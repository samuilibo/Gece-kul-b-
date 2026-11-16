import 'dotenv/config';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AdminMsg, AdminStatus, LiveMsg, LiveStats, LogItem, MusicInfo, ServerMsg } from '../shared/protocol.ts';
import { ClubState } from './core/club.ts';
import { DemoDriver } from './core/demo.ts';
import { Db } from './db.ts';
import { AVATAR_HOSTS, type PlatformDeps } from './platforms/common.ts';
import { KickConnector } from './platforms/kick.ts';
import { TikTokConnector } from './platforms/tiktok.ts';
import { TwitchConnector } from './platforms/twitch.ts';
import { YouTubeConnector } from './youtube/connector.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const MUSIC_DIR = resolve(ROOT, process.env.MUSIC_DIR ?? 'music');
const started = Date.now();

const db = new Db(resolve(ROOT, process.env.DB_FILE ?? 'data/neonclub.sqlite'));
const lives = new Set<WebSocket>();
const admins = new Set<WebSocket>();

function log(level: LogItem['level'], scope: string, msg: string) {
  const item: LogItem = { ts: Date.now(), level, scope, msg };
  try { db.log(item); } catch { /* db closed during shutdown */ }
  if (level !== 'info' || DEV) console.log(`[${level}] ${scope}: ${msg}`);
  broadcast({ t: 'log', item }, 'admin');
}

function broadcast(msg: ServerMsg, to: 'all' | 'admin') {
  const s = JSON.stringify(msg);
  for (const ws of admins) if (ws.readyState === 1) ws.send(s);
  if (to === 'all') for (const ws of lives) if (ws.readyState === 1) ws.send(s);
}

const club = new ClubState(db, broadcast, log, {
  badWords: (process.env.BAD_WORDS ?? '').split(',').filter(Boolean),
  idleMinutes: Number(process.env.IDLE_MINUTES ?? 60),
});
const demo = new DemoDriver(club);

// Credentials live only in this process. They are never sent over the WebSocket.
const yt = new YouTubeConnector({
  apiKey: process.env.YOUTUBE_API_KEY ?? '',
  oauth: process.env.YOUTUBE_OAUTH_REFRESH_TOKEN ? {
    clientId: process.env.YOUTUBE_OAUTH_CLIENT_ID ?? '', clientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET ?? '',
    refreshToken: process.env.YOUTUBE_OAUTH_REFRESH_TOKEN,
  } : undefined,
  useGrpc: (process.env.YOUTUBE_USE_GRPC ?? '1') !== '0',
}, {
  minPollMs: () => club.settings.minPollMs,
  loadToken: (chatId) => db.getJson<string | undefined>(`yt:token:${chatId}`, undefined),
  saveToken: (chatId, token) => db.setJson(`yt:token:${chatId}`, token),
  onEvent: (ev) => club.handleChat(ev),
  onStatus: () => { refreshMode(); pushStatus(); },
  log: (level, msg) => log(level, 'youtube', msg),
});

// ---- Twitch / Kick / TikTok (credentials from .env; Twitch login token kept in SQLite)
const platformDeps = (scope: string): PlatformDeps => ({
  onEvent: (ev) => club.handleChat(ev),
  onStatus: () => { refreshMode(); pushStatus(); },
  log: (level, msg) => log(level, scope, msg.replace(/^\w+: /, '')),
  kvGet: (k, f) => db.getJson(k, f),
  kvSet: (k, v) => db.setJson(k, v),
  setAvatar: (id, url) => club.setAvatar(id, url),
});
const twitch = new TwitchConnector(process.env.TWITCH_CLIENT_ID ?? '', platformDeps('twitch'));
const kick = new KickConnector({
  clientId: process.env.KICK_CLIENT_ID ?? '', clientSecret: process.env.KICK_CLIENT_SECRET ?? '',
  webhookPort: Number(process.env.KICK_WEBHOOK_PORT ?? 3001), webhookHost: process.env.KICK_WEBHOOK_HOST ?? '127.0.0.1',
}, platformDeps('kick'));
const tiktok = new TikTokConnector(process.env.TIKTOK_SIGN_API_KEY ?? '', platformDeps('tiktok'));
const anyLive = () => yt.connected || twitch.active || kick.active || tiktok.active;

/** live while at least one real platform is connected; demo only when nothing real is. */
function refreshMode() {
  const want = anyLive() ? 'live' : demo.running ? 'demo' : 'idle';
  if (club.mode !== want) club.setMode(want);
}
function disconnectAll() { yt.disconnect(); twitch.disconnect(); kick.disconnect(); tiktok.disconnect(); }

let liveStats: LiveStats | null = null;
let musicInfo: MusicInfo | null = null;
let playlist: AdminStatus['playlist'] = [];
let simDown = false;
demo.onDisconnectSim = (phase, ms) => {
  simDown = phase === 'down';
  log('warn', 'demo', phase === 'down' ? `[SIMULATION] connection lost for ${ms} ms` : '[SIMULATION] connection restored');
  pushStatus();
};

