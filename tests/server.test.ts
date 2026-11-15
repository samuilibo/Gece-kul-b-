import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '../shared/protocol.ts';
import { ClubState, type ChatEvent } from '../server/core/club.ts';
import { parseCommand } from '../server/core/commands.ts';
import { Moderation } from '../server/core/moderation.ts';
import { Db } from '../server/db.ts';
import { YouTubeConnector, backoffMs } from '../server/youtube/connector.ts';
import { extractVideoId, normalizeItem } from '../server/youtube/normalize.ts';

function makeClub(mode: 'live' | 'demo' = 'live') {
  const db = new Db(':memory:');
  const sent: ServerMsg[] = [];
  const club = new ClubState(db, (m) => sent.push(m), () => {}, { now: 0 });
  club.setMode(mode);
  let n = 0;
  const say = (user: string, text: string, now: number, extra: Partial<ChatEvent> = {}) => club.handleChat({
    id: `m${++n}`, source: mode === 'live' ? 'youtube' : 'demo', ts: now, author: { id: `UC_${user}`, name: user }, kind: 'text', text, ...extra,
  }, now);
  return { club, sent, say, db };
}

describe('command parser', () => {
  it('understands Turkish and English aliases', () => {
    expect(parseCommand('!katıl')?.cmd).toBe('join');
    expect(parseCommand('!KATIL')?.cmd).toBe('join');
    expect(parseCommand('!join')?.cmd).toBe('join');
    expect(parseCommand('!zıpla')?.cmd).toBe('jump');
    expect(parseCommand('!kıyafet')?.cmd).toBe('outfit');
    expect(parseCommand('!çık')?.cmd).toBe('leave');
    expect(parseCommand('!müzik techno')).toMatchObject({ cmd: 'song', arg: 'techno' });
    expect(parseCommand('!duo @Ece')).toMatchObject({ cmd: 'duo', arg: '@Ece' });
  });
  it('ignores normal chat and unknown commands', () => {
    expect(parseCommand('merhaba')).toBeNull();
    expect(parseCommand('!nope')).toBeNull();
    expect(parseCommand('!')).toBeNull();
  });
});

describe('moderation', () => {
  const mod = new Moderation();
  it('masks inappropriate display names', () => {
    expect(mod.cleanName('Deniz', 'UC1')).toBe('Deniz');
    expect(mod.cleanName('f.u.c.k you', 'UC1')).toMatch(/^Misafir\d{4}$/);
    expect(mod.cleanName('buy at spam.com', 'UC1')).toMatch(/^Misafir/);
    expect(mod.cleanName('', 'UC1')).toMatch(/^Misafir/);
  });
  it('does not flag innocent words containing short bad substrings', () => {
    expect(mod.isProfane('Dickens fan')).toBe(false);
    expect(mod.isProfane('s1kt1r git')).toBe(true);
  });
  it('rate limits floods and repeats', () => {
    expect(mod.spamCheck('u', '!dance', 0)).toBeNull();
    expect(mod.spamCheck('u', '!dance', 500)).toBe('repeat');
    let r: string | null = null;
    for (let i = 0; i < 8; i++) r = mod.spamCheck('u', `!cmd${i}`, 3000 + i * 100);
    expect(r).toBe('flood');
    expect(mod.spamCheck('u', '!x', 10000)).toBe('muted');
  });
});

