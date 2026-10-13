/* GODSIM map.js — GS.MapView: canvas world map (DOM).
 * Cached Path2D per region, smooth pan/zoom, map modes, overlays (people, wars, trade, alliance links, labels),
 * hit-testing, follow ring and god-power FX. Reads the world only; never mutates simulation state. */
(function () {
  'use strict';
  var GS = globalThis.GS = globalThis.GS || {};
  var M = Math;

  // ------------------------------------------------------------------ helpers
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : (x === x ? x : a)); }
  function css(c, a) {
    if (!c) c = [90, 90, 96];
    var r = clamp(c[0] | 0, 0, 255), g = clamp(c[1] | 0, 0, 255), b = clamp(c[2] | 0, 0, 255);
    return a === undefined ? 'rgb(' + r + ',' + g + ',' + b + ')' : 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function ramp(stops, t) {
    t = clamp(num(t, 0), 0, 1) * (stops.length - 1);
    var i = M.min(stops.length - 2, M.floor(t));
    return mix(stops[i], stops[i + 1], t - i);
  }
  function country(W, id) { return (id >= 0 && W && W.countries && id < W.countries.length) ? W.countries[id] : null; }
  function liveC(W, id) { var c = country(W, id); return c && c.alive ? c : null; }

  var ASH = [58, 63, 74];
  // categorical palette for spheres of influence (assigned to patrons in order of sphere size)
  var SPH_PAL = [[86, 156, 255], [235, 87, 87], [242, 170, 60], [72, 199, 142], [178, 120, 240], [80, 210, 230], [240, 120, 190],
    [196, 214, 86], [160, 120, 80], [255, 220, 120]];
  var SPH_IND = [84, 88, 98];
  var NEUTRAL = [62, 68, 82];
  var DIV = [[214, 58, 58], [150, 84, 76], [64, 70, 86], [70, 150, 104], [64, 210, 120]];
  var SEQ_WEALTH = [[30, 28, 74], [38, 78, 140], [32, 150, 150], [130, 205, 100], [250, 226, 96]];
  var SEQ_UNREST = [[48, 160, 104], [170, 196, 74], [236, 176, 60], [236, 100, 46], [205, 34, 44]];
  var SEQ_PLAGUE = [[44, 52, 64], [90, 140, 60], [190, 214, 60], [236, 150, 60], [224, 70, 190]];
  var GOV_COL = {
    democracy: [64, 142, 232], flawed_democracy: [112, 182, 228], hybrid: [204, 182, 88], autocracy: [214, 106, 58],
    oneparty: [200, 50, 60], theocracy: [46, 158, 106], monarchy: [155, 89, 208], junta: [138, 143, 58], anarchy: [58, 54, 50]
  };
  var GOV_ORDER = ['democracy', 'flawed_democracy', 'hybrid', 'autocracy', 'oneparty', 'theocracy', 'monarchy', 'junta', 'anarchy'];
  var DOT_COLS = ['#8c7fa6', '#cfc8ba', '#fff1bf', '#5ec8ff', '#ffa23a', '#a6ff4d', '#ff3b3b', '#ff5ed1'];
  var DOT_LABELS = ['Unhappy', 'Getting by', 'Content', 'Soldier', 'Refugee', 'Infected', 'Protesting', 'Rebel'];

  var MODES = [
    { id: 'political', label: 'Political' }, { id: 'alliances', label: 'Blocs' }, { id: 'spheres', label: 'Spheres' },
    { id: 'relations', label: 'Relations' }, { id: 'stability', label: 'Stability' }, { id: 'economy', label: 'Growth' },
    { id: 'wealth', label: 'Wealth' }, { id: 'government', label: 'Government' }, { id: 'plague', label: 'Plague' }
  ];
  var OVERLAYS = [
    { id: 'people', label: 'People' }, { id: 'wars', label: 'Wars' }, { id: 'trade', label: 'Trade' },
    { id: 'alliances', label: 'Alliances' }, { id: 'labels', label: 'Labels' }
  ];

  // ------------------------------------------------------------------ state
  var S = {
    canvas: null, ctx: null, dpr: 1, cw: 1, ch: 1, W: null,
    paths: [], all: null, grat: null, mapW: 3600, mapH: 1832,
    view: { s: 0.3, ox: 0, oy: 0 }, target: { s: 0.3, ox: 0, oy: 0 }, sFit: 0.3, inited: false,
    mode: 'political', ov: { people: false, wars: true, trade: false, alliances: false, labels: true },
    hover: -1, follow: -1, lastNow: 0,
    ccol: [], ccolT: -1e9, ccolDirty: true,
    pcan: null, pctx: null, pT: -1e9, pView: null, pDirty: true, pimg: null, pbuf: null,
    gpaths: [], trade: [], tradeT: -1e9, labels: [], labelT: -1e9, sphere: [], sphereT: -1e9, sphereCol: [], sphereList: [], sphereKeep: null,
    hatch: null, ocean: null, fx: [], cb: {}, down: null, mark: null, rmark: null
  };

  // ------------------------------------------------------------------ setup
  function init(canvas, callbacks) {
    S.canvas = canvas; S.ctx = canvas.getContext('2d');
    S.cb = callbacks || {};
    S.pcan = document.createElement('canvas'); S.pctx = S.pcan.getContext('2d');
    bindEvents();
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(function () { resize(); }).observe(canvas.parentElement || canvas); } catch (e) { /* ignore */ }
    }
    window.addEventListener('resize', resize);
    resize();
  }

  function setWorld(W) {
    S.W = W;
    S.paths = []; S.all = null; S.gpaths = [];
    var G = GS.Geo || {};
    S.mapW = num(G.MAP_W, num(GS.CONST && GS.CONST.MAP_W, 3600));
    S.mapH = num(G.MAP_H, 0);
    var R = (W && W.regions) || [], maxY = 0, i;
    if (typeof Path2D === 'function') {
      var all = new Path2D();
      var addPolys = function (path, polys) {
        for (var a = 0; a < polys.length; a++) {
          var rings = polys[a] || [];
          for (var b = 0; b < rings.length; b++) {
            var ring = rings[b]; if (!ring || ring.length < 3) continue;
            path.moveTo(ring[0][0], ring[0][1]);
            for (var k = 1; k < ring.length; k++) path.lineTo(ring[k][0], ring[k][1]);
            path.closePath();
          }
        }
      };
      for (i = 0; i < R.length; i++) {
        var r = R[i], p = new Path2D(), polys = (r && r.polys) || [];
        addPolys(p, polys);
        if (!(r && r.subN > 1)) addPolys(all, polys);
        else if (r.outline) { addPolys(all, r.outline); var gp = new Path2D(); addPolys(gp, r.outline); S.gpaths[r.group] = gp; }
        S.paths[i] = p;
        if (r && r.bbox && r.bbox[3] > maxY) maxY = r.bbox[3];
      }
      S.all = all;
    }
    if (!(S.mapH > 0)) S.mapH = maxY > 0 ? maxY : S.mapW * 0.51;
    buildGraticule();
    S.ccolDirty = true; S.pDirty = true; S.tradeT = -1e9; S.labelT = -1e9; S.sphereT = -1e9;
    S.hover = -1; S.follow = -1; S.fx.length = 0;
    S.inited = false;
    resize();
    resetView(true);
  }

  function buildGraticule() {
    if (typeof Path2D !== 'function') return;
    var g = new Path2D(), pr = GS.Geo && GS.Geo.project, lon, lat;
    function P(lo, la) { if (pr) { var p = pr(lo, la); return [num(p[0], num(p.x, 0)), num(p[1], num(p.y, 0))]; } return [(lo + 180) / 360 * S.mapW, (84 - la) / 144 * S.mapH]; }
    for (lon = -180; lon <= 180; lon += 30) { var a = P(lon, 84), b = P(lon, -60); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
    for (lat = -60; lat <= 80; lat += 20) { var c = P(-180, lat), d = P(180, lat); g.moveTo(c[0], c[1]); g.lineTo(d[0], d[1]); }
    S.grat = g;
  }

  function resize() {
    var cv = S.canvas; if (!cv) return;
    var host = cv.parentElement || cv, rect = host.getBoundingClientRect();
    var cw = M.max(50, rect.width), ch = M.max(50, rect.height), dpr = M.min(2.5, M.max(1, window.devicePixelRatio || 1));
    var oldCw = S.cw, oldCh = S.ch, oldDpr = S.dpr;
    if (cw === oldCw && ch === oldCh && dpr === oldDpr && cv.width) return;
    var cxMap = (oldCw / 2 - S.target.ox) / S.target.s, cyMap = (oldCh / 2 - S.target.oy) / S.target.s;
    S.cw = cw; S.ch = ch; S.dpr = dpr;
    cv.width = M.round(cw * dpr); cv.height = M.round(ch * dpr);
    cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
    S.pcan.width = cv.width; S.pcan.height = cv.height; S.pDirty = true;
    S.sFit = M.min(cw / S.mapW, ch / S.mapH);
    var g = S.ctx.createRadialGradient(cw * dpr * 0.5, ch * dpr * 0.42, 10, cw * dpr * 0.5, ch * dpr * 0.5, M.max(cw, ch) * dpr * 0.75);
    g.addColorStop(0, '#0d1a2e'); g.addColorStop(0.6, '#08111f'); g.addColorStop(1, '#04070d');
    S.ocean = g;
    buildHatch();
    if (!S.inited) { resetView(true); return; }
    // keep the map point at the centre stable
    var s = clamp(S.target.s, S.sFit * 0.9, S.sFit * 60);
    S.target.s = s; S.target.ox = cw / 2 - cxMap * s; S.target.oy = ch / 2 - cyMap * s;
    clampView(S.target); copyView(S.view, S.target);
  }

  function buildHatch() {
    try {
      var d = S.dpr, n = M.round(7 * d), c = document.createElement('canvas');
      c.width = n; c.height = n;
      var x = c.getContext('2d');
      x.strokeStyle = 'rgba(200,190,170,0.13)'; x.lineWidth = M.max(1, d * 0.9);
      x.beginPath(); x.moveTo(0, n); x.lineTo(n, 0); x.moveTo(-n / 2, n / 2); x.lineTo(n / 2, -n / 2); x.moveTo(n / 2, n * 1.5); x.lineTo(n * 1.5, n / 2); x.stroke();
      S.hatch = S.ctx.createPattern(c, 'repeat');
    } catch (e) { S.hatch = null; }
  }

  // ------------------------------------------------------------------ view
  function copyView(a, b) { a.s = b.s; a.ox = b.ox; a.oy = b.oy; }
  function clampView(v) {
    v.s = clamp(num(v.s, S.sFit), S.sFit * 0.9, S.sFit * 60);
    var mw = S.mapW * v.s, mh = S.mapH * v.s;
    if (mw <= S.cw) v.ox = (S.cw - mw) / 2; else v.ox = clamp(num(v.ox, 0), S.cw - mw - S.cw * 0.2, S.cw * 0.2);
    if (mh <= S.ch) v.oy = (S.ch - mh) / 2; else v.oy = clamp(num(v.oy, 0), S.ch - mh - S.ch * 0.2, S.ch * 0.2);
  }
  function resetView(instant) {
    var t = S.target;
    t.s = S.sFit; t.ox = 0; t.oy = 0; clampView(t);
    if (instant || !S.inited) copyView(S.view, t);
    S.inited = true;
  }
  function stepView(now) {
    var dt = M.min(100, M.max(0, now - (S.lastNow || now))); S.lastNow = now;
    var v = S.view, t = S.target, r = 1 - M.exp(-dt / 70);
    if (M.abs(v.s - t.s) / t.s < 0.001 && M.abs(v.ox - t.ox) < 0.3 && M.abs(v.oy - t.oy) < 0.3) { copyView(v, t); return; }
    v.s = v.s * M.pow(t.s / v.s, r); v.ox += (t.ox - v.ox) * r; v.oy += (t.oy - v.oy) * r;
  }
  function zoomAt(lx, ly, f) {
    var t = S.target, mx = (lx - t.ox) / t.s, my = (ly - t.oy) / t.s;
    t.s = clamp(t.s * f, S.sFit * 0.9, S.sFit * 60);
    t.ox = lx - mx * t.s; t.oy = ly - my * t.s;
    clampView(t);
  }
  function zoomBy(f) { zoomAt(S.cw / 2, S.ch / 2, f); }
  function screenToMap(lx, ly) { var v = S.view; return [(lx - v.ox) / v.s, (ly - v.oy) / v.s]; }
  function mapToScreen(x, y) { var v = S.view; return [v.ox + x * v.s, v.oy + y * v.s]; }

  function labelPoint(W, c) {
    var best = null, ba = -1, tot = 0, rs = (c && c.regions) || [];
    for (var i = 0; i < rs.length; i++) { var r = W.regions[rs[i]]; if (!r) continue; var a = num(r.area, 0); tot += a; if (a > ba) { ba = a; best = r; } }
    if (!best) { var cr = W.regions[c && c.capital]; if (cr) return { x: cr.cx, y: cr.cy, area: num(cr.area, 1) }; return null; }
    // label the homeland (e.g. Denmark, not Greenland) unless it is tiny next to the rest
    for (i = 0; i < rs.length; i++) {
      var h = W.regions[rs[i]];
      if (h && String(h.key) === String(c.key)) { best = h; break; }
    }
    // a subdivided homeland: label the whole shape (the group's first province carries the outline) when held entirely
    var g = num(best.group, best.id), ga = 0, gx = 0, gy = 0, all = true, R = W.regions;
    if (num(best.subN, 1) > 1) {
      for (i = 0; i < R.length; i++) {
        var q = R[i]; if (!q || num(q.group, q.id) !== g) continue;
        if (q.owner !== c.id) { all = false; continue; }
        ga += num(q.area, 0); gx += q.cx * num(q.area, 0); gy += q.cy * num(q.area, 0);
      }
    }
    var ha = num(best.area, 0);
    if (ga > ha && all) return { x: gx / ga, y: gy / ga, area: M.min(ga * 4, ga + 0.15 * (tot - ga)), group: g };
    return { x: best.cx, y: best.cy, area: M.min(ha * 4, ha + 0.15 * (tot - ha)), group: g };
  }
  function centerOn(cid, zoom) {
    var W = S.W; if (!W) return;
    var c = country(W, cid); if (!c) return;
    var lp = labelPoint(W, c); if (!lp) return;
    var t = S.target;
    if (zoom !== false) {
      var want = 0.32 * M.min(S.cw, S.ch) / M.max(1, M.sqrt(lp.area));
      t.s = clamp(want, S.sFit * 1.2, S.sFit * 14);
    }
    t.ox = S.cw / 2 - lp.x * t.s; t.oy = S.ch / 2 - lp.y * t.s;
    clampView(t);
  }
  function reveal(cid) {
    var W = S.W; if (!W) return;
    var c = country(W, cid); if (!c) return;
    var lp = labelPoint(W, c); if (!lp) return;
    var t = S.target, sx = t.ox + lp.x * t.s, sy = t.oy + lp.y * t.s;
    if (sx < S.cw * 0.12 || sx > S.cw * 0.88 || sy < S.ch * 0.12 || sy > S.ch * 0.88) centerOn(cid, false);
  }

  // ------------------------------------------------------------------ hit test
  function localXY(e) { var r = S.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function regionAtLocal(lx, ly) {
    var W = S.W; if (!W || !W.regions) return -1;
    var p = screenToMap(lx, ly), x = p[0], y = p[1], R = W.regions, best = -1, ba = Infinity;
    var pir = GS.Geo && GS.Geo.pointInRegion;
    for (var i = 0; i < R.length; i++) {
      var r = R[i], b = r && r.bbox; if (!b) continue;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      var inside = false;
      try { inside = pir ? !!pir(r, x, y) : pip(r, x, y); } catch (e) { inside = false; }
      if (inside && num(r.area, 0) < ba) { ba = num(r.area, 0); best = i; }
    }
    return best;
  }
  function pip(r, x, y) {
    var inside = false, polys = r.polys || [];
    for (var a = 0; a < polys.length; a++) for (var b = 0; b < polys[a].length; b++) {
      var ring = polys[a][b];
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var yi = ring[i][1], yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < (ring[j][0] - ring[i][0]) * (y - yi) / (yj - yi) + ring[i][0]) inside = !inside;
      }
    }
    return inside;
  }
  function regionAt(clientX, clientY) { var r = S.canvas.getBoundingClientRect(); return regionAtLocal(clientX - r.left, clientY - r.top); }

  function bindEvents() {
    var cv = S.canvas;
    cv.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var l = localXY(e);
      S.down = { x: l[0], y: l[1], ox: S.target.ox, oy: S.target.oy, moved: false, id: e.pointerId };
      try { cv.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    });
    cv.addEventListener('pointermove', function (e) {
      var l = localXY(e), d = S.down;
      if (d) {
        var dx = l[0] - d.x, dy = l[1] - d.y;
        if (!d.moved && dx * dx + dy * dy > 16) { d.moved = true; cv.classList.add('dragging'); }
        if (d.moved) {
          S.target.ox = d.ox + dx; S.target.oy = d.oy + dy; clampView(S.target); copyView(S.view, S.target);
          S.pDirty = true;
          if (S.cb.onHover) S.cb.onHover(-1, e);
          return;
        }
      }
      var rid = regionAtLocal(l[0], l[1]);
      S.hover = rid;
      if (S.cb.onHover) S.cb.onHover(rid, e);
    });
    function up(e) {
      var d = S.down; S.down = null; cv.classList.remove('dragging');
      if (!d) return;
      try { cv.releasePointerCapture(d.id); } catch (er) { /* ignore */ }
      if (!d.moved && e.type === 'pointerup') {
        var l = localXY(e), rid = regionAtLocal(l[0], l[1]);
        if (S.cb.onClick) S.cb.onClick(rid, e);
      }
    }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', function (e) { if (!S.down) { S.hover = -1; if (S.cb.onHover) S.cb.onHover(-1, e); } });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var l = localXY(e), dy = e.deltaY * (e.deltaMode === 1 ? 33 : (e.deltaMode === 2 ? 400 : 1));
      zoomAt(l[0], l[1], M.exp(-clamp(dy, -300, 300) * 0.0018));
    }, { passive: false });
    cv.addEventListener('dblclick', function (e) {
      e.preventDefault();
      if (S.cb.blockDblZoom && S.cb.blockDblZoom()) return;
      var l = localXY(e); zoomAt(l[0], l[1], 2.2);
    });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); if (S.cb.onContext) S.cb.onContext(e); });
  }

  // ------------------------------------------------------------------ colours per mode
  function patronOf(W, c) {
    var p = c, g = 0;
    while (g++ < 6) {
      var nx = num(p.overlord, -1) >= 0 ? p.overlord : num(p.patron, -1);
      if (nx < 0) break;
      var q = liveC(W, nx); if (!q || q === c) break;
      p = q;
    }
    return p;
  }
  function countryColor(W, c, sel) {
    var mode = S.mode;
    switch (mode) {
      case 'alliances': {
        var bc = null;
        try { bc = GS.Diplo && GS.Diplo.blocColor ? GS.Diplo.blocColor(W, c) : null; } catch (e) { bc = null; }
        return bc ? bc : NEUTRAL;
      }
      case 'spheres': {
        var p = patronOf(W, c), pc = S.sphereCol[p.id];
        if (p !== c && pc) return mix(pc, [20, 24, 32], 0.18);
        if (pc) return mix(pc, [255, 255, 255], 0.12); // the patron itself: brightest
        return SPH_IND;
      }
      case 'relations': {
        var sc = liveC(W, sel);
        if (!sc) return mix(c.color || NEUTRAL, NEUTRAL, 0.7);
        if (sc === c) return [233, 185, 73];
        var NC = W.NC | 0, v = (W.rel && NC) ? num(W.rel[sc.id * NC + c.id], 0) : 0;
        try { if (GS.War && GS.War.isAtWar && GS.War.isAtWar(W, sc.id, c.id)) return [150, 14, 26]; } catch (e) { /* ignore */ }
        return ramp(DIV, (clamp(v, -100, 100) + 100) / 200);
      }
      case 'stability':
        if (c.civilWar) return [120, 10, 34];
        return ramp(SEQ_UNREST, num(c.unrest, 0));
      case 'economy':
        return ramp(DIV, (clamp(num(c.growth, 0), -0.08, 0.08) + 0.08) / 0.16);
      case 'wealth': {
        var g = M.max(100, num(c.gdpPerCap, 0) || (num(c.gdp, 0) * 1e9 / M.max(1, num(c.pop, 1))));
        return ramp(SEQ_WEALTH, (M.log(g) / M.LN10 - 2.7) / (5 - 2.7));
      }
      case 'government':
        return GOV_COL[c.gov] || NEUTRAL;
      case 'plague':
        return ramp(SEQ_PLAGUE, M.sqrt(clamp(num(c.infected, 0), 0, 0.3) / 0.3));
      default:
        return c.color || NEUTRAL;
    }
  }
  function refreshColors(W, now) {
    if (!S.ccolDirty && now - S.ccolT < 280) return;
    S.ccolDirty = false; S.ccolT = now;
    var cs = W.countries || [], sel = num(W.selected, -1);
    if (S.mode === 'spheres' && now - S.sphereT > 1500) {
      S.sphereT = now; S.sphere = []; S.sphereCol = []; S.sphereList = [];
      for (var j = 0; j < cs.length; j++) { var cj = cs[j]; if (!cj || !cj.alive) continue; var pj = patronOf(W, cj); if (pj !== cj) S.sphere[pj.id] = (S.sphere[pj.id] || 0) + 1; }
      for (j = 0; j < cs.length; j++) if (S.sphere[j] && liveC(W, j)) S.sphereList.push(j);
      S.sphereList.sort(function (x, y) { return S.sphere[y] - S.sphere[x] || x - y; });
      // keep a patron's colour stable while it keeps its sphere
      var used = {}, keep = S.sphereKeep || {};
      for (j = 0; j < S.sphereList.length; j++) { var kp = keep[S.sphereList[j]]; if (kp !== undefined && !used[kp]) { S.sphereCol[S.sphereList[j]] = SPH_PAL[kp]; used[kp] = 1; } }
      var nk = {};
      for (j = 0; j < S.sphereList.length; j++) {
        var pid = S.sphereList[j];
        if (!S.sphereCol[pid]) for (var q = 0; q < SPH_PAL.length; q++) if (!used[q]) { S.sphereCol[pid] = SPH_PAL[q]; used[q] = 1; break; }
        for (q = 0; q < SPH_PAL.length; q++) if (S.sphereCol[pid] === SPH_PAL[q]) nk[pid] = q;
        if (!S.sphereCol[pid]) S.sphereCol[pid] = [150, 150, 160];
      }
      S.sphereKeep = nk;
    }
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (!c || !c.alive) { S.ccol[i] = null; continue; }
      var col;
      try { col = countryColor(W, c, sel); } catch (e) { col = NEUTRAL; }
      S.ccol[i] = css(col);
    }
    S.ccol.length = cs.length;
  }

  // ------------------------------------------------------------------ render
  function render(W, now) {
    var ctx = S.ctx; if (!ctx) return;
    W = W || S.W;
    now = num(now, (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    stepView(now);
    var dpr = S.dpr, v = S.view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    ctx.fillStyle = S.ocean || '#08111f';
    ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);
    if (!W || !W.regions || !S.paths.length) return;
    var k = dpr * v.s, px = 1 / v.s; // px = one CSS pixel in map units
    ctx.setTransform(k, 0, 0, k, dpr * v.ox, dpr * v.oy);

    if (S.grat) { ctx.strokeStyle = 'rgba(110,150,210,0.07)'; ctx.lineWidth = px; ctx.stroke(S.grat); }

    refreshColors(W, now);
    var R = W.regions, cs = W.countries || [], i, r, p;
    // coast glow
    if (S.all) { ctx.strokeStyle = 'rgba(90,150,230,0.10)'; ctx.lineWidth = 5 * px; ctx.stroke(S.all); }
    var hatchOK = false;
    if (S.hatch && S.hatch.setTransform && typeof DOMMatrix === 'function') {
      try { S.hatch.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0])); hatchOK = true; } catch (e) { hatchOK = false; }
    }
    for (i = 0; i < R.length; i++) {
      r = R[i]; p = S.paths[i]; if (!r || !p) continue;
      var o = r.owner, col = (o >= 0 && o < cs.length) ? S.ccol[o] : null;
      if (!col) {
        ctx.fillStyle = css(ASH); ctx.fill(p, 'evenodd');
        if (hatchOK) { ctx.fillStyle = S.hatch; ctx.fill(p, 'evenodd'); }
        ctx.strokeStyle = 'rgba(200,205,215,0.35)'; ctx.lineWidth = 0.8 * px; ctx.stroke(p);
      } else {
        ctx.fillStyle = col; ctx.fill(p, 'evenodd');
        if (r.subN > 1) { ctx.strokeStyle = col; ctx.lineWidth = 0.9 * px; ctx.stroke(p); } // hide anti-aliasing seams between provinces
      }
      var dv = num(r.devastation, 0);
      if (dv > 0.03) { ctx.fillStyle = 'rgba(28,8,0,' + M.min(0.6, dv * 0.6).toFixed(3) + ')'; ctx.fill(p, 'evenodd'); }
    }
    if (S.all) { ctx.strokeStyle = 'rgba(5,8,14,0.85)'; ctx.lineWidth = 0.8 * px; ctx.stroke(S.all); }

    var pulse = 0.5 + 0.5 * M.sin(now / 260);
    if (S.ov.people) drawPeople(W, now);
    if (S.ov.alliances) drawAllianceLinks(W, px);
    if (S.ov.trade) drawTrade(W, now);
    if (S.ov.wars) drawWars(W, now, px, pulse);

    // hover & selection
    ctx.setTransform(k, 0, 0, k, dpr * v.ox, dpr * v.oy);
    var hr = R[S.hover];
    if (hr) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.3 * px;
      if (hr.owner >= 0 && cs[hr.owner]) strokeCountry(W, cs[hr.owner]); else if (S.paths[hr.id]) ctx.stroke(S.paths[hr.id]);
    }
    if (S.mode === 'spheres') {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.3 * px;
      for (i = 0; i < S.sphereList.length; i++) { var pcn = liveC(W, S.sphereList[i]); if (pcn) strokeCountry(W, pcn); }
    }
    var sel = liveC(W, num(W.selected, -1));
    if (sel) {
      ctx.shadowColor = 'rgba(255,205,90,0.9)'; ctx.shadowBlur = 12 * dpr;
      ctx.strokeStyle = 'rgba(255,214,110,' + (0.75 + 0.25 * pulse).toFixed(3) + ')'; ctx.lineWidth = 2.2 * px;
      strokeCountry(W, sel);
      ctx.shadowBlur = 0;
    } else {
      var dead = country(W, num(W.selected, -1));
      if (dead && !dead.alive && dead.lostRegions) {
        ctx.setLineDash([4 * px, 3 * px]); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.6 * px;
        strokeCountry(W, dead, dead.lostRegions);
        ctx.setLineDash([]);
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var selc = country(W, num(W.selected, -1));
    if (selc) {
      var area = 0, rs2 = selc.alive ? selc.regions : (selc.lostRegions || []);
      for (i = 0; i < rs2.length; i++) { var rr2 = R[rs2[i]]; if (rr2) area += num(rr2.area, 0); }
      var capR = R[selc.alive ? selc.capital : (rs2[0] === undefined ? -1 : rs2[0])];
      if (capR && area * v.s * v.s < 40) {
        var sx2 = (v.ox + capR.cx * v.s) * dpr, sy2 = (v.oy + capR.cy * v.s) * dpr;
        ctx.strokeStyle = 'rgba(255,214,110,' + (0.6 + 0.4 * pulse).toFixed(3) + ')'; ctx.lineWidth = 2 * dpr;
        ctx.beginPath(); ctx.arc(sx2, sy2, (7 + 3 * pulse) * dpr, 0, 6.2832); ctx.stroke();
      }
    }
    drawFx(now);
    drawFollow(W, now);
    if (S.ov.labels) drawLabels(W, now);
  }

  // outline a country; a fully held subdivided shape is stroked as one outline (no province cut lines)
  function strokeCountry(W, c, list) {
    var rs = list || c.regions || [], R = W.regions, done = null;
    for (var i = 0; i < rs.length; i++) {
      var r = R[rs[i]]; if (!r) continue;
      if (r.subN > 1 && S.gpaths[r.group]) {
        if (done && done[r.group]) continue;
        var whole = true;
        for (var k = 0; k < R.length && whole; k++) { var q = R[k]; if (q.group === r.group && q.subN > 1 && rs.indexOf(k) < 0) whole = false; }
        if (whole) { (done || (done = {}))[r.group] = 1; S.ctx.stroke(S.gpaths[r.group]); continue; }
      }
      var p = S.paths[rs[i]]; if (p) S.ctx.stroke(p);
    }
  }
  function capXY(W, cid) {
    var c = country(W, cid); if (!c) return null;
    var r = W.regions[c.capital];
    if (!r && c.regions && c.regions.length) r = W.regions[c.regions[0]];
    return r ? [r.cx, r.cy] : null;
  }

  // ---- people
  function drawPeople(W, now) {
    var P = W.people; if (!P || !P.alive || !P.x) return;
    var n = P.n | 0, ctx = S.ctx, dpr = S.dpr, v = S.view;
    var interval = n > 15000 ? 50 : 20;
    if (S.pDirty || now - S.pT >= interval || !S.pView) { drawPeopleLayer(W, P, n); S.pT = now; S.pDirty = false; }
    // dim the map so dots read clearly
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(3,6,12,0.42)'; ctx.fillRect(0, 0, S.canvas.width, S.canvas.height);
    var pv = S.pView, kk = v.s / pv.s;
    var dx = dpr * (v.ox - pv.ox * kk), dy = dpr * (v.oy - pv.oy * kk);
    ctx.drawImage(S.pcan, dx, dy, S.pcan.width * kk, S.pcan.height * kk);
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.ox, dpr * v.oy);
  }
  var DOT_U32 = null;
  function dotColorsU32() {
    if (DOT_U32) return DOT_U32;
    var le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    DOT_U32 = new Uint32Array(DOT_COLS.length);
    for (var i = 0; i < DOT_COLS.length; i++) {
      var h = DOT_COLS[i], r = parseInt(h.substr(1, 2), 16), g = parseInt(h.substr(3, 2), 16), b = parseInt(h.substr(5, 2), 16);
      DOT_U32[i] = le ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
    }
    return DOT_U32;
  }
  // Writes dots straight into an ImageData buffer (far cheaper than ~40k fillRect calls). Two passes so that
  // special states (soldiers, refugees, infected, protesters, rebels) are painted on top of ordinary citizens.
  function drawPeopleLayer(W, P, n) {
    var c = S.pctx, w = S.pcan.width, h = S.pcan.height, dpr = S.dpr, v = S.view;
    S.pView = { s: v.s, ox: v.ox, oy: v.oy };
    if (!S.pimg || S.pimg.width !== w || S.pimg.height !== h) {
      try { S.pimg = c.createImageData(w, h); S.pbuf = new Uint32Array(S.pimg.data.buffer); } catch (e) { S.pimg = null; }
    }
    if (!S.pimg) return;
    var buf = S.pbuf; buf.fill(0);
    var cols = dotColorsU32();
    var alive = P.alive, X = P.x, Y = P.y, flags = P.flags, job = P.job, happy = P.happy, inf = P.infect;
    var s = v.s * dpr, ox = v.ox * dpr, oy = v.oy * dpr;
    var size = M.max(1, M.round(clamp(0.75 + 0.55 * M.sqrt(v.s / S.sFit), 1, 3.6) * dpr)), off = (size / 2) | 0;
    var wm = w - size, hm = h - size;
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < n; i++) {
        if (!alive[i]) continue;
        var f = flags ? flags[i] : 0, j = job ? job[i] : 0, b;
        if (inf && inf[i] === 1) b = 5;
        else if (f & 1) b = 6;
        else if (j === 8) b = 7;
        else if (f & 2) b = 4;
        else if (j === 6 || (f & 4)) b = 3;
        else b = -1;
        if (pass === 0) { if (b >= 0) continue; var hh = happy ? happy[i] : 0.5; b = hh < 0.38 ? 0 : (hh < 0.66 ? 1 : 2); }
        else if (b < 0) continue;
        var x0 = (ox + X[i] * s - off) | 0, y0 = (oy + Y[i] * s - off) | 0;
        if (x0 < 0 || y0 < 0 || x0 > wm || y0 > hm) continue;
        var col = cols[b], row = y0 * w + x0;
        if (size === 1) { buf[row] = col; continue; }
        for (var yy = 0; yy < size; yy++) { var o = row + yy * w; for (var xx = 0; xx < size; xx++) buf[o + xx] = col; }
      }
    }
    c.putImageData(S.pimg, 0, 0);
  }

  // ---- alliances
  function drawAllianceLinks(W, px) {
    var A = W.alliances || [], ctx = S.ctx, v = S.view, dpr = S.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 1.2 * dpr;
    for (var a = 0; a < A.length; a++) {
      var al = A[a]; if (!al || al.dissolved || !al.members || al.members.length < 2) continue;
      var L = liveC(W, al.leader) ? al.leader : al.members[0];
      var lp = capXY(W, L); if (!lp) continue;
      var lx = (v.ox + lp[0] * v.s) * dpr, ly = (v.oy + lp[1] * v.s) * dpr;
      ctx.strokeStyle = css(al.color || [150, 150, 150], al.type === 'defense' ? 0.6 : 0.35);
      if (al.type !== 'defense') ctx.setLineDash([4 * dpr, 4 * dpr]); else ctx.setLineDash([]);
      ctx.beginPath();
      for (var m = 0; m < al.members.length; m++) {
        var id = al.members[m]; if (id === L || !liveC(W, id)) continue;
        var mp = capXY(W, id); if (!mp) continue;
        ctx.moveTo(lx, ly); ctx.lineTo((v.ox + mp[0] * v.s) * dpr, (v.oy + mp[1] * v.s) * dpr);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css(al.color || [150, 150, 150], 0.95);
      ctx.beginPath(); ctx.arc(lx, ly, 3.5 * dpr, 0, 6.2832); ctx.fill();
    }
    ctx.setLineDash([]);
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.ox, dpr * v.oy);
  }

  // ---- trade
  function computeTrade(W) {
    var T = W.trade, NC = W.NC | 0, cs = W.countries || [], n = cs.length, top = [], K = 60, minV = 0;
    if (!T || !NC) { S.trade = top; return; }
    for (var a = 0; a < n; a++) {
      var ca = cs[a]; if (!ca || !ca.alive) continue;
      var ra = a * NC;
      for (var b = a + 1; b < n; b++) {
        var cb = cs[b]; if (!cb || !cb.alive) continue;
        var ab = num(T[ra + b], 0), ba = num(T[b * NC + a], 0), vv = ab + ba;
        if (!(vv > minV) && top.length >= K) continue;
        if (!(vv > 0)) continue;
        var it = { a: ab >= ba ? a : b, b: ab >= ba ? b : a, v: vv };
        var pos = top.length;
        while (pos > 0 && top[pos - 1].v < vv) pos--;
        top.splice(pos, 0, it);
        if (top.length > K) top.length = K;
        if (top.length >= K) minV = top[top.length - 1].v;
      }
    }
    S.trade = top;
  }
  function drawTrade(W, now) {
    if (now - S.tradeT > 1000) { S.tradeT = now; computeTrade(W); }
    var ctx = S.ctx, v = S.view, dpr = S.dpr, top = S.trade;
    if (!top.length) return;
    var vmax = top[0].v || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = 'round';
    for (var i = top.length - 1; i >= 0; i--) {
      var f = top[i], A = capXY(W, f.a), B = capXY(W, f.b); if (!A || !B) continue;
      var ax = (v.ox + A[0] * v.s) * dpr, ay = (v.oy + A[1] * v.s) * dpr, bx = (v.ox + B[0] * v.s) * dpr, by = (v.oy + B[1] * v.s) * dpr;
      var mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay;
      var cx = mx - dy * 0.2, cy = my + dx * 0.2;
      var rel = M.sqrt(f.v / vmax);
      ctx.lineWidth = (0.6 + 4.2 * rel) * dpr;
      ctx.strokeStyle = 'rgba(255,200,100,' + (0.18 + 0.4 * rel).toFixed(3) + ')';
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); ctx.stroke();
      // flowing dashes show net direction
      ctx.lineWidth = M.max(1, (0.4 + 1.6 * rel)) * dpr;
      ctx.strokeStyle = 'rgba(255,240,200,' + (0.35 + 0.4 * rel).toFixed(3) + ')';
      ctx.setLineDash([2 * dpr, 14 * dpr]); ctx.lineDashOffset = -(now / 40) * dpr;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.lineCap = 'butt';
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.ox, dpr * v.oy);
  }

  // ---- wars
  function activeWars(W) {
    try { if (GS.War && GS.War.active) { var a = GS.War.active(W); if (Array.isArray(a)) return a; } } catch (e) { /* fall through */ }
    var out = [], ws = W.wars || [];
    for (var i = 0; i < ws.length; i++) if (ws[i] && !ws[i].ended) out.push(ws[i]);
    return out;
  }
  function drawWars(W, now, px, pulse) {
    var ctx = S.ctx, v = S.view, dpr = S.dpr, cs = W.countries || [], R = W.regions, wars = activeWars(W), i, k;
    var n = cs.length;
    if (!S.mark || S.mark.length < n) S.mark = new Uint8Array(n + 64);
    if (!S.rmark || S.rmark.length < R.length) S.rmark = new Uint8Array(R.length);
    var mark = S.mark, rmark = S.rmark; mark.fill(0); rmark.fill(0);
    ctx.setTransform(dpr * v.s, 0, 0, dpr * v.s, dpr * v.ox, dpr * v.oy);
    // civil wars
    for (i = 0; i < n; i++) {
      var c = cs[i]; if (!c || !c.alive || !c.civilWar) continue;
      var held = c.civilWar.regionHeld || [];
      ctx.fillStyle = 'rgba(255,140,40,' + (0.16 + 0.18 * pulse).toFixed(3) + ')';
      for (k = 0; k < held.length; k++) { var hp = S.paths[held[k]]; if (hp) ctx.fill(hp, 'evenodd'); }
      ctx.setLineDash([5 * px, 4 * px]); ctx.strokeStyle = 'rgba(255,150,60,0.85)'; ctx.lineWidth = 1.4 * px;
      strokeCountry(W, c); ctx.setLineDash([]);
    }
    if (!wars.length) return;
    for (var w = 0; w < wars.length; w++) {
      var war = wars[w], at = war.attackers || [], de = war.defenders || [];
      for (k = 0; k < at.length; k++) if (at[k] >= 0 && at[k] < n) mark[at[k]] |= 1;
      for (k = 0; k < de.length; k++) if (de[k] >= 0 && de[k] < n) mark[de[k]] |= 2;
      var ct = war.contested || [];
      for (k = 0; k < ct.length; k++) if (ct[k] >= 0 && ct[k] < R.length) rmark[ct[k]] = 1;
    }
    ctx.fillStyle = 'rgba(255,36,36,' + (0.16 + 0.26 * pulse).toFixed(3) + ')';
    for (i = 0; i < R.length; i++) if (rmark[i] && S.paths[i]) ctx.fill(S.paths[i], 'evenodd');
    ctx.lineWidth = 1.5 * px;
    for (i = 0; i < n; i++) {
      if (!mark[i] || !cs[i] || !cs[i].alive) continue;
      ctx.strokeStyle = (mark[i] & 1) ? 'rgba(255,72,72,0.85)' : 'rgba(255,160,70,0.85)';
      strokeCountry(W, cs[i]);
    }
    // arrows from attacker capital to contested defender regions
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineCap = 'round';
    for (w = 0; w < wars.length; w++) {
      var wr = wars[w], A = capXY(W, wr.attackerLeader); if (!A) continue;
      var dset = wr.defenders || [], cont = wr.contested || [], drawn = 0;
      var ax = (v.ox + A[0] * v.s) * dpr, ay = (v.oy + A[1] * v.s) * dpr;
      for (k = 0; k < cont.length && drawn < 3; k++) {
        var rr = R[cont[k]]; if (!rr || dset.indexOf(rr.owner) < 0) continue;
        var bx = (v.ox + rr.cx * v.s) * dpr, by = (v.oy + rr.cy * v.s) * dpr;
        if (M.abs(bx - ax) + M.abs(by - ay) < 14 * dpr) continue;
        arrow(ctx, ax, ay, bx, by, dpr, pulse);
        drawn++;
      }
      if (!drawn) {
        var D = capXY(W, wr.defenderLeader);
        if (D) arrow(ctx, ax, ay, (v.ox + D[0] * v.s) * dpr, (v.oy + D[1] * v.s) * dpr, dpr, pulse);
      }
    }
    ctx.lineCap = 'butt';
    // crossed swords at contested regions
    var fs = M.round(clamp(9 + 3 * M.sqrt(v.s / S.sFit), 10, 20) * dpr);
    ctx.font = fs + 'px "Segoe UI Symbol","Apple Symbols","Noto Sans Symbols",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4 * dpr;
    ctx.fillStyle = '#ffe3d6';
    var drawnS = 0;
    for (i = 0; i < R.length && drawnS < 80; i++) {
      if (!rmark[i]) continue;
      var sx = (v.ox + R[i].cx * v.s) * dpr, sy = (v.oy + R[i].cy * v.s) * dpr;
      if (sx < 0 || sy < 0 || sx > S.canvas.width || sy > S.canvas.height) continue;
      ctx.fillText('⚔', sx, sy); drawnS++;
    }
    ctx.shadowBlur = 0;
  }
  function arrow(ctx, ax, ay, bx, by, dpr, pulse) {
    var dx = bx - ax, dy = by - ay, len = M.sqrt(dx * dx + dy * dy) || 1;
    var cx = (ax + bx) / 2 - dy * 0.18, cy = (ay + by) / 2 + dx * 0.18;
    var ex = bx - (bx - cx) / M.max(1, M.sqrt((bx - cx) * (bx - cx) + (by - cy) * (by - cy))) * 4 * dpr;
    var ey = by - (by - cy) / M.max(1, M.sqrt((bx - cx) * (bx - cx) + (by - cy) * (by - cy))) * 4 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 4.5 * dpr;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,' + M.round(60 + 60 * pulse) + ',60,0.95)'; ctx.lineWidth = 2.2 * dpr;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
    var ang = M.atan2(by - cy, bx - cx), h = M.min(11, 5 + len * 0.04) * dpr;
    ctx.fillStyle = 'rgba(255,90,70,0.98)';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - h * M.cos(ang - 0.45), by - h * M.sin(ang - 0.45));
    ctx.lineTo(bx - h * M.cos(ang + 0.45), by - h * M.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }

  // ---- labels
  function computeLabels(W) {
    var cs = W.countries || [], out = [], R = W.regions;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i]; if (!c || !c.alive) continue;
      var lp = labelPoint(W, c); if (!lp) continue;
      // importance: area, but populous nations and great powers rank up (India must be labelled)
      var imp = M.max(lp.area, M.sqrt(M.max(0, num(c.pop, 0)) / 1e6) * 900 * (c.greatPower ? 1.5 : 1));
      out.push({ id: i, x: lp.x, y: lp.y, a: imp, name: String(c.name || '?') });
      // other clusters of land it holds (conquered / settled shapes): smaller secondary labels
      var groups = {}, home = lp.group;
      for (var k = 0; k < c.regions.length; k++) {
        var r = R[c.regions[k]]; if (!r) continue;
        var g = num(r.group, r.id); if (g === home) continue;
        var e = groups[g] || (groups[g] = { a: 0, x: 0, y: 0, best: 0 });
        e.a += num(r.area, 0);
        if (num(r.area, 0) > e.best) { e.best = num(r.area, 0); e.x = r.cx; e.y = r.cy; }
      }
      for (var gk in groups) {
        var ge = groups[gk]; if (ge.a < 2500) continue;
        var occ = R[+gk] && R[+gk].core !== c.id;
        out.push({ id: i, x: ge.x, y: ge.y, a: ge.a * 0.6, name: String(c.name || '?') + (occ ? ' (occ.)' : ''), sec: true });
      }
    }
    out.sort(function (a, b) { return b.a - a.a; });
    S.labels = out;
  }
  var placed = [];
  function drawLabels(W, now) {
    if (now - S.labelT > 700) { S.labelT = now; computeLabels(W); }
    var ctx = S.ctx, v = S.view, dpr = S.dpr, L = S.labels, sel = num(W.selected, -1);
    placed.length = 0;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    var cs = W.countries || [];
    for (var i = 0; i < L.length; i++) {
      var l = L[i], c = cs[l.id]; if (!c || !c.alive) continue;
      var fsz = M.sqrt(l.a) * v.s * 0.15;
      var isSel = l.id === sel && !l.sec;
      if (fsz < 8.5 && !isSel) continue;
      fsz = clamp(fsz, isSel ? 11 : 8.5, l.sec ? 13 : 21);
      var sx = v.ox + l.x * v.s, sy = v.oy + l.y * v.s;
      var name = l.name;
      var wdt = name.length * fsz * 0.58, hgt = fsz * 1.1;
      var x0 = sx - wdt / 2, y0 = sy - hgt / 2, ok = true;
      if (x0 < 2 || y0 < 2 || x0 + wdt > S.cw - 2 || y0 + hgt > S.ch - 2) continue; // never clip a label at the edge
      if (!isSel) for (var q = 0; q < placed.length; q += 4) {
        if (x0 < placed[q + 2] && x0 + wdt > placed[q] && y0 < placed[q + 3] && y0 + hgt > placed[q + 1]) { ok = false; break; }
      }
      if (!ok) continue;
      placed.push(x0, y0, x0 + wdt, y0 + hgt);
      ctx.font = (l.sec ? 'italic 500 ' : (fsz > 13 ? '650 ' : '500 ')) + M.round(fsz * dpr) + 'px -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(4,7,14,0.78)';
      ctx.strokeText(name, sx * dpr, sy * dpr);
      ctx.fillStyle = isSel ? '#ffe39a' : (c.atWar ? 'rgba(255,205,200,0.95)' : 'rgba(235,240,250,0.88)');
      ctx.fillText(name, sx * dpr, sy * dpr);
    }
  }

  // ---- follow ring & fx
  function drawFollow(W, now) {
    var i = S.follow, P = W.people; if (i < 0 || !P || !P.x || i >= (P.n | 0)) return;
    var ctx = S.ctx, v = S.view, dpr = S.dpr;
    var sx = (v.ox + P.x[i] * v.s) * dpr, sy = (v.oy + P.y[i] * v.s) * dpr;
    if (!(sx === sx)) return;
    var alive = !!P.alive[i], t = now / 300;
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = alive ? 'rgba(255,214,110,0.95)' : 'rgba(170,170,170,0.8)';
    ctx.beginPath(); ctx.arc(sx, sy, (8 + 2.5 * M.sin(t)) * dpr, 0, 6.2832); ctx.stroke();
    ctx.lineWidth = 1 * dpr; ctx.strokeStyle = alive ? 'rgba(255,214,110,0.45)' : 'rgba(170,170,170,0.4)';
    ctx.beginPath(); ctx.arc(sx, sy, (15 + 3 * M.sin(t + 1.5)) * dpr, 0, 6.2832); ctx.stroke();
    ctx.fillStyle = alive ? '#fff3c4' : '#999';
    ctx.fillRect(sx - 1.5 * dpr, sy - 1.5 * dpr, 3 * dpr, 3 * dpr);
    if (!alive) {
      ctx.font = M.round(11 * dpr) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('✝', sx, sy - 18 * dpr);
    }
  }
  function flash(regionId, kind) {
    var W = S.W; if (!W || !W.regions) return;
    var r = W.regions[regionId]; if (!r) return;
    var col = { meteor: [255, 150, 60], nuke: [255, 250, 210], plague: [150, 255, 80], disaster: [120, 200, 255], war: [255, 60, 60] }[kind] || [255, 214, 110];
    var now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    S.fx.push({ x: r.cx, y: r.cy, t0: now, dur: 1600, col: col, big: kind === 'nuke' || kind === 'meteor' });
    if (S.fx.length > 30) S.fx.shift();
  }
  function drawFx(now) {
    var ctx = S.ctx, v = S.view, dpr = S.dpr, fx = S.fx;
    for (var i = fx.length - 1; i >= 0; i--) {
      var f = fx[i], t = (now - f.t0) / f.dur;
      if (t >= 1 || t < 0) { fx.splice(i, 1); continue; }
      var sx = (v.ox + f.x * v.s) * dpr, sy = (v.oy + f.y * v.s) * dpr, e = 1 - M.pow(1 - t, 3);
      var rad = (f.big ? 90 : 55) * e * dpr;
      if (f.big && t < 0.25) {
        var g = ctx.createRadialGradient(sx, sy, 0, sx, sy, 60 * dpr);
        g.addColorStop(0, css(f.col, 0.9 * (1 - t / 0.25))); g.addColorStop(1, css(f.col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx, sy, 60 * dpr, 0, 6.2832); ctx.fill();
      }
      ctx.lineWidth = (3 - 2 * t) * dpr; ctx.strokeStyle = css(f.col, (1 - t) * 0.95);
      ctx.beginPath(); ctx.arc(sx, sy, rad, 0, 6.2832); ctx.stroke();
      ctx.lineWidth = 1.2 * dpr; ctx.strokeStyle = css(f.col, (1 - t) * 0.5);
      ctx.beginPath(); ctx.arc(sx, sy, rad * 0.6, 0, 6.2832); ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ legend
  function grad(stops) { return stops.map(function (s) { return css(s); }); }
  function legend(W) {
    var mode = S.mode, out = { title: '', items: [], gradient: null, note: '' };
    var sel = W ? liveC(W, num(W.selected, -1)) : null, i;
    switch (mode) {
      case 'political':
        out.title = 'Political';
        out.items.push({ color: css(ASH), label: 'Ungoverned land', hatch: true });
        out.note = 'Each nation in its own colour.';
        break;
      case 'alliances': {
        out.title = 'Blocs & alliances';
        var A = (W && W.alliances) || [], list = [];
        for (i = 0; i < A.length; i++) { var a = A[i]; if (a && !a.dissolved && a.members && a.members.length >= 2) list.push(a); }
        list.sort(function (x, y) { return (x.type === 'defense' ? 0 : 1) - (y.type === 'defense' ? 0 : 1) || y.members.length - x.members.length; });
        for (i = 0; i < list.length && i < 9; i++) out.items.push({ color: css(list[i].color), label: list[i].name + ' (' + list[i].members.length + ')' });
        out.items.push({ color: css(NEUTRAL), label: 'Non-aligned' });
        out.note = 'Coloured by defence bloc first, then economic/political.';
        break;
      }
      case 'spheres': {
        out.title = 'Spheres of influence';
        var cs = (W && W.countries) || [], pl = S.sphereList || [];
        for (i = 0; i < pl.length && i < 10; i++) if (liveC(W, pl[i])) out.items.push({ color: css(S.sphereCol[pl[i]] || NEUTRAL), label: cs[pl[i]].name + ' +' + S.sphere[pl[i]] });
        if (pl.length > 10) out.items.push({ color: css([150, 150, 160]), label: '+' + (pl.length - 10) + ' smaller spheres' });
        out.items.push({ color: css(SPH_IND), label: 'Independent (no patron, no clients)' });
        out.note = 'Clients take their patron’s colour; patrons are outlined in white.';
        break;
      }
      case 'relations':
        out.title = 'Relations' + (sel ? ' with ' + sel.name : '');
        out.gradient = { css: grad(DIV), labels: ['Hostile', 'Neutral', 'Friendly'] };
        out.items.push({ color: css([233, 185, 73]), label: sel ? sel.name : 'Selected' }, { color: css([150, 14, 26]), label: 'At war' });
        if (!sel) out.note = 'Select a country to see its relations.';
        break;
      case 'stability':
        out.title = 'Unrest';
        out.gradient = { css: grad(SEQ_UNREST), labels: ['Calm', 'Tense', 'Boiling'] };
        out.items.push({ color: css([120, 10, 34]), label: 'Civil war' });
        break;
      case 'economy':
        out.title = 'GDP growth (annual)';
        out.gradient = { css: grad(DIV), labels: ['−8%', '0%', '+8%'] };
        break;
      case 'wealth':
        out.title = 'GDP per capita';
        out.gradient = { css: grad(SEQ_WEALTH), labels: ['$500', '$7k', '$100k'] };
        break;
      case 'government': {
        out.title = 'Government';
        for (i = 0; i < GOV_ORDER.length; i++) {
          var g = GOV_ORDER[i], lab = g;
          try { var gi = GS.Politics && GS.Politics.govInfo ? GS.Politics.govInfo(g) : null; if (gi && gi.label) lab = gi.label; } catch (e) { /* ignore */ }
          out.items.push({ color: css(GOV_COL[g]), label: lab });
        }
        break;
      }
      case 'plague':
        out.title = 'Infected share';
        out.gradient = { css: grad(SEQ_PLAGUE), labels: ['0%', '7%', '30%+'] };
        break;
    }
    out.lines = [];
    if (S.ov.wars) {
      out.lines.push({ color: 'rgba(255,150,60,0.9)', dash: true, label: 'Civil war (dashed; rebel land glows)' });
      out.lines.push({ color: 'rgba(255,72,72,0.9)', label: 'Attacker' });
      out.lines.push({ color: 'rgba(255,160,70,0.9)', label: 'Defender' });
      out.lines.push({ color: 'rgba(255,36,36,0.55)', fill: true, label: 'Contested region · arrow = offensive' });
    }
    if (S.ov.trade) out.lines.push({ color: 'rgba(255,200,100,0.8)', label: 'Trade: width = value, dots → importer' });
    if (S.ov.alliances) {
      out.lines.push({ color: 'rgba(130,180,255,0.9)', label: 'Defence pact / alliance link' });
      out.lines.push({ color: 'rgba(130,180,255,0.9)', dash: true, label: 'Economic / political bloc link' });
    }
    if (S.ov.people) {
      out.dots = [];
      for (i = 0; i < DOT_COLS.length; i++) out.dots.push({ color: DOT_COLS[i], label: DOT_LABELS[i] });
    }
    return out;
  }

  // ------------------------------------------------------------------ public
  GS.MapView = {
    MODES: MODES,
    OVERLAYS: OVERLAYS,
    init: init,
    setWorld: setWorld,
    render: render,
    resize: resize,
    setMode: function (m) { for (var i = 0; i < MODES.length; i++) if (MODES[i].id === m) { S.mode = m; S.ccolDirty = true; S.sphereT = -1e9; } },
    getMode: function () { return S.mode; },
    setOverlay: function (name, on) { if (S.ov.hasOwnProperty(name)) { S.ov[name] = !!on; S.pDirty = true; S.tradeT = -1e9; } },
    toggleOverlay: function (name) { if (S.ov.hasOwnProperty(name)) { S.ov[name] = !S.ov[name]; S.pDirty = true; S.tradeT = -1e9; } return !!S.ov[name]; },
    getOverlays: function () { var o = {}; for (var k in S.ov) o[k] = S.ov[k]; return o; },
    regionAt: regionAt,
    screenToMap: screenToMap,
    mapToScreen: mapToScreen,
    centerOn: centerOn,
    reveal: reveal,
    zoomBy: zoomBy,
    resetView: function () { resetView(false); },
    follow: function (i) { S.follow = (typeof i === 'number' && i >= 0) ? i : -1; },
    getFollow: function () { return S.follow; },
    flash: flash,
    legend: legend,
    invalidate: function () { S.ccolDirty = true; S.pDirty = true; S.labelT = -1e9; S.tradeT = -1e9; S.sphereT = -1e9; },
    getHover: function () { return S.hover; }
  };
})();
