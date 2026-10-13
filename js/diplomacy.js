// GODSIM — diplomacy.js  (GS.Diplo)
// Relations, sanctions, threat, spheres of influence, great powers, alliances & pacts, claims,
// settlement of ungoverned land. Everything is generic: no country is special-cased here.
(function () {
  'use strict';
  var GS = globalThis.GS = globalThis.GS || {};
  var M = Math;
  var EMPTY = {};
  var isArr = Array.isArray; // aliased: global lookups are slow inside Node vm contexts

  // ------------------------------------------------------------------ helpers
  function num(x, d) { return (typeof x === 'number' && x - x === 0) ? x : d; }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function c01(x, d) { return clamp(num(x, d === undefined ? 0 : d), 0, 1); }
  function idOf(x) {
    if (typeof x === 'number') return x === x ? (x | 0) : -1;
    if (x && typeof x.id === 'number') return x.id | 0;
    return -1;
  }
  function cOf(W, x) { var id = idOf(x); return (id >= 0 && W.countries && id < W.countries.length) ? (W.countries[id] || null) : null; }
  function isAlive(W, id) { var c = (id >= 0 && id < W.countries.length) ? W.countries[id] : null; return !!(c && c.alive); }
  function rnd(W) { return W.rng ? W.rng.next() : 0.5; }
  function chance(W, p) { return p > 0 && rnd(W) < p; }
  function news(W, text, type, ids, imp) {
    if (typeof GS.news === 'function') GS.news(W, text, { type: type || 'diplomacy', countries: ids || [], importance: imp || 1 });
  }
  function L_(c) { var L = c && c.leader; return (L && !L.none) ? L : null; }
  function trait(c, k, d) { var L = L_(c); return L ? c01(L[k], d) : d; }
  function ideo(c, k, d) {
    var L = L_(c);
    if (L && typeof L[k] === 'number') return L[k];
    var v = c ? c['ideo' + k.charAt(0).toUpperCase() + k.slice(1)] : undefined;
    return num(v, d);
  }
  var GOVFREE = { democracy: 1, flawed_democracy: 0.8, hybrid: 0.5, monarchy: 0.3, autocracy: 0.2, oneparty: 0.1, theocracy: 0.15, junta: 0.1, anarchy: 0.35 };
  function govFree(g) { var v = GOVFREE[g]; return v === undefined ? 0.4 : v; }
  function powerOf(W, c) {
    if (!c || !c.alive) return 0;
    var p = num(c.power, -1);
    if (!(p > 0) && GS.War && typeof GS.War.power === 'function') p = num(GS.War.power(W, c), 0);
    if (!(p > 0)) p = M.pow(M.max(0, num(c.gdp, 1) * 0.02 * 6), 0.8);
    return p;
  }
  function navyOf(c) { return c01(num(c.navy, c.data ? c.data.navy : 0), 0); }
  function nukesOf(c) { return M.max(0, num(c.nukes, c.data ? num(c.data.nukes, 0) : 0)); }
  function pk(a, b) { return a < b ? a * 65536 + b : b * 65536 + a; }

  function relRaw(W, a, b) {
    var NC = W.NC | 0;
    if (!W.rel || a < 0 || b < 0 || a >= NC || b >= NC) return 0;
    return num(W.rel[a * NC + b], 0);
  }
  function setRel(W, a, b, v) {
    var NC = W.NC | 0;
    if (!W.rel || a < 0 || b < 0 || a >= NC || b >= NC || a === b) return;
    v = clamp(num(v, 0), -100, 100);
    W.rel[a * NC + b] = v; W.rel[b * NC + a] = v;
  }
  function distKm(W, a, b) {
    if (a === b) return 0;
    var NC = W.NC | 0;
    if (W.dist && a < NC && b < NC) { var v = W.dist[a * NC + b]; if (v > 0) return v; }
    var ca = W.countries[a], cb = W.countries[b];
    var ra = ca && W.regions[ca.capital], rb = cb && W.regions[cb.capital];
    if (ra && rb && GS.Geo && GS.Geo.haversineKm) return num(GS.Geo.haversineKm(ra.lon, ra.lat, rb.lon, rb.lat), 5000);
    return 5000;
  }
  function dependence(W, a, b) {
    if (GS.Economy && typeof GS.Economy.dependence === 'function') return c01(GS.Economy.dependence(W, a, b), 0);
    return 0;
  }

  // ------------------------------------------------------------------ state
  function S_(W) {
    var S = W._dip;
    if (!S) S = W._dip = { mem: new Map(), cap: 0, enemies: [], seq: 0, lastFound: -1000 };
    var n = W.countries.length;
    if (S.cap < n) {
      var cap = n + 48;
      S.allyM = new Uint8Array(cap); S.nbrM = new Uint8Array(cap); S.enemyM = new Uint8Array(cap);
      S.coM = new Uint8Array(cap); S.claimM = new Uint8Array(cap); S.sancM = new Uint8Array(cap);
      S.cap = cap;
    }
    if (!W.alliances) W.alliances = [];
    return S;
  }
  // per-tick typed-array snapshot of the country fields used in O(C^2) loops (country objects are big & slow to read)
  function buildCache(W, S) {
    var cs = W.countries, n = cs.length, K = S.K;
    if (!K || K.cap < n) {
      var cap = n + 48;
      K = S.K = { cap: cap, n: 0, tick: -1, al: new Uint8Array(cap), ec: new Float32Array(cap), au: new Float32Array(cap), na: new Float32Array(cap),
        fr: new Float32Array(cap), th: new Float32Array(cap), ts: new Int32Array(cap), ov: new Int32Array(cap), gp: new Uint8Array(cap),
        pw: new Float32Array(cap), nv: new Float32Array(cap), gdp: new Float32Array(cap), cl: new Uint8Array(cap), sc: new Uint8Array(cap),
        cred: new Float32Array(cap), pup: [] };
    }
    var pup = K.pup; pup.length = n;
    for (var i = 0; i < n; i++) {
      pup[i] = null;
      var c = cs[i];
      if (!c || !c.alive) { K.al[i] = 0; K.pw[i] = 0; K.ov[i] = -1; K.ts[i] = -1; K.gp[i] = 0; K.cl[i] = 0; K.sc[i] = 0; continue; }
      K.al[i] = 1;
      K.ec[i] = clamp(ideo(c, 'econ', 0), -1, 1); K.au[i] = clamp(ideo(c, 'auth', 0), -1, 1); K.na[i] = c01(ideo(c, 'nat', 0.5), 0.5);
      K.fr[i] = govFree(c.gov); K.th[i] = c01(c.threat, 0); K.ts[i] = num(c.threatSrc, -1);
      K.ov[i] = typeof c.overlord === 'number' ? c.overlord : -1; K.gp[i] = c.greatPower ? 1 : 0;
      K.pw[i] = powerOf(W, c); K.nv[i] = navyOf(c); K.gdp[i] = M.max(0.01, num(c.gdp, num(c.gdp0, 1)));
      K.cl[i] = c.claims && c.claims.length ? 1 : 0; K.sc[i] = c.sanctions && c.sanctions.length ? 1 : 0;
      K.cred[i] = c01(c.credibility, 0.7);
    }
    for (i = 0; i < n; i++) { var o = K.ov[i]; if (K.al[i] && o >= 0 && o < n) (pup[o] || (pup[o] = [])).push(i); }
    K.n = n; K.tick = W.tick | 0;
    return K;
  }
  function cache(W) { var S = S_(W); var K = S.K; if (!K || K.n !== W.countries.length) K = buildCache(W, S); return K; }
  // trade dependence: GS.Economy.dependence for pairs with meaningful trade, 0 otherwise (cheap prefilter)
  function depPair(W, K, a, b) {
    var T = W.trade, NC = W.NC | 0;
    if (!T || a >= NC || b >= NC) return 0;
    var t = T[a * NC + b] + T[b * NC + a];
    if (!(t > 0.002 * M.min(K.gdp[a], K.gdp[b]))) return 0;
    return dependence(W, a, b) + dependence(W, b, a);
  }

  function ensureFields(c) {
    if (typeof c.patron !== 'number') c.patron = -1;
    if (typeof c.overlord !== 'number') c.overlord = -1;
    if (typeof c.threat !== 'number') c.threat = 0;
    if (typeof c.threatSrc !== 'number') c.threatSrc = -1;
    if (!isArr(c.claims)) c.claims = [];
    if (!isArr(c.sanctions)) c.sanctions = [];
    if (typeof c.greatPower !== 'boolean') c.greatPower = false;
    if (typeof c.influence !== 'number') c.influence = 0;
    if (!isArr(c.alliances)) c.alliances = [];
    if (!isArr(c.defensePacts)) c.defensePacts = [];
    if (typeof c.credibility !== 'number') c.credibility = 0.7;
    if (typeof c.gpRank !== 'number') c.gpRank = 999;
    if (!isArr(c._rankQ)) c._rankQ = [];
  }

  // neighbours by land border (owners of regions adjacent to c's regions)
  function neighbors(W, cc) {
    var c = cOf(W, cc), out = [];
    if (!c || !c.regions) return out;
    var regs = W.regions, id = c.id;
    for (var i = 0; i < c.regions.length; i++) {
      var r = regs[c.regions[i]]; if (!r || !r.neighbors) continue;
      for (var k = 0; k < r.neighbors.length; k++) {
        var nr = regs[r.neighbors[k]]; if (!nr) continue;
        var o = nr.owner;
        if (o >= 0 && o !== id && out.indexOf(o) < 0 && isAlive(W, o)) out.push(o);
      }
    }
    return out;
  }

  // enemies lists per country from active wars (rebuilt each step)
  function buildWarLists(W, S) {
    var n = W.countries.length, en = S.enemies, co = S.coBel || (S.coBel = []);
    en.length = n; co.length = n;
    for (var i = 0; i < n; i++) { en[i] = null; co[i] = null; }
    var wars = W.wars || [];
    for (var w = 0; w < wars.length; w++) {
      var war = wars[w]; if (!war || war.ended) continue;
      var A = war.attackers || [], D = war.defenders || [];
      addPairs(en, A, D, n); addPairs(en, D, A, n);
      addPairs(co, A, A, n); addPairs(co, D, D, n);
    }
  }
  function addPairs(lists, X, Y, n) {
    for (var i = 0; i < X.length; i++) {
      var x = X[i]; if (x < 0 || x >= n) continue;
      for (var j = 0; j < Y.length; j++) {
        var y = Y[j]; if (y === x || y < 0 || y >= n) continue;
        var l = lists[x] || (lists[x] = []);
        if (l.indexOf(y) < 0) l.push(y);
      }
    }
  }

  // ------------------------------------------------------------------ public relation API
  function rel(W, a, b) { var ia = idOf(a), ib = idOf(b); if (ia === ib) return 100; return relRaw(W, ia, ib); }
  function addRel(W, a, b, delta) {
    var ia = idOf(a), ib = idOf(b); if (ia < 0 || ib < 0 || ia === ib) return 0;
    var v = clamp(relRaw(W, ia, ib) + num(delta, 0), -100, 100);
    setRel(W, ia, ib, v); return v;
  }
  // persistent "memory" (grudges / gratitude) that biases the equilibrium and decays over years
  function addMemory(W, a, b, delta) {
    var ia = idOf(a), ib = idOf(b); if (ia < 0 || ib < 0 || ia === ib) return;
    var S = S_(W), k = pk(ia, ib);
    S.mem.set(k, clamp(num(S.mem.get(k), 0) + num(delta, 0), -150, 150));
  }

  // ------------------------------------------------------------------ alliances
  function aliveAlliance(A) { return A && !A.dissolved; }
  function allianceOf(W, cc, type) {
    var c = cOf(W, cc); if (!c || !c.alliances) return null;
    for (var i = 0; i < c.alliances.length; i++) {
      var A = W.alliances[c.alliances[i]];
      if (aliveAlliance(A) && (!type || A.type === type)) return A;
    }
    return null;
  }
  function theA(A) { return /^[A-Z0-9]{2,}$/.test(A.name) ? A.name : 'the ' + A.name; }
  function capA(A) { var t = theA(A); return t.charAt(0).toUpperCase() + t.slice(1); }
  function makeAlliance(W, name, type, color, founder) {
    var A = {
      id: W.alliances.length, name: String(name || 'Alliance'), type: type || 'defense', members: [],
      leader: founder, founder: founder, founded: W.tick | 0, cohesion: 0.75,
      color: color || [150, 150, 150], dissolved: false, dissolvedTick: -1
    };
    W.alliances.push(A);
    return A;
  }
  var BLOC_PAL = [[64, 120, 220], [214, 64, 64], [170, 120, 40], [150, 120, 230], [40, 170, 150], [205, 190, 70], [60, 150, 60],
    [230, 120, 40], [70, 190, 230], [190, 70, 160], [120, 130, 170], [235, 140, 165], [140, 200, 90], [240, 230, 200], [110, 80, 50]];
  function createAlliance(W, name, founderId, type) {
    S_(W);
    var f = cOf(W, founderId);
    // a categorical colour as far as possible from every live bloc's colour (blocs must stay tellable apart)
    var col = [150, 150, 150], bestD = -1;
    for (var pi = 0; pi < BLOC_PAL.length; pi++) {
      var md = 1e9;
      for (var ai = 0; ai < W.alliances.length; ai++) {
        var B = W.alliances[ai]; if (!aliveAlliance(B) || !B.color) continue;
        var d0 = BLOC_PAL[pi][0] - B.color[0], d1 = BLOC_PAL[pi][1] - B.color[1], d2 = BLOC_PAL[pi][2] - B.color[2];
        md = M.min(md, d0 * d0 + d1 * d1 + d2 * d2);
      }
      if (md > bestD) { bestD = md; col = BLOC_PAL[pi].slice(); }
    }
    var A = makeAlliance(W, name, type || 'defense', col, f ? f.id : -1);
    if (f) join(W, A.id, f, true);
    return A.id;
  }
  function join(W, allianceId, cc, silent) {
    var A = W.alliances && W.alliances[allianceId], c = cOf(W, cc);
    if (!aliveAlliance(A) || !c || !c.alive) return false;
    ensureFields(c);
    if (A.members.indexOf(c.id) >= 0) return false;
    if (A.type === 'defense') { // one defense bloc at a time
      for (var i = c.alliances.length - 1; i >= 0; i--) {
        var B = W.alliances[c.alliances[i]];
        if (aliveAlliance(B) && B.type === 'defense' && B !== A) leave(W, B.id, c, 'switch');
      }
    }
    A.members.push(c.id);
    if (c.alliances.indexOf(A.id) < 0) c.alliances.push(A.id);
    if (!silent && A.members.length > 1) news(W, c.name + ' joins ' + theA(A) + '.', 'alliance', [c.id, A.leader], A.type === 'defense' ? 3 : 2);
    return true;
  }
  function leave(W, allianceId, cc, reason) {
    var A = W.alliances && W.alliances[allianceId], c = cOf(W, cc);
    if (!A || !c) return false;
    var k = A.members.indexOf(c.id);
    if (c.alliances) { var j = c.alliances.indexOf(A.id); if (j >= 0) c.alliances.splice(j, 1); }
    if (k < 0) return false;
    A.members.splice(k, 1);
    if (!A.dissolved && reason !== 'silent' && reason !== 'removed' && reason !== 'dissolved') {
      var why = reason === 'switch' ? ' to seek protection elsewhere' : (reason === 'relations' ? ' amid souring relations with its allies' :
        (reason === 'cohesion' ? ' as the bloc loses cohesion' : (reason === 'war' ? ' after conflict with fellow members' : (reason === 'puppet' ? ' under foreign pressure' : (reason === 'drift' ? ' as its alignment shifts' : '')))));
      news(W, c.name + ' leaves ' + theA(A) + why + '.', 'alliance', [c.id], A.type === 'defense' ? 3 : 2);
    }
    if (A.leader === c.id) {
      A.leader = -1;
      if (A.type === 'defense') A.cohesion = clamp(num(A.cohesion, 0.5) - 0.25, 0, 1);
    }
    if (!A.dissolved && A.members.length <= 1) dissolve(W, A, reason === 'removed' ? 'collapse' : 'empty');
    return true;
  }
  function dissolve(W, A, why) {
    if (!A || A.dissolved) return;
    A.dissolved = true; A.dissolvedTick = W.tick | 0;
    var mem = A.members.slice();
    for (var i = 0; i < mem.length; i++) {
      var c = W.countries[mem[i]];
      if (c && c.alliances) { var j = c.alliances.indexOf(A.id); if (j >= 0) c.alliances.splice(j, 1); }
    }
    A.members.length = 0;
    news(W, capA(A) + ' is dissolved' + (why === 'collapse' ? ' as its members vanish' : (why === 'cohesion' ? ' after its members drift apart' : '')) + '.',
      'alliance', mem, A.type === 'defense' ? 3 : 2);
  }
  function inAlliance(W, a, b, type) {
    var ca = cOf(W, a), ib = idOf(b);
    if (!ca || ib < 0 || ca.id === ib) return false;
    var al = ca.alliances || [];
    for (var i = 0; i < al.length; i++) {
      var A = W.alliances[al[i]];
      if (!aliveAlliance(A)) continue;
      if (type ? A.type !== type : A.type !== 'defense') continue;
      if (A.members.indexOf(ib) >= 0) return true;
    }
    if (!type || type === 'defense') {
      if (ca.defensePacts && ca.defensePacts.indexOf(ib) >= 0) return true;
      var cb = W.countries[ib];
      if (ca.overlord === ib || (cb && cb.overlord === ca.id)) return true;
    }
    return false;
  }
  // ids obligated to defend c: defense-bloc co-members, bilateral pacts, overlord, puppets
  function allies(W, cc) {
    var c = cOf(W, cc), out = [];
    if (!c || !c.alive) return out;
    var id = c.id, i, j, al = c.alliances || [];
    for (i = 0; i < al.length; i++) {
      var A = W.alliances[al[i]];
      if (!aliveAlliance(A) || A.type !== 'defense') continue;
      for (j = 0; j < A.members.length; j++) { var m = A.members[j]; if (m !== id && isAlive(W, m) && out.indexOf(m) < 0) out.push(m); }
    }
    var dp = c.defensePacts || [];
    for (i = 0; i < dp.length; i++) { var p = dp[i]; if (p !== id && isAlive(W, p) && out.indexOf(p) < 0) out.push(p); }
    if (c.overlord >= 0 && isAlive(W, c.overlord) && out.indexOf(c.overlord) < 0) out.push(c.overlord);
    var K = W._dip && W._dip.K;
    if (K && K.n === W.countries.length) {
      var pp = K.pup[id];
      if (pp) for (i = 0; i < pp.length; i++) if (isAlive(W, pp[i]) && W.countries[pp[i]].overlord === id && out.indexOf(pp[i]) < 0) out.push(pp[i]);
    } else {
      var cs = W.countries;
      for (i = 0; i < cs.length; i++) { var o = cs[i]; if (o && o.alive && o.overlord === id && out.indexOf(i) < 0) out.push(i); }
    }
    return out;
  }
  function addPact(W, a, b) {
    var ca = cOf(W, a), cb = cOf(W, b); if (!ca || !cb || ca === cb) return false;
    ensureFields(ca); ensureFields(cb);
    if (ca.defensePacts.indexOf(cb.id) >= 0) return false;
    ca.defensePacts.push(cb.id); cb.defensePacts.push(ca.id);
    return true;
  }
  function removePact(W, a, b) {
    var ca = cOf(W, a), cb = cOf(W, b), k;
    if (ca && ca.defensePacts && (k = ca.defensePacts.indexOf(idOf(b))) >= 0) ca.defensePacts.splice(k, 1);
    if (cb && cb.defensePacts && (k = cb.defensePacts.indexOf(idOf(a))) >= 0) cb.defensePacts.splice(k, 1);
  }

  // ------------------------------------------------------------------ equilibrium relation row
  // Computes the structural "equilibrium" relation of a with every other living country, and either sets it
  // (mode 'init') or drifts W.rel toward it (mode 'drift').
  function relRow(W, S, a, mode) {
    var cs = W.countries, n = cs.length, NC = W.NC | 0, R = W.rel;
    var ca = cs[a]; if (!ca || !ca.alive || !R || a >= NC) return;
    var allyM = S.allyM, nbrM = S.nbrM, enemyM = S.enemyM, coM = S.coM, claimM = S.claimM, sancM = S.sancM;
    allyM.fill(0, 0, n); nbrM.fill(0, 0, n); enemyM.fill(0, 0, n); coM.fill(0, 0, n); claimM.fill(0, 0, n); sancM.fill(0, 0, n);
    var i, j, al = ca.alliances || [];
    for (i = 0; i < al.length; i++) {
      var A = W.alliances[al[i]]; if (!aliveAlliance(A)) continue;
      var bit = A.type === 'defense' ? 1 : (A.type === 'economic' ? 2 : 4);
      for (j = 0; j < A.members.length; j++) { var m = A.members[j]; if (m >= 0 && m < n) allyM[m] |= bit; }
    }
    var dp = ca.defensePacts || [];
    for (i = 0; i < dp.length; i++) if (dp[i] >= 0 && dp[i] < n) allyM[dp[i]] |= 8;
    if (ca.overlord >= 0 && ca.overlord < n) allyM[ca.overlord] |= 16;
    var nb = neighbors(W, ca);
    for (i = 0; i < nb.length; i++) nbrM[nb[i]] = 1;
    var en = S.enemies[a]; if (en) for (i = 0; i < en.length; i++) enemyM[en[i]] = 1;
    var co = S.coBel && S.coBel[a]; if (co) for (i = 0; i < co.length; i++) coM[co[i]] = 1;
    var cl = ca.claims || [];
    for (i = 0; i < cl.length; i++) { var rg = W.regions[cl[i]]; if (rg && rg.owner >= 0 && rg.owner < n && rg.owner !== a) claimM[rg.owner] = 1; }
    var sc = ca.sanctions || [];
    for (i = 0; i < sc.length; i++) if (sc[i] >= 0 && sc[i] < n) sancM[sc[i]] = 1;

    var K = cache(W);
    var ea = K.ec[a], aa = K.au[a], na = K.na[a];
    var fa = K.fr[a], gpA = K.gp[a] === 1, thA = K.th[a], tsA = K.ts[a];
    var Dm = W.dist, regs = W.regions;
    var mem = S.mem, init = mode === 'init' || mode === 'full', half = mode === 'init';
    var xs = ((rnd(W) * 4294967295) >>> 0) || 0x9E3779B9; // local xorshift for per-pair noise (seeded from W.rng)
    var rate = 0.05;
    for (var b = 0; b < n; b++) {
      if (b === a) continue;
      if (b >= NC || !K.al[b]) continue;
      if (half && b < a) continue;
      var nbr = nbrM[b] === 1;
      var d = Dm ? Dm[a * NC + b] : 0; if (!(d > 0)) d = distKm(W, a, b);
      var prox = nbr ? 1 : 1 / (1 + d / 4000);
      var att = 0.45 + 0.55 * prox;
      var eb = K.ec[b], ab = K.au[b], nbN = K.na[b];
      var fb = K.fr[b];
      var ideoT = 18 - 22 * ((M.abs(ea - eb) + M.abs(aa - ab)) * 0.5 + M.abs(na - nbN) * 0.5);
      var govT = 8 - 20 * M.abs(fa - fb) + (fa >= 0.8 && fb >= 0.8 ? 8 : 0);
      var eq = (ideoT + govT) * att;
      if (nbr) eq -= 4 + 10 * na * nbN;
      var dep = depPair(W, K, a, b);
      eq += M.min(30, 60 * dep);
      var am = allyM[b];
      if (K.ov[b] === a) am |= 16;
      if (am) eq += M.min(55, (am & 1 ? 30 : 0) + (am & 2 ? 15 : 0) + (am & 4 ? 8 : 0) + (am & 8 ? 25 : 0) + (am & 16 ? 45 : 0));
      if (enemyM[b]) eq -= 70;
      else if (coM[b]) eq += 20;
      var enb = S.enemies[b];
      if (enb && !enemyM[b]) { for (j = 0; j < enb.length; j++) if (enemyM[enb[j]]) { eq += 15; break; } }
      var tsB = K.ts[b];
      if (tsA >= 0 && tsA === tsB && tsA !== b && tsA !== a) eq += 40 * M.min(thA, K.th[b], 0.3);
      var cf = 0;
      if (claimM[b]) cf += 30;
      if (K.cl[b]) { var clb = cs[b].claims; for (j = 0; j < clb.length; j++) { var rr = regs[clb[j]]; if (rr && rr.owner === a) { cf += 30; break; } } }
      eq -= M.min(45, cf);
      if (sancM[b] || (K.sc[b] && cs[b].sanctions.indexOf(a) >= 0)) eq -= 15;
      if (gpA && K.gp[b] && !(am & 25)) eq -= 12 * att;
      var k = pk(a, b), mv = mem.get(k);
      if (mv !== undefined) {
        eq += mv;
        if (!init) { mv *= 0.9985; if (mv > -0.5 && mv < 0.5) mem.delete(k); else mem.set(k, mv); }
      }
      eq = clamp(eq, -100, 100);
      var r;
      if (init) r = eq;
      else {
        r = num(R[a * NC + b], 0);
        xs ^= xs << 13; xs ^= xs >>> 17; xs ^= xs << 5;
        r += (eq - r) * rate + ((xs >>> 0) / 4294967296 - 0.5) * 2;
        r = clamp(r, -100, 100);
      }
      R[a * NC + b] = r; R[b * NC + a] = r;
    }
  }

  // ------------------------------------------------------------------ threat & patron
  function updateThreat(W, S, c) {
    var cs = W.countries, n = cs.length, id = c.id, K = cache(W), NC = W.NC | 0;
    var myP = K.pw[id], al = allies(W, c), alP = 0, i;
    for (i = 0; i < al.length; i++) alP += K.pw[al[i]] * K.cred[al[i]] * 0.8;
    var nb = S.nbrM; // set by relRow just before
    var en = S.enemies[id];
    var best = 0, src = -1;
    for (var o = 0; o < n; o++) {
      if (o === id || !K.al[o] || o >= NC) continue;
      var r = W.rel[id * NC + o];
      var atWar = en !== null && en !== undefined && en.indexOf(o) >= 0;
      var h = atWar ? 1 : clamp((-r - 10) / 70, 0, 1);
      if (h <= 0) continue;
      var prox;
      if (nb[o] === 1 || atWar) prox = 1;
      else { var reach = 800 + 10000 * K.nv[o]; prox = clamp(1.15 - distKm(W, id, o) / reach, 0, 1); }
      if (prox <= 0) continue;
      var x = K.pw[o] * h * prox / (myP + alP + 1);
      var t = x / (1 + x);
      if (atWar && t < 0.5) t = 0.5;
      if (t > best) { best = t; src = o; }
    }
    c.threat = clamp(num(c.threat, 0) * 0.5 + best * 0.5, 0, 1);
    c.threatSrc = best > 0.05 ? src : -1;
  }
  // how much of a state's power can actually be projected (anarchy / losing a civil war: very little)
  function collapseF(c) {
    if (!c) return 0;
    if (c.gov === 'anarchy') return 0.2;
    if (c.civilWar && num(c.civilWar.control, 0) >= 0.3) return 0.2;
    if (c.civilWar) return 0.6;
    return 1;
  }
  function updatePatron(W, c) {
    if (c.overlord >= 0 && isAlive(W, c.overlord)) { c.patron = c.overlord; return; }
    var cs = W.countries, n = cs.length, id = c.id, K = cache(W), myP = K.pw[id];
    var best = 0, pat = -1;
    for (var o = 0; o < n; o++) {
      if (o === id || !K.al[o] || K.ov[o] >= 0) continue;
      var pp = K.pw[o] * collapseF(cs[o]);
      if (pp < 1.6 * myP) continue;
      var r = relRaw(W, id, o); if (r <= 15) continue;
      var prox = 0.35 + 0.65 * M.exp(-distKm(W, id, o) / 5000);
      var s = M.sqrt(pp) * (r - 15) / 85 * prox * (inAlliance(W, id, o) ? 1.5 : 1);
      if (s > best) { best = s; pat = o; }
    }
    // hysteresis: keep the current patron unless clearly beaten
    var cur = c.patron;
    if (cur >= 0 && cur !== pat && isAlive(W, cur) && relRaw(W, id, cur) > 10 && powerOf(W, cs[cur]) * collapseF(cs[cur]) > 1.3 * myP) {
      var co2 = cs[cur], s2 = M.sqrt(powerOf(W, co2) * collapseF(co2)) * (relRaw(W, id, cur) - 15) / 85 * (0.35 + 0.65 * M.exp(-distKm(W, id, cur) / 5000));
      if (s2 > best * 0.8) pat = cur;
    }
    c.patron = best > 0.4 ? pat : -1;
  }

  // ------------------------------------------------------------------ sanctions
  function updateSanctions(W, S, c) {
    var id = c.id, i, sc = c.sanctions;
    for (i = sc.length - 1; i >= 0; i--) {
      var t = sc[i];
      if (!isAlive(W, t)) { sc.splice(i, 1); continue; }
      if (relRaw(W, id, t) > -35 && chance(W, 0.35)) {
        sc.splice(i, 1);
        if (c.greatPower || W.countries[t].greatPower) news(W, c.name + ' lifts sanctions on ' + W.countries[t].name + '.', 'diplomacy', [id, t], 2);
      }
    }
    if (c.gov === 'anarchy' || c.overlord >= 0) return;
    var cs = W.countries, n = cs.length, en = S.enemies[id];
    var aggr = trait(c, 'aggression', 0.4), caut = trait(c, 'caution', 0.5);
    var gdpW = num(c.gdp, 0);
    if (gdpW < 5) return;
    var K = cache(W);
    for (var o = 0; o < n; o++) {
      if (o === id || !K.al[o]) continue;
      var r = relRaw(W, id, o);
      if (r >= -60 || sc.indexOf(o) >= 0) continue;
      var co = cs[o];
      if (en && en.indexOf(o) >= 0) continue;
      var dep = dependence(W, id, o);
      var p = 0.04 * (0.4 + aggr + 0.5 * (1 - caut)) * (c.greatPower ? 2 : 1) * clamp(1 - 2.5 * dep, 0, 1) * clamp((-r - 60) / 20 + 0.5, 0, 1.5);
      if (chance(W, p)) {
        sc.push(o);
        var imp = (c.greatPower || co.greatPower) ? 3 : 1;
        news(W, c.name + ' imposes sanctions on ' + co.name + '.', 'diplomacy', [id, o], imp);
      }
    }
  }

  // ------------------------------------------------------------------ claims
  function updateClaims(W, c) {
    var cl = c.claims, regs = W.regions, id = c.id, i;
    for (i = cl.length - 1; i >= 0; i--) {
      var r = regs[cl[i]];
      if (!r || r.owner === id) { cl.splice(i, 1); continue; }
      // claims on far-away lands held by much stronger friends fade slowly
      if (r.owner >= 0 && relRaw(W, id, r.owner) > 60 && chance(W, 0.01)) cl.splice(i, 1);
    }
    // revanchism: lost core regions become claims (more likely under nationalist leaders)
    var nat = c01(ideo(c, 'nat', 0.5), 0.5);
    for (i = 0; i < regs.length; i++) {
      var rg = regs[i];
      if (!rg || rg.core !== id || rg.owner === id || cl.indexOf(i) >= 0) continue;
      if (chance(W, 0.03 + 0.12 * nat)) cl.push(i);
    }
  }

  // ------------------------------------------------------------------ protection seeking
  function seekProtection(W, S, c) {
    if (c.overlord >= 0 || c.gov === 'anarchy') return;
    var th = c01(c.threat, 0), src = num(c.threatSrc, -1);
    if (th < 0.45 || src < 0 || !isAlive(W, src)) return;
    var cs = W.countries, id = c.id, srcC = cs[src], srcP = powerOf(W, srcC);
    var cur = allianceOf(W, c, 'defense');
    if (cur) {
      var lp = isAlive(W, cur.leader) ? powerOf(W, cs[cur.leader]) : 0;
      if (num(cur.cohesion, 0.5) > 0.4 && lp > 0.5 * srcP) return;
    }
    if (!chance(W, 0.1 * th)) return;
    var en = S.enemies[id];
    var best = 0, bo = -1;
    var K = cache(W);
    for (var o = 0; o < cs.length; o++) {
      if (o === id || o === src || !K.al[o] || K.ov[o] >= 0) continue;
      var r = relRaw(W, id, o); if (r <= 25) continue;
      if (relRaw(W, o, src) > 20) continue;
      var pp = K.pw[o];
      if (pp < 0.6 * srcP && !K.gp[o]) continue;
      var co = cs[o]; if (co.gov === 'anarchy') continue;
      if (en && en.indexOf(o) >= 0) continue;
      var s = pp * (r - 25) / 75 * (0.5 + 0.5 * M.exp(-distKm(W, id, o) / 8000));
      if (s > best) { best = s; bo = o; }
    }
    if (bo < 0) return;
    var P = cs[bo];
    var A = allianceOf(W, P, 'defense');
    if (A && A !== cur) {
      // admission decided by members' relations with the applicant (and with its enemy)
      // members weigh friendship against the risk of inheriting the applicant's enemies (esp. nuclear ones) and distance
      var sum = 0, sumS = 0, sumD = 0, k;
      for (k = 0; k < A.members.length; k++) { var mm = A.members[k]; sum += relRaw(W, mm, id); sumS += relRaw(W, mm, src); sumD += distKm(W, mm, id); }
      var nm = M.max(1, A.members.length);
      var adm = sum / nm - 0.3 * M.max(0, sumS / nm) - (c.atWar ? 60 : 0) - (nukesOf(srcC) > 0 ? 25 : 0) -
        clamp((sumD / nm - 3000) / 150, 0, 30) + 15 * (num(A.cohesion, 0.5) - 0.5);
      if (adm > 10 && relRaw(W, A.leader, id) > 30) { join(W, A.id, c); addRel(W, id, bo, 5); return; }
    }
    // bilateral pact
    var rp = relRaw(W, bo, id), rs = relRaw(W, bo, src);
    var will = (rp - 50) / 30 + 0.3 * clamp((-rs - 20) / 60, 0, 1) - distKm(W, bo, id) / 10000 -
      (nukesOf(srcC) > 0 ? (nukesOf(P) > 0 ? 0.3 : 0.6) : 0) - (trait(P, 'caution', 0.5) - 0.5) * 0.6 + (trait(P, 'ambition', 0.5) - 0.5) * 0.4 -
      (c.atWar ? 0.8 : 0) - (P.atWar ? 0.3 : 0);
    if (will > 0.35 && chance(W, 0.5) && (c.defensePacts || []).indexOf(bo) < 0) {
      addPact(W, id, bo); addRel(W, id, bo, 6);
      news(W, c.name + ' and ' + P.name + ' sign a mutual defense pact.', 'alliance', [id, bo], (P.greatPower ? 3 : 2));
    }
  }

  // ------------------------------------------------------------------ bloc naming
  function areaName(lon, lat) {
    if (lon < -30) return lat > 12 ? (lon > -95 && lat < 30 ? 'Caribbean' : 'Atlantic') : 'South American';
    if (lat < -10 && lon > 105) return 'Pacific';
    if (lon >= -25 && lon < 45 && lat >= 36) return 'European';
    if (lon >= 35 && lon < 63 && lat >= 12 && lat < 42) return 'Middle Eastern';
    if (lon >= -20 && lon < 52 && lat < 36) return 'African';
    if (lon >= 45 && lat >= 42) return 'Eurasian';
    if (lon >= 60 && lon < 95 && lat < 36) return 'Indian Ocean';
    if (lon >= 95 && lat < 22) return 'Indo-Pacific';
    return lon >= 100 ? 'Pacific' : 'Eurasian';
  }
  function blocName(W, f) {
    var reg = W.regions[f.capital] || EMPTY, area = areaName(num(reg.lon, 0), num(reg.lat, 0));
    var pats = [f.name + ' Security Pact', area + ' Compact', area + ' Treaty Organization', area + ' Defense Community',
      area + ' Mutual Security Alliance', f.name + '-led Collective Defense Treaty'];
    var name = pats[(rnd(W) * pats.length) | 0];
    var base = name, k = 2, ROM = ['', '', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    while (W.alliances.some(function (A) { return aliveAlliance(A) && A.name === name; })) { name = base + ' ' + (k < ROM.length ? ROM[k] : k); k++; }
    return name;
  }

  // ------------------------------------------------------------------ global monthly logic
  function rankPowers(W) {
    var cs = W.countries, arr = [], i;
    for (i = 0; i < cs.length; i++) if (cs[i] && cs[i].alive) arr.push(i);
    var pw = {};
    for (i = 0; i < arr.length; i++) pw[arr[i]] = powerOf(W, cs[arr[i]]);
    arr.sort(function (x, y) { return pw[y] - pw[x]; });
    var first = !W._dip.ranked;
    for (i = 0; i < arr.length; i++) {
      var c = cs[arr[i]]; ensureFields(c);
      var was = c.greatPower;
      c.gpRank = i + 1;
      var gp = was ? i < 10 : i < 8;
      if (first) gp = i < 8;
      c.greatPower = gp;
      if (!first && gp && !was) news(W, c.name + ' rises to great-power status.', 'diplomacy', [c.id], 3);
      else if (!first && !gp && was) news(W, c.name + ' is no longer counted among the great powers.', 'diplomacy', [c.id], 2);
    }
    W._dip.ranked = true;
    // influence: own strength plus clients
    for (i = 0; i < cs.length; i++) { var x = cs[i]; if (x) x.influence = x.alive ? 0.6 * num(pw[i], 0) + 0.004 * num(x.gdp, 0) : 0; }
    for (i = 0; i < cs.length; i++) {
      var y = cs[i]; if (!y || !y.alive || y.patron < 0) continue;
      var p = cs[y.patron]; if (p && p.alive) p.influence += 5 + 0.3 * num(pw[i], 0) + 0.002 * num(y.gdp, 0);
    }
    // yearly rank memory (for "rising power" detection)
    if ((W.tick | 0) % 52 === 0) {
      for (i = 0; i < cs.length; i++) { var z = cs[i]; if (!z || !z.alive) continue; ensureFields(z); z._rankQ.push(z.gpRank); if (z._rankQ.length > 3) z._rankQ.shift(); }
    }
  }

  function allianceMonthly(W, S) {
    var cs = W.countries, al = W.alliances, i, k;
    for (i = 0; i < al.length; i++) {
      var A = al[i]; if (!aliveAlliance(A)) continue;
      // purge dead
      for (k = A.members.length - 1; k >= 0; k--) {
        var m = A.members[k];
        if (!isAlive(W, m)) { A.members.splice(k, 1); if (A.leader === m) { A.leader = -1; if (A.type === 'defense') A.cohesion = clamp(A.cohesion - 0.25, 0, 1); } }
      }
      if (A.members.length <= 1) { dissolve(W, A, 'collapse'); continue; }
      // leader = strongest member (defense) / largest economy (others)
      var best = -1, bp = -1, tot = 0;
      for (k = 0; k < A.members.length; k++) {
        var c = cs[A.members[k]];
        var p = A.type === 'defense' ? powerOf(W, c) : num(c.gdp, 0);
        tot += p;
        if (p > bp) { bp = p; best = c.id; }
      }
      if (A.leader !== best) {
        if (A.leader >= 0 && A.type === 'defense' && isAlive(W, A.leader) && A.members.indexOf(A.leader) >= 0) A.cohesion = clamp(A.cohesion - 0.05, 0, 1);
        A.leader = best;
      }
      // average internal relations (sampled for big blocs)
      var sum = 0, cnt = 0, nM = A.members.length, atWarInside = 0;
      for (k = 0; k < nM; k++) {
        var x = A.members[k];
        if (x !== A.leader) { sum += relRaw(W, x, A.leader) * 2; cnt += 2; }
        var y = A.members[(k + 1 + ((rnd(W) * (nM - 1)) | 0)) % nM];
        if (y !== x) { sum += relRaw(W, x, y); cnt++; }
        var en = S.enemies[x];
        if (en) for (var e = 0; e < en.length; e++) if (A.members.indexOf(en[e]) >= 0) { atWarInside++; break; }
      }
      var avgRel = cnt ? sum / cnt : 0;
      var target;
      if (A.type === 'defense') {
        var share = tot > 0 ? bp / tot : 0;
        var thr = 0;
        for (k = 0; k < nM; k++) { var cc = cs[A.members[k]]; if (c01(cc.threat, 0) > 0.3 && A.members.indexOf(cc.threatSrc) < 0) thr++; }
        target = 0.3 + avgRel / 150 + 0.35 * M.min(1, share * 2) + 0.2 * thr / nM - 0.3 * atWarInside / nM;
        var lc = cs[A.leader];
        if (lc && collapseF(lc) < 1) target -= 0.3 * (1 - collapseF(lc)) / 0.8;
      } else target = 0.5 + avgRel / 120;
      A.cohesion = clamp(num(A.cohesion, 0.6) + (clamp(target, 0, 1) - num(A.cohesion, 0.6)) * 0.08, 0, 1);
      // departures
      for (k = A.members.length - 1; k >= 0 && !A.dissolved; k--) {
        var mid = A.members[k]; if (mid === A.leader) continue;
        var mc = cs[mid], rL = relRaw(W, mid, A.leader), pl = 0, why = 'cohesion';
        if (A.type === 'defense') {
          pl = clamp((0.35 - A.cohesion) * 0.6, 0, 0.25);
          if (rL < -25) { pl += 0.2; why = 'relations'; }
          var enm = S.enemies[mid];
          if (enm) for (var q = 0; q < enm.length; q++) if (A.members.indexOf(enm[q]) >= 0) { pl = 1; why = 'war'; break; }
          if (mc.patron >= 0 && A.members.indexOf(mc.patron) < 0 && relRaw(W, mc.patron, A.leader) < -40 && relRaw(W, mid, mc.patron) > rL + 30) { pl += 0.08; why = 'switch'; }
          if (mc.overlord >= 0 && A.members.indexOf(mc.overlord) < 0) { pl = 1; why = 'puppet'; }
          var lcc = cs[A.leader];
          if (lcc && collapseF(lcc) < 0.5 && pl < 1) { pl += 0.04; why = 'switch'; }
        } else {
          pl = clamp((0.3 - A.cohesion) * 0.3, 0, 0.1) + (rL < -45 ? 0.08 : 0);
          if (rL < -45) why = 'relations';
        }
        if (chance(W, pl)) leave(W, A.id, mc, why);
      }
      if (!A.dissolved && A.members.length <= 1) dissolve(W, A, 'cohesion');
      if (!A.dissolved && A.cohesion < 0.06 && chance(W, 0.2)) dissolve(W, A, 'cohesion');
    }
    // pacts: dissolve when relations collapse
    for (i = 0; i < cs.length; i++) {
      var c2 = cs[i]; if (!c2 || !c2.alive || !c2.defensePacts) continue;
      for (k = c2.defensePacts.length - 1; k >= 0; k--) {
        var o = c2.defensePacts[k];
        if (!isAlive(W, o)) { c2.defensePacts.splice(k, 1); continue; }
        if (o > i && relRaw(W, i, o) < -10 && chance(W, 0.15)) {
          removePact(W, i, o);
          news(W, 'The defense pact between ' + c2.name + ' and ' + cs[o].name + ' lapses.', 'alliance', [i, o], 2);
        }
      }
    }
  }

  // new blocs form around a rising great power
  function foundBlocs(W, S) {
    if ((W.tick | 0) - S.lastFound < 26) return;
    var cs = W.countries;
    for (var i = 0; i < cs.length; i++) {
      var g = cs[i]; if (!g || !g.alive || !g.greatPower || g.overlord >= 0 || g.gov === 'anarchy') continue;
      var cur = allianceOf(W, g, 'defense');
      if (cur && cur.leader === g.id) continue;
      if (cur && isAlive(W, cur.leader) && cur.cohesion > 0.35) continue;
      var q = g._rankQ || [];
      var past = q.length ? q[0] : g.gpRank;
      var rising = g.gpRank <= 4 && (g.gpRank <= past - 2 || (g.gpRank === 1 && past > 1) || (cur && cur.leader !== g.id && cur.cohesion < 0.3));
      if (!rising) continue;
      if (!chance(W, 0.03 + 0.12 * trait(g, 'ambition', 0.5))) continue;
      var friends = [];
      for (var o = 0; o < cs.length; o++) {
        if (o === i) continue;
        var f = cs[o]; if (!f || !f.alive || f.overlord >= 0 && f.overlord !== i) continue;
        if (relRaw(W, i, o) < 40) continue;
        var fa = allianceOf(W, f, 'defense');
        if (fa && isAlive(W, fa.leader) && fa.cohesion > 0.3 && fa.leader !== i) continue;
        if (c01(f.threat, 0) < 0.2 && f.patron !== i && f.overlord !== i) continue;
        friends.push(o);
      }
      if (friends.length < 3) continue;
      var aid = createAlliance(W, blocName(W, g), i, 'defense');
      var A = W.alliances[aid];
      for (var k = 0; k < friends.length; k++) join(W, aid, cs[friends[k]], true);
      S.lastFound = W.tick | 0;
      if (A.members.length <= 1) { dissolve(W, A, 'empty'); continue; }
      news(W, g.name + ' founds ' + theA(A) + ' with ' + (A.members.length - 1) + ' partner' + (A.members.length > 2 ? 's' : '') + '.', 'alliance', A.members.slice(0, 8), 4);
      return;
    }
  }

  // ------------------------------------------------------------------ ungoverned land
  function settle(W, c) {
    if (c.gov === 'anarchy' || c.civilWar || c.overlord >= 0) return;
    var regs = W.regions, cand = -1, best = 0, i, k;
    var own = c.regions || [];
    for (i = 0; i < own.length; i++) {
      var r = regs[own[i]]; if (!r || !r.neighbors) continue;
      for (k = 0; k < r.neighbors.length; k++) {
        var nr = regs[r.neighbors[k]];
        if (!nr || nr.owner !== -1) continue;
        var s = 1 + (c.claims.indexOf(nr.id) >= 0 ? 1 : 0) + (nr.core === c.id ? 1.5 : 0) + rnd(W) * 0.5;
        if (s > best) { best = s; cand = nr.id; }
      }
    }
    var nv = navyOf(c);
    if (cand < 0 && nv > 0.2) { // overseas: empty lands within naval reach of the capital
      var cap = regs[c.capital], reach = 600 + 4000 * nv;
      if (cap && GS.Geo && GS.Geo.haversineKm) for (i = 0; i < regs.length; i++) {
        var er = regs[i]; if (!er || er.owner !== -1) continue;
        var dkm = GS.Geo.haversineKm(cap.lon, cap.lat, er.lon, er.lat);
        if (dkm < reach) { var s2 = 0.6 * (1 - dkm / reach) + rnd(W) * 0.3; if (s2 > best) { best = s2; cand = i; } }
      }
    }
    if (cand < 0) return;
    var amb = trait(c, 'ambition', 0.5), unrest = c01(c.unrest, 0.2), pwr = powerOf(W, c);
    var stretch = own.length / (3 + M.sqrt(M.max(1, pwr)));
    var u = 0.25 + 0.5 * amb + 0.2 * M.min(1, pwr / 60) - 0.3 * clamp(stretch - 1, 0, 2) - 0.4 * unrest - (c.atWar ? 0.4 : 0) + 0.25 * (best - 1);
    if (!(u > 0)) return;
    // progress builds up month by month: settlers, administrators and soldiers have to actually get there.
    // Big, strong states advance faster; vast lands take long. Rival claimants on the same land clash.
    var reg = regs[cand];
    var prog = reg.settle || (reg.settle = {});
    var rate = 0.12 * clamp(u, 0, 1.2) * (M.log(1 + M.max(0, pwr)) / M.LN10 / 2) * M.sqrt(10000 / M.max(500, num(reg.area, 10000)));
    prog[c.id] = num(prog[c.id], 0) + clamp(rate, 0, 0.5);
    for (var oc in prog) {
      var o = +oc;
      if (o === c.id || !isAlive(W, o) || !(prog[oc] > 0.25) || !(prog[c.id] > 0.25)) continue;
      addRel(W, c.id, o, -3);
      if (c.claims && c.claims.indexOf(cand) < 0) c.claims.push(cand);
    }
    if (prog[c.id] < 1) return;
    reg.settle = null;
    if (GS.World && typeof GS.World.setRegionOwner === 'function') {
      GS.World.setRegionOwner(W, cand, c.id, 'settlement');
      if (reg.owner === c.id) {
        // the land's natural wealth now belongs to the settler, and some of its people move in
        var de = (GS.DATA && GS.DATA.countries || EMPTY)[reg.key];
        if (de && reg.core !== c.id) c.oil = clamp(num(c.oil, 0) + M.max(0, num(de.oil, 0)) / M.max(1, num(reg.subN, 1)), 0, 3);
        if (GS.People && typeof GS.People.colonize === 'function') GS.People.colonize(W, c.id, cand, 0.04 + 0.08 * clamp(num(reg.area, 0) / M.max(1, ownArea(W, c)), 0, 1));
        news(W, c.name + ' extends its authority over the ungoverned lands of ' + reg.name + '.', 'diplomacy', [c.id], 2);
      }
    }
  }
  function ownArea(W, c) {
    var a = 0, own = c.regions || [];
    for (var i = 0; i < own.length; i++) { var r = W.regions[own[i]]; if (r) a += num(r.area, 0); }
    return a;
  }

  // puppets may break free
  function puppetCheck(W, c) {
    if (c.overlord < 0) return;
    var ov = W.countries[c.overlord];
    if (!ov || !ov.alive) { c.overlord = -1; return; }
    var L = L_(c), installed = L && L.installedBy === ov.id;
    var desire = 0.5 * c01(ideo(c, 'nat', 0.5), 0.5) + (relRaw(W, c.id, ov.id) < 0 ? 0.35 : 0) + (c01(ov.warExhaustion, 0) > 0.5 ? 0.2 : 0) +
      (powerOf(W, ov) < 1.5 * powerOf(W, c) ? 0.3 : 0) + (ov.gov === 'anarchy' || ov.civilWar ? 0.5 : 0);
    var p = 0.006 * desire * (installed ? 0.25 : 1);
    if (chance(W, p)) {
      c.overlord = -1; if (c.patron === ov.id) c.patron = -1;
      addRel(W, c.id, ov.id, -20); addMemory(W, c.id, ov.id, -10);
      news(W, c.name + ' throws off the domination of ' + ov.name + ' and reasserts its independence.', 'diplomacy', [c.id, ov.id], 3);
    }
  }

  function alignDrift(W, S, c) {
    if (c.overlord >= 0 || c.gov === 'anarchy') return;
    var al = W.alliances, id = c.id, cs = W.countries, i;
    var en = S.enemies[id];
    for (i = 0; i < al.length; i++) {
      var A = al[i]; if (!aliveAlliance(A) || !isAlive(W, A.leader) || A.leader === id) continue;
      var L = cs[A.leader], rL = relRaw(W, id, A.leader), mem = A.members.indexOf(id) >= 0;
      var def = A.type === 'defense';
      if (mem) {
        var pl = rL < 0 ? (def ? 0.03 : 0.015) : 0;
        var pa = c.patron;
        if (def && pa >= 0 && pa !== A.leader && isAlive(W, pa)) {
          var PA = allianceOf(W, cs[pa], 'defense');
          if (PA && PA !== A && PA.leader === pa) pl += 0.03;
        }
        if (chance(W, pl)) leave(W, A.id, c, 'drift');
        continue;
      }
      if (def && allianceOf(W, c, 'defense')) continue; // one defensive bloc at a time
      if (collapseF(L) < 1) continue;
      var near = distKm(W, id, A.leader) < (def ? 9000 : 2500);
      var th = c01(c.threat, 0);
      var want = def ? ((rL > 65 && th > 0.2) || (c.patron === A.leader && th > 0.1)) && near : rL > 65 && near;
      if (!want) continue;
      if (en) { var bad = false; for (var e = 0; e < en.length; e++) if (A.members.indexOf(en[e]) >= 0) { bad = true; break; } if (bad) continue; }
      // members must be broadly willing
      var sum = 0, nm = A.members.length, smp = M.min(nm, 8);
      for (var k = 0; k < smp; k++) sum += relRaw(W, A.members[(k * 7 + id) % nm], id);
      if (sum / M.max(1, smp) < 0) continue;
      if (chance(W, def ? 0.006 : 0.003)) join(W, A.id, c);
    }
  }

  function countryMonthly(W, S, c) {
    ensureFields(c);
    relRow(W, S, c.id, 'drift');
    updateThreat(W, S, c);
    updatePatron(W, c);
    updateSanctions(W, S, c);
    updateClaims(W, c);
    puppetCheck(W, c);
    seekProtection(W, S, c);
    alignDrift(W, S, c);
    settle(W, c);
    c.credibility = clamp(num(c.credibility, 0.7) + (0.7 - num(c.credibility, 0.7)) * 0.02, 0, 1);
  }

  // ------------------------------------------------------------------ init
  function init(W) {
    var S = S_(W), cs = W.countries, D = GS.DATA || EMPTY, i, k;
    S.mem.clear();
    var keyTo = {};
    for (i = 0; i < cs.length; i++) { var c = cs[i]; if (!c) continue; ensureFields(c); c.alliances = []; c.defensePacts = []; c.claims = []; c.sanctions = []; if (c.key !== undefined) keyTo[String(c.key)] = i; }
    function idFor(key) { var id = keyTo[String(key)]; return (id !== undefined && cs[id] && cs[id].alive) ? id : -1; }
    // blocs
    W.alliances = [];
    var blocs = D.blocs || [];
    for (i = 0; i < blocs.length; i++) {
      var b = blocs[i];
      if (b.type !== 'defense' && b.type !== 'economic' && b.type !== 'political') continue;
      var A = makeAlliance(W, b.name, b.type, b.color ? b.color.slice() : null, -1);
      if (b.fullName) A.fullName = b.fullName;
      var mem = b.members;
      if (!mem) { mem = []; for (k = 0; k < cs.length; k++) if (cs[k] && cs[k].data && cs[k].data.blocs && cs[k].data.blocs.indexOf(b.name) >= 0) mem.push(cs[k].key); }
      for (k = 0; k < mem.length; k++) {
        var id = idFor(mem[k]); if (id < 0) continue;
        if (A.members.indexOf(id) < 0) { A.members.push(id); cs[id].alliances.push(A.id); }
      }
      A.cohesion = b.type === 'defense' ? 0.85 : 0.7;
      var bp = -1;
      for (k = 0; k < A.members.length; k++) {
        var mc = cs[A.members[k]], pv = b.type === 'defense' ? powerOf(W, mc) : num(mc.gdp, 0);
        if (pv > bp) { bp = pv; A.leader = mc.id; }
      }
      A.founder = A.leader;
      if (A.members.length <= 1) { A.dissolved = true; A.dissolvedTick = 0; if (A.members.length) { var only = cs[A.members[0]]; only.alliances.splice(only.alliances.indexOf(A.id), 1); } A.members = []; }
    }
    var bd = D.bilateralDefense || [];
    for (i = 0; i < bd.length; i++) { var x = idFor(bd[i][0]), y = idFor(bd[i][1]); if (x >= 0 && y >= 0 && x !== y) addPact(W, x, y); }
    var cl = D.claims || [];
    var regKey = {};
    for (i = 0; i < W.regions.length; i++) { var rg = W.regions[i]; if (rg) (regKey[String(rg.key)] || (regKey[String(rg.key)] = [])).push(i); }
    for (i = 0; i < cl.length; i++) {
      var cid = idFor(cl[i][0]); if (cid < 0) continue;
      var key = String(cl[i][1]), rid = regKey[key];
      var targets = [];
      if (rid !== undefined) targets = rid.slice();
      else { var tc = idFor(key); if (tc >= 0) targets = (cs[tc].regions || []).slice(); }
      for (k = 0; k < targets.length; k++) if (W.regions[targets[k]].owner !== cid && cs[cid].claims.indexOf(targets[k]) < 0) cs[cid].claims.push(targets[k]);
    }
    var sn = D.sanctions || [];
    for (i = 0; i < sn.length; i++) {
      var sx = idFor(sn[i][0]), sy = idFor(sn[i][1]);
      if (sx >= 0 && sy >= 0 && sx !== sy && cs[sx].sanctions.indexOf(sy) < 0) cs[sx].sanctions.push(sy);
    }
    buildCache(W, S);
    rankPowers(W);
    buildWarLists(W, S);
    buildCache(W, S);
    for (i = 0; i < cs.length; i++) if (cs[i] && cs[i].alive) relRow(W, S, i, 'init');
    // historical seeds become persistent memory on top of the structural base
    var seeds = D.relations || [];
    for (i = 0; i < seeds.length; i++) {
      var a = idFor(seeds[i][0]), bb = idFor(seeds[i][1]), v = num(seeds[i][2], 0);
      if (a < 0 || bb < 0 || a === bb) continue;
      var base = relRaw(W, a, bb);
      S.mem.set(pk(a, bb), clamp(v - base, -150, 150));
      setRel(W, a, bb, v);
    }
    for (i = 0; i < cs.length; i++) { var cc = cs[i]; if (cc && cc.alive) { relRowThreatInit(W, S, cc); } }
    buildCache(W, S);
    for (i = 0; i < cs.length; i++) { var c3 = cs[i]; if (c3 && c3.alive) { c3._rankQ = [c3.gpRank]; } }
  }
  function relRowThreatInit(W, S, c) {
    // neighbour marks are needed by updateThreat
    var n = W.countries.length; S.nbrM.fill(0, 0, n);
    var nb = neighbors(W, c); for (var i = 0; i < nb.length; i++) S.nbrM[nb[i]] = 1;
    updateThreat(W, S, c); updatePatron(W, c);
  }

  function initCountry(W, cc) {
    var c = cOf(W, cc); if (!c) return;
    var S = S_(W);
    c.patron = -1; if (typeof c.overlord !== 'number') c.overlord = -1;
    c.threat = 0; c.threatSrc = -1; c.claims = []; c.sanctions = []; c.greatPower = false; c.influence = 0;
    c.alliances = []; c.defensePacts = []; c.credibility = 0.6; c.gpRank = 999; c._rankQ = [];
    buildWarLists(W, S);
    buildCache(W, S);
    relRow(W, S, c.id, 'full'); // row set straight to equilibrium
    var NC = W.NC | 0, cs = W.countries, id = c.id;
    if (W.rel && id < NC) {
      var par = num(c.parent, -1);
      for (var b = 0; b < cs.length; b++) {
        if (b === id || !cs[b] || !cs[b].alive || b >= NC) continue;
        var v = relRaw(W, id, b);
        if (b === par) v = c.overlord === par ? 40 : -35;
        else if (par >= 0 && par < NC) v = 0.6 * v + 0.4 * relRaw(W, par, b) * (c.overlord === par ? 1 : -0.3);
        setRel(W, id, b, v);
      }
      if (par >= 0 && isAlive(W, par) && c.overlord !== par) { addMemory(W, id, par, -25); }
    }
  }
  function step(W) {
    var S = S_(W), cs = W.countries, tick = W.tick | 0, i;
    buildWarLists(W, S);
    buildCache(W, S);
    if (tick % 4 === 0) {
      rankPowers(W);
      allianceMonthly(W, S);
      foundBlocs(W, S);
    }
    for (i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (!c || !c.alive || ((tick + i) & 3) !== 0) continue;
      countryMonthly(W, S, c);
    }
  }

  function onCountryRemoved(W, cc) {
    var c = cOf(W, cc); if (!c) return;
    S_(W);
    var id = c.id, cs = W.countries, i, k;
    var al = W.alliances || [];
    for (i = 0; i < al.length; i++) {
      var A = al[i]; if (!A || A.dissolved) continue;
      k = A.members.indexOf(id);
      if (k >= 0) leave(W, A.id, c, 'removed');
    }
    for (i = 0; i < cs.length; i++) {
      var o = cs[i]; if (!o || o === c) continue;
      if (o.defensePacts && (k = o.defensePacts.indexOf(id)) >= 0) o.defensePacts.splice(k, 1);
      if (o.sanctions && (k = o.sanctions.indexOf(id)) >= 0) o.sanctions.splice(k, 1);
      if (o.patron === id) o.patron = -1;
      if (o.overlord === id) {
        o.overlord = -1;
        if (o.alive) news(W, o.name + ' regains full independence after the fall of ' + c.name + '.', 'diplomacy', [o.id], 2);
      }
      if (o.threatSrc === id) o.threatSrc = -1;
    }
    c.alliances = []; c.defensePacts = []; c.sanctions = []; c.claims = [];
    c.patron = -1; c.overlord = -1; c.greatPower = false; c.influence = 0; c.threat = 0; c.threatSrc = -1;
  }

  // ------------------------------------------------------------------ map helpers
  function sphereColor(W, cc) {
    var c = cOf(W, cc);
    if (!c || !c.alive) return [40, 40, 44];
    var p = c, guard = 0;
    while (guard++ < 5) {
      var nx = p.overlord >= 0 ? p.overlord : p.patron;
      if (nx < 0) break;
      var q = W.countries[nx]; if (!q || !q.alive || q === c) break;
      p = q;
    }
    if (p === c) return c.greatPower ? (c.color || [200, 200, 200]).slice() : [95, 95, 100];
    return (p.color || [160, 160, 160]).slice();
  }
  function blocColor(W, cc) {
    var A = allianceOf(W, cc, 'defense') || allianceOf(W, cc, 'economic') || allianceOf(W, cc, 'political');
    return A ? A.color.slice() : null;
  }

  GS.Diplo = {
    init: init,
    initCountry: initCountry,
    step: step,
    rel: rel,
    addRel: addRel,
    addMemory: addMemory,
    allies: allies,
    inAlliance: inAlliance,
    createAlliance: createAlliance,
    join: join,
    leave: leave,
    dissolve: function (W, allianceId, why) { dissolve(W, W.alliances[allianceId], why); },
    addPact: addPact,
    removePact: removePact,
    allianceOf: allianceOf,
    neighbors: neighbors,
    onCountryRemoved: onCountryRemoved,
    sphereColor: sphereColor,
    blocColor: blocColor,
    distKm: distKm
  };
})();
