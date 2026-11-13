(async function(){
"use strict";

/* -------------------------------------------------------------------- */
/* 0. Decompress embedded data                                          */
/* -------------------------------------------------------------------- */
function b64ToBytes(b64){
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function loadGz(b64){
  const bytes = b64ToBytes(b64);
  const text = window.pako.inflate(bytes, {to:'string'});
  return JSON.parse(text);
}

const AQUIFEREXT_DATA = loadGz(AQUIFEREXT_B64); // {names:[...], polygons:[[ [ring,...], ... ], ...]} per name
const STUDY_AREAS = loadGz(STUDYAREAS_B64); // [{name,status,startYear,endYear,link,polys}, ...]
// Built-in site attributes the API does not serve yet (formation, USGS aquifer, aquifer-extent and study-area membership), keyed by source + id
const ENRICH = loadGz(ENRICH_B64);
const AQUIFER_EXTENT_POLYGONS = AQUIFEREXT_DATA.polygons || []; // per name: array of polygons, each = array of rings
const apiState = {live:'idle', liveMsg:'', clusters:'idle', layers:{}, popup:new Map()};
/* -------------------------------------------------------------------- */
/* 0b. Data comes from the NM Unified Water Data API (OGC API - Features) */
/* -------------------------------------------------------------------- */
const API_BASE = 'https://die-pygeoapi-95715287188.us-central1.run.app';
const API_PAGE = 10000;                        // the server's maximum page size
const API_DTW = 'depth_to_water_below_ground_surface';
const CACHE_VER = 4;   // 4: every reading kept
const sleep = ms => new Promise(r=>setTimeout(r, ms));
async function apiFetch(url, tries, fopts){
  tries = tries || 4; let lastErr;
  for(let a=0; a<tries; a++){
    try{
      const r = await fetch(url, fopts || (a > 0 ? {cache:'no-store'} : undefined));
      if(r.status === 429 || r.status >= 500){ lastErr = new Error('HTTP '+r.status); await sleep(600 * Math.pow(2, a)); continue; }
      if(!r.ok){ const e = new Error('HTTP '+r.status); e.noRetry = true; throw e; }   // 4xx (not 429): retrying will not help
      return r;
    }catch(e){ lastErr = e; if(e.noRetry) break; if(a < tries-1) await sleep(600 * Math.pow(2, a)); }
  }
  throw lastErr || new Error('API unavailable');
}
async function apiJson(path, params, fopts){ const r = await apiFetch(API_BASE + path + '?' + new URLSearchParams(params), 4, fopts); return r.json(); }
async function apiPool(tasks, n, onDone){
  let next = 0, done = 0; const res = new Array(tasks.length);
  async function worker(){ while(next < tasks.length){ const k = next++; res[k] = await tasks[k](); done++; if(onDone) onDone(done, tasks.length); } }
  await Promise.all(Array.from({length:Math.min(n, tasks.length)}, worker));
  return res;
}
// every feature of a collection (all pages, 4 at a time). opts.geometry keeps the point geometry.
async function apiFeatures(collection, params, onProgress, opts){
  opts = opts || {};
  const base = Object.assign({f:'json', limit:API_PAGE}, opts.geometry ? {} : {skipGeometry:'true'}, params || {});
  let p0 = null;
  for(let a=0; a<4; a++){                       // the service sometimes answers 200 with an empty page while it warms up
    p0 = await apiJson('/collections/'+collection+'/items', Object.assign({offset:0}, base), a > 0 ? {cache:'no-store'} : undefined);
    if(p0 && p0.features && p0.features.length) break;
    if(p0 && p0.numberMatched === 0) break;      // a genuinely empty answer: no warm-up retries
    await sleep(1200 * (a+1));
  }
  if(!p0 || !p0.features) throw new Error('The API answered without a feature list.');
  const feats = p0.features.slice();
  const total = p0.numberMatched != null ? p0.numberMatched : feats.length;
  if(feats.length > 0 && feats.length < total){
    const step = feats.length, offs = [];
    for(let o=step; o<total; o+=step) offs.push(o);
    const pages = await apiPool(offs.map(o=>()=>apiJson('/collections/'+collection+'/items', Object.assign({}, base, {offset:o}))), 4, onProgress);
    pages.forEach(p=>{ for(const f of (p.features||[])) feats.push(f); });
  }
  return {features:feats, total};
}
function setLivePill(txt, tip, cls){
  const el = document.getElementById('live-pill'); if(!el) return;
  el.innerHTML = txt; el.title = tip || ''; el.className = 'pill live ' + (cls || '');
}

// ---- tiny IndexedDB key/value cache (wells + aggregated readings), best-effort ----
function idbOpen(){
  return new Promise((res, rej)=>{
    try{
      const rq = indexedDB.open('nm-hydrograph-cache', 1);
      rq.onupgradeneeded = ()=>rq.result.createObjectStore('kv');
      rq.onsuccess = ()=>res(rq.result); rq.onerror = ()=>rej(rq.error);
    }catch(e){ rej(e); }
  });
}
async function idbGet(key){
  try{ const db = await idbOpen(); return await new Promise((res, rej)=>{ const r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = ()=>res(r.result); r.onerror = ()=>rej(r.error); }); }
  catch(e){ return undefined; }
}
async function idbSet(key, val){
  try{ const db = await idbOpen(); await new Promise((res, rej)=>{ const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = res; tx.onerror = ()=>rej(tx.error); }); return true; }
  catch(e){ return false; }
}
async function idbClear(){ try{ const db = await idbOpen(); await new Promise(res=>{ const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').clear(); tx.oncomplete = res; tx.onerror = res; }); }catch(e){} }
const packJson = o => window.pako.deflate(JSON.stringify(o));
const unpackJson = u8 => JSON.parse(window.pako.inflate(u8, {to:'string'}));

function bootUi(){
  const root = document.getElementById('boot'), msg = document.getElementById('boot-msg'), fill = document.getElementById('boot-fill'),
        detail = document.getElementById('boot-detail'), actions = document.getElementById('boot-actions');
  return {
    set(m, frac, d){ if(msg) msg.textContent = m; if(fill && frac != null) fill.style.width = Math.round(frac*100) + '%'; if(detail && d != null) detail.textContent = d; },
    fail(m){ if(msg) msg.textContent = 'Could not load the data'; if(detail) detail.textContent = m; if(fill) fill.style.width = '0%';
      if(actions) actions.innerHTML = '<button class="btn primary" onclick="location.reload()">Try again</button>'; },
    done(){ if(root) root.style.display = 'none'; }
  };
}

const SOURCE_ORDER = ['USGS-NWIS','ST2/CABQ','ST2/PVACD','ST2/BernCo','NMBGMR','ST2/EBID','ISCSevenRivers','ST2/NMOSE-Roswell','WQP'];
const todayStr = new Date().toISOString().slice(0,10);

// optional site attributes the API may start serving; used only if it lists them as queryables
async function apiSiteProps(){
  try{
    const q = await apiJson('/collections/nm_waterlevels_summary/queryables', {f:'json'});
    const have = Object.keys(q.properties || {});
    return ['formation','aquifer','vertical_datum','elevation'].filter(k=>have.includes(k));
  }catch(e){ return []; }
}
async function fetchSiteRows(ui){
  const extra = await apiSiteProps();
  const props = ['source','id','name','usgs_site_id','alternate_site_id','well_depth'].concat(extra).join(',');
  const {features, total} = await apiFeatures('nm_waterlevels_summary', {properties: props}, (d,t)=>ui.set('Loading wells from the API…', 0.02 + 0.06*d/t), {geometry:true});
  apiState.siteDiag = {features:features.length, total};
  return features.map(f=>{
    const p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [null, null, null];
    const z = p.elevation != null ? Number(p.elevation) : (c[2] != null ? Number(c[2]) : null);
    return [p.source, String(p.id), p.name || '', c[0], c[1], z, p.well_depth == null ? null : Number(p.well_depth), p.usgs_site_id || null, p.alternate_site_id || '', p.formation || null, p.aquifer || null];
  }).filter(r=>r[3] != null && r[4] != null);
}

/* ---- aggregation of readings into month / year rows (same rules as the original build) ----
   Only depth-to-water readings with a real, non-future date; exact repeats (site, date, time, value) counted once. */
function newAgg(){ return {mon:new Map(), yr:new Map(), seen:new Set(), maxDate:''}; }
// Quality flags carried with every reading (bit set): 1 static, 2 disturbed (pumping / affected / foreign substance...), 4 approved, 8 provisional, 16 manual, 32 continuous logger
function readingFlags(p){
  const q = String(p.qualifier || ''), a = String(p.approval_status_normalized || '').toLowerCase(), sp = String(p.source_parameter_name || '');
  let fl = 0;
  if(/^\s*static\s*$/i.test(q)) fl |= 1;
  if(/pump|affect|foreign|recent|obstruct|nearby|inject|flowing|dry|invalid|equip|other/i.test(q)) fl |= 2;
  if(a === 'approved') fl |= 4; else if(a === 'provisional') fl |= 8;
  if(/manual/i.test(sp)) fl |= 16; else if(/^\s*groundwater levels\s*$/i.test(sp)) fl |= 32;
  return fl;
}
// aggregate keys carry the flag set in their low 6 bits, so any quality filter can be applied later without re-downloading
function aggAdd(agg, s, d, t, v, fl){
  const dk = s + '|' + d + '|' + t + '|' + v;
  if(agg.seen.has(dk)) return false; agg.seen.add(dk);
  fl = fl || 0;
  const y = +d.slice(0,4), m = +d.slice(5,7);
  const mk = (s*100000 + y*12 + (m-1))*64 + fl;
  let a = agg.mon.get(mk); if(!a){ a = [0,0]; agg.mon.set(mk, a); } a[0] += v; a[1]++;
  const yk = (s*10000 + y)*64 + fl; let b = agg.yr.get(yk); if(!b){ b = [0,0,v,v]; agg.yr.set(yk, b); } b[0] += v; b[1]++; if(v < b[2]) b[2] = v; if(v > b[3]) b[3] = v;
  if(d > agg.maxDate) agg.maxDate = d;
  return true;
}
function aggAddFeature(agg, siteOf, p){
  if(p.parameter_name !== API_DTW) return;
  const v0 = Number(p.parameter_value); if(!isFinite(v0)) return;
  const v = Math.round(v0 * 100) / 100;                                       // depth to water is kept to 0.01 ft
  const d = p.date_measured; if(!d || d > todayStr || d < '1800' || !/^\d{4}-\d{2}-\d{2}/.test(d)) return;      // drops bad dates such as year 2316
  const s = siteOf(p.source, p.id); if(s == null) return;
  const t = p.time_measured || '', fl = readingFlags(p);
  if(aggAdd(agg, s, d, t, v, fl) && agg.raw) rawPush(agg.raw, s, d, t, v, fl, p.qualifier, p.approval_status_normalized);
}
const TS_PROPS = 'source,id,parameter_name,parameter_value,date_measured,time_measured,qualifier,approval_status_normalized,source_parameter_name';
async function fetchReadingsInto(agg, siteOf, params, ui, label, fracLo, fracHi){
  const base = Object.assign({f:'json', limit:API_PAGE, skipGeometry:'true', properties:TS_PROPS}, params || {});
  let p0 = null;
  for(let a=0; a<4; a++){                       // warm-up: an empty first page while numberMatched says otherwise
    p0 = await apiJson('/collections/nm_waterlevels_timeseries/items', Object.assign({offset:0}, base), a > 0 ? {cache:'no-store'} : undefined);
    if(p0 && p0.features && (p0.features.length || p0.numberMatched === 0)) break;
    await sleep(1200 * (a+1));
  }
  if(!p0 || !p0.features) throw new Error('The API answered without a feature list.');
  const total = p0.numberMatched != null ? p0.numberMatched : p0.features.length;
  p0.features.forEach(f=>aggAddFeature(agg, siteOf, f.properties));
  let rows = p0.features.length;
  const step = p0.features.length;
  if(step > 0 && step < total){
    const offs = []; for(let o=step; o<total; o+=step) offs.push(o);
    const t0 = performance.now();
    await apiPool(offs.map(o=>async()=>{
      const p = await apiJson('/collections/nm_waterlevels_timeseries/items', Object.assign({}, base, {offset:o}));
      p.features.forEach(f=>aggAddFeature(agg, siteOf, f.properties)); rows += p.features.length;
    }), 6, (d, t)=>{
      const el = (performance.now() - t0) / 1000, eta = d > 0 ? Math.round(el * (t - d) / d) : null;
      ui.set(label, fracLo + (fracHi - fracLo) * (d / t), rows.toLocaleString() + ' of ' + total.toLocaleString() + ' readings' + (eta != null && t - d > 2 ? ' · about ' + (eta >= 90 ? Math.round(eta/60) + ' min' : eta + ' s') + ' left' : ''));
    });
  }
  if(rows < total) throw new Error(`Only ${rows.toLocaleString()} of ${total.toLocaleString()} readings arrived`);   // never keep a partial download
  return {rows, total};
}
function aggToCache(agg, keyOfSite){
  const keys = [], kidx = new Map(); const kOf = s => { let i = kidx.get(s); if(i == null){ i = keys.length; keys.push(keyOfSite(s)); kidx.set(s, i); } return i; };
  const mon = [], yr = [];
  agg.mon.forEach((a, mk)=>{ const fl = mk % 64, base = (mk - fl)/64, s = Math.floor(base/100000), ym = base % 100000; mon.push([kOf(s), Math.floor(ym/12), ym%12+1, a[0], a[1], fl]); });
  agg.yr.forEach((b, yk)=>{ const fl = yk % 64, base = (yk - fl)/64, s = Math.floor(base/10000); yr.push([kOf(s), base % 10000, b[0], b[1], b[2], b[3], fl]); });
  return {ver:CACHE_VER, keys, mon, yr, maxDate:agg.maxDate, savedAt:Date.now()};
}
function aggFromCache(c, siteOfKey){
  const agg = newAgg(); agg.maxDate = c.maxDate || '';
  const sOf = c.keys.map(siteOfKey);
  c.mon.forEach(r=>{ const s = sOf[r[0]]; if(s != null) agg.mon.set((s*100000 + r[1]*12 + (r[2]-1))*64 + r[5], [r[3], r[4]]); });
  c.yr.forEach(r=>{ const s = sOf[r[0]]; if(s != null) agg.yr.set((s*10000 + r[1])*64 + r[6], [r[2], r[3], r[4], r[5]]); });
  return agg;
}
// replace every month from cutKey (YYYYMM) onward with fresh API rows
function aggApplyDelta(agg, deltaAgg, cutKey){
  const cutY = Math.floor(cutKey/100), cutM = cutKey % 100, cutMK = cutY*12 + cutM - 1;
  const ymOf = mk => Math.floor(mk/64) % 100000, yOf = yk => Math.floor(yk/64) % 10000;
  const oldYr = new Map();
  agg.yr.forEach((b, yk)=>{ if(yOf(yk) >= cutY) oldYr.set(yk, b); });
  agg.mon.forEach((a, mk)=>{ if(ymOf(mk) >= cutMK) agg.mon.delete(mk); });
  deltaAgg.mon.forEach((a, mk)=>{ if(ymOf(mk) >= cutMK) agg.mon.set(mk, a); });
  const yks = new Set([...oldYr.keys(), ...[...deltaAgg.yr.keys()].filter(yk=>yOf(yk) >= cutY)]);
  yks.forEach(yk=>{
    const fl = yk % 64, base = (yk - fl)/64, s = Math.floor(base/10000), y = base % 10000; let sum = 0, n = 0;
    for(let m=0; m<12; m++){ const a = agg.mon.get((s*100000 + y*12 + m)*64 + fl); if(a){ sum += a[0]; n += a[1]; } }
    if(!n){ agg.yr.delete(yk); return; }
    const o = oldYr.get(yk), d = deltaAgg.yr.get(yk);
    let mn = Infinity, mx = -Infinity;
    if(o){ mn = Math.min(mn, o[2]); mx = Math.max(mx, o[3]); }
    if(d){ mn = Math.min(mn, d[2]); mx = Math.max(mx, d[3]); }
    agg.yr.set(yk, [sum, n, mn, mx]);
  });
  if(deltaAgg.maxDate > agg.maxDate) agg.maxDate = deltaAgg.maxDate;
}
// month / year rows (one per well and month) for the readings whose flag set passes `pass`
// sub (optional): {mon, yr} maps of the same keys holding [sum, count] of readings to leave out (e.g. likely pumped
// readings); they are taken off the aggregates before collapsing (a year's min / max are not recomputed)
function collapseAgg(agg, finalOf, pass, sub){
  const mon = new Map(), yr = new Map(), r2 = x => Math.round(x*100)/100;
  agg.mon.forEach((a, mk)=>{
    const fl = mk % 64; if(!pass(fl)) return;
    if(sub){ const d = sub.mon.get(mk); if(d){ if(a[1] - d[1] <= 0) return; a = [a[0] - d[0], a[1] - d[1]]; } }
    const base = (mk - fl)/64, s = finalOf.get(Math.floor(base/100000)); if(s == null) return;
    const k = s*100000 + base % 100000, t = mon.get(k); if(t){ t[0] += a[0]; t[1] += a[1]; } else mon.set(k, [a[0], a[1]]);
  });
  agg.yr.forEach((b, yk)=>{
    const fl = yk % 64; if(!pass(fl)) return;
    if(sub){ const d = sub.yr.get(yk); if(d){ if(b[1] - d[1] <= 0) return; b = [b[0] - d[0], b[1] - d[1], b[2], b[3]]; } }
    const base = (yk - fl)/64, s = finalOf.get(Math.floor(base/10000)); if(s == null) return;
    const k = s*10000 + base % 10000, t = yr.get(k);
    if(t){ t[0] += b[0]; t[1] += b[1]; if(b[2] < t[2]) t[2] = b[2]; if(b[3] > t[3]) t[3] = b[3]; } else yr.set(k, b.slice());
  });
  const siteMonth = [], siteYear = [];
  mon.forEach((a, k)=>{ const s = Math.floor(k/100000), ym = k % 100000; siteMonth.push([s, Math.floor(ym/12), ym%12+1, r2(a[0]/a[1]), a[1]]); });
  yr.forEach((b, k)=>{ siteYear.push([Math.floor(k/10000), k % 10000, r2(b[0]/b[1]), b[1], b[2], b[3]]); });
  siteMonth.sort((a,b)=>a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
  siteYear.sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
  return {siteMonth, siteYear};
}
// per-well record fields shown in popups and filters (readings, first/last year, min, max, mean)
function finalizeSiteRecs(sites, siteYear){
  const r2 = x => Math.round(x*100)/100;
  const sum = new Float64Array(sites.length), cnt = new Float64Array(sites.length);
  sites.forEach(rec=>{ rec[5] = 0; rec[6] = null; rec[7] = null; rec[8] = null; rec[9] = null; rec[10] = null; });
  siteYear.forEach(y=>{
    const rec = sites[y[0]];
    rec[5] += y[3]; sum[y[0]] += y[2]*y[3]; cnt[y[0]] += y[3];
    if(rec[6] == null || y[1] < rec[6]) rec[6] = y[1];
    if(rec[7] == null || y[1] > rec[7]) rec[7] = y[1];
    if(rec[8] == null || y[4] < rec[8]) rec[8] = y[4];
    if(rec[9] == null || y[5] > rec[9]) rec[9] = y[5];
  });
  sites.forEach((rec, i)=>{ rec[10] = cnt[i] ? r2(sum[i]/cnt[i]) : null; });
}

/* ---- every reading kept in the browser, in packed arrays ----------------------------
   Depth to water is kept to 0.01 ft (an integer number of hundredths). Per reading: day (days since 1800-01-01),
   minute of the day (-1 = no time), value, quality flags, and indexes into small tables of qualifier and approval
   text: about 13 bytes, so all ~880,000 readings take ~11 MB. Readings are grouped by well (off[s] .. off[s+1]) and
   sorted by date and time within each well. The monthly / yearly aggregates are rebuilt from this store. */
const RAW_EPOCH = Date.UTC(1800, 0, 1);
const rawDayOf = d => Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - RAW_EPOCH) / 864e5);
const rawDateOf = day => new Date(RAW_EPOCH + day * 864e5).toISOString().slice(0, 10);
const rawMinOf = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : -1; };
const rawTimeOf = mi => mi < 0 ? '' : String(Math.floor(mi / 60)).padStart(2, '0') + ':' + String(mi % 60).padStart(2, '0');
function rawCollector(){ return {s:[], day:[], min:[], v:[], fl:[], q:[], a:[], qT:[''], aT:[''], qI:new Map([['', 0]]), aI:new Map([['', 0]])}; }
function rawTextIdx(c, which, txt){
  txt = txt == null ? '' : String(txt);
  const I = which === 'q' ? c.qI : c.aI, T = which === 'q' ? c.qT : c.aT;
  let i = I.get(txt); if(i == null){ i = T.length; T.push(txt); I.set(txt, i); }
  return i;
}
function rawPush(c, s, d, t, v, fl, q, a){
  c.s.push(s); c.day.push(rawDayOf(d)); c.min.push(rawMinOf(t)); c.v.push(Math.round(v * 100)); c.fl.push(fl);
  c.q.push(rawTextIdx(c, 'q', q)); c.a.push(rawTextIdx(c, 'a', a));
}
// collector (or any {s, day, min, v, fl, q, a} arrays) -> store grouped by well, sorted by date/time within each well
function rawPack(c, nSites){
  const n = c.s.length, off = new Int32Array(nSites + 1);
  for(let i = 0; i < n; i++) off[c.s[i] + 1]++;
  for(let s = 0; s < nSites; s++) off[s + 1] += off[s];
  const pos = off.slice(0, nSites), perm = new Int32Array(n);
  for(let i = 0; i < n; i++) perm[pos[c.s[i]]++] = i;
  for(let s = 0; s < nSites; s++){
    const a = off[s], b = off[s + 1]; if(b - a < 2) continue;
    const seg = Array.from(perm.subarray(a, b)).sort((x, y) => (c.day[x] - c.day[y]) || (c.min[x] - c.min[y]) || (c.v[x] - c.v[y]));
    perm.set(seg, a);
  }
  const st = {n, off, day:new Int32Array(n), min:new Int16Array(n), v:new Int32Array(n), fl:new Uint8Array(n), q:new Uint16Array(n), a:new Uint8Array(n), qT:c.qT.slice(), aT:c.aT.slice(), maxDay:-1};
  for(let k = 0; k < n; k++){
    const i = perm[k];
    st.day[k] = c.day[i]; st.min[k] = c.min[i]; st.v[k] = c.v[i]; st.fl[k] = c.fl[i]; st.q[k] = c.q[i]; st.a[k] = c.a[i];
    if(c.day[i] > st.maxDay) st.maxDay = c.day[i];
  }
  return st;
}
// saved copy: arrays are grouped by well key (source + id), so the copy survives wells being added or reordered
function rawToCache(st, keyOfSite){
  const nS = st.off.length - 1, keys = [], counts = [];
  for(let s = 0; s < nS; s++){ const c = st.off[s + 1] - st.off[s]; if(c){ keys.push(keyOfSite(s)); counts.push(c); } }
  return {ver:CACHE_VER, kind:'readings-packed', keys, counts:Int32Array.from(counts), day:st.day, min:st.min, v:st.v, fl:st.fl, q:st.q, a:st.a, qT:st.qT, aT:st.aT, n:st.n, maxDate:st.maxDay >= 0 ? rawDateOf(st.maxDay) : '', savedAt:Date.now()};
}
function rawFromCache(c, siteOfKey, nSites){
  const segOf = new Map(); let p = 0;
  c.keys.forEach((k, i) => { const s = siteOfKey(k), len = c.counts[i]; if(s != null) segOf.set(s, [p, len]); p += len; });   // readings of wells the API no longer lists are dropped
  const off = new Int32Array(nSites + 1);
  for(let s = 0; s < nSites; s++){ const g = segOf.get(s); off[s + 1] = off[s] + (g ? g[1] : 0); }
  const n = off[nSites];
  const st = {n, off, day:new Int32Array(n), min:new Int16Array(n), v:new Int32Array(n), fl:new Uint8Array(n), q:new Uint16Array(n), a:new Uint8Array(n), qT:c.qT.slice(), aT:c.aT.slice(), maxDay:-1};
  segOf.forEach(([from, len], s) => {
    const to = off[s];
    st.day.set(c.day.subarray(from, from + len), to); st.min.set(c.min.subarray(from, from + len), to); st.v.set(c.v.subarray(from, from + len), to);
    st.fl.set(c.fl.subarray(from, from + len), to); st.q.set(c.q.subarray(from, from + len), to); st.a.set(c.a.subarray(from, from + len), to);
  });
  for(let i = 0; i < n; i++) if(st.day[i] > st.maxDay) st.maxDay = st.day[i];
  return st;
}
// keep the saved readings before cutDay and add the newly downloaded ones (which start at cutDay)
function rawMergeAfter(st, c, cutDay, nSites){
  const m = {s:[], day:[], min:[], v:[], fl:[], q:[], a:[], qT:st.qT.slice(), aT:st.aT.slice(), qI:new Map(st.qT.map((t, i) => [t, i])), aI:new Map(st.aT.map((t, i) => [t, i]))};
  for(let s = 0; s < nSites; s++) for(let i = st.off[s]; i < st.off[s + 1]; i++){
    if(st.day[i] >= cutDay) continue;
    m.s.push(s); m.day.push(st.day[i]); m.min.push(st.min[i]); m.v.push(st.v[i]); m.fl.push(st.fl[i]); m.q.push(st.q[i]); m.a.push(st.a[i]);
  }
  for(let i = 0; i < c.s.length; i++){
    if(c.day[i] < cutDay) continue;
    m.s.push(c.s[i]); m.day.push(c.day[i]); m.min.push(c.min[i]); m.v.push(c.v[i]); m.fl.push(c.fl[i]);
    m.q.push(rawTextIdx(m, 'q', c.qT[c.q[i]])); m.a.push(rawTextIdx(m, 'a', c.aT[c.a[i]]));
  }
  return rawPack(m, nSites);
}
// monthly / yearly aggregates (same layout as aggAdd builds) from the store
function aggFromRaw(st){
  const agg = newAgg(), nS = st.off.length - 1;
  const ymCache = new Map();
  const ymOf = day => { let r = ymCache.get(day); if(r == null){ const d = new Date(RAW_EPOCH + day * 864e5); r = d.getUTCFullYear() * 12 + d.getUTCMonth(); ymCache.set(day, r); } return r; };
  for(let s = 0; s < nS; s++) for(let i = st.off[s]; i < st.off[s + 1]; i++){
    const v = st.v[i] / 100, fl = st.fl[i], ym = ymOf(st.day[i]), y = Math.floor(ym / 12);
    const mk = (s * 100000 + ym) * 64 + fl;
    let a = agg.mon.get(mk); if(!a){ a = [0, 0]; agg.mon.set(mk, a); } a[0] += v; a[1]++;
    const yk = (s * 10000 + y) * 64 + fl;
    let b = agg.yr.get(yk); if(!b){ b = [0, 0, v, v]; agg.yr.set(yk, b); } b[0] += v; b[1]++; if(v < b[2]) b[2] = v; if(v > b[3]) b[3] = v;
  }
  agg.maxDate = st.maxDay >= 0 ? rawDateOf(st.maxDay) : '';
  return agg;
}

/* ---- pre-built readings snapshot ---------------------------------------------------------
   readings-snapshot.bin (next to index.html) is the packed reading store, byte-shuffled and gzipped, built by
   tools/build-snapshot.mjs from a full API download. A browser with no saved copy loads it (a few MB) and then
   asks the API only for the newest months, the same as a returning visit. */
const SNAP_FILE = 'readings-snapshot.bin';
function snapShuffle(ta){
  const b = ta.BYTES_PER_ELEMENT, n = ta.length, src = new Uint8Array(ta.buffer, ta.byteOffset, n * b), out = new Uint8Array(n * b);
  for(let k = 0; k < b; k++){ const o = k * n; for(let i = 0; i < n; i++) out[o + i] = src[i * b + k]; }
  return out;
}
function snapUnshuffle(bytes, Ctor, n){
  const b = Ctor.BYTES_PER_ELEMENT, out = new Ctor(n), dst = new Uint8Array(out.buffer);
  for(let k = 0; k < b; k++){ const o = k * n; for(let i = 0; i < n; i++) dst[i * b + k] = bytes[o + i]; }
  return out;
}
function snapPack(st, keyOfSite){
  const c = rawToCache(st, keyOfSite), n = c.n, nk = c.keys.length;
  // days as differences within each well (they are sorted), so the bytes repeat
  const dd = new Int32Array(n); let p = 0;
  for(let k = 0; k < nk; k++){ const len = c.counts[k]; let prev = 0; for(let i = 0; i < len; i++, p++){ dd[p] = c.day[p] - prev; prev = c.day[p]; } }
  const head = new TextEncoder().encode(JSON.stringify({ver:CACHE_VER, builtAt:Date.now(), n, keys:c.keys, qT:c.qT, aT:c.aT, maxDate:c.maxDate}));
  const parts = [snapShuffle(c.counts), snapShuffle(dd), snapShuffle(c.min), snapShuffle(c.v), c.fl, snapShuffle(c.q), c.a];
  let tot = 12 + head.length; parts.forEach(a => tot += a.length);
  const out = new Uint8Array(tot), dv = new DataView(out.buffer);
  out.set([78, 77, 72, 49], 0); dv.setUint32(4, head.length, true); dv.setUint32(8, 0, true); out.set(head, 12);
  let o = 12 + head.length; parts.forEach(a => { out.set(a, o); o += a.length; });
  return window.pako.deflate(out, {level: 9});
}
function snapUnpack(gz){
  const raw = window.pako.inflate(gz), dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if(raw[0] !== 78 || raw[1] !== 77 || raw[2] !== 72 || raw[3] !== 49) throw new Error('not a readings snapshot');
  const hl = dv.getUint32(4, true), h = JSON.parse(new TextDecoder().decode(raw.subarray(12, 12 + hl)));
  const n = h.n, nk = h.keys.length; let o = 12 + hl;
  const take = len => { const s = raw.subarray(o, o + len); o += len; return s; };
  const counts = snapUnshuffle(take(nk * 4), Int32Array, nk), dd = snapUnshuffle(take(n * 4), Int32Array, n);
  const min = snapUnshuffle(take(n * 2), Int16Array, n), v = snapUnshuffle(take(n * 4), Int32Array, n);
  const fl = take(n).slice(), q = snapUnshuffle(take(n * 2), Uint16Array, n), a = take(n).slice();
  const day = new Int32Array(n); let p = 0;
  for(let k = 0; k < nk; k++){ const len = counts[k]; let prev = 0; for(let i = 0; i < len; i++, p++){ prev += dd[p]; day[p] = prev; } }
  return {ver:h.ver, kind:'readings-packed', keys:h.keys, counts, day, min, v, fl, q, a, qT:h.qT, aT:h.aT, n, maxDate:h.maxDate, savedAt:h.builtAt, fromSnapshot:true};
}
async function snapFetch(ui){
  if(/[?&]nosnapshot\b/.test(location.search)) return null;
  try{
    ui.set('Loading the saved readings snapshot…', 0.08, 'One download of a few MB instead of the whole API');
    const r = await fetch(SNAP_FILE, {cache:'no-cache'}); if(!r.ok) return null;
    const c = snapUnpack(new Uint8Array(await r.arrayBuffer()));
    if(c.ver !== CACHE_VER || !c.n || Date.now() - c.savedAt > 180 * 864e5) return null;   // another format, empty, or too old to be worth it
    return c;
  }catch(e){ console.warn('snapshot not used', e); return null; }
}

async function dataBootstrap(){
  const ui = bootUi(); const t0 = performance.now(); const info = {offline:false, mode:'', rows:0};
  ui.set('Loading wells from the API…', 0.02, 'NM Unified Water Data API');
  // ---- 1. wells
  let rows = null, cachedSites = null;
  try{ rows = await fetchSiteRows(ui); if(rows.length) idbSet('sites', {ver:CACHE_VER, rows, savedAt:Date.now()}); }
  catch(e){ cachedSites = await idbGet('sites'); if(cachedSites && cachedSites.ver === CACHE_VER){ rows = cachedSites.rows; info.offline = true; } else throw new Error('The NM Unified Water Data API could not be reached (' + (e.message || e) + ') and there is no saved copy in this browser yet.'); }
  if(!rows.length){
    const c = await idbGet('sites');
    if(c && c.ver === CACHE_VER && c.rows && c.rows.length){ rows = c.rows; info.offline = true; }
    else { const d = apiState.siteDiag || {}; throw new Error('The API returned no usable wells (' + (d.features||0) + ' features received, ' + (d.total==null?'?':d.total) + ' reported). The service may be starting up; try again in a minute.'); }
  }
  { const OW = await OCO_P;
    if(OW){ const have = new Set(rows.filter(r => r[0] === 'NMBGMR').map(r => r[1]));
      OW.forEach(w => { oco.ids.set(w.name, w.id); if(!have.has(w.name) && w.lon != null && w.lat != null){ rows.push(['NMBGMR', w.name, w.name, w.lon, w.lat, w.elevFt, w.depth, null, '', null, null]); oco.newWells++; } });
      oco.wells = OW.length; } }
  const keyOf = r => r[0] + '\u0001' + r[1];
  const provIdx = new Map(); rows.forEach((r,i)=>provIdx.set(keyOf(r), i));
  const bareId = new Map(); rows.forEach((r,i)=>bareId.set(r[1], bareId.has(r[1]) ? -1 : i));
  const siteOf = (source, id) => { id = String(id); const i = provIdx.get(source + '\u0001' + id); if(i != null) return i; const j = bareId.get(id); return (j != null && j >= 0) ? j : null; };
  const siteOfKey = k => provIdx.has(k) ? provIdx.get(k) : null;
  // ---- 2. readings: cached aggregates + newest months, or everything
  let agg = null, store = null, cache = await idbGet('readingsPacked');
  const keyOfSite = s => keyOf(rows[s]);
  // a saved copy older than 30 days is replaced by a full download, so late-posted or revised readings are picked up
  if(cache && cache.savedAt && Date.now() - cache.savedAt > 30*864e5) cache = null;
  if(!cache && !info.offline) cache = await snapFetch(ui);   // first visit: the pre-built snapshot, then only the newest months from the API
  if(cache && cache.savedAt) info.cacheDays = Math.floor((Date.now() - cache.savedAt) / 864e5);
  if(cache && cache.ver === CACHE_VER && cache.n){
    const fromSnap = !!cache.fromSnapshot; info.snapshot = fromSnap;
    store = rawFromCache(cache, siteOfKey, rows.length); cache = null; info.mode = fromSnap ? 'snapshot' : 'cache';
    if(!info.offline){
      try{
        // re-fetch from the start of the month before the newest reading, so late-posted readings are picked up too
        const md = rawDateOf(store.maxDay); let cy = +md.slice(0,4), cm = +md.slice(5,7) - 1; if(cm < 1){ cm = 12; cy--; }
        const cutDate = cy + '-' + String(cm).padStart(2,'0') + '-01';
        const delta = newAgg(); delta.raw = rawCollector();
        ui.set('Checking the API for newer readings…', 0.2, 'Saved copy through ' + md);
        const dr = await fetchReadingsInto(delta, siteOf, {datetime: cutDate + 'T00:00:00Z/..'}, ui, 'Checking the API for newer readings…', 0.2, 0.9);
        // the saved copy has readings in this window, so 0 new rows means the API failed: keep the saved copy
        if(!dr.rows) throw new Error('the API returned no readings for the latest months');
        store = rawMergeAfter(store, delta.raw, rawDayOf(cutDate), rows.length); info.mode = info.snapshot ? 'snapshot+delta' : 'cache+delta';
        idbSet('readingsPacked', rawToCache(store, keyOfSite));
      }catch(e){ console.warn('delta failed, using saved copy', e); info.offline = true; }
    } else info.offline = true;
  } else {
    if(info.offline) throw new Error('The API could not be reached and no readings are saved in this browser yet.');
    const col = newAgg(); col.raw = rawCollector(); info.mode = 'full';
    ui.set('Downloading all water-level readings (first visit only)…', 0.1, 'This is saved in your browser, so later visits take seconds.');
    const r = await fetchReadingsInto(col, siteOf, {}, ui, 'Downloading all water-level readings (first visit only)…', 0.1, 0.92);
    info.rows = r.rows; info.kept = col.raw.s.length;
    store = rawPack(col.raw, rows.length);
    ui.set('Saving a copy in this browser…', 0.93);
    idbSet('readingsPacked', rawToCache(store, keyOfSite));
    idbSet('readings', null);   // the older averages-only copy is no longer used
  }
  info.readings = store.n;
  agg = aggFromRaw(store);
  agg.seen = null;
  ui.set('Preparing wells…', 0.95);
  // ---- 3. every well the API returned is kept (wells without readings too); build the rows the app uses
  const finalOf = new Map(); const keptRows = [];
  rows.forEach((r, i)=>{ finalOf.set(i, keptRows.length); keptRows.push(r); });
  const sources = SOURCE_ORDER.slice(); keptRows.forEach(r=>{ if(r[0] && !sources.includes(r[0])) sources.push(r[0]); });
  const enrichIdx = new Map(); ENRICH.id.forEach((id, i)=>enrichIdx.set(ENRICH.src[i] + '\u0001' + id, i));
  const aquifers = ENRICH.aquifers.slice(), formations = ENRICH.formations.slice();
  const nameIdx = (list, name) => { if(!name) return -1; let i = list.indexOf(name); if(i < 0){ list.push(name); i = list.length - 1; } return i; };
  const extPieces = AQUIFER_EXTENT_POLYGONS.map(polys=>polys.map(rings=>({rings, bb:ringBBox2(rings[0])})));
  const saPieces = STUDY_AREAS.map(sa=>sa.polys.map(rings=>({rings, bb:ringBBox2(rings[0])})));
  const inPieces = (lng, lat, pcs)=> pcs.some(p=> lng>=p.bb[0] && lng<=p.bb[2] && lat>=p.bb[1] && lat<=p.bb[3] && pointInRing(lng, lat, p.rings[0]) && !p.rings.slice(1).some(h=>pointInRing(lng, lat, h)));
  const sites = keptRows.map(r=>{
    const e = enrichIdx.get(r[0] + '\u0001' + r[1]);
    let aq, fm, ext, sa;
    if(e != null){ aq = ENRICH.aq[e]; fm = ENRICH.fm[e]; ext = ENRICH.ext[e]; sa = ENRICH.sa[e]; }
    else {
      aq = -1; fm = -1; ext = []; sa = [];
      extPieces.forEach((pcs, i)=>{ if(inPieces(r[3], r[4], pcs)) ext.push(i); });
      saPieces.forEach((pcs, i)=>{ if(inPieces(r[3], r[4], pcs)) sa.push(i); });
    }
    if(r[10]) aq = nameIdx(aquifers, r[10]);          // attributes the API may serve in future override the built-in ones
    if(r[9]) fm = nameIdx(formations, r[9]);
    return [r[1], r[3], r[4], sources.indexOf(r[0]), r[6], 0, null, null, null, null, null, r[7], aq, fm, r[5], ext, sa];
  });
  // month / year rows, sorted by well (all readings; the app re-collapses with quality filters later)
  const first = collapseAgg(agg, finalOf, ()=>true);
  const siteMonth = first.siteMonth, siteYear = first.siteYear;
  finalizeSiteRecs(sites, siteYear);
  const flagCounts = {total:0, static:0, disturbed:0, approved:0, provisional:0, manual:0, logger:0};
  agg.mon.forEach((a, mk)=>{ const fl = mk % 64, n = a[1]; flagCounts.total += n; if(fl&1) flagCounts.static += n; if(fl&2) flagCounts.disturbed += n; if(fl&4) flagCounts.approved += n; if(fl&8) flagCounts.provisional += n; if(fl&16) flagCounts.manual += n; if(fl&32) flagCounts.logger += n; });
  info.flagCounts = flagCounts;
  info.seconds = Math.round((performance.now() - t0)/1000); info.maxDate = agg.maxDate; info.nWells = sites.length;
  // Add readings from a user file to the aggregates (wells already loaded from the API only).
  // A reading is skipped as a probable duplicate when that well's month already holds exactly one reading with the same value.
  function addReadings(list){
    const res = {added:0, dup:0, noWell:0, bad:0, wells:new Set()};
    agg.seen = new Set();
    for(const r of list){
      const v = Number(r.dtw), d = String(r.date || '').slice(0, 10);
      const dt = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T00:00:00Z') : null;
      if(!isFinite(v) || !dt || isNaN(dt) || dt.toISOString().slice(0, 10) !== d || d > todayStr || d < '1800'){ res.bad++; continue; }
      let i = null;
      for(const k of r.keys){ const j = siteOf(k[0], k[1]); if(j != null && finalOf.has(j)){ i = j; break; } }
      if(i == null){ res.noWell++; continue; }
      const y = +d.slice(0,4), m = +d.slice(5,7), base = (i*100000 + y*12 + (m-1))*64;
      let dup = false;
      for(let fl=0; fl<64 && !dup; fl++){ const a = agg.mon.get(base + fl); if(a && a[1] === 1 && Math.abs(a[0] - v) <= 0.05) dup = true; }
      if(dup){ res.dup++; continue; }
      aggAdd(agg, i, d, 'user', v, 16);   // flagged as a manual measurement
      { const f = finalOf.get(i), M = (window.__rawAdded = window.__rawAdded || new Map()); if(!M.has(f)) M.set(f, []); M.get(f).push({d, time:'', v, fl:16, kind: r.ofr ? 'report' : 'file', ofr: r.ofr || ''}); }
      res.added++; res.wells.add(finalOf.get(i));
    }
    agg.seen = null;
    return res;
  }
  // monthly values from another database: added only for months the well has no reading in yet
  function addMonths(list){
    // Ocotillo gives depth below the measuring point; the unified API gives depth below land surface.
    // Per well, the offset is the median of (Ocotillo - unified) over months both have (at least 3);
    // it is subtracted from that well's added months. Wells with fewer shared months are added unadjusted and counted.
    const res = {added:0, had:0, noWell:0, wells:new Set(), adjWells:0, unadjWells:0, offsets:[]};
    agg.seen = new Set();
    const byWell = new Map();
    for(const r of list){
      const i = siteOf(r.source, r.id); if(i == null || !finalOf.has(i)){ res.noWell++; continue; }
      let L = byWell.get(i); if(!L){ L = []; byWell.set(i, L); } L.push(r);
    }
    for(const [i, L] of byWell){
      const diffs = [], fresh = [];
      for(const r of L){
        const base = (i*100000 + r.y*12 + (r.m-1))*64; let s = 0, n = 0;
        for(let fl=0; fl<64; fl++){ const a = agg.mon.get(base + fl); if(a){ s += a[0]; n += a[1]; } }
        if(n){ diffs.push(r.v - s/n); res.had++; } else fresh.push(r);
      }
      let off = 0;
      if(diffs.length >= 3){ diffs.sort((a,b)=>a-b); const h = diffs.length >> 1; off = diffs.length % 2 ? diffs[h] : (diffs[h-1] + diffs[h])/2; res.offsets.push(off); if(fresh.length) res.adjWells++; }
      else if(fresh.length) res.unadjWells++;
      for(const r of fresh){
        aggAdd(agg, i, r.y + '-' + String(r.m).padStart(2, '0') + '-15', 'oco', Math.round((r.v - off)*100)/100, 0);
        { const f = finalOf.get(i), M = (window.__rawAdded = window.__rawAdded || new Map()); if(!M.has(f)) M.set(f, []); M.get(f).push({d: r.y + '-' + String(r.m).padStart(2, '0') + '-15', time:'', v: Math.round((r.v - off)*100)/100, fl:0, kind:'oco'}); }
        res.added++; res.wells.add(finalOf.get(i));
      }
    }
    agg.seen = null; return res;
  }
  return {ui, info, sitesData:{sources, aquifers, formations, studyAreaNames:ENRICH.studyAreaNames, sites}, siteYear, siteMonth, collapse: (pass, sub) => collapseAgg(agg, finalOf, pass, sub), finalize: finalizeSiteRecs, addReadings, addMonths, raw: store, exportSnapshot: () => snapPack(store, keyOfSite)};
}
function ringBBox2(r){ let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity; for(const p of r){ if(p[0]<a)a=p[0]; if(p[0]>c)c=p[0]; if(p[1]<b)b=p[1]; if(p[1]>d)d=p[1]; } return [a,b,c,d]; }


// ---- load wells + readings from the API (cached in this browser after the first visit)
// ---- NMBGMR Ocotillo (OGC API) ----
const OCO_ROOT = 'https://ocotillo-api.newmexicowaterdata.org';
const oco = {key:'', header:'bearer', ids:new Map(), newWells:0, wells:0, status:'', fetched:new Map(), mem:new Map(), lastKey:null, busy:false};
try{ localStorage.removeItem('ocoKey'); oco.key = sessionStorage.getItem('ocoKey') || ''; oco.header = localStorage.getItem('ocoKeyHeader') || 'bearer'; }catch(e){}
function ocoOn(){ try{ return localStorage.getItem('ocoOff') !== '1'; }catch(e){ return true; } }
function ocoBase(){ return OCO_ROOT + (oco.key ? '/ogcapi-internal' : '/ogcapi'); }
function ocoHeaders(){ if(!oco.key) return {}; return {'Authorization': 'Bearer ' + oco.key}; }   // Ocotillo reads keys as a Bearer token
async function ocoGet(path, ms){
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms || 60000);
  try{ const r = await fetch(ocoBase() + path, {headers: ocoHeaders(), signal: ac.signal}); if(r.status === 204) return null; if(!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally{ clearTimeout(t); }
}
async function ocoWells(){
  if(!ocoOn()) return null;
  const [loc, ww] = await Promise.all([ocoGet('/collections/waterlevels/locations?f=json', 40000), ocoGet('/collections/water_wells/items?f=json&limit=50000&properties=name,elevation,well_depth', 40000).catch(() => null)]);
  const meta = new Map(); ((ww && ww.features) || []).forEach(f => meta.set(f.properties.name, f.properties));
  return ((loc && loc.features) || []).map(f => { const m = meta.get(f.properties.name) || {}, c = (f.geometry && f.geometry.coordinates) || [];
    return {id: f.id, name: String(f.properties.name), lon: c[0], lat: c[1], elevFt: m.elevation != null ? m.elevation / 0.3048 : null, depth: m.well_depth != null ? Number(m.well_depth) : null}; });
}
const OCO_P = ocoWells().catch(e => { oco.status = 'Ocotillo could not be reached (' + (e.name === 'AbortError' ? 'timed out' : e.message) + '); only the unified API is used.'; return null; });
const BOOT = await dataBootstrap();
const SITES_DATA = BOOT.sitesData;           // {sources, aquifers, formations, studyAreaNames, sites:[[id,x,y,srcIdx,depth,nrec,firstYr,lastYr,min,max,mean,usgsId,aqIdx,fmIdx,elev,aqExtIdx[],studyAreaIdx[]], ...]}
let SITE_YEAR = BOOT.siteYear;             // [[siteIdx, year, avg, n, min, max], ...] sorted by siteIdx,year
let SITE_MONTH = BOOT.siteMonth;           // [[siteIdx, year, month, avg, n], ...] sorted by siteIdx,year,month
const SOURCES = SITES_DATA.sources;
const AQUIFERS = SITES_DATA.aquifers || [];
const FORMATIONS = SITES_DATA.formations || [];
const AQUIFER_EXTENT_NAMES = AQUIFEREXT_DATA.names || [];
const STUDY_AREA_NAMES = SITES_DATA.studyAreaNames || [];
const SITES = SITES_DATA.sites;             // array indexed by siteIdx
const NSITES = SITES.length;
// Coverage stats shown in hint text — computed from the loaded data so they can't go stale on a data refresh.
const COVERAGE = (()=>{
  let ext=0, fm=0, el=0, wd=0;
  for(const r of SITES){ if(r[15].length) ext++; if(r[13]>=0) fm++; if(r[14]!=null) el++; if(r[4]==null) wd++; }
  const pct = n => Math.round(100*n/SITES.length);
  return {extMatched:pct(ext), extOutside:100-pct(ext), formation:pct(fm), elevation:pct(el), depthMissing:pct(wd)};
})();

const SOURCE_COLORS = ['#c1652f','#2f7fc1','#7a9c3f','#a26bc2','#0f6e63','#c9a227','#6b7fd4','#c25d8f','#5a8f8c'];
const CURRENT_YEAR = new Date().getFullYear();
const AQUIFER_COLORS = ['#0f6e63','#c1652f','#2f7fc1','#c9a227','#7a9c3f','#a26bc2','#c25d8f','#5a8f8c'];

// Per-site reference elevation (ft), NaN if unknown. Water-surface elevation = elevation - depth-to-water.
const siteElevation = new Float32Array(NSITES);
for(let s=0; s<NSITES; s++){
  const e = SITES[s][14];
  siteElevation[s] = (e==null) ? NaN : e;
}
function hasElevation(s){ return !isNaN(siteElevation[s]); }
const escHtml = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// ---- precomputed kriged averages (kriged/ next to the page, or the published GitHub Pages copy) ----
const KRIG_FALLBACK = 'https://steeltapejockey.github.io/WeaverAPI-Hydrograph-Explorer/boundaries/';   // boundary files (HUC-10, OSE basins)
let krigBaseP = null; const krigFiles = new Map();
function krigBase(){
  if(!krigBaseP) krigBaseP = (async()=>{
    for(const b of ['boundaries/', KRIG_FALLBACK]){
      try{ const r = await fetch(b + 'index.json'); if(r.ok){ const j = await r.json(); if(j && j.units){ window._krigIndex = j; return b; } } }catch(e){}
    }
    return null;
  })();
  return krigBaseP;
}
function krigSeasonChanged(){ if(h12State && h12State.on) h12Redraw(); }
function krigSeason(){
  const ms = state.season.monthStart, me = state.season.monthEnd;
  if(ms === 1 && me === 12) return 'all';
  const months = []; for(let m = ms; ; m = m % 12 + 1){ months.push(m); if(m === me || months.length > 12) break; }
  return months.every(m => [11,12,1,2].includes(m)) ? 'winter' : 'all';
}
let krigSeq = 0;
async function krigUpdate(){
  const my = ++krigSeq; try{ krigSeasonChanged(); }catch(e){}   // only the latest request may update the overlay
  const st = document.getElementById('krig-status');
  const sel = state.areaSelection;
  const huc = sel && (sel.type === 'huc' || sel.type === 'huc10' || sel.type === 'ose' || sel.type === 'huc12') ? sel.huc : null;
  const isH12 = sel && sel.type === 'huc12';
  const isOse = sel && sel.type === 'ose';
  if(!state.krigShow || !huc){ if(state.krig){ state.krig = null; renderChart(); } if(st) st.textContent = state.krigShow ? 'Pick an OSE basin, HUC‑8, HUC‑10 or HUC‑12 (click it on the HUC‑12 map) to see its kriged average.' : ''; return; }
  const season = krigSeason(), key = season + '/' + huc;
  if(state.krig && state.krig.key === key) return;
  const base = await krigBase();
  if(my !== krigSeq) return;
  if(!base){ if(st) st.textContent = location.protocol === 'file:' ? 'This page was opened from your computer, and the browser does not let it read the kriged folder beside it. It then reads the copy on the GitHub site, which was not found there either. Upload the kriged folder to GitHub and open the page from the GitHub site.' : 'Kriged averages were not found next to this page (folder kriged/) or on the GitHub site.'; return; }
  const h8 = huc.slice(0, 8), fk = season + '/' + h8;
  try{
    const fname = (isOse ? 'ose_' : isH12 ? 'h12_' : '') + season + '.json';
    if(!krigFiles.has(fname)){ const r = await fetch(base + fname); krigFiles.set(fname, r.ok ? await r.json() : null); }
    if(my !== krigSeq) return;
    const ALL = krigFiles.get(fname);
    let F, U;
    if(isH12){ const M8 = ALL && ALL.huc8 ? ALL.huc8[h8] : null, u = ALL && ALL.units ? ALL.units[huc] : null;
      F = M8 ? {ok: M8.ok, note: M8.note, years: ALL.years, base_year: M8.base_year, n_wells: M8.n_wells, model: {loo_corr: M8.loo_corr, calibration_factor: M8.calibration_factor, withheld_wells_tested: M8.withheld_wells_tested, possible_bias: M8.possible_bias, withheld_wells_mean_error_ft: M8.withheld_wells_mean_error_ft}} : null;
      U = u ? {name: u.n, chg_ft: u.c, se_chg_ft: u.s, cover_km2: u.cov, area_km2: u.a, unstable: u.z > 1.2, note: u.z > 1.2 ? 'year-to-year jumps larger than the model expects; ranges widened ×' + u.z : ''} : (F ? {note: 'no wells within 5 km'} : null);
    } else { F = isOse ? (ALL && ALL.basin ? ALL.basin[huc] : null) : (ALL && ALL.huc8 ? ALL.huc8[h8] : null); U = F && F.units ? F.units[huc] : null; }
    if(!F || !F.ok || !U || !U.chg_ft){
      state.krig = null;
      if(st) st.textContent = `No kriged average for ${isOse ? sel.label.replace('OSE basin: ', '') : huc} (${season === 'winter' ? 'winter' : 'all months'}): ` + ((U && U.note) || (F && F.note) || 'not computed') + '.';
      renderChart(); return;
    }
    const y0 = F.years[0];
    const rows = U.chg_ft.map((c, i) => ({year: y0 + i, chg: c, se: U.se_chg_ft[i]}));
    const M = F.model || {};
    state.krig = {key, name: 'Basin-average water level (kriged, ' + (season === 'winter' ? 'Nov–Feb' : 'all months') + ')', rows, base: F.base_year, unit: U.name, cover: U.cover_km2, area: U.area_km2, model: M};
    const seasonNote = (season === 'all' && !(state.season.monthStart === 1 && state.season.monthEnd === 12)) ? ' There is no kriged set for this season, so the all-months set is shown.' : '';
    const tested = (M.withheld_wells_tested || 0) >= 20;
    const q = (M.possible_bias || M.loo_corr < 0.8 || M.calibration_factor > 3) ? 'poor'
      : (M.loo_corr >= 0.9 && M.calibration_factor <= 2 && !U.unstable && tested) ? 'good' : 'fair';
    const calNote = tested ? ` Error ranges ×${M.calibration_factor}: the larger of a leave-one-out check and a test that withholds ${M.withheld_wells_tested} whole wells and checks that 95% of their measured changes fall inside the range.`
      : ' Error ranges could not be checked by withholding wells (too few long records), so treat them as a minimum.';
    const biasNote = M.possible_bias ? ` Caution: for withheld wells the measured changes differed from the kriged estimates by ${M.withheld_wells_mean_error_ft > 0 ? '+' : ''}${M.withheld_wells_mean_error_ft} ft on average, so this line may be biased.` : '';
    state.krig.quality = q;
    if(st) st.innerHTML = `<b>Model quality: ${q}.</b> ` + escHtml(`${U.name}${isOse ? ' (OSE basin)' : ' (' + huc + ')'}: kriged ${season === 'winter' ? 'Nov–Feb' : 'all-months'} water-level change, ${y0}–${y0 + rows.length - 1}, relative to ${F.base_year} (${isOse ? 'the basin' : 'the HUC‑8'}'s best-measured year). Area covered: ${U.cover_km2.toLocaleString()} of ${U.area_km2.toLocaleString()} km² (within 5 km of a well). Model: ${F.n_wells.toLocaleString()} wells, cross-validation r = ${M.loo_corr}.` + calNote + biasNote + (U.unstable ? ` Caution: ${U.note}.` : '') + seasonNote) + (otFeet(state.otp.method) ? ' Shown on the chart.' : ' <button class="btn" id="krig-to-chain" style="padding:2px 8px; margin-left:4px;">Show it: switch to matched wells (ft)</button>');
    const kb = document.getElementById('krig-to-chain'); if(kb) kb.onclick = ()=>{ state.otp.method = 'fe'; syncOtUi(); renderChart(); krigUpdate(); };
    renderChart();
  }catch(e){ if(st) st.textContent = 'Could not load the kriged average: ' + (e.message || e); }
}
// ---- USGS 3DEP elevations (ImageServer getSamples at 10 m, feet), cached in this browser ----
const siteElevApi = Float32Array.from(siteElevation, v => (v > 0 ? v : NaN));   // site elevation from the API (0 or below = missing)
const siteDem = new Float32Array(NSITES).fill(NaN);
const DEM_URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples';
const demKey = s => { const r = SITES[s]; return (r[3]>=0 ? SOURCES[r[3]] : '') + ':' + r[0]; };
let demCacheLoaded = false;
async function demLoadCache(){
  if(demCacheLoaded) return; demCacheLoaded = true;
  try{ const c = await idbGet('dem3dep'); if(c && c.v){ for(let s=0; s<NSITES; s++){ const e = c.v[demKey(s)]; if(e != null) siteDem[s] = e; } } }catch(e){}
}
async function demSaveCache(){
  const v = {}; for(let s=0; s<NSITES; s++) if(!isNaN(siteDem[s])) v[demKey(s)] = Math.round(siteDem[s]*100)/100;
  try{ await idbSet('dem3dep', {v, savedAt: Date.now()}); }catch(e){}
}
async function demFetch(sites, onProgress){
  const todo = sites.filter(s => isNaN(siteDem[s]) && SITES[s][1] != null && SITES[s][2] != null);
  const batches = []; for(let i=0; i<todo.length; i+=150) batches.push(todo.slice(i, i+150));
  let done = 0, failed = 0;
  await apiPool(batches.map(b => async () => {
    const body = new URLSearchParams({geometry: JSON.stringify({points: b.map(s => [SITES[s][1], SITES[s][2]]), spatialReference:{wkid:4326}}),
      geometryType:'esriGeometryMultipoint', returnFirstValueOnly:'true', interpolation:'RSP_BilinearInterpolation',
      pixelSize: JSON.stringify({x:10, y:10, spatialReference:{wkid:3857}}), f:'json'});
    for(let t=0; t<3; t++){
      try{
        const r = await fetch(DEM_URL, {method:'POST', body});
        if(!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if(j.error) throw new Error(j.error.message || 'service error');
        (j.samples || []).forEach(sm => { const v = parseFloat(sm.value); if(isFinite(v) && v > -500) siteDem[b[sm.locationId]] = v / 0.3048; });
        break;
      }catch(e){ if(t === 2) failed += b.length; }
    }
    done += b.length; if(onProgress) onProgress(done, todo.length);
  }), 4);
  return {asked: todo.length, failed};
}
function demApply(){
  // the API site elevation always wins; 3DEP only fills wells that have none
  let n = 0;
  for(let s=0; s<NSITES; s++){
    if(!isNaN(siteElevApi[s])){ siteElevation[s] = siteElevApi[s]; continue; }
    const useD = state.useDem && !isNaN(siteDem[s]);
    siteElevation[s] = useD ? siteDem[s] : NaN;
    if(useD) n++;
  }
  otDataVer = (otDataVer || 0) + 1;   // invalidates the composite caches
  return n;
}
async function demEnsure(){
  if(!state.useDem || state.valueMode !== 'elevation' || !state.activeSet) return;
  if(!state.areaSelection && !state.clickSelectedSites.size && !state.statewideOk) return;
  await demLoadCache();
  const want = [...state.activeSet];
  const noElev = want.filter(s => isNaN(siteElevApi[s]));
  const missing = noElev.filter(s => isNaN(siteDem[s]));
  const st = document.getElementById('dem-status');
  let failed = 0;
  if(missing.length){
    if(st) st.textContent = `Getting 3DEP elevations for ${missing.length.toLocaleString()} well(s) without a site elevation…`;
    const res = await demFetch(missing, (d, t) => { if(st) st.textContent = `Getting 3DEP elevations… ${d.toLocaleString()} of ${t.toLocaleString()}`; });
    await demSaveCache(); failed = res.failed;
  }
  demApply();
  if(st){
    const filled = noElev.filter(s => !isNaN(siteDem[s])).length;
    st.textContent = !noElev.length ? `All ${want.length.toLocaleString()} selected wells have a site elevation; 3DEP is not needed.`
      : `${noElev.length.toLocaleString()} of ${want.length.toLocaleString()} selected wells have no site elevation; ${filled.toLocaleString()} filled from 3DEP` + (failed ? `, ${failed.toLocaleString()} could not be reached (left out).` : '.');
  }
  renderChart();
  demCheck(want);
}
// Check site elevations against 3DEP (warning only, values are not changed)
const ELEV_FLAG_FT = 300;
window._elevFlags = new Map();   // site idx -> {api, dem}
let demCheckSeq = 0;
async function demCheck(want){
  const seq = ++demCheckSeq;
  const box = document.getElementById('dem-flags'); if(!box) return;
  const withElev = want.filter(s => !isNaN(siteElevApi[s]));
  const todo = withElev.filter(s => isNaN(siteDem[s]));
  if(todo.length){
    box.style.display = 'block'; box.style.color = 'var(--ink-2)';
    box.textContent = `Checking site elevations against 3DEP… 0 of ${todo.length.toLocaleString()}`;
    await demFetch(todo, (d, t) => { if(seq === demCheckSeq) box.textContent = `Checking site elevations against 3DEP… ${d.toLocaleString()} of ${t.toLocaleString()}`; });
    await demSaveCache();
  }
  if(seq !== demCheckSeq) return;
  const flags = [];
  withElev.forEach(s => { const d = siteDem[s]; if(!isNaN(d) && Math.abs(siteElevApi[s] - d) > ELEV_FLAG_FT) flags.push(s); });
  window._elevFlags = new Map(flags.map(s => [s, {api: siteElevApi[s], dem: siteDem[s]}]));
  const checked = withElev.filter(s => !isNaN(siteDem[s])).length;
  box.style.color = '#b45309';
  if(!flags.length){ box.style.color = 'var(--ink-2)'; box.textContent = `Site elevations checked against 3DEP for ${checked.toLocaleString()} wells: none differ by more than ${ELEV_FLAG_FT} ft.`; box.style.display = 'block'; return; }
  flags.sort((a, b) => Math.abs(siteElevApi[b] - siteDem[b]) - Math.abs(siteElevApi[a] - siteDem[a]));
  const rows = flags.slice(0, 200).map(s => { const r = SITES[s]; const src = r[3] >= 0 ? SOURCES[r[3]] : '';
    const d = siteElevApi[s] - siteDem[s];
    return `<tr><td>${escHtml(src)}</td><td>${escHtml(String(r[0]))}</td><td style="text-align:right">${Math.round(siteElevApi[s]).toLocaleString()}</td><td style="text-align:right">${Math.round(siteDem[s]).toLocaleString()}</td><td style="text-align:right">${d > 0 ? '+' : ''}${Math.round(d).toLocaleString()}</td></tr>`; }).join('');
  box.innerHTML = `<b>Warning:</b> ${flags.length.toLocaleString()} of ${checked.toLocaleString()} selected wells have a site elevation more than ${ELEV_FLAG_FT} ft from the USGS 3DEP land surface. Their water-level elevations are probably wrong. They are still used (the site elevation always wins); remove them from the selection if they look off. The per-well statistics CSV marks them.
    <details style="margin-top:4px; color:var(--ink-2);"><summary style="cursor:pointer;">Show the wells</summary>
    <table style="font-size:11px; border-collapse:collapse; margin-top:4px; width:100%;"><tr><th style="text-align:left">Source</th><th style="text-align:left">Well</th><th style="text-align:right">Site ft</th><th style="text-align:right">3DEP ft</th><th style="text-align:right">Diff</th></tr>${rows}</table>${flags.length > 200 ? `<p>First 200 of ${flags.length.toLocaleString()} shown.</p>` : ''}</details>`;
  box.style.display = 'block';
}
// Wells that NMBGMR and another agency both measure: the NMBGMR row names its partner through its
// usgs_site_id field. Each entry = [other agency well id, NMBGMR well id, NMBGMR name if different, NMBGMR alternate id].
const NMBGMR_LINKS_RAW = [["USGS-350726106222701","BC-0008","","82"],["USGS-350726106222301","BC-0011","","175"],["USGS-350726106223101","BC-0012","","176"],["USGS-350728106222301","BC-0013","","189"],["USGS-350357106262801","BC-0023","","14"],["USGS-350405106263501","BC-0024","","15"],["USGS-350531106224301","BC-0034","","25"],["USGS-350901106214201","BC-0083","","68"],["USGS-350930106210701","BC-0098","","84"],["USGS-351011106220401","BC-0099","","85"],["USGS-350949106184501","BC-0156","","137"],["USGS-350949106211801","BC-0160","","141"],["USGS-351358106202701","BC-0166","","146"],["USGS-354640105554501","EB-010","",""],["USGS-354131105571801","EB-011","","SF-25"],["USGS-354105105580401","EB-012","",""],["USGS-353749105580801","EB-014","","SF-14"],["USGS-353608106015701","EB-016","","SF-44"],["USGS-353358106054301","EB-019","",""],["USGS-353257106042101","EB-102","","SF-4"],["USGS-354401105574201","EB-107","",""],["USGS-353458106024801","EB-115","","SF-6"],["USGS-353544106030801","EB-130","",""],["USGS-354458106060601","EB-158","",""],["USGS-354623106025701","EB-160","","SF-35"],["USGS-354937106063701","EB-161","",""],["USGS-354119106023801","EB-164","","SF-19"],["USGS-353818106020201","EB-171","","SF-11"],["USGS-353754106024201","EB-172","",""],["USGS-352846105593301","EB-201","",""],["USGS-352805106035201","EB-203","",""],["USGS-353022106030201","EB-204","",""],["USGS-353108106042001","EB-205","",""],["USGS-352754106030701","EB-206","",""],["USGS-354013105580601","EB-207","","SF-27"],["USGS-354555105564501","EB-208","",""],["USGS-352647106024801","EB-209","",""],["USGS-352629106021401","EB-210","","SF-2"],["USGS-352834106011801","EB-211","","SF-45"],["USGS-352833106011601","EB-212","",""],["USGS-353024106100201","EB-213","",""],["USGS-353148106052001","EB-214","",""],["USGS-352902106044101","EB-215","",""],["USGS-353307105581901","EB-216","",""],["USGS-353636106021001","EB-218","","SF-5"],["USGS-353725106064401","EB-219","",""],["USGS-353516106035801","EB-220","","SF-52"],["USGS-353449106032401","EB-221","",""],["USGS-353449106031901","EB-222","","SF-8"],["USGS-353520106061801","EB-223","",""],["USGS-353845105555901","EB-224","",""],["USGS-353838105564301","EB-225","",""],["USGS-353906105583801","EB-226","","SF-9"],["USGS-353822106043601","EB-227","",""],["USGS-353810106002701","EB-228","","SF-12"],["USGS-353735105581201","EB-229","",""],["USGS-353636105554901","EB-230","",""],["USGS-353656105583901","EB-231","","SF-15"],["USGS-353649105575601","EB-232","","SF-17"],["USGS-353638105581101","EB-233","","SF-16"],["USGS-353738105544001","EB-234","",""],["USGS-353654105534301","EB-235","","SF-7"],["USGS-354100105562701","EB-236","","SF-26"],["USGS-354011105593201","EB-237","",""],["USGS-353958106002401","EB-238","","SF-29"],["USGS-354009106012101","EB-239","","SF-30"],["USGS-353918106013701","EB-240","","SF-31"],["USGS-353933106004901","EB-241","",""],["USGS-353925106002101","EB-243","","SF-33"],["USGS-353945105574501","EB-244","",""],["USGS-353945105574502","EB-245","",""],["USGS-353945105574503","EB-246","",""],["USGS-353943105564801","EB-247","","SF-46"],["USGS-353910105560801","EB-248","",""],["USGS-354053105552601","EB-249","",""],["USGS-353936105552701","EB-250","",""],["USGS-354744106065201","EB-251","","SF-34"],["USGS-354830105575801","EB-252","",""],["USGS-354612105560401","EB-253","",""],["USGS-354823105544401","EB-255","",""],["USGS-354800105551601","EB-256","",""],["USGS-354832105540401","EB-257","",""],["USGS-354738105553901","EB-258","","SF-47"],["USGS-354736105552801","EB-259","",""],["USGS-355006106094801","EB-260","",""],["USGS-355006106094803","EB-261","",""],["USGS-355003106094301","EB-262","",""],["USGS-355003106094302","EB-263","",""],["USGS-355003106094303","EB-264","",""],["USGS-355002106093701","EB-265","",""],["USGS-355002106093702","EB-266","",""],["USGS-355002106093703","EB-267","",""],["USGS-355000106092801","EB-268","",""],["USGS-355000106092802","EB-269","",""],["USGS-355000106092803","EB-270","",""],["USGS-355120105595201","EB-271","",""],["USGS-354341105572101","EB-272","",""],["USGS-354344105573301","EB-273","","SF-21"],["USGS-354403105580401","EB-274","","SF-23"],["USGS-354103105574401","EB-276","",""],["USGS-354501106014001","EB-287","",""],["USGS-354321105573701","EB-295","",""],["USGS-354321105573703","EB-297","",""],["USGS-354731106072003","EB-300","",""],["USGS-353406106071101","EB-307","",""],["USGS-353824106040901","EB-336","",""],["USGS-353824106040902","EB-337","",""],["USGS-353824106040903","EB-338","",""],["USGS-353756106000601","EB-341","","SF-13"],["USGS-353526106001301","EB-354","","SF-50"],["USGS-353355106033101","EB-383","",""],["USGS-353353106034301","EB-384","",""],["USGS-353357106031801","EB-385","",""],["USGS-353825105594701","EB-413","",""],["USGS-353825105594702","EB-414","",""],["USGS-353825105594703","EB-415","",""],["USGS-354041105581301","EB-429","",""],["USGS-354117105574701","EB-434","",""],["USGS-354022105584701","EB-455","",""],["USGS-354034105574301","EB-476","",""],["USGS-354931106083301","EB-483","",""],["USGS-353525106020101","EB-582","",""],["USGS-354034106014701","EB-586","",""],["USGS-353348106025101","EB-605","",""],["USGS-353348106025102","EB-606","",""],["USGS-353348106025103","EB-607","",""],["USGS-354228106044901","EB-608","",""],["USGS-354228106044902","EB-609","",""],["USGS-354228106044903","EB-610","",""],["USGS-354117106054301","EB-643","",""],["USGS-353407106115001","EB-644","",""],["USGS-354153106060001","EB-646","",""],["USGS-355353106045501","EB-647","",""],["USGS-355337106063701","EB-648","",""],["USGS-355313106040701","EB-649","",""],["USGS-355120105593901","EB-650","",""],["USGS-355120105593902","EB-651","",""],["USGS-355411106074001","EB-652","",""],["USGS-352630106014801","EB-686","","SF-3"],["USGS-320758104041601","ED-0352","","25S28E15.23"],["USGS-330743107062101","JM-015","",""],["USGS-330307107050301","JM-029","",""],["USGS-330131107070801","JM-033","",""],["USGS-330507107103401","JM-036","",""],["USGS-325329107040001","JM-046","",""],["USGS-325225107051701","JM-047","",""],["USGS-325816107073801","JM-049","",""],["USGS-324508107004001","JM-058","",""],["USGS-320118105064501","NM-00037","",""],["USGS-320125105081701","NM-00039","",""],["USGS-322637104142301","NM-00253","","La Huerta #13"],["USGS-322712104074501","NM-00257","",""],["USGS-324620104255101","NM-00367","",""],["USGS-331524104245101","NM-00643","",""],["USGS-341532106550001","NM-00904","",""],["USGS-351929106252301","NM-01326","",""],["USGS-320058107452001","NM-01941","",""],["USGS-322504107422401","NM-02402","","M-144"],["USGS-324325104233001","NM-02560","","N-2016-081"],["USGS-365339105373801","NM-03672","",""],["USGS-365644105363501","NM-03679","",""],["USGS-320932103443801","NM-05017","","S2016-026_C-2569"],["USGS-322738103263701","NM-06964","","CR-2015-004"],["USGS-322830107384201","NM-07039","","M-156"],["USGS-323022104122501","NM-07225","","CR-2015-002"],["USGS-351331106194701","NM-23243","","01 Prado Vista"],["USGS-351344106195201","NM-23274","","39 Via Entrada"],["USGS-351347106181801","NM-23281","","15 Canada Vista"],["USGS-351349106184501","NM-23288","","13 Camino Real"],["USGS-351354106180501","NM-23292","","14 Canada Vista"],["USGS-351356106210201","NM-23298","","13CanonEscondido"],["USGS-351401106182001","NM-23307","","20 Canada Vista"],["USGS-351412106185001","NM-23319","","06 La Canada Pl"],["USGS-351412106195201","NM-23320","","09VistaDeSandia"],["USGS-351437106203301","NM-23353","","02 CalleChiquita"],["USGS-351448106190702","NM-23363","","03 Ojo Chimal"],["USGS-364643103583701","NM-26614","",""],["USGS-365340105363301","NM-26724","",""],["USGS-365359105382301","NM-26726","",""],["USGS-365409105373801","NM-26729","",""],["USGS-365458105342301","NM-26733","",""],["USGS-365524105345601","NM-26737","",""],["USGS-365551105345401","NM-26741","",""],["USGS-365705105374001","NM-26755","",""],["USGS-351747106241701","PC-029","","PW-052"],["USGS-341611107381601","SA-0001","","SA-1_R00"],["USGS-341552107384501","SA-0002","","SA-2_R00"],["USGS-341545107384801","SA-0003","","SA-3_R00"],["USGS-341547107375401","SA-0004","","SA-4_R00"],["USGS-341712107462701","SA-0005","","SA-5_R00"],["USGS-341601107491801","SA-0006","","SA-6_R00"],["USGS-341458107381801","SA-0007","","SA-7_R00"],["USGS-341751107430202","SA-0008","","SA-8_R01"],["USGS-341243107404801","SA-0009","","SA-9_R00"],["USGS-341016107375601","SA-0010","","SA-10_R00"],["USGS-341251107433801","SA-0011","","SA-11_R00"],["USGS-341435107514001","SA-0012","","SA-12_R00"],["USGS-341228107512001","SA-0013","","SA-13_R00"],["USGS-340805107353701","SA-0014","","SA-14_R00"],["USGS-340827107460301","SA-0016","","SA-16_R00"],["USGS-340645107451501","SA-0017","","SA-17_R00"],["USGS-340723107425801","SA-0018","","SA-18_R00"],["USGS-340850107542801","SA-0019","","SA-19_R00"],["USGS-340817107512401","SA-0020","","SA-20_R00"],["USGS-340547107573801","SA-0022","","SA-22_R00"],["USGS-340507108080301","SA-0023","","SA-23_R00"],["USGS-340520108062601","SA-0024","","SA-24_R00"],["USGS-340503108031501","SA-0025","","SA-25_R00"],["USGS-340326107303701","SA-0026","","SA-26_R00"],["USGS-340225107340001","SA-0027","","SA-27_R00"],["USGS-340427107373601","SA-0028","","SA-28_R00"],["USGS-340118107424201","SA-0029","","SA-29_R00"],["USGS-340456107431601","SA-0030","","SA-30_R00"],["USGS-340336107552001","SA-0031","","SA-31_R00"],["USGS-340328107511201","SA-0032","","SA-32_R00"],["USGS-340223107543601","SA-0033","","SA-33_R00"],["USGS-340329107584201","SA-0034","","SA-34_R00"],["USGS-340121107582401","SA-0035","","SA-35_R00"],["USGS-340218108031601","SA-0036","","SA-36_R00"],["USGS-340153108065101","SA-0037","","SA-37_R01"],["USGS-340119108023901","SA-0038","","SA-38_R00"],["USGS-340312108102701","SA-0039","","SA-39_R01"],["USGS-335844107280601","SA-0040","","SA-40_R00"],["USGS-335904107404901","SA-0041","","SA-41_R01"],["USGS-335940107483801","SA-0042","","SA-42_R00"],["USGS-335431107481201","SA-0043","","SA-43_R00"],["USGS-335903107542201","SA-0044","","SA-44_R00"],["USGS-335439107541601","SA-0045","","SA-45_R00"],["USGS-335709108004201","SA-0046","","SA-46_R00"],["USGS-335727108042701","SA-0047","","SA-47_R00"],["USGS-335617108111801","SA-0048","","SA-48_R00"],["USGS-335535108112101","SA-0049","","SA-49_R00"],["USGS-335140107442801","SA-0051","","SA-51_R00"],["USGS-335151107582501","SA-0052","","SA-52_R00"],["USGS-335410108060901","SA-0053","","SA-53_R00"],["USGS-334930108043201","SA-0054","","SA-54_R00"],["USGS-335429108125801","SA-0055","","SA-55_R00"],["USGS-335243108100201","SA-0056","","SA-56_R00"],["USGS-334927108133301","SA-0057","","SA-57_R00"],["USGS-335134108171301","SA-0058","","SA-58_R00"],["USGS-335032108184501","SA-0059","","SA-59_R00"],["USGS-335149108355801","SA-0060","","SA-60_R00"],["USGS-334511107424301","SA-0061","","SA-61_R00"],["USGS-334819108084601","SA-0062","","SA-62_R00"],["USGS-334914108191901","SA-0063","","SA-63_R00"],["USGS-334516108173902","SA-0064","","SA-64_R00"],["USGS-334801108395201","SA-0065","","SA-65_R00"],["USGS-334629107365601","SA-0066","","SA-66_R01"],["USGS-335426108384401","SA-0067","","SA-67_R01"],["USGS-334109107402701","SA-0068","","SA-68_R00"],["USGS-333740107392301","SA-0069","","SA-69_R00"],["USGS-340450107451701","SA-0073","","SA-15_R02"],["USGS-340547107464401","SA-0074","","SA-16_R01"],["USGS-340216107281801","SA-0075","","SA-40_R01"],["USGS-340422107370801","SA-0076","","SA-28_R01"],["USGS-340451107452001","SA-0077","","SA-15_R03"],["USGS-340740107373601","SA-0078","","SA-11_R02"],["USGS-335856107374401","SA-0084","",""],["USGS-334335107401001","SA-0086","",""],["USGS-333235107360601","SA-0102","",""],["USGS-333131107434501","SA-0104","",""],["USGS-333116107415301","SA-0105","",""],["USGS-333150107402401","SA-0107","",""],["USGS-340153107483101","SA-0110","",""],["USGS-340034107545201","SA-0111","",""],["USGS-340103107461701","SA-0114","",""],["USGS-335706107571501","SA-0120","",""],["USGS-335400107562701","SA-0122","",""],["USGS-340525107515601","SA-0131","",""],["USGS-333136107361601","SA-0147","",""],["USGS-333702107420301","SA-0162","",""],["USGS-333416107414601","SA-0165","",""],["USGS-333356107404901","SA-0168","",""],["USGS-335130107431801","SA-0174","",""],["USGS-335441107411501","SA-0177","",""],["USGS-335244107454301","SA-0179","",""],["USGS-335430107435801","SA-0180","",""],["USGS-340238107382301","SA-0188","",""],["USGS-335707107460701","SA-0192","",""],["USGS-340032107425101","SA-0193","",""],["USGS-332612107420301","SA-0218","",""],["USGS-340945107403301","SA-0227","",""],["USGS-334202108152901","SA-0228","",""],["USGS-334536108150701","SA-0229","",""],["USGS-335344108023001","SA-0230","",""],["USGS-340711107253401","SA-0231","",""],["USGS-341517107383401","SA-0232","",""],["USGS-340727107523701","SA-0248","",""],["USGS-325920105241801","SM-0068","",""],["USGS-324629105275601","SM-0132","",""],["USGS-325324105290201","SM-0235","",""],["USGS-325237105103601","SM-0246","",""],["USGS-331950106020601","TB-0060","",""],["USGS-331237106022001","TB-0071","",""],["USGS-364812105460101","TC-205","","WG-18"],["USGS-364450105440801","TC-207","","WG-14"],["USGS-364940105442701","TC-210","","WG-21a"],["USGS-365504105465201","TC-211","","WG-28"],["USGS-365524105445201","TC-214","","WG-27"],["USGS-365038105530501","TC-217","","WG-23"],["USGS-365830105464701","TC-219","","WG-30"],["USGS-364543105572901","TC-221","","TP-37"],["USGS-365623105583501","TC-222","","WG-25"],["USGS-364336105434701","TC-225","","WG-13"],["USGS-365444105484701","TC-229","","WG-29"],["USGS-365624105511301","TC-230","","WG-26"],["USGS-364422105403201","TC-240","","CER-24"],["USGS-364057105401701","TC-249","","CER-23"],["USGS-365353105360101","TC-307","",""],["USGS-365116105375201","TC-327","",""],["USGS-362946103183301","UC-0068","",""],["USGS-361329103354101","UC-0069","",""],["USGS-362616103241401","UC-0070","",""],["USGS-362228103424801","UC-0072","",""],["USGS-362657103432401","UC-0073","",""],["USGS-364438103480701","UC-0074","",""],["USGS-364657103395301","UC-0075","",""],["USGS-364343103360901","UC-0076","",""],["USGS-355602103064001","UC-0078","",""],["USGS-355302103072201","UC-0079","",""],["USGS-363920103443101","UC-0083","",""],["USGS-362525103280701","UC-0084","",""],["USGS-364643103254801","UC-0085","",""],["USGS-363825103492301","UC-0086","",""],["USGS-362905103465601","UC-0087","",""],["USGS-363316103410601","UC-0088","",""],["USGS-363747103343801","UC-0089","",""],["USGS-365434103470901","UC-0090","",""],["USGS-365448103433701","UC-0091","",""],["USGS-365824103233801","UC-0092","",""],["USGS-365719103184801","UC-0093","",""],["USGS-365554103020902","UC-0094","",""],["USGS-363420103180101","UC-0095","",""],["USGS-365001103293201","UC-0096","",""],["USGS-364522104034501","UC-0134","",""],["USGS-360453103253501","UC-0136","",""],["USGS-354150103034302","UC-0138","",""],["USGS-320517105221401","WL-0034","",""],["USGS-340555106542101","WL-0132","",""],["USGS-340203106550701","WL-0134","",""],["USGS-324924106160201","WS-007","",""],["USGS-324854106160201","WS-008","",""],["USGS-324712106105901","WS-009","",""],["USGS-324648106102701","WS-010","",""],["USGS-324850106153001","WS-012","",""],["USGS-325227106090901","WS-016","",""]];
const clusterPeers = new Map();   // site idx -> [peer site idx at other agencies] (from the API's nm_well_correlation clusters)
const clusterInfo = new Map();    // site idx -> {cid, linked, method, conf}
const clusterDropSet = new Set(); // wells dropped by the "one well per cluster" de-duplication filter
const clusterKeep = new Map();     // dropped well -> the well that represents its cluster (receives its readings when merging)
const LINK_MAX_KM = 1;   // a multi-agency link must join wells within this distance (same physical well)
function siteKm(a, b){ const A = SITES[a], B = SITES[b]; if(A[1] == null || B[1] == null) return Infinity; return Math.hypot((A[1]-B[1])*111.32*Math.cos(34.4*Math.PI/180), (A[2]-B[2])*110.57); }
const linkRejected = [];   // [a, b, km] links ignored because the wells are too far apart
const nmbgmrOfOther = new Map();   // other-agency well index -> {idx, id, alt}
const otherOfNmbgmr = new Map();   // NMBGMR well index -> [{idx, id, source}]
{
  const byId = new Map(); SITES.forEach((r,i)=>byId.set(r[0], i));
  NMBGMR_LINKS_RAW.forEach(([otherId, nmId, , alt])=>{
    const o = byId.get(otherId), n = byId.get(nmId);
    if(o==null || n==null || o===n) return;
    { const km = siteKm(o, n); if(km > LINK_MAX_KM){ linkRejected.push([o, n, km]); return; } }
    nmbgmrOfOther.set(o, {idx:n, id:nmId, alt:alt||''});
    if(!otherOfNmbgmr.has(n)) otherOfNmbgmr.set(n, []);
    otherOfNmbgmr.get(n).push({idx:o, id:otherId, source: SITES[o][3]>=0 ? SOURCES[SITES[o][3]] : 'other'});
  });
}
function isMultiAgency(s){ return nmbgmrOfOther.has(s) || otherOfNmbgmr.has(s) || clusterPeers.has(s); }
function linkedPartners(s){
  if(clusterPeers.has(s)) return clusterPeers.get(s).slice();
  if(nmbgmrOfOther.has(s)){ const n = nmbgmrOfOther.get(s).idx; const sibs = (otherOfNmbgmr.get(n)||[]).map(o=>o.idx).filter(i=>i!==s); return [n, ...sibs]; }
  if(otherOfNmbgmr.has(s)) return otherOfNmbgmr.get(s).map(o=>o.idx);
  return [];
}
function toDisplay(s, rawDepthVal){
  if(rawDepthVal==null) return null;
  if(state.valueMode === 'elevation'){
    if(!hasElevation(s)) return null;
    return siteElevation[s] - rawDepthVal;
  }
  return rawDepthVal;
}

// Per-well series maps: siteIdx -> [{year,avg,n,min,max}] (yearly) and [{year,month,avg,n}] (monthly).
// Rebuilt whenever the reading-quality filters change which readings count.
const siteYearMap = new Map(), siteMonthMap = new Map();
function buildSiteMaps(){
  siteYearMap.clear(); siteMonthMap.clear();
  for(let s=0; s<NSITES; s++){ siteYearMap.set(s, []); siteMonthMap.set(s, []); }
  for(const r of SITE_YEAR) siteYearMap.get(r[0]).push({year:r[1], avg:r[2], n:r[3], min:r[4], max:r[5]});
  for(const r of SITE_MONTH) siteMonthMap.get(r[0]).push({year:r[1], month:r[2], avg:r[3], n:r[4]});
  otDataVer = (otDataVer || 0) + 1;
  try{ rangeCache = {key:null, m:new Map()}; }catch(e){ /* not declared yet on the very first build */ }
}
buildSiteMaps();

function seasonIsFullYear(){ return state.season.monthStart === 1 && state.season.monthEnd === 12; }

// Bad-reading detector. A value is flagged only when it OVERSHOOTS the range of its two
// neighbors (i.e. it is a spike, not part of a trend) AND all of these hold:
//  (1) the overshoot is at least threshold x 25 ft,
//  (2) the overshoot, relative to the neighbors' depth, exceeds threshold x sqrt(n readings) —
//      a point backed by many readings is less likely to be a typo,
//  (3) the overshoot is more than 1.5x the gap between the two neighbors themselves, so a
//      genuine step change (neighbors already far apart) is not mistaken for an error.
// Run twice: on the monthly series (so one typo inside a year of many good readings is caught)
// and then on the yearly series. `timeOf` gives each point's position on the time axis.
function detectDespikeIndices(series, threshold, timeOf){
  timeOf = timeOf || (p=>p.year);
  const bad = [];
  if(series.length < 3) return bad;
  for(let i=1; i<series.length-1; i++){
    const prev = series[i-1], cur = series[i], next = series[i+1];
    const lo = Math.min(prev.avg, next.avg), hi = Math.max(prev.avg, next.avg);
    const over = cur.avg > hi ? cur.avg - hi : (cur.avg < lo ? lo - cur.avg : 0);
    if(over <= 0) continue;
    if(over < threshold*25) continue;
    const scale = Math.max(Math.abs(prev.avg), Math.abs(next.avg), 1);
    if(over/scale <= threshold*Math.sqrt(cur.n || 1)) continue;
    if(over <= 1.5*Math.abs(prev.avg - next.avg)) continue;
    const t0 = timeOf(prev), t1 = timeOf(next), t = timeOf(cur);
    const expected = t1===t0 ? (prev.avg+next.avg)/2 : prev.avg + (next.avg-prev.avg)*(t-t0)/(t1-t0);
    bad.push({index:i, expected, relDev: over/scale});
  }
  return bad;
}
function despikeSeries(series, threshold){
  if(!state.despike.enabled || series.length < 3) return series;
  const flagged = detectDespikeIndices(series, threshold);
  if(!flagged.length) return series;
  const badIdx = new Set(flagged.map(f=>f.index));
  return series.filter((_,i)=>!badIdx.has(i));
}

// --- Monthly-level check (cached per threshold) ---
const NO_MONTH_FLAGS = new Set();
let monthFlagCache = {t:null, flags:new Map(), clean:new Map()};
function monthKey(p){ return p.year*12 + p.month; }
function monthFlagDetails(s){
  const months = siteMonthMap.get(s);
  if(!months || months.length < 3) return [];
  return detectDespikeIndices(months, state.despike.threshold, monthKey).map(f=>({...f, pt:months[f.index]}));
}
function monthFlagsFor(s){
  if(!state.despike.enabled) return NO_MONTH_FLAGS;
  if(monthFlagCache.t !== state.despike.threshold) monthFlagCache = {t:state.despike.threshold, flags:new Map(), clean:new Map()};
  let set = monthFlagCache.flags.get(s);
  if(!set){
    const d = monthFlagDetails(s);
    set = d.length ? new Set(d.map(f=>monthKey(f.pt))) : NO_MONTH_FLAGS;
    monthFlagCache.flags.set(s, set);
  }
  return set;
}
// Full-year series with any flagged months left out of that year's reading-weighted average.
function cleanedFullYearSeries(s){
  if(state.waterYear) return yearSeriesForMonthRangeRaw(s, 1, 12);
  const flags = monthFlagsFor(s);
  const raw = siteYearMap.get(s) || [];
  if(!flags.size) return raw;
  let out = monthFlagCache.clean.get(s);
  if(out) return out;
  const byYear = new Map();
  for(const p of siteMonthMap.get(s)){
    if(flags.has(monthKey(p))) continue;
    if(!byYear.has(p.year)) byYear.set(p.year, {sum:0, n:0});
    const acc = byYear.get(p.year); acc.sum += p.avg*p.n; acc.n += p.n;
  }
  const rawByYear = new Map(raw.map(p=>[p.year,p]));
  out = [];
  byYear.forEach((acc,year)=>{
    const r = rawByYear.get(year) || {};
    out.push({year, avg:acc.sum/acc.n, n:acc.n, min:r.min, max:r.max});
  });
  out.sort((a,b)=>a.year-b.year);
  monthFlagCache.clean.set(s, out);
  return out;
}
// --- Year window (min/max year): readings outside it are ignored; a well with none inside drops out.
function yearInWindow(y){
  const w = state.yearWindow;
  return (w.min==null || y>=w.min) && (w.max==null || y<=w.max);
}
function applyYearWindow(series){
  const w = state.yearWindow;
  if(w.min==null && w.max==null) return series;
  return series.filter(p=>yearInWindow(p.year));
}
function baseSeriesForSeason(s){
  return seasonIsFullYear() ? cleanedFullYearSeries(s) : yearSeriesForMonthRangeRaw(s, state.season.monthStart, state.season.monthEnd);
}
// Number of readings treated as bad for one well under current settings (monthly + yearly level).
function flagCountForSite(s){
  if(!state.despike.enabled) return 0;
  const base = baseSeriesForSeason(s);
  return monthFlagsFor(s).size + (base.length>=3 ? detectDespikeIndices(base, state.despike.threshold).length : 0);
}

// Dataset-wide list of every flagged reading (monthly and yearly level), independent of the
// map selection — powers the "flagged readings" table.
let allDespikeFlags = [];
function recomputeAllDespikeFlags(){
  allDespikeFlags = [];
  if(!state.despike.enabled) return;
  for(let s=0; s<NSITES; s++){
    for(const f of monthFlagDetails(s)){
      const yr = (siteYearMap.get(s)||[]).find(p=>p.year===f.pt.year);
      allDespikeFlags.push({site:s, level:'month', year:f.pt.year, month:f.pt.month, avg:f.pt.avg, n:f.pt.n, expected:f.expected, relDev:f.relDev, yearAvg: yr?yr.avg:null});
    }
    const base = baseSeriesForSeason(s);
    if(base.length < 3) continue;
    for(const f of detectDespikeIndices(base, state.despike.threshold)){
      const pt = base[f.index];
      allDespikeFlags.push({site:s, level:'year', year:pt.year, month:null, avg:pt.avg, n:pt.n, expected:f.expected, relDev:f.relDev, yearAvg:pt.avg});
    }
  }
  allDespikeFlags.sort((a,b)=> b.relDev - a.relDev);
}
function renderFlagsTable(force){
  const modal = document.getElementById('flags-modal');
  if(!force && modal && modal.classList.contains('hidden')) return;   // built when the table is opened
  const countEl = document.getElementById('flags-modal-count');
  const bodyEl = document.getElementById('flags-table-body');
  if(!countEl || !bodyEl) return;
  countEl.textContent = '('+allDespikeFlags.length.toLocaleString()+')';
  if(!allDespikeFlags.length){
    bodyEl.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--muted); font-family:var(--font-ui);">${state.despike.enabled ? 'No flagged readings at the current sensitivity.' : 'Bad-reading removal is currently turned off.'}</td></tr>`;
    return;
  }
  bodyEl.innerHTML = allDespikeFlags.map((f,i)=>{
    const rec = SITES[f.site];
    const src = rec[3]>=0 ? SOURCES[rec[3]] : '—';
    return `<tr>
      <td>${rec[0]}</td>
      <td>${src}</td>
      <td>${f.level==='month' ? f.year+'-'+String(f.month).padStart(2,'0') : f.year}</td>
      <td>${f.level==='month' ? 'month' : 'year'}</td>
      <td>${f.avg.toFixed(2)}</td>
      <td>${f.expected.toFixed(2)}</td>
      <td>${f.n}</td>
      <td>${(f.relDev*100).toFixed(0)}%</td>
      <td><button class="flags-locate" data-idx="${i}">Locate</button></td>
    </tr>`;
  }).join('');
  bodyEl.querySelectorAll('.flags-locate').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const f = allDespikeFlags[+btn.dataset.idx];
      const rec = SITES[f.site];
      document.getElementById('flags-modal').classList.add('hidden');
      if(rec[1]!=null && rec[2]!=null){
        map.flyTo([rec[2], rec[1]], Math.max(map.getZoom(), 14), {duration:0.6});
        const m = markers[f.site];
        if(m) setTimeout(()=>{ try{ onMarkerClick(f.site, m); }catch(e){} }, 650);
      }
    });
  });
}
/* ---- user readings (CSV or the OFR-vs-API workbook) ---- */
function importRowsFromTable(table, label){
  // table: array of arrays, first row = header
  const H = table[0].map(x => String(x == null ? '' : x).trim().toLowerCase());
  const col = names => H.findIndex(x => names.includes(x));
  const iRes = col(['result']), iFid = col(['api feature id(s)', 'feature_id', 'api_feature_id']), iSrc = col(['source']), iId = col(['id', 'site_id', 'well_id']);
  const iDate = col(['date', 'date_measured']), iV = col(['depth to water (ft)', 'depth_to_water', 'depth_to_water_ft', 'dtw', 'parameter_value', 'value']), iOfr = col(['ofr']);
  if(iDate < 0 || iV < 0 || (iFid < 0 && (iSrc < 0 || iId < 0))) throw new Error('The file needs a date column, a depth-to-water column, and either feature_id or source + id.');
  const out = [];
  for(let r=1; r<table.length; r++){
    const row = table[r]; if(!row || !row.length) continue;
    if(iRes >= 0 && !/^missing: measurement/i.test(String(row[iRes] || ''))) continue;   // workbook: only readings the API lacks
    const keys = [];
    if(iFid >= 0) String(row[iFid] || '').split(';').forEach(f => { const k = f.indexOf(':'); if(k > 0) keys.push([f.slice(0, k).trim(), f.slice(k + 1).trim()]); });
    if(iSrc >= 0 && iId >= 0 && row[iId] != null && row[iId] !== '') keys.push([String(row[iSrc] || '').trim(), String(row[iId]).trim()]);
    let d = row[iDate];
    if(d instanceof Date) d = d.toISOString().slice(0, 10);
    else if(typeof d === 'number') d = new Date(Math.round((d - 25569) * 864e5)).toISOString().slice(0, 10);   // Excel serial date
    else d = String(d || '').trim().replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4}).*$/, (m, a, b, c) => c + '-' + a.padStart(2, '0') + '-' + b.padStart(2, '0')).slice(0, 10);
    out.push({keys, date:d, dtw:row[iV], ofr: iOfr >= 0 ? row[iOfr] : ''});
  }
  return out;
}
let importedInfo = null;
function applyImportedRows(rows, name, quiet){
  const res = BOOT.addReadings(rows);
  importedInfo = {name, rows:rows.length, ...res, wells:res.wells.size};
  if(res.added) applyReadingQuality();   // re-collapses months/years with the added readings and redraws
  const st = document.getElementById('import-status');
  if(st) st.textContent = `${name}: ${res.added.toLocaleString()} reading(s) added at ${res.wells.size.toLocaleString()} well(s)` +
    (res.dup ? `; ${res.dup.toLocaleString()} skipped as already in the data` : '') + (res.noWell ? `; ${res.noWell.toLocaleString()} for wells not in the tool` : '') + (res.bad ? `; ${res.bad.toLocaleString()} without a usable date or value` : '') + '.';
  document.getElementById('btn-import-clear').classList.toggle('hidden', !res.added);
  if(!quiet) toast(res.added ? `Added ${res.added.toLocaleString()} reading(s) to ${res.wells.size.toLocaleString()} well(s).` : 'No new readings were added (see the note under the file box).');
  return res;
}
async function loadXlsxLib(){
  if(window.XLSX) return window.XLSX;
  await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = ok; s.onerror = () => bad(new Error('Could not load the spreadsheet reader.')); document.head.appendChild(s); });
  return window.XLSX;
}
document.getElementById('import-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if(!f) return;
  const st = document.getElementById('import-status'); st.textContent = 'Reading ' + f.name + '…';
  try{
    let table;
    if(/\.xlsx$/i.test(f.name)){
      const X = await loadXlsxLib();
      const wb = X.read(await f.arrayBuffer(), {type:'array', cellDates:true, dense:true});
      const sh = wb.Sheets['Records'] || wb.Sheets[wb.SheetNames[0]];
      table = X.utils.sheet_to_json(sh, {header:1, raw:true, defval:null});
    } else table = parseCsv(await f.text());
    const rows = importRowsFromTable(table, f.name);
    const res = applyImportedRows(rows, f.name);
    if(res.added){
      const prev = await idbGet('userReadings');
      const all = (prev && prev.rows ? prev.rows : []).concat(rows);
      idbSet('userReadings', {rows: all, name: (prev && prev.name ? prev.name + ' + ' : '') + f.name});
    }
  }catch(err){ st.textContent = 'Could not read ' + f.name + ': ' + (err.message || err); }
  e.target.value = '';
});
document.getElementById('btn-import-clear').addEventListener('click', async () => {
  await idbSet('userReadings', null);
  toast('Added readings removed. Reloading…');
  setTimeout(() => location.reload(), 600);
});
(async () => { try{ const u = await idbGet('userReadings'); if(u && u.rows && u.rows.length) applyImportedRows(u.rows, u.name || 'Saved readings', true); }catch(e){ console.warn('saved readings not applied', e); } litLoad(); })();
function litIsOn(){ try{ return localStorage.getItem('litReadings') !== 'off'; }catch(e){ return true; } }
async function litLoad(){
  const box = document.getElementById('lit-on'), st = document.getElementById('lit-status');
  if(box) box.checked = litIsOn();
  if(!litIsOn()){ if(st) st.textContent = 'Off: only API readings (and any file you add below) are used.'; return; }
  try{
    let r = null;
    for(const u of ['literature-readings.csv', 'https://steeltapejockey.github.io/WeaverAPI-Hydrograph-Explorer/literature-readings.csv']){
      try{ const x = await fetch(u, {cache:'no-cache'}); if(x.ok){ r = x; break; } }catch(e){}
    }
    if(!r){ if(st) st.textContent = location.protocol === 'file:' ? 'This page was opened from your computer, and the browser does not let it read literature-readings.csv beside it; the GitHub site copy was not found either. Upload the file to GitHub and open the page from the GitHub site.' : 'No literature-readings.csv found next to this page, so only API readings are used.'; return; }
    const rows = importRowsFromTable(parseCsv(await r.text()), 'literature-readings.csv');
    const res = BOOT.addReadings(rows);
    if(res.added) applyReadingQuality();
    const reps = new Set(rows.map(x => x.ofr).filter(Boolean)).size;
    if(st) st.textContent = `${res.added.toLocaleString()} readings from ${reps} open-file reports added at ${res.wells.size.toLocaleString()} wells` +
      (res.dup ? `; ${res.dup.toLocaleString()} skipped because the API (or a file you added) already has them` : '') +
      (res.noWell ? `; ${res.noWell.toLocaleString()} for wells no longer in the API` : '') + '. They count as manual readings.';
  }catch(e){ if(st) st.textContent = 'Could not load literature-readings.csv: ' + (e.message || e); }
}
(() => {
  const on = document.getElementById('oco-on'), k = document.getElementById('oco-key'), hd = document.getElementById('oco-key-header'), st = document.getElementById('oco-key-status');
  on.checked = ocoOn(); k.value = oco.key; hd.value = oco.header;
  ocoStatus(oco.status || (oco.wells ? `Ocotillo: ${oco.wells.toLocaleString()} wells with water levels${oco.key ? ' (with your key)' : ''}; ${oco.newWells.toLocaleString()} not in the unified API were added. Readings are fetched when you select an area.` : 'Ocotillo is off.'));
  on.addEventListener('change', () => { try{ localStorage.setItem('ocoOff', on.checked ? '0' : '1'); }catch(e){} toast('Reloading…'); setTimeout(() => location.reload(), 400); });
  const save = () => { const v = k.value.trim(); try{ sessionStorage.removeItem('ocoKey'); localStorage.removeItem('ocoKey'); if(v){ sessionStorage.setItem('ocoKey', v); } localStorage.setItem('ocoKeyHeader', hd.value); }catch(e){} };
  k.addEventListener('change', () => { save(); toast('Reloading with the new key…'); setTimeout(() => location.reload(), 500); });
  hd.addEventListener('change', save);
  document.getElementById('oco-key-test').addEventListener('click', async () => {
    const v = k.value.trim(); if(!v){ st.textContent = 'Paste a key first.'; return; }
    st.textContent = 'Testing…';
    const hdr = {'Authorization': 'Bearer ' + v};
    try{
      const pub = await fetch(OCO_ROOT + '/ogcapi/collections/waterlevels/locations?f=json').then(r => r.json()).then(j => j.features.length).catch(() => null);
      const r = await fetch(OCO_ROOT + '/ogcapi-internal/collections/waterlevels/locations?f=json', {headers: hdr});
      if(!r.ok){ st.textContent = `The private endpoint answered ${r.status} with this key${r.status === 404 || r.status === 401 || r.status === 403 ? ' (the key was not accepted: check it was copied whole; Ocotillo keys start with ocot_)' : ''}.`; return; }
      const n = (await r.json()).features.length;
      st.textContent = `Key works: ${n.toLocaleString()} wells with water levels with the key` + (pub != null ? ` (${pub.toLocaleString()} without it).` : '.') + ' Press Enter in the key box (or change it) to reload with it.';
    }catch(e){ st.textContent = 'Test failed: ' + (e.message || e); }
  });
})();
document.getElementById('lit-on').addEventListener('change', e => {
  try{ localStorage.setItem('litReadings', e.target.checked ? 'on' : 'off'); }catch(err){}
  toast('Reloading…'); setTimeout(() => location.reload(), 500);
});

document.getElementById('btn-show-flags-table').addEventListener('click', ()=>{
  renderFlagsTable(true);
  document.getElementById('flags-modal').classList.remove('hidden');
});
document.getElementById('flags-modal-close').addEventListener('click', ()=>{
  document.getElementById('flags-modal').classList.add('hidden');
});
document.getElementById('flags-modal').addEventListener('click', e=>{
  if(e.target.id === 'flags-modal') document.getElementById('flags-modal').classList.add('hidden');
});
document.getElementById('btn-export-flags').addEventListener('click', ()=>{
  if(!allDespikeFlags.length){ toast('No flagged readings to export.'); return; }
  const rows = [['well_id','source','year','month','level','yearly_avg_ft','flagged_value_ft','expected_value_ft','n_readings','severity_pct']];
  allDespikeFlags.forEach(f=>{
    const rec = SITES[f.site];
    const src = rec[3]>=0 ? SOURCES[rec[3]] : '';
    rows.push([rec[0], src, f.year, f.month==null?'':f.month, f.level, f.yearAvg==null?'':f.yearAvg.toFixed(2), f.avg.toFixed(2), f.expected.toFixed(2), f.n, (f.relDev*100).toFixed(0)]);
  });
  downloadCsv('nm_groundwater_flagged_readings.csv', rows);
  toast('Exported '+allDespikeFlags.length+' flagged reading(s).');
});
// Returns [{year,avg,n}, ...] for a site under the current season filter. Full year (default)
// uses the fast precomputed yearly map; a season filter recombines from monthly data instead,
// re-bucketing by each reading's own calendar year (a Dec reading counts toward that same year,
// not the following winter — a deliberate simplification, noted in the UI).
function getYearSeries(s){
  return applyYearWindow(despikeSeries(baseSeriesForSeason(s), state.despike.threshold));
}
// Same idea as getYearSeries but for an arbitrary month range, independent of the global season
// filter — used by the season-comparison overlay to recompute the same wells/years under a few
// different month ranges at once (e.g. Winter vs Summer) without touching the active filter state.
function yearSeriesForMonthRange(s, ms, me){
  return applyYearWindow(despikeSeries(yearSeriesForMonthRangeRaw(s, ms, me), state.despike.threshold));
}
var rangeCache = {key:null, m:new Map()};
function yearSeriesForMonthRangeRaw(s, ms, me){
  if(ms === 1 && me === 12 && !state.waterYear) return cleanedFullYearSeries(s);
  const ck = [state.waterYear, ms, me, state.despike.enabled, state.despike.threshold].join('|');
  if(rangeCache.key !== ck) rangeCache = {key:ck, m:new Map()};
  let hit = rangeCache.m.get(s);
  if(!hit){ hit = yearSeriesForMonthRangeCompute(s, ms, me); rangeCache.m.set(s, hit); }
  return hit;
}
function yearSeriesForMonthRangeCompute(s, ms, me){
  const months = siteMonthMap.get(s);
  if(!months || !months.length) return [];
  const inRange = ms <= me ? (m => m>=ms && m<=me) : (m => m>=ms || m<=me);
  const byYear = new Map();
  const bad = monthFlagsFor(s);
  for(const p of months){
    if(!inRange(p.month)) continue;
    if(bad.size && bad.has(monthKey(p))) continue;
    // water year (Oct-Dec -> next year), and a range that wraps the new year (e.g. Nov-Feb): months before the wrap count toward the following year
    const yr = ((state.waterYear && p.month >= 10) || (ms > me && p.month >= ms)) ? p.year + 1 : p.year;
    if(!byYear.has(yr)) byYear.set(yr, {sum:0, n:0});
    const acc = byYear.get(yr);
    // Weight each month by its own reading count, not equally — otherwise a month with 1 reading
    // and a month with 20 readings would count the same, which silently shifts the year's value
    // away from what "All year" mode reports (that fast path averages every individual reading
    // equally). Weighting by n here keeps every season filter on the same footing.
    acc.sum += p.avg * p.n;
    acc.n += p.n;
  }
  const out = [];
  byYear.forEach((acc,year)=> out.push({year, avg: acc.sum/acc.n, n: acc.n}));
  out.sort((a,b)=>a.year-b.year);
  return out;
}

// Per-site trend (simple least-squares slope of yearly avg vs year) + per-site own mean (for
// normalization) + years-of-record count. Re-run whenever the season filter changes, since all
// three depend on which readings currently count as "this site's data".
const siteTrend = new Float32Array(NSITES);   // ft/year change in depth-to-water (positive = water table declining)
const siteOwnMean = new Float32Array(NSITES);
const siteNYears = new Int16Array(NSITES);
const apiTables = {};   // well statistics / water quality from the API: name -> Map(siteIdx -> properties)
function recomputeTrendAndMean(){
  for(let s=0; s<NSITES; s++){
    const yrs = getYearSeries(s);
    if(!yrs || !yrs.length){ siteTrend[s]=NaN; siteOwnMean[s]=NaN; siteNYears[s]=0; continue; }
    siteNYears[s] = yrs.length;
    let sumY=0, sumX=0, sumXY=0, sumXX=0, sumV=0;
    for(const p of yrs){ sumX+=p.year; sumV+=p.avg; sumY+=p.avg; sumXY+=p.year*p.avg; sumXX+=p.year*p.year; }
    const n = yrs.length;
    siteOwnMean[s] = sumV/n;
    if(n >= 3){
      const denom = n*sumXX - sumX*sumX;
      siteTrend[s] = denom !== 0 ? (n*sumXY - sumX*sumY)/denom : NaN;
    } else {
      siteTrend[s] = NaN;
    }
  }
}
function siteOwnMeanDisplay(s){
  if(isNaN(siteOwnMean[s])) return NaN;
  if(state.valueMode === 'elevation'){
    if(!hasElevation(s)) return NaN;
    return siteElevation[s] - siteOwnMean[s];
  }
  return siteOwnMean[s];
}

/* -------------------------------------------------------------------- */
/* 1. State                                                              */
/* -------------------------------------------------------------------- */
function defaultFilters(){
  return {
    sources:new Set(SOURCES.map((_,i)=>i)),
    aquiferExt:new Set([...AQUIFER_EXTENT_NAMES.map((_,i)=>i), -1]),
    studyArea:new Set([...STUDY_AREA_NAMES.map((_,i)=>i), -1]),
    formation:new Set([...FORMATIONS.map((_,i)=>i), -1]),
    usgsAq:new Set([...AQUIFERS.map((_,i)=>i), -1]),
    formationSearch:'', multiAgency:'merge',
    api:{slopeMin:null, slopeMax:null, sig:false, cat:'', span:null, obsYr:null, recentYrs:null, status:'', mcl:'', wtype:'', cb:null, hard:'', tds:''},
    depthMin:null, depthMax:null, depthRequire:false, dtwMin:null, dtwMax:null, yearMin:null, yearMax:null, minYears:null
  };
}
const state = {
  theme:'light',
  filters:{
    sources: new Set(SOURCES.map((_,i)=>i)),
    aquiferExt: new Set([...AQUIFER_EXTENT_NAMES.map((_,i)=>i), -1]),
    studyArea: new Set([...STUDY_AREA_NAMES.map((_,i)=>i), -1]),
    formationSearch:'', multiAgency:'merge',
    formation: null, usgsAq: null,
    depthMin:null, depthMax:null, depthRequire:false,
    dtwMin:null, dtwMax:null,
    yearMin:null, yearMax:null, minYears:null
  },
  areaSelection:null,     // {type:'polygon'|'county'|'huc'|'upload', rings:[[[lng,lat],...], ...], label:string}
  clickSelectedSites: new Set(), // manually clicked-on wells (union with area selection)
  qualifyingSites: new Set(),    // wells actually contributing to the current composite hydrograph (after exclusions)
  algoQualifyingSites: new Set(), // wells the schedule algorithm would include, before manual exclusions
  excludedSites: new Set(),      // manually excluded from the composite; persists until a new area selection
  activeSet: null,        // Set of site indices currently passing filters+area (recomputed)
  colorBy:'source',
  season:{ monthStart:1, monthEnd:12 },  // 1=Jan..12=Dec; default = all months (no seasonal filter)
  group:{ mode:'off', n:3, breaks:null },
  waterYear:true,                    // bucket readings by water year (Oct 1 - Sep 30) like USGS OFR 2022-1008; default since patch69 so a season spanning New Year's (e.g. the default Oct-Mar cool half) isn't split across two years
  normalizeStyle:'ft',               // 'ft' = anomaly in feet; 'usgs' = % of each well's own range (Myers 2022, eq. 1)
  yearWindow:{ min:null, max:null }, // only readings inside [min,max] count; wells with none inside drop out
  despike:{ enabled:true, threshold:0.6 }, // filters lone data-entry-error readings out of every well's series
  seasonCompare:{ enabled:false, keys:new Set(['winter','summer']) },
  chartHighlightSite: null,  // site index clicked in the spaghetti chart, rung on the map
  valueMode:'depth',      // 'depth' (depth-to-water) or 'elevation' (water-surface elevation)
  showAllWells:true,               // true = Wells view (default), false = Composite view
  krigShow:false,                  // draw the precomputed kriged average for HUC-8 / HUC-10 selections
  krig:null,                       // {name, rows:[{year, chg, se}], base, key}
  ref:null,                        // reference hydrograph overlay {name, rows:[{year, chg, se}]}
  useDem:true,                    // water-level elevation from USGS 3DEP land elevation instead of the site elevation
  statewideOk:false,               // build a composite even with no area / wells picked (button)
  otp: otDefaults(),              // composite method settings (Over the Top)
  normalize:false,
  showSpaghetti:false,
  showBand:true,
  basemap:'topo',
  drawing:false,
  drawVerts:[]
};

/* -------------------------------------------------------------------- */
/* 2. Point-in-polygon helpers                                          */
/* -------------------------------------------------------------------- */
// ring: array of [lng,lat]. Standard ray casting.
function pointInRing(x, y, ring){
  let inside = false;
  for(let i=0, j=ring.length-1; i<ring.length; j=i++){
    const xi=ring[i][0], yi=ring[i][1], xj=ring[j][0], yj=ring[j][1];
    const intersect = ((yi>y) !== (yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-12) + xi);
    if(intersect) inside = !inside;
  }
  return inside;
}
// polygons: array of rings-arrays (each a polygon = [outerRing, ...holes]); we treat first ring only (holes ignored for simplicity, fine for filtering use case)
const polyBoxes = new WeakMap();
function pointInPolygons(lng, lat, polygons){
  // bounding-box prefilter per polygon (cached), outer ring, then holes
  for(const poly of polygons){
    if(!poly.length) continue;
    let bb = polyBoxes.get(poly);
    if(!bb){ let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity; for(const p of poly[0]){ if(p[0]<a)a=p[0]; if(p[0]>c)c=p[0]; if(p[1]<b)b=p[1]; if(p[1]>d)d=p[1]; } bb = [a,b,c,d]; polyBoxes.set(poly, bb); }
    if(lng < bb[0] || lng > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    if(!pointInRing(lng, lat, poly[0])) continue;
    let inHole = false;
    for(let k=1; k<poly.length; k++) if(pointInRing(lng, lat, poly[k])){ inHole = true; break; }
    if(!inHole) return true;
  }
  return false;
}

/* -------------------------------------------------------------------- */
/* 3. Theme                                                              */
/* -------------------------------------------------------------------- */
function applyTheme(t){
  state.theme = t;
  document.body.setAttribute('data-theme', t);
  document.getElementById('theme-toggle').textContent = t==='light' ? '◐' : '◑';
  if(window._basemapLayer) setBasemap(state.basemap); // refresh tile choice re: dark variant
  renderChart();
}
document.getElementById('theme-toggle').addEventListener('click', ()=>{
  applyTheme(state.theme==='light' ? 'dark' : 'light');
});

/* -------------------------------------------------------------------- */
/* 4. Tabs                                                               */
/* -------------------------------------------------------------------- */
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tabpanel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-'+btn.dataset.tab).classList.add('active');
  });
});

/* -------------------------------------------------------------------- */
/* 5. Sidebar resize + drawer resize/collapse                           */
/* -------------------------------------------------------------------- */
(function(){
  const sb = document.getElementById('sidebar');
  const grip = document.getElementById('sidebar-resize');
  let dragging=false;
  grip.addEventListener('mousedown', e=>{dragging=true; e.preventDefault();});
  window.addEventListener('mousemove', e=>{
    if(!dragging) return;
    const rect = sb.getBoundingClientRect();
    const w = Math.min(520, Math.max(260, e.clientX - rect.left));
    sb.style.width = w+'px';
  });
  window.addEventListener('mouseup', ()=>{ if(dragging){dragging=false; if(window._map) window._map.invalidateSize();} });
})();
(function(){
  const dr = document.getElementById('drawer');
  const grip = document.getElementById('drawer-resize');
  let dragging=false;
  grip.addEventListener('mousedown', e=>{dragging=true; e.preventDefault();});
  window.addEventListener('mousemove', e=>{
    if(!dragging) return;
    const rect = dr.getBoundingClientRect();
    const h = Math.min(window.innerHeight-140, Math.max(120, rect.bottom - e.clientY));
    dr.style.height = h+'px';
    if(dr._raf) return;   // at most one redraw per frame
    dr._raf = requestAnimationFrame(()=>{ dr._raf = null; if(window._map) window._map.invalidateSize(); if(chart) chart.resize(); });
  });
  window.addEventListener('mouseup', ()=>{dragging=false;});
  document.getElementById('drawer-collapse').addEventListener('click', ()=>{
    dr.classList.toggle('collapsed');
    document.getElementById('drawer-collapse').textContent = dr.classList.contains('collapsed') ? '▴' : '▾';
    if(window._map) setTimeout(()=>window._map.invalidateSize(), 160);
  });
})();
document.getElementById('legend-collapse').addEventListener('click', ()=>{
  const lg = document.getElementById('legend');
  lg.classList.toggle('collapsed');
  document.getElementById('legend-collapse').textContent = lg.classList.contains('collapsed') ? '▸' : '▾';
});

/* -------------------------------------------------------------------- */
/* 6. Toast                                                              */
/* -------------------------------------------------------------------- */
let toastTimer=null;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 2600);
}

/* -------------------------------------------------------------------- */
/* 7. Map setup                                                          */
/* -------------------------------------------------------------------- */
const map = L.map('map', {preferCanvas:true, zoomControl:true}).setView([34.5, -106.1], 7);
{ const n = document.createElement('div'); n.id = 'zoom-note'; n.textContent = 'Zoom in or pick an area to see wells';
  n.style.cssText = 'position:absolute; left:50%; bottom:28px; transform:translateX(-50%); z-index:650; background:var(--surface-1); color:var(--ink-1); border:1px solid var(--border); border-radius:999px; padding:5px 12px; font-size:12px; box-shadow:var(--shadow); pointer-events:none;';
  document.getElementById('map').appendChild(n); }
let lastZoomGate = null;
map.on('zoomend', ()=>{ const g = map.getZoom() < 9; if(g !== lastZoomGate){ lastZoomGate = g; if(typeof restyleMarkers === 'function' && state.activeSet) restyleMarkers(); } });
window._map = map;

const BASEMAPS = {
  light: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {maxZoom:16, attribution:'Esri, HERE, Garmin, OpenStreetMap contributors'}),
  dark: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {maxZoom:16, attribution:'Esri, HERE, Garmin, OpenStreetMap contributors'}),
  topo: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'Esri, USGS, NOAA'}),
  imagery: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom:19, attribution:'Esri, Maxar, Earthstar Geographics'})
};
function setBasemap(key){
  Object.values(BASEMAPS).forEach(l=>{ if(map.hasLayer(l)) map.removeLayer(l); });
  const useKey = (key==='light' && state.theme==='dark') ? 'dark' : key;
  BASEMAPS[useKey].addTo(map);
  window._basemapLayer = BASEMAPS[useKey];
}
setBasemap('topo');
document.getElementById('basemap-select').addEventListener('change', e=>{
  state.basemap = e.target.value;
  setBasemap(state.basemap);
});

const wellsPane = map.createPane('wellsPane'); wellsPane.style.zIndex = 450;
const refPane = map.createPane('refPane'); refPane.style.zIndex = 420;
const selPane = map.createPane('selPane'); selPane.style.zIndex = 440;

const wellsLayer = L.layerGroup().addTo(map);
const countiesLayer = L.layerGroup();
const hucLayer = L.layerGroup();
const aquiferExtentLayer = L.layerGroup();
const studyAreaLayer = L.layerGroup();
const areaLayer = L.layerGroup().addTo(map); // drawn/uploaded/county/huc highlight outline

/* -------------------------------------------------------------------- */
/* 8. Well markers                                                       */
/* -------------------------------------------------------------------- */
function colorForSite(s, mode){
  if(mode === 'ptrend') return hxPtmColor(s);
  if(mode === 'wtres') return hxWtColor(s);
  if(mode.startsWith('api:')) return apiColor(s, mode);
  const rec = SITES[s];
  if(mode === 'source'){
    const idx = rec[3];
    return idx>=0 ? SOURCE_COLORS[idx % SOURCE_COLORS.length] : '#999';
  }
  if(mode === 'aquifer'){
    const idx = rec[12];
    return idx>=0 ? AQUIFER_COLORS[idx % AQUIFER_COLORS.length] : '#9aa39a';
  }
  if(mode === 'overlap'){
    const n = rec[15].length; return n>1 ? '#a23fb5' : (n===1 ? '#2f7fc1' : '#9aa39a');
  }
  if(mode === 'multi'){
    return isMultiAgency(s) ? '#a23fb5' : '#9aa39a';
  }
  if(mode === 'trend'){
    const t = siteTrend[s];
    if(isNaN(t)) return '#9aa39a';
    if(t > 0.15) return '#c1652f';   // declining water table (depth increasing)
    if(t < -0.15) return '#2f7fc1';  // recovering
    return '#9aa39a';                // stable
  }
  if(mode === 'recency'){
    const last = rec[7];
    if(!last) return '#9aa39a';
    if(last >= 2020) return '#0f6e63';
    if(last >= 2010) return '#5a9c8c';
    if(last >= 2000) return '#c9a227';
    return '#c1652f';
  }
  if(mode === 'depth'){
    const d = rec[4];
    if(d==null) return '#9aa39a';
    if(d < 100) return '#2f7fc1';
    if(d < 300) return '#5a9c8c';
    if(d < 600) return '#c9a227';
    return '#c1652f';
  }
  return '#0f6e63';
}

const markers = new Array(NSITES);
const markerHidden = new Uint8Array(NSITES);
state.showMultiRings = true;
state.onlySelected = true;   // when an area/selection exists, hide every well that is not in it
const multiPane = map.createPane('multiPane'); multiPane.style.zIndex = 445;
const multiLayer = L.layerGroup().addTo(map);
const multiRings = new Map();

// Precompute "nested well" groups (separate site IDs sharing the exact same coordinate) once,
// reused for both the marker spiderfy offset and the well popup annotation.
const nestedGroups = new Map(); // siteIdx -> array of sibling siteIdx sharing its coordinate
{
  const coordGroups = new Map();
  for(let s=0; s<NSITES; s++){
    const rec = SITES[s];
    if(rec[1]==null || rec[2]==null) continue;
    const key = rec[1].toFixed(5)+','+rec[2].toFixed(5);
    if(!coordGroups.has(key)) coordGroups.set(key, []);
    coordGroups.get(key).push(s);
  }
  coordGroups.forEach(group=>{
    if(group.length > 1) group.forEach(s=>nestedGroups.set(s, group));
  });
}

function buildMarkers(){
  wellsLayer.clearLayers(); multiLayer.clearLayers(); markerHidden.fill(1);
  for(let s=0; s<NSITES; s++){
    const rec = SITES[s];
    let lat = rec[2], lng = rec[1];
    if(lat==null || lng==null) continue;
    const group = nestedGroups.get(s);
    if(group){
      const idx = group.indexOf(s);
      const n = group.length;
      const rDeg = 0.00007 * Math.sqrt(n);
      const angle = (2*Math.PI*idx)/n;
      lat += rDeg * Math.sin(angle);
      lng += (rDeg * Math.cos(angle)) / Math.cos(lat*Math.PI/180);
    }
    const m = L.circleMarker([lat,lng], {
      pane:'wellsPane', radius:3, weight:0.6, color:'#222', opacity:0.35,
      fillColor: colorForSite(s, state.colorBy), fillOpacity:0.85, siteIdx:s
    });
    m.on('click', ()=>onMarkerClick(s, m));
    markers[s] = m;
    if(isMultiAgency(s)){
      const ring = L.circleMarker([lat,lng], {pane:'multiPane', radius:8, weight:2, color:'#a23fb5', dashArray:'3,2', fillOpacity:0, opacity:0.9, interactive:false});
      multiRings.set(s, ring);
    }
  }
}

const WELL_MIN_ZOOM = 9;   // with nothing selected, well points are drawn from this zoom in
function restyleMarkers(){
  const hasSelNow = !!(state.areaSelection || state.clickSelectedSites.size);
  const zoomGate = map.getZoom() < WELL_MIN_ZOOM;
  { const n = document.getElementById('zoom-note'); if(n) n.style.display = (!hasSelNow && zoomGate) ? 'block' : 'none'; }
  const useQual = !state.showAllWells && state.qualifyingSites.size > 0;
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#0f6e63';
  for(let s=0; s<NSITES; s++){
    const m = markers[s];
    if(!m) continue;
    // a well merged into its multi-agency partner is the same physical well: draw it as its partner is drawn
    const k = clusterKeep.has(s) ? clusterKeep.get(s) : s;
    const inActive = state.activeSet.has(k);
    // with a composite drawn, show just the wells in it (plus manually excluded ones so they can be restored);
    // otherwise (no composite / overview mode) show every well in the selection
    const showSet = useQual ? (state.qualifyingSites.has(k) || (state.excludedSites.has(k) && state.algoQualifyingSites.has(k)) || state.chartHighlightSite === s) : inActive;
    const hide = (state.onlySelected && hasSelNow && !showSet) || (!hasSelNow && zoomGate);
    if(hide !== !!markerHidden[s]){
      markerHidden[s] = hide ? 1 : 0;
      if(hide){ wellsLayer.removeLayer(m); const rg = multiRings.get(s); if(rg) multiLayer.removeLayer(rg); }
      else { wellsLayer.addLayer(m); const rg = multiRings.get(s); if(rg) multiLayer.addLayer(rg); }
    }
    if(hide) continue;
    const clicked = state.clickSelectedSites.has(s);
    const qualifying = state.qualifyingSites.has(k);
    const excluded = state.excludedSites.has(k) && state.algoQualifyingSites.has(k);
    const chartHi = state.chartHighlightSite === s;
    let radius = 3, weight = 0.6, color = '#222';
    if(excluded){ radius = 5.5; weight = 2; color = '#c1652f'; }
    if(qualifying){ radius = 4.5; weight = 1.5; color = accent; }
    if(clicked){ radius = 6; weight = 2; color = '#ffd23f'; }
    if(chartHi){ radius = 8; weight = 3; color = '#e0455c'; }
    m.setStyle({
      fillColor: colorForSite(s, state.colorBy),
      fillOpacity: inActive ? 0.9 : 0.10,
      opacity: (qualifying || clicked || chartHi || excluded) ? 1 : (inActive ? 0.45 : 0.06),
      radius, weight, color
    });
    if(qualifying || clicked || chartHi || excluded) m.bringToFront();
    const ring = multiRings.get(s);
    if(ring) ring.setStyle({opacity: inActive ? 0.95 : 0.12, radius: radius + 3});
  }
}

function popupHtml(s){
  const rec = SITES[s];
  const [id, lng, lat, srcIdx, depth, nrec, firstYr, lastYr, minV, maxV, meanV, usgsId, aqIdx, fmIdx, elev, aqExtIdx, studyAreaIdxs] = rec;
  const src = srcIdx>=0 ? SOURCES[srcIdx] : 'Unknown';
  const aquifer = aqIdx>=0 ? AQUIFERS[aqIdx] : null;
  const aquiferExtent = (aqExtIdx && aqExtIdx.length) ? aqExtIdx.map(i=>AQUIFER_EXTENT_NAMES[i].replace(/_/g,' ')).join(', ') : null;
  const studyAreasTxt = (studyAreaIdxs && studyAreaIdxs.length) ? studyAreaIdxs.map(i=>STUDY_AREA_NAMES[i]).join(', ') : null;
  const formation = fmIdx>=0 ? FORMATIONS[fmIdx] : null;
  const t = siteTrend[s];
  let trendTxt = 'not enough data for a trend';
  if(!isNaN(t)){
    const dir = t>0.05 ? 'declining' : (t< -0.05 ? 'recovering' : 'roughly stable');
    trendTxt = `${dir} — ${(t>=0?'+':'')}${t.toFixed(2)} ft/yr in depth-to-water`;
  }
  if(!seasonIsFullYear()) trendTxt += ' (season-filtered)';
  const inClicked = state.clickSelectedSites.has(s);
  const elevRangeTxt = (elev!=null && minV!=null) ? `${(elev-maxV).toFixed(1)}–${(elev-minV).toFixed(1)} ft` : '—';
  const nested = nestedGroups.get(s);
  const nestedTxt = nested ? `<div class="kv"><span>Nested well</span><span>${nested.length-1} other well(s) here</span></div>` : '';
  const usgsWaterdataUrl = (typeof id === 'string' && id.startsWith('USGS-'))
    ? `https://waterdata.usgs.gov/monitoring-location/${id}/#dataTypeId=measurements-72019-0&period=P1Y`
    : null;
  const kq = clusterKeep.has(s) ? clusterKeep.get(s) : s;
  const inComposite = state.qualifyingSites.has(kq);
  const algoQualifies = state.algoQualifyingSites.has(kq);
  const isExcluded = state.excludedSites.has(kq);
  const excludeBtn = algoQualifies
    ? `<button class="btn" id="pop-exclude-${s}">${isExcluded ? 'Include in composite' : 'Exclude from composite'}</button>` + (kq !== s ? `<div class="kv" style="font-size:11px; color:var(--muted);"><span>Its readings are merged into ${escHtml(String(SITES[kq][0]))} (same well, other agency); this button acts on that merged well.</span></div>` : '')
    : '';
  return `<div class="pop">
    <h6>${id}</h6>
    <div class="kv"><span>Source</span><span>${src}</span></div>
    ${nmbgmrOfOther.has(s) ? `<div class="kv" style="background:var(--accent-soft); border-radius:4px; padding:2px 4px;"><span><b>NMBGMR site ID</b></span><span><b>${nmbgmrOfOther.get(s).id}</b>${nmbgmrOfOther.get(s).alt ? ' (alt. ID '+nmbgmrOfOther.get(s).alt+')' : ''}</span></div>` : ''}
    ${(clusterPeers.has(s) && !nmbgmrOfOther.has(s) && !otherOfNmbgmr.has(s)) ? `<div class="kv"><span>Same well at other agencies</span><span>${clusterPeers.get(s).map(o=>(SITES[o][3]>=0?SOURCES[SITES[o][3]]:'')+': '+SITES[o][0]).join('; ')}</span></div>` : ''}
    ${otherOfNmbgmr.has(s) ? `<div class="kv"><span>Also measured by</span><span>${otherOfNmbgmr.get(s).map(o=>o.source+': '+o.id).join('; ')}</span></div>` : ''}
    <div class="kv"><span>Aquifer extent</span><span>${aquiferExtent || '—'}</span></div>
    <div class="kv"><span>Aquifer (USGS, broad)</span><span>${aquifer || '—'}</span></div>
    ${studyAreasTxt ? `<div class="kv"><span>Study area(s)</span><span>${studyAreasTxt}</span></div>` : ''}
    ${formation ? `<div class="kv"><span>Formation</span><span>${formation}</span></div>` : ''}
    <div class="kv"><span>Elevation</span><span>${elev!=null ? elev.toFixed(1)+' ft' : '—'}</span></div>
    <div class="kv"><span>Well depth</span><span>${depth!=null ? depth+' ft' : '—'}</span></div>
    <div class="kv"><span>Record</span><span>${firstYr||'—'}–${lastYr||'—'} (${nrec} readings)</span></div>
    <div class="kv"><span>Depth-to-water range</span><span>${minV!=null?minV+'–'+maxV+' ft':'—'}</span></div>
    <div class="kv"><span>Water-surface elev. range</span><span>${elevRangeTxt}</span></div>
    ${usgsId ? `<div class="kv"><span>USGS site</span><span>${usgsId}</span></div>` : ''}
    ${usgsWaterdataUrl ? `<div class="kv"><span>USGS record</span><span><a href="${usgsWaterdataUrl}" target="_blank" rel="noopener" class="linklike">View on waterdata.usgs.gov ↗</a></span></div>` : ''}
    ${nestedTxt}
    ${hxProdPopup(s)}
    ${hxWtPopup(s)}
    <div class="trend">${trendTxt}</div>
    ${nested ? `<p style="margin:8px 0 0; font-size:11px; color:var(--muted);">Shown slightly spread out on the map — this well shares a physical borehole with ${nested.length-1} other screened interval(s) at the same location.</p>` : ''}
    ${inComposite ? (state.showAllWells ? `<p style="margin:8px 0 0; font-size:11px; color:var(--accent);">This well is drawn in the Wells view below; its line and its row in the list are highlighted.</p>` : `<p style="margin:8px 0 0; font-size:11px; color:var(--accent);">This well is in the current composite — clicking its marker highlights its trend line in the chart below (turns on "Show individual wells" if it's off).</p>`) : ''}
    ${isExcluded ? `<p style="margin:8px 0 0; font-size:11px; color:var(--warn);">Manually excluded from the composite — stays excluded until you draw/pick a new area.</p>` : ''}
    <div id="pop-api-${s}" class="pop-api" style="font-size:12px;"></div>
    <div class="actions">
      <button class="btn" id="pop-toggle-${s}">${inClicked?'Remove from selection':'Add to selection'}</button>
      <button class="btn" id="pop-plot-${s}">Plot this well &amp; export</button>
      ${isMultiAgency(s) ? `<button class="btn" id="pop-link-${s}">Select this + linked well(s) (${linkedPartners(s).length})</button>` : ''}
      ${excludeBtn}
    </div>
  </div>`;
}
function highlightWellFromMap(s){
  if(!state.qualifyingSites.has(s)) return; // nothing to highlight if it's not part of the current composite
  if(!state.showSpaghetti){
    state.showSpaghetti = true;
    document.getElementById('toggle-spaghetti').checked = true;
  }
  state.chartHighlightSite = (state.chartHighlightSite === s) ? null : s;
  if(state.showAllWells && wvApplyHighlight()){ restyleMarkers(); return; }
  renderChart();
}
let markerClickHandled = false;
function onMarkerClick(s, m){
  if(state.drawing) return;
  markerClickHandled = true; setTimeout(()=>{ markerClickHandled = false; }, 0);
  if(document.body.dataset.screen === 'charts'){ highlightWellFromMap(s); return; }   // locator: highlight the line, no popup
  highlightWellFromMap(s);
  showWellPopup(s, m);
}
function showWellPopup(s, m){
  m.bindPopup(popupHtml(s), {closeButton:true}).openPopup();
  setTimeout(()=>{
    if(typeof apiLoadPopup === 'function') apiLoadPopup(s);
    const btn = document.getElementById('pop-toggle-'+s);
    if(btn) btn.addEventListener('click', ()=>{
      if(state.clickSelectedSites.has(s)) state.clickSelectedSites.delete(s);
      else state.clickSelectedSites.add(s);
      recomputeActiveSet();
      m.closePopup();
    });
    const linkBtn = document.getElementById('pop-link-'+s);
    if(linkBtn) linkBtn.addEventListener('click', ()=>{
      state.clickSelectedSites.add(s); linkedPartners(s).forEach(p=>state.clickSelectedSites.add(p));
      recomputeActiveSet(); m.closePopup();
    });
    const plotBtn = document.getElementById('pop-plot-'+s);
    if(plotBtn) plotBtn.addEventListener('click', ()=>{ openSingleWell(s); });
    const exBtn = document.getElementById('pop-exclude-'+s);
    if(exBtn) exBtn.addEventListener('click', ()=>{
      const kq = clusterKeep.has(s) ? clusterKeep.get(s) : s;
      if(state.excludedSites.has(kq)) state.excludedSites.delete(kq);
      else state.excludedSites.add(kq);
      renderChart();
      m.closePopup();
    });
  }, 0);
}

/* -------------------------------------------------------------------- */
/* 9. Filters UI                                                         */
/* -------------------------------------------------------------------- */
function buildSourceList(){
  const wrap = document.getElementById('source-list');
  wrap.innerHTML = '';
  SOURCES.forEach((name, i)=>{
    const count = SITES.reduce((a,r)=> a + (r[3]===i?1:0), 0);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label><input type="checkbox" data-src="${i}" checked>
      <span class="swatch" style="background:${SOURCE_COLORS[i%SOURCE_COLORS.length]}"></span>${name}</label>
      <span class="count">${count.toLocaleString()}</span>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const i = +cb.dataset.src;
      if(cb.checked) state.filters.sources.add(i); else state.filters.sources.delete(i);
      recomputeActiveSet();
    });
  });
}
buildSourceList();

function buildAquiferList(){
  const wrap = document.getElementById('aquifer-list');
  wrap.innerHTML = '';
  const entries = AQUIFER_EXTENT_NAMES.map((name,i)=>({idx:i, name:name.replace(/_/g,' ')}))
    .sort((a,b)=>a.name.localeCompare(b.name));
  entries.push({idx:-1, name:'Outside any mapped extent'});
  entries.forEach(({idx,name})=>{
    const count = SITES.reduce((a,r)=> a + (idx===-1 ? (r[15].length?0:1) : (r[15].includes(idx)?1:0)), 0);
    const color = idx>=0 ? AQUIFER_COLORS[idx % AQUIFER_COLORS.length] : '#9aa39a';
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label><input type="checkbox" data-aq="${idx}" checked>
      <span class="swatch" style="background:${color}"></span>${name}</label>
      <span class="count">${count.toLocaleString()}</span>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const i = +cb.dataset.aq;
      if(cb.checked) state.filters.aquiferExt.add(i); else state.filters.aquiferExt.delete(i);
      recomputeActiveSet();
    });
  });
}
buildAquiferList();

function buildStudyAreaList(){
  const wrap = document.getElementById('studyarea-list');
  wrap.innerHTML = '';
  const entries = STUDY_AREA_NAMES.map((name,i)=>({idx:i, name}))
    .sort((a,b)=>a.name.localeCompare(b.name));
  entries.push({idx:-1, name:'Outside any study area'});
  entries.forEach(({idx,name})=>{
    const count = SITES.reduce((a,r)=> a + ((idx===-1 ? !r[16] || !r[16].length : (r[16]||[]).includes(idx)) ? 1 : 0), 0);
    const color = idx>=0 ? AQUIFER_COLORS[idx % AQUIFER_COLORS.length] : '#9aa39a';
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label><input type="checkbox" data-sa="${idx}" checked>
      <span class="swatch" style="background:${color}"></span>${name}</label>
      <span class="count">${count.toLocaleString()}</span>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const i = +cb.dataset.sa;
      if(cb.checked) state.filters.studyArea.add(i); else state.filters.studyArea.delete(i);
      recomputeActiveSet();
    });
  });
}
buildStudyAreaList();

function toggleAllCheckboxes(targetId){
  const wrap = document.getElementById(targetId);
  const checkboxes = Array.from(wrap.querySelectorAll('input[type=checkbox]'));
  const allChecked = checkboxes.length && checkboxes.every(cb=>cb.checked);
  const newChecked = !allChecked;
  checkboxes.forEach(cb=>cb.checked = newChecked);
  if(targetId === 'source-list'){
    state.filters.sources = newChecked ? new Set(SOURCES.map((_,i)=>i)) : new Set();
  } else if(targetId === 'aquifer-list'){
    state.filters.aquiferExt = newChecked ? new Set([...AQUIFER_EXTENT_NAMES.map((_,i)=>i), -1]) : new Set();
  } else if(targetId === 'studyarea-list'){
    state.filters.studyArea = newChecked ? new Set([...STUDY_AREA_NAMES.map((_,i)=>i), -1]) : new Set();
  }
  recomputeActiveSet();
}
document.querySelectorAll('.toggle-all-btn[data-target]').forEach(btn=>{
  btn.addEventListener('click', ()=> toggleAllCheckboxes(btn.dataset.target));
});

// ---- Formation and USGS principal-aquifer lists (separate filters, each with its own All/None) ----
function buildCatList(listId, attr, entries, onChange){
  // entries: [{idx, name, count}] ; builds rows with checkbox data-<attr>=idx
  const wrap = document.getElementById(listId);
  wrap.innerHTML = '';
  entries.forEach(({idx,name,count})=>{
    const row = document.createElement('div');
    row.className = 'row'; row.dataset.name = name.toLowerCase();
    row.innerHTML = `<label><input type="checkbox" data-${attr}="${idx}" checked>${name}</label><span class="count">${count.toLocaleString()}</span>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change', ()=>{ onChange(+cb.dataset[attr], cb.checked); recomputeActiveSet(); });
  });
}
function buildFormationList(){
  const counts = new Map();
  for(const r of SITES) counts.set(r[13], (counts.get(r[13])||0)+1);
  const entries = FORMATIONS.map((n,i)=>({idx:i, name:n, count:counts.get(i)||0})).sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name));
  entries.push({idx:-1, name:'No formation recorded', count:counts.get(-1)||0});
  buildCatList('formation-list','fm',entries,(i,on)=>{ if(on) state.filters.formation.add(i); else state.filters.formation.delete(i); });
}
function buildUsgsAqList(){
  const counts = new Map();
  for(const r of SITES) counts.set(r[12], (counts.get(r[12])||0)+1);
  const entries = AQUIFERS.map((n,i)=>({idx:i, name:n, count:counts.get(i)||0})).sort((a,b)=>b.count-a.count);
  entries.push({idx:-1, name:'No USGS aquifer recorded', count:counts.get(-1)||0});
  buildCatList('usgsaq-list','ua',entries,(i,on)=>{ if(on) state.filters.usgsAq.add(i); else state.filters.usgsAq.delete(i); });
}
state.filters.formation = new Set([...FORMATIONS.map((_,i)=>i), -1]);
state.filters.usgsAq = new Set([...AQUIFERS.map((_,i)=>i), -1]);
buildFormationList(); buildUsgsAqList();
function filterFormationList(q){
  q = (q||'').trim().toLowerCase();
  document.querySelectorAll('#formation-list .row').forEach(r=>{ r.style.display = (!q || r.dataset.name.includes(q)) ? '' : 'none'; });
}
document.getElementById('formation-search').addEventListener('input', e=> filterFormationList(e.target.value));
document.getElementById('fm-all-btn').addEventListener('click', ()=>{
  // acts on the rows currently shown, so searching "Santa Fe" then All/None selects/clears just those
  const boxes = Array.from(document.querySelectorAll('#formation-list .row')).filter(r=>r.style.display!=='none').map(r=>r.querySelector('input'));
  const allChecked = boxes.length && boxes.every(cb=>cb.checked);
  boxes.forEach(cb=>{ cb.checked = !allChecked; if(cb.checked) state.filters.formation.add(+cb.dataset.fm); else state.filters.formation.delete(+cb.dataset.fm); });
  recomputeActiveSet();
});
document.getElementById('ua-all-btn').addEventListener('click', ()=>{
  const boxes = Array.from(document.querySelectorAll('#usgsaq-list input[type=checkbox]'));
  const allChecked = boxes.every(cb=>cb.checked);
  boxes.forEach(cb=>{ cb.checked = !allChecked; if(cb.checked) state.filters.usgsAq.add(+cb.dataset.ua); else state.filters.usgsAq.delete(+cb.dataset.ua); });
  recomputeActiveSet();
});
// ---- A checkbox filter is only checked when that category actually occurs in the selected area ----
const FILTER_LISTS = [
  {id:'source-list',    attr:'src', key:'sources',    vals:r=> r[3]>=0 ? [r[3]] : []},
  {id:'aquifer-list',   attr:'aq',  key:'aquiferExt', vals:r=> r[15].length ? r[15] : [-1]},
  {id:'studyarea-list', attr:'sa',  key:'studyArea',  vals:r=> (r[16] && r[16].length) ? r[16] : [-1]},
  {id:'formation-list', attr:'fm',  key:'formation',  vals:r=> [r[13]]},
  {id:'usgsaq-list',    attr:'ua',  key:'usgsAq',     vals:r=> [r[12]]}
];
// inArea: Uint8Array over all sites (1 = inside the current area / manual selection, or everything when nothing is selected)
function syncFilterListsToSelection(inArea, hasSel){
  FILTER_LISTS.forEach(L=>{
    const counts = new Map();
    for(let s=0; s<NSITES; s++){
      if(!inArea[s]) continue;
      for(const v of L.vals(SITES[s])) counts.set(v, (counts.get(v)||0)+1);
    }
    const keep = new Set();
    document.querySelectorAll('#'+L.id+' .row').forEach(row=>{
      const cb = row.querySelector('input');
      const idx = +cb.dataset[L.attr];
      const n = counts.get(idx) || 0;
      row.querySelector('.count').textContent = n.toLocaleString();
      row.classList.toggle('absent', hasSel && n === 0);
      cb.checked = hasSel ? n > 0 : true;
      // picking ONE aquifer extent ticks only that extent (overlapping neighbours stay listed with counts, but unticked)
      if(L.key==='aquiferExt' && state.areaSelection && state.areaSelection.exactIdx != null) cb.checked = (idx === state.areaSelection.exactIdx);
      if(cb.checked) keep.add(idx);
    });
    state.filters[L.key] = keep;
  });
}
document.querySelectorAll('[data-clear]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    btn.dataset.clear.split(',').forEach(id=>{
      const el = document.getElementById(id);
      if(el.type === 'checkbox'){ el.checked = false; el.dispatchEvent(new Event('change')); }
      else { el.value = ''; el.dispatchEvent(new Event('input')); }
    });
  });
});
function bindNumField(id, key, parseFn){
  let tmr = null;   // debounced: recompute once typing pauses
  document.getElementById(id).addEventListener('input', e=>{
    const v = e.target.value.trim();
    state.filters[key] = v==='' ? null : parseFn(v);
    clearTimeout(tmr); tmr = setTimeout(recomputeActiveSet, 250);
  });
}
bindNumField('depth-min','depthMin', parseFloat);
bindNumField('depth-max','depthMax', parseFloat);
bindNumField('dtw-min','dtwMin', parseFloat);
bindNumField('dtw-max','dtwMax', parseFloat);
bindNumField('year-min','yearMin', parseInt);
bindNumField('year-max','yearMax', parseInt);
bindNumField('min-years','minYears', parseInt);
document.getElementById('depth-require').addEventListener('change', e=>{
  state.filters.depthRequire = e.target.checked;
  recomputeActiveSet();
});
document.getElementById('reset-filters').addEventListener('click', ()=>{
  state.filters = defaultFilters(); state._selSig = null; if(typeof afterFilterReset==='function') afterFilterReset(); syncMerge();
  document.querySelectorAll('#source-list input[type=checkbox], #aquifer-list input[type=checkbox], #studyarea-list input[type=checkbox], #formation-list input[type=checkbox], #usgsaq-list input[type=checkbox]').forEach(cb=>cb.checked=true);
  ['depth-min','depth-max','dtw-min','dtw-max','year-min','year-max','min-years'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('depth-require').checked=false;
  document.getElementById('formation-search').value=''; filterFormationList('');
  recomputeActiveSet();
});

function passesFilters(s){
  const rec = SITES[s];
  const f = state.filters;
  if(!rec[5] && state.readQ && !readQDefault()) return false;               // no readings left under the reading-quality filters you set
  if(!state._noWin && (state.yearWindow.min != null || state.yearWindow.max != null) && siteNYears[s] === 0) return false;   // _noWin: Compare periods ignores the Period
  if(f.api && !passesApiFilters(s, f.api)) return false;
  if(rec[3]>=0 && !f.sources.has(rec[3])) return false;
  if(f.multiAgency && f.multiAgency !== 'all'){
    const multi = isMultiAgency(s);
    if(clusterDropSet.has(s)) return false;     // its readings are merged into the well that represents its cluster
  }
  {
    const ae = rec[15];
    if(!ae.length){ if(!f.aquiferExt.has(-1)) return false; }
    else if(!ae.some(i=>f.aquiferExt.has(i))) return false;
  }
  {
    const sa = rec[16];
    if(!sa || !sa.length){
      if(!f.studyArea.has(-1)) return false;
    } else if(!sa.some(idx => f.studyArea.has(idx))){
      return false;
    }
  }
  if(f.prod && f.prod !== 'all' && !hxProdPass(s, f.prod)) return false;   // OSE production wells (file 27)
  if(f.wt && f.wt !== 'all' && !hxWtPass(s, f.wt)) return false;            // regional water table (file 34)
  if(f.formation && !f.formation.has(rec[13])) return false;
  if(f.usgsAq && !f.usgsAq.has(rec[12])) return false;
  if(f.formationSearch){
    const fmIdx = rec[13];
    const name = fmIdx>=0 ? FORMATIONS[fmIdx].toLowerCase() : '';
    if(!name.includes(f.formationSearch)) return false;
  }
  const depth = rec[4];
  if(f.depthRequire && depth==null) return false;
  if(depth!=null){
    if(f.depthMin!=null && depth < f.depthMin) return false;
    if(f.depthMax!=null && depth > f.depthMax) return false;
  }
  if(f.dtwMin!=null || f.dtwMax!=null){
    const dtw = siteOwnMean[s]; // season-aware mean observed depth-to-water, ft
    if(isNaN(dtw)) return false;
    if(f.dtwMin!=null && dtw < f.dtwMin) return false;
    if(f.dtwMax!=null && dtw > f.dtwMax) return false;
  }
  const firstYr = rec[6], lastYr = rec[7];
  if(f.yearMin!=null && (lastYr==null || lastYr < f.yearMin)) return false;
  if(f.yearMax!=null && (firstYr==null || firstYr > f.yearMax)) return false;
  if(f.minYears!=null && siteNYears[s] < f.minYears) return false;
  return true;
}

/* -------------------------------------------------------------------- */
/* 10. Area selection (draw / upload / county / huc)                    */
/* -------------------------------------------------------------------- */
let drawPolyline = null, drawVertMarkers = [];
function startDraw(){
  cancelDraw();
  state.drawing = true;
  map.doubleClickZoom.disable();
  document.getElementById('draw-hint').style.display = 'flex';
  document.getElementById('draw-hint-text').textContent = 'Click the map to add vertices · double-click to finish';
  map.getContainer().style.cursor = 'crosshair';
}
function cancelDraw(){
  state.drawing = false;
  map.doubleClickZoom.enable();
  state.drawVerts = [];
  if(drawPolyline){ map.removeLayer(drawPolyline); drawPolyline=null; }
  drawVertMarkers.forEach(m=>map.removeLayer(m));
  drawVertMarkers = [];
  document.getElementById('draw-hint').style.display = 'none';
  map.getContainer().style.cursor = '';
}
function updateDrawLine(){
  if(drawPolyline) map.removeLayer(drawPolyline);
  if(state.drawVerts.length > 1){
    drawPolyline = L.polygon(state.drawVerts, {pane:'selPane', color:'#0f6e63', weight:2, fillOpacity:0.08, dashArray:'5,5'}).addTo(map);
  }
}
map.on('click', e=>{
  if(!state.drawing) return;
  state.drawVerts.push([e.latlng.lat, e.latlng.lng]);
  const vm = L.circleMarker(e.latlng, {pane:'selPane', radius:4, color:'#0f6e63', weight:2, fillColor:'#fff', fillOpacity:1}).addTo(map);
  drawVertMarkers.push(vm);
  updateDrawLine();
});
map.on('dblclick', e=>{
  if(!state.drawing) return;
  finishDraw();
});
function finishDraw(){
  // a double-click also fires two clicks: drop repeated vertices before counting
  state.drawVerts = state.drawVerts.filter((v,i,a)=> i === 0 || Math.abs(v[0]-a[i-1][0]) > 1e-9 || Math.abs(v[1]-a[i-1][1]) > 1e-9);
  if(state.drawVerts.length < 3){ toast('Add at least 3 points to make a polygon.'); return; }
  const ring = state.drawVerts.map(([lat,lng])=>[lng,lat]);
  ring.push(ring[0]);
  setAreaSelection({type:'polygon', polygons:[[ring]], label:`Drawn polygon (${state.drawVerts.length} pts)`});
  cancelDraw();
}
document.getElementById('draw-finish').addEventListener('click', finishDraw);
document.getElementById('draw-cancel').addEventListener('click', cancelDraw);
document.getElementById('btn-draw').addEventListener('click', ()=>{
  document.querySelector('.tab-btn[data-tab="select"]').click();
  startDraw();
});

document.getElementById('btn-upload').addEventListener('click', ()=>document.getElementById('file-upload-input').click());
document.getElementById('file-upload-input').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ev=>{
    try{
      const gj = JSON.parse(ev.target.result);
      const polys = extractPolygonsFromGeoJSON(gj);
      if(!polys.length){ toast('No polygon geometry found in that file.'); return; }
      setAreaSelection({type:'upload', polygons:polys, label:`Uploaded: ${file.name}`});
      toast(`Loaded ${polys.length} polygon(s) from ${file.name}`);
    }catch(err){
      toast('Could not parse that file as GeoJSON.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});
function extractPolygonsFromGeoJSON(gj){
  const out = [];
  function addGeom(geom){
    if(!geom) return;
    if(geom.type === 'Polygon') out.push(geom.coordinates);
    else if(geom.type === 'MultiPolygon') geom.coordinates.forEach(c=>out.push(c));
    else if(geom.type === 'GeometryCollection') (geom.geometries||[]).forEach(addGeom);
  }
  if(gj.type === 'FeatureCollection') (gj.features||[]).forEach(f=>addGeom(f.geometry));
  else if(gj.type === 'Feature') addGeom(gj.geometry);
  else addGeom(gj);
  return out;
}

function setAreaSelection(sel){
  state.areaSelection = sel;
  state.clickSelectedSites.clear(); // starting a fresh area selection shouldn't drag along old individually-clicked wells
  state.excludedSites.clear(); // manual exclusions only persist until a new area selection is made
  areaLayer.clearLayers();
  const gjPolys = sel.polygons.map(rings => ({type:'Polygon', coordinates:rings}));
  gjPolys.forEach(g=>{
    L.geoJSON(g, {pane:'selPane', style:{color:'#0f6e63', weight:2, fillOpacity:0.06}}).addTo(areaLayer);
  });
  if(!map.hasLayer(areaLayer)) areaLayer.addTo(map);
  recomputeActiveSet();
  fitAreaBounds();
}
function fitAreaBounds(){
  try{
    const b = areaLayer.getBounds();
    if(b.isValid()) map.fitBounds(b, {padding:[40,40]});
  }catch(e){}
}
document.getElementById('btn-clear-selection').addEventListener('click', ()=>resetEverything(false));
document.getElementById('btn-reset-settings').addEventListener('click', ()=>resetEverything(true));

function resetEverything(keepArea){
  state.statewideOk = false;   // the Wells / Composite view is not a setting: Reset keeps it
  // area + manual selection (kept when only the settings/filters are being reset)
  state.excludedSites.clear();
  state.chartHighlightSite = null;
  if(!keepArea){
    state.areaSelection = null;
    state.clickSelectedSites.clear();
    areaLayer.clearLayers();
    document.querySelectorAll('.pickitem.sel').forEach(el=>el.classList.remove('sel'));
    document.getElementById('county-select').value = '';
    document.getElementById('huc-select').value = '';
    document.getElementById('ose-select').value = '';
    { const s10 = document.getElementById('huc10-select'); s10.value = ''; s10.disabled = true; s10.innerHTML = '<option value="">Choose a HUC‑8 first</option>'; }
    document.getElementById('aquext-select').value = '';
    document.getElementById('studyarea-select').value = '';
  }

  // filters back to defaults
  state.filters = defaultFilters(); state._selSig = null; if(typeof afterFilterReset==='function') afterFilterReset(); syncMerge();
  document.querySelectorAll('#source-list input[type=checkbox], #aquifer-list input[type=checkbox], #studyarea-list input[type=checkbox], #formation-list input[type=checkbox], #usgsaq-list input[type=checkbox]').forEach(cb=>cb.checked=true);
  ['depth-min','depth-max','dtw-min','dtw-max','year-min','year-max','min-years'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('depth-require').checked=false;
  document.getElementById('formation-search').value=''; filterFormationList('');

  // composite hydrograph controls back to defaults
  state.otp = otDefaults(); syncOtUi();
  state.group = { mode:'off', n:3, breaks:null };
  document.getElementById('group-mode').value = 'off'; document.getElementById('group-n').value = '3'; document.getElementById('group-n').disabled = false;
  document.getElementById('group-breaks').value = ''; document.getElementById('group-options').classList.add('hidden');
  state.normalize = false;
  state.normalizeStyle = 'ft'; document.getElementById('normalize-style').value = 'ft';
  state.waterYear = true; document.getElementById('toggle-wateryear').checked = true;
  document.getElementById('toggle-normalize').checked = false;
  state.showSpaghetti = false;
  document.getElementById('spaghetti-cap').value = 500;
  document.getElementById('toggle-spaghetti').checked = false;
  state.showBand = true;
  document.getElementById('toggle-band').checked = true;
  state.valueMode = 'depth';
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.toggle('active', b.dataset.valuemode==='depth'));
  document.getElementById('elev-mode-hint').style.display = 'none';
  document.getElementById('dem-row').style.display = 'none'; state.useDem = true; document.getElementById('dem-source').value = 'dem'; demApply();

  state.season = { monthStart:1, monthEnd:12 };
  document.querySelectorAll('.season-btn').forEach(b=>b.classList.toggle('active', b.dataset.ms==='1' && b.dataset.me==='12'));
  document.getElementById('season-month-start').value = '1';
  document.getElementById('season-month-end').value = '12';
  recomputeTrendAndMean();

  state.seasonCompare = { enabled:false, keys:new Set(['winter','summer']) };
  document.getElementById('toggle-season-compare').checked = false;
  document.getElementById('season-compare-options').classList.add('hidden');
  document.getElementById('season-primary-lock-hint').classList.add('hidden');
  document.querySelectorAll('.season-btn').forEach(el=>{ el.disabled = false; });
  document.getElementById('season-month-start').disabled = false;
  document.getElementById('season-month-end').disabled = false;
  document.querySelectorAll('.season-compare-cb').forEach(cb=>{
    cb.checked = (cb.dataset.key==='winter' || cb.dataset.key==='summer');
  });

  state.yearWindow = { min:null, max:null };
  document.getElementById('yw-min').value = ''; document.getElementById('yw-max').value = '';
  document.getElementById('yw-note').textContent = '';
  state.despike = { enabled:true, threshold:0.6 };
  document.getElementById('toggle-despike').checked = true;
  document.querySelectorAll('.despike-btn').forEach(b=>b.classList.toggle('active', b.dataset.thresh==='0.6'));
  recomputeTrendAndMean();
  recomputeAllDespikeFlags();
  renderFlagsTable();
  document.getElementById('flags-modal').classList.add('hidden');

  try{ hxExtrasReset(); }catch(e){}
  recomputeActiveSet();
  updateAccSummaries();
  toast(keepArea ? 'Hydrograph settings and filters reset (your selected area was kept).' : 'Selection and all filters reset.');
}

/* -------------------------------------------------------------------- */
/* 11. Recompute active site set                                         */
/* -------------------------------------------------------------------- */
function recomputeActiveSet(){
  const set = new Set();
  const sel = state.areaSelection;
  // 1. which wells are inside the area (or manually clicked)? Independent of the checkbox filters.
  const hasSel = !!(sel || state.clickSelectedSites.size);
  let inArea;
  if(!sel){ inArea = new Uint8Array(NSITES).fill(hasSel ? 0 : 1); }
  else if(state._inAreaFor === sel && state._inAreaBase){ inArea = Uint8Array.from(state._inAreaBase); }   // area unchanged: reuse
  else {
    inArea = new Uint8Array(NSITES);
    for(let s=0; s<NSITES; s++){
      if(!sel){ inArea[s] = hasSel ? 0 : 1; continue; }
      const rec = SITES[s];
      if(sel.exactIdx != null) inArea[s] = rec[15].includes(sel.exactIdx) ? 1 : 0; // precomputed containment, more precise than a runtime test against the simplified display boundary
      else inArea[s] = pointInPolygons(rec[1], rec[2], sel.polygons) ? 1 : 0;
    }
    state._inAreaFor = sel; state._inAreaBase = Uint8Array.from(inArea);
  }

  state.clickSelectedSites.forEach(s=>{ inArea[s] = 1; });
  // 2. when the selection itself changed, re-tick every filter list to just what exists in it
  const sig = (sel ? (sel.type||'')+'|'+(sel.label||'') : '') + '#' + [...state.clickSelectedSites].join(',');
  if(sig !== state._selSig){ state._selSig = sig; syncFilterListsToSelection(inArea, hasSel); }
  // 3. apply the filters
  for(let s=0; s<NSITES; s++){
    if(!inArea[s]) continue;
    if(!passesFilters(s)) continue;
    set.add(s);
  }
  // union in manually clicked wells regardless of area (but still respect data filters lightly? keep as pure additive)
  state.clickSelectedSites.forEach(s=>set.add(s));
  { let hh = 2166136261 >>> 0; set.forEach(s=>{ hh = Math.imul(hh ^ s, 16777619) >>> 0; }); set._key = set.size + ':' + hh; }   // content key for the composite cache
  state.activeSet = set;
  if(state.useDem && state.valueMode === 'elevation') setTimeout(demEnsure, 0);
  setTimeout(krigUpdate, 0);
  restyleMarkers();
  updateSelectionSummary();
  refreshScheduleUI();
  renderChart();
}

function updateSelectionSummary(){
  const set = state.activeSet;
  const n = set.size;
  document.getElementById('sel-count').textContent = n.toLocaleString();
  document.getElementById('selcount-pill').style.display = (state.areaSelection || state.clickSelectedSites.size) ? 'flex' : 'none';
  document.getElementById('selcount-pill').innerHTML = `<b>${n.toLocaleString()}</b>&nbsp;selected`;
  if(n===0){
    document.getElementById('sel-depth-pct').textContent = '–';
    document.getElementById('sel-years-med').textContent = '–';
    return;
  }
  let withDepth=0; const yearsArr=[];
  set.forEach(s=>{
    if(SITES[s][4]!=null) withDepth++;
    yearsArr.push(siteNYears[s]);
  });
  yearsArr.sort((a,b)=>a-b);
  const med = yearsArr[Math.floor(yearsArr.length/2)];
  document.getElementById('sel-depth-pct').textContent = Math.round(100*withDepth/n)+'%';
  document.getElementById('sel-years-med').textContent = med + ' yrs';
}

/* -------------------------------------------------------------------- */
/* 12. Layers tab controls                                               */
/* -------------------------------------------------------------------- */
document.getElementById('layer-wells').addEventListener('change', e=>{
  if(e.target.checked) wellsLayer.addTo(map); else map.removeLayer(wellsLayer);
});
document.getElementById('layer-onlysel').addEventListener('change', e=>{ state.onlySelected = e.target.checked; restyleMarkers(); });
document.getElementById('layer-multi').addEventListener('change', e=>{
  state.showMultiRings = e.target.checked;
  if(e.target.checked) multiLayer.addTo(map); else map.removeLayer(multiLayer);
  renderLegend();
});
document.getElementById('colorby-select').addEventListener('change', e=>{
  state.colorBy = e.target.value;
  restyleMarkers();
  renderLegend();
  if(state.colorBy.startsWith('api:')) apiSelectLayer(state.colorBy.slice(4));
});
document.getElementById('layer-counties').addEventListener('change', e=>{
  if(e.target.checked) countiesLayer.addTo(map); else map.removeLayer(countiesLayer);
});
document.getElementById('layer-krigmap').addEventListener('change', e=>{
  h12State.level = e.target.value; h12State.on = h12State.level !== 'off';
  if(h12State.layer){ map.removeLayer(h12State.layer); h12State.layer = null; } h12State.featsFor = null; h12State.feats = null; h12State.units = null;
  if(h12State.on){ h12Panel(); syncH12(); }
  else { if(h12State.timer){ clearInterval(h12State.timer); h12State.timer = null; } if(h12State.ctl){ map.removeControl(h12State.ctl); h12State.ctl = null; } }
});
document.getElementById('layer-ose').addEventListener('change', e=>{ if(e.target.checked) oseLayer.addTo(map); else map.removeLayer(oseLayer); });
document.getElementById('ose-select').addEventListener('change', e=>{ if(e.target.value === '') return; selectOse(e.target.value); });
document.getElementById('layer-huc').addEventListener('change', e=>{
  if(e.target.checked) hucLayer.addTo(map); else map.removeLayer(hucLayer);
});
document.getElementById('layer-aquext').addEventListener('change', e=>{
  if(e.target.checked) aquiferExtentLayer.addTo(map); else map.removeLayer(aquiferExtentLayer);
});
document.getElementById('layer-studyareas').addEventListener('change', e=>{
  if(e.target.checked) studyAreaLayer.addTo(map); else map.removeLayer(studyAreaLayer);
});

function renderLegend(){
  const body = document.getElementById('legend-body');
  let rows = [];
  if(state.colorBy === 'ptrend'){
    rows = hxPtmLegend();
  } else if(state.colorBy === 'wtres'){
    rows = hxWtLegend();
  } else if(state.colorBy.startsWith('api:')){
    rows = apiLegendRows();
  } else if(state.colorBy === 'source'){
    rows = SOURCES.map((name,i)=>`<div class="lg-row"><span class="swatch" style="background:${SOURCE_COLORS[i%SOURCE_COLORS.length]}"></span><span class="k">${name}</span></div>`);
  } else if(state.colorBy === 'aquifer'){
    rows = AQUIFERS.map((name,i)=>`<div class="lg-row"><span class="swatch" style="background:${AQUIFER_COLORS[i%AQUIFER_COLORS.length]}"></span><span class="k">${name}</span></div>`);
    rows.push(`<div class="lg-row"><span class="swatch" style="background:#9aa39a"></span><span class="k">Unknown</span></div>`);
  } else if(state.colorBy === 'overlap'){
    rows = [
      `<div class="lg-row"><span class="swatch" style="background:#a23fb5"></span><span class="k">In 2+ overlapping aquifer extents</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#2f7fc1"></span><span class="k">In one aquifer extent</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#9aa39a"></span><span class="k">Outside mapped extents</span></div>`
    ];
  } else if(state.colorBy === 'multi'){
    rows = [
      `<div class="lg-row"><span class="swatch" style="background:#a23fb5"></span><span class="k">Measured by NMBGMR + another agency</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#9aa39a"></span><span class="k">Single agency</span></div>`
    ];
  } else if(state.colorBy === 'trend'){
    rows = [
      `<div class="lg-row"><span class="swatch" style="background:#c1652f"></span><span class="k">Declining water table</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#9aa39a"></span><span class="k">Roughly stable</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#2f7fc1"></span><span class="k">Recovering</span></div>`
    ];
  } else if(state.colorBy === 'recency'){
    rows = [
      `<div class="lg-row"><span class="swatch" style="background:#0f6e63"></span><span class="k">2020–present</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#5a9c8c"></span><span class="k">2010–2019</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#c9a227"></span><span class="k">2000–2009</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#c1652f"></span><span class="k">Before 2000</span></div>`
    ];
  } else if(state.colorBy === 'depth'){
    rows = [
      `<div class="lg-row"><span class="swatch" style="background:#2f7fc1"></span><span class="k">&lt; 100 ft</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#5a9c8c"></span><span class="k">100–300 ft</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#c9a227"></span><span class="k">300–600 ft</span></div>`,
      `<div class="lg-row"><span class="swatch" style="background:#c1652f"></span><span class="k">&gt; 600 ft</span></div>`
    ];
  }
  if(state.showMultiRings) rows.push(`<div class="lg-row" style="margin-top:6px; padding-top:6px; border-top:1px dashed var(--border);"><span class="swatch" style="background:transparent; border:2px dashed #a23fb5; border-radius:50%;"></span><span class="k">Multi-agency well (purple ring)</span></div>`);
  rows.push(`<div class="lg-row" style="margin-top:6px; padding-top:6px; border-top:1px dashed var(--border);"><span class="swatch" style="background:transparent; border:2px solid var(--accent);"></span><span class="k">Used in composite</span></div>`);
  rows.push(`<div class="lg-row"><span class="swatch" style="background:transparent; border:2px solid #c1652f;"></span><span class="k">Manually excluded</span></div>`);
  rows.push(`<div class="lg-row"><span class="swatch" style="background:transparent; border:2px solid #ffd23f;"></span><span class="k">Manually selected</span></div>`);
  rows.push(`<div class="lg-row"><span class="swatch" style="background:transparent; border:2px solid #e0455c;"></span><span class="k">Highlighted from chart</span></div>`);
  body.innerHTML = rows.join('');
}

/* -------------------------------------------------------------------- */
/* 13. Live reference layers: counties + HUC-8                          */
/* -------------------------------------------------------------------- */
const COUNTY_URL = 'https://services3.arcgis.com/btGPJYeJkAc5Bpuh/ArcGIS/rest/services/Counties/FeatureServer/0/query?where=1%3D1&outFields=NAME,GEOID&outSR=4326&f=geojson&geometryPrecision=4';
const HUC8_URL = "https://hydrowfs.nationalmap.gov/arcgis/rest/services/wbd/MapServer/4/query?where=states+LIKE+'%25NM%25'&outFields=huc8,name,states&outSR=4326&f=geojson&geometryPrecision=4";

let countyFeatures = [];
let hucFeatures = [];
let oseFeatures = [];
const oseLayer = L.layerGroup();
const OSE_URL = 'https://services2.arcgis.com/qXZbWTdPDbTjl7Dy/ArcGIS/rest/services/DeclaredGroundwaterBasins/FeatureServer/0/query?where=1%3D1&outFields=Basin&outSR=4326&geometryPrecision=4&f=geojson';
const oseSlug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
(async () => {
  let gj = null;
  try{ const r = await fetch(OSE_URL); if(r.ok){ const j = await r.json(); if(j && j.features && j.features.length) gj = j; } }catch(e){}
  if(!gj){ try{ const base = await krigBase(); if(base){ const r = await fetch(base + 'ose_basins.geojson'); if(r.ok) gj = await r.json(); } }catch(e){} }
  const sel = document.getElementById('ose-select');
  if(!gj){ sel.innerHTML = '<option value="">Unavailable — check connection</option>'; document.getElementById('ose-hint').textContent = 'Could not reach the OSE basin service.'; return; }
  oseFeatures = gj.features.filter(f => f.properties && f.properties.Basin).sort((a,b) => a.properties.Basin.localeCompare(b.properties.Basin));
  oseFeatures.forEach(f => L.geoJSON(f, {pane:'refPane', interactive:false, style:{color:'#8a5a2b', weight:1.2, fillOpacity:0, dashArray:'5,3'}}).addTo(oseLayer));
  sel.innerHTML = '<option value="">Choose an OSE basin…</option>' + oseFeatures.map((f,i) => `<option value="${i}">${escHtml(f.properties.Basin)}</option>`).join('');
})();
function selectOse(i){
  const f = oseFeatures[+i];
  setAreaSelection({type:'ose', polygons:extractPolygonsFromGeoJSON(f), label:'OSE basin: '+f.properties.Basin, huc:oseSlug(f.properties.Basin)});
}

fetch(COUNTY_URL).then(r=>r.json()).then(gj=>{
  countyFeatures = (gj.features||[]).sort((a,b)=> (a.properties.NAME||'').localeCompare(b.properties.NAME||''));
  countyFeatures.forEach(f=>{
    L.geoJSON(f, {pane:'refPane', interactive:false, style:{color:'#7d8873', weight:1, fillOpacity:0, dashArray:'2,3'}}).addTo(countiesLayer);
  });
  const sel = document.getElementById('county-select');
  sel.innerHTML = '<option value="">Choose a county…</option>' + countyFeatures.map((f,i)=>`<option value="${i}">${f.properties.NAME}</option>`).join('');
  document.getElementById('county-hint').textContent = `${countyFeatures.length} counties loaded.`;
}).catch(()=>{
  document.getElementById('county-select').innerHTML = '<option value="">Unavailable — check connection</option>';
  document.getElementById('county-hint').textContent = 'Could not reach the county boundary service. Selection by drawn/uploaded polygon still works.';
});

fetch(HUC8_URL).then(r=>r.json()).then(gj=>{
  hucFeatures = (gj.features||[]).sort((a,b)=> (a.properties.name||'').localeCompare(b.properties.name||''));
  hucFeatures.forEach(f=>{
    L.geoJSON(f, {pane:'refPane', interactive:false, style:{color:'#5a8f8c', weight:1, fillOpacity:0, dashArray:'2,3'}}).addTo(hucLayer);
  });
  const sel = document.getElementById('huc-select');
  sel.innerHTML = '<option value="">Choose a HUC‑8…</option>' + hucFeatures.map((f,i)=>`<option value="${i}">${escHtml(f.properties.name)} (${escHtml(f.properties.huc8)})</option>`).join('');
}).catch(()=>{
  document.getElementById('huc-select').innerHTML = '<option value="">Unavailable — check connection</option>';
});

// Aquifer extents and study-area boundaries are embedded (no fetch needed) — build once at load.
// Each of the 59 extents gets its own color, spread evenly around the hue wheel, so adjacent or
// overlapping extents are actually distinguishable — a single flat color was useless here.
function hueSpreadColor(i, total, sat, light){
  // Golden-angle stepping (not a plain linear 360/total step) so that consecutive indices land
  // far apart on the hue wheel — alphabetically-adjacent extent names are sometimes geographically
  // adjacent too, and a linear step would give those neighbors nearly identical colors.
  const hue = Math.round((i * 137.508) % 360);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}
const AQUIFER_EXTENT_MAP_COLORS = AQUIFER_EXTENT_NAMES.map((_,i)=> hueSpreadColor(i, AQUIFER_EXTENT_NAMES.length, 68, 42));
AQUIFER_EXTENT_NAMES.forEach((name, idx)=>{
  const color = AQUIFER_EXTENT_MAP_COLORS[idx];
  AQUIFER_EXTENT_POLYGONS[idx].forEach(rings=>{
    // interactive:false — with the canvas renderer the top (wells) canvas swallows every mouse event,
    // so per-layer popups/tooltips can never fire. Names come from the map-level identify below instead.
    L.geoJSON({type:'Polygon', coordinates:rings}, {pane:'refPane', interactive:false,
      style:{color, weight:1.5, fillColor:color, fillOpacity:0.18}}).addTo(aquiferExtentLayer);
  });
});
STUDY_AREAS.forEach(sa=>{
  sa.polys.forEach(rings=>{
    L.geoJSON({type:'Polygon', coordinates:rings}, {pane:'refPane', interactive:false,
      style:{color: sa.status==='Ongoing' ? '#c9a227' : '#0f6e63', weight:1.2, fillOpacity:0.04, dashArray:'4,3'}}).addTo(studyAreaLayer);
  });
});

/* -------------------------------------------------------------------- */
/* Identify: which boundary layers are under the cursor / click          */
/* -------------------------------------------------------------------- */
function ringBBox(r){ let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity; for(const p of r){ if(p[0]<a)a=p[0]; if(p[0]>c)c=p[0]; if(p[1]<b)b=p[1]; if(p[1]>d)d=p[1]; } return [a,b,c,d]; }
function piecesFromPolys(polys){ return polys.map(rings=>({rings, bbox:ringBBox(rings[0])})); }
function piecesFromGeom(g){
  const polys = !g ? [] : g.type==='Polygon' ? [g.coordinates] : g.type==='MultiPolygon' ? g.coordinates : [];
  return piecesFromPolys(polys);
}
function pointInPieces(lng, lat, pieces){
  for(const p of pieces){
    const b = p.bbox;
    if(lng<b[0] || lng>b[2] || lat<b[1] || lat>b[3]) continue;
    if(pointInRing(lng, lat, p.rings[0]) && !p.rings.slice(1).some(h=>pointInRing(lng, lat, h))) return true;
  }
  return false;
}
const IDENT_EXTENTS = AQUIFER_EXTENT_POLYGONS.map(piecesFromPolys);
const IDENT_STUDY = STUDY_AREAS.map(sa=>piecesFromPolys(sa.polys));
function identifyAt(latlng){
  const lng = latlng.lng, lat = latlng.lat;
  const out = {extents:[], studies:[], county:-1, huc:-1, ose:-1, h12:-1};
  if(map.hasLayer(aquiferExtentLayer)) IDENT_EXTENTS.forEach((pcs,i)=>{ if(pointInPieces(lng,lat,pcs)) out.extents.push(i); });
  if(map.hasLayer(studyAreaLayer)) IDENT_STUDY.forEach((pcs,i)=>{ if(pointInPieces(lng,lat,pcs)) out.studies.push(i); });
  if(map.hasLayer(countiesLayer)) out.county = countyFeatures.findIndex(f=> pointInPieces(lng,lat,(f._pieces||(f._pieces=piecesFromGeom(f.geometry)))));
  if(h12State.on && h12State.feats){ out.h12 = h12State.feats.findIndex(x=> pointInPieces(lng,lat,(x.f._pieces||(x.f._pieces=piecesFromGeom(x.f.geometry))))); }
  if(map.hasLayer(oseLayer)) out.ose = oseFeatures.findIndex(f=> pointInPieces(lng,lat,(f._pieces||(f._pieces=piecesFromGeom(f.geometry)))));
  if(map.hasLayer(hucLayer)) out.huc = hucFeatures.findIndex(f=> pointInPieces(lng,lat,(f._pieces||(f._pieces=piecesFromGeom(f.geometry)))));
  return out;
}
function identifyIsEmpty(h){ return !h.extents.length && !h.studies.length && h.county<0 && h.huc<0 && h.ose<0 && h.h12<0; }
const anyIdentifyLayerOn = ()=> [aquiferExtentLayer, studyAreaLayer, countiesLayer, hucLayer, oseLayer].some(l=>map.hasLayer(l)) || h12State.on;

function identifyPopupContent(h){
  const root = document.createElement('div'); root.className = 'pop identify';
  const head = t=>{ const d=document.createElement('div'); d.className='ident-h'; d.textContent=t; root.appendChild(d); };
  const row = (color, label, sub, onSelect, link)=>{
    const r=document.createElement('div'); r.className='ident-row';
    if(color){ const sw=document.createElement('span'); sw.className='swatch'; sw.style.background=color; r.appendChild(sw); }
    const nm=document.createElement('span'); nm.className='ident-name'; nm.textContent=label;
    if(sub){ const s=document.createElement('small'); s.textContent=' '+sub; nm.appendChild(s); }
    r.appendChild(nm);
    if(link){ const a=document.createElement('a'); a.href=link; a.target='_blank'; a.rel='noopener'; a.className='linklike'; a.textContent='info ↗'; a.style.fontSize='11px'; r.appendChild(a); }
    const b=document.createElement('button'); b.className='btn'; b.textContent='Select';
    b.addEventListener('click', ()=>{ onSelect(); map.closePopup(); });
    r.appendChild(b); root.appendChild(r);
  };
  if(h.extents.length){
    head(h.extents.length>1 ? 'Aquifer extents here ('+h.extents.length+')' : 'Aquifer extent');
    h.extents.forEach(i=> row(AQUIFER_EXTENT_MAP_COLORS[i], AQUIFER_EXTENT_NAMES[i].replace(/_/g,' '), '', ()=>{
      setAreaSelection({type:'aquiferExtent', polygons:AQUIFER_EXTENT_POLYGONS[i], exactIdx:i, label:'Aquifer extent: '+AQUIFER_EXTENT_NAMES[i]});
      document.getElementById('aquext-select').value = String(i);
    }));
  }
  if(h.studies.length){
    head(h.studies.length>1 ? 'Study areas here ('+h.studies.length+')' : 'Aquifer mapping study area');
    h.studies.forEach(i=>{
      const sa = STUDY_AREAS[i];
      const yrs = (sa.startYear||sa.endYear) ? '('+(sa.startYear||'?')+'–'+(sa.endYear||'ongoing')+(sa.status?', '+sa.status.toLowerCase():'')+')' : (sa.status?'('+sa.status.toLowerCase()+')':'');
      row(sa.status==='Ongoing' ? '#c9a227' : '#0f6e63', sa.name, yrs, ()=>{
        setAreaSelection({type:'studyarea', polygons:sa.polys, label:'Study area: '+sa.name});
        document.getElementById('studyarea-select').value = String(i);
      }, sa.link);
    });
  }
  if(h.county>=0){
    const f = countyFeatures[h.county]; head('County');
    row('#7d8873', f.properties.NAME, '', ()=>{
      setAreaSelection({type:'county', polygons:extractPolygonsFromGeoJSON(f), label:'County: '+f.properties.NAME});
      document.getElementById('county-select').value = String(h.county);
    });
  }
  if(h.h12>=0){
    const x = h12State.feats[h.h12]; head(KM_LABEL[h12State.level] + ' (kriged)');
    row('#8b5cf6', x.name, (h12State.level === 'ose' ? '' : '(' + x.code + ') ') + h12Text(x.code), ()=> kmSelect(x));
  }
  if(h.ose>=0){
    const f = oseFeatures[h.ose]; head('OSE groundwater basin');
    row('#8a5a2b', f.properties.Basin, '', ()=>{ document.getElementById('ose-select').value = String(h.ose); selectOse(h.ose); });
  }
  if(h.huc>=0){
    const f = hucFeatures[h.huc]; head('HUC-8 subbasin');
    row('#5a8f8c', f.properties.name, '('+f.properties.huc8+')', ()=>{
      document.getElementById('huc-select').value = String(h.huc);
      selectHuc8(h.huc);
    });
  }
  return root;
}
// Click: a well's own click fires first and sets the flag, so a click on a well never also opens this.
map.on('click', e=>{
  if(state.drawing) return;
  if(markerClickHandled){ markerClickHandled = false; return; }
  if(!anyIdentifyLayerOn()) return;
  const h = identifyAt(e.latlng);
  if(identifyIsEmpty(h)) return;
  L.popup({maxWidth:340, className:'identify-popup'}).setLatLng(e.latlng).setContent(identifyPopupContent(h)).openOn(map);
});
// Hover readout: names under the cursor without needing to click (throttled).
(function(){
  const box = document.getElementById('hover-readout');
  let last = 0;
  map.on('mousemove', e=>{
    const now = performance.now();
    if(now-last < 70) return; last = now;
    if(state.drawing || !anyIdentifyLayerOn()){ box.classList.add('hidden'); return; }
    const h = identifyAt(e.latlng);
    if(identifyIsEmpty(h)){ box.classList.add('hidden'); return; }
    const parts = [];
    if(h.extents.length) parts.push('<b>Aquifer extent:</b> '+h.extents.map(i=>AQUIFER_EXTENT_NAMES[i].replace(/_/g,' ')).join(' · '));
    if(h.studies.length) parts.push('<b>Study area:</b> '+h.studies.map(i=>STUDY_AREAS[i].name).join(' · '));
    if(h.county>=0) parts.push('<b>County:</b> '+countyFeatures[h.county].properties.NAME);
    if(h.h12>=0){ const x = h12State.feats[h.h12]; parts.push('<b>' + KM_LABEL[h12State.level] + ':</b> ' + escHtml(x.name) + ' ' + escHtml(h12Text(x.code))); }
    if(h.ose>=0) parts.push('<b>OSE basin:</b> '+escHtml(oseFeatures[h.ose].properties.Basin));
    if(h.huc>=0) parts.push('<b>HUC-8:</b> '+hucFeatures[h.huc].properties.name);
    box.innerHTML = parts.join('<br>'); box.classList.remove('hidden');
  });
  map.on('mouseout', ()=> box.classList.add('hidden'));
})();

document.getElementById('county-select').addEventListener('change', e=>{
  const i = e.target.value;
  if(i==='') return;
  const f = countyFeatures[+i];
  const polys = extractPolygonsFromGeoJSON(f);
  setAreaSelection({type:'county', polygons:polys, label:'County: '+f.properties.NAME});
});
function selectHuc8(i){
  const f = hucFeatures[+i];
  const polys = extractPolygonsFromGeoJSON(f);
  setAreaSelection({type:'huc', polygons:polys, label:'HUC-8: '+f.properties.name, huc:String(f.properties.huc8)});
  loadHuc10List(String(f.properties.huc8));
}
document.getElementById('huc-select').addEventListener('change', e=>{
  const i = e.target.value;
  if(i==='') return;
  selectHuc8(i);
});
/* ---- HUC-10s of the chosen HUC-8 (file next to the page first, else live from USGS WBD) ---- */
let huc10Features = [];
async function loadHuc10List(h8){
  const sel = document.getElementById('huc10-select'), hint = document.getElementById('huc10-hint');
  sel.disabled = true; sel.innerHTML = '<option value="">Loading HUC‑10s…</option>';
  let gj = null;
  try{ const base = await krigBase(); if(base){ if(!window._huc10All){ const r = await fetch(base + 'huc10.geojson'); if(r.ok) window._huc10All = await r.json(); } if(window._huc10All) gj = {features: window._huc10All.features.filter(f => String(f.properties.huc10).startsWith(h8))}; } }catch(e){}
  if(!gj){
    try{ const r = await fetch("https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer/5/query?where=huc10+LIKE+'" + h8 + "%25'&outFields=huc10,name&outSR=4326&f=geojson&geometryPrecision=5"); if(r.ok) gj = await r.json(); }catch(e){}
  }
  huc10Features = ((gj && gj.features) || []).sort((a,b)=> String(a.properties.name||'').localeCompare(String(b.properties.name||'')));
  if(!huc10Features.length){ sel.innerHTML = '<option value="">Unavailable — check connection</option>'; hint.textContent = 'Could not load the HUC‑10 boundaries.'; return; }
  sel.innerHTML = '<option value="">Choose a HUC‑10…</option>' + huc10Features.map((f,i)=>`<option value="${i}">${escHtml(f.properties.name)} (${escHtml(f.properties.huc10)})</option>`).join('');
  sel.disabled = false; hint.textContent = `${huc10Features.length} HUC‑10 watersheds in this HUC‑8.`;
}
document.getElementById('huc10-select').addEventListener('change', e=>{
  const i = e.target.value; if(i==='') return;
  const f = huc10Features[+i];
  setAreaSelection({type:'huc10', polygons:extractPolygonsFromGeoJSON(f), label:'HUC-10: '+f.properties.name, huc:String(f.properties.huc10)});
});

// Aquifer extent picker — data is embedded (no fetch needed). Wells were matched to these
// boundaries at full precision when the dataset was built; the polygons shown here are a
// simplified version for display only. Filtering uses the precomputed match, not a runtime
// point-in-polygon test against the (deliberately simplified) display geometry.
(function(){
  const sel = document.getElementById('aquext-select');
  const order = AQUIFER_EXTENT_NAMES.map((name,i)=>({name,i})).sort((a,b)=>a.name.localeCompare(b.name));
  sel.innerHTML = '<option value="">Choose an aquifer extent…</option>' +
    order.map(({name,i})=>`<option value="${i}">${name.replace(/_/g,' ')}</option>`).join('');
  sel.addEventListener('change', e=>{
    const i = e.target.value;
    if(i===''){ return; }
    const idx = +i;
    const polys = AQUIFER_EXTENT_POLYGONS[idx]; // array of polygons, each = array of rings
    setAreaSelection({type:'aquiferExtent', polygons:polys, exactIdx:idx, label:'Aquifer extent: '+AQUIFER_EXTENT_NAMES[idx]});
  });
})();

// Aquifer mapping study-area picker — lists all 44 individual project boundaries (a few names
// repeat for separate mapping phases, disambiguated with their year range). No precomputed exact
// index at this per-phase granularity, so this uses a runtime point-in-polygon test like
// County/HUC-8, not the exact match used for the Filters-tab study-area checkboxes.
(function(){
  const sel = document.getElementById('studyarea-select');
  const order = STUDY_AREAS.map((sa,i)=>{
    const years = (sa.startYear||sa.endYear) ? ` (${sa.startYear||'?'}–${sa.endYear||'ongoing'})` : '';
    return {label: sa.name+years, i};
  }).sort((a,b)=>a.label.localeCompare(b.label));
  sel.innerHTML = '<option value="">Choose a study area…</option>' +
    order.map(({label,i})=>`<option value="${i}">${label}</option>`).join('');
  sel.addEventListener('change', e=>{
    const i = e.target.value;
    if(i===''){ return; }
    const sa = STUDY_AREAS[+i];
    setAreaSelection({type:'studyarea', polygons:sa.polys, label:'Study area: '+sa.name});
  });
})();

/* -------------------------------------------------------------------- */
/* 13b. Season / month-range filter                                     */
/* -------------------------------------------------------------------- */
function onSeasonChange(){
  recomputeTrendAndMean();
  recomputeAllDespikeFlags();
  renderFlagsTable();
  recomputeActiveSet(); // re-filters (the depth-to-water filter depends on the now-updated
                         // season-aware mean), regenerates auto schedules, and re-renders
}
function setSeasonRange(ms, me, activeBtn){
  state.season.monthStart = ms;
  state.season.monthEnd = me;
  document.querySelectorAll('.season-btn').forEach(b=>b.classList.remove('active'));
  if(activeBtn) activeBtn.classList.add('active');
  document.getElementById('season-month-start').value = String(ms);
  document.getElementById('season-month-end').value = String(me);
  onSeasonChange();
}
document.querySelectorAll('.season-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> setSeasonRange(+btn.dataset.ms, +btn.dataset.me, btn));
});
['season-month-start','season-month-end'].forEach(id=>{
  document.getElementById(id).addEventListener('change', ()=>{
    const ms = +document.getElementById('season-month-start').value;
    const me = +document.getElementById('season-month-end').value;
    document.querySelectorAll('.season-btn').forEach(b=>{
      b.classList.toggle('active', +b.dataset.ms===ms && +b.dataset.me===me);
    });
    state.season.monthStart = ms;
    state.season.monthEnd = me;
    onSeasonChange();
  });
});
document.getElementById('toggle-season-compare').addEventListener('change', e=>{
  state.seasonCompare.enabled = e.target.checked;
  document.getElementById('season-compare-options').classList.toggle('hidden', !e.target.checked);
  const primaryControls = ['.season-btn', '#season-month-start', '#season-month-end'];
  if(e.target.checked){
    // The base schedule/well cohort has to come from all-year data, or "compare seasons" would
    // secretly be comparing an already season-biased cohort against itself — lock the primary
    // season picker to All year while comparing so that bias can't creep back in.
    const allYearBtn = document.querySelector('.season-btn[data-ms="1"][data-me="12"]');
    setSeasonRange(1, 12, allYearBtn); // triggers its own recompute + render
    primaryControls.forEach(sel => document.querySelectorAll(sel).forEach(el=>{ el.disabled = true; }));
    document.getElementById('season-primary-lock-hint').classList.remove('hidden');
  } else {
    primaryControls.forEach(sel => document.querySelectorAll(sel).forEach(el=>{ el.disabled = false; }));
    document.getElementById('season-primary-lock-hint').classList.add('hidden');
    renderChart();
  }
});
document.querySelectorAll('.season-compare-cb').forEach(cb=>{
  cb.addEventListener('change', ()=>{
    const key = cb.dataset.key;
    if(cb.checked) state.seasonCompare.keys.add(key); else state.seasonCompare.keys.delete(key);
    renderChart();
  });
});

function onDespikeChange(){
  recomputeTrendAndMean();
  recomputeAllDespikeFlags();
  renderFlagsTable();
  recomputeActiveSet();
}
document.getElementById('toggle-despike').addEventListener('change', e=>{
  state.despike.enabled = e.target.checked;
  onDespikeChange();
});
document.querySelectorAll('.despike-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.despike-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.despike.threshold = +btn.dataset.thresh;
    onDespikeChange();
  });
});

/* -------------------------------------------------------------------- */
/* 14. Composite hydrograph — observation-year schedule matching        */
/* -------------------------------------------------------------------- */
let chart = null;

// Draws a small "⁄ ⁄" break mark (with the skipped span labeled) between any two adjacent
// schedule points whose real year-gap is much bigger than the rest — so a category axis (which
// otherwise spaces every point evenly) doesn't silently hide a 30-year jump next to a run of
// 2-year readings.
const gapBreakPlugin = {
  id: 'gapBreak',
  afterDraw(c){
    const opts = c.options.plugins && c.options.plugins.gapBreak;
    if(!opts || !opts.xvals || opts.xvals.length < 2) return;
    const xvals = opts.xvals;
    const {ctx, chartArea, scales} = c;
    const xScale = scales.x;
    const gaps = xvals.slice(1).map((v,i)=>v - xvals[i]);
    if(!gaps.length) return;
    const sorted = [...gaps].sort((a,b)=>a-b);
    const median = sorted[Math.floor(sorted.length/2)] || 1;
    const threshold = Math.max(median*2, median+4, 5);
    ctx.save();
    gaps.forEach((gap,i)=>{
      if(gap < threshold) return;
      const xA = xScale.getPixelForValue(i);
      const xB = xScale.getPixelForValue(i+1);
      const cx = (xA+xB)/2;
      const baseY = chartArea.bottom;
      ctx.fillStyle = opts.bandColor || 'rgba(125,136,120,0.05)';
      ctx.fillRect(xA, chartArea.top, xB-xA, chartArea.bottom-chartArea.top);
      ctx.strokeStyle = opts.markColor || '#7d8873';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      [cx-5, cx+5].forEach(x0=>{
        ctx.beginPath();
        ctx.moveTo(x0-4, baseY+5);
        ctx.lineTo(x0+4, baseY-5);
        ctx.stroke();
      });
      ctx.fillStyle = opts.markColor || '#7d8873';
      ctx.font = '10px ' + (opts.font || 'sans-serif');
      ctx.textAlign = 'center';
      ctx.fillText(gap+' yr gap', cx, chartArea.top+14);
    });
    ctx.restore();
  }
};
Chart.register(gapBreakPlugin);

/* ===================================================================== */
/* Composite method: "Over the Top" (replaces the old year-schedule,     */
/* year-matching and 5-year-bin methods).                                 */
/*  1. one value per well per year (median of its monthly values),        */
/*  2. spike filter on the annual values (ft/yr between kept years),      */
/*  3. record rules (min. years with data, min. span),                    */
/*  4. per-well Theil-Sen slope + Mann-Kendall test,                      */
/*  5. standardize each well (normal scores / z-scores), or chain-link    */
/*     year-to-year steps in feet,                                        */
/*  6. median (and mean) across wells for every year with >= minN wells,  */
/*  7. 95% bootstrap band (wells resampled with replacement).             */
/* Nothing is shifted between years and no gaps are filled.               */
/* ===================================================================== */
const OT = (()=>{
  const median = a=>{ if(!a.length) return NaN; const s = Float64Array.from(a).sort(); const m = s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
  const quantile = (a,q)=>{ if(!a.length) return NaN; const s = Float64Array.from(a).sort(); const p = (s.length-1)*q, i = Math.floor(p), f = p-i; return i+1 < s.length ? s[i]*(1-f) + s[i+1]*f : s[i]; };
  const mean = a=>a.reduce((x,y)=>x+y,0)/a.length;
  const sd = a=>{ const m = mean(a); return Math.sqrt(a.reduce((x,y)=>x+(y-m)*(y-m),0)/(a.length-1)); };
  function erfc(x){ const z = Math.abs(x), t = 1/(1+.5*z); const r = t*Math.exp(-z*z-1.26551223+t*(1.00002368+t*(.37409196+t*(.09678418+t*(-.18628806+t*(.27886807+t*(-1.13520398+t*(1.48851587+t*(-.82215223+t*.17087277))))))))); return x>=0 ? r : 2-r; }
  const normCdf = x=>.5*erfc(-x/Math.SQRT2);
  function normInv(p){ // Acklam's rational approximation
    const a=[-39.69683028665376,220.9460984245205,-275.9285104469687,138.357751867269,-30.66479806614716,2.506628277459239];
    const b=[-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572];
    const c=[-.007784894002430293,-.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783];
    const d=[.007784695709041462,.3224671290700398,2.445134137142996,3.754408661907416];
    if(p<=0) return -Infinity; if(p>=1) return Infinity;
    let q, r;
    if(p<.02425){ q = Math.sqrt(-2*Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    if(p>1-.02425){ q = Math.sqrt(-2*Math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    q = p-.5; r = q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  }
  function rng(seed){ let a = seed>>>0; return ()=>{ a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a>>>15, 1|a); t = t + Math.imul(t ^ t>>>7, 61|t) ^ t; return ((t ^ t>>>14)>>>0)/4294967296; }; }
  // Theil-Sen: median of pairwise slopes; intercept = median(y - b x)
  function theilSen(x, y){ const n = x.length, sl = []; for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) if(x[j]!==x[i]) sl.push((y[j]-y[i])/(x[j]-x[i]));
    if(!sl.length) return {slope:NaN, intercept:NaN}; const b = median(sl); return {slope:b, intercept:median(y.map((v,i)=>v-b*x[i]))}; }
  // Mann-Kendall with tie correction; y in time order
  function mannKendall(y){ const n = y.length; let S = 0; for(let i=0;i<n-1;i++) for(let j=i+1;j<n;j++) S += Math.sign(y[j]-y[i]);
    const cnt = new Map(); y.forEach(v=>cnt.set(v,(cnt.get(v)||0)+1)); let tie = 0; cnt.forEach(t=>{ if(t>1) tie += t*(t-1)*(2*t+5); });
    const v = (n*(n-1)*(2*n+5)-tie)/18; const z = v>0 ? (S>0 ? (S-1)/Math.sqrt(v) : S<0 ? (S+1)/Math.sqrt(v) : 0) : 0;
    return {S, z, p:2*(1-normCdf(Math.abs(z)))}; }
  // drop a year when the jump to BOTH neighbours exceeds thr (ft/yr); end years need only their one neighbour
  function spikeFilter(years, vals, thr){ if(!thr || years.length<3) return {years, vals, dropped:0};
    const rate = (i,j)=>Math.abs(vals[j]-vals[i])/Math.abs(years[j]-years[i]), keep = []; let d = 0;
    for(let i=0;i<years.length;i++){ const p = i>0, n = i<years.length-1;
      const bad = (p ? rate(i-1,i)>thr : true) && (n ? rate(i,i+1)>thr : true);
      if(bad){ d++; continue; } keep.push(i); }
    return {years:keep.map(i=>years[i]), vals:keep.map(i=>vals[i]), dropped:d}; }
  function zscore(v){ const m = mean(v), s = sd(v); return v.map(x=>s>0 ? (x-m)/s : 0); }
  // Blom normal scores, average ranks for ties
  function normalScores(v){ const n = v.length, idx = v.map((x,i)=>i).sort((a,b)=>v[a]-v[b]), r = new Array(n); let i = 0;
    while(i<n){ let j = i; while(j+1<n && v[idx[j+1]]===v[idx[i]]) j++; const avg = (i+j)/2+1; for(let k=i;k<=j;k++) r[idx[k]] = avg; i = j+1; }
    return r.map(rk=>normInv((rk-.375)/(n+.25))); }
  function bootMedianCI(vals, B, seed){ if(vals.length<2) return [NaN,NaN]; const r = rng(seed), m = []; for(let b=0;b<B;b++){ const s = []; for(let i=0;i<vals.length;i++) s.push(vals[Math.floor(r()*vals.length)]); m.push(median(s)); } return [quantile(m,.025), quantile(m,.975)]; }
  function kmeans(X, k, seed, restarts, iters){ restarts = restarts||10; iters = iters||60;
    const n = X.length, d = X[0].length, r = rng(seed); let best = null;
    const d2 = (a,b)=>{ let s = 0; for(let i=0;i<d;i++){ const t = a[i]-b[i]; s += t*t; } return s; };
    for(let rs=0; rs<restarts; rs++){ const C = [X[Math.floor(r()*n)].slice()];
      while(C.length<k){ const D = X.map(x=>Math.min(...C.map(c=>d2(x,c)))), tot = D.reduce((a,b)=>a+b,0); let u = r()*tot, i = 0; while(i<n-1 && (u -= D[i])>0) i++; C.push(X[i].slice()); }
      let lab = new Array(n).fill(-1);
      for(let it=0; it<iters; it++){ let ch = false; for(let i=0;i<n;i++){ let bj = 0, bd = Infinity; for(let j=0;j<k;j++){ const dd = d2(X[i],C[j]); if(dd<bd){ bd = dd; bj = j; } } if(lab[i]!==bj){ lab[i] = bj; ch = true; } }
        if(!ch) break; for(let j=0;j<k;j++){ const m = []; for(let i=0;i<n;i++) if(lab[i]===j) m.push(X[i]); if(m.length) for(let t=0;t<d;t++) C[j][t] = mean(m.map(x=>x[t])); } }
      let sse = 0; for(let i=0;i<n;i++) sse += d2(X[i], C[lab[i]]);
      if(!best || sse<best.sse) best = {labels:lab.slice(), centers:C.map(c=>c.slice()), sse}; }
    return best; }
  return {median, quantile, mean, sd, normCdf, normInv, rng, theilSen, mannKendall, spikeFilter, zscore, normalScores, bootMedianCI, kmeans};
})();
function median(arr){
  const a = arr.slice().sort((x,y)=>x-y);
  const n = a.length;
  if(!n) return null;
  const mid = Math.floor(n/2);
  return n%2 ? a[mid] : (a[mid-1]+a[mid])/2;
}
function otDefaults(){ return { method:'fe', annual:'median', split:true, minN:5, minYears:5, minSpan:8, spike:65, boot:200, cellKm:5, fixed:0, bin:1, unitKind:'huc10' }; }
const OT_METHOD_LABEL = { units:'area units (ft)', fe:'matched wells (ft)', ns:'normal score (SGI-style)', z:'z-score', chain:'chain-linked change (ft)' };
const otFeet = m => m === 'chain' || m === 'fe' || m === 'units';
const OT_THIN = 10;   // years plotted from fewer wells than this get hollow markers
function otUnits(){ return otFeet(state.otp.method) ? 'ft' : 'SD'; }
function candidatePoolForSchedule(){
  return Array.from(state.activeSet || []).filter(s => (siteMonthMap.get(s) || []).length);
}

// ---- 1. one value per well per year ------------------------------------------------------------
// Median of the well's monthly values in that year (Over the Top uses annual medians), with the
// season filter, water years and flagged (despiked) months applied exactly as elsewhere in the tool.
// "Reading-weighted mean" falls back to the tool's own yearly mean.
var otDataVer;   // bumped whenever the monthly data are rebuilt (buildSiteMaps)
let otAnnualCache = {key:null, m:new Map()};
const OT_WARM = m => m >= 4 && m <= 9;   // warm (irrigation) season Apr-Sep; cool season Oct-Mar
function otAnnualRaw(s, ms, me, half){
  const months = siteMonthMap.get(s);
  if(!months || !months.length) return [];
  const inRange = ms <= me ? (m => m>=ms && m<=me) : (m => m>=ms || m<=me);
  const bad = monthFlagsFor(s), by = new Map();
  for(const p of months){
    if(!inRange(p.month)) continue;
    if(half && (half === 'w') !== OT_WARM(p.month)) continue;
    if(bad.size && bad.has(monthKey(p))) continue;
    // water year (Oct-Dec -> next year), and a range that wraps the new year (e.g. Nov-Feb): months before the wrap count toward the following year
    const yr = ((state.waterYear && p.month >= 10) || (ms > me && p.month >= ms)) ? p.year + 1 : p.year;
    let a = by.get(yr); if(!a){ a = {v:[], n:0}; by.set(yr, a); }
    a.v.push(p.avg); a.n += p.n;
  }
  const out = [];
  by.forEach((a, year)=> out.push({year, avg:OT.median(a.v), n:a.n, nm:a.v.length}));
  out.sort((a,b)=>a.year-b.year);
  return out;
}
function otAnnual(s, ms, me, half){
  if(ms == null){ ms = state.season.monthStart; me = state.season.monthEnd; }
  if(state.otp.annual === 'mean' && !half) return yearSeriesForMonthRange(s, ms, me);
  const key = [otDataVer, state.waterYear, ms, me, state.despike.enabled, state.despike.threshold].join('|');
  if(otAnnualCache.key !== key) otAnnualCache = {key, m:new Map()};
  const ck = half ? s + half : s;
  let raw = otAnnualCache.m.get(ck);
  if(!raw){ raw = otAnnualRaw(s, ms, me, half); otAnnualCache.m.set(ck, raw); }
  return applyYearWindow(despikeSeries(raw, state.despike.threshold));
}

// ---- 2-5. per-well series, rules, trend, standardization ------------------------------------------
// All standardized values are in "water-level sense": up = more water (depth is sign-flipped).
// The chain-linked mode works on the displayed value (depth or elevation) in feet.
// per-well results are cached: they do not depend on the composite method, min. wells or bootstrap
let otWellCaches = new Map();
function otWell(s, ms, me){
  if(ms == null){ ms = state.season.monthStart; me = state.season.monthEnd; }
  const o = state.otp;
  const key = [otDataVer, o.annual, o.split, o.bin, o.minYears, o.minSpan, o.spike, ms, me, state.waterYear, state.despike.enabled, state.despike.threshold, state.yearWindow.min, state.yearWindow.max, state.valueMode].join('|');
  let m = otWellCaches.get(key);
  if(!m){ if(otWellCaches.size >= 6) otWellCaches = new Map(); m = new Map(); otWellCaches.set(key, m); }
  let w = m.get(s);
  if(!w){ w = otWellCompute(s, ms, me); m.set(s, w); }
  return w;
}
function otWellCompute(s, ms, me){
  const o = state.otp, ser = otAnnual(s, ms, me);
  let Y = [], W = [];
  const up = state.valueMode === 'elevation' ? 1 : -1;
  for(const p of ser){ const d = toDisplay(s, p.avg); if(d == null || !isFinite(d)) continue; Y.push(p.year); W.push(up*d); }
  const sf = OT.spikeFilter(Y, W, o.spike);
  Y = sf.years; W = sf.vals;
  const res = {site:s, dropped:sf.dropped, nYears:Y.length, span: Y.length ? Y[Y.length-1]-Y[0] : 0, ok:false};
  if(Y.length < Math.max(2, o.minYears) || res.span < o.minSpan) return res;
  const ts = OT.theilSen(Y, W), mk = OT.mannKendall(W);
  res.ok = true; res.years = Y; res.slope = ts.slope; res.p = mk.p;
  // trend and record rules use the yearly values; the series that go into the composite are the time bins (median of the
  // yearly values inside each bin, placed at the bin's middle year) so wells measured on a rotating cycle still share bins
  const bn = otBin(Y, W, o.bin), z = OT.zscore(bn.v), ns = OT.normalScores(bn.v);
  res.mapDisp = new Map(bn.y.map((y,i)=>[y, up*bn.v[i]]));
  res.mapZ = new Map(bn.y.map((y,i)=>[y, z[i]]));
  res.mapNs = new Map(bn.y.map((y,i)=>[y, ns[i]]));
  otTagMaps(res, s);
  if(otSplitOn(ms, me)){
    // warm- and cool-season series of the same well, each with its own level in the fit
    const hs = [];
    for(const hf of ['w', 'c']){ const sh = otAnnual(s, ms, me, hf); let Yh = [], Wh = [];
      for(const p of sh){ const d = toDisplay(s, p.avg); if(d == null || !isFinite(d)) continue; Yh.push(p.year); Wh.push(up*d); }
      const f2 = OT.spikeFilter(Yh, Wh, o.spike); if(f2.years.length < 2) continue;
      const hb = otBin(f2.years, f2.vals, o.bin), m = new Map(hb.y.map((y,i)=>[y, up*hb.v[i]])); m._x = res.mapDisp._x; m._y = res.mapDisp._y; m._s = s; m._half = hf; hs.push(m); }
    if(hs.length === 2){ hs.forEach(m => m._wt = 0.5); res.mapSeas = hs; }
  }
  return res;
}
// time bins: width B years (1 = yearly, 3, 5, 10), aligned so bins start in 1980 (1980-84, 1985-89 ...) as in Myers (2022);
// 10-year bins are calendar decades (1950-59 ...) as in the NMBGMR storage-change reports. The value is the median of the
// yearly values in the bin, placed at the bin's middle year (the 6th year of a decade: 1955 for the 1950s)
function otBinMid(B){ return B % 2 ? (B - 1) / 2 : B / 2; }
function otBin(Y, V, B){
  if(!B || B <= 1) return {y:Y, v:V};
  const by = new Map();
  Y.forEach((y,i)=>{ const k = Math.floor((y - 1980) / B); let a = by.get(k); if(!a){ a = []; by.set(k, a); } a.push(V[i]); });
  const ks = Array.from(by.keys()).sort((a,b)=>a-b);
  return {y: ks.map(k => 1980 + k*B + otBinMid(B)), v: ks.map(k => OT.median(by.get(k)))};
}
// season halves are used when the composite is in feet (matched wells / area units), the option is on, the annual value
// is the median, and the month range includes months of both halves
function otSplitOn(ms, me){ const o = state.otp; if(!o.split || o.annual !== 'median') return false;
  const inR = ms <= me ? (m => m >= ms && m <= me) : (m => m >= ms || m <= me); let w = false, c = false;
  for(let m=1; m<=12; m++) if(inR(m)){ if(OT_WARM(m)) w = true; else c = true; } return w && c; }
function otMapOf(w){ const m = state.otp.method; return m === 'ns' ? w.mapNs : m === 'z' ? w.mapZ : w.mapDisp; }
// well position in km (for area weighting and the composition strip), carried on each of the well's maps
function otTagMaps(res, s){ const r = SITES[s]; const x = r[1] != null ? r[1]*111.32*Math.cos(34.4*Math.PI/180) : NaN, y = r[2] != null ? r[2]*110.57 : NaN;
  [res.mapDisp, res.mapZ, res.mapNs].forEach(m => { m._x = x; m._y = y; m._s = s; }); }

// ---- 6. composite across wells ---------------------------------------------------------------------
// maps: one Map(year -> value) per well. Returns median, mean and well count per year.
// 'chain': each year's step is the median (mean) of the changes of wells measured in BOTH that year and
// the last kept year, so wells joining or leaving cannot create steps. A year with too few wells is left
// empty and the next step bridges from the last kept year (nothing is lost across the gap).
// weighted median / mean; w = null means equal weights
function otWMedian(v, w){
  const n = v.length; if(!n) return NaN; if(!w) return OT.median(v);
  const ix = Array.from(v.keys()).sort((a,b)=>v[a]-v[b]); let tot = 0; for(const i of ix) tot += w[i];
  let c = 0; for(let k=0;k<n;k++){ c += w[ix[k]]; if(c >= tot/2 - 1e-12){ if(Math.abs(c - tot/2) < 1e-12 && k+1 < n) return (v[ix[k]] + v[ix[k+1]])/2; return v[ix[k]]; } }
  return v[ix[n-1]];
}
function otWMean(v, w){ if(!v.length) return NaN; if(!w) return v.reduce((a,b)=>a+b,0)/v.length; let s = 0, t = 0; for(let i=0;i<v.length;i++){ s += v[i]*w[i]; t += w[i]; } return s/t; }
// area weights for a set of wells: each grid cell of `km` shares one unit of weight (null when off)
function otCellWeights(maps, idx, km){
  if(!km) return null;
  const key = i => { const m = maps[i]; return isFinite(m._x) ? Math.floor(m._x/km) + ':' + Math.floor(m._y/km) : 'na' + i; };
  const ks = idx.map(key), cnt = new Map(); ks.forEach(k => cnt.set(k, (cnt.get(k)||0) + 1));
  return ks.map(k => 1/cnt.get(k));
}
// Matched wells: robust two-way fit  value(well, year) = a_well + b_year  over all wells at once (weighted median
// polish for the median line, alternating least squares for the mean line). Only the part of the well/year network
// connected to the best-measured year is used. b is shifted so the first reported year is 0.
function otFixedEffects(maps, years, minN, km){
  const L = years.length, W = maps.length, yi = new Map(years.map((y,i)=>[y,i]));
  const ow = [], ot = [], ov = [];
  for(let w=0; w<W; w++) maps[w].forEach((v,y)=>{ const t = yi.get(y); if(t !== undefined && isFinite(v)){ ow.push(w); ot.push(t); ov.push(v); } });
  const med = new Array(L).fill(null), mean = new Array(L).fill(null), n = new Array(L).fill(0), eff = new Float64Array(W).fill(NaN);
  const N = ow.length; if(!N) return {med, mean, n, anchor:null, eff};
  // connectivity (wells 0..W-1, years W..W+L-1)
  const par = new Int32Array(W+L).map((_,i)=>i), f = i => { while(par[i] !== i){ par[i] = par[par[i]]; i = par[i]; } return i; };
  const nT0 = new Int32Array(L); for(let i=0;i<N;i++){ nT0[ot[i]]++; const a = f(ow[i]), b = f(W+ot[i]); if(a !== b) par[a] = b; }
  let root = 0; for(let t=1;t<L;t++) if(nT0[t] > nT0[root]) root = t;
  const rc = f(W+root);
  const keep = []; for(let i=0;i<N;i++) if(f(ow[i]) === rc) keep.push(i);
  const byT = Array.from({length:L}, ()=>[]), byW = new Map();
  for(const i of keep){ byT[ot[i]].push(i); let a = byW.get(ow[i]); if(!a){ a = []; byW.set(ow[i], a); } a.push(i); }
  // per-year area weights
  const wt = new Float64Array(N).fill(1);
  const hasW = maps.some(m => m._wt != null && m._wt !== 1);
  if(hasW) for(let i=0;i<N;i++) wt[i] = maps[ow[i]]._wt != null ? maps[ow[i]]._wt : 1;
  if(km) for(let t=0;t<L;t++){ const I = byT[t]; if(!I.length) continue; const ww = otCellWeights(maps, I.map(i=>ow[i]), km); I.forEach((i,k)=> wt[i] *= ww[k]); }
  // least squares by alternating means (weights wt per reading, times robustness weights h when given), warm start
  const als = (a, b, h, iters, tol) => {
    for(let it=0; it<iters; it++){
      let ch = 0;
      for(let t=0;t<L;t++){ const I = byT[t]; if(!I.length) continue; let s = 0, q = 0;
        for(const i of I){ const w = wt[i] * (h ? h[i] : 1); s += w * (ov[i] - a[ow[i]]); q += w; }
        if(q > 0){ const nb = s/q; ch = Math.max(ch, Math.abs(nb - b[t])); b[t] = nb; } }
      byW.forEach((I, w) => { let s = 0, q = 0; for(const i of I){ const u = h ? h[i] : 1; s += u * (ov[i] - b[ot[i]]); q += u; } if(q > 0) a[w] = s/q; });
      if(ch < tol) break;
    }
  };
  const A = {a: new Float64Array(W).fill(NaN), b: new Float64Array(L).fill(0)};
  byW.forEach((I, w) => { A.a[w] = I.reduce((x,i)=>x+ov[i],0)/I.length; });
  als(A.a, A.b, null, 150, 0.001);
  // robust line: the same model fitted by iteratively reweighted least squares with Huber weights (c = 1.345 x robust
  // scale of the residuals), so outlying readings count less; replaces median polish, which is biased on unbalanced networks
  const M = {a: Float64Array.from(A.a), b: Float64Array.from(A.b)}, h = new Float64Array(N).fill(1);
  for(let k=0; k<10; k++){
    const res = keep.map(i => Math.abs(ov[i] - M.a[ow[i]] - M.b[ot[i]]));
    const sc = Math.max(0.05, 1.4826 * OT.median(res)), c = 1.345 * sc;
    keep.forEach((i, j) => { h[i] = res[j] <= c ? 1 : c / res[j]; });
    const b0 = Float64Array.from(M.b); als(M.a, M.b, h, 25, 0.001);
    let ch = 0; for(let t=0;t<L;t++) ch = Math.max(ch, Math.abs(M.b[t] - b0[t])); if(ch < 0.002) break;
  }
  let first = -1;
  for(let t=0;t<L;t++){ n[t] = new Set(byT[t].map(i => maps[ow[i]]._s != null ? maps[ow[i]]._s : ow[i])).size; if(n[t] >= minN){ if(first < 0) first = t; med[t] = M.b[t]; mean[t] = A.b[t]; } }
  if(first >= 0){ const m0 = M.b[first], a0 = A.b[first]; for(let t=0;t<L;t++) if(med[t] != null){ med[t] -= m0; mean[t] -= a0; } }
  byW.forEach((I, w) => { eff[w] = M.a[w] + (first >= 0 ? M.b[first] : 0); });
  return {med, mean, n, anchor:null, eff};
}
// HUC-10 of a well, from boundaries/huc10.geojson (USGS WBD): the polygons load once in the background and each well is
// located the first time it is asked for (h10Of), so only the wells in a composite are ever tested
let siteH10 = null, siteH10P = null, h10Polys = null, otH10Retry = false; const h10Area = new Map();
function h10Of(s){
  if(!siteH10 || s == null) return null; let v = siteH10[s]; if(v !== undefined) return v; v = null;
  const r = SITES[s];
  if(r && r[1] != null && r[2] != null){ const x = r[1], y = r[2];
    for(const p of h10Polys){ if(x < p.bb[0] || x > p.bb[2] || y < p.bb[1] || y > p.bb[3]) continue; if(pointInPieces(x, y, p.pieces)){ v = p.code; break; } } }
  siteH10[s] = v; return v;
}
function ensureSiteH10(){
  if(siteH10P) return siteH10P;
  siteH10P = (async () => {
    let gj = null;
    try{ const base = await krigBase(); if(base){ if(!window._huc10All){ const r = await fetch(base + 'huc10.geojson'); if(r.ok) window._huc10All = await r.json(); } gj = window._huc10All; } }catch(e){}
    if(!gj || !gj.features) return null;
    const idx = window._krigIndex && window._krigIndex.units ? new Map(window._krigIndex.units.filter(u => u.level === 'huc10').map(u => [u.huc, u.area_km2])) : new Map();
    const P = gj.features.map(f => ({code: String(f.properties.huc10), ar: +f.properties.areasqkm || 0, pieces: piecesFromGeom(f.geometry)}));
    P.forEach(p => { p.bb = p.pieces.reduce((b, q) => [Math.min(b[0], q.bbox[0]), Math.min(b[1], q.bbox[1]), Math.max(b[2], q.bbox[2]), Math.max(b[3], q.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
      let a = idx.get(p.code) || p.ar; if(!a){ a = 0; p.pieces.forEach(q => { const r = q.rings[0]; let s = 0; for(let i=0, j=r.length-1; i<r.length; j=i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); a += Math.abs(s/2) * 111.32 * 110.57 * Math.cos(34.4*Math.PI/180); }); }
      h10Area.set(p.code, a || 1); });
    h10Polys = P; siteH10 = new Array(NSITES); return siteH10;
  })();
  return siteH10P;
}
setTimeout(() => { try{ ensureSiteH10(); }catch(e){} }, 8000);
// Area units: matched wells inside each HUC-10 (stage 1), then matched units weighted by area (stage 2).
// A HUC-10 whose own series covers less than half of the composite's years is pooled with the other short ones in
// its HUC-8, so units that appear late do not carry the area by themselves.
// With "aquifer outlines" as the unit (file 35) each unit is one combination of the NM 2-D aquifer extents (an overlap of
// stacked extents is its own unit), weighted by its area inside the selection.
function otUnitOf(s){ return state.otp.unitKind === 'aquifer' ? hxAqUnitOf(s) : h10Of(s); }
function otAreaUnits(maps, years, minN){
  const L = years.length, aq = state.otp.unitKind === 'aquifer';
  if(!aq && !siteH10) return Object.assign(otFixedEffects(maps, years, minN, 0), {unitsInfo: {pending: true}});
  const area = aq ? hxAqUnitAreas(maps) : h10Area;
  const nSet = Array.from({length:L}, () => new Set()); maps.forEach((m, k) => m.forEach((v, y) => { const t = y - years[0]; if(t >= 0 && t < L) nSet[t].add(m._s != null ? m._s : k); }));
  const nAll = nSet.map(s => s.size);
  const good = nAll.filter(c => c >= minN).length || 1;
  const groups = new Map(); maps.forEach(m => { const u = otUnitOf(m._s) || 'none'; if(!groups.has(u)) groups.set(u, []); groups.get(u).push(m); });
  const series = ms => { const c = otFixedEffects(ms, years, 1, 0), m = new Map(); years.forEach((y,i) => { if(c.med[i] != null) m.set(y, c.med[i]); }); return m; };
  const units = [], shortBy8 = new Map(); let nShort = 0;
  groups.forEach((ms, u) => { const s = series(ms); let cov = 0; s.forEach((v, y) => { const t = y - years[0]; if(nAll[t] >= minN) cov++; });
    const nw = new Set(ms.map(m => m._s)).size;
    if((cov >= 0.5 * good && nw >= 3) || u === 'none'){ s._wt = area.get(u) || 1; s._n = ms.length; units.push(s); }
    else { nShort++; const k = aq ? 'short' : u.slice(0, 8); if(!shortBy8.has(k)) shortBy8.set(k, {ms: [], area: 0}); const g = shortBy8.get(k); g.ms.push(...ms); g.area += area.get(u) || 1; } });
  shortBy8.forEach(g => { const s = series(g.ms); if(s.size){ s._wt = g.area; s._n = g.ms.length; units.push(s); } });
  const c = otFixedEffects(units, years, 1, 0);
  const med = new Array(L).fill(null), mean = new Array(L).fill(null);
  // the area-weighted average (least-squares stage 2) is the estimate of the area's change; both lines show it
  let f = -1; for(let t=0;t<L;t++) if(nAll[t] >= minN && c.mean[t] != null){ if(f < 0) f = t; med[t] = c.mean[t]; mean[t] = c.mean[t]; }
  if(f >= 0){ const m0 = med[f], a0 = mean[f]; for(let t=0;t<L;t++) if(med[t] != null){ med[t] -= m0; mean[t] -= a0; } }
  return {med, mean, n: nAll, anchor: null, eff: new Float64Array(maps.length).fill(NaN), unitsInfo: {units: units.length, huc10: groups.size, pooled: nShort, pooledInto: shortBy8.size, kind: aq ? 'aquifer' : 'huc10'}};
}
// ---- kriged change map (OSE basins, HUC-8, HUC-10, HUC-12) ----
const H12_COLORS = ['#b2182b','#ef8a62','#fddbc7','#f7f7f7','#d1e5f0','#67a9cf','#2166ac'], H12_BREAKS = [-50,-20,-5,5,20,50];
const KM_LABEL = {ose:'OSE basin', huc8:'HUC-8', huc10:'HUC-10', huc12:'HUC-12'};
const h12State = {on:false, level:'off', year:2026, ref:1980, feats:null, units:null, layer:null, ctl:null, timer:null, featsFor:null};
// units for the level: Map code -> {n, c (change ft, from years[0]), s (se ft)}, plus first year
async function kmUnits(level){
  const base = await krigBase(); if(!base) return null;
  const season = krigSeason();
  const fname = level === 'huc12' ? 'h12_' + season + '.json' : level === 'ose' ? 'ose_' + season + '.json' : season + '.json';
  if(!krigFiles.has(fname)){ try{ const r = await fetch(base + fname); krigFiles.set(fname, r.ok ? await r.json() : null); }catch(e){ krigFiles.set(fname, null); } }
  const D = krigFiles.get(fname); if(!D) return null;
  const out = new Map(); let y0 = 1950;
  if(level === 'huc12'){ y0 = D.years[0]; Object.entries(D.units).forEach(([k, u]) => out.set(k, {n:u.n, c:u.c, s:u.s})); }
  else {
    const top = level === 'ose' ? D.basin : D.huc8;
    Object.values(top || {}).forEach(F => { if(F.years) y0 = F.years[0]; Object.entries(F.units || {}).forEach(([k, U]) => {
      if(!U.chg_ft) return; if(level === 'huc8' && U.level !== 'huc8') return; if(level === 'huc10' && U.level !== 'huc10') return;
      out.set(k, {n:U.name, c:U.chg_ft, s:U.se_chg_ft}); }); });
  }
  return {units: out, y0};
}
// polygons for the level: [{code, name, f}]
async function kmFeatures(level){
  if(level === 'huc8') return hucFeatures.map(f => ({code:String(f.properties.huc8), name:f.properties.name, f}));
  if(level === 'ose') return oseFeatures.map(f => ({code:oseSlug(f.properties.Basin), name:f.properties.Basin, f}));
  const base = await krigBase(); if(!base) return null;
  if(level === 'huc10'){ if(!window._huc10All){ try{ const r = await fetch(base + 'huc10.geojson'); if(r.ok) window._huc10All = await r.json(); }catch(e){} }
    return window._huc10All ? window._huc10All.features.map(f => ({code:String(f.properties.huc10), name:f.properties.name, f})) : null; }
  if(!window._huc12All){ try{ const r = await fetch(base + 'huc12.geojson'); if(r.ok) window._huc12All = await r.json(); }catch(e){} }
  return window._huc12All ? window._huc12All.features.map(f => ({code:String(f.properties.huc12), name:f.properties.name, f})) : null;
}
function h12Color(d){ let i = 0; while(i < H12_BREAKS.length && d > H12_BREAKS[i]) i++; return H12_COLORS[i]; }
function kmVal(code){
  const U = h12State.units, u = U && U.units.get(code); if(!u) return null;
  const i = h12State.year - U.y0, j = h12State.ref - U.y0, a = u.c[i], b = u.c[j];
  if(a == null || b == null) return {u, none:true};
  // 95% range of the change between the two years: both are changes from the model's base year, and their errors are
  // positively correlated, so sqrt(se_a^2 + se_b^2) is an upper bound (exact when one of the years is the base year)
  return {u, d: a - b, s: 1.96 * Math.sqrt((u.s[i] || 0) ** 2 + (u.s[j] || 0) ** 2)};
}
function h12Style(code){
  const v = kmVal(code);
  if(!v || v.none) return {stroke:true, color:'#aaa', weight:0.4, opacity:0.5, fill:false};
  const unsure = v.s > Math.abs(v.d);
  return {stroke:true, color: unsure ? '#888' : '#555', weight: unsure ? 0.4 : 0.6, dashArray: unsure ? '2,2' : null, fill:true, fillColor:h12Color(v.d), fillOpacity: unsure ? 0.25 : 0.8};
}
async function h12Redraw(){
  const note = document.getElementById('h12-note'), lvl = h12State.level;
  if(lvl === 'off') return;
  const U = await kmUnits(lvl);
  if(lvl !== h12State.level) return;
  if(!U){ if(note) note.textContent = 'The kriged files for this level were not found in the kriged folder.'; return; }
  h12State.units = U;
  if(h12State.featsFor !== lvl){
    const F = await kmFeatures(lvl); if(lvl !== h12State.level) return;
    if(!F || !F.length){ if(note) note.textContent = 'Boundaries for this level are not loaded yet; try again in a moment.'; return; }
    if(h12State.layer){ map.removeLayer(h12State.layer); h12State.layer = null; }
    h12State.feats = F; h12State.featsFor = lvl;
    h12State.layer = L.geoJSON({type:'FeatureCollection', features: F.map(x => Object.assign({}, x.f, {properties: Object.assign({}, x.f.properties, {_code: x.code})}))},
      {pane:'refPane', interactive:false, style: f => h12Style(f.properties._code)});
  }
  h12State.layer.setStyle(f => h12Style(f.properties._code));
  if(!map.hasLayer(h12State.layer)) h12State.layer.addTo(map);
  if(note){ const n = h12State.feats.filter(x => U.units.has(x.code)).length;
    note.textContent = `${n.toLocaleString()} ${KM_LABEL[lvl]}${n === 1 ? '' : 's'} with an estimate (${krigSeason() === 'winter' ? 'Nov–Feb' : 'all months'}). Faded, dashed: the change is smaller than its 95% range. Grey outline: no estimate (no wells within 5 km). Hover for values; click to select.`; }
  const t = document.getElementById('h12-title'); if(t) t.textContent = 'Kriged water-level change by ' + KM_LABEL[lvl];
}
function h12Panel(){
  if(h12State.ctl) return;
  const C = L.control({position:'bottomleft'});
  C.onAdd = () => { const d = L.DomUtil.create('div', 'h12-panel');
    d.innerHTML = `<b id="h12-title">Kriged water-level change</b>
      <div class="row2">From <select id="h12-ref"></select> to <b id="h12-yl">2026</b> <button class="btn" id="h12-play" style="padding:1px 8px;">▶</button></div>
      <div class="row2"><input type="range" id="h12-year" min="1951" max="2026" value="2026"></div>
      <div class="h12-legend">${H12_COLORS.map(c => `<span style="background:${c}"></span>`).join('')}</div>
      <div class="h12-legend-l"><span>falling 50+ ft</span><span>±5</span><span>rising 50+ ft</span></div>
      <p id="h12-note" style="margin:4px 0 0; color:var(--muted); font-size:11px;">Loading…</p>`;
    L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d; };
  C.addTo(map); h12State.ctl = C;
  const ref = document.getElementById('h12-ref'); for(let y=1950; y<=2025; y++) ref.insertAdjacentHTML('beforeend', `<option value="${y}"${y === h12State.ref ? ' selected' : ''}>${y}</option>`);
  ref.addEventListener('change', e => { h12State.ref = +e.target.value; if(h12State.year <= h12State.ref){ h12State.year = Math.min(2026, h12State.ref + 1); } syncH12(); });
  document.getElementById('h12-year').addEventListener('input', e => { h12State.year = +e.target.value; syncH12(); });
  document.getElementById('h12-play').addEventListener('click', () => {
    if(h12State.timer){ clearInterval(h12State.timer); h12State.timer = null; document.getElementById('h12-play').textContent = '▶'; return; }
    if(h12State.year >= 2026) h12State.year = h12State.ref + 1;
    document.getElementById('h12-play').textContent = '❚❚';
    h12State.timer = setInterval(() => { if(h12State.year >= 2026){ clearInterval(h12State.timer); h12State.timer = null; document.getElementById('h12-play').textContent = '▶'; return; } h12State.year++; syncH12(); }, 450);
  });
}
function h12Text(code){
  const v = kmVal(code);
  if(!v) return '— no estimate (no wells within 5 km)';
  if(v.none) return '— no estimate for these years';
  return `${h12State.ref}→${h12State.year}: ${v.d >= 0 ? '+' : ''}${v.d.toFixed(1)} ft (${v.d >= 0 ? 'rising' : 'falling'}; 95% range ±${v.s.toFixed(0)} ft)` + (v.s > Math.abs(v.d) ? ', not clearly different from no change' : '');
}
function syncH12(){ const s = document.getElementById('h12-year'); if(s){ s.min = h12State.ref + 1; s.value = h12State.year; } const l = document.getElementById('h12-yl'); if(l) l.textContent = h12State.year; h12Redraw(); }
function kmSelect(x){
  const lvl = h12State.level, f = x.f;
  if(lvl === 'huc8'){ const i = hucFeatures.indexOf(f); document.getElementById('huc-select').value = String(i); selectHuc8(i); return; }
  if(lvl === 'ose'){ const i = oseFeatures.indexOf(f); document.getElementById('ose-select').value = String(i); selectOse(i); return; }
  if(lvl === 'huc10'){ setAreaSelection({type:'huc10', polygons:extractPolygonsFromGeoJSON(f), label:'HUC-10: ' + x.name, huc:x.code}); return; }
  setAreaSelection({type:'huc12', polygons:extractPolygonsFromGeoJSON(f), label:'HUC-12: ' + x.name, huc:x.code});
}
function otCompose(maps, years, mode, minN){
  const L = years.length, med = new Array(L).fill(null), mean = new Array(L).fill(null), n = new Array(L).fill(0);
  const km = state.otp.cellKm || 0;
  if(mode === 'fe') return otFixedEffects(maps, years, minN, km);
  if(mode === 'units') return otAreaUnits(maps, years, minN);
 if(mode === 'chain'){
    // Start at the year with the most wells and grow the chain one year at a time, always adding the unlinked year
    // that shares the most wells with a year already linked (ties: the closer year). Its step is the median (mean)
    // change of the wells measured in both. This is a maximum spanning tree over years, so a thin year early in the
    // record cannot strand the rest. The result is then shifted so the first plotted year is 0.
    const anchor = new Array(L).fill(null);
    const present = years.map(y=>{ const ix = []; for(let w=0; w<maps.length; w++) if(maps[w].has(y)) ix.push(w); return ix; });
    let root = -1, rootN = 0;
    for(let i=0;i<L;i++) if(present[i].length > rootN){ root = i; rootN = present[i].length; }
    if(root < 0 || rootN < minN){ for(let i=0;i<L;i++) n[i] = present[i].length; return {med, mean, n, anchor}; }
    // shared-well counts between every pair of years
    const yi = new Map(years.map((y,i)=>[y,i])), S = Array.from({length:L}, ()=>new Int32Array(L));
    for(const m of maps){ const ix = []; m.forEach((v,y)=>{ const i = yi.get(y); if(i !== undefined) ix.push(i); });
      for(let p=0;p<ix.length;p++) for(let q=p+1;q<ix.length;q++){ S[ix[p]][ix[q]]++; S[ix[q]][ix[p]]++; } }
    const inT = new Uint8Array(L), bestN = new Int32Array(L), bestP = new Int32Array(L).fill(-1);
    const add = i=>{ inT[i] = 1; for(let j=0;j<L;j++) if(!inT[j]){ const c = S[j][i];
      if(c > bestN[j] || (c === bestN[j] && c > 0 && Math.abs(i-j) < Math.abs(bestP[j]-j))){ bestN[j] = c; bestP[j] = i; } } };
    med[root] = 0; mean[root] = 0; n[root] = rootN; add(root);
    for(;;){
      let j = -1;
      for(let t=0;t<L;t++) if(!inT[t] && bestN[t] >= minN && (j < 0 || bestN[t] > bestN[j] || (bestN[t] === bestN[j] && Math.abs(bestP[t]-t) < Math.abs(bestP[j]-j)))) j = t;
      if(j < 0) break;
      const p = bestP[j], ky = years[p], y = years[j], d = [], dw = [];
      for(const w of present[j]){ const a0 = maps[w].get(ky); if(a0 !== undefined){ d.push(maps[w].get(y) - a0); dw.push(w); } }
      const ww = otCellWeights(maps, dw, km);
      med[j] = med[p] + otWMedian(d, ww); mean[j] = mean[p] + otWMean(d, ww);
      n[j] = d.length; anchor[j] = ky; add(j);
    }
    for(let i=0;i<L;i++) if(!inT[i]) n[i] = bestN[i];
    const f = med.findIndex(v=>v != null), m0 = med[f], a0 = mean[f];
    for(let i=0;i<L;i++) if(med[i] != null){ med[i] -= m0; mean[i] -= a0; }
    return {med, mean, n, anchor};
  }
  for(let i=0;i<L;i++){
    const y = years[i], a = [], ix = [];
    for(let w=0; w<maps.length; w++){ const v = maps[w].get(y); if(v !== undefined){ a.push(v); ix.push(w); } }
    n[i] = a.length;
    if(a.length >= minN){ const ww = otCellWeights(maps, ix, km); med[i] = otWMedian(a, ww); mean[i] = otWMean(a, ww); }
  }
  return {med, mean, n};
}
// ---- 7. bootstrap band of the median (wells resampled with replacement) ----------------------------
const OT_BOOT_BUDGET = 6e6;   // wells x years x draws; keeps very large selections responsive
function otBootBand(maps, years, mode, minN, B, seed){
  const W = maps.length, L = years.length;
  const obsN = maps.reduce((s,m)=>s+m.size, 0);
  const Beff = Math.min(B, mode === 'units' ? Math.floor(2*OT_BOOT_BUDGET / Math.max(1, obsN*40)) : mode === 'chain' ? Math.floor(5*OT_BOOT_BUDGET / Math.max(1, obsN*Math.min(L, 60))) : mode === 'fe' ? Math.floor(4*OT_BOOT_BUDGET / Math.max(1, obsN*40)) : Math.floor(OT_BOOT_BUDGET / Math.max(1, W*L)));
  if(Beff < 10 || W < 2) return {lo:new Array(L).fill(null), hi:new Array(L).fill(null), B:0, asked:B};
  // resample groups of nearby wells, not single wells: wells close together share pumping and recharge, so they are
  // not independent. Groups: the HUC-10 in the area-units method, else 5 km grid cells (the area-weighting cell when set).
  const gkm = state.otp.cellKm || 5, gid = new Map(), G = [];
  maps.forEach((m, i) => { const k = mode === 'units' && (state.otp.unitKind === 'aquifer' || siteH10) && otUnitOf(m._s) ? 'h' + otUnitOf(m._s) : isFinite(m._x) ? Math.floor(m._x/gkm) + ':' + Math.floor(m._y/gkm) : 'w' + (m._s != null ? m._s : i);
    let g = gid.get(k); if(g == null){ g = G.length; gid.set(k, g); G.push([]); } G[g].push(m); });
  const r = OT.rng(seed), draws = [], nG = G.length;
  if(nG < 2) return {lo:new Array(L).fill(null), hi:new Array(L).fill(null), B:0, asked:B, groups:nG};
  const main = otCompose(maps, years, mode, minN).med, f0 = main.findIndex(v => v != null);
  if(f0 < 0) return {lo:new Array(L).fill(null), hi:new Array(L).fill(null), B:0, asked:B, groups:nG};
  for(let b=0;b<Beff;b++){ const smp = []; for(let i=0;i<nG;i++){ const g = G[Math.floor(r()*nG)]; for(const m of g) smp.push(m); }
    const d = otCompose(smp, years, mode, 1).med; if(d[f0] == null) continue; draws.push(d.map((v, t) => v == null || main[t] == null ? null : v - d[f0])); }
  const lo = [], hi = [];
  for(let i=0;i<L;i++){ const c = []; for(const d of draws) if(d[i] != null) c.push(d[i]);
    lo.push(c.length > draws.length*.5 ? OT.quantile(c,.025) : null); hi.push(c.length > draws.length*.5 ? OT.quantile(c,.975) : null); }
  return {lo, hi, B:Beff, asked:B, groups:nG};
}
// ---- hydrograph clusters (k-means on each well's z-scores; Bloomfield et al. 2015 idea) -------------
// Window = years where >= minN wells have data; a well joins if it covers >= covPct of the window.
// Interior gaps are interpolated for the clustering ONLY (never for the plotted composite).
function otClusterize(perWell, xvals, k, covPct, minN){
  const cnt = xvals.map(y=>perWell.filter(pw=>pw.w.mapZ.has(y)).length);
  const good = xvals.filter((y,i)=>cnt[i] >= minN);
  if(good.length < 4) return null;
  const win = []; for(let y=good[0]; y<=good[good.length-1]; y++) win.push(y);
  const feats = [], members = []; let interp = 0;
  for(const pw of perWell){
    const mz = pw.w.mapZ, have = win.filter(y=>mz.has(y));
    if(have.length < win.length*covPct/100 || have.length < 4) continue;
    const f = win.map(y=>mz.get(y));
    for(let i=0;i<f.length;i++) if(f[i] === undefined){
      let a = i-1, b = i+1; while(a>=0 && f[a] === undefined) a--; while(b<f.length && f[b] === undefined) b++;
      if(a>=0 && b<f.length) f[i] = f[a] + (f[b]-f[a])*(i-a)/(b-a); else f[i] = a>=0 ? f[a] : f[b];
      interp++;
    }
    feats.push(f); members.push(pw);
  }
  if(feats.length < k*3) return null;
  const km = OT.kmeans(feats, k, 11, 10);
  return {win, members, labels:km.labels, interp, k, sse:km.sse};
}
const SEASON_PRESETS = {
  winter:     {ms:11, me:2,  color:'#2f7fc1', label:'Winter'},
  summer:     {ms:6,  me:8,  color:'#c1652f', label:'Summer'},
  irrigation: {ms:4,  me:10, color:'#7a9c3f', label:'Irrigation'},
  allyear:    {ms:1,  me:12, color:'#9aa39a', label:'All year'}
};
// Same wells (those qualifying all-year), same composite method, each season's months only.
function computeSeasonalOverlays(result){
  const o = state.otp, overlays = [];
  state.seasonCompare.keys.forEach(key=>{
    const P = SEASON_PRESETS[key];
    if(!P) return;
    const maps = [];
    result.qualifying.forEach(s=>{ const w = otWell(s, P.ms, P.me); if(w.ok) maps.push(otMapOf(w)); });
    const c = otCompose(maps, result.xvals, o.method, o.minN);
    overlays.push({key, label:P.label + ' (' + maps.length + ')', color:P.color, meanSeries:c.mean, medianSeries:c.med});
  });
  return overlays;
}
function refreshScheduleUI(){ /* the old year-schedule chips are gone; kept so older call sites stay harmless */ }

// ---- controls -------------------------------------------------------------------------------------
const OT_METHOD_HINT = {
  ns:'Each well\'s annual values are ranked and turned into normal scores (Blom), so every well has the same distribution regardless of depth or range (the SGI idea of Bloomfield & Marchant 2013, on annual values). Units are standard deviations; up = more water.',
  z:'Each well\'s annual values minus its own mean, divided by its own standard deviation. Units are standard deviations; up = more water. More sensitive to a single extreme year than normal scores.',
  units:'Feet of change since the first plotted year. Two steps: within each HUC-10, the wells are combined with the matched-wells fit; then the HUC-10 series are combined the same way, each weighted by its area, so every part of the area counts by its size, not by how many wells it has. HUC-10s whose wells cover less than half of the years are pooled with the other short ones in their HUC-8. This handles "where the wells are" when each area has wells through the period; it cannot recreate years when part of the area had no wells. The line is the area-weighted average of the units (a median would follow the majority of units, not the area).',
  fe:'Feet of change since the first plotted year. Every well is compared only with itself: the tool fits each well\'s own typical level and one value per year to all wells at once (a robust two-way fixed-effects fit, like a repeat-sales index), so every year is linked to every other through all the wells they share. Wells joining or leaving cannot shift the line, and no single chain of years carries it. The dashed line is the robust (median) fit, the solid line the least-squares (mean) fit.',
  chain:'Feet of change since the first plotted year. The chain starts at the best-measured year; each year is linked to the already-linked year that shares the most wells (earlier or later), and its step is the median change of the wells measured in both years, so wells joining or leaving the record cannot create false steps and a thin year does not break the chain.'
};
function syncOtUi(){
  const o = state.otp;
  document.getElementById('ot-method').value = o.method;
  document.getElementById('ot-annual').value = o.annual; document.getElementById('ot-bin').value = String(o.bin || 1); otBinLabels();
  { const e = document.getElementById('ot-split'); if(e) e.checked = o.split !== false; }
  [['ot-minn','minN'],['ot-minyears','minYears'],['ot-minspan','minSpan'],['ot-spike','spike'],['ot-boot','boot']].forEach(([id,k])=>{ document.getElementById(id).value = o[k]; });
  document.getElementById('ot-method-hint').textContent = OT_METHOD_HINT[o.method];
  { const u = document.getElementById('ot-unitkind'), w = document.getElementById('ot-unitkind-row'); if(u) u.value = o.unitKind || 'huc10'; if(w) w.style.display = o.method === 'units' ? '' : 'none'; }
  document.getElementById('ot-cell').value = String(o.cellKm || 0);
  document.getElementById('ot-fixed').value = String(o.fixed || 0);
}
document.getElementById('ot-cell').addEventListener('change', e=>{ state.otp.cellKm = +e.target.value; renderChart(); });
document.getElementById('ot-fixed').addEventListener('change', e=>{ state.otp.fixed = +e.target.value; renderChart(); });
document.getElementById('ot-unitkind').addEventListener('change', e=>{ state.otp.unitKind = e.target.value; renderChart(); });
document.getElementById('ot-method').addEventListener('change', e=>{ state.otp.method = e.target.value; syncOtUi(); renderChart(); if(state.krig){ state.krig = null; krigUpdate(); } });
function otBinLabels(){ const B = state.otp.bin > 1 ? state.otp.bin : 1, a = document.getElementById('ot-minn-l'), b = document.getElementById('stat-npoints-l');
  if(a) a.textContent = B > 1 ? `Min. wells per ${B}-year step` : 'Min. wells per year'; if(b) b.textContent = B > 1 ? `${B}-year steps plotted` : 'years plotted'; }
document.getElementById('ot-bin').addEventListener('change', e=>{ state.otp.bin = +e.target.value; otBinLabels(); renderChart(); });
document.getElementById('ot-annual').addEventListener('change', e=>{ state.otp.annual = e.target.value; renderChart(); });
document.getElementById('ot-split').addEventListener('change', e=>{ state.otp.split = e.target.checked; renderChart(); });
[['ot-minn','minN',1,10000],['ot-minyears','minYears',2,200],['ot-minspan','minSpan',0,200],['ot-spike','spike',0,100000],['ot-boot','boot',0,5000]].forEach(([id,k,lo,hi])=>{
  document.getElementById(id).addEventListener('change', e=>{
    const v = parseFloat(e.target.value);
    state.otp[k] = isNaN(v) ? otDefaults()[k] : Math.max(lo, Math.min(hi, k==='spike' ? v : Math.round(v)));
    e.target.value = state.otp[k];
    renderChart();
  });
});
function parseRefCsv(text, name){
  const t = parseCsv(text).filter(r=>r.length && r.some(c=>String(c).trim() !== ''));
  const H = t[0].map(x=>String(x).trim().toLowerCase());
  const iy = H.indexOf('year'), ic = H.findIndex(x=>['change_ft','change','value','wl_change_ft'].includes(x)), is = H.findIndex(x=>['se_ft','se','std_error'].includes(x));
  if(iy < 0 || ic < 0) throw new Error('needs columns year and change_ft');
  const rows = t.slice(1).map(r=>({year: parseInt(r[iy]), chg: parseFloat(r[ic]), se: is >= 0 && r[is] !== '' ? parseFloat(r[is]) : null})).filter(r=>isFinite(r.year) && isFinite(r.chg));
  if(!rows.length) throw new Error('no usable rows');
  return {name: name.replace(/\.(csv|txt)$/i, ''), rows};
}
document.getElementById('krig-show').addEventListener('change', e=>{ state.krigShow = e.target.checked; state.krig = null; krigUpdate(); renderChart(); });
document.getElementById('ref-file').addEventListener('change', async e=>{
  const f = e.target.files[0]; if(!f) return;
  try{ state.ref = parseRefCsv(await f.text(), f.name); idbSet('refHydrograph', state.ref); document.getElementById('btn-ref-clear').classList.remove('hidden'); renderChart(); }
  catch(err){ document.getElementById('ref-status').textContent = 'Could not read ' + f.name + ': ' + (err.message || err); }
  e.target.value = '';
});
document.getElementById('btn-ref-clear').addEventListener('click', ()=>{ state.ref = null; idbSet('refHydrograph', null); document.getElementById('ref-status').textContent = ''; document.getElementById('btn-ref-clear').classList.add('hidden'); renderChart(); });
(async()=>{ try{ const r = await idbGet('refHydrograph'); if(r && r.rows){ state.ref = r; document.getElementById('btn-ref-clear').classList.remove('hidden'); renderChart(); } }catch(e){} })();

document.getElementById('btn-ot-wells').addEventListener('click', ()=>{
  const c = window._lastComposite;
  if(!c || !c.wells || !c.wells.length){ toast('No composite yet - select wells and turn off Overview.'); return; }
  const cl = window._lastClusterOf || new Map();
  const rows = [['well_id','nmbgmr_site_id','source','longitude','latitude','n_years','first_year','last_year','span_yr','theil_sen_ft_per_yr_up_is_rising','mann_kendall_p','spike_years_dropped','cluster','site_elevation_ft','usgs_3dep_elevation_ft','elevation_check']];
  c.wells.forEach(w=>{ const r = SITES[w.site]; const ea = siteElevApi[w.site], ed = siteDem[w.site];
    rows.push([r[0], nmbgmrIdOf(w.site)||'', r[3]>=0 ? SOURCES[r[3]] : '', r[1], r[2], w.nYears, w.years[0], w.years[w.years.length-1], w.span, isFinite(w.slope) ? w.slope.toFixed(4) : '', w.p.toFixed(4), w.dropped, cl.has(w.site) ? cl.get(w.site) : '', isNaN(ea) ? '' : Math.round(ea*10)/10, isNaN(ed) ? '' : Math.round(ed*10)/10, (isNaN(ea) || isNaN(ed)) ? (isNaN(ea) && !isNaN(ed) ? '3DEP used (no site elevation)' : '') : (Math.abs(ea - ed) > ELEV_FLAG_FT ? 'differs from 3DEP by more than 300 ft' : 'ok')]); });
  downloadCsv('nm_composite_per_well_stats.csv', rows);
  toast('Exported statistics for ' + c.wells.length + ' wells.');
});
syncOtUi();

function onYearWindowChange(){
  const w = state.yearWindow;
  if(w.min!=null && w.max!=null && w.min > w.max){ const t=w.min; w.min=w.max; w.max=t;
    document.getElementById('yw-min').value = w.min; document.getElementById('yw-max').value = w.max; }
  recomputeTrendAndMean();
  recomputeActiveSet();   // drops wells with no reading in the window and re-renders
  const note = document.getElementById('yw-note');
  if(note){
    note.textContent = (w.min==null && w.max==null) ? '' :
      `Using only readings from ${w.min!=null?w.min:'the start'} to ${w.max!=null?w.max:'the present'}. ${state.activeSet ? state.activeSet.size.toLocaleString() : 0} wells have at least one reading in that window.`;
  }
}
['yw-min','yw-max'].forEach(id=>{
  document.getElementById(id).addEventListener('change', e=>{
    const v = parseInt(e.target.value);
    state.yearWindow[id==='yw-min'?'min':'max'] = isNaN(v) ? null : v;
    onYearWindowChange();
  });
});
document.getElementById('dem-source').addEventListener('change', e=>{ state.useDem = e.target.value === 'dem'; if(!state.useDem){ demApply(); renderChart(); if(state.activeSet) demCheck([...state.activeSet]); } else demEnsure(); });
document.getElementById('toggle-normalize').addEventListener('change', e=>{ state.normalize = e.target.checked; renderChart(); });
document.getElementById('normalize-style').addEventListener('change', e=>{ state.normalizeStyle = e.target.value; renderChart(); });
document.getElementById('toggle-wateryear').addEventListener('change', e=>{
  state.waterYear = e.target.checked;
  onSeasonChange();
});
document.getElementById('group-mode').addEventListener('change', e=>{
  state.group.mode = e.target.value;
  document.getElementById('group-options').classList.toggle('hidden', state.group.mode==='off');
  if(state.group.mode === 'screen' && state.activeSet && (state.areaSelection || state.clickSelectedSites.size)) hxProdLookup([...state.activeSet]).then(() => renderChart());   // file 27
  if(state.group.mode === 'wtres' || state.group.mode === 'belowwt') hxWtLoad().then(() => renderChart());   // file 34
  document.getElementById('group-breaks').style.display = (groupIsCategorical() || state.group.mode === 'cluster') ? 'none' : '';
  renderChart();
});
document.getElementById('group-n').addEventListener('change', e=>{ state.group.n = +e.target.value; renderChart(); });
document.getElementById('group-breaks').addEventListener('change', e=>{
  const nums = e.target.value.split(/[,;\s]+/).map(parseFloat).filter(v=>!isNaN(v));
  state.group.breaks = nums.length ? nums : null;
  document.getElementById('group-n').disabled = !!state.group.breaks;
  renderChart();
});
document.getElementById('spaghetti-cap').addEventListener('change', ()=>renderChart());
document.getElementById('toggle-spaghetti').addEventListener('change', e=>{
  state.showSpaghetti = e.target.checked;
  if(!state.showSpaghetti) state.chartHighlightSite = null;
  renderChart();
});
document.getElementById('toggle-band').addEventListener('change', e=>{ state.showBand = e.target.checked; renderChart(); });
document.querySelectorAll('.mode-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.valueMode = btn.dataset.valuemode;
    document.getElementById('elev-mode-hint').style.display = state.valueMode==='elevation' ? 'block' : 'none';
    document.getElementById('dem-row').style.display = state.valueMode==='elevation' ? 'block' : 'none';
    renderChart();
    demEnsure();
    if(state.valueMode === 'elevation' && !state.useDem && state.activeSet) demLoadCache().then(() => demCheck([...state.activeSet]));
  });
});

// USGS normalization (Myers 2022, eq. 1): N = -1 * (x - mean) / (max - min) * 100, using each well's
// own values at the schedule points. The -1 makes "higher water level" positive for depth-to-water;
// in elevation mode higher is already more water, so no sign flip. Returns the values unchanged
// when the USGS style isn't selected.
function usgsNormalize(vals){
  const nums = vals.filter(v=>v!=null);
  if(!nums.length) return vals;
  const mean = nums.reduce((a,b)=>a+b,0)/nums.length;
  const range = Math.max(...nums) - Math.min(...nums);
  const sign = state.valueMode === 'elevation' ? 1 : -1;
  return vals.map(v => v==null ? null : (range===0 ? 0 : sign*(v-mean)/range*100));
}
function useUsgsNorm(){ return state.normalize && state.normalizeStyle === 'usgs'; }
// ---- Group by depth: split the qualifying wells into depth classes and draw a mean/median per class.
const GROUP_COLORS = ['#0072b2','#e69f00','#009e73','#d55e00','#cc79a7','#56b4e9','#7a5195','#666666'];
const GROUP_MODE_LABELS = {welldepth:'well depth', wtres:'head against the regional water table', belowwt:'depth reached below the regional water table', screen:'top of the screened interval (OSE)', dtw:'depth to water', formation:'geologic formation', usgsaq:'USGS principal aquifer', extent:'aquifer extent (overlapping wells counted in each)', extentcombo:'aquifer extent combination', studyarea:'study area', source:'data source', cluster:'hydrograph cluster'};
function groupIsCategorical(){ return ['formation','usgsaq','extent','extentcombo','studyarea','source'].includes(state.group.mode); }
function groupCategoriesOf(s){
  const r = SITES[s];
  switch(state.group.mode){
    case 'formation': return [r[13]>=0 ? FORMATIONS[r[13]] : 'No formation recorded'];
    case 'usgsaq': return [r[12]>=0 ? AQUIFERS[r[12]] : 'No USGS aquifer recorded'];
    case 'extent': return r[15].length ? r[15].map(i=>AQUIFER_EXTENT_NAMES[i].replace(/_/g,' ')) : ['Outside mapped extents'];
    case 'extentcombo': return r[15].length ? [r[15].map(i=>AQUIFER_EXTENT_NAMES[i].replace(/_/g,' ')).sort().join(' + ')] : ['Outside mapped extents'];
    case 'studyarea': return (r[16]&&r[16].length) ? r[16].map(i=>STUDY_AREA_NAMES[i]) : ['Outside study areas'];
    case 'source': return [r[3]>=0 ? SOURCES[r[3]] : 'Unknown source'];
  }
  return [];
}
function groupValueOf(s){
  if(state.group.mode === 'welldepth') return SITES[s][4];          // construction depth, ft (may be null)
  if(state.group.mode === 'wtres'){ const v = hxWtRes(s); return isFinite(v) ? Math.round(v) : null; }      // file 34
  if(state.group.mode === 'belowwt'){ const v = hxWtBelow(s); return isFinite(v) ? Math.round(v) : null; }
  if(state.group.mode === 'screen'){ const m = hxProd.by.get(s); return m && m.ptop > 0 ? m.ptop : null; }   // file 27
  const v = siteOwnMean[s];                                          // mean depth-to-water, ft (season-aware)
  return isNaN(v) ? null : v;
}
function quantile(sorted, q){
  const pos = (sorted.length-1)*q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi]-sorted[lo])*(pos-lo);
}
function groupSeries(wells, xvals){
  const c = otCompose(wells.map(pw=>pw.cmap), xvals, state.otp.method, state.otp.minN);
  return {meanSeries:c.mean, medianSeries:c.med};
}
function computeGroups(result){
  const g = state.group;
  const {xvals, perWell} = result;
  window._lastClusterOf = null;
  if(g.mode === 'cluster'){
    const cl = otClusterize(perWell, xvals, g.n, 60, state.otp.minN);
    if(!cl) return {groups:[], unknown:perWell.length, breaks:[], cluster:true, fail:true};
    const groups = [], of = new Map();
    for(let c=0;c<cl.k;c++){
      const mem = cl.members.filter((_,i)=>cl.labels[i]===c);
      if(!mem.length) continue;
      mem.forEach(pw=>of.set(pw.site, c+1));
      const sl = OT.median(mem.map(pw=>pw.w.slope).filter(isFinite));
      groups.push({label:`Cluster ${c+1} (${mem.length}, ${sl>=0?'+':''}${sl.toFixed(2)} ft/yr)`, color:GROUP_COLORS[c % GROUP_COLORS.length], n:mem.length, ...groupSeries(mem, xvals)});
    }
    window._lastClusterOf = of;
    return {groups, unknown:perWell.length - cl.members.length, breaks:[], cluster:true, cl};
  }
  if(groupIsCategorical()){
    const by = new Map();
    perWell.forEach(pw=> groupCategoriesOf(pw.site).forEach(c=>{ if(!by.has(c)) by.set(c, []); by.get(c).push(pw); }));
    const ranked = [...by.entries()].sort((a,b)=>b[1].length-a[1].length || a[0].localeCompare(b[0]));
    const keep = ranked.slice(0, g.n), rest = ranked.slice(g.n);
    const groups = keep.map(([name,wells],i)=>({label:`${name} (${wells.length})`, color:GROUP_COLORS[i % GROUP_COLORS.length], n:wells.length, ...groupSeries(wells, xvals)}));
    if(rest.length){
      const seen = new Set(), union = [];
      rest.forEach(([,wells])=>wells.forEach(pw=>{ if(!seen.has(pw.site)){ seen.add(pw.site); union.push(pw); } }));
      groups.push({label:`All other (${union.length})`, color:'#9aa39a', n:union.length, ...groupSeries(union, xvals)});
    }
    return {groups, unknown:0, breaks:[], categorical:true, total:ranked.length};
  }
  const known = perWell.map(pw=>({pw, v:groupValueOf(pw.site)}));
  const withV = known.filter(k=>k.v!=null);
  const unknown = known.length - withV.length;
  if(!withV.length) return {groups:[], unknown, breaks:[]};
  let breaks;
  if(g.breaks && g.breaks.length){
    breaks = g.breaks.slice().sort((a,b)=>a-b);
  } else {
    const sorted = withV.map(k=>k.v).sort((a,b)=>a-b);
    breaks = [];
    for(let i=1;i<g.n;i++) breaks.push(Math.round(quantile(sorted, i/g.n)));
    breaks = breaks.filter((b,i)=> i===0 || b>breaks[i-1]); // collapse duplicate cut points
  }
  const nG = breaks.length + 1;
  const buckets = Array.from({length:nG}, ()=>[]);
  withV.forEach(k=>{ let gi = 0; while(gi < breaks.length && k.v >= breaks[gi]) gi++; buckets[gi].push(k.pw); });
  const fmt = n => n.toLocaleString();
  const names = Array.from({length:nG}, (_,i)=> i===0 ? `< ${fmt(breaks[0])} ft` : (i===nG-1 ? `≥ ${fmt(breaks[nG-2])} ft` : `${fmt(breaks[i-1])}–${fmt(breaks[i])} ft`));
  const groups = [];
  buckets.forEach((wells,i)=>{
    if(!wells.length) return;
    groups.push({label:`${names[i]} (${wells.length})`, color:GROUP_COLORS[i % GROUP_COLORS.length], n:wells.length, ...groupSeries(wells, xvals)});
  });
  return {groups, unknown, breaks};
}
function SPAGHETTI_CAP(){
  const v = parseInt(document.getElementById('spaghetti-cap').value);
  return isNaN(v) ? 500 : Math.min(50000, Math.max(10, v));
}
// ---- the composite (cached: renderChart runs on every theme/legend/UI change) ----------------------
const otSetIds = new WeakMap(); let otSetSeq = 0;
let otCache = {key:null, val:null};
let otLastDiag = null;   // why no composite could be drawn (for the empty-chart message)
function otKey(){
  let id = state.activeSet && state.activeSet._key;
  if(id == null){ id = otSetIds.get(state.activeSet); if(id == null){ id = 'o' + (++otSetSeq); otSetIds.set(state.activeSet, id); } }
  return [id, otDataVer, JSON.stringify(state.otp), state.season.monthStart, state.season.monthEnd, state.waterYear,
    state.despike.enabled, state.despike.threshold, state.yearWindow.min, state.yearWindow.max, state.valueMode,
    state.showBand ? 1 : 0, [...state.excludedSites].sort((a,b)=>a-b).join(',')].join('|');
}
function computeComposite(){
  const pool = candidatePoolForSchedule();
  if(!pool.length){ otLastDiag = null; return null; }
  const key = otKey();
  if(otCache.key === key) return otCache.val;
  const val = computeCompositeFresh(pool);
  otCache = {key, val};
  return val;
}
function computeCompositeFresh(pool){
  const o = state.otp;
  const cand = state.valueMode === 'elevation' ? pool.filter(s => hasElevation(s)) : pool;
  let spikeDropped = 0, tooShort = 0;
  const wells = [];
  for(const s of cand){ const w = otWell(s); spikeDropped += w.dropped; if(w.ok) wells.push(w); else tooShort++; }
  otLastDiag = {pool:pool.length, cand:cand.length, tooShort, ok:wells.length, maxN:0};
  if(!wells.length) return null;
  const algoQualifying = wells.map(w=>w.site);
  let used = wells.filter(w=>!state.excludedSites.has(w.site));
  // fixed well set: wells measured within 2 years of both ends of the period and in at least o.fixed % of its years
  let fixedInfo = null;
  if(o.fixed > 0 && used.length){
    const cnt = new Map(); used.forEach(w => w.years.forEach(y => cnt.set(y, (cnt.get(y)||0) + 1)));
    const ys = [...cnt.keys()].filter(y => cnt.get(y) >= o.minN).sort((a,b)=>a-b);
    const passes = (w, a, b) => { if(w.years[0] > a + 2 || w.years[w.years.length-1] < b - 2) return false; const need = Math.ceil((b - a + 1) * o.fixed / 100); let k = 0, s0 = false, s1 = false;
      for(const y of w.years){ if(y >= a && y <= b){ k++; if(y <= a + 2) s0 = true; if(y >= b - 2) s1 = true; } } return s0 && s1 && k >= need; };
    let wy0 = state.yearWindow.min, wy1 = state.yearWindow.max, auto = false;
    if(wy0 == null && wy1 == null && ys.length > 1){
      // no period set: use the longest period that at least max(minN, 10) wells cover this well (ties: more wells)
      const target = Math.max(o.minN, 10); let best = null;
      for(let i=0;i<ys.length;i++) for(let j=ys.length-1;j>i;j--){
        const a = ys[i], b = ys[j]; if(best && b - a < best.b - best.a) break;
        let c = 0; for(const w of used) if(passes(w, a, b)) c++;
        if(c >= target && (!best || b - a > best.b - best.a || (b - a === best.b - best.a && c > best.c))){ best = {a, b, c}; break; }
      }
      if(best){ wy0 = best.a; wy1 = best.b; auto = true; }
    }
    if(wy0 == null) wy0 = ys[0]; if(wy1 == null) wy1 = ys[ys.length-1];
    if(wy0 != null && wy1 != null && wy1 > wy0){
      const need = Math.ceil((wy1 - wy0 + 1) * o.fixed / 100);
      const kept = used.filter(w => passes(w, wy0, wy1));
      fixedInfo = {wy0, wy1, pct:o.fixed, need, kept:kept.length, dropped:used.length - kept.length, auto};
      used = kept;
    }
  }
  const base = {algoQualifying, poolSize:pool.length, tooShort, spikeDropped, method:o.method, prov:null, scheduleMode:'years', fixedInfo};
  otLastDiag.fixedInfo = fixedInfo;
  if(!used.length) return Object.assign(base, {labels:[], xvals:[], qualifying:[], perWell:[], wells:[], meanSeries:[], medianSeries:[], minSeries:[], maxSeries:[], nSeries:[], scheduleUnits:[], despikeRemoved:0});
  let y0 = Infinity, y1 = -Infinity;
  used.forEach(w=>{ if(w.years[0] < y0) y0 = w.years[0]; if(w.years[w.years.length-1] > y1) y1 = w.years[w.years.length-1]; });
  const B = o.bin > 1 ? o.bin : 1;   // with 3- or 5-year steps only the steps' middle years carry values
  let years = []; for(let y=y0; y<=y1; y++) if(B === 1 || ((y - 1980) % B + B) % B === otBinMid(B)) years.push(y);
  const maps = used.map(otMapOf);
  // the fit uses each well's season halves when they exist (see otSplitOn); lines per well still use the whole-year values
  const fitMaps = (o.method === 'fe' || o.method === 'units') ? used.flatMap(w => w.mapSeas || [w.mapDisp]) : maps;
  let comp = otCompose(fitMaps, years, o.method, o.minN);
  otLastDiag.maxN = Math.max(0, ...comp.n);
  let a = 0, b = years.length-1;
  while(a <= b && comp.med[a] == null) a++;
  while(b >= a && comp.med[b] == null) b--;
  if(a > b) return null;   // no year reaches the minimum number of wells
  years = years.slice(a, b+1);
  const unitsInfo = comp.unitsInfo || null;
  // redraw once the HUC-10 boundaries arrive; if they cannot be loaded the lookup resolves empty and must not redraw again
  // (that re-asked, redrew and re-asked without end, freezing the page)
  if(unitsInfo && unitsInfo.pending && !otH10Retry){ otH10Retry = true; ensureSiteH10().then(r => { if(r){ otCache.key = null; renderChart(); } else toast('The HUC-10 boundaries could not be loaded, so area units fall back to matched wells. Choose "Aquifer outlines" as the area unit instead.'); }); }
  comp = {med:comp.med.slice(a,b+1), mean:comp.mean.slice(a,b+1), n:comp.n.slice(a,b+1), anchor: comp.anchor ? comp.anchor.slice(a,b+1) : null};
  const band = state.showBand ? otBootBand(fitMaps, years, o.method, o.minN, o.boot, 3) : null;
  // individual-well lines: the standardized values; for chain mode each well's own feet, shifted so it
  // starts on the composite median at its first plotted year
  const perWell = used.map((w,idx)=>{
    const m = maps[idx];
    let values = years.map(y=> m.has(y) ? m.get(y) : null);
    if(otFeet(o.method)){
      const i0 = values.findIndex((v,i)=> v != null && comp.med[i] != null);
      const off = i0 >= 0 ? comp.med[i0] - values[i0] : null;
      values = values.map(v=> v == null || off == null ? null : v + off);
    }
    return {site:w.site, w, cmap:m, values, src:years.map(()=>null)};
  });
  // composition strip: how the wells measured each year differ from the whole set (own typical level, location)
  let composition = null;
  try{
    const dm = used.map(w=>w.mapDisp);
    const fe = (o.method === 'fe' && !o.cellKm) ? null : otFixedEffects(dm, years, o.minN, 0);
    const eff = fe ? fe.eff : otFixedEffects(dm, years, o.minN, 0).eff;
    const fin = [...eff].filter(isFinite), abar = fin.reduce((a,b)=>a+b,0) / Math.max(1, fin.length);
    let cx = 0, cy = 0, cn = 0; dm.forEach(m => { if(isFinite(m._x)){ cx += m._x; cy += m._y; cn++; } }); cx /= cn || 1; cy /= cn || 1;
    const lvl = [], dist = [];
    years.forEach((y,i) => {
      if(comp.med[i] == null){ lvl.push(null); dist.push(null); return; }
      let s = 0, k = 0, x = 0, yy = 0, kx = 0;
      dm.forEach((m,w) => { if(!m.has(y)) return; if(isFinite(eff[w])){ s += eff[w]; k++; } if(isFinite(m._x)){ x += m._x; yy += m._y; kx++; } });
      lvl.push(k ? s/k - abar : null); dist.push(kx ? Math.hypot(x/kx - cx, yy/kx - cy) : null);
    });
    // sustained move of the measured wells' centre: 10-year rolling median of the distance, relative to the RMS
    // distance of all wells from their centre (how spread out the wells are)
    let r2 = 0, rn = 0; dm.forEach(m => { if(isFinite(m._x)){ r2 += (m._x-cx)**2 + (m._y-cy)**2; rn++; } });
    const rad = Math.sqrt(r2 / Math.max(1, rn));
    const pts = years.map((y,i) => [y, dist[i]]).filter(p => p[1] != null);
    let worst = null;
    for(const [y] of pts){ const win = pts.filter(p => p[0] >= y - 4 && p[0] <= y + 5).map(p => p[1]); if(win.length < 4) continue;
      const md = OT.median(win); if(!worst || md > worst.km) worst = {km: md, from: Math.max(pts[0][0], y - 4), to: Math.min(pts[pts.length-1][0], y + 5)}; }
    const shift = worst && rad > 0 ? Object.assign(worst, {rad, ratio: worst.km / rad}) : null;
    // does it matter? the wells measured in those years must also behave differently: compare their own long-term
    // trends (Theil-Sen, ft/yr) with the trend of all wells, over years with at least OT_THIN wells
    const slAll = used.map(w => w.slope).filter(isFinite), sAll = slAll.length ? OT.median(slAll) : 0;
    const spts = [];
    years.forEach((y,i) => { if(comp.med[i] == null) return; const a = []; used.forEach((w,k) => { if(dm[k].has(y) && isFinite(w.slope)) a.push(w.slope); }); if(a.length >= OT_THIN) spts.push([y, OT.median(a) - sAll, dist[i]]); });
    let tw = null;
    for(const [y] of spts){ const win = spts.filter(p => p[0] >= y - 4 && p[0] <= y + 5); if(win.length < 4) continue;
      const d = OT.median(win.map(p => p[1])), km = OT.median(win.map(p => p[2]));
      if(!tw || Math.abs(d) > Math.abs(tw.dslope)) tw = {dslope: d, km, from: Math.max(spts[0][0], y - 4), to: Math.min(spts[spts.length-1][0], y + 5)}; }
    const warn = !!(tw && rad > 0 && tw.km / rad > 0.5 && Math.abs(tw.dslope) >= Math.max(0.3, 0.5 * Math.abs(sAll)));
    composition = {lvl, dist, shift: warn ? Object.assign({}, tw, {rad, sAll}) : shift, warn, diag: {shift, tw, rad, sAll}};
    window._lastCompositionDiag = composition.diag;
  }catch(e){ console.warn('composition strip', e); }
  const ok = years.map((y,i)=>[y, comp.med[i]]).filter(p=>p[1] != null);
  const compTrend = ok.length > 3 ? Object.assign(OT.theilSen(ok.map(p=>p[0]), ok.map(p=>p[1])), {p:OT.mannKendall(ok.map(p=>p[1])).p, n:ok.length}) : null;
  const sl = used.map(w=>w.slope).filter(isFinite);
  const slopeStats = sl.length ? {median:OT.median(sl), ci:OT.bootMedianCI(sl, Math.max(50, Math.min(400, Math.floor(2e6/sl.length))), 5), falling:sl.filter(x=>x<0).length, n:sl.length, sig:used.filter(w=>w.p < .05).length} : null;
  return Object.assign(base, {
    labels: years.map(String), xvals: years, qualifying: used.map(w=>w.site), perWell, wells: used,
    meanSeries: comp.mean, medianSeries: comp.med, nSeries: comp.n, anchorSeries: comp.anchor,
    minSeries: band ? band.lo : years.map(()=>null), maxSeries: band ? band.hi : years.map(()=>null), band,
    scheduleUnits: years, compTrend, slopeStats, composition, unitsInfo,
    despikeRemoved: used.reduce((acc,w)=>acc+flagCountForSite(w.site),0)
  });
}

function handleChartWellClick(siteIdx){
  state.chartHighlightSite = (state.chartHighlightSite === siteIdx) ? null : siteIdx;
  if(state.chartHighlightSite != null){
    const rec = SITES[siteIdx];
    if(rec[1]!=null && rec[2]!=null){
      if(document.body.dataset.screen === 'charts'){ map.setView([rec[2], rec[1]], Math.max(map.getZoom(), 10), {animate:true}); }   // locator: just show where it is
      else {
        map.flyTo([rec[2], rec[1]], Math.max(map.getZoom(), 13), {duration:0.6});
        const m = markers[siteIdx];
        if(m) setTimeout(()=>{ try{ showWellPopup(siteIdx, m); }catch(e){} }, 650);
      }
    }
  } else { try{ map.closePopup(); }catch(e){} }
  if(state.showAllWells && wvApplyHighlight()){ restyleMarkers(); return; }
  renderChart();
}
function updateExplainPanel(result, set, allExcluded){
  const el = document.getElementById('explain-text');
  if(!el) return;
  const parts = [], o = state.otp;
  const n = set ? set.size : 0;

  // 1. What's selected
  if(state.areaSelection){
    parts.push(`You've selected ${state.areaSelection.label || 'an area'}, which contains ${n.toLocaleString()} well(s) after your current filters.`);
  } else if(state.clickSelectedSites.size){
    parts.push(`You've manually picked ${state.clickSelectedSites.size} well(s) on the map (no area drawn).`);
  } else if(n > 0){
    parts.push(`No area is selected, so this reflects all ${n.toLocaleString()} wells statewide that pass your current filters — draw a polygon or pick a county/aquifer/HUC-8 to narrow it down.`);
  } else {
    parts.push(`Nothing is selected yet. Draw a polygon, pick an area from the Select Area tab, or click wells on the map to get started.`);
  }

  // 2. Season / window
  if(!seasonIsFullYear()){
    const monthName = m => ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m];
    parts.push(`Only readings from ${monthName(state.season.monthStart)}–${monthName(state.season.monthEnd)} count toward each year, so this is a seasonal slice, not the full-year picture.`);
  }
  if(state.yearWindow.min!=null || state.yearWindow.max!=null){
    parts.push(`A year window is set (${state.yearWindow.min!=null?state.yearWindow.min:'earliest'}–${state.yearWindow.max!=null?state.yearWindow.max:'latest'}): readings outside it are ignored, and wells with no reading inside it are left out entirely.`);
  }
  if(state.waterYear) parts.push(`Years are water years (Oct 1–Sep 30, named for the year they end in).`);

  // 3. Method
  parts.push(`Method (Over the Top): each well gets one value per year (${o.annual==='median' ? 'the median of its monthly values' : 'the reading-weighted mean'}), years that jump more than ${o.spike} ft/yr from both neighbours are dropped${o.spike ? '' : ' (spike filter off)'}, and a well needs at least ${o.minYears} years of data spanning at least ${o.minSpan} years. ` +
    (o.method === 'units'
      ? (o.unitKind === 'aquifer' ? `The composite is built from aquifer outlines (the NM 2-D aquifer extents; where extents overlap, the overlap is its own unit): within each unit the wells are matched against themselves, then the unit series are matched and averaged by each unit's area inside the selection (feet of change since the first plotted year).` : `The composite is built from areas: within each HUC-10 the wells are matched against themselves, then the HUC-10 series are matched and averaged by area, so each part of the area counts by its size, not its number of wells (feet of change since the first plotted year).`) + (result && result.unitsInfo && result.unitsInfo.units ? (result.unitsInfo.kind === 'aquifer' ? ` ${result.unitsInfo.huc10} aquifer units had qualifying wells; ${result.unitsInfo.pooled} with short records were pooled into one group, giving ${result.unitsInfo.units} units.` : ` ${result.unitsInfo.huc10} HUC-10s had qualifying wells; ${result.unitsInfo.pooled} with short records were pooled into ${result.unitsInfo.pooledInto} HUC-8 group(s), giving ${result.unitsInfo.units} units.`) : (result && result.unitsInfo && result.unitsInfo.pending ? ' (HUC-10 boundaries are still loading, so matched wells is shown for now.)' : ''))
      : o.method === 'fe'
      ? `The composite compares every well only with itself: a robust two-way fit gives each well its own typical level and each year one value, using all wells at once, so wells joining or leaving the record cannot move the line (feet of change since the first plotted year).`
      : o.method === 'chain'
      ? `The composite is a chain of changes in feet, starting at 0: the chain starts at the best-measured year and each year is linked to the already-linked year that shares the most wells (earlier or later), and its step is the median change of the wells measured in both years.`
      : `Each well is then rescaled to ${o.method === 'ns' ? 'normal scores' : 'z-scores'} so deep and shallow wells count equally, and each year shows the median across wells (up = more water).`) +
    ` A year is drawn only if at least ${o.minN} wells have a value in it; a well counts in every year it was measured, and nothing is shifted between years or interpolated.`);
  if(result && result.composition && result.composition.warn){ const S = result.composition.shift; parts.push(`Warning: where the measured wells are changes over the record (around ${S.from}–${S.to} their centre is about ${S.km.toFixed(0)} km from the centre of all wells, and their own trends differ from the rest by about ${Math.abs(S.dslope).toFixed(1)} ft/yr). No composite can fully correct for that; try the Area units method or split the area.`); }
  if(o.cellKm) parts.push(`Area weighting is on: each year, wells in the same ${o.cellKm} km grid cell share one vote, so clusters of wells don't outweigh the rest of the area.`);
  if(result && result.fixedInfo){ const f = result.fixedInfo; parts.push(`Fixed well set: only wells measured within 2 years of ${f.wy0} and of ${f.wy1} and in at least ${f.pct}% of the years between (${f.need}+ years) are used: ${f.kept.toLocaleString()} wells kept, ${f.dropped.toLocaleString()} left out.` + (f.auto ? ` ${f.wy0}–${f.wy1} is the longest period that at least ${Math.max(o.minN,10)} wells cover this well; set the period slider to choose another.` : '')); }
  else if(o.fixed && !result && otLastDiag && otLastDiag.fixedInfo) parts.push(`Fixed well set: no well was measured near both ${otLastDiag.fixedInfo.wy0} and ${otLastDiag.fixedInfo.wy1} and in ${otLastDiag.fixedInfo.pct}% of the years between. Narrow the period with the slider or lower the share.`);
  if(state.group.mode !== 'off') parts.push(state.group.mode === 'cluster'
    ? `The wells are clustered by hydrograph shape (k-means on each well's z-scores, ${state.group.n} clusters); each cluster gets its own median and mean line using the method above.`
    : `The wells are split into groups by ${GROUP_MODE_LABELS[state.group.mode]}, each with its own median and mean line, so unlike wells aren't combined.`);
  if(!state.despike.enabled) parts.push(`Automatic bad-reading removal is turned off, so isolated data-entry errors (if any) are still included.`);

  // 4. Result
  if(!result){
    const d = otLastDiag;
    if(d && !d.ok) parts.push(`No composite: none of the ${d.cand.toLocaleString()} wells has ${o.minYears}+ years of data over a ${o.minSpan}+ year span. Lower those rules or widen the period.`);
    else if(d) parts.push(`No composite: ${d.ok.toLocaleString()} wells pass the record rules, but no year has ${o.minN} of them measured (the most in any year is ${d.maxN}). Lower "Min. wells per year" or select more wells.`);
    else parts.push(`No composite line could be built with the current settings.`);
  } else {
    const {qualifying, algoQualifying, labels, medianSeries, poolSize, despikeRemoved} = result;
    if(allExcluded){
      parts.push(`${algoQualifying.length} well(s) pass the rules, but you've manually excluded all of them from the chart.`);
    } else {
      const drawn = medianSeries.filter(v=>v!=null).length;
      parts.push(`${qualifying.length.toLocaleString()} of the ${poolSize.toLocaleString()} selected well(s) pass the record rules (${result.tooShort.toLocaleString()} too short); ${drawn} year(s) from ${labels[0]} to ${labels[labels.length-1]} have at least ${o.minN} wells` + (drawn < labels.length ? `, and ${labels.length - drawn} year(s) in between are left empty` : '') + `. The bars show how many wells are in each year; years with fewer than ${OT_THIN} wells have hollow markers and deserve caution.`);
      if(result.spikeDropped) parts.push(`${result.spikeDropped} annual value(s) were dropped by the spike filter.`);
      if(despikeRemoved > 0) parts.push(`${despikeRemoved} likely bad reading(s) were excluded as data-entry errors.`);
      const u = otUnits();
      if(result.compTrend) parts.push(`Trend of the composite median: ${result.compTrend.slope>=0?'+':''}${result.compTrend.slope.toFixed(3)} ${u}/yr (Theil–Sen; Mann–Kendall p = ${result.compTrend.p.toFixed(3)}, optimistic because annual values are autocorrelated)` + (o.method === 'chain' ? (state.valueMode === 'depth' ? ` — positive means depth to water is increasing (water table falling).` : ` — positive means the water surface is rising.`) : ` — positive means water levels are rising.`));
      const ss = result.slopeStats;
      if(ss) parts.push(`Per well: median Theil–Sen slope ${ss.median>=0?'+':''}${ss.median.toFixed(2)} ft/yr of water level (95% CI ${ss.ci[0].toFixed(2)} to ${ss.ci[1].toFixed(2)}; negative = falling), ${Math.round(100*ss.falling/ss.n)}% of wells falling, ${ss.sig} with a significant trend (p < 0.05).`);
      if(result.band){
        if(!result.band.B) parts.push(`The bootstrap band is skipped for this many wells (it would be very narrow); select fewer wells to see it.`);
        else parts.push(`The shaded band is the 95% bootstrap range of the change since the first plotted year (${result.band.B} resamples of ${result.band.groups || ''} groups of nearby wells${result.band.B < result.band.asked ? `, reduced from ${result.band.asked} to keep a large selection responsive` : ''}). A wide band means the wells disagree or few wells are present.`);
      }
      if(seasonIsFullYear() && !state.seasonCompare.enabled) parts.push(`Season: all months are combined. Irrigation-season lows can differ from winter levels by more than the year-to-year change, so restricting every year to the same months (for example Nov–Feb) makes the comparison more reliable.`);
      if(state.normalize) parts.push(`"Normalize per well" only changes the Overview plot; the composite always uses the method above.`);
      if(qualifying.length < 10) parts.push(`Only a handful of wells qualify here, so treat this composite as suggestive rather than a robust regional signal.`);
    }
  }
  el.textContent = parts.join(' ');
}

// ---- Wells view (default) -----------------------------------------------------------
// Every selected well drawn on its own from its monthly values (mean of the readings in each month),
// after the season, period, despike, elevation and normalization settings. No composite is built in
// this view; the Composite tab builds it from the same selection with every setting as before.
const WV_GAP_YEARS = 3;   // a line is broken where a well has no reading for more than this many years
const WV_PALETTE = ['#d55e00','#0072b2','#009e73','#cc79a7','#e69f00','#56b4e9','#7a5195','#4d4d4d','#a6761d','#1b9e77','#e7298a','#66a61e'];   // Okabe-Ito based: distinguishable with common colour-vision differences
const WV_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const wv = {sort:'record', q:'', rows:[], all:[], hidden:0, noData:0, total:0, step:'raw', hideFlagged:false, fullRecord:false};   // fullRecord: the period picks the wells, but whole records are drawn   // step: 'raw' | 'month' | 'year'
// The Wells view shows everything by default: readings flagged as likely data-entry errors are drawn and marked (red \u00d7),
// not removed; the composite still leaves them out. "Wells view: hide flagged readings too" (Data quality) removes them here as well.
let wvStatLabels = null;

function wvSeries(s){
  const months = siteMonthMap.get(s);
  if(!months || !months.length) return null;
  const ms = state.season.monthStart, me = state.season.monthEnd;
  const inR = (ms === 1 && me === 12) ? null : (ms <= me ? (m => m >= ms && m <= me) : (m => m >= ms || m <= me));
  const bad = monthFlagsFor(s), w = state.yearWindow;
  const pts = [];
  for(const p of months){
    if(inR && !inR(p.month)) continue;
    if(!wv.fullRecord && ((w.min != null && p.year < w.min) || (w.max != null && p.year > w.max))) continue;
    const flag = bad.size > 0 && bad.has(monthKey(p));
    if(flag && wv.hideFlagged) continue;
    const v = toDisplay(s, p.avg);
    if(v == null || !isFinite(v)) continue;
    pts.push({x: p.year + (p.month - 0.5) / 12, y: v, year: p.year, month: p.month, n: p.n, dtw: p.avg, flag});
  }
  if(!pts.length) return null;
  pts.sort((a, b) => a.x - b.x);
  return wvNorm(pts);
}
function wvNorm(pts){
  if(useUsgsNorm()){ const v = usgsNormalize(pts.map(p => p.y)); pts.forEach((p, i) => { p.y = v[i]; }); }
  else if(state.normalize && state.normalizeStyle === 'first'){ const f = (pts.find(p => !p.flag) || pts[0]).y; pts.forEach(p => { p.y = Math.round((p.y - f) * 100) / 100; }); }
  else if(state.normalize){ const m = pts.reduce((a, p) => a + p.y, 0) / pts.length; pts.forEach(p => { p.y = Math.round((p.y - m) * 100) / 100; }); }
  return pts;
}
// ---- time step (raw readings / monthly / annual) -------------------------------------
const WV_STEP = {
  raw:   {label:'raw readings',  noun:'readings',       short:'rd', axis:'Date (each reading)'},
  month: {label:'monthly values', noun:'monthly values', short:'mo', axis:'Year (monthly values)'},
  year:  {label:'yearly values',  noun:'yearly values',  short:'yr', axis:'Year (yearly values)'}
};
// Annual: the tool's yearly value (mean of the year's readings, reading-weighted) after season, water year and bad-reading removal
function wvYearSeries(s){
  const clean = wv.fullRecord ? despikeSeries(baseSeriesForSeason(s), state.despike.threshold) : getYearSeries(s), pts = [];
  if(wv.hideFlagged || !state.despike.enabled){
    for(const p of clean){ const v = toDisplay(s, p.avg); if(v == null || !isFinite(v)) continue; pts.push({x: p.year, y: v, year: p.year, n: p.n, dtw: p.avg, flag: false}); }
    return pts.length ? wvNorm(pts) : null;
  }
  // every year with readings (same season / water-year rules), flagged when bad-reading removal drops or changes it
  const months = siteMonthMap.get(s); if(!months || !months.length) return null;
  const ms = state.season.monthStart, me = state.season.monthEnd;
  const inR = (ms === 1 && me === 12) ? null : (ms <= me ? (m => m >= ms && m <= me) : (m => m >= ms || m <= me));
  const by = new Map(), bad = monthFlagsFor(s);
  for(const p of months){
    if(inR && !inR(p.month)) continue;
    const yr = ((state.waterYear && p.month >= 10) || (ms > me && p.month >= ms)) ? p.year + 1 : p.year;
    const a = by.get(yr) || {sum: 0, n: 0, flag: false}; a.sum += p.avg * p.n; a.n += p.n; if(bad.size && bad.has(monthKey(p))) a.flag = true; by.set(yr, a);
  }
  const cleanBy = new Map(clean.map(p => [p.year, p.avg]));
  [...by.keys()].sort((a, b) => a - b).forEach(year => {
    if(!wv.fullRecord && !yearInWindow(year)) return;
    // flagged when the removal drops the year or one of its months; otherwise the tool's own yearly value is used
    const a = by.get(year), c = cleanBy.get(year), flag = c == null || a.flag, avg = flag ? a.sum / a.n : c;
    const v = toDisplay(s, avg); if(v == null || !isFinite(v)) return;
    pts.push({x: year, y: v, year, n: a.n, dtw: avg, flag});
  });
  return pts.length ? wvNorm(pts) : null;
}
// Raw: individual readings, fetched from the API for the wells drawn and kept for this session
const wvRaw = {cache: new Map(), failed: new Set(), loading: null, done: 0, total: 0};
function wvMerging(){ try{ return !!mergeApplied; }catch(e){ return false; } }
function wvPartners(s){
  if(!wvMerging()) return [];
  if(!wvRaw.rev || wvRaw.revN !== clusterKeep.size){
    wvRaw.rev = new Map(); wvRaw.revN = clusterKeep.size;
    clusterKeep.forEach((k, p) => { if(!wvRaw.rev.has(k)) wvRaw.rev.set(k, []); wvRaw.rev.get(k).push(p); });
  }
  return wvRaw.rev.get(s) || [];
}
// readings of one well from the store kept in the browser; null when there is no store
function wvFromStore(s){
  const R = BOOT.raw; if(!R || s >= R.off.length - 1) return null;
  const out = [];
  for(let i = R.off[s]; i < R.off[s + 1]; i++){
    out.push({d: rawDateOf(R.day[i]), time: rawTimeOf(R.min[i]), v: R.v[i] / 100, fl: R.fl[i], q: R.qT[R.q[i]] || '', a: R.aT[R.a[i]] || '', kind: 'api'});
  }
  return out;
}
function wvRawMissing(sites){
  const need = new Set();
  sites.forEach(s => [s, ...wvPartners(s)].forEach(x => { if(!wvRaw.cache.has(x)) need.add(x); }));
  if(BOOT.raw) return [];   // every reading is kept in the browser: nothing to fetch
  return [...need];
}
async function wvLoadRaw(need){
  wvRaw.done = 0; wvRaw.total = 0; wvStepStatus();
  const ts = await fetchRawTimeseries(need, (d, t) => { wvRaw.done = d; wvRaw.total = t; wvStepStatus(); });
  const keyOf = new Map(need.map(s => [rawWellKey(s), s]));
  const per = new Map(need.map(s => [s, []])), seen = new Set();
  for(const r of ts.rows){
    if(r[2] !== API_DTW) continue;
    const v = Number(r[3]), d = r[5];
    if(!isFinite(v) || !d || d > todayStr || d < '1800') continue;      // same rules as the loader (drops e.g. 2316 dates)
    const s = keyOf.get(r[0] + '\u0001' + r[1]); if(s == null) continue;
    const k = s + '|' + d + '|' + r[6] + '|' + v; if(seen.has(k)) continue; seen.add(k);
    per.get(s).push({d, time: r[6] || '', v, fl: readingFlags({qualifier: r[12], approval_status_normalized: r[11], source_parameter_name: r[7]}), q: r[12] || '', a: r[11] || '', kind: 'api'});
  }
  const failed = new Set(ts.failures);
  per.forEach((L, s) => { wvRaw.cache.set(s, L); if(failed.has(rawWellKey(s).replace('\u0001', ':'))) wvRaw.failed.add(s); });
}
function wvDecYear(d){ const y = +d.slice(0, 4); return y + (Date.UTC(y, +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(y, 0, 1)) / (365.25 * 864e5); }
// Year / month / decimal year of a store day, cached (the same days recur across wells)
const wvDayCache = new Map();
function wvDayInfo(day){
  let r = wvDayCache.get(day);
  if(!r){ const dt = new Date(RAW_EPOCH + day * 864e5), y = dt.getUTCFullYear(), j1 = (Date.UTC(y, 0, 1) - RAW_EPOCH) / 864e5;
    r = {year: y, month: dt.getUTCMonth() + 1, x: y + (day - j1) / 365.25}; wvDayCache.set(day, r); }
  return r;
}
// Points are kept small: a reading from the store carries its store index (i); date, time, qualifier and approval
// are read from the store only when a tooltip or an export needs them.
function wvPtDate(p){ return p.d != null ? p.d : rawDateOf(BOOT.raw.day[p.i]); }
function wvPtTime(p){ return p.time != null ? p.time : rawTimeOf(BOOT.raw.min[p.i]); }
function wvPtQual(p){ return p.q != null ? p.q : (BOOT.raw.qT[BOOT.raw.q[p.i]] || ''); }
function wvPtAppr(p){ return p.a != null ? p.a : (BOOT.raw.aT[BOOT.raw.a[p.i]] || ''); }
function wvRawSeries(s){
  const R = BOOT.raw, useStore = !!R && s < R.off.length - 1;
  if(!useStore && !wvRaw.cache.get(s)) return null;
  const pass = readPass(), offs = window._mergeOffAll || new Map(), added = window.__rawAdded || new Map();
  const ms = state.season.monthStart, me = state.season.monthEnd;
  const inR = (ms === 1 && me === 12) ? null : (ms <= me ? (m => m >= ms && m <= me) : (m => m >= ms || m <= me));
  const bad = monthFlagsFor(s), w = state.yearWindow, toD = v => toDisplay(s, v);
  const monVals = new Map(), pts = [];
  // a partner agency's reading within 0.05 ft of one already in that month is the same measurement stored twice
  const keep = (from, year, month, v) => {
    const mk = year * 12 + month, L = monVals.get(mk);
    if(from !== s && L && L.some(x => Math.abs(x - v) <= 0.05)) return false;
    if(L) L.push(v); else monVals.set(mk, [v]);
    return true;
  };
  const add = (from, year, month, x, v, fl, extra) => {
    if(!keep(from, year, month, v)) return;
    if(!pass(fl)) return;
    if(inR && !inR(month)) return;
    if(!wv.fullRecord && ((w.min != null && year < w.min) || (w.max != null && year > w.max))) return;
    const flag = bad.size > 0 && bad.has(year * 12 + month);
    if(flag && wv.hideFlagged) return;
    const y = toD(v); if(y == null || !isFinite(y)) return;
    const p = {x, y, year, month, n: 1, dtw: v, from, flag}; if(extra) Object.assign(p, extra); pts.push(p);
  };
  const fromStore = (site, off) => {
    const pm = state.readQ && state.readQ.pumpHeur && hxPump && hxPump.mark;
    for(let i = R.off[site]; i < R.off[site + 1]; i++){
      if(pm && pm[i]) continue;   // left out as likely pumped (Reading quality)
      const di = wvDayInfo(R.day[i]), v = off ? Math.round((R.v[i] / 100 - off) * 100) / 100 : R.v[i] / 100;
      add(site, di.year, di.month, di.x, v, R.fl[i], off ? {i, kind: 'api'} : {i, kind: 'api'});
    }
  };
  const fromList = (site, list, off) => (list || []).forEach(r => {
    const v = off ? Math.round((r.v - off) * 100) / 100 : r.v, year = +r.d.slice(0, 4), month = +r.d.slice(5, 7);
    add(site, year, month, wvDecYear(r.d), v, r.fl, {d: r.d, time: r.time || '', q: r.q || '', a: r.a || '', kind: r.kind, ofr: r.ofr || ''});
  });
  if(useStore) fromStore(s, 0); else fromList(s, wvRaw.cache.get(s), 0);
  fromList(s, added.get(s), 0);
  wvPartners(s).forEach(pt => {
    const off = offs.get(pt) || 0;
    if(R && pt < R.off.length - 1) fromStore(pt, off); else fromList(pt, wvRaw.cache.get(pt), off);
    fromList(pt, added.get(pt), off);
  });
  if(!pts.length) return null;
  pts.sort((a, b) => a.x - b.x);
  return wvNorm(pts);
}
function wvStepSeries(s){ return wv.step === 'year' ? wvYearSeries(s) : (wv.step === 'raw' ? wvRawSeries(s) : wvSeries(s)); }
function wvKindLabel(p){
  if(p.kind === 'oco') return 'Ocotillo monthly mean';
  if(p.kind === 'report') return 'published report' + (p.ofr ? ' (OFR ' + p.ofr + ')' : '');
  if(p.kind === 'file') return 'your file';
  return 'API';
}
function wvStepStatus(msg){
  const el = document.getElementById('wv-step-note'); if(!el) return;
  if(msg != null){ el.textContent = msg; return; }
  el.textContent = (wvRaw.loading && wv.step === 'raw') ? `Fetching readings from the API\u2026 ${wvRaw.done} / ${wvRaw.total || '?'} requests (monthly values shown until they arrive)` : '';
}
// Chart data with a null point wherever the record has a long gap, so the line breaks there
function wvLineData(pts){
  const out = [];
  for(let i = 0; i < pts.length; i++){
    if(i && pts[i].x - pts[i-1].x > WV_GAP_YEARS) out.push({x: (pts[i].x + pts[i-1].x) / 2, y: null});
    out.push(pts[i]);
  }
  return out;
}
// Colour by the "Group by" setting (except clusters, which need the composite)
function wvGroupInfo(sites){
  const g = state.group;
  if(!g || g.mode === 'off' || g.mode === 'cluster') return null;
  const of = new Map(), groups = [];
  if(groupIsCategorical()){
    const by = new Map();
    sites.forEach(s => { const c = groupCategoriesOf(s)[0]; if(!by.has(c)) by.set(c, []); by.get(c).push(s); });
    const ranked = [...by.entries()].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
    ranked.forEach(([name, list], i) => {
      const k = i < g.n ? i : g.n;
      if(!groups[k]) groups[k] = i < g.n ? {label: name, color: GROUP_COLORS[i % GROUP_COLORS.length], n: 0} : {label: 'All other', color: '#9aa39a', n: 0};
      list.forEach(s => of.set(s, groups[k])); groups[k].n += list.length;
    });
  } else {
    const vals = sites.map(s => groupValueOf(s)).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    if(!vals.length) return null;
    let breaks = (g.breaks && g.breaks.length) ? g.breaks.slice().sort((a, b) => a - b) : [];
    if(!breaks.length){ for(let i = 1; i < g.n; i++) breaks.push(Math.round(quantile(vals, i / g.n))); }
    breaks = breaks.filter((b, i) => i === 0 || b > breaks[i-1]);
    const unit = g.mode === 'welldepth' ? 'well depth' : 'depth to water';
    for(let i = 0; i <= breaks.length; i++){
      const lo = i ? breaks[i-1] : null, hi = i < breaks.length ? breaks[i] : null;
      const label = lo == null ? `${unit} < ${hi} ft` : (hi == null ? `${unit} ≥ ${lo} ft` : `${unit} ${lo}–${hi} ft`);
      groups.push({label, color: GROUP_COLORS[i % GROUP_COLORS.length], n: 0});
    }
    const unk = groups.length;
    sites.forEach(s => {
      const v = groupValueOf(s);
      if(v == null || !isFinite(v)){ if(!groups[unk]) groups[unk] = {label: 'Unknown ' + unit, color: '#9aa39a', n: 0}; of.set(s, groups[unk]); groups[unk].n++; return; }
      let k = 0; while(k < breaks.length && v >= breaks[k]) k++;
      of.set(s, groups[k]); groups[k].n++;
    });
  }
  groups.forEach(gr => { gr.label = `${gr.label} (${gr.n})`; });
  return {of, groups: groups.filter(gr => gr && gr.n)};
}
function wvTrendUp(s){   // ft/yr, + = water level rising (siteTrend is + = declining, least squares of yearly values)
  return siteNYears[s] >= 3 && isFinite(siteTrend[s]) ? -siteTrend[s] : NaN;
}
function wvSetStatLabels(view){
  const cells = [...document.querySelectorAll('#drawer-controls .stat-grid .cell .l')];
  if(!wvStatLabels) wvStatLabels = cells.map(c => c.textContent);
  const t = view === 'wells' ? ['wells plotted', WV_STEP[wv.stepUsed || wv.step].noun, 'years covered', 'median well trend / yr'] : wvStatLabels;
  cells.forEach((c, i) => { c.textContent = t[i]; });
}
function wvColorOf(w, i){
  if(window._wvGroups){ const g = window._wvGroups.of.get(w.site); return g ? g.color : '#9aa39a'; }
  return WV_PALETTE[i % WV_PALETTE.length];
}
function wvStyle(ds, nShown){
  const hi = ds._site === state.chartHighlightSite, ex = state.excludedSites.has(ds._site);
  const base = ex ? '#9aa39a' : ds._color;
  ds.borderColor = hi ? '#e0455c' : hexA(base, nShown > 60 ? 0.55 : 0.85);
  ds.backgroundColor = hi ? '#e0455c' : hexA(base, 0.85);
  ds.borderWidth = hi ? 3.2 : (nShown > 60 ? 1 : 1.5);
  ds.borderDash = ex ? [4, 3] : [];
  ds.order = hi ? 0 : 1;
  ds._pr = hi ? 2.6 : (ds._n < 3 ? 3.5 : ((nShown > 200 || ds._n > 400) ? 0.9 : 1.6));
  ds.pointRadius = c => (c.raw && c.raw.flag) ? 4.5 : c.dataset._pr;
  ds.pointStyle = c => (c.raw && c.raw.flag) ? 'crossRot' : 'circle';
  ds.pointBorderColor = c => (c.raw && c.raw.flag) ? '#d62828' : c.dataset.borderColor;
  ds.pointBackgroundColor = c => (c.raw && c.raw.flag) ? '#d62828' : c.dataset.backgroundColor;
  ds.pointBorderWidth = c => (c.raw && c.raw.flag) ? 2 : 1;
}
// In-place restyle after a click (no chart rebuild); false if the Wells chart isn't showing
function wvApplyHighlight(){
  if(!chart || !window._lastOverview || !chart.data.datasets.length || chart.data.datasets[0]._wv !== true) return false;
  const n = chart.data.datasets.length;
  chart.data.datasets.forEach(ds => wvStyle(ds, n));
  chart.update('none');
  wvRenderList();
  const el = document.querySelector('#wv-rows .wv-r.sel'); if(el) el.scrollIntoView({block: 'nearest'});
  return true;
}
function wvEmpty(title, text, btn){
  const empty = document.getElementById('hydrograph-empty'), canvas = document.getElementById('hydrograph-canvas');
  empty.style.display = 'flex'; canvas.style.display = 'none';
  empty.querySelector('b').textContent = title;
  empty.querySelector('span').textContent = text;
  const b = document.getElementById('btn-show-all-wells');
  if(b){ b.style.display = btn ? 'inline-block' : 'none'; if(btn){ b.textContent = btn; b.dataset.statewide = '1'; } }
  if(chart){ chart.destroy(); chart = null; }
  ['stat-nqual','stat-npoints','stat-meanchg','stat-medchg'].forEach(id => { const e = document.getElementById(id); e.textContent = '–'; e.title = ''; });
  window._lastOverview = null; window._wvGroups = null; window._lastComposite = null; window._lastGroups = null; window._lastSeasonOverlays = null;
  wv.rows = []; wvRenderList();
  document.getElementById('wv-legend').innerHTML = '';
  if(state.qualifyingSites.size){ state.qualifyingSites = new Set(); restyleMarkers(); }
}
function renderWellsView(set){
  wvSetStatLabels('wells');
  const n = set ? set.size : 0;
  const picked = !!(state.areaSelection || state.clickSelectedSites.size);
  const ex = document.getElementById('explain-text');
  document.getElementById('drawer-sub').textContent = (picked || state.statewideOk) && n ? `\u2014 ${n.toLocaleString()} well(s) selected` : '\u2014 select wells to see their hydrographs';
  if(!picked && !state.statewideOk){
    wvEmpty('Pick an area or wells to see their hydrographs',
      'Draw a polygon, choose a county, OSE basin, HUC, aquifer or study area, or click wells on the map (zoom in to see them). Each selected well is drawn with its own readings.',
      n ? `Plot the longest records statewide (${Math.min(n, SPAGHETTI_CAP()).toLocaleString()} of ${n.toLocaleString()} wells)` : null);
    if(ex) ex.textContent = 'Nothing is selected yet. Choose wells on the Map screen, and each one is drawn here from its own readings. The Composite tab combines them into one hydrograph.';
    return;
  }
  { const b = document.getElementById('btn-show-all-wells'); if(b) delete b.dataset.statewide; }
  if(!n){
    wvEmpty('No wells pass the current filters here', 'Loosen the Data filters, or select a different area.', null);
    if(ex) ex.textContent = 'The selection contains no wells that pass the current Data filters.';
    return;
  }
  const all = [];
  set.forEach(s => { const pts = wvSeries(s); if(pts) all.push({site: s, pts, first: pts[0], last: pts[pts.length-1]}); });
  if(!all.length){
    wvEmpty('None of the selected wells have readings under the current settings',
      'Check the period shown, season, bad-reading removal or elevation mode: they can remove every reading.', null);
    if(ex) ex.textContent = `${n} well(s) are selected but none has a reading under the current period, season and elevation settings.`;
    return;
  }
  // longest records first, capped so a large selection cannot freeze the page
  all.sort((a, b) => b.pts.length - a.pts.length || (b.last.x - b.first.x) - (a.last.x - a.first.x));
  wv.all = all;
  let shown = all.slice(0, SPAGHETTI_CAP());
  // the same wells are drawn at every time step (ranked by monthly values); only their points change
  let stepUsed = wv.step;
  if(wv.step === 'raw'){
    const need = wvRawMissing(shown.map(w => w.site));
    if(need.length){
      stepUsed = 'month';
      if(!wvRaw.loading){
        wvRaw.loading = wvLoadRaw(need).then(() => { wvRaw.loading = null; wvStepStatus(); if(state.showAllWells && wv.step === 'raw') renderChart(); })
          .catch(e => { wvRaw.loading = null; console.error(e); wvStepStatus('Could not fetch readings from the API (' + e.message + '); monthly values shown.'); });
      }
      wvStepStatus();
    }
  }
  if(stepUsed !== 'month'){
    shown = shown.map(w => { const pts = wvStepSeries(w.site); return pts ? {site: w.site, pts, first: pts[0], last: pts[pts.length-1]} : null; }).filter(Boolean);
  }
  wv.stepUsed = stepUsed;
  if(wv.step !== 'raw') wvStepStatus('');
  if(stepUsed === wv.step && !wvRaw.loading){
    const nf = wv.step === 'raw' ? shown.filter(w => wvRaw.failed.has(w.site)).length : 0;
    wvStepStatus(wv.step === 'raw' ? `Individual readings${BOOT.raw ? '' : ' from the API'}, with partner agencies' and added readings${nf ? '; ' + nf + ' well(s) could not be fetched' : ''}.` : '');
  }
  wv.drawn = new Set(shown.map(w => w.site));
  if(!shown.length){
    wvEmpty('None of the selected wells have ' + WV_STEP[stepUsed].noun + ' under the current settings', 'Check the period shown, season, reading quality or elevation mode.', null);
    return;
  }
  wvSetStatLabels('wells');
  wv.rows = shown; wv.hidden = all.length - shown.length; wv.noData = n - all.length; wv.total = n;
  window._lastOverview = shown;
  window._lastComposite = null; window._lastSeasonOverlays = null; window._lastGroups = null;
  state.qualifyingSites = new Set(shown.map(w => w.site)); restyleMarkers();

  const gi = wvGroupInfo(shown.map(w => w.site));
  window._wvGroups = gi;
  const leg = document.getElementById('wv-legend');
  leg.innerHTML = gi ? '<span style="color:var(--muted)">Coloured by ' + escHtml(GROUP_MODE_LABELS[state.group.mode] || state.group.mode) + ':</span>' + gi.groups.map(g => `<span><i style="background:${g.color}"></i>${escHtml(g.label)}</span>`).join('')
    : (state.group.mode === 'cluster' ? '<span style="color:var(--muted)">Hydrograph clusters are built from the composite; open the Composite tab to see them.</span>' : '');

  const empty = document.getElementById('hydrograph-empty'), canvas = document.getElementById('hydrograph-canvas');
  empty.style.display = 'none'; canvas.style.display = 'block';
  const datasets = shown.map((w, i) => {
    w.color = wvColorOf(w, i);
    const ds = {label: String(SITES[w.site][0]), _site: w.site, _wv: true, _color: w.color, _n: w.pts.length,
      data: wvLineData(w.pts), pointHoverRadius: 5, spanGaps: false, tension: 0, showLine: true};
    wvStyle(ds, shown.length);
    return ds;
  });
  const muted = getComputedStyle(document.body).getPropertyValue('--muted').trim();
  const revAxis = state.valueMode === 'depth' && !useUsgsNorm();
  const unit = useUsgsNorm() ? ' %' : ' ft';
  if(chart){ chart.destroy(); chart = null; }
  chart = new Chart(canvas.getContext('2d'), {
    type: 'line', data: {datasets},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: {mode: 'nearest', intersect: false},
      onClick: (e, els) => { if(els && els.length){ const ds = chart.data.datasets[els[0].datasetIndex]; if(ds && ds._site != null) handleChartWellClick(ds._site); } },
      plugins: {
        legend: {display: false},
        decimation: {enabled: stepUsed === 'raw', algorithm: 'min-max'},
        tooltip: {callbacks: {
          title: items => items.map(i => i.dataset.label + (SITES[i.dataset._site][3] >= 0 ? ' · ' + SOURCES[SITES[i.dataset._site][3]] : '')),
          label: c => { const p = c.raw; if(!p || p.y == null) return '';
            const v = `${c.parsed.y.toFixed(2)}${unit}`;
            if(p.kind){ const tm = wvPtTime(p), q = wvPtQual(p); return `${wvPtDate(p)}${tm ? ' ' + tm : ''}: ${v}` + (p.kind !== 'api' ? ' \u00b7 ' + wvKindLabel(p) : '') + (p.from !== c.dataset._site ? ' \u00b7 merged from ' + SITES[p.from][0] + (SITES[p.from][3] >= 0 ? ' (' + SOURCES[SITES[p.from][3]] + ')' : '') : '') + (q ? ' \u00b7 ' + q : ''); }
            if(p.month) return `${WV_MON[p.month-1]} ${p.year}: ${v} (${p.n} reading${p.n === 1 ? '' : 's'})`;
            return `${p.year}${state.waterYear ? ' (water year)' : ''}: ${v} (${p.n} reading${p.n === 1 ? '' : 's'})`; },
          afterLabel: c => (c.raw && c.raw.flag) ? (wv.stepUsed === 'raw' ? 'In a month flagged as a likely data-entry error' : 'Flagged as a likely data-entry error') + ': the yearly value jumps by more than ' + state.despike.threshold + ' ft/yr to both neighbouring years (left out of the composite)' : '',
          footer: () => 'Click to highlight this well on the map'
        }}
      },
      scales: {
        // the time axis spans the period (the slider's ends), so the chart, the slider and the stats agree
        x: {type: 'linear', min: wv.fullRecord ? undefined : (state.yearWindow.min != null ? state.yearWindow.min : YR_MIN), max: wv.fullRecord ? undefined : (state.yearWindow.max != null ? state.yearWindow.max : YR_MAX) + 1,
          ticks: {color: muted, callback: v => Number.isInteger(v) ? String(v) : ''}, grid: {color: 'rgba(125,136,115,.2)'}, title: {display: true, text: WV_STEP[stepUsed].axis + (stepUsed === 'year' && state.waterYear ? ', water years' : ''), color: muted}},
        y: {reverse: revAxis, ticks: {color: muted}, grid: {color: 'rgba(125,136,115,.2)'}, title: {display: true, text: wrapAxisTitle(yAxisTitle(), canvas.clientHeight - 60), color: muted}}
      }
    }
  });

  // stats
  const nPts = shown.reduce((a, w) => a + w.pts.length, 0);
  // years covered by every selected well with readings (not only those drawn), so it lines up with the period slider
  const span = (wv.all && wv.all.length && stepUsed !== 'raw' || !wv.fullRecord) ? wv.all : shown;
  let y0 = Infinity, y1 = -Infinity; (span && span.length ? span : shown).forEach(w => { if(w.first.year < y0) y0 = w.first.year; if(w.last.year > y1) y1 = w.last.year; });
  if(wv.fullRecord) shown.forEach(w => { if(w.first.year < y0) y0 = w.first.year; if(w.last.year > y1) y1 = w.last.year; });
  const tr = shown.map(w => wvTrendUp(w.site)).filter(isFinite).sort((a, b) => a - b);
  const set1 = (id, t, title) => { const e = document.getElementById(id); e.textContent = t; e.title = title || ''; };
  set1('stat-nqual', shown.length.toLocaleString() + (all.length > shown.length || wv.noData ? ' of ' + n.toLocaleString() : ''),
    `${shown.length} drawn; ${wv.hidden} more hidden by the "Max. wells to draw" limit; ${wv.noData} without readings under the current settings`);
  set1('stat-npoints', nPts.toLocaleString(), {raw: 'Individual readings drawn', month: 'Monthly values drawn (each is the mean of the readings in that month)', year: 'Yearly values drawn (each is the mean of the readings in that year)'}[stepUsed]);
  set1('stat-meanchg', `${y0}–${y1}`, 'First and last year with a reading among all the selected wells (drawn or not)');
  const trMed = tr.length ? quantile(tr, 0.5) : NaN;
  set1('stat-medchg', tr.length ? (trMed >= 0 ? '+' : '') + trMed.toFixed(2) + ' ft' : '–',
    tr.length ? `Median of ${tr.length} wells' own trends (least squares of yearly values, 3+ years); + = water level rising. ${tr.filter(v => v < 0).length} of ${tr.length} falling.` : 'No well has 3 or more years of data');
  const note = document.getElementById('spaghetti-note');
  if(note){
    note.textContent = wv.hidden > 0 ? `The Wells view shows the ${shown.length} wells with the most monthly values; ${wv.hidden} more are hidden by the "Max. wells to draw" limit: raise it or narrow the area.` : '';
    note.style.display = wv.hidden > 0 ? 'block' : 'none';
  }
  if(ex){
    const what = {raw: 'its individual readings from the API (with readings merged from the same well at partner agencies, and any added from reports, your files or Ocotillo)', month: 'the mean of its readings in each month', year: 'the mean of its readings in each ' + (state.waterYear ? 'water year (Oct\u2013Sep)' : 'year')}[stepUsed];
    const bits = [`Each line is one well: ${what}, joined in time order and broken where it has no reading for more than ${WV_GAP_YEARS} years.`];
    if(wv.step === 'raw' && stepUsed !== 'raw') bits.unshift('Individual readings are being fetched from the API; monthly values are shown until they arrive.');
    bits.push(`${shown.length.toLocaleString()} of ${n.toLocaleString()} selected wells are drawn` + (wv.hidden ? ` (the ${shown.length} with the most monthly values; raise "Max. wells to draw" in Display to see more)` : '') + (wv.noData ? `; ${wv.noData} have no readings under the current settings` : '') + '.');
    if(!seasonIsFullYear()) bits.push(`Only months ${WV_MON[state.season.monthStart-1]}–${WV_MON[state.season.monthEnd-1]} are drawn (Season setting).`);
    if(state.despike.enabled){
      const nf = shown.reduce((a, w) => a + w.pts.filter(p => p.flag).length, 0);
      bits.push(wv.hideFlagged ? 'Values flagged as likely data-entry errors are hidden ("Wells view: hide flagged readings too" in Data quality).'
        : (nf ? `${nf.toLocaleString()} value(s) flagged as likely data-entry errors are drawn as red \u00d7 (the composite leaves them out).` : 'No value here is flagged as a likely data-entry error.'));
    }
    if(state.normalize) bits.push(useUsgsNorm() ? 'Values are each well\'s percent of its own range (up = more water).' : (state.normalizeStyle === 'first' ? 'Values are each well\'s change since its first reading shown.' : 'Values are each well\'s departure from its own mean.'));
    bits.push('Click a line or a row in the list to find the well on the map; "Card" opens its own hydrograph with exports. The Composite tab combines these wells into one hydrograph.');
    ex.textContent = bits.join(' ');
  }
  wvRenderList();
}
function wvRenderList(){
  const box = document.getElementById('wv-rows'); if(!box) return;
  const title = document.getElementById('wv-list-title'), foot = document.getElementById('wv-list-foot');
  const drawnRows = wv.rows || [], drawnBy = new Map(drawnRows.map(w => [w.site, w]));
  const rows = (wv.all && wv.all.length ? wv.all.map(w => drawnBy.get(w.site) || w) : drawnRows);
  title.textContent = rows.length ? `Wells (${rows.length.toLocaleString()})` : 'Wells'; title.title = `${rows.length} selected wells with readings; ${drawnRows.length} drawn`;
  const q = wv.q.trim().toLowerCase();
  let list = q ? rows.filter(w => String(SITES[w.site][0]).toLowerCase().includes(q) || String(nmbgmrIdOf(w.site) || '').toLowerCase().includes(q)) : rows.slice();
  const id = w => String(SITES[w.site][0]);
  const monN = new Map((wv.all || []).map(w => [w.site, w.pts.length]));   // months of record (ranks drawn and undrawn wells alike)
  const sorters = {
    record: (a, b) => (monN.get(b.site) || 0) - (monN.get(a.site) || 0),
    id: (a, b) => id(a).localeCompare(id(b), undefined, {numeric: true}),
    last: (a, b) => (state.valueMode === 'depth' ? b.last.dtw - a.last.dtw : a.last.y - b.last.y),
    trend: (a, b) => { const ta = wvTrendUp(a.site), tb = wvTrendUp(b.site); return (isFinite(ta) ? ta : 1e9) - (isFinite(tb) ? tb : 1e9); },
    recent: (a, b) => b.last.x - a.last.x
  };
  list.sort(sorters[wv.sort] || sorters.record);
  const MAXROWS = 3000;
  const unit = useUsgsNorm() ? '%' : 'ft';
  box.innerHTML = list.slice(0, MAXROWS).map(w => {
    const s = w.site, r = SITES[s], t = wvTrendUp(s);
    const src = r[3] >= 0 ? SOURCES[r[3]] : '';
    const nm = nmbgmrIdOf(s);
    const shownId = String(r[0]) + (nm && nm !== r[0] ? ' / ' + nm : '');
    const excl = state.excludedSites.has(s), drawn = drawnBy.has(s);
    const short = drawn ? WV_STEP[wv.stepUsed || 'month'].short : 'mo';
    return `<div class="wv-r${s === state.chartHighlightSite ? ' sel' : ''}${excl ? ' excl' : ''}${drawn ? '' : ' undrawn'}" data-s="${s}"${drawn ? '' : ' title="Not drawn (over the &quot;Max. wells to draw&quot; limit in Display); Card opens its own hydrograph"'}>` +
      `<span class="wv-sw" style="background:${!drawn ? 'transparent' : excl ? '#9aa39a' : w.color}"></span>` +
      `<span class="wv-id" title="${escHtml(shownId + (src ? ' · ' + src : ''))}">${escHtml(shownId)}</span>` +
      `<span class="wv-acts"><button type="button" data-act="card" title="Open this well's own hydrograph, with CSV / GeoJSON / image export">Card</button>` +
      `<label title="Unticked wells are left out of the composite (and drawn grey and dashed here)"><input type="checkbox" data-act="use"${excl ? '' : ' checked'}>use</label></span>` +
      `<span class="wv-meta">${escHtml(src)} · ${w.first.year}–${w.last.year} · ${w.pts.length.toLocaleString()} ${short}${drawn ? '' : ' \u00b7 not drawn'}` +
      ` · last <span class="wv-last">${w.last.y.toFixed(2)} ${unit}</span>` +
      (isFinite(t) ? ` · ${t >= 0 ? '+' : ''}${t.toFixed(2)} ft/yr` : '') + `</span></div>`;
  }).join('') || `<p class="hint" style="margin:8px;">${rows.length ? 'No well matches.' : 'Wells appear here once they are drawn.'}</p>`;
  const bits = [];
  if(list.length > MAXROWS && q) bits.push(`First ${MAXROWS} of ${list.length} matches shown.`);
  if(wv.hidden) bits.push(`${wv.hidden.toLocaleString()} well(s) listed but not drawn ("Max. wells to draw" in Display).`);
  if(wv.noData) bits.push(`${wv.noData.toLocaleString()} without readings under the current settings.`);
  const nEx = rows.filter(w => state.excludedSites.has(w.site)).length;
  if(rows.length > MAXROWS && !q) bits.unshift(`Showing ${MAXROWS} of ${rows.length.toLocaleString()} wells; search to find others.`);
  if(nEx) bits.push(`${nEx} left out of the composite.`);
  foot.textContent = bits.join(' ');
}
function wvCsvName(){
  const area = state.areaSelection ? (state.areaSelection.label || 'area') : (state.clickSelectedSites.size ? 'picked_wells' : 'statewide');
  return 'nm_well_hydrographs_' + ({raw: 'readings', month: 'monthly', year: 'annual'}[wv.stepUsed || 'month']) + '_' + String(area).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) + '.csv';
}
function wvCsvRows(){
  const units = useUsgsNorm() ? 'percent of well range' : (state.valueMode === 'elevation' ? (state.normalize ? (state.normalizeStyle === 'first' ? 'ft elevation change since first reading' : 'ft elevation anomaly') : 'ft elevation') : (state.normalize ? (state.normalizeStyle === 'first' ? 'ft depth-to-water change since first reading' : 'ft depth-to-water anomaly') : 'ft depth to water'));
  const step = wv.stepUsed || 'month', r2 = x => Math.round(x * 100) / 100;
  const head = {
    raw:   ['date','time','value','units','depth_to_water_ft','reading_from','reading_source_well','qualifier','approval_status'],
    month: ['year','month','value','units','depth_to_water_ft_monthly_mean','n_readings_in_month'],
    year:  ['year','value','units','depth_to_water_ft_yearly_mean','n_readings_in_year']
  }[step];
  const rows = [['well_id','nmbgmr_site_id','source','longitude','latitude'].concat(head, ['used_in_composite'])];
  (window._lastOverview || []).forEach(w => {
    const r = SITES[w.site], use = state.excludedSites.has(w.site) ? 'no' : 'yes';
    const base = [r[0], nmbgmrIdOf(w.site) || '', r[3] >= 0 ? SOURCES[r[3]] : '', r[1], r[2]];
    w.pts.forEach(p => {
      const cells = step === 'raw' ? [wvPtDate(p), wvPtTime(p), r2(p.y), units, r2(p.dtw), wvKindLabel(p), p.from !== w.site ? SITES[p.from][0] : '', wvPtQual(p), wvPtAppr(p)]
        : step === 'year' ? [p.year, r2(p.y), units + (state.waterYear ? ' (water year)' : ''), r2(p.dtw), p.n]
        : [p.year, p.month, r2(p.y), units, r2(p.dtw), p.n];
      rows.push(base.concat(cells, [use]));
    });
  });
  return rows;
}
function wvDownloadSet(){
  const picked = !!(state.areaSelection || state.clickSelectedSites.size);
  return (picked || state.statewideOk) && state.activeSet ? [...state.activeSet] : [];
}
function setView(v){
  const wells = v !== 'composite';
  state.showAllWells = wells;
  const dr = document.getElementById('drawer');
  if(dr) dr.dataset.view = wells ? 'wells' : 'composite';
  document.querySelectorAll('#view-seg button').forEach(b => { const on = b.dataset.view === (wells ? 'wells' : 'composite'); b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  const t = document.getElementById('toggle-allwells'); if(t) t.checked = wells;
  const intro = document.getElementById('acc-intro-text');
  if(intro) intro.innerHTML = wells
    ? '<b>Every selected well, on its own.</b> Each line is one well\'s readings (raw, monthly or annual: Time step above the chart). The groups below set the period, cleaning, season, colouring and display; the summary on each bar shows what\'s set. Switch to <b>Composite</b> (top of this panel) to combine the wells into one hydrograph.'
    : '<b>One hydrograph from the selected wells.</b> Open a group below to choose the composite method, period, cleaning, splitting and display; the summary on each bar shows what\'s set. Wells unticked in the Wells list are left out.';
  if(!wells) wvSetStatLabels('composite');
  updateAccSummaries(); renderChart();
}
// one-time wiring (runs when the main script reaches this point; the DOM above already exists)
(function wvInit(){
  const dr = document.getElementById('drawer'); if(dr) dr.dataset.view = 'wells';
  // the old Overview checkbox is replaced by the Wells / Composite switch
  { const t = document.getElementById('toggle-allwells'); const sec = t && t.closest('.section'); if(sec) sec.style.display = 'none'; }
  // composite-only controls are hidden in the Wells view
  ['toggle-season-compare'].forEach(id => { const el = document.getElementById(id); const row = el && el.closest('.row'); if(row) row.classList.add('comp-only'); });
  { const el = document.getElementById('season-compare-options'); if(el) el.classList.add('comp-only'); }
  ['toggle-spaghetti', 'toggle-band'].forEach(id => { const el = document.getElementById(id); const row = el && el.closest('.toggle-row'); if(row) row.classList.add('comp-only'); });
  document.querySelectorAll('#view-seg button').forEach(b => b.addEventListener('click', () => { if(b.classList.contains('active')) return; setView(b.dataset.view); }));
  document.getElementById('wv-sort').addEventListener('change', e => { wv.sort = e.target.value; wvRenderList(); });
  { const hf = document.getElementById('wv-hideflag'); if(hf) hf.addEventListener('change', e => { wv.hideFlagged = e.target.checked; renderChart(); }); }
  document.querySelectorAll('#wv-step button').forEach(b => b.addEventListener('click', () => {
    if(b.classList.contains('active')) return;
    wv.step = b.dataset.step;
    document.querySelectorAll('#wv-step button').forEach(x => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    renderChart();
  }));
  document.getElementById('wv-search').addEventListener('input', e => { wv.q = e.target.value; wvRenderList(); });
  document.getElementById('wv-rows').addEventListener('click', e => {
    const row = e.target.closest('.wv-r'); if(!row) return;
    const s = +row.dataset.s, act = e.target.dataset && e.target.dataset.act;
    if(act === 'card'){ openSingleWell(s); return; }
    if(act === 'use'){
      if(e.target.checked) state.excludedSites.delete(s); else state.excludedSites.add(s);
      if(!wvApplyHighlight()) wvRenderList();
      return;
    }
    if(e.target.closest('label')) return;
    handleChartWellClick(s);
  });
})();
// read-only handle for automated tests (the app runs inside a closure)
window.__hx = {get chart(){ return chart; }, get state(){ return state; }, wvCsvRows, get wv(){ return wv; }, get wvRaw(){ return wvRaw; },
  get wvRawSeries(){ return wvRawSeries; }, get siteByKey(){ return siteByKey; },   // test only
  get computeComposite(){ return computeComposite; }, get otp(){ return state.otp; }, setPool(sites){ state.activeSet = new Set(sites); },   // test only
  get boot(){ return BOOT.info; }, get rawN(){ return BOOT.raw ? BOOT.raw.n : 0; }, exportSnapshot: () => BOOT.exportSnapshot(),
  // test only: the stored readings of these wells vs a fresh API download (date | minute | value in 0.01 ft)
  async compareWithApi(sites){
    const ts = await fetchRawTimeseries(sites), keyOf = new Map(sites.map(s => [rawWellKey(s), s])), api = new Map(sites.map(s => [s, new Set()]));
    for(const r of ts.rows){ if(r[2] !== API_DTW) continue; const v = Number(r[3]), d = r[5]; if(!isFinite(v) || !d || d > todayStr || d < '1800') continue;
      const s = keyOf.get(r[0] + '\u0001' + r[1]); if(s == null) continue; api.get(s).add(d + '|' + rawTimeOf(rawMinOf(r[6])) + '|' + Math.round(v * 100)); }
    let same = 0, onlyApi = 0, onlyStore = 0; const ex = [];
    sites.forEach(s => { const A = api.get(s), S = new Set((wvFromStore(s) || []).map(r => r.d + '|' + r.time + '|' + Math.round(r.v * 100)));
      A.forEach(k => { if(S.has(k)) same++; else { onlyApi++; if(ex.length < 8) ex.push(['api', SITES[s][0], k]); } });
      S.forEach(k => { if(!A.has(k)){ onlyStore++; if(ex.length < 8) ex.push(['store', SITES[s][0], k]); } }); });
    return {wells: sites.length, same, onlyApi, onlyStore, ex};
  }};

// ---- two screens -----------------------------------------------------------------------
// Map: the map fills the window with one panel (area, then filters) and a selection bar.
// Hydrographs: the chart panel fills the window; the same Leaflet map moves into a small locator in its
// settings column, so clicking a line still shows the well and clicking a well still highlights its line.
// Side by side (wide screens): both at once. The screen is in the address (#map, #hydrographs, #side-by-side),
// so the browser's Back button moves between screens.
let hxScreen = null, hxChartsDirty = true;
const HX_HASH = {map: '#map', charts: '#hydrographs', both: '#side-by-side'};
function hxScreenFromHash(){ const h = location.hash.split('?')[0]; return h === '#hydrographs' ? 'charts' : (h === '#side-by-side' ? 'both' : 'map'); }
function hxPicked(){ return !!(state.areaSelection || state.clickSelectedSites.size); }
function setScreen(sc, opts){
  opts = opts || {};
  if(!HX_HASH[sc]) sc = 'map';
  if(sc === 'both' && window.innerWidth < 1400) sc = 'charts';
  hxScreen = sc; document.body.dataset.screen = sc;
  hxPlaceForScreen(sc);
  document.querySelectorAll('#screen-nav button').forEach(b => { const on = b.dataset.screen === sc; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  const mw = document.getElementById('mapwrap'), slot = document.getElementById('locator-slot'), home = document.getElementById('body');
  if(sc === 'charts'){ if(mw.parentNode !== slot) slot.insertBefore(mw, document.getElementById('locator-note')); }
  else if(mw.parentNode !== home) home.appendChild(mw);
  if(!opts.fromHash && location.hash.split('?')[0] !== HX_HASH[sc]) history.pushState({screen: sc}, '', HX_HASH[sc] + hxQuery());
  requestAnimationFrame(() => {
    try{ map.invalidateSize(); }catch(e){}
    if(sc === 'map'){ hxSelBar(); return; }
    if(sc === 'charts') hxFitLocator();
    if(hxChartsDirty || !chart) renderChart(); else { try{ chart.resize(); }catch(e){} }
  });
}
// the locator shows the selection: the area outline if there is one, else the wells drawn / selected
function hxFitLocator(){
  try{
    let b = null;
    areaLayer.eachLayer(l => { if(l.getBounds){ const lb = l.getBounds(); if(lb.isValid()) b = b ? b.extend(lb) : L.latLngBounds(lb.getSouthWest(), lb.getNorthEast()); } });
    if(!b){
      const sites = state.qualifyingSites.size ? [...state.qualifyingSites] : (hxPicked() ? [...state.activeSet] : []);
      sites.slice(0, 5000).forEach(s => { const r = SITES[s]; if(r[1] == null || r[2] == null) return; b = b ? b.extend([r[2], r[1]]) : L.latLngBounds([r[2], r[1]], [r[2], r[1]]); });
    }
    if(b && b.isValid()) map.fitBounds(b, {padding: [8, 8], maxZoom: 12, animate: false});
    const note = document.getElementById('locator-note');
    if(note) note.textContent = hxPicked() ? 'Click a well to find its line; click a line to find its well.' : '';
  }catch(e){ console.warn('locator', e); }
}
function hxSelBar(){
  const el = document.getElementById('selbar-text'), go = document.getElementById('selbar-go'); if(!el || !go) return;
  const n = state.activeSet ? state.activeSet.size : 0, picked = hxPicked();
  if(picked){
    const where = state.areaSelection ? escHtml(state.areaSelection.label || 'Selected area') : `${state.clickSelectedSites.size.toLocaleString()} picked well(s)`;
    el.innerHTML = `<b>${n.toLocaleString()}</b> well${n === 1 ? '' : 's'} selected · ${where}` + (n ? '' : '<br><span class="hint">None pass the current Data filters.</span>');
    go.textContent = 'View hydrographs →'; go.disabled = !n; delete go.dataset.statewide;
  } else {
    el.innerHTML = 'Choose an area on the left, draw a polygon, or click wells on the map (zoom in to see them).';
    go.textContent = 'Longest records statewide →'; go.disabled = !n; go.dataset.statewide = '1';
  }
}
// Side by side: drag the divider between map and hydrographs (double-click resets; arrow keys move it)
const HX_SPLIT_DEFAULT = 40;
function hxSetSplit(pct, save){
  // keep at least 240 px of map beside its panel, and 640 px of hydrographs
  const vw = Math.max(1, window.innerWidth), sb = (document.getElementById('sidebar') || {}).offsetWidth || 280;
  const lo = Math.min(60, (sb + 240) / vw * 100), hi = Math.max(lo + 5, 100 - 640 / vw * 100);
  pct = Math.max(lo, Math.min(hi, pct));
  document.body.style.setProperty('--hx-split', pct + '%');
  const h = document.getElementById('split-handle'); if(h) h.setAttribute('aria-valuenow', String(Math.round(pct)));
  if(save){ try{ localStorage.setItem('hxSplit', String(pct)); }catch(e){} }
  if(hxScreen === 'both' && !hxSetSplit._raf) hxSetSplit._raf = requestAnimationFrame(() => { hxSetSplit._raf = null; try{ map.invalidateSize(); }catch(e){} try{ if(chart) chart.resize(); }catch(e){} });
}
function hxInitSplit(){
  const h = document.getElementById('split-handle'); if(!h) return;
  let saved = NaN; try{ saved = parseFloat(localStorage.getItem('hxSplit')); }catch(e){}
  hxSetSplit(isFinite(saved) ? saved : HX_SPLIT_DEFAULT, false);
  let drag = false;
  const move = e => { if(!drag) return; const x = (e.touches ? e.touches[0].clientX : e.clientX); hxSetSplit(x / window.innerWidth * 100, false); e.preventDefault(); };
  const up = () => { if(!drag) return; drag = false; document.body.classList.remove('hx-splitting');
    const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--hx-split')); if(isFinite(v)) hxSetSplit(v, true); };
  h.addEventListener('mousedown', e => { drag = true; document.body.classList.add('hx-splitting'); e.preventDefault(); });
  h.addEventListener('touchstart', e => { drag = true; document.body.classList.add('hx-splitting'); }, {passive: true});
  window.addEventListener('mousemove', move); window.addEventListener('touchmove', move, {passive: false});
  window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
  h.addEventListener('dblclick', () => hxSetSplit(HX_SPLIT_DEFAULT, true));
  h.addEventListener('keydown', e => {
    const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--hx-split')) || HX_SPLIT_DEFAULT;
    if(e.key === 'ArrowLeft'){ hxSetSplit(v - 2, true); e.preventDefault(); } else if(e.key === 'ArrowRight'){ hxSetSplit(v + 2, true); e.preventDefault(); }
  });
}
(function hxInit(){
  hxInitSplit();
  hxFiltersInit();
  hxShowAsInit();
  hxTrendInit(); hxCmpInit();
  // the empty-state message belongs to the chart itself (it used to cover the well list too)
  { const e = document.getElementById('hydrograph-empty'), cb = document.getElementById('chart-box'); if(e && cb && e.parentNode !== cb) cb.appendChild(e); }
  // the merged left panel: the statistics tables used to load when the Data filters tab opened; now when its section comes into view
  { const fp = document.getElementById('tab-filters'), tb = document.querySelector('.tab-btn[data-tab="filters"]');
    if(fp && tb && 'IntersectionObserver' in window){
      const io = new IntersectionObserver(es => { if(es.some(x => x.isIntersecting)){ io.disconnect(); tb.click(); } }, {root: document.getElementById('sidebar')});
      io.observe(fp);
    } }
  // the legend starts folded so it doesn't cover the map
  { const lg = document.getElementById('legend'), bt = document.getElementById('legend-collapse'); if(lg && bt && !lg.classList.contains('collapsed')) bt.click(); }
  document.querySelectorAll('#screen-nav button').forEach(b => b.addEventListener('click', () => setScreen(b.dataset.screen)));
  document.getElementById('selbar-go').addEventListener('click', e => {
    if(e.currentTarget.dataset.statewide){ state.statewideOk = true; }
    setScreen('charts');
  });
  document.getElementById('locator-expand').addEventListener('click', () => setScreen('map'));
  document.getElementById('btn-copylink').addEventListener('click', hxCopyLink);
  window.addEventListener('popstate', () => setScreen(hxScreenFromHash(), {fromHash: true}));
  window.addEventListener('hashchange', () => { if(hxScreenFromHash() !== hxScreen) setScreen(hxScreenFromHash(), {fromHash: true}); });
  setScreen(hxScreenFromHash(), {fromHash: true});
  hxRestoreFromUrl();
})();
// test only: the map, for automated checks
window.__hxLL = s => (SITES[s] && SITES[s][1] != null) ? L.latLng(SITES[s][2], SITES[s][1]) : null; window.__hxSiteLL = s => [SITES[s][2], SITES[s][1]];
try{ Object.defineProperty(window.__hx, 'map', {get: () => map}); Object.defineProperty(window.__hx, 'screen', {get: () => hxScreen}); }catch(e){}

// ---- Data filters as a section of the settings column; one period control ----------------
// Data filters: on the Hydrographs screen the same filter panel as the Map screen's opens as a fold-out
// section under the stats (one set of controls, moved between the two places).
// Period: one slider for the years, with the typed years, water years and "draw each well's whole record"
// under it. It replaces the old "Period of record" filter and the "Time window" group. On the Map screen
// the same control sits in the filter panel, so the map and the hydrographs always use the same years.
function hxFilterSection(){ return document.getElementById('acc-filters'); }
function hxFiltersHome(){ const sb = document.getElementById('sidebar'), fp = document.getElementById('tab-filters'); if(fp && sb && fp.parentNode !== sb) sb.appendChild(fp); }
function hxFiltersSync(){
  const acc = hxFilterSection(), fp = document.getElementById('tab-filters'), body = document.getElementById('acc-filters-body');
  if(!acc || !fp || !body) return;
  if(hxScreen === 'charts' && acc.classList.contains('open')){
    if(fp.parentNode !== body){ body.appendChild(fp); const tb = document.querySelector('.tab-btn[data-tab="filters"]'); if(tb) tb.click(); }   // starts the statistics tables loading, as the old tab did
  } else hxFiltersHome();
}
// the period control lives in the settings column, or in the filter panel on the Map screen
function hxPlaceForScreen(sc){
  const pb = document.getElementById('period-block'), home = document.getElementById('period-home'), slot = document.getElementById('period-slot-map');
  if(pb && home && slot){
    if(sc === 'map'){ if(pb.parentNode !== slot) slot.appendChild(pb); }
    else if(pb.previousSibling !== home) home.parentNode.insertBefore(pb, home.nextSibling);
  }
  hxFiltersSync();
}
function hxFiltersLabel(){
  const el = document.getElementById('sum-filters'), acc = hxFilterSection(); if(!el || !acc) return;
  const pass = state.activeSet ? state.activeSet.size : 0;
  // wells in the selection, not counting partner-agency records merged into another well (same physical well)
  const merged = s => !!(state.filters.multiAgency && state.filters.multiAgency !== 'all' && clusterDropSet.has(s));
  let inArea = 0;
  if(state.areaSelection && state._inAreaBase){ const b = state._inAreaBase; for(let i = 0; i < b.length; i++) if(b[i] && !merged(i)) inArea++; state.clickSelectedSites.forEach(s => { if(!b[s] && !merged(s)) inArea++; }); }
  else if(state.clickSelectedSites.size) state.clickSelectedSites.forEach(s => { if(!merged(s)) inArea++; });
  else for(let i = 0; i < NSITES; i++) if(!merged(i)) inArea++;
  el.textContent = `${pass.toLocaleString()} of ${inArea.toLocaleString()} wells pass`;
  acc.classList.toggle('filtered', pass < inArea);
  el.title = pass < inArea ? `Filters (data filters and the period) are leaving out ${(inArea - pass).toLocaleString()} of the ${inArea.toLocaleString()} wells in the selection` : 'No well in the selection is left out';
}
function hxFiltersInit(){
  const acc = hxFilterSection(); if(!acc) return;
  // the generic fold-out handler toggles .open first; this one then moves the panel in or out
  acc.querySelector('.acc-head').addEventListener('click', () => setTimeout(hxFiltersSync, 0));
  // ---- one period control
  const sl = document.getElementById('yr-slider'), pb = sl && sl.closest('.section');
  if(pb){
    pb.id = 'period-block';
    const home = document.createElement('div'); home.id = 'period-home'; home.hidden = true; pb.parentNode.insertBefore(home, pb);
    const t = pb.firstElementChild; if(t && /Period shown/.test(t.textContent)) t.innerHTML = 'Period <span class="hint" style="font-weight:400;">drag the ends or type the years</span>';
    const win = document.querySelector('.acc[data-acc="window"]');
    const yw = document.getElementById('yw-min') && document.getElementById('yw-min').closest('.numrow');
    const wy = document.getElementById('toggle-wateryear') && document.getElementById('toggle-wateryear').closest('.row');
    const wrap = document.createElement('div'); wrap.id = 'period-extra';
    if(yw) wrap.appendChild(yw);
    if(wy) wrap.appendChild(wy);
    const fr = document.createElement('div'); fr.className = 'row wells-only'; fr.style.marginTop = '4px';
    fr.innerHTML = '<label title="The period still picks which wells are drawn (those with a reading in it), but each well is drawn with all of its readings"><input type="checkbox" id="wv-fullrecord"> Draw each well’s whole record</label>';
    wrap.appendChild(fr);
    const note = document.createElement('p'); note.className = 'hint'; note.style.margin = '4px 0 0';
    note.innerHTML = 'Readings outside the period are left out, and wells with none inside it drop out, on both screens and in the composite.';
    wrap.appendChild(note);
    pb.appendChild(wrap);
    if(win) win.style.display = 'none';
    document.getElementById('wv-fullrecord').addEventListener('change', e => { wv.fullRecord = e.target.checked; renderChart(); });
  }
  // the filter panel's "Well's record reaches" section stays; the period control takes the old "Period of record" place on the Map screen
  { const ym = document.getElementById('year-min'), sec = ym && ym.closest('.section');
    if(sec){ const slot = document.createElement('div'); slot.id = 'period-slot-map'; slot.className = 'section'; sec.parentNode.insertBefore(slot, sec); } }
  hxFiltersLabel();
}
// the slider's ends follow the selection's own first and last years (statewide: all wells)
var hxYrSig = null;
function hxYearBounds(){
  const picked = !!(state.areaSelection || state.clickSelectedSites.size);
  const sig = picked ? (state._selSig || '') + '|' + state.clickSelectedSites.size : 'all';
  if(sig === hxYrSig) return;
  hxYrSig = sig;
  let a = Infinity;
  // same wells the stats count: not partner-agency records merged into another well
  const merged = s => !!(state.filters.multiAgency && state.filters.multiAgency !== 'all' && clusterDropSet.has(s));
  const take = s => { const r = SITES[s]; if(!merged(s) && r[6] != null && r[6] < a) a = r[6]; };
  if(!picked){ for(let s = 0; s < NSITES; s++) take(s); }
  else {
    if(state.areaSelection && state._inAreaBase){ const b = state._inAreaBase; for(let s = 0; s < b.length; s++) if(b[s]) take(s); }
    state.clickSelectedSites.forEach(take);
  }
  YR_MIN = isFinite(a) ? a : YR_MIN_ALL;
}

// ---- "Show" control (depth / elevation; as measured / change since first / departure from mean / % of range) ----
// Sits in the Hydrographs settings column; it drives the same state as the controls in Display, which stay in step.
const SA_VALUES = {as: null, first: 'first', ft: 'ft', usgs: 'usgs'};
function hxShowAsInit(){
  const q = document.querySelector('.acc[data-acc="quality"]'); if(!q || document.getElementById('showas-block')) return;
  const d = document.createElement('div'); d.id = 'showas-block'; d.className = 'section';
  d.innerHTML = '<div class="sa-title">Show</div>'
    + '<div class="sa-seg" id="sa-measure" role="group" aria-label="Measure"><button type="button" class="sa-btn" data-m="depth">Depth to water</button><button type="button" class="sa-btn" data-m="elevation">Water-level elevation</button></div>'
    + '<div class="sa-seg sa-seg4" id="sa-values" role="group" aria-label="Values"><button type="button" class="sa-btn" data-v="as">As measured</button><button type="button" class="sa-btn" data-v="first">Change since first</button><button type="button" class="sa-btn" data-v="ft">Departure from mean</button><button type="button" class="sa-btn" data-v="usgs">% of range</button></div>'
    + '<p class="hint" id="sa-note" style="margin:4px 0 0;"></p>';
  q.parentNode.insertBefore(d, q);
  d.querySelector('#sa-measure').addEventListener('click', e => {
    const b = e.target.closest('.sa-btn'); if(!b || b.dataset.m === state.valueMode) return;
    document.getElementById(b.dataset.m === 'elevation' ? 'btn-mode-elevation' : 'btn-mode-depth').click();   // the existing handler renders and fetches 3DEP elevations
  });
  d.querySelector('#sa-values').addEventListener('click', e => {
    const b = e.target.closest('.sa-btn'); if(!b) return;
    const v = b.dataset.v;
    state.normalize = v !== 'as'; if(v !== 'as') state.normalizeStyle = SA_VALUES[v];
    document.getElementById('toggle-normalize').checked = state.normalize; document.getElementById('normalize-style').value = state.normalizeStyle;
    renderChart();
  });
  hxShowAsSync();
}
function hxShowAsSync(){
  const d = document.getElementById('showas-block'); if(!d) return;
  d.querySelectorAll('#sa-measure .sa-btn').forEach(b => { const on = b.dataset.m === state.valueMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  const cur = state.normalize ? state.normalizeStyle : 'as';
  d.querySelectorAll('#sa-values .sa-btn').forEach(b => { const on = b.dataset.v === cur; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  const note = document.getElementById('sa-note'); if(!note) return;
  let t = '';
  if(state.valueMode === 'elevation' && state.activeSet && state.activeSet.size){
    let miss = 0; state.activeSet.forEach(s => { if(!hasElevation(s)) miss++; });
    t = miss ? `${miss.toLocaleString()} of ${state.activeSet.size.toLocaleString()} selected wells have no land elevation yet and are left out` + (state.useDem ? ' (3DEP lookups are filling them in).' : ' (turn on 3DEP in Display to fill them).') : 'Elevation = land elevation minus depth to water; up is more water.';
  } else if(cur === 'first') t = 'Each well is shown relative to its first reading in the period (first unflagged reading), so wells of any depth can be compared.';
  else if(cur === 'ft') t = 'Each well is shown as feet above or below its own average.';
  else if(cur === 'usgs') t = 'Each well is shown as a percent of its own range (up = more water).';
  note.textContent = t;
}

// ---- shareable links ------------------------------------------------------------------------
// The address (after the screen name) carries what is needed to reopen the same view: the area (county, HUC-8, OSE basin,
// aquifer extent, study area, or a drawn polygon) or up to 60 picked wells, the period, time step, what is shown, grouping,
// season, water years, the Wells / Composite view and the highlighted well. Filters, uploaded files and HUC-10/12 areas are
// not included (the Copy link button says so).
var HXU_SELECTS = {county: 'county-select', huc: 'huc-select', ose: 'ose-select', aquiferExtent: 'aquext-select', studyarea: 'studyarea-select'};
var HXU_MAX_WELLS = 60;
var hxuRestoring = false, hxuTimer = null;
function hxuState(){
  const P = [], left = [];
  const sel = state.areaSelection;
  if(sel){
    if(HXU_SELECTS[sel.type]) P.push(['a', HXU_SELECTS[sel.type].replace('-select', '') + '|' + String(sel.label || '').replace(/^[^:]*:\s*/, '')]);
    else if(sel.type === 'polygon' && sel.polygons[0] && sel.polygons[0][0].length <= 300) P.push(['poly', sel.polygons[0][0].map(c => (+c[0]).toFixed(4) + ',' + (+c[1]).toFixed(4)).join(';')]);
    else left.push(sel.type === 'upload' ? 'the uploaded area' : 'the ' + sel.type + ' area');
  }
  if(state.clickSelectedSites.size){
    if(state.clickSelectedSites.size <= HXU_MAX_WELLS) P.push(['w', [...state.clickSelectedSites].map(s => rawWellKey(s).replace('\u0001', '~')).join(',')]);
    else left.push('the picked wells (more than ' + HXU_MAX_WELLS + ')');
  }
  if(!state.showAllWells) P.push(['v', 'c']);
  if(wv.step !== 'raw') P.push(['st', wv.step]);
  if(state.yearWindow.min != null) P.push(['y0', state.yearWindow.min]);
  if(state.yearWindow.max != null) P.push(['y1', state.yearWindow.max]);
  if(state.filters.yearMin != null) P.push(['ra', state.filters.yearMin]);
  if(state.filters.yearMax != null) P.push(['rb', state.filters.yearMax]);
  if(typeof hxCmp !== 'undefined' && hxCmp.a[0] != null && hxCmp.b[0] != null && !document.getElementById('cmp-modal').classList.contains('hidden')) P.push(['ca', hxCmp.a.join('-')], ['cb', hxCmp.b.join('-')]);
  if(wv.fullRecord) P.push(['fr', 1]);
  if(wv.hideFlagged) P.push(['hf', 1]);
  if(!state.waterYear) P.push(['wy', 0]);   // water years are the default since patch69; only an explicit calendar-year choice needs the link param
  if(state.valueMode === 'elevation') P.push(['vm', 'e']);
  if(state.normalize) P.push(['nm', state.normalizeStyle]);
  if(state.group && state.group.mode !== 'off') P.push(['g', state.group.mode + (state.group.n ? ',' + state.group.n : '')]);
  if(state.season && (state.season.monthStart !== 1 || state.season.monthEnd !== 12)) P.push(['ss', state.season.monthStart + '-' + state.season.monthEnd]);
  if(wv.sort && wv.sort !== 'record') P.push(['so', wv.sort]);
  if(state.chartHighlightSite != null) P.push(['hi', rawWellKey(state.chartHighlightSite).replace('\u0001', '~')]);
  if(state.statewideOk && !sel && !state.clickSelectedSites.size) P.push(['sw', 1]);
  return {P, left};
}
function hxQuery(){
  if(hxuRestoring) return '';
  const {P} = hxuState();
  return P.length ? '?' + P.map(([k, v]) => k + '=' + encodeURIComponent(v).replace(/%2C/g, ',').replace(/%7E/g, '~').replace(/%3B/g, ';')).join('&') : '';
}
function hxUrlSync(){
  if(hxuRestoring || !hxScreen) return;
  clearTimeout(hxuTimer);
  hxuTimer = setTimeout(() => { try{ const h = HX_HASH[hxScreen] + hxQuery(); if(location.hash !== h) history.replaceState(history.state, '', h); }catch(e){} }, 350);
}
function hxuParse(){
  const q = location.hash.indexOf('?'); const out = {};
  if(q < 0) return out;
  location.hash.slice(q + 1).split('&').forEach(kv => { const i = kv.indexOf('='); if(i > 0) out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
  return out;
}
var hxuSiteOfKey = null;
function hxuSite(k){
  if(!hxuSiteOfKey){ hxuSiteOfKey = new Map(); for(let s = 0; s < NSITES; s++) hxuSiteOfKey.set(rawWellKey(s).replace('\u0001', '~'), s); }
  return hxuSiteOfKey.get(k);
}
async function hxRestoreFromUrl(){
  const q = hxuParse(); if(!Object.keys(q).length) return;
  hxuRestoring = true;
  try{
    // settings first (nothing is drawn until wells are selected)
    if(q.v === 'c') setView('composite');
    if(q.st && ['raw', 'month', 'year'].includes(q.st)){ const b = document.querySelector(`#wv-step button[data-step="${q.st}"]`); if(b && !b.classList.contains('active')) b.click(); }
    if(q.wy != null){ const c = document.getElementById('toggle-wateryear'), want = q.wy != '0'; if(c && c.checked !== want){ c.checked = want; c.dispatchEvent(new Event('change')); } }
    if(q.nm && ['first', 'ft', 'usgs'].includes(q.nm)){ state.normalize = true; state.normalizeStyle = q.nm; document.getElementById('toggle-normalize').checked = true; document.getElementById('normalize-style').value = q.nm; }
    if(q.g){ const [m, n] = q.g.split(','); const el = document.getElementById('group-mode'); if(el && [...el.options].some(o => o.value === m)){ el.value = m; el.dispatchEvent(new Event('change')); if(n){ const ne = document.getElementById('group-n'); if(ne){ ne.value = n; ne.dispatchEvent(new Event('change')); } } } }
    if(q.ss){ const [a, b] = q.ss.split('-').map(Number); if(a >= 1 && b <= 12){ state.season = {monthStart: a, monthEnd: b}; document.getElementById('season-month-start').value = a; document.getElementById('season-month-end').value = b; document.querySelectorAll('.season-btn').forEach(x => x.classList.toggle('active', x.dataset.ms == a && x.dataset.me == b)); recomputeTrendAndMean(); } }
    if(q.so && ['record', 'id', 'last', 'trend', 'recent'].includes(q.so)){ wv.sort = q.so; document.getElementById('wv-sort').value = q.so; }
    if(q.hf){ wv.hideFlagged = true; const h = document.getElementById('wv-hideflag'); if(h) h.checked = true; }
    if(q.fr){ wv.fullRecord = true; const f = document.getElementById('wv-fullrecord'); if(f) f.checked = true; }
    if(q.ra != null && isFinite(+q.ra)){ state.filters.yearMin = +q.ra; document.getElementById('year-min').value = q.ra; }
    if(q.rb != null && isFinite(+q.rb)){ state.filters.yearMax = +q.rb; document.getElementById('year-max').value = q.rb; }
    if(q.y0 != null || q.y1 != null){
      if(q.y0 != null && isFinite(+q.y0)){ state.yearWindow.min = +q.y0; document.getElementById('yw-min').value = q.y0; }
      if(q.y1 != null && isFinite(+q.y1)){ state.yearWindow.max = +q.y1; document.getElementById('yw-max').value = q.y1; }
      onYearWindowChange();
    }
    // selection
    if(q.a){
      const [key, name] = [q.a.slice(0, q.a.indexOf('|')), q.a.slice(q.a.indexOf('|') + 1)];
      const el = document.getElementById(key + '-select'); const want = name.trim().toLowerCase();
      const find = () => el && ([...el.options].find(o => o.value && o.textContent.trim().toLowerCase() === want) || [...el.options].find(o => o.value && o.textContent.trim().toLowerCase().includes(want)));
      let opt = find();
      for(let i = 0; i < 75 && !opt; i++){ await new Promise(r => setTimeout(r, 200)); opt = find(); }   // the lists fill in as the boundary files arrive
      if(opt){ el.value = opt.value; el.dispatchEvent(new Event('change'));
        for(let i = 0; i < 100 && !state.areaSelection; i++) await new Promise(r => setTimeout(r, 200)); }
    } else if(q.poly){
      const ring = q.poly.split(';').map(p => p.split(',').map(Number)).filter(p => p.length === 2 && isFinite(p[0]) && isFinite(p[1]));
      if(ring.length >= 3){ if(ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push(ring[0]); setAreaSelection({type: 'polygon', polygons: [[ring]], label: `Drawn polygon (${ring.length - 1} pts)`}); }
    }
    if(q.w){
      const sites = q.w.split(',').map(hxuSite).filter(s => s != null);
      if(sites.length){ sites.forEach(s => state.clickSelectedSites.add(s)); recomputeActiveSet(); }
    }
    if(q.sw) state.statewideOk = true;
    if(q.vm === 'e') document.getElementById('btn-mode-elevation').click();   // after the selection, so 3DEP is asked only for the selected wells
    if(q.hi){ const s = hxuSite(q.hi); if(s != null) state.chartHighlightSite = s; }
    renderChart();
    if(q.ca && q.cb){ const pr = v => v.split('-').map(Number), A = pr(q.ca), B = pr(q.cb);
      if(A.length === 2 && B.length === 2 && [...A, ...B].every(isFinite)){ hxCmp.a = A; hxCmp.b = B; hxCmpOpen(); } }
  }catch(e){ console.warn('link restore', e); }
  finally{ hxuRestoring = false; hxUrlSync(); }
}
function hxCopyLink(){
  const {left} = hxuState();
  const url = location.href.split('#')[0] + HX_HASH[hxScreen || 'map'] + hxQuery();
  const done = () => toast('Link copied.' + (left.length ? ' It does not include ' + left.join(' or ') + ' or the data filters' : ' It does not include the data filters') + ': Save project keeps everything.');
  const fallback = () => { const t = document.createElement('textarea'); t.value = url; document.body.appendChild(t); t.select(); try{ document.execCommand('copy'); done(); }catch(e){ toast(url); } t.remove(); };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback); else fallback();
}

// ---- trend table ---------------------------------------------------------------------------
// One row per selected well: Theil-Sen slope of its yearly mean water level over the period shown (positive = water rising,
// whatever the Show setting), Mann-Kendall p, years of data and change over the period. Flagged readings are left out.
var hxTr = {rows: [], sort: 'slope', dir: 1, minYears: 10};
function hxTrendRows(){
  const src = (wv.all && wv.all.length) ? wv.all : (wv.rows || []), out = [];
  src.forEach(w => {
    const by = new Map();
    w.pts.forEach(p => { if(p.flag || p.dtw == null) return; const n = p.n || 1, a = by.get(p.year) || [0, 0]; a[0] += p.dtw * n; a[1] += n; by.set(p.year, a); });
    const yrs = [...by.keys()].sort((a, b) => a - b), r = SITES[w.site];
    const rec = {site: w.site, id: r[0], nm: nmbgmrIdOf(w.site) || '', src: r[3] >= 0 ? SOURCES[r[3]] : '', y0: w.first.year, y1: w.last.year, nYears: yrs.length, nPts: w.pts.length, slope: NaN, p: NaN, change: NaN, last: w.last.dtw};
    if(yrs.length >= Math.max(3, hxTr.minYears)){
      const y = yrs.map(yr => by.get(yr)[0] / by.get(yr)[1]), ts = OT.theilSen(yrs, y);
      rec.slope = -ts.slope; rec.p = OT.mannKendall(y).p; rec.change = rec.slope * (yrs[yrs.length - 1] - yrs[0]);
    }
    out.push(rec);
  });
  return out;
}
function hxTrendRender(){
  const box = document.getElementById('trend-body'); if(!box) return;
  const R = hxTr.rows.slice(), k = hxTr.sort, d = hxTr.dir;
  R.sort((a, b) => { const x = a[k], y = b[k]; const nx = typeof x === 'number' && !isFinite(x), ny = typeof y === 'number' && !isFinite(y); if(nx !== ny) return nx ? 1 : -1; return (typeof x === 'string' ? x.localeCompare(y, undefined, {numeric: true}) : x - y) * d; });
  const ok = R.filter(r => isFinite(r.slope)), rise = ok.filter(r => r.slope > 0 && r.p < 0.05).length, fall = ok.filter(r => r.slope < 0 && r.p < 0.05).length;
  document.getElementById('trend-sum').textContent = `${R.length.toLocaleString()} wells; ${ok.length.toLocaleString()} have at least ${hxTr.minYears} years of data in the period. Clearly rising (p < 0.05): ${rise.toLocaleString()}, clearly falling: ${fall.toLocaleString()}, no clear trend: ${(ok.length - rise - fall).toLocaleString()}.`;
  const MAX = 2000, f2 = v => isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '–';
  box.innerHTML = R.slice(0, MAX).map(r => `<tr data-s="${r.site}"><td>${escHtml(String(r.id))}</td><td>${escHtml(r.src)}</td><td>${r.y0}–${r.y1}</td><td>${r.nYears}</td><td>${r.nPts.toLocaleString()}</td>`
    + `<td class="${!isFinite(r.slope) ? '' : r.slope > 0 ? 'tr-up' : 'tr-dn'}${r.p < 0.05 ? ' tr-sig' : ''}">${f2(r.slope)}</td><td>${isFinite(r.p) ? (r.p < 0.001 ? '<0.001' : r.p.toFixed(3)) : '–'}</td><td>${f2(r.change)}</td></tr>`).join('')
    + (R.length > MAX ? `<tr><td colspan="8" class="hint">First ${MAX.toLocaleString()} of ${R.length.toLocaleString()} shown; the CSV has them all.</td></tr>` : '');
  document.querySelectorAll('#trend-table th').forEach(th => th.dataset.dir = th.dataset.k === k ? (d > 0 ? '▲' : '▼') : '');
}
function hxTrendOpen(){
  hxTr.rows = hxTrendRows();
  if(!hxTr.rows.length){ toast('No wells are drawn yet.'); return; }
  document.getElementById('trend-modal').classList.remove('hidden'); hxTrendRender();
  document.getElementById('trend-close').focus();
}
function hxTrendCsv(){
  const r2 = (v, n) => isFinite(v) ? Math.round(v * n) / n : '';
  const rows = [['well_id', 'nmbgmr_site_id', 'source', 'longitude', 'latitude', 'first_year', 'last_year', 'years_with_data', 'readings', 'trend_ft_per_yr_positive_is_rising', 'mann_kendall_p', 'change_over_period_ft', 'last_depth_to_water_ft']];
  hxTr.rows.forEach(r => { const s = SITES[r.site]; rows.push([r.id, r.nm, r.src, s[1], s[2], r.y0, r.y1, r.nYears, r.nPts, r2(r.slope, 1000), r2(r.p, 10000), r2(r.change, 100), r2(r.last, 100)]); });
  downloadCsv(wvCsvName().replace('hydrographs', 'trends'), rows);
}
function hxTrendInit(){
  const m = document.getElementById('trend-modal'); if(!m) return;
  document.getElementById('btn-trends').addEventListener('click', hxTrendOpen);
  document.getElementById('trend-close').addEventListener('click', () => m.classList.add('hidden'));
  m.addEventListener('click', e => { if(e.target === m) m.classList.add('hidden'); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && !m.classList.contains('hidden')) m.classList.add('hidden'); });
  document.getElementById('trend-csv').addEventListener('click', hxTrendCsv);
  document.getElementById('trend-miny').addEventListener('change', e => { const v = Math.max(3, Math.min(60, Math.round(+e.target.value) || 10)); e.target.value = v; hxTr.minYears = v; hxTr.rows = hxTrendRows(); hxTrendRender(); });
  document.getElementById('trend-table').addEventListener('click', e => {
    const th = e.target.closest('th[data-k]');
    if(th){ if(hxTr.sort === th.dataset.k) hxTr.dir = -hxTr.dir; else { hxTr.sort = th.dataset.k; hxTr.dir = (th.dataset.k === 'id' || th.dataset.k === 'src') ? 1 : (th.dataset.k === 'slope' || th.dataset.k === 'change' ? 1 : -1); } hxTrendRender(); return; }
    const tr = e.target.closest('tr[data-s]'); if(tr){ m.classList.add('hidden'); state.chartHighlightSite = +tr.dataset.s; renderChart(); }
  });
}

// ---- Compare periods ---------------------------------------------------------------------------------
// Two date ranges (A and B), each summarised from the readings themselves (not from what the Period control is currently showing):
// per well, the mean depth to water (mean of the yearly means) and the Theil-Sen trend inside each range, and the change
// from A to B. Positive change or trend = water rising (depth to water getting smaller). Wells are the selected wells that pass the
// Data filters; the Period is ignored here, so a range outside it still works. Flagged readings, the Season, Water years and the
// reading-quality filters apply as everywhere else.
function hxCmpDefaults(){ return {a: [null, null], b: [null, null], stable: 0.5, minYears: 3, bands: true, rows: [], paired: [], sort: 'chg', dir: -1, token: 0, chart: null, init: false, counts: null}; }
var hxCmp = hxCmp || hxCmpDefaults();   // hxInit runs before this file's top level, so hxCmpInit repeats this
function hxCmpWells(){
  const click = state.clickSelectedSites, base = state.areaSelection && state._inAreaBase;
  if(!state.areaSelection && !click.size) return [];
  const out = []; state._noWin = true;
  try{ for(let s = 0; s < NSITES; s++){ const inArea = click.has(s) || (base && base[s]); if(inArea && (click.has(s) || passesFilters(s))) out.push(s); } }
  finally{ state._noWin = false; }
  return out;
}
function hxMedian(a){ if(!a.length) return NaN; const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function hxQuant(a, q){ if(!a.length) return NaN; const b = a.slice().sort((x, y) => x - y), i = (b.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return b[lo] + (b[hi] - b[lo]) * (i - lo); }
function hxErf(x){ const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
function hxWilcoxonP(d){   // two-sided signed-rank test, normal approximation with tie and continuity corrections
  const v = d.filter(x => x !== 0), n = v.length; if(n < 6) return NaN;
  const idx = v.map((x, i) => i).sort((i, j) => Math.abs(v[i]) - Math.abs(v[j])), rank = new Array(n); let ties = 0;
  for(let i = 0; i < n;){ let j = i; while(j + 1 < n && Math.abs(v[idx[j + 1]]) === Math.abs(v[idx[i]])) j++; const r = (i + j) / 2 + 1; for(let k = i; k <= j; k++) rank[idx[k]] = r; const t = j - i + 1; ties += t * t * t - t; i = j + 1; }
  let wp = 0; v.forEach((x, i) => { if(x > 0) wp += rank[i]; });
  const mean = n * (n + 1) / 4, sd = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24 - ties / 48); if(!(sd > 0)) return NaN;
  const z = (Math.abs(wp - mean) - 0.5) / sd; return Math.max(0, Math.min(1, 1 - hxErf(z / Math.SQRT2)));
}
// same rule as the composite: water years move Oct-Dec to the next year, and a season that wraps the new year (e.g. Nov-Feb)
// counts as one year (winter 2020 = Nov-Dec 2019 + Jan-Feb 2020)
function hxCmpYearOf(p){ const ms = state.season.monthStart, me = state.season.monthEnd; return ((state.waterYear && p.month >= 10) || (ms > me && p.month >= ms)) ? p.year + 1 : p.year; }
function hxCmpStats(pts, y0, y1){
  const by = new Map(); let n = 0, lo = Infinity, hi = -Infinity;
  for(const p of pts){ const y = hxCmpYearOf(p); if(y < y0 || y > y1) continue; const a = by.get(y) || [0, 0]; a[0] += p.dtw; a[1]++; by.set(y, a); n++; if(p.dtw < lo) lo = p.dtw; if(p.dtw > hi) hi = p.dtw; }
  if(!n) return null;
  const yrs = [...by.keys()].sort((a, b) => a - b), means = yrs.map(y => by.get(y)[0] / by.get(y)[1]);
  const mean = means.reduce((a, b) => a + b, 0) / means.length;
  const r = {n, nYears: yrs.length, mean, min: lo, max: hi, slope: NaN};
  if(yrs.length >= Math.max(3, hxCmp.minYears)) r.slope = -OT.theilSen(yrs, means).slope;
  return r;
}
async function hxCmpCompute(){
  const token = ++hxCmp.token, sites = hxCmpWells(), status = document.getElementById('cmp-status');
  const [a0, a1] = hxCmp.a, [b0, b1] = hxCmp.b;
  if(![a0, a1, b0, b1].every(v => v != null && isFinite(v)) || a0 > a1 || b0 > b1){ status.textContent = 'Enter a from and to year for both periods.'; return; }
  const keep = {vm: state.valueMode, nm: state.normalize, fr: wv.fullRecord, hf: wv.hideFlagged};
  const rows = [], t0 = performance.now();
  try{
    for(let i = 0; i < sites.length; i++){
      if(token !== hxCmp.token) return;
      if(i % 200 === 0){ status.textContent = `Computing… ${i.toLocaleString()} of ${sites.length.toLocaleString()} wells`; await new Promise(r => setTimeout(r, 0)); }
      // plain depth, whole record, flagged readings left out, whatever the chart is showing
      state.valueMode = 'depth'; state.normalize = false; wv.fullRecord = true; wv.hideFlagged = true;
      let pts = null; try{ pts = wvRawSeries(sites[i]); }finally{ state.valueMode = keep.vm; state.normalize = keep.nm; wv.fullRecord = keep.fr; wv.hideFlagged = keep.hf; }
      if(!pts) continue;
      const A = hxCmpStats(pts, a0, a1), B = hxCmpStats(pts, b0, b1); if(!A && !B) continue;
      const r = SITES[sites[i]];
      rows.push({site: sites[i], id: r[0], src: r[3] >= 0 ? SOURCES[r[3]] : '', A, B, chg: NaN, dslope: NaN});
    }
  } finally { state.valueMode = keep.vm; state.normalize = keep.nm; wv.fullRecord = keep.fr; wv.hideFlagged = keep.hf; }
  if(token !== hxCmp.token) return;
  const need = Math.max(1, hxCmp.minYears);
  rows.forEach(r => { if(r.A && r.B && r.A.nYears >= need && r.B.nYears >= need){ r.chg = r.A.mean - r.B.mean; if(isFinite(r.A.slope) && isFinite(r.B.slope)) r.dslope = r.B.slope - r.A.slope; } });
  hxCmp.rows = rows; hxCmp.counts = {wells: sites.length, secs: (performance.now() - t0) / 1000};
  hxCmpRender();
  try{ if(chart) chart.draw(); }catch(e){}
  hxUrlSync();
}
function hxCmpSummary(){
  const R = hxCmp.rows, need = Math.max(1, hxCmp.minYears), st = hxCmp.stable;
  const inA = R.filter(r => r.A && r.A.nYears >= need), inB = R.filter(r => r.B && r.B.nYears >= need);
  const pr = R.filter(r => isFinite(r.chg)), ch = pr.map(r => r.chg);
  const per = L => { const sl = L.map(r => r.slope).filter(isFinite); return {n: L.length, mean: hxMedian(L.map(r => r.mean)), slope: hxMedian(sl), nSlope: sl.length, rise: sl.filter(v => v > st / 10).length, fall: sl.filter(v => v < -st / 10).length}; };
  return {A: per(inA.map(r => r.A)), B: per(inB.map(r => r.B)), pairs: pr.length, med: hxMedian(ch), mean: ch.length ? ch.reduce((a, b) => a + b, 0) / ch.length : NaN, q1: hxQuant(ch, .25), q3: hxQuant(ch, .75),
    up: ch.filter(v => v > st).length, down: ch.filter(v => v < -st).length, same: ch.filter(v => Math.abs(v) <= st).length, p: hxWilcoxonP(ch), dslope: hxMedian(pr.map(r => r.dslope).filter(isFinite)), onlyA: inA.length - pr.length, onlyB: inB.length - pr.length};
}
function hxCmpRender(){
  const S = hxCmpSummary(), f1 = v => isFinite(v) ? v.toFixed(1) : '–', f2 = v => isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '–', fn = v => v.toLocaleString();
  const [a0, a1] = hxCmp.a, [b0, b1] = hxCmp.b;
  document.getElementById('cmp-status').textContent = `${fn(hxCmp.counts.wells)} wells selected and passing the Data filters; ${fn(S.A.n)} have at least ${hxCmp.minYears} years of readings in A, ${fn(S.B.n)} in B, ${fn(S.pairs)} in both (computed in ${hxCmp.counts.secs.toFixed(1)} s).`;
  const T = document.getElementById('cmp-summary');
  T.innerHTML = `<thead><tr><th></th><th>A: ${a0}–${a1}</th><th>B: ${b0}–${b1}</th><th>B compared with A</th></tr></thead><tbody>`
    + `<tr><td>Wells with data</td><td>${fn(S.A.n)}</td><td>${fn(S.B.n)}</td><td>${fn(S.pairs)} in both</td></tr>`
    + `<tr><td>Median depth to water (ft)</td><td>${f1(S.A.mean)}</td><td>${f1(S.B.mean)}</td><td>different wells in each column; see the change below</td></tr>`
    + `<tr><td>Median trend (ft/yr, + = rising)</td><td>${f2(S.A.slope)}</td><td>${f2(S.B.slope)}</td><td>${f2(S.dslope)} (same wells, B minus A)</td></tr>`
    + `<tr><td title="A trend counts as rising or falling when it is beyond a tenth of the stable band per year">Wells rising / falling (trend beyond ±${(hxCmp.stable / 10).toFixed(2)} ft/yr)</td><td>${fn(S.A.rise)} / ${fn(S.A.fall)}</td><td>${fn(S.B.rise)} / ${fn(S.B.fall)}</td><td></td></tr>`
    + `<tr class="cmp-key"><td>Change in level, same wells (ft)</td><td colspan="3">median <b>${f2(S.med)}</b> (middle half ${f2(S.q1)} to ${f2(S.q3)}), mean ${f2(S.mean)}; `
    + `<b>${fn(S.up)}</b> rose by more than ${hxCmp.stable} ft, <b>${fn(S.down)}</b> fell, ${fn(S.same)} within ±${hxCmp.stable} ft`
    + (isFinite(S.p) ? `; Wilcoxon signed-rank p ${S.p < 0.0001 ? '< 0.0001' : S.p.toFixed(4)}` : '') + `</td></tr></tbody>`;
  hxCmpHist(); hxCmpTable();
}
function hxCmpHist(){
  const v = hxCmp.rows.map(r => r.chg).filter(isFinite), cv = document.getElementById('cmp-hist'); if(hxCmp.chart){ hxCmp.chart.destroy(); hxCmp.chart = null; }
  document.getElementById('cmp-histnote').textContent = v.length ? '' : 'No well has enough years in both periods.'; if(!v.length) return;
  let lo = hxQuant(v, .01), hi = hxQuant(v, .99); if(!(hi > lo)){ lo -= 1; hi += 1; }
  const nb = 24, w = (hi - lo) / nb, bins = new Array(nb).fill(0); v.forEach(x => { const i = Math.min(nb - 1, Math.max(0, Math.floor((x - lo) / w))); bins[i]++; });
  const lab = bins.map((_, i) => (lo + w * (i + .5)).toFixed(Math.abs(w) < 1 ? 1 : 0));
  hxCmp.chart = new Chart(cv.getContext('2d'), {type: 'bar', data: {labels: lab, datasets: [{data: bins, backgroundColor: bins.map((_, i) => lo + w * (i + .5) >= 0 ? '#2f7fc1' : '#b5533c'), borderWidth: 0, categoryPercentage: 1, barPercentage: .95}]},
    options: {responsive: true, maintainAspectRatio: false, animation: false, plugins: {legend: {display: false}, tooltip: {callbacks: {title: i => `${(lo + w * i[0].dataIndex).toFixed(1)} to ${(lo + w * (i[0].dataIndex + 1)).toFixed(1)} ft`, label: c => `${c.parsed.y} wells`}}},
      scales: {x: {title: {display: true, text: 'Change in water level from A to B (ft; right = rising, left = falling; the middle 98% of wells)'}, ticks: {maxTicksLimit: 12}}, y: {title: {display: true, text: 'Wells'}, beginAtZero: true}}}});
}
function hxCmpTable(){
  const k = hxCmp.sort, d = hxCmp.dir, get = r => k === 'id' ? r.id : k === 'src' ? r.src : k === 'chg' ? r.chg : k === 'dslope' ? r.dslope : (k[0] === 'A' || k[0] === 'B') && r[k[0]] ? r[k[0]][k.slice(1)] : NaN;
  const R = hxCmp.rows.slice().sort((a, b) => { const x = get(a), y = get(b), nx = typeof x === 'number' && !isFinite(x), ny = typeof y === 'number' && !isFinite(y); if(nx !== ny) return nx ? 1 : -1; return (typeof x === 'string' ? x.localeCompare(y, undefined, {numeric: true}) : x - y) * d; });
  const f1 = v => isFinite(v) ? v.toFixed(1) : '–', f2 = v => isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '–', MAX = 2000;
  const cell = (P) => P ? `<td>${P.nYears}</td><td>${f1(P.mean)}</td><td>${f2(P.slope)}</td>` : '<td>–</td><td>–</td><td>–</td>';
  document.getElementById('cmp-body').innerHTML = R.slice(0, MAX).map(r => `<tr data-s="${r.site}"><td>${escHtml(String(r.id))}</td><td>${escHtml(r.src)}</td>${cell(r.A)}${cell(r.B)}<td class="${!isFinite(r.chg) ? '' : r.chg > 0 ? 'tr-up' : 'tr-dn'}">${f2(r.chg)}</td><td>${f2(r.dslope)}</td></tr>`).join('')
    + (R.length > MAX ? `<tr><td colspan="10" class="hint">First ${MAX.toLocaleString()} of ${R.length.toLocaleString()} shown; the CSV has them all.</td></tr>` : '');
  document.querySelectorAll('#cmp-table th[data-k]').forEach(th => th.dataset.dir = th.dataset.k === k ? (d > 0 ? '▲' : '▼') : '');
}
function hxCmpCsv(){
  const r1 = (v, n) => isFinite(v) ? Math.round(v * n) / n : '';
  const [a0, a1] = hxCmp.a, [b0, b1] = hxCmp.b, P = (p, key, n) => p ? r1(p[key], n) : '';
  const rows = [['well_id', 'source', 'longitude', 'latitude', `A_${a0}_${a1}_years_with_data`, `A_readings`, `A_mean_depth_to_water_ft`, `A_trend_ft_per_yr_positive_is_rising`, `B_${b0}_${b1}_years_with_data`, `B_readings`, `B_mean_depth_to_water_ft`, `B_trend_ft_per_yr_positive_is_rising`, 'change_in_level_A_to_B_ft_positive_is_rising', 'change_in_trend_ft_per_yr']];
  hxCmp.rows.forEach(r => { const s = SITES[r.site]; rows.push([r.id, r.src, s[1], s[2], r.A ? r.A.nYears : '', r.A ? r.A.n : '', P(r.A, 'mean', 100), P(r.A, 'slope', 1000), r.B ? r.B.nYears : '', r.B ? r.B.n : '', P(r.B, 'mean', 100), P(r.B, 'slope', 1000), r1(r.chg, 100), r1(r.dslope, 1000)]); });
  downloadCsv(wvCsvName().replace('hydrographs', `comparison_${a0}-${a1}_vs_${b0}-${b1}`), rows);
}
// the two periods are shaded on the main chart (A blue, B amber)
function hxBandsPluginDef(){ return {id: 'hxBands', beforeDatasetsDraw(ch){
  if(ch !== chart || !hxCmp.bands || hxCmp.a[0] == null || hxCmp.b[0] == null) return;
  const x = ch.scales && ch.scales.x, ca = ch.chartArea; if(!x || !ca || x.type !== 'linear') return;
  const c = ch.ctx; c.save();
  [[hxCmp.a, 'rgba(47,127,193,.13)', 'rgba(47,127,193,.9)', 'A'], [hxCmp.b, 'rgba(230,159,0,.16)', 'rgba(190,120,0,.95)', 'B']].forEach(([p, fill, ink, lab]) => {
    if(p[0] == null || p[1] == null) return;
    const x0 = Math.max(ca.left, x.getPixelForValue(p[0])), x1 = Math.min(ca.right, x.getPixelForValue(p[1] + 1)); if(!(x1 > x0)) return;
    c.fillStyle = fill; c.fillRect(x0, ca.top, x1 - x0, ca.bottom - ca.top);
  });
  c.restore();
}, afterDatasetsDraw(ch){   // labels on top of the well lines
  if(ch !== chart || !hxCmp.bands || hxCmp.a[0] == null || hxCmp.b[0] == null) return;
  const x = ch.scales && ch.scales.x, ca = ch.chartArea; if(!x || !ca || x.type !== 'linear') return;
  const c = ch.ctx; c.save(); c.font = '700 12px system-ui, sans-serif';
  [[hxCmp.a, 'rgba(47,127,193,1)', 'A', 0], [hxCmp.b, 'rgba(190,120,0,1)', 'B', 19]].forEach(([p, ink, lab, dy]) => {   // B one row lower so the two never overlap
    if(p[0] == null || p[1] == null) return; const t = lab + ' ' + p[0] + '–' + p[1], w = c.measureText(t).width;
    let x0 = Math.max(ca.left, x.getPixelForValue(p[0])); if(x0 >= ca.right) return; x0 = Math.min(x0, ca.right - w - 10);
    c.fillStyle = 'rgba(255,255,255,.85)'; c.fillRect(x0 + 3, ca.top + 3 + dy, w + 6, 16); c.fillStyle = ink; c.fillText(t, x0 + 6, ca.top + 15 + dy);
  });
  c.restore();
}}; }
function hxCmpFill(){
  const set = (id, v) => { document.getElementById(id).value = v == null ? '' : v; };
  set('cmp-a0', hxCmp.a[0]); set('cmp-a1', hxCmp.a[1]); set('cmp-b0', hxCmp.b[0]); set('cmp-b1', hxCmp.b[1]); set('cmp-stable', hxCmp.stable); set('cmp-miny', hxCmp.minYears);
  document.getElementById('cmp-bands').checked = hxCmp.bands;
}
function hxCmpPreset(n){
  let last = -Infinity; hxCmpWells().forEach(s => { const y = SITES[s][7]; if(y != null && y > last) last = y; });
  if(!isFinite(last)) last = new Date().getFullYear();
  hxCmp.b = [last - n + 1, last]; hxCmp.a = [last - 2 * n + 1, last - n]; hxCmpFill();
}
function hxCmpOpen(){
  if(!state.areaSelection && !state.clickSelectedSites.size){ toast('Choose an area or wells first.'); return; }
  if(hxCmp.a[0] == null) hxCmpPreset(10);
  hxCmpFill(); document.getElementById('cmp-modal').classList.remove('hidden'); document.getElementById('cmp-close').focus(); hxCmpCompute();
}
function hxCmpInit(){
  const m = document.getElementById('cmp-modal'); if(!m) return; if(!hxCmp) hxCmp = hxCmpDefaults(); hxCmp.init = true;
  document.getElementById('btn-compare').addEventListener('click', hxCmpOpen);
  const hide = () => m.classList.add('hidden');
  document.getElementById('cmp-close').addEventListener('click', hide); m.addEventListener('click', e => { if(e.target === m) hide(); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && !m.classList.contains('hidden')) hide(); });
  document.getElementById('cmp-csv').addEventListener('click', hxCmpCsv);
  let tmr = null;
  const changed = () => { const n = id => { const v = document.getElementById(id).value.trim(); return v === '' ? null : +v; };
    hxCmp.a = [n('cmp-a0'), n('cmp-a1')]; hxCmp.b = [n('cmp-b0'), n('cmp-b1')];
    hxCmp.stable = Math.max(0, n('cmp-stable') ?? 0.5); hxCmp.minYears = Math.max(1, Math.min(30, Math.round(n('cmp-miny') ?? 3)));
    hxCmp.bands = document.getElementById('cmp-bands').checked; try{ if(chart) chart.draw(); }catch(e){}
    clearTimeout(tmr); tmr = setTimeout(hxCmpCompute, 400); };
  ['cmp-a0', 'cmp-a1', 'cmp-b0', 'cmp-b1', 'cmp-stable', 'cmp-miny'].forEach(id => document.getElementById(id).addEventListener('input', changed));
  document.getElementById('cmp-bands').addEventListener('change', changed);
  m.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => { hxCmpPreset(+b.dataset.preset); changed(); }));
  document.getElementById('cmp-table').addEventListener('click', e => {
    const th = e.target.closest('th[data-k]');
    if(th){ if(hxCmp.sort === th.dataset.k) hxCmp.dir = -hxCmp.dir; else { hxCmp.sort = th.dataset.k; hxCmp.dir = (th.dataset.k === 'id' || th.dataset.k === 'src') ? 1 : -1; } hxCmpTable(); return; }
    const tr = e.target.closest('tr[data-s]'); if(tr){ hide(); state.chartHighlightSite = +tr.dataset.s; renderChart(); }
  });
  Chart.register(hxBandsPluginDef());
}

// ---- Overview: every selected well on its own, no shared-year matching -----------------------
function overviewSeries(s){
  const pts = getYearSeries(s).map(p=>({x:p.year, y:toDisplay(s, p.avg)})).filter(p=>p.y!=null);
  if(!pts.length) return null;
  if(useUsgsNorm()){ const v = usgsNormalize(pts.map(p=>p.y)); pts.forEach((p,i)=>{ p.y = v[i]; }); }
  else if(state.normalize && state.normalizeStyle === 'first'){ const f = pts[0].y; pts.forEach(p=>{ p.y -= f; }); }
  else if(state.normalize){ const b = siteOwnMeanDisplay(s); if(!isNaN(b)) pts.forEach(p=>{ p.y -= b; }); }
  return pts;
}
function renderAllWells(set){
  const empty = document.getElementById('hydrograph-empty'), canvas = document.getElementById('hydrograph-canvas');
  document.getElementById('drawer-sub').textContent = `— ${set.size.toLocaleString()} well(s) selected · overview of every well`;
  const all = [];
  set.forEach(s=>{ const pts = overviewSeries(s); if(pts) all.push({site:s, pts}); });
  const noData = set.size - all.length;
  window._lastComposite = null; window._lastSeasonOverlays = null; window._lastGroups = null;
  const statIds = ['stat-nqual','stat-npoints','stat-meanchg','stat-medchg'];
  if(!all.length){
    empty.style.display = 'flex'; canvas.style.display = 'none';
    empty.querySelector('b').textContent = 'None of the selected wells have data under the current settings';
    empty.querySelector('span').textContent = 'Check the period shown, season, bad-reading removal or elevation mode — they can remove every reading.';
    const b = document.getElementById('btn-show-all-wells'); if(b) b.style.display = 'none';
    if(chart){ chart.destroy(); chart = null; }
    statIds.forEach(id=>document.getElementById(id).textContent='–');
    window._lastOverview = null; state.qualifyingSites = new Set(); restyleMarkers();
    const el = document.getElementById('explain-text'); if(el) el.textContent = `${set.size} well(s) are selected but none has any readings under the current period, season and elevation settings.`;
    return;
  }
  empty.style.display = 'none'; canvas.style.display = 'block';
  all.sort((a,b)=>b.pts.length - a.pts.length);
  const shown = all.slice(0, SPAGHETTI_CAP());   // longest records first, capped so a statewide selection cannot freeze the page
  window._lastOverview = shown;
  state.qualifyingSites = new Set(shown.map(w=>w.site)); restyleMarkers();
  const muted = getComputedStyle(document.body).getPropertyValue('--muted').trim();
  const palette = ['#c1652f','#2f7fc1','#7a9c3f','#a26bc2','#c9a227','#6b7fd4','#c25d8f','#5a8f8c','#b5533c','#3f8f7a','#8a6bb0','#c98f3e'];
  const dashes = [[], [5,3], [1,2], [7,2,1,2]];
  const datasets = shown.map((w,i)=>({
    label:SITES[w.site][0], _site:w.site, data:w.pts,
    borderColor: w.site===state.chartHighlightSite ? '#e0455c' : hexA(palette[i % palette.length], shown.length>60 ? 0.55 : 0.85), backgroundColor: w.site===state.chartHighlightSite ? '#e0455c' : hexA(palette[i % palette.length], 0.85),
    order: w.site===state.chartHighlightSite ? 0 : 1,
    borderWidth: w.site===state.chartHighlightSite ? 3.5 : (shown.length>60 ? 1 : 1.5), borderDash: shown.length>60 ? [] : dashes[Math.floor(i/palette.length) % dashes.length],
    pointRadius: w.pts.length < 3 ? 3.5 : (shown.length>600 ? 1 : 1.8), pointHoverRadius:5, spanGaps:true, tension:0
  }));
  const revAxis = state.valueMode === 'depth' && !useUsgsNorm();
  if(chart){ chart.destroy(); chart = null; }
  chart = new Chart(canvas.getContext('2d'), {
    type:'line', data:{datasets},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false, parsing:false,
      interaction:{mode:'nearest', intersect:false},
      onClick:(e, els)=>{ if(els && els.length){ const ds = chart.data.datasets[els[0].datasetIndex]; if(ds && ds._site!=null) handleChartWellClick(ds._site); } },
      plugins:{
        legend:{display:false},
        tooltip:{callbacks:{title:items=>items.map(i=>i.dataset.label), label:c=>`${Math.round(c.parsed.x)}: ${c.parsed.y.toFixed(1)}${useUsgsNorm()?' %':' ft'}`}}
      },
      scales:{
        x:{type:'linear', ticks:{color:muted, callback:v=>Number.isInteger(v)?String(v):''}, grid:{color:'rgba(125,136,115,.2)'}, title:{display:true, text:'Year', color:muted}},
        y:{reverse:revAxis, ticks:{color:muted}, grid:{color:'rgba(125,136,115,.2)'}, title:{display:true, text:wrapAxisTitle(yAxisTitle(), canvas.clientHeight - 60), color:muted}}
      }
    }
  });
  document.getElementById('stat-nqual').textContent = shown.length.toLocaleString() + ' plotted';
  document.getElementById('stat-npoints').textContent = shown.reduce((a,w)=>a+w.pts.length,0).toLocaleString() + ' yr values';
  document.getElementById('stat-meanchg').textContent = '–'; document.getElementById('stat-medchg').textContent = '–';
  const note = document.getElementById('spaghetti-note');
  if(note){
    const over = all.length - shown.length;
    note.textContent = over>0 ? `Overview shows the ${shown.length} wells with the longest records; ${over} more are hidden by the "Max. wells to draw" limit — raise it or narrow the area.` : '';
    note.style.display = over>0 ? 'block' : 'none';
  }
  const el = document.getElementById('explain-text');
  if(el) el.textContent = `Overview mode: each of the ${shown.length} wells is drawn on its own with one value per year that has readings — no shared-year matching, no composite mean/median. ${noData ? noData+' selected well(s) have no readings under the current settings and are not shown. ' : ''}Click a line to highlight that well on the map and open its card (the card has a \"Plot this well & export\" button for its own hydrograph with CSV / GeoJSON / image export). Turn off "Overview" to return to the composite.`;
}
// Ocotillo readings for the selected NMBGMR wells
const OCO_MAX = 400;
function ocoStatus(msg){ const el = document.getElementById('oco-status'); if(el) el.textContent = msg; }
async function ocoReadingsFor(sites){
  const todo = [];
  sites.forEach(s => { const r = SITES[s]; if(r[3] < 0 || SOURCES[r[3]] !== 'NMBGMR') return; const id = oco.ids.get(String(r[0])); if(id != null && !oco.fetched.has(id)) todo.push([id, String(r[0])]); });
  if(!todo.length) return 0;
  if(todo.length > OCO_MAX){ ocoStatus(`This selection has ${todo.length.toLocaleString()} Ocotillo wells; select a smaller area (up to ${OCO_MAX}) to add their readings.`); return 0; }
  let done = 0, months = [], fails = 0;
  const one = async ([id, name]) => {
    try{
      let M = null; const ck = 'oco:' + (oco.key ? 'k:' : '') + id;
      if(oco.key) M = oco.mem.get(id) || null;
      else try{ const c = await idbGet(ck); if(c && Date.now() - c.savedAt < 30*864e5) M = c.months; }catch(e){}
      if(!M){
        const d = await ocoGet('/collections/waterlevels/locations/' + id + '?f=json', 90000);
        const by = new Map();
        ((d && d.coverages) || []).forEach(cv => { const t = cv.domain.axes.t.values, R = cv.ranges, key = Object.keys(R)[0], v = R[key].values;
          t.forEach((ts, k) => { const x = v[k]; if(x == null || !isFinite(x)) return; const y = +ts.slice(0, 4), m = +ts.slice(5, 7); const kk = y*100 + m; const a = by.get(kk); if(a){ a[0] += x; a[1]++; } else by.set(kk, [x, 1]); }); });
        M = [...by].map(([kk, a]) => [Math.floor(kk/100), kk % 100, Math.round(a[0]/a[1]*100)/100]);
        if(oco.key) oco.mem.set(id, M); else try{ idbSet(ck, {savedAt: Date.now(), months: M}); }catch(e){}
      }
      M.forEach(([y, m, v]) => months.push({source:'NMBGMR', id:name, y, m, v}));
      oco.fetched.set(id, true);
    }catch(e){ fails++; }
    done++; if(done % 5 === 0 || done === todo.length) ocoStatus(`Fetching Ocotillo readings… ${done} of ${todo.length} wells`);
  };
  for(let i=0; i<todo.length; i+=4) await Promise.all(todo.slice(i, i+4).map(one));
  const res = BOOT.addMonths(months);
  oco.totAdded = (oco.totAdded || 0) + res.added; oco.totHad = (oco.totHad || 0) + res.had; oco.adj = (oco.adj || 0) + res.adjWells; oco.unadj = (oco.unadj || 0) + res.unadjWells; oco.offsets = (oco.offsets || []).concat(res.offsets);
  ocoStatus(`Ocotillo: ${oco.wells.toLocaleString()} wells with water levels${oco.key ? ' (with your key)' : ''}; ${oco.newWells.toLocaleString()} not in the unified API were added. This session: ${oco.fetched.size.toLocaleString()} wells read, ${oco.totAdded.toLocaleString()} months added, ${oco.totHad.toLocaleString()} months skipped because the well already had a reading. Measuring-point offsets: ${oco.adj} wells adjusted (median offset ${ocoMedOff()} ft), ${oco.unadj} added unadjusted (fewer than 3 months shared with the unified API, so up to the measuring-point height too deep).` + (fails ? ` ${fails} wells could not be read (Ocotillo busy); they will be retried.` : ''));
  if(fails) todo.forEach(([id]) => { if(!oco.fetched.has(id)) {} });
  return res.added;
}
function ocoMedOff(){ const o = (oco.offsets || []).slice().sort((a,b)=>a-b); return o.length ? o[o.length >> 1].toFixed(2) : 'n/a'; }
function ocoMaybe(){
  if(!ocoOn() || !oco.ids.size || oco.busy) return;
  const sel = state.areaSelection, key = (sel ? sel.label : '') + '|' + state.clickSelectedSites.size;
  if(!sel && !state.clickSelectedSites.size) return;
  if(key === oco.lastKey) return; oco.lastKey = key;
  const sites = [...state.activeSet];
  oco.busy = true;
  setTimeout(async () => { try{ const n = await ocoReadingsFor(sites); if(n){ applyReadingQuality(); } }catch(e){ console.warn('ocotillo', e); } finally{ oco.busy = false; } }, 50);
}
let compChart = null;
function renderCompBanner(result){
  const el = document.getElementById('comp-banner'); if(!el) return;
  const C = result && result.composition;
  if(!C || !C.warn || !chart || state.showAllWells){ el.style.display = 'none'; return; }
  const S = C.shift, o = state.otp;
  el.style.display = 'block';
  el.innerHTML = `<b>Caution:</b> around ${S.from}–${S.to} the wells measured sit in a different part of the area and behave differently from the rest (often because pumping differs between the two), so the line there follows those wells rather than the whole area (details under the chart). ` +
    (o.method !== 'units' ? '<a id="cb-units" style="cursor:pointer; color:var(--accent);">Switch to Area units</a> · ' : 'Area units is on. ') +
    (o.fixed ? `Fixed well set is on (${o.fixed}%).` : '<a id="cb-fixed" style="cursor:pointer; color:var(--accent);">Compare with a fixed well set (70%)</a>');
  const u = document.getElementById('cb-units'); if(u) u.onclick = () => { state.otp.method = 'units'; syncOtUi(); renderChart(); };
  const f = document.getElementById('cb-fixed'); if(f) f.onclick = () => { state.otp.fixed = 70; syncOtUi(); renderChart(); };
}
function renderCompStrip(result){
  try{ renderCompBanner(result); }catch(e){}
  const box = document.getElementById('comp-strip'), cap = document.getElementById('comp-caption');
  if(compChart){ compChart.destroy(); compChart = null; }
  const C = result && result.composition;
  if(!C || !chart || state.showAllWells){ box.style.display = 'none'; cap.style.display = 'none'; return; }
  window._compLast = result;
  cap.style.display = 'block';
  if(!C.warn && !state.compOpen){
    box.style.display = 'none';
    cap.innerHTML = 'Composition check: no warning (the wells measured stay representative of the whole set). <a id="comp-toggle">Show the check ▸</a>';
    document.getElementById('comp-toggle').onclick = () => { state.compOpen = true; renderCompStrip(window._compLast); };
    return;
  }
  box.style.display = 'block';
  const css = getComputedStyle(document.documentElement), muted = css.getPropertyValue('--muted').trim() || '#888', border = css.getPropertyValue('--border').trim() || '#ddd';
  const dep = state.valueMode === 'depth';
  const lv = C.lvl.filter(v => v != null), mx = lv.length ? Math.max(...lv.map(Math.abs)) : 0;
  compChart = new Chart(document.getElementById('comp-canvas').getContext('2d'), {
    type:'line',
    data:{ labels: result.labels, datasets:[
      {label: dep ? 'Typical depth to water of the wells measured, vs all wells (ft)' : 'Typical water elevation of the wells measured, vs all wells (ft)', data: C.lvl, yAxisID:'y', borderColor:'#b45309', backgroundColor:'#b45309', borderWidth:1.5, pointRadius:0, spanGaps:false},
      {label:'Centre of the wells measured, km from the centre of all wells', data: C.dist, yAxisID:'y2', borderColor:'#6b7f99', backgroundColor:'#6b7f99', borderWidth:1.2, borderDash:[4,3], pointRadius:0, spanGaps:false}]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false, interaction:{mode:'index', intersect:false},
      plugins:{ legend:{display:true, position:'top', align:'start', labels:{boxWidth:14, font:{size:10.5}, color:muted}},
        tooltip:{callbacks:{label: c => c.raw == null ? '' : `${c.dataset.label}: ${c.raw >= 0 && c.datasetIndex === 0 ? '+' : ''}${c.raw.toFixed(1)}`}} },
      scales:{ x:{ display:false },
        y:{ reverse: dep, grid:{color:border}, ticks:{color:muted, maxTicksLimit:3}, title:{display:true, text:'ft', color:muted},
            afterFit: ax => { if(chart && chart.scales.y) ax.width = chart.scales.y.width; } },
        y2:{ position:'right', min:0, grid:{display:false}, ticks:{color:muted, maxTicksLimit:3}, title:{display:true, text:'km', color:muted},
            afterFit: ax => { if(chart && chart.scales.yN) ax.width = chart.scales.yN.width; } } } }
  });
  const S = C.shift;
  const warnHtml = C.warn ? `<span style="display:block; margin-bottom:3px; padding:4px 8px; border-left:3px solid #b45309; background:rgba(180,83,9,.08); color:var(--ink-1);"><b>Warning: where the wells are changes.</b> Around ${S.from}–${S.to} the wells measured sit about ${S.km.toFixed(0)} km from the centre of all the wells (the wells are spread about ${S.rad.toFixed(0)} km around it), and those wells' own long-term trends differ from the rest by about ${Math.abs(S.dslope).toFixed(1)} ft/yr (typical well: ${S.sAll >= 0 ? '+' : ''}${S.sAll.toFixed(2)} ft/yr, + = rising). Matched wells cannot correct for this; use the Area units method, or split the area (Group by, HUC-10, or a smaller selection), and read those years with caution.</span>` : '';
  cap.innerHTML = warnHtml + escHtml(`Composition check: how the wells measured each year differ from the whole set. If the composite moves together with these lines, part of that change may come from which wells were measured, not from the water. ` +
    (mx ? `The typical ${dep ? 'depth to water' : 'water elevation'} of the measured wells swings by up to ${mx.toFixed(0)} ft from year to year; ` : '') +
    (state.otp.method === 'fe' ? 'the matched-wells composite already removes each well\'s own level, so these swings do not enter it.' : 'switch to matched wells to remove each well\'s own level from the composite.')) + (C.warn ? '' : ' <a id="comp-toggle">Hide ▴</a>');
  { const t = document.getElementById('comp-toggle'); if(t) t.onclick = () => { state.compOpen = false; renderCompStrip(window._compLast); }; }
}

// ---- coverage: share of the area (HUC-10s holding the composite's wells) with at least one well measured each year
let covChart = null, covWaiting = false;
function coverageOf(result){
  if(!result || !result.wells || !result.xvals) return null;
  if(!siteH10){ if(!covWaiting){ covWaiting = true; Promise.resolve(ensureSiteH10()).then(() => { covWaiting = false; if(siteH10 && window._lastComposite) try{ renderCovStrip(window._covResult); }catch(e){} }); } return {pending:true}; }
  const unitOf = new Map(); let total = 0;
  result.wells.forEach((w, k) => { const u = h10Of(w.site); if(u){ unitOf.set(k, u); } });
  const units = new Set(unitOf.values()); units.forEach(u => total += h10Area.get(u) || 0);
  if(!units.size || !total) return null;
  const pct = [], nu = [];
  result.xvals.forEach(y => {
    const seen = new Set();
    result.wells.forEach((w, k) => { const u = unitOf.get(k); if(u && !seen.has(u) && w.mapDisp && w.mapDisp.has(y)) seen.add(u); });
    let a = 0; seen.forEach(u => a += h10Area.get(u) || 0);
    pct.push(Math.round(1000 * a / total) / 10); nu.push(seen.size);
  });
  const noUnit = result.wells.length - unitOf.size;
  return {pct, nu, units: units.size, total, noUnit};
}
function renderCovStrip(result){
  const box = document.getElementById('cov-strip'), cap = document.getElementById('cov-caption');
  if(covChart){ covChart.destroy(); covChart = null; }
  window._lastCoverage = null;
  if(!result || !chart || state.showAllWells){ box.style.display = 'none'; cap.style.display = 'none'; return; }
  window._covResult = result;
  const C = coverageOf(result);
  if(!C){ box.style.display = 'none'; cap.style.display = 'none'; return; }
  cap.style.display = 'block';
  if(C.pending){ box.style.display = 'none'; cap.textContent = 'Area measured: loading HUC-10 boundaries…'; return; }
  window._lastCoverage = Object.assign({labels: result.labels}, C);
  box.style.display = 'block';
  const css = getComputedStyle(document.documentElement), muted = css.getPropertyValue('--muted').trim() || '#888', border = css.getPropertyValue('--border').trim() || '#ddd';
  const shown = result.labels.map((l, i) => result.medianSeries ? result.medianSeries[i] != null : true);
  const data = C.pct.map((p, i) => shown[i] ? p : null);
  covChart = new Chart(document.getElementById('cov-canvas').getContext('2d'), {
    type:'bar',
    data:{ labels: result.labels, datasets:[{label:'Area with a well measured (% of the HUC-10 area holding these wells)', data,
      backgroundColor: data.map(p => p == null ? 'rgba(0,0,0,0)' : p < 50 ? '#d97706' : '#7c93b5'), barPercentage:1, categoryPercentage:0.9}]},
    options:{ responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{ legend:{display:false},
        tooltip:{callbacks:{label: c => c.raw == null ? '' : `${c.raw.toFixed(0)}% of the area measured (${C.nu[c.dataIndex]} of ${C.units} HUC-10s)`}} },
      scales:{ x:{ display:false },
        y:{ min:0, max:100, grid:{color:border}, ticks:{color:muted, maxTicksLimit:3, callback: v => v + '%'}, title:{display:true, text:'area measured', color:muted, font:{size:10}},
            afterFit: ax => { if(chart && chart.scales.y) ax.width = chart.scales.y.width; } },
        y2:{ position:'right', min:0, max:100, grid:{display:false}, ticks:{display:false},
            afterFit: ax => { if(chart && chart.scales.yN) ax.width = chart.scales.yN.width; } } } }
  });
  // years under 50%, as runs
  const yrs = result.xvals, low = []; let run = null;
  yrs.forEach((y, i) => { const p = data[i]; if(p != null && p < 50){ if(run && run[1] === yrs[i-1]) run[1] = y; else { run = [y, y]; low.push(run); } } });
  const nShown = data.filter(p => p != null).length, nLow = data.filter(p => p != null && p < 50).length;
  const runs = low.map(r => r[0] === r[1] ? String(r[0]) : r[0] + '–' + r[1]);
  cap.textContent = `Area measured: the bars show, for each year, how much of the area holding this composite's wells (${C.units} HUC-10 watershed${C.units === 1 ? '' : 's'}, ${Math.round(C.total).toLocaleString()} km²) has at least one of those wells measured. ` +
    (nLow ? `Under 50% (amber) in ${nLow} of ${nShown} plotted years: ${runs.slice(0, 4).join(', ')}${runs.length > 4 ? ', …' : ''}. In those years the composite describes the measured part of the area, not all of it.` : `At least 50% in every plotted year.`) +
    (C.noUnit ? ` ${C.noUnit} well(s) outside the HUC-10 boundaries are not counted.` : '') +
    ' HUC-10s with no qualifying well at all are not counted, so this cannot show parts of the area never measured.';
}
function compositeAxisTitle(){
  const m = state.otp.method;
  if(m === 'ns') return 'Composite normal score (SD units, up = more water)';
  if(m === 'z') return 'Composite z-score (SD units, up = more water)';
  return state.valueMode === 'elevation' ? 'Change in water-surface elevation since first year (ft, up = more water)' : 'Change in depth to water since first year (ft, deeper ↓)';
}
function renderChart(){
  try{ renderCompStrip(null); }catch(e){}
  try{ renderCovStrip(null); }catch(e){}
  const empty = document.getElementById('hydrograph-empty');
  const canvas = document.getElementById('hydrograph-canvas');
  const set = state.activeSet;
  updateAccSummaries(); // keeps the period slider + group summaries in sync even when no composite can be drawn
  try{ hxFiltersLabel(); hxShowAsSync(); hxUrlSync(); }catch(e){}
  if(document.body.dataset.screen === 'map'){ hxChartsDirty = true; hxSelBar(); return; }
  hxChartsDirty = false;
  if(state.showAllWells){ renderWellsView(set); return; }
  window._lastOverview = null;
  if(!(state.areaSelection || state.clickSelectedSites.size) && !state.statewideOk){
    // nothing picked yet: don't build a statewide composite on open (tens of thousands of wells)
    empty.style.display = 'flex'; canvas.style.display = 'none';
    empty.querySelector('b').textContent = 'Pick an area or wells to build a composite';
    empty.querySelector('span').textContent = 'Draw a polygon, choose a county, HUC-8, aquifer or study area, or click wells on the map (zoom in to see them). ' + (set && set.size ? 'Or build one from all ' + set.size.toLocaleString() + ' wells that pass your filters (slower).' : '');
    const btn = document.getElementById('btn-show-all-wells');
    if(btn){ btn.style.display = set && set.size ? 'inline-block' : 'none'; btn.textContent = 'Build statewide composite'; btn.dataset.statewide = '1'; }
    if(chart){ chart.destroy(); chart = null; }
    ['stat-nqual','stat-npoints','stat-meanchg','stat-medchg'].forEach(id=>{ const e = document.getElementById(id); e.textContent = '–'; e.title = ''; });
    window._lastComposite = null; window._lastGroups = null; window._lastSeasonOverlays = null;
    if(state.qualifyingSites.size || state.algoQualifyingSites.size){ state.qualifyingSites = new Set(); state.algoQualifyingSites = new Set(); restyleMarkers(); }
    const ex = document.getElementById('explain-text');
    if(ex) ex.textContent = 'Nothing is selected yet. Draw a polygon, pick an area from the Select Area tab, or click wells on the map (well points appear once you zoom in to about county scale or pick an area). The composite is built from the selected wells; a statewide composite of every well is available with the button in the chart, but it takes a few seconds.';
    return;
  }
  { const btn = document.getElementById('btn-show-all-wells'); if(btn) delete btn.dataset.statewide; }
  const result = computeComposite();
  const o = state.otp;

  document.getElementById('drawer-sub').textContent = set && set.size ? `— ${set.size.toLocaleString()} well(s) selected` : '— select wells to build one';

  const clearStats = ()=>{
    ['stat-nqual','stat-npoints','stat-meanchg','stat-medchg'].forEach(id=>{ const e = document.getElementById(id); e.textContent='–'; e.title=''; });
  };

  if(!result){
    empty.style.display = 'flex';
    canvas.style.display = 'none';
    const hasSelection = set && set.size > 0, d = otLastDiag;
    empty.querySelector('b').textContent = !hasSelection ? 'No wells selected yet' : (d && !d.ok ? 'No well has a long enough record' : 'Too few wells in any one year');
    empty.querySelector('span').textContent =
      !hasSelection ? "Draw a polygon, pick a county/HUC‑8, or click wells on the map, then the composite is built from every well with enough years of data."
      : (d && !d.ok)
        ? `None of the ${d.cand.toLocaleString()} selected wells has ${o.minYears}+ years of data spanning ${o.minSpan}+ years in the period shown. Lower "Min. years" / "Min. span" in Composite method, widen the period, or open the Wells view to see what exists.`
        : d ? `${d.ok.toLocaleString()} wells pass the record rules, but no year has ${o.minN} of them measured (the most in any year is ${d.maxN}). Lower "Min. wells per year" or select more wells.`
        : 'No composite could be built with the current settings.';
    { const b = document.getElementById('btn-show-all-wells'); if(b){ b.style.display = hasSelection ? 'inline-block' : 'none'; b.textContent = `Show the ${set ? set.size.toLocaleString() : 0} selected well(s) in the Wells view`; } }
    if(chart){ chart.destroy(); chart=null; }
    clearStats();
    window._lastComposite = null;
    document.getElementById('despike-removed-note').textContent = '';
    if(state.qualifyingSites.size || state.algoQualifyingSites.size){
      state.qualifyingSites = new Set(); state.algoQualifyingSites = new Set(); restyleMarkers();
    }
    updateExplainPanel(null, set);
    return;
  }

  state.algoQualifyingSites = new Set(result.algoQualifying);

  if(!result.qualifying.length){
    // Every well the algorithm would have used has been manually excluded.
    empty.style.display = 'flex';
    canvas.style.display = 'none';
    empty.querySelector('b').textContent = 'All matching wells excluded';
    empty.querySelector('span').textContent =
      `${result.algoQualifying.length} well(s) pass the composite rules but were manually excluded. Click one of their markers (still ringed on the map) and choose "Include in composite" to bring it back.`;
    if(chart){ chart.destroy(); chart=null; }
    clearStats();
    window._lastComposite = null;
    document.getElementById('despike-removed-note').textContent = '';
    state.qualifyingSites = new Set();
    restyleMarkers();
    updateExplainPanel(result, set, true);
    return;
  }

  empty.style.display = 'none';
  canvas.style.display = 'block';

  const {labels, xvals, qualifying, poolSize, perWell, meanSeries, medianSeries, minSeries, maxSeries, nSeries, despikeRemoved} = result;
  state.qualifyingSites = new Set(qualifying);
  if(state.chartHighlightSite!=null && !state.qualifyingSites.has(state.chartHighlightSite)){
    state.chartHighlightSite = null; // the previously-highlighted well dropped out of the composite
  }
  restyleMarkers();

  const border = getComputedStyle(document.body).getPropertyValue('--border').trim();
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
  const warn = getComputedStyle(document.body).getPropertyValue('--warn').trim();
  const muted = getComputedStyle(document.body).getPropertyValue('--muted').trim();
  const units = otUnits();
  const surf = getComputedStyle(document.body).getPropertyValue('--surface-1').trim() || '#ffffff';

  const datasets = [];
  const compareOn = state.seasonCompare.enabled && state.seasonCompare.keys.size > 0;
  const groupOn = state.group.mode !== 'off' && !compareOn;

  if(state.showBand && !compareOn && !groupOn && result.band && result.band.B){
    datasets.push({ label:'95% range of change since first year (upper)', data:maxSeries, borderWidth:0, pointRadius:0, backgroundColor:hexA(warn,0.14), fill:'+1', tension:0.15, order:9, spanGaps:false });
    datasets.push({ label:'95% range of change since first year (lower)', data:minSeries, borderWidth:0, pointRadius:0, backgroundColor:hexA(warn,0.14), fill:false, tension:0.15, order:9, spanGaps:false });
  }
  window._lastIqr = null;
  if(!compareOn && !groupOn) try{ datasets.push(...hxIqrDatasets(result, hexA)); }catch(e){ console.warn('iqr band', e); }

  const HIGHLIGHT_COLOR = '#e0455c';
  {
    const note = document.getElementById('spaghetti-note');
    if(note){
      const tooMany = state.showSpaghetti && !compareOn && perWell.length > SPAGHETTI_CAP();
      note.textContent = tooMany ? `${perWell.length.toLocaleString()} wells qualify — more than the ${SPAGHETTI_CAP()} line limit, so individual lines are hidden. Raise the limit or narrow the filters.` : '';
      note.style.display = tooMany ? 'block' : 'none';
    }
  }
  const crowded = perWell.length > 60;
  if(state.showSpaghetti && !compareOn && perWell.length <= SPAGHETTI_CAP()){
    const spaghettiPalette = ['#c1652f','#2f7fc1','#7a9c3f','#a26bc2','#c9a227','#6b7fd4','#c25d8f','#5a8f8c','#b5533c','#3f8f7a','#8a6bb0','#c98f3e'];
    const dashPatterns = [[], [5,3], [1,2], [7,2,1,2]];
    perWell.forEach((pw,idx)=>{
      const isHi = pw.site === state.chartHighlightSite;
      const color = spaghettiPalette[idx % spaghettiPalette.length];
      const dash = dashPatterns[Math.floor(idx/spaghettiPalette.length) % dashPatterns.length];
      datasets.push({
        label:'well_'+pw.site, data: pw.values,
        borderColor: isHi ? HIGHLIGHT_COLOR : hexA(color, crowded ? 0.4 : 0.6),
        borderWidth: isHi ? 3.2 : (crowded ? 0.9 : 1.4),
        borderDash: (isHi || crowded) ? [] : dash,
        pointRadius:0, spanGaps:true, tension:0.1, order: isHi ? 4 : 5
      });
    });
  }

  window._lastGroups = null;
  const gres = groupOn ? computeGroups(result) : null;
  if(groupOn && gres.groups.length){
    gres.groups.forEach(gp=>{
      datasets.push({ label: gp.label+' mean', data: gp.meanSeries, borderColor: gp.color, backgroundColor:'transparent',
        borderWidth:2.5, pointRadius:2.5, pointBackgroundColor:gp.color, tension:0.15, order:1, _show:true });
      datasets.push({ label: gp.label+' median', data: gp.medianSeries, borderColor: gp.color, backgroundColor:'transparent',
        borderWidth:1.6, borderDash:[5,3], pointRadius:2, pointStyle:'rectRot', pointBackgroundColor:gp.color, tension:0.15, order:2, _show:true });
    });
    window._lastGroups = gres.groups;
  }
  const groupsShown = groupOn && gres.groups.length > 0;
  {
    const info = document.getElementById('group-info');
    if(info){
      if(!groupOn) info.textContent = state.group.mode==='off' ? '' : 'Turn off "Compare seasons" to group wells.';
      else if(gres.cluster && gres.fail) info.textContent = `Not enough wells cover enough of the record to form ${state.group.n} clusters (each needs 3+ wells covering 60% of the years with ${o.minN}+ wells). Try fewer clusters, a larger area or a shorter period.`;
      else if(gres.cluster) info.textContent = `${gres.cl.members.length} of ${perWell.length} wells clustered over ${gres.cl.win[0]}–${gres.cl.win[gres.cl.win.length-1]} (wells must cover 60% of those years); ${gres.cl.interp} interior gap value(s) were interpolated for the clustering only, never for the plotted lines. Cluster labels give each cluster's median well trend (+ = rising). Per-well cluster numbers are in the per-well statistics CSV.`;
      else if(!gres.groups.length) info.textContent = 'None of the qualifying wells has a value for this depth measure.';
      else if(gres.categorical) info.textContent = (gres.total <= state.group.n ? `Showing all ${gres.total} ${GROUP_MODE_LABELS[state.group.mode]} categor${gres.total===1?'y':'ies'} among the qualifying wells.` : `Showing the ${state.group.n} largest of ${gres.total} ${GROUP_MODE_LABELS[state.group.mode]} categories among the qualifying wells; the rest are combined as "All other".`) + (['extent','studyarea'].includes(state.group.mode) ? ' Wells in overlapping areas appear in each of their groups.' : '');
      else info.textContent = `Groups split at ${gres.breaks.map(b=>b.toLocaleString()).join(', ')} ft` + (state.group.breaks && state.group.breaks.length ? ' (your breakpoints).' : ' (evenly by well count among the qualifying wells).') + (gres.unknown ? ` ${gres.unknown} well(s) without this value are left out of the groups.` : '');
      if(groupOn && gres.groups.length) info.textContent += ` Each group needs ${o.minN}+ wells in a year to plot that year.`;
    }
  }
  if(groupsShown){
    // group lines replace the single overall median/mean
  } else if(compareOn){
    const overlays = computeSeasonalOverlays(result);
    overlays.forEach(ov=>{
      datasets.push({ label: ov.label+' mean', data: ov.meanSeries, borderColor: ov.color, backgroundColor:'transparent',
        borderWidth:2.5, pointRadius:2.5, pointBackgroundColor:ov.color, tension:0.15, order:1, _show:true });
      datasets.push({ label: ov.label+' median', data: ov.medianSeries, borderColor: ov.color, backgroundColor:'transparent',
        borderWidth:1.6, borderDash:[5,3], pointRadius:2, pointStyle:'rectRot', pointBackgroundColor:ov.color, tension:0.15, order:2, _show:true });
    });
    window._lastSeasonOverlays = overlays;
  } else {
    datasets.push({
      label:'Mean', data: meanSeries, borderColor: accent, backgroundColor:hexA(accent,0.12),
      borderWidth:2.5, pointRadius: nSeries.map(v=> v < OT_THIN ? 4 : 2.5), pointBorderWidth: nSeries.map(v=> v < OT_THIN ? 2 : 1), pointBackgroundColor: nSeries.map(v=> v < OT_THIN ? surf : accent), tension:0.15, order:1, _show:true, spanGaps:false
    });
    datasets.push({
      label:'Median', data: medianSeries, borderColor: warn, backgroundColor:'transparent',
      borderWidth:2, borderDash:[5,3], pointRadius: nSeries.map(v=> v < OT_THIN ? 4 : 2.5), pointBorderWidth: nSeries.map(v=> v < OT_THIN ? 2 : 1), pointStyle:'rectRot', pointBackgroundColor: nSeries.map(v=> v < OT_THIN ? surf : warn), tension:0.15, order:2, _show:true, spanGaps:false
    });
    window._lastSeasonOverlays = null;
  }
  if(groupsShown) window._lastSeasonOverlays = null;
  // ---- overlays: precomputed kriged average and/or a user reference hydrograph (chain-linked feet only) ----
  window._lastRef = null; window._lastKrig = null;
  const overlaysR = [];
  if(state.krig && state.krigShow) overlaysR.push({R: state.krig, color: '#2a9d8f', status: 'krig-status', slot: '_lastKrig', alignYear: state.krig.base});
  if(state.ref) overlaysR.push({R: state.ref, color: '#6250d6', status: 'ref-status', slot: '_lastRef'});
  if(overlaysR.length && !groupsShown && !compareOn){
    for(const ov of overlaysR){
      const st = document.getElementById(ov.status), R = ov.R;
      if(!otFeet(o.method)){ if(st && ov.slot === '_lastRef') st.textContent = `${R.name} is loaded; switch the composite to matched wells or area units to see it.`; continue; }
      const sign = state.valueMode === 'elevation' ? 1 : -1;   // depth mode plots change in depth to water
      const byY = new Map(R.rows.map(r=>[r.year, r]));
      let k0 = -1;
      if(ov.alignYear != null){ const i = xvals.indexOf(ov.alignYear); if(i >= 0 && medianSeries[i] != null) k0 = i; }
      if(k0 < 0) for(let i=0;i<xvals.length;i++){ if(medianSeries[i] != null && byY.has(xvals[i])){ k0 = i; break; } }
      if(k0 < 0){ if(st && ov.slot === '_lastRef') st.textContent = `${R.name} has no year in common with the composite.`; continue; }
      const off = medianSeries[k0] - sign * byY.get(xvals[k0]).chg;
      const val = xvals.map(y=> byY.has(y) ? off + sign*byY.get(y).chg : null);
      const se = xvals.map(y=> byY.has(y) && byY.get(y).se != null ? byY.get(y).se : null);
      const hasSe = se.some(v=>v != null);
      if(hasSe){
        datasets.push({ label:ov.slot+'_hi', data: val.map((v,i)=> v==null || se[i]==null ? null : v + 1.96*se[i]), borderWidth:0, pointRadius:0, backgroundColor:hexA(ov.color,0.13), fill:'+1', tension:0.15, order:8, spanGaps:true });
        datasets.push({ label:ov.slot+'_lo', data: val.map((v,i)=> v==null || se[i]==null ? null : v - 1.96*se[i]), borderWidth:0, pointRadius:0, backgroundColor:hexA(ov.color,0.13), fill:false, tension:0.15, order:8, spanGaps:true });
      }
      datasets.push({ label: R.name, data: val, borderColor: ov.color, backgroundColor: ov.color, borderWidth:2, pointRadius:1.5, tension:0.15, order:3, _show:true, _ref:true, _se:se, spanGaps:true });
      window[ov.slot] = {name: R.name, val, se, alignedAt: xvals[k0]};
      if(st && ov.slot === '_lastRef') st.textContent = `${R.name}: ${R.rows.length} years, aligned to the composite in ${xvals[k0]}` + (hasSe ? ', with its 95% range.' : '.');
    }
  }
  // wells per year (per step for chain-linked), on a hidden right-hand axis along the bottom of the chart
  const maxN = Math.max(1, ...nSeries);
  datasets.push({ type:'bar', label: o.method === 'chain' ? 'Wells in step' : 'Wells in year', data: nSeries, yAxisID:'yN',
    backgroundColor: nSeries.map(v=> v >= o.minN ? hexA(muted, 0.22) : 'rgba(224,69,92,.25)'), borderWidth:0, barPercentage:0.9, categoryPercentage:1, order:20, _show:true, _nbar:true });

  if(chart) chart.destroy();
  chart = new Chart(canvas.getContext('2d'), {
    type:'line',
    data:{labels, datasets},
    options:{
      responsive:true, maintainAspectRatio:false, animation:{duration:250},
      interaction:{mode:'index', intersect:false},
      onClick: (evt, elements, c) => {
        const pts = c.getElementsAtEventForMode(evt, 'nearest', {intersect:false}, true);
        if(!pts.length) return;
        const ds = c.data.datasets[pts[0].datasetIndex];
        if(!ds.label || !ds.label.startsWith('well_')) return;
        handleChartWellClick(parseInt(ds.label.slice(5), 10));
      },
      plugins:{
        legend:{
          display:true, position:'top', align:'end',
          labels:{
            color: getComputedStyle(document.body).getPropertyValue('--ink-2').trim(), boxWidth:16, font:{size:11},
            filter: (item, data) => !!(data.datasets[item.datasetIndex] && data.datasets[item.datasetIndex]._show)
          }
        },
        tooltip:{
          filter: item => !!(item.dataset && item.dataset._show),
          callbacks:{
            title: items => items[0].label,
            label: item => item.dataset._nbar
              ? `${item.dataset.label}: ${item.raw}${item.raw < o.minN ? ' (below the minimum of ' + o.minN + ', year left empty)' : ''}`
              : `${item.dataset.label}: ${item.raw==null ? 'n/a' : item.raw.toFixed(units === 'SD' ? 3 : 2)+' '+units}`,
            afterLabel: item => {
              const lab = item.dataset.label, i = item.dataIndex, extra = [];
              if((lab === 'Mean' || lab === 'Median') && nSeries[i] < OT_THIN) extra.push('only ' + nSeries[i] + ' wells: treat this year with caution');
              if(lab === 'Mean' && result.anchorSeries && result.anchorSeries[i] != null) extra.push('step measured from ' + result.anchorSeries[i] + ' (wells measured in both years)');
              if(lab === 'Ref' || item.dataset._ref){ const rr = item.dataset._se && item.dataset._se[i]; return rr ? '95% range \u00b1' + (1.96*rr).toFixed(1) + ' ft' : ''; }
              if(lab === 'Median' && window._lastIqr && window._lastIqr.lo[i] != null) extra.push(`middle half of the ${window._lastIqr.n[i]} wells: ${window._lastIqr.lo[i].toFixed(units === 'SD' ? 2 : 1)} to ${window._lastIqr.hi[i].toFixed(units === 'SD' ? 2 : 1)} ${units}`);
              if(lab !== 'Median' || !result.band || !result.band.B) return extra.join('\n');
              const lo = minSeries[item.dataIndex], hi = maxSeries[item.dataIndex];
              return (lo == null ? '' : `95% range of the change since ${xvals[0]}: ${lo.toFixed(units === 'SD' ? 2 : 1)} to ${hi.toFixed(units === 'SD' ? 2 : 1)} ${units}`) + (extra.length ? '\n' + extra.join('\n') : '');
            }
          }
        },
        gapBreak:{ xvals, markColor: muted, bandColor: hexA(muted, 0.08) }
      },
      scales:{
        x:{ grid:{color:border}, ticks:{color:muted, maxRotation:0}, title:{display:true, text: state.waterYear ? 'Water year' : 'Year', color:muted} },
        y:{
          reverse: otFeet(o.method) && state.valueMode === 'depth',  // standardized values already point up = more water
          grid:{color:border}, ticks:{color:muted},
          title:{display:true, text: wrapAxisTitle(compositeAxisTitle(), canvas.clientHeight - 60), color:muted}
        },
        yN:{ position:'right', display:true, min:0, max:maxN*3, grid:{display:false},
             afterBuildTicks: ax => { const st = [1,2,5,10,20,25,50,100,200,250,500,1000,2000,2500,5000,10000].find(v => maxN / v <= 4) || Math.ceil(maxN/4);
               const t = []; for(let v=0; v<=maxN; v+=st) t.push({value:v}); ax.ticks = t; },
             ticks:{color:muted, precision:0},
             title:{display:true, text: o.method === 'chain' ? 'Wells linking each year (grey bars)' : 'Wells per year (grey bars)', color:muted, align:'start'} }
      }
    }
  });

  const excludedCount = state.algoQualifyingSites.size - qualifying.length;
  document.getElementById('stat-nqual').textContent = qualifying.length.toLocaleString()+' / '+poolSize.toLocaleString()
    + (excludedCount > 0 ? ` (${excludedCount} excluded)` : '');
  document.getElementById('stat-npoints').textContent = medianSeries.filter(v=>v!=null).length;
  const dec = units === 'SD' ? 2 : 1;
  const fmtChg = (a,b)=>{
    if(a==null||b==null) return '–';
    const d = b-a;
    return (d>=0?'+':'')+d.toFixed(dec)+' '+units;
  };
  const firstLast = arr=>[arr.find(v=>v!=null), [...arr].reverse().find(v=>v!=null)];
  const tEl = document.getElementById('stat-meanchg'), mEl = document.getElementById('stat-medchg');
  const ct = result.compTrend;
  tEl.textContent = ct ? (ct.slope>=0?'+':'') + ct.slope.toFixed(units === 'SD' ? 3 : 2) + ' ' + units : '–';
  tEl.title = ct ? `Theil–Sen slope of the composite median of all qualifying wells over ${ct.n} years (Mann–Kendall p = ${ct.p.toFixed(3)})` : 'Needs 4+ plotted years';
  if(groupsShown && window._lastGroups){
    mEl.textContent = window._lastGroups.map(gp=>{ const [f,l] = firstLast(gp.medianSeries); return gp.label.split(' (')[0]+' '+fmtChg(f,l); }).join(' · ');
    mEl.title = 'Median change, first to last plotted year, per group';
  } else if(compareOn && window._lastSeasonOverlays){
    mEl.textContent = window._lastSeasonOverlays.map(ov=>{ const [f,l] = firstLast(ov.medianSeries); return ov.label.slice(0,3)+' '+fmtChg(f,l); }).join(' · ');
    mEl.title = 'Median change, first to last plotted year, per season';
  } else {
    const [f,l] = firstLast(medianSeries);
    mEl.textContent = fmtChg(f,l); mEl.title = 'Composite median, last plotted year minus first';
  }

  window._lastComposite = {labels, xvals, meanSeries, medianSeries, minSeries, maxSeries, nSeries, anchorSeries: result.anchorSeries, band: result.band, qualifying, poolSize, perWell, wells: result.wells, ids: qualifying.map(s=>SITES[s][0]), method: o.method, compTrend: result.compTrend, prov: null};
  try{ renderCompStrip(result); }catch(e){ console.warn('strip', e); }
  try{ renderCovStrip(result); }catch(e){ console.warn('coverage', e); }
  try{ ocoMaybe(); }catch(e){ console.warn('oco', e); }
  document.getElementById('despike-removed-note').textContent = state.despike.enabled
    ? (despikeRemoved > 0 ? `${despikeRemoved} likely bad reading(s) removed from wells in this composite.` : 'No likely bad readings found in this composite.')
    : '';
  updateExplainPanel(result, set, false);
  updateAccSummaries();
}
// Chart.js draws an axis title on ONE line unless it gets an array; a long title on a short axis is
// clipped at both ends. Break the text into lines that fit the axis length (px) so it always wraps.
function wrapAxisTitle(text, axisPx){
  const maxChars = Math.max(14, Math.floor((axisPx || 300) / 6.6) - 2);
  if(String(text).length <= maxChars) return text;
  const lines = []; let cur = '';
  String(text).split(/\s+/).forEach(w=>{
    if(cur && (cur + ' ' + w).length > maxChars){ lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  });
  if(cur) lines.push(cur);
  return lines;
}
function yAxisTitle(){
  if(useUsgsNorm()) return 'Normalized water level (% of each well\'s range; up = higher water)';
  if(state.valueMode === 'elevation'){
    return state.normalize ? (state.normalizeStyle === 'first' ? 'Elevation change since first reading (ft, up = more water)' : 'Water-surface elevation anomaly (ft)') : 'Water-surface elevation (ft, higher ↑ = more water)';
  }
  return state.normalize ? (state.normalizeStyle === 'first' ? 'Depth change since first reading (ft, deeper ↓)' : 'Depth-to-water anomaly (ft, deeper ↓)') : 'Depth-to-water (ft below ground, deeper ↓)';
}
function hexA(hex, a){
  hex = hex.replace('#','').trim();
  if(hex.length===3) hex = hex.split('').map(c=>c+c).join('');
  const r=parseInt(hex.slice(0,2),16), g=parseInt(hex.slice(2,4),16), b=parseInt(hex.slice(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}


/* -------------------------------------------------------------------- */
/* 15. Export CSV                                                        */
/* -------------------------------------------------------------------- */
function ocoPrivateName(f){ try{ return (typeof oco !== 'undefined' && oco.key && oco.fetched && oco.fetched.size) ? 'PRIVATE_' + f : f; }catch(e){ return f; } }
function downloadCsv(filename, rows){ filename = ocoPrivateName(filename);
  const csv = rows.map(r => r.map(v=>{
    if(v==null) return '';
    let s = String(v);
    if(typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d/.test(s)) s = "'" + s;   // spreadsheet formula injection guard
    return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
document.getElementById('btn-export-sites').addEventListener('click', ()=>{
  const set = state.activeSet;
  if(!set || !set.size){ toast('No wells selected.'); return; }
  const rows = [['site_id','longitude','latitude','source','aquifer_extent','study_areas','aquifer_usgs_broad','formation','elevation_ft','well_depth_ft','n_readings','first_year','last_year','min_depth_to_water_ft','max_depth_to_water_ft','mean_depth_to_water_ft','usgs_site_id']];
  set.forEach(s=>{
    const r = SITES[s];
    const aquifer = r[12]>=0 ? AQUIFERS[r[12]] : '';
    const formation = r[13]>=0 ? FORMATIONS[r[13]] : '';
    const aquiferExtent = r[15].map(i=>AQUIFER_EXTENT_NAMES[i]).join('; ');
    const studyAreas = (r[16]&&r[16].length) ? r[16].map(i=>STUDY_AREA_NAMES[i]).join('; ') : '';
    rows.push([r[0], r[1], r[2], r[3]>=0?SOURCES[r[3]]:'', aquiferExtent, studyAreas, aquifer, formation, r[14], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]]);
  });
  downloadCsv('nm_groundwater_selected_wells.csv', rows);
  toast('Exported '+set.size+' wells.');
});
document.getElementById('btn-toggle-explain').addEventListener('click', ()=>{
  const panel = document.getElementById('explain-panel');
  const nowHidden = panel.classList.toggle('hidden');
  document.getElementById('btn-toggle-explain').classList.toggle('active', !nowHidden);
});
document.getElementById('explain-close').addEventListener('click', ()=>{
  document.getElementById('explain-panel').classList.add('hidden');
  document.getElementById('btn-toggle-explain').classList.remove('active');
});
document.getElementById('btn-toggle-explain').classList.add('active'); // panel starts visible

function setShowAllWells(on){ setView(on ? 'wells' : 'composite'); }
document.getElementById('toggle-allwells').addEventListener('change', e=>setShowAllWells(e.target.checked));
document.getElementById('btn-show-all-wells').addEventListener('click', e=>{
  if(e.currentTarget.dataset.statewide){ state.statewideOk = true; renderChart(); return; }
  setShowAllWells(true);
});
document.getElementById('btn-export-raw').addEventListener('click', ()=>{
  const set = state.showAllWells ? wvDownloadSet() : [...state.qualifyingSites];
  if(state.showAllWells && !set.length){ toast('Select an area or wells first.'); return; }
  downloadRawData(set, state.showAllWells ? 'selected_wells' : 'composite_wells');
});
document.getElementById('btn-export-hydrograph').addEventListener('click', ()=>{
  if(window._lastOverview){ downloadCsv(wvCsvName(), wvCsvRows()); return; }
  const c = window._lastComposite;
  if(!c){ toast('No composite hydrograph to export yet.'); return; }
  const overlays = window._lastSeasonOverlays || window._lastGroups;
  const u = otFeet(c.method) ? 'ft' : 'sd';
  const f = v => v==null ? '' : v.toFixed(4);
  if(overlays && overlays.length){
    const header = ['year'];
    overlays.forEach(ov=>{ header.push(ov.label+'_median_'+u, ov.label+'_mean_'+u); });
    header.push('method','n_wells_qualifying');
    const rows = [header];
    c.labels.forEach((label,i)=>{
      const row = [label];
      overlays.forEach(ov=>{ row.push(f(ov.medianSeries[i]), f(ov.meanSeries[i])); });
      row.push(c.method, c.qualifying.length);
      rows.push(row);
    });
    downloadCsv('nm_composite_hydrograph_groups.csv', rows);
  } else {
    const header = ['year','median_'+u,'mean_'+u,'boot95_lo_'+u,'boot95_hi_'+u, c.method === 'chain' ? 'n_wells_in_step' : 'n_wells_in_year','n_wells_qualifying','method'];
    const R = window._lastRef; if(R) header.push('reference_' + R.name.replace(/[^A-Za-z0-9]+/g,'_') + '_ft', 'reference_se_ft');
    const KR = window._lastKrig; if(KR) header.push('basin_average_kriged_ft', 'basin_average_kriged_se_ft');
    if(c.method === 'chain') header.push('step_from_year');
    const CV = window._lastCoverage && window._lastCoverage.labels.join() === c.labels.join() ? window._lastCoverage : null; if(CV) header.push('area_measured_pct', 'huc10_measured', 'huc10_total');
    const includeWells = state.showSpaghetti && c.perWell && c.perWell.length;
    if(includeWells) c.perWell.forEach(pw => { const nm = nmbgmrIdOf(pw.site); header.push('well_'+SITES[pw.site][0] + ((nm && nm !== SITES[pw.site][0]) ? ' (NMBGMR '+nm+')' : '')); });
    const rows = [header];
    c.labels.forEach((label,i)=>{
      const row = [label, f(c.medianSeries[i]), f(c.meanSeries[i]), f(c.minSeries[i]), f(c.maxSeries[i]), c.nSeries[i], c.qualifying.length, c.method];
      if(R) row.push(f(R.val[i]), f(R.se[i]));
      if(KR) row.push(f(KR.val[i]), f(KR.se[i]));
      if(c.method === 'chain') row.push(c.anchorSeries && c.anchorSeries[i] != null ? c.anchorSeries[i] : '');
      if(CV) row.push(CV.pct[i], CV.nu[i], CV.units);
      if(includeWells) c.perWell.forEach(pw => row.push(f(pw.values[i])));
      rows.push(row);
    });
    downloadCsv('nm_composite_hydrograph.csv', rows);
  }
  toast('Exported composite hydrograph ('+c.qualifying.length+' qualifying wells'+(state.showSpaghetti && c.perWell && c.perWell.length ? ', with individual well columns' : '')+').');
});

/* -------------------------------------------------------------------- */
/* 16. Help                                                               */
/* -------------------------------------------------------------------- */
document.getElementById('help-toggle').addEventListener('click', ()=> document.getElementById('help-modal').classList.remove('hidden'));
document.getElementById('help-close').addEventListener('click', ()=> document.getElementById('help-modal').classList.add('hidden'));
document.getElementById('help-modal').addEventListener('click', e => { if(e.target.id === 'help-modal') e.target.classList.add('hidden'); });
document.addEventListener('keydown', e => { if(e.key === 'Escape') document.getElementById('help-modal').classList.add('hidden'); });
document.querySelectorAll('#help-toc a, #help-body a[href^="#h-"]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); const t = document.querySelector(a.getAttribute('href')); if(t) t.scrollIntoView({behavior:'smooth', block:'start'}); }));

/* -------------------------------------------------------------------- */
/* 17. Init                                                               */
/* -------------------------------------------------------------------- */
document.querySelectorAll('[data-stat]').forEach(el=>{ el.textContent = COVERAGE[el.dataset.stat]; });
document.getElementById('wellcount-pill').innerHTML = `<b>${NSITES.toLocaleString()}</b>&nbsp;wells loaded`;
recomputeTrendAndMean();
recomputeAllDespikeFlags();
buildMarkers();
recomputeActiveSet();
renderLegend();


/* Collapsible control groups + one-line summaries of what each group currently has set */
document.querySelectorAll('.acc-head').forEach(btn=>{
  btn.addEventListener('click', ()=> btn.parentElement.classList.toggle('open'));
});
const YR_MIN_ALL = Math.min(...SITES.map(r=>r[6]).filter(v=>v!=null));
let YR_MIN = YR_MIN_ALL;   // follows the selection
const YR_MAX = CURRENT_YEAR;
function paintYearSlider(){
  const lo = document.getElementById('yr-lo'), hi = document.getElementById('yr-hi');
  const span = YR_MAX - YR_MIN || 1;
  const a = (+lo.value - YR_MIN)/span*100, b = (+hi.value - YR_MIN)/span*100;
  document.getElementById('yr-fill').style.cssText = 'left:'+a+'%; width:'+Math.max(0,b-a)+'%;';
  document.getElementById('yr-readout').textContent = lo.value + ' \u2013 ' + hi.value + ((+lo.value===YR_MIN && +hi.value===YR_MAX) ? '  (full record)' : '');
}
function syncYearSlider(){
  const lo = document.getElementById('yr-lo'), hi = document.getElementById('yr-hi');
  if(!lo) return;
  hxYearBounds();
  lo.min = hi.min = YR_MIN; lo.max = hi.max = YR_MAX;
  lo.value = state.yearWindow.min != null ? state.yearWindow.min : YR_MIN;
  hi.value = state.yearWindow.max != null ? state.yearWindow.max : YR_MAX;
  paintYearSlider();
}
['yr-lo','yr-hi'].forEach(id=>{
  const el = document.getElementById(id);
  el.addEventListener('input', ()=>{
    const lo = document.getElementById('yr-lo'), hi = document.getElementById('yr-hi');
    if(+lo.value > +hi.value){ if(id==='yr-lo') lo.value = hi.value; else hi.value = lo.value; }
    paintYearSlider();
  });
  el.addEventListener('change', ()=>{
    const lo = +document.getElementById('yr-lo').value, hi = +document.getElementById('yr-hi').value;
    state.yearWindow.min = lo <= YR_MIN ? null : lo;
    state.yearWindow.max = hi >= YR_MAX ? null : hi;
    document.getElementById('yw-min').value = state.yearWindow.min != null ? state.yearWindow.min : '';
    document.getElementById('yw-max').value = state.yearWindow.max != null ? state.yearWindow.max : '';
    onYearWindowChange();
  });
});
function updateAccSummaries(){
  try{ syncYearSlider(); }catch(e){ /* slider constants not defined yet during the very first render */ }
  const set = (k,t)=>{ const el=document.getElementById('sum-'+k); if(el){ el.textContent=t; el.title=t; } };
  set('schedule', {units:'area units', fe:'matched wells', ns:'normal score', z:'z-score', chain:'chain-linked ft'}[state.otp.method] + (state.otp.cellKm ? ' \u00b7 ' + state.otp.cellKm + ' km cells' : '') + (state.otp.fixed ? ' \u00b7 fixed set ' + state.otp.fixed + '%' : '') + ' \u00b7 \u2265' + state.otp.minN + ' wells/yr \u00b7 \u2265' + state.otp.minYears + ' yrs, ' + state.otp.minSpan + '-yr span');
  const w=state.yearWindow;
  const wp=[];
  if(w.min!=null||w.max!=null) wp.push((w.min!=null?w.min:'start')+'\u2013'+(w.max!=null?w.max:'now'));
  if(state.waterYear) wp.push('water yrs');
  set('window', wp.length ? wp.join(' \u00b7 ') : 'full record');
  set('quality', state.despike.enabled ? ({0.25:'strict',0.4:'moderate',0.6:'lenient'}[state.despike.threshold]||'on')+' removal' : 'removal off');
  const sp=[];
  if(state.group.mode!=='off') sp.push(GROUP_MODE_LABELS[state.group.mode]+' groups');
  if(state.seasonCompare.enabled) sp.push('comparing seasons'); else if(!seasonIsFullYear()) sp.push('season '+state.season.monthStart+'\u2013'+state.season.monthEnd);
  set('split', sp.length ? sp.join(' \u00b7 ') : 'none');
  const dp=[state.valueMode==='elevation'?'elevation':'depth'];
  if(state.normalize) dp.push(state.normalizeStyle==='usgs'?'USGS norm.':'normalized');
  if(state.showSpaghetti) dp.push('well lines');
  if(state.showBand) dp.push('95% band');
  set('display', dp.join(' \u00b7 '));
}


/* -------------------------------------------------------------------- */
/* 12. Single-well hydrograph + export (CSV / GeoJSON / PNG)             */
/* -------------------------------------------------------------------- */
const singleWell = { site:null, chart:null, flag:true, mode:'depth', method:'weighted' };
// Raw monthly readings of one well, optionally with likely-bad months flagged, plus yearly means
// (reading-weighted, flagged months left out). Pure function of the data -> easy to test.
function singleWellData(s, flag, method){
  method = method || 'weighted'; // yearly line: weighted = reading-weighted mean | mean = mean of monthly values | median = median of monthly values
  const months = siteMonthMap.get(s) || [];
  const flags = new Set(flag ? monthFlagDetails(s).map(f=>monthKey(f.pt)) : []);
  const elev = hasElevation(s) ? siteElevation[s] : null;
  const rows = months.map(p=>({
    year:p.year, month:p.month, t:p.year + (p.month-0.5)/12, depth:p.avg,
    elev: elev==null ? null : elev - p.avg, n:p.n, flagged:flags.has(monthKey(p))
  }));
  const by = new Map();
  rows.forEach(r=>{ if(r.flagged) return; const a = by.get(r.year) || {sum:0,n:0,vals:[]}; a.sum += r.depth*r.n; a.n += r.n; a.vals.push(r.depth); by.set(r.year,a); });
  const yearly = [...by.entries()].sort((a,b)=>a[0]-b[0]).map(([year,a])=>{
    const depth = method==='median' ? median(a.vals) : (method==='mean' ? a.vals.reduce((x,y)=>x+y,0)/a.vals.length : a.sum/a.n);
    return {year, depth, elev: elev==null ? null : elev-depth, n:a.n, months:a.vals.length};
  });
  return {rows, yearly, flagged: rows.filter(r=>r.flagged).length, elev};
}
function src_isNmbgmr(s){ const r = SITES[s]; return r[3]>=0 && SOURCES[r[3]] === 'NMBGMR'; }
// 'BC-0008' for a well NMBGMR also measures (or that is NMBGMR's own), else null
function nmbgmrIdOf(s){ return nmbgmrOfOther.has(s) ? nmbgmrOfOther.get(s).id : (src_isNmbgmr(s) ? SITES[s][0] : null); }
function wellMeta(s){
  const rec = SITES[s];
  const ext = (rec[15] && rec[15].length) ? rec[15].map(i=>AQUIFER_EXTENT_NAMES[i].replace(/_/g,' ')).join('; ') : null;
  return {
    well_id: rec[0], source: rec[3]>=0 ? SOURCES[rec[3]] : null, longitude: rec[1], latitude: rec[2],
    land_surface_elevation_ft: hasElevation(s) ? siteElevation[s] : null, well_depth_ft: rec[4],
    aquifer_extent: ext, aquifer_usgs: rec[12]>=0 ? AQUIFERS[rec[12]] : null, formation: rec[13]>=0 ? FORMATIONS[rec[13]] : null,
    usgs_site: rec[11] || null,
    nmbgmr_site_id: nmbgmrOfOther.has(s) ? nmbgmrOfOther.get(s).id : (src_isNmbgmr(s) ? rec[0] : null),
    nmbgmr_alternate_id: nmbgmrOfOther.has(s) ? (nmbgmrOfOther.get(s).alt || null) : null
  };
}
const MON_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// Decimal year -> date label. x for a monthly reading is year+(month-0.5)/12, so flooring gives the month back.
function decYearToLabel(v){
  const y = Math.floor(v + 1e-9), mi = Math.min(11, Math.max(0, Math.floor((v - y)*12 + 1e-9)));
  return MON_ABBR[mi] + ' ' + y;
}
const r2 = v => v==null ? null : Math.round(v*100)/100;
function singleWellCsvRows(s, flag, method){
  const d = singleWellData(s, flag, method), m = wellMeta(s);
  const yr = new Map(d.yearly.map(y=>[y.year,y]));
  const rows = [['well_id','nmbgmr_site_id','source','longitude','latitude','land_surface_elev_ft','year','month','date','depth_to_water_ft','water_surface_elev_ft','n_readings','flagged_bad_reading','yearly_value_depth_ft','yearly_value_elev_ft','yearly_method']];
  d.rows.forEach(r=>{
    const y = yr.get(r.year);
    rows.push([m.well_id, m.nmbgmr_site_id||'', m.source, m.longitude, m.latitude, m.land_surface_elevation_ft==null?'':r2(m.land_surface_elevation_ft),
      r.year, r.month, r.year+'-'+String(r.month).padStart(2,'0'), r2(r.depth), r.elev==null?'':r2(r.elev), r.n, r.flagged?1:0,
      y?r2(y.depth):'', (y && y.elev!=null)?r2(y.elev):'', method||'weighted']);
  });
  return rows;
}
function singleWellGeoJSON(s, flag, method){
  const d = singleWellData(s, flag, method), m = wellMeta(s);
  return {type:'FeatureCollection', features:[{
    type:'Feature', geometry:{type:'Point', coordinates:[m.longitude, m.latitude]},
    properties:{...m,
      bad_reading_filter: !!flag, yearly_method: method||'weighted', n_months_with_data: d.rows.length, n_flagged: d.flagged,
      first_year: d.rows.length ? d.rows[0].year : null, last_year: d.rows.length ? d.rows[d.rows.length-1].year : null,
      trend_ft_per_yr_depth: isNaN(siteTrend[s]) ? null : r2(siteTrend[s]),
      depth_units:'feet below land surface', elevation_units:'feet above datum of land-surface elevation',
      monthly_readings: d.rows.map(r=>({year:r.year, month:r.month, depth_to_water_ft:r2(r.depth), water_surface_elev_ft:r2(r.elev), n_readings:r.n, flagged:r.flagged})),
      yearly_values: d.yearly.map(y=>({year:y.year, depth_to_water_ft:r2(y.depth), water_surface_elev_ft:r2(y.elev), n_readings:y.n}))
    }}]};
}
function downloadBlob(filename, blob){ filename = ocoPrivateName(filename);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

/* -------------------------------------------------------------------- */
/* Raw data download. Readings come live from the API; sites.csv / summary.csv rows come from a small static file next to the page */
/* -------------------------------------------------------------------- */
const RAW_FILE = 'nm-site-metadata.json';
let _rawMeta = null;      // {R, sitesLines, summaryLines} or false when unavailable
function rawInflate(b64){ return window.pako.inflate(b64ToBytes(b64), {to:'string'}); }
async function rawEnsureLoaded(){
  if(_rawMeta !== null) return _rawMeta;
  try{
    const resp = await fetch(RAW_FILE); if(!resp.ok) throw new Error('HTTP '+resp.status);
    _rawMeta = {R: await resp.json(), sitesLines:null, summaryLines:null};
  }catch(e){ _rawMeta = false; }
  return _rawMeta;
}
// first two CSV fields (source,id) of a line, honouring quotes
function csvFirstTwo(line){
  const out = []; let i = 0, cur = '', q = false;
  for(; i<line.length && out.length<2; i++){
    const c = line[i];
    if(q){ if(c === '"'){ if(line[i+1] === '"'){ cur += '"'; i++; } else q = false; } else cur += c; }
    else if(c === '"') q = true;
    else if(c === ','){ out.push(cur); cur = ''; }
    else cur += c;
  }
  if(out.length<2) out.push(cur);
  return out;
}
function rawWellKey(s){ const r = SITES[s]; return (r[3]>=0 ? SOURCES[r[3]] : '') + '\u0001' + r[0]; }
const RAW_SITE_COLS = ['name','latitude','longitude','elevation','elevation_units','horizontal_datum','vertical_datum','usgs_site_id','alternate_site_id','formation','aquifer','aquifer_extent','well_depth','well_depth_units'];
const RAW_SUM_COLS = ['nrecords','min','max','mean','earliest_date','earliest_time','earliest_value','earliest_units','latest_date','latest_time','latest_value','latest_units'];
// live site metadata + summary statistics for the wells being exported (nm_waterlevels_summary)
async function fetchRawSummary(siteIdxs){
  const out = new Map(); const wanted = new Map(); siteIdxs.forEach(s=>wanted.set(rawWellKey(s), s));
  const take = f=>{
    const p = f.properties || {}; const k = p.source + '\u0001' + p.id; if(!wanted.has(k)) return;
    const c = (f.geometry && f.geometry.coordinates) || [];
    const prev = out.get(k); if(prev && prev.props.parameter_name === API_DTW) return;
    out.set(k, {props:p, lon:c[0], lat:c[1], z:c[2]});
  };
  if(siteIdxs.length <= 40){
    await apiPool([...wanted.keys()].map(k=>async()=>{
      const rec = SITES[wanted.get(k)];
      try{ const j = await apiJson('/collections/nm_waterlevels_summary/items', {f:'json', source: rec[3]>=0 ? SOURCES[rec[3]] : '', id: rec[0], limit:20}); (j.features||[]).forEach(take); }catch(e){}
    }), 6);
  } else {
    const {features} = await apiFeatures('nm_waterlevels_summary', {}, null, {geometry:true});
    features.forEach(take);
  }
  return out;
}
function buildRawFiles(siteIdxs, ts, meta, sum){
  sum = sum || new Map();
  const crlf = '\r\n', wanted = new Set(siteIdxs.map(rawWellKey));
  // original site rows (vertical datum, formation, aquifer as supplied) when the small metadata file is next to the page
  const metaSite = new Map(), metaSum = new Map();
  if(meta){
    const load = (b64, key, header, dest)=>{
      if(!meta[key]) meta[key] = rawInflate(b64).split('\n');
      const hd = parseCsv(header.replace(/\r$/, ''))[0] || [];
      meta[key].forEach(l=>{ if(!l) return; const f = csvFirstTwo(l); const k = f[0] + '\u0001' + f[1]; if(!wanted.has(k)) return;
        const v = parseCsv(l.replace(/\r$/, ''))[0] || []; const o = {}; hd.forEach((c,i)=>o[c] = v[i]); dest.set(k, o); });
    };
    load(meta.R.sites, 'sitesLines', meta.R.sites_header, metaSite);
    load(meta.R.summary, 'summaryLines', meta.R.summary_header, metaSum);
  }
  const blank = v => v == null || v === '';
  const frag = new Map(); let nSum = 0, nMeta = 0;
  siteIdxs.forEach(s=>{
    const k = rawWellKey(s), rec = SITES[s], wm = wellMeta(s), A = sum.get(k), P = A ? A.props : {}, MS = metaSite.get(k) || {}, MM = metaSum.get(k) || {};
    if(A) nSum++; if(metaSite.has(k)) nMeta++;
    const pick = (...vals)=>{ for(const v of vals) if(!blank(v)) return v; return ''; };
    const site = {
      name: pick(P.name, MS.name, MM.name),
      latitude: pick(A && A.lat, MS.latitude, rec[2]), longitude: pick(A && A.lon, MS.longitude, rec[1]),
      elevation: pick(P.elevation, A && A.z, MS.elevation, wm.land_surface_elevation_ft), elevation_units: pick(P.elevation_units, MS.elevation_units, 'ft'),
      horizontal_datum: pick(P.horizontal_datum, MS.horizontal_datum), vertical_datum: pick(MS.vertical_datum),
      usgs_site_id: pick(P.usgs_site_id, MS.usgs_site_id, rec[11]), alternate_site_id: pick(P.alternate_site_id, MS.alternate_site_id),
      formation: pick(MS.formation, wm.formation), aquifer: pick(MS.aquifer, wm.aquifer_usgs), aquifer_extent: pick(wm.aquifer_extent),
      well_depth: pick(P.well_depth, MS.well_depth, rec[4]), well_depth_units: pick(P.well_depth_units, MS.well_depth_units, 'ft')
    };
    const st = {}; RAW_SUM_COLS.forEach(c=>{ st[c] = pick(P[c], MM[c]); });
    frag.set(k, ',' + RAW_SITE_COLS.map(c=>csvCell(site[c])).join(',') + ',' + RAW_SUM_COLS.map(c=>csvCell(st[c])).join(','));
  });
  const header = RAW_TS_HEADER.slice(0, 4).concat(['depth_to_water_ft'], RAW_TS_HEADER.slice(4), RAW_SITE_COLS, RAW_SUM_COLS.map(c=>'summary_' + c)).join(',') + crlf;
  const dtw2 = r => { const v = Number(r[3]); return r[2] === API_DTW && r[3] !== '' && isFinite(v) ? (Math.round(v * 100) / 100).toFixed(2) : ''; };
  const parts = [header]; let unmatched = 0;
  ts.rows.forEach(r=>{
    const k = r[0] + '\u0001' + r[1]; let f = frag.get(k); if(f == null){ f = ',' + new Array(RAW_SITE_COLS.length + RAW_SUM_COLS.length).fill('').join(','); unmatched++; }
    parts.push(r.slice(0, 4).concat([dtw2(r)], r.slice(4)).map(csvCell).join(',') + f + crlf);
  });
  const text = parts.join('');
  const counts = {wells: siteIdxs.length, timeseries: ts.rows.length, sites: nMeta, summary: nSum, unmatched};
  return {files:[{name:'water_levels_with_site_metadata.csv', text}], counts, text};
}
// Minimal "stored" ZIP writer (no compression), so no extra library is needed
const CRC_TABLE = (()=>{ const t = new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320 ^ (c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
function crc32(u8){ let c = 0xFFFFFFFF; for(let i=0;i<u8.length;i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c>>>8); return (c ^ 0xFFFFFFFF)>>>0; }
function makeZip(files){
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const d = new Date(), dosTime = (d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1), dosDate = ((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate();
  files.forEach(f=>{
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0,0x04034b50,true); lh.setUint16(4,20,true); lh.setUint16(6,0x0800,true); lh.setUint16(8,0,true);
    lh.setUint16(10,dosTime,true); lh.setUint16(12,dosDate,true); lh.setUint32(14,crc,true);
    lh.setUint32(18,data.length,true); lh.setUint32(22,data.length,true); lh.setUint16(26,name.length,true); lh.setUint16(28,0,true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0,0x02014b50,true); ch.setUint16(4,20,true); ch.setUint16(6,20,true); ch.setUint16(8,0x0800,true); ch.setUint16(10,0,true);
    ch.setUint16(12,dosTime,true); ch.setUint16(14,dosDate,true); ch.setUint32(16,crc,true);
    ch.setUint32(20,data.length,true); ch.setUint32(24,data.length,true); ch.setUint16(28,name.length,true);
    ch.setUint32(42,offset,true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  });
  const cdSize = central.reduce((a,b)=>a+(b.byteLength!=null?b.byteLength:b.length),0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0,0x06054b50,true); end.setUint16(8,files.length,true); end.setUint16(10,files.length,true);
  end.setUint32(12,cdSize,true); end.setUint32(16,offset,true);
  return new Blob([...parts, ...central, end.buffer], {type:'application/zip'});
}
function downloadRawData(siteIdxs, baseName){
  if(!siteIdxs.length){ toast('No wells to download — build a hydrograph first.'); return; }
  toast('Fetching readings and site metadata from the API for ' + siteIdxs.length + ' well(s)…');
  setTimeout(async ()=>{
    try{
      const [ts, sum, meta] = await Promise.all([
        fetchRawTimeseries(siteIdxs, (d,t)=> toast('Downloading from the API… ' + d + ' / ' + t + ' requests')),
        fetchRawSummary(siteIdxs).catch(e=>{ console.warn('summary fetch failed', e); return new Map(); }),
        rawEnsureLoaded()
      ]);
      const r = buildRawFiles(siteIdxs, ts, meta, sum);
      downloadBlob(baseName + '_water_levels_with_site_metadata.csv', new Blob([r.text], {type:'text/csv;charset=utf-8'}));
      toast(r.counts.timeseries.toLocaleString() + ' readings joined to site metadata for ' + r.counts.wells + ' well(s)' + (ts.failures.length ? ' (' + ts.failures.length + ' well(s) failed to download)' : '') + (r.counts.summary < r.counts.wells ? ' — ' + (r.counts.wells - r.counts.summary) + ' without live API metadata' : '') + '.');
    }catch(err){ console.error(err); toast('Could not download from the API: ' + err.message); }
  }, 30);
}
const safeName = id => String(id).replace(/[^A-Za-z0-9._-]+/g,'_');
// Shared PNG exporter: title + settings line on top, the chart (its own legend hidden), and a drawn legend strip below.
function legendFromChart(ci, filterFn){
  const out = [];
  ((ci && ci.data && ci.data.datasets) || []).forEach(ds=>{
    if(filterFn && !filterFn(ds)) return;
    const col = (typeof ds.borderColor === 'string') ? ds.borderColor : '#888';
    out.push({label:ds.label, color:col, dash:ds.borderDash||[], width:Math.max(1.5, ds.borderWidth||2), point: ds.showLine===false});
  });
  return out;
}
function exportChartPng(opts){
  const src = opts.canvas;
  const dpr = Math.max(1, src.width / Math.max(1, src.clientWidth || src.width));
  const cs = getComputedStyle(document.body);
  const bg = cs.getPropertyValue('--surface-1').trim() || '#ffffff', ink1 = cs.getPropertyValue('--ink-1').trim() || '#20291f', ink2 = cs.getPropertyValue('--ink-2').trim() || '#485245';
  // hide the in-chart legend while capturing, so it is not drawn twice
  let restored = null;
  try{
    const ci = opts.chartInst;
    if(ci && ci.options && ci.options.plugins && ci.options.plugins.legend){ restored = ci.options.plugins.legend.display; ci.options.plugins.legend.display = false; ci.update('none'); }
  }catch(e){ restored = null; }
  const items = opts.items || [];
  const fs = Math.round(12*dpr), rowH = Math.round(20*dpr), sw = Math.round(30*dpr), gap = Math.round(18*dpr), m = Math.round(14*dpr);
  const probe = document.createElement('canvas').getContext('2d');
  const wrapPx = (text, font, maxW)=>{
    probe.font = font; const out = []; let cur = '';
    String(text).split(/\s+/).forEach(w=>{
      if(cur && probe.measureText(cur + ' ' + w).width > maxW){ out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
    });
    if(cur) out.push(cur); return out;
  };
  const titleFont = 'bold ' + Math.round(17*dpr) + 'px Georgia, serif', subFont = Math.round(11.5*dpr) + 'px sans-serif';
  const titleLines = wrapPx(opts.title, titleFont, src.width - 2*m), subLines = wrapPx(opts.subtitle || '', subFont, src.width - 2*m);
  const titleH = Math.round(22*dpr), subH = Math.round(16*dpr);
  const pad = Math.round(10*dpr) + titleLines.length*titleH + (subLines.length && subLines[0] ? subLines.length*subH : 0) + Math.round(10*dpr);
  probe.font = fs + 'px sans-serif';
  items.forEach(it=>{  // a label wider than the image would run off the edge: shorten it
    const maxW = src.width - 2*m - sw - Math.round(12*dpr);
    if(probe.measureText(it.label).width > maxW){ let t = it.label; while(t.length > 4 && probe.measureText(t + '\u2026').width > maxW) t = t.slice(0,-1); it.label = t + '\u2026'; }
  });
  const rows = [[]]; let x = m;
  items.forEach(it=>{
    const w = sw + Math.round(6*dpr) + probe.measureText(it.label).width + gap;
    if(x + w > src.width - m && rows[rows.length-1].length){ rows.push([]); x = m; }
    rows[rows.length-1].push(Object.assign({w}, it)); x += w;
  });
  const legendH = items.length ? rows.length*rowH + Math.round(14*dpr) : 0;
  const out = document.createElement('canvas'); out.width = src.width; out.height = pad + src.height + legendH;
  const g = out.getContext('2d');
  g.fillStyle = bg; g.fillRect(0,0,out.width,out.height); g.textBaseline = 'top';
  let ty = Math.round(10*dpr);
  g.fillStyle = ink1; g.font = titleFont; titleLines.forEach(l=>{ g.fillText(l, m, ty); ty += titleH; });
  g.fillStyle = ink2; g.font = subFont; subLines.forEach(l=>{ g.fillText(l, m, ty); ty += subH; });
  g.drawImage(src, 0, pad);
  let y = pad + src.height + Math.round(8*dpr);
  g.font = fs + 'px sans-serif';
  rows.forEach(row=>{
    let cx = m;
    row.forEach(it=>{
      const cy = y + Math.round(fs/2) + 1;
      g.strokeStyle = it.color; g.fillStyle = it.color; g.lineWidth = it.width*dpr/ (dpr>1?1:1);
      if(it.box){ g.globalAlpha = 0.35; g.fillRect(cx, cy - Math.round(5*dpr), sw, Math.round(10*dpr)); g.globalAlpha = 1; }
      else if(it.point){ g.beginPath(); g.arc(cx + sw/2, cy, Math.round(3.5*dpr), 0, Math.PI*2); g.fill(); }
      else { g.setLineDash((it.dash||[]).map(d=>d*dpr)); g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx+sw, cy); g.stroke(); g.setLineDash([]); }
      g.fillStyle = ink2; g.fillText(it.label, cx + sw + Math.round(6*dpr), y);
      cx += it.w;
    });
    y += rowH;
  });
  // restore the live chart
  try{ if(restored !== null && opts.chartInst){ opts.chartInst.options.plugins.legend.display = restored; opts.chartInst.update('none'); } }catch(e){}
  out.toBlob(b=>downloadBlob(opts.filename, b), 'image/png');
}
function singleWellImage(){
  if(!singleWell.chart) return;
  const m = wellMeta(singleWell.site);
  const bits = [m.source, (m.nmbgmr_site_id && m.nmbgmr_site_id !== m.well_id) ? 'NMBGMR ID: ' + m.nmbgmr_site_id + (m.nmbgmr_alternate_id ? ' (alt. ' + m.nmbgmr_alternate_id + ')' : '') : null, m.formation || m.aquifer_extent || m.aquifer_usgs, m.well_depth_ft!=null ? 'well depth '+m.well_depth_ft+' ft' : null,
    singleWell.mode==='elevation' ? 'water-surface elevation' : 'depth to water'].filter(Boolean);
  exportChartPng({canvas:singleWell.chart.canvas, chartInst:singleWell.chart, title:'Hydrograph — '+m.well_id, subtitle:bits.join('  ·  '),
    items: legendFromChart(singleWell.chart), filename:'hydrograph_'+safeName(m.well_id)+'.png'});
}
function renderSingleWell(){
  const s = singleWell.site; if(s==null) return;
  const d = singleWellData(s, singleWell.flag, singleWell.method);
  const elevMode = singleWell.mode === 'elevation' && d.elev != null;
  const val = r => elevMode ? r.elev : r.depth;
  const ok = d.rows.filter(r=>!r.flagged), bad = d.rows.filter(r=>r.flagged);
  const ink = getComputedStyle(document.body).getPropertyValue('--ink-2').trim() || '#485245';
  const muted = getComputedStyle(document.body).getPropertyValue('--muted').trim() || '#7d8873';
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#0f6e63';
  const m = wellMeta(s);
  document.getElementById('sw-title').textContent = m.well_id;
  document.getElementById('sw-sub').textContent = [m.source, (m.nmbgmr_site_id && m.nmbgmr_site_id !== m.well_id) ? 'NMBGMR ID: ' + m.nmbgmr_site_id + (m.nmbgmr_alternate_id ? ' (alt. ' + m.nmbgmr_alternate_id + ')' : '') : null, m.formation || m.aquifer_extent || m.aquifer_usgs, m.well_depth_ft!=null ? 'well depth '+m.well_depth_ft+' ft' : null,
    d.rows.length+' monthly values'+(d.flagged ? ' ('+d.flagged+' flagged)' : '')].filter(Boolean).join('  ·  ');
  document.getElementById('sw-mode-elev').disabled = d.elev == null;
  const datasets = [
    {label:'Monthly reading', data: ok.map(r=>({x:r.t, y:val(r)})), showLine:false, pointRadius:2.5, pointBackgroundColor:hexA(accent,0.55), borderColor:accent, order:3},
    {label: ({weighted:'Yearly mean (reading-weighted)', mean:'Yearly mean of monthly values', median:'Yearly median of monthly values'})[singleWell.method], data: d.yearly.map(y=>({x:y.year+0.5, y: elevMode ? y.elev : y.depth})), borderColor:'#c1652f', backgroundColor:'#c1652f', borderWidth:2, pointRadius:3, tension:0, order:2}
  ];
  if(bad.length) datasets.push({label:'Flagged as likely bad', data: bad.map(r=>({x:r.t, y:val(r)})), showLine:false, pointStyle:'crossRot', pointRadius:7, borderWidth:2, borderColor:'#e0455c', order:1});
  if(singleWell.chart){ singleWell.chart.destroy(); singleWell.chart = null; }
  const canvas = document.getElementById('sw-canvas');
  singleWell.chart = new Chart(canvas.getContext('2d'), {
    type:'line', data:{datasets},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false, parsing:false,
      plugins:{ legend:{labels:{color:ink, usePointStyle:true}}, tooltip:{callbacks:{title:items=>items.map(i=> i.dataset.label.indexOf('Yearly')===0 ? 'Year '+Math.floor(i.parsed.x) : decYearToLabel(i.parsed.x)), label:c=>`${c.dataset.label}: ${c.parsed.y.toFixed(2)} ${elevMode?'ft (elevation)':'ft below land surface'}`}} },
      scales:{
        x:{type:'linear', ticks:{color:muted, maxRotation:0, autoSkipPadding:14, callback:v=>decYearToLabel(v)}, grid:{color:'rgba(125,136,115,.2)'}, title:{display:true, text:'Date', color:muted}},
        y:{reverse: !elevMode, ticks:{color:muted}, grid:{color:'rgba(125,136,115,.2)'}, title:{display:true, text: wrapAxisTitle(elevMode ? 'Water-surface elevation (ft)' : 'Depth to water (ft below land surface)', canvas.clientHeight - 60), color:muted}}
      }
    }
  });
}
function openSingleWell(s){
  singleWell.site = s;
  singleWell.flag = state.despike.enabled;
  singleWell.mode = state.valueMode === 'elevation' ? 'elevation' : 'depth';
  document.getElementById('sw-flag').checked = singleWell.flag;
  singleWell.method = 'weighted'; document.getElementById('sw-method').value = 'weighted';
  document.getElementById('sw-mode-depth').classList.toggle('active', singleWell.mode==='depth');
  document.getElementById('sw-mode-elev').classList.toggle('active', singleWell.mode==='elevation');
  document.getElementById('single-well-modal').classList.remove('hidden');
  document.getElementById('sw-chem-sel').value = ''; swChemClear('');
  renderSingleWell();
}
function closeSingleWell(){
  document.getElementById('single-well-modal').classList.add('hidden');
  if(singleWell.chart){ singleWell.chart.destroy(); singleWell.chart = null; }
  swChemClear('');
}
document.getElementById('sw-close').addEventListener('click', closeSingleWell);
document.getElementById('single-well-modal').addEventListener('click', e=>{ if(e.target.id==='single-well-modal') closeSingleWell(); });
document.getElementById('sw-method').addEventListener('change', e=>{ singleWell.method = e.target.value; renderSingleWell(); });
document.getElementById('sw-flag').addEventListener('change', e=>{ singleWell.flag = e.target.checked; renderSingleWell(); });
document.getElementById('sw-mode-depth').addEventListener('click', ()=>{ singleWell.mode='depth'; document.getElementById('sw-mode-depth').classList.add('active'); document.getElementById('sw-mode-elev').classList.remove('active'); renderSingleWell(); });
document.getElementById('sw-mode-elev').addEventListener('click', ()=>{ if(document.getElementById('sw-mode-elev').disabled) return; singleWell.mode='elevation'; document.getElementById('sw-mode-elev').classList.add('active'); document.getElementById('sw-mode-depth').classList.remove('active'); renderSingleWell(); });
document.getElementById('sw-raw').addEventListener('click', ()=>{ downloadRawData([singleWell.site], 'well_'+safeName(wellMeta(singleWell.site).well_id)); });
document.getElementById('sw-csv').addEventListener('click', ()=>{ downloadCsv('hydrograph_'+safeName(wellMeta(singleWell.site).well_id)+'.csv', singleWellCsvRows(singleWell.site, singleWell.flag, singleWell.method)); });
document.getElementById('sw-geojson').addEventListener('click', ()=>{
  downloadBlob('hydrograph_'+safeName(wellMeta(singleWell.site).well_id)+'.geojson', new Blob([JSON.stringify(singleWellGeoJSON(singleWell.site, singleWell.flag, singleWell.method), null, 1)], {type:'application/geo+json'}));
});
document.getElementById('sw-png').addEventListener('click', singleWellImage);
// Composite / overview chart -> PNG with a title block (area, well count, schedule, settings)
document.getElementById('btn-export-hydrograph-png').addEventListener('click', ()=>{
  if(!chart || document.getElementById('hydrograph-canvas').style.display === 'none'){ toast('No hydrograph to export yet.'); return; }
  const src = document.getElementById('hydrograph-canvas'), dpr = Math.max(1, src.width / Math.max(1, src.clientWidth || src.width));
  const cs = getComputedStyle(document.body);
  const overview = !!window._lastOverview, c = window._lastComposite;
  const area = state.areaSelection ? (state.areaSelection.label || 'selected area') : (state.clickSelectedSites.size ? 'hand-picked wells' : 'all wells');
  const title = (overview ? 'Well hydrographs (' + ({raw:'raw readings', month:'monthly values', year:'yearly values'}[(window.__hx && window.__hx.wv.stepUsed) || 'month']) + ')' : 'Composite hydrograph') + ' \u2014 ' + area;
  const bits = [];
  if(overview) bits.push((window._lastOverview.length) + ' wells plotted');
  else if(c) bits.push(c.qualifying.length + ' of ' + c.poolSize + ' wells');
  if(!overview && c){
    bits.push(OT_METHOD_LABEL[state.otp.method] + ', \u2265' + state.otp.minN + ' wells/yr, wells with \u2265' + state.otp.minYears + ' yrs over \u2265' + state.otp.minSpan + ' yrs');
    if(c.labels.length) bits.push(c.labels[0] + ' to ' + c.labels[c.labels.length-1]);
  }
  bits.push(state.valueMode==='elevation' ? 'water-surface elevation' : 'depth to water');
  if(overview){ if(useUsgsNorm()) bits.push('USGS % of range'); else if(state.normalize) bits.push('anomaly from well mean'); }
  if(!seasonIsFullYear()) bits.push('season ' + state.season.monthStart + '\u2013' + state.season.monthEnd);
  if(state.waterYear) bits.push('water years');
  if(state.despike.enabled) bits.push('bad readings removed');
  const accent = cs.getPropertyValue('--accent').trim() || '#0f6e63';
  let items = [];
  if(overview){
    if(window._wvGroups && window._wvGroups.groups.length) window._wvGroups.groups.forEach(g=>items.push({label:g.label, color:g.color, width:2}));
    else items.push({label:'Each line = one well ('+window._lastOverview.length+' plotted; colors only separate lines)', color:'#7d8873', width:1.5});
  } else {
    items = legendFromChart(chart, ds=>ds._show);
    const grouped = !!(window._lastGroups && window._lastGroups.length), compare = !!window._lastSeasonOverlays;
    if(state.showBand && !grouped && !compare && c && c.band && c.band.B) items.push({label:'95% bootstrap band of the median', color:cs.getPropertyValue('--warn').trim() || '#c1652f', box:true, width:2});
    if(state.showSpaghetti && !grouped && !compare && c && c.perWell.length <= SPAGHETTI_CAP()) items.push({label:'Thin lines = individual wells (' + c.perWell.length + ')', color:'#7d8873', width:1.5});
    if(grouped) items.push({label:'Solid = group mean, dashed = group median', color:'#7d8873', width:1.5});
    if(compare) items.push({label:'Solid = mean, dashed = median, per season', color:'#7d8873', width:1.5});
  }
  if(state.chartHighlightSite != null) items.push({label:'Highlighted well: ' + SITES[state.chartHighlightSite][0] + ((nmbgmrIdOf(state.chartHighlightSite) && nmbgmrIdOf(state.chartHighlightSite) !== SITES[state.chartHighlightSite][0]) ? ' (NMBGMR ' + nmbgmrIdOf(state.chartHighlightSite) + ')' : ''), color:'#e0455c', width:3});
  exportChartPng({canvas:src, chartInst:chart, title, subtitle:bits.join('  \u00b7  '), items, filename:'nm_groundwater_' + (overview ? 'overview' : 'composite') + '_hydrograph.png'});
});
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && !document.getElementById('single-well-modal').classList.contains('hidden')) closeSingleWell(); });

updateAccSummaries(); // initial slider + summaries



/* -------------------------------------------------------------------- */
/* 18. Live data from the NM Unified Water Data API (OGC API - Features)  */
/* -------------------------------------------------------------------- */
// (source,id) -> site index. Some partner IDs are listed under another source label (e.g. "WQP/NWIS"), so fall back to a unique bare-id match.
const siteByKey = new Map(), siteByBareId = new Map();
SITES.forEach((r,i)=>{
  siteByKey.set((r[3]>=0 ? SOURCES[r[3]] : '') + '\u0001' + r[0], i);
  siteByBareId.set(r[0], siteByBareId.has(r[0]) ? -1 : i);
});
function apiSiteIdx(source, id){
  id = String(id);
  const i = siteByKey.get(source + '\u0001' + id);
  if(i != null) return i;
  const j = siteByBareId.get(id);
  return (j != null && j >= 0) ? j : null;
}

/* ---- B. Cross-agency well clusters (nm_well_correlation) ---- */
function refreshMultiRings(){
  multiLayer.clearLayers(); multiRings.clear();
  for(let s=0; s<NSITES; s++){
    if(!isMultiAgency(s) || !markers[s]) continue;
    const ring = L.circleMarker(markers[s].getLatLng(), {pane:'multiPane', radius:8, weight:2, color:'#a23fb5', dashArray:'3,2', fillOpacity:0, opacity:0.9, interactive:false});
    multiRings.set(s, ring);
    if(!markerHidden[s]) multiLayer.addLayer(ring);
  }
  restyleMarkers();
}
async function apiLoadClusters(){
  apiState.clusters = 'loading';
  const parts = await Promise.all([2,3,4,5,6,7,8].map(n=>apiFeatures('nm_well_correlation', {n_agencies:n, properties:'source,id,cluster_id,n_agencies,linked_site_ids,match_method,match_confidence,is_ose_pod'}).then(r=>r.features, ()=>[])));
  const feats = [].concat(...parts);
  const groups = new Map();
  for(const f of feats){
    const p = f.properties; if(p.is_ose_pod) continue;
    if(!groups.has(p.cluster_id)) groups.set(p.cluster_id, {members:new Set(), linked:new Set(), method:p.match_method, conf:p.match_confidence});
    const g = groups.get(p.cluster_id);
    const self = apiSiteIdx(p.source, p.id); if(self != null) g.members.add(self);
    String(p.linked_site_ids || '').split(',').filter(Boolean).forEach(tok=>{
      g.linked.add(tok);
      const k = tok.indexOf(':'); if(k < 0) return;
      const j = apiSiteIdx(tok.slice(0,k), tok.slice(k+1)); if(j != null) g.members.add(j);
    });
  }
  clusterPeers.clear(); clusterInfo.clear(); clusterDropSet.clear(); clusterKeep.clear();
  let nClusters = 0;
  groups.forEach((g, cid)=>{
    // keep only the members within LINK_MAX_KM of the cluster's best-placed member (most others nearby)
    let mem = [...g.members];
    if(mem.length > 1){
      const near = s => mem.filter(o => siteKm(s, o) <= LINK_MAX_KM).length;
      const core = mem.slice().sort((a, b) => near(b) - near(a))[0];
      const out = mem.filter(o => siteKm(core, o) > LINK_MAX_KM); out.forEach(o => linkRejected.push([o, core, siteKm(o, core)]));
      mem = mem.filter(o => siteKm(core, o) <= LINK_MAX_KM);
    }
    const agencies = new Set(mem.map(s=>SITES[s][3]));
    if(agencies.size < 2) return;
    nClusters++;
    mem.forEach(s=>{
      clusterPeers.set(s, mem.filter(o=>o !== s && SITES[o][3] !== SITES[s][3]));
      clusterInfo.set(s, {cid, linked:[...g.linked].join(', '), method:g.method, conf:g.conf});
    });
    // keep the NMBGMR cross-reference maps in step so the existing popup/export/filter code sees API clusters too
    const nm = mem.find(s=>src_isNmbgmr(s));
    if(nm != null){
      mem.forEach(o=>{
        if(o === nm || src_isNmbgmr(o)) return;
        if(!nmbgmrOfOther.has(o)) nmbgmrOfOther.set(o, {idx:nm, id:SITES[nm][0], alt:''});
        if(!otherOfNmbgmr.has(nm)) otherOfNmbgmr.set(nm, []);
        if(!otherOfNmbgmr.get(nm).some(x=>x.idx===o)) otherOfNmbgmr.get(nm).push({idx:o, id:SITES[o][0], source: SITES[o][3]>=0 ? SOURCES[SITES[o][3]] : 'other'});
      });
    }
    const keep = nm != null ? nm : mem.slice().sort((a,b)=>(SITES[b][5]||0)-(SITES[a][5]||0))[0];
    mem.forEach(o=>{ if(o !== keep){ clusterDropSet.add(o); clusterKeep.set(o, keep); } });
  });
  // static NMBGMR pairs that the API did not return still de-duplicate sensibly
  otherOfNmbgmr.forEach((list, n)=> list.forEach(o=>{ if(!clusterInfo.has(o.idx)){ clusterDropSet.add(o.idx); if(!clusterKeep.has(o.idx)) clusterKeep.set(o.idx, n); } }));
  clusterKeep.forEach((k, s) => { let t = k, guard = 0; while(clusterKeep.has(t) && guard++ < 20) t = clusterKeep.get(t); if(t === s){ clusterKeep.delete(s); clusterDropSet.delete(s); } else clusterKeep.set(s, t); });
  apiState.clusters = {n:nClusters, wells:clusterPeers.size};
  refreshMultiRings(); mergeApplied = null; if(!syncMerge()) recomputeActiveSet(); renderLegend();
  const el = document.getElementById('multi-count'); if(el) el.textContent = isFinite(apiState.clusters.wells) ? apiState.clusters.wells.toLocaleString() : '';
  return apiState.clusters;
}

/* ---- C. API-derived map colouring (water-level and water-quality indicators) ---- */
const API_CAT_COLORS = {
  'increasing':'#c1652f','decreasing':'#2f7fc1','stable':'#9aa39a','not enough data':'#d3d7cf','insufficient':'#d3d7cf',
  'much below normal':'#b2182b','below normal':'#ef8a62','normal':'#9aa39a','above normal':'#67a9cf','much above normal':'#2166ac',
  'active':'#0f6e63','stale':'#c9a227','declining':'#c1652f','rising':'#2f7fc1',
  'fresh':'#2f7fc1','brackish':'#c9a227','saline':'#c1652f','brine':'#6e1d1d',
  'soft':'#2f7fc1','moderate':'#5a9c8c','hard':'#c9a227','very hard':'#c1652f',
  'suspect':'#c1652f','balanced':'#0f6e63','acceptable':'#7a9c3f',
  'low':'#2f7fc1','medium':'#c9a227','high':'#e08a3c','very high':'#c1652f',
  'excellent':'#2f7fc1','good':'#5a9c8c','fair':'#c9a227','marginal':'#e08a3c','poor':'#c1652f',
  'no exceedance':'#2f7fc1','1 exceedance':'#c9a227','2 exceedances':'#e08a3c','3+ exceedances':'#c1652f'
};
const API_CAT_ORDER = ['much below normal','below normal','normal','above normal','much above normal','increasing','stable','decreasing','active','stale','declining','rising',
  'fresh','brackish','saline','brine','soft','moderate','hard','very hard','balanced','acceptable','suspect','excellent','good','fair','marginal','poor','low','medium','high','very high',
  'no exceedance','1 exceedance','2 exceedances','3+ exceedances','not enough data','insufficient'];
const API_FALLBACK = ['#0f6e63','#2f7fc1','#c9a227','#a26bc2','#7a9c3f','#c25d8f','#5a8f8c','#e08a3c','#6b7fd4','#c1652f'];
const mclClasses = (mcl, unit) => [[mcl*0.5,'#2f7fc1','< 50% of MCL ('+mcl+' '+unit+')'],[mcl,'#c9a227','50–100% of MCL'],[Infinity,'#c1652f','Exceeds MCL']];
const API_LAYERS = [
  {id:'wl_trend',   group:'Water levels', label:'Water-level trend (Mann‑Kendall)', coll:'nm_waterlevel_trends', props:'trend_category', val:p=>p.trend_category, note:'"increasing" = depth to water increasing (water table declining)'},
  {id:'wl_status',  group:'Water levels', label:'Current level vs well’s own record', coll:'nm_waterlevel_status', props:'status', val:p=>p.status},
  {id:'wl_recency', group:'Water levels', label:'Monitoring status (active / stale)', coll:'nm_monitoring_recency', props:'status', val:p=>p.status},
  {id:'wl_change',  group:'Water levels', label:'5-year water-level change', coll:'nm_waterlevel_change', props:'direction,status', val:p=>p.direction || p.status},
  {id:'wl_density', group:'Water levels', label:'Measurement frequency', coll:'nm_waterlevel_data_density', props:'observations_per_year', num:p=>p.observations_per_year,
    classes:[[1,'#c1652f','≤ 1 reading / yr'],[4,'#c9a227','1–4 / yr'],[12,'#5a9c8c','4–12 / yr'],[Infinity,'#0f6e63','> 12 / yr']]},
  {id:'wl_amp',     group:'Water levels', label:'Seasonal amplitude (mean, ft)', coll:'nm_seasonal_amplitude', props:'mean_amplitude_ft', num:p=>p.mean_amplitude_ft,
    classes:[[1,'#2f7fc1','< 1 ft'],[5,'#5a9c8c','1–5 ft'],[15,'#c9a227','5–15 ft'],[Infinity,'#c1652f','> 15 ft']]},
  {id:'wq_mcl',     group:'Water quality', label:'Drinking-water MCL exceedances', coll:'nm_mcl_exceedance', props:'any_exceedance,exceedance_count',
    val:p=> p.any_exceedance==null ? null : (!p.any_exceedance ? 'no exceedance' : (p.exceedance_count>=3 ? '3+ exceedances' : p.exceedance_count+(p.exceedance_count===1?' exceedance':' exceedances')))},
  {id:'wq_wqi',     group:'Water quality', label:'Water quality index (CCME)', coll:'nm_wqi', props:'wqi_class', val:p=>p.wqi_class},
  {id:'wq_tds',     group:'Water quality', label:'TDS class', coll:'nm_tds_summary', props:'tds_class', val:p=>p.tds_class},
  {id:'wq_hard',    group:'Water quality', label:'Hardness', coll:'nm_hardness', props:'hardness_class', val:p=>p.hardness_class},
  {id:'wq_type',    group:'Water quality', label:'Water type (Piper)', coll:'nm_water_type', props:'water_type', val:p=>p.water_type},
  {id:'wq_sar',     group:'Water quality', label:'Sodium adsorption ratio class', coll:'nm_sar', props:'sar_class', val:p=>p.sar_class},
  {id:'wq_ion',     group:'Water quality', label:'Ion-balance QA', coll:'nm_ion_balance', props:'balance_class', val:p=>p.balance_class},
  {id:'wq_as',      group:'Water quality', label:'Arsenic, latest (vs 0.01 mg/L MCL)', coll:'nm_arsenic_summary', props:'latest_value', num:p=>p.latest_value, classes:mclClasses(0.01,'mg/L')},
  {id:'wq_no3',     group:'Water quality', label:'Nitrate, latest (vs 10 mg/L MCL)', coll:'nm_nitrate_summary', props:'latest_value', num:p=>p.latest_value, classes:mclClasses(10,'mg/L')},
  {id:'wq_f',       group:'Water quality', label:'Fluoride, latest (vs 4 mg/L MCL)', coll:'nm_fluoride_summary', props:'latest_value', num:p=>p.latest_value, classes:mclClasses(4,'mg/L')},
  {id:'wq_u',       group:'Water quality', label:'Uranium, latest (vs 0.03 mg/L MCL)', coll:'nm_uranium_summary', props:'latest_value', num:p=>p.latest_value, classes:mclClasses(0.03,'mg/L')},
  {id:'wq_so4',     group:'Water quality', label:'Sulfate, latest (vs 250 mg/L)', coll:'nm_sulfate_summary', props:'latest_value', num:p=>p.latest_value, classes:mclClasses(250,'mg/L')},
  {id:'wq_cl',      group:'Water quality', label:'Chloride, latest (vs 250 mg/L)', coll:'nm_chloride_summary', props:'latest_value', num:p=>p.latest_value, classes:mclClasses(250,'mg/L')}
];
function apiLayerById(id){ return API_LAYERS.find(l=>l.id === id); }
function apiClassOf(spec, p){
  if(spec.classes){
    const v = spec.num(p); if(v == null || isNaN(v)) return null;
    const c = spec.classes.find(c=>v <= c[0]); return c ? c[2] : null;
  }
  const v = spec.val(p); return v == null || v === '' ? null : String(v);
}
async function apiLoadLayer(id){
  const spec = apiLayerById(id); if(!spec) return null;
  const cached = apiState.layers[id];
  if(cached && cached.byIdx) return cached;
  if(cached && cached.promise) return cached.promise;
  const promise = (async()=>{
    const {features} = await apiFeatures(spec.coll, {properties:'source,id,' + spec.props});
    const byIdx = new Map(), counts = new Map();
    for(const f of features){
      const p = f.properties, s = apiSiteIdx(p.source, p.id); if(s == null) continue;
      const cls = apiClassOf(spec, p); if(cls == null) continue;
      byIdx.set(s, cls); counts.set(cls, (counts.get(cls)||0) + 1);
    }
    const order = spec.classes ? spec.classes.map(c=>c[2]) : [...counts.keys()].sort((a,b)=>{
      const ia = API_CAT_ORDER.indexOf(a.toLowerCase()), ib = API_CAT_ORDER.indexOf(b.toLowerCase());
      if(ia >= 0 && ib >= 0) return ia - ib; if(ia >= 0) return -1; if(ib >= 0) return 1; return (counts.get(b)||0) - (counts.get(a)||0);
    });
    const colors = new Map(); let fb = 0;
    order.forEach(c=>{
      const k = spec.classes ? spec.classes.find(x=>x[2]===c)[1] : (API_CAT_COLORS[c.toLowerCase()] || API_FALLBACK[fb++ % API_FALLBACK.length]);
      colors.set(c, k);
    });
    const res = {byIdx, counts, order, colors, matched:byIdx.size, total:features.length};
    apiState.layers[id] = res; return res;
  })();
  apiState.layers[id] = {promise};
  try{ return await promise; }catch(e){ delete apiState.layers[id]; throw e; }
}
function apiColor(s, mode){
  const L_ = apiState.layers[mode.slice(4)];
  if(!L_ || !L_.byIdx) return '#c9cdc4';
  const c = L_.byIdx.get(s); return c == null ? '#c9cdc4' : L_.colors.get(c);
}
function apiLegendRows(){
  const id = state.colorBy.slice(4), spec = apiLayerById(id), L_ = apiState.layers[id];
  if(!spec) return [];
  if(!L_ || !L_.byIdx) return [`<div class="lg-row"><span class="k">${L_ && L_.promise ? 'Loading ' + spec.label + ' from the API…' : 'Not loaded'}</span></div>`];
  const rows = L_.order.map(c=>`<div class="lg-row"><span class="swatch" style="background:${L_.colors.get(c)}"></span><span class="k">${c} <span style="color:var(--muted)">(${(L_.counts.get(c)||0).toLocaleString()})</span></span></div>`);
  rows.push(`<div class="lg-row"><span class="swatch" style="background:#c9cdc4"></span><span class="k">No API record <span style="color:var(--muted)">(${(NSITES - L_.matched).toLocaleString()})</span></span></div>`);
  if(spec.note) rows.push(`<div class="lg-row" style="color:var(--muted); font-size:10.5px;">${spec.note}</div>`);
  rows.push(`<div class="lg-row" style="color:var(--muted); font-size:10.5px;">Source: NM Unified Water Data API · ${spec.coll}</div>`);
  return rows;
}
async function apiSelectLayer(id){
  try{
    toast('Loading ' + apiLayerById(id).label + ' from the API…');
    renderLegend();
    await apiLoadLayer(id);
    if(state.colorBy === 'api:' + id){ restyleMarkers(); renderLegend(); toast('Loaded: ' + apiLayerById(id).label); }
  }catch(e){
    console.error(e); toast('Could not load that layer from the API: ' + e.message);
    state.colorBy = 'source'; document.getElementById('colorby-select').value = 'source'; restyleMarkers(); renderLegend();
  }
}

/* ---- D. Popup: live per-well attributes ---- */
const POPUP_API = [
  ['nm_waterlevel_trends',   (p,s)=>'API trend: <b>' + (p.trend_category || 'n/a') + '</b>' + (p.slope_per_year != null ? ' (' + p.slope_per_year + ' ' + (p.slope_units || 'ft/yr') + (p.mk_p_value != null ? ', p ' + (p.mk_p_value < 0.001 ? '< 0.001' : '= ' + p.mk_p_value) : '') + (p.mk_tau != null ? ', tau ' + p.mk_tau : '') + (p.span_years != null ? ', ' + p.span_years + ' yr span' : '') + ')' : '') + (s != null && !isNaN(siteTrend[s]) ? ' · this tool: ' + (siteTrend[s] >= 0 ? '+' : '') + siteTrend[s].toFixed(2) + ' ft/yr' : '')],
  ['nm_waterlevel_data_density', p=>p.observations_per_year != null ? 'Sampling: <b>' + Number(p.observations_per_year).toLocaleString() + ' readings/yr</b>' + (p.mean_interval_days != null ? ' (every ' + p.mean_interval_days + ' d on average)' : '') : null],
  ['nm_monitoring_recency',  p=>'Monitoring: <b>' + p.status + '</b>' + (p.days_since_last != null ? ' (' + Number(p.days_since_last).toLocaleString() + ' d since last reading)' : '')],
  ['nm_mcl_exceedance',      p=>'MCL: <b>' + (p.any_exceedance ? 'exceeds ' + (()=>{ try{ return JSON.parse(p.exceeded_analytes).join(', '); }catch(e){ return p.exceeded_analytes; } })() : 'none exceeded') + '</b>'],
  ['nm_tds_summary',         p=>'TDS: <b>' + p.latest_value + ' ' + p.latest_units + '</b> (' + p.tds_class + ')'],
  ['nm_water_type',          p=>'Water type: <b>' + p.water_type + '</b>' + (p.charge_balance_pct != null ? ' (charge balance ' + Number(p.charge_balance_pct).toFixed(1) + '%)' : '')],
  ['nm_hardness',            p=>'Hardness: <b>' + p.hardness_caco3 + ' mg/L</b> (' + p.hardness_class + ')']
];
async function apiLoadPopup(s){
  const box = document.getElementById('pop-api-' + s); if(!box) return;
  const rec = SITES[s], source = rec[3]>=0 ? SOURCES[rec[3]] : '';
  let cached = apiState.popup.get(s);
  if(!cached){
    box.textContent = 'Loading live indicators…';
    const out = await Promise.all(POPUP_API.map(async([coll, fmt])=>{
      try{
        const j = await apiJson('/collections/'+coll+'/items', {f:'json', limit:1, skipGeometry:'true', source, id:rec[0]});
        const f = j.features && j.features[0]; if(!f) return null;
        return fmt(f.properties, s);
      }catch(e){ return null; }
    }));
    cached = out.filter(Boolean); apiState.popup.set(s, cached);
  }
  const b2 = document.getElementById('pop-api-' + s); if(!b2) return;
  b2.innerHTML = cached.length ? '<div style="font-size:11px; color:var(--muted); margin-top:6px; border-top:1px solid var(--border); padding-top:4px;">Live from NM Unified Water Data API</div>' + cached.map(t=>'<div class="kv" style="display:block;">' + t + '</div>').join('') : '<div style="font-size:11px; color:var(--muted); margin-top:6px;">No live indicators for this well in the API.</div>';
}

/* ---- E. Raw data download, straight from the API ---- */
const RAW_TS_HEADER = ['source','id','parameter_name','parameter_value','parameter_units','date_measured','time_measured','source_parameter_name','source_parameter_units','conversion_factor','approval_status','approval_status_normalized','qualifier','datetime'];
function parseCsv(text){
  const rows = []; let row = [], cur = '', q = false;
  for(let i=0; i<text.length; i++){
    const c = text[i];
    if(q){ if(c === '"'){ if(text[i+1] === '"'){ cur += '"'; i++; } else q = false; } else cur += c; }
    else if(c === '"') q = true;
    else if(c === ','){ row.push(cur); cur = ''; }
    else if(c === '\n'){ row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if(cur !== '' || row.length){ row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
const csvCell = v => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
async function apiCsvRows(params){      // all rows of the time-series collection matching params, as arrays in RAW_TS_HEADER order
  const out = []; let offset = 0;
  for(;;){
    const r = await apiFetch(API_BASE + '/collections/nm_waterlevels_timeseries/items?' + new URLSearchParams(Object.assign({f:'csv', limit:API_PAGE, offset}, params)));
    const rows = parseCsv(await r.text());
    if(rows.length < 2) break;
    const idx = RAW_TS_HEADER.map(h=>rows[0].indexOf(h));
    if(idx.slice(0,10).some(i=>i<0)) throw new Error('unexpected CSV columns from the API');
    for(let i=1; i<rows.length; i++) if(rows[i].length > 1) out.push(idx.map(k=>k<0 ? '' : rows[i][k]));
    if(rows.length - 1 < API_PAGE) break;
    offset += API_PAGE;
  }
  return out;
}
async function fetchRawTimeseries(siteIdxs, onProgress){
  const wanted = new Map(); siteIdxs.forEach(s=>wanted.set(rawWellKey(s), s));
  const failures = []; let rows = [];
  // Strategy: one request per well, unless the wells are dense enough that paging a bounding box is cheaper.
  let lats = [], lons = [];
  siteIdxs.forEach(s=>{ lons.push(SITES[s][1]); lats.push(SITES[s][2]); });
  let useBbox = false, bbox = null;
  if(siteIdxs.length > 40){
    const pad = 0.0005;
    bbox = [Math.min(...lons)-pad, Math.min(...lats)-pad, Math.max(...lons)+pad, Math.max(...lats)+pad].join(',');
    try{
      const probe = await apiJson('/collections/nm_waterlevels_timeseries/items', {f:'json', limit:1, skipGeometry:'true', bbox});
      useBbox = Math.ceil(probe.numberMatched / API_PAGE) < siteIdxs.length / 2;
      if(useBbox) bbox = {bbox, pages:Math.ceil(probe.numberMatched / API_PAGE)};
    }catch(e){ useBbox = false; }
  }
  if(useBbox){
    const tasks = Array.from({length:bbox.pages}, (_,k)=> async()=>{
      const r = await apiFetch(API_BASE + '/collections/nm_waterlevels_timeseries/items?' + new URLSearchParams({f:'csv', limit:API_PAGE, offset:k*API_PAGE, bbox:bbox.bbox}));
      const parsed = parseCsv(await r.text()); if(parsed.length < 2) return [];
      const idx = RAW_TS_HEADER.map(h=>parsed[0].indexOf(h));
      const out = [];
      for(let i=1; i<parsed.length; i++){ const p = parsed[i]; if(p.length < 2) continue; if(wanted.has(p[idx[0]] + '\u0001' + p[idx[1]])) out.push(idx.map(k=>p[k])); }
      return out;
    });
    const pages = await apiPool(tasks, 4, onProgress);
    pages.forEach(p=>{ for(const r of p) rows.push(r); });
    // bbox rows may interleave wells; order them by well then as served
    const order = new Map(); [...wanted.keys()].forEach((k,i)=>order.set(k,i));
    rows = rows.map((r,i)=>[r,i]).sort((a,b)=> order.get(a[0][0]+'\u0001'+a[0][1]) - order.get(b[0][0]+'\u0001'+b[0][1]) || a[1]-b[1]).map(x=>x[0]);
  } else {
    const keys = [...wanted.keys()];
    const per = await apiPool(keys.map(k=>async()=>{
      const s = wanted.get(k), rec = SITES[s];
      try{ return await apiCsvRows({source: rec[3]>=0 ? SOURCES[rec[3]] : '', id: rec[0]}); }
      catch(e){ failures.push(k.replace('\u0001',':')); return []; }
    }), 6, onProgress);
    per.forEach(p=>{ for(const r of p) rows.push(r); });
  }
  return {rows, failures, mode: useBbox ? 'bbox' : 'per-well'};
}

// header chip: where the data came from
(function(){
  const i = BOOT.info, rows = BOOT.info.nWells.toLocaleString();
  if(i.offline) setLivePill('API unreachable \u00b7 saved copy through <b>' + i.maxDate + '</b>', 'Could not reach the NM Unified Water Data API, so the copy saved in this browser (' + rows + ' wells, readings through ' + i.maxDate + ') is being used. Click to retry.', 'off');
  else setLivePill('API data through <b>' + i.maxDate + '</b>', 'Wells and readings come from the NM Unified Water Data API (' + rows + ' wells; ' + (i.mode === 'full' ? 'full download in ' + i.seconds + ' s' : (i.snapshot ? 'pre-built snapshot plus the newest months, ' + i.seconds + ' s' : 'saved copy updated in ' + i.seconds + ' s')) + '). Click to refresh; Shift+click to re-download everything.', 'ok');
  document.getElementById('live-pill').addEventListener('click', async e=>{ if(e.shiftKey) await idbClear(); location.reload(); });
})();

/* -------------------------------------------------------------------- */
/* 19. Reading quality, API well statistics / water-quality filters, chemistry series */
/* -------------------------------------------------------------------- */
state.readQ = {static:false, noDisturbed:false, approved:false, method:'all'};
if(!state.filters.api) state.filters.api = defaultFilters().api;
function readQDefault(){ const q = state.readQ; return !q.static && !q.noDisturbed && !q.approved && q.method === 'all' && !q.pumpHeur; }
function readPass(){
  const q = state.readQ;
  return fl=>{
    if(q.static && !(fl & 1)) return false;
    if(q.noDisturbed && (fl & 2)) return false;
    if(q.approved && !(fl & 4)) return false;
    if(q.method === 'noLogger' && (fl & 32)) return false;
    if(q.method === 'logger' && !(fl & 32)) return false;
    return true;
  };
}
let mergeApplied = null;
// true when the data had to be rebuilt (applyReadingQuality also refreshes the selection)
function syncMerge(){
  const want = state.filters.multiAgency === 'merge' && clusterKeep.size > 0;
  if(want === mergeApplied) return false;
  applyReadingQuality(); return true;
}
// Fold each cluster's other-agency rows into the well that represents it. Month rows: a month whose value matches
// (within 0.05 ft) a month already in the merged record is the same measurement stored twice and is skipped.
function mergeClusterRows(siteMonth, siteYear){
  const stats = {wells:0, monthsAdded:0, monthsDup:0};
  if(!clusterKeep.size) return {siteMonth, siteYear, stats};
  const keeps = new Set(clusterKeep.values());
  const monOf = new Map(), yrOf = new Map();
  siteMonth.forEach(r => { const k = clusterKeep.get(r[0]); const g = k != null ? k : (keeps.has(r[0]) ? r[0] : null); if(g == null) return; if(!monOf.has(g)) monOf.set(g, []); monOf.get(g).push(r); });
  siteYear.forEach(r => { const k = clusterKeep.get(r[0]); const g = k != null ? k : (keeps.has(r[0]) ? r[0] : null); if(g == null) return; if(!yrOf.has(g)) yrOf.set(g, []); yrOf.get(g).push(r); });
  const newMon = [], newYr = [], r2 = x => Math.round(x*100)/100;
  keeps.forEach(g => {
    let rows = monOf.get(g) || []; if(!rows.length) return;
    // reference-point check: per partner well, the median difference from the kept well over months both measured
    { const own = new Map(); rows.forEach(r => { if(r[0] !== g) return; const mk = r[1]*12 + r[2]; const a = own.get(mk); if(a) a.push(r[3]); else own.set(mk, [r[3]]); });
      const part = new Map(); rows.forEach(r => { if(r[0] === g) return; const a = own.get(r[1]*12 + r[2]); if(!a) { if(!part.has(r[0])) part.set(r[0], []); return; }
        const d = r[3] - a.reduce((x,y)=>x+y,0)/a.length; if(!part.has(r[0])) part.set(r[0], []); part.get(r[0]).push(d); });
      const off = new Map();
      part.forEach((d, p) => { if(d.length < 3){ stats.offNone = (stats.offNone || 0) + 1; return; }
        const s = Float64Array.from(d).sort(), m = s.length % 2 ? s[s.length >> 1] : (s[s.length/2 - 1] + s[s.length/2]) / 2;
        if(Math.abs(m) >= 0.05){ off.set(p, m); (stats.offAll = stats.offAll || new Map()).set(p, m); if(Math.abs(m) >= 0.5){ stats.offWells = (stats.offWells || 0) + 1; (stats.offList = stats.offList || []).push([p, g, Math.round(m*100)/100, d.length]); } } });
      if(off.size) rows = rows.map(r => off.has(r[0]) ? [r[0], r[1], r[2], Math.round((r[3] - off.get(r[0]))*100)/100, r[4]] : r); }
    // own rows first, so the representative well's own values win ties
    rows.sort((a, b) => (a[0] === g ? 0 : 1) - (b[0] === g ? 0 : 1));
    const byM = new Map(), yAdd = new Map();
    rows.forEach(r => {
      const mk = r[1]*12 + r[2] - 1; let L = byM.get(mk); if(!L){ L = []; byM.set(mk, L); }
      if(L.some(x => Math.abs(x[3] - r[3]) <= 0.05)){ if(r[0] !== g) stats.monthsDup++; return; }
      L.push(r); if(r[0] !== g){ stats.monthsAdded++; if(!yAdd.has(r[1])) yAdd.set(r[1], new Set()); yAdd.get(r[1]).add(r[0]); }
    });
    if(!yAdd.size) return;
    stats.wells++;
    const ys = new Map();
    byM.forEach((L, mk) => {
      let s = 0, n = 0; L.forEach(x => { s += x[3]*x[4]; n += x[4]; });
      newMon.push([g, Math.floor(mk/12), mk % 12 + 1, r2(s/n), n]);
      const y = Math.floor(mk/12); let Y = ys.get(y); if(!Y){ Y = [0, 0, Infinity, -Infinity]; ys.set(y, Y); } Y[0] += s; Y[1] += n;
    });
    (yrOf.get(g) || []).forEach(r => { const Y = ys.get(r[1]); if(!Y) return; if(r[0] === g || (yAdd.get(r[1]) && yAdd.get(r[1]).has(r[0]))){ Y[2] = Math.min(Y[2], r[4]); Y[3] = Math.max(Y[3], r[5]); } });
    ys.forEach((Y, y) => newYr.push([g, y, r2(Y[0]/Y[1]), Y[1], isFinite(Y[2]) ? Y[2] : r2(Y[0]/Y[1]), isFinite(Y[3]) ? Y[3] : r2(Y[0]/Y[1])]));
    stats.replace = stats.replace || new Set(); stats.replace.add(g);
  });
  if(!stats.wells) return {siteMonth, siteYear, stats};
  const rp = stats.replace;
  const sm = siteMonth.filter(r => !rp.has(r[0])).concat(newMon).sort((a,b)=>a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
  const sy = siteYear.filter(r => !rp.has(r[0])).concat(newYr).sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
  return {siteMonth: sm, siteYear: sy, stats};
}
function applyReadingQuality(){
  let c = BOOT.collapse(readPass(), hxPumpSub());
  mergeApplied = state.filters.multiAgency === 'merge' && clusterKeep.size > 0;
  if(mergeApplied){
    const m = mergeClusterRows(c.siteMonth, c.siteYear); c = m;
    window._mergeStats = m.stats; window._mergeOffAll = m.stats.offAll || new Map();
    window._mergeOffsets = (m.stats.offList || []).map(x => ({partner: SITES[x[0]][0], kept: SITES[x[1]][0], offset_ft: x[2], months: x[3]})).sort((a, b) => Math.abs(b.offset_ft) - Math.abs(a.offset_ft));
    const el = document.getElementById('merge-note');
    if(el) el.textContent = `Now: ${m.stats.wells.toLocaleString()} merged wells gained ${m.stats.monthsAdded.toLocaleString()} months from their partner agencies; ${m.stats.monthsDup.toLocaleString()} duplicate months were counted once. Reference points: ${(m.stats.offWells || 0).toLocaleString()} partner wells read 0.5 ft or more off the kept well in months both measured, and that median offset was removed before merging; ${(m.stats.offNone || 0).toLocaleString()} partners share fewer than 3 months with the kept well, so no offset could be checked.` + ((m.stats.offList || []).some(x => Math.abs(x[2]) >= 10) ? ` ${(m.stats.offList || []).filter(x => Math.abs(x[2]) >= 10).length} partners are 10 ft or more off, more than a measuring point explains; they may be different wells: ` + (m.stats.offList || []).filter(x => Math.abs(x[2]) >= 10).map(x => `${SITES[x[0]][0]} vs ${SITES[x[1]][0]} (${x[2] > 0 ? '+' : ''}${x[2]} ft)`).join(', ') + '.' : '');
  } else { const el = document.getElementById('merge-note'); if(el) el.textContent = ''; }
  SITE_MONTH = c.siteMonth; SITE_YEAR = c.siteYear;
  BOOT.finalize(SITES, SITE_YEAR);
  buildSiteMaps();
  monthFlagCache = {t:null, flags:new Map(), clean:new Map()};
  recomputeTrendAndMean();
  recomputeAllDespikeFlags();
  renderFlagsTable();
  recomputeActiveSet();
}
function readQFromControls(){
  state.readQ = {static:document.getElementById('rq-static').checked, noDisturbed:document.getElementById('rq-nodist').checked, approved:document.getElementById('rq-approved').checked, method:document.getElementById('rq-method').value, pumpHeur: !!(document.getElementById('rq-pump') && document.getElementById('rq-pump').checked)};
  applyReadingQuality();
}
['rq-static','rq-nodist','rq-approved','rq-method'].forEach(id=>document.getElementById(id).addEventListener('change', readQFromControls));
function resetReadQ(apply){
  const was = !readQDefault();
  state.readQ = {static:false, noDisturbed:false, approved:false, method:'all', pumpHeur:false};
  { const e = document.getElementById('rq-pump'); if(e) e.checked = false; }
  document.getElementById('rq-static').checked = false; document.getElementById('rq-nodist').checked = false; document.getElementById('rq-approved').checked = false; document.getElementById('rq-method').value = 'all';
  if(was && apply) applyReadingQuality();
}
(()=>{
  const fc = BOOT.info.flagCounts, pct = n => fc.total ? (100*n/fc.total).toFixed(1) + '%' : '0%';
  const el = document.getElementById('rq-hint');
  if(el && fc) el.textContent = 'Of ' + fc.total.toLocaleString() + ' readings: ' + pct(fc.static) + ' marked static, ' + pct(fc.disturbed) + ' pumping/affected, ' + pct(fc.approved) + ' approved (' + pct(fc.provisional) + ' provisional), ' + pct(fc.manual) + ' manual, ' + pct(fc.logger) + ' continuous logger. Only some agencies (mainly USGS) supply qualifiers and approval status, so "static only" and "approved only" drop everyone else’s readings.';
})();

// ---- API statistics tables (loaded in the background after the page is up) ----
const API_TABLES = [
  ['trend', 'nm_waterlevel_trends',    'source,id,slope_per_year,mk_p_value,mk_tau,span_years,trend_category,observation_count'],
  ['dens',  'nm_waterlevel_data_density', 'source,id,observations_per_year,mean_interval_days'],
  ['rec',   'nm_monitoring_recency',   'source,id,days_since_last,status'],
  ['mcl',   'nm_mcl_exceedance',       'source,id,any_exceedance,exceedance_count,exceeded_analytes,arsenic_exceeds,chloride_exceeds,fluoride_exceeds,nitrate_exceeds,sulfate_exceeds,tds_exceeds,uranium_exceeds'],
  ['wt',    'nm_water_type',           'source,id,water_type,charge_balance_pct'],
  ['hard',  'nm_hardness',             'source,id,hardness_class,hardness_caco3'],
  ['tds',   'nm_tds_summary',          'source,id,tds_class,latest_value']
];
let apiTablesPromise = null;
function ensureApiTables(){
  if(apiTablesPromise) return apiTablesPromise;
  const setMsg = t=>{ ['ws-load','wq-load'].forEach(id=>{ const e = document.getElementById(id); if(e) e.textContent = t; }); };
  setMsg('(loading from the API…)');
  let done = 0;
  apiTablesPromise = apiPool(API_TABLES.map(([name, coll, props])=>async()=>{
    try{
      const {features} = await apiFeatures(coll, {properties: props});
      const m = new Map();
      for(const f of features){ const p = f.properties || {}; const s = apiSiteIdx(p.source, p.id); if(s != null && !m.has(s)) m.set(s, p); }
      apiTables[name] = m;
    }catch(e){ console.warn('API table failed', name, e); }
    done++; setMsg('(loading from the API… ' + done + '/' + API_TABLES.length + ')');
  }), 3).then(()=>{
    fillApiSelects(); syncApiFilterControls();
    setMsg(Object.keys(apiTables).length === API_TABLES.length ? '' : '(some tables could not be loaded)');
  });
  return apiTablesPromise;
}
function fillApiSelects(){
  const fill = (id, table, field, label)=>{
    const sel = document.getElementById(id), m = apiTables[table]; if(!sel || !m) return;
    const cur = sel.value, vals = new Map();
    m.forEach(p=>{ const v = p[field]; if(v != null && v !== '') vals.set(v, (vals.get(v)||0) + 1); });
    sel.innerHTML = '<option value="">' + label + '</option>' + [...vals.entries()].sort((a,b)=>b[1]-a[1]).map(([v,n])=>'<option value="' + String(v).replace(/"/g,'&quot;') + '">' + v + ' (' + n.toLocaleString() + ')</option>').join('');
    sel.value = cur;
  };
  fill('ws-cat','trend','trend_category','Any trend category'); fill('ws-status','rec','status','Any monitoring status');
  fill('wq-type','wt','water_type','Any water type'); fill('wq-hard','hard','hardness_class','Any hardness class'); fill('wq-tds','tds','tds_class','Any TDS class');
}
function apiFilterActive(A){ return A.slopeMin!=null || A.slopeMax!=null || A.sig || A.cat || A.span!=null || A.obsYr!=null || A.recentYrs!=null || A.status || A.mcl || A.wtype || A.cb!=null || A.hard || A.tds; }
function passesApiFilters(s, A){
  if(!apiFilterActive(A)) return true;
  const t = apiTables.trend && apiTables.trend.get(s);
  if(A.slopeMin!=null || A.slopeMax!=null || A.sig || A.cat || A.span!=null){
    if(!apiTables.trend) return true;
    if(!t) return false;
    const sl = t.slope_per_year;
    if((A.slopeMin!=null || A.slopeMax!=null) && sl == null) return false;
    if(A.slopeMin!=null && sl < A.slopeMin) return false;
    if(A.slopeMax!=null && sl > A.slopeMax) return false;
    if(A.sig && !(t.mk_p_value != null && t.mk_p_value < 0.05)) return false;
    if(A.cat && t.trend_category !== A.cat) return false;
    if(A.span!=null && !(t.span_years >= A.span)) return false;
  }
  if(A.obsYr!=null && apiTables.dens){ const d = apiTables.dens.get(s); if(!d || !(d.observations_per_year >= A.obsYr)) return false; }
  if((A.recentYrs!=null || A.status) && apiTables.rec){
    const r = apiTables.rec.get(s); if(!r) return false;
    if(A.recentYrs!=null && !(r.days_since_last <= A.recentYrs*365.25)) return false;
    if(A.status && r.status !== A.status) return false;
  }
  if(A.mcl && apiTables.mcl){
    const m = apiTables.mcl.get(s); if(!m) return false;
    if(A.mcl === 'any' && !m.any_exceedance) return false;
    if(A.mcl === 'none' && m.any_exceedance) return false;
    if(A.mcl !== 'sampled' && A.mcl !== 'any' && A.mcl !== 'none' && !m[A.mcl + '_exceeds']) return false;
  }
  if((A.wtype || A.cb!=null) && apiTables.wt){
    const w = apiTables.wt.get(s); if(!w) return false;
    if(A.wtype && w.water_type !== A.wtype) return false;
    if(A.cb!=null && !(Math.abs(w.charge_balance_pct) <= A.cb)) return false;
  }
  if(A.hard && apiTables.hard){ const h = apiTables.hard.get(s); if(!h || h.hardness_class !== A.hard) return false; }
  if(A.tds && apiTables.tds){ const d = apiTables.tds.get(s); if(!d || d.tds_class !== A.tds) return false; }
  return true;
}
const API_CTRL = [['ws-slope-min','slopeMin','num'],['ws-slope-max','slopeMax','num'],['ws-sig','sig','chk'],['ws-cat','cat','sel'],['ws-span','span','num'],['ws-obsyr','obsYr','num'],['ws-recent','recentYrs','num'],['ws-status','status','sel'],['wq-mcl','mcl','sel'],['wq-type','wtype','sel'],['wq-cb','cb','num'],['wq-hard','hard','sel'],['wq-tds','tds','sel']];
API_CTRL.forEach(([id, key, kind])=>{
  const el = document.getElementById(id);
  el.addEventListener('change', async ()=>{
    const v = kind === 'chk' ? el.checked : (kind === 'num' ? (el.value === '' ? null : +el.value) : el.value);
    state.filters.api[key] = v;
    if(apiFilterActive(state.filters.api)){ await ensureApiTables(); }
    recomputeActiveSet();
  });
});
function syncApiFilterControls(){
  const A = state.filters.api;
  API_CTRL.forEach(([id, key, kind])=>{ const el = document.getElementById(id); if(!el) return; if(kind === 'chk') el.checked = !!A[key]; else el.value = A[key] == null ? '' : A[key]; });
}
function afterFilterReset(){ if(!state.readQ) return; resetReadQ(true); syncApiFilterControls(); }
// open the stats tables shortly after the page is interactive so the dropdowns are populated
// statistics tables load when the Data filters tab is first opened (or a statistics filter is used)
document.querySelector('.tab-btn[data-tab="filters"]').addEventListener('click', ()=>{ ensureApiTables().catch(e=>console.warn('API tables', e)); }, {once:true});

// ---- water-quality time series under the single-well hydrograph ----
const swChem = {chart:null, seq:0};
function swChemClear(msg){
  if(swChem.chart){ swChem.chart.destroy(); swChem.chart = null; }
  const w = document.getElementById('sw-chem-wrap'); if(w) w.style.display = 'none';
  const m = document.getElementById('sw-chem-msg'); if(m) m.textContent = msg || '';
}
async function swChemLoad(){
  const analyte = document.getElementById('sw-chem-sel').value, s = singleWell.site;
  swChemClear('');
  if(!analyte || s == null) return;
  const my = ++swChem.seq, rec = SITES[s], source = rec[3] >= 0 ? SOURCES[rec[3]] : '';
  document.getElementById('sw-chem-msg').textContent = 'Loading ' + analyte + ' from the API…';
  let feats;
  try{ feats = (await apiFeatures('nm_' + analyte + '_timeseries', {source, id: rec[0], properties:'parameter_value,parameter_units,date_measured,time_measured,qualifier'})).features; }
  catch(e){ if(my === swChem.seq) swChemClear('Could not load: ' + e.message); return; }
  if(my !== swChem.seq) return;
  const pts = []; let units = '';
  feats.forEach(f=>{
    const p = f.properties || {}, v = Number(p.parameter_value), d = p.date_measured; if(!isFinite(v) || !d) return;
    const y = +d.slice(0,4); if(!y || d > todayStr) return;
    const t = y + (Date.UTC(y, +d.slice(5,7)-1, +d.slice(8,10)) - Date.UTC(y,0,1)) / (365.25*864e5);
    pts.push({x:t, y:v}); if(p.parameter_units) units = p.parameter_units;
  });
  pts.sort((a,b)=>a.x-b.x);
  if(!pts.length){ swChemClear('No ' + analyte + ' results for this well.'); return; }
  document.getElementById('sw-chem-msg').textContent = pts.length.toLocaleString() + ' ' + analyte + ' result(s)' + (units ? ' (' + units + ')' : '');
  document.getElementById('sw-chem-wrap').style.display = 'block';
  const cs = getComputedStyle(document.body), muted = cs.getPropertyValue('--muted').trim() || '#7d8873', accent = cs.getPropertyValue('--rise').trim() || '#c1652f';
  const xs = singleWell.chart && singleWell.chart.scales && singleWell.chart.scales.x;
  swChem.chart = new Chart(document.getElementById('sw-chem-canvas').getContext('2d'), {
    type:'line', data:{datasets:[{label:analyte + (units ? ' (' + units + ')' : ''), data:pts, borderColor:accent, backgroundColor:accent, pointRadius:3, borderWidth:1.2, tension:0}]},
    options:{responsive:true, maintainAspectRatio:false, animation:false, parsing:false,
      plugins:{legend:{display:false}, tooltip:{callbacks:{title:items=>items.map(i=>decYearToLabel(i.parsed.x)), label:c=>c.parsed.y + (units ? ' ' + units : '')}}},
      scales:{x:{type:'linear', min: xs && xs.min != null ? xs.min : undefined, max: xs && xs.max != null ? xs.max : undefined, ticks:{color:muted, maxRotation:0, autoSkipPadding:14, callback:v=>decYearToLabel(v)}, grid:{color:'rgba(125,136,115,.2)'}},
              y:{beginAtZero:false, ticks:{color:muted}, grid:{color:'rgba(125,136,115,.2)'}, title:{display:true, text:analyte + (units ? ' (' + units + ')' : ''), color:muted}}}}
  });
}
document.getElementById('sw-chem-sel').addEventListener('change', swChemLoad);

// ---- shared dialog helper (used by the features in files 25-33) --------------------------------------
// hxDialog(id, title, opts) builds (once) a modal with a header (title, extra buttons, Close) and a body, and returns
// {el, body, head, open(), close()}. Escape or a click on the backdrop closes it.
var hxDialogs = {};
function hxDialog(id, title, opts){
  if(hxDialogs[id]) return hxDialogs[id];
  opts = opts || {};
  const m = document.createElement('div'); m.className = 'hx-modal hidden'; m.id = id; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', title);
  m.innerHTML = `<div class="hx-card${opts.wide ? ' wide' : ''}"><div class="hx-head"><h3>${escHtml(title)}</h3><span class="hx-head-extra"></span><button type="button" class="btn hx-close">Close</button></div><div class="hx-body"></div></div>`;
  document.body.appendChild(m);
  const d = {el: m, body: m.querySelector('.hx-body'), head: m.querySelector('.hx-head-extra'),
    open(){ m.classList.remove('hidden'); try{ m.querySelector('.hx-close').focus(); }catch(e){} },
    close(){ m.classList.add('hidden'); if(opts.onClose) opts.onClose(); },
    get isOpen(){ return !m.classList.contains('hidden'); }};
  m.querySelector('.hx-close').addEventListener('click', () => d.close());
  m.addEventListener('click', e => { if(e.target === m) d.close(); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && d.isOpen) d.close(); });
  hxDialogs[id] = d; return d;
}
function hxFmt(v, dec, plus){ if(v == null || !isFinite(v)) return '–'; const t = v.toFixed(dec == null ? 1 : dec); return (plus && v > 0 ? '+' : '') + t; }
function hxSiteLabel(s){ const r = SITES[s]; return {id: String(r[0]), src: r[3] >= 0 ? SOURCES[r[3]] : ''}; }
// the maps the composite fit uses for these wells (season halves where the fit uses them)
function hxFitMaps(wells){ const o = state.otp; return (o.method === 'fe' || o.method === 'units') ? wells.flatMap(w => w.mapSeas || [w.mapDisp]) : wells.map(otMapOf); }
function hxFirstLast(a){ let f = -1, l = -1; for(let i = 0; i < a.length; i++) if(a[i] != null){ if(f < 0) f = i; l = i; } return [f, l]; }

// ---- spread between wells: interquartile band ------------------------------------------------------------
// The bootstrap band shows how sure the median line is; this band shows how much the wells disagree. For the feet methods,
// each well's value in a year minus its own fitted level (the two-way fit) is that well's own reading of the change; the band is
// the 25th to 75th percentile of those across the wells measured that year (a well's warm- and cool-season halves are averaged
// first), drawn around the composite median. For z-scores / normal scores it is the quartiles of the wells' values.
var hxIqrCache = {key: null, val: null};
state.showIqr = false;
function hxIqrBand(result){
  const key = otKey(); if(hxIqrCache.key === key) return hxIqrCache.val;
  const o = state.otp, years = result.xvals, L = years.length, used = result.wells, med = result.medianSeries;
  const lo = new Array(L).fill(null), hi = new Array(L).fill(null), n = new Array(L).fill(0);
  const minN = Math.max(4, o.minN), yi = new Map(years.map((y, i) => [y, i]));
  const per = Array.from({length: L}, () => new Map());   // year -> site -> [sum, count]
  const add = (t, s, v) => { const a = per[t].get(s); if(a){ a[0] += v; a[1]++; } else per[t].set(s, [v, 1]); };
  let centre = null;
  if(otFeet(o.method)){
    const maps = hxFitMaps(used), fe = otFixedEffects(maps, years, 1, 0);
    maps.forEach((m, w) => { const e = fe.eff[w]; if(!isFinite(e)) return; m.forEach((v, y) => { const t = yi.get(y); if(t !== undefined && isFinite(v)) add(t, m._s, v - e); }); });
    centre = fe.med;
  } else used.forEach(w => otMapOf(w).forEach((v, y) => { const t = yi.get(y); if(t !== undefined && isFinite(v)) add(t, w.site, v); }));
  for(let t = 0; t < L; t++){
    const v = [...per[t].values()].map(a => a[0] / a[1]); n[t] = v.length;
    if(v.length < minN || med[t] == null) continue;
    const s = Float64Array.from(v).sort(), q = p => OT.quantile(s, p), c = centre ? (centre[t] == null ? OT.median(v) : centre[t]) : OT.median(v);
    lo[t] = med[t] + q(0.25) - c; hi[t] = med[t] + q(0.75) - c;
  }
  const val = {lo, hi, n, minN};
  hxIqrCache = {key, val}; return val;
}
function hxIqrDatasets(result, hexA){
  if(!state.showIqr || !result || !result.wells || !result.wells.length) return [];
  const b = hxIqrBand(result); if(!b.lo.some(v => v != null)) return [];
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#0f6e63';
  window._lastIqr = b;
  return [{label: 'Middle half of the wells (25th–75th percentile)', data: b.hi, borderWidth: 1, borderColor: hexA(accent, 0.45), borderDash: [2, 3], pointRadius: 0, backgroundColor: hexA(accent, 0.10), fill: '+1', tension: 0.15, order: 8, spanGaps: false, _show: true, _iqr: true},
    {label: 'iqr_lo', data: b.lo, borderWidth: 1, borderColor: hexA(accent, 0.45), borderDash: [2, 3], pointRadius: 0, backgroundColor: hexA(accent, 0.10), fill: false, tension: 0.15, order: 8, spanGaps: false, _iqr: true}];
}

// ---- well influence: leave each well out and see how far the composite moves ----------------------------------
var hxInf = {rows: [], sort: 'dMed', dir: -1, run: 0, done: 0, total: 0, base: null};
function hxInfInit(){
  const d = hxDialog('inf-modal', 'Which wells drive the composite?', {wide: true, onClose: () => { hxInf.run++; }});
  d.head.innerHTML = '<button type="button" class="btn" id="inf-csv">Download CSV</button>';
  d.body.innerHTML = `<div id="inf-sum" class="hx-sum"></div>
    <div class="hx-note">Each well is left out in turn and the composite is rebuilt with the same settings. <b>Change in Δ</b> is how much the composite's change from its first to its last plotted year moves without that well (ft; positive = the composite shows more decline without it, i.e. the well was pulling the line toward rising). <b>Largest shift</b> is the biggest move of the line in any single year. "Breaks" means the composite loses its first or last year without the well (it was one of too few). Click a heading to sort, a row to highlight the well, <b>Leave out</b> to drop it from the composite (undo from its map marker or with Reset).</div>
    <div class="hx-scroll"><table class="hx-table" id="inf-table"><thead><tr><th data-k="id">Well</th><th data-k="src">Source</th><th data-k="nYears">Years in composite</th><th data-k="dMed">Change in Δ, median line (ft)</th><th data-k="dMean">Change in Δ, mean line (ft)</th><th data-k="maxShift">Largest shift (ft)</th><th></th></tr></thead><tbody id="inf-body"></tbody></table></div>`;
  d.body.querySelector('#inf-table').addEventListener('click', e => {
    const b = e.target.closest('button[data-excl]');
    if(b){ const s = +b.dataset.excl; state.excludedSites.add(s); b.textContent = 'Left out'; b.disabled = true; renderChart(); try{ restyleMarkers(); }catch(err){} return; }
    const th = e.target.closest('th[data-k]');
    if(th){ if(hxInf.sort === th.dataset.k) hxInf.dir = -hxInf.dir; else { hxInf.sort = th.dataset.k; hxInf.dir = (th.dataset.k === 'id' || th.dataset.k === 'src') ? 1 : -1; } hxInfRender(); return; }
    const tr = e.target.closest('tr[data-s]'); if(tr){ state.chartHighlightSite = +tr.dataset.s; renderChart(); }
  });
  d.head.querySelector('#inf-csv').addEventListener('click', hxInfCsv);
  return d;
}
function hxInfRender(){
  const box = document.getElementById('inf-body'); if(!box) return;
  const R = hxInf.rows.slice(), k = hxInf.sort, dir = hxInf.dir, absK = ['dMed', 'dMean', 'maxShift'].includes(k);
  R.sort((a, b) => { let x = a[k], y = b[k]; if(absK){ x = a.breaks ? Infinity : Math.abs(x); y = b.breaks ? Infinity : Math.abs(y); } if(typeof x === 'string') return x.localeCompare(y, undefined, {numeric: true}) * dir; return ((isFinite(x) || x === Infinity ? x : -1) - (isFinite(y) || y === Infinity ? y : -1)) * dir; });
  box.innerHTML = R.slice(0, 1500).map(r => `<tr data-s="${r.site}"><td>${escHtml(r.id)}</td><td>${escHtml(r.src)}</td><td>${r.nYears}</td><td>${r.breaks ? '<b>breaks</b>' : hxFmt(r.dMed, 2, true)}</td><td>${r.breaks ? '–' : hxFmt(r.dMean, 2, true)}</td><td>${r.breaks ? '–' : hxFmt(r.maxShift, 2)}</td><td><button type="button" class="btn mini" data-excl="${r.site}"${state.excludedSites.has(r.site) ? ' disabled>Left out' : '>Leave out'}</button></td></tr>`).join('');
  document.querySelectorAll('#inf-table th').forEach(th => th.dataset.dir = th.dataset.k === k ? (dir > 0 ? '▲' : '▼') : '');
  const S = document.getElementById('inf-sum'), B = hxInf.base;
  if(!S || !B) return;
  const ok = hxInf.rows.filter(r => !r.breaks && isFinite(r.dMed)), top = ok.slice().sort((a, b) => Math.abs(b.dMed) - Math.abs(a.dMed))[0], nb = hxInf.rows.filter(r => r.breaks).length;
  const big = ok.filter(r => Math.abs(r.dMed) >= Math.max(1, 0.1 * Math.abs(B.dMed))).length;
  S.innerHTML = (hxInf.done < hxInf.total ? `<b>Working… ${hxInf.done.toLocaleString()} of ${hxInf.total.toLocaleString()} wells.</b> ` : '')
    + `Composite: ${B.n.toLocaleString()} wells, ${B.y0}–${B.y1}, median line Δ ${hxFmt(B.dMed, 1, true)} ft, mean line Δ ${hxFmt(B.dMean, 1, true)} ft (depth-to-water sense as charted). `
    + (top ? `Leaving out any single well moves the median line's Δ by at most <b>${Math.abs(top.dMed).toFixed(2)} ft</b> (${escHtml(top.id)}). ` : '')
    + `${big.toLocaleString()} well(s) move it by 1 ft or 10% or more` + (nb ? `; without ${nb.toLocaleString()} well(s) the composite loses its first or last year.` : '.');
}
function hxInfCsv(){
  const r2 = v => isFinite(v) ? Math.round(v * 1000) / 1000 : '';
  const rows = [['well_id', 'source', 'longitude', 'latitude', 'years_in_composite', 'change_in_first_to_last_delta_median_ft', 'change_in_first_to_last_delta_mean_ft', 'largest_single_year_shift_ft', 'composite_breaks_without_well']];
  hxInf.rows.forEach(r => { const s = SITES[r.site]; rows.push([r.id, r.src, s[1], s[2], r.nYears, r.breaks ? '' : r2(r.dMed), r.breaks ? '' : r2(r.dMean), r.breaks ? '' : r2(r.maxShift), r.breaks ? 'yes' : 'no']); });
  downloadCsv(wvCsvName().replace('hydrographs', 'well-influence'), rows);
}
async function hxInfOpen(){
  const result = computeComposite();
  if(!result || !result.wells || result.wells.length < 3){ toast('Build a composite with at least 3 wells first.'); return; }
  const d = hxInfInit(); d.open();
  const run = ++hxInf.run, o = state.otp, years = result.xvals, used = result.wells, all = hxFitMaps(used);
  const base = {med: result.medianSeries, mean: result.meanSeries};
  const [F, Lx] = hxFirstLast(base.med);
  hxInf.base = {n: used.length, y0: years[F], y1: years[Lx], dMed: base.med[Lx] - base.med[F], dMean: base.mean[Lx] - base.mean[F]};
  hxInf.rows = used.map(w => Object.assign(hxSiteLabel(w.site), {site: w.site, nYears: otMapOf(w).size, dMed: NaN, dMean: NaN, maxShift: NaN, breaks: false}));
  hxInf.done = 0; hxInf.total = used.length; hxInfRender();
  // the base line is rebuilt the same way (otCompose), so differences are not mixed up with anything else renderChart adds
  const B = otCompose(all, years, o.method, o.minN);
  const chunk = Math.max(1, Math.round(4e5 / Math.max(1, all.reduce((s, m) => s + m.size, 0))));
  let t0 = performance.now();
  for(let i = 0; i < hxInf.rows.length; i++){
    if(run !== hxInf.run) return;
    const r = hxInf.rows[i], maps = all.filter(m => m._s !== r.site), c = otCompose(maps, years, o.method, o.minN);
    if(c.med[F] == null || c.med[Lx] == null || B.med[F] == null) r.breaks = true;
    else {
      r.dMed = (c.med[Lx] - c.med[F]) - (B.med[Lx] - B.med[F]); r.dMean = (c.mean[Lx] - c.mean[F]) - (B.mean[Lx] - B.mean[F]);
      let mx = 0; for(let t = 0; t < years.length; t++) if(c.med[t] != null && B.med[t] != null){ const v = Math.abs((c.med[t] - c.med[F]) - (B.med[t] - B.med[F])); if(v > mx) mx = v; }
      r.maxShift = mx;
    }
    hxInf.done = i + 1;
    if(i % chunk === chunk - 1 || performance.now() - t0 > 120){ hxInfRender(); await new Promise(res => setTimeout(res, 0)); t0 = performance.now(); }
  }
  hxInfRender();
}
function hxCompExtrasInit(){
  const band = document.getElementById('toggle-band'), row = band && band.closest('.toggle-row');
  if(row && !document.getElementById('toggle-iqr')){
    const r = document.createElement('div'); r.className = 'toggle-row comp-only';
    r.innerHTML = '<span class="tlabel">Show the spread between wells<br><span style="color:var(--muted); font-size:11px;">(middle half of the wells, 25th–75th percentile)</span></span><label class="switch" for="toggle-iqr"><input type="checkbox" id="toggle-iqr"><span class="track"></span></label>';
    row.after(r);
    r.querySelector('input').addEventListener('change', e => { state.showIqr = e.target.checked; renderChart(); });
  }
}
hxCompExtrasInit();
document.getElementById('btn-influence').addEventListener('click', hxInfOpen);

// ---- vertical datum: NGVD 1929 site elevations converted to NAVD 1988 ------------------------------------
// About 17,000 USGS wells (and a few NMBGMR wells) give their land-surface elevation in NGVD 1929, the rest (and USGS 3DEP)
// in NAVD 1988. In New Mexico NAVD 88 is 0.5 to 6 ft higher than NGVD 29, so mixing them puts wells several feet apart in
// elevation mode for no physical reason. The shift below is NOAA's VERTCON 3 (NCAT service, geodesy.noaa.gov/api/ncat),
// sampled on a 0.25-degree grid over the state (31-37.5 N, 109.5-102.25 W, values in 0.01 ft, sampled 2026-11-09) and
// interpolated bilinearly; within a cell the grid differs from VERTCON by a few tenths of a foot at most. Each well's datum
// comes from nm-site-metadata.json (the site table next to the page), loaded the first time elevation mode is used.
var HX_VC = {lat0: 31.0, lon0: -109.5, step: 0.25, ny: 27, nx: 30, v: [265,252,309,262,248,239,235,238,222,212,206,203,203,203,202,196,176,185,182,178,166,179,151,96,92,105,109,92,77,75,267,256,272,295,250,240,228,234,206,200,196,193,189,199,209,189,189,192,215,162,173,143,127,101,48,86,94,86,81,114,258,271,309,300,248,235,227,212,199,193,192,183,182,180,192,219,204,179,199,163,170,147,136,113,95,111,102,99,105,119,240,292,280,268,247,254,235,207,190,189,185,181,157,202,215,224,194,171,176,210,180,162,153,142,139,129,116,117,128,125,235,253,242,253,256,262,234,209,180,206,190,193,182,204,242,225,216,166,170,212,179,165,151,159,158,137,131,138,137,115,158,191,267,263,248,253,236,216,202,200,205,173,203,194,203,220,188,195,195,213,179,166,157,171,169,139,131,133,143,124,187,216,240,252,304,278,259,275,228,240,193,192,213,192,186,216,231,222,236,186,169,156,162,162,158,126,111,122,119,116,208,242,230,252,290,293,277,307,235,194,201,196,192,190,203,319,252,233,201,175,158,157,152,157,156,126,108,102,97,102,252,242,307,298,273,312,314,327,244,234,201,224,195,195,210,295,259,225,211,182,178,160,159,172,159,134,123,119,107,108,245,271,280,337,350,281,338,310,248,225,211,252,212,205,228,290,250,231,218,191,188,158,156,175,158,150,136,136,127,119,289,306,287,322,352,334,317,315,268,248,221,213,237,212,225,306,244,238,208,190,161,178,173,181,171,157,148,134,130,127,358,362,324,283,374,307,336,320,341,262,231,217,232,261,238,252,242,244,228,201,183,187,199,202,187,169,154,147,141,140,399,355,371,334,343,350,300,289,312,319,254,251,228,262,265,260,280,250,236,222,198,191,204,203,194,170,171,168,155,155,381,295,329,312,321,326,333,323,334,275,258,252,261,282,277,305,273,254,249,226,210,194,209,195,178,179,185,187,174,161,282,297,286,296,303,333,342,312,284,297,280,239,262,291,267,279,274,255,248,235,219,201,204,206,204,206,194,179,170,160,295,286,314,326,330,349,347,368,315,325,289,248,267,289,279,276,271,263,242,233,217,231,238,227,214,210,198,186,179,170,327,323,301,335,345,349,392,361,330,286,282,272,265,294,286,325,303,280,254,241,234,242,215,205,201,193,198,188,180,169,309,308,331,343,357,390,335,378,419,333,275,293,299,305,327,329,304,268,245,250,226,220,224,193,195,190,175,186,175,172,326,345,317,318,329,393,370,383,356,342,317,299,326,301,330,339,313,305,307,296,243,209,210,211,195,186,173,160,166,154,316,355,347,297,316,344,351,369,346,330,335,327,385,344,351,399,394,346,316,287,265,243,236,208,217,207,195,176,174,184,290,351,345,355,302,315,332,338,344,356,355,371,435,371,330,420,485,364,336,307,276,266,249,224,223,220,216,191,183,181,302,342,400,307,307,317,337,355,352,364,375,406,344,362,339,382,434,425,364,285,272,258,269,254,250,237,220,198,184,170,290,363,407,318,311,352,344,335,337,366,411,411,417,456,390,381,480,408,320,297,282,317,301,280,273,246,219,191,166,160,325,360,322,298,296,310,328,340,375,409,441,457,456,498,430,415,479,470,384,336,310,340,336,304,277,251,229,192,120,152,312,305,292,299,340,366,386,400,403,400,464,477,517,509,423,404,432,530,447,385,362,360,342,318,337,249,219,201,193,154,313,302,320,355,406,411,421,432,448,452,448,504,540,457,412,397,423,512,436,392,335,338,289,286,292,268,245,218,194,158,338,324,357,388,401,455,495,474,523,466,606,561,556,459,407,395,453,449,388,358,324,298,284,242,246,247,237,216,189,156]};
function hxVertconFt(lon, lat){
  const G = HX_VC, fy = (lat - G.lat0) / G.step, fx = (lon - G.lon0) / G.step;
  const y0 = Math.max(0, Math.min(G.ny - 2, Math.floor(fy))), x0 = Math.max(0, Math.min(G.nx - 2, Math.floor(fx)));
  const ty = Math.max(0, Math.min(1, fy - y0)), tx = Math.max(0, Math.min(1, fx - x0)), at = (y, x) => G.v[y * G.nx + x] / 100;
  return (1 - ty) * ((1 - tx) * at(y0, x0) + tx * at(y0, x0 + 1)) + ty * ((1 - tx) * at(y0 + 1, x0) + tx * at(y0 + 1, x0 + 1));
}
var hxDatum = {on: true, loaded: false, p: null, of: null, shifted: 0, ngvd: 0, navd: 0, unknown: 0, orig: null, note: ''};
async function hxDatumLoad(){
  if(hxDatum.p) return hxDatum.p;
  hxDatum.p = (async () => {
    const meta = await rawEnsureLoaded();
    if(!meta || !meta.R || !meta.R.sites){ hxDatum.note = 'The site table (nm-site-metadata.json) is not next to the page, so vertical datums are unknown and site elevations are used as given.'; return false; }
    const hd = parseCsv(meta.R.sites_header.replace(/\r$/, ''))[0] || [], iD = hd.indexOf('vertical_datum');
    if(!meta.sitesLines) meta.sitesLines = rawInflate(meta.R.sites).split('\n');
    const byKey = new Map();
    meta.sitesLines.forEach(l => { if(!l) return; const f = parseCsv(l.replace(/\r$/, ''))[0] || []; byKey.set(f[0] + '\u0001' + f[1], String(f[iD] || '').trim().toUpperCase()); });
    hxDatum.of = new Array(NSITES);
    for(let s = 0; s < NSITES; s++) hxDatum.of[s] = byKey.get(rawWellKey(s)) || '';
    hxDatum.orig = Float32Array.from(siteElevApi);
    hxDatum.loaded = true; return true;
  })();
  return hxDatum.p;
}
// sets siteElevApi from the original values, shifted where the datum is NGVD 29 and the option is on; returns true if anything changed
function hxDatumApply(){
  if(!hxDatum.loaded) return false;
  let shifted = 0, ngvd = 0, navd = 0, unk = 0, changed = false;
  for(let s = 0; s < NSITES; s++){
    const e0 = hxDatum.orig[s]; if(isNaN(e0)) continue;
    const dt = hxDatum.of[s]; let e = e0;
    if(/NGVD/.test(dt)){ ngvd++; const r = SITES[s]; if(hxDatum.on && r[1] != null && r[2] != null){ e = e0 + hxVertconFt(r[1], r[2]); shifted++; } }
    else if(/NAVD/.test(dt)) navd++; else unk++;
    if(siteElevApi[s] !== e){ siteElevApi[s] = e; changed = true; }
  }
  Object.assign(hxDatum, {shifted, ngvd, navd, unknown: unk});
  return changed;
}
function hxDatumStatus(){
  const el = document.getElementById('datum-status'); if(!el) return;
  if(!hxDatum.loaded){ el.textContent = hxDatum.note || 'Vertical datums load the first time elevation mode is used.'; return; }
  el.textContent = `Site elevations: ${hxDatum.navd.toLocaleString()} wells in NAVD 88, ${hxDatum.ngvd.toLocaleString()} in NGVD 29` + (hxDatum.on ? ` (raised to NAVD 88 by VERTCON, +0.5 to +6 ft)` : ' (used as given)') + `, ${hxDatum.unknown.toLocaleString()} with no datum recorded (used as given). 3DEP elevations are NAVD 88.`;
}
async function hxDatumEnsure(){
  if(state.valueMode !== 'elevation') return;
  const ok = await hxDatumLoad();
  if(ok && hxDatumApply()){ demApply(); renderChart(); if(state.activeSet && state.activeSet.size) demCheck([...state.activeSet]); }
  hxDatumStatus();
}
function hxDatumInit(){
  const row = document.getElementById('dem-row'); if(!row || document.getElementById('datum-fix')) return;
  const w = document.createElement('div'); w.style.margin = '8px 0 0';
  w.innerHTML = '<label style="display:flex; gap:6px; align-items:flex-start; font-size:12px;"><input type="checkbox" id="datum-fix" checked style="margin-top:2px;"> Convert NGVD 1929 site elevations to NAVD 1988 (NOAA VERTCON), so all wells and 3DEP share one datum</label><p class="hint" id="datum-status" style="margin-top:2px;"></p>';
  row.appendChild(w);
  w.querySelector('#datum-fix').addEventListener('change', e => { hxDatum.on = e.target.checked; if(hxDatumApply()){ demApply(); renderChart(); if(state.activeSet && state.activeSet.size) demCheck([...state.activeSet]); } hxDatumStatus(); });
  document.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => { hxDatumEnsure(); }));
  hxDatumStatus();
}
hxDatumInit();
window.__hx = Object.assign(window.__hx || {}, {get datum(){ return hxDatum; }});

// ---- pumping effects that the qualifiers miss ---------------------------------------------------------------
// Pumping qualifiers come almost entirely from USGS, so other agencies' readings taken while a well (or its neighbour) was
// pumping get through. Two tools:
//  A. Reading quality > "Leave out readings far below the well's usual winter level": a reading is marked when its depth to
//     water is more than T ft (and more than 4 robust SDs) deeper than the median of that well's winter readings (Nov-Mar) in
//     the five years around it. Winter levels are the least affected by pumping; readings already qualified as pumped are left
//     to the existing "Exclude pumping / affected readings" option. Wells with fewer than 3 winter readings in that window are
//     not tested.
//  B. Data filters > "Production wells (OSE well records)": each selected well is matched to its own OSE point of diversion
//     (OSE W2W well PODs) by location and depth, and its permitted use decides whether it is a production well.

// ---- A. likely pumped readings --------------------------------------------------------------------------------
var hxPump = {mark: null, sub: null, n: 0, wells: 0, thr: 25, key: null};
function hxPumpCompute(thr){
  const R = BOOT.raw; if(!R) return;
  const key = R.n + '|' + thr; if(hxPump.key === key) return;
  const mark = new Uint8Array(R.n), nS = R.off.length - 1, T = thr * 100;
  let cnt = 0, wells = 0;
  const sub = {mon: new Map(), yr: new Map()};
  for(let s = 0; s < nS; s++){
    const a = R.off[s], b = R.off[s + 1]; if(b - a < 4) continue;
    const win = new Map();   // winter year (Nov-Dec count toward the next year) -> depths (0.01 ft)
    for(let i = a; i < b; i++){ const di = wvDayInfo(R.day[i]), m = di.month; if(m >= 11 || m <= 3){ const Y = m >= 11 ? di.year + 1 : di.year; let L = win.get(Y); if(!L){ L = []; win.set(Y, L); } L.push(R.v[i]); } }
    if(!win.size) continue;
    const stats = new Map(); let hit = false;
    for(let i = a; i < b; i++){
      if(R.fl[i] & 2) continue;
      const di = wvDayInfo(R.day[i]), y = di.year;
      let st = stats.get(y);
      if(st === undefined){
        const pool = []; for(let k = y - 2; k <= y + 2; k++){ const L = win.get(k); if(L) for(const v of L) pool.push(v); }
        if(pool.length >= 3){ const sorted = Float64Array.from(pool).sort(), med = OT.quantile(sorted, 0.5);
          const dev = Float64Array.from(pool, v => Math.abs(v - med)).sort(); st = {med, sd: 1.4826 * OT.quantile(dev, 0.5)}; } else st = null;
        stats.set(y, st);
      }
      if(!st) continue;
      if(R.v[i] - st.med > Math.max(T, 4 * st.sd)){
        mark[i] = 1; cnt++; hit = true;
        const v = R.v[i] / 100, fl = R.fl[i], mk = (s * 100000 + y * 12 + di.month - 1) * 64 + fl, yk = (s * 10000 + y) * 64 + fl;
        let m1 = sub.mon.get(mk); if(!m1){ m1 = [0, 0]; sub.mon.set(mk, m1); } m1[0] += v; m1[1]++;
        let y1 = sub.yr.get(yk); if(!y1){ y1 = [0, 0]; sub.yr.set(yk, y1); } y1[0] += v; y1[1]++;
      }
    }
    if(hit) wells++;
  }
  Object.assign(hxPump, {mark, sub, n: cnt, wells, thr, key});
}
function hxPumpSub(){ return (state.readQ && state.readQ.pumpHeur && typeof hxPump !== 'undefined' && hxPump && hxPump.sub) ? hxPump.sub : null; }
function hxPumpNote(){
  const el = document.getElementById('rq-pump-note'); if(!el) return;
  el.textContent = hxPump.mark ? `${hxPump.n.toLocaleString()} readings at ${hxPump.wells.toLocaleString()} wells are more than ${hxPump.thr} ft below the well's usual winter level` + (state.readQ.pumpHeur ? ' and are left out.' : ' (not left out while this is off).')
    : 'Marks readings more than the chosen depth below the median of the well\'s winter readings (Nov–Mar) in the five years around them; winter levels are the least affected by pumping. Readings already qualified as pumped are handled by the option above. Wells with fewer than 3 winter readings in that window are not tested.';
}
function hxPumpInit(){
  const nd = document.getElementById('rq-nodist'); if(!nd || document.getElementById('rq-pump')) return;
  const row = nd.closest('.row'), w = document.createElement('div');
  w.innerHTML = '<div class="row"><label><input type="checkbox" id="rq-pump"> Leave out readings far below the well\'s usual winter level (likely pumped)</label></div>'
    + '<div class="numrow" style="margin:2px 0 0 22px;"><label style="flex:1; font-size:12px; color:var(--ink-2);" for="rq-pump-thr">More than</label><select class="selfield" id="rq-pump-thr" style="width:auto;"><option value="10">10 ft</option><option value="25" selected>25 ft</option><option value="50">50 ft</option><option value="100">100 ft</option></select><span style="font-size:12px; color:var(--ink-2);">below</span></div>'
    + '<p class="hint" id="rq-pump-note" style="margin:2px 0 6px 22px;"></p>';
  row.after(w);
  const go = () => { const on = document.getElementById('rq-pump').checked, thr = +document.getElementById('rq-pump-thr').value;
    if(on) hxPumpCompute(thr); readQFromControls(); hxPumpNote(); };
  document.getElementById('rq-pump').addEventListener('change', go);
  document.getElementById('rq-pump-thr').addEventListener('change', () => { if(document.getElementById('rq-pump').checked) go(); else { hxPumpCompute(+document.getElementById('rq-pump-thr').value); hxPumpNote(); } });
  hxPumpNote();
}

// ---- B. production wells (OSE W2W well PODs) -----------------------------------------------------------------
var HX_POD_URL = 'https://gis.ose.nm.gov/server_s/rest/services/PODS/W2W_Well_PODs/MapServer/0/query';
// permitted uses that mean a high-capacity, regularly pumped well (OSE use codes): irrigation, municipal, industrial,
// commercial, mining, public supply, mutual domestic water association, oil production and secondary recovery, dairy,
// utility, subdivision, school, mobile-home park, pollution recovery (pump and treat), dewatering
var HX_PROD_USES = ['IRR', 'MUN', 'IND', 'COM', 'MIN', 'PUB', 'MDW', 'OIL', 'SRO', 'DAI', 'UTL', 'SUB', 'SCH', 'MOB', 'PMH', 'POL', 'DEW'];
var HX_POD_KM = 0.04, HX_POD_LOC_KM = 0.015;
var hxProd = {by: new Map(), checked: new Set(), pending: new Set(), dropped: new Set(), genOpen: false, busy: false, timer: null, cacheLoaded: false, failed: 0, asked: 0};
function hxPodIsProd(use){ return String(use || '').toUpperCase().split(/[^A-Z]+/).some(c => HX_PROD_USES.includes(c)); }
function hxProdPass(s, mode){
  if(!hxProd || !hxProd.checked) return true;
  // one recompute of the active set runs synchronously, so a microtask marks where the next one starts
  if(!hxProd.genOpen){ hxProd.genOpen = true; hxProd.dropped = new Set(); queueMicrotask(() => { hxProd.genOpen = false; }); }
  if(!hxProd.checked.has(s)){
    if(state.areaSelection || state.clickSelectedSites.size){ hxProd.pending.add(s); hxProdSchedule(); }
    return true;   // not looked up yet: kept until it is
  }
  const m = hxProd.by.get(s), prod = !!(m && m.prod), pass = mode === 'onlyProd' ? prod : !prod;
  if(!pass) hxProd.dropped.add(s);
  return pass;
}
function hxProdSchedule(){ if(hxProd.timer || hxProd.busy) return; hxProd.timer = setTimeout(() => { hxProd.timer = null; hxProdRunPending(); }, 60); }
async function hxProdRunPending(){
  if(hxProd.busy || !hxProd.pending.size) return;
  const sites = [...hxProd.pending]; hxProd.pending.clear();
  await hxProdLookup(sites);
  recomputeActiveSet(); hxProdStatus();
}
async function hxProdCacheLoad(){
  if(hxProd.cacheLoaded) return; hxProd.cacheLoaded = true;
  try{ const c = await idbGet('osePods2'); if(c && c.v && Date.now() - (c.savedAt || 0) < 90 * 864e5){ const idx = new Map(); for(let s = 0; s < NSITES; s++) idx.set(rawWellKey(s), s);
    Object.entries(c.v).forEach(([k, m]) => { const s = idx.get(k); if(s == null) return; hxProd.checked.add(s); if(m) hxProd.by.set(s, m); }); } }catch(e){}
}
async function hxProdCacheSave(){
  const v = {}; hxProd.checked.forEach(s => { v[rawWellKey(s)] = hxProd.by.get(s) || 0; });
  try{ await idbSet('osePods2', {v, savedAt: Date.now()}); }catch(e){}
}
// the well's own POD: within 40 m and the same depth (within 25 ft or 15%); without depths, the only precisely located POD within 15 m
function hxPodMatch(s, pods){
  const r = SITES[s], depth = r[4], cx = Math.cos(r[2] * Math.PI / 180), km = p => Math.hypot((p.x - r[1]) * 111.32 * cx, (p.y - r[2]) * 110.57);
  const near = pods.map(p => Object.assign({km: km(p)}, p)).filter(p => p.km <= HX_POD_KM).sort((a, b) => a.km - b.km);
  if(!near.length) return null;
  if(depth != null && depth > 0){
    const ok = near.filter(p => p.depth != null && p.depth > 0 && Math.abs(p.depth - depth) <= Math.max(25, 0.15 * Math.max(p.depth, depth)));
    if(ok.length) return Object.assign(ok[0], {how: 'location and depth'});
    if(near.some(p => p.depth != null && p.depth > 0)) return null;   // PODs here, but of other depths: other wells
  }
  const loc = near.filter(p => p.km <= HX_POD_LOC_KM && !p.plss);
  return loc.length === 1 ? Object.assign(loc[0], {how: 'location only'}) : null;
}
// screen depths are text in the OSE layer ("155", sometimes "155 " or empty); keep a positive number only
function hxPerfFt(v){ const x = parseFloat(v); return isFinite(x) && x > 0 ? x : null; }
async function hxProdLookup(sites){
  await hxProdCacheLoad();
  const todo = sites.filter(s => !hxProd.checked.has(s) && SITES[s][1] != null && SITES[s][2] != null);
  if(!todo.length){ hxProdStatus(); return; }
  hxProd.busy = true; hxProd.asked += todo.length; let done = 0;
  const B = []; for(let i = 0; i < todo.length; i += 60) B.push(todo.slice(i, i + 60));
  hxProdStatus(`Looking up OSE well records… 0 of ${todo.length.toLocaleString()}`);
  await apiPool(B.map(batch => async () => {
    const body = new URLSearchParams({geometry: JSON.stringify({points: batch.map(s => [SITES[s][1], SITES[s][2]]), spatialReference: {wkid: 4326}}),
      geometryType: 'esriGeometryMultipoint', inSR: '4326', distance: String(HX_POD_KM * 1000), units: 'esriSRUnit_Meter', spatialRel: 'esriSpatialRelIntersects',
      outFields: 'POD,Use,WellDepth_ft,Total_POD_Div_AFY,PODStatus,PLSS_Located,Metered,PERF_Top_fbgs,PERF_Bot_fbgs', returnGeometry: 'true', outSR: '4326', orderByFields: 'OBJECTID', f: 'json'});
    const pods = []; let ok = false;
    for(let off = 0, guard = 0; guard < 20; guard++){
      body.set('resultOffset', String(off)); let j = null;
      for(let t = 0; t < 3 && !j; t++){ try{ const r = await fetch(HX_POD_URL, {method: 'POST', body}); if(r.ok){ const x = await r.json(); if(!x.error) j = x; } }catch(e){} if(!j) await new Promise(res => setTimeout(res, 800 * (t + 1))); }
      if(!j) break;
      (j.features || []).forEach(f => { const a = f.attributes || {}, g = f.geometry || {}; pods.push({pod: a.POD, use: a.Use || '', depth: a.WellDepth_ft, div: a.Total_POD_Div_AFY, status: a.PODStatus || '', plss: a.PLSS_Located === 1, metered: a.Metered === 1, ptop: hxPerfFt(a.PERF_Top_fbgs), pbot: hxPerfFt(a.PERF_Bot_fbgs), x: g.x, y: g.y}); });
      if(!j.exceededTransferLimit){ ok = true; break; }
      off += (j.features || []).length || 1000;
    }
    if(!ok){ hxProd.failed += batch.length; }
    else batch.forEach(s => { const m = hxPodMatch(s, pods); hxProd.checked.add(s);
      if(m) hxProd.by.set(s, {pod: m.pod, use: m.use, depth: m.depth, div: m.div, status: m.status, km: Math.round(m.km * 1000), how: m.how, prod: hxPodIsProd(m.use), ptop: m.ptop, pbot: m.pbot}); else hxProd.by.delete(s); });
    done += batch.length; hxProdStatus(`Looking up OSE well records… ${done.toLocaleString()} of ${todo.length.toLocaleString()}`);
  }), 3);
  hxProd.busy = false; hxProdCacheSave(); hxProdStatus();
}
function hxProdStatus(msg){
  const el = document.getElementById('prod-status'); if(!el) return;
  if(msg){ el.textContent = msg; return; }
  const set = state.activeSet || new Set(), sel = state.filters.prod && state.filters.prod !== 'all' ? [...set, ...hxProd.dropped] : [...set];
  let chk = 0, mat = 0, prod = 0; sel.forEach(s => { if(hxProd.checked.has(s)){ chk++; const m = hxProd.by.get(s); if(m){ mat++; if(m.prod) prod++; } } });
  el.textContent = !hxProd.checked.size ? 'Matches each selected well to its own OSE point of diversion (W2W well PODs: within 40 m and the same depth, or the only precisely located POD within 15 m) and reads its permitted use. Production uses: ' + HX_PROD_USES.join(', ') + '. Wells with no matching POD count as not production.'
    : `${chk.toLocaleString()} wells looked up: ${mat.toLocaleString()} matched an OSE well record, ${prod.toLocaleString()} of them permitted for production use (${HX_PROD_USES.slice(0, 6).join(', ')} …).` + (hxProd.failed ? ` ${hxProd.failed.toLocaleString()} could not be looked up (OSE service unreachable).` : '');
}
function hxProdPopup(s){
  if(typeof hxProd === 'undefined' || !hxProd || !hxProd.by) return '';
  const m = hxProd.by.get(s); if(!m) return hxProd.checked && hxProd.checked.has(s) ? '<div class="kv"><span>OSE well record</span><span>no matching POD</span></div>' : '';
  return `<div class="kv"><span>OSE well record</span><span>${escHtml(m.pod)} · use ${escHtml(m.use || '?')}${m.prod ? ' <span class="hx-badge">production</span>' : ''}${m.div != null ? ' · ' + (+m.div).toLocaleString() + ' AF/yr' : ''}${m.ptop > 0 ? ' · screened ' + m.ptop + (m.pbot > 0 ? '–' + m.pbot : '') + ' ft' : ''}</span></div>`;
}
function hxProdInit(){
  const rq = document.getElementById('sec-readq'); if(!rq || document.getElementById('sec-prod')) return;
  const sec = document.createElement('div'); sec.className = 'section'; sec.id = 'sec-prod';
  sec.innerHTML = '<h4>Production wells (OSE well records)</h4><select class="selfield" id="prod-filter"><option value="all">All wells</option><option value="noProd">Leave out production wells</option><option value="onlyProd">Only production wells</option></select>'
    + '<button type="button" class="btn" id="btn-prod-check" style="margin-top:6px; padding:4px 10px; font-size:12px;">Look up the selected wells now</button><p class="hint" id="prod-status"></p>';
  rq.before(sec);
  document.getElementById('prod-filter').addEventListener('change', async e => {
    state.filters.prod = e.target.value;
    if(state.filters.prod !== 'all' && state.activeSet && (state.areaSelection || state.clickSelectedSites.size)) await hxProdLookup([...state.activeSet, ...hxProd.dropped]);
    recomputeActiveSet(); hxProdStatus();
  });
  document.getElementById('btn-prod-check').addEventListener('click', async () => {
    if(!(state.areaSelection || state.clickSelectedSites.size) || !state.activeSet){ toast('Choose an area or wells first.'); return; }
    await hxProdLookup([...state.activeSet, ...hxProd.dropped]); recomputeActiveSet(); hxProdStatus();
  });
  hxProdStatus();
}
hxPumpInit(); hxProdInit();
window.__hx = Object.assign(window.__hx || {}, {get pump(){ return hxPump; }, get prod(){ return hxProd; }});

// ---- data-issues report -------------------------------------------------------------------------------------
// One CSV of the problems the tool finds in the data, for the API maintainers: links between wells that cannot be the same well
// (too far apart, very different depths, one well linked to several nested wells, merged partners whose readings are far off),
// site elevations far from USGS 3DEP, readings dated in the future (asked of the API, since the loader drops them) or before
// 1900, readings deeper than the well, likely data-entry errors (the bad-reading detector), likely pumped readings (when that
// option has been computed) and wells placed outside New Mexico. Whole state, or only the selected wells.
function hxIssueRow(type, severity, s, o, detail, value, date){
  const r = SITES[s], q = o != null ? SITES[o] : null;
  return [type, severity, r[3] >= 0 ? SOURCES[r[3]] : '', r[0], q ? (q[3] >= 0 ? SOURCES[q[3]] : '') : '', q ? q[0] : '', detail, value == null ? '' : value, date || '', r[1], r[2]];
}
async function hxIssuesBuild(only){
  const inScope = s => !only || only.has(s), rows = [], seenPair = new Set(), r1 = v => Math.round(v * 10) / 10;
  const pair = (a, b, t) => { const k = t + ':' + Math.min(a, b) + ':' + Math.max(a, b); if(seenPair.has(k)) return false; seenPair.add(k); return true; };
  // 1. links between wells more than 1 km apart (ignored by the tool)
  linkRejected.forEach(([a, b, km]) => { if((inScope(a) || inScope(b)) && pair(a, b, 'far')) rows.push(hxIssueRow('link_wells_too_far_apart', 'high', a, b, 'linked as the same well but ' + km.toFixed(2) + ' km apart; the tool ignores this link', r1(km), '')); });
  // 2. linked wells with very different depths (nested or neighbouring wells merged as one)
  const linked = new Map();
  for(let s = 0; s < NSITES; s++){ const P = linkedPartners(s); if(P && P.length) linked.set(s, P); }
  linked.forEach((P, s) => P.forEach(o => {
    if(!(inScope(s) || inScope(o)) || o === s) return;
    const d1 = SITES[s][4], d2 = SITES[o][4];
    if(d1 > 0 && d2 > 0 && Math.abs(d1 - d2) > Math.max(50, 0.25 * Math.max(d1, d2)) && pair(s, o, 'depth'))
      rows.push(hxIssueRow('linked_wells_different_depths', 'high', s, o, `linked as the same well but well depths are ${d1} and ${d2} ft: probably nested or neighbouring wells, not one well`, Math.abs(d1 - d2), ''));
  }));
  // 3. one well linked to two or more wells that share one spot (nested wells at one agency)
  linked.forEach((P, s) => {
    if(!inScope(s)) return;
    const byNest = new Map(); P.forEach(o => { const g = nestedGroups.get(o); if(g && SITES[o][3] !== SITES[s][3]){ const k = g[0] + ':' + SITES[o][3]; if(!byNest.has(k)) byNest.set(k, []); byNest.get(k).push(o); } });
    byNest.forEach(L => { if(L.length > 1 && pair(s, L[0], 'nest')) rows.push(hxIssueRow('linked_to_several_nested_wells', 'high', s, L[0], `linked to ${L.length} wells at the same location (${L.map(o => SITES[o][0]).join(', ')}), which are separate screened intervals; their readings get merged into one record`, L.length, '')); });
  });
  // 4. merged partners reading 10 ft or more off the kept well in months both measured
  (window._mergeOffsets || []).forEach(m => {
    if(Math.abs(m.offset_ft) < 10) return;
    const a = SITES.findIndex(r => r[0] === m.partner), b = SITES.findIndex(r => r[0] === m.kept); if(a < 0 || b < 0 || !(inScope(a) || inScope(b))) return;
    rows.push(hxIssueRow('linked_wells_readings_disagree', 'medium', a, b, `in ${m.months} months both measured, this well reads ${m.offset_ft > 0 ? '+' : ''}${m.offset_ft} ft from the well it is merged into: more than a measuring-point difference, possibly different wells`, m.offset_ft, ''));
  });
  // 5. site elevation vs USGS 3DEP (wells whose 3DEP value is in this browser's cache)
  await demLoadCache();
  let demChecked = 0;
  for(let s = 0; s < NSITES; s++){
    if(!inScope(s) || isNaN(siteElevApi[s]) || isNaN(siteDem[s])) continue; demChecked++;
    const d = siteElevApi[s] - siteDem[s]; if(Math.abs(d) > ELEV_FLAG_FT) rows.push(hxIssueRow('site_elevation_far_from_3dep', 'medium', s, null, `site elevation ${Math.round(siteElevApi[s])} ft vs 3DEP land surface ${Math.round(siteDem[s])} ft: wrong location or elevation`, Math.round(d), ''));
  }
  // 6. impossible dates, asked of the API (the loader drops these readings, so they are not in the browser)
  let dateNote = '';
  try{
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const ask = q => apiFeatures('nm_waterlevels_timeseries', Object.assign({properties: 'source,id,date_measured,parameter_value,parameter_name'}, q)).then(r => r.features, () => null);
    const fut = await ask({datetime: tomorrow + 'T00:00:00Z/..'});
    if(fut == null) dateNote = 'the API could not be asked for readings dated in the future';
    (fut || []).forEach(f => { const p = f.properties || {}, s = apiSiteIdx(p.source, p.id); if(s == null || !inScope(s)) return;
      rows.push(hxIssueRow('reading_dated_in_future', 'high', s, null, `depth to water ${p.parameter_value} ft dated ${p.date_measured}: probably a typo in the date (the tool leaves it out)`, p.parameter_value, p.date_measured)); });
  }catch(e){ dateNote = 'the API could not be asked for readings dated in the future'; }
  // the API's time range starts in 1900, so earlier dates are looked for among the loaded readings
  if(BOOT.raw){ const R = BOOT.raw, cut = rawDayOf('1900-01-01');
    for(let s = 0; s < R.off.length - 1; s++){ if(!inScope(s)) continue; for(let i = R.off[s]; i < R.off[s + 1] && R.day[i] < cut; i++)
      rows.push(hxIssueRow('reading_dated_before_1900', 'medium', s, null, `depth to water ${R.v[i] / 100} ft dated ${rawDateOf(R.day[i])}: before the API's own time range (1900 on); check the date`, R.v[i] / 100, rawDateOf(R.day[i]))); } }
  // 7. readings deeper than the well
  for(let s = 0; s < NSITES; s++){
    if(!inScope(s)) continue; const r = SITES[s], d = r[4], mx = r[9];
    if(d > 0 && mx != null && mx > d + 5) rows.push(hxIssueRow('depth_to_water_below_well_bottom', 'medium', s, null, `deepest reading ${mx} ft is below the recorded well depth of ${d} ft: wrong depth, wrong reading or wrong units`, r1(mx - d), ''));
    if(r[1] == null || r[2] == null || r[1] < -109.1 || r[1] > -102.9 || r[2] < 31.3 || r[2] > 37.05) rows.push(hxIssueRow('location_outside_new_mexico', 'medium', s, null, r[1] == null ? 'no coordinates' : `coordinates ${r[2]}, ${r[1]} are outside New Mexico`, '', ''));
  }
  // 8. likely data-entry errors (the bad-reading detector, as currently set)
  let flagRows = 0;
  (typeof allDespikeFlags !== 'undefined' ? allDespikeFlags : []).forEach(f => { if(!inScope(f.site)) return; flagRows++;
    rows.push(hxIssueRow('likely_data_entry_error', 'low', f.site, null, `${f.level === 'month' ? 'monthly' : 'yearly'} value ${f.avg.toFixed(2)} ft (${f.n} reading(s)) where its neighbours suggest about ${f.expected != null ? f.expected.toFixed(1) : '?'} ft`, Math.round(f.avg * 100) / 100, f.year + (f.month ? '-' + String(f.month).padStart(2, '0') : ''))); });
  // 9. likely pumped readings without a pumping qualifier (when computed)
  if(hxPump && hxPump.mark && BOOT.raw){
    const R = BOOT.raw;
    for(let s = 0; s < R.off.length - 1; s++){ if(!inScope(s)) continue; let n = 0, first = null;
      for(let i = R.off[s]; i < R.off[s + 1]; i++) if(hxPump.mark[i]){ n++; if(!first) first = rawDateOf(R.day[i]); }
      if(n) rows.push(hxIssueRow('likely_pumped_reading_not_qualified', 'low', s, null, `${n} reading(s) more than ${hxPump.thr} ft below the well's usual winter level, with no pumping qualifier`, n, first)); }
  }
  // 10. well far off the regional water table and off its neighbours (file 34): a wrong elevation, location or depth, or a
  // well in a confined, perched or deeper unit than the wells around it. Both conditions, so the map's own local error is not flagged.
  let wtRows = 0;
  if(typeof hxWtLoad === 'function' && await hxWtLoad()){
    const rel = hxWtNeighbours();
    if(rel) for(let s = 0; s < NSITES; s++){ if(!inScope(s)) continue; const r = hxWt.res[s], q = rel[s];
      if(isFinite(r) && isFinite(q) && Math.abs(r) > 150 && Math.abs(q) > 150){ wtRows++;
        rows.push(hxIssueRow('far_from_regional_water_table', 'low', s, null, `mean water level ${Math.round(Math.abs(r))} ft ${r > 0 ? 'above' : 'below'} the regional water table (NMBGMR 2026 map) and ${Math.round(Math.abs(q))} ft ${q > 0 ? 'above' : 'below'} its neighbours within 5 km: check the site elevation, location and well depth (or it taps a confined, perched or deeper unit)`, r1(r), '')); } }
  }
  const order = {high: 0, medium: 1, low: 2};
  rows.sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]) || String(a[3]).localeCompare(String(b[3]), undefined, {numeric: true}));
  return {rows, demChecked, dateNote, flagRows, wtRows};
}
async function hxIssuesDownload(selOnly){
  const only = selOnly ? state.activeSet : null;
  if(selOnly && (!only || !only.size)){ toast('Choose an area or wells first.'); return; }
  const st = document.getElementById('issues-status'); if(st) st.textContent = 'Collecting data issues…';
  const r = await hxIssuesBuild(only);
  const head = ['issue', 'severity', 'source', 'well_id', 'other_source', 'other_well_id', 'detail', 'value', 'date', 'longitude', 'latitude'];
  downloadCsv((selOnly ? wvCsvName().replace('hydrographs', 'data-issues') : 'nm_groundwater_data_issues_statewide.csv'), [head, ...r.rows]);
  const by = {}; r.rows.forEach(x => by[x[0]] = (by[x[0]] || 0) + 1);
  const msg = `${r.rows.length.toLocaleString()} issue rows (` + Object.entries(by).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.toLocaleString()}`).join('; ') + `). Elevation checked against 3DEP for ${r.demChecked.toLocaleString()} wells (those looked up in elevation mode in this browser).` + (r.dateNote ? ' Note: ' + r.dateNote + '.' : '') + (hxPump.mark ? '' : ' Likely pumped readings are included once that Reading-quality option has been used.');
  if(st) st.textContent = msg; else toast(msg);
  return r;
}
function hxIssuesInit(){
  const dsp = document.getElementById('toggle-despike'), sec = dsp && dsp.closest('.section'); if(!sec || document.getElementById('btn-issues')) return;
  const w = document.createElement('div'); w.style.cssText = 'margin-top:10px; border-top:1px solid var(--border); padding-top:8px;';
  w.innerHTML = '<div style="font-size:12px; font-weight:700; color:var(--ink-1);">Data-issues report</div><p class="hint" style="margin:2px 0 4px;">One CSV of the problems found in the data, to send to the data providers: links between wells that cannot be one well, site elevations far from 3DEP, impossible dates, readings deeper than the well, likely entry errors, likely pumped readings, and wells far off both the regional water table and their neighbours.</p>'
    + '<div style="display:flex; gap:6px; flex-wrap:wrap;"><button type="button" class="btn" id="btn-issues" style="padding:4px 10px; font-size:12px;">Whole state (CSV)</button><button type="button" class="btn" id="btn-issues-sel" style="padding:4px 10px; font-size:12px;">Selected wells (CSV)</button></div><p class="hint" id="issues-status" style="margin-top:4px;"></p>';
  sec.appendChild(w);
  document.getElementById('btn-issues').addEventListener('click', () => hxIssuesDownload(false));
  document.getElementById('btn-issues-sel').addEventListener('click', () => hxIssuesDownload(true));
}
hxIssuesInit();
window.__hx = Object.assign(window.__hx || {}, {issuesBuild: hxIssuesBuild});

// ---- small multiples: one small chart per well (or per group) ---------------------------------------------------
// For checking by eye which wells belong together before trusting a grouping (Barthel et al. 2022, Hydrogeology Journal:
// visual classification first, a fixed y-range with each well's mean removed, the same time axis everywhere). Each well tile
// shows its yearly values (median of monthly values, with the season, water years, flagged readings and the Period applied,
// the same yearly values the composite uses); in the Composite view the composite median is drawn faintly behind each
// well, shifted to the well's own mean over the years both have. Group tiles (when the composite is grouped) show their
// member wells and the group's median.
var hxSm = {mode: 'wells', scale: 'same', max: 60, sort: 'record'};
function hxSmWellSeries(s){
  const up = state.valueMode === 'elevation' ? 1 : -1, Y = [], V = [];
  for(const p of otAnnual(s)){ const d = toDisplay(s, p.avg); if(d == null || !isFinite(d)) continue; Y.push(p.year); V.push(d); }
  const slope = Y.length >= 3 ? up * OT.theilSen(Y, V).slope : NaN;   // + = water level rising
  return {Y, V, slope};
}
function hxSmTiles(){
  const comp = !state.showAllWells, res = comp ? computeComposite() : null, tiles = [];
  if(hxSm.mode === 'groups' && comp && res && window._lastGroups && window._lastGroups.length){
    const of = window._lastClusterOf, perWell = res.perWell;
    window._lastGroups.forEach((g, gi) => {
      const name = g.label.replace(/\s*\(.*$/, '');
      let mem = [];
      if(state.group.mode === 'cluster' && of){ const c = +(/Cluster (\d+)/.exec(g.label) || [])[1]; mem = perWell.filter(pw => of.get(pw.site) === c); }
      else if(groupIsCategorical()){ const kept = window._lastGroups.map(x => x.label.replace(/\s*\(.*$/, '')).filter(x => x !== 'All other');
        mem = name === 'All other' ? perWell.filter(pw => !groupCategoriesOf(pw.site).some(c => kept.includes(c))) : perWell.filter(pw => groupCategoriesOf(pw.site).includes(name)); }
      tiles.push({group: true, title: g.label, sub: (mem.length ? mem.length + ' wells drawn' : 'group line only'), color: g.color, X: res.xvals, lines: mem.map(pw => pw.values), main: g.medianSeries});
    });
    return tiles;
  }
  let sites = comp ? (res ? res.perWell.map(pw => pw.site) : []) : (wv.all || []).map(w => w.site);
  const cmed = comp && res ? res.medianSeries : null, cx = comp && res ? res.xvals : null;
  const rows = sites.map(s => { const r = hxSmWellSeries(s), L = hxSiteLabel(s); return Object.assign(r, {site: s, title: L.id, src: L.src, n: r.Y.length}); }).filter(r => r.n >= 2);
  const so = hxSm.sort;
  rows.sort((a, b) => so === 'id' ? a.title.localeCompare(b.title, undefined, {numeric: true}) : so === 'trend' ? ((isFinite(a.slope) ? a.slope : 1e9) - (isFinite(b.slope) ? b.slope : 1e9))
    : so === 'cluster' && window._lastClusterOf ? ((window._lastClusterOf.get(a.site) || 99) - (window._lastClusterOf.get(b.site) || 99) || b.n - a.n) : b.n - a.n);
  rows.forEach(r => {
    let overlay = null;
    if(cmed){ const m = new Map(cx.map((y, i) => [y, cmed[i]])); let dw = 0, dc = 0, k = 0; r.Y.forEach((y, i) => { const c = m.get(y); if(c != null){ dw += r.V[i]; dc += c; k++; } });
      if(k >= 2){ const off = dw / k - dc / k; overlay = {X: cx, V: cmed.map(v => v == null ? null : v + off)}; } }
    const cl = window._lastClusterOf && comp ? window._lastClusterOf.get(r.site) : null;
    tiles.push({site: r.site, title: r.title, sub: `${r.src} · ${r.n} yrs · ${isFinite(r.slope) ? (r.slope >= 0 ? '+' : '') + r.slope.toFixed(2) + ' ft/yr' : 'no trend'}` + (cl ? ' · cluster ' + cl : ''), X: r.Y, V: r.V, overlay});
  });
  return tiles;
}
function hxSmDraw(cv, t, opt){
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 200, h = cv.clientHeight || 110;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.body), ink = css.getPropertyValue('--ink-2').trim() || '#555', mut = css.getPropertyValue('--muted').trim() || '#888', bord = css.getPropertyValue('--border').trim() || '#ddd', acc = css.getPropertyValue('--accent').trim() || '#0f6e63';
  const padL = 30, padR = 4, padT = 4, padB = 14, x0 = opt.x0, x1 = opt.x1, flip = state.valueMode !== 'elevation';
  let lo, hi;
  if(opt.same){ const m = t.mean; lo = m - opt.half; hi = m + opt.half; } else { lo = Infinity; hi = -Infinity; (t.V || []).forEach(v => { if(v < lo) lo = v; if(v > hi) hi = v; }); (t.lines || []).forEach(L => L.forEach(v => { if(v != null){ if(v < lo) lo = v; if(v > hi) hi = v; } })); (t.main || []).forEach(v => { if(v != null){ if(v < lo) lo = v; if(v > hi) hi = v; } }); if(!(hi > lo)){ lo -= 1; hi += 1; } const p = (hi - lo) * 0.08; lo -= p; hi += p; }
  const X = x => padL + (x - x0) / Math.max(1, x1 - x0) * (w - padL - padR), Yp = v => { const f = (v - lo) / (hi - lo); return padT + (flip ? f : 1 - f) * (h - padT - padB); };
  g.strokeStyle = bord; g.lineWidth = 1; g.strokeRect(padL, padT, w - padL - padR, h - padT - padB);
  g.fillStyle = mut; g.font = '9px system-ui, sans-serif'; g.textAlign = 'right';
  g.fillText(Math.round(flip ? lo : hi).toLocaleString(), padL - 3, padT + 8); g.fillText(Math.round(flip ? hi : lo).toLocaleString(), padL - 3, h - padB);
  g.textAlign = 'left'; g.fillText(String(x0), padL, h - 3); g.textAlign = 'right'; g.fillText(String(x1), w - padR, h - 3);
  const line = (xs, vs, col, lw, dots) => { g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); let pen = false, prev = null;
    xs.forEach((x, i) => { const v = vs[i]; if(v == null || !isFinite(v)){ pen = false; return; } const px = X(x), py = Yp(Math.max(lo, Math.min(hi, v))); if(pen && prev != null && x - prev <= 6) g.lineTo(px, py); else g.moveTo(px, py); pen = true; prev = x; });
    g.stroke(); if(dots){ g.fillStyle = col; xs.forEach((x, i) => { const v = vs[i]; if(v != null && isFinite(v)){ g.beginPath(); g.arc(X(x), Yp(Math.max(lo, Math.min(hi, v))), 1.6, 0, 7); g.fill(); } }); } };
  g.save(); g.beginPath(); g.rect(padL, padT, w - padL - padR, h - padT - padB); g.clip();
  if(t.overlay) line(t.overlay.X, t.overlay.V, mut, 1.2, false);
  (t.lines || []).forEach(L => line(t.X, L, hexA(t.color || ink, 0.35), 0.8, false));
  if(t.main) line(t.X, t.main, t.color || acc, 2, false);
  if(t.V) line(t.X, t.V, state.chartHighlightSite === t.site ? '#e0455c' : acc, 1.4, true);
  g.restore();
}
function hxSmRender(){
  const d = hxDialogs['sm-modal']; if(!d) return;
  const tiles = hxSmTiles(), grid = d.body.querySelector('#sm-grid'), sum = d.body.querySelector('#sm-sum');
  const shown = tiles.slice(0, hxSm.max);
  let x0 = Infinity, x1 = -Infinity; shown.forEach(t => (t.X || []).forEach((x, i) => { const v = t.V ? t.V[i] : (t.main ? t.main[i] : 1); if(v != null){ if(x < x0) x0 = x; if(x > x1) x1 = x; } }));
  if(!isFinite(x0)){ x0 = 1950; x1 = new Date().getFullYear(); }
  // same scale: each well's mean removed; half-range = 75th percentile of the wells' largest departures, so a few wild wells
  // (clipped) do not flatten everyone else
  shown.forEach(t => { const v = (t.V || t.main || []).filter(x => x != null && isFinite(x)); t.mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; t.dev = v.length ? Math.max(...v.map(x => Math.abs(x - t.mean))) : 0; });
  const devs = shown.map(t => t.dev).filter(isFinite).sort((a, b) => a - b), half = Math.max(1, devs.length ? devs[Math.min(devs.length - 1, Math.floor(devs.length * 0.75))] * 1.1 : 10);
  const same = hxSm.scale === 'same' && !shown.some(t => t.group);
  sum.textContent = !tiles.length ? 'No wells with at least 2 years of values in the period shown.'
    : `${shown.length.toLocaleString()} of ${tiles.length.toLocaleString()} ${tiles[0].group ? 'groups' : 'wells'}` + (tiles.length > shown.length ? ' (raise "Tiles" to see more)' : '') + `, ${x0}–${x1}. ` + (same ? `Every tile spans the same ${(2 * half).toFixed(0)} ft, centred on the well's own mean, so slopes and swings compare directly (departures beyond that are clipped).` : 'Each tile has its own y-range.') + (state.valueMode === 'elevation' ? ' Up = higher water.' : ' Depth to water, deeper is down.') + (!state.showAllWells && !tiles[0].group ? ' Grey line: the composite median, shifted to the well\'s mean.' : '');
  grid.innerHTML = shown.map((t, i) => `<div class="sm-tile${t.site != null && state.chartHighlightSite === t.site ? ' hi' : ''}${t.site != null && state.excludedSites.has(t.site) ? ' excl' : ''}" data-i="${i}"${t.site != null ? ` data-s="${t.site}"` : ''} title="${t.site != null ? 'Click to highlight this well' : escHtml(t.title)}"><div class="sm-t">${escHtml(t.title)}</div><div class="sm-s">${escHtml(t.sub)}</div><canvas></canvas></div>`).join('');
  const opt = {x0, x1, same, half};
  grid.querySelectorAll('.sm-tile').forEach(el => hxSmDraw(el.querySelector('canvas'), shown[+el.dataset.i], opt));
}
function hxSmOpen(){
  if(!state.activeSet || !state.activeSet.size || !(state.areaSelection || state.clickSelectedSites.size || state.statewideOk)){ toast('Choose an area or wells first.'); return; }
  const d = hxDialog('sm-modal', 'Small multiples', {wide: true});
  if(!d.body.querySelector('#sm-grid')){
    d.head.innerHTML = '<label>Show <select class="selfield" id="sm-mode" style="width:auto"><option value="wells">one tile per well</option><option value="groups">one tile per group</option></select></label>'
      + '<label>Y axis <select class="selfield" id="sm-scale" style="width:auto"><option value="same">same range, own mean removed</option><option value="own">each tile its own range</option></select></label>'
      + '<label>Order <select class="selfield" id="sm-sort" style="width:auto"><option value="record">longest record</option><option value="trend">trend (falling first)</option><option value="id">well ID</option><option value="cluster">cluster</option></select></label>'
      + '<label>Tiles <select class="selfield" id="sm-max" style="width:auto"><option>24</option><option selected>60</option><option>150</option><option>400</option></select></label>';
    d.body.innerHTML = '<div class="hx-sum" id="sm-sum"></div><div class="hx-note">Look for wells whose shape differs from their neighbours before trusting a composite or a grouping. Click a tile to highlight that well on the chart and map.</div><div id="sm-grid"></div>';
    const bind = (id, k, num) => d.head.querySelector('#' + id).addEventListener('change', e => { hxSm[k] = num ? +e.target.value : e.target.value; hxSmRender(); });
    bind('sm-mode', 'mode'); bind('sm-scale', 'scale'); bind('sm-sort', 'sort'); bind('sm-max', 'max', true);
    d.body.querySelector('#sm-grid').addEventListener('click', e => { const t = e.target.closest('.sm-tile[data-s]'); if(!t) return; const s = +t.dataset.s; state.chartHighlightSite = state.chartHighlightSite === s ? null : s; renderChart(); try{ restyleMarkers(); }catch(err){} hxSmRender(); });
  }
  const grouped = !state.showAllWells && window._lastGroups && window._lastGroups.length;
  d.head.querySelector('#sm-mode').querySelector('option[value=groups]').disabled = !grouped;
  if(!grouped && hxSm.mode === 'groups') hxSm.mode = 'wells';
  d.head.querySelector('#sm-mode').value = hxSm.mode;
  d.open(); requestAnimationFrame(hxSmRender);
}
['btn-smallmult', 'btn-smallmult-c'].forEach(id => { const b = document.getElementById(id); if(b) b.addEventListener('click', hxSmOpen); });

// ---- map colour: trend over the period shown --------------------------------------------------------------------
// The API's trend layer covers each well's whole record. This colours each selected well by its own Theil-Sen trend over the
// Period, Season and water-year settings in use (the yearly values the composite uses), in ft/yr with + = water level rising.
// Wells need the Trend table's minimum years in the period (default 10). Recomputed whenever those settings change.
var HX_PTM = [[-2, '#a50f15', '≤ −2 ft/yr (falling fast)'], [-0.5, '#e6553d', '−2 to −0.5'], [-0.1, '#f7a57e', '−0.5 to −0.1'], [0.1, '#d9d9d9', '±0.1 (about level)'], [0.5, '#9ecae1', '+0.1 to +0.5'], [2, '#4292c6', '+0.5 to +2'], [Infinity, '#08519c', '≥ +2 ft/yr (rising fast)']];
var hxPtm = {key: null, slope: null, p: null, n: 0, tested: 0};
function hxPtmKey(){ const sel = state.activeSet && state.activeSet._key; return [otDataVer, state.season.monthStart, state.season.monthEnd, state.waterYear, state.yearWindow.min, state.yearWindow.max, state.despike.enabled, state.despike.threshold, hxTr.minYears, (state.areaSelection || state.clickSelectedSites.size) ? sel : 'all'].join('|'); }
function hxPtmEnsure(){
  const key = hxPtmKey(); if(hxPtm.key === key) return;
  const slope = new Float32Array(NSITES).fill(NaN), p = new Float32Array(NSITES).fill(NaN), need = Math.max(3, hxTr.minYears);
  const sites = (state.areaSelection || state.clickSelectedSites.size) && state.activeSet ? [...state.activeSet] : Array.from({length: NSITES}, (_, i) => i);
  let n = 0, tested = 0;
  for(const s of sites){
    const ser = otAnnual(s); if(ser.length < need) continue; tested++;
    const Y = ser.map(q => q.year), V = ser.map(q => -q.avg);   // water-level sense: up = rising
    slope[s] = OT.theilSen(Y, V).slope; p[s] = OT.mannKendall(V).p; n++;
  }
  hxPtm = {key, slope, p, n, tested};
  if(state.colorBy === 'ptrend') setTimeout(() => { try{ renderLegend(); }catch(e){} }, 0);
}
function hxPtmColor(s){ hxPtmEnsure(); const v = hxPtm.slope[s]; if(!isFinite(v)) return '#eceeea'; for(const c of HX_PTM) if(v <= c[0]) return c[1]; return HX_PTM[HX_PTM.length - 1][1]; }
function hxPtmLegend(){
  hxPtmEnsure();
  const yw = state.yearWindow, per = (yw.min != null || yw.max != null) ? `${yw.min != null ? yw.min : 'start'}–${yw.max != null ? yw.max : 'latest'}` : 'the whole record';
  const rows = [`<div class="lg-row" style="font-size:11px; color:var(--muted); margin-bottom:3px;">Theil–Sen trend over ${per}${seasonIsFullYear() ? '' : ' (season)'}, + = rising</div>`];
  HX_PTM.forEach(c => rows.push(`<div class="lg-row"><span class="swatch" style="background:${c[1]}"></span><span class="k">${c[2]}</span></div>`));
  rows.push(`<div class="lg-row"><span class="swatch" style="background:#eceeea; border:1px solid var(--border);"></span><span class="k">Fewer than ${Math.max(3, hxTr.minYears)} years in the period</span></div>`);
  rows.push(`<div class="lg-row" style="font-size:11px; color:var(--muted);">${hxPtm.n.toLocaleString()} wells with a trend</div>`);
  return rows;
}
(function hxPtmInit(){
  const sel = document.getElementById('colorby-select'); if(!sel || sel.querySelector('option[value=ptrend]')) return;
  const o = document.createElement('option'); o.value = 'ptrend'; o.textContent = 'Color: Trend over the period shown (Theil–Sen)';
  const after = sel.querySelector('option[value=trend]'); if(after) after.after(o); else sel.appendChild(o);
  // the legend must follow the period / season: redraw it whenever markers are restyled in this mode
  const ri = document.getElementById('trend-miny'); if(ri) ri.addEventListener('change', () => { if(state.colorBy === 'ptrend'){ restyleMarkers(); renderLegend(); } });
})();

// ---- project files: save and reopen everything about a view ----------------------------------------------------
// A share link carries the area (when it is a named area or a small drawn polygon), up to 60 picked wells and the view
// settings. A project file (.json) also carries what a link cannot: HUC-10 / HUC-12 / uploaded areas and large polygons, any
// number of picked wells, the data filters (by name, so they survive new sources or formations), reading quality, the
// composite method, excluded wells, readings added from a file, the reference hydrograph and the map colouring. Wells are
// stored as source + id. Opening a project resets the page first, then applies it.
var HX_PROJ_VER = 1;
function hxProjKey(s){ return rawWellKey(s).replace('\u0001', '~'); }
function hxExtrasReset(){
  state.showIqr = false; { const e = document.getElementById('toggle-iqr'); if(e) e.checked = false; }
  state.filters.prod = 'all'; { const e = document.getElementById('prod-filter'); if(e) e.value = 'all'; }
  state.filters.wt = 'all'; state.filters.wtTol = 50; { const e = document.getElementById('wt-filter'); if(e) e.value = 'all'; const t = document.getElementById('wt-tol'); if(t) t.value = '50'; }
  { const e = document.getElementById('rq-pump'); if(e) e.checked = false; } if(state.readQ) state.readQ.pumpHeur = false;
}
async function hxProjBuild(){
  const {P} = hxuState(), sel = state.areaSelection, f = state.filters;
  const names = (set, list) => set ? [...set].map(i => i === -1 ? null : list[i]) : null;
  const linkable = sel && (HXU_SELECTS[sel.type] || (sel.type === 'polygon' && sel.polygons[0] && sel.polygons[0][0].length <= 300));
  let readings = null; try{ const u = await idbGet('userReadings'); if(u && u.rows && u.rows.length) readings = {name: u.name || '', rows: u.rows}; }catch(e){}
  return {
    app: 'NM Hydrograph Explorer', kind: 'hydrograph-project', version: HX_PROJ_VER, saved: new Date().toISOString(),
    data: {maxDate: BOOT.info && BOOT.info.maxDate, readings: BOOT.raw ? BOOT.raw.n : null},
    screen: hxScreen || 'map', link: Object.fromEntries(P),
    area: sel ? {type: sel.type, label: sel.label || '', exactIdx: sel.exactIdx == null ? null : sel.exactIdx, polygons: linkable ? null : sel.polygons} : null,
    wells: [...state.clickSelectedSites].map(hxProjKey),
    excluded: [...state.excludedSites].map(hxProjKey),
    highlight: state.chartHighlightSite != null ? hxProjKey(state.chartHighlightSite) : null,
    filters: {sources: names(f.sources, SOURCES), aquiferExt: names(f.aquiferExt, AQUIFER_EXTENT_NAMES), studyArea: names(f.studyArea, STUDY_AREA_NAMES), formation: names(f.formation, FORMATIONS), usgsAq: names(f.usgsAq, AQUIFERS),
      formationSearch: f.formationSearch || '', multiAgency: f.multiAgency, api: f.api ? JSON.parse(JSON.stringify(f.api)) : null,
      depthMin: f.depthMin, depthMax: f.depthMax, depthRequire: !!f.depthRequire, dtwMin: f.dtwMin, dtwMax: f.dtwMax, yearMin: f.yearMin, yearMax: f.yearMax, minYears: f.minYears, prod: f.prod || 'all', wt: f.wt || 'all', wtTol: f.wtTol || 50},
    readQ: Object.assign({}, state.readQ), pumpThr: +(document.getElementById('rq-pump-thr') || {value: 25}).value,
    otp: Object.assign({}, state.otp), despike: Object.assign({}, state.despike),
    display: {showBand: state.showBand, showIqr: !!state.showIqr, showSpaghetti: state.showSpaghetti, spaghettiCap: +document.getElementById('spaghetti-cap').value, normalize: state.normalize, normalizeStyle: state.normalizeStyle, useDem: state.useDem, datumFix: hxDatum.on, colorBy: state.colorBy, trendMinYears: hxTr.minYears},
    seasonCompare: {enabled: state.seasonCompare.enabled, keys: [...state.seasonCompare.keys]},
    group: Object.assign({}, state.group),
    ref: state.ref ? JSON.parse(JSON.stringify(state.ref)) : null,
    readings
  };
}
async function hxProjSave(){
  const p = await hxProjBuild();
  const label = (state.areaSelection && state.areaSelection.label) ? state.areaSelection.label.replace(/^[^:]*:\s*/, '') : (state.clickSelectedSites.size ? state.clickSelectedSites.size + '-wells' : 'statewide');
  const name = 'hydrograph-project_' + label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '_' + new Date().toISOString().slice(0, 10) + '.json';
  downloadBlob(name, new Blob([JSON.stringify(p)], {type: 'application/json'}));
  toast('Project saved: ' + name + (p.readings ? ' (includes ' + p.readings.rows.length.toLocaleString() + ' added readings)' : ''));
}
function hxSetChecks(listSel, attr, keep){ document.querySelectorAll(listSel + ' input[type=checkbox]').forEach(cb => { cb.checked = keep.has(+cb.dataset[attr]); }); }
async function hxProjOpen(p){
  if(!p || p.kind !== 'hydrograph-project') throw new Error('This is not a Hydrograph Explorer project file.');
  hxuRestoring = true;
  const missing = [], LISTS = [['sources', SOURCES, '#source-list', 'src'], ['aquiferExt', AQUIFER_EXTENT_NAMES, '#aquifer-list', 'aq'], ['studyArea', STUDY_AREA_NAMES, '#studyarea-list', 'sa'], ['formation', FORMATIONS, '#formation-list', 'fm'], ['usgsAq', AQUIFERS, '#usgsaq-list', 'ua']];
  const savedLists = {};
  try{
    resetEverything(false); hxExtrasReset();
    // filters (by name)
    const F = p.filters || {}, f = defaultFilters();
    const idx = (arr, list) => { if(!arr) return null; const out = new Set(); arr.forEach(n => { if(n == null) out.add(-1); else { const i = list.indexOf(n); if(i >= 0) out.add(i); } }); return out; };
    LISTS.forEach(([k, list]) => { const v = idx(F[k], list); if(v){ f[k] = v; savedLists[k] = v; } });
    ['formationSearch', 'multiAgency', 'depthMin', 'depthMax', 'depthRequire', 'dtwMin', 'dtwMax', 'yearMin', 'yearMax', 'minYears', 'prod', 'wt', 'wtTol'].forEach(k => { if(F[k] !== undefined) f[k] = F[k]; });
    if(F.api) f.api = Object.assign(defaultFilters().api, F.api);
    state.filters = f; state._selSig = null;
    hxSetChecks('#source-list', 'src', f.sources); hxSetChecks('#aquifer-list', 'aq', f.aquiferExt); hxSetChecks('#studyarea-list', 'sa', f.studyArea); hxSetChecks('#formation-list', 'fm', f.formation); hxSetChecks('#usgsaq-list', 'ua', f.usgsAq);
    [['depth-min', 'depthMin'], ['depth-max', 'depthMax'], ['dtw-min', 'dtwMin'], ['dtw-max', 'dtwMax'], ['year-min', 'yearMin'], ['year-max', 'yearMax'], ['min-years', 'minYears']].forEach(([id, k]) => { document.getElementById(id).value = f[k] == null ? '' : f[k]; });
    document.getElementById('depth-require').checked = !!f.depthRequire; document.getElementById('formation-search').value = f.formationSearch || ''; filterFormationList(f.formationSearch || '');
    try{ syncApiFilterControls(); }catch(e){}
    { const e = document.getElementById('prod-filter'); if(e) e.value = f.prod || 'all'; }
    { const e = document.getElementById('wt-filter'); if(e) e.value = f.wt || 'all'; const t = document.getElementById('wt-tol'); if(t) t.value = String(f.wtTol || 50); if(f.wt && f.wt !== 'all') await hxWtLoad(); }
    // reading quality (rebuilds the yearly values once)
    const q = p.readQ || {};
    document.getElementById('rq-static').checked = !!q.static; document.getElementById('rq-nodist').checked = !!q.noDisturbed; document.getElementById('rq-approved').checked = !!q.approved; document.getElementById('rq-method').value = q.method || 'all';
    { const e = document.getElementById('rq-pump'), t = document.getElementById('rq-pump-thr'); if(t && p.pumpThr) t.value = String(p.pumpThr); if(e) e.checked = !!q.pumpHeur; if(q.pumpHeur) hxPumpCompute(+(t ? t.value : 25)); }
    // readings added from a file (before the quality rebuild, which then includes them)
    if(p.readings && p.readings.rows && p.readings.rows.length){
      const prev = await idbGet('userReadings');
      if(!prev || !prev.rows || !prev.rows.length){ applyImportedRows(p.readings.rows, p.readings.name || 'Project readings', true); await idbSet('userReadings', {rows: p.readings.rows, name: p.readings.name || 'Project readings'}); }
      else missing.push('(added readings: this browser already holds its own added readings, which were kept)');
    }
    readQFromControls(); hxPumpNote();
    // composite method, cleaning, display
    state.otp = Object.assign(otDefaults(), p.otp || {}); syncOtUi();
    if(p.despike){ state.despike = Object.assign({enabled: true, threshold: 0.6}, p.despike); document.getElementById('toggle-despike').checked = state.despike.enabled; document.querySelectorAll('.despike-btn').forEach(b => b.classList.toggle('active', +b.dataset.thresh === state.despike.threshold)); onDespikeChange(); }
    const D = p.display || {};
    const setChk = (id, v) => { const e = document.getElementById(id); if(e && v != null && e.checked !== !!v){ e.checked = !!v; e.dispatchEvent(new Event('change')); } };
    setChk('toggle-band', D.showBand); setChk('toggle-iqr', D.showIqr); setChk('toggle-spaghetti', D.showSpaghetti);
    if(D.spaghettiCap) document.getElementById('spaghetti-cap').value = D.spaghettiCap;
    if(D.useDem === false){ const e = document.getElementById('dem-source'); e.value = 'api'; e.dispatchEvent(new Event('change')); }
    setChk('datum-fix', D.datumFix);
    if(D.trendMinYears){ hxTr.minYears = D.trendMinYears; const e = document.getElementById('trend-miny'); if(e) e.value = D.trendMinYears; }
    if(D.colorBy){ const e = document.getElementById('colorby-select'); if([...e.options].some(o => o.value === D.colorBy)){ e.value = D.colorBy; e.dispatchEvent(new Event('change')); } }
    if(p.seasonCompare){ setChk('toggle-season-compare', p.seasonCompare.enabled); if(p.seasonCompare.keys) document.querySelectorAll('.season-compare-cb').forEach(cb => { const want = p.seasonCompare.keys.includes(cb.dataset.key); if(cb.checked !== want){ cb.checked = want; cb.dispatchEvent(new Event('change')); } }); }
    if(p.group && p.group.breaks && p.group.breaks.length){ const e = document.getElementById('group-breaks'); if(e){ e.value = p.group.breaks.join(', '); e.dispatchEvent(new Event('change')); } }
    state.ref = p.ref || null;
  }finally{ hxuRestoring = false; }
  // the link part: view, period, time step, season, grouping, named area, small polygons, up to 60 wells, elevation mode
  const L = p.link || {};
  const hash = HX_HASH[p.screen] || '#hydrographs';
  history.replaceState(history.state, '', hash + (Object.keys(L).length ? '?' + Object.entries(L).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&') : ''));
  try{ setScreen(p.screen || 'charts'); }catch(e){}
  await hxRestoreFromUrl();
  // what the link could not carry
  if(p.area && p.area.polygons && !state.areaSelection) setAreaSelection({type: p.area.type, label: p.area.label, polygons: p.area.polygons, exactIdx: p.area.exactIdx == null ? undefined : p.area.exactIdx});
  const wells = (p.wells || []).map(k => hxuSite(k)).filter(s => s != null);
  (p.wells || []).forEach(k => { if(hxuSite(k) == null) missing.push(k); });
  if(wells.length > state.clickSelectedSites.size){ wells.forEach(s => state.clickSelectedSites.add(s)); recomputeActiveSet(); }
  // choosing the area re-ticks every list to what the area holds, so the saved list filters go back on afterwards
  LISTS.forEach(([k, , sel, attr]) => { if(savedLists[k]){ state.filters[k] = new Set(savedLists[k]); hxSetChecks(sel, attr, state.filters[k]); } });
  state.excludedSites = new Set((p.excluded || []).map(k => hxuSite(k)).filter(s => s != null));
  if(p.highlight){ const s = hxuSite(p.highlight); if(s != null) state.chartHighlightSite = s; }
  if(state.filters.prod && state.filters.prod !== 'all' && state.activeSet) await hxProdLookup([...state.activeSet]);
  recomputeActiveSet(); try{ restyleMarkers(); renderLegend(); }catch(e){}
  hxUrlSync();
  const ms = [...new Set(missing)];
  toast('Project opened' + (p.saved ? ' (saved ' + p.saved.slice(0, 10) + ')' : '') + '.' + (ms.length ? ' Not found now: ' + ms.slice(0, 5).join(', ') + (ms.length > 5 ? ' and ' + (ms.length - 5) + ' more' : '') + '.' : ''));
  return {missing: ms};
}
(function hxProjInit(){
  const btn = document.getElementById('btn-project'), inp = document.getElementById('proj-file');
  if(!btn) return;
  btn.addEventListener('click', () => {
    const d = hxDialog('proj-modal', 'Project file');
    if(!d.body.querySelector('#btn-proj-save')){
      d.el.querySelector('.hx-card').style.width = 'min(560px, 100%)';
      d.body.innerHTML = '<div class="hx-proj-row"><button type="button" class="btn primary" id="btn-proj-save">Save this view to a file</button><button type="button" class="btn" id="btn-proj-open">Open a project file…</button></div>'
        + '<div class="hx-note" style="padding-bottom:14px;">A project file keeps everything a link cannot: HUC-10, HUC-12 and uploaded areas, any number of picked wells, the data filters, reading quality, the composite method, wells left out by hand, readings added from a file, the reference hydrograph and the map colouring. Opening one resets the page first. Readings themselves are not saved (they come from the API), so a project opened later uses the readings of that day.</div>';
      d.body.querySelector('#btn-proj-save').addEventListener('click', () => { d.close(); hxProjSave().catch(e => toast('Could not save: ' + (e.message || e))); });
      d.body.querySelector('#btn-proj-open').addEventListener('click', () => { d.close(); inp.click(); });
    }
    d.open();
  });
  inp.addEventListener('change', async e => { const fl = e.target.files[0]; if(!fl) return; e.target.value = '';
    try{ await hxProjOpen(JSON.parse(await fl.text())); }catch(err){ toast('Could not open ' + fl.name + ': ' + (err.message || err)); } });
  // the Copy link note now points to project files for what a link leaves out
  window.__hx = Object.assign(window.__hx || {}, {projBuild: hxProjBuild, projOpen: hxProjOpen});
})();

// ---- one-page area report (print, or Save as PDF from the print dialog) ------------------------------------------
// Map of the area and its wells, the composite chart, the method in words and the statistics, on one letter page, for review
// documents. The map is drawn here (area outline and wells, no basemap), so it never depends on map tiles printing.
function hxRepMap(w, h){
  const cv = document.createElement('canvas'), dpr = 2; cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  const sel = state.areaSelection, used = state.qualifyingSites, act = state.activeSet || new Set();
  const pts = []; act.forEach(s => { const r = SITES[s]; if(r[1] != null) pts.push([r[1], r[2], s]); });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const ext = (x, y) => { if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; };
  if(sel && sel.polygons) sel.polygons.forEach(P => P.forEach(R => R.forEach(c => ext(c[0], c[1]))));
  pts.forEach(p => ext(p[0], p[1]));
  if(!isFinite(x0)){ x0 = -109.05; x1 = -103.0; y0 = 31.33; y1 = 37.0; }
  const cy = Math.cos(((y0 + y1) / 2) * Math.PI / 180), pad = 14, sx = (w - 2 * pad) / Math.max(1e-6, (x1 - x0) * cy), sy = (h - 2 * pad) / Math.max(1e-6, y1 - y0), sc = Math.min(sx, sy);
  const ox = pad + ((w - 2 * pad) - (x1 - x0) * cy * sc) / 2, oy = pad + ((h - 2 * pad) - (y1 - y0) * sc) / 2;
  const P = (x, y) => [ox + (x - x0) * cy * sc, oy + (y1 - y) * sc];
  if(sel && sel.polygons){ g.fillStyle = 'rgba(15,110,99,.06)'; g.strokeStyle = '#0f6e63'; g.lineWidth = 1.2;
    sel.polygons.forEach(Pp => { g.beginPath(); Pp.forEach(R => R.forEach((c, i) => { const [a, b] = P(c[0], c[1]); if(i) g.lineTo(a, b); else g.moveTo(a, b); })); g.fill('evenodd'); g.stroke(); }); }
  const dot = (s, col, r) => { const q = SITES[s]; const [a, b] = P(q[1], q[2]); g.fillStyle = col; g.beginPath(); g.arc(a, b, r, 0, 7); g.fill(); };
  pts.forEach(p => { if(!used.has(p[2]) && !state.excludedSites.has(p[2])) dot(p[2], '#b9bdb5', 1.6); });
  pts.forEach(p => { if(used.has(p[2])) dot(p[2], '#0f6e63', 2.2); });
  state.excludedSites.forEach(s => { if(act.has(s)) dot(s, '#c1652f', 2.4); });
  // scale bar and north arrow
  const kmPerPx = 1 / (sc / 111.32), nice = [1, 2, 5, 10, 20, 25, 50, 100, 200].find(k => k / kmPerPx >= 50) || 200, bar = nice / kmPerPx;
  g.strokeStyle = '#333'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(10, h - 10); g.lineTo(10 + bar, h - 10); g.moveTo(10, h - 13); g.lineTo(10, h - 7); g.moveTo(10 + bar, h - 13); g.lineTo(10 + bar, h - 7); g.stroke();
  g.fillStyle = '#333'; g.font = '9px sans-serif'; g.fillText(nice + ' km', 14 + bar, h - 7);
  g.beginPath(); g.moveTo(w - 14, 8); g.lineTo(w - 18, 20); g.lineTo(w - 10, 20); g.closePath(); g.fill(); g.fillText('N', w - 17, 30);
  return cv.toDataURL('image/png');
}
async function hxReportBuild(){
  const wasWells = state.showAllWells, wasTheme = state.theme;
  if(wasWells){ setView('composite'); await new Promise(r => setTimeout(r, 600)); }
  if(wasTheme === 'dark') applyTheme('light');
  renderChart(); await new Promise(r => setTimeout(r, 450));
  const res = computeComposite();
  if(!res || !res.qualifying || !res.qualifying.length || !chart){ if(wasWells) setView('wells'); if(wasTheme === 'dark') applyTheme('dark'); throw new Error('No composite can be built for this selection yet.'); }
  // chart on white
  // drawn at a fixed page-shaped size (whatever the screen layout), then given back its own size
  const src = document.getElementById('hydrograph-canvas'), anim = chart.options.animation;
  chart.options.animation = false; chart.resize(1100, 470);
  const cc = document.createElement('canvas'); cc.width = src.width; cc.height = src.height;
  const g = cc.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cc.width, cc.height); g.drawImage(src, 0, 0); const chartImg = cc.toDataURL('image/png');
  chart.options.animation = anim; chart.resize();
  const mapImg = hxRepMap(330, 215);
  const o = state.otp, units = otUnits(), dec = units === 'SD' ? 2 : 1, med = res.medianSeries, mean = res.meanSeries, [F, Lx] = hxFirstLast(med);
  const yrs = res.xvals, ct = res.compTrend, ss = res.slopeStats, sel = state.areaSelection;
  const title = sel ? (sel.label || 'Selected area') : (state.clickSelectedSites.size ? state.clickSelectedSites.size + ' selected wells' : 'Statewide');
  const bySrc = new Map(); res.qualifying.forEach(s => { const k = SITES[s][3] >= 0 ? SOURCES[SITES[s][3]] : 'other'; bySrc.set(k, (bySrc.get(k) || 0) + 1); });
  const yw = state.yearWindow, per = (yw.min != null || yw.max != null) ? `${yw.min != null ? yw.min : 'start'}–${yw.max != null ? yw.max : 'latest'}` : 'whole record';
  const methodRows = [['Composite', OT_METHOD_LABEL[o.method] || o.method], ['Time step', (o.bin || 1) + ' year(s)'], ['Area weighting', o.cellKm ? `each ${o.cellKm} km cell counts once` : 'off'], ['Fixed well set', o.fixed ? o.fixed + '% of years' : 'off'],
    ['Annual value', o.annual === 'median' ? 'median of monthly values' : 'reading-weighted mean'], ['Warm/cool season levels', otSplitOn(state.season.monthStart, state.season.monthEnd) ? 'separate' : 'not separated'],
    ['Well rules', `≥ ${o.minYears} years, span ≥ ${o.minSpan} yr, ≥ ${o.minN} wells per ${o.bin > 1 ? 'step' : 'year'}`], ['Spike filter', o.spike ? o.spike + ' ft/yr' : 'off'],
    ['Years', (state.waterYear ? 'water years (Oct–Sep)' : 'calendar years') + (seasonIsFullYear() ? '' : `, months ${state.season.monthStart}–${state.season.monthEnd}`)], ['Period', per],
    ['Value', state.valueMode === 'elevation' ? 'water-surface elevation' + (hxDatum.on && hxDatum.loaded ? ' (NAVD 88)' : '') : 'depth to water'],
    ['Reading quality', [state.readQ.static && 'static only', state.readQ.noDisturbed && 'no pumping-qualified readings', state.readQ.approved && 'approved only', state.readQ.method !== 'all' && state.readQ.method, state.readQ.pumpHeur && `no readings > ${hxPump.thr} ft below winter level`].filter(Boolean).join(', ') || 'all readings'],
    ['Data filters', (document.getElementById('sum-filters') || {}).textContent || 'none']];
  const statRows = [['Wells in the composite', `${res.qualifying.length.toLocaleString()} of ${res.poolSize.toLocaleString()} selected` + (state.excludedSites.size ? ` (${state.excludedSites.size} left out by hand)` : '')],
    ['By source', [...bySrc.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')],
    ['Years plotted', `${med.filter(v => v != null).length} (${yrs[F]}–${yrs[Lx]})`],
    ['Change, first to last year', `median line ${hxFmt(med[Lx] - med[F], dec, true)} ${units}, mean line ${hxFmt(mean[Lx] - mean[F], dec, true)} ${units}` + (state.valueMode === 'depth' && units === 'ft' ? ' (+ = deeper water)' : '')],
    ['Composite trend', ct ? `${hxFmt(ct.slope, units === 'SD' ? 3 : 2, true)} ${units}/yr (Theil–Sen; Mann–Kendall p = ${ct.p.toFixed(3)}, ${ct.n} years)` : '–'],
    ['Per-well trends', ss ? `median ${hxFmt(ss.median, 2, true)} ft/yr (95% CI ${hxFmt(ss.ci[0], 2, true)} to ${hxFmt(ss.ci[1], 2, true)}); ${ss.falling} of ${ss.n} falling in water-level sense; ${ss.sig} with p < 0.05` : '–'],
    ['Uncertainty', res.band && res.band.B ? `95% bootstrap band of the median from ${res.band.B} resamples of ${res.band.groups} well groups` : 'band off']];
  if(state.showIqr && window._lastIqr){ const b = window._lastIqr; statRows.push(['Spread between wells', `middle half of the wells spans ${hxFmt(b.hi[Lx] - b.lo[Lx], dec)} ${units} in ${yrs[Lx]}`]); }
  const inf = hxInf.rows && hxInf.rows.length && hxInf.base && hxInf.base.n === res.qualifying.length && hxInf.done === hxInf.total ? hxInf.rows.filter(r => !r.breaks && isFinite(r.dMed)).sort((a, b) => Math.abs(b.dMed) - Math.abs(a.dMed)).slice(0, 4) : null;
  if(inf && inf.length) statRows.push(['Most influential wells', inf.map(r => `${r.id} (${hxFmt(r.dMed, 1, true)} ft)`).join(', ')]);
  const tbl = rows => '<table>' + rows.map(r => `<tr><th>${escHtml(r[0])}</th><td>${escHtml(r[1])}</td></tr>`).join('') + '</table>';
  let box = document.getElementById('hx-report'); if(!box){ box = document.createElement('div'); box.id = 'hx-report'; document.body.appendChild(box); }
  const asOf = BOOT.info && BOOT.info.maxDate ? BOOT.info.maxDate : '';
  box.innerHTML = `<h1>Composite groundwater hydrograph: ${escHtml(title.replace(/^[^:]*:\s*/, ''))}</h1>
    <div class="r-sub">${escHtml(title)} · readings through ${escHtml(asOf)} · made ${new Date().toISOString().slice(0, 10)} with NM Hydrograph Explorer</div>
    <div class="r-two"><div><h2>Where the wells are</h2><img class="r-map" src="${mapImg}" alt="map"><p style="font-size:8pt;">Green: wells in the composite; grey: other selected wells; orange: left out by hand.</p></div><div><h2>Method</h2>${tbl(methodRows)}</div></div>
    <h2>Composite hydrograph</h2><img class="r-chart" src="${chartImg}" alt="composite chart">
    <h2>Statistics</h2>${tbl(statRows)}
    <h2>How it was made</h2><p class="r-how">Each well gets one value per ${o.bin > 1 ? o.bin + '-year step (the median of its yearly values, each the median of its monthly values)' : 'year (the median of its monthly values)'}; values that jump more than the spike limit from both neighbours and likely data-entry errors are left out, and a well needs the record shown under Well rules. The wells are then fitted together so that each is compared only with itself: a robust two-way fit gives every well its own typical level and every ${o.bin > 1 ? 'step' : 'year'} one value, using all wells at once, so wells joining or leaving the record cannot move the line. The line is the change since the first plotted ${o.bin > 1 ? 'step' : 'year'}; ${o.bin > 1 ? 'steps' : 'years'} with fewer than ${o.minN} wells are left empty and nothing is interpolated. ${o.cellKm ? `Wells in the same ${o.cellKm} km cell share one vote each year. ` : ''}The shaded band is the 95% bootstrap range of the median, from resampling groups of nearby wells${state.showIqr ? '; the dotted band holds the middle half of the wells' : ''}. Trends are Theil–Sen slopes with Mann–Kendall tests (p values are optimistic because yearly values are autocorrelated).</p>
    <div class="r-foot">Data: NM Unified Water Data API (NMBGMR, USGS, OSE and other agencies)${state.valueMode === 'elevation' ? '; elevations NAVD 88 (NGVD 29 converted with NOAA VERTCON) or USGS 3DEP' : ''}.${o.bin === 5 ? ' Five-year steps follow Myers (2022), USGS OFR 2022-1008.' : ''} NM Hydrograph Explorer, ${escHtml(location.href.split('#')[0])}</div>`;
  if(wasTheme === 'dark'){ applyTheme('dark'); renderChart(); }
  if(wasWells) setView('wells');
  return {title, wells: res.qualifying.length, years: [yrs[F], yrs[Lx]], chars: box.innerHTML.length};
}
async function hxReportPrint(){
  try{
    const r = await hxReportBuild();
    document.body.classList.add('hx-printing');
    const done = () => { document.body.classList.remove('hx-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 1500); }, 200);
    return r;
  }catch(e){ toast(e.message || String(e)); }
}
{ const b = document.getElementById('btn-report'); if(b) b.addEventListener('click', hxReportPrint); }
window.__hx = Object.assign(window.__hx || {}, {reportBuild: hxReportBuild});

// ---- replication check: Myers (2022), USGS OFR 2022-1008 --------------------------------------------------------
// Used by tools/regress.py with the well lists in tools/myers-2022-groups.json: Myers's own procedure run on this tool's
// readings, so a change anywhere in loading or reading handling that shifts these numbers shows up as a failed check.
// Per well: median of its readings (current Reading-quality rules) in each 5-year bin of water years, bins from 1980;
// a well qualifies with a reading in every bin from the group's start bin to 2015-19; result per bin = mean and median of
// the qualifying wells' bin medians; change = last bin minus first bin, in depth to water (+ = deeper).
function hxMyersGroup(siteNumbers, startBin, endBin){
  const R = BOOT.raw, pass = readPass(), b0 = Math.floor((startBin - 1980) / 5), b1 = Math.floor(((endBin || 2015) - 1980) / 5), nb = b1 - b0 + 1;
  let found = 0; const per = [];
  siteNumbers.forEach(id => {
    const s = hxuSite('USGS-NWIS~USGS-' + id); if(s == null || !R || s >= R.off.length - 1) return; found++;
    const bins = Array.from({length: nb}, () => []);
    for(let i = R.off[s]; i < R.off[s + 1]; i++){
      if(!pass(R.fl[i])) continue;
      const di = wvDayInfo(R.day[i]), wy = di.month >= 10 ? di.year + 1 : di.year, b = Math.floor((wy - 1980) / 5) - b0;
      if(b >= 0 && b < nb) bins[b].push(R.v[i] / 100);
    }
    if(bins.every(a => a.length)) per.push(bins.map(a => OT.median(a)));
  });
  const meanB = [], medB = [];
  for(let b = 0; b < nb; b++){ const v = per.map(p => p[b]); meanB.push(v.length ? v.reduce((a, c) => a + c, 0) / v.length : null); medB.push(v.length ? OT.median(v) : null); }
  const r2 = v => v == null ? null : Math.round(v * 100) / 100;
  return {listed: siteNumbers.length, found, qualifying: per.length, meanChange: per.length ? r2(meanB[nb - 1] - meanB[0]) : null, medianChange: per.length ? r2(medB[nb - 1] - medB[0]) : null, meanBins: meanB.map(r2), medianBins: medB.map(r2)};
}
window.__hx = Object.assign(window.__hx || {}, {myersGroup: hxMyersGroup});

// ---- regional water table: each well's level against a statewide water-table map ---------------------------------
// nm-water-table.bin (next to the page) is the water-level-elevation contours (100-ft interval) of the NMBGMR (2026) Depth to
// Water Map of New Mexico v2 (OSE driller depths at completion, 1940s to now; Data Integration Engine wells reduced to one mean
// each; springs at 0 ft; IDW in dense areas, kriging elsewhere), gridded at 0.01° by linear interpolation between the contours.
// Each well's "head against the regional water table" = its mean water-level elevation (land elevation − mean of its yearly
// depths to water, which is how the map reduced its time series) minus the map's water-table elevation at the well.
//   about 0  : on the regional (mostly shallow, unconfined) water table
//   negative : below it (a deeper or depressurised unit, a pumping cone, or a bad elevation)
//   positive : above it (an artesian or perched unit, or a bad elevation)
// Tested on all wells: deep wells depart far more often (> 1,200 ft deep: 18% more than 100 ft above, 41% more than 100 ft below;
// < 100 ft deep: 6% and 5%). It separates stacked units only where their heads differ (the Roswell artesian aquifer), not where
// they are connected (Ogallala over Cretaceous, Pecos Valley alluvium over the Dockum), so it is a filter and a grouping, never
// an automatic aquifer assignment.
var HX_WT_FILE = 'nm-water-table.bin';
var HX_WT_CITE = 'NMBGMR (2026), Depth to Water Map of New Mexico, v2 (water-level-elevation contours), gridded by this tool';
var HX_WTC = [[-200, '#7f2704', '≤ −200 ft (far below)'], [-100, '#d94801', '−200 to −100'], [-50, '#fdae6b', '−100 to −50'], [50, '#d9d9d9', '±50 ft (on the water table)'], [100, '#9ecae1', '+50 to +100'], [200, '#4292c6', '+100 to +200'], [Infinity, '#08306b', '≥ +200 ft (far above)']];
var hxWt = {grid: null, p: null, note: '', key: null, res: null, wle: null, lvl: null, elev: null, nbKey: null, nb: null};
function hxWtLoad(){
  if(hxWt.p) return hxWt.p;
  hxWt.p = (async () => {
    try{
      const r = await fetch(HX_WT_FILE, {cache: 'force-cache'}); if(!r.ok) throw new Error('HTTP ' + r.status);
      const raw = window.pako.inflate(new Uint8Array(await r.arrayBuffer()));
      if(raw[0] !== 78 || raw[1] !== 77 || raw[2] !== 87 || raw[3] !== 84) throw new Error('not a water-table grid');
      const hl = new DataView(raw.buffer, raw.byteOffset, 8).getUint32(4, true), h = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + hl)));
      const b = raw.slice(8 + hl), v = new Int16Array(b.buffer, 0, h.nx * h.ny);
      hxWt.grid = {h, v};
    }catch(e){ hxWt.note = 'The regional water-table map (' + HX_WT_FILE + ') is not next to the page (' + (e.message || e) + '), so this is unavailable.'; }
    hxWtStatus(); return hxWt.grid;
  })();
  return hxWt.p;
}
// bilinear; cells with no value are left out of the weights
function hxWtAt(lon, lat){
  const G = hxWt.grid; if(!G || lon == null || lat == null) return NaN;
  const h = G.h, fx = (lon - h.lon0) / h.step, fy = (lat - h.lat0) / h.step, x0 = Math.floor(fx), y0 = Math.floor(fy);
  if(x0 < 0 || y0 < 0 || x0 >= h.nx - 1 || y0 >= h.ny - 1) return NaN;
  const tx = fx - x0, ty = fy - y0; let s = 0, w = 0;
  [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]].forEach(([dx, dy, wt]) => {
    const v = G.v[(y0 + dy) * h.nx + x0 + dx]; if(v !== h.nodata && wt > 0){ s += v * wt; w += wt; } });
  return w > 0.25 ? s / w : NaN;
}
function hxWtElev(s){ const a = siteElevApi[s], d = siteDem[s]; return state.useDem ? (isFinite(d) ? d : a) : (isFinite(a) ? a : d); }
function hxWtKey(){ return [hxWt.grid ? 1 : 0, otDataVer, SITE_YEAR.length, state.useDem ? 1 : 0, typeof hxDatum !== 'undefined' ? (hxDatum.on ? 1 : 0) + ':' + hxDatum.shifted : ''].join('|'); }
// per-well residuals for the whole state (cheap: one pass over the yearly table)
function hxWtEnsure(){
  if(!hxWt.grid){ hxWtLoad(); return false; }
  const key = hxWtKey(); if(hxWt.key === key) return true;
  const sum = new Float64Array(NSITES), n = new Uint16Array(NSITES);
  for(const r of SITE_YEAR){ sum[r[0]] += r[2]; n[r[0]]++; }
  const res = new Float32Array(NSITES).fill(NaN), wle = new Float32Array(NSITES).fill(NaN), lvl = new Float32Array(NSITES).fill(NaN), el = new Float32Array(NSITES).fill(NaN);
  for(let s = 0; s < NSITES; s++){
    const r = SITES[s], w = hxWtAt(r[1], r[2]); wle[s] = w; const e = hxWtElev(s); el[s] = e;
    if(!n[s] || !isFinite(w) || !isFinite(e)) continue;
    lvl[s] = e - sum[s] / n[s]; res[s] = lvl[s] - w;
  }
  Object.assign(hxWt, {key, res, wle, lvl, elev: el, nbKey: null});
  return true;
}
function hxWtRes(s){ return hxWtEnsure() ? hxWt.res[s] : NaN; }
// depth of the regional water table below land at the well, and how far the well reaches below it (screen bottom from the
// matched OSE well record when known, else the recorded well depth)
function hxWtDepth(s){ if(!hxWtEnsure()) return NaN; const e = hxWt.elev[s], w = hxWt.wle[s]; return isFinite(e) && isFinite(w) ? e - w : NaN; }
function hxWtBelow(s){
  const d = hxWtDepth(s); if(!isFinite(d)) return NaN;
  const m = typeof hxProd !== 'undefined' && hxProd.by ? hxProd.by.get(s) : null;
  const bot = m && m.pbot > 0 ? m.pbot : SITES[s][4];
  return bot > 0 ? bot - d : NaN;
}
// filter: near (|res| <= tol) or far (> tol); wells that cannot be compared are left out of both
function hxWtPass(s, mode){
  if(!hxWtEnsure()) return true;   // map still loading: keep, re-filtered when it arrives
  const r = hxWt.res[s]; if(!isFinite(r)) return false;
  const t = state.filters.wtTol || 50;
  return mode === 'near' ? Math.abs(r) <= t : mode === 'above' ? r > t : mode === 'below' ? r < -t : Math.abs(r) > t;
}
// well minus the median residual of its neighbours within 5 km (needs >= 5): what is left after the map's local bias
function hxWtNeighbours(){
  if(!hxWtEnsure()) return null; if(hxWt.nbKey === hxWt.key) return hxWt.nb;
  const R = hxWt.res, cell = 0.05, grid = new Map(), cx = Math.cos(34.4 * Math.PI / 180), rel = new Float32Array(NSITES).fill(NaN);
  for(let s = 0; s < NSITES; s++){ if(!isFinite(R[s])) continue; const k = Math.floor(SITES[s][1] / cell) + ':' + Math.floor(SITES[s][2] / cell); let a = grid.get(k); if(!a){ a = []; grid.set(k, a); } a.push(s); }
  for(let s = 0; s < NSITES; s++){
    if(!isFinite(R[s])) continue; const x = SITES[s][1], y = SITES[s][2], gx = Math.floor(x / cell), gy = Math.floor(y / cell), v = [];
    for(let i = -1; i <= 1; i++) for(let j = -1; j <= 1; j++){ const a = grid.get((gx + i) + ':' + (gy + j)); if(!a) continue;
      for(const o of a){ if(o === s) continue; const km = Math.hypot((SITES[o][1] - x) * 111.32 * cx, (SITES[o][2] - y) * 110.57); if(km <= 5) v.push(R[o]); } }
    if(v.length >= 5){ v.sort((a, b) => a - b); rel[s] = R[s] - v[v.length >> 1]; }
  }
  hxWt.nbKey = hxWt.key; hxWt.nb = rel; return rel;
}
function hxWtColor(s){ const r = hxWtRes(s); if(!isFinite(r)) return '#eceeea'; for(const c of HX_WTC) if(r <= c[0]) return c[1]; return HX_WTC[HX_WTC.length - 1][1]; }
function hxWtLegend(){
  const ok = hxWtEnsure(), rows = [`<div class="lg-row" style="font-size:11px; color:var(--muted); margin-bottom:3px;">Well's mean water level minus the regional water table (NMBGMR 2026 map), + = above</div>`];
  HX_WTC.forEach(c => rows.push(`<div class="lg-row"><span class="swatch" style="background:${c[1]}"></span><span class="k">${c[2]}</span></div>`));
  rows.push(`<div class="lg-row"><span class="swatch" style="background:#eceeea; border:1px solid var(--border);"></span><span class="k">${ok ? 'No elevation, no readings or off the map' : 'Loading the water-table map…'}</span></div>`);
  return rows;
}
function hxWtPopup(s){
  if(!hxWtEnsure()) return '';
  const w = hxWt.wle[s]; if(!isFinite(w)) return '';
  const r = hxWt.res[s], t = state.filters.wtTol || 50, b = hxWtBelow(s);
  const where = !isFinite(r) ? 'no elevation or readings to compare' : (r > t ? 'above' : r < -t ? 'below' : 'on') + ' the regional water table (' + hxFmt(r, 0, true) + ' ft)';
  return `<div class="kv"><span>Regional water table</span><span>${Math.round(w).toLocaleString()} ft mapped · well ${where}${isFinite(b) ? ' · reaches ' + Math.round(b).toLocaleString() + ' ft below it' : ''}</span></div>`;
}
function hxWtStatus(){
  const el = document.getElementById('wt-status'); if(!el) return;
  if(!hxWt.grid){ el.textContent = hxWt.note || 'Loading the regional water-table map…'; return; }
  hxWtEnsure();
  const set = state.activeSet && (state.areaSelection || state.clickSelectedSites.size) ? state.activeSet : null, t = state.filters.wtTol || 50;
  let n = 0, near = 0, ab = 0, be = 0;
  const each = s => { const r = hxWt.res[s]; if(!isFinite(r)) return; n++; if(r > t) ab++; else if(r < -t) be++; else near++; };
  if(set && !(state.filters.wt && state.filters.wt !== 'all')) set.forEach(each); else for(let s = 0; s < NSITES; s++) each(s);
  el.textContent = `${set && !(state.filters.wt && state.filters.wt !== 'all') ? 'Selected' : 'All'} wells with an elevation and readings: ${n.toLocaleString()} — ${near.toLocaleString()} within ±${t} ft of the regional water table, ${ab.toLocaleString()} above, ${be.toLocaleString()} below. Map: ${HX_WT_CITE}. It shows the regional, mostly shallow water table; it separates confined (artesian) or perched wells from water-table wells, but not stacked aquifers that share one head.`;
}
function hxWtInit(){
  const prod = document.getElementById('sec-prod'); if(!prod || document.getElementById('sec-wt')) return;
  const sec = document.createElement('div'); sec.className = 'section'; sec.id = 'sec-wt';
  sec.innerHTML = '<h4>Regional water table</h4><select class="selfield" id="wt-filter"><option value="all">All wells</option><option value="near">Only wells on the regional water table</option><option value="far">Only wells off it (above or below)</option><option value="above">Only wells above it (artesian or perched)</option><option value="below">Only wells below it (deeper unit)</option></select>'
    + '<div class="numrow" style="margin-top:6px;"><label style="flex:1.4; font-size:12px; color:var(--ink-2);">On the water table if within</label><select class="selfield" id="wt-tol" style="flex:1;"><option value="25">±25 ft</option><option value="50" selected>±50 ft</option><option value="100">±100 ft</option><option value="200">±200 ft</option></select></div>'
    + '<p class="hint" id="wt-status"></p>';
  prod.before(sec);
  document.getElementById('wt-filter').addEventListener('change', async e => { state.filters.wt = e.target.value; await hxWtLoad(); recomputeActiveSet(); hxWtStatus(); });
  document.getElementById('wt-tol').addEventListener('change', e => { state.filters.wtTol = +e.target.value; recomputeActiveSet(); hxWtStatus(); if(state.colorBy === 'wtres'){ restyleMarkers(); renderLegend(); } });
  const sel = document.getElementById('colorby-select');
  if(sel && !sel.querySelector('option[value=wtres]')){ const o = document.createElement('option'); o.value = 'wtres'; o.textContent = 'Color: Head against the regional water table'; sel.appendChild(o); }
  const gm = document.getElementById('group-mode');
  if(gm && !gm.querySelector('option[value=wtres]')){
    const og = gm.querySelector('optgroup'); // "By depth"
    [['wtres', 'Head against the regional water table'], ['belowwt', 'Depth reached below the regional water table'], ['screen', 'Top of the screened interval (OSE well record)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; og.appendChild(o); });
  }
  state.filters.wt = state.filters.wt || 'all'; state.filters.wtTol = state.filters.wtTol || 50;
  hxWtLoad().then(g => { if(!g) return; if(state.colorBy === 'wtres'){ restyleMarkers(); renderLegend(); } if(state.filters.wt && state.filters.wt !== 'all') recomputeActiveSet(); hxWtStatus(); });
}
hxWtInit();
window.__hx = Object.assign(window.__hx || {}, {get wt(){ return hxWt; }, wtRes: hxWtRes, wtBelow: hxWtBelow, wtNeighbours: hxWtNeighbours});

// ---- area units by aquifer outline -------------------------------------------------------------------------------
// The NM 2-D aquifer extents are hydrogeologic units, so they make better area units than watersheds. A well's unit is its
// combination of extents: where extents overlap (stacked aquifers) the overlap is its own unit, because no statewide rule can
// tell which of the stacked aquifers a well is in (tested against the SE NM depth-to-unit rasters: head against the regional
// water table or depth below it got 61-82% right, near chance in the Pecos Valley). Each unit is weighted by its area inside
// the selection (or within 5 km of the clicked wells), counted on a 2 km grid.
function hxAqUnitOf(s){ const e = SITES[s][15]; return e && e.length ? 'aq:' + e.slice().sort((a, b) => a - b).join('+') : 'aq:none'; }
function hxAqUnitName(u){ if(!u || u === 'aq:none') return 'Outside the mapped aquifer extents'; return u.slice(3).split('+').map(i => (AQUIFER_EXTENT_NAMES[+i] || '?').replace(/_/g, ' ')).join(' + '); }
var hxAqArea = {key: null, map: null};
function hxAqUnitAreas(maps){
  const sel = state.areaSelection, sites = maps.map(m => m._s).filter(s => s != null);
  const key = (sel ? (sel.type || '') + '|' + (sel.label || '') : 'w:' + [...new Set(sites)].sort((a, b) => a - b).join(','));
  if(hxAqArea.key === key && hxAqArea.map) return hxAqArea.map;
  const out = new Map(), step = 0.02, cx = Math.cos(34.4 * Math.PI / 180), cellKm2 = (step * 111.32 * cx) * (step * 110.57);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const pts = [...new Set(sites)].map(s => [SITES[s][1], SITES[s][2]]).filter(p => p[0] != null && p[1] != null);
  if(!pts.length){ hxAqArea = {key, map: out}; return out; }
  if(sel && sel.polygons && sel.polygons.length){ sel.polygons.forEach(poly => poly[0].forEach(p => { if(p[0] < x0) x0 = p[0]; if(p[0] > x1) x1 = p[0]; if(p[1] < y0) y0 = p[1]; if(p[1] > y1) y1 = p[1]; })); }
  else { pts.forEach(p => { x0 = Math.min(x0, p[0] - 0.06); x1 = Math.max(x1, p[0] + 0.06); y0 = Math.min(y0, p[1] - 0.05); y1 = Math.max(y1, p[1] + 0.05); }); }
  const near = (x, y) => pts.some(p => Math.abs(p[0] - x) < 0.06 && Math.abs(p[1] - y) < 0.05 && Math.hypot((p[0] - x) * 111.32 * cx, (p[1] - y) * 110.57) <= 5);
  const inSel = sel && sel.polygons && sel.polygons.length ? ((x, y) => pointInPolygons(x, y, sel.polygons)) : near;
  for(let y = y0 + step / 2; y < y1; y += step) for(let x = x0 + step / 2; x < x1; x += step){
    if(!inSel(x, y)) continue;
    const e = []; for(let i = 0; i < AQUIFER_EXTENT_POLYGONS.length; i++) if(pointInPolygons(x, y, AQUIFER_EXTENT_POLYGONS[i])) e.push(i);
    const u = e.length ? 'aq:' + e.join('+') : 'aq:none'; out.set(u, (out.get(u) || 0) + cellKm2);
  }
  // a unit holding wells but no grid cell (a sliver at an extent edge) still gets one cell's area
  new Set(sites.map(hxAqUnitOf)).forEach(u => { if(!out.has(u)) out.set(u, cellKm2); });
  hxAqArea = {key, map: out}; return out;
}

// ---- one-click screening like the NMBGMR storage-change reports (Rinehart et al. 2015, 2016; Rinehart & Mamer 2017) ----
// Their "non-irrigated season" standard: only readings from November through February (Mar 1 - Oct 31 removed), no readings
// flagged as pumping or affected, median per decade. Here: Season Nov-Feb, "Exclude pumping / affected readings" on, 10-year
// time step. Their kriging, clipping and specific yield are not applied; this matches their screening, not their maps.
function hxNmbgmrPreset(){
  const nd = document.getElementById('rq-nodist'); if(nd && !nd.checked){ nd.checked = true; readQFromControls(); }
  setSeasonRange(11, 2, [...document.querySelectorAll('.season-btn')].find(b => +b.dataset.ms === 11 && +b.dataset.me === 2) || null);
  state.otp.bin = 10; syncOtUi(); renderChart();
  toast('NMBGMR screening on: November–February readings only, no pumping/affected readings, 10-year steps (1950s, 1960s …).');
}
(function hxPresetInit(){
  const bin = document.getElementById('ot-bin'); if(!bin || document.getElementById('btn-nmbgmr-preset')) return;
  const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.id = 'btn-nmbgmr-preset'; b.style.cssText = 'margin-top:6px; padding:4px 10px; font-size:12px;';
  b.textContent = 'Use the NMBGMR storage-change screening';
  b.title = 'November–February readings only, no pumping/affected readings, 10-year steps, as in Rinehart et al. (2015, 2016) and Rinehart & Mamer (2017)';
  b.addEventListener('click', hxNmbgmrPreset);
  const hint = bin.nextElementSibling && bin.nextElementSibling.classList.contains('hint') ? bin.nextElementSibling : bin; hint.after(b);
})();
window.__hx = Object.assign(window.__hx || {}, {aqUnitOf: hxAqUnitOf, aqUnitAreas: hxAqUnitAreas, nmbgmrPreset: hxNmbgmrPreset});

// ---- check against the State Engineer's January 1966 observation-well tables (Technical Report 34) ------------------
// tools/tr34-1966-wells.json lists, per monitoring area, the report's wells matched to their API wells (by location number
// and the published level on the published date). For a list of wells this returns each well's winter level
// (median of its November-March readings, Nov-Dec counted with the next year) in two years, their mean change, and the change
// of the tool's matched-wells fit over every year from y0-5 to y1+5 for the same wells, all in feet of depth to water
// (+ = deeper). Used by the regression test; exposed as __hx.histGroup.
// at (optional): key -> 'YYYY-MM-DD' of the published reading; each year's value is then the reading nearest that month and
// day of the year (within 31 days), as the report measured, instead of the winter median
function hxHistGroup(keys, y0, y1, at){
  const R = BOOT.raw, pass = readPass(), lo = y0 - 5, hi = y1 + 5, maps = [], ch = []; let found = 0;
  keys.forEach(k => {
    const s = hxuSite(k); if(s == null || !R || s >= R.off.length - 1) return; found++;
    const by = new Map();
    for(let i = R.off[s]; i < R.off[s + 1]; i++){
      if(!pass(R.fl[i])) continue;
      const di = wvDayInfo(R.day[i]); if(di.month > 3 && di.month < 11) continue;
      const y = di.month >= 11 ? di.year + 1 : di.year; if(y < lo || y > hi) continue;
      let a = by.get(y); if(!a){ a = []; by.set(y, a); } a.push(R.v[i] / 100);
    }
    const m = new Map(); by.forEach((a, y) => m.set(y, OT.median(a))); m._s = s;
    if(m.size >= 2) maps.push(m);
    if(at && at[k]){
      const md = at[k].slice(5), near = y => { const c = rawDayOf(y + '-' + md); let best = null, bd = 32;
        for(let i = R.off[s]; i < R.off[s + 1]; i++){ if(!pass(R.fl[i])) continue; const d = Math.abs(R.day[i] - c); if(d < bd){ bd = d; best = R.v[i] / 100; } } return best; };
      const a = near(y0), b = near(y1); if(a != null && b != null) ch.push(b - a);
    } else if(m.has(y0) && m.has(y1)) ch.push(m.get(y1) - m.get(y0));
  });
  const years = []; for(let y = lo; y <= hi; y++) years.push(y);
  let fit = null;
  if(maps.length >= 2){ const c = otFixedEffects(maps, years, 1, 0), a = c.med[y0 - lo], b = c.med[y1 - lo]; if(a != null && b != null) fit = b - a; }
  const mean = ch.length ? ch.reduce((x, y) => x + y, 0) / ch.length : null;
  return {found, nBoth: ch.length, meanChange: mean, fitChange: fit};
}
window.__hx = Object.assign(window.__hx || {}, {histGroup: hxHistGroup});

setTimeout(()=>{ apiLoadClusters().catch(e=>{ console.warn('clusters failed', e); apiState.clusters = 'error'; }); }, 400);
BOOT.ui.done();
})().catch(e=>{ console.error(e); if(window.__bootFail) window.__bootFail(e); });