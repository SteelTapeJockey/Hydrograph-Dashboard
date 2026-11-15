// ---- Water systems: one system's page ----------------------------------------------------------------------------------------
// Wells and springs with their OSE well records (and unconfirmed ones to accept or reject), a hydrograph of a chosen water-level
// well with that well's normal range for the time of year, drought triggers and the current status, metered pumping, and a
// printable summary for hazard-mitigation planning.
//
// Status of the latest reading (wsStatus, a pure function):
//   level triggers  the reading is compared with the same well's readings in the same three calendar months (the month and its
//                   neighbours) over the baseline years: deeper than the watch / warning percentile, or deeper than any of them
//                   (emergency). Fewer than WS_MIN_BASE such readings: all the well's baseline readings are used instead.
//   water above the pump  only for the system's own well, once a pump-intake depth is entered (screen top is offered as a
//                   stand-in): intake depth minus depth to water against the watch / warning / emergency feet.
//   The status is the more severe of the two. Defaults are starting points to set with the operator.
var WS_MIN_BASE = 5;
var WS_STALE_MONTHS = 24;   // older latest readings get no current status
var WS_TRIG_DEFAULT = {pWatch: 75, pWarn: 90, ftWatch: 50, ftWarn: 25, ftEmerg: 10, baseFrom: null, baseTo: null, dropPumped: true, years: 20};
var WS_LEVELS = ['normal', 'watch', 'warning', 'emergency'];
var WS_LEVEL_COLOR = {normal: 'var(--accent)', watch: '#c9a227', warning: 'var(--warn)', emergency: '#7e2418', none: 'var(--muted)'};

function wsPct(sorted, q){ if(!sorted.length) return NaN; const p = (sorted.length - 1) * q, i = Math.floor(p), f = p - i; return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i]; }
// The baseline: the well's readings over the baseline years. "Time of year" (seasonal) when at least 9 of the 12 calendar months
// have WS_MIN_BASE readings in their three-month window (the month and its neighbours); otherwise one range from every month,
// which suits wells measured once or twice a year.
function wsBaseline(series, from, to){
  const pts = series.filter(p => (from == null || p.y >= from) && (to == null || p.y <= to));
  const near = (p, m) => { const d = Math.abs(p.m - m); return d <= 1 || d === 11; };
  const win = [];
  for(let m = 1; m <= 12; m++) win[m] = Float64Array.from(pts.filter(p => near(p, m)).map(p => p.v)).sort();
  const seasonal = win.slice(1).filter(v => v.length >= WS_MIN_BASE).length >= 9;
  const all = Float64Array.from(pts.map(p => p.v)).sort();
  return {seasonal, n: pts.length, forMonth: m => seasonal && win[m].length >= WS_MIN_BASE ? win[m] : all};
}
function wsStatus(series, trig, intakeFt){
  trig = Object.assign({}, WS_TRIG_DEFAULT, trig || {});
  if(!series || !series.length) return {level: 'none', why: 'No readings.'};
  const last = series[series.length - 1];
  // the latest reading is not part of its own baseline
  const B = wsBaseline(series.slice(0, -1), trig.baseFrom, trig.baseTo), v = B.forMonth(last.m);
  const out = {last, seasonal: B.seasonal, nBase: v.length, level: 'normal', parts: []};
  if(v.length >= WS_MIN_BASE){
    const pW = wsPct(v, trig.pWatch / 100), pX = wsPct(v, trig.pWarn / 100), deepest = v[v.length - 1];
    const rank = v.filter(x => x < last.v).length / v.length * 100;   // % of baseline readings shallower than the latest
    out.pWatch = pW; out.pWarn = pX; out.deepest = deepest; out.rank = rank;
    const lvl = last.v > deepest ? 'emergency' : last.v > pX ? 'warning' : last.v > pW ? 'watch' : 'normal';
    out.parts.push({kind: 'level', level: lvl});
  } else out.parts.push({kind: 'level', level: 'none'});
  if(intakeFt != null && isFinite(intakeFt) && intakeFt > 0){
    const above = intakeFt - last.v; out.above = above; out.intake = intakeFt;
    const lvl = above < trig.ftEmerg ? 'emergency' : above < trig.ftWarn ? 'warning' : above < trig.ftWatch ? 'watch' : 'normal';
    out.parts.push({kind: 'intake', level: lvl});
  }
  const lv = out.parts.map(p => WS_LEVELS.indexOf(p.level)).filter(i => i >= 0);
  out.level = lv.length ? WS_LEVELS[Math.max(...lv)] : 'none';
  out.ageMonths = (new Date().getFullYear() * 12 + new Date().getMonth()) - (last.y * 12 + last.m - 1);
  // a reading more than WS_STALE_MONTHS old says nothing about today
  if(out.ageMonths > WS_STALE_MONTHS){ out.stale = true; out.levelThen = out.level; out.level = 'none'; }
  return out;
}

