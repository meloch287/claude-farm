// Task store for "Клауд Ферма": kanban-backing store + strictly sequential
// FIFO queue. Tasks are created manually («Создать задачу») or decomposed
// into subtasks by the claude CLI («Создать задачу ИИ»), then run through
// the farm one at a time. State is tracked by subscribing to the event bus
// and persisted as a JSON snapshot so the board survives restarts.
//
// The engine is Claude-only (real `claude -p` when available, otherwise an
// honest sim fallback). Tasks are organized into independent kanban boards
// («чаты»); the FIFO queue stays GLOBAL — one task on the farm at a time
// regardless of board.
//
// Task record:
//   {id, title, input, boardId, source: "manual"|"ai-parent"|"subtask"|"demo",
//    parentId?, status: "queued"|"splitting"|"split"|"kitchen"|"corridor"|
//    "living"|"bath"|"done"|"failed", attempts, lastMessage, createdAt,
//    config?, finishedAt?}
//
// Board record: {id:"b"+n, name, createdAt}.
//
// This module also owns the GLOBAL SETTINGS (Claude model, ultracode mode,
// subagents) persisted at output/settings.json, and the per-task config
// merge: POST /api/task may carry a partial config that is merged over the
// global settings and stored on the task.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Current persisted shape lives in output/farm-state.json (boards + tasks);
// the legacy output/tasks-state.json (bare tasks) is migrated on first load.
const STATE_FILE_NAME = 'farm-state.json';
const LEGACY_STATE_FILE_NAME = 'tasks-state.json';
const DEFAULT_BOARD_NAME = 'Чат 1';
const DECOMPOSE_TIMEOUT_MS = 90_000;
const EXECUTORS = new Set(['sim', 'claude']);

/** lastMessage note when the claude executor falls back to simulation. */
export const SIM_FALLBACK_NOTE = 'claude CLI недоступен — выполнено симуляцией';

// ---------------------------------------------------------------------------
// Global settings: Claude model, ultracode subagents. Persisted as
// output/settings.json, validated strictly on PUT and leniently on load.
// Engine is Claude-only (no `engine` field — the shape is flat).
// ---------------------------------------------------------------------------

export const SETTINGS_FILE_NAME = 'settings.json';
export const CLAUDE_MODES = ['ultracode', 'normal'];
export const SUBAGENT_TYPES = ['review', 'bugs', 'optimize', 'factcheck'];
export const SUBAGENT_CAP = 8;

export const DEFAULT_SETTINGS = Object.freeze({
  model: 'claude-opus-4-8',
  mode: 'ultracode',
  subagents: Object.freeze({
    model: 'claude-sonnet-4-6',
    count: 3,
    types: Object.freeze(['review', 'bugs']),
  }),
});

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/** Keep only known subagent types (deduplicated, order preserved); null if unusable. */
function sanitizeTypes(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const types = [...new Set(value.filter((t) => SUBAGENT_TYPES.includes(t)))];
  return types.length > 0 ? types : null;
}

const isValidCount = (value) =>
  Number.isInteger(value) && value >= 0 && value <= SUBAGENT_CAP;

/**
 * Lenient normalization: merge raw (possibly hand-edited / partial / garbage)
 * settings over the defaults, keeping only valid fields. Never throws.
 * The shape is flat & Claude-only: {model, mode, subagents:{model,count,types}}.
 * @param {object} [raw]
 * @returns {{model: string, mode: string, subagents: object}}
 */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sub = src.subagents && typeof src.subagents === 'object' ? src.subagents : {};
  const d = DEFAULT_SETTINGS;
  return {
    model: isNonEmptyString(src.model) ? src.model.trim() : d.model,
    mode: CLAUDE_MODES.includes(src.mode) ? src.mode : d.mode,
    subagents: {
      model: isNonEmptyString(sub.model) ? sub.model.trim() : d.subagents.model,
      count: isValidCount(sub.count) ? sub.count : d.subagents.count,
      types: sanitizeTypes(sub.types) ?? [...d.subagents.types],
    },
  };
}

