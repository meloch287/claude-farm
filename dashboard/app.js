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
        resetZones();
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
        if (zone) setZoneState(zone, "working");
        break;
      }
      case "driver.done": {
        // Driver finished; the zone stays "working" until the tester takes over.
        break;
      }
      case "tester.start": {
        if (zone) setZoneState(zone, "testing");
        break;
      }
      case "tester.ok": {
        if (zone) setZoneState(zone, "done");
        break;
      }
      case "tester.bounce": {
        if (zone) setZoneState(zone, "error");
        bouncePending = true;
        if (live) playSound("error");
        break;
      }
      case "task.done": {
        taskRunning = false;
        bouncePending = false;
        for (const z of ZONES) setZoneState(z.id, "done");
        updateStages(ZONES.length);
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
        if (zone) setZoneState(zone, "error");
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
    connect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
