// Twitch chat + Bits + subscriptions through the official EventSub WebSocket transport.
// No public URL is needed. Login uses the OAuth Device Code flow (public client, no secret),
// scope user:read:chat. Tokens are stored only in the local SQLite database.
import { WebSocket } from 'ws';
import type { ChatEvent } from '../core/club.ts';
import { backoffMs } from '../youtube/connector.ts';
import { RATES, newStatus, proxied, sleep, tierFromUsd, type PlatformDeps } from './common.ts';

const ID = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const EVENTSUB_WS = 'wss://eventsub.wss.twitch.tv/ws';
const SCOPES = 'user:read:chat';
const TOKEN_KEY = 'twitch:tokens';

interface Tokens { access: string; refresh: string; expiresAt: number; login: string; userId: string }
type Raw = Record<string, any>;

const tierLabel = (t: string | undefined) => (t === '3000' ? 'Tier 3' : t === '2000' ? 'Tier 2' : t === 'prime' ? 'Prime' : 'Tier 1');
const badgeSet = (ev: Raw) => new Set<string>((ev.badges ?? []).map((b: Raw) => String(b.set_id)));

/** EventSub notification (channel.chat.message / channel.chat.notification) -> ChatEvent. Exported for tests. */
export function normalizeTwitch(subType: string, ev: Raw, msgId: string): ChatEvent | null {
  const badges = badgeSet(ev);
  const anon = !!ev.chatter_is_anonymous;
  const author = {
    id: `tw:${anon ? 'anonymous' : ev.chatter_user_id}`, name: String(anon ? 'Anonymous' : ev.chatter_user_name ?? ev.chatter_user_login ?? ''),
    isOwner: badges.has('broadcaster'), isMod: badges.has('moderator'), isMember: badges.has('subscriber') || badges.has('vip') || badges.has('founder'),
  };
  if (!ev.chatter_user_id && !anon) return null;
  const base = { id: `tw:${ev.message_id ?? msgId}`, source: 'twitch' as const, ts: Date.now(), author };
  const text = String(ev.message?.text ?? '');
  if (subType === 'channel.chat.message') {
    const bits = Number(ev.cheer?.bits) || 0;
    if (bits > 0) {
      // remove the "Cheer100" tokens so a command in the same message still parses
      const clean = text.replace(/(^|\s)[A-Za-z]+\d+(?=\s|$)/g, ' ').trim();
      return { ...base, kind: 'superchat', text: clean, amountText: `${bits.toLocaleString('en-US')} Bits`, tier: tierFromUsd(bits * RATES.bitUsd), usd: bits * RATES.bitUsd };
    }
    return { ...base, kind: 'text', text };
  }
  if (subType !== 'channel.chat.notification') return null;
  const n = String(ev.notice_type ?? '');
  const subUsd = (t?: string, prime?: boolean) => RATES.twitchSubUsd[prime ? 'prime' : t ?? '1000'] ?? 5;
  switch (n) {
    case 'sub': {
      const s = ev.sub ?? {};
      return { ...base, kind: 'member', text, amountText: `${tierLabel(s.is_prime ? 'prime' : s.sub_tier)} Sub`, tier: tierFromUsd(subUsd(s.sub_tier, s.is_prime)) };
    }
    case 'resub': {
      const s = ev.resub ?? {};
      return { ...base, kind: 'milestone', text, amountText: `${tierLabel(s.is_prime ? 'prime' : s.sub_tier)} · ${Number(s.cumulative_months) || 1} mo`, tier: tierFromUsd(subUsd(s.sub_tier, s.is_prime)) };
    }
    case 'sub_gift': {
      const s = ev.sub_gift ?? {};
      if (s.community_gift_id) return null;          // part of a community gift: the community_sub_gift event already counted it
      return { ...base, kind: 'gift', text: `→ ${s.recipient_user_name ?? ''}`, amountText: `1× ${tierLabel(s.sub_tier)} Gift Sub`, tier: tierFromUsd(subUsd(s.sub_tier)) };
    }
    case 'community_sub_gift': {
      const s = ev.community_sub_gift ?? {};
      const total = Number(s.total) || 1;
      return { ...base, kind: 'gift', text, amountText: `${total}× ${tierLabel(s.sub_tier)} Gift Subs`, tier: tierFromUsd(total * subUsd(s.sub_tier)) };
    }
    case 'gift_paid_upgrade': case 'prime_paid_upgrade':
      return { ...base, kind: 'member', text, amountText: 'Sub upgrade', tier: tierFromUsd(5) };
    default:
      return null;      // raids, announcements, pay-it-forward, charity…: not handled as paid events
  }
}

export class TwitchConnector {
  status = newStatus(false);
  private clientId: string;
  private tokens: Tokens | null;
  private abort: AbortController | null = null;
  private ws: WebSocket | null = null;
  private broadcasterId = '';
  private loginAbort: AbortController | null = null;
  private avatarCache = new Map<string, string>();

