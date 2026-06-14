// HTTP server for "Клауд Ферма": serves the pixel dashboard, streams farm
// events over SSE and exposes a state snapshot, the task API and the global
// settings API (GET/PUT /api/settings).

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createEventBus } from './events.mjs';
import { createFarm } from './orchestrator.mjs';
import { createSimRunners, createClaudeRunners, askClaude } from './agents.mjs';
import {
  createTaskStore,
  createSettingsStore,
  detectClaudeCli,
  parseConsoleActions,
} from './tasks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const EVENT_TYPES = new Set([
  'task.queued', 'task.created', 'zone.enter',
  'driver.start', 'driver.done',
  'tester.start', 'tester.ok', 'tester.bounce',
  'task.done', 'task.failed',
]);

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Sanitize attached context files from POST /api/task: keep [{name, text}],
// coerce to strings, cap count (20), per-file (200 KB) and total (2 MB) size.
function sanitizeFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let total = 0;
  for (const f of raw) {
    if (out.length >= 20) break;
    const name = typeof f?.name === 'string' && f.name.trim() ? f.name.slice(0, 200) : 'файл';
    let text = typeof f?.text === 'string' ? f.text : '';
    if (text.length > 200_000) text = text.slice(0, 200_000);
    if (total + text.length > 2_000_000) break;
    total += text.length;
    out.push({ name, text });
  }
  return out;
}

