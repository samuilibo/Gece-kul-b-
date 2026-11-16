// CLI helper: node tools/admin.mjs '{"t":"demo","cmd":"start","count":50}' [more json...]   (PORT env, default 3000)
import { WebSocket } from 'ws';
const port = process.env.PORT ?? 3000;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?role=admin&token=${process.env.ADMIN_TOKEN ?? ''}`);
ws.on('open', () => { for (const m of process.argv.slice(2)) ws.send(m); setTimeout(() => ws.close(), 400); });
ws.on('error', (e) => { console.error('admin ws error', e.message); process.exit(1); });