// per-system settings (triggers, intake depths), kept in this browser
function wsTrigOf(id){ const all = wsStore.get('hxWsTrig', {}); return Object.assign({}, WS_TRIG_DEFAULT, all[id] || {}); }
function wsSetTrig(id, patch){ const all = wsStore.get('hxWsTrig', {}); all[id] = Object.assign({}, all[id] || {}, patch); wsStore.set('hxWsTrig', all); }
function wsIntakeOf(sys, w){ const all = wsStore.get('hxWsIntake', {}); const v = all[wsSrcKey(sys, w)]; return v == null ? null : +v; }
function wsSetIntake(sys, w, v){ const all = wsStore.get('hxWsIntake', {}); const k = wsSrcKey(sys, w); if(v == null || v === '' || !isFinite(+v)) delete all[k]; else all[k] = +v; wsStore.set('hxWsIntake', all); }

// the reference wells offered for a system: its own wells first, then nearby wells with readings, nearest first
function wsRefList(sys){
  const own = sys._own.map(o => Object.assign({own: true}, o)), near = sys._near.filter(o => (SITES[o.s][5] || 0) >= 3).slice(0, 12).map(o => Object.assign({own: false}, o));
  return own.concat(near);
}
function wsRefDefault(sys){
  const L = wsRefList(sys), since = WS.f.since;
  return (L.find(r => r.own && (SITES[r.s][7] || 0) >= since) || L.find(r => r.own) || L.find(r => (SITES[r.s][7] || 0) >= since) || L[0] || {}).s;
}
function wsSrcName(s){ const r = SITES[s]; return (r[3] >= 0 ? SOURCES[r[3]] : '') ; }

function wsHowTag(o){
  if(!o) return '';
  if(o.how === '5 m') return `<span class="ws-how loc" title="OSE record within 5 m of NMED's location">within 5 m</span>`;
  if(o.how === 'owner and depth') return `<span class="ws-how od" title="OSE record ${wsFmt(o.m)} m from NMED's location; owner names the system and the well depth agrees">owner + depth, ${wsFmt(o.m)} m</span>`;
  if(o.how === 'accepted') return `<span class="ws-how you" title="Accepted by you">accepted, ${wsFmt(o.m)} m</span>`;
  return '';
}
function wsScreens(o){ return o && o.ptop ? `screen ${wsFmt(o.ptop)}${o.pbot ? '–' + wsFmt(o.pbot) : ''} ft` : ''; }
function wsLastPump(o){ if(!o || !o.pump || !o.pump.length) return ''; const p = o.pump.filter(x => x[0] !== WS.partialYr); const l = p[p.length - 1] || o.pump[o.pump.length - 1]; return `${wsFmt(l[1], l[1] < 10 ? 2 : 1)} AF in ${l[0]}`; }

