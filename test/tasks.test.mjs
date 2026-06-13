// Tests for the task store: parseSubtaskJson, bus-driven status transitions,
// simple-mode end-to-end through a real farm, persistence snapshot.
// The real claude CLI is NEVER spawned here (no ai-mode end-to-end).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTaskStore, parseSubtaskJson, selectExecutor, SIM_FALLBACK_NOTE } from "../src/tasks.mjs";
import { createFarm } from "../src/orchestrator.mjs";
import { createSimRunners } from "../src/agents.mjs";
import { createEventBus } from "../src/events.mjs";

const ZONES = [
  { id: "kitchen", title: "Поле — Сбор", driver: { id: "scraper", name: "The Scraper" }, tester: { id: "cleaner", name: "The Cleaner" } },
  { id: "corridor", title: "Амбар — Обработка", driver: { id: "editor", name: "The Editor" }, tester: { id: "validator", name: "The Validator" } },
  { id: "living", title: "Теплица — QA", driver: { id: "runner", name: "The Runner" }, tester: { id: "sniffer", name: "The Sniffer" } },
  { id: "bath", title: "Рынок — Релиз", driver: { id: "archiver", name: "The Archiver" }, tester: { id: "signoff", name: "The Sign-Off" } },
];

function makeConfig(overrides = {}) {
  return {
    maxAttempts: 3,
    stepDelayMs: 0,
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "farm-tasks-")),
    zones: ZONES,
    ...overrides,
  };
}

function makeValidLines(count) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const day = String(((i - 1) % 28) + 1).padStart(2, "0");
    lines.push(`Сотрудник${i};${day}.06.2023`);
  }
  return lines;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// parseSubtaskJson
// ---------------------------------------------------------------------------

test("parseSubtaskJson: чистый JSON-массив парсится в подзадачи", () => {
  const text = '[{"title":"Шаг один","input":"a"},{"title":"Шаг два","input":"b"}]';
  assert.deepEqual(parseSubtaskJson(text), [
    { title: "Шаг один", input: "a" },
    { title: "Шаг два", input: "b" },
  ]);
});

test("parseSubtaskJson: массив, завёрнутый в прозу (и с лишними скобками до него)", () => {
  const text =
    'Конечно! Смотри [ниже] список подзадач:\n```json\n' +
    '[{"title":"Скобки [в строке]","input":"x;y"},{"title":"Вторая","input":""}]\n' +
    "```\nГотово!";
  assert.deepEqual(parseSubtaskJson(text), [
    { title: "Скобки [в строке]", input: "x;y" },
    { title: "Вторая", input: "" },
  ]);
});

test("parseSubtaskJson: мусор, не-массивы и пустые массивы дают null", () => {
  assert.equal(parseSubtaskJson("ничего полезного тут нет"), null);
  assert.equal(parseSubtaskJson('{"title":"объект, а не массив"}'), null);
  assert.equal(parseSubtaskJson("[1, 2, 3]"), null);
  assert.equal(parseSubtaskJson("[]"), null);
  assert.equal(parseSubtaskJson('[{"input":"без title"}]'), null);
  assert.equal(parseSubtaskJson(""), null);
  assert.equal(parseSubtaskJson(undefined), null);
});

// ---------------------------------------------------------------------------
// Store transitions driven by synthetic bus events
// ---------------------------------------------------------------------------

test("store: переходы статусов по событиям шины (zone.enter, bounce, done, failed)", () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const config = makeConfig();
  // Worker stub never resolves: the task stays "on the farm" during the test.
  const store = createTaskStore({ bus, config, runQueueTask: () => new Promise(() => {}) });

  const created = store.createTask({ title: "Тест", input: "Сотрудник1;01.06.2023", mode: "simple" });
  assert.equal(created.status, "queued");
  assert.equal(created.source, "manual");
  assert.equal(created.attempts, 1);

  const queuedEvents = events.filter((e) => e.type === "task.queued");
  assert.equal(queuedEvents.length, 1, "при постановке в очередь должно быть событие task.queued");
  assert.equal(queuedEvents[0].taskId, created.id);
  assert.equal(queuedEvents[0].message, "Задача „Тест“ добавлена в очередь");

  bus.emit({ type: "zone.enter", taskId: created.id, zone: "kitchen", message: "вошли на кухню" });
  assert.equal(store.get(created.id).status, "kitchen");
  assert.equal(store.get(created.id).lastMessage, "вошли на кухню");

  bus.emit({ type: "tester.bounce", taskId: created.id, zone: "corridor", message: "нашёлся баг" });
  assert.equal(store.get(created.id).attempts, 2, "tester.bounce должен увеличить attempts");
  assert.equal(store.get(created.id).lastMessage, "нашёлся баг");

  bus.emit({ type: "zone.enter", taskId: created.id, zone: "living", message: "в гостиной" });
  assert.equal(store.get(created.id).status, "living");

  bus.emit({ type: "task.done", taskId: created.id, message: "готово" });
  const done = store.get(created.id);
  assert.equal(done.status, "done");
  assert.equal(typeof done.finishedAt, "string", "done должен проставить finishedAt");

  // Second task: failure path.
  const failing = store.createTask({ title: "Провальная", input: "x", mode: "simple" });
  bus.emit({ type: "task.failed", taskId: failing.id, message: "попытки закончились" });
  assert.equal(store.get(failing.id).status, "failed");
  assert.equal(store.get(failing.id).lastMessage, "попытки закончились");

  // Events for unknown tasks must be ignored.
  bus.emit({ type: "task.done", taskId: "t999", message: "чужое событие" });
  assert.equal(store.get("t999"), undefined);
});

