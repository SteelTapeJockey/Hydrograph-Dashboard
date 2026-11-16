#!/usr/bin/env python3
"""Builds context-data.bin: the context the app draws under a composite and uses in the area summary.

  1. U.S. Drought Monitor, weekly since 2000: share of the area in each category (D0-D4) for New Mexico, its 33 counties,
     85 HUC-8s and 572 HUC-10s. Taken from the Drought vs Groundwater dashboard's stored figures (site/assets/usdm-data.js
     and usdm-huc10.js); refresh those with that site's tools/refresh_usdm.py and refresh_usdm_huc10.py first.
  2. Metered groundwater pumping by OSE point of diversion and OSE accounting year, from the OSE meter harvest
     (OSE_Meter_Harvester/OSE_statewide: annual_diversion_by_pod.csv, pods.csv, anomalies.csv). Diversion meters only, as
     harvested. Screened: a POD-year is left out when it is negative, flagged by the harvest as a spike, rollover spike,
     implausible rate, negative year, negative correction or YTD mismatch, over 25,000 acre-feet, over 3 times the POD's
     permitted diversion (when one is given and the amount is over 50 acre-feet), over 3 times the POD's own median year and
     over 2,000 acre-feet, or over 10 times its median year and over 50 acre-feet. (Large municipal wells pump 5,000-10,000
     acre-feet a year, so there is no lower absolute cap.) Owner names are not carried over.
  3. Public water systems and their sources (NMED Drinking Water Bureau, via the NM small water systems tool's
     data/water-systems.js): name, county, population, size, type, primary source, and each source's location, depth,
     water type and NMED's recorded static water level with its date (one reading per source). Owner and operator details
     are not carried over.

Standard library only:
    python tools/build-context-data.py --harvest ../OSE_Meter_Harvester/OSE_statewide \
        --drought ../drought_vs_groundwater/site --systems ../nm-small-water-systems/data/water-systems.js
"""
import argparse, base64, collections, csv, gzip, json, math, os, re, statistics, sys

