// Renders the README screenshots at 3840×2160 (1920×1080 page at device scale 2). The 3D scene runs at normal
// resolution and switches to 2× only for the captured frame, so this also works with software rendering.
// usage: start the server (npm run dev / npm start), then: node tools/screenshots.mjs <part> [port]
//   part = club | full | extra      (screens are written to docs/screenshots/)
// Uses demo mode only: every avatar is a labelled simulated viewer.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const req = createRequire(import.meta.url);
const { chromium } = req('playwright'); const { WebSocket } = req('ws');
const part = process.argv[2] ?? 'club', port = process.argv[3] ?? '3000', base = `http://127.0.0.1:${port}`;
const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=admin&token=${process.env.ADMIN_TOKEN ?? ''}`);
const snap = await new Promise((r) => ws.once('message', (d) => r(JSON.parse(d))));
const A = (m) => ws.send(JSON.stringify(m));
const cmds = { ...snap.state.settings.commands, camera: { on: false, cooldown: 60 }, help: { on: false, cooldown: 60 } };
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
// software rendering in CI / headless containers is slow at 4K: allow a long time per frame
const shot4k = async (p, name) => {
  await p.evaluate(() => { const e = window.__club.engine; e.scale = 2; e.resize(); });
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await shotJpg(p, name);
  await p.evaluate(() => { const e = window.__club.engine; e.scale = 1; e.resize(); });
};
const shotJpg = async (p, name) => { await p.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 90, timeout: 600000 }); console.log('saved', name); };

async function livePage(w, h, extra = '') {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  p.setDefaultTimeout(600000);
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto(`${base}/live?fixedres&quality=high${extra}`);
  await p.waitForFunction(() => document.title.startsWith('ready'), null, { timeout: 300000 });
  await p.waitForFunction(() => window.__club.crowd.gpu.ready, null, { timeout: 300000 });
  return p;
}
async function demo(count, max) {
  A({ t: 'demo', cmd: 'stop' });
  A({ t: 'settings', patch: { maxCharacters: max ?? count, overlayLang: 'en', commands: cmds, welcomeCamera: false, cameraAuto: false, quality: 'high' } });
  A({ t: 'demo', cmd: 'start', count, autoSupport: false });
  await wait(Math.min(36000, 6000 + count * 60));
}
const cam = async (shot, ms = 9000) => { A({ t: 'camera', shot }); await wait(ms); };

if (part === 'club') {
  A({ t: 'event', id: 'neon' });
  await demo(420);
  const p = await livePage(1920, 1080);
  await wait(6000);
  await cam('wide'); await shot4k(p, 'club-wide');
  await cam('orbit', 12000); await shot4k(p, 'crowd-orbit');
  await cam('dj'); await shot4k(p, 'dj-booth');
  // supporter close-up: a simulated tier-5 Super Chat, camera on the golden avatar
  A({ t: 'camera', shot: 'auto' }); A({ t: 'settings', patch: { cameraAuto: true } });
  A({ t: 'demo', cmd: 'superchat', tier: 5 });
  await wait(1500);
  const id = await p.evaluate(() => [...window.__club.crowd.dancers.values()].find((d) => d.goldUntil > 0)?.m.id);
  if (id) A({ t: 'camera', shot: 'user', target: id });
  await wait(4500); await shot4k(p, 'supporter-closeup');
  A({ t: 'settings', patch: { cameraAuto: false } });
  A({ t: 'event', id: 'retro' }); await cam('top', 10000); await shot4k(p, 'retro-disco-top');
  A({ t: 'event', id: 'rooftop' }); await cam('balcony', 10000); await shot4k(p, 'rooftop-party');
  A({ t: 'event', id: 'laser' }); await cam('djback', 10000); await shot4k(p, 'laser-show');
  await p.close();
}
if (part === 'full') {
  A({ t: 'event', id: 'neon' });
  await demo(1560, 1500);                 // 60 more than the limit: they wait in the door queue
  for (let i = 0; i < 4; i++) { A({ t: 'demo', cmd: 'superchat', tier: 2 + i }); await wait(400); }   // queued supporters move ahead
  await wait(8000);
  const p = await livePage(1920, 1080);
  await wait(6000);
  await cam('upper', 10000); await shot4k(p, 'balcony-1500');
  await cam('wide', 10000); await shot4k(p, 'full-club-queue');
  await p.close();
}
if (part === 'extra') {
  A({ t: 'event', id: 'color' });
  await demo(160);
  const v = await livePage(1080, 1920, '&layout=portrait');
  await cam('orbit', 12000); await shot4k(v, 'portrait-9x16');
  await v.close();
  const a = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  await a.goto(`${base}/admin`);
  await a.waitForSelector('#ytInfo'); await wait(3000);
  await a.evaluate(() => { localStorage.setItem('nc-lang', 'en'); });
  await a.reload(); await a.waitForSelector('#ytInfo'); await wait(4000);
  await shotJpg(a, 'admin-panel');
  await a.close();
  const c = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  await c.goto(`${base}/viewer?shot=1&n=8&clip=hiphop_bounce,shuffle_run,disco_point,hands_up,robot_a,house_jack,freestyle_a,twist&t=0.6&seed=21&d=8.6&y=0.95`);
  await c.waitForFunction(() => document.title.startsWith('ready'), null, { timeout: 300000 });
  await wait(2000); await shotJpg(c, 'characters');
  await c.close();
}
A({ t: 'camera', shot: 'auto' });
A({ t: 'settings', patch: { cameraAuto: true, welcomeCamera: true, commands: snap.state.settings.commands, overlayLang: snap.state.settings.overlayLang } });
await wait(500);
await browser.close(); ws.close();
