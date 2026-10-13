/* GODSIM — js/people.js
 * GS.People: structure-of-arrays agent store and per-agent behaviour.
 * Classic script, no DOM. Other modules are referenced only at call time.
 * Every behaviour here is a generic rule applied to every agent / country.
 */
var GS = globalThis.GS = globalThis.GS || {};
(function () {
  'use strict';

  // ---- constants (mirror GS.CONST.JOBS; fixed by SPEC) ----
  var CHILD = 0, UNEMP = 1, FARM = 2, IND = 3, SERV = 4, GOVJ = 5, MIL = 6, RET = 7, REBEL = 8;
  var F_PROTEST = 1, F_REFUGEE = 2, F_FRONT = 4, F_MIGRANT = 8;
  var AGE_BINS = 112, MAXCAND = 14, LOG_CAP = 14;
  var DT_Y = 4 / 52; // agents are updated every 4th tick (staggered): elapsed years per update
  var LOG10E = Math.LOG10E;
  var EMPTY = {};
  var SECT_MULT = [0, 0, 0.55, 1.05, 1.1, 1.0, 0.9, 0, 0];
  var GOV_FREEDOM = {
    democracy: 0.9, flawed_democracy: 0.75, hybrid: 0.5, autocracy: 0.25, oneparty: 0.15,
    theocracy: 0.2, monarchy: 0.3, junta: 0.15, anarchy: 0.45
  };

  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function num(v, d) { return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : d; }
  function idOf(v) {
    if (typeof v === 'number') return v | 0;
    if (v && typeof v.id === 'number') return v.id | 0;
    return -1;
  }
  function article(s) { return /^[aeiou]/i.test(s) ? 'an ' + s : 'a ' + s; }

  // ------------------------------------------------------------------
  // Store allocation
  // ------------------------------------------------------------------
  var AF = [
    ['alive', Uint8Array], ['region', Int16Array], ['origin', Int16Array], ['age', Float32Array],
    ['sex', Uint8Array], ['weight', Float32Array], ['wealth', Float32Array], ['income', Float32Array],
    ['job', Uint8Array], ['skill', Float32Array], ['econ', Float32Array], ['auth', Float32Array],
    ['nat', Float32Array], ['approval', Float32Array], ['happy', Float32Array], ['radical', Float32Array],
    ['health', Float32Array], ['infect', Uint8Array], ['flags', Uint8Array], ['x', Float32Array],
    ['y', Float32Array], ['first', Uint16Array], ['last', Uint16Array], ['born', Int32Array],
    ['expect', Float32Array], ['cc', Int16Array], ['lastJob', Uint8Array],
    // scratch / lists sized by agent capacity
    ['cList', Int32Array], ['rList', Int32Array], ['scratch', Int32Array], ['sortBuf', Float64Array]
  ];

  function growAgents(P, newCap) {
    for (var k = 0; k < AF.length; k++) {
      var name = AF[k][0], T = AF[k][1], old = P[name], arr = new T(newCap);
      if (old) arr.set(old.length <= newCap ? old : old.subarray(0, newCap));
      P[name] = arr;
    }
    P.cap = newCap;
  }

  function makeStore(cap, W) {
    var P = {
      n: 0, cap: 0, free: [], log: new Map(), live: 0, target: 1,
      capC: 0, C: null, nR: 0,
      listsOk: false, infTotal: 0, sev: 0.5, avgW: 1, _mg: null, _mgTick: -999, _anyClosed: 0,
      uiRng: null,
      // declared up front so the store keeps one hidden class
      rOwner: null, rDev: null, rRebel: null, rInfW: null, rPopW: null, rCount: null, rStart: null,
      regionPop: null, regionAgents: null, _cCur: null, _rCur: null, _aggLive: 0, _aggTotW: 0, _slowDone: false
    };
    for (var k = 0; k < AF.length; k++) P[AF[k][0]] = null;
    growAgents(P, cap);
    if (GS.RNG) {
      try { P.uiRng = new GS.RNG(((num(W && W.seed, 1) | 0) ^ 0x5bd1e995) >>> 0); } catch (e) { P.uiRng = null; }
    }
    return P;
  }

  // per-country arrays (Float64), indexed by country id; grow with W.countries
  var CF = [
    'alive', 'dev', 'gdppc', 'lnG', 'wage', 'fHire', 'sSep', 'recruitP', 'dischargeP', 'atWar', 'rally',
    'cw', 'cwE', 'cwA', 'cwN', 'Le', 'La', 'Ln', 'econM', 'authM', 'natB', 'freedom', 'repr', 'famine',
    'dS', 'defTick', 'defShock', 'prevDef', 'unemp', 'protPrev', 'radPrev', 'infPrev', 'fertW',
    'retAge', 'workAge', 'benefit', 'pension', 'eros', 'cashEros', 'sub', 'hBase', 'normMult',
    'sw0', 'sw1', 'sw2', 'sw3', 'hapRef', 'rebelRoom', 'puppet', 'anarchy', 'crisis', 'stab', 'care', 'betaF', 'thin',
    'hapC', 'apprC', 'baseW', 'mortOk', 'candOk', 'candN',
    'tfr0', 'tdev0', 'open', 'sevC', 'sevT', 'closedT', 'beta', 'pdInf', 'closed', 'intake',
    // aggregates (persist between aggregate() calls; step reads previous values)
    'aW', 'aN', 'aAdW', 'aHap', 'aApp', 'aE', 'aA', 'aNt', 'aE2', 'aA2', 'aNt2', 'aRad', 'aProt',
    'aMilW', 'aMilApp', 'aUnemp', 'aLF', 'aFarm', 'aInd', 'aServ', 'aGov', 'aMil', 'aRebel', 'aInc',
    'aWlt', 'aInf', 'aMin', 'aMultW', 'aWorkW', 'aMilW2',
    // weekly counters (accumulate until published by aggregate)
    'cDeath', 'cBirth', 'cEmig', 'cImmig'
  ];
  // fast aggregates are recomputed every tick; slow ones (moods, ideology, wealth) every 4th tick
  var AGG_FAST = ['aW', 'aN', 'aUnemp', 'aLF', 'aFarm', 'aInd', 'aServ', 'aGov', 'aMil', 'aRebel',
    'aInf', 'aMin', 'aMultW', 'aWorkW'];
  var AGG_SLOW = ['aAdW', 'aHap', 'aApp', 'aE', 'aA', 'aNt', 'aE2', 'aA2', 'aNt2', 'aRad', 'aProt',
    'aMilApp', 'aMilW2', 'aInc', 'aWlt'];

  function ensureC(W, P) {
    var need = (W.countries ? W.countries.length : 0);
    if (P.C && P.capC >= need) return;
    var nc = need + 48;
    var old = P.C, C = {}, k, f, arr;
    for (k = 0; k < CF.length; k++) {
      f = CF[k]; arr = new Float64Array(nc);
      if (old && old[f]) arr.set(old[f]);
      C[f] = arr;
    }
    C.mort = new Float32Array(nc * AGE_BINS); if (old) C.mort.set(old.mort);
    C.stkRing = new Float64Array(nc * 4); if (old) C.stkRing.set(old.stkRing);
    C.cand = new Int32Array(nc * MAXCAND); if (old) C.cand.set(old.cand);
    C.candNb = new Uint8Array(nc * MAXCAND); if (old) C.candNb.set(old.candNb);
    C.lStart = new Int32Array(nc); if (old) C.lStart.set(old.lStart);
    C.lCount = new Int32Array(nc); if (old) C.lCount.set(old.lCount);
    P.C = C; P.capC = nc;
  }

  function ensureR(W, P) {
    var nR = W.regions ? W.regions.length : 0;
    if (P.rOwner && P.nR === nR) return;
    P.nR = nR;
    P.rOwner = new Int16Array(nR);
    P.rDev = new Float32Array(nR);
    P.rRebel = new Uint8Array(nR);
    P.rInfW = new Float64Array(nR);
    P.rPopW = new Float64Array(nR);
    P.rCount = new Int32Array(nR);
    P.rStart = new Int32Array(nR);
    P.regionPop = P.rPopW;     // public aliases (real people / agents per region, last aggregate)
    P.regionAgents = P.rCount;
    P.listsOk = false;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function ownerOf(W, r) {
    var reg = W.regions[r];
    return reg && typeof reg.owner === 'number' ? reg.owner : -1;
  }
  function countryOf(W, i) {
    var P = W.people;
    if (!P || i < 0 || i >= P.n) return -1;
    return ownerOf(W, P.region[i]);
  }
  function cultureOf(W, cid) {
    var c = W.countries[cid];
    return (c && (c.culture || (c.data && c.data.culture))) || 'anglo';
  }
  function cname(W, cid) {
    var c = W.countries[cid];
    return (c && c.name) || 'a foreign land';
  }
  function devOfCountry(c) {
    var d = c.data || EMPTY;
    var pop = num(c.pop, 0); if (!(pop > 0)) pop = num(c.pop0, num(d.pop, 1)) * 1e6;
    var gdp = num(c.gdp, 0); if (!(gdp > 0)) gdp = num(c.gdp0, num(d.gdp, 1));
    var gpc = num(c.gdpPerCap, 0); if (!(gpc > 0)) gpc = gdp * 1e9 / Math.max(1, pop);
    gpc = clamp(gpc, 150, 400000);
    return clamp((Math.log(gpc) * LOG10E - 2.85) / 2.0, 0, 1);
  }

  function placeAt(W, P, i, r) {
    var reg = W.regions[r];
    var x = reg ? num(reg.cx, 0) : 0, y = reg ? num(reg.cy, 0) : 0;
    var G = GS.Geo;
    if (reg && G && typeof G.randomPointInRegion === 'function') {
      var p = G.randomPointInRegion(reg, W.rng);
      if (p) {
        var px = p.x !== undefined ? p.x : p[0], py = p.y !== undefined ? p.y : p[1];
        if (typeof px === 'number' && isFinite(px) && typeof py === 'number' && isFinite(py)) { x = px; y = py; }
      }
    }
    P.x[i] = x; P.y[i] = y;
  }

  function drawName(W, P, i, cid, sex) {
    var N = GS.Names, cu = cultureOf(W, cid);
    if (N && typeof N.first === 'function' && typeof N.last === 'function') {
      P.first[i] = num(N.first(cu, sex, W.rng), 0) | 0;
      P.last[i] = num(N.last(cu, W.rng), 0) | 0;
    } else { P.first[i] = 0; P.last[i] = 0; }
  }

  function allocSlot(P, allowGrow) {
    var i;
    if (P.free.length) i = P.free.pop();
    else {
      if (P.n >= P.cap) {
        if (!allowGrow) return -1;
        growAgents(P, Math.ceil(P.cap * 1.5) + 64);
      }
      i = P.n++;
    }
    if (P.log.size) P.log.delete(i);
    P.live++;
    return i;
  }

  function logEvent(W, i, text) {
    var P = W && W.people;
    if (!P || i < 0 || i >= P.n || !text) return;
    var L = P.log.get(i);
    if (!L) {
      if (P.log.size >= P.cap) return; // cheap global cap
      L = []; P.log.set(i, L);
    }
    L.push({ tick: W.tick | 0, text: String(text) });
    if (L.length > LOG_CAP) L.shift();
  }

  function killOne(W, P, i, text, silent) {
    if (!P.alive[i]) return 0;
    var w = P.weight[i];
    if (!silent) {
      var o = ownerOf(W, P.region[i]);
      if (o >= 0 && o < P.capC) P.C.cDeath[o] += w;
      logEvent(W, i, text);
    }
    P.alive[i] = 0; P.flags[i] = 0; P.infect[i] = 0;
    P.free.push(i); P.live--;
    return w;
  }

  // ------------------------------------------------------------------
  // Per-region / per-country preparation (O(regions + countries + wars))
  // ------------------------------------------------------------------
  function prepRegions(W, P) {
    var regs = W.regions, nR = P.nR, cs = W.countries;
    var rOwner = P.rOwner, rDev = P.rDev, rRebel = P.rRebel;
    for (var r = 0; r < nR; r++) {
      var reg = regs[r];
      var o = reg && typeof reg.owner === 'number' ? reg.owner : -1;
      if (o >= 0) { var c = cs[o]; if (!c || !c.alive) o = -2; } // invalid owner: skip, do not kill
      rOwner[r] = o;
      rDev[r] = reg ? clamp(num(reg.devastation, 0), 0, 1) : 0;
      rRebel[r] = 0;
    }
  }

  function markSide(list, single, rally, val, nC) {
    var k, id;
    if (Array.isArray(list)) {
      for (k = 0; k < list.length; k++) {
        id = idOf(list[k]);
        if (id >= 0 && id < nC && rally[id] < val) rally[id] = val;
      }
    } else {
      id = idOf(single);
      if (id >= 0 && id < nC && rally[id] < val) rally[id] = val;
    }
  }

  function buildMort(C, id, dev) {
    var e = Math.pow(dev, 0.6);
    var A = Math.exp(Math.log(2e-4) + (Math.log(2.5e-5) - Math.log(2e-4)) * e);
    var B = 0.085 + 0.01 * dev;
    var inf = 0.055 + (0.003 - 0.055) * e, ch = 0.008 + (0.0002 - 0.008) * e, bg = 0.002 + (0.0004 - 0.002) * e;
    var base = id * AGE_BINS, mort = C.mort;
    for (var a = 0; a < AGE_BINS; a++) {
      var h = bg + A * Math.exp(B * (a + 0.5));
      if (a < 1) h += inf; else if (a < 5) h += ch;
      mort[base + a] = h > 2.5 ? 2.5 : h;
    }
  }

  var topB = new Int32Array(4), topV = new Float64Array(4);
  function candHas(cand, base, n, b) {
    for (var k = 0; k < n; k++) if (cand[base + k] === b) return true;
    return false;
  }
  function buildCand(W, P, id) {
    var C = P.C, cs = W.countries, c = cs[id], cand = C.cand, nb = C.candNb;
    var base = id * MAXCAND, n = 0, k, q, b;
    var regs = (c && c.regions) || [];
    for (k = 0; k < regs.length && n < 7; k++) {
      var reg = W.regions[regs[k]];
      var nbs = reg && reg.neighbors;
      if (!nbs) continue;
      for (q = 0; q < nbs.length && n < 7; q++) {
        b = ownerOf(W, nbs[q]);
        if (b < 0 || b === id || !cs[b] || !cs[b].alive) continue;
        if (candHas(cand, base, n, b)) continue;
        cand[base + n] = b; nb[base + n] = 1; n++;
      }
    }
    var NC = W.NC | 0, nC = cs.length;
    // top trade partners
    if (W.trade && NC > id) {
      for (k = 0; k < 4; k++) { topB[k] = -1; topV[k] = 0; }
      var row = id * NC;
      for (b = 0; b < nC && b < NC; b++) {
        if (b === id || !cs[b] || !cs[b].alive) continue;
        var v = num(W.trade[row + b], 0);
        if (v <= topV[3]) continue;
        var p = 3;
        while (p > 0 && topV[p - 1] < v) { topV[p] = topV[p - 1]; topB[p] = topB[p - 1]; p--; }
        topV[p] = v; topB[p] = b;
      }
      for (k = 0; k < 4 && n < MAXCAND; k++) {
        b = topB[k];
        if (b < 0 || candHas(cand, base, n, b)) continue;
        cand[base + n] = b; nb[base + n] = 0; n++;
      }
    }
    // isolated (islands, no trade yet): nearest countries by distance
    if (n < 3 && W.dist && NC > id) {
      for (k = 0; k < 4; k++) { topB[k] = -1; topV[k] = 1e12; }
      var row2 = id * NC;
      for (b = 0; b < nC && b < NC; b++) {
        if (b === id || !cs[b] || !cs[b].alive || !cs[b].regions || !cs[b].regions.length) continue;
        var dv = num(W.dist[row2 + b], 1e9);
        if (dv <= 0) dv = 1e9;
        if (dv >= topV[3]) continue;
        var p2 = 3;
        while (p2 > 0 && topV[p2 - 1] > dv) { topV[p2] = topV[p2 - 1]; topB[p2] = topB[p2 - 1]; p2--; }
        topV[p2] = dv; topB[p2] = b;
      }
      for (k = 0; k < 4 && n < MAXCAND && n < 4; k++) {
        b = topB[k];
        if (b < 0 || candHas(cand, base, n, b)) continue;
        cand[base + n] = b; nb[base + n] = 0; n++;
      }
    }
    // immigration magnets: open, rich countries anywhere (best two by attractiveness minus distance)
    var mg = magnets(W, P);
    if (mg.length && W.dist && NC > id) {
      var b1 = -1, b2 = -1, v1 = -1e9, v2 = -1e9;
      for (k = 0; k < mg.length; k++) {
        b = mg[k];
        if (b === id || candHas(cand, base, n, b) || !cs[b] || !cs[b].alive) continue;
        var sc = C.open[b] * 2 + C.lnG[b] * 0.5 - num(W.dist[id * NC + b], 9000) / 8000;
        if (sc > v1) { v2 = v1; b2 = b1; v1 = sc; b1 = b; } else if (sc > v2) { v2 = sc; b2 = b; }
      }
      if (b1 >= 0 && n < MAXCAND) { cand[base + n] = b1; nb[base + n] = 0; n++; }
      if (b2 >= 0 && n < MAXCAND) { cand[base + n] = b2; nb[base + n] = 0; n++; }
    }
    C.candN[id] = n;
  }
  function magnets(W, P) {
    var tick = W.tick | 0;
    if (P._mgTick !== undefined && tick - P._mgTick < 13 && P._mg) return P._mg;
    var C = P.C, cs = W.countries, arr = [];
    for (var b = 0; b < cs.length && b < P.capC; b++) {
      var c = cs[b];
      if (!c || !c.alive || !c.regions || !c.regions.length) continue;
      if (C.open[b] >= 0.5 && C.gdppc[b] > 15000) arr.push(b);
    }
    arr.sort(function (x, y) { return (C.open[y] * 2 + C.lnG[y] * 0.5) - (C.open[x] * 2 + C.lnG[x] * 0.5); });
    P._mg = arr.slice(0, 10); P._mgTick = tick;
    return P._mg;
  }

  function prepCountries(W, P) {
    var C = P.C, cs = W.countries, nC = cs.length, tick = W.tick | 0;
    var g = W.global || EMPTY;
    var foodPrice = num(g.foodPrice, 100);
    var thinG = clamp(P.live / Math.max(1, P.target * 1.15), 1, 3);
    var minPer = num(GS.CONST && GS.CONST.AGENTS_MIN_PER_COUNTRY, 30);
    var rally = C.rally, id, k;
    for (id = 0; id < nC; id++) rally[id] = 0;
    var wars = W.wars;
    if (wars && wars.length) {
      for (k = 0; k < wars.length; k++) {
        var w = wars[k];
        if (!w || w.ended) continue;
        var start = num(w.start, num(w.startTick, num(w.tick, tick)));
        var fresh = clamp(1 - (tick - start) / 104, 0, 1);
        markSide(w.defenders, w.defender, rally, 0.08 + 0.17 * fresh, nC);
        markSide(w.attackers, w.attacker, rally, 0.03 * fresh, nC);
      }
    }
    var rRebel = P.rRebel, nR = P.nR;
    for (id = 0; id < nC; id++) {
      var c0 = cs[id];
      if (c0 && c0.alive) C.open[id] = clamp(num(c0.immigOpen, num(c0.data && c0.data.open, 0.3)), 0, 1);
    }
    var yrs = tick / 52;
    for (id = 0; id < nC; id++) {
      var c = cs[id];
      if (!c || !c.alive) { C.alive[id] = 0; continue; }
      C.alive[id] = 1;
      var d = c.data || EMPTY;
      var popReal = num(c.pop, 0); if (!(popReal > 0)) popReal = num(c.pop0, num(d.pop, 1)) * 1e6;
      var gdp = num(c.gdp, 0); if (!(gdp > 0)) gdp = num(c.gdp0, num(d.gdp, 1));
      var gpc = num(c.gdpPerCap, 0); if (!(gpc > 0)) gpc = gdp * 1e9 / Math.max(1, popReal);
      gpc = clamp(gpc, 150, 400000);
      var dev = clamp((Math.log(gpc) * LOG10E - 2.85) / 2.0, 0, 1);
      C.gdppc[id] = gpc; C.lnG[id] = Math.log(gpc); C.dev[id] = dev;
      if (!C.mortOk[id] || ((tick + id) & 3) === 0) { buildMort(C, id, dev); C.mortOk[id] = 1; }
      if (!C.candOk[id] || ((tick + id) & 3) === 0) { buildCand(W, P, id); C.candOk[id] = 1; }

      var econB = clamp(num(d.econ, 0), -1, 1), authB = clamp(num(d.auth, 0), -1, 1), natB = clamp(num(d.nat, 0.5), 0, 1);
      C.econM[id] = econB * 0.7; C.authM[id] = authB * 0.5; C.natB[id] = natB;
      var L = c.leader;
      C.Le[id] = L ? clamp(num(L.econ, econB), -1, 1) : econB;
      C.La[id] = L ? clamp(num(L.auth, authB), -1, 1) : authB;
      C.Ln[id] = L ? clamp(num(L.nat, natB), 0, 1) : natB;
      var gov = c.gov || d.gov;
      var anarchy = gov === 'anarchy' ? 1 : 0;
      var gf = GOV_FREEDOM[gov];
      var freedom = clamp(num(c.freedom, gf !== undefined ? gf : 0.5), 0, 1);
      var repr = clamp(num(c.repression, (1 - freedom) * 0.5), 0, 1);
      var corr = clamp(num(c.corruption, num(d.corruption, 0.4)), 0, 1);
      var infl = clamp(num(c.inflation, 0.03), -0.5, 20);
      var growth = clamp(num(c.growth, 0.02), -1, 1);
      var stab = clamp(num(c.stability, 0.6), 0, 1);
      var atWar = c.atWar ? 1 : 0;
      var cw = c.civilWar ? 1 : 0;
      var exh = clamp(num(c.warExhaustion, 0), 0, 1);
      var food = num(c.food, num(d.food, 0));
      var famine = clamp(Math.max(0, -food) * (foodPrice / 100 - 1.25) * 0.9 * (1 - 0.8 * dev), 0, 1);
      famine = clamp(famine + num(c.famine, 0), 0, 1);
      // 4-week stock change (each agent sees it once per update), via a ring of the last 4 weekly values
      var stock = num(c.stockIndex, 100), slot = id * 4 + (tick & 3), ps = C.stkRing[slot];
      C.dS[id] = (ps > 0 && stock > 0) ? clamp(stock / ps - 1, -0.95, 3) : 0;
      if (stock > 0) C.stkRing[slot] = stock;
      var def = c.defaulted ? 1 : 0;
      if (def && !C.prevDef[id] && tick > 4) C.defTick[id] = tick + 1;
      C.prevDef[id] = def;
      C.defShock[id] = (C.defTick[id] > 0 && tick - (C.defTick[id] - 1) < 4) ? 1 : 0;

      var unemp = C.aLF[id] > 0 ? C.aUnemp[id] / C.aLF[id] : clamp(num(c.unemployment, 0.07), 0, 1);
      var ld = clamp(num(c.laborDemand, 1 - (0.10 - 0.05 * dev)), 0.05, 1);
      var uStar = clamp(1 - ld, 0.015, 0.85);
      // weekly hazards converted to per-update (4 weeks) probabilities
      // (spells ~9 months, a job loss every ~8 years: same steady state, less churn)
      C.sSep[id] = 1 - Math.pow(1 - 0.025 * uStar / (1 - uStar), 4);
      C.fHire[id] = 1 - Math.pow(1 - clamp(0.025 + Math.max(0, unemp - uStar) * 0.25, 0.01, 0.4), 4);
      C.unemp[id] = unemp;

      var spendMil = clamp(num(c.spendMil, num(d.mil, 2) / 100), 0, 0.6);
      var milBase = clamp(spendMil * 0.28, 0.0008, 0.12);
      var milTgt = milBase;
      if (atWar) milTgt = Math.max(milBase * 1.4, 0.02 * (1 - 0.5 * exh));
      if (cw) milTgt = Math.max(milTgt, milBase * 1.8, 0.02);
      if (anarchy) milTgt = milBase * 0.3;
      milTgt = clamp(milTgt, 0, 0.1);
      var milCur = C.aLF[id] > 0 ? C.aMil[id] / C.aLF[id] : milBase;
      var gap = milTgt - milCur;
      C.recruitP[id] = gap > 0 ? clamp(gap * ((atWar || cw) ? 1.2 : 0.48), 0, 0.3) : 0;
      C.dischargeP[id] = (gap < -0.1 * milTgt - 0.0005) ? clamp((-gap) / Math.max(milCur, 1e-4) * 0.15, 0, 0.6) : 0;

      C.atWar[id] = atWar; C.cw[id] = cw; C.anarchy[id] = anarchy;
      if (cw) {
        var R = c.civilWar.rebels || EMPTY;
        C.cwE[id] = clamp(num(R.econ, -econB), -1, 1);
        C.cwA[id] = clamp(num(R.auth, -authB), -1, 1);
        C.cwN[id] = clamp(num(R.nat, natB), 0, 1);
        var held = c.civilWar.regionHeld;
        if (held && held.length) for (k = 0; k < held.length; k++) { var hr = held[k] | 0; if (hr >= 0 && hr < nR) rRebel[hr] = 1; }
      }
      C.freedom[id] = freedom; C.repr[id] = repr; C.stab[id] = stab; C.famine[id] = famine;
      var crisis = clamp(Math.max(0, unemp - 0.1) * 3 + Math.max(0, infl - 0.1) * 1.5 + Math.max(0, -growth) * 5 +
        cw * 0.5 + anarchy * 0.4 + famine * 0.5, 0, 1);
      C.crisis[id] = crisis;

      var wage = num(c.wage, 0); if (!(wage > 0)) wage = gpc * 1.1;
      wage = clamp(wage, 50, 2e6);
      C.wage[id] = wage;
      var welf = clamp(num(c.spendWelfare, 0.02 + 0.13 * dev), 0, 0.5);
      C.benefit[id] = wage * clamp(welf * 2.5, 0.05, 0.6);
      C.pension[id] = wage * clamp(0.12 + welf * 2.2, 0.1, 0.75);
      C.eros[id] = clamp(1 - Math.max(0, infl - 0.03) * 0.5, 0.25, 1);
      C.cashEros[id] = clamp(1 - Math.max(0, infl - 0.02) * 0.4 * DT_Y, 0.7, 1);
      C.sub[id] = gpc * 0.35 + 300;
      if (!(C.normMult[id] > 0)) C.normMult[id] = 1;

      // fertility: the country's own current rate, its excess over replacement-ish 1.8 declining ~2.5%/yr
      // (the demographic transition), shifted by development changes since the start (a collapse raises it)
      var tfrDev = 1.25 + 5.2 * Math.pow(1 - dev, 3.6);
      if (!(C.tfr0[id] > 0)) {
        var dt0 = num(d.tfr, 0);
        C.tfr0[id] = dt0 > 0 ? dt0 : Math.max(1.35, tfrDev);
        C.tdev0[id] = tfrDev;
      }
      var tf0 = C.tfr0[id];
      var tfr = (tf0 > 1.8 ? 1.8 + (tf0 - 1.8) * Math.exp(-0.025 * yrs) : tf0) + 0.5 * (tfrDev - C.tdev0[id]);
      tfr = clamp(tfr, 0.6, 7.5);
      var fm = (1 - 0.15 * atWar - 0.2 * cw) * (1 - 0.35 * famine) * (1 - 0.1 * crisis);
      var thin = thinG;
      if (C.aN[id] > 0 && C.aN[id] < minPer) thin = 0.5;
      C.thin[id] = thin;
      C.fertW[id] = tfr / 30 * DT_Y * fm / thin;
      C.retAge[id] = 68 - 5 * dev;
      C.workAge[id] = 15 + 3 * dev;
      C.hBase[id] = 0.55 + 0.4 * dev;

      // sector targets by development, adjusted toward deficits in the current mix
      var t0 = 0.03 + 0.62 * Math.pow(1 - dev, 1.6);
      var t1 = 0.12 + 0.72 * dev * (1 - dev) + 0.04 * dev;
      var t3 = 0.04 + 0.10 * dev;
      var t2 = Math.max(0.1, 1 - t0 - t1 - t3);
      var civ = C.aFarm[id] + C.aInd[id] + C.aServ[id] + C.aGov[id];
      if (civ > 0) {
        C.sw0[id] = t0 * clamp(t0 / Math.max(C.aFarm[id] / civ, 0.005), 0.3, 3);
        C.sw1[id] = t1 * clamp(t1 / Math.max(C.aInd[id] / civ, 0.005), 0.3, 3);
        C.sw2[id] = t2 * clamp(t2 / Math.max(C.aServ[id] / civ, 0.005), 0.3, 3);
        C.sw3[id] = t3 * clamp(t3 / Math.max(C.aGov[id] / civ, 0.005), 0.3, 3);
      } else { C.sw0[id] = t0; C.sw1[id] = t1; C.sw2[id] = t2; C.sw3[id] = t3; }

      var sv = clamp(C.sevC[id] > 0 ? C.sevC[id] : num(P.sev, 0.5), 0, 1);
      C.beta[id] = 0.45 + 0.5 * sv;
      C.pdInf[id] = (0.005 + 0.25 * sv * sv) * 0.25 * 4;
      if (C.sevC[id] > 0 && C.aInf[id] <= 0 && tick - C.sevT[id] > 4) C.sevC[id] = 0; // outbreak over: the next brings its own strain
      else if (C.sevC[id] > 0) C.sevC[id] *= 0.998;          // attenuation of virulence (~10% a year)
      C.care[id] = 1.4 - 0.8 * dev;
      C.betaF[id] = 1.15 - 0.3 * dev;
      C.puppet[id] = (typeof c.overlord === 'number' && c.overlord >= 0) ? 1 : 0;
      C.infPrev[id] = C.aW[id] > 0 ? C.aInf[id] / C.aW[id] : 0;
      // armed rebels saturate around ~2% of the population (logistics / weapons are scarce)
      C.rebelRoom[id] = C.aW[id] > 0 ? clamp(1 - C.aRebel[id] / C.aW[id] / 0.02, 0, 1) : 1;
      C.radPrev[id] = C.aAdW[id] > 0 ? C.aRad[id] / C.aAdW[id] : 0;
      C.protPrev[id] = C.aAdW[id] > 0 ? C.aProt[id] / C.aAdW[id] : 0;

      C.hapRef[id] = 0.30 + 0.25 * dev; // 'normal' happiness for this development level (hedonic adaptation)
      C.hapC[id] = 0.5 + 0.12 * (dev - 0.5) - 0.06 * atWar - 0.12 * cw - 0.2 * famine - 0.08 * crisis -
        0.08 * repr - 0.1 * anarchy;
      var unPen = clamp((unemp - 0.06) * 0.8, -0.03, 0.2);
      C.apprC[id] = 0.5 + clamp(growth * 2, -0.15, 0.08) - clamp((infl - 0.04) * 0.8, 0, 0.25) - corr * 0.12 -
        cw * 0.1 - anarchy * 0.3 - famine * 0.2 - unPen;
    }
    // plague policy: a government whose neighbours / partners are infected (and that is itself still mostly clean)
    // closes its borders: fewer imported cases, no economic migrants, fewer refugees, less trade (economy.js)
    if (P.infTotal > 0 || P._anyClosed) {
      var anyC = 0;
      for (id = 0; id < nC; id++) {
        var cc = cs[id];
        if (!cc || !cc.alive) { C.closed[id] = 0; continue; }
        var was = C.closed[id], cl = 0, worst = 0;
        if (!C.anarchy[id] && C.infPrev[id] < 0.03) {
          var nCand = C.candN[id] | 0, bs = id * MAXCAND;
          for (k = 0; k < nCand; k++) { var bb = C.cand[bs + k]; if (bb >= 0 && C.infPrev[bb] > worst) worst = C.infPrev[bb]; }
          // caution & authoritarian leaders close sooner; reopening needs a clearly lower threat (hysteresis)
          var L2 = cc.leader, thr = 0.012 * (1.4 - num(L2 && L2.caution, 0.5) * 0.6 - Math.max(0, C.La[id]) * 0.3);
          cl = worst > (was ? thr * 0.4 : thr) ? 1 : 0;
          if (was && !cl && tick - C.closedT[id] < 26) cl = 1; // closures last at least half a year
        }
        if (cl && !was) C.closedT[id] = tick;
        C.closed[id] = cl; cc.bordersClosed = !!cl; anyC |= cl;
        if (cl && !was && num(cc.pop, 0) > 5e7 && GS.news) {
          GS.news(W, cc.name + ' closes its borders as the plague spreads in neighbouring countries', { type: 'disaster', countries: [id], importance: 3 });
        } else if (!cl && was && num(cc.pop, 0) > 5e7 && GS.news) {
          GS.news(W, cc.name + ' reopens its borders', { type: 'disaster', countries: [id], importance: 2 });
        }
      }
      P._anyClosed = anyC;
    }
  }

  // ------------------------------------------------------------------
  // Job helpers
  // ------------------------------------------------------------------
  function pickSector(C, id, sk, u) {
    var w0 = C.sw0[id] * (1.5 - sk), w1 = C.sw1[id], w2 = C.sw2[id] * (0.5 + sk), w3 = C.sw3[id] * (0.3 + 1.4 * sk);
    var t = (w0 + w1 + w2 + w3) * u;
    if (t < w0) return FARM; t -= w0;
    if (t < w1) return IND; t -= w1;
    if (t < w2) return SERV;
    return GOVJ;
  }

  function jobLabelOf(j, sk, age) {
    switch (j) {
      case CHILD: return age < 6 ? 'small child' : 'student';
      case UNEMP: return 'unemployed';
      case FARM: return sk > 0.6 ? 'farmer' : 'farmhand';
      case IND: return sk > 0.7 ? 'engineer' : 'factory worker';
      case SERV: return sk > 0.75 ? 'professional' : (sk > 0.45 ? 'office worker' : 'shop worker');
      case GOVJ: return sk > 0.7 ? 'government official' : 'civil servant';
      case MIL: return sk > 0.7 ? 'military officer' : 'soldier';
      case RET: return 'retired';
      case REBEL: return 'rebel fighter';
    }
    return 'unknown';
  }

  var FOUND_WORK = {};
  function foundWorkText(label) {
    var t = FOUND_WORK[label];
    if (t === undefined) t = FOUND_WORK[label] = 'found work as ' + article(label);
    return t;
  }

  function naturalCause(P, i, C, cid, dvR, a) {
    if (P.infect[i] === 1) return 'died of the plague';
    if (P.flags[i] & F_FRONT) return 'killed in action';
    if (C.famine[cid] > 0.3) return 'died of hunger';
    if (dvR > 0.4) return 'died amid the devastation of war';
    if (a < 1) return 'died in infancy';
    if (a > 70) return 'died of old age';
    return 'died of illness';
  }

  // ------------------------------------------------------------------
  // Movement / migration
  // ------------------------------------------------------------------
  function move(W, i, region) {
    var P = W.people;
    if (!P || i < 0 || i >= P.n || !P.alive[i]) return false;
    var o = ownerOf(W, region);
    if (o < 0) return false;
    P.region[i] = region;
    P.cc[i] = o;
    placeAt(W, P, i, region);
    return true;
  }

  // internal colonisation: a share of a country's (non-military) people move to newly acquired land
  function colonize(W, cid, region, frac) {
    var P = W.people;
    if (!P || !P.listsOk || ownerOf(W, region) !== cid) return 0;
    var C = P.C; if (cid >= P.capC) return 0;
    var st = C.lStart[cid], cnt = C.lCount[cid] | 0;
    if (cnt <= 0) return 0;
    var want = Math.max(1, Math.min(60, Math.round(cnt * clamp(num(frac, 0.05), 0, 0.5)))), got = 0, rng = W.rng;
    var off = (rng.next() * cnt) | 0, stride = Math.max(1, Math.floor(cnt / want));
    for (var k = 0; k < cnt && got < want; k += stride) {
      var i = P.cList[st + ((off + k) % cnt)];
      if (!P.alive[i] || P.region[i] === region || ownerOf(W, P.region[i]) !== cid) continue;
      var j = P.job[i]; if (j === MIL || j === REBEL) continue;
      if (move(W, i, region)) { logEvent(W, i, 'moved to the new frontier lands of ' + ((W.regions[region] && W.regions[region].name) || 'the frontier')); got++; }
    }
    return got;
  }

  function pickRegionOf(W, b, fromRegion, preferAdjacent, u) {
    var cb = W.countries[b];
    if (!cb || !cb.alive) return -1;
    var k, q;
    if (preferAdjacent && fromRegion >= 0) {
      var reg = W.regions[fromRegion], nbs = reg && reg.neighbors;
      if (nbs && nbs.length) {
        var s = (u * nbs.length) | 0;
        for (k = 0; k < nbs.length; k++) {
          q = nbs[(s + k) % nbs.length];
          if (ownerOf(W, q) === b) return q;
        }
      }
    }
    var regs = cb.regions;
    if (!regs || !regs.length) return -1;
    if (u < 0.6 && typeof cb.capital === 'number' && ownerOf(W, cb.capital) === b) return cb.capital;
    var st = ((u * 7919) | 0) % regs.length;
    for (k = 0; k < regs.length; k++) {
      q = regs[(st + k) % regs.length];
      if (ownerOf(W, q) === b) return q;
    }
    return -1;
  }

  // copy agent i into a fresh slot (a different person of the same household / town); -1 when the store is full
  var CLONE_F = ['alive', 'region', 'origin', 'age', 'sex', 'weight', 'wealth', 'income', 'job', 'skill', 'econ', 'auth', 'nat',
    'approval', 'happy', 'radical', 'health', 'infect', 'flags', 'x', 'y', 'born', 'expect', 'cc', 'lastJob'];
  function cloneAgent(W, P, i) {
    var j = allocSlot(P, false);
    if (j < 0) return -1;
    for (var k = 0; k < CLONE_F.length; k++) { var A = P[CLONE_F[k]]; A[j] = A[i]; }
    drawName(W, P, j, P.origin[i], P.sex[i]);
    return j;
  }

  // An agent stands for `weight` people. Migrants carry the DESTINATION's agent weight: when a heavy agent (from a
  // populous country) moves to a country of light agents, only a destination-sized group leaves (a clone) and the
  // rest stay home, so people are conserved and small countries are not flooded. Returns the moved agent's index.
  function relocate(W, P, i, cid, b, dr, kind) {
    var C = P.C, w = P.weight[i];
    var wb = (b < P.capC && C.baseW[b] > 0) ? C.baseW[b] : P.avgW;
    if (w > 1.5 * wb) {
      var cl = cloneAgent(W, P, i);
      if (cl < 0) return -1;
      P.weight[i] = w - wb; P.weight[cl] = wb; w = wb; i = cl;
    }
    P.region[i] = dr; P.cc[i] = b;
    placeAt(W, P, i, dr);
    C.cEmig[cid] += w; C.cImmig[b] += w;
    var j = P.job[i];
    if (j === MIL || j === GOVJ || j === REBEL || j === FARM || j === IND || j === SERV) { P.lastJob[i] = j; P.job[i] = UNEMP; }
    var fl = P.flags[i] & ~(F_FRONT | F_PROTEST);
    if (kind === 1) {
      fl |= F_REFUGEE;
      var c = W.countries[cid];
      if (c) c.refugeesOut = num(c.refugeesOut, 0) + w;
      P.wealth[i] *= 0.5;
      P.happy[i] = clamp(P.happy[i] - 0.1, 0, 1);
      logEvent(W, i, 'fled to ' + cname(W, b) + ' as a refugee');
    } else if (kind === 2) {
      fl &= ~F_REFUGEE;
      logEvent(W, i, 'returned home to ' + cname(W, b));
    } else {
      fl |= F_MIGRANT;
      P.wealth[i] *= 0.75;
      logEvent(W, i, 'emigrated to ' + cname(W, b));
    }
    P.flags[i] = fl;
    return i;
  }

  function considerMigration(W, P, i, cid, refugee) {
    var C = P.C, n = C.candN[cid] | 0;
    if (n <= 0) return false;
    var base = cid * MAXCAND, NC = W.NC | 0, rel = W.rel, dist = W.dist, rng = W.rng;
    var cs = W.countries, org = P.origin[i], orgCult = cultureOf(W, org);
    var best = -1, bestS = -1e9;
    for (var k = 0; k < n; k++) {
      var b = C.cand[base + k];
      if (b === cid || b < 0 || b >= cs.length || !C.alive[b]) continue;
      var cb = cs[b];
      if (!cb || !cb.alive || !cb.regions || !cb.regions.length) continue;
      if (!refugee && C.closed[b]) continue; // closed border (plague): no economic migration
      var nb = C.candNb[base + k];
      var econG = C.lnG[b] - C.lnG[cid];
      var safety = -C.atWar[b] - 1.5 * C.cw[b] - C.famine[b] - C.anarchy[b];
      var rv = (rel && NC > cid && NC > b) ? num(rel[cid * NC + b], 0) / 100 : 0;
      var dk = (dist && NC > cid && NC > b) ? num(dist[cid * NC + b], 3000) : 3000;
      // recent intake (people / year) relative to the host's population: absorption capacity
      var intake = num(cb.immigY, 0) / Math.max(1, num(cb.pop, 1));
      var diaspora = (b === org ? 0.8 : 0) + (cultureOf(W, b) === orgCult ? 0.4 : 0);
      var s;
      if (refugee) {
        s = safety * 2 + C.stab[b] * 0.5 + rv * 0.5 - dk / 1500 + econG * 0.3 + (nb ? 0.5 : 0) + diaspora * 0.5 -
          Math.min(4, intake / 0.02) * 1.2 - C.closed[b] * 1.2;
      } else {
        // immigration policy: a yearly quota (share of the population) that fills up; open countries admit more
        var op = C.open[b], capY = op * 0.006 + 0.0004;
        if (intake >= capY) continue;
        s = econG * 1.5 + safety + C.stab[b] * 0.5 + rv * 0.6 - dk / 10000 + C.freedom[b] * 0.3 + diaspora +
          1.5 * (op - 0.5) - 2 * intake / capY;
      }
      s += (rng.next() - 0.5) * 0.8;
      if (s > bestS) { bestS = s; best = b; }
    }
    if (best < 0) return false;
    if (!refugee && bestS < 0.7) return false;
    if (refugee && bestS < -1.5) return false;
    var dr = pickRegionOf(W, best, P.region[i], refugee, rng.next());
    if (dr < 0) return false;
    var mv = relocate(W, P, i, cid, best, dr, refugee ? 1 : 0);
    return mv === i; // false when only part of the agent's group left (the agent itself stays)
  }

  // ------------------------------------------------------------------
  // Spawning
  // ------------------------------------------------------------------
  function fillAgent(W, P, i, r, origin, cid, o) {
    var rng = W.rng, C = P.C;
    var dev = (cid < P.capC && C.alive[cid]) ? C.dev[cid] : devOfCountry(W.countries[cid] || EMPTY);
    var oc = W.countries[origin] || EMPTY, od = oc.data || EMPTY;
    var age = clamp(num(o.age, 25), 0, 110);
    var sex = (o.sex === 0 || o.sex === 1) ? o.sex : (rng.next() < 0.5 ? 1 : 0);
    P.alive[i] = 1; P.region[i] = r; P.origin[i] = origin; P.cc[i] = cid;
    P.age[i] = age; P.sex[i] = sex;
    var bw = (cid < P.capC && C.baseW[cid] > 0) ? C.baseW[cid] : P.avgW;
    P.weight[i] = clamp(num(o.weight, bw), 1e-3, 1e12);
    P.skill[i] = clamp(num(o.skill, 0.25 + 0.45 * dev + 0.18 * rng.normal()), 0.02, 1);
    P.econ[i] = clamp(num(o.econ, num(od.econ, 0) * 0.7 + rng.normal() * 0.35), -1, 1);
    P.auth[i] = clamp(num(o.auth, num(od.auth, 0) * 0.5 + rng.normal() * 0.35), -1, 1);
    P.nat[i] = clamp(num(o.nat, num(od.nat, 0.5) + rng.normal() * 0.18), 0, 1);
    P.health[i] = clamp(num(o.health, 0.55 + 0.4 * dev + rng.normal() * 0.08), 0.02, 1);
    var job = (typeof o.job === 'number' && o.job >= 0 && o.job <= 8) ? o.job :
      (age < 15 + 3 * dev ? CHILD : (age >= 68 - 5 * dev ? RET : UNEMP));
    P.job[i] = job;
    P.wealth[i] = clamp(num(o.wealth, 0), 0, 1e12);
    P.income[i] = clamp(num(o.income, 0), 0, 1e9);
    P.expect[i] = P.income[i];
    P.happy[i] = clamp(num(o.happy, 0.5), 0, 1);
    P.approval[i] = clamp(num(o.approval, 0.5), 0, 1);
    P.radical[i] = clamp(num(o.radical, 0.05), 0, 1);
    P.infect[i] = (o.infect === 1 || o.infect === 2) ? o.infect : 0;
    P.flags[i] = (o.flags | 0) & 15;
    P.born[i] = (W.tick | 0) - Math.round(age * 52);
    drawName(W, P, i, origin, sex);
    if (typeof o.last === 'number') P.last[i] = o.last;
    if (typeof o.x === 'number' && typeof o.y === 'number' && isFinite(o.x) && isFinite(o.y)) { P.x[i] = o.x; P.y[i] = o.y; }
    else placeAt(W, P, i, r);
  }

  function spawn(W, region, origin, opts) {
    var P = W.people;
    if (!P) return -1;
    var o = opts || EMPTY;
    var cid = ownerOf(W, region);
    if (cid < 0) return -1;
    var cc = W.countries[cid];
    if (!cc || !cc.alive) return -1;
    ensureC(W, P);
    if (typeof origin !== 'number' || origin < 0 || origin >= W.countries.length) origin = cid;
    var i = allocSlot(P, true);
    fillAgent(W, P, i, region, origin, cid, o);
    if (o.log) logEvent(W, i, o.log);
    return i;
  }

  // birth inside the hot loop (no capacity growth allowed there)
  function birth(W, P, m, cid, r) {
    var C = P.C, rng = W.rng;
    var i = allocSlot(P, false);
    if (i < 0) return;
    var sex = rng.next() < 0.512 ? 0 : 1;
    var org = P.origin[m];
    P.alive[i] = 1; P.region[i] = r; P.origin[i] = org; P.cc[i] = cid;
    P.age[i] = 0; P.sex[i] = sex;
    P.weight[i] = clamp(P.weight[m] * C.thin[cid], 1e-3, 1e12);
    P.skill[i] = clamp(0.25 + 0.45 * C.dev[cid] + 0.18 * rng.normal(), 0.02, 1);
    P.econ[i] = clamp(P.econ[m] + (rng.next() - 0.5) * 0.4, -1, 1);
    P.auth[i] = clamp(P.auth[m] + (rng.next() - 0.5) * 0.4, -1, 1);
    P.nat[i] = clamp(P.nat[m] + (rng.next() - 0.5) * 0.2, 0, 1);
    P.health[i] = clamp(C.hBase[cid], 0.05, 1);
    P.job[i] = CHILD; P.wealth[i] = 0; P.income[i] = 0; P.expect[i] = 0;
    P.happy[i] = P.happy[m]; P.approval[i] = P.approval[m]; P.radical[i] = P.radical[m] * 0.5;
    P.infect[i] = 0; P.flags[i] = 0; P.born[i] = W.tick | 0;
    drawName(W, P, i, org, sex);
    P.last[i] = P.last[m];
    P.x[i] = P.x[m] + (rng.next() - 0.5) * 0.6;
    P.y[i] = P.y[m] + (rng.next() - 0.5) * 0.6;
    C.cBirth[cid] += P.weight[i];
    var reg = W.regions[r];
    logEvent(W, i, 'born in ' + ((reg && reg.name) || 'a small town') + ', ' + cname(W, cid));
  }

  // ------------------------------------------------------------------
  // init
  // ------------------------------------------------------------------
  function init(W) {
    var CONST = GS.CONST || EMPTY;
    var total = num(CONST.AGENTS_TOTAL, 40000), minPer = num(CONST.AGENTS_MIN_PER_COUNTRY, 30);
    var cs = W.countries || [], nC = cs.length, rng = W.rng;
    var popM = new Float64Array(nC), sum = 0, id, k;
    for (id = 0; id < nC; id++) {
      var c = cs[id];
      if (!c || !c.alive || !c.regions || !c.regions.length) continue;
      var p = num(c.pop0, num(c.data && c.data.pop, 0));
      if (!(p > 0)) p = 0.01;
      popM[id] = p; sum += p;
    }
    var cnt = new Int32Array(nC), tot = 0;
    for (id = 0; id < nC; id++) {
      if (!(popM[id] > 0)) continue;
      cnt[id] = Math.max(minPer, Math.round(total * popM[id] / Math.max(sum, 1e-9)));
      tot += cnt[id];
    }
    var P = W.people = makeStore(Math.ceil(tot * 1.6) + 512, W);
    P.target = Math.max(1, tot);
    ensureC(W, P); ensureR(W, P);
    prepRegions(W, P);
    prepCountries(W, P);
    var C = P.C;
    var DC = (GS.DATA && GS.DATA.countries) || EMPTY;
    var cdf = new Float64Array(AGE_BINS);
    var totW = 0;
    for (id = 0; id < nC; id++) {
      var n = cnt[id];
      if (!n) continue;
      var c2 = cs[id], regs = c2.regions;
      var bw = popM[id] * 1e6 / n;
      C.baseW[id] = bw;
      // region weights: DATA population of the region's own entry if any, else area share
      var totArea = 0, r, reg;
      for (k = 0; k < regs.length; k++) { reg = W.regions[regs[k]]; totArea += reg ? Math.max(num(reg.area, 0), 1e-6) : 0; }
      var rw = new Float64Array(regs.length), rs = 0;
      for (k = 0; k < regs.length; k++) {
        reg = W.regions[regs[k]];
        if (!reg || reg.owner !== id) { rw[k] = 0; continue; }
        var de = DC[reg.key];
        var wv = (de && num(de.pop, 0) > 0) ? de.pop / Math.max(1, num(reg.subN, 1)) : popM[id] * Math.max(num(reg.area, 0), 1e-6) / Math.max(totArea, 1e-9);
        rw[k] = wv; rs += wv;
      }
      if (!(rs > 0)) continue;
      // age distribution: stable population exp(-r a) S(a)
      var dev = C.dev[id], mb = id * AGE_BINS, S = 1, cum = 0;
      var tfr = 1.35 + 4.6 * Math.pow(1 - dev, 2.2);
      var tfrNow = num(c2.data && c2.data.tfr, tfr);
      // pyramids reflect past (higher) fertility and past growth: never stationary-old (crude death rates ~1/LE)
      var gr = clamp((Math.max(tfr, tfrNow) - 1.6) * 0.012 + 0.007, 0.004, 0.035);
      for (var a = 0; a < AGE_BINS; a++) {
        cum += Math.exp(-gr * a) * S;
        cdf[a] = cum;
        S *= Math.exp(-C.mort[mb + a]);
      }
      var econB = num(c2.data && c2.data.econ, 0), authB = num(c2.data && c2.data.auth, 0), natB = num(c2.data && c2.data.nat, 0.5);
      var corr = clamp(num(c2.corruption, num(c2.data && c2.data.corruption, 0.4)), 0, 1);
      var gpc = C.gdppc[id], sig = 1.0 + 0.5 * corr;
      var u0 = 0.10 - 0.05 * dev;
      var milShare = clamp(clamp(num(c2.spendMil, num(c2.data && c2.data.mil, 2) / 100), 0, 0.6) * 0.28, 0.0008, 0.12);
      var wage = C.wage[id];
      for (var q = 0; q < n; q++) {
        // region
        var t = rng.next() * rs, ri = 0;
        while (ri < regs.length - 1 && t >= rw[ri]) { t -= rw[ri]; ri++; }
        while (ri > 0 && rw[ri] <= 0) ri--;
        r = regs[ri];
        // age via inverse CDF
        var ut = rng.next() * cum, lo = 0, hi = AGE_BINS - 1;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (cdf[mid] < ut) lo = mid + 1; else hi = mid; }
        var age = lo + rng.next();
        var i = allocSlot(P, true);
        var sex = rng.next() < (age > 65 ? 0.56 : 0.5) ? 1 : 0;
        P.alive[i] = 1; P.region[i] = r; P.origin[i] = id; P.cc[i] = id;
        P.age[i] = age; P.sex[i] = sex; P.weight[i] = bw;
        var sk = clamp(0.25 + 0.45 * dev + 0.18 * rng.normal(), 0.02, 1);
        P.skill[i] = sk;
        P.econ[i] = clamp(econB * 0.7 + rng.normal() * 0.35, -1, 1);
        P.auth[i] = clamp(authB * 0.5 + rng.normal() * 0.35, -1, 1);
        P.nat[i] = clamp(natB + rng.normal() * 0.18, 0, 1);
        P.health[i] = clamp(C.hBase[id] + rng.normal() * 0.08, 0.05, 1);
        var job;
        if (age < C.workAge[id]) job = CHILD;
        else if (age >= C.retAge[id]) job = RET;
        else if (rng.next() < u0) job = UNEMP;
        else if (age >= 18 && age < 50 && rng.next() < milShare / (1 - u0) * (sex ? 0.25 : 1.75)) job = MIL;
        else job = pickSector(C, id, sk, rng.next());
        P.job[i] = job;
        var af = age < 16 ? 0.03 : (age < 30 ? 0.4 : (age < 60 ? 1.1 : 1.4));
        P.wealth[i] = clamp(gpc * (1.0 + 2.5 * dev) * af * Math.exp(sig * rng.normal() - sig * sig / 2), 0, 1e12);
        var inc = 0;
        if (job >= FARM && job <= MIL) inc = wage * SECT_MULT[job] * (0.5 + sk);
        else if (job === UNEMP) inc = C.benefit[id];
        else if (job === RET) inc = C.pension[id];
        inc += P.wealth[i] * 0.035;
        P.income[i] = inc; P.expect[i] = inc;
        P.happy[i] = clamp(0.45 + 0.15 * dev + rng.normal() * 0.1, 0, 1);
        P.approval[i] = clamp(0.5 + rng.normal() * 0.12, 0, 1);
        P.radical[i] = rng.next() * 0.12;
        P.infect[i] = 0; P.flags[i] = 0;
        P.born[i] = -Math.round(age * 52);
        drawName(W, P, i, id, sex);
        placeAt(W, P, i, r);
        totW += bw;
      }
    }
    P.avgW = P.live > 0 ? totW / P.live : 1;
    aggregate(W);
    return P;
  }

  // ------------------------------------------------------------------
  // step — the hot loop
  // ------------------------------------------------------------------
  function step(W) {
    var P = W.people;
    if (!P) return;
    ensureC(W, P); ensureR(W, P);
    // capacity headroom for births (no growth inside the loop: arrays are hoisted)
    if ((P.cap - P.n) + P.free.length < Math.max(512, P.cap * 0.03)) growAgents(P, Math.ceil(P.cap * 1.5) + 64);
    prepRegions(W, P);
    prepCountries(W, P);

    stepAgents(W, P);
    if (P.infTotal > 0) plagueSpread(W, P);
  }

  // the hot loop: per agent O(1); only typed arrays + rare calls
  function stepAgents(W, P) {
    var C = P.C, rng = W.rng, tick = W.tick | 0, NC = W.NC | 0, rel = W.rel, cs = W.countries;
    var nR = P.nR;
    var alive = P.alive, region = P.region, origin = P.origin, age = P.age, sex = P.sex, weight = P.weight;
    var wealth = P.wealth, income = P.income, job = P.job, skill = P.skill, econ = P.econ, auth = P.auth, nat = P.nat;
    var approval = P.approval, happy = P.happy, radical = P.radical, health = P.health, infect = P.infect;
    var flags = P.flags, born = P.born, expect = P.expect;
    var rOwner = P.rOwner, rDev = P.rDev, rRebel = P.rRebel, rInfW = P.rInfW, rPopW = P.rPopW;
    var cList = P.cList, lStart = C.lStart, lCount = C.lCount, listsOk = P.listsOk;
    var Calive = C.alive, mort = C.mort, hBase = C.hBase, famineA = C.famine, fertW = C.fertW;
    var workAge = C.workAge, retAge = C.retAge, fHire = C.fHire, sSep = C.sSep, recruitP = C.recruitP, dischargeP = C.dischargeP;
    var atWarA = C.atWar, cwA = C.cw, wageA = C.wage, normMult = C.normMult, eros = C.eros, benefitA = C.benefit, pensionA = C.pension;
    var subA = C.sub, gdppcA = C.gdppc, dSA = C.dS, defShock = C.defShock, cashEros = C.cashEros;
    var hapC = C.hapC, apprC = C.apprC, freedomA = C.freedom, reprA = C.repr, rallyA = C.rally;
    var LeA = C.Le, LaA = C.La, LnA = C.Ln, puppetA = C.puppet, radPrev = C.radPrev, protPrev = C.protPrev;
    var crisisA = C.crisis, cwE = C.cwE, cwAu = C.cwA, cwN = C.cwN, infPrev = C.infPrev, care = C.care, betaF = C.betaF;
    var econM = C.econM, authM = C.authM, natB = C.natB, cDeath = C.cDeath, hapRef = C.hapRef, rebelRoom = C.rebelRoom, anarchyA = C.anarchy;

    var plague = P.infTotal > 0;
    // each agent is fully updated once every 4 ticks (staggered by index): rates below are per 4 weeks
    // severity is per country (the strain that reached it): betaA / pdInfA are filled by prepCountries
    var betaA = C.beta, pdInfA = C.pdInf, gamma = 0.25, lastJob = P.lastJob;
    var gamma4 = 1 - Math.pow(1 - gamma, 4);

    var n0 = P.n;
    // staggered: each tick updates one contiguous quarter of the store (cache friendly)
    var blk = Math.ceil(n0 / 4), i0 = (tick & 3) * blk, i1 = Math.min(n0, i0 + blk);
    for (var i = i0; i < i1; i++) {
      if (!alive[i]) continue;
      var r = region[i];
      var cid = (r >= 0 && r < nR) ? rOwner[r] : -1;
      if (cid < 0) {
        if (cid === -1) killOne(W, P, i, 'vanished', true); // ownerless land: nobody lives there
        continue;
      }
      if (cid >= P.capC || !Calive[cid]) continue;
      if (born[i] === tick && tick > 0) continue; // spawned this tick
      P.cc[i] = cid;
      var a = age[i] + DT_Y; age[i] = a;
      var jb = job[i], fl = flags[i], dvR = rDev[r], inf = infect[i], hl = health[i];
      var cAtWar = atWarA[cid], cCw = cwA[cid];

      // ---- mortality (Gompertz table × health × famine + devastation + front + plague)
      var ai = a | 0; if (ai > AGE_BINS - 1) ai = AGE_BINS - 1;
      var hf = 1 + (hBase[cid] - hl) * 3; if (hf < 0.5) hf = 0.5; else if (hf > 4) hf = 4;
      var H = mort[cid * AGE_BINS + ai] * hf * (1 + famineA[cid] * 1.5) + dvR * 0.04;
      if (fl & F_FRONT) H += 0.03;
      var pd = H * DT_Y;
      if (inf === 1) pd += pdInfA[cid] * (1.6 - hl) * care[cid];
      if (a > 115 || rng.next() < pd) {
        var why = naturalCause(P, i, C, cid, dvR, a);
        cDeath[cid] += weight[i];
        logEvent(W, i, why);
        killOne(W, P, i, why, true);
        continue;
      }

      // ---- plague SIR
      if (plague) {
        if (inf === 1) {
          hl -= 0.03;
          if (rng.next() < gamma4) { infect[i] = 2; logEvent(W, i, 'recovered from the plague'); }
        } else if (inf === 0) {
          var pw = rPopW[r];
          var force = (pw > 0 ? rInfW[r] / pw : 0) * 0.75 + infPrev[cid] * 0.25;
          if (force > 0 && rng.next() < betaA[cid] * force * betaF[cid] * 4) { infect[i] = 1; logEvent(W, i, 'fell ill with the plague'); }
        } else if (rng.next() < 0.004) infect[i] = 0; // immunity wanes slowly
      }

      // ---- births
      if (sex[i] === 1 && a >= 15 && a < 45 && rng.next() < fertW[cid]) birth(W, P, i, cid, r);

      // ---- life course & labour market
      var ww = wageA[cid];
      if (jb === CHILD) {
        // school-to-work: most school leavers walk into a job, the rest queue as unemployed
        if (a >= workAge[cid]) jb = rng.next() < 1 - C.unemp[cid] * 1.3 ? pickSector(C, cid, skill[i], rng.next()) : UNEMP;
      } else if (jb !== RET && jb !== REBEL && a >= retAge[cid] && !(jb === MIL && cAtWar)) {
        if (jb !== UNEMP) logEvent(W, i, 'retired');
        jb = RET; fl &= ~F_FRONT;
      } else if (jb === UNEMP || (jb >= FARM && jb <= GOVJ)) {
        var u = rng.next();
        var rp = recruitP[cid];
        if (rp > 0 && a >= 18 && a < 46) rp *= (cAtWar || cCw) ? (sex[i] ? 0.1 : 1.9) : (sex[i] ? 0.4 : 1.6);
        else rp = 0;
        if (jb === UNEMP) {
          var fh = fHire[cid];
          if (fl & F_REFUGEE) fh *= 0.35; // newly arrived refugees find work slowly
          if (u < fh) {
            var lj = lastJob[i];
            // most people find work again in the sector they know
            jb = (lj >= FARM && lj <= GOVJ && rng.next() < 0.7) ? lj : pickSector(C, cid, skill[i], rng.next());
            logEvent(W, i, jb === lj ? 'found work again' : foundWorkText(jobLabelOf(jb, skill[i], a)));
          } else if (u < fh + rp) {
            jb = MIL;
            logEvent(W, i, (cAtWar || cCw) ? 'was conscripted into the army' : 'enlisted in the armed forces');
          }
        } else {
          var ss = sSep[cid];
          if (u < ss) { lastJob[i] = jb; jb = UNEMP; logEvent(W, i, 'lost their job'); }
          else if (u < ss + rp) {
            jb = MIL;
            logEvent(W, i, (cAtWar || cCw) ? 'was conscripted into the army' : 'enlisted in the armed forces');
          }
        }
      } else if (jb === MIL) {
        if (dischargeP[cid] > 0 && rng.next() < dischargeP[cid]) {
          jb = UNEMP; fl &= ~F_FRONT;
          logEvent(W, i, cAtWar ? 'was demobilized' : 'left the armed forces');
        }
      }
      // front line status
      if (jb === MIL) {
        if (cAtWar && (i % 10) < 6) fl |= F_FRONT; else fl &= ~F_FRONT;
      } else if (jb === REBEL && cCw) fl |= F_FRONT;
      else fl &= ~F_FRONT;
      if ((fl & F_FRONT) && rng.next() < 0.012) { hl -= 0.25; logEvent(W, i, 'was wounded in combat'); }

      // ---- income & wealth
      var sk = skill[i], inc;
      if (jb >= FARM && jb <= MIL) inc = ww * SECT_MULT[jb] * (0.5 + sk) / normMult[cid] * eros[cid];
      else if (jb === UNEMP) inc = benefitA[cid] * eros[cid];
      else if (jb === RET) inc = pensionA[cid] * eros[cid];
      else if (jb === REBEL) inc = ww * 0.12;
      else inc = 0;
      var wl = wealth[i];
      inc += wl * 0.035;
      if (!(inc >= 0)) inc = 0; else if (inc > 1e9) inc = 1e9;
      income[i] = inc;
      if (jb !== CHILD) {
        wl += ((inc - subA[cid]) * 0.2 - wl * 0.03) * DT_Y;
        var dS = dSA[cid];
        if (dS !== 0 && wl > 0) {
          var ex = wl / gdppcA[cid] * 0.1; if (ex > 0.6) ex = 0.6;
          wl += wl * ex * dS;
          if (dS < -0.15 && ex > 0.2 && rng.next() < 0.25) logEvent(W, i, 'lost much of their savings in a market crash');
        }
        if (defShock[cid] && wl > 0) {
          wl *= 0.8;
          if (rng.next() < 0.2) logEvent(W, i, 'lost savings when the government defaulted');
        }
        wl *= cashEros[cid];
        if (!(wl >= 0)) wl = 0; else if (wl > 1e12) wl = 1e12;
        wealth[i] = wl;
      }
      var exI = expect[i];
      exI += (inc - exI) * 0.078;
      expect[i] = exI;

      // ---- health
      var incRel = (jb === CHILD) ? 0.8 : inc / (ww + 1);
      var ht = hBase[cid] + clamp((incRel - 0.7) * 0.08, -0.08, 0.08) - famineA[cid] * 0.35 - dvR * 0.3 - (infect[i] === 1 ? 0.25 : 0);
      hl += (ht - hl) * 0.115;
      health[i] = hl < 0.01 ? 0.01 : (hl > 1 ? 1 : hl);

      // ---- happiness
      var e = econ[i], au = auth[i], nt = nat[i], hp = happy[i], ap = approval[i], rd = radical[i];
      var kk = 0.1 * ww + 1;
      var rr = (inc + kk) / (exI + kk);
      var incT = (rr - 1) / (rr + 1);       // ~ 0.5*ln(rr), bounded
      var htg = hapC[cid] + (jb === CHILD ? 0 : clamp(incT, -0.25, 0.15) + clamp((incRel - 0.8) * 0.1, -0.08, 0.12)) +
        (jb === UNEMP ? -0.12 : 0) + (health[i] - 0.7) * 0.3 - dvR * 0.35;
      var pref = (1 - au) * 0.5, fm = pref - freedomA[cid];
      htg -= fm > 0 ? fm * 0.25 : -fm * 0.05;
      if (fl & F_REFUGEE) htg -= 0.08;
      if (fl & F_FRONT) htg -= 0.1;
      if (infect[i] === 1) htg -= 0.1;
      var org = origin[i], hostile = 0;
      if (org !== cid) {
        htg -= 0.03 + 0.05 * nt;
        if (rel && org >= 0 && org < NC && cid < NC) { var rv = rel[org * NC + cid]; if (rv < 0) hostile = -rv / 100; }
      }
      hp += (htg - hp) * 0.344;
      hp = hp < 0 ? 0 : (hp > 1 ? 1 : hp);
      happy[i] = hp;

      // ---- approval of the government
      var de = e - LeA[cid], da = au - LaA[cid], dn = nt - LnA[cid];
      var dist = ((de < 0 ? -de : de) + (da < 0 ? -da : da)) * 0.5 + (dn < 0 ? -dn : dn);
      var hRef = hapRef[cid];
      var atg = apprC[cid] + (hp - hRef) * 0.6 + (jb === UNEMP ? -0.06 : 0) + rallyA[cid] * (0.5 + nt) - (dist - 0.45) * 0.4;
      if (au < 0) atg += reprA[cid] * au * 0.15;
      if (puppetA[cid]) atg -= 0.15 * nt;
      if (org !== cid) atg -= 0.06 + 0.15 * nt + 0.2 * hostile * nt;
      atg -= dvR * 0.1;
      if (atg < 0.02) atg = 0.02; else if (atg > 0.98) atg = 0.98;
      ap += (atg - ap) * 0.219;
      ap = ap < 0 ? 0 : (ap > 1 ? 1 : ap);
      approval[i] = ap;

      // ---- radicalization
      var cr = crisisA[cid];
      var rtg = (hRef - hp) * 1.3 + (0.45 - ap) * 0.9 + radPrev[cid] * 0.3 + cr * 0.15 - 0.05;
      rtg = rtg < 0 ? 0 : (rtg > 1 ? 1 : rtg);
      rd += (rtg - rd) * 0.151;
      radical[i] = rd;

      // ---- protests
      if (fl & F_PROTEST) {
        if (rd < 0.35 || ap > 0.5 || rng.next() < 0.45 + reprA[cid] * 0.5) fl &= ~F_PROTEST;
      } else if (rd > 0.4 && ap < 0.4 && a >= 16) {
        var pp = ((rd - 0.4) * 0.8 + protPrev[cid] * 2.5) * (1 - reprA[cid] * 0.75);
        if (pp > 0 && rng.next() < pp) { fl |= F_PROTEST; logEvent(W, i, 'joined protests against the government'); }
      }

      // ---- civil war: rebels
      if (cCw) {
        if (jb !== REBEL && jb !== CHILD && jb !== RET && a < 55 && rebelRoom[cid] > 0) {
          var ce = e - cwE[cid], ca = au - cwAu[cid], cn = nt - cwN[cid];
          var cd = ((ce < 0 ? -ce : ce) + (ca < 0 ? -ca : ca)) * 0.5 + (cn < 0 ? -cn : cn);
          var close = 1 - cd / 1.2;
          if (close > 0) {
            var pr = ((rd - 0.3) * 0.15 + (rRebel[r] ? 0.04 : 0)) * close * rebelRoom[cid] * (sex[i] ? 0.3 : 1);
            if (jb === MIL) pr *= (1 - ap) * 0.5;
            if (pr > 0 && rng.next() < pr) {
              jb = REBEL; fl = (fl & ~F_PROTEST) | F_FRONT;
              var cwo = cs[cid].civilWar;
              logEvent(W, i, 'joined the rebels' + (cwo && cwo.rebelName ? ' (' + cwo.rebelName + ')' : ''));
            }
          }
        } else if (jb === REBEL && rd < 0.15 && rng.next() < 0.04) {
          jb = UNEMP; fl &= ~F_FRONT; logEvent(W, i, 'deserted the rebels');
        }
      } else if (jb === REBEL) {
        jb = UNEMP; fl &= ~F_FRONT; logEvent(W, i, 'laid down arms as the civil war ended');
      }

      // ---- slow updates (each agent every 4th tick): ideology drift, migration
      var moved = false;
      {
        if (listsOk && rng.next() < 0.25) {
          var nL = lCount[cid];
          if (nL > 1) {
            var j = cList[lStart[cid] + ((rng.next() * nL) | 0)];
            if (j !== i && alive[j]) {
              e += (econ[j] - e) * 0.04; au += (auth[j] - au) * 0.04; nt += (nat[j] - nt) * 0.04;
            }
          }
        }
        e += (econM[cid] - e) * 0.004 + (rng.next() - 0.5) * 0.2;
        au += (authM[cid] - au) * 0.004 + (rng.next() - 0.5) * 0.2;
        nt += (natB[cid] - nt) * 0.004 + (rng.next() - 0.5) * 0.1;
        var crr = cr * rd;
        if (crr > 0.02) {
          e += (e >= 0 ? 1 : -1) * crr * 0.03;
          au += (au >= 0 ? 1 : -1) * crr * 0.02 + crr * 0.01;
        }
        if (cAtWar) nt += (1 - nt) * 0.02 * (0.5 + rallyA[cid] * 2);
        if (cCw) e += (e >= 0 ? 1 : -1) * 0.004;
        econ[i] = e < -1 ? -1 : (e > 1 ? 1 : e);
        auth[i] = au < -1 ? -1 : (au > 1 ? 1 : au);
        nat[i] = nt < 0 ? 0 : (nt > 1 ? 1 : nt);

        // migration (rare): refugees from danger, economic migrants, returnees
        if (a >= 16 && jb !== MIL && jb !== REBEL) {
          // danger is local: devastation of the home region, civil war (worse in rebel-held land), famine, anarchy
          var danger = dvR + 0.05 * cAtWar + cCw * (rRebel[r] ? 0.35 : 0.15) + 0.3 * famineA[cid] + 0.2 * anarchyA[cid] +
            (plague ? Math.min(0.3, infPrev[cid] * 3 * (0.5 + C.sevC[cid])) : 0);
          if (fl & F_REFUGEE) {
            if (org === cid) fl &= ~F_REFUGEE;
            else if (org >= 0 && org < P.capC && Calive[org] && !atWarA[org] && !cwA[org] && famineA[org] < 0.2 && rng.next() < 0.03) {
              var hr2 = pickRegionOf(W, org, -1, false, rng.next());
              if (hr2 >= 0) { flags[i] = fl; job[i] = jb; moved = relocate(W, P, i, cid, org, hr2, 2) === i; if (!moved) { fl = flags[i]; jb = job[i]; } }
            }
          }
          if (!moved) {
            if (danger > 0.05 && rng.next() < danger * danger * 0.04) {
              flags[i] = fl; job[i] = jb;
              moved = considerMigration(W, P, i, cid, true);
            } else {
              var ability = wl / (gdppcA[cid] * 0.5 + 500); if (ability > 1) ability = 1;
              var mh = 0.0006 * (1.2 - hp) * (1.2 - hp) * ability * (a < 45 ? 1 : 0.3);
              if (mh > 0 && rng.next() < mh) { flags[i] = fl; job[i] = jb; moved = considerMigration(W, P, i, cid, false); }
            }
          }
        }
      }
      if (moved) continue; // relocate() already wrote job/flags
      job[i] = jb;
      flags[i] = fl;
    }
  }

  // cross-border plague seeding along trade/neighbour links
  function plagueSpread(W, P) {
    var C = P.C, rng = W.rng, cs = W.countries, Calive = C.alive, infPrev = C.infPrev;
    {
      var nC = cs.length;
      for (var id = 0; id < nC && id < P.capC; id++) {
        if (!Calive[id]) continue;
        var ip = infPrev[id];
        if (ip < 0.002) continue;
        var cn2 = C.candN[id] | 0, base = id * MAXCAND, NC = W.NC | 0, T = W.trade;
        var ex = Math.max(1e-6, num(cs[id].exports, 0) + num(cs[id].imports, 0));
        for (var k = 0; k < cn2; k++) {
          var b = C.cand[base + k];
          if (b < 0 || b >= nC || !Calive[b] || infPrev[b] > 0.02) continue;
          // contact intensity: shared border, or the pair's share of this country's trade (travel follows trade)
          var ts = (T && id < NC && b < NC) ? (num(T[id * NC + b], 0) + num(T[b * NC + id], 0)) / ex : 0;
          var link = C.candNb[base + k] ? 1.5 : 0.3 + 2.0 * Math.sqrt(clamp(ts, 0, 1));
          var ps = ip * link * ((C.closed[b] || C.closed[id]) ? 0.2 : 1);
          if (ps > 0.5) ps = 0.5;
          if (rng.next() < ps) {
            var tr = pickRegionOf(W, b, -1, false, rng.next());
            if (tr >= 0) seedInfection(W, tr, 2, C.sevC[id] > 0 ? C.sevC[id] : undefined);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // aggregate — fills country aggregates, builds country/region lists
  // ------------------------------------------------------------------
  function aggregate(W) {
    var P = W.people;
    if (!P) return;
    ensureC(W, P); ensureR(W, P);
    var C = P.C, cs = W.countries, nC = cs.length, nR = P.nR, regs = W.regions, k, id, r;
    var slow = !P._slowDone || ((W.tick | 0) & 3) === 0;
    for (k = 0; k < AGG_FAST.length; k++) C[AGG_FAST[k]].fill(0, 0, nC);
    if (slow) for (k = 0; k < AGG_SLOW.length; k++) C[AGG_SLOW[k]].fill(0, 0, nC);
    P._slowDone = true;
    var lCount = C.lCount, lStart = C.lStart, rCount = P.rCount, rStart = P.rStart;
    var rInfW = P.rInfW, rPopW = P.rPopW, rOwner = P.rOwner;
    lCount.fill(0, 0, nC);
    rCount.fill(0); rInfW.fill(0); rPopW.fill(0);
    for (r = 0; r < nR; r++) {
      var reg = regs[r];
      var o = reg && typeof reg.owner === 'number' ? reg.owner : -1;
      if (o >= nC) o = -1;
      rOwner[r] = o;
    }
    aggAccumulate(P, C, nR, slow);
    P.live = P._aggLive;
    if (P._aggLive > 0) P.avgW = P._aggTotW / P._aggLive;
    if (W.global) W.global.plagueActive = P.infTotal > 0;
    aggLists(P, C, nC, nR);
    aggPublish(W, P, C, nC, slow);
  }

  function aggAccumulate(P, C, nR, slow) {
    var lCount = C.lCount, rCount = P.rCount, rInfW = P.rInfW, rPopW = P.rPopW, rOwner = P.rOwner;
    var aW = C.aW, aN = C.aN, aAdW = C.aAdW, aHap = C.aHap, aApp = C.aApp, aE = C.aE, aA = C.aA, aNt = C.aNt;
    var aE2 = C.aE2, aA2 = C.aA2, aNt2 = C.aNt2, aRad = C.aRad, aProt = C.aProt, aMilW = C.aMilW, aMilApp = C.aMilApp;
    var aUnemp = C.aUnemp, aLF = C.aLF, aFarm = C.aFarm, aInd = C.aInd, aServ = C.aServ, aGov = C.aGov, aMil = C.aMil;
    var aRebel = C.aRebel, aInc = C.aInc, aWlt = C.aWlt, aInf = C.aInf, aMin = C.aMin, aMultW = C.aMultW, aWorkW = C.aWorkW;
    var aMilW2 = C.aMilW2;
    var alive = P.alive, region = P.region, origin = P.origin, age = P.age, weight = P.weight, job = P.job, cc = P.cc;
    var happy = P.happy, approval = P.approval, econ = P.econ, auth = P.auth, nat = P.nat, radical = P.radical;
    var flags = P.flags, infect = P.infect, income = P.income, wealth = P.wealth, skill = P.skill;
    var n = P.n, infTotal = 0, liveCount = 0, totW = 0, r;
    for (var i = 0; i < n; i++) {
      if (!alive[i]) continue;
      liveCount++;
      r = region[i];
      var cid = (r >= 0 && r < nR) ? rOwner[r] : -1;
      cc[i] = cid;
      if (cid < 0) continue;
      var w = weight[i];
      totW += w;
      aW[cid] += w; lCount[cid]++;
      rPopW[r] += w; rCount[r]++;
      if (infect[i] === 1) { aInf[cid] += w; rInfW[r] += w; infTotal++; }
      if (origin[i] !== cid) aMin[cid] += w;
      var jb = job[i];
      if (jb >= FARM && jb <= MIL) {
        aMultW[cid] += w * SECT_MULT[jb] * (0.5 + skill[i]);
        if (jb === SERV) aServ[cid] += w;
        else if (jb === FARM) aFarm[cid] += w;
        else if (jb === IND) aInd[cid] += w;
        else if (jb === GOVJ) aGov[cid] += w;
        else { aMil[cid] += w; if (slow) { aMilW2[cid] += w; aMilApp[cid] += w * approval[i]; } }
      } else if (jb === UNEMP) aUnemp[cid] += w;
      else if (jb === REBEL) aRebel[cid] += w;
      if (slow && age[i] >= 16) {
        aAdW[cid] += w;
        aHap[cid] += w * happy[i];
        aApp[cid] += w * approval[i];
        var e = econ[i], a = auth[i], t = nat[i];
        aE[cid] += w * e; aE2[cid] += w * e * e;
        aA[cid] += w * a; aA2[cid] += w * a * a;
        aNt[cid] += w * t; aNt2[cid] += w * t * t;
        if (radical[i] > 0.6) aRad[cid] += w;
        if (flags[i] & F_PROTEST) aProt[cid] += w;
        aInc[cid] += w * income[i];
        aWlt[cid] += w * wealth[i];
      }
    }
    P.infTotal = infTotal; P._aggLive = liveCount; P._aggTotW = totW;
    for (var id = 0; id < aN.length && id < lCount.length; id++) {
      aN[id] = lCount[id];
      var wk = aFarm[id] + aInd[id] + aServ[id] + aGov[id] + aMil[id];
      aWorkW[id] = wk; aLF[id] = wk + aUnemp[id];
    }
  }

  function aggLists(P, C, nC, nR) {
    var lCount = C.lCount, lStart = C.lStart, rCount = P.rCount, rStart = P.rStart;
    var alive = P.alive, region = P.region, cc = P.cc, n = P.n, id, r, i;
    // lists (counting sort by country and by region)
    var acc = 0;
    for (id = 0; id < nC; id++) { lStart[id] = acc; acc += lCount[id]; }
    acc = 0;
    for (r = 0; r < nR; r++) { rStart[r] = acc; acc += rCount[r]; }
    var cList = P.cList, rList = P.rList;
    var cCur = P._cCur && P._cCur.length >= nC ? P._cCur : (P._cCur = new Int32Array(nC + 48));
    var rCur = P._rCur && P._rCur.length >= nR ? P._rCur : (P._rCur = new Int32Array(nR + 1));
    for (id = 0; id < nC; id++) cCur[id] = lStart[id];
    for (r = 0; r < nR; r++) rCur[r] = rStart[r];
    for (i = 0; i < n; i++) {
      if (!alive[i]) continue;
      var c2 = cc[i];
      if (c2 < 0) continue;
      cList[cCur[c2]++] = i;
      var r2 = region[i];
      rList[rCur[r2]++] = i;
    }
    P.listsOk = true;
  }

  function aggPublish(W, P, C, nC, slow) {
    var cs = W.countries, lStart = C.lStart, lCount = C.lCount, cList = P.cList, age = P.age, income = P.income, k, id;
    var aW = C.aW, aN = C.aN, aAdW = C.aAdW, aHap = C.aHap, aApp = C.aApp, aE = C.aE, aA = C.aA, aNt = C.aNt;
    var aE2 = C.aE2, aA2 = C.aA2, aNt2 = C.aNt2, aRad = C.aRad, aProt = C.aProt, aMilW = C.aMilW, aMilApp = C.aMilApp;
    var aUnemp = C.aUnemp, aLF = C.aLF, aFarm = C.aFarm, aInd = C.aInd, aServ = C.aServ, aGov = C.aGov, aMil = C.aMil;
    var aRebel = C.aRebel, aInc = C.aInc, aWlt = C.aWlt, aInf = C.aInf, aMin = C.aMin, aMultW = C.aMultW, aWorkW = C.aWorkW;
    // publish
    var tick = W.tick | 0, sortBuf = P.sortBuf;
    for (id = 0; id < nC; id++) {
      var c = cs[id];
      if (!c) continue;
      if (!c.alive) {
        c.pop = 0; c.agents = 0; c.deathsW = 0; c.birthsW = 0; c.emigW = 0; c.immigW = 0;
        C.cDeath[id] = 0; C.cBirth[id] = 0; C.cEmig[id] = 0; C.cImmig[id] = 0;
        continue;
      }
      var W_ = aW[id], ad = aAdW[id];
      c.pop = W_;
      c.agents = aN[id];
      if (!slow) {
        // moods/ideology/wealth keep the values of the last slow pass (<= 3 ticks old)
      } else if (ad > 0) {
        c.happiness = clamp(aHap[id] / ad, 0, 1);
        c.approval = clamp(aApp[id] / ad, 0, 1);
        var me = aE[id] / ad, ma = aA[id] / ad, mn = aNt[id] / ad;
        c.ideoEcon = clamp(me, -1, 1); c.ideoAuth = clamp(ma, -1, 1); c.ideoNat = clamp(mn, 0, 1);
        var ve = Math.max(0, aE2[id] / ad - me * me), va = Math.max(0, aA2[id] / ad - ma * ma), vn = Math.max(0, aNt2[id] / ad - mn * mn);
        c.polarization = clamp((ve + va + vn) / 0.6, 0, 1);
        c.radicalShare = clamp(aRad[id] / ad, 0, 1);
        c.protestShare = clamp(aProt[id] / ad, 0, 1);
        c.avgIncome = aInc[id] / ad;
        c.avgWealth = aWlt[id] / ad;
      } else {
        if (c.happiness === undefined) c.happiness = 0.5;
        if (c.approval === undefined) c.approval = 0.5;
        c.ideoEcon = num(c.ideoEcon, 0); c.ideoAuth = num(c.ideoAuth, 0); c.ideoNat = num(c.ideoNat, 0.5);
        c.polarization = num(c.polarization, 0); c.radicalShare = 0; c.protestShare = 0;
        c.avgIncome = num(c.avgIncome, 0); c.avgWealth = num(c.avgWealth, 0);
      }
      if (slow || c.milApproval === undefined) c.milApproval = C.aMilW2[id] > 0 ? clamp(aMilApp[id] / C.aMilW2[id], 0, 1) : num(c.approval, 0.5);
      c.unemployment = aLF[id] > 0 ? clamp(aUnemp[id] / aLF[id], 0, 1) : 0;
      c.laborForce = aLF[id];
      c.rebels = aRebel[id];
      var wk = c.workers;
      if (!wk || typeof wk !== 'object') wk = c.workers = { farm: 0, industry: 0, services: 0, gov: 0, military: 0 };
      wk.farm = aFarm[id]; wk.industry = aInd[id]; wk.services = aServ[id]; wk.gov = aGov[id]; wk.military = aMil[id];
      c.infected = W_ > 0 ? clamp(aInf[id] / W_, 0, 1) : 0;
      c.minorityShare = W_ > 0 ? clamp(aMin[id] / W_, 0, 1) : 0;
      c.deathsW = C.cDeath[id]; c.birthsW = C.cBirth[id]; c.emigW = C.cEmig[id]; c.immigW = C.cImmig[id];
      // per-year rolling figures (a weekly count is mostly 0 or one agent's weight): mean over up to 52 weeks
      var kn = c._statN = Math.min(52, (c._statN | 0) + 1);
      c.birthsY = num(c.birthsY, 0) + (C.cBirth[id] * 52 - num(c.birthsY, 0)) / kn;
      c.deathsY = num(c.deathsY, 0) + (C.cDeath[id] * 52 - num(c.deathsY, 0)) / kn;
      c.emigY = num(c.emigY, 0) + (C.cEmig[id] * 52 - num(c.emigY, 0)) / kn;
      c.immigY = num(c.immigY, 0) + (C.cImmig[id] * 52 - num(c.immigY, 0)) / kn;
      C.cDeath[id] = 0; C.cBirth[id] = 0; C.cEmig[id] = 0; C.cImmig[id] = 0;
      if (c.refugeesOut === undefined) c.refugeesOut = 0;
      var nm = aWorkW[id] > 0 ? aMultW[id] / aWorkW[id] : 1;
      C.normMult[id] = nm > 0.05 ? nm : 1;
      if (!(C.baseW[id] > 0) && aN[id] > 0) C.baseW[id] = W_ / aN[id];
      // gini of adult incomes (monthly, staggered)
      if (c.gini === undefined || ((tick + id) & 3) === 0) {
        var st = lStart[id], cnt = lCount[id], m = 0, stride = cnt > 300 ? Math.ceil(cnt / 300) : 1;
        for (k = 0; k < cnt; k += stride) { var ii = cList[st + k]; if (age[ii] >= 16) sortBuf[m++] = income[ii]; }
        if (m >= 2) {
          var sub = sortBuf.subarray(0, m);
          sub.sort();
          var s1 = 0, s2 = 0;
          for (k = 0; k < m; k++) { s1 += sub[k]; s2 += (k + 1) * sub[k]; }
          c.gini = s1 > 0 ? clamp(2 * s2 / (m * s1) - (m + 1) / m, 0, 1) : 0;
        } else c.gini = 0;
      }
    }
  }

  // ------------------------------------------------------------------
  // kill
  // ------------------------------------------------------------------
  function causeText(cause) {
    var c = String(cause || '').toLowerCase();
    if (c === 'war' || c === 'battle' || c === 'combat' || c === 'front') return 'killed in battle';
    if (c === 'civilian' || c === 'bombing' || c === 'shelling' || c === 'occupation') return 'killed in the fighting';
    if (c.indexOf('nuk') >= 0 || c.indexOf('nuclear') >= 0) return 'killed in a nuclear blast';
    if (c === 'disaster' || c === 'earthquake' || c === 'tsunami') return 'killed in a natural disaster';
    if (c === 'meteor') return 'killed by a meteor impact';
    if (c === 'famine' || c === 'hunger' || c === 'starvation') return 'starved to death';
    if (c === 'plague' || c === 'disease') return 'died of the plague';
    if (c === 'execution' || c === 'purge' || c === 'repression' || c === 'massacre') return 'was killed by the regime';
    if (c === 'civilwar' || c === 'civil_war' || c === 'rebellion') return 'killed in the civil war';
    return 'died (' + (cause || 'unknown causes') + ')';
  }

  function kill(W, filter) {
    var P = W.people;
    if (!P || !filter) return 0;
    ensureC(W, P); ensureR(W, P);
    var cause = filter.cause || 'unknown';
    var silent = cause === 'vanished';
    var text = silent ? '' : causeText(cause);
    var jobsMask = 0, jb = filter.jobs, k;
    if (typeof jb === 'number') jobsMask = 1 << jb;
    else if (jb && jb.length) for (k = 0; k < jb.length; k++) jobsMask |= 1 << (jb[k] | 0);
    var flagMask = filter.flags | 0;
    var rid = (filter.region === undefined || filter.region === null) ? -1 : idOf(filter.region);
    var cid = (filter.country === undefined || filter.country === null) ? -1 : idOf(filter.country);
    var alive = P.alive, region = P.region, job = P.job, flags = P.flags, weight = P.weight;
    var scratch = P.scratch, m = 0, sumW = 0, i;
    function test(i2) {
      if (!alive[i2]) return;
      if (jobsMask && !((1 << job[i2]) & jobsMask)) return;
      if (flagMask && !(flags[i2] & flagMask)) return;
      scratch[m++] = i2; sumW += weight[i2];
    }
    var useLists = P.listsOk;
    if (rid >= 0) {
      if (rid >= P.nR) return 0;
      if (cid >= 0 && ownerOf(W, rid) !== cid) return 0;
      if (useLists) {
        var st = P.rStart[rid], cn = P.rCount[rid];
        for (k = 0; k < cn; k++) { i = P.rList[st + k]; if (region[i] === rid) test(i); }
      } else for (i = 0; i < P.n; i++) if (region[i] === rid) test(i);
    } else if (cid >= 0) {
      var c = W.countries[cid];
      var regsC = c && c.regions;
      if (useLists && regsC) {
        for (var q = 0; q < regsC.length; q++) {
          var rr = regsC[q] | 0;
          if (rr < 0 || rr >= P.nR || ownerOf(W, rr) !== cid) continue;
          var st2 = P.rStart[rr], cn2 = P.rCount[rr];
          for (k = 0; k < cn2; k++) { i = P.rList[st2 + k]; if (region[i] === rr) test(i); }
        }
      } else for (i = 0; i < P.n; i++) if (alive[i] && ownerOf(W, region[i]) === cid) test(i);
    } else {
      for (i = 0; i < P.n; i++) test(i);
    }
    if (!m || !(sumW > 0)) return 0;
    var frac = num(filter.fraction, 0);
    if (typeof filter.count === 'number' && filter.count > 0) frac = filter.count / sumW;
    frac = clamp(frac, 0, 1);
    if (frac <= 0) return 0;
    var rng = W.rng, killed = 0, C = P.C;
    var warLike = /war|battle|combat|front|bomb|shell/.test(String(cause).toLowerCase());
    if (frac >= 1 || m * frac >= 2) {
      for (k = 0; k < m; k++) {
        i = scratch[k];
        if (frac >= 1 || rng.next() < frac) killed += killOne(W, P, i, text, silent);
      }
    } else {
      // too few agents for whole-agent sampling: thin weights so expected deaths stay smooth
      for (k = 0; k < m; k++) {
        i = scratch[k];
        if (!alive[i]) continue;
        var w = weight[i], d = w * frac;
        var o = ownerOf(W, region[i]);
        var bw = (o >= 0 && o < P.capC && C.baseW[o] > 0) ? C.baseW[o] : P.avgW;
        if (w - d < 0.25 * bw && rng.next() < 0.5) { killed += killOne(W, P, i, text, silent); continue; }
        weight[i] = w - d; killed += d;
        if (!silent && o >= 0 && o < P.capC) C.cDeath[o] += d;
        if (warLike && (job[i] === 6 || job[i] === 8) && rng.next() < 0.15) { // only combatants are 'wounded'
          P.health[i] = clamp(P.health[i] - 0.2, 0.01, 1);
          logEvent(W, i, 'was wounded; many comrades died');
        }
      }
    }
    return killed;
  }

  // ------------------------------------------------------------------
  // infect (seed plague)
  // ------------------------------------------------------------------
  function seedInfection(W, region, count, severity) {
    var P = W.people;
    if (!P) return 0;
    ensureC(W, P); ensureR(W, P);
    var rid = idOf(region);
    if (rid < 0 || rid >= P.nR || ownerOf(W, rid) < 0) return 0;
    var oc = ownerOf(W, rid), C = P.C;
    var s = (typeof severity === 'number' && isFinite(severity)) ? clamp(severity > 1 ? severity / 5 : severity, 0, 1) : -1;
    if (s >= 0) P.sev = s; // last seeded strain (display / fallback only)
    else s = C.sevC[oc] > 0 ? C.sevC[oc] : clamp(num(P.sev, 0.5), 0, 1);
    // per-country strain: a new outbreak mixes with (not upgrades) the one already there, weighted by cases
    var have = C.aInf[oc] > 0 && C.sevC[oc] > 0 ? C.aInf[oc] : 0, add = Math.max(1, num(count, 1)) * (C.baseW[oc] > 0 ? C.baseW[oc] : P.avgW);
    C.sevC[oc] = have > 0 ? (C.sevC[oc] * have + s * add) / (have + add) : s;
    C.sevT[oc] = W.tick | 0;
    var want = Math.max(1, Math.round(num(count, 1)));
    var alive = P.alive, inf = P.infect, regionA = P.region, scratch = P.scratch, m = 0, i, k;
    if (P.listsOk) {
      var st = P.rStart[rid], cn = P.rCount[rid];
      for (k = 0; k < cn; k++) { i = P.rList[st + k]; if (alive[i] && inf[i] === 0 && regionA[i] === rid) scratch[m++] = i; }
    }
    if (m === 0) for (i = 0; i < P.n; i++) if (alive[i] && inf[i] === 0 && regionA[i] === rid) scratch[m++] = i;
    if (!m) return 0;
    var rng = W.rng, got = 0;
    for (k = 0; k < m && got < want; k++) {
      var j = k + ((rng.next() * (m - k)) | 0);
      var t = scratch[k]; scratch[k] = scratch[j]; scratch[j] = t;
      i = scratch[k];
      inf[i] = 1; got++;
      logEvent(W, i, 'fell ill with the plague');
    }
    P.infTotal += got;
    if (W.global) W.global.plagueActive = true;
    return got;
  }

  // ------------------------------------------------------------------
  // onCountryRemoved
  // ------------------------------------------------------------------
  function onCountryRemoved(W, c, mode) {
    var P = W.people;
    if (!P) return;
    ensureC(W, P); ensureR(W, P);
    var cid = idOf(c);
    var co = cid >= 0 ? W.countries[cid] : null;
    if (!mode && co) mode = co.removedMode || co.deathMode || co.diedMode || co.endMode;
    var erased = mode === 'erased';
    var fallText = co && co.name ? 'lived through the fall of ' + co.name : '';
    var alive = P.alive, region = P.region, cc = P.cc;
    for (var i = 0; i < P.n; i++) {
      if (!alive[i]) continue;
      var o = ownerOf(W, region[i]);
      if (o === -1 || (erased && o === cid)) { killOne(W, P, i, 'vanished', true); continue; }
      if (!erased && cc[i] === cid && fallText) logEvent(W, i, fallText);
    }
    if (cid >= 0 && cid < P.capC) {
      var C = P.C;
      C.alive[cid] = 0; C.candN[cid] = 0; C.candOk[cid] = 0;
      C.lCount[cid] = 0;
    }
  }

  // ------------------------------------------------------------------
  // queries for UI / other modules
  // ------------------------------------------------------------------
  function name(W, i) {
    var P = W.people;
    if (!P || i < 0 || i >= P.n) return '';
    var N = GS.Names, cu = cultureOf(W, P.origin[i]);
    if (N && typeof N.str === 'function') {
      var s = N.str(cu, P.sex[i], P.first[i], P.last[i]);
      if (s) return s;
    }
    return 'Citizen #' + i;
  }

  function randomCitizen(W, countryId) {
    var P = W.people;
    if (!P) return -1;
    var cid = idOf(countryId);
    var rr = P.uiRng;
    var wr = W.rng;
    var rnd = rr ? function () { return rr.next(); } : function () { return wr.next(); };
    var k, i;
    if (cid >= 0 && cid < P.capC && P.listsOk) {
      var st = P.C.lStart[cid], cn = P.C.lCount[cid];
      if (cn > 0) {
        for (k = 0; k < 24; k++) {
          i = P.cList[st + ((rnd() * cn) | 0)];
          if (P.alive[i] && countryOf(W, i) === cid) return i;
        }
      }
    }
    if (!P.n) return -1;
    var s = (rnd() * P.n) | 0;
    for (k = 0; k < P.n; k++) {
      i = (s + k) % P.n;
      if (P.alive[i] && (cid < 0 || countryOf(W, i) === cid)) return i;
    }
    return -1;
  }

  function ideologyText(e, a, n) {
    var parts = [];
    parts.push(e < -0.6 ? 'far-left' : e < -0.25 ? 'left-wing' : e < -0.08 ? 'center-left' :
      e <= 0.08 ? 'centrist' : e < 0.25 ? 'center-right' : e < 0.6 ? 'right-wing' : 'far-right');
    if (a < -0.5) parts.push('libertarian');
    else if (a < -0.2) parts.push('liberal');
    else if (a > 0.6) parts.push('authoritarian');
    else if (a > 0.25) parts.push('law-and-order');
    if (n > 0.8) parts.push('ultranationalist');
    else if (n > 0.6) parts.push('nationalist');
    else if (n > 0.42) parts.push('mildly nationalist');
    else if (n < 0.15) parts.push('cosmopolitan');
    return parts.join(', ');
  }

  function describe(W, i) {
    var P = W.people;
    if (!P || i < 0 || i >= P.n) return null;
    var C = P.C;
    var cid = countryOf(W, i), org = P.origin[i];
    var reg = W.regions[P.region[i]];
    var a = P.age[i], j = P.job[i], fl = P.flags[i];
    var gpc = (cid >= 0 && cid < P.capC && C.gdppc[cid] > 0) ? C.gdppc[cid] : 10000;
    var st = [];
    var isAlive = !!P.alive[i];
    if (!isAlive) st.push('deceased');
    if (fl & F_PROTEST) st.push('protesting');
    if (fl & F_FRONT) st.push(j === REBEL ? 'fighting for the rebels' : 'at the front');
    if (fl & F_REFUGEE) st.push('refugee');
    if (fl & F_MIGRANT) st.push('immigrant');
    if (org !== cid && !(fl & (F_REFUGEE | F_MIGRANT))) st.push('ethnic minority');
    if (P.infect[i] === 1) st.push('sick with the plague');
    else if (P.infect[i] === 2) st.push('plague survivor');
    if (j === REBEL) st.push('rebel');
    if (j === UNEMP) st.push('unemployed');
    if (P.radical[i] > 0.6) st.push('radicalized');
    if (P.happy[i] < 0.3) st.push('miserable'); else if (P.happy[i] > 0.72) st.push('content');
    if (P.approval[i] < 0.25) st.push('hates the government'); else if (P.approval[i] > 0.75) st.push('loyal to the government');
    if (a >= 16) {
      if (P.wealth[i] > gpc * 15) st.push('wealthy');
      else if (P.wealth[i] < gpc * 0.1) st.push('poor');
    }
    if (P.health[i] < 0.35) st.push('in poor health');
    var L = P.log.get(i) || [], log = [];
    for (var k = 0; k < L.length; k++) {
      var en = L[k], ds = '';
      if (GS.dateOf) { try { var dd = GS.dateOf(en.tick); ds = dd && (dd.full || dd.str) || ''; } catch (e) { ds = ''; } }
      log.push({ tick: en.tick, date: ds, text: en.text });
    }
    var bornStr = '';
    if (GS.dateOf) { try { var bd = GS.dateOf(P.born[i]); bornStr = bd && bd.str || ''; } catch (e2) { bornStr = ''; } }
    return {
      index: i, alive: isAlive,
      name: name(W, i),
      age: Math.floor(a), sex: P.sex[i] ? 'female' : 'male',
      job: jobLabelOf(j, P.skill[i], a), jobId: j,
      country: cid >= 0 ? cname(W, cid) : 'nowhere', countryId: cid,
      origin: cname(W, org), originId: org,
      region: (reg && reg.name) || '', regionId: P.region[i],
      wealth: P.wealth[i], income: P.income[i],
      happy: P.happy[i], approval: P.approval[i], radical: P.radical[i], health: P.health[i],
      econ: P.econ[i], auth: P.auth[i], nat: P.nat[i],
      ideology: ideologyText(P.econ[i], P.auth[i], P.nat[i]),
      status: st, statusText: st.join(', '),
      infect: P.infect[i], flags: fl, weight: P.weight[i],
      born: P.born[i], bornStr: bornStr,
      log: log
    };
  }

  function jobLabel(W, i) {
    var P = W.people;
    if (!P || i < 0 || i >= P.n) return '';
    return jobLabelOf(P.job[i], P.skill[i], P.age[i]);
  }

  GS.People = {
    init: init,
    step: step,
    aggregate: aggregate,
    kill: kill,
    spawn: spawn,
    move: move,
    colonize: colonize,
    countryOf: countryOf,
    name: name,
    describe: describe,
    randomCitizen: randomCitizen,
    infect: seedInfection,
    onCountryRemoved: onCountryRemoved,
    logEvent: logEvent,
    // extras
    jobLabel: jobLabel,
    ideologyText: ideologyText,
    FLAGS: { PROTEST: F_PROTEST, REFUGEE: F_REFUGEE, AT_FRONT: F_FRONT, MIGRANT: F_MIGRANT },
    JOB_NAMES: ['child', 'unemployed', 'farm', 'industry', 'services', 'government', 'military', 'retired', 'rebel']
  };
})();