function status(): AdminStatus {
  const y = { ...yt.status };
  if (club.mode === 'demo' && simDown) { y.state = 'reconnecting'; y.detail = 'SIMULATION'; }
  return {
    platforms: { twitch: twitch.status, kick: kick.status, tiktok: tiktok.status },
    youtube: y, mode: club.mode, liveClients: lives.size, stats: lives.size ? liveStats : null, music: lives.size ? musicInfo : null,
    playlist, queueLength: club.queueLength(), blocked: db.blocked(), uptime: Date.now() - started,
  };
}
function pushStatus() { broadcast({ t: 'status', status: status() }, 'admin'); }

// ------------------------------------------------------------------ admin commands
async function onAdmin(msg: AdminMsg) {
  switch (msg.t) {
    case 'connect': {
      if (demo.running) demo.stop();
      club.setMode('live');
      const ok = await yt.connect(msg.url);
      refreshMode();
      if (ok) log('info', 'youtube', `connected to ${yt.status.videoId} "${yt.status.title}"`);
      break;
    }
    case 'disconnect': yt.disconnect(); refreshMode(); break;
    case 'platform': {
      const ch = (msg.channel ?? '').trim().slice(0, 100);
      const p = msg.platform;
      if (msg.cmd === 'login' && p === 'twitch') { void twitch.login(); break; }
      if (msg.cmd === 'logout' && p === 'twitch') { twitch.logout(); refreshMode(); break; }
      if (msg.cmd === 'disconnect') { (p === 'twitch' ? twitch : p === 'kick' ? kick : tiktok).disconnect(); refreshMode(); break; }
      if (msg.cmd === 'connect') {
        const pl = club.settings.platforms;
        if (p === 'tiktok') club.patchSettings({ platforms: { ...pl, tiktok: { ...pl.tiktok, username: ch || pl.tiktok.username } } });
        else club.patchSettings({ platforms: { ...pl, [p]: { channel: ch || pl[p].channel } } });
        if (demo.running) demo.stop();
        club.setMode('live');
        const s = club.settings.platforms;
        if (p === 'twitch') await twitch.connect(s.twitch.channel);
        else if (p === 'kick') await kick.connect(s.kick.channel);
        else await tiktok.connect(s.tiktok.username, s.tiktok.acceptUnofficial);
        refreshMode();
      }
      break;
    }
    case 'settings': club.patchSettings(msg.patch); break;
    case 'kick': club.remove(msg.id, 'kicked'); break;
    case 'block': club.block(msg.id); break;
    case 'unblock': club.unblock(msg.id); break;
    case 'grantVip': club.grantVip(msg.id, msg.on); break;
    case 'demo':
      // Simulated viewers are only ever created while no real stream is connected.
      if (anyLive() || club.mode === 'live') { log('warn', 'demo', 'demo refused: a real stream is connected'); break; }
      if (msg.cmd === 'start') { demo.autoSuperchat = msg.autoSupport !== false; demo.start(msg.count ?? 10); }
      else if (msg.cmd === 'stop') demo.stop();
      else if (!demo.running) break;
      else if (msg.cmd === 'add') demo.add(msg.count ?? 10);
      else if (msg.cmd === 'chat') demo.sayAsFirst(msg.text ?? '!dance');
      else if (msg.cmd === 'superchat') demo.superchat(msg.tier ?? 0);
      else if (msg.cmd === 'disconnectTest') demo.disconnectTest();
      else if (msg.cmd === 'load') {
        const n = msg.count ?? 300;
        if (club.settings.maxCharacters < n) club.patchSettings({ maxCharacters: n });
        demo.rate = 8;
        demo.add(Math.max(0, n - demo.count));
      }
      break;
    case 'music': broadcast({ t: 'music', cmd: msg.cmd, arg: msg.arg }, 'all'); break;
    case 'camera': broadcast({ t: 'camera', shot: msg.shot, target: msg.target }, 'all'); break;
    case 'event': club.setEvent(msg.id); break;
    case 'eventVote': club.openEventVote(); break;
    case 'test': broadcast({ t: 'test', what: msg.what, arg: msg.arg }, 'all'); break;
    case 'emergency':
      club.setEmergency(msg.on);
      if (msg.on) { disconnectAll(); if (demo.running) demo.stop(); club.setMode('idle'); }
      break;
    case 'clearLogs': db.clearLogs(); break;
    case 'effects': club.stopEffects(msg.cmd === 'clear'); break;
  }
  pushStatus();
}

// ------------------------------------------------------------------ http
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/ogg', '.webm': 'audio/webm',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm',
};
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.webm']);

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache = false) {
  let st;
  try { st = statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (!st.isFile()) { res.writeHead(404).end('not found'); return; }
  const headers: Record<string, string | number> = {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'accept-ranges': 'bytes',
    'cache-control': cache ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }).end(); return; }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  createReadStream(file).pipe(res);
}

function safeJoin(base: string, rel: string): string | null {
  const p = normalize(join(base, decodeURIComponent(rel)));
  return p.startsWith(base) ? p : null;
}

