import { describe, expect, it } from 'vitest';
import type { ServerMsg, SupportEffect } from '../shared/protocol.ts';
import { ClubState, type ChatEvent } from '../server/core/club.ts';
import { Db } from '../server/db.ts';

function setup() {
  const db = new Db(':memory:');
  const sent: ServerMsg[] = [];
  const c = new ClubState(db, (m) => sent.push(m), () => {}, { now: 0 });
  c.setMode('live');
  let n = 0;
  const msg = (author: string, extra: Partial<ChatEvent>, now: number) => c.handleChat({
    id: `x${++n}`, source: 'tiktok', ts: now, author: { id: author, name: author.replace(/^\w+:/, '') }, kind: 'text', text: '', ...extra,
  }, now);
  const effects = () => sent.filter((m): m is Extract<ServerMsg, { t: 'effect' }> => m.t === 'effect').map((m) => m.effect);
  return { c, db, sent, msg, effects };
}
const gift = (usd: number, amountText: string, tier = 0): Partial<ChatEvent> => ({ kind: 'superchat', usd, amountText, tier });

describe('support policy', () => {
  it('adds up tiny gifts per person and fires one effect for the total', () => {
    const { msg, effects } = setup();
    expect(msg('tt:1', gift(0.4, 'Rose ×30 (30 coins)'), 0)).toBe('support:accumulating');
    expect(msg('tt:1', gift(0.4, 'Rose ×30 (30 coins)'), 10000)).toBe('support:accumulating');
    expect(msg('tt:1', gift(0.4, 'Rose ×30 (30 coins)'), 20000)).toMatch(/^support:queued/);
    expect(effects()).toHaveLength(1);
    expect(effects()[0]).toMatchObject({ tier: 1, amountText: 'Rose ×30 (30 coins) + Rose ×30 (30 coins) + Rose ×30 (30 coins)' });
  });
  it('forgets small amounts that never reach the first tier', () => {
    const { c, msg, effects } = setup();
    msg('tt:2', gift(0.5, 'a'), 0);
    c.tick(130000);
    expect(msg('tt:2', gift(0.6, 'b'), 131000)).toBe('support:accumulating');
    expect(effects()).toHaveLength(0);
  });
  it('gives temporary VIP that expires, while admin grants stay', () => {
    const { c, msg } = setup();
    msg('tt:3', { text: '!join' }, 0);
    msg('tt:3', gift(5, 'Galaxy', 3), 1000);
    expect(c.members.get('tt:3')!.vip).toBe(true);
    msg('tt:3', { text: '!vip' }, 20000);
    expect(c.members.get('tt:3')!.zone).toBe('vip');
    c.tick(1000 + 60 * 60000 + 1);
    expect(c.members.get('tt:3')).toMatchObject({ vip: false, zone: 'floor' });
    c.grantVip('tt:3', true, 3.605e6);
    c.tick(3.61e6);              // (after 60 silent minutes the viewer would auto-leave anyway)
    expect(c.members.get('tt:3')!.vip).toBe(true);
  });
  it('walks supporters in automatically, but never past capacity and never anonymous ones', () => {
    const { c, msg } = setup();
    msg('tt:4', gift(5, 'Galaxy', 3), 0);
    expect(c.members.has('tt:4')).toBe(true);
    msg('kick:anonymous', gift(10, '2× Gift Sub', 4), 0);
    expect(c.members.has('kick:anonymous')).toBe(false);
    c.patchSettings({ maxCharacters: 1 });
    msg('tt:5', gift(5, 'Galaxy', 3), 0);
    expect(c.members.has('tt:5')).toBe(false);
  });
  it('removes links, mentions and profanity from paid messages', () => {
    const { msg, effects } = setup();
    msg('tt:6', { ...gift(5, 'x', 3), text: 'çok iyi @someone bak https://spam.example/x www.a.com' }, 0);
    msg('tt:7', { ...gift(5, 'x', 3), text: 'siktir' }, 0);
    const [a, b] = [effects()[0], null];
    expect(a.comment).toBe('çok iyi bak');
    expect(b).toBeNull();
  });
  it('merges a gift bomb into one combo banner and drains the queue faster', () => {
    const { c, msg, effects } = setup();
    for (let i = 0; i < 10; i++) msg(`tt:b${i}`, gift(5, 'Galaxy', 3), 0);
    const q = (c as unknown as { queue: SupportEffect[] }).queue;
    expect(q.some((e) => e.kind === 'combo')).toBe(true);
    expect(q.length).toBeLessThan(6);
    const combo = q.find((e) => e.kind === 'combo')!;
    expect(1 + combo.others!.length).toBeGreaterThanOrEqual(3);
    c.tick(60000);
    expect(effects().length).toBe(2);
  });
  it('lets the admin skip the running effect or clear the queue', () => {
    const { c, sent, msg } = setup();
    msg('tt:8', gift(5, 'a', 3), 0); msg('tt:9', gift(5, 'b', 3), 0);
    expect(c.queueLength()).toBe(1);
    c.stopEffects(false, 100);
    expect(sent.some((m) => m.t === 'effectStop')).toBe(true);
    expect(c.queueLength()).toBe(0);                 // the waiting one started immediately
    msg('tt:10', gift(5, 'c', 3), 200);
    c.stopEffects(true, 300);
    expect(c.queueLength()).toBe(0);
  });
  it('makes viewers who become channel members mid-stream VIP', () => {
    const { c, msg } = setup();
    msg('tt:11', { text: '!join' }, 0);
    expect(c.members.get('tt:11')!.vip).toBe(false);
    c.handleChat({ id: 'm1', source: 'tiktok', ts: 0, author: { id: 'tt:11', name: 'x', isMember: true }, kind: 'text', text: 'hi' }, 5000);
    expect(c.members.get('tt:11')!.vip).toBe(true);
  });
});
