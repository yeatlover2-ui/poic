#!/usr/bin/env node
/*
 * GODSIM browser smoke test (Playwright + headless Chromium).
 *
 * Usage:
 *   node test/ui-smoke.js [--seed N] [--out DIR] [--years N]
 *
 * Env:
 *   PW_PATH     path to the playwright package (default: require('playwright') via NODE_PATH / global install)
 *   PW_CHROME   chromium executable (default: first /opt/pw-browsers/chromium-* /chrome-linux/chrome found,
 *               otherwise Playwright's own resolution)
 *
 * Loads file://<repo>/index.html at 1600x1000, waits for the world, runs at top speed for a few game years,
 * selects a country by clicking the map, rerolls the citizen card, cycles every map mode and overlay,
 * triggers the "Erase USA" scenario, runs on, and saves screenshots. Console errors and page errors are
 * collected; the exit code is 1 if any occurred.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var args = process.argv.slice(2), seed = 5, out = path.join(__dirname, '..', 'shots'), years = 3;
for (var i = 0; i < args.length; i++) {
  if (args[i] === '--seed') seed = +args[++i];
  else if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--years') years = +args[++i];
}
fs.mkdirSync(out, { recursive: true });

var pw;
try { pw = require(process.env.PW_PATH || 'playwright'); }
catch (e) { console.error('playwright not found; set PW_PATH to the playwright package directory'); process.exit(2); }

function findChrome() {
  if (process.env.PW_CHROME) return process.env.PW_CHROME;
  var base = '/opt/pw-browsers';
  try {
    var dirs = fs.readdirSync(base).filter(function (d) { return /^chromium-\d+$/.test(d); }).sort().reverse();
    for (var k = 0; k < dirs.length; k++) {
      var p = path.join(base, dirs[k], 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* fall through */ }
  return undefined;
}

