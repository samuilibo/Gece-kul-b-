import { COLUMNS, DJ, FLOOR, LOUNGE, LOUNGE_SEATS, ROOM, SOFAS, STAGE, STAGE_SLOTS, TABLES, VIP, VIP_SEATS, groundY, type Seat } from '../layout.ts';
import { rng } from '../engine.ts';
import type { Zone } from '../../../shared/protocol.ts';

export interface P2 { x: number; z: number }
export interface Slot extends Seat { taken: string | null; zone: Zone; seat: boolean; pair?: number }

const CELL = 0.4;
const OX = -18.4, OZ = -14.4;
const NX = Math.ceil(36.8 / CELL), NZ = Math.ceil(31.6 / CELL);
const STEP_H = 0.3;

/** Grid navigation (A*) + reservation of standing slots and seats. */
export class Nav {
  blocked = new Uint8Array(NX * NZ);
  height = new Float32Array(NX * NZ);
  occ = new Uint8Array(NX * NZ);
  slots: Record<Zone, Slot[]> = { floor: [], vip: [], stage: [], lounge: [] };
  seats: Record<'vip' | 'lounge', Slot[]> = { vip: [], lounge: [] };
  private g = new Float32Array(NX * NZ);
  private from = new Int32Array(NX * NZ);
  private mark = new Uint32Array(NX * NZ);
  private stamp = 0;

