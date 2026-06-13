// Tests for the config system: global settings (defaults, roundtrip, strict
// PUT validation), per-task config merge, runner selection matrix
// (claude/sim fallback via injected availability) and the ultracode
// subagent fan-out with a stubbed runner fn. No real CLI is ever spawned.
// The engine is Claude-only — the settings/config shape is flat:
// {model, mode, subagents:{model,count,types}}.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SETTINGS,
  SIM_FALLBACK_NOTE,
  createSettingsStore,
  createTaskStore,
  mergeTaskConfig,
  normalizeSettings,
  selectExecutor,
  validateSettingsPatch,
} from "../src/tasks.mjs";
import {
  buildSubagentPrompt,
  planSubagents,
  runSubagentFanout,
  SUBAGENT_BRIEFS,
} from "../src/agents.mjs";
import { createEventBus } from "../src/events.mjs";

const ZONES = [
  { id: "kitchen", title: "Поле — Сбор", driver: { id: "scraper", name: "The Scraper" }, tester: { id: "cleaner", name: "The Cleaner" } },
  { id: "corridor", title: "Амбар — Обработка", driver: { id: "editor", name: "The Editor" }, tester: { id: "validator", name: "The Validator" } },
  { id: "living", title: "Теплица — QA", driver: { id: "runner", name: "The Runner" }, tester: { id: "sniffer", name: "The Sniffer" } },
  { id: "bath", title: "Рынок — Релиз", driver: { id: "archiver", name: "The Archiver" }, tester: { id: "signoff", name: "The Sign-Off" } },
];

function tmpConfig(overrides = {}) {
  return {
    maxAttempts: 3,
    stepDelayMs: 0,
    outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "farm-settings-")),
    zones: ZONES,
    ...overrides,
  };
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
// Global settings: defaults, persistence roundtrip, strict validation
// ---------------------------------------------------------------------------

test("настройки: дефолты точно по контракту (без файла на диске)", () => {
  const store = createSettingsStore({ config: tmpConfig() });
  assert.deepEqual(store.get(), {
    model: "claude-opus-4-8",
    mode: "ultracode",
    subagents: { model: "claude-sonnet-4-6", count: 3, types: ["review", "bugs"] },
  });
  // get() возвращает копию: мутация снаружи не портит стор.
  const copy = store.get();
  copy.model = "взломано";
  copy.subagents.types.push("hack");
  assert.equal(store.get().model, "claude-opus-4-8");
  assert.deepEqual(store.get().subagents.types, ["review", "bugs"]);
});