/**
 * Strict validation of a PUT /api/settings patch: every PROVIDED field must
 * be valid; missing fields are fine (partial patch). Returns Russian errors.
 * @param {object} patch
 * @returns {string[]} empty array when the patch is acceptable
 */
export function validateSettingsPatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return ['Настройки должны быть JSON-объектом'];
  }
  if ('model' in patch && !isNonEmptyString(patch.model)) {
    errors.push('Поле model должно быть непустой строкой');
  }
  if ('mode' in patch && !CLAUDE_MODES.includes(patch.mode)) {
    errors.push('Поле mode должно быть "ultracode" или "normal"');
  }
  if ('subagents' in patch) {
    const sub = patch.subagents;
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
      errors.push('Поле subagents должно быть объектом');
    } else {
      if ('model' in sub && !isNonEmptyString(sub.model)) {
        errors.push('Поле subagents.model должно быть непустой строкой');
      }
      if ('count' in sub && !isValidCount(sub.count)) {
        errors.push(`Поле subagents.count должно быть целым числом от 0 до ${SUBAGENT_CAP}`);
      }
      if ('types' in sub
        && !(Array.isArray(sub.types) && sub.types.every((t) => SUBAGENT_TYPES.includes(t)))) {
        errors.push(`Поле subagents.types — массив из: ${SUBAGENT_TYPES.join(', ')}`);
      }
    }
  }
  return errors;
}

/**
 * Create the global settings store backed by output/settings.json.
 * Load is lenient (garbage on disk degrades to defaults), update is strict
 * (a patch with invalid values is rejected with Russian errors).
 * @param {{config?: {outputDir?: string}}} options
 * @returns {{get(): object, update(patch: object): {ok: true, settings: object} | {ok: false, errors: string[]}, file: string}}
 */
export function createSettingsStore({ config } = {}) {
  const outputDir = (() => {
    const dir = config?.outputDir ?? 'output';
    return path.isAbsolute(dir) ? dir : path.resolve(PROJECT_ROOT, dir);
  })();
  const file = path.join(outputDir, SETTINGS_FILE_NAME);

  let settings = normalizeSettings();
  try {
    settings = normalizeSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // no file / unreadable file => defaults
  }

  function persist() {
    try {
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    } catch {
      // fs errors never break the farm
    }
  }

  function get() {
    return structuredClone(settings);
  }

  function update(patch) {
    const errors = validateSettingsPatch(patch);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    // Deep-merge the valid patch over the current settings, then re-normalize.
    const next = structuredClone(settings);
    if ('model' in patch) next.model = patch.model;
    if ('mode' in patch) next.mode = patch.mode;
    if (patch.subagents && typeof patch.subagents === 'object') {
      const sub = patch.subagents;
      if ('model' in sub) next.subagents.model = sub.model;
      if ('count' in sub) next.subagents.count = sub.count;
      if ('types' in sub) next.subagents.types = [...sub.types];
    }
    settings = normalizeSettings(next);
    persist();
    return { ok: true, settings: get() };
  }

  return { get, update, file };
}

/**
 * Merge a raw per-task config (from POST /api/task) over the global settings
 * into the flat effective config stored on the task. Invalid fields silently
 * fall back to the global values (defensive: the API never 500s on garbage).
 * The engine is always Claude: {model, mode, subagents:{model,count,types}}.
 * @param {object} [settings] global settings (normalized leniently)
 * @param {object} [raw] per-task config {model, mode, subagents}
 * @returns {object} effective task config
 */
export function mergeTaskConfig(settings, raw) {
  const base = normalizeSettings(settings);
  const src = raw && typeof raw === 'object' ? raw : {};
  const sub = src.subagents && typeof src.subagents === 'object' ? src.subagents : {};
  const subBase = base.subagents;
  return {
    model: isNonEmptyString(src.model) ? src.model.trim() : base.model,
    mode: CLAUDE_MODES.includes(src.mode) ? src.mode : base.mode,
    subagents: {
      model: isNonEmptyString(sub.model) ? sub.model.trim() : subBase.model,
      count: isValidCount(sub.count) ? sub.count : subBase.count,
      types: sanitizeTypes(sub.types) ?? [...subBase.types],
    },
  };
}

