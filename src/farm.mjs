#!/usr/bin/env node
// CLI entry for "Клауд Ферма".
// Commands: demo | serve [--port N] [--no-open] | run "<title>" --input <file> [--real]
// Project root is resolved relative to import.meta.url, so the CLI works
// from any cwd.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createEventBus } from './events.mjs';
import { createFarm } from './orchestrator.mjs';
import { createSimRunners, createClaudeRunners } from './agents.mjs';
import { startServer } from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'farm.config.json');
const DEMO_FILE = path.join(ROOT, 'demo', 'demo-task.txt');

// Fallback matching farm.config.json so the CLI survives a missing config.
const DEFAULT_CONFIG = {
  port: 8787,
  maxAttempts: 3,
  model: 'claude-haiku-4-5-20251001',
  outputDir: 'output',
  claudeModels: [
    { id: 'claude-opus-4-8', label: 'Клауд 4.8' },
    { id: 'claude-sonnet-4-6', label: 'Соннет 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Хайку 4.5' },
  ],
  codexModels: [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ],
  zones: [
    {
      id: 'kitchen',
      title: 'Поле — Сбор',
      driver: { id: 'scraper', name: 'The Scraper' },
      tester: { id: 'cleaner', name: 'The Cleaner' },
    },
    {
      id: 'corridor',
      title: 'Амбар — Обработка',
      driver: { id: 'editor', name: 'The Editor' },
      tester: { id: 'validator', name: 'The Validator' },
    },
    {
      id: 'living',
      title: 'Теплица — QA',
      driver: { id: 'runner', name: 'The Runner' },
      tester: { id: 'sniffer', name: 'The Sniffer' },
    },
    {
      id: 'bath',
      title: 'Рынок — Релиз',
      driver: { id: 'archiver', name: 'The Archiver' },
      tester: { id: 'signoff', name: 'The Sign-Off' },
    },
  ],
};

async function loadConfig() {
  let config = { ...DEFAULT_CONFIG };
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(await readFile(CONFIG_FILE, 'utf8')) };
  } catch {
    console.error('Внимание: farm.config.json не прочитан, использую настройки по умолчанию');
  }
  // Make outputDir cwd-independent for the agents.
  config.outputDir = path.resolve(ROOT, config.outputDir ?? 'output');
  return config;
}

// One pretty Russian line per event: zone title + character name + message.
function makeNarrator(config) {
  const zoneById = new Map(config.zones.map((zone) => [zone.id, zone]));
  return (event) => {
    const zone = event.zone ? zoneById.get(event.zone) : undefined;
    const place = zone ? zone.title : 'Ферма';
    let name = '';
    if (zone && event.role === 'driver') name = zone.driver.name;
    if (zone && event.role === 'tester') name = zone.tester.name;
    // Orchestrator messages often start with the character name already —
    // only prefix it when it is missing (e.g. «Паша исправил дату»).
    const body = name && !event.message.startsWith(name)
      ? `${name}: ${event.message}`
      : event.message;
    console.log(`[${place}] ${body}`);
  };
}

async function runThroughFarm({ config, title, input, runners, stepDelayMs, resultFile = 'result.csv' }) {
  const bus = createEventBus();
  bus.subscribe(makeNarrator(config));
  const farm = createFarm({ ...config, stepDelayMs }, runners, bus);
  const result = await farm.runTask({ title, input });
  if (result.ok) {
    console.log(`Результат: ${path.join(config.outputDir, result.task.id, resultFile)}`);
    console.log('Задача закрыта');
  } else {
    console.error('Задача провалена: попытки закончились');
    process.exitCode = 1;
  }
  return result;
}

async function cmdDemo() {
  const config = await loadConfig();
  let input;
  try {
    input = await readFile(DEMO_FILE, 'utf8');
  } catch {
    console.error('Не найден файл demo/demo-task.txt — демо запустить нечем');
    process.exitCode = 1;
    return;
  }
  await runThroughFarm({
    config,
    title: 'Демо: список клиентов',
    input,
    runners: createSimRunners(),
    stepDelayMs: 150,
  });
}

