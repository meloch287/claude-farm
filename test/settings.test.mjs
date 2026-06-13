// Tests for the config system: global settings (defaults, roundtrip, strict
// PUT validation), per-task config merge, runner selection matrix
// (claude/codex/fallbacks via injected availability) and the ultracode
// subagent fan-out with a stubbed runner fn. No real CLI is ever spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SETTINGS,
  SIM_FALLBACK_NOTE,
  CODEX_FALLBACK_NOTE,
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
    engine: "claude",
    claude: {
      model: "claude-opus-4-8",
      mode: "ultracode",
      subagents: { model: "claude-sonnet-4-6", count: 3, types: ["review", "bugs"] },
    },
    codex: { model: "gpt-5.5", speed: "normal" },
  });
  // get() возвращает копию: мутация снаружи не портит стор.
  const copy = store.get();
  copy.engine = "codex";
  copy.claude.subagents.types.push("hack");
  assert.equal(store.get().engine, "claude");
  assert.deepEqual(store.get().claude.subagents.types, ["review", "bugs"]);
});

test("настройки: update сохраняет в output/settings.json и новый стор это читает", () => {
  const config = tmpConfig();
  const store = createSettingsStore({ config });

  const result = store.update({
    engine: "codex",
    claude: { mode: "normal", subagents: { count: 5, types: ["optimize", "factcheck"] } },
    codex: { speed: "faster" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.settings.engine, "codex");
  assert.equal(result.settings.claude.mode, "normal");
  assert.equal(result.settings.claude.subagents.count, 5);
  assert.deepEqual(result.settings.claude.subagents.types, ["optimize", "factcheck"]);
  assert.equal(result.settings.codex.speed, "faster");
  // Незатронутые поля остаются дефолтными.
  assert.equal(result.settings.claude.model, "claude-opus-4-8");

  const file = path.join(config.outputDir, "settings.json");
  assert.ok(fs.existsSync(file), "settings.json должен существовать после update");
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.engine, "codex");

  // «Рестарт»: новый стор на том же outputDir видит сохранённое.
  const store2 = createSettingsStore({ config });
  assert.deepEqual(store2.get(), result.settings);
});

test("настройки: мусорный патч отклоняется с русскими ошибками, стор не меняется", () => {
  const config = tmpConfig();
  const store = createSettingsStore({ config });
  const before = store.get();

  const bad = store.update({
    engine: "gpt",
    claude: { model: "", mode: "fast", subagents: { count: 99, types: ["hack"] } },
    codex: { speed: "turbo" },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 5, "каждое мусорное поле должно дать ошибку");
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
  assert.equal(store.get().engine, "claude");
});

// ---------------------------------------------------------------------------
// Per-task config merge
// ---------------------------------------------------------------------------

test("mergeTaskConfig: без per-task конфига — плоский клауд-конфиг из глобальных настроек", () => {
  assert.deepEqual(mergeTaskConfig(DEFAULT_SETTINGS, undefined), {
    engine: "claude",
    model: "claude-opus-4-8",
    mode: "ultracode",
    subagents: { model: "claude-sonnet-4-6", count: 3, types: ["review", "bugs"] },
  });
  // Без настроек вообще — те же дефолты.
  assert.deepEqual(mergeTaskConfig(undefined, undefined), mergeTaskConfig(DEFAULT_SETTINGS, {}));
});

test("mergeTaskConfig: engine=codex даёт {engine, model, speed} без субагентов", () => {
  const merged = mergeTaskConfig(DEFAULT_SETTINGS, { engine: "codex" });
  assert.deepEqual(merged, { engine: "codex", model: "gpt-5.5", speed: "normal" });
  assert.ok(!("subagents" in merged), "в кодекс-конфиге не должно быть субагентов");

  const fast = mergeTaskConfig(DEFAULT_SETTINGS, { engine: "codex", model: "gpt-6", speed: "faster" });
  assert.deepEqual(fast, { engine: "codex", model: "gpt-6", speed: "faster" });
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
    engine: "gpt",
    model: "  ",
    mode: "fast",
    subagents: { count: 9, types: ["hack", "review"] },
  });
  assert.equal(garbage.engine, "claude");
  assert.equal(garbage.model, "claude-opus-4-8");
  assert.equal(garbage.mode, "ultracode");
  assert.equal(garbage.subagents.count, 3, "count вне 0..8 откатывается");
  assert.deepEqual(garbage.subagents.types, ["review"], "неизвестные типы отфильтровываются");
});

// ---------------------------------------------------------------------------
// Runner selection matrix (pure selectExecutor + queue wiring)
// ---------------------------------------------------------------------------