test("настройки: update сохраняет в output/settings.json и новый стор это читает", () => {
  const config = tmpConfig();
  const store = createSettingsStore({ config });

  const result = store.update({
    mode: "normal",
    subagents: { count: 5, types: ["optimize", "factcheck"] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.settings.mode, "normal");
  assert.equal(result.settings.subagents.count, 5);
  assert.deepEqual(result.settings.subagents.types, ["optimize", "factcheck"]);
  // Незатронутые поля остаются дефолтными.
  assert.equal(result.settings.model, "claude-opus-4-8");
  assert.equal(result.settings.subagents.model, "claude-sonnet-4-6");

  const file = path.join(config.outputDir, "settings.json");
  assert.ok(fs.existsSync(file), "settings.json должен существовать после update");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.mode, "normal");

  // «Рестарт»: новый стор на том же outputDir видит сохранённое.
  const store2 = createSettingsStore({ config });
  assert.deepEqual(store2.get(), result.settings);
});

test("настройки: мусорный патч отклоняется с русскими ошибками, стор не меняется", () => {
  const config = tmpConfig();
  const store = createSettingsStore({ config });
  const before = store.get();

  const bad = store.update({
    model: "",
    mode: "fast",
    subagents: { model: "", count: 99, types: ["hack"] },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 4, "каждое мусорное поле должно дать ошибку");
  for (const err of bad.errors) {
    assert.ok(/[А-Яа-яЁё]/.test(err), `ошибка должна быть по-русски: ${err}`);
  }
  assert.deepEqual(store.get(), before, "настройки не должны измениться");

  // Совсем не объект — тоже 400-кейс.
  assert.equal(store.update(null).ok, false);
  assert.equal(store.update([1, 2]).ok, false);
  assert.equal(validateSettingsPatch("мусор").length, 1);
});

test("настройки: битый settings.json на диске тихо деградирует в дефолты", () => {
  const config = tmpConfig();
  fs.writeFileSync(path.join(config.outputDir, "settings.json"), "{оборванный json", "utf8");
  const store = createSettingsStore({ config });
  assert.deepEqual(store.get(), normalizeSettings());
  assert.equal(store.get().model, "claude-opus-4-8");
});

// ---------------------------------------------------------------------------
// Per-task config merge
// ---------------------------------------------------------------------------

test("mergeTaskConfig: без per-task конфига — плоский клауд-конфиг из глобальных настроек", () => {
  assert.deepEqual(mergeTaskConfig(DEFAULT_SETTINGS, undefined), {
    model: "claude-opus-4-8",
    mode: "ultracode",
    subagents: { model: "claude-sonnet-4-6", count: 3, types: ["review", "bugs"] },
  });
  // Без настроек вообще — те же дефолты.
  assert.deepEqual(mergeTaskConfig(undefined, undefined), mergeTaskConfig(DEFAULT_SETTINGS, {}));
});

test("mergeTaskConfig: per-task поля перекрывают глобальные, мусор откатывается к глобальным", () => {
  const merged = mergeTaskConfig(DEFAULT_SETTINGS, {
    model: "claude-haiku-4-5-20251001",
    mode: "normal",
    subagents: { count: 8, types: ["factcheck"] },
  });
  assert.equal(merged.model, "claude-haiku-4-5-20251001");
  assert.equal(merged.mode, "normal");
  assert.equal(merged.subagents.count, 8);
  assert.deepEqual(merged.subagents.types, ["factcheck"]);
  assert.equal(merged.subagents.model, "claude-sonnet-4-6", "модель субагентов — из глобальных");

  const garbage = mergeTaskConfig(DEFAULT_SETTINGS, {
    model: "  ",
    mode: "fast",
    subagents: { count: 9, types: ["hack", "review"] },
  });
  assert.equal(garbage.model, "claude-opus-4-8");
  assert.equal(garbage.mode, "ultracode");
  assert.equal(garbage.subagents.count, 3, "count вне 0..8 откатывается");
  assert.deepEqual(garbage.subagents.types, ["review"], "неизвестные типы отфильтровываются");
});

// ---------------------------------------------------------------------------
// Runner selection matrix (pure selectExecutor + queue wiring)
// ---------------------------------------------------------------------------

test("selectExecutor: матрица клауд/сим-фолбэк", () => {
  const config = { executor: "claude" };

  // Клауд доступен => claude; недоступен => sim + русская заметка.
  assert.deepEqual(
    selectExecutor({ source: "manual", config, claudeAvailable: true }),
    { executor: "claude" },
  );
  assert.deepEqual(
    selectExecutor({ source: "manual", config, claudeAvailable: false }),
    { executor: "sim", note: SIM_FALLBACK_NOTE },
  );
  assert.equal(SIM_FALLBACK_NOTE, "claude CLI недоступен — выполнено симуляцией");

  // Демо всегда сим; без executor=claude в глобальном конфиге — тоже сим.
  assert.deepEqual(
    selectExecutor({ source: "demo", config, claudeAvailable: true }),
    { executor: "sim" },
  );
  assert.deepEqual(
    selectExecutor({ source: "manual", config: {}, claudeAvailable: true }),
    { executor: "sim" },
  );
  // Без аргументов вовсе — безопасный сим.
  assert.deepEqual(selectExecutor(), { executor: "sim" });
});

test("store: задача уходит на claude-раннер, конфиг хранится на задаче и переживает рестарт", async () => {
  const bus = createEventBus();
  const config = tmpConfig({ executor: "claude" });
  const calls = [];
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: true,
    runQueueTask: (spec, executor) => {
      calls.push({ id: spec.id, executor, config: spec.config });
      bus.emit({ type: "task.done", taskId: spec.id, message: "готово" });
      return Promise.resolve({ ok: true });
    },
  });

  const customTask = store.createTask({
    title: "Своя модель",
    input: "x",
    mode: "simple",
    config: { model: "claude-haiku-4-5-20251001", mode: "normal" },
  });
  const defaultTask = store.createTask({ title: "По дефолту", input: "y", mode: "simple" });

  assert.ok(await waitFor(() => calls.length === 2));
  for (const c of calls) {
    assert.equal(c.executor, "claude");
  }

  const customCall = calls.find((c) => c.id === customTask.id);
  assert.deepEqual(customCall.config, {
    model: "claude-haiku-4-5-20251001",
    mode: "normal",
    subagents: { model: "claude-sonnet-4-6", count: 3, types: ["review", "bugs"] },
  });

  // Конфиг хранится на задаче и отдаётся наружу (GET /api/tasks -> store.list()).
  const listed = store.list().find((t) => t.id === customTask.id);
  assert.deepEqual(listed.config, customCall.config);
  assert.equal(store.get(defaultTask.id).config.model, "claude-opus-4-8");
  assert.equal(store.get(defaultTask.id).config.mode, "ultracode");

  // «Рестарт»: конфиг восстанавливается из снапшота состояния фермы.
  const store2 = createTaskStore({
    bus: createEventBus(),
    config,
    runQueueTask: () => new Promise(() => {}),
  });
  assert.deepEqual(store2.get(customTask.id).config, customCall.config);
});

