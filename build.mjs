// Builds index.html from source/: every line of source/page.html that reads  <!-- @include path -->  is replaced by that file
// (path is relative to source/).  node build.mjs            writes index.html next to this file
//                               node build.mjs --check    exits 1 if index.html is not what the sources build (use before committing)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url)), src = join(root, 'source');
const build = file => readFileSync(join(src, file), 'utf8').split('\n').map(line => {
  const m = line.match(/^\s*<!-- @include (\S+) -->\s*$/);
  return m ? build(m[1]) : line;
}).join('\n');
const html = build('page.html');
const out = join(root, 'index.html');
if(process.argv.includes('--check')){
  if(!existsSync(out) || readFileSync(out, 'utf8') !== html){ console.error('index.html is out of date: run  node build.mjs'); process.exit(1); }
  console.log('index.html matches the sources.');
} else { writeFileSync(out, html); console.log(`built index.html (${html.length.toLocaleString()} characters)`); }
