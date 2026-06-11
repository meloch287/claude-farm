// Agents for "Клауд Ферма": sim runners (deterministic, used by tests and
// the demo) and experimental claude runners that spawn the `claude` CLI.
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

/** Parse a CSV string (header "Имя;Дата") into data rows, like a user would. */
function parseCsvRows(csv) {
  const lines = String(csv ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(1).map((line) => {
    const [name = '', date = ''] = line.split(';').map((part) => part.trim());
    return { name, date };
  });
}

// ---------------------------------------------------------------------------
// SIM runners — deterministic pipeline used by tests and the demo.
// ---------------------------------------------------------------------------

export function createSimRunners() {
  const drivers = {
    // Кухня — The Scraper: raw input -> trimmed non-empty lines.
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

    // Коридор — The Editor: lines "Имя;DD.MM.YYYY" -> rows + CSV.
    async corridor(ctx) {
      const rows = (ctx.data.lines ?? []).map((line) => {
        const [name = '', date = ''] = line.split(';').map((part) => part.trim());
        return { name, date };
      });
      ctx.data.rows = rows;
      ctx.data.csv =
        ['Имя;Дата', ...rows.map((row) => `${row.name};${row.date}`)].join('\n') + '\n';
      return { message: `Свёрстан CSV: ${rows.length} строк` };
    },

    // Гостиная — The Runner: re-opens the CSV like a user would.
    async living(ctx) {
      const rows = parseCsvRows(ctx.data.csv);
      ctx.data.qa = { rowsOpened: rows.length };
      return { message: `Открыто строк: ${rows.length}` };
    },

    // Ванная — The Archiver: writes result.csv + manifest.json, zips the folder.
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
    // Кухня — The Cleaner: there must be at least one line.
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

    // Коридор — The Validator: every date must be a real calendar date.
    async corridor(ctx) {
      for (const row of ctx.data.rows ?? []) {
        const match = DATE_RE.exec(row.date);
        let valid = false;
        let fixed = null;

        if (match) {
          const day = Number(match[1]);
          const month = Number(match[2]);
          const year = Number(match[3]);
          if (month >= 1 && month <= 12) {
            const maxDay = daysInMonth(month, year);
            if (day >= 1 && day <= maxDay) {
              valid = true;
            } else if (day > maxDay) {
              // Clamp the day to the last valid day of that month.
              fixed = `${String(maxDay).padStart(2, '0')}.${match[2]}.${match[3]}`;
            }
          }
        }

        if (!valid) {
          if (!ctx.data.fixRequest && fixed) {
            ctx.data.fixRequest = { bad: row.date, fixed };
          }
          return {
            ok: false,
            reason: `Дата ${row.date} не существует`,
            bounceTo: 'kitchen',
          };
        }
      }
      return { ok: true, note: 'Все даты настоящие' };
    },

    // Гостиная — The Sniffer: no empty fields, no duplicate rows.
    async living(ctx) {
      const rows = parseCsvRows(ctx.data.csv);
      const seen = new Set();
      for (const row of rows) {
        if (!row.name || !row.date) {
          return {
            ok: false,
            reason: `Пустое поле в строке «${row.name};${row.date}»`,
            bounceTo: 'corridor',
          };
        }
        const key = `${row.name};${row.date}`;
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

    // Ванная — The Sign-Off: both release files exist and are non-empty.
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
// CLAUDE runners — experimental real mode: spawns the `claude` CLI.
// Never used by tests.
// ---------------------------------------------------------------------------

const ZONE_DRIVER_TASKS = {
  kitchen: 'разбери входной текст задачи на чистые строки и опиши результат',
  corridor: 'преобразуй строки вида «Имя;ДД.ММ.ГГГГ» в CSV с заголовком «Имя;Дата»',
  living: 'просмотри CSV глазами пользователя и опиши, что открылось',
  bath: 'подготовь итоговый пакет к релизу и опиши его содержимое',
};

const ZONE_TESTER_TASKS = {
  kitchen: 'проверь, что строки собраны и их больше нуля',
  corridor: 'проверь, что все даты — настоящие календарные даты в формате ДД.ММ.ГГГГ',
  living: 'проверь, что нет пустых полей и дубликатов строк',
  bath: 'проверь, что итоговые файлы готовы и не пустые',
};

function summarizeData(ctx, limit = 3000) {
  let json;
  try {
    json = JSON.stringify(ctx.data) ?? '{}';
  } catch {
    json = '{}';
  }
  if (json.length > limit) {
    json = json.slice(0, limit) + '…';
  }
  return json;
}

function runClaudeCli(prompt, config) {
  const timeoutMs = config?.claudeTimeoutMs ?? 180_000;
  const args = ['-p', prompt];
  if (config?.model) {
    args.push('--model', config.model);
  }
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
      child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

export function createClaudeRunners(config) {
  const zones = config?.zones ?? [];

  const zoneById = (zoneId) => zones.find((zone) => zone.id === zoneId);

  // Bounce target: previous zone in the pipeline, or itself for the first one.
  const bounceTarget = (zoneId) => {
    const index = zones.findIndex((zone) => zone.id === zoneId);
    return index > 0 ? zones[index - 1].id : zoneId;
  };

  return {
    async runDriver(zoneId, ctx) {
      const zone = zoneById(zoneId);
      const prompt = [
        `Ты — агент «${zone?.driver?.name ?? zoneId}» на конвейере «Клауд Ферма», зона «${zone?.title ?? zoneId}».`,
        `Твоя работа: ${ZONE_DRIVER_TASKS[zoneId] ?? 'обработай данные задачи'}.`,
        `Задача: «${ctx.task.title}».`,
        zoneId === 'kitchen' ? `Входной текст:\n${ctx.task.input}` : null,
        `Текущие данные (JSON): ${summarizeData(ctx)}`,
        'Ответь кратким отчётом на русском языке, обычным текстом.',
      ]
        .filter(Boolean)
        .join('\n\n');

      const result = await runClaudeCli(prompt, config);
      if (!result.ok) {
        ctx.data.claude = { ...ctx.data.claude, [zoneId]: { error: result.error } };
        return { message: `Клауд недоступен: ${result.error}` };
      }

      ctx.data.claude = { ...ctx.data.claude, [zoneId]: { report: result.text } };
      const firstLine = result.text.split('\n')[0].slice(0, 120);
      return { message: firstLine };
    },

    async runTester(zoneId, ctx) {
      const zone = zoneById(zoneId);
      const prompt = [
        `Ты — тестировщик «${zone?.tester?.name ?? zoneId}» на конвейере «Клауд Ферма», зона «${zone?.title ?? zoneId}».`,
        `Твоя проверка: ${ZONE_TESTER_TASKS[zoneId] ?? 'проверь результат работы драйвера'}.`,
        `Задача: «${ctx.task.title}».`,
        `Текущие данные (JSON): ${summarizeData(ctx)}`,
        'Первым словом ответа напиши ОК (если всё хорошо) или БАГ (если есть проблема), затем краткое пояснение на русском.',
      ].join('\n\n');

      const result = await runClaudeCli(prompt, config);
      if (!result.ok) {
        return {
          ok: false,
          reason: `Клауд недоступен: ${result.error}`,
          bounceTo: bounceTarget(zoneId),
        };
      }

      const text = result.text.trim();
      const firstWord = (text.match(/[A-Za-zА-Яа-яЁё]+/) ?? [''])[0].toUpperCase();
      const rest = text.replace(/^[^A-Za-zА-Яа-яЁё]*[A-Za-zА-Яа-яЁё]+[\s:,.—-]*/, '').trim();

      if (firstWord === 'ОК' || firstWord === 'OK') {
        return { ok: true, note: rest || undefined };
      }
      if (firstWord === 'БАГ') {
        return {
          ok: false,
          reason: rest || 'Тестер нашёл проблему',
          bounceTo: bounceTarget(zoneId),
        };
      }
      return {
        ok: false,
        reason: `Непонятный вердикт тестера: «${text.slice(0, 80)}»`,
        bounceTo: bounceTarget(zoneId),
      };
    },
  };
}
