// usage: node tools/shot.mjs <url> <out.png> [w] [h] [waitMs] [more: "ms:out2.png" ...]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const [url, out, w = 900, h = 900, wait = 0, ...more] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
p.on('console', (m) => { if (m.type() === 'error' || process.env.VERBOSE) console.log('[console]', m.type(), m.text()); });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(url);
await p.waitForFunction(() => document.title.startsWith('ready'), null, { timeout: 180000 }).catch(() => console.log('timeout waiting ready'));
if (+wait) await p.waitForTimeout(+wait);
console.log(await p.title());
await p.screenshot({ path: out });
for (const m of more) { const [ms, f] = m.split(':'); await p.waitForTimeout(+ms); await p.screenshot({ path: f }); }
if (process.env.EVAL) console.log(JSON.stringify(await p.evaluate(process.env.EVAL)));
await b.close();
