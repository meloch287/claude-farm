// Tests for the farm orchestrator pipeline (contract-driven, sim runners only).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    outputDir: fs.mkdtempSync(os.tmpdir() + "/farm-"),
    zones: ZONES,
    ...overrides,
  };
}

// Distinct names + distinct real dates so the Sniffer never bounces.
function makeValidLines(count) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const day = String(((i - 1) % 28) + 1).padStart(2, "0");
    lines.push(`Сотрудник${i};${day}.06.2023`);
  }
  return lines;
}

function setup(configOverrides = {}, runners = createSimRunners()) {
  const config = makeConfig(configOverrides);
  const bus = createEventBus();
  const events = [];
  bus.subscribe((e) => events.push(e));
  const farm = createFarm(config, runners, bus);
  return { config, bus, events, farm };
}

test("счастливый путь: 20 валидных строк проходят все зоны с первой попытки", async () => {
  const { farm, events } = setup();
  const input = makeValidLines(20).join("\n");

  const result = await farm.runTask({ title: "Счастливый путь", input });

  assert.equal(result.ok, true, "задача должна завершиться успешно");
  assert.equal(result.task.attempts, 1, "должна быть ровно одна попытка");

  const types = events.map((e) => e.type);
  const enterCount = types.filter((t) => t === "zone.enter").length;
  assert.equal(enterCount, 4, "должно быть ровно 4 события zone.enter");
  assert.ok(types.includes("task.done"), "должно быть событие task.done");
  assert.ok(!types.includes("tester.bounce"), "не должно быть отскоков");
  assert.ok(!types.includes("task.failed"), "не должно быть провала");
});

test("невалидная дата 35.12.2023 на строке 13: один отскок, исправление, успех со второй попытки", async () => {
  const { farm, events } = setup();
  const lines = makeValidLines(20);
  lines[12] = "Игорь;35.12.2023"; // line 13 (1-based)
  const input = lines.join("\n");

  const result = await farm.runTask({ title: "Кривая дата", input });

  assert.equal(result.ok, true, "задача должна завершиться успешно после исправления");
  assert.equal(result.task.attempts, 2, "должно быть ровно две попытки");

  const bounces = events.filter((e) => e.type === "tester.bounce");
  assert.equal(bounces.length, 1, "должен быть ровно один tester.bounce");
  assert.equal(bounces[0].zone, "corridor", "отскок должен прийти из коридора (Validator)");

  // The bounce must send the task back to the kitchen: the next zone.enter
  // after the bounce event must be the kitchen.
  const bounceIdx = events.indexOf(bounces[0]);
  const nextEnter = events.slice(bounceIdx + 1).find((e) => e.type === "zone.enter");
  assert.ok(nextEnter, "после отскока должен быть вход в зону");
  assert.equal(nextEnter.zone, "kitchen", "после отскока задача возвращается на кухню");

  // Clamp rule: day 35 in December (31 days) clamps to 31 -> 31.12.2023.
  assert.ok(typeof result.data.csv === "string" && result.data.csv.length > 0, "csv должен быть собран");
  assert.ok(result.data.csv.includes("31.12.2023"), "csv должен содержать исправленную дату 31.12.2023");
  assert.ok(!result.data.csv.includes("35.12.2023"), "csv не должен содержать несуществующую дату 35.12.2023");
});

test("вечно недовольный тестировщик: task.failed после maxAttempts", async () => {
  const failingRunners = {
    runDriver: async () => ({}),
    runTester: async () => ({ ok: false, reason: "всегда баг", bounceTo: "kitchen" }),
  };
  const { farm, events, config } = setup({}, failingRunners);

  const result = await farm.runTask({ title: "Безнадёжная задача", input: "Сотрудник1;01.06.2023" });

  assert.equal(result.ok, false, "задача должна провалиться");

  const types = events.map((e) => e.type);
  assert.ok(types.includes("task.failed"), "должно быть событие task.failed");
  assert.ok(!types.includes("task.done"), "не должно быть события task.done");

  const bounceCount = types.filter((t) => t === "tester.bounce").length;
  assert.equal(bounceCount, config.maxAttempts, "отскоков должно быть ровно maxAttempts");
});

test("порядок событий: seq строго растёт, zone.enter предшествует driver.start в каждой зоне", async () => {
  const { farm, events } = setup();
  const input = makeValidLines(20).join("\n");

  await farm.runTask({ title: "Порядок событий", input });

  assert.ok(events.length > 0, "события должны быть");

  for (let i = 1; i < events.length; i++) {
    assert.ok(
      events[i].seq > events[i - 1].seq,
      `seq должен строго расти: ${events[i - 1].seq} -> ${events[i].seq}`,
    );
  }

  // Every driver.start must have a zone.enter for the same zone earlier,
  // and that zone.enter must be the most recent zone.enter before it.
  events.forEach((e, idx) => {
    if (e.type !== "driver.start") return;
    const priorEnters = events.slice(0, idx).filter((x) => x.type === "zone.enter");
    assert.ok(priorEnters.length > 0, "перед driver.start должен быть zone.enter");
    const lastEnter = priorEnters[priorEnters.length - 1];
    assert.equal(lastEnter.zone, e.zone, "driver.start должен идти после zone.enter своей зоны");
  });
});

test("архиватор: result.csv и manifest.json существуют и непусты в outputDir", async () => {
  const { farm, config } = setup();
  const input = makeValidLines(20).join("\n");

  const result = await farm.runTask({ title: "Проверка архива", input });
  assert.equal(result.ok, true, "задача должна завершиться успешно");

  const taskDir = path.join(config.outputDir, result.task.id);
  const csvPath = path.join(taskDir, "result.csv");
  const manifestPath = path.join(taskDir, "manifest.json");

  assert.ok(fs.existsSync(csvPath), "result.csv должен существовать");
  assert.ok(fs.existsSync(manifestPath), "manifest.json должен существовать");
  assert.ok(fs.statSync(csvPath).size > 0, "result.csv должен быть непустым");
  assert.ok(fs.statSync(manifestPath).size > 0, "manifest.json должен быть непустым");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(typeof manifest.title, "string", "в манифесте должен быть title");
});
