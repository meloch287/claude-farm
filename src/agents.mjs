// Agents for "Клауд Ферма": sim runners (deterministic, used by tests and
// the demo) and real CLI runners — claude (`claude -p`) and codex
// (`codex exec`). The claude path additionally supports the ULTRACODE mode:
// in the Теплица (living) zone parallel subagents review the result before
// the Sniffer verdict.
//
// Runners NEVER emit events themselves — the orchestrator does. A driver may
// return { message } and a tester returns a verdict:
//   { ok: true, note? } or { ok: false, reason, bounceTo }.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/** Days in a 1-based month of a given year (leap years included). */
function daysInMonth(month, year) {
  return new Date(year, month, 0).getDate();
}

/** Resolve the output directory cwd-independently (relative to project root). */
function resolveOutputDir(config) {
  const dir = config?.outputDir ?? 'output';
  return path.isAbsolute(dir) ? dir : path.resolve(PROJECT_ROOT, dir);
}

/**
 * Parse a CSV string into data rows, like a user would.
 * Header with ";" (e.g. "Имя;Дата") -> {name, date} rows;
 * single-column header (e.g. "Текст") -> {text} rows.
 */
function parseCsvRows(csv) {
  const lines = String(csv ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0] ?? '';
  const body = lines.slice(1);
  if (!header.includes(';')) {
    return body.map((line) => ({ text: line }));
  }
  return body.map((line) => {
    const [name = '', date = ''] = line.split(';').map((part) => part.trim());
    return { name, date };
  });
}

// ---------------------------------------------------------------------------
// SIM runners — deterministic pipeline used by tests and the demo.
// ---------------------------------------------------------------------------

