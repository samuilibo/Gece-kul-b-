// Runs the in-app benchmark against a running server (npm start) and prints the measured result.
// usage: node tools/benchmark.mjs [characters=100] [quality=high]   (PORT env, default 3000)
// Open http://localhost:PORT/live in Chrome/Edge or OBS on the target PC first: the measurement happens there.
import { WebSocket } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
const port = process.env.PORT ?? 3000, n = Number(process.argv[2] ?? 100), quality = process.argv[3] ?? 'high';
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=admin&token=${process.env.ADMIN_TOKEN ?? ''}`);
const send = (m) => ws.send(JSON.stringify(m));
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.t === 'status' && m.status.liveClients === 0 && !globalThis.warned) { globalThis.warned = true; console.log('Waiting for a /live client to connect…'); }
  if (m.t === 'log' && m.item.scope === 'benchmark' && m.item.ts > start) {
    const r = JSON.parse(m.item.msg);
    console.log(JSON.stringify(r, null, 2));
    mkdirSync('bench-results', { recursive: true });
    writeFileSync(`bench-results/bench-${r.characters}-${r.quality}-${Date.now()}.json`, JSON.stringify(r, null, 2));
    send({ t: 'demo', cmd: 'stop' });
    setTimeout(() => process.exit(0), 300);
  }
});
let start = 0;
ws.on('open', async () => {
  start = Date.now();
  send({ t: 'settings', patch: { quality, maxCharacters: Math.max(n, 10) } });
  send({ t: 'demo', cmd: 'stop' });
  send({ t: 'demo', cmd: 'start', count: n });
  console.log(`Spawning ${n} demo characters at quality=${quality}; benchmark starts in ${Math.round(20 + n * 0.08)} s…`);
  setTimeout(() => send({ t: 'test', what: 'bench' }), (20 + n * 0.08) * 1000);
});
