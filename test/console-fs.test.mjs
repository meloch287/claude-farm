// Tests for the two new features:
//   FEATURE 1 — GET /api/fs folder browser (listDirectories via the HTTP server):
//     folders-only listing of a temp dir, parent, HOME default, unreadable => error.
//   FEATURE 2 — console: the defensive action parser (parseConsoleActions),
//     the store methods cancelTask / retryTask transitions, and the full
//     POST /api/console flow with a STUBBED ask (no real CLI is ever spawned).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createTaskStore,
  parseConsoleActions,
} from "../src/tasks.mjs";
import { startServer } from "../src/server.mjs";
import { createEventBus } from "../src/events.mjs";

const ZONES = [
  { id: "kitchen", title: "Поле", driver: { id: "scraper" }, tester: { id: "cleaner" } },
  { id: "corridor", title: "Амбар", driver: { id: "editor" }, tester: { id: "validator" } },
  { id: "living", title: "Теплица", driver: { id: "runner" }, tester: { id: "sniffer" } },
  { id: "bath", title: "Рынок", driver: { id: "archiver" }, tester: { id: "signoff" } },
];

function makeConfig(overrides = {}) {
  return {
    maxAttempts: 3,
    stepDelayMs: 0,
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "farm-console-")),
    zones: ZONES,
    port: 0, // ephemeral
    // Skip the real `claude -p` boot probe so the server starts/stops fast and
    // never spawns a CLI in tests.
    detectCli: () => Promise.resolve(false),
    // Run the sim farm instantly so a console-created task does not keep the
    // event loop alive after the test closes the server.
    simStepDelayMs: 0,
    ...overrides,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