export function createSimRunners() {
  const drivers = {
    // Поле — The Scraper: raw input -> trimmed non-empty lines.
    async kitchen(ctx) {
      let lines = String(ctx.task.input ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const fix = ctx.data.fixRequest;
      if (fix) {
        lines = lines.map((line) =>
          line.includes(fix.bad) ? line.replace(fix.bad, fix.fixed) : line
        );
        ctx.data.lines = lines;
        return { message: 'Паша исправил дату' };
      }

      ctx.data.lines = lines;
      return { message: `Собрано строк: ${lines.length}` };
    },

    // Амбар — The Editor: lines "Имя;DD.MM.YYYY" -> rows + CSV.
    // Arbitrary text without ";" becomes single-column rows (header «Текст»).
    async corridor(ctx) {
      const lines = ctx.data.lines ?? [];
      if (lines.some((line) => line.includes(';'))) {
        const rows = lines.map((line) => {
          const [name = '', date = ''] = line.split(';').map((part) => part.trim());
          return { name, date };
        });
        ctx.data.rows = rows;
        ctx.data.csv =
          ['Имя;Дата', ...rows.map((row) => `${row.name};${row.date}`)].join('\n') + '\n';
        return { message: `Свёрстан CSV: ${rows.length} строк` };
      }
      const rows = lines.map((line) => ({ text: line }));
      ctx.data.rows = rows;
      ctx.data.csv = ['Текст', ...rows.map((row) => row.text)].join('\n') + '\n';
      return { message: `Свёрстан CSV: ${rows.length} строк` };
    },

    // Теплица — The Runner: re-opens the CSV like a user would.
    async living(ctx) {
      const rows = parseCsvRows(ctx.data.csv);
      ctx.data.qa = { rowsOpened: rows.length };
      return { message: `Открыто строк: ${rows.length}` };
    },

    // Рынок — The Archiver: writes result.csv + manifest.json, zips the folder.
    async bath(ctx) {
      const baseDir = resolveOutputDir(ctx.config);
      const taskDir = path.join(baseDir, ctx.task.id);
      await mkdir(taskDir, { recursive: true });

      const csvPath = path.join(taskDir, 'result.csv');
      const manifestPath = path.join(taskDir, 'manifest.json');
      const manifest = {
        title: ctx.task.title,
        rows: ctx.data.qa?.rowsOpened ?? ctx.data.rows?.length ?? 0,
        attempts: ctx.task.attempts,
        finishedAt: new Date().toISOString(),
      };

      await writeFile(csvPath, ctx.data.csv ?? '', 'utf8');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

      // Best-effort zip via the zip CLI; absence or failure is fine.
      await new Promise((resolve) => {
        execFile(
          'zip',
          ['-r', `${ctx.task.id}.zip`, ctx.task.id],
          { cwd: baseDir },
          () => resolve()
        );
      });

      ctx.data.release = { dir: taskDir, csvPath, manifestPath };
      return {
        message: `Релиз упакован в ${path.join(ctx.config?.outputDir ?? 'output', ctx.task.id)}`,
      };
    },
  };

  const testers = {
    // Поле — The Cleaner: there must be at least one line.
    async kitchen(ctx) {
      const count = ctx.data.lines?.length ?? 0;
      if (count > 0) {
        return { ok: true, note: `Строк к обработке: ${count}` };
      }
      return {
        ok: false,
        reason: 'Входные данные пусты, ни одной строки',
        bounceTo: 'kitchen',
      };
    },

    // Амбар — The Validator: every token that LOOKS like a date
    // (dd.mm.yyyy) must be a real calendar date; anything else passes.
    async corridor(ctx) {
      for (const row of ctx.data.rows ?? []) {
        const tokens = typeof row.date === 'string'
          ? [row.date]
          : String(row.text ?? '').split(/\s+/).filter(Boolean);

        for (const token of tokens) {
          const match = DATE_RE.exec(token);
          if (!match) {
            continue; // не похоже на дату — не проверяем
          }

          const day = Number(match[1]);
          const month = Number(match[2]);
          const year = Number(match[3]);
          let valid = false;
          let fixed = null;
          if (month >= 1 && month <= 12) {
            const maxDay = daysInMonth(month, year);
            if (day >= 1 && day <= maxDay) {
              valid = true;
            } else if (day > maxDay) {
              // Clamp the day to the last valid day of that month.
              fixed = `${String(maxDay).padStart(2, '0')}.${match[2]}.${match[3]}`;
            }
          }

          if (!valid) {
            if (!ctx.data.fixRequest && fixed) {
              ctx.data.fixRequest = { bad: token, fixed };
            }
            return {
              ok: false,
              reason: `Дата ${token} не существует`,
              bounceTo: 'kitchen',
            };
          }
        }
      }
      return { ok: true, note: 'Все даты настоящие' };
    },

    // Теплица — The Sniffer: no empty fields, no duplicate rows.
    // Single-column CSV rows are keyed by their text.
    async living(ctx) {
      const rows = parseCsvRows(ctx.data.csv);
      const seen = new Set();
      for (const row of rows) {
        let key;
        if (typeof row.text === 'string') {
          if (!row.text) {
            return {
              ok: false,
              reason: 'Пустая строка в данных',
              bounceTo: 'corridor',
            };
          }
          key = row.text;
        } else {
          if (!row.name || !row.date) {
            return {
              ok: false,
              reason: `Пустое поле в строке «${row.name};${row.date}»`,
              bounceTo: 'corridor',
            };
          }
          key = `${row.name};${row.date}`;
        }
        if (seen.has(key)) {
          return {
            ok: false,
            reason: `Дубликат строки «${key}»`,
            bounceTo: 'corridor',
          };
        }
        seen.add(key);
      }
      return {
        ok: true,
        note: `Проверено строк: ${ctx.data.qa?.rowsOpened ?? rows.length}, дубликатов и пустых полей нет`,
      };
    },

    // Рынок — The Sign-Off: both release files exist and are non-empty.
    async bath(ctx) {
      const baseDir = resolveOutputDir(ctx.config);
      const taskDir = ctx.data.release?.dir ?? path.join(baseDir, ctx.task.id);
      const csvPath = ctx.data.release?.csvPath ?? path.join(taskDir, 'result.csv');
      const manifestPath =
        ctx.data.release?.manifestPath ?? path.join(taskDir, 'manifest.json');
      try {
        const [csvStat, manifestStat] = await Promise.all([
          stat(csvPath),
          stat(manifestPath),
        ]);
        if (csvStat.size > 0 && manifestStat.size > 0) {
          return { ok: true, note: 'Клиенту можно отправлять!' };
        }
        return {
          ok: false,
          reason: 'Файлы релиза пустые',
          bounceTo: 'bath',
        };
      } catch {
        return {
          ok: false,
          reason: 'Файлы релиза не найдены',
          bounceTo: 'bath',
        };
      }
    },
  };

  return {
    async runDriver(zoneId, ctx) {
      const driver = drivers[zoneId];
      if (!driver) {
        throw new Error(`Неизвестная зона для драйвера: ${zoneId}`);
      }
      return driver(ctx);
    },
    async runTester(zoneId, ctx) {
      const tester = testers[zoneId];
      if (!tester) {
        throw new Error(`Неизвестная зона для тестера: ${zoneId}`);
      }
      return tester(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI runners — real executors: the Амбар (corridor) Editor actually performs
// the task via a local CLI (claude or codex), the other roles prepare, verify
// and package the deliverable. Never spawned by tests.
// ---------------------------------------------------------------------------

const CLAUDE_TIMEOUT_MS = 120_000;
const CODEX_TIMEOUT_MS = 180_000;

/** Clip long text for prompts. */
function clip(text, limit = 6000) {
  const str = String(text ?? '');
  return str.length > limit ? str.slice(0, limit) + '…' : str;
}

/** First non-empty line, shortened — used for dashboard messages. */
function firstLine(text, limit = 120) {
  const line = String(text ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return (line ?? '').slice(0, limit);
}

/**
 * Parse a tester reply: first word ОК/OK => ok:true,
 * anything else => ok:false with the rest as the reason.
 */
function parseVerdict(text) {
  const trimmed = String(text ?? '').trim();
  const word = (trimmed.match(/[A-Za-zА-Яа-яЁё]+/) ?? [''])[0].toUpperCase();
  const rest = trimmed
    .replace(/^[^A-Za-zА-Яа-яЁё]*[A-Za-zА-Яа-яЁё]+[\s:,.—-]*/, '')
    .trim();
  if (word === 'ОК' || word === 'OK') {
    return { ok: true, note: rest || undefined };
  }
  return { ok: false, reason: rest || trimmed || 'Тестер нашёл проблему' };
}

/**
 * Build a clean environment for spawning the `claude`/`codex` CLIs.
 * When the farm server itself is launched from inside a Claude Code session,
 * it inherits harness variables (CLAUDECODE, CLAUDE_CODE_*, ANTHROPIC_BASE_URL,
 * CLAUDE_CODE_ENTRYPOINT) that put a nested `claude -p` into a "credentials
 * injected by parent" mode and make it report "Not logged in". Strip them so
 * the CLI falls back to the user's own stored long-lived token / API key.
 */
function cliEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Keep the OAuth token: it is how `claude -p` authenticates headless.
    if (k === 'CLAUDE_CODE_OAUTH_TOKEN') { env[k] = v; continue; }
    if (k === 'CLAUDECODE') continue;
    if (k.startsWith('CLAUDE_CODE_')) continue;
    if (k === 'ANTHROPIC_BASE_URL') continue;
    if (k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'AI_AGENT') continue;
    env[k] = v;
  }
  return env;
}

/** Spawn an arbitrary CLI prompt call. Resolves {ok, text} | {ok:false, error}. */
function runCliPrompt(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };

    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: cliEnv() });
    } catch (err) {
      settle({ ok: false, error: String(err?.message ?? err) });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      settle({ ok: false, error: `таймаут ${timeoutMs} мс` });
    }, timeoutMs);

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
        settle({ ok: true, text: stdout.trim() });
      } else {
        settle({
          ok: false,
          error: stderr.trim() || `код выхода ${code}`,
        });
      }
    });
  });
}

