import { describe, expect, it } from 'vitest';
import { Nav } from '../src/live/chars/nav.ts';
import { SPAWN, groundY } from '../src/live/layout.ts';

describe('navigation', () => {
  const nav = new Nav();
  const all = [...Object.values(nav.slots).flat(), ...nav.seats.vip, ...nav.seats.lounge];

  it('has room for at least 300 avatars', () => {
    expect(all.length).toBeGreaterThanOrEqual(300);
  });

  it('reaches every slot from the entrance without crossing obstacles or tall steps', () => {
    for (const s of all) {
      const to = s.seat ? Nav.approach(s) : s;
      const p = nav.findPath(SPAWN, to);
      expect(p, `${s.zone} ${s.x},${s.z}`).not.toBeNull();
      for (let i = 1; i < p!.length; i++) {
        const a = p![i - 1], b = p![i];
        const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.1);
        let prevY = groundY(a.x, a.z);
        for (let k = 1; k <= n; k++) {
          const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
          if (i > 1 || k > 3) expect(nav.walkable(x, z), `blocked at ${x.toFixed(2)},${z.toFixed(2)}`).toBe(true);
          const y = groundY(x, z);
          expect(Math.abs(y - prevY)).toBeLessThan(0.31);
          prevY = y;
        }
      }
    }
  });

  it('keeps standing slots at least 0.9 m apart so dancers never intersect', () => {
    const st = Object.values(nav.slots).flat();
    let min = 1e9;
    for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) min = Math.min(min, Math.hypot(st[i].x - st[j].x, st[i].z - st[j].z));
    expect(min).toBeGreaterThanOrEqual(0.9);
  });

  it('reserves each slot only once', () => {
    const n2 = new Nav();
    const ids = new Set<unknown>();
    for (let i = 0; i < 400; i++) { const s = n2.reserve('floor', `u${i}`); if (!s) break; expect(ids.has(s)).toBe(false); ids.add(s); }
    expect(n2.reserve('floor', 'overflow')).toBeNull();
    const one = [...ids][0] as Parameters<Nav['release']>[0];
    n2.release(one);
    expect(n2.reserve('floor', 'again')).toBe(one);
  });
});
