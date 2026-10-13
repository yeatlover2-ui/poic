/* GODSIM core.js \u2014 constants, RNG, utils, geography (TopoJSON decode + Miller projection), names, dates.
 * Classic script, no DOM. Defines: GS.CONST, GS.RNG, GS.U, GS.Geo, GS.Names, GS.dateOf */
(function () {
  'use strict';
  var GS = globalThis.GS = globalThis.GS || {};

  // ------------------------------------------------------------------ CONST
  GS.CONST = {
    MAP_W: 3600,
    MAP_H: 0, // filled below (== GS.Geo.MAP_H)
    AGENTS_TOTAL: 40000,
    AGENTS_MIN_PER_COUNTRY: 30,
    START: { y: 2026, m: 10, d: 13 },
    DAYS_PER_TICK: 7,
    TICKS_PER_YEAR: 52,
    JOBS: { CHILD: 0, UNEMPLOYED: 1, FARM: 2, INDUSTRY: 3, SERVICES: 4, GOV: 5, MILITARY: 6, RETIRED: 7, REBEL: 8 },
    GOVS: ['democracy', 'flawed_democracy', 'hybrid', 'autocracy', 'oneparty', 'theocracy', 'monarchy', 'junta', 'anarchy']
  };

  // ------------------------------------------------------------------ RNG (mulberry32)
  function hashStr(s) {
    s = String(s);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  var _wbuf = new Float64Array(256);

  function RNG(seed) {
    if (!(this instanceof RNG)) return new RNG(seed);
    var s;
    if (typeof seed === 'string') s = hashStr(seed);
    else if (typeof seed === 'number' && isFinite(seed)) s = Math.floor(Math.abs(seed)) >>> 0;
    else s = 0x9E3779B9;
    this.seed = seed;
    this.s = s | 0;
    this._spare = NaN;
  }
  RNG.prototype.next = function () {
    var t = (this.s = (this.s + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  RNG.prototype.int = function (n) { n = n | 0; return n > 0 ? Math.floor(this.next() * n) : 0; };
  RNG.prototype.normal = function () {
    if (this._spare === this._spare) { var sp = this._spare; this._spare = NaN; return sp; }
    var u = 0, v = 0;
    while (u <= 1e-12) u = this.next();
    v = this.next();
    var r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
    this._spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
  RNG.prototype.pick = function (arr) { return (arr && arr.length) ? arr[Math.floor(this.next() * arr.length)] : undefined; };
  RNG.prototype.chance = function (p) { return this.next() < p; };
  RNG.prototype.weighted = function (arr, weightFn) {
    if (!arr || !arr.length) return undefined;
    if (typeof weightFn !== 'function') return this.pick(arr);
    var n = arr.length;
    if (_wbuf.length < n) _wbuf = new Float64Array(Math.max(n, _wbuf.length * 2));
    var tot = 0;
    for (var i = 0; i < n; i++) {
      var w = +weightFn(arr[i], i);
      if (!(w > 0) || w === Infinity) w = 0;
      _wbuf[i] = w; tot += w;
    }
    if (!(tot > 0)) return this.pick(arr);
    var r = this.next() * tot;
    for (var j = 0; j < n; j++) { r -= _wbuf[j]; if (r < 0) return arr[j]; }
    for (var k = n - 1; k >= 0; k--) if (_wbuf[k] > 0) return arr[k];
    return arr[n - 1];
  };
  RNG.prototype.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(this.next() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  };
  RNG.prototype.getState = function () { return this.s; };
  RNG.prototype.setState = function (s) { this.s = s | 0; this._spare = NaN; };
  GS.RNG = RNG;

  // ------------------------------------------------------------------ Utils
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : (x === x ? x : a)); }
  function fix3(v) { var a = Math.abs(v); return a >= 100 ? v.toFixed(0) : (a >= 10 ? v.toFixed(1) : v.toFixed(2)); }
  GS.U = {
    clamp: clamp,
    lerp: function (a, b, t) { return a + (b - a) * t; },
    sigmoid: function (x) { if (x > 40) return 1; if (x < -40) return 0; var r = 1 / (1 + Math.exp(-x)); return r === r ? r : 0.5; },
    smooth: function (old, target, rate) { return old + (target - old) * rate; },
    safe: function (x, fallback) { return (typeof x === 'number' && isFinite(x)) ? x : (fallback === undefined ? 0 : fallback); },
    hashStr: hashStr,
    fmtMoney: function (b) {
      b = +b; if (!isFinite(b)) b = 0;
      var s = b < 0 ? '-' : ''; b = Math.abs(b);
      if (b >= 1000) return s + '$' + fix3(b / 1000) + 'T';
      if (b >= 1) return s + '$' + fix3(b) + 'B';
      if (b >= 0.001) return s + '$' + fix3(b * 1000) + 'M';
      return s + '$' + fix3(b * 1e6) + 'K';
    },
    fmtNum: function (n) {
      n = +n; if (!isFinite(n)) n = 0;
      var s = n < 0 ? '-' : ''; n = Math.abs(n);
      if (n >= 1e9) return s + fix3(n / 1e9) + 'B';
      if (n >= 1e6) return s + fix3(n / 1e6) + 'M';
      if (n >= 1e3) return s + fix3(n / 1e3) + 'K';
      return s + Math.round(n);
    },
    fmtPct: function (x, digits) { x = +x; if (!isFinite(x)) x = 0; return (x * 100).toFixed(digits === undefined ? 1 : digits) + '%'; },
    // h in degrees [0,360) (values in 0..1 are NOT rescaled), s,l in 0..1 \u2192 [r,g,b] ints 0..255
    hsl: function (h, s, l) {
      h = ((+h % 360) + 360) % 360 / 360; s = clamp(+s, 0, 1); l = clamp(+l, 0, 1);
      if (h !== h) h = 0;
      function f(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
      var r, g, b;
      if (s === 0) { r = g = b = l; } else {
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
      }
      return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    },
    mean: function (arr) { if (!arr || !arr.length) return 0; var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; var m = s / arr.length; return isFinite(m) ? m : 0; },
    sum: function (arr) { var s = 0; if (arr) for (var i = 0; i < arr.length; i++) s += arr[i]; return s; }
  };

  // ------------------------------------------------------------------ Dates
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var START_MS = Date.UTC(2026, 9, 13);
  GS.dateOf = function (tick) {
    tick = +tick; if (!isFinite(tick)) tick = 0;
    var dt = new Date(START_MS + Math.round(tick * 7) * 86400000);
    var y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    return { y: y, m: m, d: d, str: MONTHS[m - 1] + ' ' + y, full: d + ' ' + MONTHS[m - 1] + ' ' + y };
  };

  // ------------------------------------------------------------------ Geography
  var W = GS.CONST.MAP_W, DEG = Math.PI / 180;
  function M(latDeg) {
    var la = latDeg; if (la > 89.5) la = 89.5; if (la < -89.5) la = -89.5;
    return 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * la * DEG));
  }
  var M84 = M(84);
  var K = W / (2 * Math.PI);
  function projX(lon) { return (lon + 180) / 360 * W; }
  function projY(lat) { return (M84 - M(lat)) * K; }
  function unprojLat(y) { var m = M84 - y / K; return (2.5 * (Math.atan(Math.exp(m / 1.25)) - Math.PI / 4)) / DEG; }
  function unprojLon(x) { return x / W * 360 - 180; }
  var MAP_H = projY(-60);
  GS.CONST.MAP_H = MAP_H;

  // returns [x,y] with .x/.y aliases
  function project(lon, lat) { var x = projX(+lon || 0), y = projY(+lat || 0); var p = [x, y]; p.x = x; p.y = y; return p; }
  function unproject(x, y) { var lon = unprojLon(+x || 0), lat = unprojLat(+y || 0); var p = [lon, lat]; p.lon = lon; p.lat = lat; return p; }

  function ringArea(r) { // signed shoelace (ring implicitly closed)
    var a = 0, n = r.length;
    for (var i = 0, j = n - 1; i < n; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return a / 2;
  }
  function polyArea(poly) {
    if (!poly.length) return 0;
    var a = Math.abs(ringArea(poly[0]));
    for (var i = 1; i < poly.length; i++) a -= Math.abs(ringArea(poly[i]));
    return a > 0 ? a : Math.abs(ringArea(poly[0])) * 0.1;
  }
  function ringContains(r, x, y) {
    var inside = false, n = r.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function polyContains(poly, x, y) { // even-odd over rings of one poly
    var inside = false;
    for (var k = 0; k < poly.length; k++) if (ringContains(poly[k], x, y)) inside = !inside;
    return inside;
  }
  function bboxOf(rings, out) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var k = 0; k < rings.length; k++) {
      var r = rings[k];
      for (var i = 0; i < r.length; i++) {
        var x = r[i][0], y = r[i][1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (!isFinite(x0)) { x0 = y0 = x1 = y1 = 0; }
    out = out || []; out[0] = x0; out[1] = y0; out[2] = x1; out[3] = y1; return out;
  }
  function segDist2(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = 0;
    if (l2 > 0) { t = ((px - ax) * dx + (py - ay) * dy) / l2; if (t < 0) t = 0; else if (t > 1) t = 1; }
    var ex = ax + t * dx - px, ey = ay + t * dy - py;
    return ex * ex + ey * ey;
  }
  function edgeDist2(poly, x, y) {
    var best = Infinity;
    for (var k = 0; k < poly.length; k++) {
      var r = poly[k], n = r.length;
      for (var i = 0, j = n - 1; i < n; j = i++) {
        var d = segDist2(x, y, r[j][0], r[j][1], r[i][0], r[i][1]);
        if (d < best) best = d;
      }
    }
    return best;
  }
  // Sutherland\u2013Hodgman clip of a ring against x >= lo (keepGreater) or x <= hi
  function clipX(ring, v, keepGreater) {
    var out = [], n = ring.length;
    if (!n) return out;
    for (var i = 0; i < n; i++) {
      var a = ring[(i + n - 1) % n], b = ring[i];
      var ain = keepGreater ? a[0] >= v : a[0] <= v;
      var bin = keepGreater ? b[0] >= v : b[0] <= v;
      if (bin) {
        if (!ain) out.push(interX(a, b, v));
        out.push(b);
      } else if (ain) out.push(interX(a, b, v));
    }
    return out;
  }
  function interX(a, b, v) { var dx = b[0] - a[0]; var t = dx !== 0 ? (v - a[0]) / dx : 0; return [v, a[1] + (b[1] - a[1]) * t]; }
  // same clip along either axis (ax 0 = x, 1 = y)
  function clipA(ring, v, keepGreater, ax) {
    var out = [], n = ring.length;
    if (!n) return out;
    for (var i = 0; i < n; i++) {
      var a = ring[(i + n - 1) % n], b = ring[i];
      var ain = keepGreater ? a[ax] >= v : a[ax] <= v;
      var bin = keepGreater ? b[ax] >= v : b[ax] <= v;
      if (bin) { if (!ain) out.push(interA(a, b, v, ax)); out.push(b); }
      else if (ain) out.push(interA(a, b, v, ax));
    }
    return out;
  }
  function interA(a, b, v, ax) {
    var o = 1 - ax, d = b[ax] - a[ax], t = d !== 0 ? (v - a[ax]) / d : 0, p = [0, 0];
    p[ax] = v; p[o] = a[o] + (b[o] - a[o]) * t; return p;
  }
  function clipRange(ring, lo, hi) { return clipX(clipX(ring, lo, true), hi, false); }
  function shiftRing(ring, dx) { var o = new Array(ring.length); for (var i = 0; i < ring.length; i++) o[i] = [ring[i][0] + dx, ring[i][1]]; return o; }

  // Unwrap a projected ring across the antimeridian; returns {ring, min, max, wrapped}
  function unwrapRing(ring) {
    var off = 0, out = new Array(ring.length), wrapped = false, mn = Infinity, mx = -Infinity;
    for (var i = 0; i < ring.length; i++) {
      var x = ring[i][0];
      if (i > 0) {
        var dx = x - ring[i - 1][0];
        if (dx > W / 2) { off -= W; wrapped = true; } else if (dx < -W / 2) { off += W; wrapped = true; }
      }
      var xx = x + off;
      out[i] = [xx, ring[i][1]];
      if (xx < mn) mn = xx; if (xx > mx) mx = xx;
    }
    return { ring: out, min: mn, max: mx, wrapped: wrapped };
  }
  // Split a polygon (array of projected rings) at the map edges so nothing streaks; returns array of polys
  function splitPoly(poly) {
    var any = false, uw = [], mn = Infinity, mx = -Infinity;
    for (var k = 0; k < poly.length; k++) {
      var u = unwrapRing(poly[k]); uw.push(u);
      if (u.wrapped) any = true;
      if (u.min < mn) mn = u.min; if (u.max > mx) mx = u.max;
    }
    if (!any) return [poly];
    var res = [];
    var shifts = [0];
    if (mx > W + 1e-6) shifts.push(-W);
    if (mn < -1e-6) shifts.push(W);
    for (var s = 0; s < shifts.length; s++) {
      var np = [];
      for (var r = 0; r < uw.length; r++) {
        var ring = shifts[s] ? shiftRing(uw[r].ring, shifts[s]) : uw[r].ring;
        var c = clipRange(ring, 0, W);
        if (c.length >= 3 && Math.abs(ringArea(c)) > 1e-9) np.push(c);
        else if (r === 0) { np = null; break; }
      }
      if (np && np.length) res.push(np);
    }
    return res.length ? res : [poly];
  }

  function decodeArcs(topo) {
    var tf = topo.transform, sx = 1, sy = 1, tx = 0, ty = 0;
    if (tf) { sx = tf.scale[0]; sy = tf.scale[1]; tx = tf.translate[0]; ty = tf.translate[1]; }
    var arcs = new Array(topo.arcs.length);
    for (var a = 0; a < topo.arcs.length; a++) {
      var src = topo.arcs[a], pts = new Array(src.length), x = 0, y = 0;
      for (var i = 0; i < src.length; i++) {
        if (tf) { x += src[i][0]; y += src[i][1]; pts[i] = [x * sx + tx, y * sy + ty]; }
        else pts[i] = [src[i][0], src[i][1]];
      }
      arcs[a] = pts;
    }
    return arcs;
  }
  function stitchRing(arcIdxs, arcs) { // lon/lat ring
    var out = [];
    for (var k = 0; k < arcIdxs.length; k++) {
      var ai = arcIdxs[k], rev = ai < 0, arc = arcs[rev ? ~ai : ai];
      if (!arc) continue;
      var n = arc.length;
      for (var i = 0; i < n; i++) {
        var p = arc[rev ? n - 1 - i : i];
        if (out.length && i === 0) continue; // drop shared joint point
        out.push(p);
      }
    }
    if (out.length > 1) { var f = out[0], l = out[out.length - 1]; if (f[0] === l[0] && f[1] === l[1]) out.pop(); }
    return out;
  }

  function labelPoint(poly, bb) {
    // pole-of-inaccessibility-lite: coarse grid then 2 refinements
    var bestX = NaN, bestY = NaN, bestD = -1;
    var x0 = bb[0], y0 = bb[1], w = bb[2] - bb[0], h = bb[3] - bb[1];
    if (!(w > 0) || !(h > 0)) return null;
    var N = 18;
    var cx0 = x0, cy0 = y0, cw = w, ch = h;
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i <= N; i++) {
        for (var j = 0; j <= N; j++) {
          var x = cx0 + cw * (i + 0.5) / (N + 1), y = cy0 + ch * (j + 0.5) / (N + 1);
          if (x < x0 || x > x0 + w || y < y0 || y > y0 + h) continue;
          if (!polyContains(poly, x, y)) continue;
          var d = edgeDist2(poly, x, y);
          if (d > bestD) { bestD = d; bestX = x; bestY = y; }
        }
      }
      if (bestD < 0) break;
      cw = cw / N * 3; ch = ch / N * 3; cx0 = bestX - cw / 2; cy0 = bestY - ch / 2; N = 10;
    }
    if (bestD < 0) return null;
    return [bestX, bestY];
  }
  function scanlinePoint(poly, y) {
    var xs = [];
    for (var k = 0; k < poly.length; k++) {
      var r = poly[k], n = r.length;
      for (var i = 0, j = n - 1; i < n; j = i++) {
        var yi = r[i][1], yj = r[j][1];
        if ((yi > y) !== (yj > y)) xs.push(r[i][0] + (y - yi) * (r[j][0] - r[i][0]) / (yj - yi));
      }
    }
    xs.sort(function (a, b) { return a - b; });
    var best = -1, bx = NaN;
    for (var m = 0; m + 1 < xs.length; m += 2) { var sp = xs[m + 1] - xs[m]; if (sp > best) { best = sp; bx = (xs[m] + xs[m + 1]) / 2; } }
    return best >= 0 ? [bx, y] : null;
  }
  function centroidOf(ring) {
    var a = 0, cx = 0, cy = 0, n = ring.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (Math.abs(a) < 1e-12) {
      var sx = 0, sy = 0; for (var k = 0; k < n; k++) { sx += ring[k][0]; sy += ring[k][1]; }
      return n ? [sx / n, sy / n] : [0, 0];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }

  function buildRegions(topo) {
    topo = topo || globalThis.GS_TOPO;
    if (!topo || !topo.objects) throw new Error('GS.Geo.buildRegions: no topology');
    var obj = topo.objects.countries || topo.objects[Object.keys(topo.objects)[0]];
    var arcs = decodeArcs(topo);
    var geoms = obj.geometries, regions = [], arcUsers = new Array(arcs.length);
    for (var g = 0; g < geoms.length; g++) {
      var geo = geoms[g];
      if (geo.id === '010') continue;
      if (!geo.arcs || (geo.type !== 'Polygon' && geo.type !== 'MultiPolygon')) continue;
      var props = geo.properties || {};
      var key = (geo.id !== undefined && geo.id !== null && geo.id !== '') ? String(geo.id) : String(props.name);
      var polysArcs = geo.type === 'Polygon' ? [geo.arcs] : geo.arcs;
      var rid = regions.length;
      var polys = [];
      for (var p = 0; p < polysArcs.length; p++) {
        var rings = [];
        for (var r = 0; r < polysArcs[p].length; r++) {
          var ra = polysArcs[p][r];
          for (var q = 0; q < ra.length; q++) {
            var ai = ra[q] < 0 ? ~ra[q] : ra[q];
            var us = arcUsers[ai] || (arcUsers[ai] = []);
            if (us[us.length - 1] !== rid) us.push(rid);
          }
          var ll = stitchRing(ra, arcs);
          if (ll.length < 3) continue;
          var pr = new Array(ll.length);
          for (var t = 0; t < ll.length; t++) pr[t] = [projX(ll[t][0]), projY(ll[t][1])];
          rings.push(pr);
        }
        if (!rings.length) continue;
        var parts = splitPoly(rings);
        for (var s = 0; s < parts.length; s++) polys.push(parts[s]);
      }
      if (!polys.length) continue;
      regions.push(makeRegion(rid, key, String(props.name || key), polys));
    }
    // large countries are subdivided into 2-6 provinces (strips along their long axis) so land can change hands
    // piece by piece: partial conquest, partition after civil wars, gradual settlement of empty land
    regions = subdivide(regions, arcs, arcUsers);
    for (var z = 0; z < regions.length; z++) regions[z].neighbors.sort(function (a, b) { return a - b; });
    GS.Geo.regions = regions;
    return regions;
  }

  function makeRegion(rid, key, name, polys) {
    var areas = new Array(polys.length), total = 0, main = 0;
    for (var pi = 0; pi < polys.length; pi++) {
      areas[pi] = polyArea(polys[pi]); total += areas[pi];
      if (areas[pi] > areas[main]) main = pi;
    }
    var cum = new Float64Array(polys.length), acc = 0;
    for (var ci = 0; ci < polys.length; ci++) { acc += areas[ci]; cum[ci] = acc; }
    var allRings = []; for (var ar = 0; ar < polys.length; ar++) for (var rr = 0; rr < polys[ar].length; rr++) allRings.push(polys[ar][rr]);
    var bbox = bboxOf(allRings);
    var polyBBox = polys.map(function (pp) { return bboxOf(pp); });
    var mp = polys[main];
    var lp = labelPoint(mp, polyBBox[main]);
    var cen = centroidOf(mp[0]);
    if (!lp) { lp = polyContains(mp, cen[0], cen[1]) ? cen : (scanlinePoint(mp, cen[1]) || cen); }
    return {
      id: rid, key: key, name: name,
      polys: polys, bbox: bbox, area: total > 0 ? total : 1e-6,
      cx: lp[0], cy: lp[1],
      lon: unprojLon(cen[0]), lat: unprojLat(cen[1]),
      neighbors: [], owner: -1, core: -1, devastation: 0,
      // additions (internal helpers, safe to ignore):
      mainPoly: main, polyAreas: areas, polyBBox: polyBBox, _cum: cum,
      // subdivision: group = index of the whole country shape, sub = piece index, subN = pieces in the group
      group: rid, sub: 0, subN: 1, baseName: name, outline: null
    };
  }

  var SPLIT_MIN = 9000, SPLIT_UNIT = 12000;
  function dirNames(k, ax) {
    var h = { 2: ['Western', 'Eastern'], 3: ['Western', 'Central', 'Eastern'], 4: ['Western', 'West-Central', 'East-Central', 'Eastern'],
      5: ['Western', 'West-Central', 'Central', 'East-Central', 'Eastern'], 6: ['Far Western', 'Western', 'West-Central', 'East-Central', 'Eastern', 'Far Eastern'] };
    var v = { 2: ['Northern', 'Southern'], 3: ['Northern', 'Central', 'Southern'], 4: ['Northern', 'North-Central', 'South-Central', 'Southern'],
      5: ['Far Northern', 'Northern', 'Central', 'Southern', 'Far Southern'], 6: ['Far Northern', 'Northern', 'North-Central', 'South-Central', 'Southern', 'Far Southern'] };
    return (ax ? v : h)[k];
  }
  function subdivide(orig, arcs, arcUsers) {
    var plans = new Array(orig.length), out = [], map = new Array(orig.length), i, s, k;
    for (i = 0; i < orig.length; i++) {
      var r = orig[i], ma = r.polyAreas[r.mainPoly], mb = r.polyBBox[r.mainPoly];
      if (!(ma >= SPLIT_MIN)) { plans[i] = null; continue; }
      var ax = (mb[2] - mb[0]) >= (mb[3] - mb[1]) ? 0 : 1;
      var n = Math.max(2, Math.min(6, Math.round(Math.sqrt(ma / SPLIT_UNIT))));
      plans[i] = { k: n, ax: ax, lo: mb[ax], step: (mb[ax + 2] - mb[ax]) / n };
    }
    function stripOf(pl, x, y) {
      var v = pl.ax ? y : x, hi = pl.lo + pl.k * pl.step;
      if (!pl.ax) { if (v < pl.lo && pl.lo - v > W / 2) v += W; else if (v > hi && v - hi > W / 2) v -= W; }
      var q = Math.floor((v - pl.lo) / pl.step);
      return q < 0 ? 0 : (q >= pl.k ? pl.k - 1 : q);
    }
    for (i = 0; i < orig.length; i++) {
      var R0 = orig[i], pl = plans[i];
      if (!pl) { R0.id = out.length; R0.group = R0.id; R0.neighbors = []; map[i] = [R0.id]; out.push(R0); continue; }
      var buckets = []; for (s = 0; s < pl.k; s++) buckets.push([]);
      for (var p = 0; p < R0.polys.length; p++) {
        var poly = R0.polys[p], pb = R0.polyBBox[p];
        var s0 = stripOf(pl, pb[0], pb[1]), s1 = stripOf(pl, pb[2], pb[3]);
        if (p !== R0.mainPoly && s0 === s1) { buckets[s0].push(poly); continue; }
        if (p !== R0.mainPoly) { buckets[stripOf(pl, (pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2)].push(poly); continue; }
        for (s = 0; s < pl.k; s++) {
          var lo = pl.lo + s * pl.step, hi = lo + pl.step, np = [];
          for (var q = 0; q < poly.length; q++) {
            var ring = poly[q];
            if (s > 0) ring = clipA(ring, lo, true, pl.ax);
            if (s < pl.k - 1) ring = clipA(ring, hi, false, pl.ax);
            if (ring.length >= 3 && Math.abs(ringArea(ring)) > 1e-6) np.push(ring);
            else if (q === 0) { np = null; break; }
          }
          if (np && np.length) buckets[s].push(np);
        }
      }
      var names = dirNames(pl.k, pl.ax), ids = [], first = -1;
      for (s = 0; s < pl.k; s++) {
        if (!buckets[s].length) { ids.push(-1); continue; }
        var nr = makeRegion(out.length, R0.key, names[s] + ' ' + R0.name, buckets[s]);
        nr.group = first >= 0 ? first : nr.id; nr.sub = s; nr.baseName = R0.name;
        if (first < 0) { first = nr.id; nr.outline = R0.polys; }
        ids.push(nr.id); out.push(nr);
      }
      var cnt = 0; for (s = 0; s < ids.length; s++) if (ids[s] >= 0) cnt++;
      for (s = 0; s < ids.length; s++) if (ids[s] >= 0) { out[ids[s]].subN = cnt; out[ids[s]].group = first; }
      // pieces of one country border each other in sequence
      var prev = -1;
      for (s = 0; s < ids.length; s++) {
        if (ids[s] < 0) continue;
        if (prev >= 0) { out[prev].neighbors.push(ids[s]); out[ids[s]].neighbors.push(prev); }
        prev = ids[s];
      }
      map[i] = ids;
      plans[i].ids = ids;
    }
    function pieceAt(i0, x, y) {
      var ids = map[i0]; if (ids.length === 1) return ids[0];
      var pl = plans[i0], st = stripOf(pl, x, y);
      for (var d = 0; d < pl.k; d++) {
        if (st - d >= 0 && ids[st - d] >= 0) return ids[st - d];
        if (st + d < pl.k && ids[st + d] >= 0) return ids[st + d];
      }
      return -1;
    }
    function link(a, b) {
      if (a < 0 || b < 0 || a === b) return;
      if (out[a].neighbors.indexOf(b) < 0) out[a].neighbors.push(b);
      if (out[b].neighbors.indexOf(a) < 0) out[b].neighbors.push(a);
    }
    // neighbors via shared arcs (each shared border point links the pieces on both sides of it)
    for (var a2 = 0; a2 < arcUsers.length; a2++) {
      var u = arcUsers[a2]; if (!u || u.length < 2) continue;
      var arc = arcs[a2], split = false;
      for (k = 0; k < u.length; k++) if (plans[u[k]]) split = true;
      for (var i1 = 0; i1 < u.length; i1++) for (var i2 = i1 + 1; i2 < u.length; i2++) {
        if (u[i1] === u[i2]) continue;
        if (!split) { link(map[u[i1]][0], map[u[i2]][0]); continue; }
        var stepP = Math.max(1, Math.floor(arc.length / 24));
        for (var t = 0; t < arc.length; t += stepP) {
          var x = projX(arc[t][0]), y = projY(arc[t][1]);
          link(pieceAt(u[i1], x, y), pieceAt(u[i2], x, y));
        }
      }
    }
    return out;
  }

  function resolveRegion(region) {
    if (typeof region === 'number') return GS.Geo.regions ? GS.Geo.regions[region] : null;
    return region;
  }
  function pointInRegion(region, x, y) {
    region = resolveRegion(region);
    if (!region || !region.polys) return false;
    var b = region.bbox;
    if (b && (x < b[0] || x > b[2] || y < b[1] || y > b[3])) return false;
    var inside = false, polys = region.polys;
    for (var p = 0; p < polys.length; p++) {
      var pb = region.polyBBox && region.polyBBox[p];
      if (pb && (x < pb[0] || x > pb[2] || y < pb[1] || y > pb[3])) continue;
      if (polyContains(polys[p], x, y)) inside = !inside;
    }
    return inside;
  }
  function rnd(rng) { return rng ? (typeof rng.next === 'function' ? rng.next() : (typeof rng === 'function' ? rng() : Math.random())) : Math.random(); }
  // returns [x,y] (also .x/.y). Pass `out` (array) to avoid allocation.
  function randomPointInRegion(region, rng, out) {
    region = resolveRegion(region);
    out = out || [0, 0];
    if (!region) { out[0] = out[1] = out.x = out.y = 0; return out; }
    var polys = region.polys, cum = region._cum, np = polys ? polys.length : 0;
    for (var tries = 0; tries < 40 && np; tries++) {
      var pi = 0;
      if (np > 1 && cum) { var r = rnd(rng) * cum[np - 1]; while (pi < np - 1 && r > cum[pi]) pi++; }
      var bb = region.polyBBox ? region.polyBBox[pi] : region.bbox;
      var x = bb[0] + (bb[2] - bb[0]) * rnd(rng), y = bb[1] + (bb[3] - bb[1]) * rnd(rng);
      if (polyContains(polys[pi], x, y)) { out[0] = x; out[1] = y; out.x = x; out.y = y; return out; }
    }
    out[0] = region.cx; out[1] = region.cy; out.x = region.cx; out.y = region.cy;
    return out;
  }
  function haversineKm(lon1, lat1, lon2, lat2) {
    var p1 = lat1 * DEG, p2 = lat2 * DEG, dp = (lat2 - lat1) * DEG, dl = (lon2 - lon1) * DEG;
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    if (a > 1) a = 1; if (!(a >= 0)) a = 0;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  GS.Geo = {
    MAP_W: W, MAP_H: MAP_H,
    project: project, unproject: unproject,
    buildRegions: buildRegions,
    pointInRegion: pointInRegion,
    randomPointInRegion: randomPointInRegion,
    haversineKm: haversineKm,
    regions: null // last built regions (set by buildRegions)
  };

  // ------------------------------------------------------------------ Names
  // '_' inside a token becomes a space.
  function L(s) { return s.trim().split(/\s+/).map(function (t) { return t.replace(/_/g, ' '); }); }
  var lists = {
    anglo: {
      first_m: L('James John Robert Michael William David Richard Joseph Thomas Charles Daniel Matthew Anthony Mark Steven Paul Andrew Joshua Kevin Brian George Edward Ryan Jacob Gary Nicholas Eric Jonathan Stephen Justin Scott Benjamin Samuel Gregory Patrick Jack Oliver Harry Liam Noah Ethan Henry'),
      first_f: L('Mary Patricia Jennifer Linda Elizabeth Barbara Susan Jessica Sarah Karen Nancy Lisa Margaret Betty Sandra Ashley Emily Donna Michelle Carol Amanda Melissa Deborah Stephanie Rebecca Laura Sharon Cynthia Kathleen Amy Emma Olivia Charlotte Sophie Grace Hannah Megan Chloe Lucy Ruth'),
      last: L('Smith Johnson Williams Brown Jones Miller Davis Wilson Anderson Taylor Thomas Moore Martin Jackson Thompson White Harris Clark Lewis Robinson Walker Young Allen King Wright Scott Hill Green Adams Baker Nelson Carter Mitchell Roberts Turner Phillips Campbell Parker Evans Edwards Collins Stewart Morris Murphy Cook Rogers Morgan Cooper Hughes Kelly Wood Ward Hall Bell')
    },
    hispanic: {
      first_m: L('Jos\u00e9 Juan Luis Carlos Jorge Miguel Javier Alejandro Manuel Francisco Antonio Pedro Diego Fernando Ricardo Andr\u00e9s Sergio Pablo Ra\u00fal Eduardo Roberto Mateo Santiago Sebasti\u00e1n Gabriel Rafael Emilio H\u00e9ctor Gustavo \u00c1lvaro Ignacio Enrique \u00d3scar Rodrigo Marcos'),
      first_f: L('Mar\u00eda Ana Carmen Luc\u00eda Isabel Sof\u00eda Valentina Camila Gabriela Daniela Laura Paula Elena Rosa Teresa Patricia Marta Andrea Natalia Mariana Fernanda Alejandra Claudia Ver\u00f3nica Adriana Beatriz Pilar Julia Ximena Paola Victoria Carolina Lorena Silvia In\u00e9s'),
      last: L('Garc\u00eda Rodr\u00edguez Mart\u00ednez L\u00f3pez Gonz\u00e1lez Hern\u00e1ndez P\u00e9rez S\u00e1nchez Ram\u00edrez Torres Flores Rivera G\u00f3mez D\u00edaz Cruz Morales Reyes Guti\u00e9rrez Ortiz Ramos Romero \u00c1lvarez Mendoza Ruiz Jim\u00e9nez Vargas Castillo Moreno Herrera Medina Aguilar Castro V\u00e1zquez Rojas Guerrero Navarro Molina Delgado Su\u00e1rez Ortega Cabrera Dom\u00ednguez Fuentes Salazar Pe\u00f1a Soto Contreras')
    },
    lusophone: {
      first_m: L('Jo\u00e3o Jos\u00e9 Ant\u00f3nio Francisco Carlos Paulo Pedro Lucas Luiz Marcos Lu\u00eds Gabriel Rafael Daniel Marcelo Bruno Eduardo Felipe Raimundo Rodrigo Manuel Tiago Gon\u00e7alo Rui Miguel Diogo Henrique Gustavo F\u00e1bio Leonardo Vin\u00edcius Matheus Ricardo S\u00e9rgio Andr\u00e9'),
      first_f: L('Maria Ana Francisca Ant\u00f4nia Adriana Juliana M\u00e1rcia Fernanda Patr\u00edcia Aline Beatriz In\u00eas Mariana Joana Catarina Sofia Leonor Carolina Gabriela Larissa Camila Amanda Bruna Let\u00edcia Vit\u00f3ria Luana Rita Teresa Helena Isabela Raquel Sandra Cl\u00e1udia D\u00e9bora Renata'),
      last: L('Silva Santos Oliveira Souza Rodrigues Ferreira Alves Pereira Lima Gomes Costa Ribeiro Martins Carvalho Almeida Lopes Soares Fernandes Vieira Barbosa Rocha Dias Nascimento Andrade Moreira Nunes Marques Machado Mendes Freitas Cardoso Ramos Gon\u00e7alves Santana Teixeira Correia Pinto Moura Cavalcanti Monteiro Azevedo Coelho Tavares')
    },
    french: {
      first_m: L('Jean Pierre Michel Andr\u00e9 Philippe Louis Nicolas Alain Jacques Bernard Christophe Patrick Daniel Fran\u00e7ois Laurent Julien Thomas Antoine S\u00e9bastien Mathieu Olivier Guillaume Hugo Lucas Th\u00e9o Gabriel Arthur Rapha\u00ebl Maxime Vincent \u00c9tienne Beno\u00eet R\u00e9mi Yves Luc'),
      first_f: L('Marie Nathalie Isabelle Sylvie Catherine Fran\u00e7oise Monique Val\u00e9rie Sandrine Christine Sophie C\u00e9line Julie Camille L\u00e9a Manon Chlo\u00e9 Emma In\u00e8s Jade Louise Alice Juliette Margaux Pauline Claire \u00c9lise Aur\u00e9lie Mathilde Anne H\u00e9l\u00e8ne Brigitte Agn\u00e8s Caroline Odile'),
      last: L('Martin Bernard Dubois Thomas Robert Richard Petit Durand Leroy Moreau Simon Laurent Lefebvre Michel Garcia David Bertrand Roux Vincent Fournier Morel Girard Andr\u00e9 Lef\u00e8vre Mercier Dupont Lambert Bonnet Fran\u00e7ois Legrand Garnier Faure Rousseau Blanc Gu\u00e9rin Muller Henry Roussel Perrin Morin Mathieu Cl\u00e9ment Gauthier Dumont Fontaine Chevalier')
    },
    german: {
      first_m: L('Hans Peter Wolfgang Klaus Michael Thomas Andreas Stefan J\u00fcrgen Frank Uwe Dieter G\u00fcnter Matthias Christian Markus Martin Tobias Lukas Jonas Felix Maximilian Leon Paul Florian Sebastian Alexander Jan Daniel Niklas Moritz Johannes Friedrich Karl Heinz Pieter Sander'),
      first_f: L('Ursula Monika Petra Sabine Andrea Claudia Susanne Birgit Gabriele Karin Renate Heike Anja Katrin Julia Laura Anna Lena Lea Hannah Sophie Marie Emilia Mia Lisa Sarah Johanna Katharina Franziska Ingrid Helga Elke Annika Greta Clara Femke'),
      last: L('M\u00fcller Schmidt Schneider Fischer Weber Meyer Wagner Becker Schulz Hoffmann Sch\u00e4fer Koch Bauer Richter Klein Wolf Schr\u00f6der Neumann Schwarz Zimmermann Braun Kr\u00fcger Hofmann Hartmann Lange Schmitt Werner Krause Meier Lehmann Schmid Schulze Maier K\u00f6hler Herrmann K\u00f6nig Walter Huber Kaiser Fuchs Peters Lang M\u00f6ller Wei\u00df Jung Hahn Vogel de_Vries Jansen van_Dijk Bakker Visser de_Jong')
    },
    italian: {
      first_m: L('Giuseppe Giovanni Antonio Mario Luigi Francesco Angelo Vincenzo Pietro Salvatore Carlo Franco Domenico Bruno Paolo Michele Giorgio Roberto Marco Andrea Luca Alessandro Matteo Lorenzo Leonardo Davide Simone Federico Riccardo Stefano Fabio Massimo Enrico Gianluca Sergio'),
      first_f: L('Maria Anna Giuseppina Rosa Angela Giovanna Teresa Lucia Carmela Caterina Francesca Antonietta Elena Chiara Giulia Sara Martina Sofia Aurora Alessia Valentina Federica Silvia Paola Laura Elisa Beatrice Ginevra Alice Giorgia Roberta Daniela Simona Barbara Cristina'),
      last: L("Rossi Russo Ferrari Esposito Bianchi Romano Colombo Ricci Marino Greco Bruno Gallo Conti De_Luca Mancini Costa Giordano Rizzo Lombardi Moretti Barbieri Fontana Santoro Mariani Rinaldi Caruso Ferrara Galli Martini Leone Longo Gentile Martinelli Vitale Lombardo Serra Coppola De_Santis D'Angelo Marchetti Parisi Villa Conte Ferraro Ferri Fabbri Bianco Marini Grasso")
    },
    nordic: {
      first_m: L('Lars Anders Johan Erik Per Karl Nils Jan Mikael Peter Henrik Ole Jens S\u00f8ren Magnus Bj\u00f8rn Gustav Olof Sven Kristian Mathias Emil William Oskar Lucas Elias Axel Hugo Viktor J\u00f3nas Sigur\u00f0ur Matti Mikko Juha Timo Aksel'),
      first_f: L('Anna Maria Kristina Karin Ingrid Margareta Eva Birgitta Kirsten Hanne Mette Inger Astrid Sigrid Ingeborg Linnea Elsa Alice Maja Freja Ida Emma Ella Saga Julia Wilma Nora Liv Gu\u00f0r\u00fan Sigr\u00ed\u00f0ur Aino Helmi Johanna Tuula Pirjo Silje'),
      last: L('Andersson Johansson Karlsson Nilsson Eriksson Larsson Olsson Persson Svensson Gustafsson Pettersson Jonsson Jensen Nielsen Hansen Pedersen Andersen Christensen Larsen S\u00f8rensen Rasmussen Johansen Olsen Berg Haugen Hagen Johannessen Lund Lindberg Lindqvist Berglund Dahl Holm Virtanen Korhonen M\u00e4kinen Nieminen M\u00e4kel\u00e4 H\u00e4m\u00e4l\u00e4inen Laine J\u00f3nsson Sigur\u00f0sson Gu\u00f0mundsson')
    },
    slavic: {
      first_m: L('Aleksandr Sergei Dmitri Andrei Alexei Vladimir Ivan Mikhail Nikolai Yuri Oleg Viktor Pavel Igor Maxim Artem Denis Roman Evgeni Konstantin Piotr Tomasz Krzysztof Pawe\u0142 Micha\u0142 Jakub Marek Jan Tom\u00e1\u0161 Petr Luk\u00e1\u0161 Oleksandr Volodymyr Taras Bohdan'),
      first_f: L('Elena Olga Tatiana Natalia Irina Svetlana Anna Maria Ekaterina Yulia Anastasia Marina Lyudmila Galina Daria Polina Ksenia Valentina Agnieszka Katarzyna Ma\u0142gorzata Magdalena Joanna Zofia Barbara Petra Jana Lucie Tereza Oksana Iryna Kateryna Halyna Nadia Viktoria'),
      last: L('Ivanov Smirnov Kuznetsov Popov Vasiliev Petrov Sokolov Mikhailov Novikov Fedorov Morozov Volkov Alekseev Lebedev Semenov Egorov Pavlov Kozlov Stepanov Nikolaev Orlov Kovalenko Bondarenko Shevchenko Tkachenko Kravchenko Melnyk Lysenko Nowak Kowalski Wi\u015bniewski W\u00f3jcik Kowalczyk Kami\u0144ski Lewandowski Zieli\u0144ski Szyma\u0144ski Nov\u00e1k Svoboda Novotn\u00fd Dvo\u0159\u00e1k \u010cern\u00fd Proch\u00e1zka Ku\u010dera Horv\u00e1th Kov\u00e1\u010d')
    },
    baltic: {
      first_m: L('Andris J\u0101nis P\u0113teris M\u0101rti\u0146\u0161 K\u0101rlis Edgars Aivars Raimonds Gints Valdis Jonas Tomas Mantas Lukas Darius Paulius Mindaugas Vytautas Gintaras Algirdas Andrius Rokas T\u00f5nis Jaan Andres Mart Toomas Rein Kristjan Indrek Juhan Priit Kaspars Arvydas'),
      first_f: L('Anna Krist\u012bne Laura Inese Ilze L\u012bga Dace Sandra Ieva Agn\u0117 R\u016bta Gintar\u0117 Egl\u0117 Jurgita Aist\u0117 Kristina Dalia Vilma Birut\u0117 Kadri Maarja Liis Kati Triin Tiina Kersti Mari Piret Ingrid Zane Baiba El\u012bna Aust\u0117ja Gabija Viktorija'),
      last: L('Kazlauskas Jankauskas Petrauskas Stankevi\u010dius Vasiliauskas \u017dukauskas Butkus Paulauskas Urbonas Kavaliauskas Navickas Rimkus B\u0113rzi\u0146\u0161 Kalni\u0146\u0161 Ozoli\u0146\u0161 Jansons Ozols Liepi\u0146\u0161 Kr\u016bmi\u0146\u0161 Balodis Zari\u0146\u0161 K\u013cavi\u0146\u0161 V\u012btols K\u0101rkli\u0146\u0161 Tamm Saar Sepp M\u00e4gi Kask Kukk Rebane Ilves P\u00e4rn Koppel Lepik Kallas Oja Raudsepp Mets Vaher')
    },
    balkan: {
      first_m: L('Marko Nikola Stefan Luka Milan Dragan Zoran Goran Aleksandar Milo\u0161 Nenad Dejan Petar Tomislav Josip Ante Mladen Bojan Vuk Andrej Georgi Dimitar Hristo Ion Mihai Gheorghe Vasile Bogdan Florin Arben Besnik Edin Emir Adnan Tam\u00e1s L\u00e1szl\u00f3 G\u00e1bor'),
      first_f: L('Ana Marija Jelena Ivana Milica Mila Dragana Sne\u017eana Vesna Sanja Maja Tamara Katarina Nina Jovana Petra Elena Ioana Andreea Mihaela Gabriela Cristina Ionela Desislava Gergana Ivelina Teodora Albana Arta Elira Amra Lejla Emina Zs\u00f3fia Katalin Eszter'),
      last: L('Jovanovi\u0107 Petrovi\u0107 Nikoli\u0107 Markovi\u0107 \u0110or\u0111evi\u0107 Stojanovi\u0107 Ili\u0107 Stankovi\u0107 Pavlovi\u0107 Horvat Kova\u010devi\u0107 Babi\u0107 Mari\u0107 Kova\u010d Juri\u0107 Kne\u017eevi\u0107 Hod\u017ei\u0107 Begi\u0107 Popescu Ionescu Popa Radu Dumitru Stoica Munteanu Constantin Georgiev Dimitrov Petrov Hristov Todorov Hoxha Krasniqi Berisha Gashi Shala Nagy Kov\u00e1cs T\u00f3th Szab\u00f3 Varga Krasni\u00e7')
    },
    greek: {
      first_m: L('Georgios Ioannis Konstantinos Dimitrios Nikolaos Panagiotis Vasileios Christos Athanasios Michail Evangelos Spyridon Antonios Andreas Stavros Theodoros Kyriakos Alexandros Petros Emmanouil Ilias Charalampos Stylianos Apostolos Sotirios Grigorios Anastasios Pavlos Thomas Leonidas Aristotelis Periklis'),
      first_f: L('Maria Eleni Aikaterini Vasiliki Sofia Angeliki Dimitra Georgia Konstantina Paraskevi Evangelia Ioanna Christina Anastasia Panagiota Kalliopi Despoina Eirini Athina Fotini Theodora Chrysoula Stella Zoi Niki Olga Alexandra Ourania Varvara Kyriaki Afroditi Penelope Danai Myrto'),
      last: L('Papadopoulos Papadakis Georgiou Oikonomou Dimitriou Nikolaidis Vlachos Konstantinidis Papanikolaou Karagiannis Pappas Makris Athanasiou Ioannidis Christodoulou Antoniou Alexiou Mavridis Theodorou Kyriakou Angelopoulos Michailidis Papageorgiou Sotiropoulos Panagiotopoulos Vasileiou Stavropoulos Kostopoulos Zervas Galanis Raptis Lambrou Spanos Katsaros Doukas Floros Markou Petridis Samaras Kouris')
    },
    turkic: {
      first_m: L('Mehmet Mustafa Ahmet Ali H\u00fcseyin Hasan \u0130brahim \u0130smail Osman Yusuf Murat \u00d6mer Emre Burak Kemal Erdem Serkan Can Arda Eren Kassym Yerlan Askar Timur Rustam Bakyt Elchin Rashid Batbayar Ganbaatar Shavkat Aibek Daniyar Sardor Orhan'),
      first_f: L('Fatma Ay\u015fe Emine Hatice Zeynep Elif Meryem \u015eerife Zehra Hanife Merve Esra B\u00fc\u015fra \u00d6zlem G\u00fcl Derya Ebru Aylin Defne Ecem Aigerim Aizhan Dinara Gulnara Madina Saule Aliya Leyla Sevinj Nigora Dilnoza Oyunchimeg Altantsetseg Asel Kamila'),
      last: L('Y\u0131lmaz Kaya Demir \u015eahin \u00c7elik Y\u0131ld\u0131z Y\u0131ld\u0131r\u0131m \u00d6zt\u00fcrk Ayd\u0131n \u00d6zdemir Arslan Do\u011fan K\u0131l\u0131\u00e7 Aslan \u00c7etin Kara Ko\u00e7 Kurt \u00d6zkan \u015eim\u015fek Polat Aksoy Akhmetov Abenov Suleimenov Mammadov Huseynov Hasanov Karimov Rakhimov Usmonov Abdullayev Ismailov Bekov Omarov Sadykov Bat-Erdene Dorj Gantulga Tursunov')
    },
    arabic: {
      first_m: L('Mohammed Ahmed Ali Omar Khaled Youssef Ibrahim Hassan Hussein Mahmoud Abdullah Mustafa Tariq Karim Hamza Bilal Faisal Fahd Saeed Nasser Rashid Majid Walid Ziad Samir Sami Adel Jamal Fares Abdulaziz Hamad Mansour Anwar Rami Abdi'),
      first_f: L('Fatima Aisha Maryam Khadija Zainab Layla Nour Huda Amina Salma Rania Yasmin Hana Reem Dana Lina Sara Mona Noura Samira Jamila Farah Dalia Rasha Hiba Nadia Iman Asma Lubna Sumaya Ghada Wafa Ruqayya Hawa Fadumo'),
      last: L('Al-Sayed Haddad Khalil Hassan Hussein Ibrahim Mansour Nasser Saleh Abdullah Al-Masri Al-Rashid Al-Harbi Al-Otaibi Al-Qahtani Al-Ghamdi Al-Zahrani Al-Shehri Al-Dosari Al-Mutairi Darwish Khoury Aziz Farouk Hamdan Barakat Najjar Saadi Belkacem Mebarki Benjelloun El-Amrani Tazi Abdi Farah Warsame Osman Qasim Jaber Salem Suleiman Rahman Taha Zaki Obeidi Shammari Tamimi')
    },
    persian: {
      first_m: L('Mohammad Ali Hossein Reza Mehdi Hassan Amir Abbas Mahmoud Saeed Hamid Javad Majid Morteza Ahmad Mostafa Hadi Behzad Dariush Kourosh Farhad Kaveh Babak Arash Navid Omid Pouya Siavash Bahram Rostam Nasrullah Firuz Jamshid Sohrab Abdullah'),
      first_f: L('Fatemeh Zahra Maryam Masoumeh Sakineh Zeinab Leila Narges Shirin Parisa Nasrin Mahsa Neda Azadeh Roya Fereshteh Golnaz Mina Samira Hamideh Elham Mitra Shabnam Soraya Yasaman Nazanin Taraneh Parvaneh Ladan Simin Malalai Farzana Gulnaz Tahmina Nigina'),
      last: L('Hosseini Mohammadi Rezaei Ahmadi Moradi Karimi Rahimi Jafari Hashemi Mousavi Sadeghi Ghasemi Rostami Kazemi Heidari Ebrahimi Nazari Najafi Abbasi Shirazi Tehrani Esfahani Farahani Bagheri Salehi Akbari Amini Tavakoli Soltani Ansari Habibi Panahi Rahmani Popal Durrani Barakzai Wardak Sharifi Yusufi Davlatov Nazarov Saidov')
    },
    hebrew: {
      first_m: L("David Moshe Yosef Avraham Yaakov Daniel Michael Itzhak Shmuel Eitan Noam Ariel Uri Yonatan Amit Omer Tal Gil Yuval Ido Itai Nadav Ron Ehud Avi Eli Asher Lior Guy Oren Boaz Gideon Rafael Ze'ev Amir"),
      first_f: L('Sarah Rachel Leah Rivka Miriam Esther Tamar Noa Maya Shira Yael Michal Avital Hila Tali Orly Dafna Galit Keren Liat Efrat Shani Adi Neta Roni Inbar Yarden Moran Hadas Ayelet Ruth Naama Hagar Dina Ilana'),
      last: L('Cohen Levi Mizrahi Peretz Biton Dahan Avraham Friedman Azoulay Malka Katz Shapiro Ben-David Goldberg Rosenberg Klein Ohana Amar Gabay Hadad Ben-Haim Yosef Vaknin Elbaz Shalom Weiss Segal Kaplan Rubin Ashkenazi Barak Golan Carmeli Navon Eliyahu Sharabi Halevi Weinstein Stern Adler')
    },
    south_asian: {
      first_m: L('Rahul Amit Rajesh Suresh Vijay Sanjay Anil Sunil Ravi Arjun Rohan Vikram Ajay Deepak Manoj Prakash Ramesh Ashok Arun Karan Aditya Nikhil Imran Ahmed Bilal Usman Faisal Hamza Tariq Kamal Rafiq Abdul Jamal Dinesh Nuwan Kasun Pemba Bishal'),
      first_f: L('Priya Anjali Sunita Pooja Neha Kavita Lakshmi Deepa Meena Rekha Anita Asha Divya Shreya Ananya Aishwarya Sneha Swati Nisha Radha Fatima Ayesha Sana Hina Nazia Farhana Rubina Shabnam Taslima Nasreen Sabina Chandani Dilini Sita Gita Kamala Maya'),
      last: L('Sharma Verma Gupta Singh Kumar Patel Shah Mehta Joshi Reddy Rao Nair Iyer Menon Pillai Das Bose Chatterjee Banerjee Mukherjee Ghosh Sen Mishra Pandey Yadav Chauhan Khan Ahmed Hussain Malik Qureshi Chaudhry Butt Sheikh Raza Rahman Islam Hossain Chowdhury Perera Fernando Jayawardena Bandara Thapa Shrestha Gurung Tamang Dorji')
    },
    chinese: {
      first_m: L('Wei Jun Jie Hao Lei Tao Ming Qiang Yong Bin Peng Gang Chao Xin Long Jian Feng Bo Kai Zhiwei Haoran Yuxuan Junjie Zhihao Jianguo Guoqiang Weidong Chengzhi Mingyu Zhenhua Jialiang Zihao Tianyi Hongwei Xiaolong'),
      first_f: L('Fang Na Min Jing Xiu Ying Hong Yan Juan Ling Mei Lan Xia Hui Qing Ping Yun Ting Jiayi Yuxin Xinyi Yutong Shiyun Mengyao Siqi Xiaomei Lijuan Guilan Shuang Jiahui Wanting Yiting Ruoxi Shufen Meiling'),
      last: L('Wang Li Zhang Liu Chen Yang Huang Zhao Wu Zhou Xu Sun Ma Zhu Hu Guo He Lin Gao Luo Zheng Liang Xie Song Tang Han Feng Deng Cao Peng Zeng Xiao Tian Dong Pan Yuan Cai Jiang Yu Du Ye Cheng Wei Su Lu Ding Shen')
    },
    japanese: {
      first_m: L('Hiroshi Takashi Kenji Akira Satoshi Makoto Kazuo Yoshio Minoru Osamu Tsuyoshi Daisuke Takuya Kenta Shota Yuto Haruto Sota Ren Riku Yuki Kaito Daiki Ryota Naoki Kazuki Tetsuya Masato Hiroki Shinji Koji Taro Ichiro Yusuke Kenichi Toshiro'),
      first_f: L('Yoko Keiko Naoko Yuko Tomoko Akiko Kumiko Mayumi Junko Megumi Yumi Emi Ai Haruka Misaki Nanami Yui Sakura Hina Mio Yuna Aoi Rin Saki Mai Kaori Ayaka Natsuki Chihiro Sayaka Rie Noriko Michiko Hanako Fumiko'),
      last: L('Sato Suzuki Takahashi Tanaka Watanabe Ito Yamamoto Nakamura Kobayashi Kato Yoshida Yamada Sasaki Yamaguchi Matsumoto Inoue Kimura Hayashi Shimizu Yamazaki Mori Ikeda Hashimoto Yamashita Ishikawa Nakajima Maeda Fujita Ogawa Goto Okada Hasegawa Murakami Kondo Ishii Saito Sakamoto Endo Aoki Fujii Nishimura Fukuda Ota Miura')
    },
    korean: {
      first_m: L('Min-jun Seo-jun Ji-ho Do-yun Ha-jun Joo-won Ji-hoon Hyun-woo Sung-min Dong-hyun Jae-won Young-ho Sang-woo Seung-hoon Kwang-su Chul-soo Young-soo Jung-ho Tae-yang Woo-jin Jin-woo Myung-soo Byung-chul Kyung-ho Hyun-jun Jun-seo Yoon-ho Si-woo Eun-woo Ji-hwan Song-il Chol-jin Kwang-chol Myong-guk Hyok-chol'),
      first_f: L('Seo-yeon Ji-woo Seo-yun Min-seo Ha-eun Ji-yoo Yoon-seo Ji-min Soo-ah Ye-eun Eun-ji Hye-jin Mi-kyung Young-hee Jung-sook Sun-hee Kyung-ja Min-ji Yu-na Da-eun Su-bin Ha-yoon Chae-won Na-yeon Soo-jin Hyo-jin Eun-young Ji-yeon Seon-ok Ok-sun Hyang-mi Kum-sun Song-hui Ryon-hui Mi-ok'),
      last: L('Kim Lee Park Choi Jung Kang Cho Yoon Jang Lim Han Oh Seo Shin Kwon Hwang Ahn Song Jeon Hong Yoo Ko Moon Yang Son Bae Baek Heo Nam Noh Ha Kwak Sung Cha Joo Woo Min Ryu Na Jin Ri Pak')
    },
    sea: {
      first_m: L('Budi Agus Joko Bambang Andi Hendra Wahyu Arif Rizky Hafiz Faizal Azman Ismail Minh Tuan Hung Duc Anh Long Quang Thanh Somchai Somsak Prasert Anan Kittisak Chaiwat Aung Kyaw Zaw Htun Sokha Dara Ramon Paolo Mark'),
      first_f: L('Siti Dewi Sri Rina Putri Ayu Wulan Indah Nurul Aisyah Farah Linh Hoa Lan Mai Huong Thu Trang Ngoc Malee Siriporn Nattaya Kanya Ploy Suda Khin Thida Hnin Sophea Chanthy Rosario Cristina Angelica Kristine Leni'),
      last: L('Santoso Wijaya Susanto Hidayat Pratama Saputra Setiawan Kusuma Siregar Nasution Abdullah Rahman Ibrahim Tan Lim Ong Nguyen Tran Le Pham Hoang Vu Dang Bui Ngo Duong Srisuk Chaiyaporn Wongsawat Saetang Thein Win Myint Soe Chea Sok Santos Reyes Bautista Ocampo Mendoza Villanueva Dela_Cruz')
    },
    african_west: {
      first_m: L('Mamadou Moussa Amadou Ousmane Abdoulaye Sekou Boubacar Cheikh Modou Kwame Kofi Kwaku Yaw Kojo Emeka Chinedu Obinna Chukwudi Tunde Babajide Olusegun Adebayo Musa Abubakar Femi Sani Yakubu Idris Aliou Lamine Seydou Kouassi Koffi Ebo Senyo'),
      first_f: L('Aminata Fatoumata Mariama Aissatou Awa Fanta Kadiatou Ramatoulaye Ndeye Khady Ama Akosua Abena Efua Adwoa Chiamaka Ngozi Ifeoma Adaeze Funmilayo Folake Yetunde Bisi Halima Zainab Hauwa Hadiza Nafisa Binta Rokia Adjoua Mariam Salimata Kadi Esi'),
      last: L('Diallo Coulibaly Diop Ndiaye Sow Keita Konat\u00e9 Camara Tour\u00e9 Ciss\u00e9 Bah Barry Sylla Fofana Kone Ou\u00e9draogo Sawadogo Kabor\u00e9 Mensah Owusu Boateng Asante Osei Agyeman Adeyemi Okafor Okonkwo Eze Nwosu Bello Danjuma Yusuf Okoro Kamara Koroma Conteh Sesay Doe Yao Bamba Adjei Oladipo')
    },
    african_east: {
      first_m: L('Juma Hamisi Baraka Jabari Daudi Musa Omari Salim Joseph Samuel Peter Emmanuel Abebe Tesfaye Getachew Mulugeta Dawit Haile Yohannes Bekele Mesfin Tadesse Kiprop Otieno Kamau Kibet Mugisha Tumusiime Okello Opio Hery Rivo Tiana Deng Garang'),
      first_f: L('Amina Zawadi Neema Rehema Imani Halima Mwanaisha Wanjiru Njeri Akinyi Achieng Atieno Chebet Wambui Almaz Tigist Meron Hiwot Selam Saba Genet Mekdes Liya Aster Uwase Ingabire Mukamana Grace Faith Mercy Joy Esther Nyibol Voahangy Lalao'),
      last: L('Mwangi Kamau Otieno Ochieng Odhiambo Kiprono Kipchoge Njoroge Wanjiku Mutua Kimani Omondi Onyango Mwakyusa Mohamed Juma Mushi Massawe Tesfaye Bekele Haile Girma Alemu Mengistu Gebre Kebede Desta Habimana Niyonzima Uwimana Mugisha Okello Ssempala Nsubuga Rakotomalala Randrianarisoa Andriamanana Deng Garang Akol Mabior')
    },
    african_south: {
      first_m: L('Thabo Sipho Themba Bongani Mandla Sibusiso Lwazi Kagiso Tshepo Tumelo Mpho Tendai Tatenda Farai Tafadzwa Kudakwashe Blessing Brighton Mwila Chanda Bwalya Mulenga Kondwani Chikondi Kgosi Mothusi Tebogo Pule Andile Siyabonga Lungile Tjiuma Ndapanda'),
      first_f: L('Nomvula Thandiwe Zanele Nokuthula Lindiwe Ayanda Busisiwe Palesa Lerato Naledi Dineo Refilwe Kgomotso Boitumelo Nthabiseng Chipo Rutendo Nyasha Tsitsi Rufaro Ruvimbo Mutinta Chileshe Mapalo Thokozani Precious Memory Tiyamike Ndapewa Nangula Hlengiwe Sibongile Nompumelelo Phindile Zodwa'),
      last: L('Nkosi Dlamini Ndlovu Khumalo Mokoena Mahlangu Zulu Mthembu Ngcobo Sithole Mabaso Molefe Moloi Radebe Mofokeng Botha Van_der_Merwe Pretorius Moyo Ncube Sibanda Mpofu Chikwanha Mutasa Banda Phiri Mwale Tembo Mbewe Lungu Chanda Mulenga Kasonde Kgosana Shikongo Nghipondoka Amukoto Masilela Tshabalala Shabangu Hadebe')
    },
    african_central: {
      first_m: L('Jean-Pierre Joseph Patrice Didier F\u00e9lix Christian Thierry Serge Blaise Paul Ars\u00e8ne Herv\u00e9 Fiston Tr\u00e9sor Gloire Dieudonn\u00e9 Prince Bienvenu Fabrice Junior Landry Rodrigue Mo\u00efse Idriss Mahamat Abakar Saleh Faustin D\u00e9sir\u00e9 Aim\u00e9 Cl\u00e9ment Bertrand'),
      first_f: L('Marie Gr\u00e2ce Chantal Jos\u00e9e B\u00e9atrice Odette Pascaline Merveille Gloria Divine Ornella Esther Rachel Sarah Nad\u00e8ge Clarisse Francine Solange Yvette Jeanne Mireille Prisca Carine Rosalie Fatim\u00e9 Achta Mariam Zara Hawa F\u00e9licit\u00e9 Aur\u00e9lie Brigitte Christelle Sandrine'),
      last: L('Mukendi Kabongo Ilunga Tshibangu Kalala Mbuyi Kasongo Ngoy Mutombo Lukusa Nzuzi Mbala Makiese Kanda Mbemba Massamba Nkounkou Moukoko Ngoma Ndongo Essomba Mbarga Atangana Nkoulou Fouda Ondo Obame Mba Nguema Ndong Mahamat Abakar Djimet Ngaba Yakit\u00e9 Zanga Gbaya Koyara Ngouandjika Malonga')
    }
  };
  var CZ_FEM = { 'Nov\u00e1k': 1, 'Svoboda': 1, 'Dvo\u0159\u00e1k': 1, 'Proch\u00e1zka': 1, 'Ku\u010dera': 1, 'Horv\u00e1th': 1, 'Kov\u00e1\u010d': 1 };
  function feminize(culture, s) {
    if (culture === 'slavic' || culture === 'balkan' || culture === 'turkic') {
      if (culture === 'slavic' && CZ_FEM[s]) return (s.charAt(s.length - 1) === 'a' ? s.slice(0, -1) : s) + 'ov\u00e1';
      if (/(ov|ev|in|yn)$/.test(s)) return s + 'a';
      if (/skiy$/.test(s)) return s.slice(0, -4) + 'skaya';
      if (/(ski|cki)$/.test(s)) return s.slice(0, -1) + 'a';
      if (/\u00fd$/.test(s)) return s.slice(0, -1) + '\u00e1';
      return s;
    }
    if (culture === 'greek') {
      if (/os$/.test(s)) return s.slice(0, -2) + 'ou';
      if (/is$/.test(s)) return s.slice(0, -1);
      if (/as$/.test(s)) return s.slice(0, -1);
      return s;
    }
    if (culture === 'baltic') {
      if (/i\u0146\u0161$/.test(s)) return s.slice(0, -1) + 'a';
      if (/ols$/.test(s)) return s.slice(0, -1) + 'a';
      if (/ons$/.test(s)) return s.slice(0, -1) + 'e';
      if (/dis$/.test(s)) return s.slice(0, -2) + 'e';
      if (/ius$/.test(s)) return s.slice(0, -3) + 'ien\u0117';
      if (/(as|us)$/.test(s)) return s.slice(0, -2) + 'ien\u0117';
      return s;
    }
    return s;
  }
  var SURNAME_FIRST = { chinese: 1, korean: 1 };
  function getList(culture) { return lists[culture] || lists.anglo; }
  function isF(sex) { return sex === 1 || sex === 'f' || sex === 'F' || sex === true; }

  GS.Names = {
    lists: lists,
    cultures: Object.keys(lists),
    first: function (culture, sex, rng) { var l = getList(culture); var a = isF(sex) ? l.first_f : l.first_m; return Math.floor(rnd(rng) * a.length) % a.length; },
    last: function (culture, rng) { var l = getList(culture); return Math.floor(rnd(rng) * l.last.length) % l.last.length; },
    str: function (culture, sex, firstIdx, lastIdx) {
      var l = getList(culture); var fa = isF(sex) ? l.first_f : l.first_m;
      var f = fa[((firstIdx | 0) % fa.length + fa.length) % fa.length];
      var s = l.last[((lastIdx | 0) % l.last.length + l.last.length) % l.last.length];
      if (isF(sex)) s = feminize(lists[culture] ? culture : 'anglo', s);
      return SURNAME_FIRST[culture] ? s + ' ' + f : f + ' ' + s;
    },
    leader: function (culture, rng) {
      var sex = rnd(rng) < 0.2 ? 1 : 0;
      var fi = GS.Names.first(culture, sex, rng), li = GS.Names.last(culture, rng);
      return { name: GS.Names.str(culture, sex, fi, li), sex: sex };
    },
    // kind: 'rebel'|'left'|'communist'|'right'|'nationalist'|'democratic'|'liberal'|'provisional'|'junta'|'military'|
    //       'theocracy'|'religious'|'monarchy'|'anarchy'|'secession'|'independence'|'free'  or an ideology {econ,auth,nat}
    newCountryName: function (baseName, kind, rng) {
      var X = String(baseName || 'the Land');
      var k = kind;
      if (k && typeof k === 'object') {
        var e = +k.econ || 0, a = +k.auth || 0, n = +k.nat || 0;
        k = e < -0.35 ? (a > 0.2 ? 'communist' : 'left') : (a > 0.5 ? (n > 0.6 ? 'nationalist' : 'junta') : (a < -0.1 ? 'democratic' : (n > 0.6 ? 'nationalist' : 'provisional')));
      }
      k = String(k || 'rebel').toLowerCase();
      var T = {
        left: ["{X} People's Republic", "People's Republic of {X}", "Socialist Republic of {X}", "{X} Workers' Republic", "{X} Commune"],
        communist: ["{X} People's Republic", "People's Republic of {X}", "Socialist Republic of {X}", "{X} Soviet Republic", "Democratic People's Republic of {X}"],
        right: ["{X} National State", "Republic of {X}", "{X} Patriotic Republic", "Greater {X}"],
        nationalist: ["{X} National State", "Greater {X}", "{X} Patriotic Republic", "National Republic of {X}", "{X} Homeland"],
        democratic: ["Democratic {X}", "Democratic Republic of {X}", "Free Republic of {X}", "Republic of {X}", "Federal Republic of {X}"],
        liberal: ["Free Republic of {X}", "Democratic {X}", "Federal Republic of {X}", "Republic of {X}"],
        provisional: ["Provisional Government of {X}", "Transitional Council of {X}", "Interim Authority of {X}", "Provisional Republic of {X}"],
        junta: ["{X} Military Council", "National Salvation Council of {X}", "State of {X}", "{X} Revolutionary Command"],
        military: ["{X} Military Council", "National Salvation Council of {X}", "{X} Revolutionary Command"],
        theocracy: ["Holy State of {X}", "{X} Theocratic Republic", "Sacred Republic of {X}", "{X} Covenant State"],
        religious: ["Holy State of {X}", "{X} Theocratic Republic", "Sacred Republic of {X}"],
        monarchy: ["Kingdom of {X}", "Grand Duchy of {X}", "Principality of {X}", "Sultanate of {X}"],
        anarchy: ["{X} Free Territory", "Free Communes of {X}", "{X} Autonomous Zone"],
        secession: ["Republic of {X}", "Free {X}", "Independent {X}", "{X}", "{X} Republic"],
        independence: ["Republic of {X}", "Free {X}", "Independent {X}", "{X} Republic"],
        free: ["Free Republic of {X}", "Free {X}", "Free State of {X}"],
        rebel: ["Free Republic of {X}", "{X} People's Republic", "Provisional Government of {X}", "Democratic {X}", "{X} Liberation Front", "National Salvation Council of {X}", "Republic of New {X}"]
      };
      var arr = T[k] || T.rebel;
      var tpl = arr[Math.floor(rnd(rng) * arr.length) % arr.length];
      return tpl.replace('{X}', X);
    }
  };
})();
