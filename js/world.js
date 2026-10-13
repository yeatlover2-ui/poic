/* GODSIM world.js — owns GS.World, GS.news, GS.God.
 * Builds the world (regions, countries, matrices, globals), runs the weekly step in the order fixed by SPEC.md,
 * keeps region ownership / country lifecycle consistent, records history and news, and implements the God powers.
 * Classic script, no DOM. Other modules are only referenced at call time. */
(function () {
  'use strict';
  var GS = globalThis.GS = globalThis.GS || {};
  var M = Math;

  var NC_PAD = 48, NEWS_CAP = 400, HIST_CAP = 600;
  var DEV_DECAY = M.pow(0.5, 1 / 52);          // devastation half-life ≈ 1 year
  var EMPTY = {};

  // ------------------------------------------------------------------ helpers
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : (x === x ? x : a)); }
  function fn(mod, name) { var m = GS[mod]; return (m && typeof m[name] === 'function') ? m[name] : null; }
  function jobs() { return (GS.CONST && GS.CONST.JOBS) || { CHILD: 0, UNEMPLOYED: 1, FARM: 2, INDUSTRY: 3, SERVICES: 4, GOV: 5, MILITARY: 6, RETIRED: 7, REBEL: 8 }; }
  function fmtNum(n) { return (GS.U && GS.U.fmtNum) ? GS.U.fmtNum(n) : String(M.round(num(n, 0))); }
  function fmtMoney(b) { return (GS.U && GS.U.fmtMoney) ? GS.U.fmtMoney(b) : ('$' + M.round(num(b, 0)) + 'B'); }

  function countryOf(W, c) {
    if (c === null || c === undefined || !W || !W.countries) return null;
    if (typeof c === 'number') return (c >= 0 && c < W.countries.length) ? (W.countries[c] || null) : null;
    if (typeof c === 'string') { var n = +c; if (c !== '' && isFinite(n)) return countryOf(W, n); return findByKey(W, c); }
    if (typeof c === 'object' && typeof c.id === 'number') return W.countries[c.id] === c ? c : (W.countries[c.id] || null);
    return null;
  }
  function liveCountry(W, c) { var o = countryOf(W, c); return (o && o.alive) ? o : null; }
  function regionOf(W, r) {
    if (r === null || r === undefined || !W || !W.regions) return null;
    if (typeof r === 'object') { if (typeof r.id === 'number') return W.regions[r.id] || null; return null; }
    r = +r; return (r >= 0 && r < W.regions.length) ? (W.regions[r | 0] || null) : null;
  }
  function findByKey(W, key) {
    var cs = W.countries, k = String(key), dead = null;
    for (var i = 0; i < cs.length; i++) if (cs[i] && String(cs[i].key) === k) { if (cs[i].alive) return cs[i]; if (!dead) dead = cs[i]; }
    return dead;
  }
  function findByIso3(W, iso3) {
    if (!W || !W.countries || !iso3) return null;
    var cs = W.countries, k = String(iso3).toUpperCase(), dead = null;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i]; if (!c) continue;
      var a = c.iso3 || (c.data && c.data.iso3) || '';
      if (String(a).toUpperCase() === k) { if (c.alive) return c; if (!dead) dead = c; }
    }
    return dead;
  }

  function hueOf(rgb) {
    if (!rgb || rgb.length < 3) return -1;
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var mx = M.max(r, g, b), mn = M.min(r, g, b), d = mx - mn;
    if (d < 0.06) return -1; // greyish: no meaningful hue
    var h;
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
    return h;
  }
  function hueDist(a, b) { var d = M.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

  // a muted, pleasant colour whose hue differs from the hues of land neighbours (golden-angle candidates)
  function genColor(W, c, seq) {
    var nh = [], regs = c.regions || [], R = W.regions, cs = W.countries, i, j;
    for (i = 0; i < regs.length; i++) {
      var reg = R[regs[i]]; if (!reg || !reg.neighbors) continue;
      for (j = 0; j < reg.neighbors.length; j++) {
        var nb = R[reg.neighbors[j]]; if (!nb) continue;
        var o = nb.owner; if (o < 0 || o === c.id) continue;
        var oc = cs[o]; if (!oc || !oc.color) continue;
        var h = hueOf(oc.color); if (h >= 0) nh.push(h);
      }
    }
    var best = (seq * 137.508) % 360, bestScore = -1;
    for (var k = 0; k < 14; k++) {
      var cand = ((seq + k * 11) * 137.508) % 360, sc = 180;
      for (j = 0; j < nh.length; j++) { var dd = hueDist(cand, nh[j]); if (dd < sc) sc = dd; }
      if (sc > bestScore + 1e-9) { bestScore = sc; best = cand; }
      if (sc >= 60) break;
    }
    var s = 0.30 + W.rng.next() * 0.20, l = 0.40 + W.rng.next() * 0.14;
    if (GS.U && typeof GS.U.hsl === 'function') return GS.U.hsl(best, s, l);
    return [128, 128, 128];
  }

  function capLonLat(W, c) {
    if (!c) return [0, 0];
    var reg = W.regions[c.capital];
    if (c.data && c.data.capLonLat && c.data.capLonLat.length >= 2 && reg && String(reg.key) === String(c.key)) return c.data.capLonLat;
    if (reg) return [num(reg.lon, 0), num(reg.lat, 0)];
    if (c.data && c.data.capLonLat && c.data.capLonLat.length >= 2) return c.data.capLonLat;
    return [0, 0];
  }

  function chooseCapital(W, c) {
    var regs = c.regions || [], R = W.regions, best = -1, bs = -1;
    var cap = c.data && c.data.capLonLat, cp = (cap && GS.Geo && GS.Geo.project) ? GS.Geo.project(cap[0], cap[1]) : null;
    for (var i = 0; i < regs.length; i++) {
      var r = R[regs[i]]; if (!r || r.owner !== c.id) continue;
      var s = M.max(num(r.area, 0), 1e-6);
      if (String(r.key) === String(c.key)) {
        s *= 1e6; // homeland region
        if (cp && r.subN > 1 && GS.Geo.pointInRegion(r, cp[0], cp[1])) s *= 1e6; // the province with the real capital
      }
      else if (r.core === c.id) s *= 1e3;             // other core land
      s *= (1 - 0.5 * clamp(num(r.devastation, 0), 0, 1));
      if (s > bs) { bs = s; best = regs[i]; }
    }
    return best;
  }

  function updateDistRow(W, id) {
    var NC = W.NC, D = W.dist, cs = W.countries, n = M.min(cs.length, NC);
    if (!D || id < 0 || id >= NC) return;
    var a = capLonLat(W, cs[id]), geo = GS.Geo;
    for (var j = 0; j < n; j++) {
      var v = 0;
      if (j !== id && cs[j]) {
        var b = capLonLat(W, cs[j]);
        v = num(geo && geo.haversineKm ? geo.haversineKm(a[0], a[1], b[0], b[1]) : 0, 0);
        if (v < 1 && j !== id) v = 1;
      }
      D[id * NC + j] = v; D[j * NC + id] = v;
    }
  }

  function newHist() { return { t: [], gdp: [], pop: [], approval: [], unrest: [], stock: [], power: [] }; }

  function defaultData(name) {
    return { name: name || 'Unknown', iso3: '', pop: 0.5, gdp: 3, mil: 1, gov: 'hybrid', econ: 0, auth: 0.3, nat: 0.5,
      oil: 0, food: 0, minerals: 0.2, nukes: 0, tech: 0.5, navy: 0, culture: 'anglo', blocs: [], corruption: 0.5 };
  }

  function makeCountry(W, id, key, data) {
    var d = data || defaultData(key);
    return {
      id: id, key: String(key), name: d.name || String(key), iso3: d.iso3 || '', culture: d.culture || 'anglo',
      color: (d.color && d.color.length >= 3) ? d.color.slice(0, 3) : null,
      alive: true, regions: [], capital: -1, createdTick: W.tick | 0, diedTick: -1, parent: -1,
      pop0: num(d.pop, 0.5), gdp0: num(d.gdp, 3), data: d,
      gov: d.gov || 'hybrid',
      oil: num(d.oil, 0), food: num(d.food, 0), minerals: num(d.minerals, 0),
      nukes: M.max(0, num(d.nukes, 0)), tech: num(d.tech, 0.6), navy: num(d.navy, 0),
      // neutral placeholders for fields owned by other modules (their init overwrites)
      patron: -1, overlord: -1, threat: 0, claims: [], sanctions: [], greatPower: false, influence: 0,
      alliances: [], defensePacts: [], atWar: false, warExhaustion: 0, power: 0, civilWar: null,
      hist: newHist()
    };
  }

  // ------------------------------------------------------------------ matrices
  function ensureCapacity(W, need) {
    if (need <= W.NC) return false;
    var old = W.NC, NC = M.max(need + NC_PAD, M.ceil(old * 1.25));
    function grow(A) {
      var B = new Float32Array(NC * NC);
      if (A) for (var a = 0; a < old; a++) for (var b = 0; b < old; b++) B[a * NC + b] = A[a * old + b];
      return B;
    }
    W.rel = grow(W.rel); W.trade = grow(W.trade); W.dist = grow(W.dist);
    var G = W.global;
    if (G) {
      var rs = new Float32Array(NC), ors = G.reserveShares;
      if (ors) for (var i = 0; i < M.min(ors.length, NC); i++) rs[i] = num(ors[i], 0);
      G.reserveShares = rs;
    }
    W.NC = NC;
    return true;
  }

  function buildReserveShares(W) {
    var G = W.global, rs = G.reserveShares, cs = W.countries, n = cs.length, i;
    for (i = 0; i < rs.length; i++) rs[i] = 0;
    var D = GS.DATA || EMPTY, src = D.reserveShares || {}, used = new Uint8Array(n), k;
    for (k in src) {
      if (k === 'EU' || k === 'other') continue;
      var c = findByKey(W, k);
      if (c && c.alive && c.id < rs.length) { rs[c.id] += num(src[k], 0); used[c.id] = 1; }
    }
    // euro share over euro members (fallback: EU bloc members) by GDP
    var euro = num(src.EU, 0);
    if (euro > 0) {
      var mem = [], tot = 0;
      var euroKeys = D.eurozone || null;
      for (i = 0; i < n; i++) {
        var ci = cs[i]; if (!ci || !ci.alive || used[i]) continue;
        var isM = euroKeys ? euroKeys.indexOf(ci.key) >= 0 : !!(ci.data && ci.data.blocs && ci.data.blocs.indexOf('EU') >= 0);
        if (isM) { mem.push(i); tot += M.max(0, num(ci.gdp0, 0)); }
      }
      if (tot > 0) for (i = 0; i < mem.length; i++) { rs[mem[i]] += euro * M.max(0, num(cs[mem[i]].gdp0, 0)) / tot; used[mem[i]] = 1; }
    }
    var other = num(src.other, 0);
    if (other > 0) {
      var tot2 = 0;
      for (i = 0; i < n; i++) if (cs[i] && cs[i].alive && !used[i]) tot2 += M.max(0, num(cs[i].gdp0, 0));
      if (tot2 > 0) for (i = 0; i < n; i++) if (cs[i] && cs[i].alive && !used[i]) rs[i] += other * M.max(0, num(cs[i].gdp0, 0)) / tot2;
    }
    var s = 0; for (i = 0; i < rs.length; i++) s += rs[i];
    if (s > 0) for (i = 0; i < rs.length; i++) rs[i] /= s;
    else if (n > 0) { var g = 0; for (i = 0; i < n; i++) g += M.max(0, num(cs[i].gdp0, 0)); if (g > 0) for (i = 0; i < n; i++) rs[i] = M.max(0, num(cs[i].gdp0, 0)) / g; }
  }

  // ------------------------------------------------------------------ create
  function create(seed) {
    if (seed === undefined || seed === null || !isFinite(+seed)) seed = 20261013;
    seed = (+seed) >>> 0;
    var topo = globalThis.GS_TOPO;
    if (!topo) throw new Error('GS.World.create: GS_TOPO not loaded');
    if (!GS.Geo || typeof GS.Geo.buildRegions !== 'function') throw new Error('GS.World.create: GS.Geo missing');
    var DATA = GS.DATA || { countries: {}, ownerOverrides: {} };
    var DC = DATA.countries || {}, OV = DATA.ownerOverrides || {};

    var W = {
      seed: seed, rng: new GS.RNG(seed), tick: 0, speed: 1,
      regions: GS.Geo.buildRegions(topo), countries: [], people: null,
      alliances: [], wars: [], n: 0, rel: null, trade: null, dist: null, NC: 0,
      global: null,
      ghist: { t: [], market: [], oil: [], food: [], fear: [], gdp: [], pop: [], wars: [] },
      news: [], newsSeq: 0, selected: -1, _histTick: -1
    };
    var R = W.regions, i, r, c;
    for (i = 0; i < R.length; i++) { r = R[i]; r.id = i; r.owner = -1; r.core = -1; r.devastation = 0; if (!r.neighbors) r.neighbors = []; }

    // 1) one country per region key that is not an override territory
    var byKey = {};
    for (i = 0; i < R.length; i++) {
      r = R[i]; var key = String(r.key);
      if (OV.hasOwnProperty(key)) continue;
      c = byKey[key];
      if (!c) {
        var bn = r.baseName || r.name;
        var d = DC[key] || defaultData(bn || key);
        if (!DC[key] && bn) d.name = bn;
        c = makeCountry(W, W.countries.length, key, d);
        W.countries.push(c); byKey[key] = c;
      }
      r.owner = c.id; r.core = c.id; c.regions.push(i);
    }
    // 2) territories → override owner (or their own country if the owner is absent)
    for (i = 0; i < R.length; i++) {
      r = R[i]; var k2 = String(r.key);
      if (!OV.hasOwnProperty(k2)) continue;
      var own = byKey[String(OV[k2])];
      if (!own) {
        own = byKey[k2];
        if (!own) { own = makeCountry(W, W.countries.length, k2, DC[k2] || defaultData(r.baseName || r.name || k2)); W.countries.push(own); byKey[k2] = own; }
      } else if (!(r.sub > 0)) {
        // territory figures are separate in DATA: fold them into the owner's totals (once per territory)
        var td = DC[k2];
        if (td) {
          own.pop0 += M.max(0, num(td.pop, 0)); own.gdp0 += M.max(0, num(td.gdp, 0));
          own.oil += M.max(0, num(td.oil, 0)); own.minerals = M.max(own.minerals, num(td.minerals, 0));
        }
      }
      r.owner = own.id; r.core = own.id; own.regions.push(i);
    }
    var n = W.countries.length;
    W.n = n;
    // 3) capitals, colours
    for (i = 0; i < n; i++) { c = W.countries[i]; c.capital = chooseCapital(W, c); c.oil = clamp(c.oil, 0, 2); }
    var seq = 0;
    for (i = 0; i < n; i++) { c = W.countries[i]; if (!c.color) c.color = genColor(W, c, seq++); }

    // 4) matrices
    W.NC = n + NC_PAD;
    W.rel = new Float32Array(W.NC * W.NC); W.trade = new Float32Array(W.NC * W.NC); W.dist = new Float32Array(W.NC * W.NC);
    var NC = W.NC, geo = GS.Geo, ll = new Array(n);
    for (i = 0; i < n; i++) ll[i] = capLonLat(W, W.countries[i]);
    for (i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      var dk = num(geo.haversineKm(ll[i][0], ll[i][1], ll[j][0], ll[j][1]), 0);
      if (dk < 1) dk = 1;
      W.dist[i * NC + j] = dk; W.dist[j * NC + i] = dk;
    }

    // 5) globals
    var gdp = 0, pop = 0;
    for (i = 0; i < n; i++) { gdp += W.countries[i].gdp0; pop += W.countries[i].pop0 * 1e6; }
    W.global = {
      worldGDP: gdp, worldGrowth: 0.03, worldPop: pop, marketIndex: 1000, oilPrice: 75, foodPrice: 100,
      fear: 0.15, baseRate: 0.04, tradeVolume: 0, reserveShares: new Float32Array(NC),
      plagueActive: false, nukesUsed: 0, warDeaths: 0
    };
    buildReserveShares(W);

    // 6) modules
    var f;
    if ((f = fn('People', 'init'))) f(W);
    if ((f = fn('Economy', 'init'))) f(W);
    if ((f = fn('Politics', 'init'))) f(W);
    if ((f = fn('Diplo', 'init'))) f(W);
    if ((f = fn('War', 'init'))) f(W);
    if ((f = fn('People', 'aggregate'))) f(W);
    // settle the economy now (not lazily on the first step) so a god power used before the first tick
    // hits a calibrated world instead of being absorbed into the starting baseline
    if ((f = fn('Economy', 'settle'))) f(W);
    sampleHistory(W);
    news(W, 'The world as of ' + GS.dateOf(0).full + ': ' + n + ' nations, ' + fmtNum(W.global.worldPop || pop) + ' souls. You are watching.', { type: 'world', importance: 2 });
    return W;
  }

  // ------------------------------------------------------------------ step
  function step(W) {
    var f;
    if ((f = fn('People', 'step'))) f(W);
    if ((f = fn('People', 'aggregate'))) f(W);
    if ((f = fn('Economy', 'step'))) f(W);
    if ((f = fn('Politics', 'step'))) f(W);
    if ((f = fn('Diplo', 'step'))) f(W);
    if ((f = fn('War', 'step'))) f(W);
    // devastation decays
    var R = W.regions;
    for (var i = 0; i < R.length; i++) {
      var d = R[i].devastation;
      if (d > 0) { d *= DEV_DECAY; R[i].devastation = (d < 0.002 || !(d === d)) ? 0 : (d > 1 ? 1 : d); }
      else if (d !== 0) R[i].devastation = 0;
    }
    if ((W.tick % 4) === 0) sampleHistory(W);
    W.tick++;
    return W;
  }

  function push(arr, v) { arr.push(v); if (arr.length > HIST_CAP) arr.splice(0, arr.length - HIST_CAP); }

  function sampleHistory(W) {
    if (W._histTick === W.tick) return;
    W._histTick = W.tick;
    var cs = W.countries, G = W.global || EMPTY, gpop = 0, ggdp = 0, i;
    for (i = 0; i < cs.length; i++) {
      var c = cs[i]; if (!c || !c.alive) continue;
      var h = c.hist || (c.hist = newHist());
      if (!h.t) h.t = [];
      push(h.t, W.tick);
      push(h.gdp, num(c.gdp, num(c.gdp0, 0)));
      push(h.pop, num(c.pop, num(c.pop0, 0) * 1e6));
      push(h.approval, num(c.approval, 0.5));
      push(h.unrest, num(c.unrest, 0));
      push(h.stock, num(c.stockIndex, 100));
      push(h.power, num(c.power, 0));
      gpop += num(c.pop, 0); ggdp += num(c.gdp, 0);
    }
    var wars = 0, ws = W.wars || [];
    for (i = 0; i < ws.length; i++) if (ws[i] && !ws[i].ended) wars++;
    var gh = W.ghist;
    push(gh.t, W.tick);
    push(gh.market, num(G.marketIndex, 1000));
    push(gh.oil, num(G.oilPrice, 75));
    push(gh.food, num(G.foodPrice, 100));
    push(gh.fear, num(G.fear, 0));
    push(gh.gdp, num(G.worldGDP, 0) > 0 ? G.worldGDP : ggdp);
    push(gh.pop, num(G.worldPop, 0) > 0 ? G.worldPop : gpop);
    push(gh.wars, wars);
  }

  // ------------------------------------------------------------------ ownership & lifecycle
  // internal: move a region; returns old owner id (or -2 if nothing changed). Countries emptied are pushed to `emptied`.
  function moveRegion(W, rid, cid, emptied) {
    var r = W.regions[rid]; if (!r) return -2;
    var old = r.owner;
    if (old === cid) return -2;
    var oc = old >= 0 ? W.countries[old] : null;
    if (oc) {
      var ix = oc.regions.indexOf(rid);
      if (ix >= 0) oc.regions.splice(ix, 1);
    }
    r.owner = cid;
    var nc = cid >= 0 ? W.countries[cid] : null;
    if (nc && nc.regions.indexOf(rid) < 0) nc.regions.push(rid);
    if (oc && oc.alive) {
      if (!oc.regions.length) { if (emptied) emptied.push(oc); }
      else if (oc.capital === rid || oc.capital < 0) {
        var oldCap = oc.capital;
        oc.capital = chooseCapital(W, oc);
        updateDistRow(W, oc.id);
        if (oldCap === rid && oc.capital >= 0 && W.regions[oc.capital]) {
          news(W, oc.name + ' loses its capital and relocates the government to ' + W.regions[oc.capital].name + '.',
            { type: 'war', countries: nc ? [oc.id, nc.id] : [oc.id], importance: 3 });
        }
      }
    }
    if (nc && (nc.capital < 0 || !W.regions[nc.capital] || W.regions[nc.capital].owner !== nc.id)) {
      nc.capital = chooseCapital(W, nc);
      updateDistRow(W, nc.id);
    }
    var f;
    if ((f = fn('People', 'onRegionOwnerChanged'))) f(W, rid, old, cid);
    if ((f = fn('Economy', 'onRegionOwnerChanged'))) f(W, rid, old, cid);
    if ((f = fn('Politics', 'onRegionOwnerChanged'))) f(W, rid, old, cid);
    if ((f = fn('Diplo', 'onRegionOwnerChanged'))) f(W, rid, old, cid);
    if ((f = fn('War', 'onRegionOwnerChanged'))) f(W, rid, old, cid);
    return old;
  }

  function setRegionOwner(W, regionId, countryId, reason) {
    var r = regionOf(W, regionId); if (!r) return false;
    var cid;
    if (countryId === null || countryId === undefined || countryId === -1) cid = -1;
    else { var c = countryOf(W, countryId); if (!c || !c.alive) return false; cid = c.id; }
    var emptied = [];
    var old = moveRegion(W, r.id, cid, emptied);
    if (old === -2) return false;
    for (var i = 0; i < emptied.length; i++) {
      if (emptied[i].alive && !emptied[i].regions.length) destroyCountry(W, emptied[i], 'conquered', { by: cid, reason: reason });
    }
    return true;
  }

  function scaledWorkers(src, f) {
    var o = { farm: 0, industry: 0, services: 0, gov: 0, military: 0 };
    if (src) for (var k in o) o[k] = M.max(0, num(src[k], 0) * f);
    return o;
  }

  function createCountry(W, opts) {
    opts = opts || EMPTY;
    var regs = [], i, rr = opts.regions || [];
    for (i = 0; i < rr.length; i++) { var reg = regionOf(W, rr[i]); if (reg && regs.indexOf(reg.id) < 0) regs.push(reg.id); }
    if (!regs.length) return -1;
    var parent = (typeof opts.parent === 'number' && opts.parent >= 0) ? countryOf(W, opts.parent) : (opts.parent && typeof opts.parent === 'object' ? countryOf(W, opts.parent) : null);
    var origin = (typeof opts.origin === 'number' && opts.origin >= 0) ? countryOf(W, opts.origin) : null;
    var id = W.countries.length;
    ensureCapacity(W, id + 1);

    // measure what is being taken before moving it
    var P = W.people, R = W.regions, popReal = 0, agents = 0, area = 0, pArea = 0;
    var rp = P && (P.regionPop || P.rPopW), ra = P && (P.regionAgents || P.rCount);
    for (i = 0; i < regs.length; i++) {
      if (rp && regs[i] < rp.length) popReal += M.max(0, num(rp[regs[i]], 0));
      if (ra && regs[i] < ra.length) agents += M.max(0, num(ra[regs[i]], 0));
      area += M.max(0, num(R[regs[i]].area, 0));
    }
    if (parent) for (i = 0; i < parent.regions.length; i++) pArea += M.max(0, num(R[parent.regions[i]] && R[parent.regions[i]].area, 0));
    var share = parent && pArea > 0 ? clamp(area / pArea, 0, 1) : 0.2;
    if (!(popReal > 0)) popReal = parent ? M.max(1e4, num(parent.pop, num(parent.pop0, 1) * 1e6) * share) : 1e5;
    var pShare = parent && num(parent.pop, 0) > 0 ? clamp(popReal / parent.pop, 0, 1) : share;

    // data: inherit the parent's (or origin's) profile, then adjust
    var base = (opts.data && typeof opts.data === 'object') ? opts.data : ((origin && origin.data) || (parent && parent.data) || defaultData(opts.name));
    var d = {}, k;
    for (k in base) if (base.hasOwnProperty(k)) d[k] = base[k];
    delete d.color; delete d.capLonLat; delete d.startCivilWar; delete d.rebelShare;
    d.blocs = []; d.iso3 = opts.iso3 || '';
    var gpc = parent && num(parent.gdpPerCap, 0) > 0 ? parent.gdpPerCap : (num(d.gdp, 0) > 0 && num(d.pop, 0) > 0 ? d.gdp * 1e3 / d.pop : 3000);
    d.pop = popReal / 1e6; d.gdp = M.max(0.05, gpc * popReal / 1e9 * 0.85); d.nukes = 0;
    var name = opts.name;
    if (!name) {
      var bn = (parent && parent.name) || (R[regs[0]] && R[regs[0]].name) || 'the Land';
      name = (GS.Names && GS.Names.newCountryName) ? GS.Names.newCountryName(R[regs[0]] ? R[regs[0]].name : bn, 'republic', W.rng) : ('Republic of ' + bn);
    }
    d.name = name;
    if (opts.gov) d.gov = opts.gov;
    var c = makeCountry(W, id, opts.key ? String(opts.key) : ('X' + id), d);
    c.name = name; c.iso3 = d.iso3; c.data = d;
    c.culture = opts.culture || (origin && origin.culture) || (parent && parent.culture) || d.culture || 'anglo';
    c.gov = opts.gov || (parent && parent.gov) || d.gov || 'hybrid';
    c.parent = parent ? parent.id : -1;
    c.origin = origin ? origin.id : -1;
    c.createdTick = W.tick | 0;
    c.pop0 = d.pop; c.gdp0 = d.gdp;
    // land carries its resources; tech & reach are inherited at a discount
    var oil = 0, food = 0, fw = 0, mins = 0, DC = (GS.DATA && GS.DATA.countries) || EMPTY;
    for (i = 0; i < regs.length; i++) {
      var de = DC[R[regs[i]].key], sn = M.max(1, num(R[regs[i]].subN, 1));
      if (de) { oil += M.max(0, num(de.oil, 0)) / sn; food += num(de.food, 0); fw++; mins = M.max(mins, num(de.minerals, 0)); }
    }
    if (fw === 0 && parent) { oil = num(parent.oil, 0) * share; food = num(parent.food, 0); mins = num(parent.minerals, 0); fw = 1; }
    c.oil = clamp(oil, 0, 2); c.food = clamp(fw ? food / fw : 0, -1, 1); c.minerals = clamp(mins, 0, 1);
    c.tech = clamp(num(parent ? parent.tech : d.tech, 0.6) * 0.9, 0.3, 1.5);
    c.navy = clamp(num(parent ? parent.navy : d.navy, 0) * 0.2, 0, 1);
    c.nukes = 0;
    // provisional people aggregates (People.aggregate refreshes them next tick)
    var src = parent || origin || EMPTY;
    c.pop = popReal; c.agents = agents;
    c.happiness = num(src.happiness, 0.45); c.approval = 0.55; // honeymoon
    c.ideoEcon = num(src.ideoEcon, num(d.econ, 0)); c.ideoAuth = num(src.ideoAuth, num(d.auth, 0)); c.ideoNat = clamp(num(src.ideoNat, num(d.nat, 0.5)) + 0.1, 0, 1);
    c.polarization = num(src.polarization, 0.3); c.radicalShare = num(src.radicalShare, 0.1); c.protestShare = 0;
    c.milApproval = 0.6; c.unemployment = num(src.unemployment, 0.1);
    c.workers = scaledWorkers(src.workers, pShare);
    c.avgIncome = num(src.avgIncome, gpc * 0.5); c.avgWealth = num(src.avgWealth, gpc); c.gini = num(src.gini, 0.4);
    c.infected = num(src.infected, 0); c.deathsW = 0; c.birthsW = 0; c.emigW = 0; c.immigW = 0; c.refugeesOut = 0;
    c.minorityShare = 0;
    if (opts.color && opts.color.length >= 3) c.color = [opts.color[0] | 0, opts.color[1] | 0, opts.color[2] | 0];

    W.countries.push(c);
    W.n = W.countries.length;
    if (W.global && W.global.reserveShares && id < W.global.reserveShares.length) W.global.reserveShares[id] = 0;
    // zero matrix rows (stride may contain stale data from nothing, but be explicit)
    var NC = W.NC;
    for (i = 0; i < NC; i++) { W.rel[id * NC + i] = 0; W.rel[i * NC + id] = 0; W.trade[id * NC + i] = 0; W.trade[i * NC + id] = 0; }

    // take the land (defer destruction of emptied countries until the newcomer is fully initialised)
    var emptied = [];
    for (i = 0; i < regs.length; i++) moveRegion(W, regs[i], id, emptied);
    if (typeof opts.capital === 'number' && c.regions.indexOf(opts.capital) >= 0) c.capital = opts.capital;
    else c.capital = chooseCapital(W, c);
    if (!c.color) c.color = genColor(W, c, id * 3 + 7);
    updateDistRow(W, id);

    var f;
    if ((f = fn('People', 'initCountry'))) f(W, c);
    if ((f = fn('Economy', 'initCountry'))) f(W, c);
    if ((f = fn('Politics', 'initCountry'))) f(W, c);
    if ((f = fn('Diplo', 'initCountry'))) f(W, c);
    if ((f = fn('War', 'initCountry'))) f(W, c);

    if (!opts.silent) {
      news(W, 'A new nation is born: ' + c.name + (parent ? ' breaks away from ' + parent.name : ' rises') +
        (c.regions.length && R[c.capital] ? ', governing from ' + R[c.capital].name : '') + '.',
        { type: 'politics', countries: parent ? [id, parent.id] : [id], importance: 4 });
    }
    for (i = 0; i < emptied.length; i++) {
      if (emptied[i].alive && !emptied[i].regions.length) destroyCountry(W, emptied[i], 'conquered', { by: id, reason: 'secession' });
    }
    return id;
  }

  function destroyCountry(W, cc, mode, opts) {
    var c = countryOf(W, cc);
    if (!c || !c.alive) return false;
    opts = opts || EMPTY;
    mode = mode === 'erased' ? 'erased' : 'conquered';
    var id = c.id, i, R = W.regions;
    c.alive = false; c.diedTick = W.tick | 0; c.removedMode = mode; c.deathMode = mode;
    c.lostRegions = c.regions.slice();
    c.conqueredBy = (mode !== 'erased' && typeof opts.by === 'number' && opts.by >= 0) ? opts.by : -1;
    if (c.leader) c.leader.ruledUntil = W.tick | 0;
    if (mode === 'erased') {
      for (i = 0; i < c.regions.length; i++) { var r = R[c.regions[i]]; if (r && r.owner === id) r.owner = -1; }
      c.regions = [];
    } else if (c.regions.length) {
      // a 'conquered' country that still holds land: hand it to the conqueror if any, else leave it empty
      var by = (typeof opts.by === 'number' && opts.by >= 0 && W.countries[opts.by] && W.countries[opts.by].alive) ? opts.by : -1;
      var regs = c.regions.slice();
      for (i = 0; i < regs.length; i++) moveRegion(W, regs[i], by, null);
      c.regions = [];
    }
    c.atWar = false;
    var f;
    if ((f = fn('People', 'onCountryRemoved'))) f(W, c, mode);
    if ((f = fn('Economy', 'onCountryRemoved'))) f(W, c, mode);
    if ((f = fn('Politics', 'onCountryRemoved'))) f(W, c, mode);
    if ((f = fn('Diplo', 'onCountryRemoved'))) f(W, c, mode);
    if ((f = fn('War', 'onCountryRemoved'))) f(W, c, mode);

    // after the economic shock has been measured: sever all ties
    var NC = W.NC, rel = W.rel, tr = W.trade;
    if (id < NC) for (i = 0; i < NC; i++) { rel[id * NC + i] = 0; rel[i * NC + id] = 0; tr[id * NC + i] = 0; tr[i * NC + id] = 0; }
    var G = W.global;
    if (G && G.reserveShares && id < G.reserveShares.length && G.reserveShares[id] > 0) {
      G.reserveShares[id] = 0;
      var s = 0, rs = G.reserveShares; for (i = 0; i < rs.length; i++) s += rs[i];
      if (s > 0) for (i = 0; i < rs.length; i++) rs[i] /= s;
    }
    var cs = W.countries;
    for (i = 0; i < cs.length; i++) {
      var o = cs[i]; if (!o) continue;
      if (o.patron === id) o.patron = -1;
      if (o.overlord === id) o.overlord = -1;
      if (o.defensePacts && o.defensePacts.indexOf(id) >= 0) o.defensePacts = o.defensePacts.filter(function (x) { return x !== id; });
      if (o.sanctions && o.sanctions.indexOf(id) >= 0) o.sanctions = o.sanctions.filter(function (x) { return x !== id; });
    }
    if (!opts.silent) {
      var byC = (typeof opts.by === 'number' && opts.by >= 0) ? W.countries[opts.by] : null;
      var txt = mode === 'erased' ? c.name + ' has vanished from the face of the Earth.'
        : (byC ? c.name + ' ceases to exist: its last territory falls to ' + byC.name + '.' : c.name + ' ceases to exist as a state.');
      news(W, txt, { type: mode === 'erased' ? 'world' : 'war', countries: byC ? [id, byC.id] : [id], importance: 5 });
    }
    return true;
  }

  // ------------------------------------------------------------------ news
  function news(W, text, opts) {
    if (!W) return null;
    opts = opts || EMPTY;
    var ids = [], cl = opts.countries || [];
    if (!Array.isArray(cl)) cl = [cl];
    for (var i = 0; i < cl.length; i++) {
      var x = cl[i], v = (typeof x === 'number') ? x : (x && typeof x.id === 'number' ? x.id : -1);
      if (v >= 0 && ids.indexOf(v) < 0) ids.push(v);
    }
    var t = W.tick | 0;
    var item = { tick: t, date: GS.dateOf ? GS.dateOf(t).full : String(t), text: String(text).replace(/(^|[^.])\.\.(?!\.)/g, '$1.'), type: opts.type || 'world',
      countries: ids, importance: clamp(M.round(num(opts.importance, 2)), 1, 5) };
    for (var k in opts) if (opts.hasOwnProperty(k) && !item.hasOwnProperty(k)) item[k] = opts[k];
    item.id = W.newsSeq = (num(W.newsSeq, 0) | 0) + 1;
    if (!W.news) W.news = [];
    W.news.push(item);
    if (W.news.length > NEWS_CAP) W.news.splice(0, W.news.length - NEWS_CAP);
    return item;
  }

  // ------------------------------------------------------------------ God
  function god(W, text, countries) { return news(W, text, { type: 'god', countries: countries || [], importance: 5 }); }

  // iterate live agents living in country cid (region owner lookup built once)
  function eachAgentOf(W, cid, cb) {
    var P = W.people; if (!P || !P.alive) return 0;
    var R = W.regions, own = new Int32Array(R.length), i, cnt = 0;
    for (i = 0; i < R.length; i++) own[i] = R[i].owner;
    var alive = P.alive, region = P.region, n = P.n | 0;
    for (i = 0; i < n; i++) {
      if (!alive[i]) continue;
      var rg = region[i];
      if (rg < 0 || rg >= own.length || own[rg] !== cid) continue;
      cb(P, i); cnt++;
    }
    return cnt;
  }

  function killIn(W, filter) {
    var f = fn('People', 'kill');
    var k = f ? num(f(W, filter), 0) : 0;
    return k > 0 ? k : 0;
  }

  function regionTarget(W, x) {
    var r = regionOf(W, x);
    if (r) return r;
    var c = countryOf(W, x);
    return c && c.capital >= 0 ? W.regions[c.capital] : null;
  }

  // "Greenland (Denmark)" for a territory, just "India" for a homeland region
  function placeName(W, r) {
    var oc = r && r.owner >= 0 ? W.countries[r.owner] : null;
    if (!r) return 'an unknown land';
    if (!oc) return r.name;
    return String(r.key) === String(oc.key) ? oc.name : r.name + ' (' + oc.name + ')';
  }
  function devastate(r, v) { if (r) r.devastation = clamp(M.max(num(r.devastation, 0), 0) + v, 0, 1); }
  function addFear(W, a) {
    var f = fn('Economy', 'addFear');
    if (f) f(W, a); else if (W.global) W.global.fear = clamp(num(W.global.fear, 0) + a, 0, 1);
  }

  var God = {
    erase: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      god(W, 'GOD HAS SPOKEN. ' + c.name + ' is erased from existence — ' + fmtNum(num(c.pop, 0)) +
        ' people, its cities, its armies and its government are simply gone. Where it stood, there is only empty land.', [c.id]);
      return destroyCountry(W, c, 'erased', { silent: true });
    },

    collapse: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      var J = jobs(), rng = W.rng;
      god(W, 'The state of ' + c.name + ' collapses overnight. Ministries empty, soldiers desert their posts and the capital falls silent. Warlords stir.', [c.id]);
      var f;
      if ((f = fn('Politics', 'changeGov'))) f(W, c, 'anarchy', 'collapse', { silent: true });
      else { c.gov = 'anarchy'; c.leader = null; }
      var dis = 0;
      eachAgentOf(W, c.id, function (P, i) { if (P.job[i] === J.MILITARY && rng.next() < 0.6) { P.job[i] = J.UNEMPLOYED; dis++; } });
      if (typeof c.milStock === 'number') c.milStock = M.max(0, c.milStock * 0.5);
      if (typeof c.manpower === 'number') c.manpower = M.max(0, c.manpower * 0.4);
      if (c.workers && typeof c.workers.military === 'number') c.workers.military *= 0.4;
      c.unrest = 0.9; c.stability = M.min(num(c.stability, 0.1), 0.05); c.legitimacy = M.min(num(c.legitimacy, 0.1), 0.05);
      if (typeof c.confidence === 'number') c.confidence = M.min(c.confidence, 0.2);
      if (typeof c.stockIndex === 'number') c.stockIndex *= 0.6;
      if (!c.civilWar && (f = fn('Politics', 'startCivilWar'))) f(W, c, { kind: 'warlords' });
      return true;
    },

    plague: function (W, regionId, severity) {
      var r = regionTarget(W, regionId); if (!r) return false;
      var sev = clamp(num(severity, 0.6), 0, 1);
      var f = fn('People', 'infect'), got = 0;
      if (f) got = num(f(W, r.id, M.round(6 + sev * 24), sev), 0);
      if (W.global) W.global.plagueActive = true;
      var oc = r.owner >= 0 ? W.countries[r.owner] : null;
      god(W, 'A new plague emerges in ' + placeName(W, r) + '. ' +
        (sev > 0.7 ? 'It is swift and merciless.' : sev > 0.4 ? 'Doctors are alarmed.' : 'Few notice it at first.'), oc ? [oc.id] : []);
      addFear(W, 0.05 + 0.15 * sev);
      return got > 0 || !!f;
    },

    disaster: function (W, regionId) {
      var r = regionTarget(W, regionId); if (!r) return false;
      var kinds = ['earthquake', 'tsunami', 'super-typhoon', 'volcanic eruption', 'catastrophic flood'];
      var kind = W.rng.pick(kinds);
      var killed = killIn(W, { region: r.id, fraction: W.rng.range(0.01, 0.05), cause: kind === 'tsunami' ? 'tsunami' : (kind === 'earthquake' ? 'earthquake' : 'disaster') });
      devastate(r, 0.6);
      for (var i = 0; i < r.neighbors.length; i++) devastate(W.regions[r.neighbors[i]], 0.15);
      var oc = r.owner >= 0 ? W.countries[r.owner] : null, f;
      if (oc && (f = fn('Economy', 'destroyCapital'))) f(W, oc, 0.08);
      god(W, 'A devastating ' + kind + ' strikes ' + placeName(W, r) + '. ' + (killed > 0 ? fmtNum(killed) + ' dead; ' : '') + 'cities lie in ruins.', oc ? [oc.id] : []);
      addFear(W, 0.03);
      return true;
    },

    nuke: function (W, regionId) {
      var r = regionTarget(W, regionId); if (!r) return false;
      var oc = r.owner >= 0 ? W.countries[r.owner] : null;
      god(W, 'A blinding flash over ' + placeName(W, r) + '. A nuclear detonation of unknown origin' + (oc ? ' devastates ' + oc.name : '') + '. The world holds its breath.', oc ? [oc.id] : []);
      var f = fn('War', 'nuke');
      if (f) return f(W, -1, r.id);
      // fallback when war.js is absent
      killIn(W, { region: r.id, fraction: 0.3, cause: 'nuclear' });
      devastate(r, 1);
      for (var i = 0; i < r.neighbors.length; i++) devastate(W.regions[r.neighbors[i]], 0.3);
      if (W.global) W.global.nukesUsed = num(W.global.nukesUsed, 0) + 1;
      addFear(W, 0.5);
      return true;
    },

    prosperity: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      if (typeof c.tfp === 'number' && isFinite(c.tfp)) c.tfp *= 1.15;
      if (typeof c.confidence === 'number') c.confidence = clamp(c.confidence + 0.2, 0, 1);
      eachAgentOf(W, c.id, function (P, i) {
        P.happy[i] = P.happy[i] + 0.15 > 1 ? 1 : P.happy[i] + 0.15;
        P.approval[i] = P.approval[i] + 0.08 > 1 ? 1 : P.approval[i] + 0.08;
        if (P.radical) P.radical[i] *= 0.7;
      });
      c.unrest = clamp(num(c.unrest, 0) * 0.6, 0, 1);
      god(W, 'A golden age dawns in ' + c.name + ': harvests overflow, factories hum and invention flourishes.', [c.id]);
      return true;
    },

    famine: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      c.food = -1;
      var killed = killIn(W, { country: c.id, fraction: W.rng.range(0.02, 0.05), cause: 'famine' });
      eachAgentOf(W, c.id, function (P, i) {
        P.happy[i] = P.happy[i] > 0.25 ? P.happy[i] - 0.25 : 0;
        if (P.health) P.health[i] = P.health[i] > 0.2 ? P.health[i] - 0.2 : 0;
      });
      c.unrest = clamp(num(c.unrest, 0) + 0.25, 0, 1);
      god(W, 'The fields of ' + c.name + ' wither. A great famine spreads' + (killed > 0 ? ', and ' + fmtNum(killed) + ' starve in the first weeks.' : '.'), [c.id]);
      return true;
    },

    marketCrash: function (W) {
      var G = W.global; if (!G) return false;
      G.marketIndex = M.max(1, num(G.marketIndex, 1000) * 0.6);
      G.fear = M.max(num(G.fear, 0), 0.9);
      var cs = W.countries;
      for (var i = 0; i < cs.length; i++) { var c = cs[i]; if (c && c.alive && typeof c.stockIndex === 'number' && isFinite(c.stockIndex)) c.stockIndex *= 0.7; }
      god(W, 'BLACK MONDAY. Global markets crash 40% in a single session; panic grips every trading floor from New York to Tokyo.', []);
      return true;
    },

    discoverOil: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      c.oil = clamp(num(c.oil, 0) + 0.5, 0, 3);
      god(W, 'Gushers! Vast oil reserves are discovered beneath ' + c.name + '. Fortunes — and appetites — awaken.', [c.id]);
      return true;
    },

    revolution: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      var rng = W.rng;
      god(W, 'A revolutionary fire sweeps through ' + c.name + '. Millions pour into the streets demanding the fall of the regime.', [c.id]);
      eachAgentOf(W, c.id, function (P, i) {
        var a = P.age ? P.age[i] : 30;
        if (a < 14) return;
        P.radical[i] = M.max(P.radical[i], 0.6 + 0.4 * rng.next());
        P.approval[i] *= 0.3;
        P.happy[i] = P.happy[i] > 0.2 ? P.happy[i] - 0.2 : 0;
        if (rng.next() < 0.5) P.flags[i] |= 1; // PROTEST
      });
      c.unrest = M.max(num(c.unrest, 0), 0.95);
      c.protestShare = M.max(num(c.protestShare, 0), 0.4);
      c.legitimacy = M.min(num(c.legitimacy, 0.5), 0.15);
      var f;
      if ((f = fn('Politics', 'revolution'))) f(W, c);
      return true;
    },

    assassinate: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      var L = c.leader, nm = (L && !L.none && L.name) ? L.name : null;
      god(W, nm ? 'Shots ring out in ' + c.name + '. ' + nm + ' has been assassinated. The nation is in shock.'
        : 'An assassin\'s bullet strikes at the heart of ' + c.name + '\'s fractured leadership.', [c.id]);
      var f;
      if ((f = fn('Politics', 'changeLeader'))) f(W, c, 'assassinated');
      else c.leader = null;
      c.unrest = clamp(num(c.unrest, 0) + 0.25, 0, 1);
      c.stability = clamp(num(c.stability, 0.5) - 0.2, 0, 1);
      return true;
    },

    warmonger: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      var L = c.leader;
      if (L) { L.aggression = 0.95; L.ambition = 0.9; L.caution = 0.1; }
      god(W, 'A dark whisper enters the mind of ' + (L && L.name ? L.name : 'the rulers') + ' of ' + c.name + ': conquest, glory, empire. The generals are summoned.', [c.id]);
      return !!L;
    },

    pacify: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      var L = c.leader;
      if (L) { L.aggression = 0.05; L.ambition = 0.2; L.caution = 0.9; }
      god(W, 'A strange serenity settles over ' + (L && L.name ? L.name : 'the rulers') + ' of ' + c.name + '. Swords are sheathed; envoys are sent to every border.', [c.id]);
      return !!L;
    },

    forceWar: function (W, aa, bb) {
      var a = liveCountry(W, aa), b = liveCountry(W, bb);
      if (!a || !b || a === b) return null;
      var isW = fn('War', 'isAtWar');
      if (isW && isW(W, a.id, b.id)) return null; // nothing happens: no news, no relation change
      god(W, 'The gods sow discord: ' + a.name + ' is driven to war against ' + b.name + '.', [a.id, b.id]);
      var f;
      if ((f = fn('Diplo', 'addRel'))) f(W, a.id, b.id, -60);
      else if (W.rel) { var NC = W.NC; var v = clamp(num(W.rel[a.id * NC + b.id], 0) - 60, -100, 100); W.rel[a.id * NC + b.id] = v; W.rel[b.id * NC + a.id] = v; }
      if ((f = fn('War', 'declare'))) return f(W, a, b, 'conquest');
      return null;
    },

    armUp: function (W, cc) {
      var c = liveCountry(W, cc); if (!c) return false;
      if (typeof c.milStock === 'number' && isFinite(c.milStock)) c.milStock *= 2;
      var f;
      if ((f = fn('War', 'power'))) { var p = f(W, c); if (typeof p === 'number' && isFinite(p)) c.power = p; }
      god(W, 'Arsenals overflow in ' + c.name + ': tanks, jets and missiles appear as if from nowhere. Its military might doubles.', [c.id]);
      return true;
    },

    meteor: function (W, regionId) {
      var r = regionTarget(W, regionId); if (!r) return false;
      var oc = r.owner >= 0 ? W.countries[r.owner] : null;
      var killed = killIn(W, { region: r.id, fraction: 0.6, cause: 'meteor' });
      devastate(r, 1);
      var aff = oc ? [oc.id] : [], i, f;
      for (i = 0; i < r.neighbors.length; i++) {
        var nb = W.regions[r.neighbors[i]]; if (!nb) continue;
        devastate(nb, 0.5);
        killed += killIn(W, { region: nb.id, fraction: 0.05, cause: 'meteor' });
        if (nb.owner >= 0 && aff.indexOf(nb.owner) < 0) aff.push(nb.owner);
      }
      if (oc && (f = fn('Economy', 'destroyCapital'))) f(W, oc, 0.6);
      addFear(W, 0.4);
      god(W, 'FIRE FROM THE SKY. A meteor obliterates ' + placeName(W, r) + '. ' + (killed > 0 ? fmtNum(killed) + ' perish in an instant. ' : '') +
        'Dust darkens the skies across the hemisphere.', aff);
      return true;
    }
  };

  // ------------------------------------------------------------------ scenarios (user-triggered only)
  function topByPop(W, k) {
    var cs = W.countries.filter(function (c) { return c && c.alive && c.capital >= 0; });
    cs.sort(function (a, b) { return num(b.pop, 0) - num(a.pop, 0); });
    return cs.slice(0, k);
  }
  var scenarios = {
    eraseUSA: function (W) { var c = findByIso3(W, 'USA'); return c && c.alive ? God.erase(W, c) : false; },
    eraseChina: function (W) { var c = findByIso3(W, 'CHN'); return c && c.alive ? God.erase(W, c) : false; },
    collapseRussia: function (W) { var c = findByIso3(W, 'RUS'); return c && c.alive ? God.collapse(W, c) : false; },
    globalPlague: function (W) {
      // seed in the most populous capitals plus a few random regions on other continents
      var tops = topByPop(W, 4), done = 0, i;
      for (i = 0; i < tops.length; i++) if (God.plague(W, tops[i].capital, 0.85)) done++;
      for (i = 0; i < 3; i++) {
        var r = W.rng.pick(W.regions);
        if (r && r.owner >= 0 && God.plague(W, r.id, 0.85)) done++;
      }
      return done > 0;
    },
    // a single outbreak in one big city: tests cross-border spreading
    singlePlague: function (W) {
      var tops = topByPop(W, 10); if (!tops.length) return false;
      var c = tops[(W.rng.next() * tops.length) | 0];
      return God.plague(W, c.capital, 0.7);
    }
  };

  // ------------------------------------------------------------------ summary
  function summary(W) {
    var cs = W.countries, G = W.global || EMPTY, alive = 0, anarchy = 0, civil = 0, i;
    var top = [];
    for (i = 0; i < cs.length; i++) {
      var c = cs[i]; if (!c || !c.alive) continue;
      alive++;
      if (c.gov === 'anarchy') anarchy++;
      if (c.civilWar) civil++;
      top.push(c);
    }
    top.sort(function (a, b) { return num(b.gdp, 0) - num(a.gdp, 0); });
    var wars = 0, ended = 0, ws = W.wars || [];
    for (i = 0; i < ws.length; i++) { if (!ws[i]) continue; if (ws[i].ended) ended++; else wars++; }
    var P = W.people, agents = 0;
    if (P && P.alive) for (i = 0; i < (P.n | 0); i++) if (P.alive[i]) agents++;
    var empty = 0;
    for (i = 0; i < W.regions.length; i++) if (W.regions[i].owner < 0) empty++;
    return {
      tick: W.tick, date: GS.dateOf ? GS.dateOf(W.tick).full : String(W.tick),
      countries: cs.length, alive: alive, dead: cs.length - alive, anarchy: anarchy, civilWars: civil,
      emptyRegions: empty, agents: agents,
      worldPop: num(G.worldPop, 0), worldGDP: num(G.worldGDP, 0), worldGrowth: num(G.worldGrowth, 0),
      marketIndex: num(G.marketIndex, 0), oilPrice: num(G.oilPrice, 0), foodPrice: num(G.foodPrice, 0),
      fear: num(G.fear, 0), plagueActive: !!G.plagueActive, nukesUsed: num(G.nukesUsed, 0), warDeaths: num(G.warDeaths, 0),
      activeWars: wars, endedWars: ended, alliances: (W.alliances || []).length, news: (W.news || []).length,
      top: top.slice(0, 8).map(function (c) {
        return { id: c.id, name: c.name, gdp: M.round(num(c.gdp, 0)), gdpStr: fmtMoney(num(c.gdp, 0)), pop: M.round(num(c.pop, 0)),
          gov: c.gov, power: M.round(num(c.power, 0) * 100) / 100, atWar: !!c.atWar };
      })
    };
  }

  GS.World = {
    create: create,
    step: step,
    setRegionOwner: setRegionOwner,
    createCountry: createCountry,
    destroyCountry: destroyCountry,
    findByIso3: findByIso3,
    findByKey: findByKey,
    summary: summary,
    scenarios: scenarios,
    capLonLat: capLonLat,
    sampleHistory: sampleHistory,
    ensureCapacity: ensureCapacity
  };
  GS.news = news;
  GS.God = God;
})();
