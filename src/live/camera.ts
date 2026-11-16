import * as THREE from 'three';
import type { Crowd } from './chars/crowd.ts';
import { BALCONY, COLUMNS, DJ, ROOM, STAGE } from './layout.ts';

interface Pose { pos: THREE.Vector3; look: THREE.Vector3 }
interface Ctx { t: number; crowd: Crowd; target: string | null; seed: number; center: THREE.Vector3 }
interface Shot { name: string; weight: number; needs?: 'people' | 'stage' | 'vip'; pose(c: Ctx, out: Pose): void }

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const SHOTS: Shot[] = [
  { name: 'wide', weight: 3, pose: (c, o) => { o.pos.set(Math.sin(c.t * 0.11 + c.seed) * 2.2, 3.5 - 0.3 * Math.sin(c.t * 0.07), 8.4 - c.t * 0.05); o.look.set(0, 1.9, -6.5); } },
  { name: 'dj', weight: 2, pose: (c, o) => { o.pos.set(Math.sin(c.t * 0.16 + c.seed) * 2.6, STAGE.y + 1.55 + 0.15 * Math.sin(c.t * 0.2), -7.6 + 0.4 * Math.cos(c.t * 0.13)); o.look.set(DJ.x, STAGE.y + 1.45, DJ.z); } },
  { name: 'djback', weight: 2, pose: (c, o) => { o.pos.set(1.6 * Math.sin(c.t * 0.12 + c.seed), STAGE.y + 2.5, -13.1); o.look.set(0, 1.0, -3); } },
  { name: 'crowd', weight: 3, needs: 'people', pose: (c, o) => { const s = (c.seed % 2 ? 1 : -1), x = s * (-6.5 + (c.t * 0.55) % 13); o.pos.set(x, 2.3, 2.6); o.look.set(x * 0.4, 1.35, -5); } },
  { name: 'top', weight: 1.5, pose: (c, o) => { const a = c.t * 0.1 + c.seed; o.pos.set(Math.sin(a) * 1.8, 8.4, -2.3 + Math.cos(a) * 1.8); o.look.set(0, 0, -2.5); } },
  { name: 'vip', weight: 1, needs: 'vip', pose: (c, o) => { o.pos.set(9.8 + 0.5 * Math.sin(c.t * 0.1), 2.5, 2.2); o.look.set(15.4, 1.2, -4.2); } },
  { name: 'door', weight: 0.6, pose: (c, o) => { o.pos.set(-3.6 + 0.4 * Math.sin(c.t * 0.1), 2.15, 6.6); o.look.set(0.2, 1.25, 12.6); } },
  { name: 'balcony', weight: 2, pose: (c, o) => { const s = c.seed % 2 ? 1 : -1; o.pos.set(s * (12.6 + 0.2 * Math.sin(c.t * 0.1)), 6.1, 6.5 - c.t * 0.06); o.look.set(-s * 1.5, 1.2, -5); } },
  { name: 'orbit', weight: 3, needs: 'people', pose: (c, o) => { const a = c.t * 0.13 + c.seed * 1.7, r = 6.6; o.pos.set(c.center.x + Math.sin(a) * r, 3.1 + 0.4 * Math.sin(c.t * 0.09), c.center.z + Math.cos(a) * r * 0.8); o.look.set(c.center.x, 1.25, c.center.z); } },
  { name: 'stage', weight: 1.2, needs: 'stage', pose: (c, o) => { o.pos.set(2.5 * Math.sin(c.t * 0.14), 2.7, -5.6); o.look.set(0, STAGE.y + 1.1, -10.4); } },
  { name: 'lounge', weight: 0.6, pose: (c, o) => { o.pos.set(-9.4, 2.3, 2.4 - 0.4 * Math.sin(c.t * 0.1)); o.look.set(-16, 0.9, -3); } },
  {
    name: 'user', weight: 2.5, needs: 'people', pose: (c, o) => {
      const p = c.target ? c.crowd.position(c.target) : null;
      if (!p) { o.pos.set(0, 3.2, 6); o.look.set(0, 1.5, -4); return; }
      const h = c.crowd.headHeight(c.target!), a = c.t * 0.22 + c.seed;
      o.look.set(p.x, p.y + h - 0.28, p.z);
      o.pos.set(p.x + Math.sin(a) * 2.5, p.y + h + 0.3, p.z + Math.cos(a) * 2.5);
    },
  },
];
export const SHOT_NAMES = SHOTS.map((s) => s.name);

/** Automatic director: picks shots every 10-25 s, reacts to events, never clips through geometry or people. */
export class CameraDirector {
  auto = true;
  shot: Shot = SHOTS[0];
  private t = 0;
  private until = 0;
  private ctx: Ctx;
  private desired: Pose = { pos: v(0, 3.4, 8.6), look: v(0, 2, -6) };
  private look = v(0, 2, -6);
  private pending: { shot: Shot; target: string | null; hold: number } | null = null;
  private fadeT = -1;
  private lastWelcome = -100;
  private fixed: string | null = null;
  private snap = true;
  private time = 0;

  constructor(private camera: THREE.PerspectiveCamera, private crowd: Crowd, private fade: (opacity: number) => void) {
    this.ctx = { t: 0, crowd, target: null, seed: 1, center: v(0, 0, -2.5) };
    this.until = 12;
  }

