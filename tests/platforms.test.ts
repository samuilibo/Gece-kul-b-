import { generateKeyPairSync, createSign } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '../shared/protocol.ts';
import { ClubState, type ChatEvent } from '../server/core/club.ts';
import { Db } from '../server/db.ts';
import { tierFromUsd, type PlatformDeps } from '../server/platforms/common.ts';
import { KickConnector, normalizeKick, verifyKickSignature } from '../server/platforms/kick.ts';
import { normalizeTikTok } from '../server/platforms/tiktok.ts';
import { TwitchConnector, normalizeTwitch } from '../server/platforms/twitch.ts';

const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 10)); };
const deps = (events: ChatEvent[], kv = new Map<string, unknown>()): PlatformDeps => ({
  onEvent: (e) => events.push(e), onStatus: () => {}, log: () => {},
  kvGet: <T,>(k: string, f: T) => (kv.has(k) ? kv.get(k) as T : f), kvSet: (k, v) => kv.set(k, v),
});

describe('tier mapping', () => {
  it('maps dollars onto the YouTube tiers', () => {
    expect(tierFromUsd(0.5)).toBe(0);
    expect(tierFromUsd(1)).toBe(1);
    expect(tierFromUsd(4.99)).toBe(2);
    expect(tierFromUsd(5)).toBe(3);
    expect(tierFromUsd(25)).toBe(5);
    expect(tierFromUsd(9999)).toBe(11);
  });
});

describe('Twitch normalisation', () => {
  const chatter = { chatter_user_id: '42', chatter_user_login: 'ece', chatter_user_name: 'Ece', message_id: 'm1' };
  it('maps chat, badges and cheers', () => {
    const c = normalizeTwitch('channel.chat.message', { ...chatter, message: { text: '!katıl' }, badges: [{ set_id: 'subscriber' }] }, 'x')!;
    expect(c).toMatchObject({ id: 'tw:m1', source: 'twitch', kind: 'text', text: '!katıl', author: { id: 'tw:42', name: 'Ece', isMember: true } });
    const b = normalizeTwitch('channel.chat.message', { ...chatter, message: { text: 'Cheer500 !dance harika' }, cheer: { bits: 500 } }, 'x')!;
    expect(b).toMatchObject({ kind: 'superchat', amountText: '500 Bits', tier: 3, text: '!dance harika' });
  });
  it('maps subs and counts community gifts once', () => {
    expect(normalizeTwitch('channel.chat.notification', { ...chatter, notice_type: 'sub', sub: { sub_tier: '2000' } }, 'x')).toMatchObject({ kind: 'member', tier: 4, amountText: 'Tier 2 Sub' });
    expect(normalizeTwitch('channel.chat.notification', { ...chatter, notice_type: 'community_sub_gift', community_sub_gift: { total: 10, sub_tier: '1000' } }, 'x')).toMatchObject({ kind: 'gift', tier: 6, amountText: '10× Tier 1 Gift Subs' });
    expect(normalizeTwitch('channel.chat.notification', { ...chatter, notice_type: 'sub_gift', sub_gift: { community_gift_id: 'c1', sub_tier: '1000' } }, 'x')).toBeNull();
    expect(normalizeTwitch('channel.chat.notification', { ...chatter, notice_type: 'raid' }, 'x')).toBeNull();
  });
});

