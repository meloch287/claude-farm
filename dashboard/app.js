/*
 * Клауд Ферма — dashboard client (vanilla JS, no deps).
 *
 * Responsibilities:
 *  - EventSource("/events") with reconnect notes and seq-based dedupe
 *  - state machine: event type -> zone data-state + token position + clothespin aria-current
 *  - coalesced role="status" announcer (queue, min 2s between flushes, assertive only on failure)
 *  - view switcher «Ферма»/«Доска»: aria-pressed buttons toggle the hidden
 *    attribute on #farm-view/#board-view, choice persisted (localStorage "farm.view")
 *  - kanban board: renders GET /api/tasks into 6 columns + epic strip,
 *    refetch debounced 500ms on SSE events carrying taskId, status diffs
 *    announced as ONE merged summary through the same coalesced #status
 *  - #task-form: POST /api/task with mode from the clicked submit button
 *    (event.submitter), aria-disabled pending pattern, inline title
 *    validation (#err-title), AI-split polling every 2s up to 120s
 *  - WebAudio square-wave bleeps gated by #btn-sound (aria-pressed, persisted, OFF by default);
 *    every sound is mirrored as text via the #status announcer
 *  - fixed --anim-duration (collapses to 0 under prefers-reduced-motion)
 *  - never steals focus (form focus moves are user-initiated submits),
 *    defensive JSON.parse, honors prefers-reduced-motion
 *  - Actor engine + choreographer: decorative boss/worker sprites act out
 *    pipeline events over the farmhouse map — workers sit at their stations,
 *    stand up, and carry the single shared paper to each other; a serialized
 *    action queue consumes events (doors/seats/desks from assets/layout.json
 *    v2); «Анимация» pause toggle (#btn-anim, localStorage "farm.anim") and
 *    prefers-reduced-motion collapse all choreography to instant final
 *    poses; map elements stay aria-hidden and are never announced
 *  - Engine config: onboarding <dialog> (first visit, localStorage
 *    "farm.engineChosen"), settings <dialog> behind #btn-settings
 *    (GET/PUT /api/settings), per-task <details id="task-config"> prefilled
 *    from the global settings; POST /api/task carries the per-task config
 *  - Kanban cards render model/mode/speed chips from task.config
 *  - Helpers: decorative subagent sprites in the Теплица while the active
 *    task is in QA, gated by reduced-motion and the «Анимация» pause
 */
"use strict";