test("selectExecutor: матрица клауд/кодекс/фолбэки", () => {
  const config = { executor: "claude" };
  const claudeCfg = mergeTaskConfig(DEFAULT_SETTINGS, {});
  const codexCfg = mergeTaskConfig(DEFAULT_SETTINGS, { engine: "codex" });

  // Клауд: доступен => claude, нет => sim + русская заметка.
  assert.deepEqual(
    selectExecutor({ source: "manual", config, taskConfig: claudeCfg, claudeAvailable: true, codexAvailable: true }),
    { executor: "claude" },
  );
  assert.deepEqual(
    selectExecutor({ source: "manual", config, taskConfig: claudeCfg, claudeAvailable: false, codexAvailable: true }),
    { executor: "sim", note: SIM_FALLBACK_NOTE },
  );

  // Кодекс: доступен => codex, нет => sim + заметка про codex CLI.
  assert.deepEqual(
    selectExecutor({ source: "manual", config, taskConfig: codexCfg, claudeAvailable: true, codexAvailable: true }),
    { executor: "codex" },
  );
  assert.deepEqual(
    selectExecutor({ source: "manual", config, taskConfig: codexCfg, claudeAvailable: true, codexAvailable: false }),
    { executor: "sim", note: CODEX_FALLBACK_NOTE },
  );
  assert.equal(CODEX_FALLBACK_NOTE, "codex CLI недоступен — выполнено симуляцией");

  // Демо всегда сим; без executor=claude в глобальном конфиге — тоже сим.
  assert.deepEqual(
    selectExecutor({ source: "demo", config, taskConfig: codexCfg, claudeAvailable: true, codexAvailable: true }),
    { executor: "sim" },
  );
  assert.deepEqual(
    selectExecutor({ source: "manual", config: {}, taskConfig: codexCfg, codexAvailable: true }),
    { executor: "sim" },
  );
});

test("store: кодекс-задача уходит на codex-раннеры, конфиг хранится на задаче и переживает рестарт", async () => {
  const bus = createEventBus();
  const config = tmpConfig({ executor: "claude" });
  const calls = [];
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: true,
    codexAvailable: () => Promise.resolve(true),
    runQueueTask: (spec, executor) => {
      calls.push({ id: spec.id, executor, config: spec.config });
      bus.emit({ type: "task.done", taskId: spec.id, message: "готово" });
      return Promise.resolve({ ok: true });
    },
  });

  const codexTask = store.createTask({
    title: "Через Кодекс",
    input: "x",
    mode: "simple",
    config: { engine: "codex", speed: "faster" },
  });
  const claudeTask = store.createTask({ title: "Через Клауд", input: "y", mode: "simple" });

  assert.ok(await waitFor(() => calls.length === 2));
  const codexCall = calls.find((c) => c.id === codexTask.id);
  assert.equal(codexCall.executor, "codex");
  assert.deepEqual(codexCall.config, { engine: "codex", model: "gpt-5.5", speed: "faster" });
  assert.equal(calls.find((c) => c.id === claudeTask.id).executor, "claude");

  // Конфиг хранится на задаче и отдаётся наружу (GET /api/tasks -> store.list()).
  const listed = store.list().find((t) => t.id === codexTask.id);
  assert.deepEqual(listed.config, { engine: "codex", model: "gpt-5.5", speed: "faster" });
  assert.equal(store.get(claudeTask.id).config.engine, "claude");
  assert.equal(store.get(claudeTask.id).config.mode, "ultracode");

  // «Рестарт»: конфиг восстанавливается из tasks-state.json.
  const store2 = createTaskStore({
    bus: createEventBus(),
    config,
    runQueueTask: () => new Promise(() => {}),
  });
  assert.deepEqual(store2.get(codexTask.id).config, { engine: "codex", model: "gpt-5.5", speed: "faster" });
});

test("store: кодекс недоступен => sim с заметкой «codex CLI недоступен» после done", async () => {
  const bus = createEventBus();
  const config = tmpConfig({ executor: "claude" });
  const calls = [];
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: true,
    codexAvailable: false,
    runQueueTask: (spec, executor) => {
      calls.push(executor);
      bus.emit({ type: "task.done", taskId: spec.id, message: "готово" });
      return Promise.resolve({ ok: true });
    },
  });

  const task = store.createTask({ title: "Кодекс без CLI", input: "z", mode: "simple", config: { engine: "codex" } });
  assert.ok(await waitFor(() => store.get(task.id).status === "done"
    && store.get(task.id).lastMessage === CODEX_FALLBACK_NOTE));
  assert.deepEqual(calls, ["sim"]);
  assert.equal(store.get(task.id).executor, "sim");
});

test("store: getSettings задаёт глобальный движок — задачи без конфига идут на кодекс", async () => {
  const bus = createEventBus();
  const config = tmpConfig({ executor: "claude" });
  const calls = [];
  const store = createTaskStore({
    bus,
    config,
    claudeAvailable: true,
    codexAvailable: true,
    getSettings: () => ({ ...structuredClone(DEFAULT_SETTINGS), engine: "codex" }),
    runQueueTask: (spec, executor) => {
      calls.push(executor);
      bus.emit({ type: "task.done", taskId: spec.id, message: "готово" });
      return Promise.resolve({ ok: true });
    },
  });

  const task = store.createTask({ title: "Глобальный кодекс", input: "x", mode: "simple" });
  assert.ok(await waitFor(() => calls.length === 1));
  assert.deepEqual(calls, ["codex"]);
  assert.equal(store.get(task.id).config.engine, "codex");
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