test("store: claude недоступен => sim с заметкой «claude CLI недоступен» после done", async () => {
  const bus = createEventBus();
  const config = tmpConfig({ executor: "claude" });
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

test("store: демо-задача всегда идёт на sim даже при доступном claude", async () => {
  const bus = createEventBus();
  const config = tmpConfig({ executor: "claude" });
  const calls = [];
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: true,
    runQueueTask: (spec, executor) => {
      calls.push(executor);
      bus.emit({ type: "task.done", taskId: spec.id, message: "готово" });
      return Promise.resolve({ ok: true });
    },
  });

  const task = store.createTask({ title: "Демо", input: "x", mode: "simple", source: "demo" });
  assert.ok(await waitFor(() => calls.length === 1));
  assert.deepEqual(calls, ["sim"]);
  assert.equal(store.get(task.id).executor, "sim");
});

// ---------------------------------------------------------------------------
// Ultracode subagent fan-out (stubbed ask — no real CLI)
// ---------------------------------------------------------------------------

test("planSubagents: count ограничен 8, типы циклически, пусто => []", () => {
  assert.deepEqual(
    planSubagents({ count: 5, types: ["review", "bugs"] }),
    ["review", "bugs", "review", "bugs", "review"],
  );
  assert.equal(planSubagents({ count: 99, types: ["review"] }).length, 8, "cap = 8");
  assert.deepEqual(planSubagents({ count: 0, types: ["review"] }), []);
  assert.deepEqual(planSubagents({ count: 3, types: [] }), []);
  assert.deepEqual(planSubagents({ count: 3, types: ["hack"] }), [], "неизвестные типы игнорируются");
  assert.deepEqual(planSubagents(undefined), []);
});

test("runSubagentFanout: параллельный запуск, дайджест по типам, ошибки не роняют ферму", async () => {
  const pending = [];
  const fanPromise = runSubagentFanout({
    subagents: { count: 3, types: ["review", "bugs", "factcheck"] },
    taskTitle: "Тестовая задача",
    result: "# Результат\nтекст",
    ask: (prompt) => new Promise((resolve) => pending.push({ prompt, resolve })),
  });

  // ПАРАЛЛЕЛЬНОСТЬ: все 3 вызова запущены до того, как хоть один ответил.
  assert.ok(await waitFor(() => pending.length === 3));
  assert.ok(pending[0].prompt.includes(SUBAGENT_BRIEFS.review));
  assert.ok(pending[1].prompt.includes(SUBAGENT_BRIEFS.bugs));
  assert.ok(pending[2].prompt.includes(SUBAGENT_BRIEFS.factcheck));
  assert.ok(pending.every((p) => p.prompt.includes("Тестовая задача")));

  pending[0].resolve({ ok: true, text: "Проблем не найдено" });
  pending[1].resolve({ ok: true, text: "Найдена ошибка в дате" });
  pending[2].resolve({ ok: false, error: "таймаут" });

  const fan = await fanPromise;
  assert.equal(fan.count, 3);
  assert.deepEqual(fan.types, ["review", "bugs", "factcheck"]);
  assert.equal(fan.findings.length, 3);
  assert.ok(fan.digest.includes("ревью"));
  assert.ok(fan.digest.includes("Найдена ошибка в дате"));
  assert.ok(fan.digest.includes("субагент недоступен: таймаут"), "ошибка субагента честно попадает в дайджест");
});

test("runSubagentFanout: пустой план — ноль вызовов, пустой дайджест", async () => {
  let asked = 0;
  const fan = await runSubagentFanout({
    subagents: { count: 0, types: ["review"] },
    result: "x",
    ask: () => {
      asked += 1;
      return Promise.resolve({ ok: true, text: "" });
    },
  });
  assert.equal(asked, 0);
  assert.deepEqual(fan, { count: 0, types: [], findings: [], digest: "" });
});

test("buildSubagentPrompt: каждый тип получает свою инструкцию и результат", () => {
  for (const [type, brief] of Object.entries(SUBAGENT_BRIEFS)) {
    const prompt = buildSubagentPrompt(type, "Задача X", "результат Y");
    assert.ok(prompt.includes(brief), `промпт ${type} должен содержать «${brief}»`);
    assert.ok(prompt.includes("результат Y"));
  }
});