function listMusic() {
  if (!existsSync(MUSIC_DIR)) return [];
  const out: { file: string; title: string; genre: string }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) { if (!rel) walk(join(dir, e.name), e.name); continue; }   // one level: sub-folder = genre
      if (!AUDIO_EXT.has(extname(e.name).toLowerCase())) continue;
      out.push({ file: (rel ? `${rel}/` : '') + e.name, title: e.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '), genre: rel.toLowerCase() });
    }
  };
  walk(MUSIC_DIR, '');
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

const avatarCache = new Map<string, { type: string; body: Buffer }>();
async function avatar(res: ServerResponse, u: string) {
  let url: URL;
  try { url = new URL(u); } catch { res.writeHead(400).end(); return; }
  // only Google-hosted profile images are proxied (no open proxy)
  if (url.protocol !== 'https:' || !AVATAR_HOSTS.test(url.hostname)) { res.writeHead(403).end(); return; }
  let hit = avatarCache.get(u);
  if (!hit) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || !type.startsWith('image/')) throw new Error(`bad response ${r.status}`);
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length > 512 * 1024) throw new Error('too large');
      hit = { type, body };
      avatarCache.set(u, hit);
      if (avatarCache.size > 600) avatarCache.delete(avatarCache.keys().next().value!);
    } catch { res.writeHead(502).end(); return; }
  }
  res.writeHead(200, { 'content-type': hit.type, 'cache-control': 'public, max-age=86400' }).end(hit.body);
}

const PAGES: Record<string, string> = { '/live': 'live.html', '/admin': 'admin.html', '/viewer': 'viewer.html' };
let vite: import('vite').ViteDevServer | null = null;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') { res.writeHead(302, { location: '/admin' }).end(); return; }
  if (path === '/api/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, mode: club.mode, uptime: Date.now() - started })); return; }
  if (path === '/api/music') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(listMusic())); return; }
  if (path === '/api/avatar') { void avatar(res, url.searchParams.get('u') ?? ''); return; }
  if (path.startsWith('/music/')) {
    const f = safeJoin(MUSIC_DIR, path.slice(7));
    if (!f || !AUDIO_EXT.has(extname(f).toLowerCase())) { res.writeHead(404).end(); return; }
    sendFile(req, res, f);
    return;
  }
  if (vite) {
    if (PAGES[path]) req.url = `/${PAGES[path]}${url.search}`;
    vite.middlewares(req, res, () => res.writeHead(404).end('not found'));
    return;
  }
  const dist = join(ROOT, 'dist');
  const f = PAGES[path] ? join(dist, PAGES[path]) : safeJoin(dist, path);
  if (!f) { res.writeHead(403).end(); return; }
  sendFile(req, res, f, path.startsWith('/assets/') && !path.startsWith('/assets/characters'));
});

// ------------------------------------------------------------------ websocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') return;      // leaves Vite's HMR socket alone
  const role = url.searchParams.get('role');
  if (role === 'admin' && ADMIN_TOKEN && url.searchParams.get('token') !== ADMIN_TOKEN) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const set = role === 'admin' ? admins : lives;
    set.add(ws);
    ws.send(JSON.stringify({ t: 'snapshot', state: club.publicState() } satisfies ServerMsg));
    if (role === 'admin') {
      for (const item of db.recentLogs(150)) ws.send(JSON.stringify({ t: 'log', item } satisfies ServerMsg));
      ws.send(JSON.stringify({ t: 'status', status: status() } satisfies ServerMsg));
    }
    ws.on('message', (data) => {
      let msg: AdminMsg | LiveMsg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (role === 'admin') { void onAdmin(msg as AdminMsg).catch((e) => log('error', 'admin', String(e?.message ?? e))); return; }
      const m = msg as LiveMsg;                    // the live view can only report, never command
      if (m.t === 'stats') liveStats = m.stats;
      else if (m.t === 'musicInfo') { musicInfo = m.info; if (m.playlist) playlist = m.playlist; }
      else if (m.t === 'clientError') log('error', 'live', String(m.msg).slice(0, 500));
      else if (m.t === 'bench') log('info', 'benchmark', JSON.stringify(m.result).slice(0, 1800));
    });
    ws.on('close', () => { set.delete(ws); pushStatus(); });
    ws.on('error', () => set.delete(ws));
    pushStatus();
  });
});

setInterval(() => { club.tick(); pushStatus(); }, 1000);
setInterval(() => club.sweep(), 5 * 60000);

if (DEV) {
  const { createServer: createVite } = await import('vite');
  vite = await createVite({ root: ROOT, server: { middlewareMode: true, hmr: { server } } });
} else if (!existsSync(join(ROOT, 'dist', 'live.html'))) {
  console.error('dist/ not found. Run "npm run build" first (or "npm run dev").');
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  NEON CLUB LIVE${DEV ? ' (dev)' : ''}\n  Live view  : http://localhost:${PORT}/live\n  Admin panel: http://localhost:${PORT}/admin\n`);
  log('info', 'server', `started on ${HOST}:${PORT}; music dir ${MUSIC_DIR}; api key ${process.env.YOUTUBE_API_KEY ? 'set' : 'not set'}`);
});

const shutdown = () => { disconnectAll(); kick.stop(); demo.running && demo.stop(); server.close(); db.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
