/*
 * Клауд Ферма — dashboard client (vanilla JS, no deps).
 *
 * Responsibilities:
 *  - EventSource("/events") with reconnect notes in the log and seq-based dedupe
 *  - state machine: event type -> zone data-state + token position + clothespin aria-current
 *  - coalesced role="status" announcer (queue, min 2s between flushes, assertive only on failure)
 *  - feed appender (append <li> only, cap 200 nodes, never re-render)
 *  - WebAudio square-wave bleeps gated by #btn-sound (aria-pressed, persisted, OFF by default);
 *    every sound is mirrored as text in the log
 *  - #speed select drives the CSS transition-duration variable
 *  - POST /api/demo with disabled-while-running button
 *  - never steals focus, defensive JSON.parse, honors prefers-reduced-motion
 *  - Actor engine + choreographer: decorative boss/worker sprites act out
 *    pipeline events over the farmhouse map — workers sit at their stations,
 *    stand up, and carry the single shared paper to each other; a serialized
 *    action queue consumes events (doors/seats/desks from assets/layout.json
 *    v2); «Анимация» pause toggle (#btn-anim, localStorage "farm.anim") and
 *    prefers-reduced-motion collapse all choreography to instant final
 *    poses; map elements stay aria-hidden and are never announced
 */
"use strict";

