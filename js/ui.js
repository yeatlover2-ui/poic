/* GODSIM ui.js — GS.UI: panels, god palette, inspector, citizen card, news feed, global charts (DOM).
 * Reads the world defensively (other modules may omit fields); god powers go through GS.God / GS.World.scenarios. */
(function () {
  'use strict';
  var GS = globalThis.GS = globalThis.GS || {};
  var M = Math;

  // ------------------------------------------------------------------ helpers
  function $(id) { return document.getElementById(id); }
  function num(x, d) { return (typeof x === 'number' && isFinite(x)) ? x : d; }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : (x === x ? x : a)); }
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function fmtNum(n) {
    n = num(n, 0);
    if (GS.U && GS.U.fmtNum) { try { return GS.U.fmtNum(n); } catch (e) { /* fallthrough */ } }
    var a = M.abs(n);
    return a >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(M.round(n));
  }
  function fmtMoney(b) {
    b = num(b, 0);
    if (GS.U && GS.U.fmtMoney) { try { return GS.U.fmtMoney(b); } catch (e) { /* fallthrough */ } }
    return b >= 1000 ? '$' + (b / 1000).toFixed(2) + 'T' : '$' + b.toFixed(1) + 'B';
  }
  function fmtUSD(x) {
    x = num(x, 0); var s = x < 0 ? '-' : ''; x = M.abs(x);
    return s + (x >= 1e9 ? '$' + (x / 1e9).toFixed(1) + 'B' : x >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : x >= 1e4 ? '$' + M.round(x / 1e3) + 'K' : x >= 1e3 ? '$' + (x / 1e3).toFixed(1) + 'K' : '$' + M.round(x));
  }
  function pct(x, d) { return (num(x, 0) * 100).toFixed(d === undefined ? 1 : d) + '%'; }
  function spct(x, d) { x = num(x, 0); return (x >= 0 ? '+' : '−') + (M.abs(x) * 100).toFixed(d === undefined ? 1 : d) + '%'; }
  function rgb(c, a) { if (!c || c.length < 3) c = [120, 120, 130]; return a === undefined ? 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')' : 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; }
  function dateFull(t) { try { var d = GS.dateOf(num(t, 0)); return d.full || d.str || String(t); } catch (e) { return 'week ' + t; } }
  function dateShort(t) { try { var d = GS.dateOf(num(t, 0)); return d.str || d.full || String(t); } catch (e) { return 'wk ' + t; } }
  function C(W, id) { return (W && W.countries && id >= 0 && id < W.countries.length) ? W.countries[id] : null; }
  function cname(W, id) { var c = C(W, id); return c ? c.name : '—'; }
  function clink(W, id) {
    var c = C(W, id); if (!c) return '<span class="empty">unknown</span>';
    return '<span class="link" data-cid="' + id + '">' + esc(c.name) + '</span>' + (c.alive ? '' : ' <span class="empty">(gone)</span>');
  }
  function govLabel(g) {
    try { var gi = GS.Politics && GS.Politics.govInfo ? GS.Politics.govInfo(g) : null; if (gi && gi.label) return gi.label; } catch (e) { /* ignore */ }
    return String(g || 'unknown').replace(/_/g, ' ');
  }
  function ramp3(t) { // red → amber → green
    t = clamp(num(t, 0.5), 0, 1);
    return t < 0.5 ? [230, 70 + 250 * t, 60] : [230 - (t - 0.5) * 340, 195, 60 + (t - 0.5) * 120];
  }
  function warsOf(W, id) {
    var out = [], ws = W.wars || [];
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i]; if (!w || w.ended) continue;
      if ((w.attackers || []).indexOf(id) >= 0 || (w.defenders || []).indexOf(id) >= 0) out.push(w);
    }
    return out;
  }
  function activeWars(W) {
    var out = [], ws = W.wars || [];
    for (var i = 0; i < ws.length; i++) if (ws[i] && !ws[i].ended) out.push(ws[i]);
    return out;
  }
  function warName(W, w) { return w.name || (cname(W, w.attackerLeader) + '–' + cname(W, w.defenderLeader) + ' war'); }

  var GOV_COL = {
    democracy: [64, 142, 232], flawed_democracy: [112, 182, 228], hybrid: [204, 182, 88], autocracy: [214, 106, 58],
    oneparty: [200, 50, 60], theocracy: [46, 158, 106], monarchy: [155, 89, 208], junta: [138, 143, 58], anarchy: [90, 84, 78]
  };
  var SHORT_GOV = { democracy: 'Democ.', flawed_democracy: 'Flawed', hybrid: 'Hybrid', autocracy: 'Autoc.', oneparty: '1-party', theocracy: 'Theoc.', monarchy: 'Monar.', junta: 'Junta', anarchy: 'Anarchy' };
  var TYPE_COL = { war: '#ff4d4d', politics: '#b48cff', economy: '#3fd07f', diplomacy: '#5aa9ff', alliance: '#5aa9ff', god: '#e9b949', world: '#9aa7bd', people: '#ff9ad5', plague: '#a6ff4d', disaster: '#ff9a3c' };
  var FILTERS = [
    { id: 'major', label: '★ Major' }, { id: 'all', label: 'All' }, { id: 'war', label: 'War', types: ['war'] }, { id: 'politics', label: 'Politics', types: ['politics'] },
    { id: 'economy', label: 'Economy', types: ['economy'] }, { id: 'diplomacy', label: 'Diplomacy', types: ['diplomacy', 'alliance'] },
    { id: 'god', label: 'Divine', types: ['god'] }, { id: 'other', label: 'Other' }
  ];
  var KNOWN_TYPES = ['war', 'politics', 'economy', 'diplomacy', 'alliance', 'god'];

  var POWERS = [
    { g: 'Catastrophes', id: 'meteor', icon: '☄️', name: 'Meteor', target: 'region', fx: 'meteor', desc: 'Hurl a meteor at a region: most of its people die, the land is devastated, neighbours are scorched and fear grips the world.' },
    { g: 'Catastrophes', id: 'nuke', icon: '☢️', name: 'Nuclear strike', target: 'region', fx: 'nuke', desc: 'Detonate a nuclear weapon of unknown origin over a region. Mass death, devastation, global panic and suspicion.' },
    { g: 'Catastrophes', id: 'disaster', icon: '🌋', name: 'Natural disaster', target: 'region', fx: 'disaster', desc: 'Earthquake, tsunami, typhoon or eruption strikes a region: deaths, ruined cities, economic damage.' },
    { g: 'Catastrophes', id: 'plague', icon: '🦠', name: 'Plague', target: 'region', fx: 'plague', args: [0.7], desc: 'Seed a new disease in a region. It spreads through people, trade and migration on its own.' },
    { g: 'Catastrophes', id: 'famine', icon: '🥀', name: 'Famine', target: 'country', fx: 'disaster', desc: 'The harvests of a nation fail: starvation, misery, unrest and food dependence.' },
    { g: 'Statecraft', id: 'erase', icon: '🕳️', name: 'Erase nation', target: 'country', fx: 'nuke', desc: 'A nation vanishes from existence — people, state, armies. Its land becomes empty. Watch the world react.' },
    { g: 'Statecraft', id: 'collapse', icon: '🏚️', name: 'Collapse state', target: 'country', fx: 'war', desc: 'The government fails overnight: anarchy, deserting soldiers, warlords and a likely civil war.' },
    { g: 'Statecraft', id: 'revolution', icon: '✊', name: 'Revolution', target: 'country', fx: 'war', desc: 'Radicalise the people and light the revolutionary fuse.' },
    { g: 'Statecraft', id: 'assassinate', icon: '🎯', name: 'Assassinate leader', target: 'country', fx: 'war', desc: 'Kill the head of state. Succession, instability and opportunism follow.' },
    { g: 'Minds of rulers', id: 'warmonger', icon: '😈', name: 'Warmonger', target: 'country', fx: 'war', desc: 'Fill a leader with aggression and ambition, strip away caution. Whether they attack depends on their odds.' },
    { g: 'Minds of rulers', id: 'pacify', icon: '🕊️', name: 'Pacify', target: 'country', desc: 'Make a leader peaceful, cautious and content.' },
    { g: 'Minds of rulers', id: 'forceWar', icon: '⚔️', name: 'Force war', target: 'pair', fx: 'war', desc: 'Drive one nation to declare war on another. Click the aggressor, then the victim. Alliances decide the rest.' },
    { g: 'Blessings', id: 'prosperity', icon: '✨', name: 'Golden age', target: 'country', desc: 'Bless a nation with productivity, confidence and happiness.' },
    { g: 'Blessings', id: 'armUp', icon: '🛡️', name: 'Arm up', target: 'country', desc: 'Double a nation’s military stock. Neighbours will notice.' },
    { g: 'Blessings', id: 'discoverOil', icon: '🛢️', name: 'Discover oil', target: 'country', desc: 'Vast oil reserves are found beneath a nation: riches, and appetites.' },
    { g: 'Global', id: 'marketCrash', icon: '📉', name: 'Market crash', target: 'global', desc: 'Black Monday: global markets crash instantly. Applied immediately.' }
  ];
  var SCENARIOS = [
    { id: 'eraseUSA', label: '🕳️ Erase USA', cls: 'danger' },
    { id: 'eraseChina', label: '🕳️ Erase China', cls: 'danger' },
    { id: 'collapseRussia', label: '🏚️ Collapse Russia', cls: 'danger' },
    { id: 'globalPlague', label: '🦠 Global plague', cls: 'danger' },
    { id: 'singlePlague', label: '🦠 Outbreak in one city', cls: 'danger' },
    { id: 'restart', label: '🎲 Random seed restart', cls: '' }
  ];

  // ------------------------------------------------------------------ state
  var U = {
    W: null, power: null, forceA: -1, newsFilter: 'major', newsKey: '', newsSeen: -1,
    citizen: -1, citKey: '', citT: 0, cache: {}, inspFor: null, scatterT: 0, scatterFor: -2, sample: null,
    tip: { rid: -1, x: 0, y: 0 }, errs: {}, legendKey: '', lastUpdate: 0, paused: false, speed: 1, inited: false
  };

  function setHTML(key, el, html) {
    if (!el) return;
    if (U.cache[key] === html) return;
    U.cache[key] = html; el.innerHTML = html;
  }
  function safe(key, f) {
    try { f(); } catch (e) {
      if (!U.errs[key]) { U.errs[key] = 1; console.error('[UI ' + key + ']', e); toast('UI error in ' + key + ': ' + (e && e.message), 'error', 6000); }
    }
  }

  // event delegation that survives innerHTML refreshes between pointerdown and pointerup
  function delegate(root, handler) {
    if (!root) return;
    var downKey = null;
    function keyOf(t) { return (t.getAttribute('data-act') || '') + '|' + (t.getAttribute('data-cid') || '') + '|' + (t.getAttribute('data-arg') || ''); }
    root.addEventListener('pointerdown', function (e) { var t = e.target.closest && e.target.closest('[data-cid],[data-act]'); downKey = t && root.contains(t) ? keyOf(t) : null; });
    root.addEventListener('pointerup', function (e) {
      if (e.button !== 0) return;
      var t = e.target.closest && e.target.closest('[data-cid],[data-act]');
      if (t && downKey && keyOf(t) === downKey) handler(t, e);
      downKey = null;
    });
  }

  // ------------------------------------------------------------------ init
  function init() {
    if (U.inited) return; U.inited = true;
    buildPowers(); buildScenarios(); buildMapBar(); buildNewsFilters(); buildCharts(); buildStats();
    // collapse toggles
    var cols = document.querySelectorAll('[data-collapse]');
    for (var i = 0; i < cols.length; i++) cols[i].addEventListener('click', onCollapse);
    $('zoomctl').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b || !GS.MapView) return;
      var z = b.getAttribute('data-zoom');
      if (z === 'in') GS.MapView.zoomBy(1.6); else if (z === 'out') GS.MapView.zoomBy(1 / 1.6); else GS.MapView.resetView();
    });
    $('btnPlay').addEventListener('click', function () { if (GS.Main) GS.Main.togglePause(); });
    $('speeds').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b && GS.Main) GS.Main.setSpeed(+b.getAttribute('data-speed')); });
    $('btnRestart').addEventListener('click', function () { if (GS.Main) GS.Main.restart(); });
    $('btnDeselect').addEventListener('click', function () { select(-1); });
    delegate($('right'), onInspectorAct);
    delegate($('newsList'), onNewsAct);
    document.addEventListener('keydown', onKey);
    if (window.innerWidth < 1200) $('app').classList.add('lc');
    var tip = $('tooltip'); if (tip) tip.hidden = true;
    if (GS.MapView) {
      GS.MapView.init($('map'), {
        onHover: onHover, onClick: onMapClick,
        blockDblZoom: function () { return !!U.power; }
      });
    }
  }

  function onCollapse(e) {
    var w = e.currentTarget.getAttribute('data-collapse'), app = $('app');
    var cls = w === 'left' ? 'lc' : (w === 'right' ? 'rc' : 'bc');
    app.classList.toggle(cls);
    setTimeout(function () { if (GS.MapView) GS.MapView.resize(); }, 260);
  }

  function buildPowers() {
    var host = $('powers'), html = '', g = '';
    for (var i = 0; i < POWERS.length; i++) {
      var p = POWERS[i];
      if (p.g !== g) { if (g) html += '</div>'; g = p.g; html += '<div class="pgroup"><div class="pgroup-title">' + esc(g) + '</div>'; }
      var tg = p.target === 'region' ? 'region' : p.target === 'pair' ? '2 nations' : p.target === 'global' ? 'world' : 'nation';
      html += '<button class="power" data-power="' + p.id + '" title="' + esc(p.name + ' — ' + p.desc) + '"><span class="ic">' + p.icon + '</span><span class="nm">' + esc(p.name) + '</span><span class="tg">' + tg + '</span></button>';
    }
    html += '</div>';
    host.innerHTML = html;
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-power]'); if (!b) return;
      var id = b.getAttribute('data-power');
      if (U.power && U.power.id === id) { disarm(); return; }
      arm(id);
    });
  }
  function buildScenarios() {
    var host = $('scenarios'), html = '';
    for (var i = 0; i < SCENARIOS.length; i++) html += '<button class="btn ' + SCENARIOS[i].cls + '" data-scn="' + SCENARIOS[i].id + '" title="' + SCENARIOS[i].label.replace(/^\S+\s/, '') + '">' + SCENARIOS[i].label + '</button>';
    host.innerHTML = html;
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-scn]'); if (!b) return;
      runScenario(b.getAttribute('data-scn'));
    });
  }
  function buildMapBar() {
    var MV = GS.MapView; if (!MV) return;
    var m = '', o = '', i, ov = MV.getOverlays();
    for (i = 0; i < MV.MODES.length; i++) m += '<button data-mode="' + MV.MODES[i].id + '"' + (MV.getMode() === MV.MODES[i].id ? ' class="on"' : '') + '>' + esc(MV.MODES[i].label) + '</button>';
    for (i = 0; i < MV.OVERLAYS.length; i++) o += '<button data-ov="' + MV.OVERLAYS[i].id + '"' + (ov[MV.OVERLAYS[i].id] ? ' class="on"' : '') + '>' + esc(MV.OVERLAYS[i].label) + '</button>';
    $('modes').innerHTML = m; $('overlays').innerHTML = o;
    $('modes').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mode]'); if (!b) return;
      MV.setMode(b.getAttribute('data-mode'));
      var bs = $('modes').querySelectorAll('button');
      for (var k = 0; k < bs.length; k++) bs[k].classList.toggle('on', bs[k] === b);
      renderLegend(U.W, true);
    });
    $('overlays').addEventListener('click', function (e) {
      var b = e.target.closest('[data-ov]'); if (!b) return;
      b.classList.toggle('on', MV.toggleOverlay(b.getAttribute('data-ov')));
      renderLegend(U.W, true);
    });
  }
  function buildNewsFilters() {
    var html = '';
    for (var i = 0; i < FILTERS.length; i++) {
      var f = FILTERS[i], col = f.types ? TYPE_COL[f.types[0]] : (f.id === 'other' ? '#9aa7bd' : null);
      html += '<button data-f="' + f.id + '"' + (f.id === U.newsFilter ? ' class="on"' : '') + '>' + (col ? '<i style="background:' + col + '"></i>' : '') + esc(f.label) + '</button>';
    }
    var host = $('newsFilters'); host.innerHTML = html;
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]'); if (!b) return;
      U.newsFilter = b.getAttribute('data-f');
      var bs = host.querySelectorAll('button');
      for (var k = 0; k < bs.length; k++) bs[k].classList.toggle('on', bs[k] === b);
      renderNews(U.W, true);
    });
  }
  var CHARTS = [
    { id: 'market', label: 'Global markets', key: 'market', col: [90, 169, 255] },
    { id: 'oil', label: 'Oil $/bbl', key: 'oil', col: [233, 185, 73] },
    { id: 'fear', label: 'Fear', key: 'fear', col: [255, 77, 77] },
    { id: 'gdp', label: 'World GDP', key: 'gdp', col: [63, 208, 127] }
  ];
  function buildCharts() {
    var html = '';
    for (var i = 0; i < CHARTS.length; i++) html += '<div class="chart"><div class="ch"><span>' + CHARTS[i].label + '</span><b id="chv-' + CHARTS[i].id + '">—</b></div><canvas id="chc-' + CHARTS[i].id + '"></canvas></div>';
    $('charts').innerHTML = html;
  }
  function buildStats() {
    var defs = [
      ['pop', 'Population', ''], ['gdp', 'World GDP', ''], ['mkt', 'Markets', ''], ['oil', 'Oil', ''], ['food', 'Food', 'opt'],
      ['fear', 'Fear', ''], ['wars', 'Wars', ''], ['nations', 'Nations', 'opt'], ['deaths', 'War dead', 'opt'], ['nukes', 'Nukes used', '']
    ];
    var html = '';
    for (var i = 0; i < defs.length; i++) html += '<div class="stat ' + defs[i][2] + '" id="st-' + defs[i][0] + '"><div class="k">' + defs[i][1] + '</div><div class="v" id="sv-' + defs[i][0] + '">—</div></div>';
    $('stats').innerHTML = html;
  }

  // ------------------------------------------------------------------ world binding
  function setWorld(W) {
    U.W = W; U.cache = {}; U.newsKey = ''; U.newsSeen = -1; U.inspFor = null; U.scatterFor = -2; U.sample = null;
    U.legendKey = ''; U.citizen = -1; U.citKey = ''; U.forceA = -1;
    if (W) W.selected = -1;
    disarm();
    if (GS.MapView) { GS.MapView.setWorld(W); GS.MapView.follow(-1); }
    pickCitizen();
    update(W, true);
  }

  function select(id, opts) {
    var W = U.W; if (!W) return;
    id = (typeof id === 'number' && id >= 0 && C(W, id)) ? id : -1;
    var changed = W.selected !== id;
    W.selected = id;
    if (GS.MapView) { GS.MapView.invalidate(); if (id >= 0 && opts && opts.reveal) GS.MapView.reveal(id); }
    if (changed) {
      U.scatterFor = -2;
      var f = GS.MapView ? GS.MapView.getFollow() : -1;
      if (f < 0) pickCitizen();
      if ($('rightScroll')) $('rightScroll').scrollTop = 0;
    }
    if ($('app').classList.contains('rc') && id >= 0) { $('app').classList.remove('rc'); setTimeout(function () { if (GS.MapView) GS.MapView.resize(); }, 260); }
    renderInspector(W, true);
    renderCitizen(W, true);
    renderLegend(W, true);
  }

  // ------------------------------------------------------------------ god powers
  function powerDef(id) { for (var i = 0; i < POWERS.length; i++) if (POWERS[i].id === id) return POWERS[i]; return null; }
  function arm(id) {
    var p = powerDef(id); if (!p) return;
    if (p.target === 'global') { applyGlobal(p); return; }
    U.power = p; U.forceA = -1;
    refreshArmed();
  }
  function disarm() {
    U.power = null; U.forceA = -1;
    refreshArmed();
  }
  function refreshArmed() {
    var bs = document.querySelectorAll('.power');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', !!U.power && bs[i].getAttribute('data-power') === U.power.id);
    var ins = $('instruction'), help = $('powerHelp'), wrap = $('mapwrap'), p = U.power;
    if (wrap) wrap.classList.toggle('armed', !!p);
    if (!p) {
      if (ins) ins.hidden = true;
      if (help) { help.classList.remove('armed'); help.innerHTML = 'Choose a power, then click the map. <kbd>Esc</kbd> cancels. Hold <kbd>Shift</kbd> to keep a power armed.'; }
      return;
    }
    var msg;
    if (p.target === 'region') msg = '<b>' + p.icon + ' ' + esc(p.name) + '</b> — click a region to strike';
    else if (p.target === 'pair') msg = U.forceA < 0 ? '<b>' + p.icon + ' Force war</b> — step 1: click the <b>aggressor</b>'
      : '<b>' + p.icon + ' ' + esc(cname(U.W, U.forceA)) + '</b> will attack — step 2: click the <b>victim</b>';
    else msg = '<b>' + p.icon + ' ' + esc(p.name) + '</b> — click a nation';
    if (ins) { ins.innerHTML = msg + '<span class="esc">Esc to cancel</span>'; ins.hidden = false; }
    if (help) { help.classList.add('armed'); help.innerHTML = esc(p.desc); }
  }
  function afterGod(W) {
    if (GS.MapView) GS.MapView.invalidate();
    U.newsKey = ''; U.cache = {}; U.scatterFor = -2;
    update(W, true);
  }
  function applyGlobal(p) {
    var W = U.W; if (!W || !GS.God || typeof GS.God[p.id] !== 'function') { toast('That power is not available.', 'error'); return; }
    try { GS.God[p.id](W); toast(p.icon + ' ' + p.name + '.', 'god'); } catch (e) { reportErr(p.name, e); }
    afterGod(W);
  }
  function onMapClick(rid, e) {
    var W = U.W; if (!W) return;
    var r = rid >= 0 ? W.regions[rid] : null;
    var owner = r ? num(r.owner, -1) : -1;
    if (!U.power) {
      select(owner >= 0 && C(W, owner) && C(W, owner).alive ? owner : -1);
      return;
    }
    var p = U.power, keep = !!(e && e.shiftKey), God = GS.God || {}, fn = God[p.id], res, fxRegion = rid;
    if (typeof fn !== 'function') { toast('The power “' + p.name + '” is not available.', 'error'); disarm(); return; }
    try {
      if (p.target === 'region') {
        if (!r) { toast('Strike land, not the sea.', 'info'); return; }
        res = p.args ? fn(W, rid, p.args[0]) : fn(W, rid);
      } else if (p.target === 'country') {
        if (owner < 0 || !C(W, owner) || !C(W, owner).alive) { toast('No nation rules this land.', 'info'); return; }
        res = fn(W, owner);
        var cc = C(W, owner); if (cc && cc.capital >= 0) fxRegion = cc.capital;
      } else if (p.target === 'pair') {
        if (owner < 0 || !C(W, owner) || !C(W, owner).alive) { toast('Click a nation.', 'info'); return; }
        if (U.forceA < 0) { U.forceA = owner; refreshArmed(); select(owner); return; }
        if (owner === U.forceA) { toast('A nation cannot declare war on itself — pick a different victim.', 'info'); return; }
        res = fn(W, U.forceA, owner);
        if (!res) { toast(cname(W, U.forceA) + ' and ' + cname(W, owner) + ' are already at war (or war could not be declared).', 'info'); res = null; }
        else toast('⚔ ' + cname(W, U.forceA) + ' declares war on ' + cname(W, owner), 'god');
        U.forceA = -1;
      }
    } catch (err) { reportErr(p.name, err); }
    if (res === false) toast('Nothing happened.', 'info');
    else if (res && p.target !== 'pair') toast(p.icon + ' ' + p.name + (p.target === 'country' && owner >= 0 ? ': ' + cname(W, owner) : (r ? ': ' + r.name : '')), 'god');
    if (GS.MapView && fxRegion >= 0 && res !== false) GS.MapView.flash(fxRegion, p.fx || 'god');
    if (!keep) disarm(); else refreshArmed();
    afterGod(W);
  }
  function runScenario(id) {
    var W = U.W;
    if (id === 'restart') { if (GS.Main) GS.Main.restart(); return; }
    if (!W) return;
    var S = GS.World && GS.World.scenarios;
    if (!S || typeof S[id] !== 'function') { toast('Scenario unavailable.', 'error'); return; }
    try {
      var ok = S[id](W);
      if (ok === false || ok === null) toast('Nothing to do — it is already gone.', 'info');
      else { for (var si = 0; si < SCENARIOS.length; si++) if (SCENARIOS[si].id === id) toast(SCENARIOS[si].label, 'god'); }
    } catch (e) { reportErr('scenario ' + id, e); }
    afterGod(W);
  }
  function reportErr(what, e) {
    console.error(e);
    toast(what + ' failed: ' + (e && e.message ? e.message : e), 'error', 7000);
  }

  // ------------------------------------------------------------------ keyboard
  function onKey(e) {
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space' || e.key === ' ') { e.preventDefault(); if (GS.Main) GS.Main.togglePause(); return; }
    if (e.key >= '1' && e.key <= '5') { if (GS.Main) GS.Main.setSpeed(+e.key); return; }
    if (e.key === 'Escape') { if (U.power) disarm(); else if (U.W && U.W.selected >= 0) select(-1); return; }
    if (e.key === '+' || e.key === '=') { if (GS.MapView) GS.MapView.zoomBy(1.5); return; }
    if (e.key === '-' || e.key === '_') { if (GS.MapView) GS.MapView.zoomBy(1 / 1.5); return; }
    if (e.key === '0') { if (GS.MapView) GS.MapView.resetView(); }
  }

  // ------------------------------------------------------------------ tooltip
  function onHover(rid, e) {
    U.tip.rid = rid;
    if (!U.mapRect || (U.mapRectT | 0) + 1000 < Date.now()) { var mwr = $('mapwrap'); if (mwr) { U.mapRect = mwr.getBoundingClientRect(); U.mapRectT = Date.now(); } }
    if (e) { U.tip.x = e.clientX; U.tip.y = e.clientY; }
    renderTooltip(U.W);
  }
  function renderTooltip(W) {
    var el = $('tooltip'); if (!el) return;
    var rid = U.tip.rid;
    if (!W || rid < 0 || !W.regions[rid]) { el.hidden = true; return; }
    var r = W.regions[rid], c = r.owner >= 0 ? C(W, r.owner) : null, html = '';
    if (!c || !c.alive) {
      var core = C(W, r.core);
      html = '<div class="tt-h"><span class="sw" style="width:12px;height:12px;border-radius:3px;background:#3a3f4a"></span>Ungoverned land</div>' +
        '<div class="tt-sub">' + esc(r.name) + (core && core.name !== r.name && r.name.indexOf(core.name) < 0 ? ' · formerly ' + esc(core.name) : (core ? ' · formerly a nation' : '')) + '</div>';
      if (num(r.devastation, 0) > 0.02) html += '<div class="tt-row">Devastation <b>' + pct(r.devastation, 0) + '</b></div>';
      var stl = r.settle, sb = -1, sv = 0;
      if (stl) for (var sk in stl) if (stl[sk] > sv && C(W, +sk) && C(W, +sk).alive) { sv = stl[sk]; sb = +sk; }
      if (sb >= 0) html += '<div class="tt-row">Being settled by <b>' + esc(cname(W, sb)) + ' (' + pct(M.min(1, sv), 0) + ')</b></div>';
    } else {
      var L = c.leader;
      html = '<div class="tt-h"><span class="sw" style="width:12px;height:12px;border-radius:3px;background:' + rgb(c.color) + '"></span>' + esc(c.name) + '</div>';
      if (r.name && r.name !== c.name) html += '<div class="tt-sub">' + esc(r.name) + (r.core !== c.id && C(W, r.core) ? ' · occupied from ' + esc(cname(W, r.core)) : '') + '</div>';
      html += '<div class="tt-row">Leader <b>' + esc(L && L.name ? L.name : 'none') + (L && L.age ? ', ' + M.floor(L.age) : '') + '</b></div>';
      html += '<div class="tt-row">Government <b>' + esc(govLabel(c.gov)) + '</b></div>';
      html += '<div class="tt-row">Population <b>' + fmtNum(c.pop) + '</b></div>';
      html += '<div class="tt-row">GDP <b>' + fmtMoney(c.gdp) + ' <span class="' + (num(c.growth, 0) >= 0 ? 'up' : 'down') + '">' + spct(c.growth) + '</span></b></div>';
      html += '<div class="tt-row">Unrest <b>' + pct(c.unrest, 0) + '</b></div>';
      var ws = warsOf(W, c.id);
      if (ws.length) {
        var en = [];
        for (var i = 0; i < ws.length; i++) {
          var mine = (ws[i].attackers || []).indexOf(c.id) >= 0, opp = mine ? ws[i].defenders : ws[i].attackers;
          for (var k = 0; k < (opp || []).length; k++) if (en.indexOf(opp[k]) < 0) en.push(opp[k]);
        }
        html += '<div class="tt-war">⚔ At war with ' + esc(en.slice(0, 3).map(function (x) { return cname(W, x); }).join(', ')) + (en.length > 3 ? ' +' + (en.length - 3) : '') + '</div>';
      }
      if (c.civilWar) html += '<div class="tt-war" style="color:#ffbf80">🔥 Civil war' + (c.civilWar.rebelName ? ' vs ' + esc(c.civilWar.rebelName) : '') + '</div>';
    }
    if (U.power) {
      var p = U.power;
      if (p.target === 'region') html += '<div class="tt-hint">Click: ' + p.icon + ' ' + esc(p.name) + ' on ' + esc(r.name) + '</div>';
      else if (c && c.alive && p.target === 'pair' && c.id === U.forceA) html += '<div class="tt-hint">Aggressor: pick a different nation as the victim</div>';
      else if (c && c.alive) html += '<div class="tt-hint">Click: ' + p.icon + ' ' + esc(p.target === 'pair' ? (U.forceA < 0 ? 'choose as aggressor' : cname(W, U.forceA) + ' attacks ' + c.name) : p.name + ' on ' + c.name) + '</div>';
    }
    el.innerHTML = html;
    el.hidden = false;
    var w = el.offsetWidth, h = el.offsetHeight, x = U.tip.x + 16, y = U.tip.y + 14;
    var mw = U.mapRect || ($('mapwrap') ? $('mapwrap').getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
    if (x + w > mw.right - 6) x = U.tip.x - w - 14;
    if (y + h > mw.bottom - 6) y = U.tip.y - h - 12;
    el.style.left = M.max(mw.left + 4, x) + 'px'; el.style.top = M.max(mw.top + 4, y) + 'px';
  }

  // ------------------------------------------------------------------ periodic update
  // panels are refreshed round-robin (top bar + news every call, the heavier blocks every other call)
  function update(W, force) {
    W = W || U.W; if (!W) return;
    U.phase = (U.phase | 0) + 1;
    var ph = force ? -1 : (U.phase & 1);
    safe('top', function () { renderTop(W); });
    if (ph !== 1) safe('inspector', function () { renderInspector(W, force); });
    var now = Date.now();
    if (ph !== 0 && (force || now - U.citT > 900)) { U.citT = now; safe('citizen', function () { renderCitizen(W, force); }); }
    safe('news', function () { renderNews(W, force); });
    if (ph !== 0) safe('charts', function () { renderCharts(W, force); });
    if (ph !== 0) safe('legend', function () { renderLegend(W, force); });
    if (U.tip.rid >= 0) safe('tooltip', function () { renderTooltip(W); });
  }

  function setText(id, v) { var el = $(id); if (el && el.textContent !== v) el.textContent = v; }
  function renderTop(W) {
    var G = W.global || {}, t = num(W.tick, 0);
    setText('date', dateFull(t));
    setText('week', 'week ' + t + ' · year ' + (M.floor(t / 52) + 1));
    var cs = W.countries || [], alive = 0, pop = 0, gdp = 0, i;
    for (i = 0; i < cs.length; i++) { var c = cs[i]; if (c && c.alive) { alive++; pop += num(c.pop, 0); gdp += num(c.gdp, 0); } }
    var wp = num(G.worldPop, 0) > 0 ? G.worldPop : pop, wg = num(G.worldGDP, 0) > 0 ? G.worldGDP : gdp;
    setHTML('sv-pop', $('sv-pop'), fmtNum(wp));
    var gr = num(G.worldGrowth, NaN);
    setHTML('sv-gdp', $('sv-gdp'), fmtMoney(wg) + (isFinite(gr) ? '<small class="' + (gr >= 0 ? 'up' : 'down') + '">' + spct(gr) + '</small>' : ''));
    var mk = num(G.marketIndex, 1000), gh = W.ghist || {}, ms = gh.market || [], prev = ms.length >= 2 ? ms[ms.length - 2] : 1000;
    var ch = prev > 0 ? mk / prev - 1 : 0;
    setHTML('sv-mkt', $('sv-mkt'), M.round(mk).toLocaleString('en-US') + '<small class="' + (ch > 0.0005 ? 'up' : ch < -0.0005 ? 'down' : 'flat') + '">' + (ch > 0.0005 ? '▲' : ch < -0.0005 ? '▼' : '◆') + ' ' + (M.abs(ch) * 100).toFixed(1) + '%</small>');
    setHTML('sv-oil', $('sv-oil'), '$' + num(G.oilPrice, 0).toFixed(1));
    setHTML('sv-food', $('sv-food'), num(G.foodPrice, 100).toFixed(0));
    var fear = clamp(num(G.fear, 0), 0, 1);
    setHTML('sv-fear', $('sv-fear'), pct(fear, 0) + '<div class="fearbar"><i style="width:' + (fear * 100).toFixed(1) + '%"></i></div>');
    var wars = activeWars(W).length;
    setHTML('sv-wars', $('sv-wars'), String(wars));
    $('st-wars').classList.toggle('hot', wars > 0);
    setHTML('sv-nations', $('sv-nations'), alive + (cs.length - alive > 0 ? '<small class="down" title="nations that have ceased to exist">(' + (cs.length - alive) + ' fallen)</small>' : ''));
    setHTML('sv-deaths', $('sv-deaths'), fmtNum(num(G.warDeaths, 0)));
    var nk = num(G.nukesUsed, 0);
    setHTML('sv-nukes', $('sv-nukes'), String(nk));
    $('st-nukes').hidden = nk <= 0;
    $('st-nukes').classList.toggle('hot', nk > 0);
  }

  // ------------------------------------------------------------------ inspector
  function onInspectorAct(t) {
    var W = U.W; if (!W) return;
    var cid = t.getAttribute('data-cid'), act = t.getAttribute('data-act');
    if (act === 'another') { pickCitizen(); renderCitizen(W, true); return; }
    if (act === 'follow') {
      var MV = GS.MapView; if (!MV) return;
      if (MV.getFollow() === U.citizen) MV.follow(-1); else { MV.follow(U.citizen); locateCitizen(W, false); }
      renderCitizen(W, true); return;
    }
    if (act === 'locate') { locateCitizen(W, true); return; }
    if (act === 'zoom') { if (GS.MapView && W.selected >= 0) GS.MapView.centerOn(W.selected); return; }
    if (cid !== null && cid !== '') { select(+cid, { reveal: true }); }
  }
  function locateCitizen(W, zoom) {
    var P = W.people, i = U.citizen; if (!P || i < 0 || !P.x || !GS.MapView) return;
    var r = W.regions[P.region[i]]; if (!r) return;
    if (zoom && r.owner >= 0) GS.MapView.centerOn(r.owner); else if (r.owner >= 0) GS.MapView.reveal(r.owner);
  }

  function bar(label, v, col, txt, center) {
    v = clamp(num(v, 0), 0, 1);
    return '<div class="bar"><span>' + esc(label) + '</span><div class="tr' + (center ? ' center' : '') + '"><i style="width:' + (v * 100).toFixed(1) + '%;background:' + col + '"></i></div><b>' + (txt === undefined ? pct(v, 0) : txt) + '</b></div>';
  }
  function sbar(label, v, txt) { // -1..1 centred bar
    v = clamp(num(v, 0), -1, 1);
    var l = v < 0 ? 50 + v * 50 : 50, w = M.abs(v) * 50;
    return '<div class="bar"><span>' + esc(label) + '</span><div class="tr center"><i style="left:' + l.toFixed(1) + '%;width:' + w.toFixed(1) + '%;background:' + (v < 0 ? '#ff7a7a' : '#5aa9ff') + '"></i></div><b>' + (txt || v.toFixed(2)) + '</b></div>';
  }
  function kv(pairs) {
    var h = '<div class="kv">';
    for (var i = 0; i < pairs.length; i++) if (pairs[i]) h += '<div><span>' + esc(pairs[i][0]) + '</span><b' + (pairs[i][2] ? ' class="' + pairs[i][2] + '"' : '') + '>' + pairs[i][1] + '</b></div>';
    return h + '</div>';
  }

  function renderInspector(W, force) {
    var sel = num(W.selected, -1), c = C(W, sel), host = $('inspector');
    var mode = c ? 'c' + sel : 'world';
    if (U.inspFor !== mode) {
      U.inspFor = mode; U.cache = {}; U.sparkKeys = {};
      host.innerHTML = c ? countrySkeleton() : worldSkeleton();
    }
    $('btnDeselect').hidden = !c;
    setText('inspTitle', c ? (c.alive ? 'Nation' : 'Fallen nation') : 'World overview');
    if (!c) { renderWorldOverview(W); return; }
    var parts = countryParts(W, c);
    for (var k in parts) setHTML('sec-' + k, $('sec-' + k), parts[k]);
    renderSparks(W, c);
    renderScatter(W, c, force);
  }
  function countrySkeleton() {
    return '<div id="sec-head"></div>' +
      '<div class="card"><h3>Leader</h3><div id="sec-leader"></div></div>' +
      '<div class="card"><h3>History <span class="h3x">monthly</span></h3><div class="sparks" id="sparks"></div></div>' +
      '<div class="card"><h3>Economy</h3><div id="sec-econ"></div></div>' +
      '<div class="card"><h3>Politics</h3><div id="sec-pol"></div></div>' +
      '<div class="card"><h3>People</h3><div id="sec-people"></div></div>' +
      '<div class="card scatter"><h3>Ideology of citizens <span class="h3x">colour = approval</span></h3><canvas id="scatter"></canvas><div class="axes"><span>← left</span><span>economy</span><span>right →</span></div></div>' +
      '<div class="card"><h3>Military</h3><div id="sec-mil"></div></div>' +
      '<div class="card"><h3>Wars</h3><div id="sec-wars"></div></div>' +
      '<div class="card"><h3>Diplomacy</h3><div id="sec-diplo"></div></div>' +
      '<div class="card"><h3>Relations</h3><div id="sec-rel"></div></div>' +
      '<div class="card"><h3>Trade partners</h3><div id="sec-trade"></div></div>';
  }
  function worldSkeleton() {
    return '<div class="card"><h3>The world</h3><div id="sec-wsum"></div></div>' +
      '<div class="card"><h3>Active wars</h3><div id="sec-wwars"></div></div>' +
      '<div class="card"><h3>Great powers</h3><div id="sec-wgp"></div></div>' +
      '<div class="card"><h3>Hotspots <span class="h3x">highest unrest</span></h3><div id="sec-whot"></div></div>' +
      '<div class="card"><h3>Blocs</h3><div id="sec-wbloc"></div></div>' +
      '<div class="empty" style="padding:2px 4px 10px">Click any nation on the map to inspect it.</div>';
  }

  function renderWorldOverview(W) {
    if (!U.rightWT || Date.now() - U.rightWT > 2000 || U.rightWinW !== window.innerWidth) { var rp = $('right'); U.rightW = rp ? rp.clientWidth : 356; U.rightWT = Date.now(); U.rightWinW = window.innerWidth; }
    var G = W.global || {}, cs = W.countries || [], alive = [], i;
    for (i = 0; i < cs.length; i++) if (cs[i] && cs[i].alive) alive.push(cs[i]);
    var anarchy = 0, cw = 0;
    for (i = 0; i < alive.length; i++) { if (alive[i].gov === 'anarchy') anarchy++; if (alive[i].civilWar) cw++; }
    var empty = 0; for (i = 0; i < W.regions.length; i++) if (W.regions[i].owner < 0) empty++;
    setHTML('sec-wsum', $('sec-wsum'), kv([
      ['Nations', String(alive.length)], ['Fallen', String(cs.length - alive.length)],
      ['Civil wars', String(cw)], ['Anarchies', String(anarchy)],
      ['Empty lands', String(empty)], ['Alliances', String((W.alliances || []).filter(function (a) { return a && !a.dissolved; }).length)],
      ['World growth', spct(G.worldGrowth), num(G.worldGrowth, 0) >= 0 ? 'up' : 'down'], ['Fear', pct(G.fear, 0)],
      ['War deaths', fmtNum(G.warDeaths)], ['Nukes used', String(num(G.nukesUsed, 0))],
      ['Plague', G.plagueActive ? '<span class="down">active</span>' : 'none'], ['Base rate', pct(num(G.baseRate, 0.04), 2)]
    ]));
    var ws = activeWars(W), h = '';
    if (!ws.length) h = '<div class="empty">The world is at peace — for now.</div>';
    ws.sort(function (a, b) { return (b.attackers.length + b.defenders.length) - (a.attackers.length + a.defenders.length); });
    for (i = 0; i < ws.length && i < 8; i++) h += warRow(W, ws[i], -1);
    if (ws.length > 8) h += '<div class="empty">+' + (ws.length - 8) + ' more</div>';
    setHTML('sec-wwars', $('sec-wwars'), h);
    var gp = alive.slice().sort(function (a, b) { return num(b.gdp, 0) - num(a.gdp, 0); }).slice(0, 10);
    var wide = !U.rightW || U.rightW > 330; // narrow inspector: drop the government column so names stay readable
    h = '<table class="tbl fixed"><colgroup><col style="width:16px"><col><col style="width:62px"><col style="width:52px">' + (wide ? '<col style="width:58px">' : '') + '</colgroup>';
    for (i = 0; i < gp.length; i++) {
      var c = gp[i];
      h += '<tr data-cid="' + c.id + '"><td><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + rgb(c.color) + '"></span></td><td class="nm">' + esc(c.name) + (c.atWar ? ' <span class="down">⚔</span>' : '') + (c.greatPower ? ' <span style="color:var(--gold)">★</span>' : '') +
        '</td><td class="r">' + fmtMoney(c.gdp) + '</td><td class="r ' + (num(c.growth, 0) >= 0 ? 'up' : 'down') + '">' + spct(c.growth) + '</td>' + (wide ? '<td class="r nm" style="color:var(--muted)">' + esc(SHORT_GOV[c.gov] || govLabel(c.gov).split(' ')[0]) + '</td>' : '') + '</tr>';
    }
    setHTML('sec-wgp', $('sec-wgp'), h + '</table>');
    var hot = alive.slice().sort(function (a, b) { return num(b.unrest, 0) - num(a.unrest, 0); }).slice(0, 6);
    h = '<div class="rl">';
    for (i = 0; i < hot.length; i++) h += relItem(W, hot[i].id, pct(hot[i].unrest, 0) + (hot[i].civilWar ? ' 🔥' : ''), ramp3(1 - num(hot[i].unrest, 0)));
    setHTML('sec-whot', $('sec-whot'), h + '</div>');
    var A = (W.alliances || []).filter(function (a) { return a && !a.dissolved && a.members && a.members.length > 1; });
    A.sort(function (a, b) { return b.members.length - a.members.length; });
    h = '';
    for (i = 0; i < A.length && i < 10; i++) h += allianceRow(W, A[i]);
    setHTML('sec-wbloc', $('sec-wbloc'), h || '<div class="empty">No blocs.</div>');
  }

  function relItem(W, id, valHtml, col) {
    var c = C(W, id); if (!c) return '';
    return '<div class="rli" data-cid="' + id + '"><span class="sw" style="background:' + rgb(c.color) + '"></span><span class="n">' + esc(c.name) + '</span><span class="v" style="color:' + rgb(col || [200, 210, 225]) + '">' + valHtml + '</span></div>';
  }
  function allianceRow(W, a) {
    var L = C(W, a.leader);
    return '<div class="rli" data-cid="' + (L ? L.id : '') + '"><span class="sw" style="background:' + rgb(a.color) + '"></span><span class="n">' + esc(a.name) +
      ' <span class="empty" style="font-style:normal">' + esc(a.type || '') + (L ? ' · led by ' + esc(L.name) : '') + '</span></span><span class="v">' + (a.members || []).length + '</span></div>';
  }
  function warRow(W, w, me) {
    var at = w.attackers || [], de = w.defenders || [], side = me >= 0 ? (at.indexOf(me) >= 0 ? 1 : 2) : 0;
    var score = clamp(num(w.score, 0), -100, 100);
    function names(arr) { var s = []; for (var i = 0; i < arr.length && i < 4; i++) s.push(clink(W, arr[i])); return s.join(', ') + (arr.length > 4 ? ' +' + (arr.length - 4) : ''); }
    var dur = M.max(0, num(W.tick, 0) - num(w.start, 0));
    var status = score > 15 ? 'attackers advancing' : score < -15 ? 'defenders advancing' : 'stalemate';
    if (side) status = (side === 1 ? score : -score) > 15 ? 'winning' : (side === 1 ? score : -score) < -15 ? 'losing' : 'stalemate';
    return '<div class="warrow"><div class="wn">⚔ ' + esc(warName(W, w)) + '</div>' +
      '<div class="ws">' + names(at) + ' <span style="color:#ff8080">vs</span> ' + names(de) + '</div>' +
      '<div class="ws">' + (dur >= 52 ? (dur / 52).toFixed(1) + ' years' : dur + ' weeks') + ' · ' + esc(status) + (w.goal && w.goal.type ? ' · goal: ' + esc(w.goal.type) : (typeof w.goal === 'string' ? ' · goal: ' + esc(w.goal) : '')) + '</div>' +
      '<div class="scorebar" title="War score ' + score.toFixed(0) + ' (red = attackers)"><i style="width:' + ((score + 100) / 2).toFixed(1) + '%"></i></div></div>';
  }

  function f2(x) { x = num(x, 0); return (M.abs(x) < 0.005 ? 0 : x).toFixed(2); }
  function shareOf(W, c, k) {
    var cs = W.countries || [], tot = 0, rank = 1, v = num(c[k], 0);
    for (var i = 0; i < cs.length; i++) { var o = cs[i]; if (!o || !o.alive) continue; tot += M.max(0, num(o[k], 0)); if (o !== c && num(o[k], 0) > v) rank++; }
    return c.alive ? '#' + rank + ' · ' + pct(tot > 0 ? v / tot : 0, 0) : '—';
  }
  function powerRank(W, c) { return shareOf(W, c, 'power'); }
  function countryParts(W, c) {
    var parts = {}, G = W.global || {}, NC = W.NC | 0, i;
    // ---- header
    var gp = c.greatPower, ws = c.alive ? warsOf(W, c.id) : [];
    var h = '<div class="chead"><div class="flag" style="background:linear-gradient(135deg,' + rgb(c.color) + ' 0 55%,' + rgb((c.color || [128, 128, 128]).map(function (x) { return x * 0.55; })) + ' 55% 100%)"></div><div style="min-width:0;flex:1">' +
      '<div class="cname">' + esc(c.name) + '</div><div class="csub">' + (c.iso3 ? esc(c.iso3) + ' · ' : '') + (c.alive ? esc(govLabel(c.gov)) + (c.regimeSince >= 0 ? ' since ' + esc(dateShort(c.regimeSince)) : '') : 'Fallen nation, formerly ' + esc(govLabel(c.gov).toLowerCase())) + '</div></div>' +
      '<button class="btn small" data-act="zoom" title="Zoom to">⌖</button></div><div class="badges">';
    if (!c.alive) h += '<span class="badge dead">† ceased to exist' + (c.diedTick >= 0 ? ' ' + esc(dateShort(c.diedTick)) : '') + '</span>';
    if (gp) h += '<span class="badge gp">★ great power</span>';
    if (ws.length) h += '<span class="badge war">⚔ at war</span>';
    if (c.civilWar) h += '<span class="badge cw">🔥 civil war</span>';
    if (c.defaulted) h += '<span class="badge war">defaulted</span>';
    if (num(c.overlord, -1) >= 0) h += '<span class="badge puppet">puppet of ' + esc(cname(W, c.overlord)) + '</span>';
    if (num(c.parent, -1) >= 0) h += '<span class="badge">seceded from ' + esc(cname(W, c.parent)) + '</span>';
    if (num(c.nukes, num(c.data && c.data.nukes, 0)) > 0) h += '<span class="badge">☢ nuclear</span>';
    h += '</div>';
    if (!c.alive) {
      var hg = (c.hist && c.hist.gdp) || [], hp = (c.hist && c.hist.pop) || [], peak = 0;
      for (i = 0; i < hg.length; i++) if (num(hg[i], 0) > peak) peak = hg[i];
      var cause = c.deathMode === 'erased' ? 'erased by divine will' : (num(c.conqueredBy, -1) >= 0 ? 'conquered by ' + cname(W, c.conqueredBy) : 'dissolved');
      h += '<div class="card"><h3>Last known</h3>' + kv([
        ['Fell', esc(dateShort(c.diedTick))], ['Cause', esc(cause)],
        ['Peak GDP', fmtMoney(M.max(peak, num(c.eco && c.eco.gdpAtDeath, 0)))], ['GDP at fall', fmtMoney(num(c.eco && c.eco.gdpAtDeath, hg.length ? hg[hg.length - 1] : 0))],
        ['Population', fmtNum(hp.length ? hp[hp.length - 1] : 0)], ['Provinces lost', String((c.lostRegions || []).length)]
      ]) + '<div class="empty" style="margin-top:6px">This nation no longer exists. Its history remains below.</div></div>';
    }
    parts.head = h;

    // ---- leader
    var L = c.leader;
    if (L && L.name && !L.none) {
      var ini = String(L.name).split(/\s+/).map(function (s) { return s.charAt(0); }).slice(0, 2).join('');
      var endT = c.alive ? num(W.tick, 0) : num(L.ruledUntil, num(c.diedTick, W.tick));
      var yrs = (endT - num(L.since, endT)) / 52;
      var ideo = '';
      try { if (GS.People && GS.People.ideologyText) ideo = GS.People.ideologyText(num(L.econ, 0), num(L.auth, 0), num(L.nat, 0.5)); } catch (e) { ideo = ''; }
      h = '<div class="leader"><div class="avatar" style="background:' + rgb(GOV_COL[c.gov] || [150, 150, 160]) + '">' + esc(ini) + '</div><div style="min-width:0">' +
        '<div class="lname">' + esc(L.name) + '</div><div class="lsub">' + (L.age ? M.floor(L.age) + ', ' : '') + esc(L.sex === 1 || L.sex === 'f' || L.sex === 'female' ? 'female' : 'male') +
        (L.party ? ' · ' + esc(L.party) : '') + ' · ' + (c.alive ? '' : 'ruled ') + (yrs >= 1 ? yrs.toFixed(1) + ' yrs' : M.max(0, M.round(yrs * 52)) + ' wks') + (c.alive ? ' in power' : ' (until ' + esc(dateShort(endT)) + ')') + '</div>' +
        (ideo ? '<div class="lsub" style="font-style:italic">' + esc(ideo) + '</div>' : '') + '</div></div><div class="bars">' +
        bar('Aggression', L.aggression, '#ff6060') + bar('Ambition', L.ambition, '#ff9a3c') + bar('Caution', L.caution, '#5aa9ff') + bar('Competence', L.competence, '#3fd07f') +
        sbar('Economics', L.econ, num(L.econ, 0) < -0.15 ? 'left' : num(L.econ, 0) > 0.15 ? 'right' : 'centre') + sbar('Authority', L.auth, num(L.auth, 0) > 0.15 ? 'auth' : num(L.auth, 0) < -0.15 ? 'liberal' : 'mid') + '</div>';
    } else h = '<div class="empty">' + (c.alive ? 'No one rules. Power lies in the streets.' : 'The last government is gone.') + '</div>';
    parts.leader = h;

    // ---- economy
    var gpc = num(c.gdpPerCap, num(c.pop, 0) > 0 ? num(c.gdp, 0) * 1e9 / c.pop : 0);
    if (!c.alive) parts.econ = '<div class="empty">No economy remains. See “Last known” above.</div>';
    else parts.econ = kv([
      ['GDP', fmtMoney(c.gdp)], ['Growth', spct(c.growth), num(c.growth, 0) >= 0 ? 'up' : 'down'],
      ['Per capita', fmtUSD(gpc)], ['Inflation', pct(c.inflation), num(c.inflation, 0) > 0.08 ? 'down' : ''],
      ['Unemployment', pct(c.unemployment), num(c.unemployment, 0) > 0.12 ? 'down' : ''], ['Debt / GDP', pct(c.debtRatio, 0), num(c.debtRatio, 0) > 1 ? 'down' : ''],
      ['Bond yield', pct(c.bondYield, 2), num(c.bondYield, 0) > 0.1 ? 'down' : ''], ['Deficit', pct(c.deficit)],
      ['Stock index', num(c.stockIndex, 100).toFixed(0), num(c.stockIndex, 100) >= 100 ? 'up' : 'down'], ['Currency', num(c.currency, 1).toFixed(2)],
      ['Exports', fmtMoney(c.exports)], ['Imports', fmtMoney(c.imports)],
      ['Tax take', pct(c.taxRate, 0)], ['Confidence', pct(c.confidence, 0)],
      ['Military', pct(c.spendMil)], ['Welfare', pct(c.spendWelfare)],
      ['Oil', num(c.oil, 0).toFixed(2)], ['Food', num(c.food, 0) >= 0 ? 'exporter' : 'importer'],
      num(c.sanctionedBy, 0) > 0 ? ['Sanctioned by', String(c.sanctionedBy), 'down'] : null
    ]);

    // ---- politics
    h = '<div class="bars">' +
      bar('Approval', c.approval, rgb(ramp3(c.approval))) + bar('Unrest', c.unrest, rgb(ramp3(1 - num(c.unrest, 0)))) +
      bar('Stability', c.stability, '#5aa9ff') + bar('Legitimacy', c.legitimacy, '#8fb8ff') +
      bar('Freedom', c.freedom, '#3fd07f') + bar('Repression', c.repression, '#ff7a7a') +
      bar('Corruption', c.corruption, '#c9a050') + bar('Polarization', c.polarization, '#b48cff') +
      bar('Radicals', c.radicalShare, '#ff5ed1') + bar('Protesting', c.protestShare, '#ff3b3b') + '</div>';
    if (num(c.nextElection, -1) >= 0) h += '<div class="subh" style="margin-top:8px">Next election: <span style="color:var(--text)">' + esc(dateShort(c.nextElection)) + '</span></div>';
    var cwr = c.civilWar;
    if (cwr) {
      var rs = num(cwr.rebelStrength, 0), gs = num(cwr.govStrength, 0), tot = rs + gs > 0 ? rs + gs : 1;
      h += '<div class="warrow" style="margin-top:8px;border-color:rgba(255,154,60,0.4);background:rgba(255,154,60,0.07)"><div class="wn" style="color:#ffd2a8">🔥 Civil war' + (cwr.rebelName ? ': ' + esc(cwr.rebelName) : '') + '</div>' +
        '<div class="ws">since ' + esc(dateShort(cwr.start)) + ' · rebels hold ' + ((cwr.regionHeld || []).length) + ' region(s)</div>' +
        '<div class="scorebar" title="Rebel strength (red) vs government"><i style="width:' + (rs / tot * 100).toFixed(1) + '%"></i></div></div>';
    }
    var ps = (c.parties || []).slice();
    if (ps.length) {
      var ruling = num(c.rulingParty, -1), idx = ps.map(function (p, k) { return k; });
      idx.sort(function (a, b) { return num(ps[b].support, 0) - num(ps[a].support, 0); });
      h += '<div class="subh" style="margin-top:8px">Parties</div>';
      for (i = 0; i < idx.length && i < 6; i++) {
        var p = ps[idx[i]];
        h += '<div class="party' + (idx[i] === ruling ? ' ruling' : '') + '"><span class="pn">' + (idx[i] === ruling ? '★ ' : '') + esc(p.name) + '</span><div class="tr"><i style="width:' + (clamp(num(p.support, 0), 0, 1) * 100).toFixed(1) + '%;background:' + (num(p.econ, 0) < 0 ? '#ff7a7a' : '#5aa9ff') + '"></i></div><b style="font-size:11px;text-align:right;font-weight:500">' + pct(p.support, 0) + '</b></div>';
      }
    }
    parts.pol = h;

    // ---- people
    var wk = c.workers || {};
    parts.people = kv([
      ['Population', fmtNum(c.pop)], ['Agents', String(num(c.agents, 0))],
      ['Happiness', pct(c.happiness, 0)], ['Gini', num(c.gini, 0).toFixed(2)],
      ['Avg income', fmtUSD(c.avgIncome)], ['Avg wealth', fmtUSD(c.avgWealth)],
      ['Births / yr', fmtNum(num(c.birthsY, c.birthsW * 52))], ['Deaths / yr', fmtNum(num(c.deathsY, c.deathsW * 52))],
      ['Emigrants / yr', fmtNum(num(c.emigY, c.emigW * 52))], ['Immigrants / yr', fmtNum(num(c.immigY, c.immigW * 52))],
      ['Refugees out', fmtNum(c.refugeesOut)], ['Minorities', pct(c.minorityShare, 0)],
      ['Infected', pct(c.infected, 1), num(c.infected, 0) > 0.005 ? 'down' : ''], ['Soldiers', fmtNum(wk.military)]
    ]) + '<div class="bars" style="margin-top:8px">' +
      bar('Ideology L/R', (num(c.ideoEcon, 0) + 1) / 2, '#5aa9ff', f2(c.ideoEcon)) +
      bar('Authoritarian', (num(c.ideoAuth, 0) + 1) / 2, '#ff9a3c', f2(c.ideoAuth)) +
      bar('Nationalism', c.ideoNat, '#e9b949', f2(c.ideoNat)) + '</div>';

    // ---- military
    parts.mil = kv([
      ['Power', powerRank(W, c)], ['Mil. stock', fmtMoney(c.milStock)],
      ['Manpower', fmtNum(c.manpower)], ['Warheads', String(num(c.nukes, num(c.data && c.data.nukes, 0)))],
      ['Tech', num(c.tech, num(c.data && c.data.tech, 0)).toFixed(2)], ['Navy', num(c.navy, num(c.data && c.data.navy, 0)).toFixed(2)],
      ['Exhaustion', pct(c.warExhaustion, 0), num(c.warExhaustion, 0) > 0.4 ? 'down' : ''], ['Threat felt', pct(c.threat, 0), num(c.threat, 0) > 0.5 ? 'down' : ''],
      ['Army loyalty', pct(c.milApproval, 0)], ['Influence', shareOf(W, c, 'influence')]
    ]);

    // ---- wars
    h = '';
    for (i = 0; i < ws.length; i++) h += warRow(W, ws[i], c.id);
    parts.wars = h || '<div class="empty">' + (c.alive ? 'At peace.' : '—') + '</div>';

    // ---- diplomacy
    h = '<div class="kv one">';
    if (num(c.overlord, -1) >= 0) h += '<div><span>Overlord</span><b>' + clink(W, c.overlord) + '</b></div>';
    h += '<div><span>Patron / sphere</span><b>' + (num(c.patron, -1) >= 0 ? clink(W, c.patron) : (gp ? 'independent power' : 'none')) + '</b></div>';
    var clients = [];
    for (i = 0; i < W.countries.length; i++) { var o = W.countries[i]; if (o && o.alive && o.id !== c.id && (o.patron === c.id || o.overlord === c.id)) clients.push(o.id); }
    if (clients.length) h += '<div><span>Clients</span><b style="white-space:normal;text-align:right">' + clients.slice(0, 6).map(function (x) { return clink(W, x); }).join(', ') + (clients.length > 6 ? ' +' + (clients.length - 6) : '') + '</b></div>';
    var pacts = c.defensePacts || [];
    if (pacts.length) h += '<div><span>Defence pacts</span><b style="white-space:normal;text-align:right">' + pacts.slice(0, 6).map(function (x) { return clink(W, x); }).join(', ') + '</b></div>';
    var sanc = c.sanctions || [];
    if (sanc.length) h += '<div><span>Sanctions</span><b style="white-space:normal;text-align:right">' + sanc.slice(0, 5).map(function (x) { return clink(W, x); }).join(', ') + (sanc.length > 5 ? ' +' + (sanc.length - 5) : '') + '</b></div>';
    var claims = c.claims || [];
    if (claims.length) h += '<div><span>Claims</span><b style="white-space:normal;text-align:right">' + claims.slice(0, 4).map(function (r) { return esc((W.regions[r] || {}).name || '?'); }).join(', ') + '</b></div>';
    h += '</div>';
    var al = [], A = W.alliances || [];
    for (i = 0; i < A.length; i++) { var a = A[i]; if (a && !a.dissolved && (a.members || []).indexOf(c.id) >= 0) al.push(a); }
    h += '<div class="subh" style="margin-top:8px">Alliances</div>' + (al.length ? '<div class="rl">' + al.map(function (a) { return allianceRow(W, a); }).join('') + '</div>' : '<div class="empty">Non-aligned.</div>');
    parts.diplo = h;

    // ---- relations
    var fr = [], rv = [];
    if (W.rel && NC && c.alive) {
      for (i = 0; i < W.countries.length; i++) {
        var oc = W.countries[i]; if (!oc || !oc.alive || i === c.id) continue;
        var v = num(W.rel[c.id * NC + i], 0);
        fr.push([i, v]);
      }
      fr.sort(function (x, y) { return y[1] - x[1]; });
      rv = fr.slice(-5).reverse(); fr = fr.slice(0, 5);
    }
    function relList(arr) {
      var s = '<div class="rl">';
      for (var q = 0; q < arr.length; q++) {
        var vv = arr[q][1], atw = false;
        try { atw = GS.War && GS.War.isAtWar ? !!GS.War.isAtWar(W, c.id, arr[q][0]) : false; } catch (e) { atw = false; }
        s += relItem(W, arr[q][0], (atw ? '⚔ ' : '') + (vv > 0 ? '+' : '') + vv.toFixed(0), ramp3((vv + 100) / 200));
      }
      return s + '</div>';
    }
    parts.rel = c.alive ? '<div class="cols2"><div><div class="subh">Friends</div>' + relList(fr) + '</div><div><div class="subh">Rivals</div>' + relList(rv) + '</div></div>' : '<div class="empty">—</div>';

    // ---- trade
    var T = W.trade, tp = [], tot2 = 0;
    if (T && NC && c.alive) {
      for (i = 0; i < W.countries.length; i++) {
        var tc = W.countries[i]; if (!tc || !tc.alive || i === c.id) continue;
        var ex = num(T[c.id * NC + i], 0), im = num(T[i * NC + c.id], 0);
        if (ex + im > 0) { tp.push([i, ex, im]); tot2 += ex + im; }
      }
      tp.sort(function (x, y) { return (y[1] + y[2]) - (x[1] + x[2]); });
    }
    h = '';
    if (tp.length) {
      h = '<table class="tbl fixed"><colgroup><col><col style="width:62px"><col style="width:62px"><col style="width:42px"></colgroup><tr style="cursor:default"><td style="color:var(--dim)">partner</td><td class="r" style="color:var(--dim)">exports</td><td class="r" style="color:var(--dim)">imports</td><td class="r" style="color:var(--dim)">share</td></tr>';
      for (i = 0; i < tp.length && i < 6; i++) h += '<tr data-cid="' + tp[i][0] + '"><td class="nm">' + esc(cname(W, tp[i][0])) + '</td><td class="r">' + fmtMoney(tp[i][1]) + '</td><td class="r">' + fmtMoney(tp[i][2]) + '</td><td class="r">' + pct((tp[i][1] + tp[i][2]) / (tot2 || 1), 0) + '</td></tr>';
      h += '</table>';
    } else h = '<div class="empty">No recorded trade.</div>';
    parts.trade = h;
    return parts;
  }

  // ---- sparklines
  var SPARKS = [
    { k: 'gdp', label: 'GDP', col: [63, 208, 127], fmt: fmtMoney },
    { k: 'pop', label: 'Population', col: [90, 169, 255], fmt: fmtNum },
    { k: 'approval', label: 'Approval', col: [233, 185, 73], fmt: function (v) { return pct(v, 0); }, range: [0, 1] },
    { k: 'unrest', label: 'Unrest', col: [255, 77, 77], fmt: function (v) { return pct(v, 0); }, range: [0, 1] },
    { k: 'stock', label: 'Stocks', col: [180, 140, 255], fmt: function (v) { return num(v, 0).toFixed(0); } },
    { k: 'power', label: 'Power', col: [255, 154, 60], fmt: function (v) { return num(v, 0).toFixed(2); } }
  ];
  function renderSparks(W, c) {
    var host = $('sparks'); if (!host) return;
    if (!host.firstChild) {
      var h = '';
      for (var i = 0; i < SPARKS.length; i++) h += '<div class="spark"><div class="sk"><span>' + SPARKS[i].label + '</span><b id="spv-' + SPARKS[i].k + '">—</b></div><canvas id="spc-' + SPARKS[i].k + '"></canvas></div>';
      host.innerHTML = h;
    }
    var hist = c.hist || {};
    for (var j = 0; j < SPARKS.length; j++) {
      var s = SPARKS[j], arr = hist[s.k] || [], last = arr.length ? arr[arr.length - 1] : NaN;
      var cur = { gdp: c.gdp, pop: c.pop, approval: c.approval, unrest: c.unrest, stock: c.stockIndex, power: c.power }[s.k];
      setText('spv-' + s.k, s.fmt(isFinite(num(cur, NaN)) && c.alive ? cur : last));
      var key = c.id + ':' + arr.length + ':' + last;
      if (!U.sparkKeys) U.sparkKeys = {};
      if (U.sparkKeys[s.k] === key) continue;
      U.sparkKeys[s.k] = key;
      drawLine($('spc-' + s.k), arr, s.col, { range: s.range });
    }
  }

  // canvas CSS sizes are cached and refreshed by a ResizeObserver: reading clientWidth right after innerHTML
  // writes forces a synchronous layout on every sparkline
  var cvSize = typeof WeakMap === 'function' ? new WeakMap() : null, cvObs = null;
  function cssSize(cv) {
    var sz = cvSize && cvSize.get(cv);
    if (sz && sz.w > 0) return sz;
    sz = { w: cv.clientWidth || 100, h: cv.clientHeight || 30 };
    if (cvSize) {
      cvSize.set(cv, sz);
      if (!cvObs && typeof ResizeObserver === 'function') {
        cvObs = new ResizeObserver(function (es) {
          for (var i = 0; i < es.length; i++) { var cr = es[i].contentRect; cvSize.set(es[i].target, { w: cr.width || 100, h: cr.height || 30 }); }
          U.chartKey = ''; U.sparkKeys = {};
        });
      }
      if (cvObs) cvObs.observe(cv);
    }
    return sz;
  }
  function fitCanvas(cv) {
    if (!cv) return null;
    var cs0 = cssSize(cv), dpr = M.min(2.5, window.devicePixelRatio || 1), w = cs0.w, h = cs0.h;
    var W = M.round(w * dpr), H = M.round(h * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }
  function drawLine(cv, arr, col, opts) {
    var f = fitCanvas(cv); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h, n = arr ? arr.length : 0, i;
    ctx.clearRect(0, 0, w, h);
    if (n < 2) {
      ctx.fillStyle = 'rgba(130,145,170,0.5)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('collecting history…', w / 2, h / 2); return;
    }
    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < n; i++) { var v = num(arr[i], NaN); if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!(lo <= hi)) return;
    if (opts && opts.range) { lo = M.min(lo, opts.range[0]); hi = M.max(hi, opts.range[1]); }
    if (hi - lo < 1e-9) { hi = lo + (M.abs(lo) * 0.01 || 1); lo -= (M.abs(lo) * 0.01 || 1); }
    var pad = 3, yy = function (val) { return h - pad - (num(val, lo) - lo) / (hi - lo) * (h - 2 * pad); };
    var xx = function (k) { return k / (n - 1) * (w - 2) + 1; };
    var g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, rgb(col, 0.32)); g.addColorStop(1, rgb(col, 0));
    ctx.beginPath(); ctx.moveTo(xx(0), h);
    for (i = 0; i < n; i++) ctx.lineTo(xx(i), yy(arr[i]));
    ctx.lineTo(xx(n - 1), h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath();
    for (i = 0; i < n; i++) { if (i) ctx.lineTo(xx(i), yy(arr[i])); else ctx.moveTo(xx(i), yy(arr[i])); }
    ctx.strokeStyle = rgb(col, 0.95); ctx.lineWidth = 1.4; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.fillStyle = rgb(col); ctx.beginPath(); ctx.arc(xx(n - 1), yy(arr[n - 1]), 2.2, 0, 6.2832); ctx.fill();
    if (opts && opts.labels) {
      ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.lineWidth = 3; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(6,10,18,0.85)'; ctx.fillStyle = 'rgba(170,182,205,0.9)';
      var tHi = opts.fmt ? opts.fmt(hi) : hi.toFixed(0), tLo = opts.fmt ? opts.fmt(lo) : lo.toFixed(0);
      ctx.textBaseline = 'top'; ctx.strokeText(tHi, 2, 1); ctx.fillText(tHi, 2, 1);
      ctx.textBaseline = 'bottom'; ctx.strokeText(tLo, 2, h - 1); ctx.fillText(tLo, 2, h - 1);
    }
  }

  // ---- ideology scatter
  var ownBuf = null;
  function sampleAgents(W, cid, max) {
    var P = W.people, out = { e: [], a: [], ap: [] };
    if (!P || !P.alive || !P.econ) return out;
    var R = W.regions, n = P.n | 0, i;
    if (!ownBuf || ownBuf.length < R.length) ownBuf = new Int32Array(R.length + 16);
    for (i = 0; i < R.length; i++) ownBuf[i] = R[i].owner;
    var c = C(W, cid), est = M.max(1, num(c && c.agents, 0) || 1), step = M.max(1, M.floor(est / max)), seen = 0, off = num(W.tick, 0) % step;
    for (i = 0; i < n && out.e.length < max; i++) {
      if (!P.alive[i]) continue;
      var rg = P.region[i]; if (rg < 0 || ownBuf[rg] !== cid) continue;
      if (P.age && P.age[i] < 16) continue;
      if ((seen++ % step) !== off) continue;
      out.e.push(P.econ[i]); out.a.push(P.auth[i]); out.ap.push(P.approval ? P.approval[i] : 0.5);
    }
    return out;
  }
  function renderScatter(W, c, force) {
    var cv = $('scatter'); if (!cv) return;
    var now = Date.now();
    if (U.scatterFor === c.id && now - U.scatterT < 2000 && !force) return;
    if (U.scatterFor === c.id && now - U.scatterT < 2000 && force && U.sample) { /* redraw only */ } else {
      U.sample = c.alive ? sampleAgents(W, c.id, 500) : { e: [], a: [], ap: [] };
      U.scatterT = now;
    }
    U.scatterFor = c.id;
    var f = fitCanvas(cv); if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h, i, S = U.sample;
    ctx.clearRect(0, 0, w, h);
    var px = function (e) { return (clamp(num(e, 0), -1, 1) + 1) / 2 * (w - 16) + 8; };
    var py = function (a) { return (1 - (clamp(num(a, 0), -1, 1) + 1) / 2) * (h - 16) + 8; };
    // quadrants
    ctx.fillStyle = 'rgba(255,90,90,0.05)'; ctx.fillRect(0, 0, w / 2, h / 2);
    ctx.fillStyle = 'rgba(90,140,255,0.05)'; ctx.fillRect(w / 2, 0, w / 2, h / 2);
    ctx.fillStyle = 'rgba(80,220,140,0.05)'; ctx.fillRect(0, h / 2, w / 2, h / 2);
    ctx.fillStyle = 'rgba(233,185,73,0.05)'; ctx.fillRect(w / 2, h / 2, w / 2, h / 2);
    ctx.strokeStyle = 'rgba(150,170,200,0.2)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.fillStyle = 'rgba(150,165,190,0.55)'; ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillText('AUTHORITARIAN', 5, 4);
    ctx.textBaseline = 'bottom'; ctx.fillText('LIBERTARIAN', 5, h - 3);
    for (i = 0; i < S.e.length; i++) {
      ctx.fillStyle = rgb(ramp3(S.ap[i]), 0.75);
      ctx.fillRect(px(S.e[i]) - 1.4, py(S.a[i]) - 1.4, 2.8, 2.8);
    }
    if (!S.e.length) { ctx.fillStyle = 'rgba(150,165,190,0.6)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '11px sans-serif'; ctx.fillText(c.alive ? 'no citizens sampled' : 'no one remains', w / 2, h / 2); }
    // parties
    var ps = c.parties || [];
    ctx.lineWidth = 1.2;
    for (i = 0; i < ps.length; i++) {
      var p = ps[i]; if (!p) continue;
      var r = 3 + 10 * M.sqrt(clamp(num(p.support, 0), 0, 1));
      ctx.strokeStyle = i === c.rulingParty ? 'rgba(255,217,122,0.9)' : 'rgba(220,230,245,0.55)';
      ctx.beginPath(); ctx.arc(px(p.econ), py(p.auth), r, 0, 6.2832); ctx.stroke();
    }
    // leader
    var L = c.leader;
    if (L && !L.none && typeof L.econ === 'number') {
      var lx = px(L.econ), ly = py(L.auth);
      ctx.fillStyle = '#ffd97a'; ctx.strokeStyle = '#2a1d00'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(lx, ly - 6); ctx.lineTo(lx + 5, ly); ctx.lineTo(lx, ly + 6); ctx.lineTo(lx - 5, ly); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ citizen card
  function pickCitizen() {
    var W = U.W; if (!W || !GS.People || !GS.People.randomCitizen) { U.citizen = -1; return; }
    try {
      var sel = num(W.selected, -1), c = C(W, sel);
      var i = GS.People.randomCitizen(W, c && c.alive ? sel : -1);
      U.citizen = (typeof i === 'number' && i >= 0) ? i : -1;
    } catch (e) { U.citizen = -1; console.error(e); }
    U.citKey = '';
    if (GS.MapView && GS.MapView.getFollow() >= 0 && GS.MapView.getFollow() !== U.citizen) GS.MapView.follow(-1);
  }
  function renderCitizen(W, force) {
    var host = $('citizen'); if (!host) return;
    var d = null;
    if (U.citizen >= 0 && GS.People && GS.People.describe) { try { d = GS.People.describe(W, U.citizen); } catch (e) { d = null; } }
    var following = GS.MapView && GS.MapView.getFollow() === U.citizen && U.citizen >= 0;
    var h = '<h3>Meet a citizen <span class="h3x">one of ' + fmtNum(num((W.global || {}).worldPop, 0)) + '</span></h3>';
    if (!d) {
      h += '<div class="empty">No one to meet here.</div><div class="cit-actions"><button class="btn small" data-act="another">↻ Find someone</button></div>';
      setHTML('citizen', host, h); return;
    }
    var ini = String(d.name || '?').split(/\s+/).map(function (s) { return s.charAt(0); }).slice(0, 2).join('');
    var bad = /protest|refugee|rebel|unemployed|miserable|hates|radical|poor|sick|deceased|front|poor health/;
    var good = /content|loyal|wealthy|survivor/;
    var cid = num(d.countryId, -1), oc = C(W, cid);
    h += '<div class="cit-top"><div class="avatar" style="background:' + (d.alive === false ? '#555' : rgb(oc ? oc.color : [150, 150, 160])) + '">' + esc(ini) + '</div><div style="min-width:0">' +
      '<div class="cit-name">' + esc(d.name) + (d.alive === false ? ' <span class="empty">†</span>' : '') + '</div>' +
      '<div class="cit-sub">' + esc(num(d.age, 0)) + ', ' + esc(d.sex || '') + ' · ' + esc(d.job || '') + '</div>' +
      '<div class="cit-sub">' + (d.region && (!oc || d.region !== oc.name) ? esc(d.region) + ', ' : '') + (cid >= 0 ? clink(W, cid) : esc(d.country || 'nowhere')) +
      (d.originId !== undefined && d.originId !== cid && d.origin ? ' · born ' + esc(d.origin) : '') + '</div></div></div>';
    h += '<div class="bars">' + bar('Happiness', d.happy, rgb(ramp3(d.happy))) + bar('Approval', d.approval, rgb(ramp3(d.approval))) +
      bar('Health', d.health, '#3fd07f') + bar('Radical', d.radical, '#ff5ed1') + '</div>';
    h += kv([['Wealth', fmtUSD(d.wealth)], ['Income', /child|student|baby|infant/i.test(String(d.job || '')) ? '—' : fmtUSD(d.income) + '/yr']]);
    if (d.ideology) h += '<div class="cit-ideo">“' + esc(d.ideology) + '”</div>';
    var st = d.status || [];
    if (st.length) {
      h += '<div class="chipset">';
      for (var i = 0; i < st.length; i++) h += '<span class="chip' + (bad.test(st[i]) ? ' bad' : good.test(st[i]) ? ' good' : '') + '">' + esc(st[i]) + '</span>';
      h += '</div>';
    }
    var log = d.log || [];
    if (log.length) {
      h += '<div class="lifelog">';
      for (var k = log.length - 1; k >= 0; k--) h += '<div><i>' + esc(log[k].date || dateShort(log[k].tick)) + '</i>' + esc(log[k].text) + '</div>';
      h += '</div>';
    } else h += '<div class="empty" style="margin-top:6px">A quiet life, so far.</div>';
    h += '<div class="cit-actions"><button class="btn small" data-act="another">↻ Another citizen</button>' +
      '<button class="btn small' + (following ? ' following' : '') + '" data-act="follow">' + (following ? '◉ Following' : '◎ Follow') + '</button>' +
      '<button class="btn small" data-act="locate">⌖ Locate</button></div>';
    setHTML('citizen', host, h);
  }

  // ------------------------------------------------------------------ news
  function newsGroup(type) { return KNOWN_TYPES.indexOf(type) >= 0 ? (type === 'alliance' ? 'diplomacy' : type) : 'other'; }
  function renderNews(W, force) {
    var N = W.news || [], last = N.length ? N[N.length - 1] : null;
    var lastId = last ? num(last.id, N.length) : 0;
    var key = lastId + '|' + N.length + '|' + U.newsFilter;
    if (!force && key === U.newsKey) return;
    U.newsKey = key;
    var f = U.newsFilter, h = '', shown = 0, seen = U.newsSeen, routine = 0;
    for (var i = N.length - 1; i >= 0 && shown < 140; i--) {
      var it = N[i]; if (!it) continue;
      var g = newsGroup(it.type);
      if (f === 'major') { if (num(it.importance, 2) < 3) continue; }
      else if (f !== 'all' && g !== f) continue;
      // routine re-elections (no change of government) are folded into one line
      if (f !== 'all' && /election \d{4}:/.test(it.text) && /re-elected|stays in power|retains|keeps/i.test(it.text)) { routine++; continue; }
      var imp = clamp(M.round(num(it.importance, 2)), 1, 5), id = num(it.id, i);
      var col = TYPE_COL[it.type] || '#9aa7bd';
      h += '<div class="ni i' + imp + ' t-' + esc(g) + (seen >= 0 && id > seen ? ' fresh' : '') + '" data-act="news" data-arg="' + id + '" title="' + esc(it.type || '') + '">' +
        '<span class="nd">' + esc(it.date ? String(it.date) : dateShort(it.tick)) + '</span><span class="nc" style="background:' + col + (imp >= 4 ? ';box-shadow:0 0 8px ' + col : '') + '"></span><span>' + esc(it.text) + '</span></div>';
      shown++;
    }
    if (routine) h += '<div class="empty" style="padding:4px 8px">+ ' + routine + ' routine election' + (routine > 1 ? 's' : '') + ' with no change of government (see All)</div>';
    if (!h) h = '<div class="empty" style="padding:8px">No major news yet.</div>';
    U.newsSeen = lastId;
    var host = $('newsList');
    U.cache.news = h; host.innerHTML = h;
  }
  function onNewsAct(t) {
    var W = U.W; if (!W) return;
    var id = +t.getAttribute('data-arg'), N = W.news || [];
    for (var i = N.length - 1; i >= 0; i--) {
      var it = N[i];
      if (it && num(it.id, i) === id) {
        var cl = it.countries || [];
        if (cl.length && C(W, cl[0])) select(cl[0], { reveal: true });
        return;
      }
    }
  }

  // ------------------------------------------------------------------ charts & legend
  function renderCharts(W, force) {
    var gh = W.ghist || {}, G = W.global || {};
    setText('chv-market', M.round(num(G.marketIndex, 0)).toLocaleString('en-US'));
    setText('chv-oil', '$' + num(G.oilPrice, 0).toFixed(1));
    setText('chv-fear', pct(G.fear, 0));
    setText('chv-gdp', fmtMoney(G.worldGDP));
    var key = (gh.t ? gh.t.length : 0) + ':' + (gh.t && gh.t.length ? gh.t[gh.t.length - 1] : 0);
    if (!force && U.chartKey === key) return;
    U.chartKey = key;
    drawLine($('chc-market'), gh.market || [], CHARTS[0].col, { labels: true, fmt: function (v) { return v.toFixed(0); } });
    drawLine($('chc-oil'), gh.oil || [], CHARTS[1].col, { labels: true, fmt: function (v) { return '$' + v.toFixed(0); } });
    drawLine($('chc-fear'), gh.fear || [], CHARTS[2].col, { range: [0, 1], labels: true, fmt: function (v) { return pct(v, 0); } });
    drawLine($('chc-gdp'), gh.gdp || [], CHARTS[3].col, { labels: true, fmt: fmtMoney });
  }
  function renderLegend(W, force) {
    if (!GS.MapView || !W) return;
    var L = GS.MapView.legend(W), h = '<div class="lt">' + esc(L.title || '') + '</div>', i;
    if (L.gradient) {
      h += '<div class="gr" style="background:linear-gradient(90deg,' + L.gradient.css.join(',') + ')"></div><div class="gl">';
      for (i = 0; i < L.gradient.labels.length; i++) h += '<span>' + esc(L.gradient.labels[i]) + '</span>';
      h += '</div>';
    }
    for (i = 0; i < (L.items || []).length; i++) {
      var it = L.items[i];
      h += '<div class="li"><span class="sw' + (it.hatch ? ' hatch' : '') + '" style="background-color:' + it.color + '"></span>' + esc(it.label) + '</div>';
    }
    for (i = 0; i < (L.lines || []).length; i++) {
      var ln = L.lines[i];
      h += '<div class="li wrap"><span class="ln' + (ln.dash ? ' dash' : '') + (ln.fill ? ' fill' : '') + '" style="' + (ln.fill ? 'background:' : 'border-color:') + ln.color + '"></span><span>' + esc(ln.label) + '</span></div>';
    }
    if (L.note) h += '<div class="note">' + esc(L.note) + '</div>';
    if (L.dots) {
      h += '<div class="dots">';
      for (i = 0; i < L.dots.length; i++) h += '<div class="li"><span class="dot" style="background:' + L.dots[i].color + '"></span>' + esc(L.dots[i].label) + '</div>';
      h += '</div>';
    }
    if (!force && U.legendKey === h) return;
    U.legendKey = h; $('legend').innerHTML = h;
  }

  // ------------------------------------------------------------------ misc public
  function toast(msg, kind, ms) {
    var host = $('toasts'); if (!host) { console.log(msg); return; }
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = String(msg);
    host.appendChild(el);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    var t = setTimeout(function () { el.classList.add('out'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 450); }, ms || (kind === 'error' ? 8000 : 2600));
    el.addEventListener('click', function () { clearTimeout(t); if (el.parentNode) el.parentNode.removeChild(el); });
  }
  function setPlayState(paused, speed) {
    U.paused = !!paused; U.speed = speed;
    var b = $('btnPlay');
    if (b) { b.innerHTML = paused ? '▶' : '&#10074;&#10074;'; b.classList.toggle('paused', !!paused); }
    var bs = document.querySelectorAll('#speeds button');
    for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', !paused && +bs[i].getAttribute('data-speed') === speed);
  }
  function setPerf(txt) { setText('perf', txt || ''); }
  function loading(show, msg, isError) {
    var el = $('loading'); if (!el) return;
    if (msg !== undefined) setText('loadingMsg', msg);
    el.classList.toggle('error', !!isError);
    el.classList.toggle('hide', !show);
  }

  GS.UI = {
    init: init,
    setWorld: setWorld,
    update: update,
    select: select,
    toast: toast,
    setPlayState: setPlayState,
    setPerf: setPerf,
    loading: loading,
    arm: arm,
    disarm: disarm,
    POWERS: POWERS
  };
})();