  constructor(clientId: string, private deps: PlatformDeps, private f: typeof fetch = fetch, private wsUrl = EVENTSUB_WS) {
    this.clientId = clientId;
    this.status.configured = !!clientId;
    this.tokens = deps.kvGet<Tokens | null>(TOKEN_KEY, null);
    this.status.account = this.tokens?.login;
  }

  get active() { return this.abort !== null; }
  private set(p: Partial<typeof this.status>) { Object.assign(this.status, p); this.deps.onStatus(); }

  // ------------------------------------------------------------------ device-code login
  async login() {
    if (!this.clientId) { this.set({ state: 'error', detail: 'TWITCH_CLIENT_ID missing in .env' }); return; }
    this.loginAbort?.abort();
    const ac = (this.loginAbort = new AbortController());
    try {
      const r = await this.f(`${ID}/device`, { method: 'POST', body: new URLSearchParams({ client_id: this.clientId, scopes: SCOPES }) });
      const d = await r.json() as Raw;
      if (!r.ok) throw new Error(`device: ${d.message ?? r.status}`);
      this.set({ auth: { userCode: d.user_code, verificationUri: d.verification_uri, expiresAt: Date.now() + d.expires_in * 1000 }, detail: 'login-pending' });
      let interval = (d.interval ?? 5) * 1000;
      while (!ac.signal.aborted && Date.now() < this.status.auth!.expiresAt) {
        await sleep(interval, ac.signal);
        const t = await this.f(`${ID}/token`, { method: 'POST', body: new URLSearchParams({ client_id: this.clientId, scopes: SCOPES, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
        const j = await t.json() as Raw;
        if (t.ok && j.access_token) { await this.storeTokens(j); this.set({ auth: null, detail: '', account: this.tokens!.login }); this.deps.log('info', `twitch: logged in as ${this.tokens!.login}`); return; }
        const msg = String(j.message ?? '');
        if (/slow_down/.test(msg)) interval += 5000;
        else if (!/authorization_pending/.test(msg)) throw new Error(`token: ${msg || t.status}`);
      }
      this.set({ auth: null, detail: ac.signal.aborted ? '' : 'login-expired' });
    } catch (e) {
      this.set({ auth: null, state: 'error', detail: String((e as Error).message).slice(0, 160) });
    }
  }

  logout() {
    this.loginAbort?.abort();
    this.disconnect();
    this.tokens = null;
    this.deps.kvSet(TOKEN_KEY, null);
    this.set({ account: undefined, auth: null });
  }

  private async storeTokens(j: Raw) {
    const v = await (await this.f(`${ID}/validate`, { headers: { authorization: `OAuth ${j.access_token}` } })).json() as Raw;
    this.tokens = { access: j.access_token, refresh: j.refresh_token ?? this.tokens?.refresh ?? '', expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000, login: v.login ?? '', userId: v.user_id ?? '' };
    this.deps.kvSet(TOKEN_KEY, this.tokens);
  }

  private async token(): Promise<string> {
    if (!this.tokens) throw Object.assign(new Error('not logged in'), { fatal: true });
    if (Date.now() < this.tokens.expiresAt - 120000) return this.tokens.access;
    const r = await this.f(`${ID}/token`, { method: 'POST', body: new URLSearchParams({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: this.tokens.refresh }) });
    const j = await r.json() as Raw;
    if (!r.ok || !j.access_token) { this.tokens = null; this.deps.kvSet(TOKEN_KEY, null); this.set({ account: undefined }); throw Object.assign(new Error('Twitch login expired, log in again'), { fatal: true }); }
    await this.storeTokens(j);
    return this.tokens!.access;
  }

  private async helix(path: string, init: RequestInit = {}) {
    const r = await this.f(`${HELIX}/${path}`, { ...init, headers: { 'client-id': this.clientId, authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const j = await r.json().catch(() => ({})) as Raw;
    if (!r.ok) throw Object.assign(new Error(`Helix ${r.status}: ${j.message ?? ''}`), { fatal: r.status === 401 || r.status === 403 || r.status === 400 });
    return j;
  }

  // ------------------------------------------------------------------ EventSub WebSocket
  async connect(channel: string) {
    this.disconnect();
    if (!this.clientId) { this.set({ state: 'error', detail: 'TWITCH_CLIENT_ID missing in .env' }); return false; }
    if (!this.tokens) { this.set({ state: 'error', detail: 'login required' }); return false; }
    const ac = (this.abort = new AbortController());
    const login = (channel || this.tokens.login).replace(/^.*twitch\.tv\//i, '').replace(/[^A-Za-z0-9_]/g, '').toLowerCase();
    this.set({ state: 'connecting', channel: login, detail: '', messages: 0 });
    try {
      const u = await this.helix(`users?login=${encodeURIComponent(login)}`);
      if (!u.data?.[0]) throw Object.assign(new Error(`channel "${login}" not found`), { fatal: true });
      this.broadcasterId = u.data[0].id;
    } catch (e) { this.fail((e as Error).message); return false; }
    void this.run(ac);
    return true;
  }

  disconnect() {
    this.abort?.abort();
    this.abort = null;
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
    this.set({ state: 'disconnected', retryInMs: 0, detail: '' });
  }

  private fail(detail: string) {
    this.abort?.abort(); this.abort = null;
    try { this.ws?.close(); } catch { /* */ }
    this.set({ state: 'error', detail: detail.slice(0, 200), retryInMs: 0 });
    this.deps.log('error', `twitch: ${detail}`);
  }

  private async run(ac: AbortController) {
    let attempt = 0;
    let url = this.wsUrl;
    while (!ac.signal.aborted) {
      const result = await this.session(url, ac.signal).catch((e) => ({ error: e as Error & { fatal?: boolean } }));
      if (ac.signal.aborted) return;
      if ('reconnectUrl' in result && result.reconnectUrl) { url = result.reconnectUrl; attempt = 0; continue; }
      url = this.wsUrl;
      if ('error' in result && result.error?.fatal) { this.fail(result.error.message); return; }
      const wait = backoffMs(attempt++);
      this.set({ state: 'reconnecting', retryInMs: wait, detail: 'error' in result ? String(result.error?.message ?? '').slice(0, 120) : 'connection closed' });
      this.deps.log('warn', `twitch: reconnecting in ${wait} ms`);
      await sleep(wait, ac.signal);
    }
  }

  /** One WebSocket session. Resolves with a reconnect URL (session_reconnect) or when the socket closes. */
  private session(url: string, signal: AbortSignal): Promise<{ reconnectUrl?: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const isReconnect = url !== this.wsUrl;
      let keepalive = 30000, timer: NodeJS.Timeout | null = null, done = false;
      const finish = (v: { reconnectUrl?: string } | Error) => {
        if (done) return; done = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (v instanceof Error) reject(v); else resolve(v);
      };
      const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { ws.terminate(); finish(new Error('keepalive timeout')); }, keepalive + 5000); };
      const onAbort = () => { ws.close(); finish({}); };
      signal.addEventListener('abort', onAbort, { once: true });
      ws.on('message', async (data) => {
        arm();
        let m: Raw;
        try { m = JSON.parse(String(data)); } catch { return; }
        const type = m.metadata?.message_type;
        if (type === 'session_welcome') {
          keepalive = (m.payload.session.keepalive_timeout_seconds ?? 10) * 1000;
          arm();
          const old = this.ws;
          this.ws = ws;
          if (old && old !== ws) old.close();      // after a session_reconnect the old socket is closed only now
          if (!isReconnect) {
            try {
              for (const t of ['channel.chat.message', 'channel.chat.notification']) {
                await this.helix('eventsub/subscriptions', { method: 'POST', body: JSON.stringify({ type: t, version: '1', condition: { broadcaster_user_id: this.broadcasterId, user_id: this.tokens!.userId }, transport: { method: 'websocket', session_id: m.payload.session.id } }) });
              }
            } catch (e) { ws.close(); finish(e as Error); return; }
          }
          this.set({ state: 'connected', detail: '', retryInMs: 0 });
          this.deps.log('info', `twitch: connected to #${this.status.channel}`);
        } else if (type === 'notification') {
          const ev = normalizeTwitch(m.metadata.subscription_type, m.payload.event ?? {}, m.metadata.message_id);
          if (ev) { this.status.messages++; this.deps.onEvent(ev); if (ev.kind === 'text' && /^!\s?(join|katıl|katil)/i.test(ev.text)) void this.avatar(ev.author.id); }
        } else if (type === 'session_reconnect') {
          // keep this socket until the new one says welcome
          finish({ reconnectUrl: m.payload.session.reconnect_url });
        } else if (type === 'revocation') {
          ws.close();
          finish(Object.assign(new Error(`subscription revoked: ${m.payload?.subscription?.status}`), { fatal: true }));
        }
      });
      ws.on('close', (code) => { if (this.ws === ws) this.ws = null; finish(code === 4003 || code === 4004 || code === 4007 ? new Error(`closed ${code}`) : {}); });
      ws.on('error', (e) => finish(e));
    });
  }

  /** Twitch chat events carry no profile picture; fetch it once for avatars that join. */
  private async avatar(memberId: string) {
    const id = memberId.slice(3);
    if (!/^\d+$/.test(id) || !this.deps.setAvatar) return;
    try {
      let url = this.avatarCache.get(id);
      if (!url) { url = (await this.helix(`users?id=${id}`)).data?.[0]?.profile_image_url ?? ''; this.avatarCache.set(id, url!); if (this.avatarCache.size > 2000) this.avatarCache.clear(); }
      if (url) setTimeout(() => this.deps.setAvatar!(memberId, proxied(url)!), 300);
    } catch { /* avatar is optional */ }
  }
}