describe('club state', () => {
  it('creates exactly one character per channel id', () => {
    const { club, say, sent } = makeClub();
    expect(say('ece', '!join', 1000)).toBe('joined');
    expect(say('ece', '!katıl', 9000)).toBe('already-in');
    expect(club.members.size).toBe(1);
    expect(sent.filter((m) => m.t === 'join')).toHaveLength(1);
  });
  it('keys identity on channel id, not on the display name', () => {
    const { club } = makeClub();
    club.handleChat({ id: 'a', source: 'youtube', ts: 1, author: { id: 'UC_same', name: 'OldName' }, kind: 'text', text: '!join' }, 1000);
    const r = club.handleChat({ id: 'b', source: 'youtube', ts: 2, author: { id: 'UC_same', name: 'NewName' }, kind: 'text', text: '!join' }, 9000);
    expect(r).toBe('already-in');
    expect(club.members.size).toBe(1);
  });
  it('deduplicates by message id', () => {
    const { club } = makeClub();
    const ev: ChatEvent = { id: 'dup', source: 'youtube', ts: 1, author: { id: 'UC_x', name: 'x' }, kind: 'text', text: '!join' };
    expect(club.handleChat(ev, 1000)).toBe('joined');
    club.remove('UC_x', 'left');
    expect(club.handleChat(ev, 9000)).toBe('duplicate');
    expect(club.members.size).toBe(0);
  });
  it('applies per-user cooldowns and command toggles', () => {
    const { club, say } = makeClub();
    say('a', '!join', 0);
    expect(say('a', '!dance', 10000)).toBe('dance');
    expect(say('a', '!dans hiphop', 11000)).toBe('cooldown');
    expect(say('a', '!dance', 20000)).toBe('dance');
    club.patchSettings({ commands: { ...club.settings.commands, robot: { on: false, cooldown: 1 } } });
    expect(say('a', '!robot', 30000)).toBe('disabled');
  });
  it('requires joining before other commands and enforces capacity', () => {
    const { club, say } = makeClub();
    expect(say('a', '!dance', 0)).toBe('not-joined');
    club.patchSettings({ maxCharacters: 1 });
    expect(say('a', '!join', 5000)).toBe('joined');
    expect(say('b', '!join', 5000)).toBe('full');
  });
  it('gates VIP and limits the stage', () => {
    const { club, say } = makeClub();
    say('a', '!join', 0);
    expect(say('a', '!vip', 5000)).toBe('vip-denied');
    club.grantVip('UC_a', true);
    expect(say('a', '!vip', 20000)).toBe('vip');
    expect(club.members.get('UC_a')!.zone).toBe('vip');
    for (const u of ['b', 'c', 'd', 'e', 'f']) say(u, '!join', 0);
    const results = ['b', 'c', 'd', 'e', 'f'].map((u) => say(u, '!sahne', 30000));
    expect(results.filter((r) => r === 'stage')).toHaveLength(4);
    expect(results[4]).toBe('stage-full');
    club.tick(30000 + 46000);
    expect([...club.members.values()].filter((m) => m.zone === 'stage')).toHaveLength(0);
  });
  it('never replays effects for historical or duplicate super chats and queues overlaps', () => {
    const { club, say, sent } = makeClub();
    say('a', '!join', 0);
    const sc = (id: string, now: number, historical = false) => club.handleChat({
      id, source: 'youtube', ts: now, historical, author: { id: 'UC_a', name: 'a' }, kind: 'superchat', text: 'gg', amountText: '₺50,00', tier: 3,
    }, now);
    expect(sc('old', 1000, true)).toBe('historical');
    expect(sent.filter((m) => m.t === 'effect')).toHaveLength(0);
    sc('s1', 2000); sc('s2', 2100); sc('s1', 2200);
    expect(sent.filter((m) => m.t === 'effect')).toHaveLength(1);       // second is queued, duplicate dropped
    const first = sent.find((m) => m.t === 'effect') as Extract<ServerMsg, { t: 'effect' }>;
    expect(first.effect.amountText).toBe('₺50,00');
    club.tick(2000 + first.effect.durationMs + 700);
    expect(sent.filter((m) => m.t === 'effect')).toHaveLength(2);
    expect(club.members.get('UC_a')!.vip).toBe(true);
  });
  it('keeps demo and real traffic strictly apart', () => {
    const live = makeClub('live');
    expect(live.club.handleChat({ id: 'd1', source: 'demo', ts: 0, author: { id: 'demo:1', name: 'bot' }, kind: 'text', text: '!join' }, 0)).toBe('rejected:demo-off');
    expect(live.club.handleChat({ id: 'd2', source: 'demo', ts: 0, author: { id: 'demo:1', name: 'bot' }, kind: 'superchat', text: '', amountText: '$5', tier: 5 }, 0)).toBe('rejected:demo-off');
    const demo = makeClub('demo');
    demo.say('bot', '!join', 0);
    expect(demo.club.members.size).toBe(1);
    demo.club.setMode('live');
    expect(demo.club.members.size).toBe(0);
    expect(demo.club.handleChat({ id: 'y1', source: 'youtube', ts: 0, author: { id: 'UC_r', name: 'real' }, kind: 'text', text: '!join' }, 5000)).toBe('joined');
  });
  it('runs a music vote with one vote per viewer', () => {
    const { club, say, sent } = makeClub();
    expect(say('a', '!müzik techno', 0)).toBe('vote:techno');
    expect(say('a', '!song disco', 30000)).toBe('already-voted');
    say('b', '!song techno', 1000); say('c', '!song disco', 1000);
    club.tick(46000);
    expect(sent.some((m) => m.t === 'music' && m.cmd === 'genre' && m.arg === 'techno')).toBe(true);
  });
  it('pairs a duo after accept and blocks users', () => {
    const { club, say, sent } = makeClub();
    say('ece', '!join', 0); say('mert', '!join', 0);
    expect(say('ece', '!duo mer', 5000)).toBe('duo-invited');
    expect(say('mert', '!accept', 6000)).toBe('duo');
    expect(sent.some((m) => m.t === 'duo')).toBe(true);
    club.block('UC_mert');
    expect(club.members.has('UC_mert')).toBe(false);
    expect(say('mert', '!join', 60000)).toBe('blocked');
  });
  it('emergency stop silences everything', () => {
    const { club, say } = makeClub();
    club.setEmergency(true);
    expect(say('a', '!join', 0)).toBe('emergency-stop');
  });
});