/**
 * Pick the runner for a task. Pure — unit-testable without spawning any CLI.
 * Demo tasks always run on the sim. Real tasks run on the claude CLI when it
 * is available, otherwise the sim with an honest Russian fallback note.
 * @param {{source?: string, config?: object, claudeAvailable?: boolean}} args
 * @returns {{executor: "sim"|"claude", note?: string}}
 */
export function selectExecutor({ source, config, claudeAvailable } = {}) {
  if (source === 'demo') {
    return { executor: 'sim' };
  }
  if (config?.executor !== 'claude') {
    return { executor: 'sim' };
  }
  if (claudeAvailable === true) {
    return { executor: 'claude' };
  }
  return { executor: 'sim', note: SIM_FALLBACK_NOTE };
}

// Detected ONCE per process (at server boot) and cached, per CLI.
const cliProbes = new Map();

// Markers that mean the CLI is installed but cannot run headless prompts
// (no ANTHROPIC_API_KEY / no setup-token — OAuth does not work with -p).
const HEADLESS_AUTH_FAIL = /not logged in|please run \/login|invalid api key|no api key|credit balance|authentication/i;

/**
 * Clean env for probing the claude CLI: strip the Claude Code harness vars
 * that force a nested `claude -p` into "credentials injected by parent" mode
 * (so it falls back to the user's stored token / ANTHROPIC_API_KEY, which is
 * preserved). Mirrors cliEnv() in agents.mjs.
 */
function cliSpawnEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Keep the OAuth token: it is how `claude -p` authenticates headless.
    if (k === 'CLAUDE_CODE_OAUTH_TOKEN') { env[k] = v; continue; }
    if (k === 'CLAUDECODE' || k === 'ANTHROPIC_BASE_URL') continue;
    if (k.startsWith('CLAUDE_CODE_')) continue;
    if (k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'AI_AGENT') continue;
    env[k] = v;
  }
  return env;
}

/**
 * Probe whether `claude -p` can actually answer (headless capability), not
 * just whether the binary exists. `claude --version` passes without auth, so
 * a version probe would falsely report the executor as ready and every task
 * would fail after exhausting its retries. We send a 1-word prompt and treat
 * auth-failure output or a non-zero exit as "unavailable" -> sim fallback.
 * Cached per process; generous timeout because a real answer takes seconds.
 * @returns {Promise<boolean>}
 */
function detectClaudeHeadless({ timeoutMs = 30_000, force = false } = {}) {
  const key = 'claude:headless';
  if (cliProbes.has(key) && !force) return cliProbes.get(key);
  const probe = new Promise((resolve) => {
    let settled = false;
    let out = '';
    let timer;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn('claude', ['-p', 'Ответь одним словом: ок'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cliSpawnEnv(),
      });
    } catch {
      settle(false);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      settle(false);
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => settle(false));
    child.on('close', (code) => {
      settle(code === 0 && out.trim().length > 0 && !HEADLESS_AUTH_FAIL.test(out));
    });
  });
  cliProbes.set(key, probe);
  return probe;
}

/** Probe the claude CLI's headless prompt capability; cached. */
export function detectClaudeCli(options = {}) {
  return detectClaudeHeadless(options);
}

const SOURCES = new Set(['manual', 'ai-parent', 'subtask', 'demo']);
const ZONE_STATUSES = new Set(['kitchen', 'corridor', 'living', 'bath']);
const TERMINAL_STATUSES = new Set(['done', 'failed']);
const KNOWN_STATUSES = new Set([
  'queued', 'splitting', 'split',
  'kitchen', 'corridor', 'living', 'bath',
  'done', 'failed',
]);

/**
 * Defensively extract a subtask array from claude CLI stdout.
 * Finds the first parseable [...] JSON block (prose around it is fine),
 * keeps only items shaped like {title, input} with a non-empty title.
 * @param {string} text
 * @returns {Array<{title: string, input: string}> | null}
 */