(async function () {
  var errors = [];
  var browser = await pw.chromium.launch({ executablePath: findChrome() });
  var page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', function (e) { errors.push('pageerror: ' + e.message); });
  page.on('console', function (m) { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('dialog', function (d) { d.accept(); });
  var shotN = 0;
  async function shot(name) {
    var f = path.join(out, String(++shotN).padStart(2, '0') + '-' + name + '.png');
    await page.screenshot({ path: f });
    return f;
  }
  async function runTicks(n, timeoutMs) {
    var target = await page.evaluate(function (k) { return window.W.tick + k; }, n);
    await page.waitForFunction(function (t) { return window.W && window.W.tick >= t; }, target, { timeout: timeoutMs || 180000, polling: 250 });
  }
  function log(s) { console.log('[ui-smoke] ' + s); }

  var url = 'file://' + path.resolve(__dirname, '..', 'index.html') + '#seed=' + seed;
  var t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(function () {
    var l = document.getElementById('loading');
    return window.W && window.GS && (!l || l.classList.contains('hide') || l.hidden || getComputedStyle(l).display === 'none');
  }, null, { timeout: 90000 });
  log('world ready in ' + (Date.now() - t0) + 'ms');
  await page.waitForTimeout(600);
  await shot('start');

  // top speed, make sure it is running
  await page.keyboard.press('5');
  var st = await page.evaluate(function () { return GS.Main && GS.Main.state ? GS.Main.state() : null; });
  if (st && st.paused) await page.keyboard.press('Space');
  var tA = Date.now();
  await runTicks(52 * years);
  var simInfo = await page.evaluate(function () { return { tick: W.tick, perf: (document.getElementById('perf') || {}).textContent }; });
  log('ran to tick ' + simInfo.tick + ' in ' + (Date.now() - tA) + 'ms; perf label: ' + simInfo.perf);
  await shot('running');

  // pause for deterministic UI interaction
  await page.evaluate(function () { if (GS.Main && GS.Main.setPaused) GS.Main.setPaused(true); });

  // click a country (Germany if alive, else the most populous)
  var pt = await page.evaluate(function () {
    var c = GS.World.findByIso3(W, 'DEU');
    if (!c || !c.alive) c = W.countries.filter(function (x) { return x.alive; }).sort(function (a, b) { return b.pop - a.pop; })[0];
    var r = W.regions[c.capital];
    var s = GS.MapView.mapToScreen(r.cx, r.cy), rect = document.getElementById('map').getBoundingClientRect();
    return { x: rect.left + s[0], y: rect.top + s[1], name: c.name, id: c.id };
  });
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(500);
  var sel = await page.evaluate(function () { return W.selected; });
  log('clicked ' + pt.name + ' → selected id ' + sel + (sel === pt.id ? ' (ok)' : ' (MISMATCH)'));
  if (sel !== pt.id) errors.push('map click selected ' + sel + ' instead of ' + pt.id);
  await shot('selected');

  // citizen card: reroll a few times
  for (var k = 0; k < 3; k++) {
    var btn = await page.$('#citizen [data-act="another"]');
    if (btn) { await btn.click(); await page.waitForTimeout(200); }
    else { errors.push('citizen "another" button missing'); break; }
  }
  var cit = await page.evaluate(function () { var el = document.getElementById('citizen'); return el ? el.innerText.slice(0, 160).replace(/\s+/g, ' ') : ''; });
  log('citizen card: ' + cit);
  await page.evaluate(function () { var el = document.getElementById('citizen'); if (el) el.scrollIntoView(); });
  await shot('citizen');

  // every map mode
  var modes = await page.$$eval('[data-mode]', function (bs) { return bs.map(function (b) { return b.getAttribute('data-mode'); }); });
  for (var m = 0; m < modes.length; m++) {
    await page.click('[data-mode="' + modes[m] + '"]');
    await page.waitForTimeout(250);
    await shot('mode-' + modes[m]);
  }
  await page.click('[data-mode="political"]');
  // every overlay on (one at a time), then all together
  var ovs = await page.$$eval('[data-ov]', function (bs) { return bs.map(function (b) { return [b.getAttribute('data-ov'), b.classList.contains('on')]; }); });
  for (var o = 0; o < ovs.length; o++) {
    await page.click('[data-ov="' + ovs[o][0] + '"]');
    await page.waitForTimeout(250);
    await shot('overlay-' + ovs[o][0] + (ovs[o][1] ? '-off' : '-on'));
    await page.click('[data-ov="' + ovs[o][0] + '"]');
  }
  for (o = 0; o < ovs.length; o++) if (!ovs[o][1]) await page.click('[data-ov="' + ovs[o][0] + '"]');
  await page.waitForTimeout(300);
  await shot('overlays-all');
  for (o = 0; o < ovs.length; o++) if (!ovs[o][1]) await page.click('[data-ov="' + ovs[o][0] + '"]');

  // scenario: Erase USA, then keep running
  await page.click('[data-scn="eraseUSA"]');
  await page.waitForTimeout(400);
  var usa = await page.evaluate(function () { var c = GS.World.findByIso3(W, 'USA'); return c ? c.alive : null; });
  log('after Erase USA: USA alive=' + usa);
  if (usa !== false) errors.push('Erase USA did not erase the USA');
  await shot('erase-usa');
  await page.evaluate(function () { if (GS.Main && GS.Main.setPaused) GS.Main.setPaused(false); });
  await runTicks(104);
  await page.evaluate(function () { if (GS.Main && GS.Main.setPaused) GS.Main.setPaused(true); });
  await page.evaluate(function () { GS.UI.select(-1); });
  await page.waitForTimeout(400);
  await shot('after-erase-2y');
  // the power-vacuum views
  await page.click('[data-mode="spheres"]'); await page.waitForTimeout(1700); await shot('after-erase-spheres');
  await page.click('[data-mode="alliances"]'); await page.waitForTimeout(300); await shot('after-erase-blocs');
  await page.click('[data-mode="political"]');
  // a fallen nation in the inspector
  await page.evaluate(function () { var c = GS.World.findByIso3(W, 'USA'); if (c) GS.UI.select(c.id); });
  await page.waitForTimeout(400); await shot('inspector-fallen-usa');
  await page.evaluate(function () { GS.UI.select(-1); });
  // smaller screen
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.waitForTimeout(700); await shot('small-1200x800');
  await page.click('[data-ov="trade"]'); await page.waitForTimeout(300); await shot('small-trade-legend'); await page.click('[data-ov="trade"]');
  var fin = await page.evaluate(function () {
    return { tick: W.tick, date: GS.dateOf(W.tick).str, alive: W.countries.filter(function (c) { return c.alive; }).length, news: W.news.length, perf: (document.getElementById('perf') || {}).textContent };
  });
  log('final: ' + JSON.stringify(fin));

  await browser.close();
  log('screenshots: ' + shotN + ' in ' + out);
  if (errors.length) { console.log('[ui-smoke] ERRORS (' + errors.length + '):'); errors.slice(0, 40).forEach(function (e) { console.log('  - ' + e); }); process.exit(1); }
  console.log('[ui-smoke] OK — no console or page errors');
})().catch(function (e) { console.error('[ui-smoke] FAILED: ' + (e && e.stack || e)); process.exit(1); });
