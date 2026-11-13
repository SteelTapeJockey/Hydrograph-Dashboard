"""Build water-systems.js: small community water systems, their wells, and each well's own OSE record and metered pumping.

usage:  python tools/build-water-systems.py [--harvest ../OSE_Meter_Harvester/OSE_statewide] [--out water-systems.js] [--max-pop 3300]

Reads (live, all public):
  NMED Drinking Water Bureau sources        community systems and their wells / springs (location, depth, static level)
  OSE Waters-to-Wells well PODs (W2W)       well records near each source: owner, use, depth, screens, PLSS-located flag
  OSE New Mexico Public Water Systems       service-area outlines (by PWS ID)
  NMBGMR Collaborative Water Level Network  OSE well ID of each network well (links an OSE record to a water-level well by ID)
Reads (from the meter harvester, run on your own computer because OSE blocks cloud servers):
  annual_diversion_by_pod.csv               metered pumping per POD per OSE accounting year (diversion meters only)
  perforations.csv                          screen intervals per POD (fills W2W gaps)

How a source is matched to its own OSE well record (see MATCH_M, CONFIRM_M, the depth test):
  1. an OSE record within MATCH_M (5 m): the same well by location
  2. else an OSE record within CONFIRM_M (250 m) whose owner names the system AND whose well depth agrees with NMED's
     (within 5 ft or 5 %): the same well, with the two agencies' coordinates apart (many OSE records are located by PLSS section)
  3. anything else nearby is listed as an unconfirmed candidate; the page lets you accept or reject it
Tested on all small community systems: pairs within 5 m agree on owner and depth 48 % of the time and on neither only 6 %;
past 25 m distance alone mostly finds other wells; owner and depth both agreeing by chance happens for 1 % of pairs 250-500 m apart.
"""
import argparse, csv, datetime, json, math, os, re, sys, time, urllib.parse, urllib.request

MATCH_M = 5          # distance alone
CONFIRM_M = 250      # with owner name and well depth both agreeing
CAND_M = 250         # unconfirmed candidates listed up to this distance
CAND_N = 5
NMED = 'https://mercator.env.nm.gov/server/rest/services/dwb/drinking_water_sources/FeatureServer'
W2W = 'https://gis.ose.nm.gov/server_s/rest/services/PODS/W2W_Well_PODs/MapServer/0/query'
OSE_PWS = 'https://services2.arcgis.com/qXZbWTdPDbTjl7Dy/arcgis/rest/services/New_Mexico_Public_Water_Systems/FeatureServer/0/query'
CWLN = 'https://maps.nmt.edu/server/rest/services/Water/Water_Resources/MapServer/13/query'
MDW_RE = re.compile(r'\b(MDWCA|MDWA|MDWUA|MDWC|MDW|MUTUAL|WUA|DWCA|MDWSA|MDWCSWA)\b|MUTUAL DOMESTIC', re.I)
STOP = set('MDWCA MUTUAL DOMESTIC WATER CONSUMERS CONSUMER ASSOCIATION ASSN AND SEWAGE WORKS MDWA MDWUA INC THE MDWC WUA DWCA SYSTEM SYSTEMS '
           'COMMUNITY COMPANY UTILITY UTILITIES CORP CITY TOWN VILLAGE COUNTY ESTATES PARK SUBDIVISION SERVICE SERVICES ASSOC CORPORATION '
           'DISTRICT ACRES HOMEOWNERS USERS COOP COOPERATIVE AUTHORITY REGIONAL NEW MEXICO SANITATION'.split())


def get_json(url, params=None, data=None, tries=4):
    for t in range(tries):
        try:
            if data is not None:
                req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), method='POST')
            else:
                req = urllib.request.Request(url + ('?' + urllib.parse.urlencode(params) if params else ''))
            with urllib.request.urlopen(req, timeout=180) as r:
                j = json.load(r)
            if isinstance(j, dict) and j.get('error'):
                raise RuntimeError(j['error'])
            return j
        except Exception as e:
            if t == tries - 1:
                raise
            print('  retry', url.split('/')[2], e, file=sys.stderr); time.sleep(3 * (t + 1))


