// npm test: online server suites (real server core on an in-memory store), real-browser online + local runs, logic suites (jsdom), theme contrast audit, then the real-browser layout regression suites.
import { spawn } from 'child_process'; import path from 'path'; import { fileURLToPath } from 'url';
import { serve } from './layout/serve.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..');
const { srv, base } = await serve(root);
const runs = [['node', ['../tools/sync-edge-shared.mjs', '--check']], ['node', ['online/rooms.mjs']], ['node', ['online/game.mjs']], ['node', ['online/security.mjs']], ['node', ['online/network.mjs']], ['node', ['online/endgame.mjs']], ['node', ['online/abandon.mjs']], ['node', ['online/pause-undo.mjs']], ['node', ['online/parity.mjs']], ['node', ['online/tahkim-reason.mjs']], ['node', ['online/tahkim-discussion.mjs']], ['node', ['online/tahkim-rules.mjs']], ['node', ['online/draft.mjs']], ['node', ['online/explain.mjs']], ['node', ['online/first-draw.mjs']], ['node', ['online/env-build.mjs']], ['node', ['online/hardening.mjs']],
  ['python3', ['e2e/local.py']], ['python3', ['e2e/run.py']],   // real browsers: local play unchanged; two players through the real server core (python3 + playwright + Chromium)
  ['python3', ['contrast.py']], ['node', ['logic/engine.mjs']], ['node', ['logic/endgame.mjs']], ['node', ['logic/startup.mjs']], ['node', ['logic/names.mjs']],
  ['node', ['layout/history-toggle.mjs']], ['node', ['layout/history-toggle-extra.mjs', 'a']], ['node', ['layout/history-toggle-extra.mjs', 'b']], ['node', ['layout/log-icon.mjs']], ['node', ['layout/floating.mjs']], ['python3', ['layout/float_modules.py']], ['node', ['layout/layering.mjs']], ['node', ['layout/fluid.mjs']], ['node', ['layout/tools.mjs']], ['node', ['layout/collapse.mjs']], ['node', ['layout/feel.mjs']],
  ['node', ['pwa/static.mjs']], ['node', ['pwa/e2e.mjs']]];   // PWA suites start their own servers; e2e needs playwright-core + Chromium (CHROME_PATH)
// Optional filter: `node run-all.mjs "extra.mjs b"` runs only the suites whose command line contains that text.
const only = process.argv[2];
let bad = 0;
for (const [cmd, args] of runs.filter(([c, a]) => !only || `${c} ${a.join(' ')}`.includes(only))) {
  console.log(`\n=== ${cmd} ${args.join(' ')}`);
  // async spawn on purpose: spawnSync would block this process's event loop, and with it the static server the browser needs
  const code = await new Promise(res => spawn(cmd, args, { cwd: here, stdio: 'inherit', env: { ...process.env, BASE: base } }).on('close', res)); if (code) bad++;
}
srv.close(); console.log(bad ? `\n${bad} suite(s) FAILED` : '\nALL SUITES PASSED'); process.exit(bad ? 1 : 0);
