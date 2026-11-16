import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '../shared/protocol.ts';
import { ClubState, type ChatEvent } from '../server/core/club.ts';
import { Db } from '../server/db.ts';

function setup(max = 2) {
  const sent: ServerMsg[] = [];
  const c = new ClubState(new Db(':memory:'), (m) => sent.push(m), () => {}, { now: 0 });
  c.setMode('live');
  c.patchSettings({ maxCharacters: max });
  let n = 0;
  const say = (u: string, text: string, now: number, extra: Partial<ChatEvent> = {}) => c.handleChat({ id: `q${++n}`, source: 'twitch', ts: now, author: { id: `tw:${u}`, name: u }, kind: 'text', text, ...extra }, now);
  const pay = (u: string, usd: number, text: string, now: number) => say(u, '', now, { kind: 'superchat', usd, amountText: text, tier: Math.max(0, Math.floor(Math.log2(usd + 1))) });
  const order = () => c.queueInfo().top.map((t) => t.name);
  return { c, sent, say, pay, order };
}

describe('door queue', () => {
  it('queues !join when the club is full and lets people in first-come first-served', () => {
    const { c, say, order } = setup(2);
    expect(say('a', '!join', 0)).toBe('joined');
    expect(say('b', '!join', 0)).toBe('joined');
    expect(say('c', '!join', 100)).toBe('queued:#1');
    expect(say('d', '!katıl', 200)).toBe('queued:#2');
    expect(say('c', '!join', 9000)).toBe('queued:#1');            // asking again keeps the place
    expect(order()).toEqual(['c', 'd']);
    say('a', '!leave', 10000);
    c.tick(10000);
    expect(c.members.has('tw:c')).toBe(true);
    expect(order()).toEqual(['d']);
  });

  it('puts supporters in front, ordered by the amount (sums several donations)', () => {
    const { c, say, pay, order } = setup(1);
    say('a', '!join', 0);
    say('f1', '!join', 100); say('f2', '!join', 200); say('f3', '!join', 300);
    pay('f3', 5, '500 Bits', 1000);
    pay('p1', 20, '2000 Bits', 1100);                         // not queued yet: donating while full queues them
    pay('f2', 5, '500 Bits', 1200);
    expect(order()).toEqual(['p1', 'f3', 'f2', 'f1']);           // 20 > 5 = 5 (earlier first) > free
    pay('f2', 30, '3000 Bits', 1300);
    expect(order()).toEqual(['f2', 'p1', 'f3', 'f1']);           // 35 in total now
    expect(c.queueInfo()).toMatchObject({ size: 4, priority: 3 });
    expect(c.queueInfo().top[0]).toMatchObject({ priority: true, amountText: '3000 Bits +1' });
    c.patchSettings({ maxCharacters: 3 });
    c.tick(2000);
    expect(['tw:f2', 'tw:p1'].every((id) => c.members.has(id))).toBe(true);
    expect(c.members.has('tw:f1')).toBe(false);
  });

  it('can reserve every Nth place for free viewers', () => {
    const { c, say, pay } = setup(1);
    say('a', '!join', 0);
    say('free', '!join', 100);
    for (const p of ['p1', 'p2', 'p3']) pay(p, 10, '1000 Bits', 200);
    c.patchSettings({ queueFreeEvery: 2, maxCharacters: 4 });
    c.tick(1000);
    expect(c.members.has('tw:free')).toBe(true);                 // admitted after two priority entries
    expect(c.queueInfo().size).toBe(1);
  });

  it('answers !queue, lets people leave the queue and announces changes', () => {
    const { c, say, sent } = setup(1);
    say('a', '!join', 0); say('b', '!join', 0);
    expect(say('b', '!sıra', 20000)).toBe('queue-position:#1');
    expect(sent.some((m) => m.t === 'queueNotice' && m.kind === 'position' && m.position === 1)).toBe(true);
    expect(say('b', '!dance', 30000)).toBe('queued-wait');
    expect(say('b', '!çık', 40000)).toBe('left-queue');
    c.tick(41000);
    expect(c.queueInfo().size).toBe(0);
    expect(sent.some((m) => m.t === 'queue')).toBe(true);
  });

  it('turns priority off when the setting is off', () => {
    const { c, say, pay, order } = setup(1);
    say('a', '!join', 0); say('f', '!join', 100);
    c.patchSettings({ queuePaidPriority: false });
    pay('p', 50, '5000 Bits', 200);
    expect(order()).toEqual(['f', 'p']);
  });
});
