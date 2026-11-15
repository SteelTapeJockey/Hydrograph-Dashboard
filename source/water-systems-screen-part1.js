// ---- Water systems screen: drought resilience of small community water systems ---------------------------------------
// Data: water-systems.js, built by tools/build-water-systems.py from NMED's drinking water sources (community systems of up to
// 3,300 people), the OSE Waters-to-Wells well records and the OSE meter harvest. Each NMED well or spring carries its own OSE
// well record where one was found (within 5 m, or owner and well depth agreeing within 250 m), with screens and metered pumping,
// plus unconfirmed OSE records nearby.
// This file: links each source to water-level wells in this app, the screening table and the map. The system page (hydrograph,
// normal ranges, triggers, pumping, printable summary) is file 38.
// Declared with var: setScreen (file 15) can ask for this screen before this file has run.
var WS = null, wsPending = false;
var WS_OWN_M = 5;                  // a water-level well within this distance of a source is that source (the system's own well)
var WS_RADII_MI = [1, 2, 3, 5];    // choices for "nearby"
var WS_DM_COLORS = ['#ffff00', '#fcd37f', '#ffaa00', '#e60000', '#730000'];   // U.S. Drought Monitor D0-D4
var WS_USDM_URL = 'https://services5.arcgis.com/0OTVzJS4K09zlixn/ArcGIS/rest/services/USDM_current/FeatureServer/0/query';
function wsShow(){ if(!WS){ wsPending = true; return; } wsOpen(); }

