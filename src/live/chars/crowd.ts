import * as THREE from 'three';
import type { ActionKind, ClubEvent, Member, Zone } from '../../../shared/protocol.ts';
import { rng, type AudioFrame, type Engine } from '../engine.ts';
import { SPAWN, groundY } from '../layout.ts';
import type { Archetype } from './assets.ts';
import { Character } from './character.ts';
import { DANCES, DANCE_ALIASES } from './dances.ts';
import { makeLook } from './look.ts';
import { Nav, type P2, type Slot } from './nav.ts';

type State = 'walk' | 'settle' | 'dance' | 'sit' | 'leave';
const WALK = 1.35, RUN = 3.1, RADIUS = 0.3;
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

export class Dancer {
  ch: Character;
  state: State = 'walk';
  path: P2[] = [];
  pi = 0;
  slot: Slot | null = null;
  speed = 0;
  yaw = Math.PI;
  dance = 'idle';
  nextSwitch = 0;
  overrideUntil = 0;          // beat until which the current dance must not be auto-changed
  acc = 0;
  dist = 0;
  visible = true;
  stuck = 0;
  lastProgress = 0;
  ghost = 0;
  partner: Dancer | null = null;
  duoRole: 'lead' | 'follow' | null = null;
  goldUntil = 0;
  settleFrom = new THREE.Vector3();
  settleT = 0;
  pos: THREE.Vector3;
  cell = '';

  constructor(public m: Member, arch: Archetype[]) {
    const look = makeLook(m.seed, m.outfit, m.color, arch);
    this.ch = new Character(arch[look.arch], look);
    this.pos = this.ch.group.position;
    this.ch.phase = 0;
  }
}

/** Owns every viewer avatar: spawning, walking, slot reservation, dancing, LOD and animation LOD. */
export class Crowd {
  nav = new Nav();
  dancers = new Map<string, Dancer>();
  group = new THREE.Group();
  showNames = true;
  showAvatars = true;
  visibleCount = 0;
  onArrive: ((d: Dancer) => void) | null = null;
  private event: ClubEvent | null = null;
  private shadows: THREE.InstancedMesh;
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
  private m4 = new THREE.Matrix4();
  private hash = new Map<string, Dancer[]>();
  private battleUntil = 0;
  private lastBeat = -1;
  private sorted: Dancer[] = [];
  private r = rng(99);