// ---------------------------------------------------------------------------
// Simple mode end-to-end through a real farm (sim runners)
// ---------------------------------------------------------------------------

test("store: простая задача проходит настоящую ферму до done, очередь строго FIFO", async () => {
  const bus = createEventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const config = makeConfig();
  const farm = createFarm(config, createSimRunners(), bus);
  const store = createTaskStore({ bus, config, runQueueTask: (spec) => farm.runTask(spec) });

  const first = store.createTask({ title: "Сквозная №1", input: makeValidLines(5).join("\n"), mode: "simple" });
  const second = store.createTask({ title: "Сквозная №2", input: makeValidLines(7).join("\n"), mode: "simple" });

  assert.ok(
    await waitFor(() => store.get(second.id).status === "done"),
    "обе задачи должны дойти до done",
  );
  assert.equal(store.get(first.id).status, "done");
  assert.equal(store.get(first.id).attempts, 1);
  assert.equal(typeof store.get(first.id).finishedAt, "string");

  // Farm events must carry the STORE id (orchestrator honors spec.id).
  assert.ok(events.some((e) => e.type === "task.done" && e.taskId === first.id));

  // Strict FIFO: the second task enters the farm only after the first is done.
  const firstDoneIdx = events.findIndex((e) => e.type === "task.done" && e.taskId === first.id);
  const secondStartIdx = events.findIndex((e) => e.type === "task.created" && e.taskId === second.id);
  assert.ok(firstDoneIdx >= 0 && secondStartIdx >= 0);
  assert.ok(secondStartIdx > firstDoneIdx, "вторая задача стартует строго после завершения первой");

  // list() exposes both records.
  const ids = store.list().map((t) => t.id);
  assert.ok(ids.includes(first.id) && ids.includes(second.id));
});

// ---------------------------------------------------------------------------
// Persistence: snapshot write + load
// ---------------------------------------------------------------------------

test("store: снапшот пишется в farm-state.json и восстанавливается на старте", async () => {
  const bus = createEventBus();
  const config = makeConfig();
  const farm = createFarm(config, createSimRunners(), bus);
  const store = createTaskStore({ bus, config, runQueueTask: (spec) => farm.runTask(spec) });

  const task = store.createTask({ title: "Переживёт рестарт", input: makeValidLines(3).join("\n"), mode: "simple" });
  assert.ok(await waitFor(() => store.get(task.id).status === "done"));

  // Snapshot file exists and contains the finished task.
  const stateFile = path.join(config.outputDir, "farm-state.json");
  assert.ok(fs.existsSync(stateFile), "farm-state.json должен существовать");
  const snapshot = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const saved = snapshot.tasks.find((t) => t.id === task.id);
  assert.ok(saved, "задача должна быть в снапшоте");
  assert.equal(saved.status, "done");

  // "Restart": a fresh store on the same outputDir restores the finished task.
  const store2 = createTaskStore({
    bus: createEventBus(),
    config,
    runQueueTask: () => new Promise(() => {}),
  });
  const restored = store2.get(task.id);
  assert.ok(restored, "после рестарта задача должна восстановиться");
  assert.equal(restored.status, "done");
  assert.equal(restored.title, "Переживёт рестарт");
  assert.equal(typeof restored.finishedAt, "string");
});

test("store: задачи, застрявшие в пайплайне, восстанавливаются как queued и встают в очередь", async () => {
  const config = makeConfig();
  const stateFile = path.join(config.outputDir, "tasks-state.json");
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      tasks: [
        { id: "t3", title: "Висела на кухне", input: "x", source: "manual", status: "kitchen", attempts: 2, lastMessage: "шла работа", createdAt: "2026-06-12T00:00:00.000Z" },
        { id: "t4", title: "Готовая", input: "y", source: "demo", status: "done", attempts: 1, lastMessage: "готово", createdAt: "2026-06-12T00:00:00.000Z", finishedAt: "2026-06-12T00:01:00.000Z" },
        { id: "t5", title: "Разбивалась", input: "z", source: "ai-parent", status: "splitting", attempts: 1, lastMessage: "", createdAt: "2026-06-12T00:00:00.000Z" },
      ],
    }),
    "utf8",
  );

  const bus = createEventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const started = [];
  const store = createTaskStore({
    bus,
    config,
    runQueueTask: (spec) => {
      started.push(spec.id);
      return new Promise(() => {});
    },
  });

  // Mid-pipeline -> queued (and re-enqueued: task.queued + worker start).
  assert.equal(store.get("t3").status, "queued");
  assert.equal(store.get("t3").attempts, 2, "attempts должны сохраниться");
  assert.ok(events.some((e) => e.type === "task.queued" && e.taskId === "t3"));
  assert.ok(await waitFor(() => started.includes("t3")));

  // Finished -> restored as-is.
  assert.equal(store.get("t4").status, "done");
  assert.equal(store.get("t4").source, "demo");

  // Interrupted splitting parent cannot resume -> failed with a Russian reason.
  assert.equal(store.get("t5").status, "failed");
  assert.equal(store.get("t5").lastMessage, "Разбиение прервано перезапуском сервера");

  // The id counter continues past restored ids: no collisions.
  const fresh = store.createTask({ title: "Новая", input: "", mode: "simple" });
  assert.equal(fresh.id, "t6");
});

