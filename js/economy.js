// GODSIM — economy.js  (GS.Economy)
// Bottom-up macro model: Cobb-Douglas potential (capital, labor from agents, TFP with catch-up),
// demand factor (confidence, partners' import demand, fear, war, sanctions, commodities, fiscal),
// gravity trade matrix with asymmetric adjustment, commodity markets, budgets/debt/default,
// inflation/currency, stock indices, global market & fear, reserve currencies.
// Nothing here refers to any specific country: every rule is generic.
(function () {
  'use strict';
  var GS = globalThis.GS = globalThis.GS || {};
  // local aliases: global-name lookups are slow inside Node vm contexts
  var M = Math, F64 = Float64Array, F32 = Float32Array, U8 = Uint8Array, U32 = Uint32Array, I32 = Int32Array, isArr = Array.isArray;

  // ------------------------------------------------------------------ constants
  var ALPHA = 0.35, DELTA = 0.05;
  var OIL_P0 = 75, OIL_K = 280;        // $B/yr of oil output for oil==1 at OIL_P0
  var FOOD_P0 = 100, FOOD_SHARE = 0.015; // world traded food value as share of world GDP
  var FEAR0 = 0.09;                    // "normal" fear level
  var FRONTIER0 = 72000;               // $ GDP per capita technology frontier at start
  var LOG10E = M.LOG10E;
  var EMPTY = {};
  var TYPE = 'economy';

  // ------------------------------------------------------------------ helpers
  function num(x, d) { return (typeof x === 'number' && x - x === 0) ? x : d; }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : (x === x ? x : a)); }
  function devOf(gpc) { return clamp((M.log(M.max(gpc, 1)) * LOG10E - 2.85) / 2, 0, 1); }
  function rn(W) { return (W.rng && W.rng.normal) ? num(W.rng.normal(), 0) : 0; }
  function ru(W) { return (W.rng && W.rng.next) ? num(W.rng.next(), 0.5) : 0.5; }
  function alive(c) { return !!(c && c.alive); }
  function money(b) { return (GS.U && GS.U.fmtMoney) ? GS.U.fmtMoney(b) : ('$' + M.round(b) + 'B'); }
  function pct(x, d) { return (x * 100).toFixed(d === void 0 ? 0 : d) + '%'; }
  function post(W, text, countries, importance) {
    if (typeof GS.news === 'function') GS.news(W, text, { type: TYPE, countries: countries || [], importance: importance || 2 });
  }
  function anarchyOf(c) { return c.gov === 'anarchy' ? 1 : 0; }
  function popOf(c) {
    var p = num(c.pop, 0);
    if (!(p > 0)) p = num(c.pop0, num(c.data && c.data.pop, 0.01)) * 1e6;
    return M.max(p, 1000);
  }
  function laborForceM(c, popP) {
    var w = c.workers, emp = 0;
    if (w && typeof w === 'object') emp = num(w.farm, 0) + num(w.industry, 0) + num(w.services, 0) + num(w.gov, 0) + num(w.military, 0);
    if (emp > 0) {
      var u = clamp(num(c.unemployment, 0.07), 0, 0.9);
      return M.max(emp / (1 - u), 1) / 1e6;
    }
    return popP * 0.45 / 1e6;
  }
  function employed(c, popP) {
    var w = c.workers, emp = 0;
    if (w && typeof w === 'object') emp = num(w.farm, 0) + num(w.industry, 0) + num(w.services, 0) + num(w.gov, 0) + num(w.military, 0);
    return emp > 0 ? emp : popP * 0.42;
  }
  function cobb(tfp, K, L) {
    if (!(K > 0) || !(L > 0)) return 0;
    var y = tfp * M.pow(K, ALPHA) * M.pow(L, 1 - ALPHA);
    return y > 0 && y < 1e9 ? y : 0;
  }
  function policyVal(pol, key, def, hi) {
    if (!pol) return def;
    var v = num(pol[key], 0 / 0);
    if (!(v === v)) return def;
    if (v > 1.0001) v = v / 100; // tolerate percentages
    return clamp(v, 0, hi);
  }
  function distKm(W, NC, a, b) {
    var d = W.dist ? num(W.dist[a * NC + b], 0) : 0;
    if (d > 0) return d;
    var cs = W.countries, ca = cs[a], cb = cs[b];
    var pa = capLL(W, ca), pb = capLL(W, cb);
    if (pa && pb && GS.Geo && GS.Geo.haversineKm) {
      d = num(GS.Geo.haversineKm(pa[0], pa[1], pb[0], pb[1]), 0);
      if (d > 0) return d;
    }
    return 6000;
  }
  function capLL(W, c) {
    if (!c) return null;
    var r = W.regions && W.regions[c.capital];
    if (r && r.lon === r.lon && r.lat === r.lat && typeof r.lon === 'number') return [r.lon, r.lat];
    if (c.data && c.data.capLonLat) return c.data.capLonLat;
    return null;
  }
  function warSides(w) {
    var A = isArr(w.attackers) ? w.attackers : (w.attacker !== void 0 && w.attacker !== null ? [w.attacker] : []);
    var D = isArr(w.defenders) ? w.defenders : (w.defender !== void 0 && w.defender !== null ? [w.defender] : []);
    return [A, D];
  }
  function cid(x) { return (typeof x === 'object' && x) ? (x.id | 0) : (x | 0); }

  // ------------------------------------------------------------------ module state (per world)
  function S_(W) {
    var S = W._eco;
    if (!S) S = W._eco = newState(W);
    var n = W.countries.length;
    if (S.cap < n) growScratch(S, n + 32);
    var R = W.regions ? W.regions.length : 0;
    if (S.lastOwner.length !== R) {
      var lo = new I32(R), rp = new F32(R);
      for (var r = 0; r < R; r++) lo[r] = W.regions[r] ? (W.regions[r].owner | 0) : -1;
      S.lastOwner = lo; S.regionPop = rp; S.regionPopTick = -999;
    }
    return S;
  }
  function newState(W) {
    var S = {
      settled: false, initDone: false, cap: 0,
      lastOwner: new I32(0), regionPop: new F32(0), regionPopTick: -999,
      flags: null, flagsNC: 0,
      sw: 0, swPrev: 0, lnFw: 0, mom: 0, gshock: 0, lastRet: 0,
      oilNoise: 0, foodNoise: 0, oilResp: 1, foodResp: 1,
      worldGDP0: 0, worldPop0: 0, oilSupply0: 0, foodSupply0: 0, oilWorldVal0: 0, foodWorldVal0: 0,
      prevWorldGDP: 0, worldInfl: 0.03, fearPrev: FEAR0,
      warSeen: new Set(), nukesSeen: 0,
      ath: 1000, lastRecordTick: -9999,
      mRing: new F64(5), oRing: new F64(5), fRing: new F64(5),
      cool: { crash: -9999, oilUp: -9999, oilDown: -9999, food: -9999, worldRec: -9999, panic: -9999, reserve: -9999, recNews: -9999 },
      topReserve: -1, top20: [], defQ: []
    };
    growScratch(S, (W.countries ? W.countries.length : 0) + 32);
    return S;
  }
  function growScratch(S, n) {
    S.cap = n;
    S.sancP = new F64(n);
    S.atWar = new U8(n);
    S.oilAv = new F64(n);
    S.maskLo = new U32(n); S.maskHi = new U32(n);
    S.tmpA = new F64(n); S.tmpB = new F64(n); S.tmpC = new F64(n); S.tmpD = new F64(n);
    S.ovl = new I32(n); S.pat = new I32(n); S.ovlTr = new F64(n); S.patTs = new F64(n);
  }
  function ensureFlags(W, S) {
    var NC = W.NC | 0;
    if (!S.flags || S.flagsNC !== NC) { S.flags = new U8(NC * NC); S.flagsNC = NC; }
    return S.flags;
  }
  function ensureGlobal(W) {
    var G = W.global || (W.global = {});
    G.worldGDP = num(G.worldGDP, 0);
    G.worldGrowth = num(G.worldGrowth, 0.03);
    G.worldPop = num(G.worldPop, 0);
    G.marketIndex = num(G.marketIndex, 1000);
    G.oilPrice = num(G.oilPrice, OIL_P0);
    G.foodPrice = num(G.foodPrice, FOOD_P0);
    G.fear = clamp(num(G.fear, FEAR0), 0, 1);
    G.baseRate = num(G.baseRate, 0.04);
    G.tradeVolume = num(G.tradeVolume, 0);
    G.nukesUsed = num(G.nukesUsed, 0);
    var NC = W.NC | 0;
    if (!G.reserveShares || G.reserveShares.length < NC) {
      var rs = new F32(NC);
      if (G.reserveShares) for (var i = 0; i < G.reserveShares.length; i++) rs[i] = num(G.reserveShares[i], 0);
      G.reserveShares = rs;
    }
    return G;
  }
  function ensureTrade(W) {
    var NC = W.NC | 0;
    if (!W.trade || W.trade.length < NC * NC) {
      var t = new F32(NC * NC);
      W.trade = t;
    }
    return W.trade;
  }

  // ------------------------------------------------------------------ per-country growth fundamentals
  function frontier(W) { return FRONTIER0 * M.exp(0.014 * num(W.tick, 0) / 52); }
  function computeGA(W, c, dev, gpc) {
    var d = c.data || EMPTY;
    var gap = clamp(M.log(frontier(W) / M.max(gpc, 100)), 0, 3.2);
    var corr = clamp(num(c.corruption, num(d.corruption, 0.5)), 0, 1);
    var stab = clamp(num(c.stability, 0.65), 0, 1);
    var inst = (1 - 0.6 * corr) * (0.45 + 0.55 * stab) * (anarchyOf(c) ? 0.15 : 1) * (c.civilWar ? 0.5 : 1);
    var absorb = 0.45 + 0.55 * M.min(1, dev * 1.6);
    return clamp(0.0065 + 0.0145 * gap * inst * absorb, -0.02, 0.06);
  }
  function piBaseOf(c, dev) {
    var corr = clamp(num(c.corruption, num(c.data && c.data.corruption, 0.5)), 0, 1);
    return 0.02 + 0.03 * (1 - dev) + 0.03 * corr * (1 - dev);
  }
  function uNatOf(dev) { return 0.05 + 0.06 * (1 - dev); }

  function bondYield(W, c, e, dev, rs) {
    var G = W.global;
    var infl = clamp(num(c.inflation, 0.03), -0.05, 5);
    var dr = clamp(num(c.debtRatio, 0.5), 0, 20);
    var stab = clamp(num(c.stability, 0.65), 0, 1);
    var lim = M.max(0.6 + 0.8 * dev + 1.5 * rs, e ? num(e.dr0, 0) * 1.05 : 0);
    var risk = 0.012 * (1 - dev) + 0.03 * M.max(0, dr - lim) * (1 + 2 * (1 - dev)) + 0.03 * (1 - stab) +
      (c.atWar ? 0.015 : 0) + (c.civilWar ? 0.05 : 0) + 0.2 * anarchyOf(c) +
      0.04 * M.max(0, G.fear - 0.05) * (1 - dev * 0.6) + (c.defaulted ? 0.25 : 0) + 0.05 * (e ? e.sancP : 0);
    var wi = (W._eco && W._eco.worldInfl === W._eco.worldInfl) ? clamp(W._eco.worldInfl, 0, 0.3) : 0.03;
    return clamp(G.baseRate + 0.85 * (infl - wi) + risk - 0.025 * M.sqrt(M.max(0, rs)), 0.002, 1.5);
  }

  // Basic field initialisation (used at world creation and for new countries).
  function baseInit(W, c, gdp, popP, noRng) {
    var d = c.data || EMPTY, G = W.global;
    gdp = M.max(0.05, num(gdp, 1));
    var gpc = gdp * 1e9 / popP, dev = devOf(gpc);
    var id = c.id | 0;
    c.oil = num(c.oil, num(d.oil, 0));
    c.food = num(c.food, num(d.food, 0));
    c.minerals = num(c.minerals, num(d.minerals, 0));
    c.gdp = gdp; c.gdpPotential = gdp; c.gdpPerCap = clamp(gpc, 50, 1e6);
    var e = c.eco = {
      D: 1, L: laborForceM(c, popP), xRef: 0, lnF: 0, idio: 0, lnPPP: 0, real: 0, fxd: 0,
      hap0: 0.5, stab0: 0.6, u0: 0.07, uS: 0.07, gapI: 0, dBias: 1, shock: 0, wshock: 0, defShock: 0,
      gA: 0.01, gPot: 0.02, s0: 0.21 + 0.04 * (1 - dev), piBase: 0.03, effRate: 0.04, def0: 0.03,
      open: 0.3, openM: 0.3, tr: 1, ts: 1, devAvg: 0, sancP: 0, oilAv: 1,
      tax0: 0.25, wel0: 0.1, mil0: 0.02, other0: 0.12, fScale: 0, resQ0: 0,
      defTick: -9999, ring: new F64(13), ringN: 0,
      coolRec: -9999, coolHyper: -9999, coolFx: -9999, fxMonth: 0,
      prevGdp: gdp, fresh: false, dev: dev
    };
    e.gA = computeGA(W, c, dev, gpc);
    e.gPot = e.gA / (1 - ALPHA) + 0.005;
    var K = gdp * e.s0 / (DELTA + e.gPot);
    c.capStock = K;
    c.tfp = gdp / M.max(1e-9, M.pow(K, ALPHA) * M.pow(M.max(e.L, 1e-6), 1 - ALPHA));
    c.growth = e.gPot;
    e.piBase = piBaseOf(c, dev);
    c.inflation = e.piBase;
    // debt: data value if present (ratio or percent), otherwise a generic development-based estimate
    var dr = num(d.debt, 0 / 0);
    if (dr === dr) { if (dr > 5) dr /= 100; } else dr = 0.3 + 0.6 * dev + (noRng ? 0 : 0.18 * rn(W));
    dr = clamp(dr, 0.08, 3);
    c.debtRatio = dr; c.debt = dr * gdp;
    e.dr0 = dr; // markets already tolerate the debt level a country has carried for years (deep domestic savings)
    e.mil0 = clamp(num(d.mil, 2) / 100, 0, 0.5);
    e.wel0 = clamp(0.02 + 0.13 * dev, 0, 0.5);
    e.other0 = 0.08 + 0.1 * dev;
    c.spendMil = e.mil0; c.spendWelfare = e.wel0; c.spendOther = e.other0;
    c.defaulted = !!d.inDefault && !noRng; // already in default when the world starts (data flag)
    if (c.defaulted) e.defTick = 0;
    var rs = G.reserveShares && id < G.reserveShares.length ? num(G.reserveShares[id], 0) : 0;
    c.bondYield = bondYield(W, c, null, dev, rs);
    e.effRate = c.bondYield;
    var interest = dr * e.effRate;
    e.def0 = 0.015 + (noRng ? 0.012 : 0.025 * ru(W));
    var spend = c.spendMil + c.spendWelfare + c.spendOther + interest;
    c.taxRate = clamp(spend - e.def0, 0.06, 0.55);
    e.tax0 = c.taxRate; e.dr0 = dr; e.int0 = interest;
    c.deficit = spend - c.taxRate;
    c.stockIndex = 100; c.currency = 1; c.confidence = 0.6;
    c.laborDemand = clamp(1 - uNatOf(dev), 0.5, 0.98);
    var share = 0.45 + 0.15 * dev;
    c.wage = clamp(gdp * 1e9 * share / employed(c, popP), 50, 2e6);
    c.exports = num(c.exports, 0); c.imports = num(c.imports, 0);
    c.sanctionedBy = num(c.sanctionedBy, 0);
    e.fScale = M.sqrt(M.max(0, num(c.pop0, popP / 1e6)) * gdp);
    return e;
  }

  // ------------------------------------------------------------------ init
  function init(W) {
    var S = W._eco = newState(W);
    S_(W);
    var G = ensureGlobal(W);
    ensureTrade(W);
    var cs = W.countries, n = cs.length, id;
    for (id = 0; id < n; id++) {
      var c = cs[id];
      if (!c) continue;
      if (!alive(c)) { c.eco = null; continue; }
      baseInit(W, c, num(c.gdp0, num(c.data && c.data.gdp, 1)), popOf(c), false);
    }
    initReserves(W);
    // re-derive yields/taxes now that reserve shares exist (reserve issuers borrow cheaper)
    for (id = 0; id < n; id++) {
      var cc = cs[id]; if (!alive(cc) || !cc.eco) continue;
      var rs = num(G.reserveShares[id], 0);
      cc.bondYield = bondYield(W, cc, null, cc.eco.dev, rs);
      cc.eco.effRate = cc.bondYield;
      var spend = cc.spendMil + cc.spendWelfare + cc.spendOther + cc.debtRatio * cc.eco.effRate;
      cc.taxRate = clamp(spend - cc.eco.def0, 0.06, 0.55); cc.eco.tax0 = cc.taxRate;
      cc.eco.int0 = cc.debtRatio * cc.eco.effRate; cc.eco.dr0 = cc.debtRatio;
      cc.deficit = spend - cc.taxRate;
    }
    buildTrade(W, S, false);
    worldTotals(W, S);
    S.worldGDP0 = G.worldGDP; S.prevWorldGDP = G.worldGDP; S.worldPop0 = M.max(1, G.worldPop);
    var R = W.regions ? W.regions.length : 0;
    for (var r = 0; r < R; r++) S.lastOwner[r] = W.regions[r] ? (W.regions[r].owner | 0) : -1;
    for (var k = 0; k < 5; k++) { S.mRing[k] = G.marketIndex; S.oRing[k] = G.oilPrice; S.fRing[k] = G.foodPrice; }
    S.ath = G.marketIndex;
    S.lnFw = M.log(M.max(1, G.marketIndex) / 1000);
    S.initDone = true;
  }

  function initReserves(W) {
    var G = W.global, NC = W.NC | 0, cs = W.countries, n = cs.length;
    var rs = G.reserveShares, i;
    for (i = 0; i < rs.length; i++) rs[i] = 0;
    var D = GS.DATA || EMPTY, src = D.reserveShares || {}, euro = D.eurozone || [];
    var byKey = {};
    for (i = 0; i < n; i++) if (alive(cs[i]) && cs[i].key !== void 0) byKey[String(cs[i].key)] = i;
    var used = new U8(n), k;
    for (k in src) {
      if (k === 'EU' || k === 'other') continue;
      var cidx = byKey[k];
      if (cidx !== void 0) { rs[cidx] += num(src[k], 0); used[cidx] = 1; }
    }
    // shared-currency share split by GDP across its members
    var eu = num(src.EU, 0), euGdp = 0, m = [];
    for (i = 0; i < euro.length; i++) { var ci = byKey[euro[i]]; if (ci !== void 0) { m.push(ci); euGdp += num(cs[ci].gdp, 0); } }
    for (i = 0; i < m.length; i++) { rs[m[i]] += eu * num(cs[m[i]].gdp, 0) / M.max(euGdp, 1e-9); used[m[i]] = 1; }
    // 'other' spread over remaining economies by GDP^1.5 × quality
    var oth = num(src.other, 0), wsum = 0;
    var tmp = new F64(n);
    for (i = 0; i < n; i++) {
      var c = cs[i]; if (!alive(c) || used[i] || !c.eco) continue;
      var w = M.pow(M.max(0, num(c.gdp, 0)) / 1000, 1.5) * M.pow(1 - clamp(num(c.data && c.data.corruption, 0.5), 0, 1), 2);
      tmp[i] = w; wsum += w;
    }
    if (wsum > 0) for (i = 0; i < n; i++) rs[i] += oth * tmp[i] / wsum;
    var tot = 0;
    for (i = 0; i < n && i < NC; i++) tot += rs[i];
    if (!(tot > 0)) {
      // no data: largest economy-weighted
      for (i = 0; i < n; i++) if (alive(cs[i])) { rs[i] = M.pow(M.max(0, num(cs[i].gdp, 0)), 1.5); tot += rs[i]; }
    }
    if (tot > 0) for (i = 0; i < n && i < NC; i++) rs[i] /= tot;
  }

  // ------------------------------------------------------------------ trade
  function relFactor(W, NC, a, b) {
    var r = W.rel ? num(W.rel[a * NC + b], 0) : 0;
    return clamp(1 + r / 150, 0.3, 1.7);
  }
  function buildMasks(W, S) {
    var cs = W.countries, n = cs.length, i, j;
    var lo = S.maskLo, hi = S.maskHi;
    for (i = 0; i < n; i++) { lo[i] = 0; hi[i] = 0; }
    var al = W.alliances;
    if (al && al.length) {
      for (i = 0; i < al.length; i++) {
        var A = al[i];
        if (!A || A.dissolved || A.ended || A.active === false || A.type !== 'economic') continue;
        var mem = A.members || [];
        var bit = (num(A.id, i) | 0) & 63;
        for (j = 0; j < mem.length; j++) {
          var m = cid(mem[j]); if (m < 0 || m >= n) continue;
          if (bit < 32) lo[m] |= (1 << bit) >>> 0; else hi[m] |= (1 << (bit - 32)) >>> 0;
        }
      }
    } else {
      var blocs = (GS.DATA && GS.DATA.blocs) || [], bi = {};
      for (i = 0; i < blocs.length; i++) if (blocs[i].type === 'economic') bi[blocs[i].name] = i & 63;
      for (i = 0; i < n; i++) {
        var c = cs[i]; if (!alive(c)) continue;
        var bl = (c.data && c.data.blocs) || [];
        for (j = 0; j < bl.length; j++) {
          var b = bi[bl[j]]; if (b === void 0) continue;
          if (b < 32) lo[i] |= (1 << b) >>> 0; else hi[i] |= (1 << (b - 32)) >>> 0;
        }
      }
    }
  }
  // flags bit0: blocked (war/sanction), bit1: land neighbours
  function buildFlags(W, S) {
    var NC = W.NC | 0, F = ensureFlags(W, S), cs = W.countries, n = cs.length, i, j, k;
    F.fill(0);
    var regs = W.regions || [];
    for (i = 0; i < regs.length; i++) {
      var r = regs[i]; if (!r) continue;
      var a = r.owner | 0; if (a < 0 || a >= n) continue;
      var nb = r.neighbors || [];
      for (j = 0; j < nb.length; j++) {
        var rb = regs[nb[j]]; if (!rb) continue;
        var b = rb.owner | 0; if (b < 0 || b === a || b >= n) continue;
        F[a * NC + b] |= 2; F[b * NC + a] |= 2;
      }
    }
    var wars = W.wars || [];
    for (i = 0; i < wars.length; i++) {
      var w = wars[i]; if (!w || w.ended) continue;
      var sd = warSides(w), A = sd[0], D = sd[1];
      for (j = 0; j < A.length; j++) for (k = 0; k < D.length; k++) {
        var x = cid(A[j]), y = cid(D[k]);
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        F[x * NC + y] |= 1; F[y * NC + x] |= 1;
      }
    }
    for (i = 0; i < n; i++) {
      var c = cs[i]; if (!alive(c) || !c.sanctions || !c.sanctions.length) continue;
      for (j = 0; j < c.sanctions.length; j++) {
        var t = cid(c.sanctions[j]); if (t < 0 || t >= n) continue;
        F[i * NC + t] |= 1; F[t * NC + i] |= 1;
      }
    }
    return F;
  }
  // Fill out[a*NC+b] with the gravity base of every live pair (0 when blocked/dead).
  function fillBase(W, S, F, NC, n, ya, yb, out) {
    var Dm = W.dist, Rl = W.rel, cs = W.countries, lo = S.maskLo, hi = S.maskHi, a, b;
    var ovl = S.ovl, pat = S.pat;
    for (a = 0; a < n; a++) {
      var c = cs[a];
      ovl[a] = (c && c.overlord !== void 0 && c.overlord !== null) ? (c.overlord | 0) : -1;
      pat[a] = (c && c.patron !== void 0 && c.patron !== null) ? (c.patron | 0) : -1;
    }
    var hasD = !!(Dm && Dm.length >= NC * NC), hasR = !!(Rl && Rl.length >= NC * NC);
    for (a = 0; a < n; a++) {
      var row = a * NC, yA = ya[a];
      if (!(yA > 0)) { for (b = 0; b < n; b++) out[row + b] = 0; continue; }
      var la = lo[a], ha = hi[a], oa = ovl[a], pa = pat[a];
      for (b = 0; b < n; b++) {
        var idx = row + b, yB = yb[b];
        if (a === b || !(yB > 0)) { out[idx] = 0; continue; }
        var f = F[idx];
        if (f & 1) { out[idx] = 0; continue; }
        var d = hasD ? Dm[idx] : 0;
        if (!(d > 0)) d = distKm(W, NC, a, b);
        var v = yA * yB / (d + 500);
        if (f & 2) v *= 1.6;
        if ((la & lo[b]) || (ha & hi[b])) v *= 1.6;
        if (oa === b || ovl[b] === a) v *= 1.5;
        else if (pa === b || pat[b] === a) v *= 1.15;
        var r = hasR ? Rl[idx] : 0;
        if (!(r === r)) r = 0;
        var rf = 1 + r / 150;
        v *= rf < 0.3 ? 0.3 : (rf > 1.7 ? 1.7 : rf);
        out[idx] = v > 0 && v < 1e30 ? v : 0;
      }
    }
  }
  function ensureBase(W, S) {
    var NC = W.NC | 0;
    if (!S.base || S.base.length !== NC * NC) S.base = new F32(NC * NC);
    return S.base;
  }
  // Full gravity calibration (IPF). final=true at settle time (uses relations/wars/sanctions).
  function buildTrade(W, S, final) {
    var NC = W.NC | 0, cs = W.countries, n = M.min(cs.length, NC), T = ensureTrade(W), a, b;
    buildMasks(W, S);
    var F = buildFlags(W, S);
    var ya = S.tmpA, yb = S.tmpB, rowT = S.tmpC, colT = S.tmpD;
    for (a = 0; a < n; a++) {
      var c = cs[a];
      if (alive(c) && c.eco) { var g = M.max(0.01, num(c.gdp, 0.01)); ya[a] = M.pow(g, 0.9); yb[a] = M.pow(g, 0.85); }
      else { ya[a] = 0; yb[a] = 0; }
    }
    var B = ensureBase(W, S);
    fillBase(W, S, F, NC, n, ya, yb, B);
    // market access → target openness (exports/GDP)
    var sumX = 0, sumM = 0;
    for (a = 0; a < n; a++) {
      var ca = cs[a];
      if (!(ya[a] > 0)) { rowT[a] = 0; colT[a] = 0; continue; }
      var ma = 0, row = a * NC;
      for (b = 0; b < n; b++) ma += B[row + b];
      ma /= ya[a]; ca.eco.ma = ma;
      var gdpA = num(ca.gdp, 0.01);
      var open = clamp(0.43 * M.pow(M.max(ma, 1e-9), 0.7) * M.pow(M.max(gdpA, 0.5), -0.25) * (0.4 + 0.6 * ca.eco.dev), 0.06, 1.2);
      if (!final || !(ca.eco.open > 0) || !S.initDone) ca.eco.open = open;
      rowT[a] = ca.eco.open * gdpA;
      colT[a] = ca.eco.open * gdpA;
      sumX += rowT[a]; sumM += colT[a];
    }
    var scaleM = sumM > 0 ? sumX / sumM : 1;
    for (a = 0; a < n; a++) { colT[a] *= scaleM; if (cs[a] && cs[a].eco) cs[a].eco.openM = (cs[a].eco.open || 0) * scaleM; }
    // IPF
    var tr = new F64(n), ts = new F64(n), it, s;
    for (a = 0; a < n; a++) { tr[a] = 1; ts[a] = 1; }
    for (it = 0; it < 8; it++) {
      for (a = 0; a < n; a++) {
        if (!(rowT[a] > 0)) { tr[a] = 0; continue; }
        s = 0; var ra = a * NC;
        for (b = 0; b < n; b++) s += B[ra + b] * ts[b];
        tr[a] = s > 0 ? rowT[a] / s : 0;
      }
      for (b = 0; b < n; b++) {
        if (!(colT[b] > 0)) { ts[b] = 0; continue; }
        s = 0;
        for (a = 0; a < n; a++) s += B[a * NC + b] * tr[a];
        ts[b] = s > 0 ? clamp(colT[b] / s, 0, 1e6) : 0;
      }
    }
    for (a = 0; a < n; a++) {
      if (!(rowT[a] > 0)) { tr[a] = 0; continue; }
      s = 0; var rb2 = a * NC;
      for (b = 0; b < n; b++) s += B[rb2 + b] * ts[b];
      tr[a] = s > 0 ? rowT[a] / s : 0;
    }
    for (a = 0; a < NC * NC && a < T.length; a++) T[a] = 0;
    for (a = 0; a < n; a++) {
      var cA = cs[a];
      if (cA && cA.eco) { cA.eco.tr = tr[a]; cA.eco.ts = ts[a]; }
      if (!(tr[a] > 0)) continue;
      var r0 = a * NC;
      for (b = 0; b < n; b++) { var v = B[r0 + b] * tr[a] * ts[b]; T[r0 + b] = v > 1e-6 ? v : 0; }
    }
    sumTrade(W);
    for (a = 0; a < n; a++) { var c2 = cs[a]; if (alive(c2) && c2.eco) c2.eco.xRef = c2.exports; }
  }
  function sumTrade(W) {
    var NC = W.NC | 0, cs = W.countries, n = M.min(cs.length, NC), T = W.trade, a, b, vol = 0;
    for (a = 0; a < n; a++) { if (cs[a]) { cs[a].exports = 0; cs[a].imports = 0; } }
    for (a = 0; a < n; a++) {
      var ca = cs[a]; if (!ca) continue;
      var row = a * NC, x = 0;
      for (b = 0; b < n; b++) {
        var v = T[row + b];
        if (v > 0) { x += v; if (cs[b]) cs[b].imports += v; }
      }
      ca.exports = x; vol += x;
    }
    if (W.global) W.global.tradeVolume = vol;
  }
  // Monthly trade dynamics: flows move toward gravity targets; collapse fast, rebuild slowly.
  function updateTrade(W, S) {
    var NC = W.NC | 0, cs = W.countries, n = M.min(cs.length, NC), T = ensureTrade(W), a, b;
    buildMasks(W, S);
    var F = buildFlags(W, S);
    var ya = S.tmpA, yb = S.tmpB, rowS = S.tmpC, colS = S.tmpD;
    for (a = 0; a < n; a++) {
      var c = cs[a];
      if (alive(c) && c.eco) { var g = M.max(0.01, num(c.gdp, 0.01)); ya[a] = M.pow(g, 0.9); yb[a] = M.pow(g, 0.85); }
      else { ya[a] = 0; yb[a] = 0; }
      rowS[a] = 0; colS[a] = 0;
    }
    var B = ensureBase(W, S);
    fillBase(W, S, F, NC, n, ya, yb, B);
    var trA = S.ovlTr, tsA = S.patTs;
    for (a = 0; a < n; a++) { var ec = (cs[a] && cs[a].eco) || null; trA[a] = ec ? num(ec.tr, 0) : 0; tsA[a] = ec ? num(ec.ts, 0) : 0; }
    // pass 1: undiverted targets → row/col sums
    for (a = 0; a < n; a++) {
      if (!(ya[a] > 0)) continue;
      var row1 = a * NC, tra = trA[a];
      for (b = 0; b < n; b++) {
        var v = B[row1 + b];
        if (v > 0) { v *= tra * tsA[b]; rowS[a] += v; colS[b] += v; }
      }
    }
    // diversion multipliers: exporters/importers re-seek lost markets/suppliers
    for (a = 0; a < n; a++) {
      if (!(ya[a] > 0)) { rowS[a] = 0; colS[a] = 0; continue; }
      var e = cs[a].eco, gdp = num(cs[a].gdp, 0.01);
      var rx = rowS[a] > 1e-9 ? clamp(e.open * gdp / rowS[a], 0.4, 3) : 1;
      var rm = colS[a] > 1e-9 ? clamp(e.openM * gdp / colS[a], 0.4, 3) : 1;
      rowS[a] = M.sqrt(rx); colS[a] = M.sqrt(rm);
    }
    // pass 2: move flows (collapse fast, rebuild slowly)
    for (a = 0; a < n; a++) {
      var row = a * NC;
      if (!(ya[a] > 0)) { for (b = 0; b < n; b++) { T[row + b] = 0; T[b * NC + a] = 0; } continue; }
      var tra2 = trA[a] * rowS[a];
      for (b = 0; b < n; b++) {
        var idx = row + b, cur = T[idx];
        if (a === b || !(yb[b] > 0)) { T[idx] = 0; continue; }
        var blocked = F[idx] & 1;
        var tgt = blocked ? 0 : B[idx] * tra2 * tsA[b] * colS[b];
        if (cs[a].bordersClosed || (cs[b] && cs[b].bordersClosed)) tgt *= 0.7; // plague border controls slow trade
        if (!(tgt > 0)) tgt = 0;
        var rate = blocked ? 0.8 : (tgt < 0.8 * cur ? 0.3 : 0.05);
        var nv = cur + (tgt - cur) * rate;
        T[idx] = nv > 1e-5 ? nv : 0;
      }
    }
    sumTrade(W);
  }

  // ------------------------------------------------------------------ settle (first step, after people aggregate)
  function settle(W, S) {
    var cs = W.countries, n = cs.length, G = W.global, id;
    for (id = 0; id < n; id++) {
      var c = cs[id]; if (!alive(c)) continue;
      if (!c.eco) baseInit(W, c, num(c.gdp0, num(c.data && c.data.gdp, 1)), popOf(c), false);
      var e = c.eco, popP = popOf(c);
      e.L = laborForceM(c, popP);
      c.tfp = c.gdp / M.max(1e-9, M.pow(c.capStock, ALPHA) * M.pow(M.max(e.L, 1e-6), 1 - ALPHA));
      e.D = 1; e.prevGdp = c.gdp;
      e.hap0 = clamp(num(c.happiness, 0.5), 0, 1);
      e.stab0 = clamp(num(c.stability, 0.6), 0, 1);
      e.u0 = clamp(num(c.unemployment, uNatOf(e.dev)), 0, 0.6); e.uS = e.u0; e.gapI = 0;
      // structural offset: start the labour market in balance at the unemployment it actually has
      e.uOff = clamp(uNatOf(e.dev) - e.u0, -0.05, 0.05);
      c.gdpPerCap = clamp(c.gdp * 1e9 / popP, 50, 1e6);
      c.wage = clamp(c.gdp * 1e9 * (0.45 + 0.15 * e.dev) / employed(c, popP), 50, 2e6);
      for (var k = 0; k < 13; k++) e.ring[k] = c.gdp;
      e.ringN = 13;
    }
    buildTrade(W, S, true);
    // commodity baselines
    var oilS = 0, foodS = 0, oilV = 0, foodV = 0, wg = 0;
    for (id = 0; id < n; id++) {
      var cc = cs[id]; if (!alive(cc) || !cc.eco) continue;
      var av = availability(W, S, cc, id);
      oilS += M.max(0, cc.oil) * av; oilV += M.max(0, cc.oil) * OIL_K;
      foodS += M.max(0, cc.food) * cc.eco.fScale * av;
      wg += cc.gdp;
    }
    S.oilSupply0 = M.max(oilS, 1e-6); S.oilWorldVal0 = M.max(oilV, 1);
    S.foodSupply0 = M.max(foodS, 1e-6);
    var fsum = 0;
    for (id = 0; id < n; id++) { var c3 = cs[id]; if (alive(c3) && c3.eco && c3.food > 0) fsum += c3.food * c3.eco.fScale; }
    S.foodK = fsum > 0 ? FOOD_SHARE * wg / fsum : 0;
    worldTotals(W, S);
    S.worldGDP0 = M.max(1, G.worldGDP); S.prevWorldGDP = G.worldGDP; S.worldPop0 = M.max(1, G.worldPop);
    // demand bias: start the world at D=1 whatever the current frictions (wars, sanctions…)
    for (id = 0; id < n; id++) {
      var c4 = cs[id]; if (!alive(c4) || !c4.eco) continue;
      var e4 = c4.eco;
      e4.dBias = 1;
      e4.resQ0 = reserveQuality(W, c4);
      var rs4 = id < G.reserveShares.length ? num(G.reserveShares[id], 0) : 0;
      var rev4 = M.max(0.03, num(c4.taxRate, 0.2));
      e4.stress0 = c4.debtRatio * M.max(0, e4.effRate - 0.6 * M.max(0, num(c4.inflation, 0.03))) / rev4;
      e4.yld0 = num(c4.bondYield, 0.05) - M.max(0, num(c4.inflation, 0.03));
      void rs4;
      var dt = demandTarget(W, S, c4, id, e4);
      e4.dBias = clamp(1 / M.max(dt, 0.1), 0.7, 1.4);
    }
    // wars that already exist don't create a fresh fear jump
    var wars = W.wars || [];
    for (var i = 0; i < wars.length; i++) if (wars[i]) S.warSeen.add(wars[i]);
    S.nukesSeen = num(G.nukesUsed, 0);
    S.fearPrev = G.fear;
    S.topReserve = topReserveId(W);
    refreshRegionPop(W, S);
    S.settled = true;
  }

  // ------------------------------------------------------------------ region bookkeeping (conquest/secession/erasure)
  function refreshRegionPop(W, S) {
    var rp = S.regionPop, R = rp.length, i;
    for (i = 0; i < R; i++) rp[i] = 0;
    var P = W.people;
    if (P && P.alive && P.region && P.weight) {
      var nP = P.n | 0, al = P.alive, rg = P.region, wt = P.weight;
      for (i = 0; i < nP; i++) {
        if (!al[i]) continue;
        var r = rg[i];
        if (r >= 0 && r < R) rp[r] += wt[i];
      }
    }
    S.regionPopTick = W.tick | 0;
  }
  function detectOwnership(W, S) {
    var regs = W.regions; if (!regs) return;
    var lo = S.lastOwner, R = lo.length, r, changed = false;
    for (r = 0; r < R; r++) { if (regs[r] && (regs[r].owner | 0) !== lo[r]) { changed = true; break; } }
    if (!changed) return;
    refreshRegionPop(W, S);
    var cs = W.countries, n = cs.length, rp = S.regionPop;
    var ownPop = new F64(n);
    for (r = 0; r < R; r++) { var o = lo[r]; if (o >= 0 && o < n) ownPop[o] += rp[r] + 1; }
    for (r = 0; r < R; r++) {
      if (!regs[r]) continue;
      var nw = regs[r].owner | 0, old = lo[r];
      if (nw === old) continue;
      if (old >= 0 && old < n && cs[old] && cs[old].eco) {
        var share = clamp((rp[r] + 1) / M.max(ownPop[old], 1), 0, 1);
        transfer(W, S, old, nw, share, clamp(num(regs[r].devastation, 0), 0, 1));
        ownPop[old] = M.max(0, ownPop[old] - rp[r] - 1);
      }
      lo[r] = nw;
    }
  }
  function transfer(W, S, a, b, share, dv) {
    var cs = W.countries, ca = cs[a], ea = ca.eco;
    if (!(share > 0)) return;
    var Ka = M.max(0, num(ca.capStock, 0)), La = M.max(0, num(ea.L, 0));
    var YpA = cobb(num(ca.tfp, 0), Ka, La);
    var dK = Ka * share, dL = La * share, dY = YpA * share, dX = num(ea.xRef, 0) * share;
    ca.capStock = Ka - dK; ea.L = La - dL; ea.xRef = num(ea.xRef, 0) - dX;
    var cb = b >= 0 ? cs[b] : null;
    if (!cb || !alive(cb)) return;
    if (!cb.eco) initCountry(W, cb);
    var eb = cb.eco;
    var Kb = M.max(0, num(cb.capStock, 0)), Lb = M.max(0, num(eb.L, 0));
    var YpB = cobb(num(cb.tfp, 0), Kb, Lb);
    var fresh = eb.fresh || !(YpB > 0);
    var keep = fresh ? 0.95 * (1 - 0.3 * dv) : 0.9 * (1 - 0.5 * dv);
    Kb += dK * (1 - 0.5 * dv); Lb += dL;
    var tgt = YpB + dY * keep;
    var f = M.pow(M.max(Kb, 1e-9), ALPHA) * M.pow(M.max(Lb, 1e-9), 1 - ALPHA);
    if (f > 0 && tgt > 0) cb.tfp = tgt / f;
    cb.capStock = Kb; eb.L = Lb; eb.xRef = num(eb.xRef, 0) + dX;
    if (fresh) {
      eb.D = clamp(ea.D * 0.92, 0.3, 1.2); eb.lnF = ea.lnF; eb.idio = ea.idio - 0.1; eb.lnPPP = ea.lnPPP; eb.real = ea.real - 0.1;
      eb.open = ea.open; eb.openM = ea.openM; eb.tr = ea.tr; eb.ts = ea.ts; eb.dBias = ea.dBias;
      eb.hap0 = ea.hap0; eb.stab0 = ea.stab0; eb.u0 = ea.u0; eb.piBase = ea.piBase;
      cb.inflation = num(ca.inflation, eb.piBase); cb.confidence = clamp(num(ca.confidence, 0.6) - 0.1, 0.02, 0.98);
      cb.stockIndex = 100 * M.exp(clamp(eb.lnF + eb.idio, -12, 12));
      cb.currency = M.exp(clamp(eb.lnPPP + eb.real, -25, 8));
      eb.fresh = false;
    }
    // move a share of the giver's trade relationships to the receiver
    if (alive(ca)) {
      var NC = W.NC | 0, T = W.trade, n = M.min(cs.length, NC);
      if (T && a < NC && b < NC) {
        for (var k = 0; k < n; k++) {
          if (k === a || k === b) continue;
          var ia = a * NC + k, ib = b * NC + k, va = T[ia] * share;
          T[ia] -= va; T[ib] += va;
          var ja = k * NC + a, jb = k * NC + b, vb = T[ja] * share;
          T[ja] -= vb; T[jb] += vb;
        }
        T[a * NC + b] *= (1 - share); T[b * NC + a] *= (1 - share);
        sumTrade(W);
      }
    }
  }

  // ------------------------------------------------------------------ commodities
  function availability(W, S, c, id) {
    var e = c.eco || EMPTY;
    var war = (c.atWar || (S.atWar && S.atWar[id])) ? 1 : 0;
    var av = (1 - 0.25 * war) * (c.civilWar ? 0.45 : 1) * (1 - 0.6 * num(e.devAvg, 0)) * (anarchyOf(c) ? 0.3 : 1) *
      (1 - 0.25 * num(e.sancP, 0)) * (c.defaulted ? 0.9 : 1);
    return clamp(av, 0, 1);
  }
  function stepCommodities(W, S) {
    var G = W.global, cs = W.countries, n = cs.length, id;
    var oilS = 0, foodS = 0;
    for (id = 0; id < n; id++) {
      var c = cs[id]; if (!alive(c) || !c.eco) continue;
      var av = availability(W, S, c, id);
      c.eco.oilAv = av;
      oilS += M.max(0, num(c.oil, 0)) * av;
      foodS += M.max(0, num(c.food, 0)) * c.eco.fScale * av;
    }
    var yrs = num(W.tick, 0) / 52;
    var wg = M.max(1, G.worldGDP), wg0 = M.max(1, S.worldGDP0);
    // oil: demand grows with world output (less efficiency gains); producers respond slowly to price
    var dOil = M.pow(wg / wg0, 0.75) * M.exp(-0.012 * yrs);
    var sOil = (oilS / S.oilSupply0) * S.oilResp;
    var pOil = OIL_P0 * M.pow(dOil / M.max(sOil, 0.05), 2.4) * (1 + 0.15 * M.max(0, G.fear - 0.3)) * M.exp(S.oilNoise);
    S.oilNoise = S.oilNoise * 0.95 + 0.022 * rn(W);
    pOil = clamp(pOil, 8, 900);
    G.oilPrice = clamp(G.oilPrice + (pOil - G.oilPrice) * 0.2, 5, 1000);
    S.oilResp = clamp(S.oilResp + 0.1 * M.log(G.oilPrice / OIL_P0) / 52, 0.75, 1.6);
    // food: demand ~ population (and a little income), supply from exporters' farms; weather noise
    var dFood = (M.max(1, G.worldPop) / S.worldPop0) * M.pow(wg / wg0, 0.15) * M.exp(-0.008 * yrs);
    var sFood = (foodS / S.foodSupply0) * S.foodResp;
    var pFood = FOOD_P0 * M.pow(dFood / M.max(sFood, 0.05), 2.0) * M.exp(S.foodNoise);
    S.foodNoise = S.foodNoise * 0.96 + 0.018 * rn(W);
    pFood = clamp(pFood, 30, 1500);
    G.foodPrice = clamp(G.foodPrice + (pFood - G.foodPrice) * 0.15, 20, 2000);
    S.foodResp = clamp(S.foodResp + 0.15 * M.log(G.foodPrice / FOOD_P0) / 52, 0.8, 1.6);
  }

  // ------------------------------------------------------------------ reserves
  function reserveQuality(W, c) {
    if (!alive(c) || c.defaulted) return 0;
    var d = c.data || EMPTY;
    var corr = clamp(num(c.corruption, num(d.corruption, 0.5)), 0, 1);
    var stab = clamp(num(c.stability, 0.6), 0, 1);
    var fr = clamp(num(c.freedom, 0.5), 0, 1);
    var infl = num(c.inflation, 0.03);
    var q = M.pow(1 - corr, 2) * (0.3 + 0.7 * stab) * (0.3 + 0.7 * fr) * M.exp(-8 * M.max(0, infl - 0.03)) *
      (c.atWar ? 0.8 : 1) * (c.civilWar ? 0.2 : 1) * (anarchyOf(c) ? 0.02 : 1) * (0.2 + 0.8 * num(c.eco && c.eco.dev, 0.5));
    return clamp(q, 0, 2);
  }
  // members of a currency union (the euro) issue one reserve currency: attraction scales with the union's size
  function euroFlags(W) {
    var cs = W.countries, n = cs.length, D = GS.DATA || EMPTY, keys = D.eurozone || [];
    var S = W._eco;
    if (!S.euro || S.euro.length < n) {
      var f = new U8(n + 32);
      for (var i = 0; i < n; i++) if (cs[i] && cs[i].key !== void 0 && keys.indexOf(String(cs[i].key)) >= 0 && !(cs[i].createdTick > 0)) f[i] = 1;
      S.euro = f;
    }
    return S.euro;
  }
  function euroGdp(W, eu) {
    var cs = W.countries, g = 0;
    for (var i = 0; i < cs.length; i++) if (eu[i] && alive(cs[i])) g += M.max(0, num(cs[i].gdp, 0));
    return g;
  }
  function stepReserves(W, S) {
    var G = W.global, rs = G.reserveShares, cs = W.countries, n = M.min(cs.length, rs.length), i;
    var inert = S.tmpA, attr = S.tmpB, si = 0, sa = 0;
    var eu = euroFlags(W), eg = euroGdp(W, eu);
    for (i = 0; i < n; i++) {
      var c = cs[i]; inert[i] = 0; attr[i] = 0;
      if (!alive(c) || !c.eco) { rs[i] = 0; continue; }
      var q = reserveQuality(W, c), e = c.eco;
      var q0 = e.resQ0 > 0 ? e.resQ0 : q;
      var g0 = M.max(0.01, num(c.gdp0, c.gdp));
      var r = q0 > 0 ? (q / q0) * M.sqrt(M.max(0, c.gdp) / g0) : 0;
      inert[i] = rs[i] * clamp(r, 0, 3); si += inert[i];
      var gi = M.max(0, c.gdp);
      attr[i] = (eu[i] && eg > 0) ? M.pow(eg / 1000, 1.5) * q * gi / eg : M.pow(gi / 1000, 1.5) * q;
      sa += attr[i];
    }
    var tot = 0;
    for (i = 0; i < n; i++) {
      var tgt = (si > 0 ? 0.75 * inert[i] / si : 0) + (sa > 0 ? (si > 0 ? 0.25 : 1) * attr[i] / sa : 0);
      rs[i] = M.max(0, rs[i] + (tgt - rs[i]) / 36);
      tot += rs[i];
    }
    if (tot > 0) for (i = 0; i < n; i++) rs[i] /= tot;
    var top = topReserveId(W), tv = topReserveShare(W, top);
    if (top !== -1 && S.topReserve !== -1 && top !== S.topReserve) {
      var ids = []; if (top >= 0) ids.push(top); if (S.topReserve >= 0) ids.push(S.topReserve);
      var prevGone = S.topReserve >= 0 && !alive(cs[S.topReserve]);
      post(W, reserveName(W, top) + (prevGone ? ' becomes the world\'s main reserve currency issuer after the fall of ' + reserveName(W, S.topReserve) + ' (' :
        ' overtakes ' + reserveName(W, S.topReserve) + ' as the world\'s main reserve currency issuer (') + pct(tv) + ' of global reserves)', ids, 4);
    }
    S.topReserve = top;
  }
  // -2 stands for the euro area as a whole
  function reserveName(W, id) { return id === -2 ? 'The euro area' : ((W.countries[id] && W.countries[id].name) || '?'); }
  function topReserveShare(W, id) {
    var rs = W.global.reserveShares, cs = W.countries;
    if (id !== -2) return id >= 0 ? rs[id] : 0;
    var eu = euroFlags(W), s = 0;
    for (var i = 0; i < cs.length && i < rs.length; i++) if (eu[i] && alive(cs[i])) s += rs[i];
    return s;
  }
  function topReserveId(W) {
    var rs = W.global.reserveShares, cs = W.countries, best = -1, bv = 0, eu = W._eco ? euroFlags(W) : null, es = 0;
    for (var i = 0; i < cs.length && i < rs.length; i++) {
      if (!alive(cs[i])) continue;
      if (eu && eu[i]) { es += rs[i]; continue; }
      if (rs[i] > bv) { bv = rs[i]; best = i; }
    }
    if (es > bv) best = -2;
    return best;
  }
  // Wealth loss for holders when an issuer of reserves/finance disappears or defaults.
  function financialShock(W, S, srcId, lostShare, lostGdpShare, factor) {
    var G = W.global, cs = W.countries, n = cs.length, NC = W.NC | 0, T = W.trade;
    var fearJump = clamp((1.8 * lostGdpShare + 1.6 * lostShare) * factor, 0, 0.95);
    G.fear = clamp(G.fear + fearJump, 0, 1);
    var lostWealth = lostShare * 0.25 * M.max(1, G.worldGDP) * factor;
    var H = 0, i;
    var hi = S.tmpA;
    for (i = 0; i < n; i++) {
      var c = cs[i]; hi[i] = 0;
      if (!alive(c) || !c.eco || i === srcId) continue;
      hi[i] = (0.15 + num(c.eco.open, 0.3)) * (0.4 + 0.6 * c.eco.dev) * M.max(0, c.gdp);
      H += hi[i];
    }
    for (i = 0; i < n; i++) {
      var k = cs[i]; if (!(hi[i] > 0)) continue;
      var e = k.eco, Y = M.max(0.01, k.gdp);
      var lk = H > 0 ? clamp(lostWealth * hi[i] / H / Y, 0, 0.5) : 0;
      var te = 0;
      // lost export demand hurts most; lost imports (supply) less: avoid double-counting two-way trade
      if (T && srcId >= 0 && srcId < NC && i < NC) te = clamp((T[i * NC + srcId] + 0.3 * T[srcId * NC + i]) / Y, 0, 2);
      var fin = 0.3 + 0.7 * e.dev, herd = 0.75 + 0.5 * ru(W); // markets over- or under-react country by country
      e.idio -= (fearJump * 0.25 * fin + 1.2 * te * factor + 1.5 * lk) * herd;
      k.confidence = clamp(num(k.confidence, 0.6) - clamp(0.25 * fearJump + 0.8 * te * factor + lk, 0, 0.5), 0.02, 0.98);
      e.wshock = clamp(e.wshock + 0.3 * lk + 0.25 * te * factor, 0, 0.25);
      var K = M.max(0, num(k.capStock, 0));
      if (K > 0) k.capStock = K * (1 - clamp(0.3 * lk * Y / K, 0, 0.15));
    }
    return fearJump;
  }

  // ------------------------------------------------------------------ fear inputs (wars, nukes, plague)
  function fearInputs(W, S) {
    var G = W.global, cs = W.countries, n = cs.length, wars = W.wars || [], i, j;
    var wg = M.max(1, G.worldGDP), floorW = 0, jump = 0;
    var aw = S.atWar;
    for (i = 0; i < n; i++) aw[i] = 0;
    for (i = 0; i < wars.length; i++) {
      var w = wars[i]; if (!w || w.ended) continue;
      var sd = warSides(w), gA = 0, gD = 0, nA = false, nD = false;
      for (j = 0; j < sd[0].length; j++) {
        var a = cid(sd[0][j]), ca = cs[a]; if (!alive(ca)) continue;
        aw[a] = 1; gA += M.max(0, num(ca.gdp, 0)); if (num(ca.nukes, num(ca.data && ca.data.nukes, 0)) > 0) nA = true;
      }
      for (j = 0; j < sd[1].length; j++) {
        var b = cid(sd[1][j]), cb = cs[b]; if (!alive(cb)) continue;
        aw[b] = 1; gD += M.max(0, num(cb.gdp, 0)); if (num(cb.nukes, num(cb.data && cb.data.nukes, 0)) > 0) nD = true;
      }
      var size = M.min(gA, gD) / wg;
      floorW += 1.4 * size;
      if (!S.warSeen.has(w)) {
        S.warSeen.add(w);
        jump += M.min(0.6, 3.5 * size + ((nA && nD && size > 0.005) ? 0.12 : 0));
      }
    }
    if (S.warSeen.size > 2 * wars.length + 64) { S.warSeen = new Set(); for (i = 0; i < wars.length; i++) if (wars[i]) S.warSeen.add(wars[i]); }
    var nk = num(G.nukesUsed, 0);
    if (nk > S.nukesSeen) { jump += M.min(0.8, 0.3 * (nk - S.nukesSeen)); }
    S.nukesSeen = nk;
    var inf = 0, wp = 0;
    for (i = 0; i < n; i++) { var c = cs[i]; if (!alive(c)) continue; var p = popOf(c); inf += clamp(num(c.infected, 0), 0, 1) * p; wp += p; }
    var infShare = wp > 0 ? inf / wp : 0;
    var floor = 0.06 + M.min(0.5, floorW) + (G.plagueActive ? 0.06 : 0) + M.min(0.3, infShare * 4);
    G.fear = clamp(G.fear + jump, 0, 1);
    // decay toward floor (half-life ~9 months), rise toward floor quickly
    if (G.fear > floor) G.fear = floor + (G.fear - floor) * 0.9824;
    else G.fear += (floor - G.fear) * 0.1;
    // world GDP losses feed fear
    var dW = S.prevWorldGDP > 0 ? G.worldGDP / S.prevWorldGDP - 1 : 0;
    if (dW < -0.003) G.fear = clamp(G.fear + 1.5 * (-dW), 0, 1);
  }

  // ------------------------------------------------------------------ demand factor
  function demandTarget(W, S, c, id, e) {
    var G = W.global;
    var conf = clamp(num(c.confidence, 0.6), 0, 1);
    var gdp = M.max(0.01, num(c.gdp, 0.01));
    var war = (c.atWar || S.atWar[id]) ? 1 : 0;
    var cw = c.civilWar ? 1 : 0, an = anarchyOf(c);
    var infl = num(c.inflation, 0.03);
    var exp = clamp(1.1 * (num(c.exports, 0) - num(e.xRef, 0)) / gdp, -0.3, 0.12);
    // commodities terms of trade
    var pOil = G.oilPrice / OIL_P0 - 1;
    var wg = M.max(1, G.worldGDP);
    var oilCons = S.oilWorldVal0 * M.pow(wg / M.max(1, S.worldGDP0), 0.75) * gdp / wg;
    var oilProd = M.max(0, num(c.oil, 0)) * OIL_K * num(e.oilAv, 1);
    var tot = 0.5 * (oilProd - oilCons) * pOil / gdp;
    var pFood = G.foodPrice / FOOD_P0 - 1;
    tot += 0.5 * num(c.food, 0) * e.fScale * num(S.foodK, 0) * pFood / gdp;
    tot = clamp(tot, -0.25, 0.35);
    var infected = clamp(num(c.infected, 0), 0, 1);
    var rr = clamp(0.5 * (G.baseRate - S.worldInfl - 0.015), -0.03, 0.04);
    var dt = e.dBias * (1 + e.gapI) * (1 - rr) *
      (1 + 0.12 * (conf - 0.6)) *
      (1 + exp) *
      (1 - 0.03 * M.max(0, G.fear - FEAR0) * (0.4 + 0.6 * e.dev)) *
      clamp(1 - 0.03 * war - 0.1 * cw - 0.35 * e.devAvg - 0.3 * an - 0.08 * e.sancP - e.defShock, 0.2, 1) *
      (1 + tot) *
      (1 - clamp((infl - 0.25) * 0.06, 0, 0.25)) *
      (1 + clamp(0.25 * (num(c.deficit, 0) - e.def0), -0.03, 0.04)) *
      (1 + e.shock + S.gshock * (0.5 + 0.5 * e.dev)) *
      (1 - 0.4 * e.wshock) *
      (1 - clamp(infected * 1.2, 0, 0.3));
    return clamp(dt, 0.2, 1.3);
  }

  // ------------------------------------------------------------------ per-country weekly step
  function stepCountry(W, S, c, id, monthlyTurn) {
    var G = W.global, e = c.eco, d = c.data || EMPTY;
    var popP = popOf(c);
    var rs = id < G.reserveShares.length ? num(G.reserveShares[id], 0) : 0;
    var war = (c.atWar || S.atWar[id]) ? 1 : 0, cw = c.civilWar ? 1 : 0, an = anarchyOf(c);
    var tick = W.tick | 0;
    // sanctions already in force when the world starts are priced in (the economy adapted to them before 2026)
    if (!(e.sancP0 >= 0)) e.sancP0 = W.tick < 2 ? S.sancP[id] : 0;
    e.sancP = clamp(S.sancP[id] - e.sancP0, 0, 1);
    // devastation (population-weighted)
    var regs = c.regions || [], dv = 0, wsum = 0, rp = S.regionPop;
    for (var k = 0; k < regs.length; k++) {
      var rr = W.regions[regs[k]]; if (!rr) continue;
      var wgt = (rp[regs[k]] || 0) + 1;
      dv += clamp(num(rr.devastation, 0), 0, 1) * wgt; wsum += wgt;
    }
    e.devAvg = wsum > 0 ? dv / wsum : 0;

    // labor & potential
    var LF = laborForceM(c, popP);
    if (!(e.L > 0)) e.L = LF; else e.L += (LF - e.L) * 0.02;
    var K = num(c.capStock, 0);
    if (!(c.tfp > 0)) c.tfp = 1;
    if (!(K > 1e-6)) {
      K = M.max(0.01, 1.5 * M.max(0.05, num(c.gdp, 0.05)));
      c.tfp = M.max(0.05, num(c.gdp, 0.05)) / M.max(1e-9, M.pow(K, ALPHA) * M.pow(M.max(e.L, 1e-6), 1 - ALPHA));
    }
    c.tfp *= M.exp(e.gA / 52);
    var Yp = cobb(c.tfp, K, e.L);
    if (!(Yp > 0)) Yp = M.max(0.01, num(c.gdp, 0.01));

    // AR shock & wealth-shock decay
    e.shock = e.shock * 0.96 + 0.003 * rn(W);
    e.wshock *= 0.985; e.defShock *= 0.987;
    e.dBias += (1 - e.dBias) / (52 * 8);

    // confidence
    var hap = clamp(num(c.happiness, e.hap0), 0, 1), stab = clamp(num(c.stability, e.stab0), 0, 1);
    var u = clamp(num(c.unemployment, e.u0), 0, 1), infl = num(c.inflation, 0.03);
    e.uS += (u - e.uS) / 13;
    // reference levels adapt over ~5 years (people get used to conditions)
    e.hap0 += (hap - e.hap0) / 260; e.stab0 += (stab - e.stab0) / 260; e.u0 += (e.uS - e.u0) / 260;
    var exh = clamp(num(c.warExhaustion, 0), 0, 1);
    var confT = 0.6 + 0.4 * (hap - e.hap0) + 0.2 * (stab - e.stab0) - 0.4 * (G.fear - FEAR0) -
      0.7 * M.max(0, e.uS - e.u0 - 0.015) + 0.4 * clamp(num(c.growth, 0) - e.gPot, -0.15, 0.05) -
      0.08 * war - 0.2 * cw - 0.25 * an - 0.2 * (c.defaulted ? 1 : 0) - 0.3 * clamp(infl - 0.08, 0, 1) -
      0.12 * e.sancP - 0.2 * exh - e.wshock;
    c.confidence = clamp(num(c.confidence, 0.6) + (clamp(confT, 0.02, 0.98) - num(c.confidence, 0.6)) * 0.08, 0.02, 0.98);

    // demand factor & GDP
    var Dt = demandTarget(W, S, c, id, e);
    e.D += (Dt - e.D) * (Dt < e.D ? 0.15 : 0.06);
    e.D = clamp(e.D, 0.2, 1.3);
    // prices/monetary policy slowly close output gaps (integral term; limited for structural damage)
    // (anti-windup: only ordinary gaps are integrated, so deep slumps don't leave an inflationary overhang)
    e.gapI = clamp(e.gapI * 0.998 - 0.25 * clamp(e.D / M.max(0.3, e.dBias) - 1, -0.04, 0.04) / 52, -0.06, 0.06);
    var prev = M.max(0.01, num(c.gdp, 0.01));
    var gdp = M.max(0.01, Yp * e.D);
    c.gdp = gdp; c.gdpPotential = Yp;
    var lg = M.log(gdp / prev) * 52;
    c.growth = clamp(num(c.growth, 0) + (clamp(lg, -6, 6) - num(c.growth, 0)) / 26, -0.95, 0.95);
    c.gdpPerCap = clamp(gdp * 1e9 / popP, 20, 2e6);

    // investment, depreciation, war destruction
    var realY = num(c.bondYield, 0.05) - M.max(0, infl);
    var s = clamp(e.s0 * (0.65 + 0.6 * c.confidence) * (1 - 0.3 * war - 0.3 * cw) * (c.defaulted ? 0.7 : 1) * (an ? 0.3 : 1) *
      (1 - clamp(2 * (realY - 0.04), -0.1, 0.4)), 0.02, 0.5);
    K += (s * gdp - DELTA * K) / 52 - K * 0.3 * e.devAvg / 52;
    c.capStock = M.max(K, 0.02 * gdp);

    // exports reference adapts (structural adjustment ~2 years)
    e.xRef = M.max(0, e.xRef * M.exp(e.gPot / 52));
    e.xRef += (num(c.exports, 0) - e.xRef) / 156;

    // ---- fiscal
    var pol = c.policy;
    var intNow = c.defaulted ? 0 : clamp(num(c.debtRatio, 0) * e.effRate, 0, 0.5);
    // without a political target, revenue follows the interest bill and debt (a generic fiscal rule)
    var taxDef = clamp(e.tax0 + 0.7 * (intNow - num(e.int0, intNow)) + 0.05 * (num(c.debtRatio, 0) - num(e.dr0, 0)), 0.04, 0.6);
    var taxT = policyVal(pol, 'taxTarget', taxDef, 0.7);
    var milT = policyVal(pol, 'milTarget', e.mil0, 0.6);
    var welT = policyVal(pol, 'welfareTarget', e.wel0, 0.5);
    // bond-market discipline squeezes discretionary spending when debt/real yields get high
    var limD = 0.9 + 1.4 * e.dev + 3 * rs;
    var squeeze = clamp(0.3 * (num(c.debtRatio, 0) / limD - 0.75) + 2 * (num(c.bondYield, 0.05) - M.max(0, infl) - 0.06), 0, 0.4);
    var othT = e.other0 * (1 - squeeze) * (c.defaulted ? 0.8 : 1) * (an ? 0.3 : 1);
    c.taxRate = clamp(num(c.taxRate, e.tax0) + (taxT - num(c.taxRate, e.tax0)) / 26, 0.02, 0.75);
    c.spendMil = clamp(num(c.spendMil, e.mil0) + (milT - num(c.spendMil, e.mil0)) / 13, 0, 0.6);
    c.spendWelfare = clamp(num(c.spendWelfare, e.wel0) + (welT - num(c.spendWelfare, e.wel0)) / 26, 0, 0.5);
    c.spendOther = clamp(num(c.spendOther, e.other0) + (othT - num(c.spendOther, e.other0)) / 26, 0, 0.5);
    var collect = clamp(1 - 0.5 * an - 0.25 * cw - 0.3 * e.devAvg - 0.5 * clamp((infl - 0.3) / 3, 0, 1), 0.1, 1);
    var rev = c.taxRate * collect;
    c.bondYield = bondYield(W, c, e, e.dev, rs);
    e.effRate += (c.bondYield - e.effRate) / 208;
    var interest = c.defaulted ? 0 : clamp(num(c.debtRatio, 0) * e.effRate, 0, 0.5);
    c.deficit = clamp(c.spendMil + c.spendWelfare + c.spendOther + interest - rev, -0.3, 0.8);
    var monShare = clamp((c.defaulted ? 0.9 : clamp((c.bondYield - M.max(0, infl) - 0.10) * 3, 0, 0.9)) + 0.3 * an + 0.2 * cw, 0, 1);
    var mon = M.max(0, c.deficit) * monShare;
    var debt = M.max(0, num(c.debt, 0));
    debt += (c.deficit - mon) * gdp / 52;
    debt -= debt * clamp(infl, 0, 3) * 0.6 / 52;
    // foreign-currency share of debt grows when the currency falls in real terms
    var realPrev = e.real;

    // ---- inflation
    var gap = e.D / M.max(0.3, e.dBias) - 1;
    var ke = 0.4 + 0.7 * clamp(mon / 0.08, 0, 1);
    var piT = e.piBase + 0.5 * gap + 0.06 * (G.oilPrice / OIL_P0 - 1) + 0.08 * (G.foodPrice / FOOD_P0 - 1) * (1 - 0.6 * e.dev) +
      3 * mon + 0.3 * M.max(0, -e.fxd - 0.1) + 0.02 * war + 0.06 * cw + 0.15 * an + 0.04 * e.sancP + ke * M.max(0, infl - 0.12);
    if (!(e.piAdj <= 0)) e.piAdj = M.min(0, e.piBase + 0.04 - piT);
    else e.piAdj *= (1 - 1 / 260);
    piT = clamp(piT + e.piAdj, -0.03, 50);
    infl += (piT - infl) * ((infl > 0.5 || piT > 0.5) ? 0.12 : 0.04);
    c.inflation = clamp(infl, -0.05, 50);

    // ---- currency (PPP path × real deviation)
    var wInfl = clamp(S.worldInfl, 0, 0.3);
    e.lnPPP -= (clamp(c.inflation, -0.05, 50) - wInfl) / 52;
    var realT = 0.3 * (c.confidence - 0.6) - 0.3 * (c.defaulted ? 1 : 0) - 0.12 * M.max(0, G.fear - FEAR0) * (1 - e.dev) +
      0.25 * rs * M.max(0, G.fear - FEAR0) - 0.2 * cw - 0.3 * an - 0.15 * e.sancP;
    e.real += (realT - e.real) * 0.03 + 0.006 * (1.5 - e.dev) * rn(W);
    e.lnPPP = clamp(e.lnPPP, -25, 6);
    var dReal = e.real - realPrev;
    e.fxd += (dReal * 52 - e.fxd) / 8;
    c.currency = M.exp(clamp(e.lnPPP + e.real, -25, 8));
    if (dReal < 0) debt *= 1 + 0.35 * (-dReal);
    c.debt = clamp(debt, 0, 1e7);
    c.debtRatio = clamp(c.debt / gdp, 0, 50);

    // ---- stock market (fundamental × global beta × idiosyncratic)
    e.lnF += M.log(gdp / prev) + (0.022 + 0.3 * clamp(c.inflation, 0, 0.15)) / 52;
    e.lnF = clamp(e.lnF, -10, 10);
    var idT = 0.6 * (c.confidence - 0.6) - 0.4 * (c.defaulted ? 1 : 0) - 0.12 * war - 0.35 * cw - 0.6 * an - 0.1 * e.sancP;
    e.idio += (idT - e.idio) * 0.05 + (0.012 + 0.02 * (1 - e.dev)) * rn(W);
    e.idio = clamp(e.idio, -6, 3);
    var beta = 0.5 + 0.6 * (0.3 + 0.7 * e.dev);
    c.stockIndex = clamp(100 * M.exp(clamp(e.lnF + beta * S.sw + e.idio, -12, 12)), 0.01, 1e7);

    // ---- labor market signals for people.js
    var uNat = uNatOf(e.dev);
    c.laborDemand = clamp(1 - uNat + num(e.uOff, 0) + 0.6 * gap + 0.05 * (c.confidence - 0.6) - 0.15 * an, 0.5, 0.98);
    c.wage = clamp(gdp * 1e9 * (0.45 + 0.15 * e.dev) / employed(c, popP), 50, 2e6);

    // ---- sovereign default (staggered monthly check)
    if (monthlyTurn) monthlyCountry(W, S, c, id, e, rs, rev, interest);
    e.prevGdp = gdp;
  }

  function monthlyCountry(W, S, c, id, e, rs, rev, interest) {
    var G = W.global, tick = W.tick | 0;
    e.dev = devOf(c.gdpPerCap);
    e.gA = computeGA(W, c, e.dev, c.gdpPerCap);
    e.gPot = e.gA / (1 - ALPHA) + 0.005;
    e.piBase = piBaseOf(c, e.dev);
    if (c.defaulted) {
      if (tick - e.defTick > 104 && c.debtRatio < 1.0 && c.inflation < 0.5 && !anarchyOf(c)) {
        c.defaulted = false;
        e.effRate = M.min(e.effRate, c.bondYield);
        if (c.gdp > 100) post(W, c.name + ' restructures its debt and regains access to bond markets', [id], 2);
      }
      return;
    }
    var infl = num(c.inflation, 0.03);
    var stress = c.debtRatio * M.max(0, e.effRate - 0.6 * M.max(0, infl)) / M.max(0.03, rev);
    var thr = M.max(0.35 + 0.2 * e.dev + rs, num(e.stress0, 0) * 1.15);
    var lim = M.max(0.9 + 1.4 * e.dev + 3 * rs, num(e.dr0, 0) * 1.2);
    var p = 0;
    if (stress > thr) p += 0.12 + (stress - thr);
    if (c.debtRatio > lim) p += 0.5 * (c.debtRatio / lim - 1);
    if (c.bondYield - M.max(0, infl) > M.max(0.15, num(e.yld0, 0) + 0.05)) p += 0.08;
    if (anarchyOf(c)) p += 0.05;
    p = clamp(p, 0, 0.6);
    if (p > 0 && tick > 12 && ru(W) < p) doDefault(W, S, c, id, rs);
  }

  function doDefault(W, S, c, id, rs) {
    var G = W.global, e = c.eco;
    c.defaulted = true; e.defTick = W.tick | 0;
    e.effRate = M.min(e.effRate, 0.05); // restructured debt carries low coupons
    var lost = c.debt * 0.45;
    c.debt *= 0.55; c.debtRatio = c.debt / M.max(0.01, c.gdp);
    e.defShock = 0.1; e.idio -= 0.5; e.real -= 0.35;
    c.confidence = clamp(c.confidence - 0.2, 0.02, 0.98);
    var share = c.gdp / M.max(1, G.worldGDP);
    G.fear = clamp(G.fear + M.min(0.4, 0.02 + 4 * share), 0, 1);
    if (rs > 0.003) financialShock(W, S, id, rs * 0.35, 0, 1);
    S.defQ.push({ id: id, lost: lost, ratio: c.debtRatio / 0.55, rank: rankOf(W, id) });
  }
  function rankOf(W, id) {
    var cs = W.countries, g = num(cs[id] && cs[id].gdp, 0), r = 0;
    for (var i = 0; i < cs.length; i++) if (i !== id && alive(cs[i]) && num(cs[i].gdp, 0) > g) r++;
    return r;
  }

  // ------------------------------------------------------------------ world aggregates
  function worldTotals(W, S) {
    var G = W.global, cs = W.countries, n = cs.length, gdp = 0, pop = 0, inf = 0, vol = 0;
    for (var i = 0; i < n; i++) {
      var c = cs[i]; if (!alive(c)) continue;
      var g = M.max(0, num(c.gdp, 0));
      gdp += g; pop += popOf(c); inf += g * clamp(num(c.inflation, 0.03), -0.05, 0.3); vol += M.max(0, num(c.exports, 0));
    }
    G.worldGDP = gdp; G.worldPop = pop; G.tradeVolume = vol;
    S.worldInfl = gdp > 0 ? inf / gdp : 0.03;
  }
  function sanctionPressure(W, S) {
    var cs = W.countries, n = cs.length, i, j, G = W.global, wg = M.max(1, G.worldGDP);
    var sp = S.sancP;
    for (i = 0; i < n; i++) { sp[i] = 0; if (cs[i]) cs[i].sanctionedBy = 0; }
    for (i = 0; i < n; i++) {
      var c = cs[i]; if (!alive(c) || !c.sanctions || !c.sanctions.length) continue;
      var g = M.max(0, num(c.gdp, 0)) / wg;
      for (j = 0; j < c.sanctions.length; j++) {
        var t = cid(c.sanctions[j]); if (t < 0 || t >= n || t === i || !cs[t]) continue;
        cs[t].sanctionedBy++; sp[t] += g;
      }
    }
    for (i = 0; i < n; i++) sp[i] = clamp(sp[i] * 2.5, 0, 1);
  }

  // ------------------------------------------------------------------ main step
  function step(W) {
    var S = S_(W), G = ensureGlobal(W);
    ensureTrade(W);
    if (!S.initDone) { init(W); S = W._eco; }
    var cs = W.countries, n = cs.length, tick = W.tick | 0, id;
    for (id = 0; id < n; id++) { var c0 = cs[id]; if (alive(c0) && !c0.eco) initCountry(W, c0); }
    if (!S.settled) settle(W, S);
    detectOwnership(W, S);
    if (tick % 4 === 0 && S.regionPopTick !== tick) refreshRegionPop(W, S);

    sanctionPressure(W, S);
    fearInputs(W, S);
    stepCommodities(W, S);
    S.gshock = S.gshock * 0.97 + 0.0022 * rn(W);

    for (id = 0; id < n; id++) {
      var c = cs[id]; if (!alive(c) || !c.eco) continue;
      stepCountry(W, S, c, id, ((tick + id) % 4) === 0);
    }

    // world aggregates & growth
    worldTotals(W, S);
    var wPrev = S.prevWorldGDP > 0 ? S.prevWorldGDP : G.worldGDP;
    var lw = wPrev > 0 && G.worldGDP > 0 ? M.log(G.worldGDP / wPrev) : 0;
    G.worldGrowth = clamp(G.worldGrowth + (clamp(lw * 52, -6, 6) - G.worldGrowth) / 26, -0.95, 0.95);

    // global equity market
    S.lnFw = clamp(S.lnFw + lw + 0.016 / 52, -10, 10);
    var dF = G.fear - S.fearPrev;
    var swT = -1.0 * (G.fear - FEAR0) + 1.5 * clamp(G.worldGrowth - 0.028, -0.15, 0.05);
    S.sw += (swT - S.sw) * 0.03 + 0.25 * S.mom + 0.016 * rn(W);
    if (dF > 0) S.sw -= 0.6 * dF;
    // endogenous panics: hazard rises with overvaluation
    var hz = clamp(0.0015 + 0.03 * M.max(0, S.sw - 0.08), 0, 0.05);
    if (ru(W) < hz) {
      var sev = 0.04 + 0.08 * ru(W) + 0.5 * M.max(0, S.sw);
      S.sw -= sev; G.fear = clamp(G.fear + 0.08 + 0.6 * M.max(0, S.sw + sev), 0, 1);
    }
    S.sw = clamp(S.sw, -3, 1.5);
    var mi = clamp(1000 * M.exp(S.lnFw + S.sw), 1, 1e8);
    var ret = G.marketIndex > 0 ? M.log(mi / G.marketIndex) : 0;
    S.mom = S.mom * 0.85 + 0.15 * clamp(ret, -0.2, 0.2) * 0.5;
    G.marketIndex = mi;
    S.fearPrev = G.fear;

    // global policy rate
    var rT = clamp(0.012 + 1.5 * (S.worldInfl - 0.025) + 0.025 + 0.5 * (G.worldGrowth - 0.028) - 0.03 * M.max(0, G.fear - 0.15), 0, 0.2);
    G.baseRate = clamp(G.baseRate + (rT - G.baseRate) * 0.02, 0, 0.3);

    // monthly
    if (tick % 4 === 0) {
      updateTrade(W, S);
      stepReserves(W, S);
      monthlyNews(W, S);
    }
    weeklyNews(W, S);
    S.prevWorldGDP = G.worldGDP;
  }

  // ------------------------------------------------------------------ news
  function flushDefaults(W, S) {
    var q = S.defQ, cs = W.countries;
    if (!q || !q.length) return;
    if (q.length <= 2) {
      for (var i = 0; i < q.length; i++) {
        var d = q[i], c = cs[d.id];
        post(W, c.name + ' defaults on its sovereign debt (' + money(d.lost) + ' written off; debt was ' + pct(d.ratio) + ' of GDP)',
          [d.id], d.rank < 10 ? 5 : (d.rank < 30 ? 4 : 3));
      }
    } else {
      q.sort(function (a, b) { return a.rank - b.rank; });
      var names = [], ids = [], tot = 0;
      for (var j = 0; j < q.length; j++) { tot += q[j].lost; ids.push(q[j].id); if (j < 4) names.push(cs[q[j].id].name); }
      post(W, 'Sovereign debt crisis spreads: ' + names.join(', ') + (q.length > 4 ? ' and ' + (q.length - 4) + ' others' : '') +
        ' default (' + money(tot) + ' written off)', ids, q[0].rank < 10 ? 5 : 4);
    }
    S.defQ = [];
  }
  function weeklyNews(W, S) {
    flushDefaults(W, S);
    var G = W.global, tick = W.tick | 0, k = tick % 5, k4 = (tick + 1) % 5; // k4 holds the value from 4 weeks ago
    var m4 = S.mRing[k4], o4 = S.oRing[k4], f4 = S.fRing[k4];
    S.mRing[k] = G.marketIndex; S.oRing[k] = G.oilPrice; S.fRing[k] = G.foodPrice;
    if (tick < 5) return;
    var dm = m4 > 0 ? G.marketIndex / m4 - 1 : 0;
    if (dm < -0.10 && tick - S.cool.crash > 10) {
      S.cool.crash = tick;
      post(W, 'Global stock markets crash: index down ' + pct(-dm) + ' in a month (fear ' + pct(G.fear) + ')', [], dm < -0.25 ? 5 : 4);
    }
    if (G.marketIndex > S.ath) {
      S.ath = G.marketIndex;
      if (tick - S.lastRecordTick > 52 && tick - S.cool.crash > 26) {
        S.lastRecordTick = tick;
        post(W, 'Global stocks close at a record high (' + M.round(G.marketIndex) + ')', [], 1);
      }
    }
    var dO = o4 > 0 ? G.oilPrice / o4 - 1 : 0;
    if ((dO > 0.25 || (G.oilPrice > 130 && o4 <= 130)) && tick - S.cool.oilUp > 13) {
      S.cool.oilUp = tick;
      post(W, 'Oil price surges to $' + M.round(G.oilPrice) + '/bbl (' + (dO >= 0 ? '+' : '') + pct(dO) + ' in a month)', topOilProducers(W), 3);
    }
    if ((dO < -0.25 || (G.oilPrice < 40 && o4 >= 40)) && tick - S.cool.oilDown > 13) {
      S.cool.oilDown = tick;
      post(W, 'Oil price collapses to $' + M.round(G.oilPrice) + '/bbl (' + pct(dO) + ' in a month)', topOilProducers(W), 3);
    }
    if (G.foodPrice > 150 && f4 <= 150 && tick - S.cool.food > 26) {
      S.cool.food = tick;
      post(W, 'Global food prices soar: index at ' + M.round(G.foodPrice) + ' — import-dependent nations face hunger', [], 3);
    }
  }
  function topOilProducers(W) {
    var cs = W.countries, out = [];
    for (var i = 0; i < cs.length; i++) if (alive(cs[i]) && num(cs[i].oil, 0) >= 0.5) out.push(i);
    return out.slice(0, 6);
  }
  function monthlyNews(W, S) {
    var G = W.global, cs = W.countries, n = cs.length, tick = W.tick | 0, i;
    // top-20 by GDP
    var ids = [];
    for (i = 0; i < n; i++) if (alive(cs[i]) && cs[i].eco) ids.push(i);
    ids.sort(function (a, b) { return cs[b].gdp - cs[a].gdp; });
    var top = ids.slice(0, 20), rec = [];
    S.top20 = top;
    for (i = 0; i < ids.length; i++) {
      var c = cs[ids[i]], e = c.eco;
      // monthly ring of GDP → YoY
      for (var k = 0; k < 12; k++) e.ring[k] = e.ring[k + 1];
      e.ring[12] = c.gdp;
      if (e.ringN < 13) e.ringN++;
      var yoy = e.ring[0] > 0 ? c.gdp / e.ring[0] - 1 : 0;
      if (i < 20 && tick > 26 && (yoy < -0.03 || c.growth < -0.06) && tick - e.coolRec > 52) {
        e.coolRec = tick;
        rec.push(ids[i]);
      }
      if (c.inflation > 1.0 && !anarchyOf(c) && num(c.stability, 0) > 0.25 && (e.hyperN = (e.hyperN | 0) + 1) > 18) {
        // a government that holds power eventually stabilises: new currency, inflation expectations reset
        e.hyperN = 0;
        c.inflation = e.piBase + 0.1; e.piAdj = M.min(0, e.piBase - 0.5); e.lnPPP = 0; e.real = -0.2; e.fxd = 0;
        c.currency = M.exp(e.lnPPP + e.real);
        c.confidence = clamp(num(c.confidence, 0.5) - 0.1, 0.02, 0.98);
        post(W, c.name + ' introduces a new currency to end hyperinflation', [ids[i]], 3);
      } else if (c.inflation <= 1.0) e.hyperN = 0;
      if (c.inflation > 0.5 && tick - e.coolHyper > 104 && c.gdp > 5) {
        e.coolHyper = tick;
        post(W, 'Hyperinflation grips ' + c.name + ': prices rising ' + pct(c.inflation) + ' a year', [ids[i]], i < 30 ? 4 : 3);
      }
      var fxm = c.currency / M.max(1e-12, e.fxMonth || c.currency);
      if (e.fxMonth > 0 && fxm < 0.65 && tick - e.coolFx > 52 && c.gdp > 20) {
        e.coolFx = tick;
        post(W, c.name + '\'s currency collapses, losing ' + pct(1 - fxm) + ' of its value in a month', [ids[i]], i < 20 ? 4 : 3);
      }
      e.fxMonth = c.currency;
    }
    if (rec.length >= 4) {
      var nm = [];
      for (i = 0; i < rec.length && i < 4; i++) nm.push(cs[rec[i]].name);
      post(W, 'Global slump: ' + rec.length + ' of the 20 largest economies are in deep recession (' + nm.join(', ') +
        (rec.length > 4 ? ', …' : '') + ')', rec, 5);
    } else if (rec.length && tick - S.cool.recNews < 13) {
      var nm2 = [];
      for (i = 0; i < rec.length; i++) nm2.push(cs[rec[i]].name);
      post(W, 'Recession spreads: ' + nm2.join(', ') + (rec.length > 1 ? ' are' : ' is') + ' now in deep recession', rec, 3);
    } else {
      for (i = 0; i < rec.length; i++) {
        var cr = cs[rec[i]], yo = cr.eco.ring[0] > 0 ? cr.gdp / cr.eco.ring[0] - 1 : 0;
        post(W, cr.name + ' falls into a deep recession: GDP ' + pct(M.min(yo, cr.growth), 1) + ' (annualized), unemployment ' +
          pct(num(cr.unemployment, 0)), [rec[i]], top.indexOf(rec[i]) < 5 ? 4 : 3);
      }
    }
    if (rec.length) S.cool.recNews = tick;
    if (tick > 52 && G.worldGrowth < -0.005 && tick - S.cool.worldRec > 52) {
      S.cool.worldRec = tick;
      post(W, 'The world economy is in recession: global output shrinking at ' + pct(-G.worldGrowth, 1) + ' a year', [], 4);
    }
  }

  // ------------------------------------------------------------------ hooks
  function initCountry(W, c) {
    if (!c) return;
    var S = W._eco;
    if (!S) { S = W._eco = newState(W); }
    S_(W);
    ensureGlobal(W);
    var cs = W.countries, parent = (c.parent !== void 0 && c.parent >= 0) ? cs[c.parent] : null;
    var popP = num(c.pop, 0);
    if (!(popP > 0)) {
      // count agents living in its regions
      var P = W.people, regs = c.regions || [], set = {}, i;
      for (i = 0; i < regs.length; i++) set[regs[i]] = 1;
      popP = 0;
      if (P && P.alive && P.region && P.weight) for (i = 0; i < (P.n | 0); i++) if (P.alive[i] && set[P.region[i]]) popP += P.weight[i];
      if (!(popP > 0)) popP = num(c.pop0, 0.5) * 1e6;
    }
    popP = M.max(popP, 1000);
    var gpc = parent && parent.gdpPerCap > 0 ? parent.gdpPerCap : (num(c.gdp0, 0) > 0 ? c.gdp0 * 1e9 / popP : 3000);
    var gdp = S.initDone ? M.max(0.05, gpc * popP / 1e9 * 0.85) : num(c.gdp0, num(c.data && c.data.gdp, gpc * popP / 1e9));
    var e = baseInit(W, c, gdp, popP, S.initDone);
    if (S.initDone) {
      // new country mid-game: capital and labor arrive through region transfers (detectOwnership)
      e.fresh = true;
      c.capStock = 0; e.L = 0;
      if (parent && parent.eco) {
        c.tfp = num(parent.tfp, c.tfp);
        e.open = parent.eco.open; e.openM = parent.eco.openM; e.tr = parent.eco.tr; e.ts = parent.eco.ts;
        e.hap0 = parent.eco.hap0; e.stab0 = parent.eco.stab0; e.u0 = parent.eco.u0; e.dBias = parent.eco.dBias;
      } else {
        // median calibration factors
        var trs = [], tss = [];
        for (var j = 0; j < cs.length; j++) if (alive(cs[j]) && cs[j].eco && cs[j] !== c && cs[j].eco.tr > 0) { trs.push(cs[j].eco.tr); tss.push(cs[j].eco.ts); }
        trs.sort(function (a, b) { return a - b; }); tss.sort(function (a, b) { return a - b; });
        if (trs.length) { e.tr = trs[trs.length >> 1]; e.ts = tss[tss.length >> 1]; }
      }
      c.debt = 0.25 * gdp; c.debtRatio = 0.25;
      c.confidence = 0.45;
      e.resQ0 = 0;
      for (var k = 0; k < 13; k++) e.ring[k] = gdp;
      e.ringN = 13;
      // regions: mark ones not yet seen as moved so detectOwnership transfers them; nothing to do here
    }
  }

  function settleNow(W) {
    var S = W._eco;
    if (!S || !S.initDone || S.settled) return;
    settle(W, S);
  }
  function onCountryRemoved(W, c, mode) {
    if (!c) return;
    var S = W._eco; if (!S) return;
    if (S.initDone && !S.settled) settle(W, S);
    var erased = mode === 'erased';
    var G = W.global, NC = W.NC | 0, T = W.trade, cs = W.countries, n = M.min(cs.length, NC), id = c.id | 0, k;
    var by = (!erased && typeof c.conqueredBy === 'number' && c.conqueredBy >= 0 && alive(cs[c.conqueredBy])) ? c.conqueredBy : -1;
    var gdp = M.max(0, num(c.gdp, 0));
    var wg = M.max(1, G.worldGDP);
    var lostGdp = gdp / wg;
    var rs = (G.reserveShares && id < G.reserveShares.length) ? num(G.reserveShares[id], 0) : 0;
    var fj = 0;
    // a conquered state's land, people and output live on under the conqueror: no global wipe-out
    if (erased && S.settled && (lostGdp > 0.0005 || rs > 0.0005)) fj = financialShock(W, S, id, rs, lostGdp, 1);
    else if (!erased && S.settled && lostGdp > 0.002) G.fear = clamp(G.fear + M.min(0.08, lostGdp * 0.8), 0, 1);
    // trade with the dead country vanishes immediately (erased) or passes, partly, to the conqueror
    if (T && id < NC) {
      for (k = 0; k < n; k++) {
        var ck = cs[k];
        var x = T[k * NC + id], m = T[id * NC + k];
        if (ck && ck !== c) { ck.exports = M.max(0, num(ck.exports, 0) - x); ck.imports = M.max(0, num(ck.imports, 0) - m); }
        if (by >= 0 && k !== by && by < NC) { T[k * NC + by] += x * 0.6; T[by * NC + k] += m * 0.6; }
        T[k * NC + id] = 0; T[id * NC + k] = 0;
      }
    }
    if (G.reserveShares && id < G.reserveShares.length) {
      if (by >= 0 && by < G.reserveShares.length) G.reserveShares[by] += G.reserveShares[id] * 0.5;
      G.reserveShares[id] = 0;
      var tot = 0;
      for (k = 0; k < G.reserveShares.length; k++) tot += G.reserveShares[k];
      if (tot > 0) for (k = 0; k < G.reserveShares.length; k++) G.reserveShares[k] /= tot;
    }
    // the GDP loss hits the world fundamental now; keep the weekly GDP-drop fear rule from double counting
    if (erased && S.settled && lostGdp > 0) {
      S.lnFw += M.log(clamp(1 - lostGdp, 0.05, 1));
      S.prevWorldGDP = M.max(0, S.prevWorldGDP - gdp);
    }
    if (erased && S.settled && (rs > 0.01 || lostGdp > 0.01)) {
      post(W, 'Global financial panic: the disappearance of ' + c.name + ' wipes out ' + money(gdp) + ' of annual output' +
        (rs > 0.01 ? ' and ' + pct(rs) + ' of world currency reserves' : '') + ' — fear index jumps to ' + pct(G.fear),
        [id], (rs > 0.05 || lostGdp > 0.05) ? 5 : 4);
    }
    c.exports = 0; c.imports = 0;
    if (c.eco) c.eco.gdpAtDeath = gdp;
    c.gdp = 0; c.gdpPotential = 0; c.growth = 0; c.laborDemand = 0.5;
    sumTrade(W);
    return fj;
  }

  // ------------------------------------------------------------------ queries
  function tradeShare(W, a, b) {
    var NC = W.NC | 0, T = W.trade;
    if (!T || a < 0 || b < 0 || a >= NC || b >= NC || a === b) return 0;
    var ca = W.countries[a];
    var s = ca ? num(ca.exports, 0) : 0; // row sum, kept current by sumTrade
    if (!(s > 0)) { var row = a * NC, n = M.min(W.countries.length, NC); s = 0; for (var k = 0; k < n; k++) s += T[row + k]; }
    return s > 0 ? clamp(T[a * NC + b] / s, 0, 1) : 0;
  }
  function dependence(W, a, b) {
    var NC = W.NC | 0, T = W.trade, cs = W.countries;
    if (!T || a < 0 || b < 0 || a >= NC || b >= NC || a === b) return 0;
    var ca = cs[a], cb = cs[b];
    if (!alive(ca) || !alive(cb)) return 0;
    var Y = M.max(0.01, num(ca.gdp, 0.01));
    var trade = (T[a * NC + b] + 0.5 * T[b * NC + a]) / Y;
    var rs = (W.global && W.global.reserveShares && b < W.global.reserveShares.length) ? num(W.global.reserveShares[b], 0) : 0;
    var dev = ca.eco ? ca.eco.dev : 0.5;
    var fin = rs * 0.15 * (0.3 + 0.7 * dev);
    return clamp(trade * 1.6 + fin, 0, 1);
  }

  // ------------------------------------------------------------------ extra hooks for God powers / other modules
  function marketCrash(W, severity) {
    var S = S_(W), G = ensureGlobal(W);
    if (S.initDone && !S.settled) settle(W, S);
    var sev = clamp(num(severity, 0.35), 0, 1.5);
    G.fear = clamp(G.fear + 0.5 * sev, 0, 1);
    S.sw -= 0.5 * sev; // plus the fear-delta repricing next step
    return G.fear;
  }
  function addFear(W, amount) {
    var G = ensureGlobal(W);
    G.fear = clamp(G.fear + num(amount, 0), 0, 1);
    return G.fear;
  }
  function destroyCapital(W, c, frac) {
    if (!c) return;
    var f = clamp(num(frac, 0), 0, 1);
    c.capStock = M.max(0, num(c.capStock, 0) * (1 - f));
  }

  GS.Economy = {
    init: init,
    initCountry: initCountry,
    step: step,
    onCountryRemoved: onCountryRemoved,
    settle: settleNow,
    tradeShare: tradeShare,
    dependence: dependence,
    marketCrash: marketCrash,
    addFear: addFear,
    destroyCapital: destroyCapital,
    reserveQuality: reserveQuality
  };
})();
