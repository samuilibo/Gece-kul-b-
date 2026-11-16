import {
  BAL_AREAS, BAL_LANDING, BAL_STAIR, BAL_TABLES, BALCONY, COLUMNS, DJ, FLOOR, LOUNGE, LOUNGE_SEATS, ROOM, SOFAS, SPAWN, STAGE, STAGE_SLOTS, TABLES, VIP, VIP_SEATS,
  groundY, type Seat,
} from '../layout.ts';
import { rng } from '../engine.ts';
import type { Zone } from '../../../shared/protocol.ts';

/** A point on a walkable level (l: 0 = ground floor, 1 = balcony). */
export interface P2 { x: number; z: number; l?: number }
export interface Slot extends Seat {
  taken: string | null; zone: Zone; seat: boolean;
  level: number;
  compact: boolean;          // densely packed place: only dances that stay within the body's footprint
}

const CELL = 0.4;
const OX = -18.4, OZ = -14.4;
const NX = Math.ceil(36.8 / CELL), NZ = Math.ceil(31.6 / CELL);
const N = NX * NZ;
const STEP_H = 0.3;
const DENSE = 0.58;          // spacing of the overflow crowd (≈ 3 people per m², a packed club)

const inRect = (x: number, z: number, r: { x0: number; x1: number; z0: number; z1: number }, m = 0) => x >= r.x0 + m && x <= r.x1 - m && z >= r.z0 + m && z <= r.z1 - m;

/**
 * Two-level grid navigation (ground floor + balcony, connected by the balcony stairs) with A*,
 * and reservation of standing places / seats. Cell index = level * N + iz * NX + ix.
 */
export class Nav {
  blocked = new Uint8Array(2 * N);
  height = new Float32Array(2 * N);
  occ = new Uint8Array(2 * N);
  private noSlot = new Uint8Array(N);
  slots: Record<Zone, Slot[]> = { floor: [], vip: [], stage: [], lounge: [] };
  seats: Record<'vip' | 'lounge', Slot[]> = { vip: [], lounge: [] };
  private g = new Float64Array(2 * N);
  private from = new Int32Array(2 * N);
  private mark = new Uint32Array(2 * N);
  private stamp = 0;