(function () {
  // ------------------------------------------------------------------ contract

  const ZONES = [
    { id: "kitchen", title: "Кухня — Сборка", accusative: "Сборку" },
    { id: "corridor", title: "Коридор — Обработка", accusative: "Обработку" },
    { id: "living", title: "Гостиная — QA", accusative: "QA" },
    { id: "bath", title: "Ванная — Релиз", accusative: "Релиз" },
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
  const FEED_CAP = 200;
  const STATUS_INTERVAL_MS = 2000;
  // History replay must not trigger announcements/sounds; only "fresh" events do.
  const LIVE_WINDOW_MS = 5000;

  // ------------------------------------------------------------------ dom refs

  const els = {
    map: document.getElementById("map"),
    token: document.getElementById("token"),
    stages: document.getElementById("stages"),
    feed: document.getElementById("feed"),
    status: document.getElementById("status"),
    btnDemo: document.getElementById("btn-demo"),
    btnSound: document.getElementById("btn-sound"),
    speed: document.getElementById("speed"),
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

  let speedMs = 600;

  function parseSpeedValue(raw) {
    const v = String(raw == null ? "" : raw).trim().toLowerCase();
    const named = {
      "медленно": 1200, "slow": 1200,
      "обычно": 600, "normal": 600, "medium": 600,
      "быстро": 250, "fast": 250,
    };
    if (Object.prototype.hasOwnProperty.call(named, v)) return named[v];
    const n = parseFloat(v);
    if (!isFinite(n) || n <= 0) return 600;
    // Plain multiplier (e.g. "0.5", "1", "2") vs explicit milliseconds (e.g. "600").
    return n >= 50 ? Math.round(n) : Math.round(600 / n);
  }

  function applySpeed() {
    if (els.speed) speedMs = parseSpeedValue(els.speed.value);
    const effective = reducedMotion() ? 0 : speedMs;
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
      applySpeed();
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

  // ------------------------------------------------------------------ feed (role="log")

  function logLine(text, type) {
    if (!els.feed) return;
    const scroller = els.feed.closest('[role="log"]');
    const nearBottom = scroller
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
      : false;
    const li = document.createElement("li");
    if (type) li.setAttribute("data-type", type);
    li.textContent = text;
    els.feed.appendChild(li);
    while (els.feed.children.length > FEED_CAP) {
      els.feed.removeChild(els.feed.firstChild);
    }
    // Keep the log pinned to the latest entry, but never fight a user
    // who scrolled up to read history (and never move focus).
    if (scroller && nearBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  function formatTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    if (isNaN(d.getTime())) return "";
    function pad(n) { return n < 10 ? "0" + n : String(n); }
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function zoneTitle(zoneId) {
    const zone = ZONES.find(function (z) { return z.id === zoneId; });
    return zone ? zone.title : zoneId;
  }

  function logEvent(ev) {
    const time = formatTime(ev.ts);
    const prefix = ev.zone ? "[" + zoneTitle(ev.zone) + "] " : "";
    const message = typeof ev.message === "string" ? ev.message : "";
    logLine((time ? time + " · " : "") + prefix + message, ev.type);
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
    logLine(sound.label, "sound"); // every sound also appears as text in the log
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
        logLine("Звук включён", "sound");
      } else {
        logLine("Звук выключен", "sound");
      }
    });
  }

  // ------------------------------------------------------------------ demo button

  let taskRunning = false;

  // aria-disabled keeps the button focusable: disabling the focused element
  // would drop focus to <body> (WCAG 2.4.3), and SSE-driven disabling must
  // never steal focus.
  function setDemoEnabled(enabled) {
    if (els.btnDemo) els.btnDemo.setAttribute("aria-disabled", enabled ? "false" : "true");
  }

  if (els.btnDemo) {
    els.btnDemo.addEventListener("click", function () {
      if (els.btnDemo.getAttribute("aria-disabled") === "true") return;
      setDemoEnabled(false);
      fetch("/api/demo", { method: "POST" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          logLine("Демо-задача запущена", "info");
        })
        .catch(function () {
          setDemoEnabled(true);
          logLine("Не удалось запустить демо-задачу", "error");
          announce("Не удалось запустить демо-задачу");
        });
    });
  }

  // ------------------------------------------------------------------ event state machine

  let bouncePending = false;

  // Zone-card data-state changes and clothesline pip updates are handed off
  // to notifyCharacterEngine, which applies them inside the SAME queued beat
  // as the matching choreo* step, so badges never run ahead of the house.
  // #status announcements, feed lines and sounds stay on server event time
  // (a11y requirement) — only this visual state lags with the animation.
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
    logEvent(ev);
    const live = isLive(ev);
    const zone = typeof ev.zone === "string" ? ev.zone : null;

    switch (ev.type) {
      case "task.created": {
        deferVisual(resetZones);
        taskRunning = true;
        bouncePending = false;
        setDemoEnabled(false);
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
            announce("Задача возвращена в " + (z ? z.accusative : zone));
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
        taskRunning = false;
        bouncePending = false;
        deferVisual(function () {
          for (const z of ZONES) setZoneState(z.id, "done");
          updateStages(ZONES.length);
        });
        setDemoEnabled(true);
        if (live) {
          announce(ev.message || "Задача готова, клиенту можно отправлять!");
          playSound("victory");
        }
        break;
      }
      case "task.failed": {
        taskRunning = false;
        bouncePending = false;
        if (zone) deferVisual(function () { setZoneState(zone, "error"); });
        setDemoEnabled(true);
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
      logLine("Лента событий недоступна", "error");
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
    };

    source.onopen = function () {
      if (connectionLost) {
        connectionLost = false;
        logLine("Связь с фермой восстановлена", "info");
      }
    };

    source.onerror = function () {
      // EventSource reconnects on its own; note it once per outage.
      if (!connectionLost) {
        connectionLost = true;
        logLine("Связь с фермой потеряна, переподключаемся…", "error");
      }
    };
  }

  // ------------------------------------------------------------------ actor engine + choreographer
  //
  // Decorative actor layer over the farmhouse map: the boss + 8 workers act
  // out pipeline events (sit at desks, stand up, carry the shared paper to
  // each other) via a serialized action queue. Purely visual: every element
  // it touches is aria-hidden and NOTHING in this section ever calls
  // announce()/announceFailure()/logLine() — map motion is never announced
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
    return { a: a, b: b, sit: sit || a };
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
      if (actors[id].bobbing) bobAt(actors[id], true);
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

  // ---- global flush (pause toggle / reduced-motion change) ----

  function flushAllMotion() {
    for (const id in actors) {
      if (!Object.prototype.hasOwnProperty.call(actors, id)) continue;
      finishWalk(actors[id]); // resolves pending walks at their final pose
      paintActor(actors[id], 0);
    }
    suspendBobs();
    if (paperEl && !paperEl.hidden && paperX != null) paintPaperAt(paperX, 0);
  }

  function repaintAll() {
    for (const id in actors) {
      if (!Object.prototype.hasOwnProperty.call(actors, id)) continue;
      paintActor(actors[id], 0);
    }
    if (paperEl && !paperEl.hidden && paperX != null) paintPaperAt(paperX, 0);
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
  }

  function choreoDriverDone(zoneId) {
    const crew = zoneCrew(zoneId);
    if (crew && crew.driver && crew.driver.actor) bobAt(crew.driver.actor, false);
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
    if (driver) bobAt(driver, false);
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
  }

  // Shared collect beat (tester.ok and after the bounce bubble): the boss
  // walks in to the tester's desk, takes the paper back, the tester sits.
  async function choreoCollect(zoneId) {
    const crew = zoneCrew(zoneId);
    const tester = crew && crew.tester && crew.tester.actor ? crew.tester.actor : null;
    if (tester) bobAt(tester, false);
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

  // tester.bounce: static "!" bubble for a beat (the feed already carries
  // the message — nothing is announced), then the same collect-by-boss; the
  // following zone.enter walks the boss back to the previous room.
  async function choreoTesterBounce(zoneId) {
    const crew = zoneCrew(zoneId);
    if (crew && crew.driver && crew.driver.actor) bobAt(crew.driver.actor, false);
    if (crew && crew.tester && crew.tester.actor) bobAt(crew.tester.actor, false);
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
      btn.setAttribute("aria-pressed", animEnabled ? "true" : "false");
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
    applySpeed();
    if (els.speed) els.speed.addEventListener("change", applySpeed);
    if (typeof reducedMotionQuery.addEventListener === "function") {
      reducedMotionQuery.addEventListener("change", applySpeed);
    }
    // Park the token in the first zone once layout is ready.
    requestAnimationFrame(function () {
      moveToken(ZONES[0].id, true);
    });
    initCharacterEngine();
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
