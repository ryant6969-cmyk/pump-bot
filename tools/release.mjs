// Stamps a release version on every file the app loads, so phones always
// fetch one fresh, matching set of files (never a mix of old and new).
// Usage: node tools/release.mjs 2.2.1
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || '')) { console.error('usage: node tools/release.mjs X.Y.Z'); process.exit(1); }
const edit = (file, fn) => { const p = path.join(ROOT, file); const before = fs.readFileSync(p, 'utf8'); const after = fn(before); if (after !== before) fs.writeFileSync(p, after); };
for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js'))) {
  edit('js/' + f, (s) => s.replace(/from '\.\/(\w+)\.js(?:\?v=[^']*)?';/g, `from './$1.js?v=${v}';`));
}
edit('js/main.js', (s) => s.replace(/const VERSION = '[^']*';/, `const VERSION = '${v}';`));
edit('index.html', (s) => s
  .replace(/href="css\/app\.css(?:\?v=[^"]*)?"/, `href="css/app.css?v=${v}"`)
  .replace(/src="js\/boot\.js(?:\?v=[^"]*)?"/, `src="js/boot.js?v=${v}"`)
  .replace(/src="js\/main\.js(?:\?v=[^"]*)?"/, `src="js/main.js?v=${v}"`));
fs.writeFileSync(path.join(ROOT, 'version.json'), JSON.stringify({ version: v }) + '\n');
console.log('stamped', v);
