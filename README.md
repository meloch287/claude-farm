# Клауд Ферма (Claude Farm)

**English** · [Русский](README.ru.md)

A cozy pixel‑art **task farm** that runs real work through Claude. A task travels across four farm plots — like a harvest from the field to the market stall — and at every plot a pair of agents handles it: a **Driver** does the work and a **Tester** checks the result. You watch it live on a Stardew‑Valley‑inspired dashboard: a farm map where villagers dig, haul, water and sell, and a kanban board of chats.

Zero npm dependencies — only built‑in Node.js modules.

![Farm map: a pixel‑art farm with a house, field, barn, greenhouse and market stall; farmer villagers stand along a dirt path; a green status bar at the bottom shows a live notification](docs/img/farm.png)

---

## Contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Real execution (Claude)](#real-execution-claude)
- [Ultracode subagents](#ultracode-subagents)
- [Boards (chats)](#boards-chats)
- [Settings](#settings)
- [HTTP API](#http-api)
- [Main Agent mode](#main-agent-mode)
- [Project layout](#project-layout)
- [Accessibility](#accessibility)
- [Tests & CI](#tests--ci)

---

## What it is

Клауд Ферма is a task pipeline with a playful skin. Each plot owns one stage of a task's life:

| # | Zone id | Plot | Driver | Tester | What happens |
|---|---------|------|--------|--------|--------------|
| 1 | `kitchen`  | Поле — Сбор (Field — Intake) | The Scraper | The Cleaner | Gather materials and a plan for the task |
| 2 | `corridor` | Амбар — Обработка (Barn — Processing) | The Editor | The Validator | **Actually perform the task**, validate on the merits |
| 3 | `living`   | Теплица — QA (Greenhouse — QA) | The Runner | The Sniffer | Read the result as a user would; in ultracode, parallel subagents review it |
| 4 | `bath`     | Рынок — Релиз (Market — Release) | The Archiver | The Sign‑Off | Write `result.md` + `manifest.json`, final acceptance |

The agents never walk around the farm themselves. **Only the Main Agent — the orchestrator (`src/orchestrator.mjs`) — carries a task between plots.** It knows the route, counts attempts, emits events, and decides where a task goes after a tester's verdict. A Tester returns `ОК` (move on) or `БАГ` (bounce back). After too many bounces (`maxAttempts`, default 3) the task fails.

The engine is **Claude only** — real `claude -p` when a token is available, otherwise an honest simulation fallback.

## Quick start

```bash
npm run serve          # start the dashboard, opens Safari on macOS
# then open http://localhost:8787

npm test               # run the test suite (zero deps, Node's built‑in runner)

node src/farm.mjs run "Guest list" --input path/to/file.txt   # run one task from a file
```

Create tasks from the **Board** tab: type a title and data, press **Создать задачу** (Create task) or **Создать задачу ИИ** (Create AI task — Claude decomposes it into many subtasks). Switch to the **Ферма** (Farm) tab to watch the villagers do the work; the finished deliverable lands in `output/<taskId>/result.md`.

## Screenshots

| Kanban board | Mobile (responsive) |
|---|---|
| ![Kanban board titled “Доска задач — Чат 1” with a board switcher, a task‑creation form, and six columns (Queue, Intake, Processing, QA, Release, Done) holding task cards with model and mode badges](docs/img/board.png) | ![The same dashboard on a narrow phone screen: the header and controls stack into full‑width buttons and the board bar wraps, with no horizontal scrolling](docs/img/mobile.png) |

## How it works

Every step emits an event on an internal bus. Events are streamed to the dashboard over **Server‑Sent Events** (`GET /events`) and narrated in the console. The dashboard turns them into motion: the boss villager carries a paper between plots, the active worker plays a chore animation (digging in the field, hauling sacks in the barn, watering in the greenhouse, selling at the market), and the kanban cards move between columns. A coalesced status line at the bottom of the screen announces what just happened.

### The bounce‑back, by example: `35.12.2023`

The CLI demo (`npm run demo`, deterministic sim) feeds 20 lines of `Name;DD.MM.YYYY`, with line 13 broken on purpose: `Игорь;35.12.2023`.

1. **Field.** The Scraper splits the file into lines; The Cleaner confirms there is work to do.
2. **Barn.** The Editor builds a CSV. The Validator checks every date as a real calendar date and trips on `35.12.2023`. It files a fix (clamp the day to the last valid day: `35` → `31`) and votes `БАГ`, bounce to `kitchen`.
3. **Bounce.** The Main Agent bumps the attempt counter and carries the task back to the field; the Scraper re‑builds the data with the fix applied.
4. **Second pass.** Barn validates, Greenhouse finds no duplicates or empty fields, Market writes the files: “Клиенту можно отправлять!” (Ready to ship).

## Real execution (Claude)

For non‑demo tasks the farm runs the real `claude` CLI (`claude -p ... --model <model>`). The Editor in the Barn **really performs the task** and writes a markdown deliverable; the testers judge it on the merits.

Headless `claude -p` needs its own credentials (an OAuth token or an API key — your interactive login does **not** carry over). Enable it once:

```bash
claude setup-token          # in a real terminal; prints an sk-ant-oat… token
echo 'PASTE_TOKEN_HERE' > ~/.claude-farm-token
chmod 600 ~/.claude-farm-token
```

On start the server loads that file: a `sk-ant-oat…` token goes to `CLAUDE_CODE_OAUTH_TOKEN`, a plain API key to `ANTHROPIC_API_KEY`. It then probes `claude -p` once and reports readiness in `GET /api/state` as `claudeExecutor: true`. The token file lives in your home directory and is never committed. Without it, tasks still complete — via a clearly‑noted simulation fallback.

## Ultracode subagents

In **Ultracode** mode, before the Sniffer's verdict in the Greenhouse, the farm spawns up to 8 **parallel subagents** on the latest Sonnet (`claude-sonnet-4-6`) by default. Each gets one review type, cycled across the count:

| Type | Instruction |
|------|-------------|
| `review` | review the result |
| `bugs` | find errors and inconsistencies |
| `optimize` | suggest improvements |
| `factcheck` | verify the facts |

Their findings are merged into a digest the Sniffer reads — real problems become a `БАГ` and send the task back to the Barn. On the map, extra farmhands appear in the greenhouse while they work.

## Boards (chats)

The kanban is split into independent **boards**, each a separate chat/workspace with its own task list:

- **Доска:** a `<select>` switches the active board.
- **+ Новая доска** creates a new chat; **Переименовать** / **Удалить** rename and delete (there is always at least one board).
- A task is created into the currently selected board and is isolated from the others. The shared farm map always shows whichever task is currently running (the queue is a single global FIFO).

## Settings

Global settings live in `output/settings.json` and are reachable via the gear dialog or the API. The shape is flat (Claude‑only):

```json
{
  "model": "claude-opus-4-8",
  "mode": "ultracode",
  "subagents": { "model": "claude-sonnet-4-6", "count": 3, "types": ["review", "bugs"] }
}
```

```bash
curl -s localhost:8787/api/settings
curl -s -X PUT localhost:8787/api/settings -d '{"model":"claude-sonnet-4-6","mode":"normal"}'
```

`PUT` takes a partial patch and strictly validates enums. The model catalog lives in `farm.config.json` (`claudeModels`).

### Per‑task config

`POST /api/task` accepts an optional `config` that is merged over the global settings and stored on the task (shown as model/mode badges on the kanban card):

```bash
curl -s -X POST localhost:8787/api/task \
  -d '{"title":"Report","input":"...","boardId":"b1","config":{"model":"claude-haiku-4-5-20251001","mode":"normal","subagents":{"count":0,"types":[]}}}'
```

## HTTP API

| Method & path | Purpose |
|---|---|
| `GET /events` | SSE stream of pipeline events |
| `GET /api/state` | zones, `claudeExecutor`, last 100 events |
| `GET /api/tasks?board=<id>` | tasks for a board (default: active board) |
| `POST /api/task` | create a task `{title, input, mode, boardId, config}` → `202 {taskId}` |
| `GET /api/boards` | `{boards, activeBoardId}` |
| `POST /api/boards` | create a board `{name?}` |
| `PATCH /api/boards/:id` | rename `{name}` |
| `DELETE /api/boards/:id` | delete a board and its tasks |
| `GET / PUT /api/settings` | read / patch global settings |
| `POST /api/event` | inject an external event (Main Agent mode) |

## Main Agent mode

The farm can be driven by an external orchestrator — for example Claude Code acting as the Main Agent — doing the real work with its own subagents and broadcasting each step to the dashboard via `POST /api/event`:

```bash
curl -s -X POST localhost:8787/api/event \
  -d '{"type":"zone.enter","taskId":"boss-1","zone":"kitchen","message":"Задача переходит в зону «Поле — Сбор»"}'
```

Allowed `type` values: `task.created`, `task.queued`, `zone.enter`, `driver.start`, `driver.done`, `tester.start`, `tester.ok`, `tester.bounce`, `task.done`, `task.failed`. External events render exactly like the built‑in farm's.

## Project layout

```
claude-farm/
├── farm.config.json      # port, maxAttempts, executor, model catalog, zones
├── package.json          # scripts: demo, serve, start, test
├── src/
│   ├── farm.mjs          # CLI: demo | serve [--port N] [--no-open] | run "<title>" --input <file>
│   ├── orchestrator.mjs  # Main Agent: route across plots, bounces, attempt limit
│   ├── events.mjs        # event bus: seq+ts, history, JSONL log, subscriptions
│   ├── agents.mjs        # sim runners, claude runners, ultracode subagents
│   ├── tasks.mjs         # task store, FIFO queue, boards, settings
│   └── server.mjs        # http: static, SSE, /api/state|tasks|task|boards|settings|event
├── dashboard/
│   ├── index.html        # farm map + kanban board (two views)
│   ├── style.css         # pixel art, 90% density, responsive, plot states
│   ├── app.js            # EventSource, board rendering, choreography, forms
│   └── assets/           # original pixel sprites + the farm scene (SVG)
├── demo/demo-task.txt    # demo data: 20 lines, one broken date
├── test/                 # node --test (no real CLI is ever spawned)
└── output/               # task results, farm-state.json, settings.json
```

## Accessibility

The dashboard targets WCAG AA. Plot states are conveyed by text and a glyph (never color alone); status announcements coalesce through a single `role="status"` region (the visible bottom bar); progress is marked with `aria-current="step"`; the farm map is decorative (`aria-hidden`); all animations honor `prefers‑reduced‑motion` and the **Анимация** pause toggle; sound is off by default behind an `aria-pressed` button; the layout reflows cleanly down to ~320px and at 200% zoom, with ≥44px touch targets.

## Tests & CI

```bash
npm test
```

The suite runs on Node's built‑in test runner with zero dependencies and never spawns a real CLI. GitHub Actions runs it on every push (`.github/workflows/ci.yml`).