describe('Kick', () => {
  const sender = { user_id: 7, username: 'deniz', profile_picture: 'https://files.kick.com/a.png', identity: { badges: [{ type: 'moderator' }] } };
  it('normalises webhook payloads', () => {
    expect(normalizeKick('chat.message.sent', { sender, content: '!dans [emote:37226:KEKW]' }, 'K1')).toMatchObject({ id: 'kick:K1', source: 'kick', text: '!dans KEKW', author: { id: 'kick:7', isMod: true } });
    expect(normalizeKick('kicks.gifted', { sender, gift: { amount: 500, name: 'Rage Quit', message: 'gg' } }, 'K2')).toMatchObject({ kind: 'superchat', tier: 3, amountText: '500 KICKs · Rage Quit', text: 'gg' });
    expect(normalizeKick('channel.subscription.gifts', { gifter: { is_anonymous: true }, giftees: [{}, {}, {}] }, 'K3')).toMatchObject({ kind: 'gift', author: { id: 'kick:anonymous' }, amountText: '3× Gift Sub', tier: 4 });
    expect(normalizeKick('livestream.status.updated', { is_live: false }, 'K4')).toBe('ended');
  });

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const sign = (s: string) => { const g = createSign('RSA-SHA256'); g.update(s); return g.sign(privateKey, 'base64'); };

  it('verifies RSA signatures over id.timestamp.body', () => {
    const body = '{"a":1}', sig = sign(`ID.TS.${body}`);
    expect(verifyKickSignature(pem, 'ID', 'TS', body, sig)).toBe(true);
    expect(verifyKickSignature(pem, 'ID', 'TS', '{"a":2}', sig)).toBe(false);
    expect(verifyKickSignature('garbage', 'ID', 'TS', body, sig)).toBe(false);
  });

  it('subscribes with an app token and only accepts signed, fresh webhooks', async () => {
    const calls: { url: string; body?: string }[] = [];
    const f = (async (u: string | URL, init?: RequestInit) => {
      const url = String(u); calls.push({ url, body: init?.body ? String(init.body) : undefined });
      const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
      if (url.includes('oauth/token')) return json({ access_token: 'APP', expires_in: 3600 });
      if (url.endsWith('/public-key')) return json({ data: { public_key: pem } });
      if (url.includes('channels?slug=')) return json({ data: [{ broadcaster_user_id: 99 }] });
      if (url.endsWith('events/subscriptions') && !init?.method) return json({ data: [] });
      return json({ data: [] });
    }) as typeof fetch;
    const events: ChatEvent[] = [];
    const k = new KickConnector({ clientId: 'id', clientSecret: 'sec', webhookPort: 0, webhookHost: '127.0.0.1' }, deps(events), f);
    expect(await k.connect('https://kick.com/MyChannel')).toBe(true);
    expect(k.status).toMatchObject({ state: 'waiting', channel: 'mychannel' });
    const post = calls.find((c) => c.url.endsWith('events/subscriptions') && c.body)!;
    expect(JSON.parse(post.body!)).toMatchObject({ broadcaster_user_id: 99, method: 'webhook' });
    const body = JSON.stringify({ broadcaster: { user_id: 99 }, sender, content: '!join' });
    const ts = new Date().toISOString();
    const h = (id: string, s: string) => ({ 'kick-event-message-id': id, 'kick-event-message-timestamp': ts, 'kick-event-signature': s, 'kick-event-type': 'chat.message.sent' });
    expect(await k.onWebhook(h('M1', sign(`M1.${ts}.${body}`.replace('M1', 'XX'))), body)).toBe(401);
    expect(events).toHaveLength(0);
    expect(await k.onWebhook(h('M1', sign(`M1.${ts}.${body}`)), body)).toBe(200);
    expect(events[0]).toMatchObject({ id: 'kick:M1', text: '!join' });
    expect(k.status.state).toBe('connected');
    const other = JSON.stringify({ broadcaster: { user_id: 5 }, sender, content: 'x' });
    await k.onWebhook(h('M2', sign(`M2.${ts}.${other}`)), other);
    expect(events).toHaveLength(1);                           // another channel's event is ignored
    k.stop();
  });
});

describe('TikTok normalisation', () => {
  const user = { userId: '123', uniqueId: 'neon_fan', nickname: 'Neon Fan', profilePicture: { url: ['https://p16-sign.tiktokcdn.com/a.jpg'] } };
  it('counts a gift streak once, at the end', () => {
    expect(normalizeTikTok('gift', { user, giftId: 5655, repeatCount: 3, repeatEnd: 0, gift: { type: 1, diamondCount: 1, name: 'Rose' } }, '1')).toBeNull();
    const end = normalizeTikTok('gift', { user, giftId: 5655, repeatCount: 5, repeatEnd: 1, gift: { type: 1, diamondCount: 1, name: 'Rose' } }, '2')!;
    expect(end).toMatchObject({ kind: 'superchat', amountText: 'Rose ×5 (5 coins)', tier: 0, author: { id: 'tt:123', name: 'Neon Fan' } });
    expect(normalizeTikTok('gift', { user, repeatCount: 1, gift: { type: 2, diamondCount: 500, name: 'Galaxy' } }, '3')!.tier).toBe(3);
    expect(normalizeTikTok('chat', { user, content: '!katıl' }, '4')).toMatchObject({ kind: 'text', text: '!katıl', source: 'tiktok' });
  });
});

