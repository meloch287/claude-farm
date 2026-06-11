// HTTP server for "Клауд Ферма": serves the pixel dashboard, streams farm
// events over SSE, exposes a state snapshot and a demo trigger.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createEventBus } from './events.mjs';
import { createFarm } from './orchestrator.mjs';
import { createSimRunners } from './agents.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_DIR = path.join(ROOT, 'dashboard');
const DEMO_FILE = path.join(ROOT, 'demo', 'demo-task.txt');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
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

/**
 * Start the farm dashboard server.
 * @param {{config: object, bus?: object}} options
 * @returns {Promise<{server: import('node:http').Server, port: number}>}
 */
export function startServer({ config = {}, bus = createEventBus() } = {}) {
  const requestedPort = config.port ?? 8787;
  // One farm instance per server so demo task ids keep incrementing (t1, t2, ...).
  const demoFarm = createFarm({ ...config, stepDelayMs: 600 }, createSimRunners(), bus);

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

  async function handleDemo(res) {
    let input;
    try {
      input = await readFile(DEMO_FILE, 'utf8');
    } catch {
      sendJson(res, 500, { error: 'Не найден файл demo/demo-task.txt' });
      return;
    }
    // Fire and forget: the dashboard watches progress via /events.
    demoFarm.runTask({ title: 'Демо: список клиентов', input }).catch(() => {});
    sendJson(res, 200, { taskId: 'started' });
  }

  async function handleStatic(pathname, res) {
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
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
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
          history: bus.history().slice(-100),
        });
        return;
      }
      if (req.method === 'POST' && pathname === '/api/demo') {
        await handleDemo(res);
        return;
      }
      if (req.method === 'GET') {
        await handleStatic(pathname, res);
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