(function () {
  // ------------------------------------------------------------------ contract

  // Farm-theme zone names (ids NEVER change); accusative carries its own
  // preposition for the «Задача возвращена …» announcement (в Поле / на Рынок).
  const ZONES = [
    { id: "kitchen", title: "Поле — Сбор", accusative: "в Поле" },
    { id: "corridor", title: "Амбар — Обработка", accusative: "в Амбар" },
    { id: "living", title: "Теплица — QA", accusative: "в Теплицу" },
    { id: "bath", title: "Рынок — Релиз", accusative: "на Рынок" },
  ];

  // Distinct glyph per state (glyph is aria-hidden: the Russian text carries meaning).
  const STATE_LABELS = {
    idle: { text: "Ожидание", glyph: "·" },
    working: { text: "Работает", glyph: "▶" },
    testing: { text: "Проверка", glyph: "?" },
    error: { text: "Возврат", glyph: "✗" },
    done: { text: "Готово", glyph: "✓" },
  };

  const SOUND_STORAGE_KEY = "farm-sound";
  const VIEW_STORAGE_KEY = "farm.view";
  const STATUS_INTERVAL_MS = 2000;
  // History replay must not trigger announcements/sounds; only "fresh" events do.
  const LIVE_WINDOW_MS = 5000;

  // ------------------------------------------------------------------ dom refs

  const els = {
    map: document.getElementById("map"),
    token: document.getElementById("token"),
    stages: document.getElementById("stages"),
    status: document.getElementById("status"),
    btnSound: document.getElementById("btn-sound"),
    viewFarmBtn: document.getElementById("view-farm-btn"),
    viewBoardBtn: document.getElementById("view-board-btn"),
    farmView: document.getElementById("farm-view"),
    boardView: document.getElementById("board-view"),
    taskForm: document.getElementById("task-form"),
    taskTitle: document.getElementById("task-title"),
    taskInput: document.getElementById("task-input"),
  };

  const zoneEls = {};
  for (const zone of ZONES) {
    // Scope to the map: clothesline <li> items carry data-zone too.
    zoneEls[zone.id] = document.querySelector('#map section[data-zone="' + zone.id + '"]');
  }

  // ------------------------------------------------------------------ motion

  const reducedMotionQuery = typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false, addEventListener: function () {} };

  function reducedMotion() {
    return Boolean(reducedMotionQuery.matches);
  }

  // Fixed animation duration (the old #speed select is gone): one sensible
  // default; collapses to 0 under prefers-reduced-motion so the choreography
  // gates keep working.
  const ANIM_MS = 600;

  function applyAnimDuration() {
    const effective = reducedMotion() ? 0 : ANIM_MS;
    const root = document.documentElement;
    root.style.setProperty("--anim-duration", effective + "ms");
    if (els.token) {
      els.token.style.transition = effective === 0
        ? "none"
        : "transform " + effective + "ms ease-in-out";
    }
  }

  // ------------------------------------------------------------------ zones

  const zoneStates = {};

  function zoneStateEl(zoneId) {
    const section = zoneEls[zoneId];
    if (!section) return null;
    let holder = section.querySelector(".zone-state");
    if (!holder) {
      holder = document.createElement("p");
      holder.className = "zone-state";
      const glyph = document.createElement("span");
      glyph.className = "zone-state-glyph";
      glyph.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "zone-state-text";
      holder.appendChild(glyph);
      holder.appendChild(document.createTextNode(" "));
      holder.appendChild(text);
      section.appendChild(holder);
    }
    return holder;
  }

  function setZoneState(zoneId, state) {
    const section = zoneEls[zoneId];
    if (!section || !STATE_LABELS[state]) return;
    zoneStates[zoneId] = state;
    section.setAttribute("data-state", state);
    const holder = zoneStateEl(zoneId);
    if (!holder) return;
    const glyph = holder.querySelector(".zone-state-glyph");
    const text = holder.querySelector(".zone-state-text");
    if (glyph) glyph.textContent = STATE_LABELS[state].glyph;
    if (text) text.textContent = STATE_LABELS[state].text;
  }

  function resetZones() {
    for (const zone of ZONES) setZoneState(zone.id, "idle");
    updateStages(-1);
  }

  // ------------------------------------------------------------------ clothesline

  function ensureStages() {
    if (!els.stages) return [];
    let items = Array.prototype.slice.call(els.stages.querySelectorAll("li"));
    if (items.length === 0) {
      for (const zone of ZONES) {
        const li = document.createElement("li");
        li.setAttribute("data-zone", zone.id);
        const marker = document.createElement("span");
        marker.className = "stage-marker";
        marker.setAttribute("aria-hidden", "true");
        marker.textContent = "·";
        li.appendChild(marker);
        li.appendChild(document.createTextNode(" " + zone.title));
        els.stages.appendChild(li);
      }
      items = Array.prototype.slice.call(els.stages.querySelectorAll("li"));
    }
    return items;
  }

  function stageMarker(li) {
    let marker = li.querySelector(".stage-marker");
    if (!marker) {
      marker = document.createElement("span");
      marker.className = "stage-marker";
      marker.setAttribute("aria-hidden", "true");
      li.insertBefore(marker, li.firstChild);
      li.insertBefore(document.createTextNode(" "), marker.nextSibling);
    }
    return marker;
  }

  // currentIndex: -1 = nothing active; ZONES.length = everything finished.
  function updateStages(currentIndex) {
    const items = ensureStages();
    items.forEach(function (li, i) {
      const idx = li.hasAttribute("data-zone")
        ? ZONES.findIndex(function (z) { return z.id === li.getAttribute("data-zone"); })
        : i;
      const marker = stageMarker(li);
      if (idx === currentIndex) {
        li.setAttribute("aria-current", "step");
        li.setAttribute("data-stage", "current");
        marker.textContent = "▶"; // non-color current marker
      } else if (idx >= 0 && idx < currentIndex) {
        li.removeAttribute("aria-current");
        li.setAttribute("data-stage", "done");
        marker.textContent = "✓";
      } else {
        li.removeAttribute("aria-current");
        li.setAttribute("data-stage", "todo");
        marker.textContent = "·";
      }
    });
  }

  // ------------------------------------------------------------------ token

  let currentZoneId = null;

  function moveToken(zoneId, instant) {
    currentZoneId = zoneId;
    const token = els.token;
    const map = els.map;
    const zone = zoneEls[zoneId];
    if (!token || !map || !zone) return;
    const mapRect = map.getBoundingClientRect();
    const zRect = zone.getBoundingClientRect();
    const x = zRect.left - mapRect.left + zRect.width / 2 - token.offsetWidth / 2;
    const y = zRect.top - mapRect.top + zRect.height / 2 - token.offsetHeight / 2;
    if (instant || reducedMotion()) {
      const saved = token.style.transition;
      token.style.transition = "none";
      token.style.transform = "translate(" + Math.round(x) + "px, " + Math.round(y) + "px)";
      // Force reflow so the next move animates again.
      void token.offsetWidth;
      token.style.transition = saved;
      applyAnimDuration();
    } else {
      token.style.transform = "translate(" + Math.round(x) + "px, " + Math.round(y) + "px)";
    }
  }

  let resizeTimer = null;
  window.addEventListener("resize", function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (currentZoneId) moveToken(currentZoneId, true);
    }, 150);
  });

  // ------------------------------------------------------------------ zone titles

  function zoneTitle(zoneId) {
    const zone = ZONES.find(function (z) { return z.id === zoneId; });
    return zone ? zone.title : zoneId;
  }

  // ------------------------------------------------------------------ status announcer

  const statusQueue = [];
  let statusTimer = null;
  let lastStatusFlush = 0;
  let restorePoliteTimer = null;

  function flushStatus() {
    statusTimer = null;
    if (!els.status || statusQueue.length === 0) return;
    const text = statusQueue.join(". ");
    statusQueue.length = 0;
    els.status.textContent = text;
    lastStatusFlush = Date.now();
  }

  function announce(message) {
    if (!els.status || !message) return;
    // Merge bursts, drop immediate duplicates.
    if (statusQueue[statusQueue.length - 1] !== message) statusQueue.push(message);
    if (!statusTimer) {
      const wait = Math.max(0, STATUS_INTERVAL_MS - (Date.now() - lastStatusFlush));
      statusTimer = setTimeout(flushStatus, wait);
    }
  }

  // Assertive is reserved for pipeline failure only.
  function announceFailure(message) {
    if (!els.status || !message) return;
    statusQueue.length = 0;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    els.status.setAttribute("aria-live", "assertive");
    // Write the text a tick after the live-attribute change: NVDA/VoiceOver
    // can miss content written in the same synchronous task.
    setTimeout(function () { if (els.status) els.status.textContent = message; }, 50);
    lastStatusFlush = Date.now();
    if (restorePoliteTimer) clearTimeout(restorePoliteTimer);
    restorePoliteTimer = setTimeout(function () {
      if (els.status) els.status.setAttribute("aria-live", "polite");
    }, 3000);
  }

  // ------------------------------------------------------------------ sound (opt-in chiptune)

  let soundOn = false;
  let audioCtx = null;

  const SOUNDS = {
    take: { notes: [[660, 0.09], [880, 0.13]], label: "Звук: задача взята в работу" },
    error: { notes: [[220, 0.12], [147, 0.22]], label: "Звук: ошибка" },
    victory: {
      notes: [[523, 0.11], [659, 0.11], [784, 0.11], [1047, 0.24]],
      label: "Звук: победная мелодия",
    },
  };

  function ensureAudio() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) {
      try { audioCtx = new Ctor(); } catch (err) { return null; }
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(function () {});
    }
    return audioCtx;
  }

  function bleep(notes) {
    const ctx = ensureAudio();
    if (!ctx) return;
    let t = ctx.currentTime + 0.01;
    for (const pair of notes) {
      const freq = pair[0];
      const dur = pair[1];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      t += dur;
    }
  }

  function playSound(name) {
    if (!soundOn) return;
    const sound = SOUNDS[name];
    if (!sound) return;
    bleep(sound.notes);
    announce(sound.label); // every sound is also mirrored as text via #status
  }

  function readSoundPref() {
    try { return localStorage.getItem(SOUND_STORAGE_KEY) === "1"; } catch (err) { return false; }
  }

  function writeSoundPref(on) {
    try { localStorage.setItem(SOUND_STORAGE_KEY, on ? "1" : "0"); } catch (err) { /* ignore */ }
  }

  function soundIndicator() {
    if (!els.btnSound) return null;
    let span = els.btnSound.querySelector(".sound-indicator");
    if (!span) {
      span = document.createElement("span");
      span.className = "sound-indicator";
      els.btnSound.appendChild(document.createTextNode(" "));
      els.btnSound.appendChild(span);
    }
    return span;
  }

  function setSound(on, persist) {
    soundOn = Boolean(on);
    if (els.btnSound) {
      els.btnSound.setAttribute("aria-pressed", soundOn ? "true" : "false");
      const indicator = soundIndicator();
      if (indicator) indicator.textContent = soundOn ? "вкл" : "выкл";
    }
    if (persist) writeSoundPref(soundOn);
  }

  if (els.btnSound) {
    els.btnSound.addEventListener("click", function () {
      setSound(!soundOn, true);
      if (soundOn) {
        ensureAudio();
        announce("Звук включён");
      } else {
        announce("Звук выключен");
      }
    });
  }

  // ------------------------------------------------------------------ view switcher («Ферма» / «Доска»)
  // Two aria-pressed buttons toggle the hidden attribute on the sections.
  // Focus STAYS on the pressed button; nothing is announced — #status lives
  // OUTSIDE both sections so it survives the hidden toggling.

  function readViewPref() {
    try {
      return localStorage.getItem(VIEW_STORAGE_KEY) === "board" ? "board" : "farm";
    } catch (err) {
      return "farm";
    }
  }

  function writeViewPref(view) {
    try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch (err) { /* ignore */ }
  }

  function setView(view, persist) {
    const board = view === "board";
    if (els.farmView) els.farmView.hidden = board;
    if (els.boardView) els.boardView.hidden = !board;
    if (els.viewFarmBtn) els.viewFarmBtn.setAttribute("aria-pressed", board ? "false" : "true");
    if (els.viewBoardBtn) els.viewBoardBtn.setAttribute("aria-pressed", board ? "true" : "false");
    if (persist) writeViewPref(board ? "board" : "farm");
    if (!board) {
      // Geometry measured while the farm was hidden is all zeros: repaint
      // the token and the actor layer at final poses once visible again.
      requestAnimationFrame(function () {
        if (currentZoneId) moveToken(currentZoneId, true);
        repaintAll();
      });
    }
  }

  function initViewSwitcher() {
    if (!els.farmView || !els.boardView) return; // old markup: nothing to switch
    setView(readViewPref(), false);
    if (els.viewFarmBtn) {
      els.viewFarmBtn.addEventListener("click", function () { setView("farm", true); });
    }
    if (els.viewBoardBtn) {
      els.viewBoardBtn.addEventListener("click", function () { setView("board", true); });
    }
  }

  // ------------------------------------------------------------------ kanban board (GET /api/tasks)
  // Renders the task store into 6 columns + an epic strip ABOVE them for
  // splitting/split parents. NO aria-live on the board itself: movements are
  // announced ONLY through the coalesced #status as ONE merged summary
  // («Парсер → QA; Сборка +2», cap 2 items then «и ещё N изменений»).

  const BOARD_COLUMNS = [
    { key: "queue", title: "Очередь" },
    { key: "kitchen", title: "Сбор" },
    { key: "corridor", title: "Обработка" },
    { key: "living", title: "QA" },
    { key: "bath", title: "Релиз" },
    { key: "done", title: "Готово" },
  ];
  const BOARD_REFETCH_MS = 500;
  const CARD_MSG_MAX = 80;

  let boardColumnsCache = null; // key -> { heading, count, list }
  let boardEpicStrip = null;
  let boardPrevColumns = null;  // task id -> column key; null until the first paint
  let boardRefetchTimer = null;
  let boardFetchInFlight = false;
  let boardFetchAgain = false;

  function columnForTask(task) {
    switch (task.status) {
      case "queued": return "queue";
      case "kitchen":
      case "corridor":
      case "living":
      case "bath": return task.status;
      case "done":
      case "failed": return "done"; // failed cards live in «Готово» with a «Сбой» badge
      default: return null; // splitting/split parents render in the epic strip
    }
  }

  function truncateText(text, max) {
    const s = typeof text === "string" ? text : "";
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  // Find-or-create the board DOM per the contract: section.board-col with
  // <h3 id="col-<key>">Название <span class="col-count">(N)</span></h3> +
  // <ul aria-labelledby="col-<key>">. Markup shipped in index.html is reused
  // as-is; anything missing is built defensively.
  function ensureBoardDom() {
    if (!els.boardView) els.boardView = document.getElementById("board-view");
    const view = els.boardView;
    if (!view) return null;
    if (boardColumnsCache && boardEpicStrip && boardEpicStrip.parentNode) {
      return boardColumnsCache;
    }

    let board = view.querySelector(".board");
    if (!board) {
      board = document.createElement("div");
      board.className = "board";
      view.appendChild(board);
    }

    let strip = view.querySelector(".epic-strip");
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "epic-strip";
      strip.hidden = true;
      board.parentNode.insertBefore(strip, board); // epics sit ABOVE the columns
    }
    boardEpicStrip = strip;

    const cols = {};
    for (const col of BOARD_COLUMNS) {
      const headingId = "col-" + col.key;
      let heading = document.getElementById(headingId);
      let list = view.querySelector('ul[aria-labelledby="' + headingId + '"]');
      if (!heading || !list) {
        const section = document.createElement("section");
        section.className = "board-col";
        heading = document.createElement("h3");
        heading.id = headingId;
        heading.appendChild(document.createTextNode(col.title + " "));
        list = document.createElement("ul");
        list.setAttribute("aria-labelledby", headingId);
        section.appendChild(heading);
        section.appendChild(list);
        board.appendChild(section);
      }
      let count = heading.querySelector(".col-count");
      if (!count) {
        count = document.createElement("span");
        count.className = "col-count";
        count.textContent = "(0)";
        heading.appendChild(document.createTextNode(" "));
        heading.appendChild(count);
      }
      cols[col.key] = { heading: heading, count: count, list: list };
    }
    boardColumnsCache = cols;
    return cols;
  }

  function buildCard(task) {
    const li = document.createElement("li");
    li.className = "board-card";

    const title = document.createElement("span");
    title.className = "card-title";
    title.textContent = typeof task.title === "string" && task.title
      ? task.title
      : "Задача";
    li.appendChild(title);

    // Config chips right after the title (contract DOM order:
    // title -> badges -> status): model label, then mode/speed, then «ИИ».
    for (const chip of buildConfigChips(task)) {
      li.appendChild(document.createTextNode(" "));
      li.appendChild(chip);
    }

    if (task.source === "subtask" || task.source === "ai-parent") {
      const badge = document.createElement("span");
      badge.className = "badge-ai";
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "ИИ";
      const sr = document.createElement("span");
      sr.className = "sr-only";
      sr.textContent = "источник: ИИ";
      badge.appendChild(glyph);
      badge.appendChild(sr);
      li.appendChild(document.createTextNode(" "));
      li.appendChild(badge);
    }

    if (task.status === "failed") {
      // text + glyph, never color alone (state-error color comes from CSS)
      const fail = document.createElement("span");
      fail.className = "badge-fail";
      const glyph = document.createElement("span");
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = "✗ ";
      fail.appendChild(glyph);
      fail.appendChild(document.createTextNode("Сбой"));
      li.appendChild(document.createTextNode(" "));
      li.appendChild(fail);
    }

    if (typeof task.attempts === "number" && task.attempts > 1) {
      const attempts = document.createElement("span");
      attempts.className = "card-attempts";
      attempts.textContent = "Попытки: " + task.attempts;
      li.appendChild(document.createTextNode(" "));
      li.appendChild(attempts);
    }

    if (typeof task.lastMessage === "string" && task.lastMessage) {
      const msg = document.createElement("p");
      msg.className = "card-msg";
      msg.textContent = truncateText(task.lastMessage, CARD_MSG_MAX);
      li.appendChild(msg);
    }
    return li;
  }

  function buildEpic(task, children) {
    const wrap = document.createElement("div");
    wrap.className = "epic";
    const titleId = "epic-title-" + String(task.id).replace(/[^\w-]/g, "");

    const title = document.createElement("p");
    title.className = "epic-title";
    title.id = titleId;
    title.textContent = typeof task.title === "string" && task.title
      ? task.title
      : "Задача ИИ";
    wrap.appendChild(title);

    const total = children.length;
    const finished = children.filter(function (c) {
      return c.status === "done" || c.status === "failed";
    }).length;

    const progress = document.createElement("progress");
    progress.max = Math.max(total, 1);
    progress.value = finished;
    progress.setAttribute("aria-labelledby", titleId);
    wrap.appendChild(progress);
    wrap.appendChild(document.createTextNode(" "));

    const label = document.createElement("span");
    label.className = "epic-count";
    label.textContent = total > 0
      ? finished + "/" + total + " готово"
      : "ИИ разбивает задачу…";
    wrap.appendChild(label);
    return wrap;
  }

  function renderBoard(tasks) {
    const cols = ensureBoardDom();
    if (!cols || !Array.isArray(tasks)) return;

    // Epic strip (splitting/split parents).
    const epics = tasks.filter(function (t) {
      return t && (t.status === "splitting" || t.status === "split");
    });
    boardEpicStrip.textContent = "";
    boardEpicStrip.hidden = epics.length === 0;
    for (const parent of epics) {
      const children = tasks.filter(function (t) {
        return t && t.parentId === parent.id;
      });
      boardEpicStrip.appendChild(buildEpic(parent, children));
    }

    // Columns + heading counts.
    const byCol = {};
    for (const col of BOARD_COLUMNS) byCol[col.key] = [];
    const nextColumns = {};
    for (const task of tasks) {
      if (!task || task.id == null) continue;
      const key = columnForTask(task);
      if (!key) continue;
      byCol[key].push(task);
      nextColumns[task.id] = key;
    }
    for (const col of BOARD_COLUMNS) {
      const slot = cols[col.key];
      slot.list.textContent = "";
      for (const task of byCol[col.key]) slot.list.appendChild(buildCard(task));
      slot.count.textContent = "(" + byCol[col.key].length + ")";
    }

    announceBoardDiff(boardPrevColumns, nextColumns, tasks);
    boardPrevColumns = nextColumns;
  }

  // ONE merged summary per render through the coalesced #status announcer:
  // single mover => «Название → Колонка», several into one column =>
  // «Колонка +N»; at most 2 items, then «и ещё N изменений».
  function announceBoardDiff(prev, next, tasks) {
    if (!prev) return; // first paint (incl. state restored on boot) is silent
    const titles = {};
    for (const task of tasks) {
      if (task && task.id != null) titles[task.id] = task.title;
    }
    const moved = {}; // column key -> titles of tasks that just entered it
    for (const id in next) {
      if (!Object.prototype.hasOwnProperty.call(next, id)) continue;
      if (prev[id] === next[id]) continue;
      if (!moved[next[id]]) moved[next[id]] = [];
      moved[next[id]].push(typeof titles[id] === "string" && titles[id] ? titles[id] : "Задача");
    }
    const parts = [];
    const counts = [];
    for (const col of BOARD_COLUMNS) {
      const list = moved[col.key];
      if (!list) continue;
      parts.push(list.length === 1
        ? truncateText(list[0], 40) + " → " + col.title
        : col.title + " +" + list.length);
      counts.push(list.length);
    }
    if (parts.length === 0) return;
    let text;
    if (parts.length <= 2) {
      text = parts.join("; ");
    } else {
      const rest = counts.slice(2).reduce(function (a, b) { return a + b; }, 0);
      text = parts.slice(0, 2).join("; ") + "; и ещё " + rest + " изменений";
    }
    announce(text);
  }

  function fetchBoard() {
    if (boardFetchInFlight) {
      boardFetchAgain = true;
      return Promise.resolve(null);
    }
    boardFetchInFlight = true;
    return fetch("/api/tasks")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        const tasks = data && Array.isArray(data.tasks) ? data.tasks : null;
        if (tasks) renderBoard(tasks);
        return tasks;
      })
      .catch(function () { return null; })
      .then(function (tasks) {
        boardFetchInFlight = false;
        if (boardFetchAgain) {
          boardFetchAgain = false;
          scheduleBoardRefetch();
        }
        return tasks;
      });
  }

  function scheduleBoardRefetch() {
    if (boardRefetchTimer) return; // debounce: one refetch per 500ms window
    boardRefetchTimer = setTimeout(function () {
      boardRefetchTimer = null;
      fetchBoard();
    }, BOARD_REFETCH_MS);
  }

  // ------------------------------------------------------------------ task form (#task-form)
  // POST /api/task with the mode taken from the clicked submit button
  // (event.submitter). Pending uses the existing aria-disabled pattern so
  // focus never drops to <body>; focus moves below are user-initiated
  // (they happen in direct response to the submit).

  const SPLIT_POLL_MS = 2000;
  const SPLIT_POLL_MAX_MS = 120000;
  let taskFormPending = false;

  function setFormPending(pending) {
    taskFormPending = Boolean(pending);
    if (!els.taskForm) return;
    const buttons = els.taskForm.querySelectorAll('button[name="mode"], button[type="submit"]');
    for (const btn of buttons) {
      btn.setAttribute("aria-disabled", taskFormPending ? "true" : "false");
    }
  }

  function showTitleError(message) {
    if (!els.taskTitle) return;
    let err = document.getElementById("err-title");
    if (!err) {
      err = document.createElement("p");
      err.id = "err-title";
      err.className = "field-error";
      els.taskTitle.insertAdjacentElement("afterend", err);
    }
    err.textContent = "✗ " + message; // glyph + text, never color alone
    const described = (els.taskTitle.getAttribute("aria-describedby") || "")
      .split(/\s+/).filter(Boolean);
    if (described.indexOf("err-title") === -1) described.push("err-title");
    els.taskTitle.setAttribute("aria-describedby", described.join(" "));
    els.taskTitle.setAttribute("aria-invalid", "true");
    els.taskTitle.focus(); // user-initiated: the submit that just failed
  }

  function clearTitleError() {
    const err = document.getElementById("err-title");
    if (err) err.textContent = "";
    if (!els.taskTitle) return;
    els.taskTitle.removeAttribute("aria-invalid");
    const described = (els.taskTitle.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter(function (id) { return id && id !== "err-title"; });
    if (described.length) els.taskTitle.setAttribute("aria-describedby", described.join(" "));
    else els.taskTitle.removeAttribute("aria-describedby");
  }

  // AI mode answers async: poll /api/tasks every 2s (up to 120s) until the
  // parent leaves "splitting", then announce the subtask count. Each poll
  // also repaints the board, so subtasks appear as soon as they exist.
  function pollSplitResult(taskId) {
    const started = Date.now();
    function tick() {
      fetchBoard().then(function (tasks) {
        const list = Array.isArray(tasks) ? tasks : [];
        const parent = list.find(function (t) { return t && t.id === taskId; });
        if (parent && parent.status !== "splitting") {
          if (parent.status === "failed") {
            announce(typeof parent.lastMessage === "string" && parent.lastMessage
              ? truncateText(parent.lastMessage, 120)
              : "Не удалось разделить задачу");
          } else {
            const n = list.filter(function (t) {
              return t && t.parentId === taskId;
            }).length;
            announce("Задача разделена на " + n + " подзадач");
          }
          return;
        }
        if (Date.now() - started < SPLIT_POLL_MAX_MS) {
          setTimeout(tick, SPLIT_POLL_MS);
        } else {
          announce("ИИ всё ещё разбивает задачу — доска обновится автоматически");
        }
      });
    }
    setTimeout(tick, SPLIT_POLL_MS);
  }

  function initTaskForm() {
    const form = els.taskForm;
    if (!form) return;
    form.noValidate = true; // inline #err-title validation instead of native bubbles

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (taskFormPending) return; // aria-disabled buttons stay focusable

      const submitter = e.submitter || null;
      const mode = submitter && submitter.value === "ai" ? "ai" : "simple";
      const title = els.taskTitle ? els.taskTitle.value.trim() : "";
      const input = els.taskInput ? els.taskInput.value : "";

      if (!title) {
        showTitleError("Укажите название задачи");
        return;
      }
      clearTitleError();

      setFormPending(true);
      announce(mode === "ai"
        ? "ИИ разбивает задачу, это может занять до минуты"
        : "Создаём задачу…");

      const payload = { title: title, input: input, mode: mode };
      const config = taskConfigPayload();
      if (config) payload.config = config;

      fetch("/api/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json().catch(function () { return {}; });
        })
        .then(function (data) {
          setFormPending(false);
          if (els.taskTitle) els.taskTitle.value = "";
          if (els.taskInput) els.taskInput.value = "";
          if (els.taskTitle) els.taskTitle.focus(); // back to the start of the form
          if (mode === "ai") {
            if (data && data.taskId != null) pollSplitResult(data.taskId);
          } else {
            announce("Задача добавлена в очередь");
          }
          scheduleBoardRefetch();
        })
        .catch(function () {
          setFormPending(false);
          announce("Не удалось создать задачу — попробуйте ещё раз");
        });
    });

    if (els.taskTitle) {
      els.taskTitle.addEventListener("input", function () {
        if (els.taskTitle.getAttribute("aria-invalid") === "true" && els.taskTitle.value.trim()) {
          clearTitleError(); // the field is valid again as soon as there is text
        }
      });
    }
  }

  // ------------------------------------------------------------------ engine config
  // Global settings (onboarding + settings dialog, GET/PUT /api/settings)
  // and the per-task config <details id="task-config">. Every init binds
  // defensively: when the markup has not shipped yet it simply no-ops.
  // Settings shape: {engine, claude:{model, mode, subagents:{model, count,
  // types}}, codex:{model, speed}}.

  const ENGINE_CHOSEN_KEY = "farm.engineChosen";
  const SUB_COUNT_MIN = 0;
  const SUB_COUNT_MAX = 8;
  const SUB_TYPES = ["review", "bugs", "optimize", "factcheck"];

  // Hardcoded fallback catalog; refreshed from /api/state when the server
  // exposes claudeModels/codexModels (farm.config.json catalog).
  let claudeModels = [
    { id: "claude-opus-4-8", label: "Клауд 4.8" },
    { id: "claude-sonnet-4-6", label: "Соннет 4.6" },
    { id: "claude-haiku-4-5-20251001", label: "Хайку 4.5" },
  ];
  let codexModels = [
    { id: "gpt-5.5", label: "GPT-5.5" },
  ];

  const MODE_OPTIONS = [
    { id: "ultracode", label: "Ультракод" },
    { id: "normal", label: "Обычный" },
  ];
  const SPEED_OPTIONS = [
    { id: "normal", label: "Обычная" },
    { id: "faster", label: "Фастер" },
  ];
  // Chip labels on kanban cards (full text, never abbreviations).
  const MODE_CHIP_LABELS = { ultracode: "Ультракод", normal: "Обычный" };
  const SPEED_CHIP_LABELS = { normal: "Обычный", faster: "Фастер" };

  function modelLabel(id) {
    if (typeof id !== "string" || !id) return null;
    for (const m of claudeModels) { if (m.id === id) return m.label; }
    for (const m of codexModels) { if (m.id === id) return m.label; }
    return id; // unknown id: show it verbatim rather than hiding the chip
  }

  function defaultSettings() {
    return {
      engine: "claude",
      claude: {
        model: "claude-opus-4-8",
        mode: "ultracode",
        subagents: { model: "claude-sonnet-4-6", count: 3, types: ["review", "bugs"] },
      },
      codex: { model: "gpt-5.5", speed: "normal" },
    };
  }

  let currentSettings = defaultSettings();

  function clampCount(value, fallback) {
    const n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.min(SUB_COUNT_MAX, Math.max(SUB_COUNT_MIN, n));
  }

  // Merge an arbitrary payload over the defaults; junk never sticks.
  function normalizeSettings(raw) {
    const base = defaultSettings();
    if (!raw || typeof raw !== "object") return base;
    if (raw.engine === "codex" || raw.engine === "claude") base.engine = raw.engine;
    const claude = raw.claude && typeof raw.claude === "object" ? raw.claude : {};
    if (typeof claude.model === "string" && claude.model) base.claude.model = claude.model;
    if (claude.mode === "normal" || claude.mode === "ultracode") base.claude.mode = claude.mode;
    const sub = claude.subagents && typeof claude.subagents === "object" ? claude.subagents : {};
    if (typeof sub.model === "string" && sub.model) base.claude.subagents.model = sub.model;
    base.claude.subagents.count = clampCount(sub.count, base.claude.subagents.count);
    if (Array.isArray(sub.types)) {
      base.claude.subagents.types = sub.types.filter(function (t) {
        return SUB_TYPES.indexOf(t) !== -1;
      });
    }
    const codex = raw.codex && typeof raw.codex === "object" ? raw.codex : {};
    if (typeof codex.model === "string" && codex.model) base.codex.model = codex.model;
    if (codex.speed === "faster" || codex.speed === "normal") base.codex.speed = codex.speed;
    return base;
  }

  function putSettings(payload) {
    return fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json().catch(function () { return null; });
    });
  }

  function fetchSettings() {
    return fetch("/api/settings")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        currentSettings = normalizeSettings(data && data.settings ? data.settings : data);
      })
      .catch(function () { /* endpoint missing/offline: defaults stay */ });
  }

  function validCatalogEntry(m) {
    return Boolean(m) && typeof m === "object"
      && typeof m.id === "string" && m.id
      && typeof m.label === "string" && m.label;
  }

  function fetchModelCatalog() {
    return fetch("/api/state")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || typeof data !== "object") return;
        const src = data.catalog && typeof data.catalog === "object" ? data.catalog : data;
        if (Array.isArray(src.claudeModels)) {
          const list = src.claudeModels.filter(validCatalogEntry);
          if (list.length) claudeModels = list;
        }
        if (Array.isArray(src.codexModels)) {
          const list = src.codexModels.filter(validCatalogEntry);
          if (list.length) codexModels = list;
        }
      })
      .catch(function () { /* hardcoded catalog stays */ });
  }

  // ---- shared controls plumbing (settings dialog "set-", task config "cfg-") ----

  function ensureOptions(select, options) {
    if (!select || select.options.length > 0) return; // markup owns its options
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.id;
      o.textContent = opt.label;
      select.appendChild(o);
    }
  }

  function engineControls(root, prefix) {
    if (!root) return null;
    function byId(suffix) {
      const el = document.getElementById(prefix + suffix);
      return el && root.contains(el) ? el : null;
    }
    const controls = {
      root: root,
      radios: [],
      model: byId("model"),
      mode: byId("mode"),
      subModel: byId("sub-model"),
      subCount: byId("sub-count"),
      codexModel: byId("codex-model"),
      codexSpeed: byId("codex-speed"),
      typeBoxes: Array.prototype.slice.call(
        root.querySelectorAll('input[type="checkbox"][name="' + prefix + 'sub-type"]')
      ),
    };
    const radios = root.querySelectorAll('input[type="radio"]');
    for (const radio of radios) {
      if (radio.value === "claude" || radio.value === "codex") controls.radios.push(radio);
    }
    controls.claudeFieldset = controls.model ? controls.model.closest("fieldset") : null;
    controls.codexFieldset = controls.codexModel ? controls.codexModel.closest("fieldset") : null;
    return controls;
  }

  function selectedEngine(controls) {
    if (controls) {
      for (const radio of controls.radios) {
        if (radio.checked) return radio.value;
      }
    }
    return currentSettings.engine;
  }

  // The INACTIVE engine fieldset gets the hidden attribute (not disabled),
  // so it leaves the a11y tree entirely; focus never moves on radio change.
  function applyEngineFieldsets(controls) {
    if (!controls) return;
    const engine = selectedEngine(controls);
    if (controls.claudeFieldset) controls.claudeFieldset.hidden = engine !== "claude";
    if (controls.codexFieldset) controls.codexFieldset.hidden = engine !== "codex";
  }

  function bindEngineRadios(controls) {
    if (!controls) return;
    for (const radio of controls.radios) {
      radio.addEventListener("change", function () { applyEngineFieldsets(controls); });
    }
  }

  function fillEngineControls(controls, settings) {
    if (!controls) return;
    for (const radio of controls.radios) {
      radio.checked = radio.value === settings.engine;
    }
    ensureOptions(controls.model, claudeModels);
    ensureOptions(controls.subModel, claudeModels);
    ensureOptions(controls.mode, MODE_OPTIONS);
    ensureOptions(controls.codexModel, codexModels);
    ensureOptions(controls.codexSpeed, SPEED_OPTIONS);
    if (controls.model) controls.model.value = settings.claude.model;
    if (controls.mode) controls.mode.value = settings.claude.mode;
    if (controls.subModel) controls.subModel.value = settings.claude.subagents.model;
    if (controls.subCount) controls.subCount.value = String(settings.claude.subagents.count);
    for (const box of controls.typeBoxes) {
      box.checked = settings.claude.subagents.types.indexOf(box.value) !== -1;
    }
    if (controls.codexModel) controls.codexModel.value = settings.codex.model;
    if (controls.codexSpeed) controls.codexSpeed.value = settings.codex.speed;
    applyEngineFieldsets(controls);
  }

  function readEngineControls(controls) {
    const out = normalizeSettings(currentSettings); // deep copy of the current state
    if (!controls) return out;
    out.engine = selectedEngine(controls) === "codex" ? "codex" : "claude";
    if (controls.model && controls.model.value) out.claude.model = controls.model.value;
    if (controls.mode && (controls.mode.value === "normal" || controls.mode.value === "ultracode")) {
      out.claude.mode = controls.mode.value;
    }
    if (controls.subModel && controls.subModel.value) {
      out.claude.subagents.model = controls.subModel.value;
    }
    if (controls.subCount) {
      out.claude.subagents.count = clampCount(controls.subCount.value, out.claude.subagents.count);
    }
    if (controls.typeBoxes.length) {
      out.claude.subagents.types = controls.typeBoxes
        .filter(function (box) { return box.checked; })
        .map(function (box) { return box.value; })
        .filter(function (v) { return SUB_TYPES.indexOf(v) !== -1; });
    }
    if (controls.codexModel && controls.codexModel.value) out.codex.model = controls.codexModel.value;
    if (controls.codexSpeed
        && (controls.codexSpeed.value === "normal" || controls.codexSpeed.value === "faster")) {
      out.codex.speed = controls.codexSpeed.value;
    }
    return out;
  }

  // ---- onboarding dialog (first visit only) ----

  function engineChosen() {
    try { return localStorage.getItem(ENGINE_CHOSEN_KEY) === "1"; } catch (err) { return false; }
  }

  function markEngineChosen() {
    try { localStorage.setItem(ENGINE_CHOSEN_KEY, "1"); } catch (err) { /* ignore */ }
  }

  function findEngineButton(dialog, engine, pattern) {
    let btn = dialog.querySelector('button[data-engine="' + engine + '"]');
    if (btn) return btn;
    btn = dialog.querySelector('button[value="' + engine + '"]');
    if (btn) return btn;
    const buttons = dialog.querySelectorAll("button");
    for (const b of buttons) {
      if (pattern.test(b.textContent || "")) return b;
    }
    return null;
  }

  function initOnboarding() {
    const dialog = document.getElementById("onboarding-dialog");
    if (!dialog || typeof dialog.showModal !== "function") return;
    if (engineChosen()) return; // first visit only

    let picked = false;

    function choose(engine) {
      picked = true;
      markEngineChosen();
      currentSettings.engine = engine;
      putSettings({ engine: engine })
        .then(function () { currentSettings.engine = engine; }) // wins any GET race
        .catch(function () { /* keep the local choice */ });
      prefillTaskConfig();
      announce(engine === "codex"
        ? "Движок: Кодекс. Изменить можно в настройках"
        : "Движок: Клауд. Изменить можно в настройках");
      if (dialog.open) dialog.close();
    }

    const claudeBtn = findEngineButton(dialog, "claude", /клауд/i);
    const codexBtn = findEngineButton(dialog, "codex", /кодекс/i);
    if (claudeBtn) claudeBtn.addEventListener("click", function () { choose("claude"); });
    if (codexBtn) codexBtn.addEventListener("click", function () { choose("codex"); });

    // Escape is ALLOWED: closing without a pick defaults to Клауд and still
    // sets the flag so the dialog never nags again.
    dialog.addEventListener("close", function () {
      if (!picked) choose("claude");
    });

    try { dialog.showModal(); } catch (err) { /* already open / unsupported */ }
  }

  // ---- settings dialog (#btn-settings -> #settings-dialog) ----

  let settingsControls = null;

  function initSettingsDialog() {
    const btn = document.getElementById("btn-settings");
    const dialog = document.getElementById("settings-dialog");
    if (!btn || !dialog || typeof dialog.showModal !== "function") return;
    settingsControls = engineControls(dialog, "set-");
    bindEngineRadios(settingsControls);

    let saveRequested = false;

    let saveBtn = dialog.querySelector('button[value="save"]');
    if (!saveBtn) {
      const buttons = dialog.querySelectorAll("button");
      for (const b of buttons) {
        if (/сохран/i.test(b.textContent || "")) { saveBtn = b; break; }
      }
    }
    if (saveBtn) {
      saveBtn.addEventListener("click", function () { saveRequested = true; });
    }

    btn.addEventListener("click", function () {
      saveRequested = false;
      fillEngineControls(settingsControls, currentSettings);
      // Refresh from the server, refill while the user has not saved yet.
      fetchSettings().then(function () {
        if (dialog.open && !saveRequested) {
          fillEngineControls(settingsControls, currentSettings);
        }
      });
      try { dialog.showModal(); } catch (err) { /* ignore */ }
    });

    // «Отмена»/Escape close without saving; focus return is native <dialog>.
    dialog.addEventListener("close", function () {
      const saved = saveRequested || /^(save|сохранить)$/i.test(dialog.returnValue || "");
      saveRequested = false;
      if (!saved) return;
      currentSettings = readEngineControls(settingsControls);
      prefillTaskConfig();
      putSettings(currentSettings)
        .then(function () { announce("Настройки сохранены"); })
        .catch(function () { announce("Не удалось сохранить настройки"); });
    });
  }

  // ---- per-task config (<details id="task-config"> inside #task-form) ----

  let taskConfigControls = null;

  function initTaskConfig() {
    const details = document.getElementById("task-config");
    if (!details) return;
    taskConfigControls = engineControls(details, "cfg-");
    bindEngineRadios(taskConfigControls);
    prefillTaskConfig();
  }

  // Silent prefill from the global settings: on load, after onboarding and
  // after every settings save. Never announces, never moves focus.
  function prefillTaskConfig() {
    if (taskConfigControls) fillEngineControls(taskConfigControls, currentSettings);
  }

  // POST /api/task config payload: {engine, model, mode, subagents} for
  // Клауд, {engine, model, speed} for Кодекс; null while the per-task
  // markup has not shipped (the server then applies the global defaults).
  function taskConfigPayload() {
    if (!taskConfigControls) return null;
    const cfg = readEngineControls(taskConfigControls);
    if (cfg.engine === "codex") {
      return { engine: "codex", model: cfg.codex.model, speed: cfg.codex.speed };
    }
    return {
      engine: "claude",
      model: cfg.claude.model,
      mode: cfg.claude.mode,
      subagents: {
        model: cfg.claude.subagents.model,
        count: cfg.claude.subagents.count,
        types: cfg.claude.subagents.types.slice(),
      },
    };
  }

  // ---- kanban config chips ----

  function makeChip(text, extraClass) {
    const chip = document.createElement("span");
    chip.className = "card-chip" + (extraClass ? " " + extraClass : "");
    chip.textContent = text;
    return chip;
  }

  // Non-interactive full-text chips after the card title: model label
  // («Клауд 4.8»), then mode/speed («Ультракод»/«Фастер»/«Обычный»).
  function buildConfigChips(task) {
    const cfg = task && task.config && typeof task.config === "object" ? task.config : null;
    if (!cfg) return [];
    const chips = [];
    const label = modelLabel(cfg.model);
    if (label) chips.push(makeChip(label, "card-chip-model"));
    const modeText = cfg.engine === "codex"
      ? SPEED_CHIP_LABELS[cfg.speed]
      : MODE_CHIP_LABELS[cfg.mode];
    if (modeText) chips.push(makeChip(modeText, "card-chip-mode"));
    return chips;
  }

  function initEngineUi() {
    initSettingsDialog();
    initTaskConfig();
    fetchModelCatalog();
    fetchSettings().then(prefillTaskConfig);
    initOnboarding();
  }

  // ------------------------------------------------------------------ event state machine

  let bouncePending = false;

  // Zone-card data-state changes and clothesline pip updates are handed off
  // to notifyCharacterEngine, which applies them inside the SAME queued beat
  // as the matching choreo* step, so badges never run ahead of the house.
  // #status announcements, board refetches and sounds stay on server event
  // time (a11y requirement) — only this visual state lags with the animation.
  // When no choreography beat picks the thunk up (farmhouse missing, no
  // matching step) it is applied immediately, i.e. on server time.
  let pendingVisual = null;

  function deferVisual(fn) {
    pendingVisual = fn;
  }

  function isLive(ev) {
    const t = Date.parse(ev.ts || "");
    if (isNaN(t)) return true;
    return Date.now() - t < LIVE_WINDOW_MS;
  }

  function zoneIndex(zoneId) {
    return ZONES.findIndex(function (z) { return z.id === zoneId; });
  }

  function handleEvent(ev) {
    const live = isLive(ev);
    const zone = typeof ev.zone === "string" ? ev.zone : null;

    switch (ev.type) {
      case "task.created": {
        deferVisual(resetZones);
        bouncePending = false;
        if (live) {
          announce(ev.message || "Новая задача создана");
          playSound("take");
        }
        break;
      }
      case "zone.enter": {
        if (!zone) break;
        const idx = zoneIndex(zone);
        deferVisual(function () {
          ZONES.forEach(function (z, i) {
            if (i < idx) {
              if (zoneStates[z.id] !== "done") setZoneState(z.id, "done");
            } else if (i === idx) {
              setZoneState(z.id, "working");
            } else {
              setZoneState(z.id, "idle");
            }
          });
          updateStages(idx);
        });
        moveToken(zone, !live);
        if (live) {
          if (bouncePending) {
            const z = ZONES[idx];
            announce("Задача возвращена " + (z ? z.accusative : "в " + zone));
          } else {
            announce("Задача в зоне «" + zoneTitle(zone) + "»");
          }
        }
        bouncePending = false;
        break;
      }
      case "driver.start": {
        if (zone) deferVisual(function () { setZoneState(zone, "working"); });
        break;
      }
      case "driver.done": {
        // Driver finished; the zone stays "working" until the tester takes over.
        break;
      }
      case "tester.start": {
        if (zone) deferVisual(function () { setZoneState(zone, "testing"); });
        break;
      }
      case "tester.ok": {
        if (zone) deferVisual(function () { setZoneState(zone, "done"); });
        break;
      }
      case "tester.bounce": {
        if (zone) deferVisual(function () { setZoneState(zone, "error"); });
        bouncePending = true;
        if (live) playSound("error");
        break;
      }
      case "task.done": {
        bouncePending = false;
        deferVisual(function () {
          for (const z of ZONES) setZoneState(z.id, "done");
          updateStages(ZONES.length);
        });
        if (live) {
          announce(ev.message || "Задача готова, клиенту можно отправлять!");
          playSound("victory");
        }
        break;
      }
      case "task.failed": {
        bouncePending = false;
        if (zone) deferVisual(function () { setZoneState(zone, "error"); });
        if (live) {
          announceFailure(ev.message || "Задача провалена");
          playSound("error");
        }
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------------ SSE

  let lastSeq = 0;
  let connectionLost = false;

  function connect() {
    let source;
    try {
      source = new EventSource("/events");
    } catch (err) {
      announce("Поток событий недоступен");
      return;
    }

    source.onmessage = function (e) {
      let ev;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return;
      if (typeof ev.seq === "number") {
        if (ev.seq <= lastSeq) return; // dedupe history replayed after reconnect
        lastSeq = ev.seq;
      }
      handleEvent(ev);
      notifyCharacterEngine(ev);
      updateHelpersForEvent(ev);
      // Any event tied to a task may have moved a board card: refetch
      // (debounced 500ms) and let the status-diff produce ONE summary.
      if (typeof ev.taskId === "string" || typeof ev.taskId === "number") {
        scheduleBoardRefetch();
      }
    };

    source.onopen = function () {
      if (connectionLost) {
        connectionLost = false;
        announce("Связь с фермой восстановлена");
        scheduleBoardRefetch(); // catch up on anything missed while offline
      }
    };

    source.onerror = function () {
      // EventSource reconnects on its own; note it once per outage.
      if (!connectionLost) {
        connectionLost = true;
        announce("Связь с фермой потеряна, переподключаемся…");
      }
    };
  }

  // ------------------------------------------------------------------ actor engine + choreographer
  //
  // Decorative actor layer over the farmhouse map: the boss + 8 workers act
  // out pipeline events (sit at desks, stand up, carry the shared paper to
  // each other) via a serialized action queue. Purely visual: every element
  // it touches is aria-hidden and NOTHING in this section ever calls
  // announce()/announceFailure() — map motion is never announced
  // in live regions. Every entry point no-ops gracefully when
  // assets/layout.json or the farmhouse DOM is missing or in an old format.
  // Under prefers-reduced-motion, the «Анимация» pause toggle, or history
  // replay, the queue drains by applying final poses instantly (no
  // transitions, no intervals).

  const ANIM_STORAGE_KEY = "farm.anim";
  const BOSS_HOME = "cabinet";
  const VIEW_W_DEFAULT = 960;
  const VIEW_H_DEFAULT = 540;
  const LANE_Y_DEFAULT = 436;
  const STRIDE_MS = 170;          // 2-frame stride swap ≈ 5.9 fps (motion rule cap is 6)
  const BOB_MS = 400;             // work-bob toggle, well under the stride cap
  const BOB_PX = 3;               // bob amplitude 3px <= 4px
  const ROOM_WALK_MIN_MS = 2000;  // boss room-to-room: 2–4s, linear
  const ROOM_WALK_MAX_MS = 4000;
  const IN_ROOM_MIN_MS = 800;     // in-room walks: 0.8–1.6s, linear
  const IN_ROOM_MAX_MS = 1600;
  const EXIT_FACTOR = 0.75;       // exits are faster than entrances
  const EXIT_MIN_MS = 600;
  const GIVE_MS = 400;            // paper handoff hop (ease-out feedback)
  const HANDOFF_HOLD_MS = 400;    // both actors face each other holding the paper
  const HANDOFF_GAP = 42;         // boss stops a clear step short of the seated worker (view units)
  const BOUNCE_BUBBLE_MS = 1500;  // static "!" beat before the boss collects
  const SPARKLE_HIDE_MS = 2500;   // CSS pulse is finite; element hidden after
  const CATCHUP_QUEUE_LEN = 6;    // queue longer than this => compress durations
  const CATCHUP_FLOOR_MS = 600;   // compressed walks/waits never drop below this
  const CATCHUP_FLOOR_ROOM_MS = 1400; // room-to-room boss legs keep at least this much
                                      // when compressed so they never read as teleports
  const EASE_OUT = "cubic-bezier(0.25, 1, 0.5, 1)";

  // ---- chore (work) animation constants ----
  // Frame swap ≈ 4.5fps (220ms) per the brief, but never faster than the
  // stride cap (≈6fps); particles spawn every ~700–1000ms, capped at 6 on
  // screen. zone -> chore -> particle asset map. Every chore is decorative
  // and lives entirely inside the aria-hidden .farmhouse.
  const WORK_SWAP_MS = Math.max(220, STRIDE_MS); // 4.5fps, honors the stride cap
  const FX_SPAWN_MS = 850;          // one particle every ~700–1000ms while working
  const FX_LIFETIME_MS = 1100;      // rise+fade duration; element removed after
  const FX_MAX = 6;                 // concurrent particles cap (per the brief)
  const ASSET_V = "8";              // cache-bust regenerated work/fx SVGs
  const fxUrl = (p) => p + "?v=" + ASSET_V;
  const CHORE_BY_ZONE = {
    kitchen: "dig",     // Поле — КОПАТЬ/САЖАТЬ -> dirt puffs
    corridor: "haul",   // Амбар — ТАСКАТЬ МЕШКИ -> small dust (reuse dirt)
    living: "water",    // Теплица — ПОЛИВАТЬ -> water drops
    bath: "sell",       // Рынок — ТОРГОВАТЬ -> coin sparkles
  };
  const FX_ASSET = {
    dig: fxUrl("assets/fx-dirt.svg"),
    haul: fxUrl("assets/fx-dirt.svg"),   // штабелирование мешков поднимает ту же пыль
    water: fxUrl("assets/fx-water.svg"),
    sell: fxUrl("assets/fx-coin.svg"),
  };

  function choreFor(zoneId) {
    return CHORE_BY_ZONE[zoneId] || null;
  }

  const ANCHOR_ALIASES = {
    cabinet: ["cabinet", "office", "boss", "study"],
    kitchen: ["kitchen", "assembly"],
    corridor: ["corridor", "hall", "hallway"],
    living: ["living", "livingroom", "living-room", "qa"],
    bath: ["bath", "bathroom", "release"],
  };

  let charLayout = null;            // normalized layout.json (v2-aware)
  let layoutSettled = Promise.resolve(); // queue waits for the layout fetch
  let animEnabled = true;           // «Анимация» toggle; false = body.anim-paused
  const actors = {};                // id -> actor record (boss + workers)
  let bossActor = null;
  let paperEl = null;               // the single shared paper <img>
  let paperX = null;                // paper position in viewBox units
  let paperVisible = false;
  let forceInstant = false;         // true while replaying history (non-live)
  let sparkleTimer = null;
  let bubbleX = null;               // viewBox x of the visible "!" bubble
  let actorResizeTimer = null;

  function farmEl() { return document.querySelector(".farmhouse"); }
  function bossEl() { return document.getElementById("boss"); }

  function elWidth(el) {
    if (!el) return 0;
    if (el.offsetWidth) return el.offsetWidth;
    return el.getBoundingClientRect ? el.getBoundingClientRect().width : 0;
  }

  function motionAllowed() {
    return animEnabled && !reducedMotion() && !forceInstant;
  }

  function num(v) {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  // ---- layout.json parsing (v2: lane/anchors/workers/zones; tolerant) ----

  function anchorXFrom(value) {
    if (typeof value === "number" && isFinite(value)) return value;
    if (typeof value === "string") return num(value);
    if (!value || typeof value !== "object") return null;
    const keys = ["x", "cx", "bossX", "anchorX"];
    for (const key of keys) {
      const direct = anchorXFrom(value[key]);
      if (direct != null) return direct;
    }
    if (value.anchor) {
      const nested = anchorXFrom(value.anchor);
      if (nested != null) return nested;
    }
    const left = parseFloat(value.left);
    const width = parseFloat(value.width);
    if (isFinite(left) && isFinite(width)) return left + width / 2;
    return null;
  }

  function collectAnchors(source, anchors) {
    if (!source || typeof source !== "object") return;
    if (Array.isArray(source)) {
      for (const item of source) {
        if (!item || typeof item !== "object") continue;
        const id = item.id || item.zone || item.room || item.name;
        const x = anchorXFrom(item);
        if (typeof id === "string" && x != null && anchors[id] == null) anchors[id] = x;
      }
      return;
    }
    for (const key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const x = anchorXFrom(source[key]);
      if (x != null && anchors[key] == null) anchors[key] = x;
    }
  }

  function normalizeLayout(data) {
    if (!data || typeof data !== "object") return null;
    let width = VIEW_W_DEFAULT;
    let height = VIEW_H_DEFAULT;
    if (typeof data.viewBox === "string") {
      const parts = data.viewBox.trim().split(/\s+/);
      if (parts.length === 4) {
        const w = parseFloat(parts[2]);
        const h = parseFloat(parts[3]);
        if (isFinite(w) && w > 0) width = w;
        if (isFinite(h) && h > 0) height = h;
      }
    } else if (data.viewBox && typeof data.viewBox === "object") {
      const w = parseFloat(data.viewBox.width);
      const h = parseFloat(data.viewBox.height);
      if (isFinite(w) && w > 0) width = w;
      if (isFinite(h) && h > 0) height = h;
    } else {
      const w = parseFloat(data.viewBoxWidth != null ? data.viewBoxWidth : data.width);
      const h = parseFloat(data.viewBoxHeight != null ? data.viewBoxHeight : data.height);
      if (isFinite(w) && w > 0) width = w;
      if (isFinite(h) && h > 0) height = h;
    }
    const anchors = {};
    collectAnchors(data.anchors, anchors);
    collectAnchors(data.rooms, anchors);
    const zones = data.zones && typeof data.zones === "object" && !Array.isArray(data.zones)
      ? data.zones
      : null;
    const workers = data.workers && typeof data.workers === "object" && !Array.isArray(data.workers)
      ? data.workers
      : null;
    const lane = data.lane && typeof data.lane === "object" ? num(data.lane.y) : null;
    let usable = zones != null;
    if (!usable) {
      for (const zoneId in ANCHOR_ALIASES) {
        if (!Object.prototype.hasOwnProperty.call(ANCHOR_ALIASES, zoneId)) continue;
        const names = ANCHOR_ALIASES[zoneId];
        for (const name of names) {
          if (anchors[name] != null) { usable = true; break; }
        }
        if (usable) break;
      }
    }
    if (!usable) return null;
    return { width: width, height: height, laneY: lane, anchors: anchors, workers: workers, zones: zones };
  }

  function viewW() { return charLayout && charLayout.width ? charLayout.width : VIEW_W_DEFAULT; }
  function viewH() { return charLayout && charLayout.height ? charLayout.height : VIEW_H_DEFAULT; }
  function laneY() { return charLayout && charLayout.laneY != null ? charLayout.laneY : LANE_Y_DEFAULT; }

  function bottomPct(y) {
    const h = viewH() || VIEW_H_DEFAULT;
    return Math.round(((h - y) / h) * 10000) / 100;
  }

  function zoneSpecRaw(zoneId) {
    return charLayout && charLayout.zones ? charLayout.zones[zoneId] : null;
  }

  function anchorViewX(zoneId) {
    if (!charLayout || !zoneId) return null;
    const names = ANCHOR_ALIASES[zoneId] || [zoneId];
    for (const name of names) {
      if (charLayout.anchors && charLayout.anchors[name] != null) return charLayout.anchors[name];
    }
    if (charLayout.anchors && charLayout.anchors[zoneId] != null) return charLayout.anchors[zoneId];
    const raw = zoneSpecRaw(zoneId);
    if (raw) {
      const door = anchorXFrom(raw.door);
      if (door != null) return door;
    }
    return null;
  }

  function roleSpec(raw) {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" ? raw.id : null;
    return {
      actor: id && actors[id] ? actors[id] : null,
      seat: anchorXFrom(raw.seat),
      desk: anchorXFrom(raw.desk),
    };
  }

  // Zone crew: { door, driver: {actor, seat, desk}, tester: {...} } or null
  // when layout.json is the old (anchors-only) format — choreography then
  // degrades to boss-only walks between room anchors.
  function zoneCrew(zoneId) {
    const raw = zoneSpecRaw(zoneId);
    if (!raw || typeof raw !== "object") return null;
    return {
      door: anchorXFrom(raw.door),
      driver: roleSpec(raw.driver),
      tester: roleSpec(raw.tester),
    };
  }

  function seatViewX(workerId) {
    if (!charLayout || !charLayout.zones) return null;
    for (const zoneId in charLayout.zones) {
      if (!Object.prototype.hasOwnProperty.call(charLayout.zones, zoneId)) continue;
      const raw = charLayout.zones[zoneId];
      if (!raw || typeof raw !== "object") continue;
      const roles = [raw.driver, raw.tester];
      for (const role of roles) {
        if (role && role.id === workerId) {
          const x = anchorXFrom(role.seat);
          if (x != null) return x;
        }
      }
    }
    return null;
  }

  // ---- actors ----

  function frameSrcs(spriteEl) {
    const a = spriteEl.getAttribute("data-frame-a") || spriteEl.getAttribute("src") || "";
    const b = spriteEl.getAttribute("data-frame-b") || a;
    let sit = spriteEl.getAttribute("data-frame-sit");
    if (!sit && a) sit = a.replace(/-a(\.[a-z]+)$/i, "-sit$1");
    // Chore (work) frames: explicit data-* override, else the
    // assets/char-<id>-work1.svg / -work2.svg path convention derived from
    // frame "a". A missing file just fails to paint (graceful no-op): the
    // sprite keeps showing its previous frame, the swap interval is harmless.
    let work1 = spriteEl.getAttribute("data-frame-work1");
    let work2 = spriteEl.getAttribute("data-frame-work2");
    // Regenerated chore frames carry a cache-bust query so the new silhouette
    // poses load even if the old -work*.svg is in the browser cache.
    if (!work1 && a) work1 = fxUrl(a.replace(/-a(\.[a-z]+)$/i, "-work1$1"));
    if (!work2 && a) work2 = fxUrl(a.replace(/-a(\.[a-z]+)$/i, "-work2$1"));
    return { a: a, b: b, sit: sit || a, work1: work1 || a, work2: work2 || (work1 || a) };
  }

  function setFrame(actor, key) {
    if (!actor || !actor.spriteEl || !actor.frames) return;
    const src = actor.frames[key] || actor.frames.a;
    if (!src || actor.frame === key) return;
    actor.frame = key;
    actor.spriteEl.setAttribute("src", src);
  }

  function pxForViewX(viewX, el) {
    const farm = farmEl();
    if (!farm || viewX == null) return null;
    const rendered = elWidth(farm);
    if (!rendered) return null;
    return (viewX / viewW()) * rendered - elWidth(el) / 2;
  }

  function paintActorAt(actor, viewX, ms) {
    if (!actor || !actor.el) return;
    const px = pxForViewX(viewX, actor.el);
    if (px == null) return;
    const bob = actor.bobUp ? -BOB_PX : 0;
    actor.el.style.transition = ms > 0 ? "transform " + ms + "ms linear" : "none";
    actor.el.style.transform =
      "translateX(" + Math.round(px) + "px) translateY(" + bob + "px) scaleX(" + actor.face + ")";
  }

  function paintActor(actor, ms) {
    paintActorAt(actor, actor.viewX, ms);
  }

  function makeActor(id, el, spriteEl, startViewX, y) {
    const actor = {
      id: id,
      el: el,
      spriteEl: spriteEl,
      frames: frameSrcs(spriteEl),
      frame: null,
      viewX: startViewX,
      homeX: null,
      face: 1,
      carrying: false,
      sitting: false,
      walking: false,
      bobbing: false,
      bobUp: false,
      strideB: false,
      strideTimer: null,
      bobTimer: null,
      walkResolve: null,
      walkTimer: null,
      working: false,        // chore frame-swap active for this actor
      workChore: null,       // which chore (dig/haul/water/sell) it is doing
      workB: false,          // current work frame (false=work1, true=work2)
      workTimer: null,       // setInterval handle for the frame swap
      fxTimer: null,         // setInterval handle for the particle emitter
    };
    el.style.left = "0px"; // x is driven by translateX from viewBox units
    if (y != null) el.style.bottom = bottomPct(y) + "%";
    function onEnd(e) {
      if (e && e.target !== el) return;
      if (actor.walkResolve && (!e || !e.propertyName || e.propertyName === "transform")) {
        finishWalk(actor);
      }
    }
    el.addEventListener("transitionend", onEnd);
    el.addEventListener("transitioncancel", onEnd);
    return actor;
  }

  function buildActors() {
    const farm = farmEl();
    if (!farm || !charLayout) return;
    const bossDiv = bossEl();
    if (bossDiv && !actors.boss) {
      const sprite = bossDiv.querySelector(".boss-sprite") || bossDiv.querySelector("img");
      if (sprite) {
        const homeX = anchorViewX(BOSS_HOME);
        bossActor = makeActor("boss", bossDiv, sprite, homeX != null ? homeX : 0, laneY());
        bossActor.homeX = homeX;
        actors.boss = bossActor;
      }
      const oldParcel = bossDiv.querySelector(".parcel");
      if (oldParcel) oldParcel.hidden = true; // superseded by the shared paper
    }
    const workerEls = farm.querySelectorAll("[data-worker]");
    for (const el of workerEls) {
      const id = el.getAttribute("data-worker");
      if (!id || actors[id]) continue;
      const seatX = seatViewX(id);
      const meta = charLayout.workers ? charLayout.workers[id] : null;
      let startX = seatX;
      if (startX == null && meta) startX = anchorXFrom(meta);
      if (startX == null) startX = inlineViewX(el);
      if (startX == null) continue; // unmanaged: leave the markup positioning
      const y = meta && num(meta.y) != null ? num(meta.y) : laneY();
      const actor = makeActor(id, el, el, startX, y);
      actor.homeX = startX;
      el.classList.add("actor");
      // Fallback sizing only when the stylesheet leaves the sprite at its
      // tiny natural size (16px); never overrides a CSS-sized sprite.
      if (!el.style.width && elWidth(el) > 0 && elWidth(el) <= 20) el.style.width = "4.2%";
      actors[id] = actor;
      actor.sitting = true; // workers start seated at their stations
      setFrame(actor, "sit");
      paintActor(actor, 0);
    }
    if (bossActor) paintActor(bossActor, 0);
    ensurePaperEl();
  }

  function inlineViewX(el) {
    const raw = el && el.style ? el.style.left : "";
    if (typeof raw !== "string" || raw.indexOf("%") === -1) return null;
    const pct = num(raw);
    return pct == null ? null : (pct / 100) * viewW();
  }

  // ---- pacing (catch-up + instant gates) ----

  // protect=true marks a narrative beat (paper handoffs and the in-room
  // paper carries): beats always keep their full duration so the story
  // «взял бумажку — понёс — отдал» stays readable; catch-up compression
  // only ever shortens boss transits and waits.
  function dur(ms, protect) {
    if (!motionAllowed()) return 0;
    if (!protect && actionQueue.length > CATCHUP_QUEUE_LEN) {
      // Catch-up: halve, but never below the floor (or below the original
      // ms when it was already shorter) — compressed walks must stay
      // readable steps, not blinks. Room-to-room boss legs (only roomWalkMs
      // produces durations >= ROOM_WALK_MIN_MS) keep the higher floor so
      // they never read as teleports. The queue is allowed to drain a
      // little behind real time instead of racing the server clock.
      const floor = ms >= ROOM_WALK_MIN_MS ? CATCHUP_FLOOR_ROOM_MS : CATCHUP_FLOOR_MS;
      return Math.max(Math.min(ms, floor), Math.round(ms / 2));
    }
    return ms;
  }

  function wait(ms) {
    const t = dur(ms);
    if (t <= 0) return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, t); });
  }

  function roomWalkMs(fromX, toX) {
    const span = viewW() || VIEW_W_DEFAULT;
    const f = Math.min(1, Math.abs(toX - fromX) / span);
    return Math.round(ROOM_WALK_MIN_MS + f * (ROOM_WALK_MAX_MS - ROOM_WALK_MIN_MS));
  }

  function inRoomWalkMs(fromX, toX) {
    const dist = Math.abs(toX - fromX);
    return Math.round(Math.min(IN_ROOM_MAX_MS, Math.max(IN_ROOM_MIN_MS, IN_ROOM_MIN_MS + dist * 4)));
  }

  function exitWalkMs(fromX, toX) {
    return Math.max(EXIT_MIN_MS, Math.round(inRoomWalkMs(fromX, toX) * EXIT_FACTOR));
  }

  // ---- primitives (each returns a Promise) ----

  function startStride(actor) {
    stopStride(actor);
    if (!motionAllowed()) return;
    actor.strideTimer = setInterval(function () {
      actor.strideB = !actor.strideB;
      setFrame(actor, actor.strideB ? "b" : "a");
    }, STRIDE_MS);
  }

  function stopStride(actor) {
    if (actor.strideTimer) { clearInterval(actor.strideTimer); actor.strideTimer = null; }
    actor.strideB = false;
    if (!actor.sitting) setFrame(actor, "a");
  }

  function finishWalk(actor) {
    if (!actor) return;
    if (actor.walkTimer) { clearTimeout(actor.walkTimer); actor.walkTimer = null; }
    const resolve = actor.walkResolve;
    actor.walkResolve = null;
    actor.walking = false;
    stopStride(actor);
    if (resolve) {
      paintActor(actor, 0); // snap to the commanded final position
      if (actor.carrying) paintPaperAt(actor.viewX, 0);
      resolve();
    }
    if (actor.bobbing) bobAt(actor, true); // resume a suspended work-bob
  }

  // walkTo: translate transition + ~160ms stride frame swap + flip by
  // direction; resolves on transitionend with a fallback timeout. Collapses
  // to an instant repaint when motion is paused/reduced or replaying history.
  function walkTo(actor, targetViewX, ms, protect) {
    if (!actor || !actor.el || targetViewX == null || !charLayout || !farmEl()) {
      return Promise.resolve();
    }
    finishWalk(actor); // resolve any stale walk first (defensive)
    if (actor.bobTimer) { clearInterval(actor.bobTimer); actor.bobTimer = null; }
    actor.bobUp = false;
    actor.sitting = false;
    setFrame(actor, "a");
    const fromX = actor.viewX;
    actor.viewX = targetViewX;
    const msEff = dur(ms, protect);
    if (msEff <= 0 || Math.abs(targetViewX - fromX) < 0.5) {
      paintActor(actor, 0);
      if (actor.carrying) paintPaperAt(targetViewX, 0);
      return Promise.resolve();
    }
    const face = targetViewX < fromX ? -1 : 1;
    actor.face = face; // flip instantly: scaleX never tweens through 0
    paintActorAt(actor, fromX, 0);
    void actor.el.offsetWidth; // reflow so the next transform transitions
    actor.walking = true;
    startStride(actor);
    return new Promise(function (resolve) {
      actor.walkResolve = resolve;
      paintActorAt(actor, targetViewX, msEff);
      if (actor.carrying) paintPaperAt(targetViewX, msEff, "linear");
      // Safety net in case transitionend never fires (e.g. hidden tab).
      actor.walkTimer = setTimeout(function () { finishWalk(actor); }, msEff + 250);
    });
  }

  function sit(actor) {
    if (!actor) return Promise.resolve();
    bobAt(actor, false);
    actor.sitting = true;
    setFrame(actor, "sit");
    return Promise.resolve();
  }

  function stand(actor) {
    if (!actor) return Promise.resolve();
    actor.sitting = false;
    setFrame(actor, "a");
    return Promise.resolve();
  }

  // bobAt: gentle work-bob (3px, 400ms toggle) driven by a JS interval so
  // the pause/reduced-motion gates can freeze it; flag survives suspension.
  function bobAt(actor, on) {
    if (!actor) return;
    actor.bobbing = Boolean(on);
    if (actor.bobTimer) { clearInterval(actor.bobTimer); actor.bobTimer = null; }
    if (actor.bobUp) {
      actor.bobUp = false;
      if (!actor.walking) paintActor(actor, 0);
    }
    if (!actor.bobbing || actor.walking || !motionAllowed()) return;
    actor.bobTimer = setInterval(function () {
      actor.bobUp = !actor.bobUp;
      paintActor(actor, 0);
    }, BOB_MS);
  }

  function suspendBobs() {
    for (const id in actors) {
      if (!Object.prototype.hasOwnProperty.call(actors, id)) continue;
      const actor = actors[id];
      if (actor.bobTimer) { clearInterval(actor.bobTimer); actor.bobTimer = null; }
      if (actor.bobUp) { actor.bobUp = false; paintActor(actor, 0); }
    }
  }

  function resumeBobs() {
    for (const id in actors) {
      if (!Object.prototype.hasOwnProperty.call(actors, id)) continue;
      const actor = actors[id];
      if (actor.bobbing) bobAt(actor, true);
      if (actor.working) workAt(actor, true, actor.workChore); // resume frame swap + fx
    }
    startHelperBob(); // no-op unless helpers are visible and motion allowed
  }

  // ---- chore (work) animation: frame swap + particle emitter ----
  // workAt: while ON and motion is allowed, swap the sprite between its two
  // work frames on an interval (≈4.5fps, honoring the stride cap) and run the
  // particle emitter for the matching chore. While OFF — or whenever motion is
  // not allowed (reduced-motion / «Анимация» pause / history replay) — both
  // the swap interval and the emitter are cleared and the sprite freezes on a
  // single static work pose (work1). The `working`/`workChore` flags survive a
  // pause so resumeBobs() can restart the loop on toggle-on. Decorative only:
  // the sprite is inside the aria-hidden .farmhouse and nothing is announced.
  function workAt(actor, on, chore) {
    if (!actor || !actor.spriteEl) return;
    actor.working = Boolean(on);
    actor.workChore = on ? (chore || actor.workChore) : actor.workChore;
    stopWork(actor); // clear any existing swap interval + emitter first
    if (!actor.working) {
      // Off: drop the chore identity and fall back to the idle/standing frame.
      actor.workChore = null;
      if (!actor.sitting && !actor.walking) setFrame(actor, "a");
      return;
    }
    if (!motionAllowed()) {
      // Motion off but still "working": a single STATIC work pose, no loop.
      actor.workB = false;
      setFrame(actor, "work1");
      return;
    }
    actor.sitting = false;
    actor.workB = false;
    setFrame(actor, "work1");
    actor.workTimer = setInterval(function () {
      if (actor.walking) return; // a stride swap owns the sprite mid-walk
      actor.workB = !actor.workB;
      setFrame(actor, actor.workB ? "work2" : "work1");
    }, WORK_SWAP_MS);
    startFx(actor, actor.workChore);
  }

  function stopWork(actor) {
    if (!actor) return;
    if (actor.workTimer) { clearInterval(actor.workTimer); actor.workTimer = null; }
    stopFx(actor);
  }

  // Count live particles inside the farmhouse so we can cap concurrency.
  function fxCount() {
    const farm = farmEl();
    return farm ? farm.querySelectorAll(".fx").length : 0;
  }

  // spawnFx: append one decorative particle <img> at the actor's position and
  // remove it after its rise+fade. NEVER spawns when motion is not allowed,
  // and respects the FX_MAX concurrency cap. The rise+fade is driven by the
  // Web Animations API so no stylesheet change is needed and the element is
  // self-cleaning; one finite play (no looping, no white strobe, subtle).
  function spawnFx(actor, chore) {
    if (!actor || !motionAllowed()) return;
    const farm = farmEl();
    const src = FX_ASSET[chore];
    if (!farm || !src || fxCount() >= FX_MAX) return;
    const px = pxForViewX(actor.viewX, actor.el);
    if (px == null) return;
    const img = document.createElement("img");
    img.className = "fx fx-" + chore;
    img.src = src;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.style.position = "absolute";
    img.style.left = "0px";
    // emit at roughly hand/chest height, jittered a little around the worker
    const jitter = (Math.random() * 24 - 12);
    img.style.bottom = (bottomPct(laneY()) + 7) + "%";
    // size comes from the .fx CSS rule (kept square); no inline width override
    // (an inline % width fought the CSS height and squashed coins into bars)
    img.style.zIndex = "7";
    img.style.pointerEvents = "none";
    img.style.transform = "translateX(" + Math.round(px + jitter) + "px)";
    farm.appendChild(img);
    let anim = null;
    try {
      if (typeof img.animate === "function") {
        // small lift (≈20px) + soft fade; finite, single play, no strobe
        anim = img.animate(
          [
            { transform: "translate(" + Math.round(px + jitter) + "px, 2px)", opacity: 0.0 },
            { transform: "translate(" + Math.round(px + jitter) + "px, -6px)", opacity: 0.9, offset: 0.25 },
            { transform: "translate(" + Math.round(px + jitter) + "px, -20px)", opacity: 0.0 },
          ],
          { duration: FX_LIFETIME_MS, easing: "ease-out", fill: "forwards" }
        );
      }
    } catch (err) { anim = null; }
    function remove() { if (img.parentNode) img.parentNode.removeChild(img); }
    if (anim && typeof anim.finished !== "undefined") {
      anim.finished.then(remove).catch(remove);
    } else {
      setTimeout(remove, FX_LIFETIME_MS + 40);
    }
  }

  // Emit one chore particle now, plus — for the «sell» (Рынок/ТОРГ) chore —
  // a second coin ~280ms later so the «trade» reads as a little shower of
  // coins. Still pause/reduced-motion-safe (re-checks at fire time), still
  // under FX_MAX (spawnFx caps), and at ~280ms apart it stays well under
  // 3 flashes/sec (each beat is FX_SPAWN_MS≈850ms apart).
  function emitFx(actor, chore) {
    spawnFx(actor, chore);
    if (chore === "sell") {
      setTimeout(function () {
        if (actor && actor.working && motionAllowed()) spawnFx(actor, chore);
      }, 280);
    }
  }

  function startFx(actor, chore) {
    stopFx(actor);
    if (!actor || !chore || !FX_ASSET[chore] || !motionAllowed()) return;
    emitFx(actor, chore); // one immediately so the chore reads at once
    actor.fxTimer = setInterval(function () {
      if (!actor.working || !motionAllowed()) { stopFx(actor); return; }
      emitFx(actor, chore);
    }, FX_SPAWN_MS);
  }

  function stopFx(actor) {
    if (actor && actor.fxTimer) { clearInterval(actor.fxTimer); actor.fxTimer = null; }
  }

  // Freeze every chore on a pause / reduced-motion change: clear all swap
  // intervals + emitters, drop in-flight particles, and pin still-working
  // sprites to their single static work pose (work1). Working flags survive
  // so resumeBobs() can restart the loops on toggle-on.
  function suspendWork() {
    for (const id in actors) {
      if (!Object.prototype.hasOwnProperty.call(actors, id)) continue;
      const actor = actors[id];
      stopWork(actor);
      if (actor.working) { actor.workB = false; setFrame(actor, "work1"); }
    }
    const farm = farmEl();
    if (farm) {
      const live = farm.querySelectorAll(".fx");
      for (const el of live) { if (el.parentNode) el.parentNode.removeChild(el); }
    }
  }

  // ---- the shared paper ----

  function ensurePaperEl() {
    if (paperEl && paperEl.parentNode) return paperEl;
    const farm = farmEl();
    if (!farm) return null;
    const img = document.createElement("img");
    img.className = "item-paper";
    img.src = "assets/item-paper.svg";
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    img.hidden = true;
    img.style.position = "absolute";
    img.style.left = "0px";
    img.style.bottom = (bottomPct(laneY()) + 6) + "%"; // carried at hand height
    img.style.width = "2.6%";
    img.style.zIndex = "7";
    img.style.pointerEvents = "none";
    farm.appendChild(img);
    paperEl = img;
    return img;
  }

  function paintPaperAt(viewX, ms, easing) {
    const p = ensurePaperEl();
    if (!p || viewX == null) return;
    paperX = viewX;
    const px = pxForViewX(viewX, p);
    if (px == null) return;
    p.style.transition = ms > 0 ? "transform " + ms + "ms " + (easing || "linear") : "none";
    p.style.transform = "translateX(" + Math.round(px) + "px)";
  }

  function attachPaper(actor) {
    if (!actor) return;
    for (const id in actors) {
      if (Object.prototype.hasOwnProperty.call(actors, id)) actors[id].carrying = false;
    }
    actor.carrying = true;
    const p = ensurePaperEl();
    if (!p) return;
    p.hidden = false;
    p.style.opacity = "";
    paperVisible = true;
    paintPaperAt(actor.viewX, 0);
  }

  // give: the paper hops from the giver to the receiver (single shared img).
  // A protected narrative beat: both actors turn to face each other, the
  // paper hops at full GIVE_MS (never compressed by catch-up), and they hold
  // the facing pose for a beat so the exchange visibly registers.
  function give(from, to) {
    if (!to || !to.el) return Promise.resolve();
    if (from) from.carrying = false;
    to.carrying = true;
    if (from && from.el && Math.abs(to.viewX - from.viewX) > 0.5) {
      const dirn = to.viewX > from.viewX ? 1 : -1;
      from.face = dirn;   // giver looks at the receiver
      to.face = -dirn;    // receiver looks back at the giver
      paintActor(from, 0);
      paintActor(to, 0);
    }
    const p = ensurePaperEl();
    if (!p) return Promise.resolve();
    p.hidden = false;
    p.style.opacity = "";
    paperVisible = true;
    const msEff = dur(GIVE_MS, true);
    paintPaperAt(to.viewX, msEff, EASE_OUT);
    if (msEff <= 0) return Promise.resolve();
    const holdMs = dur(HANDOFF_HOLD_MS, true);
    return new Promise(function (resolve) { setTimeout(resolve, msEff + holdMs + 30); });
  }

  function fadePaperOut() {
    for (const id in actors) {
      if (Object.prototype.hasOwnProperty.call(actors, id)) actors[id].carrying = false;
    }
    paperVisible = false;
    const p = paperEl;
    if (!p || p.hidden) return Promise.resolve();
    const msEff = dur(300);
    if (msEff <= 0) { p.hidden = true; return Promise.resolve(); }
    p.style.transition = "opacity " + msEff + "ms " + EASE_OUT;
    p.style.opacity = "0";
    return new Promise(function (resolve) {
      setTimeout(function () {
        p.hidden = true;
        p.style.opacity = "";
        p.style.transition = "none";
        resolve();
      }, msEff + 30);
    });
  }

  // ---- map overlays: done-sparkle and static "!" failure bubble ----

  function overlayEl(className, glyph) {
    const farm = farmEl();
    if (!farm) return null;
    let el = farm.querySelector("." + className);
    if (el) return el;
    el = document.createElement("div");
    el.className = className;
    el.setAttribute("aria-hidden", "true");
    el.textContent = glyph;
    el.hidden = true;
    el.style.position = "absolute";
    el.style.left = "0px";
    el.style.zIndex = "8";
    el.style.pointerEvents = "none";
    if (className === "error-bubble") {
      // darkened state color as text on cream — never gold, never color-alone
      el.style.bottom = "44%";
      el.style.padding = "0.05em 0.4em";
      el.style.border = "2px solid var(--state-error)";
      el.style.borderRadius = "0.375rem";
      el.style.background = "var(--surface)";
      el.style.color = "var(--state-error)";
      el.style.fontWeight = "700";
      el.style.fontSize = "1.25rem";
      el.style.lineHeight = "1.4";
    } else {
      el.style.bottom = "34%";
      el.style.color = "var(--state-done)";
      el.style.fontSize = "1.5rem";
      el.style.lineHeight = "1";
    }
    farm.appendChild(el);
    return el;
  }

  function placeOverlayAt(el, viewX) {
    const px = pxForViewX(viewX, el);
    if (px == null) return false;
    el.style.transform = "translateX(" + Math.round(px) + "px)";
    return true;
  }

  function showFailBubble(zoneId) {
    const x = anchorViewX(zoneId);
    if (x == null) return;
    const bubble = overlayEl("error-bubble", "!");
    if (!bubble) return;
    bubbleX = x;
    bubble.style.animation = "none"; // static under pause/reduced motion
    bubble.hidden = false;           // unhide first so its width measures
    if (!placeOverlayAt(bubble, x)) { bubble.hidden = true; bubbleX = null; return; }
    if (motionAllowed()) {
      void bubble.offsetWidth;       // restart the finite pop-in
      bubble.style.animation = "";
    }
  }

  function hideFailBubble() {
    bubbleX = null;
    const farm = farmEl();
    const bubble = farm ? farm.querySelector(".error-bubble") : null;
    if (bubble) bubble.hidden = true;
  }

  function flashDoneSparkle() {
    const x = anchorViewX(BOSS_HOME);
    if (x == null) return;
    const sparkle = overlayEl("done-sparkle", "✦");
    if (!sparkle) return;
    sparkle.style.animation = "none";
    sparkle.hidden = false;
    if (!placeOverlayAt(sparkle, x)) { sparkle.hidden = true; return; }
    if (motionAllowed()) {
      void sparkle.offsetWidth;
      sparkle.style.animation = ""; // finite CSS pulse (<= 3/sec)
    }
    if (sparkleTimer) clearTimeout(sparkleTimer);
    sparkleTimer = setTimeout(hideDoneSparkle, SPARKLE_HIDE_MS);
  }

  function hideDoneSparkle() {
    if (sparkleTimer) { clearTimeout(sparkleTimer); sparkleTimer = null; }
    const farm = farmEl();
    const sparkle = farm ? farm.querySelector(".done-sparkle") : null;
    if (sparkle) sparkle.hidden = true;
  }

  // ---- helpers: subagent sprites in the Теплица (living/QA) ----
  // Decorative «помощники»: while the active task sits in the greenhouse
  // with N subagents (the «N субагентов» SSE message, the task's stored
  // config, or the global settings), min(N,4) .helper sprites appear at the
  // layout.json helpers anchor and work-bob. They hide on zone exit and on
  // task end. Everything is aria-hidden inside .farmhouse and the bob is
  // fully gated by prefers-reduced-motion and the «Анимация» pause.

  const HELPER_MAX = 4;
  const HELPER_SPACING = 30;  // viewBox units between helper sprites
  const HELPER_RAISE_PCT = 9; // helpers float on a row above the seat lane
  const HELPER_SPRITES = [
    "assets/char-cleaner-b.svg",
    "assets/char-editor-b.svg",
    "assets/char-validator-b.svg",
    "assets/char-scraper-b.svg",
  ];

  const helperEls = [];
  let helpersShown = 0;
  let helperBobTimer = null;
  let helperBobUp = false;

  function helpersAnchorX() {
    if (!charLayout) return null;
    if (charLayout.anchors && charLayout.anchors.helpers != null) {
      return charLayout.anchors.helpers;
    }
    return anchorViewX("living"); // fallback: the greenhouse room anchor
  }

  function ensureHelperEls() {
    const farm = farmEl();
    if (!farm) return false;
    while (helperEls.length < HELPER_MAX) {
      const img = document.createElement("img");
      img.className = "helper";
      img.src = HELPER_SPRITES[helperEls.length % HELPER_SPRITES.length];
      img.alt = "";
      img.setAttribute("aria-hidden", "true");
      img.hidden = true;
      img.style.position = "absolute";
      img.style.left = "0px";
      img.style.bottom = (bottomPct(laneY()) + HELPER_RAISE_PCT) + "%";
      img.style.width = "3.4%";
      img.style.zIndex = "6";
      img.style.pointerEvents = "none";
      farm.appendChild(img);
      helperEls.push(img);
    }
    return true;
  }

  function paintHelpers() {
    if (helpersShown <= 0) return;
    const base = helpersAnchorX();
    if (base == null) return;
    for (let i = 0; i < helperEls.length; i++) {
      const el = helperEls[i];
      if (el.hidden) continue;
      const x = base + (i - (helpersShown - 1) / 2) * HELPER_SPACING;
      const px = pxForViewX(x, el);
      if (px == null) continue;
      // alternate bob phase per sprite so the crew does not pump in unison
      const bob = helperBobUp === (i % 2 === 0) ? -BOB_PX : 0;
      el.style.transform = "translateX(" + Math.round(px) + "px) translateY(" + bob + "px)";
    }
  }

  function startHelperBob() {
    stopHelperBob();
    if (helpersShown <= 0) return;
    if (!animEnabled || reducedMotion()) return; // both gates cover the bob
    helperBobTimer = setInterval(function () {
      helperBobUp = !helperBobUp;
      paintHelpers();
    }, BOB_MS);
  }

  function stopHelperBob() {
    if (helperBobTimer) { clearInterval(helperBobTimer); helperBobTimer = null; }
    if (helperBobUp) { helperBobUp = false; paintHelpers(); }
  }

  function showHelpers(count) {
    const n = Math.min(HELPER_MAX, Math.max(0, count | 0));
    if (n <= 0 || !charLayout || !ensureHelperEls()) { hideHelpers(); return; }
    helpersShown = n;
    for (let i = 0; i < helperEls.length; i++) helperEls[i].hidden = i >= n;
    paintHelpers();
    startHelperBob();
  }

  function hideHelpers() {
    helpersShown = 0;
    stopHelperBob();
    for (const el of helperEls) el.hidden = true;
  }

  // N: «N субагентов» in the event message wins; else the task's stored
  // config from /api/tasks; else the global settings (Клауд only — Кодекс
  // has no subagents).
  function resolveHelperCount(ev) {
    const m = typeof ev.message === "string" ? ev.message.match(/(\d+)\s*субагент/i) : null;
    if (m) return Promise.resolve(parseInt(m[1], 10) || 0);
    const fallback = currentSettings.engine === "claude"
      ? currentSettings.claude.subagents.count
      : 0;
    if (ev.taskId == null) return Promise.resolve(fallback);
    return fetch("/api/tasks")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        const tasks = data && Array.isArray(data.tasks) ? data.tasks : [];
        const task = tasks.find(function (t) { return t && t.id === ev.taskId; });
        const cfg = task && task.config && typeof task.config === "object" ? task.config : null;
        if (!cfg) return fallback;
        if (cfg.engine === "codex") return 0;
        const sub = cfg.subagents && typeof cfg.subagents === "object" ? cfg.subagents : null;
        const n = sub ? parseInt(sub.count, 10) : NaN;
        return isFinite(n) ? n : fallback;
      })
      .catch(function () { return fallback; });
  }

  // SSE hook (server time, never queued — visibility is state, not motion):
  // entering the Теплица shows the crew, any other zone or task end hides it.
  function updateHelpersForEvent(ev) {
    if (!ev || typeof ev.type !== "string" || !farmEl()) return;
    if (ev.type === "zone.enter") {
      if (ev.zone !== "living") { hideHelpers(); return; }
      resolveHelperCount(ev).then(function (n) {
        // the task may have left the greenhouse while the count was fetched
        if (currentZoneId === "living") showHelpers(n);
      });
      return;
    }
    if (ev.type === "task.done" || ev.type === "task.failed" || ev.type === "task.created") {
      hideHelpers();
    }
  }

  // ---- global flush (pause toggle / reduced-motion change) ----

  function flushAllMotion() {
    for (const id in actors) {
      if (!Object.prototype.hasOwnProperty.call(actors, id)) continue;
      finishWalk(actors[id]); // resolves pending walks at their final pose
      paintActor(actors[id], 0);
    }
    suspendBobs();
    suspendWork(); // freeze chore frame-swaps + emitters; drop live particles
    stopHelperBob(); // helpers freeze in place; visibility is unchanged
    if (paperEl && !paperEl.hidden && paperX != null) paintPaperAt(paperX, 0);
  }

  function repaintAll() {
    for (const id in actors) {
      if (!Object.prototype.hasOwnProperty.call(actors, id)) continue;
      paintActor(actors[id], 0);
    }
    if (paperEl && !paperEl.hidden && paperX != null) paintPaperAt(paperX, 0);
    paintHelpers();
    const farm = farmEl();
    if (!farm) return;
    const bubble = farm.querySelector(".error-bubble");
    if (bubble && !bubble.hidden && bubbleX != null) placeOverlayAt(bubble, bubbleX);
    const sparkle = farm.querySelector(".done-sparkle");
    const homeX = anchorViewX(BOSS_HOME);
    if (sparkle && !sparkle.hidden && homeX != null) placeOverlayAt(sparkle, homeX);
  }

  // ---- choreographer: serialized action queue ----
  // Events may arrive faster than the animation plays: actions queue up and
  // intentionally drain a little behind real time; only when more than
  // CATCHUP_QUEUE_LEN are pending do unprotected durations compress (halved,
  // floored at CATCHUP_FLOOR_MS so walks remain visible steps).
  // Non-live (history replay) actions run with forceInstant so they apply
  // final poses immediately.

  const actionQueue = [];
  let queueRunning = false;

  function enqueueAction(live, fn) {
    actionQueue.push({ live: live, fn: fn });
    if (!queueRunning) drainQueue();
  }

  function drainQueue() {
    queueRunning = true;
    Promise.resolve(layoutSettled).then(step).catch(function () { queueRunning = false; });
    function step() {
      const item = actionQueue.shift();
      if (!item) {
        queueRunning = false;
        if (motionAllowed()) resumeBobs();
        return;
      }
      forceInstant = !item.live;
      let p;
      try { p = item.fn(); } catch (err) { p = null; }
      Promise.resolve(p)
        .catch(function () {})
        .then(function () {
          forceInstant = false;
          step();
        });
    }
  }

  function allWorkersHome() {
    const walks = [];
    for (const id in actors) {
      if (!Object.prototype.hasOwnProperty.call(actors, id)) continue;
      const actor = actors[id];
      if (actor === bossActor) continue;
      bobAt(actor, false);
      workAt(actor, false); // clear any lingering chore swap + emitter
      if (actor.homeX != null && Math.abs(actor.viewX - actor.homeX) > 0.5) {
        walks.push(
          walkTo(actor, actor.homeX, exitWalkMs(actor.viewX, actor.homeX))
            .then(function () { return sit(actor); })
        );
      } else {
        sit(actor);
      }
    }
    return Promise.all(walks);
  }

  // Idle pose contract: the boss always parks at the cabinet facing right
  // (into the house), exactly like the first paint — walkTo may have left
  // him flipped after a leftward walk home.
  function bossFaceHome() {
    if (!bossActor) return;
    bossActor.face = 1;
    paintActor(bossActor, 0);
  }

  // task.created: clear overlays, everyone to their seat, boss home with a
  // fresh paper in hand.
  async function choreoTaskCreated() {
    hideFailBubble();
    hideDoneSparkle();
    await allWorkersHome();
    if (!bossActor) return;
    const homeX = bossActor.homeX != null ? bossActor.homeX : anchorViewX(BOSS_HOME);
    if (homeX != null && Math.abs(bossActor.viewX - homeX) > 0.5) {
      // protected beat: the boss walk to collect the fresh paper keeps its
      // full duration so it never reads as a teleport at default speed
      await walkTo(bossActor, homeX, roomWalkMs(bossActor.viewX, homeX), true);
    }
    bossFaceHome();
    attachPaper(bossActor);
  }

  // zone.enter: boss carries the paper to the zone door, walks in to the
  // driver's desk, hands it over, the driver stands; boss steps back out to
  // Keep a stop position a clear step away from every other villager so the
  // boss never eclipses a seated worker (>=55px at 1440 ≈ 38 view units);
  // the handoff partner is exempt — the gap to them is HANDOFF_GAP by design.
  const WORKER_CLEAR = 38;

  function clearStop(x, partnerActor) {
    if (x == null) return x;
    let out = x;
    for (const id of Object.keys(actors)) {
      const other = actors[id];
      if (!other || other === bossActor || other === partnerActor || other.viewX == null) continue;
      if (Math.abs(out - other.viewX) < WORKER_CLEAR) {
        out = other.viewX + (out >= other.viewX ? WORKER_CLEAR : -WORKER_CLEAR);
      }
    }
    return out;
  }

  // the door (exit faster than entrance) and waits there.
  async function choreoZoneEnter(zoneId) {
    hideFailBubble();
    if (!bossActor) return;
    if (!bossActor.carrying) attachPaper(bossActor);
    const crew = zoneCrew(zoneId);
    const doorX = crew && crew.door != null ? crew.door : anchorViewX(zoneId);
    if (doorX != null) {
      // protected beat: the boss visibly carries the paper room-to-room —
      // same mechanism as the driver/tester carries in choreoTesterStart
      await walkTo(bossActor, doorX, roomWalkMs(bossActor.viewX, doorX), true);
    }
    if (!crew || !crew.driver || !crew.driver.actor) return;
    const driver = crew.driver;
    const deskX = driver.desk != null ? driver.desk : driver.seat;
    if (deskX != null) {
      // stop a step short of the desk (same HANDOFF_GAP as choreoCollect)
      // so the boss and the driver stand side by side for the handoff
      // instead of overlapping on the same spot
      const stopX = clearStop(
        bossActor.viewX >= deskX ? deskX + HANDOFF_GAP : deskX - HANDOFF_GAP,
        driver.actor
      );
      await walkTo(bossActor, stopX, inRoomWalkMs(bossActor.viewX, stopX));
    }
    await stand(driver.actor);
    await give(bossActor, driver.actor);
    if (doorX != null) {
      // wait spot also keeps clearance — door anchors can sit next to a wall
      // shared with a neighbouring room's chair
      const waitX = clearStop(doorX, null);
      await walkTo(bossActor, waitX, exitWalkMs(bossActor.viewX, waitX));
    }
  }

  // driver.start: the driver carries the paper to the desk and works (bob).
  async function choreoDriverStart(zoneId) {
    const crew = zoneCrew(zoneId);
    if (!crew || !crew.driver || !crew.driver.actor) return;
    const driver = crew.driver.actor;
    await stand(driver);
    const deskX = crew.driver.desk != null ? crew.driver.desk : crew.driver.seat;
    if (deskX != null) {
      await walkTo(driver, deskX, inRoomWalkMs(driver.viewX, deskX));
    }
    bobAt(driver, true);
    workAt(driver, true, choreFor(zoneId)); // chore frame-swap + particles
  }

  function choreoDriverDone(zoneId) {
    const crew = zoneCrew(zoneId);
    if (crew && crew.driver && crew.driver.actor) {
      bobAt(crew.driver.actor, false);
      workAt(crew.driver.actor, false); // stop the chore swap + emitter
    }
    return Promise.resolve();
  }

  // tester.start: the driver walks the paper across the room, hands it to
  // the standing tester, returns to their own seat and sits; the tester
  // takes it to the desk and checks (bob).
  async function choreoTesterStart(zoneId) {
    const crew = zoneCrew(zoneId);
    if (!crew) return;
    const driver = crew.driver && crew.driver.actor ? crew.driver.actor : null;
    const tester = crew.tester && crew.tester.actor ? crew.tester.actor : null;
    const testerDeskX = crew.tester
      ? (crew.tester.desk != null ? crew.tester.desk : crew.tester.seat)
      : null;
    if (driver) { bobAt(driver, false); workAt(driver, false); } // driver stops its chore
    if (driver && testerDeskX != null) {
      // protected beat: the driver visibly carries the paper across the room
      await walkTo(driver, testerDeskX, inRoomWalkMs(driver.viewX, testerDeskX), true);
    }
    if (!tester) return;
    await stand(tester);
    await give(driver || bossActor, tester);
    if (driver && crew.driver && crew.driver.seat != null) {
      await walkTo(driver, crew.driver.seat, exitWalkMs(driver.viewX, crew.driver.seat));
      await sit(driver);
    }
    if (testerDeskX != null) {
      // protected beat: the tester carries the paper to their own desk
      await walkTo(tester, testerDeskX, inRoomWalkMs(tester.viewX, testerDeskX), true);
    }
    bobAt(tester, true);
    workAt(tester, true, choreFor(zoneId)); // tester does the same chore (QA check)
  }

  // Shared collect beat (tester.ok and after the bounce bubble): the boss
  // walks in to the tester's desk, takes the paper back, the tester sits.
  async function choreoCollect(zoneId) {
    const crew = zoneCrew(zoneId);
    const tester = crew && crew.tester && crew.tester.actor ? crew.tester.actor : null;
    if (tester) { bobAt(tester, false); workAt(tester, false); } // stop the QA chore
    if (!bossActor) return;
    const meetX = crew && crew.tester
      ? (crew.tester.desk != null ? crew.tester.desk : crew.tester.seat)
      : anchorViewX(zoneId);
    if (meetX != null) {
      // stop a step short of the tester so the two stand side by side for
      // the handoff instead of overlapping on the same spot
      const stopX = tester == null
        ? meetX
        : clearStop(
            bossActor.viewX >= meetX ? meetX + HANDOFF_GAP : meetX - HANDOFF_GAP,
            tester
          );
      await walkTo(bossActor, stopX, inRoomWalkMs(bossActor.viewX, stopX));
    }
    await give(tester, bossActor);
    if (tester && crew && crew.tester && crew.tester.seat != null) {
      await walkTo(tester, crew.tester.seat, exitWalkMs(tester.viewX, crew.tester.seat));
      await sit(tester);
    }
  }

  // tester.bounce: static "!" bubble for a beat (the board card already
  // carries the message — nothing is announced here), then the same
  // collect-by-boss; the following zone.enter walks the boss back.
  async function choreoTesterBounce(zoneId) {
    const crew = zoneCrew(zoneId);
    if (crew && crew.driver && crew.driver.actor) {
      bobAt(crew.driver.actor, false); workAt(crew.driver.actor, false);
    }
    if (crew && crew.tester && crew.tester.actor) {
      bobAt(crew.tester.actor, false); workAt(crew.tester.actor, false);
    }
    showFailBubble(zoneId);
    await wait(BOUNCE_BUBBLE_MS);
    hideFailBubble();
    await choreoCollect(zoneId);
  }

  // task.done: boss carries the finished paper home, it fades out, a brief
  // sparkle plays over the cabinet, every worker sits back down.
  async function choreoTaskDone() {
    hideFailBubble();
    if (bossActor) {
      const homeX = bossActor.homeX != null ? bossActor.homeX : anchorViewX(BOSS_HOME);
      if (homeX != null) {
        await walkTo(bossActor, homeX, roomWalkMs(bossActor.viewX, homeX));
      }
      bossFaceHome();
    }
    await fadePaperOut();
    flashDoneSparkle();
    await allWorkersHome();
  }

  // task.failed: the "!" bubble stays over the failing room; the boss walks
  // home empty-handed and the workers settle back into their seats.
  async function choreoTaskFailed(zoneId) {
    if (zoneId) showFailBubble(zoneId); // stays until the next task
    await fadePaperOut();
    if (bossActor) {
      const homeX = bossActor.homeX != null ? bossActor.homeX : anchorViewX(BOSS_HOME);
      if (homeX != null) {
        await walkTo(bossActor, homeX, roomWalkMs(bossActor.viewX, homeX));
      }
      bossFaceHome();
    }
    await allWorkersHome();
  }

  // ---- «Анимация» pause toggle (#btn-anim) ----

  function readAnimPref() {
    try { return localStorage.getItem(ANIM_STORAGE_KEY) !== "0"; } catch (err) { return true; }
  }

  function writeAnimPref(on) {
    try { localStorage.setItem(ANIM_STORAGE_KEY, on ? "1" : "0"); } catch (err) { /* ignore */ }
  }

  function animButton() {
    let btn = document.getElementById("btn-anim");
    if (btn) return btn;
    // Defensive fallback: if the markup does not ship the toggle, create it
    // next to the sound toggle — animations auto-play longer than 5 s, so a
    // visible pause control must always exist (WCAG 2.2.2).
    const host = (els.btnSound && els.btnSound.parentNode) || document.querySelector(".controls");
    if (!host || !host.appendChild) return null;
    btn = document.createElement("button");
    btn.id = "btn-anim";
    btn.type = "button";
    btn.appendChild(document.createTextNode("Анимация"));
    if (els.btnSound && els.btnSound.nextSibling) {
      host.insertBefore(btn, els.btnSound.nextSibling);
    } else {
      host.appendChild(btn);
    }
    return btn;
  }

  function animIndicator(btn) {
    if (!btn) return null;
    let span = btn.querySelector(".anim-indicator");
    if (!span) {
      span = document.createElement("span");
      span.className = "anim-indicator";
      span.setAttribute("aria-hidden", "true");
      btn.appendChild(document.createTextNode(" "));
      btn.appendChild(span);
    }
    return span;
  }

  function setAnimEnabled(on, persist) {
    animEnabled = Boolean(on);
    const btn = document.getElementById("btn-anim");
    if (btn) {
      // One coherent toggle model: the button is "pressed/engaged" exactly
      // when animation is ON, which matches the «вкл» glyph and the full
      // accessible name. (Previously aria-pressed was read as inverted vs the
      // paused state.) Glyph + aria-pressed + aria-label now all agree.
      btn.setAttribute("aria-pressed", animEnabled ? "true" : "false");
      btn.setAttribute("aria-label", animEnabled ? "Анимация включена" : "Анимация выключена");
      const indicator = animIndicator(btn);
      if (indicator) indicator.textContent = animEnabled ? "вкл" : "выкл";
    }
    if (document.body) document.body.classList.toggle("anim-paused", !animEnabled);
    if (persist) writeAnimPref(animEnabled);
    if (!animEnabled) {
      flushAllMotion(); // freeze everything at final poses immediately
    } else {
      resumeBobs();
    }
  }

  // ---- event wiring (called right after handleEvent; never announces) ----

  function notifyCharacterEngine(ev) {
    // Pick up the zone-card/clothesline visual thunk handleEvent deferred
    // for this event. It is applied inside the SAME queued beat as the
    // matching choreo* step so badges never run ahead of the house; when no
    // beat is queued (farmhouse missing, no matching step) it applies right
    // here, i.e. on server event time. With motion off (reduced-motion or
    // anim-paused) queued beats collapse to instant final poses, so badges
    // return to server time automatically. Never announces anything.
    const visual = pendingVisual;
    pendingVisual = null;
    if (!ev || typeof ev.type !== "string" || !farmEl()) {
      if (visual) visual(); // no choreography layer: badges stay on server time
      return;
    }
    const live = isLive(ev);
    const zone = typeof ev.zone === "string" ? ev.zone : null;
    let queued = false;

    function act(fn) {
      queued = true;
      enqueueAction(live, function () {
        if (visual) visual(); // same beat as the matching choreo step
        return fn ? fn() : undefined;
      });
    }

    switch (ev.type) {
      case "task.created":
        act(choreoTaskCreated);
        break;
      case "zone.enter":
        if (zone) act(function () { return choreoZoneEnter(zone); });
        break;
      case "driver.start":
        if (zone) act(function () { return choreoDriverStart(zone); });
        break;
      case "driver.done":
        if (zone) act(function () { return choreoDriverDone(zone); });
        break;
      case "tester.start":
        if (zone) act(function () { return choreoTesterStart(zone); });
        break;
      case "tester.ok":
        if (zone) act(function () { return choreoCollect(zone); });
        break;
      case "tester.bounce":
        if (zone) act(function () { return choreoTesterBounce(zone); });
        break;
      case "task.done":
        act(choreoTaskDone);
        break;
      case "task.failed":
        act(function () { return choreoTaskFailed(zone); });
        break;
      default:
        break;
    }
    if (!queued && visual) visual(); // no matching beat: apply on server time
  }

  function initCharacterEngine() {
    // Visible «Анимация» pause toggle, persisted; OFF state = body.anim-paused.
    const btn = animButton();
    setAnimEnabled(readAnimPref(), false);
    if (btn) {
      btn.addEventListener("click", function () {
        setAnimEnabled(!animEnabled, true);
      });
    }

    // Window resize -> recompute every actor/paper/overlay position, no motion.
    window.addEventListener("resize", function () {
      if (actorResizeTimer) clearTimeout(actorResizeTimer);
      actorResizeTimer = setTimeout(repaintAll, 150);
    });

    // prefers-reduced-motion may change at runtime (OS setting).
    if (typeof reducedMotionQuery.addEventListener === "function") {
      reducedMotionQuery.addEventListener("change", function () {
        if (reducedMotion()) flushAllMotion();
        else resumeBobs();
      });
    }

    if (!farmEl()) return; // no map: decorative layer stays off entirely

    layoutSettled = fetch("assets/layout.json")
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        charLayout = normalizeLayout(data);
        if (!charLayout) return;
        buildActors();
        requestAnimationFrame(repaintAll);
      })
      .catch(function () {
        charLayout = null; // decorative layer stays parked; dashboard unaffected
      });
  }

  // ------------------------------------------------------------------ init

  function init() {
    resetZones();
    ensureStages();
    setSound(readSoundPref(), false);
    applyAnimDuration();
    if (typeof reducedMotionQuery.addEventListener === "function") {
      reducedMotionQuery.addEventListener("change", applyAnimDuration);
    }
    initViewSwitcher();
    initTaskForm();
    initEngineUi();
    // Park the token in the first zone once layout is ready.
    requestAnimationFrame(function () {
      moveToken(ZONES[0].id, true);
    });
    initCharacterEngine();
    connect();
    fetchBoard(); // first paint sets the diff baseline silently (restored tasks)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