export function parseSubtaskJson(text) {
  if (typeof text !== 'string') {
    return null;
  }

  // Try every '[' as a potential start of the JSON block: prose before the
  // real array may itself contain brackets («см. [ниже]»).
  for (let start = text.indexOf('['); start !== -1; start = text.indexOf('[', start + 1)) {
    const slice = extractBalancedArray(text, start);
    if (slice === null) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(slice);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    const subtasks = parsed
      .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({
        title: String(item.title ?? '').trim(),
        input: typeof item.input === 'string' ? item.input : String(item.input ?? ''),
      }))
      .filter((item) => item.title.length > 0);
    if (subtasks.length > 0) {
      return subtasks;
    }
  }
  return null;
}

/** Slice a balanced [...] block starting at `start`, string-aware; null if unbalanced. */
function extractBalancedArray(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

function buildDecomposePrompt(task) {
  const input = String(task.input ?? '').slice(0, 4000);
  return [
    'Разбей задачу на 3-12 маленьких конкретных подзадач.',
    `Задача: «${task.title}».`,
    input ? `Данные задачи:\n${input}` : null,
    'Ответ верни СТРОГО как JSON-массив вида [{"title":"...","input":"..."}] — без пояснений, без markdown, без какого-либо другого текста.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Spawn the claude CLI for decomposition. Resolves {ok, text} | {ok:false, error}. */
function runClaudeDecompose(prompt, config) {
  const args = ['-p', prompt, '--model', config?.model];
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    let child;
    try {
      child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      settle({ ok: false, error: String(err?.message ?? err) });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      settle({ ok: false, error: `таймаут ${DECOMPOSE_TIMEOUT_MS} мс` });
    }, DECOMPOSE_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      settle({ ok: false, error: String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        settle({ ok: true, text: stdout });
      } else {
        settle({ ok: false, error: stderr.trim().slice(0, 200) || `код выхода ${code}` });
      }
    });
  });
}

/**
 * Create the task store.
 * @param {{bus: {emit: Function, subscribe: Function}, config: object,
 *          runQueueTask: (spec: {id: string, title: string, input: string, config?: object},
 *                         executor: "sim"|"claude") => Promise<any>,
 *          claudeAvailable?: boolean | Promise<boolean> | (() => boolean | Promise<boolean>),
 *          getSettings?: () => object}} options
 * @returns {object} store API (tasks + boards)
 */
