// Builds dist/win-bot.html: the whole app in one file (scripts, styles and
// icons inlined), for hosts where uploading a single file is easiest.
// Usage: node tools/build-single.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ORDER = ['bytes', 'b58', 'ed25519', 'pda', 'tx', 'keys', 'pump', 'rpc', 'feeds', 'strategy', 'analyst', 'wallets', 'trader', 'store', 'bot', 'ui', 'main'];

function bundle() {
  const parts = [];
  for (const name of ORDER) {
    let src = fs.readFileSync(path.join(ROOT, 'js', name + '.js'), 'utf8');
    const imports = [];
    src = src.replace(/^import\s+([\s\S]+?)\s+from\s+'\.\/(\w+)\.js';\s*$/gm, (_, what, mod) => {
      if (!ORDER.includes(mod)) throw new Error('unknown module ' + mod);
      what = what.trim();
      if (what.startsWith('* as ')) imports.push(`const ${what.slice(5).trim()} = __m_${mod};`);
      else if (what.startsWith('{')) imports.push(`const ${what.replace(/\s+as\s+/g, ': ')} = __m_${mod};`);
      else throw new Error('unsupported import in ' + name + ': ' + what);
      return '';
    });
    if (/^\s*import\s/m.test(src)) throw new Error('leftover import in ' + name);
    const names = [];
    src = src.replace(/^export\s+(async\s+function|function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, id) => { names.push(id); return `${kind} ${id}`; });
    if (/^export\s/m.test(src)) throw new Error('unsupported export in ' + name);
    parts.push(`const __m_${name} = (() => {\n'use strict';\n${imports.join('\n')}\n${src}\nreturn { ${names.join(', ')} };\n})();`);
  }
  return parts.join('\n');
}

const dataUri = (file) => 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, file)).toString('base64');
const js = bundle().replace(/<\/script/gi, '<\\/script');
let css = fs.readFileSync(path.join(ROOT, 'css/app.css'), 'utf8').replace('url("../icons/icon-192.png")', `url("${dataUri('icons/icon-192.png')}")`);
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hash = crypto.createHash('sha256').update('\n' + js + '\n').digest('base64');
html = html
  .replace(/<link rel="manifest"[^>]*>\n?\s*/, '')
  .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" type="image/png" href="${dataUri('icons/icon-192.png')}">`)
  .replace(/<link rel="apple-touch-icon"[^>]*>/, `<link rel="apple-touch-icon" href="${dataUri('icons/apple-touch-icon.png')}">`)
  .replace(/<link rel="stylesheet" href="css\/app.css">/, () => `<style>\n${css}\n</style>`)
  .replace(/<script type="module" src="js\/main.js"><\/script>/, () => `<script>\n${js}\n</script>`)
  .replace("script-src 'self'", `script-src 'sha256-${hash}'`);
if (!html.includes(`'sha256-${hash}'`) || html.includes('src="js/main.js"')) throw new Error('build failed');
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/win-bot.html'), html);
console.log('dist/win-bot.html', (html.length / 1024).toFixed(0) + ' KB');