describe('youtube helpers', () => {
  it('extracts video ids', () => {
    for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'https://youtu.be/dQw4w9WgXcQ?si=x', 'youtube.com/live/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://studio.youtube.com/video/dQw4w9WgXcQ/livestreaming', 'dQw4w9WgXcQ']) {
      expect(extractVideoId(u)).toBe('dQw4w9WgXcQ');
    }
    expect(extractVideoId('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(extractVideoId('nonsense')).toBeNull();
  });
  it('normalises REST and gRPC shaped items', () => {
    const base = { id: 'x1', authorDetails: { channelId: 'UC1', displayName: 'A', isChatSponsor: true } };
    const sc = normalizeItem({ ...base, snippet: { type: 'superChatEvent', publishedAt: '2030-01-01T00:00:00Z', superChatDetails: { amountDisplayString: '₺50,00', tier: 4, userComment: 'yo' } } }, 0);
    expect(sc).toMatchObject({ kind: 'superchat', amountText: '₺50,00', tier: 4, text: 'yo', historical: false });
    const g = normalizeItem({ ...base, snippet: { type: 'SUPER_STICKER_EVENT', publishedAt: '2020-01-01T00:00:00Z', superStickerDetails: { amountDisplayString: '$2.00', tier: 1 } } }, Date.parse('2021-01-01'));
    expect(g).toMatchObject({ kind: 'sticker', historical: true });
    expect(normalizeItem({ ...base, snippet: { type: 'chatEndedEvent' } }, 0)).toBe('ended');
    expect(normalizeItem({ ...base, snippet: { type: 'messageDeletedEvent' } }, 0)).toBeNull();
  });
  it('backs off exponentially with a cap', () => {
    expect(backoffMs(0, 0)).toBe(500);
    expect(backoffMs(3, 1)).toBe(8000);
    expect(backoffMs(20, 1)).toBe(60000);
  });
});