/** `claude -p <prompt> [--model <model>]`; model defaults to config.model. */
function runClaudeCli(prompt, config, model) {
  const args = ['-p', prompt];
  const effectiveModel = model ?? config?.model;
  if (effectiveModel) {
    args.push('--model', effectiveModel);
  }
  return runCliPrompt('claude', args, config?.claudeTimeoutMs ?? CLAUDE_TIMEOUT_MS);
}

/**
 * `codex exec --model <model> -c model_reasoning_effort=<low|medium> <prompt>`.
 * speed "faster" maps to low reasoning effort, "normal" to medium.
 */
function runCodexCli(prompt, config, { model, speed } = {}) {
  const effort = speed === 'faster' ? 'low' : 'medium';
  const args = [
    'exec',
    '--model', model ?? 'gpt-5.5',
    '-c', `model_reasoning_effort=${effort}`,
    prompt,
  ];
  return runCliPrompt('codex', args, config?.codexTimeoutMs ?? CODEX_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// ULTRACODE subagents (claude engine only): parallel reviewers in Теплица.
// Pure planning + injectable `ask` so tests never spawn a real CLI.
// ---------------------------------------------------------------------------

/** Per-type subagent briefs (the actual instruction sent to the model). */
export const SUBAGENT_BRIEFS = Object.freeze({
  review: 'сделай ревью результата',
  bugs: 'найди ошибки/несостыковки',
  optimize: 'предложи улучшения',
  factcheck: 'проверь факты',
});

/** Russian labels for dashboard messages. */
export const SUBAGENT_LABELS = Object.freeze({
  review: 'ревью',
  bugs: 'поиск ошибок',
  optimize: 'оптимизация',
  factcheck: 'факт-чекинг',
});

const SUBAGENT_FANOUT_CAP = 8;

/**
 * Plan the fan-out: count (capped at 8) parallel calls, one per enabled type,
 * cycling through the types when count exceeds them. Pure.
 * @param {{count?: number, types?: string[]}} [subagents]
 * @returns {string[]} ordered list of subagent types to spawn
 */
export function planSubagents(subagents) {
  const types = Array.isArray(subagents?.types)
    ? subagents.types.filter((type) => type in SUBAGENT_BRIEFS)
    : [];
  const count = Math.min(
    Number.isInteger(subagents?.count) && subagents.count > 0 ? subagents.count : 0,
    SUBAGENT_FANOUT_CAP
  );
  if (count === 0 || types.length === 0) {
    return [];
  }
  return Array.from({ length: count }, (_, i) => types[i % types.length]);
}

/** Build a subagent prompt for a given type against the task result. */
export function buildSubagentPrompt(type, taskTitle, resultText) {
  return [
    `Ты — субагент-проверяющий на конвейере «Клауд Ферма». Твоя роль: ${SUBAGENT_LABELS[type] ?? type}.`,
    `Инструкция: ${SUBAGENT_BRIEFS[type] ?? 'проверь результат'}.`,
    taskTitle ? `Задача: «${taskTitle}».` : null,
    `Результат:\n${clip(resultText)}`,
    'Если реальных проблем нет — напиши «Проблем не найдено». Иначе перечисли проблемы списком. Ответ по-русски, кратко.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Run the ultracode fan-out: spawn the planned subagents IN PARALLEL via the
 * injected `ask` and merge their findings into a digest for the Sniffer.
 * Failed calls are kept in the digest with an honest note — never throws.
 * @param {{subagents?: object, taskTitle?: string, result?: string,
 *          ask: (prompt: string) => Promise<{ok: boolean, text?: string, error?: string}>}} args
 * @returns {Promise<{count: number, types: string[], findings: Array<{type: string, ok: boolean, text: string}>, digest: string}>}
 */
export async function runSubagentFanout({ subagents, taskTitle, result, ask }) {
  const plan = planSubagents(subagents);
  if (plan.length === 0) {
    return { count: 0, types: [], findings: [], digest: '' };
  }
  const findings = await Promise.all(
    plan.map(async (type) => {
      try {
        const reply = await ask(buildSubagentPrompt(type, taskTitle, result));
        if (reply?.ok === true) {
          return { type, ok: true, text: String(reply.text ?? '').trim() };
        }
        return { type, ok: false, text: `субагент недоступен: ${reply?.error ?? 'нет ответа'}` };
      } catch (err) {
        return { type, ok: false, text: `субагент недоступен: ${String(err?.message ?? err)}` };
      }
    })
  );
  const digest = findings
    .map((f, i) => `[субагент ${i + 1}, ${SUBAGENT_LABELS[f.type] ?? f.type}] ${f.text}`)
    .join('\n');
  return { count: plan.length, types: [...new Set(plan)], findings, digest };
}

/** Human list of subagent type labels: «ревью, поиск ошибок». */
export function describeSubagentTypes(types) {
  return types.map((type) => SUBAGENT_LABELS[type] ?? type).join(', ');
}

/** The task runs ultracode when its claude config says so and the plan is non-empty. */
function isUltracode(taskConfig) {
  return taskConfig?.engine !== 'codex'
    && taskConfig?.mode === 'ultracode'
    && planSubagents(taskConfig?.subagents).length > 0;
}

export function createClaudeRunners(config) {
  // Task model comes from the per-task config; config.model is the fallback.
  const ask = (ctx, prompt) => runClaudeCli(prompt, config, ctx.task?.config?.model);
  // Ultracode subagents run on their own (usually cheaper) model.
  const askSubagent = (ctx, prompt) =>
    runClaudeCli(prompt, config, ctx.task?.config?.subagents?.model);
  return createCliRunners(config, {
    executorName: 'claude',
    cliLabel: 'claude CLI',
    ask,
    askSubagent,
  });
}

export function createCodexRunners(config) {
  // Codex path: model + speed from the per-task config; NO subagents.
  const ask = (ctx, prompt) => runCodexCli(prompt, config, {
    model: ctx.task?.config?.model,
    speed: ctx.task?.config?.speed,
  });
  return createCliRunners(config, {
    executorName: 'codex',
    cliLabel: 'codex CLI',
    ask,
  });
}

function createCliRunners(config, { executorName, cliLabel, ask, askSubagent }) {

  // A failed CLI call never throws: the driver stores the error note and the
  // zone tester turns it into a БАГ so the pipeline bounces/fails gracefully.
  const noteError = (ctx, zoneId, error) => {
    ctx.data.errors = { ...ctx.data.errors, [zoneId]: String(error) };
  };
  const clearError = (ctx, zoneId) => {
    if (ctx.data.errors) {
      delete ctx.data.errors[zoneId];
    }
  };

  // Fix note from a bouncing tester: the retry pass improves the brief/result.
  const fixNoteLine = (ctx) =>
    ctx.data.fixNote
      ? `Замечание проверяющего с прошлой попытки (обязательно учти и исправь): ${clip(ctx.data.fixNote, 800)}`
      : null;

  const bag = (ctx, reason, bounceTo) => {
    ctx.data.fixNote = reason;
    return { ok: false, reason, bounceTo };
  };

  const drivers = {
    // Поле — The Scraper: готовит материалы и план для задачи -> ctx.data.brief.
    async kitchen(ctx) {
      const prompt = [
        'Ты — Scraper, сборщик на конвейере «Клауд Ферма».',
        'Подготовь сжатые материалы и план выполнения задачи: что именно сделать, ключевые факты, структура будущего результата.',
        `Задача: «${ctx.task.title}».`,
        ctx.task.input ? `Данные задачи:\n${clip(ctx.task.input, 4000)}` : null,
        fixNoteLine(ctx),
        'Ответь кратко, по-русски, обычным текстом.',
      ]
        .filter(Boolean)
        .join('\n\n');

      const result = await ask(ctx, prompt);
      if (!result.ok) {
        noteError(ctx, 'kitchen', result.error);
        return { message: `Scraper: ${cliLabel} не ответил (${result.error})` };
      }
      clearError(ctx, 'kitchen');
      ctx.data.brief = result.text;
      return { message: `Материалы готовы: ${firstLine(result.text)}` };
    },

    // Амбар — The Editor: ВЫПОЛНЯЕТ задачу по-настоящему -> ctx.data.result.
    async corridor(ctx) {
      const prompt = [
        'Ты — Editor на конвейере «Клауд Ферма». ВЫПОЛНИ задачу по-настоящему, как если бы пользователь спросил ассистента напрямую.',
        `Задача: «${ctx.task.title}».`,
        ctx.task.input ? `Данные задачи:\n${clip(ctx.task.input, 4000)}` : null,
        ctx.data.brief ? `Материалы и план от Scraper:\n${clip(ctx.data.brief)}` : null,
        fixNoteLine(ctx),
        'Выдай ГОТОВЫЙ результат в markdown — только сам результат, без преамбулы, без вопросов и без пояснений о процессе.',
      ]
        .filter(Boolean)
        .join('\n\n');

      const result = await ask(ctx, prompt);
      if (!result.ok) {
        noteError(ctx, 'corridor', result.error);
        return { message: `Editor: ${cliLabel} не ответил (${result.error})` };
      }
      clearError(ctx, 'corridor');
      ctx.data.result = result.text;
      return { message: `Результат готов: ${firstLine(result.text)}` };
    },

    // Теплица — The Runner: читает результат глазами пользователя -> ctx.data.qa.
    // ULTRACODE (claude): перед вердиктом Sniffer'а параллельные субагенты
    // проверяют результат, их находки попадают в ctx.data.qa.
    async living(ctx) {
      const prompt = [
        'Ты — Runner на конвейере «Клауд Ферма». Прочитай готовый результат глазами пользователя.',
        `Задача: «${ctx.task.title}».`,
        `Результат:\n${clip(ctx.data.result)}`,
        'Кратко (3-5 пунктов, по-русски): что получилось, понятно ли, полезно ли.',
      ].join('\n\n');

      const result = await ask(ctx, prompt);
      if (!result.ok) {
        noteError(ctx, 'living', result.error);
        return { message: `Runner: ${cliLabel} не ответил (${result.error})` };
      }
      clearError(ctx, 'living');
      ctx.data.qa = result.text;

      // Ultracode fan-out — claude engine only (codex runners pass no askSubagent).
      if (askSubagent && isUltracode(ctx.task?.config)) {
        const fan = await runSubagentFanout({
          subagents: ctx.task.config.subagents,
          taskTitle: ctx.task.title,
          result: ctx.data.result,
          ask: (subPrompt) => askSubagent(ctx, subPrompt),
        });
        if (fan.count > 0) {
          ctx.data.qa += `\n\nНаходки субагентов:\n${fan.digest}`;
          ctx.data.subagents = { count: fan.count, types: fan.types };
          return {
            message: `Заметки готовы, результат проверили ${fan.count} субагентов (${describeSubagentTypes(fan.types)})`,
          };
        }
      }
      return { message: `Заметки пользователя: ${firstLine(result.text)}` };
    },

    // Рынок — The Archiver: пишет result.md (деливерабл) + manifest.json + zip.
    async bath(ctx) {
      const baseDir = resolveOutputDir(ctx.config);
      const taskDir = path.join(baseDir, ctx.task.id);
      try {
        await mkdir(taskDir, { recursive: true });

        const resultPath = path.join(taskDir, 'result.md');
        const manifestPath = path.join(taskDir, 'manifest.json');
        const manifest = {
          title: ctx.task.title,
          attempts: ctx.task.attempts,
          executor: executorName,
          finishedAt: new Date().toISOString(),
        };

        await writeFile(resultPath, ctx.data.result ?? '', 'utf8');
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

        // Best-effort zip via the zip CLI; absence or failure is fine.
        await new Promise((resolve) => {
          execFile(
            'zip',
            ['-r', `${ctx.task.id}.zip`, ctx.task.id],
            { cwd: baseDir },
            () => resolve()
          );
        });

        clearError(ctx, 'bath');
        ctx.data.release = { dir: taskDir, resultPath, manifestPath };
        return {
          message: `Релиз упакован в ${path.join(ctx.config?.outputDir ?? 'output', ctx.task.id)}`,
        };
      } catch (err) {
        noteError(ctx, 'bath', err?.message ?? err);
        return { message: `Archiver: не удалось записать релиз (${String(err?.message ?? err)})` };
      }
    },
  };

  const testers = {
    // Поле — The Cleaner: проверяет полноту brief; первым словом «ОК»/«БАГ».
    async kitchen(ctx) {
      if (ctx.data.errors?.kitchen) {
        return bag(ctx, `Scraper не подготовил материалы: ${ctx.data.errors.kitchen}`, 'kitchen');
      }
      if (!String(ctx.data.brief ?? '').trim()) {
        return bag(ctx, 'Материалы пустые — Scraper ничего не собрал', 'kitchen');
      }

      const prompt = [
        'Ты — Cleaner на конвейере «Клауд Ферма». Реши, можно ли с этими материалами ПРИСТУПИТЬ к выполнению задачи.',
        `Задача: «${ctx.task.title}».`,
        `Материалы:\n${clip(ctx.data.brief)}`,
        'Будь снисходителен: по умолчанию «ОК». Ставь «БАГ» ТОЛЬКО если материалы пустые, не по теме или совсем бесполезны для задачи. НЕ требуй исчерпывающей информации, идеальной структуры или дополнительных уточнений — этого достаточно, если можно начать работу.',
        'ПЕРВЫМ СЛОВОМ ответа напиши «ОК» или «БАГ: причина». Ответ по-русски, кратко.',
      ].join('\n\n');

      const result = await ask(ctx, prompt);
      if (!result.ok) {
        return bag(ctx, `${cliLabel} недоступен: ${result.error}`, 'kitchen');
      }
      const verdict = parseVerdict(result.text);
      return verdict.ok ? verdict : bag(ctx, verdict.reason, 'kitchen');
    },

    // Амбар — The Validator: проверяет результат по существу против задачи.
    // БАГ => возврат на поле, замечание сохраняется для улучшения brief.
    async corridor(ctx) {
      if (ctx.data.errors?.corridor) {
        return bag(ctx, `Editor не выполнил задачу: ${ctx.data.errors.corridor}`, 'kitchen');
      }
      if (!String(ctx.data.result ?? '').trim()) {
        return bag(ctx, 'Результат пуст — задача не выполнена', 'kitchen');
      }

      const prompt = [
        'Ты — Validator на конвейере «Клауд Ферма». Прими результат, если задача в целом выполнена и результат пригоден к использованию.',
        `Задача: «${ctx.task.title}».`,
        ctx.task.input ? `Данные задачи:\n${clip(ctx.task.input, 4000)}` : null,
        `Результат:\n${clip(ctx.data.result)}`,
        'Высокий порог для брака: по умолчанию «ОК». Ставь «БАГ» ТОЛЬКО при критическом дефекте — результат пустой, не по теме, фактически неверный, не в том формате, или задача явно НЕ выполнена. НЕ браковать за «можно оригинальнее», «можно подробнее», «можно улучшить стиль» — это не дефекты. Хороший достаточный результат = «ОК».',
        'ПЕРВЫМ СЛОВОМ ответа напиши «ОК» или «БАГ: что не так». Ответ по-русски, кратко.',
      ]
        .filter(Boolean)
        .join('\n\n');

      const result = await ask(ctx, prompt);
      if (!result.ok) {
        return bag(ctx, `${cliLabel} недоступен: ${result.error}`, 'kitchen');
      }
      const verdict = parseVerdict(result.text);
      return verdict.ok ? verdict : bag(ctx, verdict.reason, 'kitchen');
    },

    // Теплица — The Sniffer: придирчивый поиск проблем; БАГ => в амбар.
    // В ультракоде Sniffer получает дайджест находок субагентов: реальные
    // проблемы из дайджеста => вердикт БАГ с причинами.
    async living(ctx) {
      if (ctx.data.errors?.living) {
        return bag(ctx, `Runner не посмотрел результат: ${ctx.data.errors.living}`, 'corridor');
      }

      const hasSubagents = Boolean(ctx.data.subagents?.count);
      const prompt = [
        'Ты — Sniffer, финальный контроль качества на конвейере «Клауд Ферма». Реши, можно ли выпускать результат клиенту.',
        `Задача: «${ctx.task.title}».`,
        `Результат:\n${clip(ctx.data.result)}`,
        ctx.data.qa
          ? `${hasSubagents ? 'Заметки пользователя (Runner) и находки субагентов' : 'Заметки пользователя (Runner)'}:\n${clip(ctx.data.qa, 4000)}`
          : null,
        hasSubagents
          ? 'Субагенты уже проверили результат. Ставь «БАГ» ТОЛЬКО если среди находок есть КРИТИЧЕСКАЯ проблема, делающая результат непригодным (фактическая ошибка, результат не решает задачу). Мелкие замечания и предложения по улучшению — НЕ повод для брака.'
          : null,
        'Высокий порог для брака: по умолчанию «ОК». «БАГ» — только критический дефект (результат не по теме, фактически неверный, задача не решена). НЕ браковать за стиль, полноту или «можно лучше».',
        'ПЕРВЫМ СЛОВОМ ответа напиши «ОК» или «БАГ: причина». Ответ по-русски, кратко.',
      ]
        .filter(Boolean)
        .join('\n\n');

      const result = await ask(ctx, prompt);
      if (!result.ok) {
        return bag(ctx, `${cliLabel} недоступен: ${result.error}`, 'corridor');
      }
      const verdict = parseVerdict(result.text);
      return verdict.ok ? verdict : bag(ctx, verdict.reason, 'corridor');
    },

    // Рынок — The Sign-Off: файлы релиза существуют и не пустые.
    async bath(ctx) {
      if (ctx.data.errors?.bath) {
        return bag(ctx, `Archiver не записал релиз: ${ctx.data.errors.bath}`, 'bath');
      }
      const baseDir = resolveOutputDir(ctx.config);
      const taskDir = ctx.data.release?.dir ?? path.join(baseDir, ctx.task.id);
      const resultPath = ctx.data.release?.resultPath ?? path.join(taskDir, 'result.md');
      const manifestPath =
        ctx.data.release?.manifestPath ?? path.join(taskDir, 'manifest.json');
      try {
        const [resultStat, manifestStat] = await Promise.all([
          stat(resultPath),
          stat(manifestPath),
        ]);
        if (resultStat.size > 0 && manifestStat.size > 0) {
          return { ok: true, note: 'Клиенту можно отправлять!' };
        }
        // Empty deliverable means the result itself is bad — regenerate it.
        return bag(
          ctx,
          'Файлы релиза пустые',
          String(ctx.data.result ?? '').trim() ? 'bath' : 'corridor'
        );
      } catch {
        return bag(ctx, 'Файлы релиза не найдены', 'bath');
      }
    },
  };

  return {
    async runDriver(zoneId, ctx) {
      const driver = drivers[zoneId];
      if (!driver) {
        throw new Error(`Неизвестная зона для драйвера: ${zoneId}`);
      }
      return driver(ctx);
    },
    async runTester(zoneId, ctx) {
      const tester = testers[zoneId];
      if (!tester) {
        throw new Error(`Неизвестная зона для тестера: ${zoneId}`);
      }
      return tester(ctx);
    },
  };
}
