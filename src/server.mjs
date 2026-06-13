// HTTP server for "Клауд Ферма": serves the pixel dashboard, streams farm
// events over SSE and exposes a state snapshot, the task API and the global
// settings API (GET/PUT /api/settings).

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createEventBus } from './events.mjs';
import { createFarm } from './orchestrator.mjs';
import { createSimRunners, createClaudeRunners, createCodexRunners } from './agents.mjs';
import {
  createTaskStore,
  createSettingsStore,
  detectClaudeCli,
  detectCodexCli,
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

/**
 * Start the farm dashboard server.
 * @param {{config: object, bus?: object}} options
 * @returns {Promise<{server: import('node:http').Server, port: number}>}
 */
export function startServer({ config = {}, bus = createEventBus() } = {}) {
  const requestedPort = config.port ?? 8787;
  // Sim farm: fallback executor when the claude CLI is unavailable.
  // stepDelayMs paces sim events at ~15s per zone (5 events x 3000ms) so the
  // dashboard choreography (boss walk -> handoff -> work -> carry -> check)
  // stays within one beat of reality without the catch-up queue compressing it.
  // Tests and the CLI pass their own config and are unaffected.
  const simFarm = createFarm({ ...config, stepDelayMs: 3000 }, createSimRunners(), bus);
  // Real executors: the claude and codex CLI farms. Minimal pacing — the CLI
  // calls are the natural delay, and the boss wants real tasks done fast.
  const claudeFarm = createFarm(
    { ...config, stepDelayMs: 300 },
    createClaudeRunners(config),
    bus
  );
  const codexFarm = createFarm(
    { ...config, stepDelayMs: 300 },
    createCodexRunners(config),
    bus
  );

  // Probe both CLIs ONCE at boot; the cached results pick the executor per
  // task and are exposed in /api/state as {claudeExecutor, codexExecutor}.
  let claudeExecutor = false;
  const claudeAvailable = detectClaudeCli().then((ok) => {
    claudeExecutor = ok;
    return ok;
  });
  let codexExecutor = false;
  const codexAvailable = detectCodexCli().then((ok) => {
    codexExecutor = ok;
    return ok;
  });

  // Global settings (engine Клауд/Кодекс, models, ultracode subagents),
  // persisted at output/settings.json.
  const settings = createSettingsStore({ config });

  // Task store: kanban board state + strictly sequential FIFO queue feeding
  // one farm at a time. Persists/restores output/tasks-state.json.
  const farms = { sim: simFarm, claude: claudeFarm, codex: codexFarm };
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: () => claudeAvailable,
    codexAvailable: () => codexAvailable,
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
      body = JSON.parse((await readBody(req)) || '{}');
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
    const task = store.createTask({ title, input, mode, config: taskConfig });
    sendJson(res, 202, { taskId: task.id });
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
      zone: typeof event.zone === 'string' ? event.zone : undefined,
      role: typeof event.role === 'string' ? event.role : undefined,
      message: typeof event.message === 'string' ? event.message.slice(0, 500) : '',
    });
    sendJson(res, 200, { ok: true });
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
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      sendText(res, 400, 'Некорректный запрос');
      return;
    }

    try {
      if (req.method === 'GET' && pathname === '/events') {
        handleSse(req, res);
        return;
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, {
          zones: config.zones ?? [],
          claudeExecutor,
          codexExecutor,
          engine: settings.get().engine,
          claudeModels: config.claudeModels ?? [],
          codexModels: config.codexModels ?? [],
          history: bus.history().slice(-100),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/tasks') {
        sendJson(res, 200, { tasks: store.list() });
        return;
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