function wsRenderDetail(){
  const el = document.getElementById('ws-detail'), sys = WS.byId.get(WS.sel); if(!el || !sys) return;
  if(WS.pageChart){ WS.pageChart.destroy(); WS.pageChart = null; }
  if(WS.pumpChart){ WS.pumpChart.destroy(); WS.pumpChart = null; }
  if(WS.ref == null || !wsRefList(sys).some(r => r.s === WS.ref)) WS.ref = wsRefDefault(sys);
  const trig = wsTrigOf(sys.id), open = WS.openCands || (WS.openCands = new Set());
  const dmTxt = sys._dm == null ? 'loading…' : sys._dm < 0 ? 'none this week' : ['D0 abnormally dry', 'D1 moderate', 'D2 severe', 'D3 extreme', 'D4 exceptional'][sys._dm];
  const ownSet = new Set(sys._own.map(o => o.s));
  const wellRows = sys.wells.map((w, wi) => {
    const o = w._ose, key = wsSrcKey(sys, w), ch = wsChoices()[key], nC = (w.cand || []).filter(c => !o || c.pod !== o.pod).length;
    const own = (w._own || []).map(s => `<a href="#" class="linklike" data-ref="${s}">${escHtml(SITES[s][0])}</a>`).join(', ');
    const intake = wsIntakeOf(sys, w);
    let h = `<tr><td><b>${escHtml(w.name || 'Source')}</b><small>${escHtml(w.fid)}${w.water === 'SW' ? ' · surface water' : ''}${w.avail ? ' · ' + escHtml({P: 'permanent', S: 'seasonal', E: 'emergency', I: 'interim', O: 'other', U: 'unknown'}[w.avail] || w.avail) : ''}</small></td>
      <td><span class="m">${w.depth ? wsFmt(w.depth) + ' ft' : '–'}</span><small>${w.swl ? 'static ' + wsFmt(w.swl) + ' ft' + (w.swl_date ? ' (' + w.swl_date.slice(0, 4) + ')' : '') : ''}</small></td>
      <td>${o ? `<b class="m">${escHtml(o.pod)}</b> ${wsHowTag(o)}<small>${escHtml([o.use, o.depth ? wsFmt(o.depth) + ' ft deep' : '', wsScreens(o), o.plss ? 'located by PLSS section' : '', o.year ? 'drilled ' + o.year : ''].filter(Boolean).join(' · '))}</small>`
        : `<span style="color:var(--muted)">${ch && ch.pod === null ? 'rejected by you' : 'no record matched'}</span>`}
        ${nC ? `<div><button class="ws-cands-btn ws-noprint" data-cands="${wi}">${open.has(key) ? 'Hide' : 'Show'} ${nC} unconfirmed record${nC === 1 ? '' : 's'} nearby</button></div>` : ''}
        ${o && o.how !== 'accepted' ? `<div class="ws-noprint"><button class="ws-cands-btn" data-reject="${wi}" title="Mark this as not the source's own well record">Not this well</button></div>` : ''}
        ${ch ? `<div class="ws-noprint"><button class="ws-cands-btn" data-undo="${wi}">Undo my choice</button></div>` : ''}</td>
      <td class="m">${o && o.pump ? wsLastPump(o) : (o && o.metered ? '<span style="color:var(--muted)">metered, no readings</span>' : '–')}</td>
      <td>${own || '<span style="color:var(--muted)">none</span>'}</td>
      <td class="ws-noprint"><input type="number" class="numfield" style="width:78px" data-intake="${wi}" value="${intake == null ? '' : intake}" placeholder="${o && o.ptop ? wsFmt(o.ptop) : 'ft'}" title="Pump intake depth, ft below land surface (from the operator). Leave blank to use the top of the screen when it is known."></td></tr>`;
    if(open.has(key)) (w.cand || []).filter(c => !o || c.pod !== o.pod).forEach(c => {
      h += `<tr class="cand"><td colspan="2">${wsFmt(c.m)} m away${c.owner_match ? ' · <b>owner matches</b>' : ''}${c.depth_match ? ' · <b>depth matches</b>' : ''}</td>
        <td><span class="m">${escHtml(c.pod)}</span> <small>${escHtml([c.owner, c.use, c.depth ? wsFmt(c.depth) + ' ft deep' : '', wsScreens(c), c.plss ? 'PLSS-located' : ''].filter(Boolean).join(' · '))}</small></td>
        <td class="m">${c.pump ? wsLastPump(c) : '–'}</td><td colspan="2"><button class="btn mini" data-accept="${wi}" data-pod="${escHtml(c.pod)}">This is the well</button></td></tr>`;
    });
    return h;
  }).join('');
  const refs = wsRefList(sys);
  const refBtns = refs.map(r => { const S = SITES[r.s]; return `<button class="ws-ref ${r.s === WS.ref ? 'active' : ''}" data-ref="${r.s}">
      <span class="a">${escHtml(S[0])}${r.own ? ' <span class="ws-tag own">own</span>' : ''}</span>
      <span class="b">${escHtml(wsSrcName(r.s))} · ${r.own ? escHtml(r.how) : wsDist(r.d)} · ${S[4] ? wsFmt(S[4]) + ' ft deep · ' : ''}${S[6] && S[7] ? S[6] + '–' + S[7] : 'no readings'}</span></button>`; }).join('');
  const pumpYrs = [...sys._pumpYrs.keys()].sort((a, b) => a - b);
  el.innerHTML = `
  <div class="ws-card">
    <div class="ws-title"><div><h3>${escHtml(sys.name)}</h3>
      <div class="sub">${escHtml(sys.id)} · ${escHtml([sys.city, sys.county + ' County'].filter(Boolean).join(', '))}${sys.office ? ' · NMED ' + escHtml(sys.office) : ''}</div></div>
      <div class="spacer"></div>
      <div class="acts ws-noprint"><button class="btn" id="ws-to-map" title="Select the service area and the wells within ${WS.f.radius} mi of the system's sources on the Map screen, to use every other tool in this explorer on them">Open on the Map screen</button>
        <button class="btn" id="ws-print" title="A printable summary of this page (or save it as a PDF from the print dialog)">Print summary</button></div></div>
    <div class="ws-facts">
      <div class="ws-fact"><div class="v">${wsFmt(sys.pop)}</div><div class="l">people served · ${sys.size} system${sys.mdw ? ' · mutual domestic' : ''}</div></div>
      <div class="ws-fact"><div class="v">${sys.wells.length}</div><div class="l">sources (NMED) · ${sys._nOse} with an OSE well record · ${sys._nPump} metered</div></div>
      <div class="ws-fact"><div class="v">${sys.store_gal ? wsFmt(sys.store_gal) : '–'}</div><div class="l">gallons of storage (NMED)</div></div>
      <div class="ws-fact"><div class="v">${sys._pumpAf == null ? '–' : wsFmt(sys._pumpAf, 1) + ' AF'}</div><div class="l">${sys._pumpAf == null ? 'no metered pumping found' : 'pumped in ' + sys._pumpLast + (sys._gpcd ? ' · ' + wsFmt(sys._gpcd) + ' gal/person/day' : '') + (sys._nPump < sys.wells.length ? ' (metered wells only)' : '')}</div></div>
      <div class="ws-fact"><div class="v">${wsDmChip(sys._dm)}</div><div class="l">Drought Monitor: ${dmTxt}${wsDroughtDate() ? ' (map of ' + wsDroughtDate() + ')' : ''}</div></div>
      <div class="ws-fact"><div class="v">${sys._mon === 'own' ? 'own well' : sys._mon === 'near' ? wsDist(sys._nearest.d) : 'gap'}</div><div class="l">${sys._mon === 'own' ? 'a water-level well at a source' : sys._mon === 'near' ? 'to the nearest well measured since ' + WS.f.since : 'no water-level well within ' + WS.f.radius + ' mi measured since ' + WS.f.since}</div></div>
    </div>
  </div>
  <div class="ws-card">
    <h4>Wells and springs<span class="spacer"></span><span style="text-transform:none;letter-spacing:0;font-weight:400" class="ws-noprint">OSE records are matched within ${WS.D.rules.match_m} m, or within ${WS.D.rules.confirm_m} m when the owner names the system and the depth agrees</span></h4>
    <div style="overflow-x:auto"><table class="ws-wells"><thead><tr><th>Source (NMED)</th><th>Depth</th><th>Own OSE well record</th><th>Metered pumping</th><th>Water-level well here</th><th class="ws-noprint">Pump intake</th></tr></thead><tbody>${wellRows}</tbody></table></div>
    <p class="hint">Choices you make here (accepting a nearby record, rejecting a match, intake depths) are kept in this browser; <b>Well matches (CSV)</b> lists them for every system, to send back into the data.</p>
  </div>
  <div class="ws-card">
    <h4>Water levels and drought triggers</h4>
    ${refs.length ? `<div class="ws-refs ws-noprint">${refBtns}</div>` : ''}
    <div class="ws-tools ws-noprint">
      <label>Show <select id="ws-years"><option value="10">10 years</option><option value="20">20 years</option><option value="40">40 years</option><option value="0">whole record</option></select></label>
      <label title="Years whose readings set the normal range (blank: the whole record)">Baseline <input type="number" id="ws-bfrom" placeholder="from" value="${trig.baseFrom ?? ''}"> – <input type="number" id="ws-bto" placeholder="to" value="${trig.baseTo ?? ''}"></label>
      <label title="Readings qualified as pumping or affected, and readings far below the well's usual winter level (likely pumped), are left out"><input type="checkbox" id="ws-droppump" ${trig.dropPumped ? 'checked' : ''}> Leave out pumped readings</label>
      <span class="spacer"></span><button class="btn mini" id="ws-ref-open" title="Open this well in the explorer's single-well window">Well details</button><button class="btn mini" id="ws-lv-csv">Readings and status (CSV)</button>
    </div>
    <div class="ws-chartbox"><canvas id="ws-lv-canvas"></canvas><div class="ws-chart-empty" id="ws-lv-empty" hidden></div></div>
    <div class="ws-status-row"><div id="wsy-status"></div><div class="ws-trig" id="wsy-trig"></div></div>
  </div>
  <div class="ws-card">
    <h4>Metered pumping (OSE)</h4>
    ${pumpYrs.length ? `<div class="ws-chartbox short"><canvas id="ws-pump-canvas"></canvas></div>
      <p class="hint">Diversion-meter totals by OSE accounting year from the State Engineer's NMWRRS reports, for the ${sys._nPump} of ${sys.wells.length} sources whose own OSE record has readings${WS.partialYr && pumpYrs.includes(WS.partialYr) ? `; ${WS.partialYr} is a partial year` : ''}. Gallons per person per day uses NMED's population served.</p>`
      : `<p class="hint" style="margin:0">No metered pumping was found for this system's matched OSE records. ${sys._nOse < sys.wells.length ? 'Some sources have no OSE record matched yet; accepting the right record above adds its meter readings.' : ''}</p>`}
  </div>
  <div id="ws-print-foot">Printed ${new Date().toISOString().slice(0, 10)} from the NM Hydrograph Explorer, Water systems screen. Sources: NMED Drinking Water Bureau sources; NM Office of the State Engineer Waters-to-Wells records and NMWRRS meter reports; NM Unified Water Data API water levels; U.S. Drought Monitor (NDMC, USDA, NOAA). Triggers are screening values set for planning, not regulatory limits.</div>`;
  const ys = document.getElementById('ws-years'); ys.value = String(trig.years); ys.addEventListener('change', () => { wsSetTrig(sys.id, {years: +ys.value}); wsRenderLevels(); });
  const bf = document.getElementById('ws-bfrom'), bt = document.getElementById('ws-bto');
  const setBase = () => { const a = bf.value === '' ? null : +bf.value, b = bt.value === '' ? null : +bt.value; wsSetTrig(sys.id, {baseFrom: a, baseTo: b}); wsRenderLevels(); };
  bf.addEventListener('change', setBase); bt.addEventListener('change', setBase);
  document.getElementById('ws-droppump').addEventListener('change', e => { wsSetTrig(sys.id, {dropPumped: e.target.checked}); wsRenderLevels(); });
  document.getElementById('ws-ref-open').addEventListener('click', () => { if(WS.ref != null) openSingleWell(WS.ref); });
  document.getElementById('ws-lv-csv').addEventListener('click', wsLevelsCsv);
  document.getElementById('ws-print').addEventListener('click', wsPrint);
  document.getElementById('ws-to-map').addEventListener('click', () => wsToMap(sys));
  el.querySelectorAll('[data-ref]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); WS.ref = +b.dataset.ref; wsRenderDetail(); }));
  el.querySelectorAll('[data-cands]').forEach(b => b.addEventListener('click', () => { const k = wsSrcKey(sys, sys.wells[+b.dataset.cands]); open.has(k) ? open.delete(k) : open.add(k); wsRenderDetail(); }));
  el.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', () => { wsSetChoice(wsSrcKey(sys, sys.wells[+b.dataset.accept]), {pod: b.dataset.pod, at: todayStr}); wsRefresh(); toast('Accepted ' + b.dataset.pod + ' as this source\'s own well record'); }));
  el.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => { wsSetChoice(wsSrcKey(sys, sys.wells[+b.dataset.reject]), {pod: null, at: todayStr}); wsRefresh(); }));
  el.querySelectorAll('[data-undo]').forEach(b => b.addEventListener('click', () => { wsSetChoice(wsSrcKey(sys, sys.wells[+b.dataset.undo]), undefined); wsRefresh(); }));
  el.querySelectorAll('[data-intake]').forEach(inp => inp.addEventListener('change', () => { wsSetIntake(sys, sys.wells[+inp.dataset.intake], inp.value); wsRenderLevels(); }));
  wsRenderFocusMap(sys);
  wsRenderLevels();
  wsRenderPumping(sys);
}

// intake depth for the reference well when it is one of the system's own wells: the entered depth, else the top of the screen
function wsIntakeForRef(sys){
  const w = sys.wells.find(w => (w._own || []).includes(WS.ref)); if(!w) return null;
  const v = wsIntakeOf(sys, w); if(v != null) return {ft: v, from: 'pump intake (entered)', w};
  if(w._ose && w._ose.ptop) return {ft: w._ose.ptop, from: 'top of the screen (OSE ' + w._ose.pod + ')', w};
  return {ft: null, from: '', w};
}
function wsRenderLevels(){
  const sys = WS.byId.get(WS.sel); if(!sys) return;
  const trig = wsTrigOf(sys.id), empty = document.getElementById('ws-lv-empty'), cv = document.getElementById('ws-lv-canvas'), stEl = document.getElementById('wsy-status'), trEl = document.getElementById('wsy-trig');
  if(WS.pageChart){ WS.pageChart.destroy(); WS.pageChart = null; }
  const s = WS.ref;
  const series = s == null ? [] : wsMonthly(s, trig.dropPumped);
  const intake = s == null ? null : wsIntakeForRef(sys);
  const st = wsStatus(series, trig, intake && intake.ft);
  WS.status = st; WS.series = series;
  if(!series.length){
    empty.hidden = false; cv.style.display = 'none';
    empty.innerHTML = s == null ? `No water-level well within ${WS.f.radius} mi of this system has readings in the explorer. This is a monitoring gap: a candidate for a new telemetry unit.` : 'This well has no readings that pass the reading filter.';
    stEl.innerHTML = ''; trEl.innerHTML = ''; return;
  }
  empty.hidden = true; cv.style.display = '';
  const css = n => getComputedStyle(document.body).getPropertyValue(n).trim();
  const accent = css('--accent') || '#0f6e63', muted = css('--muted') || '#7d8873', ink = css('--ink-2') || '#485245';
  const t1 = series[series.length - 1].t, t0 = trig.years ? Math.max(series[0].t, t1 - trig.years) : series[0].t;
  const shown = series.filter(p => p.t >= t0 - 1e-9);
  // the normal range for each month of the period shown (from the baseline, excluding nothing: the band is the well's history)
  // the same baseline as the status (the latest reading left out); seasonal wells get a band that follows the year
  const band = [], BL = wsBaseline(series.slice(0, -1), trig.baseFrom, trig.baseTo), cache = new Map();
  const bandAt = m => { if(!cache.has(m)){ const v = BL.forMonth(m); cache.set(m, v.length >= WS_MIN_BASE ? {lo: wsPct(v, 1 - trig.pWatch / 100), w: wsPct(v, trig.pWatch / 100), x: wsPct(v, trig.pWarn / 100), mx: v[v.length - 1]} : null); } return cache.get(m); };
  if(BL.seasonal){
    for(let y = Math.floor(t0); y <= Math.floor(t1) + 1; y++) for(let m = 1; m <= 12; m++){
      const t = y + (m - 0.5) / 12; if(t < t0 - 0.5 / 12 || t > t1 + 0.5) continue;
      const b = bandAt(m); if(b) band.push({t, ...b});
    }
  } else { const b = bandAt(1); if(b) band.push({t: t0, ...b}, {t: t1 + 0.4, ...b}); }
  const ds = [];
  if(band.length){
    ds.push({label: BL.seasonal ? 'Normal range for the time of year' : 'Normal range (whole baseline)', data: band.map(b => ({x: b.t, y: b.lo})), borderWidth: 0, pointRadius: 0, fill: false, order: 9});
    ds.push({label: '_bandhi', data: band.map(b => ({x: b.t, y: b.w})), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: hexA(accent, .16), order: 9});
    ds.push({label: `Watch (deeper than the ${trig.pWatch}th percentile)`, data: band.map(b => ({x: b.t, y: b.w})), borderColor: '#c9a227', borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0, fill: false, order: 8});
    ds.push({label: `Warning (${trig.pWarn}th)`, data: band.map(b => ({x: b.t, y: b.x})), borderColor: css('--warn') || '#c1652f', borderWidth: 1.2, borderDash: [4, 3], pointRadius: 0, fill: false, order: 8});
    ds.push({label: 'Emergency (deeper than any baseline reading)', data: band.map(b => ({x: b.t, y: b.mx})), borderColor: '#7e2418', borderWidth: 1.2, borderDash: [2, 3], pointRadius: 0, fill: false, order: 8});
  }
  ds.push({label: 'Monthly depth to water', data: shown.map(p => ({x: p.t, y: p.v})), borderColor: hexA(ink, .55), borderWidth: 1, pointRadius: shown.length > 300 ? 0 : 2.5, pointBackgroundColor: accent, pointBorderColor: accent, spanGaps: false, tension: 0, order: 2,
    segment: {borderColor: c => (c.p1.parsed.x - c.p0.parsed.x) > 3 ? 'transparent' : undefined}});
  const lastP = series[series.length - 1];
  ds.push({label: 'Latest reading', data: [{x: lastP.t, y: lastP.v}], pointRadius: 6, pointStyle: 'rectRot', borderColor: wsCssColor(WS_LEVEL_COLOR[st.level] || WS_LEVEL_COLOR.none), backgroundColor: wsCssColor(WS_LEVEL_COLOR[st.level] || WS_LEVEL_COLOR.none), showLine: false, order: 1});
  const line = (label, y, color, dash) => ds.push({label, data: [{x: t0, y}, {x: t1 + 0.4, y}], borderColor: color, borderWidth: 1.6, borderDash: dash, pointRadius: 0, fill: false, order: 7});
  if(intake && intake.ft){
    line((intake.from.startsWith('pump') ? 'Pump intake' : 'Top of screen') + ' ' + wsFmt(intake.ft) + ' ft', intake.ft, '#20291f', []);
    line(`Warning: ${trig.ftWarn} ft of water above it`, intake.ft - trig.ftWarn, css('--warn') || '#c1652f', [6, 4]);
  }
  WS.pageChart = new Chart(cv.getContext('2d'), {type: 'line', data: {datasets: ds}, options: {
    responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
    plugins: {legend: {labels: {color: ink, usePointStyle: true, boxWidth: 10, filter: i => !i.text.startsWith('_')}},
      tooltip: {filter: i => !i.dataset.label.startsWith('_'), callbacks: {title: it => it.length ? decYearToLabel(it[0].parsed.x) : '', label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)} ft`}}},
    scales: {x: {type: 'linear', min: t0, max: t1 + 0.4, ticks: {color: muted, maxRotation: 0, autoSkipPadding: 14, callback: v => String(Math.floor(v))}, grid: {color: 'rgba(125,136,115,.2)'}},
      y: {reverse: true, ticks: {color: muted}, grid: {color: 'rgba(125,136,115,.2)'}, title: {display: true, text: 'Depth to water (ft below land surface)', color: muted}}}}});
  // status
  const S = SITES[s], lbl = {normal: 'Normal', watch: 'Watch', warning: 'Warning', emergency: 'Emergency', none: st.stale ? 'No current status' : 'No status'}[st.level];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], win = m => [mon[(m + 10) % 12], mon[m - 1], mon[m % 12]].join('–');
  const bYrs = (trig.baseFrom || trig.baseTo) ? `${trig.baseFrom || 'start'}–${trig.baseTo || 'end'}` : 'the whole record';
  let why = `<b>Latest reading:</b> ${escHtml(lastP.last)}, ${wsFmt(lastP.v, 1)} ft below land surface at ${escHtml(S[0])}${(WS.byId.get(WS.sel)._own || []).some(o => o.s === s) ? ' (the system\'s own well)' : ', ' + wsDist(wsRefList(sys).find(r => r.s === s).d) + ' from the system'}.`;
  if(st.rank != null) why += `<br><b>${st.seasonal ? 'Time of year' : 'History'}:</b> deeper than ${wsFmt(st.rank)}% of the ${st.nBase} ${st.seasonal ? win(lastP.m) + ' ' : ''}readings from ${bYrs}${st.seasonal ? '' : ' (too few readings for each time of year, so the whole record is the baseline)'}.`;
  else why += `<br>Fewer than ${WS_MIN_BASE} baseline readings, so no level trigger can be set yet.`;
  if(st.above != null) why += `<br><b>Water above the ${escHtml(intake.from)}:</b> ${wsFmt(st.above, 1)} ft (at ${wsFmt(st.intake)} ft).`;
  else if(intake && !intake.ft) why += `<br>Enter this well's pump intake depth in the table above to add the water-above-the-pump trigger.`;
  else if(!intake) why += `<br>This is a nearby well, not the system's own, so only its level against its own history is used.`;
  if(st.stale) why = `<b>No current status:</b> the latest reading is ${Math.floor(st.ageMonths / 12)} years old (it would have been <i>${escHtml(st.levelThen)}</i> then).<br>` + why;
  else if(st.ageMonths > 12) why += `<br><span class="ws-up">The latest reading is ${Math.floor(st.ageMonths / 12)} year${st.ageMonths >= 24 ? 's' : ''} old.</span>`;
  const tr = wsTrend(series, 10);
  if(tr) why += `<br><b>Trend:</b> ${tr.slope > 0 ? 'falling' : 'rising'} ${wsFmt(Math.abs(tr.slope), 2)} ft/yr (Theil-Sen, ${tr.from}–${tr.to}).`;
  stEl.innerHTML = `<div class="ws-status ${st.level}"><div class="lvl"><i style="background:${WS_LEVEL_COLOR[st.level] || WS_LEVEL_COLOR.none}"></i>${lbl}</div><div class="why">${why}</div></div>`;
  const dot = l => `<span class="ws-dot" style="background:${WS_LEVEL_COLOR[l]}"></span>`;
  trEl.innerHTML = `<table>
    <tr><td colspan="2" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Level against the well's history</td></tr>
    <tr><td>${dot('watch')}Watch</td><td>deeper than the <input type="number" data-t="pWatch" min="50" max="99" value="${trig.pWatch}">th percentile of the baseline</td></tr>
    <tr><td>${dot('warning')}Warning</td><td>deeper than the <input type="number" data-t="pWarn" min="50" max="99" value="${trig.pWarn}">th percentile</td></tr>
    <tr><td>${dot('emergency')}Emergency</td><td>deeper than any baseline reading</td></tr>
    <tr><td colspan="2" style="font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);padding-top:8px">Water above the pump (own well)</td></tr>
    <tr><td>${dot('watch')}Watch</td><td>less than <input type="number" data-t="ftWatch" min="0" value="${trig.ftWatch}"> ft</td></tr>
    <tr><td>${dot('warning')}Warning</td><td>less than <input type="number" data-t="ftWarn" min="0" value="${trig.ftWarn}"> ft</td></tr>
    <tr><td>${dot('emergency')}Emergency</td><td>less than <input type="number" data-t="ftEmerg" min="0" value="${trig.ftEmerg}"> ft</td></tr>
  </table><p class="hint">Starting values. Set them with the system's operator; they are kept in this browser for this system and printed with the summary.</p>`;
  trEl.querySelectorAll('input[data-t]').forEach(inp => inp.addEventListener('change', () => { const v = +inp.value; if(!isFinite(v)) return; wsSetTrig(sys.id, {[inp.dataset.t]: v}); wsRenderLevels(); }));
  // map: highlight the reference well
  if(WS.layers.ref){ WS.layers.ref.clearLayers(); if(S[2] != null) L.circleMarker([S[2], S[1]], {radius: 8, color: wsCssColor(WS_LEVEL_COLOR[st.level] || WS_LEVEL_COLOR.none), weight: 3, fill: false}).addTo(WS.layers.ref); }
}
function wsRenderPumping(sys){
  const cv = document.getElementById('ws-pump-canvas'); if(!cv) return;
  const yrs = [...sys._pumpYrs.keys()].sort((a, b) => a - b);
  const pods = sys.wells.map(w => w._ose).filter(o => o && o.pump);
  const pal = ['#0f6e63', '#2f7fc1', '#c1652f', '#6b4fa0', '#c9a227', '#1d8fb0', '#7e2418', '#485245'];
  const ds = pods.map((o, i) => { const m = new Map(o.pump); return {type: 'bar', label: o.pod, data: yrs.map(y => m.get(y) || 0), backgroundColor: pal[i % pal.length], stack: 'p', yAxisID: 'y', order: 2}; });
  if(sys.pop > 0) ds.push({type: 'line', label: 'Gallons per person per day', data: yrs.map(y => y === WS.partialYr ? null : sys._pumpYrs.get(y) * 325851 / 365 / sys.pop), borderColor: '#20291f', backgroundColor: '#20291f', pointRadius: 3, borderWidth: 1.5, yAxisID: 'g', order: 1, spanGaps: true});
  const css = n => getComputedStyle(document.body).getPropertyValue(n).trim(), muted = css('--muted') || '#7d8873', ink = css('--ink-2') || '#485245';
  WS.pumpChart = new Chart(cv.getContext('2d'), {data: {labels: yrs.map(y => y === WS.partialYr ? y + ' (partial)' : String(y)), datasets: ds}, options: {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {legend: {labels: {color: ink, boxWidth: 10}}, tooltip: {callbacks: {label: c => `${c.dataset.label}: ${c.parsed.y == null ? '–' : c.parsed.y.toFixed(c.dataset.yAxisID === 'g' ? 0 : 2)} ${c.dataset.yAxisID === 'g' ? 'gal/person/day' : 'AF'}`}}},
    scales: {x: {stacked: true, ticks: {color: muted}, grid: {display: false}}, y: {stacked: true, ticks: {color: muted}, title: {display: true, text: 'Acre-feet', color: muted}, grid: {color: 'rgba(125,136,115,.2)'}},
      g: {position: 'right', ticks: {color: muted}, title: {display: true, text: 'Gal/person/day', color: muted}, grid: {display: false}, beginAtZero: true}}}});
}
// the selected system on the map: service area, sources, the radius, its own and nearby water-level wells
function wsRenderFocusMap(sys){
  const g = WS.layers.focus; g.clearLayers();
  if(!WS.layers.ref) WS.layers.ref = L.layerGroup().addTo(WS.map);
  const pts = [];
  if(sys.area) sys.area.forEach(r => { L.polygon(r.map(p => [p[1], p[0]]), {color: '#0f6e63', weight: 1.5, fillOpacity: .06, interactive: false}).addTo(g); r.forEach(p => pts.push([p[1], p[0]])); });
  sys.wells.forEach(w => {
    L.circle([w.lat, w.lon], {radius: WS.f.radius * 1609.344, color: '#7d8873', weight: 1, dashArray: '4 4', fill: false, interactive: false}).addTo(g);
    const mk = L.marker([w.lat, w.lon], {icon: L.divIcon({className: '', html: `<div style="width:11px;height:11px;transform:rotate(45deg);background:#20291f;border:2px solid #fff;box-shadow:0 0 2px rgba(0,0,0,.5)"></div>`, iconSize: [11, 11], iconAnchor: [6, 6]})});
    mk.bindTooltip(`<b>${escHtml(w.name)}</b> (source)${w._ose ? '<br>OSE ' + escHtml(w._ose.pod) : ''}`); mk.addTo(g); pts.push([w.lat, w.lon]);
  });
  wsRefList(sys).forEach(r => {
    const S = SITES[r.s]; if(S[2] == null) return;
    const mk = L.circleMarker([S[2], S[1]], {radius: r.own ? 6 : 4.5, color: '#fff', weight: 1, fillColor: wsCssColor(r.own ? WS_MON_COLOR.own : WS_MON_COLOR.near), fillOpacity: .95});
    mk.bindTooltip(`${escHtml(S[0])} · ${escHtml(wsSrcName(r.s))}${S[7] ? '<br>last reading ' + S[7] : ''}`); mk.on('click', () => { WS.ref = r.s; wsRenderDetail(); }); mk.addTo(g);
    if(r.d < WS.f.radius * 1609.344 * 0.6 || r.own) pts.push([S[2], S[1]]);
  });
  try{ if(pts.length) WS.map.fitBounds(L.latLngBounds(pts).pad(0.15), {maxZoom: 14, animate: false}); }catch(e){}
}