describe('club with several platforms', () => {
  function club() {
    const db = new Db(':memory:');
    const sent: ServerMsg[] = [];
    const c = new ClubState(db, (m) => sent.push(m), () => {}, { now: 0 });
    return { c, sent };
  }
  const ev = (id: string, source: ChatEvent['source'], author: string, text: string, extra: Partial<ChatEvent> = {}): ChatEvent =>
    ({ id, source, ts: 0, author: { id: author, name: author }, kind: 'text', text, ...extra });
  it('accepts every real platform only in live mode, dedupes, and keeps identities apart', () => {
    const { c } = club();
    expect(c.handleChat(ev('tw:1', 'twitch', 'tw:5', '!join'), 0)).toBe('rejected:not-live');
    c.setMode('live');
    expect(c.handleChat(ev('tw:2', 'twitch', 'tw:5', '!join'), 0)).toBe('joined');
    expect(c.handleChat(ev('kick:1', 'kick', 'kick:5', '!katıl'), 0)).toBe('joined');
    expect(c.handleChat(ev('tt:1', 'tiktok', 'tt:5', '!join'), 0)).toBe('joined');
    expect(c.handleChat(ev('tw:2', 'twitch', 'tw:5', '!dance'), 9000)).toBe('duplicate');
    expect(c.members.size).toBe(3);
    expect(c.handleChat(ev('d1', 'demo', 'demo:1', '!join'), 0)).toBe('rejected:demo-off');
  });
  it('gives small gifts no effect and respects the supporter-VIP switch', () => {
    const { c, sent } = club();
    c.setMode('live');
    c.handleChat(ev('tt:j', 'tiktok', 'tt:9', '!join'), 0);
    expect(c.handleChat(ev('tt:g1', 'tiktok', 'tt:9', '', { kind: 'superchat', amountText: 'Rose ×1', tier: 0 }), 1000)).toBe('support:below-min');
    expect(c.members.get('tt:9')!.vip).toBe(false);
    c.patchSettings({ supporterVipMinutes: 0 });
    c.handleChat(ev('tt:g2', 'tiktok', 'tt:9', '', { kind: 'superchat', amountText: 'Galaxy ×1', tier: 3 }), 2000);
    expect(c.members.get('tt:9')!.vip).toBe(false);
    expect(sent.filter((m) => m.t === 'effect')).toHaveLength(1);
  });
});

describe('Twitch EventSub WebSocket (local mock server)', () => {
  it('subscribes after welcome, delivers events and follows session_reconnect', async () => {
    const a = new WebSocketServer({ port: 0 }), b = new WebSocketServer({ port: 0 });
    const portA = (a.address() as { port: number }).port, portB = (b.address() as { port: number }).port;
    const subs: string[] = [];
    const f = (async (u: string | URL, init?: RequestInit) => {
      const url = String(u);
      const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s });
      if (url.includes('helix/users')) return json({ data: [{ id: '777', profile_image_url: 'https://static-cdn.jtvnw.net/x.png' }] });
      if (url.includes('helix/eventsub/subscriptions')) { subs.push(JSON.parse(String(init!.body)).type); return json({ data: [{}] }, 202); }
      return json({});
    }) as typeof fetch;
    const events: ChatEvent[] = [];
    const kv = new Map<string, unknown>([['twitch:tokens', { access: 'AT', refresh: 'RT', expiresAt: Date.now() + 3600e3, login: 'me', userId: '1' }]]);
    const tw = new TwitchConnector('cid', deps(events, kv), f, `ws://127.0.0.1:${portA}`);
    let socketA: import('ws').WebSocket | null = null;
    a.on('connection', (s) => { socketA = s; s.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'S1', keepalive_timeout_seconds: 10 } } })); });
    b.on('connection', (s) => {
      s.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'S2', keepalive_timeout_seconds: 10 } } }));
      setTimeout(() => s.send(JSON.stringify({ metadata: { message_type: 'notification', message_id: 'n2', subscription_type: 'channel.chat.message' }, payload: { event: { chatter_user_id: '9', chatter_user_name: 'B', message_id: 'c2', message: { text: 'after reconnect' } } } })), 50);
    });
    expect(await tw.connect('SomeChannel')).toBe(true);
    await until(() => tw.status.state === 'connected');
    expect(subs).toEqual(['channel.chat.message', 'channel.chat.notification']);
    socketA!.send(JSON.stringify({ metadata: { message_type: 'notification', message_id: 'n1', subscription_type: 'channel.chat.message' }, payload: { event: { chatter_user_id: '9', chatter_user_name: 'B', message_id: 'c1', message: { text: '!join' } } } }));
    await until(() => events.length === 1);
    socketA!.send(JSON.stringify({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: `ws://127.0.0.1:${portB}` } } }));
    await until(() => events.length === 2);
    expect(events.map((e) => e.id)).toEqual(['tw:c1', 'tw:c2']);
    expect(subs).toHaveLength(2);                      // no re-subscription after session_reconnect
    await until(() => socketA!.readyState === 3);
    expect(socketA!.readyState).toBe(3);               // old socket closed once the new one welcomed us
    tw.disconnect(); a.close(); b.close();
  });
});
