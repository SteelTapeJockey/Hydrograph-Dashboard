// Builds readings-snapshot.bin: opens the app in headless Chrome with no saved copy and no snapshot (so it downloads every
// reading from the API itself), then writes the app's own packed store.   node tools/build-snapshot.mjs SITE_DIR OUT_FILE
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [siteDir = '.', outFile = 'readings-snapshot.bin'] = process.argv.slice(2);
const types = {'.html':'text/html','.js':'text/javascript','.json':'application/json','.csv':'text/csv','.bin':'application/octet-stream'};
const server = createServer(async (req, res) => {
  try{ const p = decodeURIComponent(req.url.split('?')[0]); const b = await readFile(join(siteDir, p === '/' ? 'index.html' : p));
    res.writeHead(200, {'content-type': types[extname(p)] || 'application/octet-stream'}); res.end(b); }
  catch(e){ res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const proxy = process.env.HTTPS_PROXY ? {server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost'} : undefined;
const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, proxy, args: ['--no-sandbox']});
const page = await (await browser.newContext()).newPage();
page.on('pageerror', e => console.error('page error:', e.message));
await page.goto(`http://127.0.0.1:${port}/index.html?nosnapshot`);
await page.waitForFunction(() => getComputedStyle(document.getElementById('boot')).display === 'none', null, {timeout: 25 * 60e3});
const info = await page.evaluate(() => ({boot: window.__hx.boot, n: window.__hx.rawN}));
if(info.boot.mode !== 'full' || info.n < 500000) throw new Error('unexpected load: ' + JSON.stringify(info));
const b64 = await page.evaluate(async () => { const u = window.__hx.exportSnapshot(); let s = ''; for(let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); });
const buf = Buffer.from(b64, 'base64'); await writeFile(outFile, buf);
console.log(JSON.stringify({readings: info.n, maxDate: info.boot.maxDate, bytes: buf.length}));
await browser.close(); server.close();
