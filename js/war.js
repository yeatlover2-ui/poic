// GODSIM — war.js  (GS.War)
// Military strength, war declaration AI (expected-value, ally-aware), weekly war resolution,
// peace treaties, nuclear use. Generic rules only — no country is special-cased here.
(function () {
  'use strict';
  var GS = globalThis.GS = globalThis.GS || {};
  var M = Math;
  var EMPTY = {};
  var MILITARY = 6;

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
  function gauss(W) { return W.rng && W.rng.normal ? num(W.rng.normal(), 0) : (rnd(W) + rnd(W) + rnd(W) - 1.5) * 2; }
  function sigmoid(x) { if (x > 40) return 1; if (x < -40) return 0; return 1 / (1 + M.exp(-x)); }
  function news(W, text, type, ids, imp) {
    if (typeof GS.news === 'function') GS.news(W, text, { type: type || 'war', countries: ids || [], importance: imp || 2 });
  }
  function L_(c) { var L = c && c.leader; return (L && !L.none) ? L : null; }
  function trait(c, k, d) { var L = L_(c); return L ? c01(L[k], d) : d; }
  function lid(c, k, d) { var L = L_(c); return L ? num(L[k], d) : d; }
  function rel(W, a, b) {
    var NC = W.NC | 0;
    if (a === b) return 100;
    if (!W.rel || a < 0 || b < 0 || a >= NC || b >= NC) return 0;
    return num(W.rel[a * NC + b], 0);
  }
  function addRel(W, a, b, d) { if (GS.Diplo && GS.Diplo.addRel) GS.Diplo.addRel(W, a, b, d); }
  function addMem(W, a, b, d) { if (GS.Diplo && GS.Diplo.addMemory) GS.Diplo.addMemory(W, a, b, d); }
  function alliesOf(W, c) { return (GS.Diplo && GS.Diplo.allies) ? (GS.Diplo.allies(W, c) || []) : []; }
  function neighborsOf(W, c) {
    if (GS.Diplo && GS.Diplo.neighbors) return GS.Diplo.neighbors(W, c);
    return [];
  }
  function distKm(W, a, b) {
    if (a === b) return 0;
    var NC = W.NC | 0;
    if (W.dist && a >= 0 && b >= 0 && a < NC && b < NC) { var v = W.dist[a * NC + b]; if (v > 0) return v; }
    var ca = W.countries[a], cb = W.countries[b];
    var ra = ca && W.regions[ca.capital], rb = cb && W.regions[cb.capital];
    if (ra && rb && GS.Geo && GS.Geo.haversineKm) return num(GS.Geo.haversineKm(ra.lon, ra.lat, rb.lon, rb.lat), 5000);
    return 5000;
  }
  function kmTo(W, c, lon, lat) {
    var r = W.regions[c.capital];
    if (!r || !GS.Geo || !GS.Geo.haversineKm) return 3000;
    return num(GS.Geo.haversineKm(r.lon, r.lat, lon, lat), 3000);
  }
  function dataNum(c, k, d) { return num(c[k], c.data ? num(c.data[k], d) : d); }
  function techOf(c) { return clamp(dataNum(c, 'tech', 0.8), 0.2, 2); }
  function navyOf(c) { return c01(dataNum(c, 'navy', 0), 0); }
  function nukesOf(c) { return M.max(0, dataNum(c, 'nukes', 0)); }
  function spendMilOf(c) {
    var s = num(c.spendMil, -1);
    if (!(s >= 0)) s = num(c.data && c.data.mil, 1.5) / 100;
    return clamp(s, 0, 0.6);
  }
  function gdpOf(c) { return M.max(0, num(c.gdp, num(c.gdp0, c.data ? num(c.data.gdp, 1) : 1))); }
  function dependence(W, a, b) { return (GS.Economy && GS.Economy.dependence) ? c01(GS.Economy.dependence(W, a, b), 0) : 0; }

  // ------------------------------------------------------------------ state
  function ST_(W) {
    var S = W._war;
    if (!S) S = W._war = { nextId: 1, active: [], truce: new Map(), dirty: true, nameCount: {} };
    if (!W.wars) W.wars = [];
    return S;
  }
  function pk(a, b) { return a < b ? a * 65536 + b : b * 65536 + a; }
  function refreshActive(W) {
    var S = ST_(W), act = S.active, ws = W.wars;
    act.length = 0;
    for (var i = 0; i < ws.length; i++) if (ws[i] && !ws[i].ended) act.push(ws[i]);
    S.dirty = false;
    return act;
  }
  function active(W) { var S = ST_(W); return S.dirty ? refreshActive(W) : S.active; }
  function recomputeAtWar(W) {
    var cs = W.countries, i, k, act = active(W);
    for (i = 0; i < cs.length; i++) if (cs[i]) cs[i].atWar = false;
    for (i = 0; i < act.length; i++) {
      var w = act[i];
      for (k = 0; k < w.attackers.length; k++) { var a = cs[w.attackers[k]]; if (a) a.atWar = true; }
      for (k = 0; k < w.defenders.length; k++) { var d = cs[w.defenders[k]]; if (d) d.atWar = true; }
    }
  }

  // ------------------------------------------------------------------ power
  function estMilStock(c) { return spendMilOf(c) * gdpOf(c) * 6; }
  function estManpower(c) {
    var w = c.workers && num(c.workers.military, 0);
    if (w > 0) return w;
    return M.max(0, num(c.pop, num(c.pop0, 1) * 1e6)) * 0.004;
  }
  function power(W, cc) {
    var c = cOf(W, cc); if (!c || !c.alive) return 0;
    var ms = num(c.milStock, -1); if (!(ms >= 0)) ms = estMilStock(c);
    var mp = num(c.manpower, -1); if (!(mp >= 0)) mp = estManpower(c);
    var mf = clamp(M.pow((mp + 1) / (ms * 300 + 2000), 0.25), 0.35, 1.4);
    var morale = 0.65 + 0.35 * c01(c.milApproval, 0.6);
    var exh = c01(c.warExhaustion, 0);
    var p = M.pow(M.max(0, ms), 0.8) * techOf(c) * mf * morale * (1 - 0.7 * exh);
    if (c.civilWar) p *= 0.6;
    if (c.gov === 'anarchy') p *= 0.25;
    return (p > 0 && p < 1e9) ? p : 0;
  }
  function pw(c) { return c && c.alive ? M.max(0, num(c.power, 0)) : 0; }

  function initCountry(W, cc) {
    var c = cOf(W, cc); if (!c) return;
    var newState = (W.tick | 0) > 0 && num(c.createdTick, 0) > 0;
    if (!(num(c.milStock, -1) >= 0)) c.milStock = estMilStock(c) * (newState ? 0.4 : 1);
    if (!(num(c.manpower, -1) >= 0)) c.manpower = estManpower(c);
    c.warExhaustion = c01(c.warExhaustion, 0);
    c.atWar = false;
    if (typeof c.credibility !== 'number') c.credibility = 0.7;
    c.power = power(W, c);
  }

  // ------------------------------------------------------------------ queries
  function sideOf(war, id) {
    if (war.attackers.indexOf(id) >= 0) return 1;
    if (war.defenders.indexOf(id) >= 0) return 2;
    return 0;
  }
  function isAtWar(W, a, b) {
    var ia = idOf(a), ib = idOf(b); if (ia < 0 || ib < 0 || ia === ib) return false;
    var act = active(W);
    for (var i = 0; i < act.length; i++) {
      var s = sideOf(act[i], ia); if (!s) continue;
      var t = sideOf(act[i], ib); if (t && t !== s) return true;
    }
    return false;
  }
  function enemies(W, cc) {
    var id = idOf(cc), out = [], act = active(W);
    for (var i = 0; i < act.length; i++) {
      var w = act[i], s = sideOf(w, id); if (!s) continue;
      var other = s === 1 ? w.defenders : w.attackers;
      for (var k = 0; k < other.length; k++) if (out.indexOf(other[k]) < 0) out.push(other[k]);
    }
    return out;
  }
  function warsOf(W, cc) {
    var id = idOf(cc), out = [], act = active(W);
    for (var i = 0; i < act.length; i++) if (sideOf(act[i], id)) out.push(act[i]);
    return out;
  }
  function truceActive(W, a, b) {
    var t = ST_(W).truce.get(pk(a, b));
    return t !== undefined && t > (W.tick | 0);
  }

  // ------------------------------------------------------------------ naming
  var ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  var ORD = ['', '', 'Second ', 'Third ', 'Fourth ', 'Fifth ', 'Sixth ', 'Seventh ', 'Eighth ', 'Ninth ', 'Tenth '];
  function continentOf(lon, lat) {
    if (lon < -30) return lat > 12 ? 'North American' : 'South American';
    if (lat < -10 && lon > 105) return 'Pacific';
    if (lon >= -25 && lon < 45 && lat >= 36) return 'European';
    if (lon >= 35 && lon < 63 && lat >= 12 && lat < 42) return 'Middle Eastern';
    if (lon >= -20 && lon < 52 && lat < 36) return 'African';
    if (lon >= 45 && lat >= 42) return 'Eurasian';
    return 'Asian';
  }
  function frontLL(W, war) {
    var lon = 0, lat = 0, n = 0, cs = war.contested;
    for (var i = 0; i < cs.length; i++) { var r = W.regions[cs[i]]; if (r) { lon += num(r.lon, 0); lat += num(r.lat, 0); n++; } }
    if (!n) { var d = W.countries[war.defenderLeader]; var rr = d && W.regions[d.capital]; if (rr) { lon = num(rr.lon, 0); lat = num(rr.lat, 0); n = 1; } }
    return n ? [lon / n, lat / n] : [0, 0];
  }
  function gpCount(W, war) {
    var n = 0, all = war.attackers.concat(war.defenders);
    for (var i = 0; i < all.length; i++) { var c = W.countries[all[i]]; if (c && c.greatPower) n++; }
    return n;
  }
  function theW(war) { return /^World War/.test(war.name) ? war.name : 'the ' + war.name; }
  function capW(war) { var t = theW(war); return t.charAt(0).toUpperCase() + t.slice(1); }
  function uniqueName(W, base) {
    var S = ST_(W), k = (S.nameCount[base] || 0) + 1;
    S.nameCount[base] = k;
    return k === 1 ? base : (k < ORD.length ? ORD[k] + base : base + ' (' + k + ')');
  }
  function nameWar(W, war) {
    var a = W.countries[war.attackerLeader] || EMPTY, d = W.countries[war.defenderLeader] || EMPTY;
    var gp = gpCount(W, war);
    if (gp >= 4) {
      var conts = {}, nc = 0, all = war.attackers.concat(war.defenders);
      for (var i = 0; i < all.length; i++) {
        var c = W.countries[all[i]]; if (!c || !c.greatPower) continue;
        var r = W.regions[c.capital]; if (!r) continue;
        var k = continentOf(r.lon, r.lat); if (!conts[k]) { conts[k] = 1; nc++; }
      }
      if (nc >= 3) {
        var S = ST_(W); S.worldWars = (S.worldWars || 0) + 1;
        var n = 2 + S.worldWars;
        return 'World War ' + (n < ROMAN.length ? ROMAN[n] : n);
      }
    }
    if (gp >= 3) { var ll = frontLL(W, war); return uniqueName(W, 'Great ' + continentOf(ll[0], ll[1]) + ' War'); }
    var g = war.goal || EMPTY;
    if (g.type === 'claims' && g.regions && g.regions.length === 1) {
      var reg = W.regions[g.regions[0]];
      if (reg && reg.name && reg.name !== d.name) {
        if (reg.core >= 0 && !isAlive(W, reg.core)) return uniqueName(W, 'War of the ' + reg.name + ' Succession');
        return uniqueName(W, reg.name + ' War');
      }
    }
    return uniqueName(W, (a.name || '?') + '–' + (d.name || '?') + ' War');
  }

  // ------------------------------------------------------------------ alliance obligations
  // utility of ally `a` honoring its obligation to defend `d` against `att`
  function honorUtil(W, a, d, att) {
    var ca = W.countries[a], cd = W.countries[d], ct = W.countries[att];
    if (!ca || !ca.alive || !cd || !ct) return -9;
    if (ca.gov === 'anarchy') return -9;
    var u = 0.15 + 0.45 * c01(ca.credibility, 0.7) + rel(W, a, d) / 160 - M.max(0, rel(W, a, att)) / 120 - 0.9 * c01(ca.warExhaustion, 0);
    var reach = 1500 + 9000 * navyOf(ca);
    u -= 0.35 * clamp(distKm(W, a, d) / reach - 0.3, 0, 1.5);
    u += 0.12 * clamp(M.log((pw(ca) + 1) / (pw(ct) + 1)), -2, 2);
    if (nukesOf(ct) > 0) u -= nukesOf(ca) > 0 ? 0.1 : 0.25;
    u += 0.15 * (trait(ca, 'aggression', 0.4) - 0.5) - 0.15 * (trait(ca, 'caution', 0.5) - 0.5);
    if (ca.atWar) u -= 0.2;
    if (ca.civilWar) u -= 0.5;
    if (ca.overlord === d || cd.overlord === a) u += 0.7;
    if (GS.Diplo && GS.Diplo.allianceOf) {
      var A = GS.Diplo.allianceOf(W, ca, 'defense');
      if (A && A.members.indexOf(d) >= 0) u += (A.leader === a ? 0.35 : 0.25) * c01(A.cohesion, 0.5);
    }
    if (ca.defensePacts && ca.defensePacts.indexOf(d) >= 0) u += 0.15;
    return u;
  }
  function honorProb(W, a, d, att) { return sigmoid((honorUtil(W, a, d, att) - 0.35) * 8); }

  // ------------------------------------------------------------------ declaring war
  function normGoal(W, goal, a, d) {
    var g = (goal && typeof goal === 'object') ? { type: goal.type || 'conquest', regions: (goal.regions || []).slice() } : { type: goal || 'conquest', regions: [] };
    var cd = W.countries[d];
    if (!g.regions.length && cd && cd.regions) {
      if (g.type === 'claims') {
        var ca = W.countries[a], cl = (ca && ca.claims) || [];
        for (var i = 0; i < cl.length; i++) { var r = W.regions[cl[i]]; if (r && r.owner === d) g.regions.push(cl[i]); }
        if (!g.regions.length) g.type = 'conquest';
      }
      if (g.type === 'conquest') g.regions = borderRegions(W, a, d);
    }
    return g;
  }
  function borderRegions(W, a, d) {
    var cd = W.countries[d], out = [], regs = W.regions;
    if (!cd || !cd.regions) return out;
    for (var i = 0; i < cd.regions.length; i++) {
      var r = regs[cd.regions[i]]; if (!r || !r.neighbors) continue;
      for (var k = 0; k < r.neighbors.length; k++) { var nr = regs[r.neighbors[k]]; if (nr && nr.owner === a) { out.push(r.id); break; } }
    }
    if (!out.length || cd.regions.length <= 2) return cd.regions.slice();
    return out;
  }
  function joinSide(W, war, id, side, quiet) {
    var c = W.countries[id]; if (!c || !c.alive) return false;
    if (sideOf(war, id)) return false;
    (side === 1 ? war.attackers : war.defenders).push(id);
    if (!war.casualties[id]) war.casualties[id] = 0;
    c.atWar = true;
    // puppets follow their overlord
    var cs = W.countries;
    for (var i = 0; i < cs.length; i++) { var p = cs[i]; if (p && p.alive && p.overlord === id && !sideOf(war, i)) joinSide(W, war, i, side, true); }
    return true;
  }

  function declare(W, attacker, defender, goal, opts) {
    var S = ST_(W);
    var a = idOf(attacker), d = idOf(defender);
    var ca = cOf(W, a), cd = cOf(W, d);
    if (!ca || !cd || !ca.alive || !cd.alive || a === d) return null;
    opts = opts || EMPTY;
    var act = active(W);
    for (var i = 0; i < act.length; i++) {
      var w0 = act[i]; var s1 = sideOf(w0, a), s2 = sideOf(w0, d);
      if (s1 && s2 && s1 !== s2) return w0;
      if (s1 && s2 && s1 === s2) {
        // co-belligerents turning on each other: the attacker first leaves the common war (a side leader cannot)
        if (a === (s1 === 1 ? w0.attackerLeader : w0.defenderLeader)) return null;
        var lst = s1 === 1 ? w0.attackers : w0.defenders, ix = lst.indexOf(a);
        if (ix >= 0) lst.splice(ix, 1);
        S.dirty = true;
      }
    }
    var g = normGoal(W, goal, a, d);
    var war = {
      id: S.nextId++, name: '', attackers: [], defenders: [], attackerLeader: a, defenderLeader: d,
      start: W.tick | 0, goal: g, score: 0, casualties: {}, contested: [], ended: false, endTick: -1, outcome: null,
      winner: null, aid: [0, 0], aidBy: [[], []], captured: [], peakScore: 0
    };
    joinSide(W, war, a, 1, true);
    joinSide(W, war, d, 2, true);
    W.wars.push(war);
    S.dirty = true;
    computeContested(W, war);
    addRel(W, a, d, -40); addMem(W, a, d, -25);
    if (!opts.silent) news(W, ca.name + ' declares war on ' + cd.name + (g.type === 'claims' ? ', pressing its territorial claims' :
      (g.type === 'regime' ? ', seeking to topple its government' : (g.type === 'puppet' ? ', seeking to bring it under its control' : ''))) + '.',
      'war', [a, d], (ca.greatPower || cd.greatPower) ? 4 : 3);
    // defender's allies decide whether to honor their obligations
    var al = alliesOf(W, cd), aAllies = alliesOf(W, ca);
    for (i = 0; i < al.length; i++) {
      var x = al[i], cx = W.countries[x];
      if (x === a || sideOf(war, x) || !cx || !cx.alive) continue;
      if (aAllies.indexOf(x) >= 0) continue; // bound to both: stays out
      var p = opts.noAllies ? 0 : honorProb(W, x, d, a);
      if (cx.overlord === d || cd.overlord === x) p = M.max(p, 0.97);
      if (chance(W, p)) {
        joinSide(W, war, x, 2);
        cx.credibility = clamp(num(cx.credibility, 0.7) + 0.08, 0, 1);
        addRel(W, x, d, 10); addMem(W, x, d, 8); addRel(W, x, a, -30); addMem(W, x, a, -15);
        if (!opts.silent) news(W, cx.name + ' honors its commitments and enters the war on the side of ' + cd.name + '.', 'war', [x, d, a], cx.greatPower ? 4 : 2);
      } else if (!opts.initial) {
        cx.credibility = clamp(num(cx.credibility, 0.7) - 0.25, 0, 1);
        addRel(W, x, d, -25); addMem(W, x, d, -15);
        if (GS.Diplo && GS.Diplo.allianceOf) { var A = GS.Diplo.allianceOf(W, cx, 'defense'); if (A && A.members.indexOf(d) >= 0) A.cohesion = clamp(num(A.cohesion, 0.5) - 0.12 * clamp(pw(cx) / (pw(cd) + 1), 0.15, 1), 0, 1); }
        if (!opts.silent && (cx.greatPower || pw(cx) > 0.3 * pw(cd))) news(W, cx.name + ' refuses to come to the aid of its ally ' + cd.name + '.', 'war', [x, d], cx.greatPower ? 4 : 2);
      }
    }
    // attacker's allies: may join opportunistically if they too hate the target
    for (i = 0; i < aAllies.length; i++) {
      var y = aAllies[i], cy = W.countries[y];
      if (!cy || !cy.alive || sideOf(war, y) || cy.gov === 'anarchy') continue;
      var py = cy.overlord === a ? 0.97 : (rel(W, y, d) < -50 && rel(W, y, a) > 50 ? 0.3 * trait(cy, 'aggression', 0.4) * (1 - c01(cy.warExhaustion, 0)) : 0);
      if (!opts.noAllies && chance(W, py)) {
        joinSide(W, war, y, 1);
        addRel(W, y, d, -30);
        if (!opts.silent && cy.overlord !== a) news(W, cy.name + ' joins ' + ca.name + ' in its war against ' + cd.name + '.', 'war', [y, a, d], cy.greatPower ? 4 : 2);
      }
    }
    war.name = nameWar(W, war);
    recomputeAtWar(W);
    if (GS.Economy && GS.Economy.addFear) GS.Economy.addFear(W, gpCount(W, war) >= 2 ? 0.2 : (gpCount(W, war) ? 0.06 : 0.02));
    // cap history
    if (W.wars.length > 200) {
      for (i = 0; i < W.wars.length && W.wars.length > 200; i++) if (W.wars[i].ended) { W.wars.splice(i, 1); i--; }
    }
    S.dirty = true;
    return war;
  }

  // ------------------------------------------------------------------ contested regions
  function computeContested(W, war) {
    var regs = W.regions, out = [], cs = W.countries, i, k, q;
    var sides = [war.attackers, war.defenders];
    for (var s = 0; s < 2; s++) {
      var mine = sides[s], other = sides[1 - s];
      for (i = 0; i < mine.length; i++) {
        var c = cs[mine[i]]; if (!c || !c.regions) continue;
        for (k = 0; k < c.regions.length; k++) {
          var r = regs[c.regions[k]]; if (!r || !r.neighbors) continue;
          for (q = 0; q < r.neighbors.length; q++) {
            var nr = regs[r.neighbors[q]];
            if (nr && nr.owner >= 0 && other.indexOf(nr.owner) >= 0) {
              if (out.indexOf(r.id) < 0) out.push(r.id);
              if (out.indexOf(nr.id) < 0) out.push(nr.id);
            }
          }
        }
      }
    }
    if (!out.length) { // no land contact: amphibious front at the goal/defender capital
      var g = war.goal && war.goal.regions || [];
      for (i = 0; i < g.length && out.length < 3; i++) { var gr = regs[g[i]]; if (gr && war.defenders.indexOf(gr.owner) >= 0) out.push(g[i]); }
      if (!out.length) { var d = cs[war.defenderLeader]; if (d && d.alive && d.capital >= 0) out.push(d.capital); }
    }
    if (out.length > 14) out.length = 14;
    war.contested = out;
  }

  function sideStrength(W, war, side, ll) {
    var list = side === 1 ? war.attackers : war.defenders, leader = side === 1 ? war.attackerLeader : war.defenderLeader;
    var sum = 0, cs = W.countries, cont = war.contested;
    for (var i = 0; i < list.length; i++) {
      var c = cs[list[i]]; if (!c || !c.alive) continue;
      var p = pw(c); if (!(p > 0)) continue;
      var front = false;
      for (var k = 0; k < cont.length; k++) { var r = W.regions[cont[k]]; if (r && r.owner === c.id) { front = true; break; } }
      var log = 1;
      if (!front) log = clamp(M.exp(-kmTo(W, c, ll[0], ll[1]) / (2000 + 9000 * navyOf(c))), 0.08, 1);
      var commit = list[i] === leader ? 1 : (c.overlord >= 0 ? 0.7 : 0.55);
      sum += p * log * commit;
    }
    return sum;
  }

  // foreign aid from sympathetic non-belligerents (monthly)
  function computeAid(W, war) {
    var cs = W.countries, A = war.attackerLeader, D = war.defenderLeader, ag = 0, dg = 0;
    var ab = [], db = [];
    for (var i = 0; i < cs.length; i++) {
      var o = cs[i]; if (!o || !o.alive || sideOf(war, i) || o.gov === 'anarchy') continue;
      var ra = rel(W, i, A), rd = rel(W, i, D), p = pw(o) * (1 - c01(o.warExhaustion, 0));
      if (rd > 25 && ra < -20) { var x = p * 0.12 * clamp((rd - 25) / 60, 0, 1) * clamp((-ra - 20) / 50, 0.2, 1); dg += x; if (x > 2) db.push(i); }
      else if (ra > 25 && rd < -20) { var y = p * 0.12 * clamp((ra - 25) / 60, 0, 1) * clamp((-rd - 20) / 50, 0.2, 1); ag += y; if (y > 2) ab.push(i); }
    }
    war.aid[0] = ag; war.aid[1] = dg;
    war.aidBy[0] = ab.slice(0, 8); war.aidBy[1] = db.slice(0, 8);
  }

  // ------------------------------------------------------------------ weekly resolution
  function cleanSides(W, war) {
    var i;
    for (i = war.attackers.length - 1; i >= 0; i--) if (!isAlive(W, war.attackers[i])) war.attackers.splice(i, 1);
    for (i = war.defenders.length - 1; i >= 0; i--) if (!isAlive(W, war.defenders[i])) war.defenders.splice(i, 1);
  }
  function endIfBroken(W, war) {
    if (war.ended) return true;
    cleanSides(W, war);
    if (!war.attackers.length || !war.defenders.length) {
      var winner = war.attackers.length ? 1 : (war.defenders.length ? 2 : 0);
      finish(W, war, 'conquest', winner, true);
      return true;
    }
    if (!isAlive(W, war.attackerLeader) || war.attackers.indexOf(war.attackerLeader) < 0) { finish(W, war, 'ceasefire', 2, false); return true; }
    if (!isAlive(W, war.defenderLeader) || war.defenders.indexOf(war.defenderLeader) < 0) { finish(W, war, 'ceasefire', 1, false); return true; }
    return false;
  }

  function resolveWar(W, war) {
    if (endIfBroken(W, war)) return;
    var tick = W.tick | 0, cs = W.countries, i;
    if (((tick + war.id) & 3) === 0 || !war.contested.length) { computeContested(W, war); computeAid(W, war); }
    var ll = frontLL(W, war);
    var A = sideStrength(W, war, 1, ll), D = sideStrength(W, war, 2, ll);
    A += M.min(war.aid[0], 0.8 * A + 5); D += M.min(war.aid[1], 0.8 * D + 5);
    D *= 1.2; // defender's advantage
    var ratio = (A + 1e-6) / (A + D + 2e-6);
    var target = clamp((ratio - 0.5) * 300, -100, 100);
    war.score = clamp(num(war.score, 0) + (target - war.score) * 0.03 + gauss(W) * 2.5, -100, 100);
    if (M.abs(war.score) > M.abs(war.peakScore)) war.peakScore = war.score;
    var intensity = 0.6 + 0.8 * M.min(A, D) / M.max(1e-6, M.max(A, D));
    var lan = [clamp(M.sqrt((D + 1e-6) / (A + 1e-6)), 0.25, 1.6), clamp(M.sqrt((A + 1e-6) / (D + 1e-6)), 0.25, 1.6)];
    var g = W.global || (W.global = {});
    // casualties & attrition
    var P = GS.People, sides = [war.attackers, war.defenders], weekMil = [0, 0, 0];
    for (var s = 0; s < 2; s++) {
      var list = sides[s], leader = s === 0 ? war.attackerLeader : war.defenderLeader;
      var losing = s === 0 ? war.score < 0 : war.score > 0, sc = M.abs(war.score) / 100;
      for (i = 0; i < list.length; i++) {
        var c = cs[list[i]]; if (!c || !c.alive) continue;
        var main = list[i] === leader;
        var frac = 0.0003 * intensity * lan[s] * (main ? 1 : 0.45) * (losing ? 1 + sc : 1 - 0.4 * sc);
        var killed = 0;
        if (P && P.kill) killed = num(P.kill(W, { country: c.id, fraction: frac, cause: 'war', jobs: [MILITARY] }), 0);
        war.casualties[c.id] = num(war.casualties[c.id], 0) + killed;
        weekMil[s + 1] += killed;
        g.warDeaths = num(g.warDeaths, 0) + killed;
        c.manpower = M.max(0, num(c.manpower, 0) - killed);
        c.milStock = M.max(0, num(c.milStock, 0) * (1 - 0.003 * intensity * (main ? 1 : 0.5) * (losing ? 1 + sc : 1)));
        c.warExhaustion = c01(num(c.warExhaustion, 0) + (main ? 0.0016 : 0.0009) * intensity * (losing ? 1 + 1.5 * sc : 0.8), 0);
      }
    }
    // civilians & devastation in contested regions (regions can be whole countries: scale by the fighting, not by area)
    var cont = war.contested, nCont = M.min(cont.length, 6);
    for (i = 0; i < nCont; i++) {
      var r = W.regions[cont[i]]; if (!r || r.owner < 0) continue;
      var dev = c01(r.devastation, 0), os = sideOf(war, r.owner);
      var ownerLosing = (os === 1 && war.score < 0) || (os === 2 && war.score > 0);
      var kc = 0, want = (weekMil[os] || 0) * 0.2 * (1 + 2 * dev) * (ownerLosing ? 1.5 : 0.5) / nCont;
      if (want > 0 && P && P.kill) kc = num(P.kill(W, { region: r.id, count: want, cause: 'civilian' }), 0);
      if (kc > 0) { war.casualties[r.owner] = num(war.casualties[r.owner], 0) + kc; g.warDeaths = num(g.warDeaths, 0) + kc; }
      // a front touches only part of a large region (e.g. all of Russia is one region): scale by size
      if (os) r.devastation = M.min(1, dev + 0.004 * intensity * (ownerLosing ? 1 : 0.3) / M.max(1, M.sqrt(nCont / 2)) * areaF(W, r));
    }
    // captures
    if (war.score > 25) tryCapture(W, war, 1, (war.score - 25) / 75);
    else if (war.score < -25) tryCapture(W, war, 2, (-war.score - 25) / 75);
    if (war.ended || endIfBroken(W, war)) return;
    // nuclear desperation
    nuclearCheck(W, war);
    if (war.ended || endIfBroken(W, war)) return;
    peaceCheck(W, war);
  }

  function tryCapture(W, war, side, strength) {
    var regs = W.regions, cont = war.contested, cs = W.countries;
    var winners = side === 1 ? war.attackers : war.defenders, losers = side === 1 ? war.defenders : war.attackers;
    var cand = [], wts = [], i, k;
    for (i = 0; i < cont.length; i++) {
      var r = regs[cont[i]]; if (!r || losers.indexOf(r.owner) < 0) continue;
      var adj = -1, bp = -1;
      for (k = 0; k < r.neighbors.length; k++) {
        var nr = regs[r.neighbors[k]];
        if (nr && winners.indexOf(nr.owner) >= 0) { var pp = pw(cs[nr.owner]); if (pp > bp) { bp = pp; adj = nr.owner; } }
      }
      var owner = cs[r.owner];
      var isCap = owner && owner.capital === r.id;
      var last = !owner || !owner.regions || owner.regions.length <= 1;
      if (last && strength < 0.47) continue; // taking a state's final region (total conquest) needs a decisive edge (score > 60)
      var w = (last ? 0.4 : 1) * (adj >= 0 ? 1 : 0.3) * (isCap ? 0.3 : 1) * (winners.indexOf(r.core) >= 0 ? 2 : 1) * (war.goal.regions.indexOf(r.id) >= 0 ? 1.3 : 1);
      cand.push([r.id, adj >= 0 ? adj : (side === 1 ? war.attackerLeader : war.defenderLeader), isCap]); wts.push(w);
    }
    if (!cand.length) return;
    var tot = 0; for (i = 0; i < wts.length; i++) tot += wts[i];
    var x = rnd(W) * tot, pick = 0;
    for (i = 0; i < wts.length; i++) { x -= wts[i]; if (x <= 0) { pick = i; break; } }
    var p = 0.04 * strength * wts[pick];
    if (!chance(W, p)) return;
    var rid = cand[pick][0], to = cand[pick][1], wasCap = cand[pick][2];
    var reg = regs[rid], from = reg.owner, fc = cs[from], tc = cs[to];
    if (!tc || !tc.alive || !GS.World || !GS.World.setRegionOwner) return;
    var fname = fc ? fc.name : '?', lastRegion = fc && fc.regions && fc.regions.length <= 1;
    if (war.captured.indexOf(rid) < 0) war.captured.push(rid);
    GS.World.setRegionOwner(W, rid, to, 'conquest');
    war.score = clamp(war.score + (side === 1 ? 4 : -4), -100, 100);
    if (lastRegion) news(W, tc.name + ' completes the conquest of ' + fname + '.', 'war', [to, from], 5);
    else if (wasCap) news(W, tc.name + ' captures the capital of ' + fname + (fc && String(reg.key) === String(fc.key) ? '' : ' (' + reg.name + ')') + '.', 'war', [to, from], 4);
    else news(W, tc.name + ' seizes ' + (fc && String(reg.key) === String(fc.key) ? 'the heartland of ' + fname : reg.name + ' from ' + fname) + '.', 'war', [to, from], (tc.greatPower || (fc && fc.greatPower)) ? 3 : 2);
    if (!war.ended) computeContested(W, war);
  }

  function peaceCheck(W, war) {
    var cs = W.countries, a = cs[war.attackerLeader], d = cs[war.defenderLeader];
    var ea = c01(a.warExhaustion, 0), ed = c01(d.warExhaustion, 0), sc = war.score;
    var dur = (W.tick | 0) - war.start;
    if (sc >= 70 && chance(W, 0.12 + 0.3 * ed)) return finish(W, war, null, 1, false);
    if (sc <= -70 && chance(W, 0.12 + 0.3 * ea)) return finish(W, war, null, 2, false);
    if (ed > 0.8 && sc > 20 && chance(W, 0.08)) return finish(W, war, null, 1, false);
    if (ea > 0.8 && sc < -20 && chance(W, 0.08)) return finish(W, war, null, 2, false);
    var both = M.min(ea, ed);
    if (both > 0.45 && chance(W, 0.015 + 0.15 * (both - 0.45))) return finish(W, war, M.abs(sc) < 20 ? 'white' : 'ceasefire', sc >= 0 ? 1 : 2, false);
    if (dur > 156 && M.abs(sc) < 30 && chance(W, 0.008 + 0.01 * (ea + ed))) return finish(W, war, M.abs(sc) < 15 ? 'white' : 'ceasefire', sc >= 0 ? 1 : 2, false);
  }

  // outcome type decided from goal & winner unless forced
  function finish(W, war, forced, winnerSide, silentOutcome) {
    if (war.ended) return;
    var cs = W.countries, S = ST_(W);
    var winL = winnerSide === 1 ? war.attackerLeader : war.defenderLeader;
    var loseL = winnerSide === 1 ? war.defenderLeader : war.attackerLeader;
    var winners = (winnerSide === 1 ? war.attackers : war.defenders).slice();
    var losers = (winnerSide === 1 ? war.defenders : war.attackers).slice();
    var wc = cs[winL], lc = cs[loseL];
    var type = forced;
    if (!type) {
      var g = war.goal || EMPTY;
      if (winnerSide === 1) {
        type = g.type === 'regime' ? 'regime' : (g.type === 'puppet' ? 'puppet' : 'annex');
        // annexing every remaining region of the loser needs a crushing victory; otherwise it is subordinated
        if (type === 'annex' && lc && lc.alive && lc.regions && lc.regions.length && war.score < 90) {
          var allIn = true;
          for (var q = 0; q < lc.regions.length; q++) if ((g.regions || []).indexOf(lc.regions[q]) < 0) { allIn = false; break; }
          if (allIn) type = lc.overlord >= 0 ? 'regime' : 'puppet';
        }
      }
      else type = war.captured.some(function (r) { var rg = W.regions[r]; return rg && winners.indexOf(rg.owner) >= 0 && losers.indexOf(rg.core) >= 0; }) ? 'annex' : 'white';
      if (type === 'puppet' && lc && lc.overlord >= 0) type = 'regime';
    }
    war.ended = true; war.endTick = W.tick | 0; war.outcome = type; war.winner = winnerSide === 1 ? 'attackers' : (winnerSide === 2 ? 'defenders' : null);
    S.dirty = true;
    var wAlive = wc && wc.alive && wc.id !== S.removing, lAlive = lc && lc.alive && lc.id !== S.removing, setOwner = GS.World && GS.World.setRegionOwner;
    var i, regs = W.regions, txt = '';
    if (type === 'conquest') {
      var held = 0;
      for (i = 0; i < regs.length; i++) if (regs[i] && regs[i].core === loseL && winners.indexOf(regs[i].owner) >= 0) held++;
      txt = held ? (wAlive ? wc.name : 'The victors') + ' emerge' + (wAlive ? 's' : '') + ' victorious as ' + (lc ? lc.name : 'the enemy') + ' ceases to exist; ' + theW(war) + ' ends.'
        : capW(war) + ' ends as ' + (lc ? lc.name : 'one side') + ' vanishes.';
    } else if (type === 'white') {
      // return captured land to its pre-war owners
      for (i = 0; i < war.captured.length; i++) {
        var rg = regs[war.captured[i]];
        if (rg && rg.core >= 0 && isAlive(W, rg.core) && rg.owner !== rg.core && sideOf(war, rg.core) && sideOf(war, rg.owner) !== sideOf(war, rg.core) && setOwner) {
          GS.World.setRegionOwner(W, rg.id, rg.core, 'treaty');
        }
      }
      txt = capW(war) + ' ends in a white peace' + (lAlive && wAlive ? ' between ' + cs[war.attackerLeader].name + ' and ' + cs[war.defenderLeader].name : '') + '.';
    } else if (type === 'ceasefire') {
      txt = 'A ceasefire ends the fighting in ' + theW(war) + '; current lines are frozen.';
    } else if (type === 'annex') {
      var taken = 0;
      if (wAlive && setOwner) {
        var want = winnerSide === 1 ? (war.goal.regions || []) : [];
        for (i = 0; i < want.length; i++) {
          var r2 = regs[want[i]];
          if (r2 && losers.indexOf(r2.owner) >= 0 && isAlive(W, r2.owner)) { GS.World.setRegionOwner(W, r2.id, winL, 'treaty'); taken++; }
        }
      }
      for (i = 0; i < war.captured.length; i++) { var r3 = regs[war.captured[i]]; if (r3 && winners.indexOf(r3.owner) >= 0) taken++; }
      txt = (wAlive ? wc.name : 'The victors') + ' wins ' + theW(war) + (taken ? ' and annexes ' + taken + ' region' + (taken > 1 ? 's' : '') : '') + (lAlive ? ' from ' + lc.name : '') + '.';
    } else if (type === 'puppet') {
      if (lAlive && wAlive) {
        lc.overlord = winL; lc.patron = winL;
        if (GS.Diplo) {
          var al = (lc.alliances || []).slice();
          for (i = 0; i < al.length; i++) { var A = W.alliances[al[i]]; if (A && A.type === 'defense') GS.Diplo.leave(W, A.id, lc, 'puppet'); }
          var dp = (lc.defensePacts || []).slice();
          for (i = 0; i < dp.length; i++) if (GS.Diplo.removePact) GS.Diplo.removePact(W, lc.id, dp[i]);
        }
        if (GS.Politics && GS.Politics.changeLeader) GS.Politics.changeLeader(W, lc, 'puppet');
        addRel(W, winL, loseL, 30);
      }
      txt = (wAlive ? wc.name : 'The victors') + ' wins ' + theW(war) + (lAlive ? ' and reduces ' + lc.name + ' to a client state' : '') + '.';
    } else if (type === 'regime') {
      if (lAlive && wAlive && GS.Politics) {
        var WL = L_(wc), ng = wc.gov === 'anarchy' ? 'hybrid' : wc.gov;
        if (GS.Politics.changeGov) GS.Politics.changeGov(W, lc, ng, 'regime change', WL ? { ideology: { econ: num(WL.econ, 0), auth: num(WL.auth, 0), nat: num(WL.nat, 0.5) } } : undefined);
        else if (GS.Politics.changeLeader) GS.Politics.changeLeader(W, lc, 'regime change');
        addRel(W, winL, loseL, 35);
      }
      txt = (wAlive ? wc.name : 'The victors') + ' wins ' + theW(war) + (lAlive ? ' and imposes a new government on ' + lc.name : '') + '.';
    }
    // aftermath: truces, grudges, revanchist claims, leader fallout
    var all = winners.concat(losers);
    for (i = 0; i < winners.length; i++) for (var k = 0; k < losers.length; k++) {
      S.truce.set(pk(winners[i], losers[k]), (W.tick | 0) + 260);
      if (type !== 'regime' && type !== 'puppet') addMem(W, winners[i], losers[k], -10);
    }
    if (lAlive && (type === 'annex' || type === 'ceasefire')) {
      var nat = c01(lid(lc, 'nat', 0.5), 0.5);
      for (i = 0; i < regs.length; i++) {
        var rr = regs[i];
        if (rr && rr.core === loseL && rr.owner !== loseL && rr.owner >= 0 && lc.claims && lc.claims.indexOf(i) < 0 && rnd(W) < 0.3 + 0.7 * nat) lc.claims.push(i);
      }
    }
    if (lAlive && type !== 'regime' && type !== 'puppet' && type !== 'conquest' && winnerSide && GS.Politics && GS.Politics.changeLeader &&
        M.abs(war.score) > 40 && chance(W, 0.35)) GS.Politics.changeLeader(W, lc, 'war defeat');
    refreshActive(W);
    recomputeAtWar(W);
    if (!silentOutcome || type === 'conquest') {
      var imp = 0; for (i = 0; i < all.length; i++) if (cs[all[i]] && cs[all[i]].greatPower) imp++;
      news(W, txt, 'war', all.slice(0, 8), imp ? 4 : 3);
    }
  }

  function makePeace(W, war, outcome) {
    if (!war || war.ended) return;
    var type = null, side = 0;
    if (outcome && typeof outcome === 'object') { type = outcome.type || null; side = outcome.winner === 'attackers' ? 1 : (outcome.winner === 'defenders' ? 2 : 0); }
    else type = outcome || null;
    if (!side) side = num(war.score, 0) >= 0 ? 1 : 2;
    if (!type) type = M.abs(num(war.score, 0)) < 20 ? 'white' : null;
    finish(W, war, type, side, false);
  }

  // ------------------------------------------------------------------ nuclear weapons
  function nuke(W, attacker, regionId, opts) {
    opts = opts || EMPTY;
    var reg = W.regions && W.regions[regionId]; if (!reg) return 0;
    var a = idOf(attacker), ca = a >= 0 ? cOf(W, a) : null;
    var owner = reg.owner, oc = owner >= 0 ? W.countries[owner] : null;
    var frac = clamp(num(opts.fraction, 0.3), 0, 1);
    var killed = 0;
    if (GS.People && GS.People.kill) killed = num(GS.People.kill(W, { region: reg.id, fraction: frac, cause: 'nuclear' }), 0);
    reg.devastation = 1;
    var g = W.global || (W.global = {});
    g.nukesUsed = num(g.nukesUsed, 0) + 1;
    g.fear = M.max(num(g.fear, 0), 0.97);
    if (GS.Economy && GS.Economy.addFear) GS.Economy.addFear(W, 1);
    if (oc && oc.alive) {
      if (GS.Economy && GS.Economy.destroyCapital) GS.Economy.destroyCapital(W, oc, oc.regions && oc.regions.length ? clamp(0.6 / oc.regions.length, 0.1, 0.4) : 0.3);
      if (oc.capital === reg.id) oc.milStock = num(oc.milStock, 0) * 0.7;
      oc.warExhaustion = c01(num(oc.warExhaustion, 0) + 0.3, 0);
    }
    if (ca) {
      g.warDeaths = num(g.warDeaths, 0) + killed;
      if (typeof ca.nukes === 'number') ca.nukes = M.max(0, ca.nukes - 1);
      else ca.nukes = M.max(0, nukesOf(ca) - 1);
      var cs = W.countries, NC = W.NC | 0, myAl = opts.retaliation ? alliesOf(W, ca) : null;
      for (var i = 0; i < cs.length; i++) {
        if (i === a || !cs[i] || !cs[i].alive || !W.rel || i >= NC || a >= NC) continue;
        if (opts.retaliation) { // a second strike is condemned, but far less than a first use
          if (myAl.indexOf(i) < 0 && i !== owner) { addRel(W, a, i, -25); addMem(W, a, i, -10); }
          continue;
        }
        W.rel[a * NC + i] = -100; W.rel[i * NC + a] = -100;
        addMem(W, a, i, -60);
      }
      // war accounting
      var ws = warsOf(W, a);
      for (var k = 0; k < ws.length; k++) if (owner >= 0 && sideOf(ws[k], owner)) ws[k].casualties[owner] = num(ws[k].casualties[owner], 0) + killed;
    }
    var who = ca ? ca.name : 'An unknown power';
    news(W, '☢ ' + who + ' detonates a nuclear weapon over ' + (oc && String(reg.key) === String(oc.key) ? oc.name : reg.name + (oc ? ' (' + oc.name + ')' : '')) + '. ' +
      (GS.U && GS.U.fmtNum ? GS.U.fmtNum(killed) : M.round(killed)) + ' killed.', 'war', ca && oc ? [a, owner] : (oc ? [owner] : []), 5);
    // second strike: generic retaliation logic
    if (ca && ca.alive && oc && oc.alive && owner !== a && !opts.retaliation) {
      var cand = [owner].concat(alliesOf(W, oc)), ar = W.regions[ca.capital];
      for (var j = 0; j < cand.length && ar; j++) {
        var r = W.countries[cand[j]]; if (!r || !r.alive || nukesOf(r) <= 0 || cand[j] === a) continue;
        var p = cand[j] === owner ? 0.8 * (1 - 0.5 * trait(r, 'caution', 0.5)) : 0.3 * honorProb(W, cand[j], owner, a);
        if (chance(W, p)) { nuke(W, cand[j], ca.capital, { retaliation: true, fraction: frac }); break; }
      }
    }
    return killed;
  }

  function nuclearCheck(W, war) {
    var sc = war.score, side = sc <= -75 ? 1 : (sc >= 75 ? 2 : 0);
    if (!side) return;
    var me = side === 1 ? war.attackerLeader : war.defenderLeader, foe = side === 1 ? war.defenderLeader : war.attackerLeader;
    var c = W.countries[me], f = W.countries[foe];
    if (!c || !c.alive || !f || !f.alive || nukesOf(c) <= 0) return;
    var capThreat = war.contested.indexOf(c.capital) >= 0;
    var coreLost = false, regs = W.regions;
    for (var i = 0; i < war.captured.length; i++) { var r = regs[war.captured[i]]; if (r && r.core === me && r.owner !== me) { coreLost = true; break; } }
    if (!capThreat && !coreLost) return;
    var aggr = trait(c, 'aggression', 0.4), caut = trait(c, 'caution', 0.5);
    if (aggr < 0.7 || caut > 0.3) return;
    var p = 0.01 * (aggr - 0.6) * 4 * (0.3 - caut) / 0.3 * (capThreat ? 1.5 : 1) * (nukesOf(f) > 0 ? 0.4 : 1);
    if (!chance(W, p)) return;
    // strike the enemy's front-line region or its capital
    var target = -1;
    for (i = 0; i < war.contested.length; i++) { var cr = regs[war.contested[i]]; if (cr && cr.owner === foe) { target = cr.id; break; } }
    if (target < 0) target = f.capital;
    if (target >= 0) {
      nuke(W, me, target);
      if (!war.ended) war.score = clamp(war.score + (side === 1 ? 35 : -35), -100, 100);
    }
  }

  // size factor for damage spread over a region: 1 for a median-sized region, ~0.15 for continental ones
  function areaF(W, r) {
    var S = ST_(W);
    if (!(S.refArea > 0)) {
      var a = [], R = W.regions;
      for (var i = 0; i < R.length; i++) if (R[i] && R[i].area > 0) a.push(R[i].area);
      a.sort(function (x, y) { return x - y; });
      S.refArea = a.length ? a[(a.length * 0.6) | 0] : 1;
    }
    return r && r.area > 0 ? clamp(M.sqrt(S.refArea / r.area), 0.15, 1) : 1;
  }

  // ------------------------------------------------------------------ war AI
  var _cand = [];
  function warAI(W, c) {
    if (!c || !c.alive || c.gov === 'anarchy' || c.overlord >= 0) return;
    if (c.civilWar && num(c.civilWar.rebelStrength, 0) > 0.3 * num(c.civilWar.govStrength, 1)) return;
    var L = L_(c); if (!L) return;
    var id = c.id, cs = W.countries, n = cs.length, i;
    var myWars = warsOf(W, id);
    if (myWars.length >= 2) return;
    var aggr = c01(L.aggression, 0.4), amb = c01(L.ambition, 0.5), caut = c01(L.caution, 0.5);
    var exh = c01(c.warExhaustion, 0);
    if (exh > 0.6) return;
    var myP = pw(c); if (!(myP > 0.5)) return;
    // candidates
    var cand = _cand; cand.length = 0;
    var nb = neighborsOf(W, c);
    for (i = 0; i < nb.length; i++) if (rel(W, id, nb[i]) < 25 && cand.indexOf(nb[i]) < 0) cand.push(nb[i]);
    var cl = c.claims || [];
    for (i = 0; i < cl.length; i++) { var cr = W.regions[cl[i]]; if (cr && cr.owner >= 0 && cr.owner !== id && cand.indexOf(cr.owner) < 0) cand.push(cr.owner); }
    var nv = navyOf(c);
    if (nv > 0.25) {
      var reach = 1500 + 8000 * nv;
      for (i = 0; i < n; i++) {
        if (i === id || rel(W, id, i) >= -20 || distKm(W, id, i) >= reach) continue;
        if (cand.indexOf(i) >= 0 || !isAlive(W, i)) continue;
        cand.push(i);
      }
    }
    if (!cand.length) return;
    var myAllies = alliesOf(W, c);
    var unrest = c01(c.unrest, 0.2), free = c.gov === 'democracy' ? 1 : (c.gov === 'flawed_democracy' ? 0.8 : 0);
    var gdpC = M.max(1, gdpOf(c));
    var best = -1e9, bt = -1, bGoal = null;
    for (var ci = 0; ci < cand.length; ci++) {
      var t = cand[ci], ct = cs[t];
      if (!ct || !ct.alive || t === id) continue;
      if (ct.overlord === id || c.overlord === t) continue;
      if (myAllies.indexOf(t) >= 0) continue;
      if (truceActive(W, id, t) || isAtWar(W, id, t)) continue;
      var r = rel(W, id, t);
      if (r > 30) continue;
      var isNb = nb.indexOf(t) >= 0;
      var d = distKm(W, id, t);
      var proj = isNb ? 1 : clamp(nv * 1.3, 0.05, 1) * M.exp(-d / 9000);
      // expected allied help on my side (only those who also dislike the target)
      var myExp = 0, k;
      for (k = 0; k < myAllies.length; k++) {
        var x = cs[myAllies[k]]; if (!x || !x.alive) continue;
        if (rel(W, myAllies[k], t) < -30) myExp += 0.25 * c01(x.credibility, 0.7) * pw(x) * clamp(M.exp(-distKm(W, myAllies[k], t) / (2000 + 9000 * navyOf(x))), 0.08, 1);
      }
      // expected help for the target: each ally weighted by its honor probability, distance and power
      // a state in anarchy or civil war has shaky command over its arsenal: deterrence is less credible
      var cmd = ct.gov === 'anarchy' ? 0.3 : (ct.civilWar ? 0.6 : 1);
      var tAl = alliesOf(W, ct), tExp = 0, nukeDeter = nukesOf(ct) > 0 ? 3.2 * cmd : 0;
      for (k = 0; k < tAl.length; k++) {
        var y = tAl[k]; if (y === id) continue;
        var cy = cs[y]; if (!cy || !cy.alive) continue;
        if (myAllies.indexOf(y) >= 0) continue;
        var hp = honorProb(W, y, t, id);
        tExp += hp * pw(cy) * clamp(M.exp(-distKm(W, y, t) / (2000 + 9000 * navyOf(cy))), 0.08, 1) * 0.6;
        if (nukesOf(cy) > 0) nukeDeter = M.max(nukeDeter, 2.6 * hp);
      }
      var myEff = (myP * proj + myExp) * (1 + 0.3 * (aggr - 0.5));
      var tEff = pw(ct) * 1.25 + tExp + 1;
      var ratio = myEff / tEff;
      var pWin = sigmoid(2.2 * M.log(M.max(1e-6, ratio)) - 0.8);
      // gains
      var claimed = 0, regs = W.regions;
      for (k = 0; k < cl.length; k++) { var rr = regs[cl[k]]; if (rr && rr.owner === t) claimed++; }
      var nat = c01(num(L.nat, 0.5), 0.5);
      var gain = (claimed ? 0.5 + 0.5 * nat : 0) +
        0.25 * clamp(gdpOf(ct) / gdpC, 0, 2) * (0.5 + amb) * (isNb ? 1 : 0.4) +
        0.12 * (c01(dataNum(ct, 'oil', 0), 0) + c01(dataNum(ct, 'minerals', 0), 0)) +
        0.5 * clamp(-r / 100, 0, 1) +
        0.12 * (M.abs(num(L.econ, 0) - lid(ct, 'econ', 0)) + M.abs(num(L.auth, 0) - lid(ct, 'auth', 0))) * clamp(-r / 60, 0, 1) +
        0.45 * unrest * (1 - caut) * (free ? 0.5 : 1) +
        (ct.gov === 'anarchy' ? 0.6 : 0) + (ct.civilWar ? 0.35 : 0) +
        (num(ct.milStock, 1) < 0.5 * estMilStock(ct) ? 0.2 : 0) +                       // its army has collapsed
        (num(ct.createdTick, 0) > 0 && num(ct.createdTick, 0) > (W.tick | 0) - 156 ? 0.25 : 0); // a fragile new state
      // costs
      var gpFriends = 0, GPL = ST_(W).gpList || [];
      for (k = 0; k < GPL.length; k++) { var gk = GPL[k]; if (gk !== id && gk !== t && rel(W, gk, t) > 30) gpFriends++; }
      var G = W.global || EMPTY;
      var cost = 0.6 + 0.4 * M.max(0, num(G.fear, 0.1) - 0.25) - (ct.gov === 'anarchy' ? 0.2 : 0) +
        2.5 * dependence(W, id, t) +
        0.06 * gpFriends +
        nukeDeter +
        1.6 * exh + 0.9 * myWars.length + (c.civilWar ? 0.8 : 0) +
        0.5 * free + (free && (ct.gov === 'democracy' || ct.gov === 'flawed_democracy') ? 1.0 : 0) +
        (1 - pWin) * (0.8 + 0.4 * (1 - c01(c.stability, 0.5)));
      cost *= (0.7 + 0.6 * caut);
      var ev = pWin * gain * (0.6 + 0.8 * amb) - cost;
      if (ev > best) {
        best = ev; bt = t;
        var gt;
        if (claimed) gt = 'claims';
        else if (ratio > 3 && (ct.regions || []).length <= 2 && amb > 0.6) gt = 'conquest';
        else if (ratio > 2.2 && r < -40) gt = 'puppet';
        else if (r < -60 && clamp((M.abs(num(L.auth, 0) - lid(ct, 'auth', 0))), 0, 2) > 0.8) gt = 'regime';
        else gt = isNb ? 'conquest' : 'puppet';
        bGoal = gt;
      }
    }
    if (bt < 0) return;
    var thr = 0.15 - 0.35 * (aggr - 0.5);
    if (W._warDebug) W._warDebug.push({ tick: W.tick, a: id, t: bt, ev: best, thr: thr, goal: bGoal });
    if (best > thr && chance(W, clamp((best - thr) * 0.6, 0, 0.5))) declare(W, id, bt, bGoal);
  }

  // puppets follow overlords; join wars their overlord is in
  function puppetsFollow(W) {
    var cs = W.countries, act = active(W);
    if (!act.length) return;
    for (var i = 0; i < cs.length; i++) {
      var p = cs[i]; if (!p || !p.alive || p.overlord < 0) continue;
      for (var k = 0; k < act.length; k++) {
        var w = act[k], s = sideOf(w, p.overlord);
        if (s && !sideOf(w, i)) { joinSide(W, w, i, s, true); p.atWar = true; }
      }
    }
  }

  // ------------------------------------------------------------------ init / step
  function init(W) {
    var S = ST_(W), cs = W.countries, D = GS.DATA || EMPTY, i;
    S.truce.clear(); S.nameCount = {};
    for (i = 0; i < cs.length; i++) if (cs[i]) initCountry(W, cs[i]);
    var keyTo = {};
    for (i = 0; i < cs.length; i++) if (cs[i] && cs[i].key !== undefined) keyTo[String(cs[i].key)] = i;
    var iw = D.initialWars || [];
    for (i = 0; i < iw.length; i++) {
      var a = keyTo[String(iw[i].attacker)], d = keyTo[String(iw[i].defender)];
      if (a === undefined || d === undefined || !isAlive(W, a) || !isAlive(W, d)) continue;
      var w = declare(W, a, d, iw[i].goal || 'conquest', { initial: true, silent: true });
      if (w) {
        // an ongoing war: both sides already worn down
        cs[a].warExhaustion = M.max(c01(cs[a].warExhaustion, 0), 0.25);
        cs[d].warExhaustion = M.max(c01(cs[d].warExhaustion, 0), 0.25);
        news(W, 'The ' + w.name + ' continues.', 'war', [a, d], 3);
      }
    }
    refreshActive(W); recomputeAtWar(W);
    for (i = 0; i < cs.length; i++) if (cs[i] && cs[i].alive) cs[i].power = power(W, cs[i]);
  }

  function militaryWeekly(W) {
    var cs = W.countries;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i]; if (!c || !c.alive) continue;
      var spend = spendMilOf(c) * gdpOf(c);
      var ms = num(c.milStock, -1); if (!(ms >= 0)) ms = estMilStock(c);
      ms += spend / 52 - ms * 0.06 / 52;
      c.milStock = ms > 0 && ms < 1e9 ? ms : 0;
      var tgt = estManpower(c), mp = num(c.manpower, tgt);
      c.manpower = M.max(0, mp + (tgt - mp) * 0.2);
      if (!c.atWar) c.warExhaustion = M.max(0, c01(c.warExhaustion, 0) * 0.994 - 0.0005);
      else c.warExhaustion = c01(c.warExhaustion, 0);
      c.power = power(W, c);
    }
  }

  function step(W) {
    var S = ST_(W), tick = W.tick | 0, cs = W.countries, i;
    refreshActive(W);
    recomputeAtWar(W);
    militaryWeekly(W);
    var gl = S.gpList || (S.gpList = []); gl.length = 0;
    for (i = 0; i < cs.length; i++) if (cs[i] && cs[i].alive && cs[i].greatPower) gl.push(i);
    if ((tick & 3) === 0) puppetsFollow(W);
    var act = S.active.slice();
    for (i = 0; i < act.length; i++) if (!act[i].ended) resolveWar(W, act[i]);
    for (i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (!c || !c.alive || ((tick + i) & 3) !== 0) continue;
      warAI(W, c);
    }
    refreshActive(W);
    recomputeAtWar(W);
    if (tick % 52 === 0 && S.truce.size) S.truce.forEach(function (v, k) { if (!(v > tick)) S.truce.delete(k); });
    // war history cap
    if (W.wars.length > 200) {
      for (i = 0; i < W.wars.length && W.wars.length > 200; i++) if (W.wars[i].ended) { W.wars.splice(i, 1); i--; }
    }
  }

  function onCountryRemoved(W, cc) {
    var c = cOf(W, cc); if (!c) return;
    var id = c.id, ws = W.wars || [], i, S = ST_(W);
    S.removing = id;
    for (i = 0; i < ws.length; i++) {
      var w = ws[i]; if (!w || w.ended) continue;
      var s = sideOf(w, id); if (!s) continue;
      var list = s === 1 ? w.attackers : w.defenders;
      list.splice(list.indexOf(id), 1);
      if (!list.length) finish(W, w, 'conquest', s === 1 ? 2 : 1, false);
      else if (id === (s === 1 ? w.attackerLeader : w.defenderLeader)) finish(W, w, 'ceasefire', s === 1 ? 2 : 1, false);
    }
    var cs = W.countries;
    for (i = 0; i < cs.length; i++) if (cs[i] && cs[i].overlord === id) cs[i].overlord = -1;
    c.atWar = false; c.power = 0;
    S.removing = -1;
    S.dirty = true;
    refreshActive(W); recomputeAtWar(W);
  }

  GS.War = {
    init: init,
    initCountry: initCountry,
    step: step,
    power: power,
    declare: declare,
    isAtWar: isAtWar,
    enemies: enemies,
    warsOf: warsOf,
    active: active,
    makePeace: makePeace,
    nuke: nuke,
    onCountryRemoved: onCountryRemoved,
    honorProb: honorProb,
    areaFactor: areaF
  };
})();