// ---------------------------------------------------------------------------
// Runner selection: selectExecutor (pure) + queue worker wiring.
// The real claude CLI is NEVER spawned — availability is injected as a flag.
// ---------------------------------------------------------------------------

test("selectExecutor: demo-задача всегда идёт на симуляцию, даже при доступном CLI", () => {
  assert.deepEqual(
    selectExecutor({ source: "demo", config: { executor: "claude" }, claudeAvailable: true }),
    { executor: "sim" },
  );
});

test("selectExecutor: executor=claude и CLI доступен => claude", () => {
  assert.deepEqual(
    selectExecutor({ source: "manual", config: { executor: "claude" }, claudeAvailable: true }),
    { executor: "claude" },
  );
  assert.deepEqual(
    selectExecutor({ source: "subtask", config: { executor: "claude" }, claudeAvailable: true }),
    { executor: "claude" },
  );
});

test("selectExecutor: executor=claude, но CLI недоступен => sim с заметкой о фолбэке", () => {
  const pick = selectExecutor({ source: "manual", config: { executor: "claude" }, claudeAvailable: false });
  assert.equal(pick.executor, "sim");
  assert.equal(pick.note, SIM_FALLBACK_NOTE);
  assert.equal(pick.note, "claude CLI недоступен — выполнено симуляцией");
});

test("selectExecutor: без executor=claude в конфиге => sim без заметки", () => {
  assert.deepEqual(
    selectExecutor({ source: "manual", config: {}, claudeAvailable: true }),
    { executor: "sim" },
  );
  assert.deepEqual(selectExecutor({}), { executor: "sim" });
});

test("store: воркер выбирает раннеры на задачу — demo=>sim, manual=>claude (флаг доступности инжектится)", async () => {
  const bus = createEventBus();
  const config = makeConfig({ executor: "claude" });
  const calls = [];
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: true,
    runQueueTask: (spec, executor) => {
      calls.push({ id: spec.id, executor });
      bus.emit({ type: "task.done", taskId: spec.id, message: "готово" });
      return Promise.resolve({ ok: true });
    },
  });

  const demo = store.createTask({ title: "Демо", input: "x", mode: "simple", source: "demo" });
  const manual = store.createTask({ title: "Настоящая", input: "y", mode: "simple" });

  assert.ok(await waitFor(() => calls.length === 2));
  assert.equal(calls.find((c) => c.id === demo.id).executor, "sim");
  assert.equal(calls.find((c) => c.id === manual.id).executor, "claude");
  assert.equal(store.get(demo.id).executor, "sim");
  assert.equal(store.get(manual.id).executor, "claude");
});

test("store: CLI недоступен => фолбэк на sim и заметка в lastMessage после done", async () => {
  const bus = createEventBus();
  const config = makeConfig({ executor: "claude" });
  const calls = [];
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: false,
    runQueueTask: (spec, executor) => {
      calls.push(executor);
      bus.emit({ type: "task.done", taskId: spec.id, message: "готово" });
      return Promise.resolve({ ok: true });
    },
  });

  const task = store.createTask({ title: "Без CLI", input: "z", mode: "simple" });
  assert.ok(await waitFor(() => store.get(task.id).status === "done"
    && store.get(task.id).lastMessage === SIM_FALLBACK_NOTE));
  assert.deepEqual(calls, ["sim"]);
  assert.equal(store.get(task.id).executor, "sim");
});

test("store: доступность может приходить функцией с промисом (как с сервера)", async () => {
  const bus = createEventBus();
  const config = makeConfig({ executor: "claude" });
  const calls = [];
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: () => Promise.resolve(true),
    runQueueTask: (spec, executor) => {
      calls.push(executor);
      bus.emit({ type: "task.done", taskId: spec.id, message: "готово" });
      return Promise.resolve({ ok: true });
    },
  });

  const task = store.createTask({ title: "Промис-флаг", input: "w", mode: "simple" });
  assert.ok(await waitFor(() => store.get(task.id).status === "done"));
  assert.deepEqual(calls, ["claude"]);
});
