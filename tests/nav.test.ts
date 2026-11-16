import { describe, expect, it } from 'vitest';
import { Nav } from '../src/live/chars/nav.ts';
import { SPAWN, groundY } from '../src/live/layout.ts';

describe('navigation', () => {
  const nav = new Nav();
  const all = [...Object.values(nav.slots).flat(), ...nav.seats.vip, ...nav.seats.lounge];
  const standing = Object.values(nav.slots).flat();

  it('has room for more than 1500 avatars on the ground floor and the balcony', () => {
    expect(nav.capacity).toBeGreaterThan(1500);
    expect(standing.filter((s) => s.level === 1).length).toBeGreaterThan(500);
  });

  it('reaches every place from the entrance (balcony via the stairs) without crossing obstacles or tall steps', () => {
    for (const s of all) {
      const to = s.seat ? Nav.approach(s) : { x: s.x, z: s.z, l: s.level };
      const p = nav.findPath({ x: SPAWN.x, z: SPAWN.z, l: 0 }, to);
      expect(p, `${s.zone} L${s.level} ${s.x.toFixed(2)},${s.z.toFixed(2)}`).not.toBeNull();
      for (let i = 1; i < p!.length; i++) {
        const a = p![i - 1], b = p![i];
        if ((a.l ?? 0) !== (b.l ?? 0)) { expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.01); continue; }   // level change only in place
        const l = b.l ?? 0;
        const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.1);
        let prevY = groundY(a.x, a.z, l);
        for (let k = 1; k <= n; k++) {
          const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
          if (i > 1 || k > 3) expect(nav.walkable(x, z, l), `blocked at L${l} ${x.toFixed(2)},${z.toFixed(2)}`).toBe(true);
          const y = groundY(x, z, l);
          expect(Math.abs(y - prevY)).toBeLessThan(0.31);
          prevY = y;
        }
      }
    }
  });

  it('keeps roomy dance-floor places 0.9 m apart and packed places at least 0.55 m apart', () => {
    let roomy = 1e9, any = 1e9;
    for (let i = 0; i < standing.length; i++) for (let j = i + 1; j < standing.length; j++) {
      const a = standing[i], b = standing[j];
      if (a.level !== b.level) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      any = Math.min(any, d);
      if (!a.compact && !b.compact) roomy = Math.min(roomy, d);
    }
    expect(roomy).toBeGreaterThanOrEqual(0.9);
    expect(any).toBeGreaterThanOrEqual(0.55);
  });

  it('reserves each slot only once', () => {
    const n2 = new Nav();
    const ids = new Set<unknown>();
    for (let i = 0; i < 3000; i++) { const s = n2.reserve('floor', `u${i}`); if (!s) break; expect(ids.has(s)).toBe(false); ids.add(s); }
    expect(n2.reserve('floor', 'overflow')).toBeNull();
    const one = [...ids][0] as Parameters<Nav['release']>[0];
    n2.release(one);
    expect(n2.reserve('floor', 'again')).toBe(one);
  });
});
