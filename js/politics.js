/* GODSIM — js/politics.js
 * GS.Politics: governments, leaders, parties, elections, unrest, coups, revolutions,
 * civil wars, independence movements, democratic erosion / liberalisation.
 * Classic script, no DOM. Other modules are referenced only at call time.
 * NOTHING SCRIPTED: every rule here is generic and applies to every country / agent.
 */
var GS = globalThis.GS = globalThis.GS || {};
(function () {
  'use strict';

  var M_sqrt = Math.sqrt, M_floor = Math.floor, M_max = Math.max, M_min = Math.min, M_abs = Math.abs, M_exp = Math.exp,
    M_log = Math.log, M_round = Math.round, M_hypot = Math.hypot, M_LN10 = Math.LN10, M_ceil = Math.ceil;
  // ---- constants (mirror GS.CONST.JOBS; fixed by SPEC) ----
  var CHILD = 0, MIL = 6, RET = 7, REBEL = 8;
  var F_PROTEST = 1;
  var MAXP = 6;            // max parties per country
  var TERM = 208;          // 4 years of weekly ticks
  var NAT_W = 1.5;         // nationalism axis scale in ideology distance (nat is 0..1, others -1..1)
  var EMPTY = {};

  var GOV_INFO = {
    democracy:        { label: 'Full democracy',   elections: true,  freedom: 0.9,  repressionCap: 0.15, fraud: 0,    termLimitYears: 8,  coup: 0.0002 },
    flawed_democracy: { label: 'Flawed democracy', elections: true,  freedom: 0.75, repressionCap: 0.3,  fraud: 0.04, termLimitYears: 10, coup: 0.0012 },
    hybrid:           { label: 'Hybrid regime',    elections: true,  freedom: 0.5,  repressionCap: 0.55, fraud: 0.28, termLimitYears: 0,  coup: 0.004 },
    autocracy:        { label: 'Autocracy',        elections: false, freedom: 0.25, repressionCap: 0.8,  fraud: 0,    termLimitYears: 0,  coup: 0.006 },
    oneparty:         { label: 'One-party state',  elections: false, freedom: 0.15, repressionCap: 0.9,  fraud: 0,    termLimitYears: 0,  coup: 0.003 },
    theocracy:        { label: 'Theocracy',        elections: false, freedom: 0.2,  repressionCap: 0.8,  fraud: 0,    termLimitYears: 0,  coup: 0.003 },
    monarchy:         { label: 'Absolute monarchy', elections: false, freedom: 0.3, repressionCap: 0.7,  fraud: 0,    termLimitYears: 0,  coup: 0.004 },
    junta:            { label: 'Military junta',   elections: false, freedom: 0.15, repressionCap: 0.85, fraud: 0,    termLimitYears: 0,  coup: 0.012 },
    anarchy:          { label: 'Anarchy',          elections: false, freedom: 0.45, repressionCap: 0.05, fraud: 0,    termLimitYears: 0,  coup: 0 }
  };
  var ERODE = { democracy: 'flawed_democracy', flawed_democracy: 'hybrid', hybrid: 'autocracy' };
  var LIBERALIZE = { hybrid: 'flawed_democracy', flawed_democracy: 'democracy', autocracy: 'hybrid', junta: 'hybrid',
    oneparty: 'hybrid', theocracy: 'hybrid', monarchy: 'hybrid' };
  var ISLAMIC = { arabic: 1, persian: 1, turkic: 1 };

  // ---- small helpers ----
  // (no global lookups in hot helpers: in Node's vm contexts every global access goes through an interceptor)
  function num(v, d) { return (typeof v === 'number' && v - v === 0) ? v : d; }
  function clamp(x, a, b) { return x === x ? (x < a ? a : (x > b ? b : x)) : a; }
  function c01(x, d) { return clamp(num(x, d === void 0 ? 0 : d), 0, 1); }
  function gi(gov) { return GOV_INFO[gov] || GOV_INFO.hybrid; }
  function govInfo(gov) { return gi(gov); }
  function rnd(W) { return W.rng ? W.rng.next() : 0.5; }
  function chance(W, p) { return p > 0 && rnd(W) < p; }
  function gauss(W) { return W.rng && W.rng.normal ? clamp(num(W.rng.normal(), 0), -4, 4) : 0; }
  function alive(W, id) { var c = (id >= 0 && W.countries) ? W.countries[id] : null; return !!(c && c.alive); }
  function idist(e1, a1, n1, e2, a2, n2) {
    var de = e1 - e2, da = a1 - a2, dn = (n1 - n2) * NAT_W;
    return M_sqrt(de * de + da * da + dn * dn);
  }
  function ideoOf(o, fb) {
    fb = fb || EMPTY;
    return { econ: clamp(num(o && o.econ, num(fb.econ, 0)), -1, 1), auth: clamp(num(o && o.auth, num(fb.auth, 0)), -1, 1),
      nat: clamp(num(o && o.nat, num(fb.nat, 0.5)), 0, 1) };
  }
  function devOf(c) {
    var gpc = num(c.gdpPerCap, 0);
    if (!(gpc > 0)) {
      var pop = num(c.pop, 0); if (!(pop > 0)) pop = num(c.pop0, num(c.data && c.data.pop, 1)) * 1e6;
      var gdp = num(c.gdp, 0); if (!(gdp > 0)) gdp = num(c.gdp0, num(c.data && c.data.gdp, 1));
      gpc = gdp * 1e9 / M_max(1, pop);
    }
    gpc = clamp(gpc, 150, 400000);
    return clamp((M_log(gpc) / M_LN10 - 2.85) / 2.0, 0, 1);
  }
  function popIdeo(c) {
    var d = c.data || EMPTY;
    return { econ: clamp(num(c.ideoEcon, num(d.econ, 0) * 0.7), -1, 1), auth: clamp(num(c.ideoAuth, num(d.auth, 0) * 0.5), -1, 1),
      nat: clamp(num(c.ideoNat, num(d.nat, 0.5)), 0, 1) };
  }
  function isBig(W, c) {
    if (c.greatPower) return true;
    var wg = num(W.global && W.global.worldGDP, 0);
    return wg > 0 && num(c.gdp, 0) / wg > 0.015;
  }
  function post(W, text, c, imp, sub, others) {
    if (typeof GS.news !== 'function' || !c) return;
    var ids = [c.id];
    if (others) for (var k = 0; k < others.length; k++) if (others[k] >= 0 && ids.indexOf(others[k]) < 0) ids.push(others[k]);
    var type = (sub === 'civilwar') ? 'war' : 'politics';
    GS.news(W, text, { type: type, sub: sub || 'politics', countries: ids, importance: clamp(M_round(imp + (isBig(W, c) ? 1 : 0)), 1, 5) });
  }
  function an(word) { return (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word; }
  function pct(x) { return (clamp(num(x, 0), 0, 1) * 100).toFixed(1) + '%'; }
  function yearsSince(W, t) { return M_max(0, ((W.tick | 0) - num(t, W.tick | 0)) / 52); }
  function religious(c) {
    var d = c.data || EMPTY;
    return d.gov === 'theocracy' || !!ISLAMIC[c.culture || d.culture];
  }
  function regionName(W, r) { var g = W.regions && W.regions[r]; return (g && g.name) || 'the region'; }

  // ------------------------------------------------------------------
  // Module state (per world, stored on W._pol). Agent statistics are gathered in 4 slices (one per
  // tick) into a building buffer and published every 4 ticks into S.R (read by everything else).
  // ------------------------------------------------------------------
  var RF = ['rW', 'rReb', 'rMil', 'rCnt', 'rCandW', 'rCandAppr', 'rCandRad', 'rCandE', 'rCandA', 'rCandN'];
  var RI = ['rCand', 'rBM'];
  var CF = ['cRebCnt', 'cRebCandW', 'cRebW', 'cProtW', 'cProtE', 'cProtA', 'cProtN', 'cMilW', 'cMilE', 'cMilA', 'cMilN', 'cAdW'];
  var CI = ['cRebCand', 'cRebBM', 'head'];
  function makeBuf(nR, nC, old) {
    var B = {}, k;
    for (k = 0; k < RF.length; k++) { B[RF[k]] = new Float64Array(nR); if (old) B[RF[k]].set(old[RF[k]].subarray(0, M_min(nR, old[RF[k]].length))); }
    for (k = 0; k < RI.length; k++) { B[RI[k]] = new Int32Array(nR).fill(-1); if (old) B[RI[k]].set(old[RI[k]].subarray(0, M_min(nR, old[RI[k]].length))); }
    for (k = 0; k < CF.length; k++) { B[CF[k]] = new Float64Array(nC); if (old) B[CF[k]].set(old[CF[k]].subarray(0, M_min(nC, old[CF[k]].length))); }
    for (k = 0; k < CI.length; k++) { B[CI[k]] = new Int32Array(nC).fill(-1); if (old) B[CI[k]].set(old[CI[k]].subarray(0, M_min(nC, old[CI[k]].length))); }
    B.poll = new Float64Array(nC * MAXP); if (old) B.poll.set(old.poll.subarray(0, M_min(nC * MAXP, old.poll.length)));
    // per-country singly linked agent lists (head[country] -> nxt[agent] -> ... -> -1), rebuilt every cycle
    B.nxt = old && old.nxt ? old.nxt : new Int32Array(1024).fill(-1);
    return B;
  }
  function clearBuf(B) {
    var k;
    for (k = 0; k < RF.length; k++) B[RF[k]].fill(0);
    B.rBM.fill(-1);
    for (k = 0; k < CF.length; k++) B[CF[k]].fill(0);
    B.cRebBM.fill(-1); B.head.fill(-1);
    B.poll.fill(0);
  }
  function st(W) {
    var S = W._pol;
    if (!S) {
      S = W._pol = { nR: 0, nC: 0, statsTick: -1, pending: null, R: null, B: null, rOwner: null, rPress: null, rPressOwner: null, rPrevOwner: null,
        pE: null, pA: null, pN: null, pK: null, pRul: null, sliceEnd: 0, sliceNext: 0 };
    }
    var nR = (W.regions && W.regions.length) | 0, nC = (W.countries && W.countries.length) | 0;
    if (S.nR < nR || S.nC < nC || !S.R) {
      var capC = M_max(S.nC, nC + 40), capR = M_max(S.nR, nR);
      S.R = makeBuf(capR, capC, S.R); S.B = makeBuf(capR, capC, S.B);
      var oldP = S.rPress, oldO = S.rPressOwner;
      S.rOwner = new Int32Array(capR).fill(-1);
      var oldPO = S.rPrevOwner;
      S.rPress = new Float64Array(capR); S.rPressOwner = new Int32Array(capR).fill(-1); S.rPrevOwner = new Int32Array(capR).fill(-1);
      if (oldP) { S.rPress.set(oldP.subarray(0, M_min(oldP.length, capR))); S.rPressOwner.set(oldO.subarray(0, M_min(oldO.length, capR))); }
      if (oldPO) S.rPrevOwner.set(oldPO.subarray(0, M_min(oldPO.length, capR)));
      var FP = ['pE', 'pA', 'pN'];
      for (var k = 0; k < FP.length; k++) { var op = S[FP[k]], ap = new Float64Array(capC * MAXP); if (op) ap.set(op.subarray(0, M_min(op.length, ap.length))); S[FP[k]] = ap; }
      var ok = S.pK; S.pK = new Int32Array(capC); if (ok) S.pK.set(ok.subarray(0, M_min(ok.length, capC)));
      var orl = S.pRul; S.pRul = new Int32Array(capC).fill(-1); if (orl) S.pRul.set(orl.subarray(0, M_min(orl.length, capC)));
      S.nR = capR; S.nC = capC;
    }
    return S;
  }

  function refreshOwners(W, S) {
    var regs = W.regions, cs = W.countries, nR = M_min(S.nR, regs.length);
    for (var r = 0; r < nR; r++) {
      var g = regs[r], o = (g && typeof g.owner === 'number') ? g.owner : -1;
      if (o >= 0) { var c = cs[o]; if (!c || !c.alive || o >= S.nC) o = -1; }
      S.rOwner[r] = o;
    }
  }

  function flattenParties(W, S) {
    var pK = S.pK, pRul = S.pRul, pE = S.pE, pA = S.pA, pN = S.pN, nC = M_min(S.nC, W.countries.length);
    for (var id = 0; id < nC; id++) {
      var c = W.countries[id];
      pK[id] = 0; pRul[id] = -1;
      if (!c || !c.alive || !c.parties || !c.parties.length) continue;
      var m = M_min(MAXP, c.parties.length);
      for (var k = 0; k < m; k++) {
        var p = c.parties[k];
        pE[id * MAXP + k] = num(p.econ, 0); pA[id * MAXP + k] = num(p.auth, 0); pN[id * MAXP + k] = num(p.nat, 0.5) * NAT_W;
      }
      pK[id] = m;
      pRul[id] = (typeof c.rulingParty === 'number' && c.rulingParty < m) ? c.rulingParty : -1;
    }
  }

  // Slice s (0..3) of the monthly agent pass: region origin majorities (weighted Boyer-Moore, verified
  // against last cycle's candidate), rebels' origin, soldiers' and protesters' ideology, party polls.
  function gatherSlice(W, s) {
    var S = st(W), P = W.people, B = S.B;
    if (s !== 0 && s !== S.sliceNext) return;
    S.sliceNext = (s + 1) & 3;
    if (s === 0) { clearBuf(B); flattenParties(W, S); S.sliceEnd = 0; }
    refreshOwners(W, S);
    if (P && P.alive) {
      if (B.nxt.length < (P.n | 0)) { var nx = new Int32Array(M_max((P.n | 0) + 1024, B.nxt.length * 2)).fill(-1); nx.set(B.nxt); B.nxt = nx; }
      var n = P.n | 0, i0 = s === 0 ? 0 : S.sliceEnd, i1 = s === 3 ? n : M_min(n, M_floor(n * (s + 1) / 4));
      if (i0 < i1) gatherRange(S, B, P, i0, i1);
      S.sliceEnd = M_max(i1, i0);
    }
    if (s === 3) {
      // publish: counts refer to the candidates of the previous cycle (R.rBM / R.cRebBM)
      var R = S.R;
      B.rCand.set(R.rBM); B.cRebCand.set(R.cRebBM);
      S.R = B; S.B = R;
      S.statsTick = W.tick | 0;
    }
  }
  function gatherRange(S, B, P, i0, i1) {
    var R = S.R;
    var nR = S.nR, al = P.alive, region = P.region, origin = P.origin, job = P.job, weight = P.weight, age = P.age,
      flags = P.flags, econ = P.econ, auth = P.auth, nat = P.nat, appr = P.approval, rad = P.radical;
    var rOwner = S.rOwner, rW = B.rW, rReb = B.rReb, rMil = B.rMil, rBM = B.rBM, rCnt = B.rCnt, vCand = R.rBM;
    var rCandW = B.rCandW, rCandAppr = B.rCandAppr, rCandRad = B.rCandRad, rCandE = B.rCandE, rCandA = B.rCandA, rCandN = B.rCandN;
    var cRebBM = B.cRebBM, cRebCnt = B.cRebCnt, cRebW = B.cRebW, vReb = R.cRebBM, cRebCandW = B.cRebCandW;
    var cMilW = B.cMilW, cMilE = B.cMilE, cMilA = B.cMilA, cMilN = B.cMilN;
    var cAdW = B.cAdW, cProtW = B.cProtW, cProtE = B.cProtE, cProtA = B.cProtA, cProtN = B.cProtN, poll = B.poll;
    var pK = S.pK, pRul = S.pRul, pE = S.pE, pA = S.pA, pN = S.pN, head = B.head, nxt = B.nxt;
    for (var i = i0; i < i1; i++) {
      if (!al[i]) continue;
      var r = region[i]; if (r < 0 || r >= nR) continue;
      var w = weight[i]; if (!(w > 0)) continue;
      var og = origin[i], e = econ[i], a = auth[i], nt = nat[i];
      rW[r] += w;
      if (rCnt[r] <= 0) { rBM[r] = og; rCnt[r] = w; }
      else if (rBM[r] === og) rCnt[r] += w;
      else if (rCnt[r] >= w) rCnt[r] -= w;
      else { rBM[r] = og; rCnt[r] = w - rCnt[r]; }
      if (og === vCand[r]) {
        rCandW[r] += w; rCandAppr[r] += appr[i] * w; rCandRad[r] += rad[i] * w;
        rCandE[r] += e * w; rCandA[r] += a * w; rCandN[r] += nt * w;
      }
      var o = rOwner[r]; if (o < 0) continue;
      nxt[i] = head[o]; head[o] = i;
      var jb = job[i];
      if (jb === REBEL) {
        rReb[r] += w; cRebW[o] += w;
        if (cRebCnt[o] <= 0) { cRebBM[o] = og; cRebCnt[o] = w; }
        else if (cRebBM[o] === og) cRebCnt[o] += w;
        else if (cRebCnt[o] >= w) cRebCnt[o] -= w;
        else { cRebBM[o] = og; cRebCnt[o] = w - cRebCnt[o]; }
        if (og === vReb[o]) cRebCandW[o] += w;
      } else if (jb === MIL) {
        rMil[r] += w; cMilW[o] += w; cMilE[o] += e * w; cMilA[o] += a * w; cMilN[o] += nt * w;
      }
      if (age[i] >= 18) {
        cAdW[o] += w;
        if (flags[i] & F_PROTEST) { cProtW[o] += w; cProtE[o] += e * w; cProtA[o] += a * w; cProtN[o] += nt * w; }
        var kk = pK[o];
        if (kk > 0) {
          var base = o * MAXP, best = 0, bd = 1e9, rul = pRul[o], ntw = nt * NAT_W;
          for (var q = 0; q < kk; q++) {
            var de = e - pE[base + q], da = a - pA[base + q], dn = ntw - pN[base + q];
            var dd = de * de + da * da + dn * dn;
            if (q === rul) dd -= (appr[i] - 0.5) * 0.5;
            if (dd < bd) { bd = dd; best = q; }
          }
          poll[base + best] += w;
        }
      }
    }
  }
  // Full synchronous pass (init / after big changes): twice, so candidates are verified.
  function gatherStats(W) {
    for (var k = 0; k < 8; k++) gatherSlice(W, k & 3);
  }

  function milIdeo(W, c) {
    var S = st(W), id = c.id, w = id < S.nC ? S.R.cMilW[id] : 0, pi = popIdeo(c);
    if (!(w > 0)) return { econ: clamp(pi.econ + 0.1, -1, 1), auth: clamp(pi.auth + 0.3, -1, 1), nat: clamp(pi.nat + 0.15, 0, 1) };
    return { econ: clamp(S.R.cMilE[id] / w, -1, 1), auth: clamp(S.R.cMilA[id] / w, -1, 1), nat: clamp(S.R.cMilN[id] / w, 0, 1) };
  }
  function protIdeo(W, c) {
    var S = st(W), id = c.id, w = id < S.nC ? S.R.cProtW[id] : 0;
    if (!(w > 0)) {
      var pi = popIdeo(c), L = c.leader || pi;
      // the discontented sit on the far side of the population from the regime
      return { econ: clamp(pi.econ - (num(L.econ, 0) - pi.econ) * 0.6, -1, 1), auth: clamp(pi.auth - (num(L.auth, 0) - pi.auth) * 0.6, -1, 1),
        nat: clamp(pi.nat, 0, 1) };
    }
    return { econ: clamp(S.R.cProtE[id] / w, -1, 1), auth: clamp(S.R.cProtA[id] / w, -1, 1), nat: clamp(S.R.cProtN[id] / w, 0, 1) };
  }

  // ------------------------------------------------------------------
  // Parties
  // ------------------------------------------------------------------
  var PARTY_NAMES = {
    religiousI: ['Islamic Front', 'Islamic Renewal Party', 'Party of the Faithful', 'Islamic Unity Front'],
    religiousO: ['Faith and Family Party', 'Religious Front', 'Party of the Faithful', 'Covenant Party'],
    communist: ['Communist Party', "Workers' Party", 'Socialist Unity Party', "Revolutionary Workers' League"],
    greenleft: ['Green Left', 'Greens', 'Ecology Party', 'Left Alliance'],
    socdem: ['Social Democrats', 'Labour Party', 'Socialist Party', 'Progressive Alliance'],
    natfront: ['National Front', 'Patriotic Union', 'Homeland Party', 'Sovereignty Party'],
    order: ['Order and Justice Party', 'National Unity Party', 'Strong State Party', 'Party of Order'],
    liberal: ['Liberal Party', 'Free Market Alliance', 'Liberal Democrats', 'Reform Party'],
    conservative: ['Conservatives', 'Christian Democrats', 'Republican Union', 'Moderate Party'],
    centreLib: ['Liberal Party', 'Centre Party', "Citizens' Movement", 'Civic Platform'],
    centre: ["People's Party", 'Centre Party', 'Unity Party', 'New Alliance'],
    fallback: ['Progress Party', 'Renewal Party', 'Union for Change', 'Forward Party', "Independents' Alliance", 'Democratic Union',
      'Party of the Future', 'Alliance for Dignity']
  };
  function partyName(e, a, n, c, used) {
    var cat;
    if (c.gov === 'theocracy' && a > 0.2 && n > 0.4) cat = ISLAMIC[c.culture || (c.data && c.data.culture)] ? 'religiousI' : 'religiousO';
    else if (e < -0.45 && a > 0.2) cat = 'communist';
    else if (e < -0.3 && a < -0.2) cat = 'greenleft';
    else if (n > 0.7 && a > 0.15) cat = 'natfront';
    else if (e < -0.12) cat = 'socdem';
    else if (a > 0.45) cat = 'order';
    else if (e > 0.3 && a < -0.15) cat = 'liberal';
    else if (e > 0.12) cat = 'conservative';
    else if (a < -0.15) cat = 'centreLib';
    else cat = 'centre';
    var lists = [PARTY_NAMES[cat], PARTY_NAMES.fallback];
    for (var l = 0; l < lists.length; l++) for (var k = 0; k < lists[l].length; k++) if (!used[lists[l][k]]) return lists[l][k];
    var x = 2; while (used['New Party ' + x]) x++;
    return 'New Party ' + x;
  }

  // Reservoir sample of up to `max` living agent indices in country cid (O(agents)).
  function sampleCountry(W, cid, max) {
    var P = W.people, out = [];
    if (!P || !P.alive) return out;
    var S = st(W); refreshOwners(W, S);
    var al = P.alive, region = P.region, rOwner = S.rOwner, nR = S.nR, seen = 0, i, r, j;
    // fast path: this cycle's per-country agent list
    if (S.statsTick >= 0 && cid < S.nC) {
      var nxt = S.R.nxt, guard = P.n | 0;
      for (i = S.R.head[cid]; i >= 0 && guard-- > 0; i = nxt[i]) {
        if (!al[i]) continue;
        r = region[i]; if (r < 0 || r >= nR || rOwner[r] !== cid || P.age[i] < 18) continue;
        seen++;
        if (out.length < max) out.push(i);
        else { j = (rnd(W) * seen) | 0; if (j < max) out[j] = i; }
      }
      if (seen > 0) return out;
    }
    var n = P.n | 0;
    for (i = 0; i < n; i++) {
      if (!al[i]) continue;
      r = region[i]; if (r < 0 || r >= nR || rOwner[r] !== cid) continue;
      if (P.age[i] < 18) continue;
      seen++;
      if (out.length < max) out.push(i);
      else { j = (rnd(W) * seen) | 0; if (j < max) out[j] = i; }
    }
    return out;
  }
  // One pass: samples for every country (used at init).
  function sampleAll(W, max) {
    var P = W.people, nC = W.countries.length, res = new Array(nC), seen = new Int32Array(nC), id;
    for (id = 0; id < nC; id++) res[id] = [];
    if (!P || !P.alive) return res;
    var S = st(W); refreshOwners(W, S);
    var n = P.n | 0, al = P.alive, region = P.region, rOwner = S.rOwner, nR = S.nR;
    for (var i = 0; i < n; i++) {
      if (!al[i]) continue;
      var r = region[i]; if (r < 0 || r >= nR) continue;
      var o = rOwner[r]; if (o < 0 || o >= nC || P.age[i] < 18) continue;
      var s = ++seen[o], arr = res[o];
      if (arr.length < max) arr.push(i);
      else { var j = (rnd(W) * s) | 0; if (j < max) arr[j] = i; }
    }
    return res;
  }

  function syntheticParties(W, c, ref) {
    var used = {}, out = [];
    var proto = [[-0.45, -0.2, -0.1, 0.3], [0.35, 0.1, 0.05, 0.3], [0, 0, 0, 0.2], [0.2, 0.5, 0.3, 0.2]];
    for (var k = 0; k < proto.length; k++) {
      var e = clamp(ref.econ + proto[k][0] + gauss(W) * 0.05, -1, 1), a = clamp(ref.auth + proto[k][1] + gauss(W) * 0.05, -1, 1),
        n = clamp(ref.nat + proto[k][2], 0, 1);
      var nm = partyName(e, a, n, c, used); used[nm] = 1;
      out.push({ name: nm, econ: e, auth: a, nat: n, support: proto[k][3] });
    }
    return out;
  }

  // k-means over (econ, auth, nat*1.5) of a sample of the country's adult agents.
  function deriveParties(W, c, sample, old) {
    var P = W.people, gov = c.gov;
    var k = gov === 'democracy' || gov === 'flawed_democracy' ? 5 : (gov === 'hybrid' ? 4 : 3);
    if (num(c.polarization, 0.3) > 0.45 && k < MAXP) k++;
    if (!P || !sample || sample.length < k * 4) return syntheticParties(W, c, popIdeo(c));
    var m = sample.length, xe = new Float64Array(m), xa = new Float64Array(m), xn = new Float64Array(m), xw = new Float64Array(m);
    var i, j, q;
    for (i = 0; i < m; i++) {
      var ix = sample[i];
      xe[i] = num(P.econ[ix], 0); xa[i] = num(P.auth[ix], 0); xn[i] = num(P.nat[ix], 0.5) * NAT_W; xw[i] = M_max(1e-6, num(P.weight[ix], 1));
    }
    var ce = new Float64Array(k), ca = new Float64Array(k), cn = new Float64Array(k), cw = new Float64Array(k), dmin = new Float64Array(m);
    var asg = new Int32Array(m);
    // k-means++ seeding
    var f = (rnd(W) * m) | 0; ce[0] = xe[f]; ca[0] = xa[f]; cn[0] = xn[f];
    for (q = 1; q < k; q++) {
      var tot = 0;
      for (i = 0; i < m; i++) {
        var best = 1e9;
        for (j = 0; j < q; j++) { var de = xe[i] - ce[j], da = xa[i] - ca[j], dn = xn[i] - cn[j]; var dd = de * de + da * da + dn * dn; if (dd < best) best = dd; }
        dmin[i] = best; tot += best;
      }
      var pick = 0, u = rnd(W) * tot;
      for (i = 0; i < m; i++) { u -= dmin[i]; if (u <= 0) { pick = i; break; } }
      ce[q] = xe[pick]; ca[q] = xa[pick]; cn[q] = xn[pick];
    }
    for (var it = 0; it < 10; it++) {
      for (i = 0; i < m; i++) {
        var bj = 0, bd = 1e9;
        for (j = 0; j < k; j++) { var de2 = xe[i] - ce[j], da2 = xa[i] - ca[j], dn2 = xn[i] - cn[j]; var d2 = de2 * de2 + da2 * da2 + dn2 * dn2; if (d2 < bd) { bd = d2; bj = j; } }
        asg[i] = bj; dmin[i] = bd;
      }
      var se = new Float64Array(k), sa = new Float64Array(k), sn = new Float64Array(k);
      cw.fill(0);
      for (i = 0; i < m; i++) { j = asg[i]; var w = xw[i]; se[j] += xe[i] * w; sa[j] += xa[i] * w; sn[j] += xn[i] * w; cw[j] += w; }
      for (j = 0; j < k; j++) {
        if (cw[j] > 0) { ce[j] = se[j] / cw[j]; ca[j] = sa[j] / cw[j]; cn[j] = sn[j] / cw[j]; }
        else { // reseed an empty cluster at the worst-fit point
          var far = 0; for (i = 1; i < m; i++) if (dmin[i] > dmin[far]) far = i;
          ce[j] = xe[far]; ca[j] = xa[far]; cn[j] = xn[far]; dmin[far] = 0;
        }
      }
    }
    var totW = 0; for (j = 0; j < k; j++) totW += cw[j];
    var order = []; for (j = 0; j < k; j++) if (cw[j] > 0) order.push(j);
    order.sort(function (x, y) { return cw[y] - cw[x]; });
    var parties = [], used = {}, takenOld = {};
    for (var oi = 0; oi < order.length; oi++) {
      j = order[oi];
      var pe = clamp(ce[j], -1, 1), pa = clamp(ca[j], -1, 1), pn = clamp(cn[j] / NAT_W, 0, 1);
      // push party platforms slightly outward from the centre (parties are more ideological than voters)
      var pi = popIdeo(c);
      pe = clamp(pe + (pe - pi.econ) * 0.25, -1, 1); pa = clamp(pa + (pa - pi.auth) * 0.25, -1, 1); pn = clamp(pn + (pn - pi.nat) * 0.2, 0, 1);
      var nm = null;
      if (old && old.length) {
        var bo = -1, bdo = 0.3;
        for (q = 0; q < old.length; q++) {
          if (takenOld[q]) continue;
          var dq = idist(pe, pa, pn, num(old[q].econ, 0), num(old[q].auth, 0), num(old[q].nat, 0.5));
          if (dq < bdo) { bdo = dq; bo = q; }
        }
        if (bo >= 0 && !used[old[bo].name]) { nm = old[bo].name; takenOld[bo] = 1; }
      }
      if (!nm) nm = partyName(pe, pa, pn, c, used);
      used[nm] = 1;
      parties.push({ name: nm, econ: pe, auth: pa, nat: pn, support: totW > 0 ? cw[j] / totW : 1 / order.length });
    }
    return parties.length ? parties : syntheticParties(W, c, popIdeo(c));
  }

  function nearestParty(c, ideo) {
    var ps = c.parties, best = -1, bd = 1e9;
    if (!ps) return -1;
    for (var k = 0; k < ps.length; k++) {
      var d = idist(ideo.econ, ideo.auth, ideo.nat, num(ps[k].econ, 0), num(ps[k].auth, 0), num(ps[k].nat, 0.5));
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  function updatePolls(W, c) {
    var S = st(W), id = c.id, ps = c.parties;
    if (!ps || !ps.length || id >= S.nC) return;
    var m = M_min(MAXP, ps.length), tot = 0, k;
    for (k = 0; k < m; k++) tot += S.R.poll[id * MAXP + k];
    if (!(tot > 0)) return;
    for (k = 0; k < m; k++) ps[k].support = clamp(num(ps[k].support, 0) + (S.R.poll[id * MAXP + k] / tot - num(ps[k].support, 0)) * 0.3, 0, 1);
  }

  // ------------------------------------------------------------------
  // Leaders
  // ------------------------------------------------------------------
  function makeLeader(W, c, opts) {
    opts = opts || EMPTY;
    var d = c.data || EMPTY, gov = c.gov || d.gov || 'hybrid', info = gi(gov);
    var culture = c.culture || d.culture || 'anglo';
    var nm = (GS.Names && GS.Names.leader) ? GS.Names.leader(culture, W.rng) : { name: 'Leader ' + ((rnd(W) * 900 + 100) | 0), sex: 0 };
    var base = opts.ideology;
    var party = (typeof opts.party === 'number' && c.parties) ? c.parties[opts.party] : null;
    if (!base) {
      if (!party && c.parties && c.rulingParty >= 0) party = c.parties[c.rulingParty];
      base = party || popIdeo(c);
    }
    base = ideoOf(base, popIdeo(c));
    if (!party && c.parties && c.rulingParty >= 0 && c.gov !== 'junta') party = c.parties[c.rulingParty] || null;
    var sd = num(opts.noise, 0.12);
    var econ = clamp(base.econ + gauss(W) * sd, -1, 1), auth = clamp(base.auth + gauss(W) * sd, -1, 1), nat = clamp(base.nat + gauss(W) * sd * 0.8, 0, 1);
    if (!info.elections && gov !== 'anarchy' && !opts.ideology && rnd(W) > 0.12) auth = clamp(auth + (M_max(auth, 0.35 + 0.3 * rnd(W)) - auth) * 0.7, -1, 1);
    // puppets: aligned with the overlord's leader
    var ov = (typeof c.overlord === 'number' && c.overlord >= 0) ? W.countries[c.overlord] : null;
    var installedBy = -1;
    if (ov && ov.alive && ov.leader && !opts.ideology) {
      econ = clamp(econ * 0.3 + num(ov.leader.econ, 0) * 0.7, -1, 1);
      auth = clamp(auth * 0.3 + num(ov.leader.auth, 0) * 0.7, -1, 1);
      nat = clamp(nat * 0.5 + num(ov.leader.nat, 0.5) * 0.3, 0, 1);
      installedBy = c.overlord;
    }
    var autoc = 1 - info.freedom;
    var aggression = clamp(0.12 + 0.35 * autoc * nat + 0.18 * M_max(0, auth) + 0.15 * nat + 0.13 * gauss(W) + num(opts.aggrBias, 0), 0.02, 0.98);
    if (installedBy >= 0) aggression *= 0.6;
    var ambition = clamp(0.35 + 0.25 * autoc + 0.1 * M_max(0, auth) + 0.15 * gauss(W), 0.02, 0.98);
    var caution = clamp(0.62 - 0.3 * aggression + 0.12 * info.freedom + 0.15 * gauss(W), 0.02, 0.98);
    var corr = c01(c.corruption, num(d.corruption, 0.4));
    var competence = clamp(0.35 + 0.25 * (1 - corr) + 0.1 * devOf(c) + 0.15 * gauss(W), 0.05, 0.98);
    var age;
    if (opts.young) age = 46 + 8 * gauss(W);
    else if (info.elections) age = 58 + 8 * gauss(W);
    else if (gov === 'junta') age = 56 + 6 * gauss(W);
    else if (gov === 'monarchy') age = 52 + 14 * gauss(W);
    else age = 62 + 9 * gauss(W);
    age = clamp(age, 30, 88);
    var pname = party ? party.name : (opts.partyName || (gov === 'junta' ? 'Armed Forces' : gov === 'monarchy' ? 'Royal House' :
      gov === 'theocracy' ? 'Clerical Council' : 'Independent'));
    return { name: nm.name, sex: nm.sex | 0, age: age, party: pname, aggression: aggression, ambition: ambition, caution: caution,
      econ: econ, auth: auth, nat: nat, competence: competence, since: W.tick | 0, installedBy: installedBy };
  }

  function anarchyLeader(W) {
    return { name: 'No central authority', sex: 0, age: 0, party: 'Warlords', aggression: 0.5, ambition: 0.5, caution: 0.3,
      econ: 0, auth: 0.5, nat: 0.5, competence: 0.1, since: W.tick | 0, none: true, installedBy: -1 };
  }

  function archiveLeader(W, c, reason) {
    var L = c.leader; if (!L || L.none) return;
    if (!c.pastLeaders) c.pastLeaders = [];
    c.pastLeaders.push({ name: L.name, party: L.party, from: L.since, to: W.tick | 0, reason: reason || '' });
    if (c.pastLeaders.length > 12) c.pastLeaders.shift();
  }

  // changeLeader(W, c, reason, opts?) — new leader, same regime. opts: {ideology, party (index), silent, young}
  function changeLeader(W, c, reason, opts) {
    if (!c || !c.alive) return null;
    opts = opts || EMPTY;
    reason = reason || 'succession';
    var old = c.leader;
    archiveLeader(W, c, reason);
    if (c.gov === 'anarchy') { c.leader = anarchyLeader(W); return c.leader; }
    var ideo = opts.ideology, partyIdx = opts.party;
    if (!ideo) {
      if (reason === 'coup') ideo = (function () { var m = milIdeo(W, c); return { econ: m.econ, auth: clamp(m.auth + 0.3, -1, 1), nat: clamp(m.nat + 0.1, 0, 1) }; })();
      else if (reason === 'puppet' && c.overlord >= 0 && alive(W, c.overlord) && W.countries[c.overlord].leader) ideo = null; // makeLeader aligns
      else if (reason !== 'election' && old && !old.none) {
        var pr = (c.parties && c.rulingParty >= 0) ? c.parties[c.rulingParty] : null;
        ideo = pr ? { econ: (num(old.econ, 0) + num(pr.econ, 0)) / 2, auth: (num(old.auth, 0) + num(pr.auth, 0)) / 2, nat: (num(old.nat, 0.5) + num(pr.nat, 0.5)) / 2 }
          : ideoOf(old);
      }
    }
    var L = makeLeader(W, c, { ideology: ideo, party: partyIdx, young: opts.young, partyName: opts.partyName });
    if (reason === 'coup' && c.gov === 'junta') L.party = 'Armed Forces';
    if (reason === 'puppet' && c.overlord >= 0) L.installedBy = c.overlord;
    c.leader = L;
    var info = gi(c.gov);
    if (reason === 'death' || reason === 'assassination') {
      // succession crises are sharper where power is personal
      var hit = c.gov === 'monarchy' ? 0.04 : (info.elections ? 0.03 : 0.12);
      c.legitimacy = c01(num(c.legitimacy, 0.5) - hit);
      c.stability = c01(num(c.stability, 0.5) - hit * 0.8);
    }
    if (!opts.silent && old && !old.none) {
      var t = null, imp = 2;
      if (reason === 'death') t = old.name + ', leader of ' + c.name + ', has died aged ' + M_round(num(old.age, 70)) + '. ' + L.name + ' succeeds.';
      else if (reason === 'assassination') { t = L.name + ' takes power in ' + c.name + ' after the assassination of ' + old.name + '.'; imp = 3; }
      else if (reason === 'resignation') t = old.name + ' resigns as leader of ' + c.name + ' amid collapsing approval; ' + L.name + ' (' + L.party + ') takes over.';
      else if (reason === 'retirement') t = old.name + ' steps down after ' + yearsSince(W, old.since).toFixed(0) + ' years in power in ' + c.name + '; ' + L.name + ' succeeds.';
      else if (reason === 'puppet') { t = (alive(W, c.overlord) ? W.countries[c.overlord].name : 'A foreign power') + ' installs a loyal government in ' + c.name + ' under ' + L.name + '.'; imp = 3; }
      else if (reason === 'coup' || reason === 'election') t = null;
      else t = L.name + ' becomes leader of ' + c.name + '.';
      if (t) post(W, t, c, imp, 'leader', reason === 'puppet' ? [c.overlord] : null);
    }
    return L;
  }

  // ------------------------------------------------------------------
  // Regimes
  // ------------------------------------------------------------------
  function govFromIdeology(W, c, ideo, ctx) {
    var a = num(ideo.auth, 0), e = num(ideo.econ, 0), n = num(ideo.nat, 0.5), dev = devOf(c);
    if (ctx === 'coup') return 'junta';
    if (a < -0.2) return dev > 0.5 ? 'democracy' : 'flawed_democracy';
    if (a < 0.1) return dev > 0.3 ? 'flawed_democracy' : 'hybrid';
    if (a < 0.32) return 'hybrid';
    if (e < -0.35) return 'oneparty';
    if (n > 0.65 && religious(c)) return 'theocracy';
    if (ctx === 'military') return 'junta';
    return 'autocracy';
  }

  // changeGov(W, c, gov, reason, opts?) — new regime; installs a fresh leader suited to it (no separate changeLeader needed).
  // opts: {ideology, silent, keepLeader}
  function changeGov(W, c, gov, reason, opts) {
    if (!c || !GOV_INFO[gov]) return;
    opts = opts || EMPTY;
    var old = c.gov, oldInfo = gi(old), info = GOV_INFO[gov], oldLeader = c.leader;
    c.gov = gov;
    c.regimeSince = W.tick | 0;
    c.demDrift = 0;
    c.freedom = c01(num(c.freedom, info.freedom) + (info.freedom - num(c.freedom, info.freedom)) * 0.6);
    c.repression = clamp(M_min(num(c.repression, 0), info.repressionCap), 0, 1);
    if (gov === 'anarchy') {
      archiveLeader(W, c, reason);
      c.leader = anarchyLeader(W);
      c.rulingParty = -1; c.nextElection = -1; c.anarchyMonths = 0;
      c.legitimacy = 0.05; c.stability = M_min(num(c.stability, 0.3), 0.15);
      if (c.policy) { c.policy.taxTarget = 0.05; c.policy.milTarget = 0.01; c.policy.welfareTarget = 0.01; }
      c.repression = 0;
    } else {
      c.anarchyMonths = 0;
      var ideo = opts.ideology ? ideoOf(opts.ideology) : (reason === 'coup' ? milIdeo(W, c) : popIdeo(c));
      if (!c.parties || !c.parties.length || (info.elections && !oldInfo.elections)) {
        c.parties = deriveParties(W, c, sampleCountry(W, c.id, 300), c.parties);
      }
      c.rulingParty = nearestParty(c, ideo);
      if (info.elections) {
        if (!oldInfo.elections || num(c.nextElection, -1) < 0) c.nextElection = (W.tick | 0) + 26 + ((rnd(W) * 52) | 0);
      } else c.nextElection = -1;
      c.legitimacy = (reason === 'revolution' || reason === 'election' || reason === 'reform' || reason === 'referendum') ? 0.55 :
        (reason === 'coup' ? 0.35 : 0.42);
      if (!opts.keepLeader || !oldLeader || oldLeader.none) {
        archiveLeader(W, c, reason);
        c.leader = makeLeader(W, c, { ideology: ideo, party: c.rulingParty, young: reason === 'revolution' || reason === 'civil war', noise: 0.08 });
        if (gov === 'junta') c.leader.party = 'Armed Forces';
      }
    }
    if (!opts.silent && old !== gov) {
      var L = c.leader;
      var t = 'Regime change in ' + c.name + ': ' + (GOV_INFO[old] ? oldInfo.label.toLowerCase() : 'the old order') + ' gives way to ' +
        info.label.toLowerCase() + (reason ? ' (' + reason + ')' : '') + '.' + (L && !L.none ? ' ' + L.name + ' leads the country.' : '');
      post(W, t, c, 3, 'regime');
    }
  }

  // ------------------------------------------------------------------
  // Elections
  // ------------------------------------------------------------------
  function holdElection(W, c) {
    var info = gi(c.gov), P = W.people, S = st(W);
    if (!c.parties || !c.parties.length) c.parties = deriveParties(W, c, sampleCountry(W, c.id, 300), null);
    // party systems evolve: re-cluster roughly every third election
    else if (rnd(W) < 0.33) {
      var oldRul = (c.rulingParty >= 0 && c.parties[c.rulingParty]) ? c.parties[c.rulingParty] : null;
      c.parties = deriveParties(W, c, sampleCountry(W, c.id, 300), c.parties);
      c.rulingParty = oldRul ? nearestParty(c, oldRul) : -1;
    }
    var ps = c.parties, k = M_min(MAXP, ps.length), votes = new Float64Array(k), q;
    var pe = new Float64Array(k), pa = new Float64Array(k), pn = new Float64Array(k), small = new Float64Array(k);
    for (q = 0; q < k; q++) {
      pe[q] = num(ps[q].econ, 0); pa[q] = num(ps[q].auth, 0); pn[q] = num(ps[q].nat, 0.5) * NAT_W;
      small[q] = num(ps[q].support, 0.2) < 0.06 ? 0.08 : 0; // strategic desertion of tiny parties
    }
    var rul = (c.rulingParty >= 0 && c.rulingParty < k) ? c.rulingParty : -1;
    var logged = [], logP = 3 / M_max(30, num(c.agents, 300)), total = 0;
    if (P && P.alive) {
      refreshOwners(W, S);
      var n = P.n | 0, al = P.alive, region = P.region, rOwner = S.rOwner, nR = S.nR, cid = c.id;
      var useList = S.statsTick >= 0 && cid < S.nC && S.R.head[cid] >= 0, nxt = S.R.nxt, guard = n;
      for (var i = useList ? S.R.head[cid] : 0; useList ? (i >= 0 && guard-- > 0) : i < n; i = useList ? nxt[i] : i + 1) {
        if (!al[i]) continue;
        var r = region[i]; if (r < 0 || r >= nR || rOwner[r] !== cid || P.age[i] < 18) continue;
        var w = P.weight[i]; if (!(w > 0)) continue;
        var e = P.econ[i], a = P.auth[i], nt = P.nat[i] * NAT_W, ap = P.approval[i], u = rnd(W) * 7919;
        var best = 0, bd = 1e9;
        for (q = 0; q < k; q++) {
          var de = e - pe[q], da = a - pa[q], dn = nt - pn[q];
          var hz = u * (q + 1.618); hz -= M_floor(hz);   // cheap per-party strategic noise from one draw
          var dd = M_sqrt(de * de + da * da + dn * dn) + small[q] + (hz - 0.5) * 0.3;
          if (q === rul) dd -= (ap - 0.5) * 0.6;
          if (dd < bd) { bd = dd; best = q; }
        }
        votes[best] += w; total += w;
        if (logged.length < 4 && rnd(W) < logP) logged.push(i, best);
      }
    }
    if (!(total > 0)) { for (q = 0; q < k; q++) votes[q] = num(ps[q].support, 1 / k); total = 0; for (q = 0; q < k; q++) total += votes[q]; }
    if (!(total > 0)) { c.nextElection = (W.tick | 0) + TERM; return; }
    // fraud (scaled by how authoritarian the incumbent is)
    var L = c.leader || EMPTY;
    if (rul >= 0 && info.fraud > 0) votes[rul] += total * info.fraud * (0.5 + M_max(0, num(L.auth, 0)));
    var sum = 0; for (q = 0; q < k; q++) sum += votes[q];
    var order = []; for (q = 0; q < k; q++) { ps[q].support = sum > 0 ? votes[q] / sum : 0; order.push(q); }
    order.sort(function (x, y) { return votes[y] - votes[x]; });
    var win = order[0], wp = ps[win];
    c.lastElection = W.tick | 0;
    c.nextElection = (W.tick | 0) + TERM;
    c.electionResults = order.slice(0, 3).map(function (q2) { return { party: ps[q2].name, share: ps[q2].support }; });
    var oldL = c.leader, changed = false, termOut = false;
    if (win !== rul) {
      c.rulingParty = win;
      changeLeader(W, c, 'election', { party: win, silent: true });
      changed = true;
    } else if (info.termLimitYears > 0 && oldL && yearsSince(W, oldL.since) >= info.termLimitYears - 0.5) {
      changeLeader(W, c, 'election', { party: win, silent: true });
      changed = true; termOut = true;
    }
    if (changed) c.legitimacy = c01(num(c.legitimacy, 0.5) + 0.1);
    var wa = num(wp.auth, 0), wn = num(wp.nat, 0.5), we = num(wp.econ, 0);
    // nationalism alone is not radical in an electorate where every party is nationalist; it must come with
    // an authoritarian streak (the same test that names a party a 'National Front')
    var exNat = wn > 0.8 && wa > 0.15;
    var extremist = wa > 0.6 || exNat || M_abs(we) > 0.8;
    var exLabel = exNat ? 'nationalist' : (wa > 0.6 ? 'authoritarian' : (we < 0 ? 'far-left' : 'hard-right'));
    if (extremist && num(wp.auth, 0) > 0.3) c.demDrift = num(c.demDrift, 0) + 0.25;
    // news
    var res = c.electionResults.map(function (x) { return x.party + ' ' + pct(x.share); }).join(', ');
    var y = GS.dateOf ? GS.dateOf(W.tick | 0).y : '';
    var t = c.name + ' election ' + y + ': ' + res + '. ' +
      (changed ? (termOut ? c.leader.name + ' succeeds the term-limited ' + (oldL ? oldL.name : 'incumbent') : c.leader.name + ' (' + wp.name + ') takes office' + (oldL && !oldL.none ? ', ousting ' + oldL.name : ''))
        : (oldL ? oldL.name : 'The incumbent') + ' re-elected') + '.' +
      (extremist ? ' A radical ' + exLabel + ' party now governs.' : '') +
      (info.fraud > 0.1 ? ' Observers report widespread irregularities.' : '');
    post(W, t, c, (changed ? 2 : 1) + (extremist ? 1 : 0), 'election');
    if (GS.People && typeof GS.People.logEvent === 'function') {
      for (var li = 0; li < logged.length; li += 2) {
        var pr = ps[logged[li + 1]];
        if (pr) GS.People.logEvent(W, logged[li], 'voted for the ' + pr.name + ' in the ' + y + ' election');
      }
    }
  }

  // ------------------------------------------------------------------
  // Country init
  // ------------------------------------------------------------------
  function defaultPolicy(c) {
    var d = c.data || EMPTY, dev = devOf(c);
    return {
      taxTarget: clamp(num(c.taxRate, 0.10 + 0.25 * dev), 0.03, 0.6),
      milTarget: clamp(num(c.spendMil, num(d.mil, 2) / 100), 0.001, 0.4),
      welfareTarget: clamp(num(c.spendWelfare, 0.02 + 0.13 * dev), 0, 0.35)
    };
  }

  function initCountry(W, c, sample) {
    if (!c) return;
    var S = st(W), d = c.data || EMPTY, pend = S.pending; S.pending = null;
    var midGame = (W.tick | 0) > 0 || !!pend || (typeof c.parent === 'number' && c.parent >= 0);
    var gov = GOV_INFO[c.gov] ? c.gov : (GOV_INFO[d.gov] ? d.gov : 'hybrid');
    c.gov = gov;
    var info = GOV_INFO[gov];
    var parent = (typeof c.parent === 'number' && c.parent >= 0) ? W.countries[c.parent] : null;
    c.corruption = c01(c.corruption, num(d.corruption, parent ? num(parent.corruption, 0.5) : 0.5));
    c.freedom = info.freedom;
    c.repression = info.repressionCap * (info.elections ? 0.2 : 0.5);
    c.unrest = midGame ? 0.3 : 0.12;
    c.stability = midGame ? 0.45 : clamp(0.55 + 0.25 * (1 - c.corruption) + gauss(W) * 0.05, 0.3, 0.9);
    c.legitimacy = midGame ? 0.5 : clamp(0.45 + 0.3 * info.freedom + 0.1 * (1 - c.corruption), 0.3, 0.9);
    c.civilWar = null;
    c.demDrift = 0;
    c.anarchyMonths = 0;
    c.lastElection = -1;
    c.electionResults = null;
    c.regimeSince = midGame ? (W.tick | 0) : -((rnd(W) * 52 * 25) | 0);
    if (!sample) sample = sampleCountry(W, c.id, 300);
    c.parties = deriveParties(W, c, sample, null);
    var ref = pend && pend.ideology ? ideoOf(pend.ideology) :
      (d.econ !== void 0 ? { econ: clamp(num(d.econ, 0), -1, 1), auth: clamp(num(d.auth, 0), -1, 1), nat: clamp(num(d.nat, 0.5), 0, 1) } : popIdeo(c));
    c.rulingParty = gov === 'anarchy' ? -1 : nearestParty(c, ref);
    if (gov === 'anarchy') c.leader = anarchyLeader(W);
    else {
      var pr = c.rulingParty >= 0 ? c.parties[c.rulingParty] : null;
      var li = pr ? { econ: (pr.econ + ref.econ) / 2, auth: (pr.auth + ref.auth) / 2, nat: (pr.nat + ref.nat) / 2 } : ref;
      c.leader = makeLeader(W, c, { ideology: li, party: c.rulingParty, noise: 0.1, young: !!pend });
      if (!midGame) {
        var yrs = info.elections ? rnd(W) * 7 : rnd(W) * 18;
        c.leader.since = -M_round(yrs * 52);
      }
      if (gov === 'junta') c.leader.party = 'Armed Forces';
    }
    c.pastLeaders = [];
    c.nextElection = info.elections ? (W.tick | 0) + (midGame ? 26 + ((rnd(W) * 52) | 0) : 1 + ((rnd(W) * TERM) | 0)) : -1;
    var pol = defaultPolicy(c);
    if (parent && parent.policy) { pol.taxTarget = num(parent.policy.taxTarget, pol.taxTarget); pol.welfareTarget = num(parent.policy.welfareTarget, pol.welfareTarget); }
    c.policy = pol;
    if (pend && pend.revives >= 0) c.revives = pend.revives;
  }

  function init(W) {
    var S = st(W), cs = W.countries || [];
    var samples = sampleAll(W, 300);
    for (var id = 0; id < cs.length; id++) {
      var c = cs[id];
      if (!c || !c.alive) continue;
      S.pending = null;
      initCountry(W, c, samples[id]);
    }
    gatherStats(W);
    for (id = 0; id < cs.length; id++) {
      var c2 = cs[id];
      if (!c2 || !c2.alive || !c2.data || !c2.data.startCivilWar) continue;
      startCivilWar(W, c2, { rebelShare: num(c2.data.rebelShare, 0.35), ongoing: true });
    }
  }

  // ------------------------------------------------------------------
  // Monthly indices: unrest, legitimacy, stability, freedom, corruption
  // ------------------------------------------------------------------
  function computeIndices(W, c, info) {
    var d = c.data || EMPTY, g = W.global || EMPTY, L = c.leader || EMPTY;
    var prot = c01(c.protestShare), unemp = c01(c.unemployment, 0.06), infl = clamp(num(c.inflation, 0.03), -1, 50);
    var exh = c01(c.warExhaustion), appr = c01(c.approval, 0.5), radS = c01(c.radicalShare);
    var food = num(c.food, num(d.food, 0)), fp = num(g.foodPrice, 100);
    var famine = clamp(num(c.famine, 0) + M_max(0, -food) * M_max(0, fp / 100 - 1.25) * 0.9, 0, 1);
    var devS = 0, nr = 0, regs = c.regions || [];
    for (var k = 0; k < regs.length; k++) { var rg = W.regions[regs[k]]; if (rg) { devS += c01(rg.devastation); nr++; } }
    var devast = nr ? devS / nr : 0;
    var anarchy = c.gov === 'anarchy' ? 1 : 0, cw = c.civilWar ? 1 : 0;
    var target = prot * 2.2 + M_max(0, unemp - 0.06) * 1.1 + clamp(M_max(0, infl - 0.05) * 0.7, 0, 0.4) + exh * 0.3 +
      famine * 0.5 + devast * 0.4 + M_max(0, 0.45 - appr) * 0.9 + radS * 0.3 + cw * 0.15 + anarchy * 0.35 +
      (c.defaulted ? 0.08 : 0) - c01(c.repression) * 0.12;
    c.unrest = c01(num(c.unrest, 0.2) + (c01(target) - num(c.unrest, 0.2)) * 0.35);
    // legitimacy
    var growth = clamp(num(c.growth, 0.02), -0.5, 0.5), corr = c01(c.corruption, 0.4), lt;
    if (anarchy) lt = 0.05;
    else if (info.elections) {
      lt = 0.3 + 0.45 * appr + 0.15 * (1 - info.fraud * 2) + ((c.lastElection >= 0 && (W.tick - c.lastElection) < 52) ? 0.08 : 0) - corr * 0.1;
    } else {
      lt = 0.22 + 0.35 * appr + 0.12 * clamp(yearsSince(W, c.regimeSince) / 30, 0, 1) + 0.15 * clamp(growth * 5 + 0.5, 0, 1) - 0.15 * corr +
        (c.gov === 'monarchy' ? 0.1 : 0) + (c.gov === 'theocracy' ? 0.06 : 0);
    }
    if (cw) lt -= 0.15;
    if (typeof c.overlord === 'number' && c.overlord >= 0) lt -= 0.12;
    c.legitimacy = c01(num(c.legitimacy, 0.5) + (c01(lt) - num(c.legitimacy, 0.5)) * 0.15);
    var milA = c01(c.milApproval, appr);
    var stT = 0.15 + 0.35 * c.legitimacy + 0.3 * (1 - c.unrest) + 0.15 * milA + 0.05 * c01(L.competence, 0.5) - 0.25 * cw - 0.3 * anarchy - 0.1 * exh;
    c.stability = c01(num(c.stability, 0.5) + (c01(stT) - num(c.stability, 0.5)) * 0.2);
    var fT = info.freedom * (1 - 0.35 * c01(c.repression)) - cw * 0.08;
    c.freedom = c01(num(c.freedom, info.freedom) + (c01(fT) - num(c.freedom, info.freedom)) * 0.1);
    var cT = num(d.corruption, 0.45) * 0.7 + (1 - c.freedom) * 0.25 + (1 - c01(L.competence, 0.5)) * 0.1 + anarchy * 0.3;
    c.corruption = c01(corr + (c01(cT) - corr) * 0.01);
    return famine;
  }

  // ------------------------------------------------------------------
  // Leader policy AI: coordinate ascent on a utility built from traits, ideology, threat, unrest, budget.
  // ------------------------------------------------------------------
  function choosePolicy(W, c, info) {
    var pol = c.policy;
    if (!pol || typeof pol !== 'object') pol = c.policy = defaultPolicy(c);
    pol.taxTarget = clamp(num(pol.taxTarget, 0.2), 0.03, 0.6);
    pol.milTarget = clamp(num(pol.milTarget, 0.02), 0.001, 0.4);
    pol.welfareTarget = clamp(num(pol.welfareTarget, 0.08), 0, 0.35);
    if (c.gov === 'anarchy') {
      pol.taxTarget += (0.05 - pol.taxTarget) * 0.3; pol.milTarget += (0.01 - pol.milTarget) * 0.3; pol.welfareTarget += (0.01 - pol.welfareTarget) * 0.3;
      c.repression = 0;
      return;
    }
    var L = c.leader || EMPTY, d = c.data || EMPTY, dev = devOf(c);
    var Le = clamp(num(L.econ, 0), -1, 1), La = clamp(num(L.auth, 0), -1, 1), Ln = c01(L.nat, 0.5);
    var aggr = c01(L.aggression, 0.4), caut = c01(L.caution, 0.5);
    // reference levels: the fiscal settlement the country actually started with (taxes that fund its state)
    var e0 = c.eco || EMPTY;
    var baseTax = clamp(num(e0.tax0, 0.10 + 0.25 * dev), 0.05, 0.6), baseWel = 0.02 + 0.13 * dev, baseMil = clamp(num(d.mil, 2) / 100, 0.003, 0.15);
    var threat = c01(c.threat), atWar = c.atWar ? 1 : 0, cw = c.civilWar ? 1 : 0, exh = c01(c.warExhaustion);
    var other = clamp(num(c.spendOther, 0.08 + 0.06 * dev), 0, 0.5);
    var dr = clamp(num(c.debtRatio, 0.6), 0, 5), by = clamp(num(c.bondYield, 0.04), 0, 0.5);
    var dr0 = clamp(num(c.eco && c.eco.dr0, 0.6), 0, 5); // the debt level the bond market has long tolerated
    var interest = dr * by, unrest = c01(c.unrest);
    // allied power behind this country now vs its 1-year average: a vanished protector is a reason to rearm
    var allyP = 0;
    if (GS.Diplo && typeof GS.Diplo.allies === 'function') {
      var al = GS.Diplo.allies(W, c) || [];
      for (var ai = 0; ai < al.length; ai++) { var ac = W.countries[al[ai]]; if (ac && ac.alive) allyP += M_max(0, num(ac.power, 0)); }
    }
    if (!(c.allyPowY >= 0)) c.allyPowY = allyP;
    var lost = c.allyPowY > 1 ? clamp(1 - allyP / c.allyPowY, 0, 1) : 0;
    c.allyPowY += (allyP - c.allyPowY) / 12;
    c.lostProtector = lost;
    var welIdeal = baseWel * (1 - 0.55 * Le) + unrest * 0.02 * (1 - M_max(0, La));
    var taxIdeal = baseTax * (1 - 0.3 * Le);
    var milIdeal = baseMil * (0.8 + 0.4 * aggr) + threat * 0.05 * (0.6 + aggr + 0.4 * Ln) +
      atWar * (0.03 + 0.05 * aggr) * (1 - 0.5 * exh) * clamp(1 - baseMil / 0.08, 0.15, 1) + cw * 0.03 - ((typeof c.overlord === 'number' && c.overlord >= 0) ? baseMil * 0.3 : 0);
    milIdeal += baseMil * 1.5 * lost * (0.5 + threat);
    if (threat > 0.3) milIdeal = M_max(milIdeal, baseMil * (1 + 1.5 * threat));
    milIdeal = clamp(milIdeal, 0.002, 0.3);
    var okDef = clamp(0.03 - 0.02 * M_max(0, dr - M_max(0.6, dr0)), -0.02, 0.04) + atWar * 0.04 + cw * 0.02 + threat * 0.01;
    var fiscalW = (25 + 60 * caut) * (1 + M_max(0, dr - M_max(0.9, dr0)) * 1.5) * (c.defaulted ? 3 : 1);
    var popW = (info.elections ? 1 : 0.35) + unrest * 1.2;
    var repCap = info.repressionCap;
    var repIdeal = repCap * c01(unrest * 1.2 * (0.35 + M_max(0, La)) + M_max(0, La) * 0.3 + cw * 0.25 - (info.elections ? 0.2 : 0));
    var milK = 400 + 300 * threat + 200 * atWar + 200 * lost; // defence budgets are sticky (procurement, personnel)
    function U(t, m, w, r) {
      var u = 0, x;
      x = w - welIdeal; u -= x * x * 60;
      x = t - taxIdeal; u -= x * x * 40;
      x = m - milIdeal; u -= x * x * milK;
      x = (m + w + other + interest - t) - okDef; if (x > 0) u -= x * x * fiscalW * 10;
      u += popW * ((w - baseWel) * 1.2 - (t - baseTax) * 1.6);
      x = r - repIdeal; u -= x * x * 8;
      return u;
    }
    var v = [pol.taxTarget, pol.milTarget, pol.welfareTarget, clamp(num(c.repression, 0), 0, repCap)];
    var steps = [0.005, atWar || cw ? 0.006 : 0.002, 0.004, 0.03];
    var lo = [0.03, 0.001, 0, 0], hi = [0.6, 0.4, 0.35, repCap];
    var mult = [0, 1, -1, 2, -2, 4, -4];
    for (var pass = 0; pass < 2; pass++) {
      for (var kx = 0; kx < 4; kx++) {
        var bestV = v[kx], bestU = -1e18;
        for (var mi = 0; mi < mult.length; mi++) {
          var cand = clamp(v[kx] + steps[kx] * mult[mi], lo[kx], hi[kx]);
          var save = v[kx]; v[kx] = cand;
          var uu = U(v[0], v[1], v[2], v[3]);
          v[kx] = save;
          if (uu > bestU + 1e-12) { bestU = uu; bestV = cand; }
        }
        v[kx] = bestV;
      }
    }
    pol.taxTarget = v[0]; pol.milTarget = v[1]; pol.welfareTarget = v[2];
    c.repression = clamp(v[3], 0, repCap);
  }

  // ------------------------------------------------------------------
  // Coups, revolutions, civil-war onset, erosion, independence
  // ------------------------------------------------------------------
  function coupCheck(W, c, info) {
    var L = c.leader || EMPTY, milA = c01(c.milApproval, c01(c.approval, 0.5));
    var f = (clamp((0.5 - milA) * 4, 0, 1.5) + (c.gov === 'junta' ? 0.1 : 0.02)) * (c01(c.unrest) * 2 + (1 - c01(c.stability, 0.5))) *
      (1 - 0.4 * c01(L.caution, 0.5)) * (c.civilWar ? 1.5 : 1) * (1 + c01(c.warExhaustion));
    var dv = devOf(c), base = info.coup;
    if (c.gov === 'democracy' && dv > 0.7) base *= 0.02;
    else if (c.gov === 'flawed_democracy' && dv > 0.7) base *= 0.2;
    if (!chance(W, base * f)) return false;
    attemptCoup(W, c, false);
    return true;
  }

  function attemptCoup(W, c, force) {
    var L = c.leader || EMPTY, milA = c01(c.milApproval, c01(c.approval, 0.5));
    var success = force ? 1 : clamp(0.45 + (0.5 - milA) * 0.9 - c01(L.caution, 0.5) * 0.15 - c01(c.legitimacy, 0.5) * 0.2 + c01(c.unrest) * 0.2, 0.12, 0.88);
    var m = milIdeo(W, c), ideo = { econ: m.econ, auth: clamp(m.auth + 0.3, -1, 1), nat: clamp(m.nat + 0.1, 0, 1) };
    var oldName = L.name || 'the government';
    if (rnd(W) < success) {
      var info = gi(c.gov);
      var toJunta = c.gov === 'junta' || info.elections || c.gov === 'anarchy' || rnd(W) < 0.7;
      if (c.gov === 'junta' && rnd(W) < 0.5) { toJunta = false; changeGov(W, c, 'autocracy', 'coup', { ideology: ideo, silent: true }); }
      else if (toJunta && c.gov !== 'junta') changeGov(W, c, 'junta', 'coup', { ideology: ideo, silent: true });
      else changeLeader(W, c, 'coup', { ideology: ideo, silent: true, partyName: c.gov === 'junta' ? 'Armed Forces' : null });
      c.unrest = c01(c.unrest * 0.8);
      post(W, 'Military coup in ' + c.name + ': ' + oldName + ' is overthrown; ' + (c.gov === 'junta' ? 'General ' : '') + c.leader.name +
        ' seizes power' + (toJunta ? ' at the head of a military junta.' : '.'), c, 3, 'coup');
      return true;
    }
    c.repression = clamp(num(c.repression, 0) + 0.1, 0, gi(c.gov).repressionCap);
    if (GS.People && GS.People.kill) GS.People.kill(W, { country: c.id, fraction: 0.01, cause: 'purge', jobs: [MIL] });
    post(W, 'Coup attempt fails in ' + c.name + '; ' + oldName + ' purges the officer corps.', c, 2, 'coup');
    return false;
  }

  function revolutionCheck(W, c, info) {
    var unrest = c01(c.unrest), prot = c01(c.protestShare), milA = c01(c.milApproval, 0.5);
    if (unrest < 0.5 || (prot < 0.04 && c01(c.radicalShare) < 0.2)) return false;
    // new rulers get a honeymoon: no revolution within a year of taking power
    if (yearsSince(W, c.regimeSince) < 1 || (c.leader && yearsSince(W, c.leader.since) < 1)) return false;
    // revolutionary exhaustion: a society that just overthrew its rulers rarely mobilises again for years
    if (c.lastRevolution != null && yearsSince(W, c.lastRevolution) < 3) return false;
    var sc = stateCapacity(c);
    var capacity = 0.15 + info.repressionCap * c01(c.repression) * 0.8 + milA * 0.3 + c01(c.legitimacy, 0.5) * 0.35 + (info.elections ? c01(c.freedom) * 0.3 : 0) +
      sc * 0.3;
    if (unrest <= capacity) return false;
    if (!chance(W, clamp((unrest - capacity) * 1.5, 0, 0.5))) return false;
    var success = clamp(0.4 + (unrest - capacity) * 2 - c01(c.repression) * 0.3 + (0.5 - milA) * 0.6, 0.1, 0.9);
    if (rnd(W) < success) { revolution(W, c); return true; }
    // failed uprising: escalation to civil war in divided societies, else crackdown
    if (num(c.polarization, 0) > 0.3 && unrest > 0.6 && (W.tick | 0) >= num(c.cwCooldown, -1) && rnd(W) < 1.2 * c01(c.polarization) * (1 - sc) * (1 - sc)) {
      startCivilWar(W, c, { kind: 'regime', src: 'uprising' });
      return true;
    }
    crackdown(W, c, 'Uprising crushed in ' + c.name + ': security forces disperse mass protests against ' + ((c.leader && c.leader.name) || 'the government') + '.');
    return true;
  }

  function crackdown(W, c, text) {
    var info = gi(c.gov);
    c.repression = clamp(num(c.repression, 0) + 0.15, 0, info.repressionCap);
    var killed = 0;
    if (GS.People && GS.People.kill && info.repressionCap > 0.3) killed = GS.People.kill(W, { country: c.id, fraction: 0.01 * info.repressionCap, cause: 'repression', flags: F_PROTEST });
    post(W, text + (killed > 1000 ? ' Hundreds are reported dead.' : ''), c, 2, 'unrest');
  }

  // Successful revolution (exposed: God.revolution may call it). New regime from protesters' mean ideology.
  function revolution(W, c) {
    if (!c || !c.alive) return;
    var ideo = protIdeo(W, c), old = c.leader, oldGov = c.gov;
    var gov = govFromIdeology(W, c, ideo, 'revolution');
    if (gov === oldGov && gov !== 'anarchy') {
      // same regime type: the revolution still sweeps away the ruling elite
      changeLeader(W, c, 'revolution', { ideology: ideo, silent: true, young: true });
      c.rulingParty = nearestParty(c, ideo);
      if (c.leader && c.rulingParty >= 0) c.leader.party = c.parties[c.rulingParty].name;
    } else changeGov(W, c, gov, 'revolution', { ideology: ideo, silent: true });
    if (c.civilWar) { c.civilWar = null; }
    c.unrest = c01(c.unrest * 0.6);
    c.lastRevolution = W.tick | 0;
    post(W, 'Revolution in ' + c.name + ': ' + (old && !old.none ? old.name + ' is toppled by mass protests. ' : 'Mass protests sweep away the old order. ') +
      c.leader.name + ' proclaims a new ' + gi(c.gov).label.toLowerCase() + '.', c, 4, 'revolution');
    logSome(W, c.id, 5, function (P, i) { return (P.flags[i] & F_PROTEST) !== 0; }, 'took to the streets in the revolution that toppled ' + (old && !old.none ? old.name : 'the old regime'));
    calmVictors(W, c.id);
  }

  // The protesters won: they go home, de-radicalised and hopeful about the regime they installed.
  function calmVictors(W, cid) {
    var P = W.people;
    if (!P || !P.alive) return;
    var S = st(W), n = P.n | 0;
    for (var i = 0; i < n; i++) {
      if (!P.alive[i]) continue;
      var r = P.region[i];
      if (r < 0 || r >= S.nR || S.rOwner[r] !== cid) continue;
      if ((P.flags[i] & F_PROTEST) === 0) continue;
      P.flags[i] &= ~F_PROTEST;
      P.radical[i] *= 0.4;
      if (P.approval[i] < 0.65) P.approval[i] = 0.65;
    }
  }

  function logSome(W, cid, max, test, text) {
    var P = W.people;
    if (!P || !P.alive || !GS.People || typeof GS.People.logEvent !== 'function') return;
    var S = st(W), n = P.n | 0, got = 0;
    if (n <= 0) return;
    var start = (rnd(W) * n) | 0;
    for (var j = 0; j < n && got < max; j++) {
      var i = (start + j) % n;
      if (!P.alive[i]) continue;
      var r = P.region[i];
      if (r < 0 || r >= S.nR || S.rOwner[r] !== cid) continue;
      if (!test(P, i)) continue;
      GS.People.logEvent(W, i, text); got++;
    }
  }

  // 0..1: income per head and an army that is paid for (the state's reach into its territory)
  function stateCapacity(c) {
    var dv = devOf(c), mil = clamp(num(c.spendMil, 0.015) / 0.03, 0, 1);
    return c01(dv * 0.75 + mil * 0.25 * (0.4 + 0.6 * dv) - (c.defaulted ? 0.1 : 0));
  }
  function civilWarOnset(W, c, info) {
    if ((W.tick | 0) < num(c.cwCooldown, -1)) return false;
    var unrest = c01(c.unrest), pol = c01(num(c.polarization, 0)), sc = stateCapacity(c), stab = c01(c.stability, 0.5);
    var growth = clamp(num(c.growth, 0.02), -0.5, 0.5), calm = growth > 0.02 ? 0.6 : 1;
    // mass-unrest route: a divided, unstable society in turmoil
    if (unrest >= 0.5 && pol >= 0.3 && stab <= 0.5) {
      var p = (unrest - 0.45) * 0.05 * (1 + pol) * (info.elections ? 0.3 : 1) * (1.5 - c01(c.milApproval, 0.5)) * 2 * (1 - sc) * (1 - sc) * calm;
      if (chance(W, p)) { startCivilWar(W, c, { kind: 'regime', src: 'onset' }); return true; }
    }
    // low-level insurgency: poor, weak states with radicalised or divided populations
    var pi = 0.004 * (1 - sc) * (1 - sc) * (0.3 + pol + c01(c.minorityShare)) * (1 + 3 * c01(c.radicalShare)) * (1 - 0.5 * stab) *
      (info.elections && c.gov !== 'hybrid' ? 0.4 : 1) * calm;
    if (chance(W, pi)) { startCivilWar(W, c, { kind: 'regime', insurgency: true, rebelShare: 0.06 }); return true; }
    return false;
  }

  function democraticDrift(W, c, info) {
    var L = c.leader || EMPTY; if (L.none) return;
    var La = clamp(num(L.auth, 0), -1, 1), amb = c01(L.ambition, 0.5);
    var prefFree = (1 - clamp(num(c.ideoAuth, 0), -1, 1)) * 0.5;
    var push = 0;
    if (La > 0.3) push += (La - 0.3) * (0.5 + amb) * 0.035;
    push -= (prefFree - 0.4) * 0.02;
    if (La < 0) push += La * 0.045;
    if (c.gov === 'junta') {
      var jy = yearsSince(W, c.regimeSince);
      if (jy > 3) push -= 0.03 + 0.01 * M_min(10, jy - 3); // pressure to return to the barracks grows with time
    }
    if (!info.elections) push -= c01(c.protestShare) * 0.3 * (1 - M_max(0, La));
    if (c.gov === 'democracy') push -= 0.006;
    c.demDrift = clamp(num(c.demDrift, 0) * 0.99 + push, -1.2, 1.2);
    var t;
    if (c.demDrift >= 1) {
      var nx = ERODE[c.gov];
      if (nx && (c.gov !== 'hybrid' || (La > 0.6 && yearsSince(W, L.since) > 2))) {
        var old = gi(c.gov).label;
        changeGov(W, c, nx, 'erosion', { keepLeader: true, silent: true });
        t = 'Democratic backsliding in ' + c.name + ': under ' + L.name + ' the ' + old.toLowerCase() + ' slides into ' + an(gi(nx).label.toLowerCase()) + '.';
        post(W, t, c, 2, 'regime');
      }
      c.demDrift = 0;
    } else if (c.demDrift <= -1) {
      var lx = LIBERALIZE[c.gov];
      if (lx === 'democracy' && (devOf(c) < 0.45 || c01(c.corruption) > 0.55)) lx = null;
      if (lx) {
        var old2 = gi(c.gov).label;
        if (c.gov === 'junta') {
          // the generals return to the barracks: a civilian government drawn from the population takes over
          changeGov(W, c, lx, 'reform', { silent: true, ideology: popIdeo(c) });
          t = 'The military junta in ' + c.name + ' hands power to a civilian government under ' + c.leader.name + '.';
        } else {
          changeGov(W, c, lx, 'reform', { keepLeader: true, silent: true });
          t = 'Reform in ' + c.name + ': the ' + old2.toLowerCase() + ' liberalises into ' + an(gi(lx).label.toLowerCase()) + ' under ' + L.name + '.';
        }
        post(W, t, c, 2, 'regime');
      }
      c.demDrift = 0;
    }
  }

  function leaderMortality(W, c, info) {
    var L = c.leader; if (!L || L.none) return false;
    L.age = num(L.age, 60) + 4 / 52;
    var q = clamp(0.0004 * M_exp(0.09 * (L.age - 30)), 0, 0.6);   // annual
    if (chance(W, q / 12)) { changeLeader(W, c, 'death'); return true; }
    // assassinations emerge from unrest
    if (chance(W, 0.0006 * c01(c.unrest) * (1 - 0.5 * c01(L.caution, 0.5)))) {
      var nm = L.name;
      changeLeader(W, c, 'assassination', { silent: true });
      post(W, nm + ', leader of ' + c.name + ', is assassinated; ' + c.leader.name + ' takes over.', c, 3, 'leader');
      return true;
    }
    if (!info.elections && L.age > 80 && chance(W, 0.008)) { changeLeader(W, c, 'retirement'); return true; }
    if (info.elections && c01(c.approval, 0.5) < 0.22 && yearsSince(W, L.since) > 0.5 && chance(W, 0.04)) { changeLeader(W, c, 'resignation'); return true; }
    return false;
  }

  function puppetCheck(W, c) {
    if (!(typeof c.overlord === 'number' && c.overlord >= 0)) return;
    var ov = W.countries[c.overlord], L = c.leader;
    if (!ov || !ov.alive || !ov.leader || !L || L.none) return;
    if (L.installedBy === c.overlord) return;
    var d = idist(num(L.econ, 0), num(L.auth, 0), num(L.nat, 0.5), num(ov.leader.econ, 0), num(ov.leader.auth, 0), num(ov.leader.nat, 0.5));
    if (d > 0.45 || chance(W, 0.15)) changeLeader(W, c, 'puppet');
    else L.installedBy = c.overlord;
  }

  // Regions whose residents are mostly of another origin and unhappy build up independence pressure.
  function independenceCheck(W, c, info) {
    var S = st(W), regs = c.regions; if (!regs || !regs.length) return;
    var best = -1, bestCnt = 0, groups = null;
    for (var k = 0; k < regs.length; k++) {
      var r = regs[k]; if (r < 0 || r >= S.nR) continue;
      if (S.rPressOwner[r] !== c.id) {
        if (S.rPressOwner[r] >= 0) S.rPrevOwner[r] = S.rPressOwner[r];
        S.rPressOwner[r] = c.id; S.rPress[r] = 0;
      }
      if (r === c.capital && regs.length > 1) { S.rPress[r] = 0; continue; }
      var o = S.R.rCand[r], w = S.R.rW[r], cw = S.R.rCandW[r];
      if (o < 0 || o === c.id || o === c.revives || !(w > 0) || !(cw > 0) || !rooted(W, r, o)) { S.rPress[r] *= 0.9; continue; }
      var sh = cw / w;
      if (sh < 0.5) { S.rPress[r] *= 0.9; continue; }
      var oc = W.countries[o];
      var ap = S.R.rCandAppr[r] / cw, rd = S.R.rCandRad[r] / cw;
      var hostile = 0;
      if (oc && oc.alive && GS.Diplo && typeof GS.Diplo.rel === 'function') hostile = num(GS.Diplo.rel(W, o, c.id), 0) < -30 ? 0.1 : 0;
      var griev = (0.5 - ap) * 1.5 + rd * 0.8 + (1 - c01(c.stability, 0.5)) * 0.3 + hostile - c01(c.repression) * 0.25 * (1 - c01(c.stability, 0.5));
      S.rPress[r] = clamp(S.rPress[r] + clamp(griev, -0.2, 0.5) * (sh - 0.4) * 0.25 + (S.rPress[r] < 0 ? 0.01 : 0), -1.5, 1.5);
      if (S.rPress[r] >= 1) {
        if (!groups) groups = {};
        var g = groups[o] || (groups[o] = []);
        g.push(r);
        if (g.length > bestCnt) { bestCnt = g.length; best = o; }
      }
    }
    if (best < 0) return;
    var claimed = groups[best];
    // a single-region country whose only region is foreign-majority is handled by revolutions, not secession
    if (claimed.length >= regs.length && regs.length === 1) return;
    for (k = 0; k < claimed.length; k++) S.rPress[claimed[k]] = 0;
    var ideo = regionGroupIdeo(S, claimed);
    if (info.elections && c.gov !== 'hybrid' && c01(c.repression) < 0.25 && rnd(W) < 0.35) {
      var nm = claimed.map(function (r2) { return regionName(W, r2); }).join(', ');
      post(W, 'Referendum: ' + nm + ' votes to leave ' + c.name + '.', c, 3, 'independence');
      secede(W, c, { rebels: ideo, origin: best, claimed: claimed, regionHeld: claimed, kind: 'secession', start: W.tick | 0 }, best, true);
      return;
    }
    startCivilWar(W, c, { kind: 'secession', origin: best, regions: claimed, rebels: ideo });
  }

  // A people is 'rooted' in a region if it is the region's original nation (or that nation's revived state),
  // or the nation of a former owner — not merely a migrant majority.
  function rooted(W, r, o) {
    var g = W.regions[r]; if (!g || o < 0) return false;
    var core = typeof g.core === 'number' ? g.core : -1;
    if (o === core) return true;
    var cc = core >= 0 ? W.countries[core] : null, oc = W.countries[o];
    if (cc && cc.revivedAs === o) return true;
    if (oc && oc.revives === core && core >= 0) return true;
    var S = st(W);
    return S.rPrevOwner && S.rPrevOwner[r] === o;
  }

  function regionGroupIdeo(S, regs) {
    var w = 0, e = 0, a = 0, n = 0;
    for (var k = 0; k < regs.length; k++) { var r = regs[k]; w += S.R.rCandW[r]; e += S.R.rCandE[r]; a += S.R.rCandA[r]; n += S.R.rCandN[r]; }
    if (!(w > 0)) return { econ: 0, auth: 0, nat: 0.7 };
    return { econ: clamp(e / w, -1, 1), auth: clamp(a / w, -1, 1), nat: clamp(n / w + 0.1, 0, 1) };
  }

  // ------------------------------------------------------------------
  // Civil war
  // ------------------------------------------------------------------
  function rebelNameFor(W, c, kind, R, origin) {
    var oc = origin >= 0 ? W.countries[origin] : null, X = c.name;
    if (kind === 'secession') return (oc ? oc.name : X) + ' Liberation Front';
    if (kind === 'warlords') return 'warlord coalition';
    var e = num(R.econ, 0), a = num(R.auth, 0), n = num(R.nat, 0.5);
    if (e < -0.35) return a > 0.2 ? "People's Liberation Army of " + X : 'Revolutionary Armed Forces of ' + X;
    if (a < -0.15) return 'Free ' + X + ' Army';
    if (n > 0.65 && religious(c) && a > 0.2) return 'Islamic Resistance of ' + X;
    if (n > 0.65) return 'National Salvation Front';
    if (a > 0.4) return 'Patriotic Forces of ' + X;
    return 'Democratic Resistance of ' + X;
  }

  // startCivilWar(W, c, opts?) opts: {kind:'regime'|'secession'|'warlords', origin, regions:[claimed ids], rebels:{econ,auth,nat},
  //                                    rebelShare, ongoing, silent}
  function startCivilWar(W, c, opts) {
    if (!c || !c.alive) return null;
    if (c.civilWar) return c.civilWar;
    opts = opts || EMPTY;
    if (W._cwDebug) W._cwDebug.push({ t: W.tick, id: c.id, src: opts.src || opts.kind, sc: stateCapacity(c), u: c.unrest, pol: c.polarization, st: c.stability });
    var S = st(W), L = c.leader || EMPTY;
    var kind = opts.kind || (c.gov === 'anarchy' ? 'warlords' : 'regime');
    var origin = (typeof opts.origin === 'number') ? opts.origin : -1;
    var R = opts.rebels ? ideoOf(opts.rebels) : null;
    if (!R && kind === 'warlords') { var mi = milIdeo(W, c); R = { econ: mi.econ, auth: clamp(mi.auth + 0.35, -1, 1), nat: clamp(mi.nat + 0.1, 0, 1) }; }
    if (!R) {
      var pi = protIdeo(W, c);
      R = { econ: pi.econ, auth: pi.auth, nat: pi.nat };
      // armed rebels are more radical than street protesters, and opposed to the regime
      R.econ = clamp(R.econ + (R.econ - num(L.econ, 0)) * 0.3, -1, 1);
      R.auth = clamp(R.auth + (R.auth - num(L.auth, 0)) * 0.3, -1, 1);
      R.nat = clamp(R.nat + 0.05, 0, 1);
    }
    var milA = c01(c.milApproval, 0.5);
    var id = c.id, d = c.data || EMPTY;
    var popR = num(c.pop, 0);
    if (!(popR > 0)) popR = (id < S.nC && S.R.cAdW[id] > 0) ? S.R.cAdW[id] * 1.5 : num(d.pop, 1) * 1e6;
    var milReal = (c.workers && num(c.workers.military, 0) > 0) ? num(c.workers.military, 0) :
      ((id < S.nC && S.R.cMilW[id] > 0) ? S.R.cMilW[id] : popR * 0.003);
    var share = (typeof opts.rebelShare === 'number') ? clamp(opts.rebelShare, 0.02, 0.8) : clamp((0.55 - milA) * 0.6 + c01(c.unrest) * 0.15, 0.05, 0.45);
    var militia, defFrac;
    if (kind === 'secession') {
      var cl = opts.regions || [], pw = 0;
      for (var k = 0; k < cl.length; k++) if (cl[k] >= 0 && cl[k] < S.nR) pw += S.R.rW[cl[k]];
      militia = M_max(pw, popR * 0.02) * 0.006; defFrac = 0.05;
    } else if (kind === 'warlords') { militia = milReal * 0.6 + popR * 0.002; defFrac = 0.5; }
    else { militia = milReal * share + popR * 0.0008; defFrac = share; }
    var claimed = (opts.regions || []).filter(function (r) { return W.regions[r] && W.regions[r].owner === c.id; });
    var cw = {
      rebels: R, rebelStrength: militia, govStrength: milReal * (1 - defFrac), start: W.tick | 0,
      rebelName: rebelNameFor(W, c, kind, R, origin), regionHeld: [],
      kind: kind, origin: origin, claimed: claimed, control: kind === 'secession' ? 0.3 : clamp(share * 0.8, 0.05, 0.6), progress: 0,
      militia: militia, defFrac: defFrac, rebSupport: 0, govSupport: 0, supporters: [], deaths: 0
    };
    c.civilWar = cw;
    updateHeld(W, c, cw);
    c.unrest = M_max(c01(c.unrest), 0.5);
    c.stability = c01(num(c.stability, 0.5) * 0.7);
    if (!opts.silent) {
      var t;
      if (kind === 'secession') t = 'Independence war: the ' + cw.rebelName + ' rises against ' + c.name + ' in ' +
        (claimed.length ? claimed.map(function (r) { return regionName(W, r); }).join(', ') : 'occupied lands') + '.';
      else if (kind === 'warlords') t = 'Rival warlords fight for control of ' + c.name + ' as the state disintegrates.';
      else if (opts.ongoing) t = 'Civil war rages in ' + c.name + ': the ' + cw.rebelName + ' controls much of the country.';
      else if (opts.insurgency) t = 'Insurgency in ' + c.name + ': the ' + cw.rebelName + ' launches an armed rebellion against ' + (L.none ? 'the authorities' : L.name) + '.';
      else t = 'Civil war erupts in ' + c.name + ': the ' + cw.rebelName + ' takes up arms against ' + (L.none ? 'the authorities' : L.name) + '.';
      post(W, t, c, 3, 'civilwar', origin >= 0 && alive(W, origin) ? [origin] : null);
    }
    return cw;
  }

  function updateHeld(W, c, cw) {
    var S = st(W), regs = c.regions || [];
    var pool = [];
    if (cw.kind === 'secession') {
      cw.claimed = (cw.claimed || []).filter(function (r) { return W.regions[r] && W.regions[r].owner === c.id; });
      pool = cw.claimed.slice();
    } else {
      for (var k = 0; k < regs.length; k++) if (regs[k] !== c.capital || cw.control > 0.85) pool.push(regs[k]);
    }
    if (!pool.length || regs.length < 2) { cw.regionHeld = []; return; }
    var cap = W.regions[c.capital], held = cw.regionHeld || [];
    var score = pool.map(function (r) {
      var g = W.regions[r], s = (S.R.rW[r] > 0 ? S.R.rReb[r] / S.R.rW[r] * 20 : 0) + (held.indexOf(r) >= 0 ? 0.3 : 0);
      if (cap && g) s += M_min(1, M_hypot(num(g.cx, 0) - num(cap.cx, 0), num(g.cy, 0) - num(cap.cy, 0)) / 600) * 0.5;
      return { r: r, s: s };
    });
    score.sort(function (a, b) { return b.s - a.s; });
    var nHeld = cw.kind === 'secession' ? M_round(cw.control * pool.length) : M_min(pool.length, M_floor(cw.control * regs.length));
    if (cw.kind !== 'secession' && cw.control > 0.15 && nHeld < 1) nHeld = 1;
    cw.regionHeld = score.slice(0, M_max(0, nHeld)).map(function (x) { return x.r; });
  }

  function civilWarWeek(W, c) {
    var cw = c.civilWar, d = c.data || EMPTY;
    if (!cw) return;
    var milReal = c.workers ? M_max(0, num(c.workers.military, 0)) : 0;
    var rebReal = M_max(0, num(c.rebels, 0));
    cw.defFrac = clamp(num(cw.defFrac, 0) * 0.996, 0, 0.95);
    cw.militia = M_max(0, num(cw.militia, 0) * 0.996);
    var tech = clamp(num(c.tech, num(d.tech, 0.7)), 0.2, 2);
    var milA = c01(c.milApproval, 0.5);
    var govS = milReal * (1 - cw.defFrac) * (0.5 + 0.5 * tech) * (0.5 + 0.5 * milA) * (1 + num(cw.govSupport, 0)) *
      (c.gov === 'anarchy' ? 0.5 : 1) * (0.7 + 0.3 * c01(c.legitimacy, 0.5));
    var rebS = (rebReal * 0.6 + cw.militia) * 0.8 * (0.7 + 0.3 * c01(c.unrest)) * (1 + num(cw.rebSupport, 0)) * (cw.kind === 'secession' ? 1.2 : 1);
    govS = num(govS, 0); rebS = num(rebS, 0);
    var tot = govS + rebS, share = tot > 0 ? rebS / tot : 0.5;
    cw.rebelStrength = rebS; cw.govStrength = govS; cw.share = share;
    cw.progress = clamp(num(cw.progress, 0) + (share - 0.5) * 0.03 + (rnd(W) - 0.5) * 0.015, -1, 1);
    cw.control = clamp(num(cw.control, 0.3) + (share - num(cw.control, 0.3)) * 0.03 + cw.progress * 0.004, 0, 1);
    var t = W.tick | 0;
    // casualties & devastation (monthly batches, staggered)
    if (((t + c.id) & 3) === 1 && GS.People && typeof GS.People.kill === 'function') {
      var inten = clamp(M_min(rebS, govS) / M_max(1, M_max(rebS, govS)), 0.1, 1);
      var killed = 0;
      killed += GS.People.kill(W, { country: c.id, fraction: 0.004 * (1.2 - share) * inten, cause: 'civilwar', jobs: [REBEL] }) || 0;
      killed += GS.People.kill(W, { country: c.id, fraction: 0.0025 * (share + 0.2) * inten, cause: 'civilwar', jobs: [MIL] }) || 0;
      // civilians: proportional to the fighting (regions can be whole countries, so never a flat share of region pop)
      var civ = killed * (0.3 + 0.4 * inten);
      var held = cw.regionHeld || [];
      for (var k = 0; k < held.length; k++) {
        var rg = W.regions[held[k]];
        if (!rg) continue;
        if (civ > 0) killed += GS.People.kill(W, { region: held[k], count: civ / held.length, cause: 'civilwar' }) || 0;
        var af = (GS.War && GS.War.areaFactor) ? GS.War.areaFactor(W, rg) : 1;
        rg.devastation = clamp(num(rg.devastation, 0) + 0.01 * inten * af / M_max(1, M_sqrt(held.length)), 0, 1);
      }
      if (!held.length && c.regions && c.regions.length) {
        var rc = W.regions[c.regions[0]];
        if (rc) rc.devastation = clamp(num(rc.devastation, 0) + 0.004 * inten * ((GS.War && GS.War.areaFactor) ? GS.War.areaFactor(W, rc) : 1), 0, 1);
        if (civ > 0) killed += GS.People.kill(W, { country: c.id, count: civ * 0.5, cause: 'civilwar' }) || 0;
      }
      killed = num(killed, 0);
      cw.deaths = num(cw.deaths, 0) + killed;
      if (W.global) W.global.warDeaths = num(W.global.warDeaths, 0) + killed;
    }
    if (cw.progress >= 1 || cw.control > 0.9) endCivilWar(W, c, 'rebels');
    else if (cw.progress <= -1 || (rebS < govS * 0.02 && t - cw.start > 12)) endCivilWar(W, c, 'government');
  }

  function civilWarMonthly(W, c) {
    var cw = c.civilWar; if (!cw) return;
    updateHeld(W, c, cw);
    // foreign support: allies back the government; hostile powers closer in ideology to the rebels back them
    var gs = 0, rs = 0, sup = [], k;
    if (GS.Diplo && typeof GS.Diplo.allies === 'function') {
      var al = GS.Diplo.allies(W, c) || [];
      for (k = 0; k < al.length; k++) if (alive(W, al[k])) gs += 0.08;
    }
    var cs = W.countries, L = c.leader || EMPTY, R = cw.rebels, myP = M_max(1, num(c.power, 1)), NC = W.NC | 0;
    for (k = 0; k < cs.length; k++) {
      var o = cs[k];
      if (!o || !o.alive || k === c.id || !o.leader || o.leader.none) continue;
      var rel = (W.rel && NC > 0 && k < NC && c.id < NC) ? num(W.rel[k * NC + c.id], 0) : 0;
      if (k === cw.origin) { rs += 0.3; sup.push(k); continue; }
      if (rel > -25) continue;
      var ol = o.leader;
      var dR = idist(num(ol.econ, 0), num(ol.auth, 0), num(ol.nat, 0.5), R.econ, R.auth, R.nat);
      var dG = idist(num(ol.econ, 0), num(ol.auth, 0), num(ol.nat, 0.5), num(L.econ, 0), num(L.auth, 0), num(L.nat, 0.5));
      if (dR >= dG) continue;
      var w = 0.1 * M_min(1, num(o.power, 0) / myP) * (o.greatPower ? 1.5 : 1);
      if (w > 0.02) { rs += w; sup.push(k); }
    }
    cw.govSupport = clamp(gs, 0, 0.4); cw.rebSupport = clamp(rs, 0, 0.6); cw.supporters = sup.slice(0, 6);
    // negotiated settlement after long stalemates
    var yrs = yearsSince(W, cw.start);
    // a frozen front hardens into a border: the rebels keep the provinces they hold
    if (yrs > 2 && cw.kind !== 'secession' && cw.control > 0.3 && cw.control < 0.9 && (cw.regionHeld || []).length &&
        chance(W, (cw.kind === 'warlords' ? 0.03 : 0.008) * (1 + c01(c.warExhaustion)))) { endCivilWar(W, c, 'partition'); return; }
    if (yrs > 4 && M_abs(num(cw.progress, 0)) < 0.35 && chance(W, 0.012 * (1 + c01(c.warExhaustion)))) endCivilWar(W, c, 'settlement');
  }

  function rebelsForeignOrigin(W, c) {
    var S = st(W), id = c.id;
    if (id >= S.nC || !(S.R.cRebW[id] > 0)) return -1;
    var o = S.R.cRebCand[id];
    if (o < 0 || o === c.id || o === c.revives) return -1;
    return S.R.cRebCandW[id] / S.R.cRebW[id] > 0.5 ? o : -1;
  }

  // Partition: the rebels (or rival warlords) keep the provinces they hold as new states.
  function partition(W, c, cw, dur) {
    var S = st(W);
    var held = (cw.regionHeld || []).filter(function (r) { return W.regions[r] && W.regions[r].owner === c.id && r !== c.capital; });
    if (!held.length || held.length >= (c.regions || []).length || !GS.World || typeof GS.World.createCountry !== 'function') return false;
    var groups = [held];
    if (cw.kind === 'warlords' && held.length >= 2 && rnd(W) < 0.6) { var h = M_ceil(held.length / 2); groups = [held.slice(0, h), held.slice(h)]; }
    var made = [], names = [];
    for (var g = 0; g < groups.length; g++) {
      var ideo = cw.rebels || popIdeo(c);
      var gov = cw.kind === 'warlords' ? (rnd(W) < 0.6 ? 'junta' : 'autocracy') : govFromIdeology(W, c, ideo, 'rebels');
      if (gov === 'democracy' || gov === 'anarchy') gov = 'flawed_democracy';
      var r0 = groups[g][0];
      var nm = (GS.Names && GS.Names.newCountryName) ? GS.Names.newCountryName(regionName(W, r0), 'secession', W.rng) : 'Free ' + regionName(W, r0);
      S.pending = { ideology: ideo, revives: -1 };
      var nid = GS.World.createCountry(W, { name: nm, regions: groups[g], culture: c.culture, gov: gov, parent: c.id, silent: true });
      S.pending = null;
      var nc = (typeof nid === 'number' && nid >= 0) ? W.countries[nid] : null;
      if (!nc) continue;
      made.push(nc.id); names.push(nc.name);
      // a new national identity: the people of these provinces (and the land itself) now belong to the new nation,
      // so they do not count as an occupied minority of the old state
      var P = W.people, set = {};
      for (var q = 0; q < groups[g].length; q++) { set[groups[g][q]] = 1; var rg = W.regions[groups[g][q]]; if (rg && rg.core === c.id) rg.core = nc.id; }
      if (P && P.alive) for (var ai = 0, nP = P.n | 0; ai < nP; ai++) if (P.alive[ai] && set[P.region[ai]] && P.origin[ai] === c.id) P.origin[ai] = nc.id;
      // the rump state does not accept the loss: claims (and grievances) remain
      if (c.claims) for (var k = 0; k < groups[g].length; k++) if (c.claims.indexOf(groups[g][k]) < 0) c.claims.push(groups[g][k]);
      if (GS.Diplo && typeof GS.Diplo.addRel === 'function') GS.Diplo.addRel(W, c.id, nc.id, -40);
    }
    if (!made.length) return false;
    c.unrest = c01(c.unrest * 0.6);
    post(W, 'Partition of ' + c.name + dur + ': ' + names.join(' and ') + (names.length > 1 ? ' emerge' : ' emerges') +
      ' as ' + (names.length > 1 ? 'independent states' : 'an independent state') + ' from the civil war.', c, 4, 'independence', made);
    return true;
  }

  // endCivilWar(W, c, winner) winner: 'rebels' | 'government' | 'settlement' | 'partition'
  function endCivilWar(W, c, winner) {
    if (!c) return;
    var cw = c.civilWar; if (!cw) return;
    c.civilWar = null;
    c.cwCooldown = (W.tick | 0) + 52;
    var yrs = yearsSince(W, cw.start), dur = yrs >= 1 ? ' after ' + yrs.toFixed(0) + (yrs < 1.5 ? ' year' : ' years') : '';
    if (!c.alive) return;
    if (winner === 'partition') {
      if (partition(W, c, cw, dur)) {
        if (c.gov === 'anarchy') changeGov(W, c, govFromIdeology(W, c, milIdeo(W, c), 'military'), 'warlord victory', { ideology: milIdeo(W, c), silent: true });
        return;
      }
      winner = 'settlement';
    }
    if (winner === 'settlement' && cw.kind !== 'secession' && cw.control > 0.3 && rnd(W) < 0.4 && partition(W, c, cw, dur)) return;
    if (winner === 'rebels') {
      var fo = cw.kind === 'secession' ? (cw.origin >= 0 ? cw.origin : rebelsForeignOrigin(W, c)) : rebelsForeignOrigin(W, c);
      if (fo >= 0 && secede(W, c, cw, fo, false)) return;
      var gov = govFromIdeology(W, c, cw.rebels, cw.kind === 'warlords' ? 'military' : 'rebels');
      var old = c.leader;
      changeGov(W, c, gov, 'civil war', { ideology: cw.rebels, silent: true });
      c.unrest = c01(c.unrest * 0.6);
      post(W, 'The ' + cw.rebelName + ' wins the civil war in ' + c.name + dur + '. ' + (old && !old.none ? old.name + ' falls; ' : '') +
        c.leader.name + ' heads a new ' + gi(c.gov).label.toLowerCase() + '.', c, 4, 'civilwar');
    } else if (winner === 'government') {
      if (c.gov === 'anarchy') {
        changeGov(W, c, govFromIdeology(W, c, milIdeo(W, c), 'military'), 'warlord victory', { ideology: milIdeo(W, c), silent: true });
        post(W, 'The strongest faction reunifies ' + c.name + dur + ': ' + c.leader.name + ' establishes ' + an(gi(c.gov).label.toLowerCase()) + '.', c, 3, 'civilwar');
      } else {
        c.repression = clamp(num(c.repression, 0) + 0.15, 0, gi(c.gov).repressionCap);
        c.legitimacy = c01(num(c.legitimacy, 0.5) + 0.1);
        c.unrest = c01(c.unrest * 0.7);
        post(W, 'Government of ' + c.name + ' defeats the ' + cw.rebelName + dur + '.', c, 3, 'civilwar');
      }
    } else if (cw.kind === 'secession') {
      // negotiated end of an independence war: independence, or autonomy within the state
      var orgn = cw.origin >= 0 ? cw.origin : rebelsForeignOrigin(W, c);
      if (orgn >= 0 && rnd(W) < 0.5 && secede(W, c, cw, orgn, true)) return;
      c.unrest = c01(c.unrest * 0.7);
      var S2 = st(W), cl = cw.claimed || [];
      for (var k2 = 0; k2 < cl.length; k2++) if (cl[k2] >= 0 && cl[k2] < S2.nR) S2.rPress[cl[k2]] = -1.5; // autonomy buys years of calm
      post(W, 'Peace deal in ' + c.name + ': the ' + cw.rebelName + ' accepts broad autonomy' + dur + '.', c, 3, 'civilwar');
    } else {
      var mid = { econ: (cw.rebels.econ + num(c.leader && c.leader.econ, 0)) / 2, auth: (cw.rebels.auth + num(c.leader && c.leader.auth, 0)) / 2 - 0.1,
        nat: (cw.rebels.nat + num(c.leader && c.leader.nat, 0.5)) / 2 };
      var g2 = gi(c.gov).elections ? c.gov : 'hybrid';
      if (c.gov === 'anarchy') g2 = 'hybrid';
      changeGov(W, c, g2, 'peace deal', { ideology: mid, silent: true });
      c.unrest = c01(c.unrest * 0.7);
      post(W, 'Peace deal ends the civil war in ' + c.name + dur + ': a power-sharing government under ' + c.leader.name + ' takes office.', c, 3, 'civilwar');
    }
  }

  // Regions where `origin` people are the majority leave c: rejoin a living origin state, or (re)create it.
  function secede(W, c, cw, origin, peaceful) {
    var S = st(W), regs = (c.regions || []).slice(), out = [], k;
    for (k = 0; k < regs.length; k++) {
      var r = regs[k];
      if (r < 0 || r >= S.nR) continue;
      if (S.R.rCand[r] === origin && S.R.rW[r] > 0 && S.R.rCandW[r] / S.R.rW[r] > 0.5 && rooted(W, r, origin)) out.push(r);
    }
    if (!out.length && cw.kind === 'secession') out = (cw.claimed || []).filter(function (r2) { return W.regions[r2] && W.regions[r2].owner === c.id; });
    if (!out.length || !GS.World) return false;
    var oc = W.countries[origin];
    var names = out.map(function (r2) { return regionName(W, r2); }).join(', ');
    var oldName = c.name, cid = c.id;
    var how = peaceful ? 'peacefully' : 'after the ' + (cw.rebelName || 'rebels') + ' prevails';
    if (oc && oc.alive && origin !== cid && typeof GS.World.setRegionOwner === 'function') {
      for (k = 0; k < out.length; k++) GS.World.setRegionOwner(W, out[k], origin, 'liberation');
      post(W, 'Liberation: ' + names + ' break' + (out.length > 1 ? '' : 's') + ' away from ' + oldName + ' ' + how + ' and rejoin' + (out.length > 1 ? '' : 's') + ' ' + oc.name + '.', c, 4, 'independence', [origin]);
      return true;
    }
    if (typeof GS.World.createCountry !== 'function') return false;
    var revived = !!(oc && !oc.alive);
    var name = revived ? oc.name : (GS.Names && GS.Names.newCountryName ? GS.Names.newCountryName(regionName(W, out[0]), peaceful ? 'independence' : 'secession', W.rng) : 'Free ' + regionName(W, out[0]));
    var gov = govFromIdeology(W, c, cw.rebels || { econ: 0, auth: 0, nat: 0.7 }, 'rebels');
    if (gov === 'democracy' && !peaceful) gov = 'flawed_democracy';
    S.pending = { ideology: cw.rebels, revives: revived ? origin : -1 };
    var nid = GS.World.createCountry(W, { name: name, regions: out, culture: oc ? oc.culture : c.culture, gov: gov, parent: cid,
      color: oc && oc.color ? oc.color.slice() : void 0, silent: true });
    S.pending = null;
    var nc = (typeof nid === 'number' && nid >= 0) ? W.countries[nid] : (nid && typeof nid === 'object' ? nid : null);
    if (!nc) return false;
    nid = nc.id;
    if (revived) {
      nc.revives = origin;
      oc.revivedAs = nid;
      // the nation's people (wherever they live) now belong to the reborn state
      var P = W.people;
      if (P && P.alive) {
        var n = P.n | 0, org = P.origin;
        for (var i = 0; i < n; i++) if (P.alive[i] && org[i] === origin) org[i] = nid;
      }
    }
    post(W, revived ? (nc.name + ' is reborn: ' + names + ' break' + (out.length > 1 ? '' : 's') + ' free of ' + oldName + ' ' + how + '.')
      : ('Independence: ' + names + ' secede' + (out.length > 1 ? '' : 's') + ' from ' + oldName + ' ' + how + ' as ' + nc.name + '.'), nc, 4, 'independence', [cid]);
    return true;
  }

  // ------------------------------------------------------------------
  // Anarchy: warlords → civil war, or a new regime emerges
  // ------------------------------------------------------------------
  function anarchyMonth(W, c) {
    c.anarchyMonths = num(c.anarchyMonths, 0) + 1;
    choosePolicy(W, c, GOV_INFO.anarchy);
    if (c.civilWar) { civilWarMonthly(W, c); return; }
    if (chance(W, 0.12 + c01(c.polarization) * 0.2)) { startCivilWar(W, c, { kind: 'warlords' }); return; }
    if (c.anarchyMonths >= 3 && chance(W, 0.02 + 0.01 * (c.anarchyMonths - 3))) {
      var pi = popIdeo(c), strong = rnd(W) < 0.45;
      var ideo = strong ? milIdeo(W, c) : { econ: pi.econ, auth: clamp(pi.auth + 0.1, -1, 1), nat: pi.nat };
      var gov = strong ? 'junta' : govFromIdeology(W, c, ideo, 'emerge'), months = c.anarchyMonths;
      changeGov(W, c, gov, 'new order', { ideology: ideo, silent: true });
      post(W, 'Order returns to ' + c.name + ' after ' + months + ' month' + (months === 1 ? '' : 's') + ' of anarchy: ' + c.leader.name + ' forms ' + an(gi(gov).label.toLowerCase()) + '.', c, 3, 'regime');
    }
  }

  // ------------------------------------------------------------------
  // Main step
  // ------------------------------------------------------------------
  function monthly(W, c) {
    var info = gi(c.gov);
    if (!c.leader) c.leader = c.gov === 'anarchy' ? anarchyLeader(W) : makeLeader(W, c);
    if (!c.parties) c.parties = deriveParties(W, c, sampleCountry(W, c.id, 300), null);
    if (!c.policy) c.policy = defaultPolicy(c);
    updatePolls(W, c);
    computeIndices(W, c, info);
    if (c.gov === 'anarchy') { anarchyMonth(W, c); return; }
    choosePolicy(W, c, info);
    puppetCheck(W, c);
    leaderMortality(W, c, info);
    if (info.elections) {
      if (num(c.nextElection, -1) < 0) c.nextElection = (W.tick | 0) + 4 + ((rnd(W) * TERM) | 0);
      else if ((W.tick | 0) >= c.nextElection) holdElection(W, c);
    } else c.nextElection = -1;
    democraticDrift(W, c, info);
    info = gi(c.gov);
    if (!c.civilWar) {
      if (coupCheck(W, c, info)) return;
      if (revolutionCheck(W, c, info)) return;
      if (civilWarOnset(W, c, info)) return;
      independenceCheck(W, c, info);
    } else civilWarMonthly(W, c);
  }

  function step(W) {
    if (!W || !W.countries) return;
    var S = st(W), cs = W.countries, nC = cs.length, t = W.tick | 0;
    if (S.statsTick < 0 || S.statsTick > t) gatherStats(W);
    else gatherSlice(W, t & 3);
    for (var id = 0; id < nC; id++) {
      var c = cs[id];
      if (!c) continue;
      if (!c.alive) { if (c.civilWar) c.civilWar = null; continue; }
      if (c.leader === void 0 || c.gov === void 0 || c.policy === void 0) initCountry(W, c);
      if (c.civilWar) civilWarWeek(W, c);
      if (!c.alive) continue;
      if (((t + id) & 3) === 0) monthly(W, c);
    }
  }

  GS.Politics = {
    init: init,
    initCountry: function (W, c) { initCountry(W, c, null); },
    step: step,
    changeLeader: changeLeader,
    changeGov: changeGov,
    startCivilWar: startCivilWar,
    endCivilWar: endCivilWar,
    govInfo: govInfo,
    // extras
    revolution: revolution,
    coup: function (W, c) { if (c && c.alive && c.gov !== 'anarchy') return attemptCoup(W, c, true); return false; },
    govFromIdeology: function (W, c, ideo) { return govFromIdeology(W, c, ideo || popIdeo(c), 'rebels'); },
    GOVS_INFO: GOV_INFO,
    _gatherStats: gatherStats
  };
})();