  /** Admin: fixed shot name, or 'auto'. */
  setMode(name: string, target?: string) {
    if (name === 'auto') { this.fixed = null; this.auto = true; this.until = 0; return; }
    const s = SHOTS.find((x) => x.name === name);
    if (!s) return;
    this.fixed = name;
    this.cut(s, target ?? this.pickTarget(), 1e9);
  }

  /** Temporary shot (viewer !camera, Super Chat close-up, welcome shot…). */
  request(name: string, target: string | null, hold: number, force = false) {
    if (this.fixed && !force) return;
    const s = SHOTS.find((x) => x.name === name);
    if (s) this.cut(s, target, hold);
  }

  welcome(id: string) {
    if (!this.auto || this.fixed || this.time - this.lastWelcome < 45 || this.shot.name === 'user') return;
    this.lastWelcome = this.time;
    this.cut(SHOTS.find((s) => s.name === 'door')!, id, 5.5);
  }

  private pickTarget(): string | null { return this.crowd.random()?.m.id ?? null; }

  private cut(shot: Shot, target: string | null, hold: number) {
    this.pending = { shot, target, hold };
    if (this.fadeT < 0) this.fadeT = 0;
  }

  private choose() {
    const people = this.crowd.count > 0;
    let stage = false, vip = false;
    for (const d of this.crowd.dancers.values()) { if (d.m.zone === 'stage') stage = true; if (d.m.zone === 'vip') vip = true; }
    const ok = SHOTS.filter((s) => s !== this.shot && (!s.needs || (s.needs === 'people' && people) || (s.needs === 'stage' && stage) || (s.needs === 'vip' && vip)));
    let total = 0;
    for (const s of ok) total += s.weight;
    let r = Math.random() * total;
    let pick = ok[0];
    for (const s of ok) { r -= s.weight; if (r <= 0) { pick = s; break; } }
    this.cut(pick, pick.name === 'user' ? this.pickTarget() : null, 10 + Math.random() * 15);
  }

  update(dt: number) {
    this.time += dt;
    this.t += dt;
    if (this.auto && !this.fixed && this.time >= this.until && !this.pending) this.choose();
    // a requested target that left the club ends the shot early
    if (this.shot.name === 'user' && this.ctx.target && !this.crowd.position(this.ctx.target) && !this.pending) { if (this.fixed) this.ctx.target = this.pickTarget(); else this.until = 0; }
    // dip to black, switch, come back: no abrupt whip-pans
    if (this.fadeT >= 0) {
      this.fadeT += dt;
      const half = 0.2;
      if (this.fadeT >= half && this.pending) {
        const p = this.pending;
        this.pending = null;
        this.shot = p.shot; this.t = 0;
        this.ctx.target = p.target; this.ctx.seed = Math.floor(Math.random() * 1000);
        this.until = this.time + p.hold;
        this.snap = true;
      }
      const o = this.fadeT < half ? this.fadeT / half : 1 - (this.fadeT - half) / 0.28;
      this.fade(Math.max(0, Math.min(1, o)));
      if (this.fadeT > half + 0.28) { this.fadeT = -1; this.fade(0); }
    }
    this.ctx.t = this.t;
    this.crowd.center(this.ctx.center);
    this.shot.pose(this.ctx, this.desired);
    this.constrain(this.desired.pos);
    const k = this.snap ? 1 : Math.min(1, dt * 2.2);
    this.camera.position.lerp(this.desired.pos, k);
    this.look.lerp(this.desired.look, this.snap ? 1 : Math.min(1, dt * 3));
    this.snap = false;
    this.camera.lookAt(this.look);
  }

  /** Keeps the camera inside the room, out of structures and above nearby heads. */
  private constrain(p: THREE.Vector3) {
    p.x = THREE.MathUtils.clamp(p.x, -ROOM.hx + 0.8, ROOM.hx - 0.8);
    p.z = THREE.MathUtils.clamp(p.z, -ROOM.hz + 0.7, ROOM.hz - 0.8);
    p.y = THREE.MathUtils.clamp(p.y, 1.2, ROOM.h - 0.5);
    const d = BALCONY.depth;
    const underBalcony = Math.abs(p.x) > ROOM.hx - d - 0.3 || p.z > ROOM.hz - d - 0.3;
    if (underBalcony && p.y > BALCONY.y - 0.9 && p.y < BALCONY.y + 0.5) p.y = p.y < BALCONY.y - 0.2 ? BALCONY.y - 0.9 : BALCONY.y + 1.5;
    if (p.z < STAGE.z1 + 0.3 && Math.abs(p.x) < STAGE.x1 + 0.3) p.y = Math.max(p.y, STAGE.y + 1.5);
    if (p.z < -ROOM.hz + 1.6 && Math.abs(p.x) < 8.5 && p.y < 7.6) p.z = -ROOM.hz + 1.0;      // stay in front of the LED wall, behind the DJ
    for (const [cx, cz] of COLUMNS) {
      const dx = p.x - cx, dz = p.z - cz, e = Math.hypot(dx, dz);
      if (e < 0.75 && p.y < BALCONY.y) { p.x = cx + (dx / (e || 1)) * 0.75; p.z = cz + (dz / (e || 1)) * 0.75; }
    }
    for (const o of this.crowd.dancers.values()) {
      const e = Math.hypot(p.x - o.pos.x, p.z - o.pos.z);
      if (e < 0.7) p.y = Math.max(p.y, o.pos.y + o.ch.headY + 0.45);
    }
  }
}
