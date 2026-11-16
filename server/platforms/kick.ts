// Kick chat, subscriptions, gifted subs and KICKs through the official Kick Public API.
// Kick delivers events only by webhook to a PUBLIC https URL. This module runs a separate, minimal
// webhook listener (KICK_WEBHOOK_PORT, default 3001) that you expose with a tunnel (e.g. Cloudflare
// Tunnel); the admin panel and the live view are NOT exposed. Every request is verified with Kick's
// RSA signature before it is used.
import { createVerify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { ChatEvent } from '../core/club.ts';
import { RATES, newStatus, proxied, tierFromUsd, type PlatformDeps } from './common.ts';

const API = 'https://api.kick.com/public/v1';
const EVENTS = ['chat.message.sent', 'channel.subscription.new', 'channel.subscription.renewal', 'channel.subscription.gifts', 'kicks.gifted', 'livestream.status.updated'];
type Raw = Record<string, any>;

const user = (u: Raw | null | undefined, anon = false) => ({
  id: `kick:${anon || !u?.user_id ? 'anonymous' : u.user_id}`, name: String(anon || !u?.username ? 'Anonymous' : u.username),
  avatar: anon ? undefined : proxied(u?.profile_picture || undefined),
  isOwner: false, isMod: false, isMember: false,
});

/** Webhook payload -> ChatEvent. Exported for tests. */
export function normalizeKick(type: string, body: Raw, messageId: string): ChatEvent | 'ended' | null {
  const base = { id: `kick:${messageId}`, source: 'kick' as const, ts: Date.parse(body.created_at ?? '') || Date.now() };
  switch (type) {
    case 'chat.message.sent': {
      const a = user(body.sender);
      const badges = new Set<string>((body.sender?.identity?.badges ?? []).map((b: Raw) => String(b.type)));
      a.isOwner = badges.has('broadcaster'); a.isMod = badges.has('moderator'); a.isMember = badges.has('subscriber') || badges.has('vip') || badges.has('og');
      // emotes arrive as [emote:id:name]; keep the name so the text stays readable
      const text = String(body.content ?? '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1');
      return { ...base, author: a, kind: 'text', text };
    }
    case 'channel.subscription.new':
      return { ...base, author: user(body.subscriber), kind: 'member', text: '', amountText: 'Kick Sub', tier: tierFromUsd(RATES.kickSubUsd) };
    case 'channel.subscription.renewal':
      return { ...base, author: user(body.subscriber), kind: 'milestone', text: '', amountText: `Kick Sub · ${Number(body.duration) || 1} mo`, tier: tierFromUsd(RATES.kickSubUsd) };
    case 'channel.subscription.gifts': {
      const n = Array.isArray(body.giftees) ? body.giftees.length : 1;
      return { ...base, author: user(body.gifter, !!body.gifter?.is_anonymous), kind: 'gift', text: '', amountText: `${n}× Gift Sub`, tier: tierFromUsd(n * RATES.kickSubUsd) };
    }
    case 'kicks.gifted': {
      const amount = Number(body.gift?.amount) || 0;
      return { ...base, author: user(body.sender), kind: 'superchat', text: String(body.gift?.message ?? ''), amountText: `${amount.toLocaleString('en-US')} KICKs${body.gift?.name ? ` · ${body.gift.name}` : ''}`, tier: tierFromUsd(amount * RATES.kickUsd), usd: amount * RATES.kickUsd };
    }
    case 'livestream.status.updated':
      return body.is_live === false ? 'ended' : null;
    default:
      return null;
  }
}

/** Signature check exactly as documented: RSA-SHA256 (PKCS#1 v1.5) over "messageId.timestamp.rawBody". */
export function verifyKickSignature(publicKeyPem: string, messageId: string, timestamp: string, rawBody: string, signatureB64: string): boolean {
  try {
    const v = createVerify('RSA-SHA256');
    v.update(`${messageId}.${timestamp}.${rawBody}`);
    return v.verify(publicKeyPem, signatureB64, 'base64');
  } catch { return false; }
}

export class KickConnector {
  status = newStatus(false);
  private appToken = '';
  private appTokenExp = 0;
  private publicKey = '';
  private publicKeyAt = 0;
  private broadcasterId = 0;
  private server: Server | null = null;
  private connected = false;

  constructor(private cfg: { clientId: string; clientSecret: string; webhookPort: number; webhookHost: string }, private deps: PlatformDeps, private f: typeof fetch = fetch) {
    this.status.configured = !!(cfg.clientId && cfg.clientSecret);
    this.status.webhookPort = cfg.webhookPort;
  }

  get active() { return this.connected; }
  private set(p: Partial<typeof this.status>) { Object.assign(this.status, p); this.deps.onStatus(); }

  private async token() {
    if (this.appToken && Date.now() < this.appTokenExp - 60000) return this.appToken;
    const r = await this.f('https://id.kick.com/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }) });
    const j = await r.json().catch(() => ({})) as Raw;
    if (!r.ok || !j.access_token) throw new Error(`Kick token: ${j.error ?? r.status}`);
    this.appToken = j.access_token;
    this.appTokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return this.appToken;
  }

  private async api(path: string, init: RequestInit = {}) {
    const r = await this.f(`${API}/${path}`, { ...init, headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) } });
    const j = await r.json().catch(() => ({})) as Raw;
    if (!r.ok) throw new Error(`Kick API ${r.status}: ${j.message ?? JSON.stringify(j).slice(0, 120)}`);
    return j;
  }

  private async key(force = false) {
    if (this.publicKey && !force && Date.now() - this.publicKeyAt < 3600000) return this.publicKey;
    const r = await this.f(`${API}/public-key`);
    const j = await r.json().catch(() => ({})) as Raw;
    const pem = j?.data?.public_key;
    if (typeof pem !== 'string' || !pem.includes('PUBLIC KEY')) throw new Error('Kick public key unavailable');
    this.publicKey = pem; this.publicKeyAt = Date.now();
    return pem;
  }

  async connect(channel: string) {
    const slug = channel.replace(/^.*kick\.com\//i, '').replace(/[^A-Za-z0-9_-]/g, '').toLowerCase();
    if (!this.status.configured) { this.set({ state: 'error', detail: 'KICK_CLIENT_ID / KICK_CLIENT_SECRET missing in .env' }); return false; }
    if (!slug) { this.set({ state: 'error', detail: 'channel name required' }); return false; }
    this.set({ state: 'connecting', channel: slug, detail: '', messages: 0 });
    try {
      this.startListener();
      await this.key();
      const ch = await this.api(`channels?slug=${encodeURIComponent(slug)}`);
      this.broadcasterId = Number(ch.data?.[0]?.broadcaster_user_id);
      if (!this.broadcasterId) throw new Error(`channel "${slug}" not found`);
      const existing = (await this.api('events/subscriptions')).data ?? [];
      const mine = existing.filter((s: Raw) => Number(s.broadcaster_user_id ?? this.broadcasterId) === this.broadcasterId);
      const missing = EVENTS.filter((e) => !mine.some((s: Raw) => s.event === e && Number(s.version) === 1));
      if (missing.length) {
        const res = await this.api('events/subscriptions', { method: 'POST', body: JSON.stringify({ broadcaster_user_id: this.broadcasterId, events: missing.map((name) => ({ name, version: 1 })), method: 'webhook' }) });
        const errs = (res.data ?? []).filter((x: Raw) => x.error).map((x: Raw) => `${x.name}: ${x.error}`);
        if (errs.length) this.deps.log('warn', `kick: some subscriptions failed: ${errs.join('; ')}`);
      }
      this.connected = true;
      // events only arrive once the tunnel + app webhook URL are set up; "waiting" until the first one does
      this.set({ state: 'waiting', detail: 'waiting-first-webhook' });
      this.deps.log('info', `kick: subscribed to ${slug} (#${this.broadcasterId}); waiting for webhooks on port ${this.cfg.webhookPort}`);
      return true;
    } catch (e) {
      this.connected = false;
      this.set({ state: 'error', detail: String((e as Error).message).slice(0, 200) });
      this.deps.log('error', `kick: ${(e as Error).message}`);
      return false;
    }
  }

  /** Subscriptions stay registered on Kick (cheap, and re-used on the next connect); events are ignored while disconnected. */
  disconnect() { this.connected = false; this.set({ state: 'disconnected', detail: '' }); }

  stop() { this.disconnect(); this.server?.close(); this.server = null; }

  private startListener() {
    if (this.server) return;
    this.server = createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > 256 * 1024) req.destroy(); else chunks.push(c); });
      req.on('end', () => { void this.onWebhook(req.headers as Record<string, string>, Buffer.concat(chunks).toString('utf8')).then((code) => res.writeHead(code).end()); });
    });
    this.server.on('error', (e) => { this.set({ state: 'error', detail: `webhook port ${this.cfg.webhookPort}: ${e.message}` }); });
    this.server.listen(this.cfg.webhookPort, this.cfg.webhookHost);
  }

  /** Returns the HTTP status for Kick. Unsigned / invalid requests are rejected and never reach the club. */
  async onWebhook(h: Record<string, string>, raw: string): Promise<number> {
    const id = h['kick-event-message-id'], ts = h['kick-event-message-timestamp'], sig = h['kick-event-signature'], type = h['kick-event-type'];
    if (!id || !ts || !sig || !type) return 400;
    let ok = verifyKickSignature(await this.key().catch(() => ''), id, ts, raw, sig);
    if (!ok) ok = verifyKickSignature(await this.key(true).catch(() => ''), id, ts, raw, sig);   // key rotation
    if (!ok) { this.deps.log('warn', 'kick: rejected webhook with invalid signature'); return 401; }
    if (Math.abs(Date.now() - Date.parse(ts)) > 10 * 60000) return 200;                       // stale replay: acknowledge, ignore
    if (!this.connected) return 200;
    let body: Raw;
    try { body = JSON.parse(raw); } catch { return 400; }
    if (body.broadcaster?.user_id && Number(body.broadcaster.user_id) !== this.broadcasterId) return 200;
    const ev = normalizeKick(type, body, id);
    if (this.status.state !== 'connected') this.set({ state: 'connected', detail: '' });
    if (ev === 'ended') { this.deps.log('info', 'kick: stream ended'); return 200; }
    if (ev) { this.status.messages++; this.deps.onEvent(ev); }
    return 200;
  }
}