// FEATURE 1 — folder browser. List ONLY sub-directories of `requested` (names
// only, read-only), with the resolved absolute path and its parent (null at the
// FS root). No/invalid path => the user HOME. Never throws: an unreadable dir
// resolves to {path, parent, entries:[], error}. The server is local/single-user.
async function listDirectories(requested) {
  const home = process.env.HOME || os.homedir() || '/';
  let dir = typeof requested === 'string' ? requested.trim() : '';
  if (!dir || !path.isAbsolute(dir)) {
    dir = home;
  }
  const resolved = path.resolve(dir);
  const parent = path.dirname(resolved);
  // `dirname('/')` is `/` — at the FS root there is no parent.
  const parentOrNull = parent === resolved ? null : parent;

  try {
    const dirents = await readdir(resolved, { withFileTypes: true });
    const entries = dirents
      .filter((d) => {
        try { return d.isDirectory(); } catch { return false; }
      })
      .map((d) => ({ name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { path: resolved, parent: parentOrNull, entries };
  } catch {
    return { path: resolved, parent: parentOrNull, entries: [], error: 'Нет доступа к папке' };
  }
}

// FEATURE 2 — console prompt. Hand Claude the current board (id/title/status/
// attempts) + the user message; it replies in Russian and MAY emit actions.
function buildConsolePrompt(tasks, message) {
  const lines = (Array.isArray(tasks) ? tasks : []).map(
    (t) => `- ${t.id} | ${t.status} | попыток: ${t.attempts} | ${t.title}`,
  );
  const board = lines.length > 0 ? lines.join('\n') : '(на доске нет задач)';
  return [
    'Ты — ассистент в консоли «Клауд Ферма». Пользователь управляет доской задач (канбан).',
    'Текущие задачи на доске (id | статус | попытки | название):',
    board,
    `Сообщение пользователя:\n${message}`,
    'Ответь пользователю по-русски, кратко и по делу.',
    'Если нужно ИЗМЕНИТЬ доску — добавь в конце ответа блок ```json{"actions":[...]}``` где каждое действие одно из:',
    '{"type":"create","title":"...","input":"..."} — создать задачу;',
    '{"type":"cancel","taskId":"tN"} — отменить задачу в очереди;',
    '{"type":"retry","taskId":"tN"} — перезапустить проваленную задачу.',
    'Если менять доску не нужно — JSON-блок не добавляй.',
  ].join('\n\n');
}

/**
 * Start the farm dashboard server.
 * @param {{config: object, bus?: object}} options
 * @returns {Promise<{server: import('node:http').Server, port: number}>}
 */
export function startServer({ config = {}, bus = createEventBus(), consoleAsk } = {}) {
  const requestedPort = config.port ?? 8787;
  // Console model call. Injectable so tests never spawn a real CLI; defaults to
  // the real `claude -p` helper. `onChild` is forwarded so the request can kill
  // the in-flight child when the client aborts (the «Стоп» button).
  const askConsole = typeof consoleAsk === 'function'
    ? consoleAsk
    : (prompt, opts) => askClaude(prompt, opts);
  // Sim farm: fallback executor when the claude CLI is unavailable.
  // stepDelayMs paces sim events at ~15s per zone (5 events x 3000ms) so the
  // dashboard choreography (boss walk -> handoff -> work -> carry -> check)
  // stays within one beat of reality without the catch-up queue compressing it.
  // Tests may pass config.simStepDelayMs (e.g. 0) to run the sim instantly.
  const simStepDelayMs = Number.isFinite(config.simStepDelayMs) ? config.simStepDelayMs : 3000;
  const simFarm = createFarm({ ...config, stepDelayMs: simStepDelayMs }, createSimRunners(), bus);
  // Real executor: the claude CLI farm. Minimal pacing — the CLI calls are the
  // natural delay, and the boss wants real tasks done fast.
  const claudeFarm = createFarm(
    { ...config, stepDelayMs: 300 },
    createClaudeRunners(config),
    bus
  );

  // Probe the claude CLI ONCE at boot; the cached result picks the executor
  // per task and is exposed in /api/state as {claudeExecutor}. The probe is
  // injectable (config.detectCli) so tests skip the real `claude -p` spawn that
  // would otherwise keep the process alive for the full probe timeout.
  let claudeExecutor = false;
  const probe = typeof config.detectCli === 'function' ? config.detectCli : detectClaudeCli;
  const claudeAvailable = Promise.resolve()
    .then(() => probe())
    .then((ok) => {
      claudeExecutor = ok === true;
      return claudeExecutor;
    })
    .catch(() => false);

  // Global settings (Claude model, ultracode subagents), persisted at
  // output/settings.json.
  const settings = createSettingsStore({ config });

  // Task store: kanban board state + strictly sequential FIFO queue feeding
  // one farm at a time. Persists/restores output/farm-state.json.
  const farms = { sim: simFarm, claude: claudeFarm };
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: () => claudeAvailable,
    getSettings: () => settings.get(),
    runQueueTask: (spec, executor) => (farms[executor] ?? simFarm).runTask(spec),
  });

  function handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Replay history first, then go live.
    for (const event of bus.history()) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    const unsubscribe = bus.subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  // POST /api/task {title, input, mode: "simple"|"ai", config?} -> 202 {taskId}.
  // config is an optional per-task partial {engine, model, mode, speed,
  // subagents:{model,count,types}} merged over the global settings.
  async function handleCreateTask(req, res) {
    let body;
    try {
      // Larger limit than other routes: attached context files travel here.
      body = JSON.parse((await readBody(req, 6 * 1024 * 1024)) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Некорректный JSON' });
      return;
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      sendJson(res, 400, { error: 'Название задачи не может быть пустым' });
      return;
    }
    const mode = body.mode === 'ai' ? 'ai' : 'simple';
    if (body.mode !== undefined && body.mode !== 'simple' && body.mode !== 'ai') {
      sendJson(res, 400, { error: 'Режим должен быть "simple" или "ai"' });
      return;
    }
    const input = typeof body.input === 'string' ? body.input : '';
    const taskConfig = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
      ? body.config
      : undefined;
    const boardId = typeof body.boardId === 'string' ? body.boardId : undefined;

    // Working directory (the «Рабочая папка»): optional, but if given it must be
    // an existing absolute directory on this machine (the server is local).
    const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
    if (cwd) {
      let ok = path.isAbsolute(cwd);
      if (ok) {
        try {
          ok = (await stat(cwd)).isDirectory();
        } catch {
          ok = false;
        }
      }
      if (!ok) {
        sendJson(res, 400, {
          error: 'Папка не найдена — укажите существующий абсолютный путь',
          field: 'cwd',
        });
        return;
      }
    }

    const files = sanitizeFiles(body.files);
    const task = store.createTask({ title, input, mode, boardId, config: taskConfig, cwd, files });
    sendJson(res, 202, { taskId: task.id, boardId: task.boardId });
  }

  // --- boards API -----------------------------------------------------------
  // POST /api/boards {name?} -> {board}. PATCH /api/boards/:id {name} -> rename.
  // DELETE /api/boards/:id -> delete board + its tasks (never zero boards).
  async function handleCreateBoard(req, res) {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Некорректный JSON' });
      return;
    }
    const name = typeof body.name === 'string' ? body.name : undefined;
    const board = store.createBoard(name);
    sendJson(res, 201, { board });
  }

  async function handleRenameBoard(req, res, id) {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Некорректный JSON' });
      return;
    }
    const result = store.renameBoard(id, body.name);
    if (!result.ok) {
      sendJson(res, result.error === 'Доска не найдена' ? 404 : 400, { error: result.error });
      return;
    }
    sendJson(res, 200, { board: result.board });
  }

  function handleDeleteBoard(res, id) {
    const result = store.deleteBoard(id);
    if (!result.ok) {
      sendJson(res, 404, { error: result.error });
      return;
    }
    sendJson(res, 200, store.listBoards());
  }

  // PUT /api/settings: strict validation, 400 with Russian errors on garbage.
  async function handleUpdateSettings(req, res) {
    let patch;
    try {
      patch = JSON.parse((await readBody(req)) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Некорректный JSON' });
      return;
    }
    const result = settings.update(patch);
    if (!result.ok) {
      sendJson(res, 400, { error: 'Некорректные настройки', details: result.errors });
      return;
    }
    sendJson(res, 200, result.settings);
  }

  // External orchestrators (the Main Agent — Claude) push their pipeline
  // events here; the dashboard renders them exactly like sim-farm events.
  async function handleIngest(req, res) {
    let event;
    try {
      event = JSON.parse((await readBody(req)) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Некорректный JSON' });
      return;
    }
    if (!EVENT_TYPES.has(event.type)) {
      sendJson(res, 400, { error: 'Неизвестный тип события', allowed: [...EVENT_TYPES] });
      return;
    }
    bus.emit({
      type: event.type,
      taskId: typeof event.taskId === 'string' ? event.taskId : 'external',
      boardId: typeof event.boardId === 'string' ? event.boardId : undefined,
      zone: typeof event.zone === 'string' ? event.zone : undefined,
      role: typeof event.role === 'string' ? event.role : undefined,
      message: typeof event.message === 'string' ? event.message.slice(0, 500) : '',
    });
    sendJson(res, 200, { ok: true });
  }

  // POST /api/console {boardId, message} -> {reply, actions:[{type, ok, detail}]}.
  // Runs `claude -p` with the current board + the user message; parses an
  // optional ```json{"actions":[...]}``` block and applies it via the store.
  // ABORTABLE: the spawned child is tracked; if the client aborts the request
  // before it finishes, the child is SIGKILLed so «Стоп» really stops it.
  async function handleConsole(req, res) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      sendJson(res, 400, { error: 'Некорректный JSON' });
      return;
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      sendJson(res, 400, { error: 'Сообщение не может быть пустым' });
      return;
    }
    const boardId = typeof body.boardId === 'string' && body.boardId
      ? body.boardId
      : store.listBoards().activeBoardId;

    const tasks = store.list(boardId);
    const prompt = buildConsolePrompt(tasks, message.slice(0, 4000));

    // Track the spawned child so an aborted request can kill it.
    let child = null;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      if (child) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    };
    req.on('close', onAbort);
    req.on('aborted', onAbort);

    const settings = settings_get_safe();
    const reply = await askConsole(prompt, {
      model: settings.model,
      timeoutMs: 90_000,
      onChild: (c) => { child = c; if (aborted) { try { c.kill('SIGKILL'); } catch { /* ignore */ } } },
    });
    req.removeListener('close', onAbort);
    req.removeListener('aborted', onAbort);

    if (aborted || res.writableEnded || (res.socket && res.socket.destroyed)) {
      // The client (Stop) is gone — nothing to send, child already killed.
      return;
    }

    if (!reply || reply.ok !== true) {
      sendJson(res, 200, {
        reply: `Клауд не ответил: ${reply?.error ?? 'нет ответа'}`,
        actions: [],
      });
      return;
    }

    const parsed = parseConsoleActions(reply.text);
    const actions = store.applyConsoleActions(parsed, { boardId });
    sendJson(res, 200, { reply: reply.text, actions });
  }

  // Read the global settings without ever throwing (the console only needs the model).
  function settings_get_safe() {
    try {
      const s = settings.get();
      return s && typeof s === 'object' ? s : {};
    } catch {
      return {};
    }
  }

  async function handleStatic(pathname, res, headOnly = false) {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.normalize(path.join(DASHBOARD_DIR, relative));

    // Path traversal guard: stay inside dashboard/.
    if (filePath !== DASHBOARD_DIR && !filePath.startsWith(DASHBOARD_DIR + path.sep)) {
      sendText(res, 403, 'Доступ запрещён');
      return;
    }

    let body;
    try {
      body = await readFile(filePath);
    } catch {
      sendText(res, 404, 'Страница не найдена');
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()]
      ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
    });
    res.end(headOnly ? undefined : body);
  }

  const server = http.createServer(async (req, res) => {
    let pathname;
    let query;
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
      query = url.searchParams;
    } catch {
      sendText(res, 400, 'Некорректный запрос');
      return;
    }

    // /api/boards/:id (PATCH rename, DELETE, POST .../active)
    const boardMatch = /^\/api\/boards\/([^/]+?)(\/active)?$/.exec(pathname);

    try {
      if (req.method === 'GET' && pathname === '/events') {
        handleSse(req, res);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, {
          zones: config.zones ?? [],
          claudeExecutor,
          claudeModels: config.claudeModels ?? [],
          history: bus.history().slice(-100),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/tasks') {
        // ?board=<id> scopes to one board; no param => active board's tasks.
        const board = query.get('board');
        const tasks = board ? store.list(board) : store.list(store.listBoards().activeBoardId);
        sendJson(res, 200, { tasks });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/boards') {
        sendJson(res, 200, store.listBoards());
        return;
      }
      if (req.method === 'POST' && pathname === '/api/boards') {
        await handleCreateBoard(req, res);
        return;
      }
      if (boardMatch) {
        const boardId = decodeURIComponent(boardMatch[1]);
        const isActive = Boolean(boardMatch[2]);
        if (req.method === 'POST' && isActive) {
          const result = store.setActiveBoard(boardId);
          if (!result.ok) sendJson(res, 404, { error: result.error });
          else sendJson(res, 200, store.listBoards());
          return;
        }
        if (req.method === 'PATCH' && !isActive) {
          await handleRenameBoard(req, res, boardId);
          return;
        }
        if (req.method === 'DELETE' && !isActive) {
          handleDeleteBoard(res, boardId);
          return;
        }
      }
      if (req.method === 'GET' && pathname === '/api/settings') {
        sendJson(res, 200, settings.get());
        return;
      }
      if (req.method === 'PUT' && pathname === '/api/settings') {
        await handleUpdateSettings(req, res);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/task') {
        await handleCreateTask(req, res);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/fs') {
        sendJson(res, 200, await listDirectories(query.get('path')));
        return;
      }
      if (req.method === 'POST' && pathname === '/api/console') {
        await handleConsole(req, res);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/event') {
        await handleIngest(req, res);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        await handleStatic(pathname, res, req.method === 'HEAD');
        return;
      }
      sendText(res, 405, 'Метод не поддерживается');
    } catch {
      if (!res.headersSent) {
        sendText(res, 500, 'Внутренняя ошибка фермы');
      } else {
        res.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(requestedPort, () => {
      server.removeListener('error', onError);
      resolve({ server, port: server.address().port });
    });
  });
}