def query_all(url, where, fields, geom=False, out_sr=4326, page=1000):
    out, off = [], 0
    while True:
        j = get_json(url, {'where': where, 'outFields': fields, 'returnGeometry': 'true' if geom else 'false', 'outSR': out_sr,
                           'resultOffset': off, 'resultRecordCount': page, 'orderByFields': 'OBJECTID', 'f': 'json'})
        fs = j.get('features', []); out += fs
        if not fs or (not j.get('exceededTransferLimit') and len(fs) < page):
            return out
        off += len(fs)


def metres(lat1, lon1, lat2, lon2):
    c = math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon2 - lon1) * 111320 * c, (lat2 - lat1) * 110570)


def tokens(s, stop=STOP):
    return {t for t in re.findall(r'[A-Z]+', str(s or '').upper()) if t not in stop and len(t) > 3}


def num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def depth_agrees(a, b):
    return a is not None and b is not None and a > 0 and b > 0 and abs(a - b) <= max(5.0, 0.05 * a)


def simplify(pts, tol):
    """Douglas-Peucker on one ring of [lon, lat]."""
    if len(pts) < 4:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True; stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop(); (x1, y1), (x2, y2) = pts[a], pts[b]; dmax, imax = 0, None
        for i in range(a + 1, b):
            x0, y0 = pts[i]; dx, dy = x2 - x1, y2 - y1
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / (math.hypot(dx, dy) or 1e-12)
            if d > dmax: dmax, imax = d, i
        if imax is not None and dmax > tol:
            keep[imax] = True; stack += [(a, imax), (imax, b)]
    return [p for p, k in zip(pts, keep) if k]


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument('--harvest', default=os.path.join(here, '..', '..', 'OSE_Meter_Harvester', 'OSE_statewide'))
    ap.add_argument('--out', default=os.path.join(here, '..', 'water-systems.js'))
    ap.add_argument('--max-pop', type=int, default=3300)
    a = ap.parse_args()

    print('NMED community water system sources…')
    # layers: 1 active groundwater sources, 0 active surface-water sources (inactive sources, layer 2, are left out)
    feats = []
    for lyr in (1, 0):
        try:
            feats += [dict(f['attributes'], _layer=lyr) for f in query_all(f'{NMED}/{lyr}/query', "D_PWS_FED_TYPE_CD='C'", '*')]
        except Exception as e:
            print('  layer', lyr, 'failed:', e, file=sys.stderr)
    feats = [f for f in feats if (f.get('D_POPULATION_COUNT') or 0) <= a.max_pop and f.get('LAT') and f.get('LON')]
    systems = {}
    for f in feats:
        sid = f['NUMBER0']
        s = systems.setdefault(sid, {'id': sid, 'name': (f.get('SYSTEM_NAME') or '').strip(), 'county': (f.get('D_PRIN_CNTY_SVD_NM') or '').title(),
                                     'city': (f.get('D_PRIN_CITY_SVD_NM') or '').title(), 'pop': int(f.get('D_POPULATION_COUNT') or 0),
                                     'store_gal': num(f.get('D_TTL_STOR_CAP_MSR')), 'prim': f.get('D_FED_PRIM_SRC_CD') or '',
                                     'office': (f.get('OFFICE') or '').title(), 'wells': []})
        s['wells'].append({'name': (f.get('FACILITY_NAME') or '').strip(), 'fid': f.get('ST_ASGN_IDENT_CD') or '', 'type': f.get('FACILITY_TYPE') or '',
                           'water': f.get('WATER_TYPE_CODE') or '', 'avail': f.get('AVAILABILITY_CODE') or '',
                           'lat': round(f['LAT'], 6), 'lon': round(f['LON'], 6), 'depth': num(f.get('DEPTH_OF_WELL')),
                           'swl': num(f.get('STATIC_WATER_LEVEL')), 'swl_date': datetime.datetime.fromtimestamp(f["DATA_COLLECTION_DT"] / 1000, datetime.timezone.utc).date().isoformat() if f.get('DATA_COLLECTION_DT') else ''})
    for s in systems.values():
        s['mdw'] = bool(MDW_RE.search(s['name']))
        s['size'] = 'very small' if s['pop'] <= 500 else 'small'
    print(f'  {len(systems)} systems ({sum(s["mdw"] for s in systems.values())} mutual domestic), {sum(len(s["wells"]) for s in systems.values())} sources')

    # ---- OSE W2W well PODs within CAND_M of every source
    print('OSE W2W well records near each source…')
    allw = [(s, w) for s in systems.values() for w in s['wells']]
    pods = {}
    for i in range(0, len(allw), 50):
        batch = allw[i:i + 50]
        body = {'geometry': json.dumps({'points': [[w['lon'], w['lat']] for _, w in batch], 'spatialReference': {'wkid': 4326}}),
                'geometryType': 'esriGeometryMultipoint', 'inSR': 4326, 'distance': CAND_M, 'units': 'esriSRUnit_Meter',
                'spatialRel': 'esriSpatialRelIntersects', 'outFields': 'POD,Use,WellDepth_ft,PERF_Top_fbgs,PERF_Bot_fbgs,PERF,DTW_Initial_ft,SWL,FinishYear,PODStatus,Metered,PLSS_Located,Owners,Total_POD_Div_AFY,EstimatedYield_GPM,Scanned_WellLog_Link',
                'returnGeometry': 'true', 'outSR': 4326, 'orderByFields': 'OBJECTID', 'f': 'json'}
        off = 0
        while True:
            body['resultOffset'] = off; j = get_json(W2W, data=body); fs = j.get('features', [])
            for f in fs:
                at, g = f['attributes'], f.get('geometry') or {}
                if at.get('POD') and g.get('x') is not None:
                    pods[at['POD']] = dict(at, lon=g['x'], lat=g['y'])
            if not j.get('exceededTransferLimit') or not fs: break
            off += len(fs)
        print(f'  {min(i + 50, len(allw))}/{len(allw)} sources, {len(pods)} records', end='\r')
    print()

    # ---- harvester: pumping and screens
    pump, perf = {}, {}
    fa = os.path.join(a.harvest, 'annual_diversion_by_pod.csv')
    if os.path.exists(fa):
        with open(fa, newline='', encoding='utf-8') as fh:
            for r in csv.DictReader(fh):
                if r['pod_file'] in pods:
                    v = num(r['diversion_af'])
                    if v is not None and r['year']: pump.setdefault(r['pod_file'], {})[int(float(r['year']))] = round(v, 3)
    else:
        print('  no harvest found at', fa, '(pumping left out)', file=sys.stderr)
    fp = os.path.join(a.harvest, 'perforations.csv')
    if os.path.exists(fp):
        with open(fp, newline='', encoding='utf-8') as fh:
            for r in csv.DictReader(fh):
                if r['pod_file'] in pods and num(r['top_ft']) is not None:
                    perf.setdefault(r['pod_file'], []).append([num(r['top_ft']), num(r['bottom_ft'])])
    harvest_through = max((y for d in pump.values() for y in d), default=None)

    # ---- NMBGMR network wells by OSE well ID
    cw = {}
    try:
        for f in query_all(CWLN, '1=1', 'PointID,OSEWellID'):
            k = str(f['attributes'].get('OSEWellID') or '').strip().upper()
            if k and k not in ('X', 'NONE', 'NA'): cw.setdefault(k, []).append(f['attributes']['PointID'])
    except Exception as e:
        print('  NMBGMR network failed:', e, file=sys.stderr)

    def pod_out(p, d, how):
        pid = p['POD']; sc = perf.get(pid)
        top = num(p.get('PERF_Top_fbgs')); bot = num(p.get('PERF_Bot_fbgs'))
        if sc:
            sc = sorted(sc); top = top if top else sc[0][0]; bot = bot if bot else max(x[1] or 0 for x in sc) or None
        o = {'pod': pid, 'm': round(d, 1), 'how': how, 'use': p.get('Use') or '', 'owner': (p.get('Owners') or '').strip(),
             'depth': num(p.get('WellDepth_ft')), 'ptop': top if top and top > 0 else None, 'pbot': bot if bot and bot > 0 else None,
             'dtw0': num(p.get('DTW_Initial_ft')), 'swl': num(p.get('SWL')), 'year': p.get('FinishYear'), 'status': p.get('PODStatus') or '',
             'plss': p.get('PLSS_Located') == 1, 'metered': p.get('Metered') == 1, 'yield_gpm': num(p.get('EstimatedYield_GPM')),
             'log': p.get('Scanned_WellLog_Link') or ''}
        if sc: o['screens'] = sc
        if pid in pump: o['pump'] = sorted(pump[pid].items())
        if pid.upper() in cw: o['nmbgmr'] = cw[pid.upper()]
        return {k: v for k, v in o.items() if v not in (None, '', [], False) or k in ('m', 'how')}

    # ---- match
    plist = list(pods.values()); n_match = {'5 m': 0, 'owner and depth': 0}
    for s in systems.values():
        toks = tokens(s['name'])
        used = set()
        for w in s['wells']:
            near = sorted(((metres(w['lat'], w['lon'], p['lat'], p['lon']), p) for p in plist
                           if abs(p['lat'] - w['lat']) < 0.003 and abs(p['lon'] - w['lon']) < 0.004), key=lambda t: t[0])
            near = [(d, p) for d, p in near if d <= CAND_M]
            best, how = None, None
            close = [(d, p) for d, p in near if d <= MATCH_M]
            if close:   # several records at one spot (replacement wells): the one whose depth agrees, else the nearest
                agree = [(d, p) for d, p in close if depth_agrees(w['depth'], num(p.get('WellDepth_ft')))]
                best, how = (agree or close)[0], '5 m'
            else:
                ok = [(d, p) for d, p in near if d <= CONFIRM_M and toks & tokens(p.get('Owners'), set())
                      and depth_agrees(w['depth'], num(p.get('WellDepth_ft'))) and p['POD'] not in used]
                if ok: best, how = ok[0], 'owner and depth'
            if best:
                w['ose'] = pod_out(best[1], best[0], how); used.add(best[1]['POD']); n_match[how] += 1
            cands = []
            for d, p in near:
                if best and p['POD'] == best[1]['POD']: continue
                c = pod_out(p, d, 'candidate')
                c['owner_match'] = bool(toks & tokens(p.get('Owners'), set()))
                c['depth_match'] = depth_agrees(w['depth'], num(p.get('WellDepth_ft')))
                cands.append(c)
            # most plausible first: owner and depth, then either, then distance
            cands.sort(key=lambda c: (-(c['owner_match'] + c['depth_match']), c['m']))
            if cands: w['cand'] = cands[:CAND_N]

    # ---- service areas
    print('OSE service-area outlines…')
    try:
        for f in query_all(OSE_PWS, '1=1', 'Water_System_ID,PublicSystemName,Sys_Type,Polygon_Basis', geom=True, page=200):
            sid = (f['attributes'].get('Water_System_ID') or '').strip()
            if sid in systems and f.get('geometry'):
                rings = [simplify([[round(x, 5), round(y, 5)] for x, y in r], 0.00015) for r in f['geometry']['rings']]
                systems[sid]['area'] = [r for r in rings if len(r) >= 4]
                systems[sid]['area_basis'] = f['attributes'].get('Polygon_Basis') or ''
    except Exception as e:
        print('  service areas failed:', e, file=sys.stderr)

    out = {'gen': datetime.date.today().isoformat(), 'harvest_through': harvest_through,
           'rules': {'match_m': MATCH_M, 'confirm_m': CONFIRM_M, 'cand_m': CAND_M, 'depth': 'within 5 ft or 5 %', 'max_pop': a.max_pop},
           'systems': sorted(systems.values(), key=lambda s: s['name'])}
    js = json.dumps(out, separators=(',', ':'), ensure_ascii=False)
    with open(a.out, 'w', encoding='utf-8') as fh:
        fh.write('/* generated by tools/build-water-systems.py - do not edit */\nwindow.HX_WATER_SYSTEMS = ' + js + ';\n')
    nw = sum(len(s['wells']) for s in systems.values())
    print(f'wrote {a.out}: {len(systems)} systems, {nw} sources; matched {n_match["5 m"]} within {MATCH_M} m and {n_match["owner and depth"]} by owner and depth; '
          f'{sum(1 for s in systems.values() for w in s["wells"] if w.get("ose", {}).get("pump"))} with metered pumping; {len(js) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
