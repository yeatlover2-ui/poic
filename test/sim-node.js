#!/usr/bin/env node
/*
 * GODSIM headless simulation test (no npm packages needed).
 *
 * Usage:
 *   node test/sim-node.js [seed] [--years N] [--scenario NAME] [--at YEAR] [--quiet] [--json] [--isolated]
 *
 *   seed          world seed (number or string, default 1)
 *   --years N     simulated years to run (default 20; 52 weekly ticks per year)
 *   --scenario S  one of GS.World.scenarios: eraseUSA, eraseChina, collapseRussia, globalPlague
 *   --at Y        apply the scenario at the start of simulated year Y (1-based, default 1 = after the first
 *                 few weeks, so the shock hits a running economy rather than the starting calibration)
 *   --chaos       stress mode: every year apply a random god power (erase, collapse, plague, meteor, nuke,
 *                 forced war, market crash, revolution) to random targets, and check invariants throughout
 *   --quiet       print only the final summary and assertion results
 *   --json        print one JSON object (yearly rows + summary) instead of the table
 *   --isolated    load the sim into a fresh vm context (slower global lookups) instead of this context
 *
 * Examples:
 *   node test/sim-node.js 1 --years 30
 *   node test/sim-node.js 2 --years 15 --scenario eraseUSA
 *   node test/sim-node.js 7 --years 10 --scenario globalPlague --at 3 --json > out.json
 *
 * The script loads data/world-topo.js and the simulation files (core, data, people, economy, politics,
 * diplomacy, war, world) with Node's `vm` module so they share one globalThis, exactly as the browser's
 * classic <script> tags do. It then checks: no exceptions, no NaN/Infinity in any numeric country field
 * (including nested objects) or in W.global, agent count stays within a sane band, and reports ms/tick.
 * Exit code is 0 when every assertion passes, 1 otherwise.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

// ------------------------------------------------------------------ args
var argv = process.argv.slice(2), opt = { seed: 1, years: 20, scenario: null, at: 1, quiet: false, json: false, isolated: false, chaos: false };
for (var ai = 0; ai < argv.length; ai++) {
  var a = argv[ai];
  if (a === '--years') opt.years = +argv[++ai];
  else if (a === '--scenario') opt.scenario = argv[++ai];
  else if (a === '--at') opt.at = +argv[++ai];
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--isolated') opt.isolated = true;
  else if (a === '--chaos') opt.chaos = true;
  else if (a === '--seed') opt.seed = argv[++ai];
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
  else if (a.charAt(0) !== '-') opt.seed = a;
  else { console.error('unknown option ' + a); process.exit(2); }
}
if (!(opt.years > 0)) opt.years = 20;
if (!(opt.at >= 1)) opt.at = 1;
if (typeof opt.seed === 'string' && opt.seed !== '' && isFinite(+opt.seed)) opt.seed = +opt.seed;

// ------------------------------------------------------------------ load
var ROOT = path.join(__dirname, '..');
var FILES = ['data/world-topo.js', 'js/core.js', 'js/data.js', 'js/people.js', 'js/economy.js', 'js/politics.js',
  'js/diplomacy.js', 'js/war.js', 'js/world.js'];
var ctx = opt.isolated ? vm.createContext({ console: console }) : null;
FILES.forEach(function (f) {
  var src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (ctx) vm.runInContext(src, ctx, { filename: f });
  else vm.runInThisContext(src, { filename: f });
});
var G = ctx ? ctx : globalThis;
var GS = G.GS;
['RNG', 'U', 'Geo', 'Names', 'DATA', 'People', 'Economy', 'Politics', 'Diplo', 'War', 'World', 'God'].forEach(function (k) {
  if (!GS[k]) { console.error('missing GS.' + k); process.exit(1); }
});

// ------------------------------------------------------------------ helpers
var failures = [];
function fail(msg) { if (failures.length < 60) failures.push(msg); }
function fmtNum(n) { return GS.U.fmtNum(n); }
function fmtMoney(b) { return GS.U.fmtMoney(b); }
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s.length > n ? s.slice(0, n) : s; }
function lpad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
function bad(v) { return typeof v === 'number' && !isFinite(v); }

// scan an object (one level of nesting into plain objects/arrays/typed arrays) for NaN/Infinity
function scan(obj, where, depth, seen) {
  if (!obj || typeof obj !== 'object' || depth > 3) return;
  if (seen.has(obj)) return; seen.add(obj);
  if (ArrayBuffer.isView(obj)) {
    for (var i = 0; i < obj.length; i++) if (bad(obj[i])) { fail(where + '[' + i + '] = ' + obj[i]); return; }
    return;
  }
  var keys = Object.keys(obj);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k], v = obj[key];
    if (key === 'hist' || key === 'data' || key.charAt(0) === '_') continue;
    if (bad(v)) fail(where + '.' + key + ' = ' + v);
    else if (v && typeof v === 'object') scan(v, where + '.' + key, depth + 1, seen);
  }
}
function checkWorld(W, label) {
  var seen = new Set();
  scan(W.global, label + ' W.global', 0, seen);
  for (var i = 0; i < W.countries.length; i++) {
    var c = W.countries[i]; if (!c || !c.alive) continue;
    scan(c, label + ' ' + c.name, 0, seen);
  }
  var NC = W.NC, n = W.countries.length;
  for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
    var idx = a * NC + b;
    if (bad(W.rel[idx]) || bad(W.trade[idx]) || bad(W.dist[idx])) { fail(label + ' matrix NaN at ' + a + ',' + b); return; }
  }
  scan(W._eco ? { sw: W._eco.sw, lnFw: W._eco.lnFw, mom: W._eco.mom, worldInfl: W._eco.worldInfl } : null, label + ' W._eco', 0, seen);
  // structural invariants
  var cs = W.countries;
  function liveId(x) { return typeof x === 'number' && x >= 0 && cs[x] && cs[x].alive; }
  for (var ci = 0; ci < cs.length; ci++) {
    var cc = cs[ci]; if (!cc || !cc.alive) continue;
    if (!cc.regions || !cc.regions.length) { fail(label + ' ' + cc.name + ' alive with no regions'); return; }
    if (!(cc.capital >= 0) || !W.regions[cc.capital] || W.regions[cc.capital].owner !== cc.id) { fail(label + ' ' + cc.name + ' capital not owned'); return; }
    if (cc.gov !== 'anarchy' && !cc.leader) { fail(label + ' ' + cc.name + ' has no leader'); return; }
    if (cc.patron >= 0 && !liveId(cc.patron)) { fail(label + ' ' + cc.name + ' patron is dead'); return; }
    if (cc.overlord >= 0 && !liveId(cc.overlord)) { fail(label + ' ' + cc.name + ' overlord is dead'); return; }
    var dp = cc.defensePacts || [];
    for (var di = 0; di < dp.length; di++) if (!liveId(dp[di])) { fail(label + ' ' + cc.name + ' pact with dead country'); return; }
  }
  for (var ai2 = 0; ai2 < (W.alliances || []).length; ai2++) {
    var A = W.alliances[ai2]; if (!A || A.dissolved) continue;
    for (var mi = 0; mi < A.members.length; mi++) if (!liveId(A.members[mi])) { fail(label + ' alliance ' + A.name + ' has dead member'); return; }
  }
  for (var wi = 0; wi < W.wars.length; wi++) {
    var w = W.wars[wi]; if (!w || w.ended) continue;
    var side = w.attackers.concat(w.defenders);
    for (var si = 0; si < side.length; si++) if (!liveId(side[si])) { fail(label + ' war ' + w.name + ' has dead belligerent'); return; }
  }
  var P = W.people;
  for (var pi = 0; pi < P.n; pi += 7) {
    if (!P.alive[pi]) continue;
    var ro = W.regions[P.region[pi]] ? W.regions[P.region[pi]].owner : -1;
    if (ro >= 0 && !(cs[ro] && cs[ro].alive)) { fail(label + ' agent lives in region of dead country'); return; }
  }
  // region ownership consistency
  for (var r = 0; r < W.regions.length; r++) {
    var reg = W.regions[r], o = reg.owner;
    if (o >= 0) {
      var oc = W.countries[o];
      if (!oc || !oc.alive) { fail(label + ' region ' + reg.name + ' owned by dead/missing country ' + o); return; }
      if (oc.regions.indexOf(r) < 0) { fail(label + ' region ' + reg.name + ' not in owner.regions'); return; }
    }
    if (bad(reg.devastation)) fail(label + ' region devastation NaN ' + reg.name);
  }
}
function aliveAgents(W) {
  var P = W.people, n = 0;
  for (var i = 0; i < P.n; i++) if (P.alive[i]) n++;
  return n;
}
function activeWars(W) {
  var n = 0; for (var i = 0; i < W.wars.length; i++) if (W.wars[i] && !W.wars[i].ended) n++;
  return n;
}
function civilWars(W) {
  var n = 0; for (var i = 0; i < W.countries.length; i++) if (W.countries[i] && W.countries[i].alive && W.countries[i].civilWar) n++;
  return n;
}
function topPowers(W, k) {
  var arr = W.countries.filter(function (c) { return c && c.alive; });
  arr.sort(function (x, y) { return (y.power || 0) - (x.power || 0); });
  return arr.slice(0, k).map(function (c) { return c.iso3 || c.name.slice(0, 10); });
}

// ------------------------------------------------------------------ run
var t0 = Date.now();
var W;
try { W = GS.World.create(opt.seed); }
catch (e) { console.error('World.create threw: ' + (e && e.stack || e)); process.exit(1); }
var createMs = Date.now() - t0;
checkWorld(W, 'init');
var agents0 = aliveAgents(W);
var TPY = 52, totalTicks = Math.round(opt.years * TPY);
// year 1 = after 8 weeks: the shock lands on a running economy (markets, trade and demand already in motion)
var scenTick = Math.max(8, (opt.at - 1) * TPY), scenDone = !opt.scenario;
var base = null; // same-seed reference for shock assertions
if (opt.scenario === 'eraseUSA' || opt.scenario === 'eraseChina') {
  try {
    var WB = GS.World.create(opt.seed);
    for (var bt = 0; bt < scenTick + 13; bt++) GS.World.step(WB);
    base = { fear: WB.global.fear, market: WB.global.marketIndex, gdp: {} };
    WB.countries.forEach(function (c) { if (c && c.alive) base.gdp[c.iso3] = c.gdp; });
  } catch (e) { fail('baseline reference run threw: ' + (e && e.stack || e)); }
}
var shockCheck = null;
if (opt.scenario && !(GS.World.scenarios && typeof GS.World.scenarios[opt.scenario] === 'function')) {
  console.error('unknown scenario "' + opt.scenario + '"; available: ' + Object.keys(GS.World.scenarios || {}).join(', '));
  process.exit(2);
}

var rows = [], newsSeen = W.news.length ? W.news[W.news.length - 1].id : -1;
var lastGDP = W.global.worldGDP, maxTick = 0, tickMs = [], minAgents = agents0, maxAgents = agents0;
var crashed = null;

function yearRow() {
  var g = W.global, d = GS.dateOf(W.tick), alive = 0;
  for (var i = 0; i < W.countries.length; i++) if (W.countries[i] && W.countries[i].alive) alive++;
  var notable = [];
  for (var j = 0; j < W.news.length; j++) {
    var it = W.news[j];
    if (it.id > newsSeen && it.importance >= 4) notable.push(it.text);
  }
  if (W.news.length) newsSeen = W.news[W.news.length - 1].id;
  var gr = lastGDP > 0 ? g.worldGDP / lastGDP - 1 : 0;
  lastGDP = g.worldGDP;
  var ag = aliveAgents(W);
  return {
    tick: W.tick, date: d.str, pop: g.worldPop, gdp: g.worldGDP, growth: gr, growthSm: g.worldGrowth,
    market: g.marketIndex, oil: g.oilPrice, food: g.foodPrice, fear: g.fear, wars: activeWars(W), civilWars: civilWars(W), alive: alive,
    agents: ag, top: topPowers(W, 5), warDeaths: g.warDeaths, news: notable
  };
}

function printHeader() {
  console.log('GODSIM sim-node  seed=' + opt.seed + '  years=' + opt.years + (opt.scenario ? '  scenario=' + opt.scenario + '@y' + opt.at : '') +
    '  countries=' + W.countries.length + '  agents=' + agents0 + '  create=' + createMs + 'ms');
  console.log(pad('date', 9) + lpad('pop', 7) + lpad('GDP', 9) + lpad('gr%', 6) + lpad('mkt', 7) + lpad('oil', 5) + lpad('fear', 5) +
    lpad('wars', 5) + lpad('cw', 4) + lpad('wdead', 7) + lpad('ctry', 5) + lpad('agents', 7) + '  top-5 powers');
}
function printRow(r) {
  console.log(pad(r.date, 9) + lpad(fmtNum(r.pop), 7) + lpad(fmtMoney(r.gdp), 9) + lpad((r.growth * 100).toFixed(1), 6) +
    lpad(Math.round(r.market), 7) + lpad(Math.round(r.oil), 5) + lpad(r.fear.toFixed(2), 5) + lpad(r.wars, 5) +
    lpad(r.civilWars, 4) + lpad(fmtNum(r.warDeaths), 7) + lpad(r.alive, 5) + lpad(r.agents, 7) + '  ' + r.top.join(' '));
  for (var i = 0; i < r.news.length && i < 8; i++) console.log('    * ' + r.news[i]);
  if (r.news.length > 8) console.log('    * (+' + (r.news.length - 8) + ' more)');
}

function chaos(W) {
  var rng = W.rng, cs = W.countries, live = cs.filter(function (c) { return c && c.alive; }), God = GS.God;
  function pick() { return live[(rng.next() * live.length) | 0]; }
  function anyRegion() { return (rng.next() * W.regions.length) | 0; }
  var k = (rng.next() * 9) | 0, a = pick(), b = pick();
  switch (k) {
    case 0: if (live.length > 40) God.erase(W, a); break;
    case 1: God.collapse(W, a); break;
    case 2: God.plague(W, anyRegion(), rng.next()); break;
    case 3: God.meteor(W, anyRegion()); break;
    case 4: if (GS.War && GS.War.nuke) GS.War.nuke(W, a.id, anyRegion()); break;
    case 5: God.forceWar(W, a, b); break;
    case 6: God.marketCrash(W); break;
    case 7: God.revolution(W, a); break;
    default: God.assassinate(W, a); God.erase(W, cs.filter(function (c) { return c && !c.alive; })[0] || a.id + 99999);
  }
}

if (!opt.quiet && !opt.json) printHeader();
var scenarioResult = null;
var tStart = Date.now();
for (var t = 0; t < totalTicks; t++) {
  if (!scenDone && W.tick >= scenTick) {
    try { scenarioResult = GS.World.scenarios[opt.scenario](W); }
    catch (e) { crashed = 'scenario ' + opt.scenario + ' threw: ' + (e && e.stack || e); break; }
    scenDone = true;
    shockCheck = { at: W.tick, maxFear: W.global.fear };
  }
  if (shockCheck && W.tick - shockCheck.at <= 13) shockCheck.maxFear = Math.max(shockCheck.maxFear, W.global.fear);
  if (shockCheck && base && W.tick - shockCheck.at === 13) {
    // a vanished superpower must shake the world: fear, markets and its trade partners
    var partner = opt.scenario === 'eraseUSA' ? 'CAN' : 'MNG', pc = W.countries.filter(function (c) { return c && c.alive && c.iso3 === partner; })[0];
    shockCheck.fear = shockCheck.maxFear; shockCheck.market = W.global.marketIndex / base.market;
    shockCheck.partner = pc && base.gdp[partner] ? pc.gdp / base.gdp[partner] : null;
    if (!(shockCheck.maxFear > 0.5)) fail(opt.scenario + ': fear peaked at ' + shockCheck.maxFear.toFixed(2) + ' (expected > 0.5)');
    if (shockCheck.partner !== null && !(shockCheck.partner < 0.9)) fail(opt.scenario + ': ' + partner + ' GDP ' + shockCheck.partner.toFixed(2) + 'x baseline after 13 weeks (expected < 0.9)');
  }
  if (opt.chaos && W.tick > 0 && W.tick % 52 === 20) {
    try { chaos(W); } catch (e) { crashed = 'chaos at tick ' + W.tick + ' threw: ' + (e && e.stack || e); break; }
  }
  var s = process.hrtime.bigint();
  try { GS.World.step(W); }
  catch (e) { crashed = 'tick ' + W.tick + ' (' + GS.dateOf(W.tick).full + ') threw: ' + (e && e.stack || e); break; }
  var ms = Number(process.hrtime.bigint() - s) / 1e6;
  tickMs.push(ms); if (ms > maxTick) maxTick = ms;
  if ((W.tick & 3) === 0) {
    var ag = aliveAgents(W);
    if (ag < minAgents) minAgents = ag; if (ag > maxAgents) maxAgents = ag;
  }
  if (W.tick % 13 === 0) checkWorld(W, GS.dateOf(W.tick).full);
  if (W.tick % TPY === 0) {
    var row = yearRow(); rows.push(row);
    if (!opt.quiet && !opt.json) printRow(row);
  }
  if (failures.length > 20) break;
}
var wallMs = Date.now() - tStart;
checkWorld(W, 'final');

// ------------------------------------------------------------------ summary
tickMs.sort(function (x, y) { return x - y; });
var avg = tickMs.length ? tickMs.reduce(function (s, v) { return s + v; }, 0) / tickMs.length : 0;
var p50 = tickMs.length ? tickMs[Math.floor(tickMs.length * 0.5)] : 0, p95 = tickMs.length ? tickMs[Math.floor(tickMs.length * 0.95)] : 0;
var agentsEnd = aliveAgents(W);
if (crashed) fail(crashed);
if (minAgents < agents0 * 0.5 && opt.scenario !== 'globalPlague') fail('agents fell from ' + agents0 + ' to ' + minAgents);
if (maxAgents > agents0 * 1.6) fail('agents grew from ' + agents0 + ' to ' + maxAgents);
if (W.people.n > W.people.cap) fail('P.n > P.cap');

var summary = {
  seed: opt.seed, years: opt.years, scenario: opt.scenario, scenarioResult: scenarioResult == null ? null : !!scenarioResult,
  ticks: tickMs.length, createMs: createMs, wallMs: wallMs, msPerTick: +avg.toFixed(2), p50: +p50.toFixed(2), p95: +p95.toFixed(2),
  maxTick: +maxTick.toFixed(1), agentsStart: agents0, agentsEnd: agentsEnd, agentsMin: minAgents, agentsMax: maxAgents,
  countriesAlive: W.countries.filter(function (c) { return c.alive; }).length, countriesTotal: W.countries.length,
  wars: W.wars.length, warDeaths: W.global.warDeaths, alliances: W.alliances.filter(function (x) { return x && !x.dissolved; }).length,
  shock: shockCheck,
  ok: failures.length === 0, failures: failures
};

if (opt.json) {
  console.log(JSON.stringify({ rows: rows, summary: summary }, null, 1));
} else {
  console.log('---');
  console.log('ticks=' + summary.ticks + ' ms/tick avg=' + summary.msPerTick + ' p50=' + summary.p50 + ' p95=' + summary.p95 + ' max=' + summary.maxTick +
    '  create=' + createMs + 'ms  wall=' + wallMs + 'ms');
  console.log('agents start=' + agents0 + ' end=' + agentsEnd + ' min=' + minAgents + ' max=' + maxAgents +
    '  countries alive=' + summary.countriesAlive + '/' + summary.countriesTotal + '  wars total=' + summary.wars +
    '  war deaths=' + fmtNum(W.global.warDeaths) + '  live alliances=' + summary.alliances);
  if (shockCheck && shockCheck.fear !== undefined) console.log('shock check (13 weeks): peak fear=' + shockCheck.fear.toFixed(2) + '  market=' +
    shockCheck.market.toFixed(2) + 'x baseline' + (shockCheck.partner !== null ? '  partner GDP=' + shockCheck.partner.toFixed(2) + 'x baseline' : ''));
  if (opt.quiet && rows.length) printRow(rows[rows.length - 1]);
  if (failures.length) { console.log('FAIL (' + failures.length + '):'); failures.forEach(function (f) { console.log('  - ' + f); }); }
  else console.log('OK');
}
process.exit(failures.length ? 1 : 0);