  constructor() {
    const rect = (x0: number, x1: number, z0: number, z1: number, level = 0, arr = this.blocked) => {
      for (let iz = Math.max(0, this.iz(z0)); iz <= Math.min(NZ - 1, this.iz(z1)); iz++)
        for (let ix = Math.max(0, this.ix(x0)); ix <= Math.min(NX - 1, this.ix(x1)); ix++) arr[level * N + iz * NX + ix] = 1;
    };
    for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
      const x = OX + (ix + 0.5) * CELL, z = OZ + (iz + 0.5) * CELL, i = iz * NX + ix;
      const inside = Math.abs(x) < ROOM.hx - 0.35 && z > -ROOM.hz + 0.35 && z < ROOM.hz - 0.3;
      const door = Math.abs(x) < 1.2 && z >= ROOM.hz - 0.3 && z < ROOM.hz + 2.9;
      this.blocked[i] = inside || door ? 0 : 1;
      this.height[i] = groundY(x, z, 0);
      // balcony level: the three balcony wings (keeping clear of walls and the glass rail) + the stair landing
      // wings without gaps at the corners; 0.3 m clear of the walls and of the inner glass rail
      const ax = Math.abs(x), lim = ROOM.hx - 0.3, back = ROOM.hz - 0.3, rail = 0.3;
      const onBal = (ax >= 13 + rail && ax <= lim && Math.abs(z) <= back) || (z >= 9 + rail && z <= back && ax <= lim) || inRect(x, z, { ...BAL_LANDING, z1: BAL_LANDING.z1 + 0.7 });
      this.blocked[N + i] = onBal ? 0 : 1;
      this.height[N + i] = BALCONY.y;
    }
    for (const [x, z] of COLUMNS) rect(x - 0.45, x + 0.45, z - 0.45, z + 0.45);
    for (const s of SOFAS) {
      const along = Math.abs(Math.cos(s.yaw)) > 0.5;
      const hx = (along ? s.len / 2 + 0.3 : 0.6), hz = (along ? 0.6 : s.len / 2 + 0.3);
      rect(s.x - hx, s.x + hx, s.z - hz, s.z + hz);
    }
    for (const [x, z] of TABLES) rect(x - 0.5, x + 0.5, z - 0.5, z + 0.5);
    rect(-18, -14.0, 5.6, 13.2);                                   // bar + stools
    rect(DJ.x - 2.1, DJ.x + 2.1, DJ.z + 0.15, DJ.z + 1.4);         // DJ booth
    rect(DJ.x - 0.5, DJ.x + 0.5, DJ.z - 0.5, DJ.z + 0.3);          // the DJ
    for (const sx of [-1, 1]) {
      rect(sx * 7.1 - 0.9, sx * 7.1 + 0.9, -13.7, -12.1);          // stage speaker stacks
      rect(sx * 10.4 - 0.85, sx * 10.4 + 0.85, -9.7, -8.3);        // floor subs
      rect(sx * 1.55 - 0.2, sx * 1.55 + 0.2, 5.5, 13.2);           // carpet ropes
    }
    rect(VIP.x0, VIP.x0 + 0.45, VIP.z0, VIP.z1);                   // VIP rope
    for (const [x, z] of BAL_TABLES) rect(x - 0.5, x + 0.5, z - 0.5, z + 0.5, 1);
    // glass side panel of the balcony stairs / landing: the row of cells straddling it is not walkable,
    // so the stairs can only be entered from the bottom step
    rect(BAL_STAIR.x0 - 1.5, BAL_STAIR.x1, BAL_STAIR.z0 + 0.01, BAL_STAIR.z0 + 0.02);
    // aisles: kept free of standing places so that people can always get through a full club
    const aisle = (x0: number, x1: number, z0: number, z1: number) => rect(x0, x1, z0, z1, 0, this.noSlot);
    aisle(-1.7, 1.7, 3.4, 15);                                     // entrance -> floor
    aisle(-11.5, 11.5, 3.5, 4.3);                                  // cross aisle in front of the floor
    aisle(-9.0, -8.05, -9.6, 3.5); aisle(8.05, 9.0, -9.6, 3.5);    // side aisles along the floor
    aisle(BAL_STAIR.x0 - 1.6, BAL_STAIR.x1 + 1.6, BAL_STAIR.z0 - 0.9, BAL_STAIR.z1 + 0.6);   // stairs + bottom approach
    aisle(11.6, 16.2, 2.6, 5.4);                                   // VIP steps
    aisle(-1.7, 1.7, -9.6, -8.0);                                  // front of the stage
    this.buildSlots();
    // keep only places that can be reached from the entrance (one flood fill instead of one A* per place)
    const reach = this.flood(this.cell(SPAWN.x, SPAWN.z, 0));
    const ok = (s: Slot) => { const p = s.seat ? Nav.approach(s) : s; const c = this.cell(p.x, p.z, s.level); return c >= 0 && reach[c] === 1; };
    for (const z of Object.keys(this.slots) as Zone[]) this.slots[z] = this.slots[z].filter(ok);
    this.seats.vip = this.seats.vip.filter(ok);
    this.seats.lounge = this.seats.lounge.filter(ok);
  }

  /** Standing point in front of a seat. */
  static approach(s: Seat): P2 { return { x: s.x + Math.sin(s.yaw) * 0.72, z: s.z + Math.cos(s.yaw) * 0.72, l: 0 }; }

  get capacity() { return Object.values(this.slots).reduce((n, l) => n + l.length, 0) + this.seats.vip.length + this.seats.lounge.length; }

  ix(x: number) { return Math.floor((x - OX) / CELL); }
  iz(z: number) { return Math.floor((z - OZ) / CELL); }
  private cell(x: number, z: number, l = 0) { const ix = this.ix(x), iz = this.iz(z); return ix < 0 || iz < 0 || ix >= NX || iz >= NZ ? -1 : l * N + iz * NX + ix; }
  walkable(x: number, z: number, l = 0) { const i = this.cell(x, z, l); return i >= 0 && !this.blocked[i]; }
  heightAt(x: number, z: number, l = 0) { return groundY(x, z, l); }
  private centre(i: number): P2 { const c = i % N; return { x: OX + ((c % NX) + 0.5) * CELL, z: OZ + (Math.floor(c / NX) + 0.5) * CELL, l: i >= N ? 1 : 0 }; }

  private buildSlots() {
    const r = rng(1234);
    const floor: Slot[] = [];
    const taken: Slot[] = [];
    const clearOf = (x: number, z: number, l: number, d: number) => taken.every((s) => s.level !== l || (s.x - x) ** 2 + (s.z - z) ** 2 >= d * d);
    const add = (x: number, z: number, opts: { l?: number; compact?: boolean; yaw?: number } = {}) => {
      const l = opts.l ?? 0;
      if (!this.walkable(x, z, l)) return false;
      if (l === 0 && (this.noSlot[this.cell(x, z, 0)] || groundY(x, z, 0) > 0.01)) return false;
      const yaw = opts.yaw ?? (r() < 0.7 ? Math.PI + (r() - 0.5) * 0.9 : r() * Math.PI * 2);
      const s: Slot = { x, z, yaw, y: groundY(x, z, l), taken: null, zone: 'floor', seat: false, level: l, compact: !!opts.compact };
      floor.push(s); taken.push(s);
      return true;
    };
    // 1) the LED dance floor: roomy places, every dance allowed
    let row = 0;
    for (let z = FLOOR.z0 + 0.6; z <= FLOOR.z1 - 0.5; z += 0.94, row++) for (let x = FLOOR.x0 + 0.7 + (row % 2) * 0.5; x <= FLOOR.x1 - 0.6; x += 1.0) add(x, z);
    const tier1 = floor.length;
    for (const z of [4.6, 5.55, 6.5, 7.45, 8.4]) for (let x = -9.6; x <= 9.6; x += 1.0) if (Math.abs(x) > 2.4) add(x + (z * 10 % 2 ? 0.5 : 0), z);
    for (const x of [-10.2, -9.2, 9.2, 10.2]) for (let z = -7.2; z <= 3.4; z += 0.96) add(x, z);
    const tier2 = floor.length;
    // 2) overflow crowd on the ground floor: densely packed, compact dances only
    for (let z = -ROOM.hz + 0.8; z <= ROOM.hz - 0.8; z += DENSE) for (let x = -ROOM.hx + 0.8; x <= ROOM.hx - 0.8; x += DENSE) {
      if (inRect(x, z, VIP, -0.3) || inRect(x, z, LOUNGE, -0.2) || z < STAGE.z1 + 0.6) continue;
      if (!this.walkable(x + 0.3, z) || !this.walkable(x - 0.3, z) || !this.walkable(x, z + 0.3) || !this.walkable(x, z - 0.3)) continue;
      if (!clearOf(x, z, 0, DENSE - 0.02)) continue;
      const face = Math.atan2(0 - x, -3 - z);                    // towards the floor / DJ
      add(x, z, { compact: true, yaw: face + (r() - 0.5) * 0.6 });
    }
    const tier3 = floor.length;
    // 3) balcony: people line up along the glass first, then fill towards the wall
    for (let z = -ROOM.hz + 0.6; z <= ROOM.hz - 0.6; z += DENSE) for (let x = -ROOM.hx + 0.6; x <= ROOM.hx - 0.6; x += DENSE) {
      if (!BAL_AREAS.some((a) => inRect(x, z, a, 0.3))) continue;
      if (Math.abs(x) > ROOM.hx - 0.8 || z > ROOM.hz - 0.8) continue;                      // walking lane along the wall
      if (inRect(x, z, { x0: BAL_LANDING.x0 - 1.2, x1: BAL_LANDING.x1 + 1.2, z0: BAL_LANDING.z0, z1: BAL_LANDING.z1 + 1.4 })) continue;
      if (!this.walkable(x + 0.3, z, 1) || !this.walkable(x - 0.3, z, 1) || !this.walkable(x, z + 0.3, 1) || !this.walkable(x, z - 0.3, 1)) continue;
      add(x, z, { l: 1, compact: true, yaw: Math.atan2(0 - x, -3 - z) + (r() - 0.5) * 0.5 });
    }
    // fill order: dance floor centre first, then its ring, then the dense crowd nearest the DJ, the balcony last
    const k = (s: Slot, i: number) => i < tier1 ? Math.hypot(s.x, (s.z + 3) * 1.25) + r() * 2.2
      : i < tier2 ? 100 + r() : i < tier3 ? 200 + Math.hypot(s.x, s.z + 3) + r() * 0.5 : 300 + Math.hypot(s.x, s.z + 3) + r() * 0.5;
    this.slots.floor = floor.map((s, i) => ({ s, k: k(s, i) })).sort((a, b) => a.k - b.k).map((e) => e.s);
    this.slots.stage = STAGE_SLOTS.map((s) => ({ ...s, taken: null, zone: 'stage' as Zone, seat: false, level: 0, compact: false }));
    const grid = (zone: Zone, x0: number, x1: number, z0: number, z1: number, face: number) => {
      const out: Slot[] = [];
      for (let z = z0; z <= z1; z += 1.15) for (let x = x0; x <= x1; x += 1.15) {
        if (!this.walkable(x, z) || !this.walkable(x + 0.4, z) || !this.walkable(x - 0.4, z) || !this.walkable(x, z + 0.4) || !this.walkable(x, z - 0.4)) continue;
        out.push({ x, z, yaw: face + (r() - 0.5) * 1.2, y: groundY(x, z), taken: null, zone, seat: false, level: 0, compact: false });
      }
      return out;
    };
    this.slots.vip = grid('vip', VIP.x0 + 1.2, VIP.x1 - 2.3, VIP.z0 + 2.4, VIP.z1 - 0.8, -Math.PI / 2);
    this.slots.lounge = grid('lounge', LOUNGE.x0 + 2.4, LOUNGE.x1 - 0.6, LOUNGE.z0 + 2.2, LOUNGE.z1 - 0.6, Math.PI / 2);
    this.seats.vip = VIP_SEATS.map((s) => ({ ...s, taken: null, zone: 'vip' as Zone, seat: true, level: 0, compact: false }));
    this.seats.lounge = LOUNGE_SEATS.map((s) => ({ ...s, taken: null, zone: 'lounge' as Zone, seat: true, level: 0, compact: false }));
  }

  /** Reserves a free standing slot (or seat). Returns null when the zone is full. */
  reserve(zone: Zone, id: string, sit = false, near?: P2): Slot | null {
    const list = sit && (zone === 'vip' || zone === 'lounge') ? this.seats[zone] : this.slots[zone];
    let best: Slot | null = null, bd = 1e9;
    for (const s of list) {
      if (s.taken) continue;
      if (!near) { best = s; break; }
      const d = (s.x - near.x) ** 2 + (s.z - near.z) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return null;
    best.taken = id;
    if (!best.seat) this.setOcc(best, 1);
    return best;
  }

  /** Two free neighbouring roomy floor slots for a duo dance. */
  reservePair(a: string, b: string): [Slot, Slot] | null {
    const f = this.slots.floor;
    for (const s of f) {
      if (s.taken || s.compact) continue;
      const o = f.find((q) => !q.taken && !q.compact && q !== s && Math.abs(q.z - s.z) < 0.1 && Math.abs(Math.abs(q.x - s.x) - 1.0) < 0.05);
      if (o) { s.taken = a; o.taken = b; this.setOcc(s, 1); this.setOcc(o, 1); return [s, o]; }
    }
    return null;
  }

  release(s: Slot | null) {
    if (!s) return;
    s = (s as Slot & { src?: Slot }).src ?? s;      // duo slots are nudged copies of a real slot
    s.taken = null;
    if (!s.seat) this.setOcc(s, 0);
  }

  private setOcc(p: Slot, v: number) { const i = this.cell(p.x, p.z, p.level); if (i >= 0) this.occ[i] = v; }

  /** Spiral search for the closest unblocked cell centre on a level. */
  nearestFree(x: number, z: number, l = 0): P2 {
    const cx = this.ix(x), cz = this.iz(z);
    for (let rad = 0; rad < 30; rad++) for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
      const ix = cx + dx, iz = cz + dz;
      if (ix < 0 || iz < 0 || ix >= NX || iz >= NZ || this.blocked[l * N + iz * NX + ix]) continue;
      return { x: OX + (ix + 0.5) * CELL, z: OZ + (iz + 0.5) * CELL, l };
    }
    return { x, z, l };
  }

  private pass(a: number, b: number) { return !this.blocked[b] && Math.abs(this.height[a] - this.height[b]) <= STEP_H; }

  /** Neighbours of a cell: 8 on the same level, plus the other level at the stair landing. */
  private *neighbours(cur: number): Generator<[number, number]> {
    const l = cur >= N ? 1 : 0, c = cur % N, cx = c % NX, cz = Math.floor(c / NX);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dz) continue;
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ) continue;
      const ni = l * N + nz * NX + nx;
      if (!this.pass(cur, ni)) continue;
      if (dx && dz && (!this.pass(cur, l * N + cz * NX + nx) || !this.pass(cur, l * N + nz * NX + cx))) continue;   // no corner cutting
      yield [ni, dx && dz ? Math.SQRT2 : 1];
    }
    const other = l ? c : N + c;
    if (!this.blocked[other] && !this.blocked[cur] && Math.abs(this.height[other] - this.height[cur]) < 0.05) yield [other, 0.5];
  }

  private flood(start: number) {
    const seen = new Uint8Array(2 * N);
    if (start < 0) return seen;
    const q = [start];
    seen[start] = 1;
    while (q.length) { const c = q.pop()!; for (const [n] of this.neighbours(c)) if (!seen[n]) { seen[n] = 1; q.push(n); } }
    return seen;
  }

  findPath(from: P2, to: P2): P2[] | null {
    const s0 = this.nearestFree(from.x, from.z, from.l ?? 0), t0 = this.nearestFree(to.x, to.z, to.l ?? 0);
    const start = this.cell(s0.x, s0.z, s0.l), goal = this.cell(t0.x, t0.z, t0.l);
    if (start < 0 || goal < 0) return null;
    const stamp = ++this.stamp, g = this.g, fromArr = this.from, mark = this.mark;
    const gc = goal % N, gx = gc % NX, gz = Math.floor(gc / NX), gl = goal >= N ? 1 : 0;
    const sx = BAL_LANDING.x0 + 0.7, sz = (BAL_LANDING.z0 + BAL_LANDING.z1) / 2;
    const h = (i: number) => {
      const c = i % N, x = c % NX, z = Math.floor(c / NX), l = i >= N ? 1 : 0;
      if (l !== gl) {          // via the landing
        const lx = this.ix(sx), lz = this.iz(sz);
        return Math.hypot(x - lx, z - lz) + Math.hypot(gx - lx, gz - lz);
      }
      const dx = Math.abs(x - gx), dz = Math.abs(z - gz);
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    const heapF: number[] = [], heapI: number[] = [];
    const push = (f: number, i: number) => {
      let k = heapF.length; heapF.push(f); heapI.push(i);
      while (k > 0) { const p = (k - 1) >> 1; if (heapF[p] <= f) break; heapF[k] = heapF[p]; heapI[k] = heapI[p]; k = p; }
      heapF[k] = f; heapI[k] = i;
    };
    const pop = () => {
      const top = heapI[0], f = heapF.pop()!, i = heapI.pop()!;
      const n = heapF.length;
      if (n) {
        let k = 0;
        for (;;) { let c = 2 * k + 1; if (c >= n) break; if (c + 1 < n && heapF[c + 1] < heapF[c]) c++; if (heapF[c] >= f) break; heapF[k] = heapF[c]; heapI[k] = heapI[c]; k = c; }
        heapF[k] = f; heapI[k] = i;
      }
      return top;
    };
    g[start] = 0; mark[start] = stamp; fromArr[start] = -1;
    push(h(start), start);
    let found = false, guard = 0;
    while (heapF.length && guard++ < 400000) {
      const fTop = heapF[0];
      const cur = pop();
      if (cur === goal) { found = true; break; }
      if (fTop > g[cur] + h(cur) + 1e-4) continue;          // stale heap entry
      for (const [ni, step] of this.neighbours(cur)) {
        const cost = g[cur] + step * (1 + 2.5 * this.occ[ni]);
        if (mark[ni] === stamp && g[ni] <= cost) continue;
        g[ni] = cost; mark[ni] = stamp; fromArr[ni] = cur;
        push(cost + h(ni), ni);
      }
    }
    if (!found) return null;
    const cells: P2[] = [];
    for (let i = goal; i >= 0; i = fromArr[i]) cells.push(this.centre(i));
    cells.reverse();
    cells[0] = { x: from.x, z: from.z, l: cells[0].l };
    if (this.walkable(to.x, to.z, to.l ?? 0)) cells.push({ x: to.x, z: to.z, l: to.l ?? 0 });
    // string pulling, never across a level change
    const out: P2[] = [cells[0]];
    let a = 0;
    while (a < cells.length - 1) {
      let b = cells.length - 1;
      while (b > a + 1 && (cells[b].l !== cells[a].l || !this.los(cells[a], cells[b]))) b--;
      out.push(cells[b]);
      a = b;
    }
    return out;
  }

  /** Straight walkable line on one level that never crosses a tall step or an occupied place. */
  private los(a: P2, b: P2): boolean {
    const l = a.l ?? 0;
    const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(d / 0.15);
    let prev = this.cell(a.x, a.z, l);
    for (let i = 1; i <= n; i++) {
      const t = i / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const c = this.cell(x, z, l);
      if (c < 0 || this.blocked[c] || (this.occ[c] && i < n)) return false;
      for (const [ox, oz] of [[0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]]) { const q = this.cell(x + ox, z + oz, l); if (q < 0 || this.blocked[q]) return false; }
      if (prev >= 0 && Math.abs(this.height[c] - this.height[prev]) > STEP_H) return false;
      prev = c;
    }
    return true;
  }
}