export function createTaskStore({
  bus,
  config,
  runQueueTask,
  claudeAvailable = false,
  getSettings,
}) {
  const tasks = new Map();
  const queue = [];
  let counter = 0;        // task id counter (t<n>)
  let boardCounter = 0;   // board id counter (b<n>)
  let running = false;

  // Boards («чаты»): independent kanban lists. The FIFO queue stays GLOBAL —
  // boards only organize the board view.
  const boards = [];           // [{id, name, createdAt}]
  let activeBoardId = null;

  // Global settings snapshot for the per-task config merge. Never throws.
  function currentSettings() {
    try {
      const value = typeof getSettings === 'function' ? getSettings() : undefined;
      return value && typeof value === 'object' ? value : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  const outputDir = (() => {
    const dir = config?.outputDir ?? 'output';
    return path.isAbsolute(dir) ? dir : path.resolve(PROJECT_ROOT, dir);
  })();
  const stateFile = path.join(outputDir, STATE_FILE_NAME);
  const legacyStateFile = path.join(outputDir, LEGACY_STATE_FILE_NAME);

  // --- boards ----------------------------------------------------------

  // Ensure there is always at least one board and a valid active one.
  function ensureBoardInvariant() {
    if (boards.length === 0) {
      boardCounter += 1;
      boards.push({
        id: 'b' + boardCounter,
        name: DEFAULT_BOARD_NAME,
        createdAt: new Date().toISOString(),
      });
    }
    if (!boards.some((b) => b.id === activeBoardId)) {
      activeBoardId = boards[0].id;
    }
  }

  function makeBoard(name) {
    boardCounter += 1;
    const clean = typeof name === 'string' && name.trim()
      ? name.trim()
      : `Чат ${boards.length + 1}`;
    return { id: 'b' + boardCounter, name: clean, createdAt: new Date().toISOString() };
  }

  // --- persistence -----------------------------------------------------

  // Best-effort full snapshot on every change; fs errors never break the farm.
  function persist() {
    try {
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify(
          {
            boards,
            activeBoardId,
            tasks: [...tasks.values()],
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } catch {
      // ignore fs errors
    }
  }

  // Normalize a raw task record from disk into the live shape, or null when
  // unusable. `fallbackBoardId` backfills a missing boardId (old shape).
  function reviveTask(raw, fallbackBoardId) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') {
      return null;
    }
    const idMatch = /^t(\d+)$/.exec(raw.id);
    if (idMatch) {
      counter = Math.max(counter, Number(idMatch[1]));
    }
    const task = {
      id: raw.id,
      title: raw.title,
      input: typeof raw.input === 'string' ? raw.input : '',
      boardId: typeof raw.boardId === 'string' ? raw.boardId : fallbackBoardId,
      source: SOURCES.has(raw.source) ? raw.source : 'manual',
      status: KNOWN_STATUSES.has(raw.status) ? raw.status : 'queued',
      attempts: Number.isInteger(raw.attempts) && raw.attempts > 0 ? raw.attempts : 1,
      lastMessage: typeof raw.lastMessage === 'string' ? raw.lastMessage : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    };
    if (typeof raw.parentId === 'string') {
      task.parentId = raw.parentId;
    }
    if (EXECUTORS.has(raw.executor)) {
      task.executor = raw.executor;
    }
    if (raw.config && typeof raw.config === 'object') {
      // Sanitize the persisted config through the merge (garbage degrades
      // to the current global defaults).
      task.config = mergeTaskConfig(currentSettings(), raw.config);
    }
    if (typeof raw.finishedAt === 'string') {
      task.finishedAt = raw.finishedAt;
    }
    return task;
  }

  // Load the snapshot on boot: finished tasks restored as-is, tasks that
  // were mid-pipeline restore as queued and re-enter the FIFO queue. Reads the
  // current farm-state.json shape ({boards, activeBoardId, tasks}); when only
  // the legacy tasks-state.json ({tasks}) exists, migrates bare tasks into a
  // default board. On first boot with no state, creates one «Чат 1» board.
  function load() {
    let snapshot = null;
    let legacy = false;
    try {
      snapshot = JSON.parse(readFileSync(stateFile, 'utf8'));
    } catch {
      try {
        snapshot = JSON.parse(readFileSync(legacyStateFile, 'utf8'));
        legacy = true;
      } catch {
        snapshot = null;
      }
    }

    // Restore boards (current shape only). Migration / first boot creates one.
    const rawBoards = Array.isArray(snapshot?.boards) ? snapshot.boards : [];
    for (const rb of rawBoards) {
      if (!rb || typeof rb.id !== 'string' || typeof rb.name !== 'string') continue;
      const bMatch = /^b(\d+)$/.exec(rb.id);
      if (bMatch) boardCounter = Math.max(boardCounter, Number(bMatch[1]));
      boards.push({
        id: rb.id,
        name: rb.name,
        createdAt: typeof rb.createdAt === 'string' ? rb.createdAt : new Date().toISOString(),
      });
    }
    if (typeof snapshot?.activeBoardId === 'string') {
      activeBoardId = snapshot.activeBoardId;
    }
    ensureBoardInvariant(); // guarantees a default «Чат 1» on first boot / migration
    const fallbackBoardId = activeBoardId;

    const records = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
    const toEnqueue = [];
    for (const raw of records) {
      const task = reviveTask(raw, fallbackBoardId);
      if (!task) continue;
      // A task pointing at a board that no longer exists falls back to active.
      if (!boards.some((b) => b.id === task.boardId)) {
        task.boardId = fallbackBoardId;
      }
      if (task.status === 'splitting') {
        // The decompose call cannot survive a restart — be honest about it.
        task.status = 'failed';
        task.lastMessage = 'Разбиение прервано перезапуском сервера';
      } else if (!TERMINAL_STATUSES.has(task.status) && task.status !== 'split') {
        task.status = 'queued';
        toEnqueue.push(task);
      }
      tasks.set(task.id, task);
    }
    for (const task of toEnqueue) {
      enqueue(task);
    }
    // Persist if we changed shape (migration), recovered, or had records.
    if (records.length > 0 || legacy || rawBoards.length === 0) {
      persist();
    }
  }

  // --- FIFO queue: one task on the farm at a time ------------------------

  function enqueue(task) {
    queue.push(task.id);
    bus.emit({
      type: 'task.queued',
      taskId: task.id,
      boardId: task.boardId,
      message: `Задача „${task.title}“ добавлена в очередь`,
    });
    persist();
    pump();
  }

  // Availability flags can be injected as a boolean (tests), a promise or a
  // getter (the server passes the cached boot-time probe). Never throws.
  async function resolveAvailable(flag) {
    try {
      let value = flag;
      if (typeof value === 'function') {
        value = value();
      }
      return (await value) === true;
    } catch {
      return false;
    }
  }

  function pump() {
    if (running || queue.length === 0) {
      return;
    }
    const id = queue.shift();
    const task = tasks.get(id);
    if (!task) {
      pump();
      return;
    }
    running = true;
    let fallbackNote = null;
    Promise.resolve()
      .then(async () => {
        // Pick the runner per task: demo => sim, otherwise the claude CLI when
        // available, else an honest sim fallback with a Russian note.
        const pick = selectExecutor({
          source: task.source,
          config,
          claudeAvailable: await resolveAvailable(claudeAvailable),
        });
        task.executor = pick.executor;
        if (pick.note) {
          fallbackNote = pick.note;
          task.lastMessage = pick.note;
        }
        persist();
        return runQueueTask(
          { id: task.id, title: task.title, input: task.input, config: task.config },
          pick.executor
        );
      })
      .then(() => {
        // Keep the fallback note visible after the final task.done message.
        if (fallbackNote) {
          const live = tasks.get(id);
          if (live && live.status === 'done') {
            live.lastMessage = fallbackNote;
            persist();
          }
        }
      })
      .catch((err) => {
        const live = tasks.get(id);
        if (live && !TERMINAL_STATUSES.has(live.status)) {
          live.status = 'failed';
          live.lastMessage = `Ферма не справилась: ${String(err?.message ?? err)}`;
          persist();
        }
      })
      .finally(() => {
        running = false;
        pump();
      });
  }

  // --- status tracking via the event bus ---------------------------------

  bus.subscribe((event) => {
    if (typeof event?.taskId !== 'string') {
      return;
    }
    const task = tasks.get(event.taskId);
    if (!task) {
      return;
    }
    // Tag the event with the task's board so SSE consumers (and history
    // replay — same object reference) know which board view to refresh. The
    // store subscribes at boot, before any per-connection SSE subscriber, so
    // the mutation is visible downstream.
    if (event.boardId == null && typeof task.boardId === 'string') {
      event.boardId = task.boardId;
    }
    if (typeof event.message === 'string' && event.message.length > 0) {
      task.lastMessage = event.message;
    }
    if (event.type === 'zone.enter' && ZONE_STATUSES.has(event.zone)) {
      task.status = event.zone;
    } else if (event.type === 'tester.bounce') {
      task.attempts += 1;
    } else if (event.type === 'task.done') {
      task.status = 'done';
      task.finishedAt = new Date().toISOString();
    } else if (event.type === 'task.failed') {
      task.status = 'failed';
    }
    persist();
  });

  // --- AI decomposition ---------------------------------------------------

  function failParent(parentId, reason) {
    const parent = tasks.get(parentId);
    if (!parent || TERMINAL_STATUSES.has(parent.status)) {
      return;
    }
    parent.status = 'failed';
    parent.lastMessage = reason;
    persist();
  }

  async function decompose(parent) {
    const result = await runClaudeDecompose(buildDecomposePrompt(parent), config);
    if (!result.ok) {
      failParent(parent.id, `Не удалось разбить задачу: ${result.error}`);
      return;
    }
    const subtasks = parseSubtaskJson(result.text);
    if (!subtasks) {
      failParent(parent.id, 'Клауд не вернул корректный JSON-массив подзадач');
      return;
    }
    const live = tasks.get(parent.id);
    if (!live || live.status !== 'splitting') {
      return;
    }
    live.status = 'split';
    live.lastMessage = `Задача разделена на ${subtasks.length} подзадач`;
    persist();
    for (const sub of subtasks) {
      const child = makeRecord({
        title: sub.title,
        input: sub.input,
        source: 'subtask',
        status: 'queued',
        // Subtasks live on the parent's board and inherit its effective config.
        boardId: live.boardId,
        config: live.config,
      });
      child.parentId = live.id;
      tasks.set(child.id, child);
      enqueue(child);
    }
  }

  // --- public API -----------------------------------------------------------

  function makeRecord({ title, input, source, status, boardId, config: rawConfig }) {
    counter += 1;
    return {
      id: 't' + counter,
      title: String(title),
      input: typeof input === 'string' ? input : String(input ?? ''),
      // A task always belongs to an existing board (falls back to active).
      boardId: boards.some((b) => b.id === boardId) ? boardId : activeBoardId,
      source,
      status,
      attempts: 1,
      lastMessage: '',
      createdAt: new Date().toISOString(),
      // Effective config: per-task partial merged over the global settings.
      config: mergeTaskConfig(currentSettings(), rawConfig),
    };
  }

  function createTask({ title, input, mode, source, boardId, config: rawConfig }) {
    const ai = mode === 'ai';
    const task = makeRecord({
      title,
      input,
      source: SOURCES.has(source) ? source : ai ? 'ai-parent' : 'manual',
      status: ai ? 'splitting' : 'queued',
      boardId,
      config: rawConfig,
    });
    tasks.set(task.id, task);
    if (ai) {
      persist();
      decompose(task).catch((err) => {
        failParent(task.id, `Не удалось разбить задачу: ${String(err?.message ?? err)}`);
      });
    } else {
      enqueue(task);
    }
    return structuredClone(task);
  }

  // list() — every task; list(boardId) — only that board's tasks.
  function list(boardId) {
    const all = [...tasks.values()].map((task) => structuredClone(task));
    if (typeof boardId !== 'string') return all;
    return all.filter((task) => task.boardId === boardId);
  }

  function get(id) {
    const task = tasks.get(id);
    return task ? structuredClone(task) : undefined;
  }

  // --- board API -------------------------------------------------------

  function listBoards() {
    return { boards: boards.map((b) => ({ ...b })), activeBoardId };
  }

  function setActiveBoard(id) {
    if (!boards.some((b) => b.id === id)) {
      return { ok: false, error: 'Доска не найдена' };
    }
    activeBoardId = id;
    persist();
    return { ok: true, activeBoardId };
  }

  function createBoard(name) {
    const board = makeBoard(name);
    boards.push(board);
    activeBoardId = board.id; // a freshly created board becomes active
    persist();
    return { ...board };
  }

  function renameBoard(id, name) {
    const board = boards.find((b) => b.id === id);
    if (!board) {
      return { ok: false, error: 'Доска не найдена' };
    }
    if (typeof name !== 'string' || !name.trim()) {
      return { ok: false, error: 'Имя доски не может быть пустым' };
    }
    board.name = name.trim();
    persist();
    return { ok: true, board: { ...board } };
  }

  // Delete a board AND its tasks. Never zero boards: recreate «Чат 1» if the
  // last board is removed; fall back to another board when the active one goes.
  function deleteBoard(id) {
    const idx = boards.findIndex((b) => b.id === id);
    if (idx === -1) {
      return { ok: false, error: 'Доска не найдена' };
    }
    boards.splice(idx, 1);
    for (const [taskId, task] of [...tasks.entries()]) {
      if (task.boardId === id) tasks.delete(taskId);
    }
    if (activeBoardId === id) activeBoardId = null;
    ensureBoardInvariant(); // recreate a default board if none remain
    persist();
    return { ok: true, activeBoardId };
  }

  load();

  return {
    createTask,
    list,
    get,
    listBoards,
    setActiveBoard,
    createBoard,
    renameBoard,
    deleteBoard,
  };
}