def utm_to_lonlat(e, n, zone=13):
    # NAD83 / GRS80, northern hemisphere
    a, f, k0 = 6378137.0, 1 / 298.257222101, 0.9996
    e2 = f * (2 - f); ep2 = e2 / (1 - e2)
    x = e - 500000.0; m = n / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu) \
        + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu)
    c1 = ep2 * math.cos(p1) ** 2; t1 = math.tan(p1) ** 2
    n1 = a / math.sqrt(1 - e2 * math.sin(p1) ** 2); r1 = a * (1 - e2) / (1 - e2 * math.sin(p1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = p1 - (n1 * math.tan(p1) / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
          + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / math.cos(p1)
    return math.degrees(lon) + (zone - 1) * 6 - 180 + 3, math.degrees(lat)

def unpack(path, name):
    t = open(path, encoding='utf-8').read()
    return json.loads(gzip.decompress(base64.b64decode(re.search(name + r'\s*=\s*"([^"]*)"', t).group(1))))

def drought(site):
    a = unpack(os.path.join(site, 'assets', 'usdm-data.js'), 'USDM_B64')
    b = unpack(os.path.join(site, 'assets', 'usdm-huc10.js'), 'USDM_H10_B64')
    if (a['first'], a['n']) != (b['first'], b['n']): sys.exit('Drought files cover different weeks; refresh both first.')
    c = dict(a['c']); c.update(b['c'])
    print(f"  drought: {a['first']} to {a['last']}, {a['n']} weeks, {len(c)} areas")
    return {'first': a['first'], 'last': a['last'], 'n': a['n'], 'share': a.get('share', {}), 'c': c}

FLAGS = {'SPIKE', 'ROLLOVER_SPIKE', 'IMPLAUSIBLE_RATE', 'NEG_YEAR', 'NEG_CORRECTION', 'NEG_OTHER', 'YTD_MISMATCH', 'YEAR_SPIKE'}
def pumping(h):
    pods = {r['pod_file']: r for r in csv.DictReader(open(os.path.join(h, 'pods.csv'), encoding='utf-8'))}
    flag = set()
    for r in csv.DictReader(open(os.path.join(h, 'anomalies.csv'), encoding='utf-8')):
        if r['type'] in FLAGS: flag.add((r['pod_file'], r['ose_year']))
    by = collections.defaultdict(list)
    for r in csv.DictReader(open(os.path.join(h, 'annual_diversion_by_pod.csv'), encoding='utf-8')):
        if r['diversion_af'] == '': continue
        by[r['pod_file']].append((int(r['year']), float(r['diversion_af']), r))
    uses, out, drop, kept, y0, y1 = [], [], collections.Counter(), 0, 9999, 0
    for pod, ys in sorted(by.items()):
        info = pods.get(pod) or ys[0][2]
        try: e, n = float(info['easting']), float(info['northing'])
        except (TypeError, ValueError): drop['no location'] += len(ys); continue
        lon, lat = utm_to_lonlat(e, n, int(float(info.get('utm_zone') or 13)))
        pos = [v for _, v, _ in ys if v > 0]; med = statistics.median(pos) if pos else 0
        try: td = float(info.get('total_div') or 0)
        except ValueError: td = 0
        good = {}
        for y, v, _ in ys:
            why = ('negative' if v < 0 else 'flagged by the harvest' if (pod, str(y)) in flag else 'over 25,000 AF' if v > 25000
                   else 'over 3x the permit' if td > 0 and v > 3 * td and v > 50
                   else 'over 3x its median and 2,000 AF' if med > 0 and v > 3 * med and v > 2000
                   else 'over 10x its median' if med > 0 and v > 10 * med and v > 50 else None)
            if why: drop[why] += 1; continue
            if y < 1975: drop['before 1975'] += 1; continue
            good[y] = round(v, 1); kept += 1
        if not good: continue
        u = (info.get('use_') or ys[0][2].get('use_') or '').strip() or '?'
        if u not in uses: uses.append(u)
        a0, a1 = min(good), max(good); y0, y1 = min(y0, a0), max(y1, a1)
        dep = info.get('depth_well'); dep = round(float(dep)) if dep not in (None, '') else None
        out.append([round(lon, 5), round(lat, 5), uses.index(u), dep, a0, [good.get(y) for y in range(a0, a1 + 1)]])
    print(f'  pumping: {len(out)} metered PODs, {kept} POD-years kept, {sum(drop.values())} left out {dict(drop)}')
    return {'cols': ['lon', 'lat', 'use', 'depth_ft', 'first_year', 'af_by_year'], 'uses': uses, 'first': y0, 'last': y1,
            'left_out': dict(drop), 'pods': out}

def systems(path):
    t = open(path, encoding='utf-8').read()
    j = json.loads(re.search(r'\["systems"\]\s*=\s*(\{.*\})\s*;?\s*$', t, re.S).group(1))
    out = []
    for s in j['systems']:
        src = [[w.get('lat'), w.get('lon'), w.get('depth'), w.get('water'), w.get('type'), w.get('swl'), w.get('swl_date'), w.get('name')]
               for w in s.get('wells') or [] if w.get('lat') is not None]
        out.append([s.get('id'), s.get('name'), s.get('county'), s.get('pop'), s.get('size'), s.get('type'), s.get('prim'), src])
    print(f"  public water systems: {len(out)} systems, {sum(len(s[7]) for s in out)} sources, {sum(1 for s in out for w in s[7] if w[5] is not None)} with a static water level (NMED, built {j.get('gen')})")
    return {'cols': ['id', 'name', 'county', 'pop', 'size', 'type', 'primary_source', 'sources[lat,lon,depth_ft,water,type,static_level_ft,static_level_date,source_name]'], 'gen': j.get('gen'), 'systems': out}

def main():
    p = argparse.ArgumentParser(); p.add_argument('--harvest', required=True); p.add_argument('--drought', required=True)
    p.add_argument('--systems', required=True); p.add_argument('--out', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'context-data.bin'))
    a = p.parse_args(); print('Building context data…')
    data = {'usdm': drought(a.drought), 'pump': pumping(a.harvest), 'pws': systems(a.systems)}
    raw = json.dumps(data, separators=(',', ':')).encode()
    open(a.out, 'wb').write(gzip.compress(raw, 9, mtime=0))
    print(f'Wrote {a.out}: {os.path.getsize(a.out) / 1e6:.1f} MB')

if __name__ == '__main__':
    main()
