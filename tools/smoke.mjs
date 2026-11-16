// End-to-end smoke test: starts the production server, runs demo mode with N characters in a headless
// Chromium, exercises commands / Super Chat / events / disconnect simulation, and checks for errors and
// leaked GPU resources.  usage: node tools/smoke.mjs [count=50] [seconds=60]
// NOTE: headless Chromium renders with SwiftShader (CPU). Its FPS says nothing about your GPU; use the
// in-app benchmark on the target PC for real numbers.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
const { chromium } = createRequire(import.meta.url)('playwright');
const count = Number(process.argv[2] ?? 50), seconds = Number(process.argv[3] ?? 60);
const PORT = 3217;
const srv = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT), DB_FILE: 'data/smoke.sqlite', YOUTUBE_API_KEY: '', ADMIN_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
srv.stdout.on('data', (d) => (serverOut += d)); srv.stderr.on('data', (d) => (serverOut += d));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.error('SMOKE FAIL:', m); console.error(serverOut.slice(-2000)); srv.kill(); process.exit(1); };
for (let i = 0; i < 60 && !serverOut.includes('Admin panel'); i++) await wait(250);
if (!serverOut.includes('Admin panel')) fail('server did not start');
const admin = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=admin`);
const logs = [];
admin.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'log' && m.item.level === 'error') logs.push(m.item); });
await new Promise((r) => admin.on('open', r));
const A = (m) => admin.send(JSON.stringify(m));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/live?quality=low&fixedres`);
await page.waitForFunction(() => document.title.startsWith('ready'), null, { timeout: 180000 });
A({ t: 'settings', patch: { maxCharacters: Math.max(count, 10) } });
A({ t: 'demo', cmd: 'start', count });
const sample = () => page.evaluate(() => { const c = window.__club; return { n: c.crowd.count, geo: c.engine.renderer.info.memory.geometries, tex: c.engine.renderer.info.memory.textures, fps: c.engine.stats.fps, states: [...c.crowd.dancers.values()].reduce((a, d) => (a[d.state] = (a[d.state] ?? 0) + 1, a), {}) }; });
const t0 = Date.now();
let k = 0;
while (Date.now() - t0 < seconds * 1000) {
  await wait(5000);
  k++;
  if (k % 2 === 0) A({ t: 'demo', cmd: 'superchat', tier: 1 + (k % 7) });
  if (k === 3) A({ t: 'event', id: 'retro' });
  if (k === 4) A({ t: 'demo', cmd: 'disconnectTest' });
  if (k === 5) A({ t: 'test', what: 'fireworks' });
  if (k === 6) A({ t: 'settings', patch: { quality: 'medium' } });
  if (k === 7) A({ t: 'eventVote' });
  console.log(`t=${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(await sample()));
}
const before = await sample();
// churn: everyone leaves, a new crowd joins and leaves again -> GPU resources must return to the empty baseline
const drain = async () => { A({ t: 'demo', cmd: 'stop' }); for (let i = 0; i < 24; i++) { await wait(5000); if ((await sample()).n === 0) break; } await wait(3000); return sample(); };
const empty = await drain();
A({ t: 'demo', cmd: 'start', count });
await wait(40000);
const after = await sample();
const empty2 = await drain();
// third cycle: detailed characters are pooled (bounded), so resources must stop growing
A({ t: 'demo', cmd: 'start', count });
await wait(40000);
const empty3 = await drain();
console.log('before', JSON.stringify(before), '\nempty ', JSON.stringify(empty), '\nafter ', JSON.stringify(after), '\nempty2', JSON.stringify(empty2), '\nempty3', JSON.stringify(empty3));
await browser.close(); admin.close(); srv.kill();
if (errors.length) fail(`page errors: ${errors.slice(0, 5).join(' | ')}`);
if (logs.length) fail(`server error logs: ${JSON.stringify(logs.slice(0, 5))}`);
if (before.n !== count) fail(`expected ${count} characters, got ${before.n}`);
if (empty.n !== 0) fail(`characters left after demo stop: ${empty.n}`);
if (empty2.n !== 0) fail(`characters left after second stop: ${empty2.n}`);
if (empty3.n !== 0) fail(`characters left after third stop: ${empty3.n}`);
if (empty3.geo > empty2.geo + 12 || empty3.tex > empty2.tex + 12) fail(`GPU resource leak: ${JSON.stringify(empty2)} -> ${JSON.stringify(empty3)}`);
console.log('SMOKE OK');