describe('youtube connector (mocked API)', () => {
  function harness(script: ((url: URL) => { status?: number; body: unknown } | Error)[], stored?: string) {
    const calls: URL[] = [];
    const events: ChatEvent[] = [];
    const sleeps: number[] = [];
    let saved = stored;
    let i = 0;
    const conn = new YouTubeConnector({ apiKey: 'TESTKEY', useGrpc: false }, {
      fetch: (async (input: string | URL) => {
        const url = new URL(String(input));
        calls.push(url);
        const step = script[Math.min(i++, script.length - 1)](url);
        if (step instanceof Error) throw step;
        return new Response(JSON.stringify(step.body), { status: step.status ?? 200 });
      }) as typeof fetch,
      now: () => Date.parse('2030-01-01T00:00:10Z'),
      sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setImmediate(r)); },
      minPollMs: () => 3000,
      loadToken: () => saved,
      saveToken: (_c, t) => { saved = t; },
      onEvent: (e) => events.push(e),
      onStatus: () => {},
      log: () => {},
    });
    return { conn, calls, events, sleeps, token: () => saved };
  }
  const video = () => ({ body: { items: [{ snippet: { title: 'T' }, liveStreamingDetails: { activeLiveChatId: 'CHAT', concurrentViewers: '12' } }] } });
  const msg = (id: string, at: string, text = '!join') => ({ id, snippet: { type: 'textMessageEvent', publishedAt: at, textMessageDetails: { messageText: text } }, authorDetails: { channelId: `UC${id}`, displayName: id } });
  const until = async (cond: () => boolean) => { for (let k = 0; k < 500 && !cond(); k++) await new Promise((r) => setImmediate(r)); };

  it('resolves activeLiveChatId, honours pollingIntervalMillis and resumes with nextPageToken', async () => {
    const h = harness([
      video,
      () => ({ body: { items: [msg('old', '2030-01-01T00:00:00Z'), msg('new', '2030-01-01T00:00:09Z')], nextPageToken: 'P1', pollingIntervalMillis: 7000 } }),
      (u) => ({ body: { items: [msg('n2', '2030-01-01T00:00:11Z')], nextPageToken: 'P2', pollingIntervalMillis: 1000, _token: u.searchParams.get('pageToken') } }),
      () => ({ status: 403, body: { error: { message: 'ended', errors: [{ reason: 'liveChatEnded' }] } } }),
    ]);
    expect(await h.conn.connect('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    await until(() => h.conn.status.state === 'ended');
    expect(h.calls[0].pathname).toMatch(/videos$/);
    expect(h.calls[1].searchParams.get('liveChatId')).toBe('CHAT');
    expect(h.calls[1].searchParams.get('part')).toBe('id,snippet,authorDetails');
    expect(h.calls[2].searchParams.get('pageToken')).toBe('P1');
    expect(h.sleeps.slice(0, 2)).toEqual([7000, 3000]);              // server interval, then the configured minimum
    expect(h.events.map((e) => [e.id, !!e.historical])).toEqual([['old', true], ['new', false], ['n2', false]]);
    expect(h.token()).toBe('P2');
    expect(h.conn.status.viewers).toBe(12);
    expect(h.conn.status.quotaUsed).toBe(1 + 5 * 3);
  });
  it('reconnects with exponential backoff after network errors, keeping its position', async () => {
    const h = harness([
      video,
      () => ({ body: { items: [], nextPageToken: 'P1', pollingIntervalMillis: 3000 } }),
      () => new Error('socket hang up'),
      () => ({ status: 500, body: {} }),
      (u) => ({ body: { items: [msg('after', '2030-01-01T00:00:12Z')], nextPageToken: 'P2', _t: u.searchParams.get('pageToken') } }),
      () => ({ status: 403, body: { error: { errors: [{ reason: 'liveChatDisabled' }] } } }),
    ]);
    await h.conn.connect('dQw4w9WgXcQ');
    await until(() => h.conn.status.state === 'chat_disabled');
    expect(h.calls[4].searchParams.get('pageToken')).toBe('P1');
    expect(h.sleeps[1]).toBeGreaterThanOrEqual(500); expect(h.sleeps[1]).toBeLessThanOrEqual(1000);
    expect(h.sleeps[2]).toBeGreaterThanOrEqual(1000); expect(h.sleeps[2]).toBeLessThanOrEqual(2000);
    expect(h.events.map((e) => e.id)).toEqual(['after']);
  });
  it('reports quota exhaustion, missing chat and ended streams', async () => {
    const q = harness([video, () => ({ status: 403, body: { error: { errors: [{ reason: 'quotaExceeded' }] } } })]);
    await q.conn.connect('dQw4w9WgXcQ');
    await until(() => q.conn.status.state === 'quota');
    expect(q.conn.status.state).toBe('quota');
    q.conn.disconnect();
    const none = harness([() => ({ body: { items: [{ snippet: { title: 'T' }, liveStreamingDetails: { actualEndTime: '2020' } }] } })]);
    expect(await none.conn.connect('dQw4w9WgXcQ')).toBe(false);
    expect(none.conn.status.state).toBe('ended');
    const off = harness([() => ({ body: { items: [{ snippet: { title: 'T' }, liveStreamingDetails: {} }] } })]);
    await off.conn.connect('dQw4w9WgXcQ');
    expect(off.conn.status.state).toBe('chat_disabled');
    const bad = harness([video]);
    expect(await bad.conn.connect('not a url')).toBe(false);
    expect(bad.conn.status.detail).toBe('invalid-url');
  });
  it('uses a stored page token so restarts do not replay history', async () => {
    const h = harness([video, (u) => ({ body: { items: [msg('x', '2030-01-01T00:00:01Z')], nextPageToken: 'P9', _t: u.searchParams.get('pageToken') } }),
      () => ({ status: 403, body: { error: { errors: [{ reason: 'liveChatEnded' }] } } })], 'SAVED');
    await h.conn.connect('dQw4w9WgXcQ');
    await until(() => h.conn.status.state === 'ended');
    expect(h.calls[1].searchParams.get('pageToken')).toBe('SAVED');
    expect(h.events[0].historical).toBe(false);
  });
});