  constructor() {
    const rect = (x0: number, x1: number, z0: number, z1: number) => {
      for (let iz = Math.max(0, this.iz(z0)); iz <= Math.min(NZ - 1, this.iz(z1)); iz++)
        for (let ix = Math.max(0, this.ix(x0)); ix <= Math.min(NX - 1, this.ix(x1)); ix++) this.blocked[iz * NX + ix] = 1;
    };
    for (let iz = 0; iz < NZ; iz++) for (let ix = 0; ix < NX; ix++) {
      const x = OX + (ix + 0.5) * CELL, z = OZ + (iz + 0.5) * CELL;
      const inside = Math.abs(x) < ROOM.hx - 0.35 && z > -ROOM.hz + 0.35 && z < ROOM.hz - 0.3;
      const door = Math.abs(x) < 1.2 && z >= ROOM.hz - 0.3 && z < ROOM.hz + 2.9;
      this.blocked[iz * NX + ix] = inside || door ? 0 : 1;
      this.height[iz * NX + ix] = groundY(x, z);
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
    this.buildSlots();
  }

  ix(x: number) { return Math.floor((x - OX) / CELL); }
  iz(z: number) { return Math.floor((z - OZ) / CELL); }
  private idx(x: number, z: number) { const ix = this.ix(x), iz = this.iz(z); return ix < 0 || iz < 0 || ix >= NX || iz >= NZ ? -1 : iz * NX + ix; }
  walkable(x: number, z: number) { const i = this.idx(x, z); return i >= 0 && !this.blocked[i]; }

  private buildSlots() {
    const r = rng(1234);
    const floor: Slot[] = [];
    const add = (x: number, z: number) => {
      if (!this.walkable(x, z)) return;
      // most dancers face the DJ, some face each other / the room
      const yaw = r() < 0.7 ? Math.PI + (r() - 0.5) * 0.9 : r() * Math.PI * 2;
      floor.push({ x, z, yaw, y: groundY(x, z), taken: null, zone: 'floor', seat: false });
    };
    let row = 0;
    for (let z = FLOOR.z0 + 0.6; z <= FLOOR.z1 - 0.5; z += 0.94, row++) for (let x = FLOOR.x0 + 0.7 + (row % 2) * 0.5; x <= FLOOR.x1 - 0.6; x += 1.0) add(x, z);
    const main = floor.length;
    for (const z of [4.6, 5.55, 6.5, 7.45, 8.4]) for (let x = -9.6; x <= 9.6; x += 1.0) if (Math.abs(x) > 2.4) add(x + (z * 10 % 2 ? 0.5 : 0), z);
    for (const x of [-10.2, -9.2, 9.2, 10.2]) for (let z = -7.2; z <= 3.4; z += 0.96) add(x, z);
    // centre of the floor fills first, the overflow ring last
    const key = (s: Slot, i: number) => Math.hypot(s.x, (s.z + 3) * 1.25) + (i >= main ? 100 : 0) + r() * 2.2;
    this.slots.floor = floor.map((s, i) => ({ s, k: key(s, i) })).sort((a, b) => a.k - b.k).map((e) => e.s);
    this.slots.stage = STAGE_SLOTS.map((s) => ({ ...s, taken: null, zone: 'stage' as Zone, seat: false }));
    const grid = (zone: Zone, x0: number, x1: number, z0: number, z1: number, face: number) => {
      const out: Slot[] = [];
      for (let z = z0; z <= z1; z += 1.15) for (let x = x0; x <= x1; x += 1.15) {
        if (!this.walkable(x, z) || !this.walkable(x + 0.4, z) || !this.walkable(x - 0.4, z) || !this.walkable(x, z + 0.4) || !this.walkable(x, z - 0.4)) continue;
        out.push({ x, z, yaw: face + (r() - 0.5) * 1.2, y: groundY(x, z), taken: null, zone, seat: false });
      }
      return out;
    };
    this.slots.vip = grid('vip', VIP.x0 + 1.2, VIP.x1 - 2.3, VIP.z0 + 2.4, VIP.z1 - 0.8, -Math.PI / 2);
    this.slots.lounge = grid('lounge', LOUNGE.x0 + 2.4, LOUNGE.x1 - 0.6, LOUNGE.z0 + 2.2, LOUNGE.z1 - 0.6, Math.PI / 2);
    this.seats.vip = VIP_SEATS.map((s) => ({ ...s, taken: null, zone: 'vip' as Zone, seat: true }));
    this.seats.lounge = LOUNGE_SEATS.map((s) => ({ ...s, taken: null, zone: 'lounge' as Zone, seat: true }));
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

  /** Two free neighbouring floor slots for a duo dance. */
  reservePair(a: string, b: string): [Slot, Slot] | null {
    const f = this.slots.floor;
    for (const s of f) {
      if (s.taken) continue;
      const o = f.find((q) => !q.taken && q !== s && Math.abs(q.z - s.z) < 0.1 && Math.abs(Math.abs(q.x - s.x) - 1.0) < 0.05);
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

  private setOcc(p: P2, v: number) { const i = this.idx(p.x, p.z); if (i >= 0) this.occ[i] = v; }

  /** Spiral search for the closest unblocked cell centre. */
  nearestFree(x: number, z: number): P2 {
    const cx = this.ix(x), cz = this.iz(z);
    for (let rad = 0; rad < 30; rad++) for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
      const ix = cx + dx, iz = cz + dz;
      if (ix < 0 || iz < 0 || ix >= NX || iz >= NZ || this.blocked[iz * NX + ix]) continue;
      return { x: OX + (ix + 0.5) * CELL, z: OZ + (iz + 0.5) * CELL };
    }
    return { x, z };
  }

  private pass(a: number, b: number) { return !this.blocked[b] && Math.abs(this.height[a] - this.height[b]) <= STEP_H; }

  findPath(from: P2, to: P2): P2[] | null {
    const s0 = this.nearestFree(from.x, from.z), t0 = this.nearestFree(to.x, to.z);
    const start = this.idx(s0.x, s0.z), goal = this.idx(t0.x, t0.z);
    if (start < 0 || goal < 0) return null;
    const stamp = ++this.stamp, g = this.g, fromArr = this.from, mark = this.mark;
    const gx = goal % NX, gz = Math.floor(goal / NX);
    const h = (i: number) => { const dx = Math.abs((i % NX) - gx), dz = Math.abs(Math.floor(i / NX) - gz); return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz)); };
    // binary heap of [f, index]
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
    while (heapF.length && guard++ < 40000) {
      const cur = pop();
      if (cur === goal) { found = true; break; }
      const cx = cur % NX, cz = Math.floor(cur / NX);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= NX || nz >= NZ) continue;
        const ni = nz * NX + nx;
        if (!this.pass(cur, ni)) continue;
        if (dx && dz && (!this.pass(cur, cz * NX + nx) || !this.pass(cur, nz * NX + cx))) continue;   // no corner cutting
        const cost = g[cur] + (dx && dz ? Math.SQRT2 : 1) * (1 + 2.5 * this.occ[ni]);
        if (mark[ni] === stamp && g[ni] <= cost) continue;
        g[ni] = cost; mark[ni] = stamp; fromArr[ni] = cur;
        push(cost + h(ni), ni);
      }
    }
    if (!found) return null;
    const cells: P2[] = [];
    for (let i = goal; i >= 0; i = fromArr[i]) cells.push({ x: OX + ((i % NX) + 0.5) * CELL, z: OZ + (Math.floor(i / NX) + 0.5) * CELL });
    cells.reverse();
    cells[0] = { x: from.x, z: from.z };
    if (this.walkable(to.x, to.z)) cells.push({ x: to.x, z: to.z });
    // string pulling
    const out: P2[] = [cells[0]];
    let a = 0;
    while (a < cells.length - 1) {
      let b = cells.length - 1;
      while (b > a + 1 && !this.los(cells[a], cells[b])) b--;
      out.push(cells[b]);
      a = b;
    }
    return out;
  }

  /** Straight walkable line that never crosses a step higher than a stair riser or an occupied slot. */
  private los(a: P2, b: P2): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(d / 0.15);
    let prev = this.idx(a.x, a.z);
    for (let i = 1; i <= n; i++) {
      const t = i / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const c = this.idx(x, z);
      if (c < 0 || this.blocked[c] || (this.occ[c] && i < n)) return false;
      for (const [ox, oz] of [[0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]]) { const q = this.idx(x + ox, z + oz); if (q < 0 || this.blocked[q]) return false; }
      if (prev >= 0 && Math.abs(this.height[c] - this.height[prev]) > STEP_H) return false;
      prev = c;
    }
    return true;
  }
}

export { STAGE };
