// Vercel build step: copies ONLY the files a browser needs into dist/, so the repository's other folders (supabase/ sources and migrations, tests/, docs/, tools/)
// are never served from the public site. Run after write-env.mjs and stamp-sw.mjs (the copies must carry the generated env.js and the stamped sw.js).
//   node tools/build-dist.mjs            -> dist/
// The list is explicit on purpose: a new top-level file or folder is not published until it is added here.
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const root = process.env.EAS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, process.env.EAS_DIST || 'dist');
const PUBLIC = ['index.html', 'manifest.webmanifest', 'sw.js', 'pwa-check.html', 'css', 'js', 'assets'];
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
let files = 0;
const copy = (rel) => {
  const from = path.join(root, rel), to = path.join(out, rel), st = fs.statSync(from);
  if (st.isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(from)) copy(path.join(rel, f)); }
  else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); files++; }
};
for (const p of PUBLIC) { if (!fs.existsSync(path.join(root, p))) { console.error(`build-dist: missing ${p}`); process.exit(1); } copy(p); }
console.log(`dist/ ready: ${files} files (${PUBLIC.join(', ')})`);