// Optional: load a long-lived token into ANTHROPIC_API_KEY so the real
// executor can call `claude -p`. Put the token (from `claude setup-token`,
// starts with sk-ant-) in ~/.claude-farm-token — it never touches the repo
// or the chat. An ANTHROPIC_API_KEY already in the environment wins.
async function loadFarmToken() {
  if (process.env.ANTHROPIC_API_KEY) return 'env';
  const tokenPath = path.join(process.env.HOME || '', '.claude-farm-token');
  try {
    const token = (await readFile(tokenPath, 'utf8')).trim();
    if (token) {
      process.env.ANTHROPIC_API_KEY = token;
      return tokenPath;
    }
  } catch {
    // no token file — farm runs in sim mode, which is fine
  }
  return null;
}

async function cmdServe(args) {
  const config = await loadConfig();
  const tokenSource = await loadFarmToken();
  if (tokenSource) console.log(`Токен исполнителя загружен (${tokenSource}).`);
  const portIndex = args.indexOf('--port');
  if (portIndex !== -1) {
    const parsed = Number.parseInt(args[portIndex + 1], 10);
    if (Number.isNaN(parsed)) {
      console.error('Некорректный порт. Пример: node src/farm.mjs serve --port 8788');
      process.exitCode = 1;
      return;
    }
    config.port = parsed;
  }

  try {
    const { port } = await startServer({ config });
    const url = `http://localhost:${port}`;
    console.log(`Клауд Ферма открыта: ${url}`);
    console.log('Остановить сервер: Ctrl+C');
    // macOS: open the dashboard in Safari automatically (skip with --no-open).
    if (process.platform === 'darwin' && !args.includes('--no-open')) {
      try {
        const opener = spawn('open', ['-a', 'Safari', url], {
          stdio: 'ignore',
          detached: true,
        });
        opener.on('error', () => {}); // best-effort: a missing `open` never kills the server
        opener.unref();
      } catch {
        // ignore — the URL is already printed above
      }
    }
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      console.error(
        `Порт ${config.port ?? 8787} уже занят. ` +
        'Останови другой процесс или выбери свободный порт: node src/farm.mjs serve --port <N>',
      );
    } else {
      console.error(`Не удалось запустить сервер: ${err?.message ?? err}`);
    }
    process.exitCode = 1;
  }
}

async function cmdRun(args) {
  let title;
  let inputFile;
  let real = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--input') {
      inputFile = args[i + 1];
      i += 1;
    } else if (arg === '--real') {
      real = true;
    } else if (title === undefined) {
      title = arg;
    }
  }

  if (!title) {
    console.error('Укажи название задачи: node src/farm.mjs run "Название" --input <файл>');
    process.exitCode = 1;
    return;
  }
  if (!inputFile) {
    console.error('Укажи входной файл: --input <файл>');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  let input;
  try {
    input = await readFile(path.resolve(process.cwd(), inputFile), 'utf8');
  } catch {
    console.error(`Не удалось прочитать входной файл: ${inputFile}`);
    process.exitCode = 1;
    return;
  }

  const runners = real ? createClaudeRunners(config) : createSimRunners();
  if (real) {
    console.log('Режим --real: задачу выполняют настоящие агенты Claude');
  }
  await runThroughFarm({
    config,
    title,
    input,
    runners,
    stepDelayMs: 0,
    resultFile: real ? 'result.md' : 'result.csv',
  });
}

function printUsage() {
  console.log('Клауд Ферма — конвейер задач с пиксельной фермой');
  console.log('');
  console.log('Команды:');
  console.log('  node src/farm.mjs demo                          — прогнать демо-задачу');
  console.log('  node src/farm.mjs serve [--port N] [--no-open]  — запустить дашборд (на macOS откроет Safari)');
  console.log('  node src/farm.mjs run "Название" --input <файл> [--real] — выполнить задачу');
}

const [, , command, ...rest] = process.argv;

try {
  switch (command) {
    case 'demo':
      await cmdDemo();
      break;
    case 'serve':
      await cmdServe(rest);
      break;
    case 'run':
      await cmdRun(rest);
      break;
    default:
      if (command) {
        console.error(`Неизвестная команда: ${command}`);
        process.exitCode = 1;
      }
      printUsage();
  }
} catch (err) {
  console.error(`Ферма споткнулась: ${err?.message ?? err}`);
  process.exitCode = 1;
}
