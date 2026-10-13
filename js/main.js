/* GODSIM main.js — bootstrap & game loop (DOM). Defines GS.Main.
 * Creates the world behind a loading overlay, runs the simulation at the chosen speed via requestAnimationFrame,
 * renders the map every frame and refreshes panels ~4 Hz. Simulation errors pause the game and surface as a toast. */
(function () {
  'use strict';
  var GS = globalThis.GS = globalThis.GS || {};
  var M = Math;

  // weeks (ticks) per second for speeds 1..4; speed 5 = as many ticks as fit in the frame budget
  //   1: a day every ~0.3 s (a year ≈ 2 min)   2: a year ≈ 35 s   3: a year ≈ 13 s   4: a year ≈ 4 s
  var RATES = [0, 0.5, 1.5, 4, 12];
  var MAX_BUDGET_MS = 25, FAST_BUDGET_MS = 36; // 'as fast as possible' still leaves the frame time to the map and UI

  var S = {
    W: null, paused: false, speed: 1, acc: 0, lastFrame: 0, lastPanel: 0, raf: 0,
    tickMs: 0, tps: 0, tpsCount: 0, tpsT: 0, busy: false, failed: false, seed: 0
  };

  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function ui(name) { var f = GS.UI && GS.UI[name]; return typeof f === 'function' ? f : function () {}; }

  function seedFromUrl() {
    try {
      var m = /[#&?]seed=(\d+)/.exec(location.hash + '&' + location.search);
      if (m) return (+m[1]) >>> 0;
    } catch (e) { /* ignore */ }
    return null;
  }
  function randomSeed() { return ((Date.now() ^ M.floor(M.random() * 0x7fffffff)) >>> 0) % 1000000000; }

  function createWorld(seed) {
    S.busy = true;
    S.seed = seed;
    ui('loading')(true, 'Creating the world…  (seed ' + seed + ')');
    // defer so the overlay paints before the heavy synchronous build
    setTimeout(function () {
      var t0 = now(), W = null;
      try {
        if (!GS.World || typeof GS.World.create !== 'function') throw new Error('GS.World.create is missing (js/world.js failed to load?)');
        W = GS.World.create(seed);
      } catch (e) {
        console.error(e);
        ui('loading')(true, 'The world could not be created:\n\n' + (e && e.stack ? e.stack : e), true);
        S.busy = false; S.failed = true;
        return;
      }
      S.W = W; globalThis.W = W;
      if (typeof window !== 'undefined') window.W = W;
      W.speed = S.speed;
      try { ui('setWorld')(W); } catch (e2) { console.error(e2); ui('toast')('UI failed to bind the world: ' + e2.message, 'error'); }
      S.acc = 0; S.failed = false; S.busy = false;
      try { history.replaceState(null, '', '#seed=' + seed); } catch (e3) { /* file:// may refuse */ }
      console.log('[GODSIM] world created in ' + M.round(now() - t0) + ' ms, seed ' + seed + ' — inspect via window.W');
      ui('loading')(false);
      ui('setPlayState')(S.paused, S.speed);
    }, 40);
  }

  function step1() {
    var W = S.W; if (!W) return false;
    var t0 = now();
    try {
      GS.World.step(W);
    } catch (e) {
      console.error('[GODSIM] simulation error at tick ' + W.tick, e);
      S.paused = true;
      ui('setPlayState')(true, S.speed);
      ui('toast')('Simulation error at week ' + W.tick + ' (paused):\n' + (e && e.message ? e.message : e) +
        (e && e.stack ? '\n' + String(e.stack).split('\n').slice(1, 3).join('\n') : ''), 'error', 12000);
      return false;
    }
    var dt = now() - t0;
    S.tickMs = S.tickMs ? S.tickMs * 0.9 + dt * 0.1 : dt;
    S.tpsCount++;
    return true;
  }

  function frame() {
    S.raf = requestAnimationFrame(frame);
    var t = now(), dt = S.lastFrame ? M.min(250, t - S.lastFrame) : 16;
    S.lastFrame = t;
    var W = S.W;
    if (W && !S.paused && !S.busy) {
      var start = now();
      if (S.speed >= 5) {
        // check the budget BEFORE the next step (using the measured tick cost) so frames don't overshoot
        do { if (!step1()) break; } while (now() - start + (S.tickMs || 5) < FAST_BUDGET_MS && !S.paused);
      } else {
        S.acc += dt / 1000 * RATES[S.speed];
        var n = M.floor(S.acc);
        if (n > 0) {
          S.acc -= n;
          for (var i = 0; i < n; i++) {
            if (!step1()) break;
            if (now() - start > MAX_BUDGET_MS) { S.acc = 0; break; }
          }
        }
      }
    }
    // fraction of the current week already elapsed, so the calendar advances day by day between ticks
    if (W) W.subTick = (!S.paused && S.speed < 5) ? M.max(0, M.min(0.999, S.acc)) : 0;
    if (W) {
      try { if (GS.MapView) GS.MapView.render(W, t); } catch (e) { reportOnce('map', e); }
      if (t - S.lastPanel > 250) {
        S.lastPanel = t;
        try { ui('update')(W); } catch (e2) { reportOnce('ui', e2); }
      }
      if (t - S.tpsT > 1000) {
        S.tps = S.tpsCount * 1000 / (t - S.tpsT || 1000); S.tpsCount = 0; S.tpsT = t;
        ui('setPerf')(S.tickMs.toFixed(1) + ' ms/tick · ' + S.tps.toFixed(S.tps < 10 ? 1 : 0) + ' wk/s');
      }
    }
  }
  var reported = {};
  function reportOnce(k, e) {
    var key = k + ':' + (e && e.message);
    if (reported[key]) return; reported[key] = 1;
    console.error('[GODSIM ' + k + ']', e);
    ui('toast')(k + ' error: ' + (e && e.message ? e.message : e), 'error', 8000);
  }

  function setSpeed(n) {
    n = M.max(1, M.min(5, n | 0));
    S.speed = n; S.paused = false; S.acc = 0;
    if (S.W) S.W.speed = n;
    ui('setPlayState')(S.paused, S.speed);
  }
  function togglePause() {
    S.paused = !S.paused; S.acc = 0;
    ui('setPlayState')(S.paused, S.speed);
  }
  function setPaused(p) { S.paused = !!p; S.acc = 0; ui('setPlayState')(S.paused, S.speed); }
  function restart(seed) {
    if (S.busy) return;
    var sd = (typeof seed === 'number' && isFinite(seed)) ? (seed >>> 0) : randomSeed();
    S.W = null;
    createWorld(sd);
  }

  function boot() {
    try { ui('init')(); } catch (e) { console.error(e); }
    ui('setPlayState')(S.paused, S.speed);
    var sd = seedFromUrl();
    createWorld(sd !== null ? sd : randomSeed());
    S.raf = requestAnimationFrame(frame);
  }

  GS.Main = {
    setSpeed: setSpeed,
    togglePause: togglePause,
    setPaused: setPaused,
    restart: restart,
    step: function (n) { for (var i = 0; i < (n || 1); i++) if (!step1()) break; },
    getWorld: function () { return S.W; },
    state: function () { return { paused: S.paused, speed: S.speed, seed: S.seed, tickMs: S.tickMs, tps: S.tps }; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