  constructor(private engine: Engine, private arch: Archetype[]) {
    engine.scene.add(this.group);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.75)'); grad.addColorStop(0.6, 'rgba(0,0,0,0.35)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }), 320);
    this.shadows.count = 0; this.shadows.frustumCulled = false; this.shadows.renderOrder = 5;
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadows.userData.noEnv = true;
    engine.scene.add(this.shadows);
    this.group.userData.noEnv = true;
  }

  get count() { return this.dancers.size; }

  // ------------------------------------------------------------------ membership
  sync(members: Member[]) {
    const ids = new Set(members.map((m) => m.id));
    for (const id of [...this.dancers.keys()]) if (!ids.has(id)) this.leave(id);
    for (const m of members) if (this.dancers.has(m.id)) this.update1(m); else this.join(m, true);
  }

  join(m: Member, instant = false) {
    if (this.dancers.has(m.id)) return;
    const d = new Dancer(m, this.arch);
    this.dancers.set(m.id, d);
    this.group.add(d.ch.group);
    d.pos.set(SPAWN.x + (Math.random() - 0.5) * 0.8, 0, SPAWN.z + Math.random() * 0.6);
    d.ch.group.rotation.y = d.yaw = Math.PI;
    d.dance = this.chooseDance();
    this.refreshTag(d);
    this.goTo(d, m.zone, m.sitting);
    if (instant && d.slot) {             // state restore after a page reload: skip the walk-in
      d.pos.set(d.slot.x, d.slot.y, d.slot.z);
      d.path = []; this.arrive(d, true);
    }
  }

  leave(id: string) {
    const d = this.dancers.get(id);
    if (!d || d.state === 'leave') return;
    this.unpair(d);
    this.nav.release(d.slot); d.slot = null;
    d.state = 'leave';
    this.route(d, SPAWN);
  }

  update1(m: Member) {
    const d = this.dancers.get(m.id);
    if (!d || d.state === 'leave') return;
    const old = d.m;
    d.m = m;
    if (old.outfit !== m.outfit || old.color !== m.color) d.ch.setLook(makeLook(m.seed, m.outfit, m.color, this.arch));
    if (old.name !== m.name || old.vip !== m.vip || old.avatar !== m.avatar) this.refreshTag(d);
    if (old.zone !== m.zone || old.sitting !== m.sitting) { this.unpair(d); this.goTo(d, m.zone, m.sitting); }
  }

  private refreshTag(d: Dancer) {
    d.ch.setTag(this.showNames ? { name: d.m.name, demo: d.m.source === 'demo', vip: d.m.vip, avatar: this.showAvatars ? d.m.avatar : undefined } : null);
  }

  setTagOptions(names: boolean, avatars: boolean) {
    if (names === this.showNames && avatars === this.showAvatars) return;
    this.showNames = names; this.showAvatars = avatars;
    for (const d of this.dancers.values()) this.refreshTag(d);
  }

  // ------------------------------------------------------------------ movement
  private goTo(d: Dancer, zone: Zone, sit: boolean) {
    this.nav.release(d.slot);
    let slot = this.nav.reserve(zone, d.m.id, sit, zone === 'floor' ? undefined : d.pos);
    if (!slot && sit) slot = this.nav.reserve(zone, d.m.id, false, d.pos);
    if (!slot) slot = this.nav.reserve('floor', d.m.id) ?? this.nav.reserve('lounge', d.m.id);
    if (!slot) {                                    // everything is full: any free spot away from other people
      for (let k = 0; k < 40 && !slot; k++) {
        const p = this.nav.nearestFree((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 22);
        if (groundY(p.x, p.z) === 0 && ![...this.dancers.values()].some((o) => o !== d && o.slot && Math.hypot(o.slot.x - p.x, o.slot.z - p.z) < 0.75)) {
          slot = { x: p.x, z: p.z, y: 0, yaw: Math.random() * 6.28, taken: d.m.id, zone: 'floor', seat: false };
        }
      }
    }
    d.slot = slot;
    if (slot) this.route(d, slot.seat ? Nav.approach(slot) : slot);
  }

  private route(d: Dancer, to: P2) {
    const path = this.nav.findPath({ x: d.pos.x, z: d.pos.z }, to) ?? [{ x: d.pos.x, z: d.pos.z }, { x: to.x, z: to.z }];
    d.path = path; d.pi = 1;
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    d.speed = len > 13 ? RUN : WALK;
    if (d.state !== 'leave') d.state = 'walk';
    d.stuck = 0; d.ghost = 0; d.lastProgress = len;
    d.ch.play(d.speed === RUN ? 'run' : 'walk', 0.3);
  }

  private arrive(d: Dancer, instant = false) {
    const s = d.slot;
    if (d.state === 'leave' || !s) { this.remove(d); return; }
    if (s.seat) {
      d.state = 'settle'; d.settleT = instant ? 1 : 0; d.settleFrom.copy(d.pos);
      d.yaw = s.yaw;
      d.ch.play('sit', 0.5);
      return;
    }
    d.state = d.m.sitting ? 'sit' : 'dance';
    d.yaw = d.partner && d.duoRole ? Math.atan2(d.partner.slot!.x - s.x, d.partner.slot!.z - s.z) : s.yaw;
    if (d.partner && d.duoRole) {
      if (d.partner.state === 'dance') for (const q of [d, d.partner]) { q.ch.phase = 0; q.ch.play(q.duoRole === 'lead' ? 'duo_lead' : 'duo_follow', 0.4); }
      else d.ch.play('idle', 0.3);
    } else d.ch.play(d.m.sitting ? 'idle' : d.dance, 0.4);
    this.onArrive?.(d);
  }

  private remove(d: Dancer) {
    this.nav.release(d.slot);
    this.dancers.delete(d.m.id);
    d.ch.dispose();
  }

  private unpair(d: Dancer) {
    const p = d.partner;
    d.partner = null; d.duoRole = null;
    if (p) { p.partner = null; p.duoRole = null; if (p.state === 'dance') p.ch.play(p.dance, 0.4); }
  }

  // ------------------------------------------------------------------ actions
  private chooseDance(arg?: string): string {
    if (arg) {
      if (DANCES.includes(arg)) return arg;
      const a = DANCE_ALIASES[arg];
      if (a) return pick(a);
    }
    const ev = this.event;
    if (ev?.special === 'choreo') return pick(ev.dances);
    if (ev && Math.random() < 0.7) return pick(ev.dances);
    return pick(DANCES);
  }

  action(id: string, kind: ActionKind, arg: string | undefined, beats: number) {
    const d = this.dancers.get(id);
    if (!d || d.state === 'leave') return;
    const map: Partial<Record<ActionKind, string>> = { shuffle: 'shuffle', breakdance: 'breakdance', robot: 'robot' };
    if (kind === 'dance' || map[kind]) {
      this.unpair(d);
      d.dance = this.chooseDance(map[kind] ?? arg);
      d.overrideUntil = beats + 48;
      d.nextSwitch = beats + 48 + Math.random() * 32;
      if (d.state === 'dance') d.ch.play(d.dance, 0.4);
    } else if (kind === 'special') {
      d.dance = 'special'; d.overrideUntil = beats + 32; d.nextSwitch = beats + 32;
      if (d.state === 'dance') d.ch.play('special', 0.4);
    } else if ((kind === 'jump' || kind === 'wave' || kind === 'clap') && d.state === 'dance') d.ch.playOnce(kind, 0.2);
    else if (kind === 'wave' && d.state === 'sit') { /* seated viewers keep sitting */ }
  }

  duo(a: string, b: string, beats: number) {
    const A = this.dancers.get(a), B = this.dancers.get(b);
    if (!A || !B || A.state === 'leave' || B.state === 'leave') return;
    this.unpair(A); this.unpair(B);
    this.nav.release(A.slot); this.nav.release(B.slot); A.slot = B.slot = null;
    const pair = this.nav.reservePair(a, b);
    if (!pair) { this.goTo(A, 'floor', false); this.goTo(B, 'floor', false); return; }
    // stand a little closer than the slot spacing so that hands can meet
    const [sa, sb] = pair, dir = Math.sign(sb.x - sa.x);
    A.slot = { ...sa, x: sa.x + dir * 0.1 }; B.slot = { ...sb, x: sb.x - dir * 0.1 };
    A.slot.taken = a; B.slot.taken = b;
    (A.slot as Slot & { src?: Slot }).src = sa; (B.slot as Slot & { src?: Slot }).src = sb;
    A.partner = B; B.partner = A; A.duoRole = 'lead'; B.duoRole = 'follow';
    A.overrideUntil = B.overrideUntil = beats + 64;
    this.route(A, A.slot); this.route(B, B.slot);
  }

  gold(id: string, seconds: number, now: number) { const d = this.dancers.get(id); if (d) d.goldUntil = now + seconds; }
  position(id: string): THREE.Vector3 | null { const d = this.dancers.get(id); return d && d.state !== 'leave' ? d.pos : null; }
  headHeight(id: string) { return this.dancers.get(id)?.ch.headY ?? 1.7; }

  setEvent(ev: ClubEvent, beats: number) {
    this.event = ev;
    for (const d of this.dancers.values()) if (beats >= d.overrideUntil) d.nextSwitch = beats + (ev.special === 'choreo' ? 0 : Math.random() * 16);
  }

  /** Centre of mass of the people currently dancing (camera target). */
  center(out: THREE.Vector3) {
    let n = 0; out.set(0, 0, 0);
    for (const d of this.dancers.values()) if (d.state === 'dance' && d.m.zone === 'floor') { out.add(d.pos); n++; }
    return n ? out.multiplyScalar(1 / n) : out.set(0, 0, -2.5);
  }

  random(filter?: (d: Dancer) => boolean): Dancer | null {
    const list = [...this.dancers.values()].filter((d) => d.state === 'dance' && (!filter || filter(d)));
    return list.length ? pick(list) : null;
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, t: number, a: AudioFrame, camera: THREE.Camera) {
    const prof = this.engine.profile, bps = a.bpm / 60;
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    // spatial hash for local avoidance
    this.hash.clear();
    for (const d of this.dancers.values()) {
      const k = `${Math.floor(d.pos.x)},${Math.floor(d.pos.z)}`;
      let l = this.hash.get(k);
      if (!l) this.hash.set(k, (l = []));
      l.push(d);
    }
    const beat = a.beatCount;
    const newBeat = beat !== this.lastBeat;
    this.lastBeat = beat;
    if (newBeat && this.event?.special === 'battle' && beat % 32 === 0) this.battle(a.beats);

    let i = 0, vis = 0;
    const camPos = camera.position, many = this.dancers.size > 150;
    this.sorted.length = 0;
    for (const d of this.dancers.values()) {
      // ---- locomotion
      if (d.state === 'walk' || d.state === 'leave') {
        // sub-steps keep waypoint following and avoidance stable when a frame takes long
        for (let r = dt; r > 1e-4 && (d.state === 'walk' || d.state === 'leave') && this.dancers.has(d.m.id); r -= 0.05) this.walk(d, Math.min(r, 0.05));
        if (!this.dancers.has(d.m.id)) continue;
      }
      else if (d.state === 'settle') {
        d.settleT = Math.min(1, d.settleT + dt / 0.7);
        const s = d.slot!, k = d.settleT * d.settleT * (3 - 2 * d.settleT);
        d.pos.set(THREE.MathUtils.lerp(d.settleFrom.x, s.x, k), THREE.MathUtils.lerp(d.settleFrom.y, s.y, k), THREE.MathUtils.lerp(d.settleFrom.z, s.z, k));
        if (d.settleT >= 1) { d.state = 'sit'; this.onArrive?.(d); }
      } else if (d.state === 'dance' && newBeat && a.beats >= d.nextSwitch && !d.partner && !d.ch.busy && beat % 4 === 0) {
        d.nextSwitch = a.beats + 32 + Math.floor(Math.random() * 6) * 8;
        if (a.beats >= d.overrideUntil) { d.dance = this.chooseDance(); d.ch.play(d.dance, 0.6); }
      }
      // smooth turning
      const g = d.ch.group;
      let dy = d.yaw - g.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      g.rotation.y += dy * Math.min(1, dt * 7);
      const gold = t < d.goldUntil ? 1 : 0;
      const ug = d.ch.uniforms.uGold;
      if (ug.value !== gold) ug.value += (gold - ug.value) * Math.min(1, dt * 4);

      // ---- LOD + animation LOD
      this.sphere.center.set(d.pos.x, d.pos.y + 0.95, d.pos.z);
      d.visible = this.frustum.intersectsSphere(this.sphere);
      d.dist = camPos.distanceTo(this.sphere.center);
      const k = many ? 0.75 : 1;
      const lod = d.dist < prof.lod[0] * k ? 0 : d.dist < prof.lod[1] * k ? 1 : 2;
      d.ch.setLod(lod, prof.shadows > 0);
      const moving = d.state === 'walk' || d.state === 'leave' || d.state === 'settle';
      const hz = !d.visible ? 5 : lod === 0 ? 1000 : lod === 1 ? Math.max(30, prof.animFar) : prof.animFar;
      d.acc += dt;
      if (d.acc >= 1 / hz - 0.004 || (moving && d.visible)) {
        d.ch.skip = false;
        d.ch.update(d.acc, a.beats, bps, d.speed);
        d.acc = 0;
      } else d.ch.skip = true;
      if (d.visible) { vis++; this.sorted.push(d); }
      // ---- contact shadow
      const sc = 0.95 * d.ch.look.scale;
      this.m4.makeScale(sc, 1, sc).setPosition(d.pos.x, d.pos.y + 0.035, d.pos.z);
      if (i < 320) this.shadows.setMatrixAt(i++, this.m4);
    }
    this.shadows.count = i;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.visibleCount = vis;
    // name tags: nearest N only
    if (this.showNames) {
      this.sorted.sort((x, y) => x.dist - y.dist);
      for (const d of this.dancers.values()) if (d.ch.tag) d.ch.tag.visible = false;
      const n = Math.min(prof.nameTags, this.sorted.length);
      for (let j = 0; j < n; j++) { const tg = this.sorted[j].ch.tag; if (tg && this.sorted[j].dist < 32 && this.sorted[j].dist > 1.2) tg.visible = true; }
    }
  }

  private walk(d: Dancer, dt: number) {
    const wp = d.path[d.pi];
    if (!wp) { this.arrive(d); return; }
    let dx = wp.x - d.pos.x, dz = wp.z - d.pos.z;
    const dist = Math.hypot(dx, dz), last = d.pi === d.path.length - 1;
    if (dist < (last ? 0.06 : 0.3)) {
      d.pi++;
      if (d.pi >= d.path.length) { if (!last || dist < 0.06) { d.pos.x = wp.x; d.pos.z = wp.z; } this.arrive(d); }
      return;
    }
    dx /= dist; dz /= dist;
    // slow down for the last step so that the avatar stops exactly on its slot
    const v = Math.min(d.speed, last ? Math.max(0.5, dist * 4) : d.speed);
    let nx = d.pos.x + dx * v * dt, nz = d.pos.z + dz * v * dt;
    // local avoidance: slide around people (standing dancers are static obstacles)
    if (d.ghost <= 0) {
      const cx = Math.floor(nx), cz = Math.floor(nz);
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        const l = this.hash.get(`${cx + ox},${cz + oz}`);
        if (!l) continue;
        for (const o of l) {
          if (o === d || o === d.partner) continue;
          const ex = nx - o.pos.x, ez = nz - o.pos.z, e = Math.hypot(ex, ez), min = RADIUS * 2;
          if (e >= min || e < 1e-4) continue;
          if (last && dist < 0.8) continue;                 // own slot: neighbours are spaced correctly already
          const push = (min - e) * (o.state === 'walk' || o.state === 'leave' ? 0.5 : 1);
          // push sideways relative to the walking direction so that people flow around each other
          const side = Math.sign(ex * dz - ez * dx) || 1;
          nx += (ex / e) * push * 0.6 + dz * side * push * 0.4;
          nz += (ez / e) * push * 0.6 - dx * side * push * 0.4;
        }
      }
      if (!this.nav.walkable(nx, nz)) { nx = d.pos.x + dx * v * dt; nz = d.pos.z + dz * v * dt; }
    } else d.ghost -= dt;
    const moved = Math.hypot(nx - d.pos.x, nz - d.pos.z);
    d.pos.x = nx; d.pos.z = nz;
    d.pos.y += (groundY(nx, nz) - d.pos.y) * Math.min(1, dt * 10);
    d.yaw = Math.atan2(dx, dz);
    // stuck handling: re-plan, then (rarely) squeeze through. Never teleports.
    d.stuck = moved < v * dt * 0.25 ? d.stuck + dt : Math.max(0, d.stuck - dt);
    if (d.stuck > 1.2) {
      d.stuck = 0;
      const end = d.path[d.path.length - 1];
      const p = this.nav.findPath({ x: d.pos.x, z: d.pos.z }, end);
      if (p && p.length > 1) { d.path = p; d.pi = 1; }
      d.ghost = 1.0;
    }
  }

  private battle(beats: number) {
    const a = this.random((d) => d.m.zone === 'floor' && !d.partner), b = this.random((d) => d.m.zone === 'floor' && !d.partner && d !== a);
    for (const d of [a, b]) if (d) { d.dance = pick(['break_floor', 'break_toprock', 'shuffle_t', 'robot_a']); d.overrideUntil = beats + 30; d.nextSwitch = beats + 30; d.ch.play(d.dance, 0.4); }
    this.battleUntil = beats + 30;
    this.battlers = [a, b].filter(Boolean) as Dancer[];
  }
  battlers: Dancer[] = [];
  get battleActive() { return this.battlers.length > 0 && this.lastBeat < this.battleUntil; }
}