async function getJson(port, urlPath) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  return { status: res.status, body: await res.json() };
}
async function postJson(port, urlPath, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// FEATURE 1 — GET /api/fs folder browser
// ---------------------------------------------------------------------------

test("api/fs: перечисляет только подпапки временной директории + parent", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "farm-fs-"));
  fs.mkdirSync(path.join(tmp, "zebra"));
  fs.mkdirSync(path.join(tmp, "alpha"));
  fs.writeFileSync(path.join(tmp, "file.txt"), "не папка", "utf8");

  const { server, port } = await startServer({ config: makeConfig() });
  try {
    const { status, body } = await getJson(port, "/api/fs?path=" + encodeURIComponent(tmp));
    assert.equal(status, 200);
    assert.equal(body.path, fs.realpathSync(tmp) === tmp ? tmp : body.path); // resolved abs
    assert.equal(body.path, path.resolve(tmp));
    assert.equal(body.parent, path.dirname(path.resolve(tmp)));
    // Only directories, sorted, no files.
    assert.deepEqual(body.entries, [{ name: "alpha" }, { name: "zebra" }]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("api/fs: без path и с относительным путём — дефолт в HOME", async () => {
  const home = process.env.HOME || os.homedir();
  const { server, port } = await startServer({ config: makeConfig() });
  try {
    const noParam = await getJson(port, "/api/fs");
    assert.equal(noParam.status, 200);
    assert.equal(noParam.body.path, path.resolve(home));

    const relative = await getJson(port, "/api/fs?path=" + encodeURIComponent("relative/dir"));
    assert.equal(relative.body.path, path.resolve(home), "относительный путь => HOME");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("api/fs: корень ФС имеет parent=null", async () => {
  const { server, port } = await startServer({ config: makeConfig() });
  try {
    const { body } = await getJson(port, "/api/fs?path=" + encodeURIComponent("/"));
    assert.equal(body.path, "/");
    assert.equal(body.parent, null);
    assert.ok(Array.isArray(body.entries));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("api/fs: нечитаемая/несуществующая папка => entries:[] и русская ошибка, не бросает", async () => {
  const { server, port } = await startServer({ config: makeConfig() });
  try {
    const missing = "/" + "no-such-dir-" + Math.random().toString(36).slice(2);
    const { status, body } = await getJson(port, "/api/fs?path=" + encodeURIComponent(missing));
    assert.equal(status, 200);
    assert.deepEqual(body.entries, []);
    assert.equal(body.error, "Нет доступа к папке");
    assert.equal(body.path, missing);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// FEATURE 2 — parseConsoleActions (defensive)
// ---------------------------------------------------------------------------

test("parseConsoleActions: чистый JSON-блок с действиями", () => {
  const text = '{"actions":[{"type":"create","title":"Новая","input":"x"},{"type":"cancel","taskId":"t3"},{"type":"retry","taskId":"t5"}]}';
  assert.deepEqual(parseConsoleActions(text), [
    { type: "create", title: "Новая", input: "x" },
    { type: "cancel", taskId: "t3" },
    { type: "retry", taskId: "t5" },
  ]);
});

test("parseConsoleActions: блок, завёрнутый в прозу/markdown и с лишними скобками", () => {
  const text =
    "Конечно! Сделаю {это}. Вот действия:\n```json\n" +
    '{"actions":[{"type":"create","title":"Из прозы"}]}\n' +
    "```\nГотово.";
  assert.deepEqual(parseConsoleActions(text), [
    { type: "create", title: "Из прозы", input: "" },
  ]);
});

test("parseConsoleActions: мусор/без actions/битые поля => []", () => {
  assert.deepEqual(parseConsoleActions("просто текст без json"), []);
  assert.deepEqual(parseConsoleActions('{"foo":"bar"}'), []);
  assert.deepEqual(parseConsoleActions('{"actions":"не массив"}'), []);
  assert.deepEqual(parseConsoleActions('{"actions":[{"type":"create"}]}'), [], "create без title отброшен");
  assert.deepEqual(parseConsoleActions('{"actions":[{"type":"cancel"}]}'), [], "cancel без taskId отброшен");
  assert.deepEqual(parseConsoleActions('{"actions":[{"type":"unknown","taskId":"t1"}]}'), []);
  assert.deepEqual(parseConsoleActions(""), []);
  assert.deepEqual(parseConsoleActions(undefined), []);
});

// ---------------------------------------------------------------------------
// FEATURE 2 — cancelTask / retryTask store transitions
// ---------------------------------------------------------------------------

test("store.cancelTask: задача в очереди отменяется и удаляется; running/done нельзя", async () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const config = makeConfig();
  // Worker that never resolves: the first task stays "running", later ones queue.
  const store = createTaskStore({ bus, config, runQueueTask: () => new Promise(() => {}) });

  const running = store.createTask({ title: "Бежит", input: "a", mode: "simple" });
  const queued = store.createTask({ title: "В очереди", input: "b", mode: "simple" });

  // The first task is pulled onto the (never-resolving) worker; the second waits.
  assert.ok(await waitFor(() => store.get(queued.id).status === "queued"));

  // Cancel the still-queued one: removed from the store, task.failed emitted.
  const r = store.cancelTask(queued.id);
  assert.equal(r.ok, true);
  assert.equal(store.get(queued.id), undefined, "отменённая задача удалена");
  assert.ok(events.some((e) => e.type === "task.failed" && e.taskId === queued.id));

  // The running task cannot be cancelled (the FIFO worker owns it).
  const rRunning = store.cancelTask(running.id);
  assert.equal(rRunning.ok, false);

  // Unknown id.
  assert.equal(store.cancelTask("t999").ok, false);
});

test("store.retryTask: только проваленную можно перезапустить -> queued, attempts=1", () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const config = makeConfig();
  const store = createTaskStore({ bus, config, runQueueTask: () => new Promise(() => {}) });

  const task = store.createTask({ title: "Упадёт", input: "x", mode: "simple" });
  bus.emit({ type: "tester.bounce", taskId: task.id, message: "баг" }); // attempts -> 2
  bus.emit({ type: "task.failed", taskId: task.id, message: "сломалось" });
  assert.equal(store.get(task.id).status, "failed");
  assert.equal(store.get(task.id).attempts, 2);

  const r = store.retryTask(task.id);
  assert.equal(r.ok, true);
  assert.equal(store.get(task.id).status, "queued");
  assert.equal(store.get(task.id).attempts, 1, "счётчик попыток сброшен");
  // Re-enqueue emits task.queued; the store subscriber stamps that note.
  assert.match(store.get(task.id).lastMessage, /добавлена в очередь/);
  assert.ok(events.some((e) => e.type === "task.queued" && e.taskId === task.id));

  // A queued (non-failed) task cannot be retried.
  assert.equal(store.retryTask(task.id).ok, false);
});

// ---------------------------------------------------------------------------
// FEATURE 2 — applyConsoleActions directly (no CLI)
// ---------------------------------------------------------------------------

test("store.applyConsoleActions: create/cancel/retry применяются и возвращают detail", () => {
  const bus = createEventBus();
  const config = makeConfig();
  const store = createTaskStore({ bus, config, runQueueTask: () => new Promise(() => {}) });
  const board = store.listBoards().activeBoardId;

  const toCancel = store.createTask({ title: "Снять", input: "", mode: "simple" });
  // Force it to be queued (not running): create a never-resolving worker means
  // the very first task runs; create one more so toCancel is queued behind it.
  const filler = store.createTask({ title: "Заглушка", input: "", mode: "simple" });

  const failed = store.createTask({ title: "Провал", input: "", mode: "simple" });
  bus.emit({ type: "task.failed", taskId: failed.id, message: "упало" });

  const actions = [
    { type: "create", title: "Создаём из консоли", input: "данные" },
    { type: "cancel", taskId: filler.id }, // filler is queued behind the runner
    { type: "retry", taskId: failed.id },
    { type: "cancel", taskId: "t999" }, // not found => ok:false
  ];
  const results = store.applyConsoleActions(actions, { boardId: board });

  assert.equal(results.length, 4);
  assert.equal(results[0].type, "create");
  assert.equal(results[0].ok, true);
  assert.match(results[0].detail, /Создана задача/);
  // A freshly created task exists on the board.
  assert.ok(store.list(board).some((t) => t.title === "Создаём из консоли"));

  assert.equal(results[1].type, "cancel");
  assert.equal(results[1].ok, true);
  assert.equal(store.get(filler.id), undefined);

  assert.equal(results[2].type, "retry");
  assert.equal(results[2].ok, true);
  assert.equal(store.get(failed.id).status, "queued");

  assert.equal(results[3].ok, false, "несуществующая задача => ok:false");
  void toCancel;
});

// ---------------------------------------------------------------------------
// FEATURE 2 — POST /api/console end-to-end with a STUBBED ask (no real CLI)
// ---------------------------------------------------------------------------

test("api/console: stubbed ask, ответ + действия применяются к доске", async () => {
  const config = makeConfig();
  let seenPrompt = "";
  // Stub: echo a reply that carries one create action.
  const consoleAsk = async (prompt) => {
    seenPrompt = prompt;
    return {
      ok: true,
      text:
        "Создаю задачу для вас.\n```json\n" +
        '{"actions":[{"type":"create","title":"Задача из консоли","input":"тело"}]}\n' +
        "```",
    };
  };
  const { server, port } = await startServer({ config, consoleAsk });
  try {
    const { status, body } = await postJson(port, "/api/console", { message: "сделай задачу" });
    assert.equal(status, 200);
    assert.match(body.reply, /Создаю задачу/);
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0].type, "create");
    assert.equal(body.actions[0].ok, true);
    // The prompt actually carried the user message + board context.
    assert.match(seenPrompt, /сделай задачу/);
    assert.match(seenPrompt, /Текущие задачи на доске/);

    // The created task is now on the active board.
    const tasks = await getJson(port, "/api/tasks");
    assert.ok(tasks.body.tasks.some((t) => t.title === "Задача из консоли"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("api/console: пустое сообщение => 400; ask, вернувший ошибку => reply без действий", async () => {
  const config = makeConfig();
  const consoleAsk = async () => ({ ok: false, error: "таймаут 90000 мс" });
  const { server, port } = await startServer({ config, consoleAsk });
  try {
    const empty = await postJson(port, "/api/console", { message: "   " });
    assert.equal(empty.status, 400);

    const failed = await postJson(port, "/api/console", { message: "привет" });
    assert.equal(failed.status, 200);
    assert.match(failed.body.reply, /Клауд не ответил/);
    assert.deepEqual(failed.body.actions, []);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