function wsM(lat1, lon1, lat2, lon2){ const c = Math.cos((lat1 + lat2) / 2 * Math.PI / 180); return Math.hypot((lon2 - lon1) * 111320 * c, (lat2 - lat1) * 110570); }
const wsMi = m => m / 1609.344;
// distance as people say it: metres up to 160 m, else miles
const wsDist = m => m < 160 ? Math.round(m) + ' m' : (m / 1609.344).toFixed(m < 16093 ? 1 : 0) + ' mi';
const wsFmt = (v, d) => v == null || !isFinite(v) ? '–' : (+v).toLocaleString(undefined, {maximumFractionDigits: d == null ? 0 : d, minimumFractionDigits: d == null ? 0 : Math.min(d, 1)});
const wsStore = {
  get(k, dflt){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; }catch(e){ return dflt; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
};
// a source's key for saved choices: system id + NMED source id (or its name when the id is missing)
const wsSrcKey = (sys, w) => sys.id + '|' + (w.fid || w.name);

// ---- the water-level wells of this app near each system ----------------------------------------------------------------------
// grid of wells (0.05 degree cells) for nearest-well searches
function wsSiteGrid(){
  if(WS.grid) return WS.grid;
  const g = new Map();
  for(let s = 0; s < NSITES; s++){
    const r = SITES[s]; if(r[1] == null || r[2] == null) continue;
    const k = Math.floor(r[2] / 0.05) + ':' + Math.floor(r[1] / 0.05);
    let L = g.get(k); if(!L){ L = []; g.set(k, L); } L.push(s);
  }
  return (WS.grid = g);
}
function wsSitesNear(lat, lon, m){
  const g = wsSiteGrid(), out = [], dy = Math.ceil(m / 110570 / 0.05), dx = Math.ceil(m / (111320 * Math.cos(lat * Math.PI / 180)) / 0.05);
  const cy = Math.floor(lat / 0.05), cx = Math.floor(lon / 0.05);
  for(let y = cy - dy; y <= cy + dy; y++) for(let x = cx - dx; x <= cx + dx; x++){
    const L = g.get(y + ':' + x); if(!L) continue;
    for(const s of L){ const d = wsM(lat, lon, SITES[s][2], SITES[s][1]); if(d <= m) out.push([s, d]); }
  }
  return out;
}
// NMBGMR network well ids -> site index (an OSE record that names a network well links to it by ID, at any distance)
function wsNmbgmrIdx(){
  if(WS.nmIdx) return WS.nmIdx;
  const m = new Map();
  for(let s = 0; s < NSITES; s++){ const r = SITES[s]; if(r[3] >= 0 && SOURCES[r[3]] === 'NMBGMR') m.set(String(r[0]).toUpperCase(), s); }
  return (WS.nmIdx = m);
}
// readings of one well as monthly means (ft below land surface). Pumping-affected readings (qualifier, or far below the usual
// winter level - file 27) are left out when asked.
function wsMonthly(s, dropPumped){
  const R = BOOT.raw; if(!R) return [];
  const a = R.off[s], b = R.off[s + 1]; if(b <= a) return [];
  if(dropPumped && typeof hxPumpCompute === 'function'){ try{ hxPumpCompute(hxPump.thr || 25); }catch(e){} }
  const mark = dropPumped && typeof hxPump !== 'undefined' ? hxPump.mark : null;
  const by = new Map();
  for(let i = a; i < b; i++){
    if(dropPumped && ((R.fl[i] & 2) || (mark && mark[i]))) continue;
    const d = rawDateOf(R.day[i]), y = +d.slice(0, 4), mo = +d.slice(5, 7), k = y * 12 + mo - 1;
    let c = by.get(k); if(!c){ c = {y, m: mo, sum: 0, n: 0, last: d}; by.set(k, c); }
    c.sum += R.v[i] / 100; c.n++; if(d > c.last) c.last = d;
  }
  return [...by.values()].sort((p, q) => p.y - q.y || p.m - q.m).map(c => ({y: c.y, m: c.m, t: c.y + (c.m - 0.5) / 12, v: c.sum / c.n, n: c.n, last: c.last}));
}
// Theil-Sen slope (ft/yr, positive = water deeper) over the last `yrs` years of monthly values; null if too little record
function wsTrend(series, yrs){
  if(!series.length) return null;
  const t1 = series[series.length - 1].t, pts = series.filter(p => p.t >= t1 - yrs);
  if(pts.length < 5 || t1 - pts[0].t < 3) return null;
  // thin dense logger records to monthly already; cap pairs for speed
  const use = pts.length > 240 ? pts.filter((p, i) => i % Math.ceil(pts.length / 240) === 0) : pts;
  const ts = OT.theilSen(use.map(p => p.t), use.map(p => p.v));
  return isFinite(ts.slope) ? {slope: ts.slope, n: pts.length, from: pts[0].y, to: pts[pts.length - 1].y} : null;
}

// ---- saved match choices (accept a candidate OSE record, or reject a match) --------------------------------------------------
function wsChoices(){ return WS.choices || (WS.choices = wsStore.get('hxWsMatch', {})); }
function wsSetChoice(key, val){ const c = wsChoices(); if(val === undefined) delete c[key]; else c[key] = val; wsStore.set('hxWsMatch', c); }
// the OSE record used for a source: the built-in match unless the user rejected it or accepted a candidate
function wsOseOf(sys, w){
  const ch = wsChoices()[wsSrcKey(sys, w)];
  if(ch && ch.pod === null) return null;
  if(ch && ch.pod){
    if(w.ose && w.ose.pod === ch.pod) return w.ose;
    const c = (w.cand || []).find(x => x.pod === ch.pod);
    if(c) return Object.assign({}, c, {how: 'accepted'});
  }
  return w.ose || null;
}

// ---- per-system figures for the screening table ------------------------------------------------------------------------------
function wsDerive(){
  const radM = WS.f.radius * 1609.344, since = WS.f.since, cy = new Date().getFullYear();
  const nm = wsNmbgmrIdx(), partialYr = WS.D.harvest_through != null && WS.D.harvest_through >= cy ? WS.D.harvest_through : null;
  WS.partialYr = partialYr;
  for(const sys of WS.sys){
    const own = new Map(), near = new Map();   // site -> {d, src}
    let lat = 0, lon = 0;
    sys.wells.forEach(w => { lat += w.lat; lon += w.lon; });
    sys.lat = lat / sys.wells.length; sys.lon = lon / sys.wells.length;
    sys.wells.forEach((w, wi) => {
      const ose = wsOseOf(sys, w); w._ose = ose; w._own = [];
      wsSitesNear(w.lat, w.lon, Math.max(radM, WS_OWN_M)).forEach(([s, d]) => {
        if(typeof clusterDropSet !== 'undefined' && clusterDropSet.has(s)) return;
        if(d <= WS_OWN_M){ own.set(s, {d, wi, how: 'within ' + WS_OWN_M + ' m'}); w._own.push(s); }
        else { const o = near.get(s); if(!o || d < o.d) near.set(s, {d, wi}); }
      });
      if(ose && ose.nmbgmr) ose.nmbgmr.forEach(id => { const s = nm.get(String(id).toUpperCase()); if(s != null && !own.has(s)){ own.set(s, {d: wsM(w.lat, w.lon, SITES[s][2], SITES[s][1]), wi, how: 'OSE well ID ' + ose.pod}); w._own.push(s); } });
    });
    own.forEach((v, s) => near.delete(s));
    sys._own = [...own.entries()].map(([s, v]) => Object.assign({s}, v)).sort((a, b) => (SITES[b.s][7] || 0) - (SITES[a.s][7] || 0));
    sys._near = [...near.entries()].map(([s, v]) => Object.assign({s}, v)).filter(x => (SITES[x.s][5] || 0) > 0).sort((a, b) => a.d - b.d);
    const nearRecent = sys._near.filter(x => (SITES[x.s][7] || 0) >= since);
    const ownRecent = sys._own.filter(x => (SITES[x.s][7] || 0) >= since);
    sys._mon = ownRecent.length ? 'own' : (nearRecent.length ? 'near' : 'gap');
    sys._nearest = nearRecent[0] || null;
    // reference well for the table trend: the system's own well measured most recently, else the nearest measured since `since`
    const ref = ownRecent[0] || sys._own[0] || nearRecent[0] || null;
    sys._ref = ref ? ref.s : null;
    if(ref){ const tr = wsTrend(wsMonthly(ref.s, true), 10); sys._trend = tr ? tr.slope : null; sys._trendN = tr; } else { sys._trend = null; sys._trendN = null; }
    // pumping: matched OSE records with diversion-meter totals
    const byYr = new Map(); let nPump = 0, nOse = 0;
    sys.wells.forEach(w => { const o = w._ose; if(!o) return; nOse++; if(!o.pump) return; nPump++; o.pump.forEach(([y, af]) => byYr.set(y, (byYr.get(y) || 0) + af)); });
    sys._nOse = nOse; sys._nPump = nPump;
    const yrs = [...byYr.keys()].filter(y => y !== partialYr).sort((a, b) => a - b);
    sys._pumpYrs = byYr;
    const last = yrs.length ? yrs[yrs.length - 1] : null;
    sys._pumpLast = last; sys._pumpAf = last != null ? byYr.get(last) : null;
    sys._gpcd = sys._pumpAf != null && sys.pop > 0 ? sys._pumpAf * 325851 / 365 / sys.pop : null;
    // change: mean of the last 3 complete years against the 3 before them
    const L3 = yrs.slice(-3), P3 = yrs.slice(-6, -3);
    const mean = Y => Y.reduce((t, y) => t + byYr.get(y), 0) / Y.length;
    sys._pumpChg = L3.length === 3 && P3.length === 3 && mean(P3) > 0 ? (mean(L3) / mean(P3) - 1) * 100 : null;
    sys._dm = wsDroughtAt(sys.lat, sys.lon);
  }
}

// ---- U.S. Drought Monitor, current week (live; kept in this browser for 2 days) -------------------------------------------------
async function wsLoadDrought(){
  if(WS.drought || WS.droughtBusy) return; WS.droughtBusy = true;
  try{
    let c = null; try{ c = await idbGet('wsUsdm'); }catch(e){}
    if(!c || !c.feats || Date.now() - (c.savedAt || 0) > 2 * 864e5){
      const p = new URLSearchParams({where: '1=1', geometry: '-109.1,31.3,-103,37.1', geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: 'DM,MapDate,ValidStart,ValidEnd', returnGeometry: 'true', outSR: '4326', maxAllowableOffset: '0.01', geometryPrecision: '3', f: 'json'});
      const r = await fetch(WS_USDM_URL + '?' + p); const j = await r.json(); if(j.error) throw new Error(j.error.message || 'error');
      c = {savedAt: Date.now(), feats: (j.features || []).map(f => ({dm: f.attributes.DM, date: f.attributes.MapDate || f.attributes.ValidStart, rings: (f.geometry && f.geometry.rings) || []}))};
      try{ await idbSet('wsUsdm', c); }catch(e){}
    }
    c.feats.forEach(f => { f.bb = f.rings.map(r => ringBBox2(r)); });
    WS.drought = c;
  }catch(e){ console.warn('drought monitor', e); WS.droughtErr = String(e.message || e); }
  WS.droughtBusy = false;
  if(WS.built){ WS.sys.forEach(sys => { sys._dm = wsDroughtAt(sys.lat, sys.lon); }); wsRenderTable(); wsRenderMapSystems(); if(WS.sel) wsRenderDetail(); }
}
// highest drought category whose polygon holds the point (rings by even-odd, which handles holes); -1 none, null not loaded
function wsDroughtAt(lat, lon){
  if(!WS.drought) return null;
  let best = -1;
  for(const f of WS.drought.feats){
    if(f.dm <= best) continue;
    let inside = false;
    f.rings.forEach((r, i) => { const b = f.bb[i]; if(lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && pointInRing(lon, lat, r)) inside = !inside; });
    if(inside) best = f.dm;
  }
  return best;
}
function wsDmChip(dm){
  if(dm == null) return '<span class="ws-dm none" title="Drought Monitor not loaded">…</span>';
  if(dm < 0) return '<span class="ws-dm none" title="Not in drought or abnormally dry this week">none</span>';
  const lbl = ['abnormally dry', 'moderate drought', 'severe drought', 'extreme drought', 'exceptional drought'][dm];
  return `<span class="ws-dm" style="background:${WS_DM_COLORS[dm]};${dm >= 3 ? 'color:#fff;' : ''}" title="U.S. Drought Monitor: ${lbl}">D${dm}</span>`;
}
function wsDroughtDate(){ const f = WS.drought && WS.drought.feats[0]; return f && f.date ? new Date(f.date).toISOString().slice(0, 10) : ''; }

// ---- screening table ------------------------------------------------------------------------------------------------------------
const WS_COLS = [
  {k: 'name', t: 'System', title: 'System name, county and population class'},
  {k: 'pop', t: 'People', title: 'Population served (NMED)'},
  {k: 'wells', t: 'Wells', title: 'Wells and springs (NMED) · with their own OSE well record'},
  {k: 'pump', t: 'Pumped AF', title: 'Metered pumping in the last complete OSE year, acre-feet, from the matched wells only'},
  {k: 'chg', t: 'Pump chg', title: 'Pumping, mean of the last 3 complete years against the 3 before'},
  {k: 'mon', t: 'Monitoring', title: 'Own well: a water-level well at a source (within ' + WS_OWN_M + ' m, or the same OSE well ID). Otherwise the nearest well measured since the chosen year. Gap: none.'},
  {k: 'trend', t: 'Level ft/yr', title: 'Theil-Sen trend of the reference well over its last 10 years (positive = water deeper)'},
  {k: 'dm', t: 'Drought', title: 'U.S. Drought Monitor category at the system this week'}
];
function wsSortVal(sys, k){
  switch(k){
    case 'name': return sys.name.toLowerCase();
    case 'pop': return sys.pop;
    case 'wells': return sys.wells.length * 100 + sys._nOse;
    case 'pump': return sys._pumpAf == null ? -1 : sys._pumpAf;
    case 'chg': return sys._pumpChg == null ? -1e9 : sys._pumpChg;
    case 'mon': return sys._mon === 'own' ? -1 : (sys._nearest ? sys._nearest.d : 1e9);
    case 'trend': return sys._trend == null ? -1e9 : sys._trend;
    case 'dm': return sys._dm == null ? -2 : sys._dm;
  }
  return 0;
}
function wsFiltered(){
  const f = WS.f, q = f.q.trim().toLowerCase();
  return WS.sys.filter(sys => (f.kind === 'all' || sys.mdw) && (!f.size || sys.size === f.size) && (!f.county || sys.county === f.county)
    && (!f.gap || sys._mon === 'gap') && (!q || (sys.name + ' ' + sys.id + ' ' + sys.county + ' ' + sys.city).toLowerCase().includes(q)));
}
function wsMonCell(sys){
  if(sys._mon === 'own') return '<span class="ws-tag own" title="A water-level well at one of the system\'s own sources">own well</span>';
  if(sys._nearest) return `<span title="Nearest well measured since ${WS.f.since}: ${escHtml(SITES[sys._nearest.s][0])}, last reading ${SITES[sys._nearest.s][7]}">${wsDist(sys._nearest.d)} · ${SITES[sys._nearest.s][7]}</span>`;
  return `<span class="ws-tag gap" title="No water-level well within ${WS.f.radius} mi measured since ${WS.f.since}">gap</span>`;
}
function wsRenderTable(){
  const tb = document.querySelector('#ws-table tbody'), th = document.querySelector('#ws-table thead'); if(!tb) return;
  const {k, dir} = WS.sort;
  th.innerHTML = '<tr>' + WS_COLS.map(c => `<th data-k="${c.k}" title="${escHtml(c.title)}" class="${c.k === k ? 'sorted' : ''}">${c.t}${c.k === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
  const rows = wsFiltered().sort((a, b) => { const x = wsSortVal(a, k), y = wsSortVal(b, k); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name); });
  WS.rows = rows;
  tb.innerHTML = rows.map(sys => {
    const tr = sys._trend;
    return `<tr data-id="${escHtml(sys.id)}" class="${WS.sel === sys.id ? 'cur' : ''}">
      <td class="nm">${escHtml(sys.name)}<small>${escHtml(sys.county)} · ${sys.size}${sys.mdw && WS.f.kind === 'all' ? ' · mutual domestic' : ''}</small></td>
      <td>${wsFmt(sys.pop)}</td>
      <td title="${sys.wells.length} sources in NMED, ${sys._nOse} with their own OSE well record, ${sys._nPump} with metered pumping">${sys.wells.length}<span style="color:var(--muted)"> · ${sys._nOse}</span></td>
      <td title="${sys._pumpLast ? 'OSE year ' + sys._pumpLast + ', ' + sys._nPump + ' of ' + sys.wells.length + ' wells metered' : 'No metered pumping found'}">${sys._pumpAf == null ? '–' : wsFmt(sys._pumpAf, sys._pumpAf < 10 ? 1 : 0)}</td>
      <td class="${sys._pumpChg > 10 ? 'ws-up' : sys._pumpChg < -10 ? 'ws-down' : ''}">${sys._pumpChg == null ? '–' : (Math.round(sys._pumpChg) > 0 ? '+' : '') + wsFmt(Math.round(sys._pumpChg) || 0) + '%'}</td>
      <td>${wsMonCell(sys)}</td>
      <td class="${tr > 0.5 ? 'ws-up' : tr < -0.5 ? 'ws-down' : ''}" title="${sys._trendN ? 'Reference well ' + escHtml(SITES[sys._ref][0]) + ', ' + sys._trendN.from + '–' + sys._trendN.to + ', ' + sys._trendN.n + ' monthly values' : 'Too little recent record for a trend'}">${tr == null ? '–' : (tr > 0 ? '+' : '') + wsFmt(tr, 2)}</td>
      <td>${wsDmChip(sys._dm)}</td></tr>`;
  }).join('') || `<tr><td colspan="${WS_COLS.length}" style="text-align:center;color:var(--muted);padding:20px;font-family:var(--font-ui)">No systems match these filters.</td></tr>`;
  const gap = rows.filter(s => s._mon === 'gap').length, own = rows.filter(s => s._mon === 'own').length;
  document.getElementById('ws-count').innerHTML = `<span><b>${rows.length.toLocaleString()}</b> systems · <b>${rows.reduce((t, s) => t + s.pop, 0).toLocaleString()}</b> people</span>
    <span><span class="ws-tag own">own well</span> ${own} · <span class="ws-tag near">nearby</span> ${rows.length - own - gap} · <span class="ws-tag gap">gap</span> ${gap}</span>`;
}

// ---- map --------------------------------------------------------------------------------------------------------------------------
const WS_MON_COLOR = {own: 'var(--accent)', near: 'var(--rise)', gap: 'var(--warn)'};
function wsCssColor(v){ const m = /var\((--[^)]+)\)/.exec(v); return m ? (getComputedStyle(document.body).getPropertyValue(m[1]).trim() || '#888') : v; }
function wsBuildMap(){
  if(WS.map) return;
  const m = L.map('ws-map', {preferCanvas: true, zoomControl: true}).setView([34.4, -106.1], 6);
  WS.map = m; wsTiles();
  // follow the light / dark switch: tiles, and the page's chart colours
  new MutationObserver(() => { wsTiles(); if(WS.sel && hxScreen === 'systems') wsRenderDetail(); }).observe(document.body, {attributes: true, attributeFilter: ['data-theme']});
  WS.layers.sys = L.layerGroup().addTo(m);
  WS.layers.focus = L.layerGroup().addTo(m);
  const lg = document.createElement('div'); lg.id = 'ws-map-legend';
  lg.innerHTML = `<div><i style="background:${wsCssColor(WS_MON_COLOR.own)}"></i>own water-level well</div><div><i style="background:${wsCssColor(WS_MON_COLOR.near)}"></i>nearby well only</div><div><i style="background:${wsCssColor(WS_MON_COLOR.gap)}"></i>monitoring gap</div>`;
  document.getElementById('ws-map').appendChild(lg);
}
function wsTiles(){
  const key = state.theme === 'dark' ? 'dark' : 'light'; if(WS.tileKey === key) return;
  if(WS.tiles) WS.map.removeLayer(WS.tiles);
  WS.tiles = L.tileLayer(BASEMAPS[key]._url, BASEMAPS[key].options).addTo(WS.map); WS.tileKey = key;
}
function wsRenderMapSystems(){
  if(!WS.map) return;
  WS.layers.sys.clearLayers();
  const show = new Set((WS.rows || wsFiltered()).map(s => s.id));
  WS.sys.forEach(sys => {
    if(!show.has(sys.id)) return;
    const r = 3 + Math.min(7, Math.sqrt(sys.pop) / 8), col = wsCssColor(WS_MON_COLOR[sys._mon]);
    const mk = L.circleMarker([sys.lat, sys.lon], {radius: r, color: WS.sel === sys.id ? '#20291f' : '#fff', weight: WS.sel === sys.id ? 2.5 : 1, fillColor: col, fillOpacity: .9});
    mk.bindTooltip(`<b>${escHtml(sys.name)}</b><br>${wsFmt(sys.pop)} people · ${sys._mon === 'own' ? 'own water-level well' : sys._mon === 'near' ? 'nearby well ' + wsDist(sys._nearest.d) : 'monitoring gap'}`);
    mk.on('click', () => wsSelect(sys.id));
    mk.addTo(WS.layers.sys);
  });
}

// ---- open, filters, selection --------------------------------------------------------------------------------------------------
function wsOpen(){
  const main = document.getElementById('ws-main');
  if(!WS.ok){
    document.getElementById('ws-detail').innerHTML = `<div class="empty"><b>The water-system data file is missing.</b><br>Put <code>water-systems.js</code> next to <code>index.html</code>.
      Build it with <code>python tools/build-water-systems.py</code> after the OSE meter harvest has run.</div>`;
    document.getElementById('ws-count').textContent = ''; return;
  }
  wsBuildMap();
  if(!WS.built){
    WS.built = true;
    wsDerive();
    const counties = [...new Set(WS.sys.map(s => s.county).filter(Boolean))].sort();
    document.getElementById('ws-county').innerHTML = '<option value="">All counties</option>' + counties.map(c => `<option>${escHtml(c)}</option>`).join('');
    wsRenderTable(); wsRenderMapSystems();
    const saved = wsStore.get('hxWsSel', null);
    if(saved && WS.byId.has(saved)) wsSelect(saved, {noScroll: true});
    wsLoadDrought();
  }
  requestAnimationFrame(() => { try{ WS.map.invalidateSize(); }catch(e){} if(WS.pageChart) try{ WS.pageChart.resize(); }catch(e){} });
  main.classList.toggle('has-sel', !!WS.sel);
}
function wsRefresh(){ wsDerive(); wsRenderTable(); wsRenderMapSystems(); if(WS.sel) wsRenderDetail(); }
function wsSelect(id, opts){
  opts = opts || {};
  if(!WS.byId.has(id)) return;
  WS.sel = id; wsStore.set('hxWsSel', id);
  WS.ref = null;   // reference well chosen again for the new system
  document.getElementById('ws-main').classList.add('has-sel');
  document.querySelectorAll('#ws-table tr.cur').forEach(tr => tr.classList.remove('cur'));
  const tr = document.querySelector(`#ws-table tr[data-id="${CSS.escape(id)}"]`);
  if(tr){ tr.classList.add('cur'); if(!opts.noScroll) tr.scrollIntoView({block: 'nearest'}); }
  wsRenderMapSystems();
  wsRenderDetail();
  requestAnimationFrame(() => { try{ WS.map.invalidateSize(); }catch(e){} });
  if(!opts.noScroll) document.getElementById('ws-main').scrollTop = 0;
}

// ---- CSV exports ----------------------------------------------------------------------------------------------------------------
function wsScreeningCsv(){
  const rows = [['pws_id', 'system_name', 'mutual_domestic', 'county', 'city', 'population', 'size_class', 'storage_gal', 'sources', 'sources_with_ose_record', 'sources_with_metered_pumping',
    'pumped_af_last_complete_year', 'pumping_year', 'gallons_per_person_per_day', 'pumping_change_pct_last3_vs_prior3', 'monitoring', 'own_water_level_wells', 'nearest_well', 'nearest_well_mi', 'nearest_well_last_year',
    'reference_well', 'level_trend_ft_per_yr', 'trend_years', 'drought_monitor', 'drought_monitor_date', 'nearby_radius_mi', 'measured_since']];
  (WS.rows || wsFiltered()).forEach(s => rows.push([s.id, s.name, s.mdw ? 'yes' : 'no', s.county, s.city, s.pop, s.size, s.store_gal, s.wells.length, s._nOse, s._nPump,
    s._pumpAf == null ? '' : +s._pumpAf.toFixed(3), s._pumpLast || '', s._gpcd == null ? '' : Math.round(s._gpcd), s._pumpChg == null ? '' : Math.round(s._pumpChg),
    s._mon, s._own.map(o => SITES[o.s][0]).join('; '), s._nearest ? SITES[s._nearest.s][0] : '', s._nearest ? +wsMi(s._nearest.d).toFixed(2) : '', s._nearest ? SITES[s._nearest.s][7] : '',
    s._ref != null ? SITES[s._ref][0] : '', s._trend == null ? '' : +s._trend.toFixed(3), s._trendN ? s._trendN.from + '-' + s._trendN.to : '',
    s._dm == null ? '' : s._dm < 0 ? 'none' : 'D' + s._dm, wsDroughtDate(), WS.f.radius, WS.f.since]));
  downloadCsv('water_systems_screening_' + todayStr + '.csv', rows);
}
function wsMatchesCsv(){
  const rows = [['pws_id', 'system_name', 'source_name', 'nmed_source_id', 'latitude', 'longitude', 'nmed_well_depth_ft', 'nmed_static_level_ft', 'nmed_static_level_date',
    'ose_pod', 'match', 'distance_m', 'ose_owner', 'ose_use', 'ose_well_depth_ft', 'screen_top_ft', 'screen_bottom_ft', 'plss_located', 'metered_pumping_years', 'water_level_wells_at_source', 'your_choice']];
  (WS.rows || wsFiltered()).forEach(s => s.wells.forEach(w => {
    const o = w._ose, ch = wsChoices()[wsSrcKey(s, w)];
    rows.push([s.id, s.name, w.name, w.fid, w.lat, w.lon, w.depth, w.swl, w.swl_date, o ? o.pod : '', o ? o.how : 'none', o ? o.m : '', o ? o.owner : '', o ? o.use : '',
      o ? o.depth : '', o ? o.ptop : '', o ? o.pbot : '', o ? (o.plss ? 'yes' : 'no') : '', o && o.pump ? o.pump.map(p => p[0]).join(' ') : '', (w._own || []).map(x => SITES[x][0]).join('; '),
      ch ? (ch.pod === null ? 'rejected' : 'accepted ' + ch.pod) : '']);
  }));
  downloadCsv('water_system_well_matches_' + todayStr + '.csv', rows);
}

(function wsInit(){
  const D = window.HX_WATER_SYSTEMS;
  WS = {D, ok: !!(D && D.systems && D.systems.length), sys: D && D.systems ? D.systems : [], byId: new Map(), sel: null, ref: null, map: null, layers: {}, built: false,
    drought: null, sort: wsStore.get('hxWsSort', {k: 'name', dir: 1}),
    f: Object.assign({q: '', kind: 'mdw', size: '', county: '', gap: false, radius: 2, since: 2020}, wsStore.get('hxWsFilt', {}), {q: ''})};
  WS.sys.forEach(s => WS.byId.set(s.id, s));
  const saveF = () => wsStore.set('hxWsFilt', {kind: WS.f.kind, size: WS.f.size, radius: WS.f.radius, since: WS.f.since, gap: WS.f.gap});
  const kindSeg = document.getElementById('ws-kind');
  kindSeg.querySelectorAll('button').forEach(b => { b.classList.toggle('active', b.dataset.k === WS.f.kind); b.addEventListener('click', () => {
    WS.f.kind = b.dataset.k; kindSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); saveF(); wsRenderTable(); wsRenderMapSystems(); }); });
  const sz = document.getElementById('ws-size'); sz.value = WS.f.size; sz.addEventListener('change', () => { WS.f.size = sz.value; saveF(); wsRenderTable(); wsRenderMapSystems(); });
  const co = document.getElementById('ws-county'); co.addEventListener('change', () => { WS.f.county = co.value; wsRenderTable(); wsRenderMapSystems(); });
  const rad = document.getElementById('ws-radius'); rad.innerHTML = WS_RADII_MI.map(r => `<option value="${r}">${r} mi</option>`).join(''); rad.value = String(WS.f.radius);
  rad.addEventListener('change', () => { WS.f.radius = +rad.value; saveF(); if(WS.built) wsRefresh(); });
  const sin = document.getElementById('ws-since'); sin.value = String(WS.f.since);
  sin.addEventListener('change', () => { WS.f.since = +sin.value; saveF(); if(WS.built) wsRefresh(); });
  const gp = document.getElementById('ws-gap-only'); gp.checked = !!WS.f.gap; gp.addEventListener('change', () => { WS.f.gap = gp.checked; saveF(); wsRenderTable(); wsRenderMapSystems(); });
  let qt = null; document.getElementById('ws-search').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { WS.f.q = e.target.value; wsRenderTable(); wsRenderMapSystems(); }, 150); });
  document.querySelector('#ws-table thead').addEventListener('click', e => { const th = e.target.closest('th'); if(!th) return; const k = th.dataset.k;
    WS.sort = {k, dir: WS.sort.k === k ? -WS.sort.dir : (k === 'name' ? 1 : -1)}; wsStore.set('hxWsSort', WS.sort); wsRenderTable(); });
  document.querySelector('#ws-table tbody').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if(tr) wsSelect(tr.dataset.id, {noScroll: true}); });
  document.getElementById('ws-csv').addEventListener('click', wsScreeningCsv);
  document.getElementById('ws-matches-csv').addEventListener('click', wsMatchesCsv);
  const meta = document.getElementById('ws-meta');
  if(meta) meta.textContent = WS.ok ? `${WS.sys.length.toLocaleString()} community systems of up to ${(D.rules && D.rules.max_pop || 3300).toLocaleString()} people · data file built ${D.gen}${D.harvest_through ? ' · OSE meter readings through ' + D.harvest_through : ''}` : '';
  window.__hx = Object.assign(window.__hx || {}, {get ws(){ return WS; }, wsStatus: (...a) => wsStatus(...a), wsMonthly, wsTrend, wsDroughtAt, wsSelect, wsBeforePrint, wsAfterPrint});
  if(wsPending || hxScreen === 'systems') wsOpen();
})();