function wsLevelsCsv(){
  const sys = WS.byId.get(WS.sel); if(!sys || WS.ref == null) return;
  const trig = wsTrigOf(sys.id), st = WS.status || {}, S = SITES[WS.ref];
  const rows = [['# system', sys.id, sys.name], ['# reference well', S[0], wsSrcName(WS.ref)], ['# status', st.level, 'latest', st.last ? st.last.last : '', st.last ? +st.last.v.toFixed(2) : ''],
    ['# triggers', `watch > p${trig.pWatch}`, `warning > p${trig.pWarn}`, 'emergency > deepest baseline reading', `water above pump: watch < ${trig.ftWatch} ft, warning < ${trig.ftWarn} ft, emergency < ${trig.ftEmerg} ft`],
    ['# baseline', trig.baseFrom || 'start', trig.baseTo || 'end', trig.dropPumped ? 'pumped readings left out' : 'all readings'],
    ['year', 'month', 'depth_to_water_ft_monthly_mean', 'readings', 'normal_low_ft', `p${trig.pWatch}_ft`, `p${trig.pWarn}_ft`, 'deepest_baseline_ft']];
  const cache = new Map(), BL = wsBaseline((WS.series || []).slice(0, -1), trig.baseFrom, trig.baseTo);
  rows.splice(rows.length - 1, 0, ['# normal range', BL.seasonal ? 'by time of year (3-month window)' : 'whole baseline (too few readings for each time of year)']);
  (WS.series || []).forEach(p => {
    let b = cache.get(p.m); if(!b){ const v = BL.forMonth(p.m); b = v.length >= WS_MIN_BASE ? [wsPct(v, 1 - trig.pWatch / 100), wsPct(v, trig.pWatch / 100), wsPct(v, trig.pWarn / 100), v[v.length - 1]] : ['', '', '', '']; cache.set(p.m, b); }
    rows.push([p.y, p.m, +p.v.toFixed(2), p.n, ...b.map(x => x === '' ? '' : +x.toFixed(2))]);
  });
  downloadCsv(`water_levels_${sys.id}_${String(S[0]).replace(/[^\w.-]+/g, '_')}.csv`, rows);
}
// printing: the page's own layout (css @media print), with the charts drawn at the width of a letter page
function wsBeforePrint(){
  if(hxScreen !== 'systems' || !WS || !WS.sel) return;
  document.body.classList.add('ws-print');
  try{ if(WS.pageChart) WS.pageChart.resize(700, 290); if(WS.pumpChart) WS.pumpChart.resize(700, 210); }catch(e){}
}
function wsAfterPrint(){
  if(!document.body.classList.contains('ws-print')) return;
  document.body.classList.remove('ws-print');
  requestAnimationFrame(() => { try{ WS.pageChart && WS.pageChart.resize(); WS.pumpChart && WS.pumpChart.resize(); }catch(e){} });
}
window.addEventListener('beforeprint', wsBeforePrint);
window.addEventListener('afterprint', wsAfterPrint);
function wsPrint(){ wsBeforePrint(); setTimeout(() => window.print(), 80); }
// the Map screen with this system as the area: its service area plus a circle of the chosen radius around each source
function wsToMap(sys){
  const R = WS.f.radius * 1609.344, polys = [];
  if(sys.area) sys.area.forEach(r => polys.push([r.map(p => [p[0], p[1]])]));
  sys.wells.forEach(w => { const ring = [], c = Math.cos(w.lat * Math.PI / 180);
    for(let i = 0; i <= 48; i++){ const a = i / 48 * 2 * Math.PI; ring.push([w.lon + R * Math.cos(a) / (111320 * c), w.lat + R * Math.sin(a) / 110570]); }
    polys.push([ring]); });
  setScreen('map');
  setAreaSelection({type: 'upload', polygons: polys, label: `Water system: ${sys.name} (service area and ${WS.f.radius} mi around its sources)`});
  // the map was hidden while this screen was open: size it, then zoom to the system (areaLayer is a plain layer group, so the
  // bounds come from the outline itself)
  const bb = L.latLngBounds(polys.flatMap(pg => pg[0].map(p => [p[1], p[0]])));
  requestAnimationFrame(() => { try{ map.invalidateSize(); map.fitBounds(bb, {padding: [40, 40]}); }catch(e){} });
}
