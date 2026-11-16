import * as THREE from 'three';
import type { ActionKind, ClubEvent, Member, Zone } from '../../../shared/protocol.ts';
import type { AudioFrame, Engine } from '../engine.ts';
import { SPAWN, groundY } from '../layout.ts';
import type { Archetype } from './assets.ts';
import { Character } from './character.ts';
import { CrowdGPU } from './crowdgpu.ts';
import { DANCES, DANCE_ALIASES } from './dances.ts';
import { makeLook, type Look } from './look.ts';
import { Nav, type P2, type Slot } from './nav.ts';

type State = 'outside' | 'walk' | 'settle' | 'dance' | 'sit' | 'leave';
const WALK = 1.35, RUN = 3.1, RADIUS = 0.3;
const MAX_WALKERS = 40;                 // people moving through the club at the same time (door throttle)
/** Dances that stay inside the body's footprint: used on densely packed places so neighbours never touch. */
export const COMPACT_DANCES = ['hiphop_bounce', 'house_jack', 'edm_pump', 'hands_up', 'techno_stomp', 'slow_sway', 'twist', 'freestyle_b'];
const pick = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

/**
 * One viewer. The data lives here; a detailed skinned Character is attached only while the viewer is
 * a "hero" (near the camera, moving, gesturing or in a special effect). Everyone else is drawn by the GPU crowd.
 */
export class Dancer {
  ch: Character | null = null;
  look: Look;
  state: State = 'outside';
  path: P2[] = [];
  pi = 0;
  slot: Slot | null = null;
  speed = 0;
  yaw = Math.PI;
  shownYaw = Math.PI;
  level = 0;
  dance = 'idle';
  phase = 0;
  nextSwitch = 0;
  overrideUntil = 0;          // beat until which the current dance must not be auto-changed
  heroUntil = 0;              // seconds: keep detailed (gesture / command / effect)
  dist = 0;
  visible = true;
  stuck = 0;
  ghost = 0;
  partner: Dancer | null = null;
  duoRole: 'lead' | 'follow' | null = null;
  goldUntil = 0;
  gold = 0;
  settleFrom = new THREE.Vector3();
  settleT = 0;
  pos = new THREE.Vector3();
  lookRow = -1;
  animAcc = 0;
  headY: number;
  scale: number;

  constructor(public m: Member, arch: Archetype[]) {
    this.look = makeLook(m.seed, m.outfit, m.color, arch);
    this.scale = this.look.scale;
    this.headY = arch[this.look.arch].headTop * this.scale;
    this.phase = m.seed % 4;
  }

  get clip() {
    if (this.state === 'sit' && this.slot?.seat) return 'sit';
    if (this.state === 'sit') return 'idle';
    if (this.partner && this.duoRole) return this.partner.state === 'dance' && this.state === 'dance' ? (this.duoRole === 'lead' ? 'duo_lead' : 'duo_follow') : 'idle';
    return this.state === 'dance' ? this.dance : this.state === 'settle' ? 'sit' : 'idle';
  }
}

/** Owns every viewer avatar: spawning, walking, slot reservation, dancing, hero/crowd LOD. */
export class Crowd {
  nav = new Nav();
  dancers = new Map<string, Dancer>();
  group = new THREE.Group();
  gpu: CrowdGPU;
  showNames = true;
  showAvatars = true;
  visibleCount = 0;
  heroCount = 0;
  onArrive: ((d: Dancer) => void) | null = null;
  battlers: Dancer[] = [];
  private event: ClubEvent | null = null;
  private shadows: THREE.InstancedMesh;
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
  private hash = new Map<number, Dancer[]>();
  private battleUntil = 0;
  private lastBeat = -1;
  private pool: Character[][];
  private heroes = new Set<Dancer>();
  private rankT = 0;
  private time = 0;
  private walkers = 0;

  constructor(private engine: Engine, private arch: Archetype[]) {
    engine.scene.add(this.group);
    this.group.userData.noEnv = true;
    this.pool = arch.map(() => []);
    this.gpu = new CrowdGPU(engine.scene);
    void this.gpu.init(arch, (a) => makeLook(a.index * 7919 + 1, 0, 0, arch));
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.75)'); grad.addColorStop(0.6, 'rgba(0,0,0,0.35)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }), 2048);
    this.shadows.count = 0; this.shadows.frustumCulled = false; this.shadows.renderOrder = 5;
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadows.userData.noEnv = true;
    engine.scene.add(this.shadows);
  }

  get count() { return this.dancers.size; }
  get capacity() { return this.nav.capacity; }

  // ------------------------------------------------------------------ hero characters (pooled)
  private attach(d: Dancer) {
    if (d.ch) return;
    const ch = this.pool[d.look.arch].pop() ?? new Character(this.arch[d.look.arch], d.look);
    ch.setLook(d.look);
    ch.phase = d.phase;
    d.ch = ch;
    d.animAcc = 0;
    ch.group.position.copy(d.pos);
    ch.group.rotation.y = d.shownYaw;
    ch.uniforms.uGold.value = d.gold;
    this.group.add(ch.group);
    const moving = d.state === 'walk' || d.state === 'leave';
    ch.play(moving ? (d.speed === RUN ? 'run' : 'walk') : d.clip, 0);
    this.heroes.add(d);
    this.refreshTag(d);
  }

  private detach(d: Dancer) {
    const ch = d.ch;
    if (!ch) return;
    d.ch = null;
    this.heroes.delete(d);
    ch.reset();
    ch.group.removeFromParent();
    const p = this.pool[d.look.arch];
    if (p.length < 40) p.push(ch); else ch.dispose();
  }

  /** A viewer must be detailed while moving, gesturing, partnered or highlighted, and whenever the GPU crowd cannot draw it. */
  private mustBeHero(d: Dancer) {
    return d.state === 'walk' || d.state === 'leave' || d.state === 'settle' || !!d.partner || d.heroUntil > this.time || d.goldUntil > this.time
      || d.m.zone === 'stage' || !!d.ch?.busy || !this.gpu.ready || !this.gpu.hasClip(d.look.arch, d.clip) || d.lookRow < 0;
  }

  // ------------------------------------------------------------------ membership
  sync(members: Member[]) {
    const ids = new Set(members.map((m) => m.id));
    for (const id of [...this.dancers.keys()]) if (!ids.has(id)) this.remove(this.dancers.get(id)!);
    for (const m of members) if (this.dancers.has(m.id)) this.update1(m); else this.join(m, true);
  }

  join(m: Member, instant = false) {
    if (this.dancers.has(m.id)) return;
    const d = new Dancer(m, this.arch);
    d.lookRow = this.gpu.allocLook(d.look.arch, d.look);
    this.dancers.set(m.id, d);
    d.pos.set(SPAWN.x + (Math.random() - 0.5) * 0.8, 0, SPAWN.z + Math.random() * 0.6);
    d.yaw = d.shownYaw = Math.PI;
    d.dance = this.chooseDance(undefined, false);
    this.reserveFor(d, m.zone, m.sitting);
    if (instant && d.slot) {              // state restore after a page reload: skip the walk-in
      const s = d.slot;
      d.level = s.level;
      d.pos.set(s.x, s.y, s.z);
      this.arrive(d, true);
    }
  }

  leave(id: string) {
    const d = this.dancers.get(id);
    if (!d || d.state === 'leave') return;
    this.unpair(d);
    this.nav.release(d.slot); d.slot = null;
    // mass exits (stream end, demo stop): people who are not on screen, or too many at once, fade out
    if (d.state === 'outside' || (!d.ch && (this.walkers >= MAX_WALKERS || !d.visible))) { this.remove(d); return; }
    d.state = 'leave';
    this.route(d, { x: SPAWN.x, z: SPAWN.z, l: 0 });
  }

  update1(m: Member) {
    const d = this.dancers.get(m.id);
    if (!d || d.state === 'leave') return;
    const old = d.m;
    d.m = m;
    if (old.outfit !== m.outfit || old.color !== m.color) {
      d.look = makeLook(m.seed, m.outfit, m.color, this.arch);
      d.ch?.setLook(d.look);
      if (d.lookRow >= 0) this.gpu.writeLook(d.lookRow, d.look.arch, d.look);
      d.heroUntil = this.time + 6;
    }
    if (old.name !== m.name || old.vip !== m.vip || old.avatar !== m.avatar) this.refreshTag(d);
    if (old.zone !== m.zone || old.sitting !== m.sitting) { this.unpair(d); this.reserveFor(d, m.zone, m.sitting); if (d.state !== 'outside') this.goToSlot(d); }
  }

  private refreshTag(d: Dancer) {
    d.ch?.setTag(this.showNames ? { name: d.m.name, demo: d.m.source === 'demo', vip: d.m.vip, avatar: this.showAvatars ? d.m.avatar : undefined, platform: d.m.source } : null);
  }

  setTagOptions(names: boolean, avatars: boolean) {
    if (names === this.showNames && avatars === this.showAvatars) return;
    this.showNames = names; this.showAvatars = avatars;
    for (const d of this.heroes) this.refreshTag(d);
  }

  // ------------------------------------------------------------------ movement
  private reserveFor(d: Dancer, zone: Zone, sit: boolean) {
    this.nav.release(d.slot);
    let slot = this.nav.reserve(zone, d.m.id, sit, zone === 'floor' ? undefined : d.pos);
    if (!slot && sit) slot = this.nav.reserve(zone, d.m.id, false, d.pos);
    if (!slot) slot = this.nav.reserve('floor', d.m.id) ?? this.nav.reserve('lounge', d.m.id) ?? this.nav.reserve('lounge', d.m.id, true);
    d.slot = slot;
    if (slot?.compact && !COMPACT_DANCES.includes(d.dance)) d.dance = this.chooseDance(undefined, true);
  }

  private goToSlot(d: Dancer) {
    const s = d.slot;
    if (!s) return;
    this.route(d, s.seat ? Nav.approach(s) : { x: s.x, z: s.z, l: s.level });
  }

  private route(d: Dancer, to: P2) {
    const path = this.nav.findPath({ x: d.pos.x, z: d.pos.z, l: d.level }, to) ?? [{ x: d.pos.x, z: d.pos.z, l: d.level }, to];
    d.path = path; d.pi = 1;
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
    d.speed = len > 13 && path.every((p) => (p.l ?? 0) === d.level) ? RUN : WALK;      // nobody runs up the stairs
    if (d.state !== 'leave') d.state = 'walk';
    d.stuck = 0; d.ghost = 0;
    this.attach(d);
    d.ch!.play(d.speed === RUN ? 'run' : 'walk', 0.3);
  }

  private arrive(d: Dancer, instant = false) {
    const s = d.slot;
    if (d.state === 'leave' || !s) { this.remove(d); return; }
    if (s.seat) {
      d.state = 'settle'; d.settleT = instant ? 1 : 0; d.settleFrom.copy(d.pos);
      d.yaw = s.yaw;
      if (instant) d.shownYaw = d.yaw;
      d.ch?.play('sit', 0.5);
      return;
    }
    d.state = d.m.sitting ? 'sit' : 'dance';
    d.yaw = d.partner && d.duoRole && d.partner.slot ? Math.atan2(d.partner.slot.x - s.x, d.partner.slot.z - s.z) : s.yaw;
    if (s.compact && !COMPACT_DANCES.includes(d.dance)) d.dance = this.chooseDance(undefined, true);
    if (d.partner && d.duoRole && d.partner.state === 'dance') for (const q of [d, d.partner]) { q.phase = 0; if (q.ch) q.ch.phase = 0; q.ch?.play(q.clip, 0.4); }
    else d.ch?.play(d.clip, 0.4);
    if (instant) d.shownYaw = d.yaw;
    this.onArrive?.(d);
  }

  private remove(d: Dancer) {
    this.unpair(d);
    this.nav.release(d.slot);
    this.detach(d);
    this.gpu.freeLook(d.lookRow);
    d.lookRow = -1;
    this.dancers.delete(d.m.id);
  }

  private unpair(d: Dancer) {
    const p = d.partner;
    d.partner = null; d.duoRole = null;
    if (p) { p.partner = null; p.duoRole = null; if (p.state === 'dance') p.ch?.play(p.clip, 0.4); }
  }

  // ------------------------------------------------------------------ actions
  private chooseDance(arg: string | undefined, compact: boolean): string {
    const ok = (n: string) => !compact || COMPACT_DANCES.includes(n);
    if (arg) {
      if (DANCES.includes(arg) && ok(arg)) return arg;
      const a = (DANCE_ALIASES[arg] ?? []).filter(ok);
      if (a.length) return pick(a);
    }
    const ev = this.event;
    if (ev?.special === 'choreo' && !compact) return pick(ev.dances);
    const evd = ev ? ev.dances.filter(ok) : [];
    if (evd.length && Math.random() < 0.7) return pick(evd);
    return pick(compact ? COMPACT_DANCES : DANCES);
  }

  action(id: string, kind: ActionKind, arg: string | undefined, beats: number) {
    const d = this.dancers.get(id);
    if (!d || d.state === 'leave' || d.state === 'outside') return;
    const map: Partial<Record<ActionKind, string>> = { shuffle: 'shuffle', breakdance: 'breakdance', robot: 'robot' };
    const compact = !!d.slot?.compact;
    if (kind === 'dance' || map[kind]) {
      this.unpair(d);
      d.dance = this.chooseDance(map[kind] ?? arg, compact);
      d.overrideUntil = beats + 48;
      d.nextSwitch = beats + 48 + Math.random() * 32;
      d.heroUntil = this.time + 6;
      if (d.state === 'dance') { this.attach(d); d.ch!.play(d.dance, 0.4); }
    } else if (kind === 'special') {
      d.dance = compact ? 'hands_up' : 'special'; d.overrideUntil = beats + 32; d.nextSwitch = beats + 32;
      d.heroUntil = this.time + 10;
      if (d.state === 'dance') { this.attach(d); d.ch!.play(d.dance, 0.4); }
    } else if ((kind === 'jump' || kind === 'wave' || kind === 'clap') && d.state === 'dance') {
      // gestures need the detailed skeleton: the viewer becomes a hero for the gesture
      d.heroUntil = this.time + 6;
      this.attach(d);
      d.ch!.playOnce(compact && kind === 'jump' ? 'clap' : kind, 0.2);
    }
  }

  duo(a: string, b: string, beats: number) {
    const A = this.dancers.get(a), B = this.dancers.get(b);
    if (!A || !B || A.state === 'leave' || B.state === 'leave' || A.state === 'outside' || B.state === 'outside') return;
    this.unpair(A); this.unpair(B);
    this.nav.release(A.slot); this.nav.release(B.slot); A.slot = B.slot = null;
    const pair = this.nav.reservePair(a, b);
    if (!pair) { this.reserveFor(A, 'floor', false); this.reserveFor(B, 'floor', false); this.goToSlot(A); this.goToSlot(B); return; }
    const [sa, sb] = pair, dir = Math.sign(sb.x - sa.x);
    A.slot = { ...sa, x: sa.x + dir * 0.1 }; B.slot = { ...sb, x: sb.x - dir * 0.1 };
    (A.slot as Slot & { src?: Slot }).src = sa; (B.slot as Slot & { src?: Slot }).src = sb;
    A.partner = B; B.partner = A; A.duoRole = 'lead'; B.duoRole = 'follow';
    A.overrideUntil = B.overrideUntil = beats + 64;
    this.goToSlot(A); this.goToSlot(B);
  }

  gold(id: string, seconds: number, now: number) { const d = this.dancers.get(id); if (d) d.goldUntil = now + seconds; }
  clearGold() { for (const d of this.dancers.values()) d.goldUntil = 0; }
  position(id: string): THREE.Vector3 | null { const d = this.dancers.get(id); return d && d.state !== 'leave' && d.state !== 'outside' ? d.pos : null; }
  headHeight(id: string) { return this.dancers.get(id)?.headY ?? 1.7; }

  setEvent(ev: ClubEvent, beats: number) {
    this.event = ev;
    for (const d of this.dancers.values()) if (beats >= d.overrideUntil) d.nextSwitch = beats + (ev.special === 'choreo' ? 0 : Math.random() * 16);
  }

  /** Centre of mass of the people dancing on the LED floor (camera target). */
  center(out: THREE.Vector3) {
    let n = 0; out.set(0, 0, 0);
    for (const d of this.dancers.values()) if (d.state === 'dance' && d.level === 0 && d.m.zone === 'floor' && !d.slot?.compact) { out.add(d.pos); n++; }
    return n ? out.multiplyScalar(1 / n) : out.set(0, 0, -2.5);
  }

  random(filter?: (d: Dancer) => boolean): Dancer | null {
    const list = [...this.dancers.values()].filter((d) => d.state === 'dance' && (!filter || filter(d)));
    return list.length ? pick(list) : null;
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, t: number, a: AudioFrame, camera: THREE.Camera) {
    this.time = t;
    const prof = this.engine.profile, bps = a.bpm / 60;
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    const beat = a.beatCount, newBeat = beat !== this.lastBeat;
    this.lastBeat = beat;
    if (newBeat && this.event?.special === 'battle' && beat % 32 === 0) this.battle(a.beats);

    // door throttle: let people in while fewer than MAX_WALKERS are moving
    this.walkers = 0;
    for (const d of this.dancers.values()) if (d.state === 'walk' || d.state === 'leave') this.walkers++;
    if (this.walkers < MAX_WALKERS) for (const d of this.dancers.values()) {
      if (d.state !== 'outside') continue;
      if (!d.slot) this.reserveFor(d, d.m.zone, d.m.sitting);
      if (!d.slot) continue;
      this.goToSlot(d);
      if (++this.walkers >= MAX_WALKERS) break;
    }

    // spatial hash for local avoidance (only needed while somebody walks)
    this.hash.clear();
    if (this.walkers) for (const d of this.dancers.values()) {
      if (d.state === 'outside') continue;
      const k = ((Math.floor(d.pos.x) + 64) * 128 + Math.floor(d.pos.z) + 64) * 2 + d.level;
      let l = this.hash.get(k);
      if (!l) this.hash.set(k, (l = []));
      l.push(d);
    }

    const camPos = camera.position;
    let vis = 0;
    for (const d of this.dancers.values()) {
      if (d.state === 'outside') { d.visible = false; continue; }
      if (d.state === 'walk' || d.state === 'leave') {
        for (let r = dt; r > 1e-4 && (d.state === 'walk' || d.state === 'leave') && this.dancers.has(d.m.id); r -= 0.05) this.walk(d, Math.min(r, 0.05));
        if (!this.dancers.has(d.m.id)) continue;
      } else if (d.state === 'settle') {
        d.settleT = Math.min(1, d.settleT + dt / 0.7);
        const s = d.slot!, k = d.settleT * d.settleT * (3 - 2 * d.settleT);
        d.pos.set(THREE.MathUtils.lerp(d.settleFrom.x, s.x, k), THREE.MathUtils.lerp(d.settleFrom.y, s.y, k), THREE.MathUtils.lerp(d.settleFrom.z, s.z, k));
        if (d.settleT >= 1) { d.state = 'sit'; this.onArrive?.(d); }
      } else if (d.state === 'dance' && newBeat && a.beats >= d.nextSwitch && !d.partner && !d.ch?.busy && beat % 4 === 0) {
        d.nextSwitch = a.beats + 32 + Math.floor(Math.random() * 6) * 8;
        if (a.beats >= d.overrideUntil) { d.dance = this.chooseDance(undefined, !!d.slot?.compact); d.ch?.play(d.dance, 0.6); }
      }
      let dy = d.yaw - d.shownYaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      d.shownYaw += dy * Math.min(1, dt * 7);
      d.gold += ((t < d.goldUntil ? 1 : 0) - d.gold) * Math.min(1, dt * 4);
      this.sphere.center.set(d.pos.x, d.pos.y + 0.95, d.pos.z);
      d.visible = this.frustum.intersectsSphere(this.sphere);
      d.dist = camPos.distanceTo(this.sphere.center);
      if (d.visible) vis++;
    }
    this.visibleCount = vis;

    // hero selection a few times per second: forced heroes + the nearest visible viewers
    this.rankT -= dt;
    if (this.rankT <= 0) { this.rankT = 0.3; this.chooseHeroes(prof.heroes); }

    // heroes: detailed skinned characters with animation LOD
    const many = this.dancers.size > 150;
    this.heroCount = this.heroes.size;
    for (const d of this.heroes) {
      const ch = d.ch!;
      ch.group.position.copy(d.pos);
      ch.group.rotation.y = d.shownYaw;
      ch.uniforms.uGold.value = d.gold;
      const k = many ? 0.75 : 1;
      const lod = d.dist < prof.lod[0] * k ? 0 : d.dist < prof.lod[1] * k ? 1 : 2;
      ch.setLod(lod, prof.shadows > 0);
      const moving = d.state === 'walk' || d.state === 'leave' || d.state === 'settle';
      const hz = !d.visible ? 5 : lod === 0 ? 1000 : lod === 1 ? Math.max(30, prof.animFar) : prof.animFar;
      d.animAcc += dt;
      if (d.animAcc >= 1 / hz - 0.004 || (moving && d.visible)) { ch.skip = false; ch.update(d.animAcc, a.beats, bps, d.speed); d.animAcc = 0; }
      else ch.skip = true;
      if (ch.tag) ch.tag.visible = false;
    }
    // name tags on the nearest heroes only
    if (this.showNames) {
      const near = [...this.heroes].filter((d) => d.visible && d.dist < 32 && d.dist > 3.2).sort((x, y) => x.dist - y.dist);
      for (let j = 0; j < Math.min(prof.nameTags, near.length); j++) if (near[j].ch?.tag) near[j].ch!.tag!.visible = true;
    }

    // everyone else: one instanced draw call per archetype; contact shadows for all
    this.gpu.begin(a.beats);
    let si = 0;
    const sm = this.shadows.instanceMatrix.array as Float32Array;
    for (const d of this.dancers.values()) {
      if (d.state === 'outside' || !d.visible) continue;
      const sc = 0.95 * d.scale;
      if (si < 2048) {
        const o = si * 16;
        sm[o] = sc; sm[o + 1] = 0; sm[o + 2] = 0; sm[o + 3] = 0; sm[o + 4] = 0; sm[o + 5] = 1; sm[o + 6] = 0; sm[o + 7] = 0;
        sm[o + 8] = 0; sm[o + 9] = 0; sm[o + 10] = sc; sm[o + 11] = 0; sm[o + 12] = d.pos.x; sm[o + 13] = d.pos.y + 0.035; sm[o + 14] = d.pos.z; sm[o + 15] = 1;
        si++;
      }
      if (d.ch) continue;
      const clip = d.clip;
      this.gpu.push({ arch: d.look.arch, lookRow: d.lookRow, clip, phase: clip.startsWith('choreo') || clip.startsWith('duo') ? 0 : d.phase, gold: d.gold, x: d.pos.x, y: d.pos.y, z: d.pos.z, yaw: d.shownYaw, scale: d.scale });
    }
    this.gpu.end();
    this.shadows.count = si;
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  private chooseHeroes(budget: number) {
    const forced: Dancer[] = [], rest: Dancer[] = [];
    for (const d of this.dancers.values()) {
      if (d.state === 'outside') continue;
      if (this.mustBeHero(d)) forced.push(d); else if (d.visible) rest.push(d);
    }
    rest.sort((x, y) => x.dist - y.dist);
    const want = new Set<Dancer>(forced);
    const free = Math.max(0, budget - forced.length);
    for (let i = 0; i < Math.min(free, rest.length); i++) want.add(rest[i]);
    // hysteresis: current heroes slightly beyond the cut-off keep their detail (no flicker at the boundary)
    const cut = free > 0 && rest.length ? rest[Math.min(free, rest.length) - 1].dist : 0;
    for (const d of this.heroes) if (!want.has(d) && d.visible && d.dist < cut * 1.12 && want.size < budget * 1.15) want.add(d);
    for (const d of [...this.heroes]) if (!want.has(d)) this.detach(d);
    for (const d of want) if (!d.ch) this.attach(d);
  }

  private walk(d: Dancer, dt: number) {
    const wp = d.path[d.pi];
    if (!wp) { this.arrive(d); return; }
    if ((wp.l ?? 0) !== d.level) { d.level = wp.l ?? 0; d.pi++; return; }          // stair landing: change level
    let dx = wp.x - d.pos.x, dz = wp.z - d.pos.z;
    const dist = Math.hypot(dx, dz), last = d.pi === d.path.length - 1;
    if (dist < (last ? 0.06 : 0.3)) {
      d.pi++;
      if (d.pi >= d.path.length) { if (!last || dist < 0.06) { d.pos.x = wp.x; d.pos.z = wp.z; } this.arrive(d); }
      return;
    }
    dx /= dist; dz /= dist;
    const v = Math.min(d.speed, last ? Math.max(0.5, dist * 4) : d.speed);
    let nx = d.pos.x + dx * v * dt, nz = d.pos.z + dz * v * dt;
    if (d.ghost <= 0) {
      const cx = Math.floor(nx), cz = Math.floor(nz);
      for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
        const l = this.hash.get(((cx + ox + 64) * 128 + cz + oz + 64) * 2 + d.level);
        if (!l) continue;
        for (const o of l) {
          if (o === d || o === d.partner) continue;
          const ex = nx - o.pos.x, ez = nz - o.pos.z, e = Math.hypot(ex, ez), min = RADIUS * 2;
          if (e >= min || e < 1e-4) continue;
          if (last && dist < 0.8) continue;
          const push = (min - e) * (o.state === 'walk' || o.state === 'leave' ? 0.5 : 1);
          const side = Math.sign(ex * dz - ez * dx) || 1;
          nx += (ex / e) * push * 0.6 + dz * side * push * 0.4;
          nz += (ez / e) * push * 0.6 - dx * side * push * 0.4;
        }
      }
      if (!this.nav.walkable(nx, nz, d.level)) { nx = d.pos.x + dx * v * dt; nz = d.pos.z + dz * v * dt; }
    } else d.ghost -= dt;
    const moved = Math.hypot(nx - d.pos.x, nz - d.pos.z);
    d.pos.x = nx; d.pos.z = nz;
    d.pos.y += (groundY(nx, nz, d.level) - d.pos.y) * Math.min(1, dt * 10);
    d.yaw = Math.atan2(dx, dz);
    d.stuck = moved < v * dt * 0.25 ? d.stuck + dt : Math.max(0, d.stuck - dt);
    if (d.stuck > 1.2) {
      d.stuck = 0;
      const end = d.path[d.path.length - 1];
      const p = this.nav.findPath({ x: d.pos.x, z: d.pos.z, l: d.level }, end);
      if (p && p.length > 1) { d.path = p; d.pi = 1; }
      d.ghost = 1.0;      // squeeze through a packed crowd instead of standing still (never teleports)
    }
  }

  private battle(beats: number) {
    const a = this.random((d) => d.m.zone === 'floor' && !d.partner && !d.slot?.compact), b = this.random((d) => d.m.zone === 'floor' && !d.partner && !d.slot?.compact && d !== a);
    for (const d of [a, b]) if (d) { d.dance = pick(['break_floor', 'break_toprock', 'shuffle_t', 'robot_a']); d.overrideUntil = beats + 30; d.nextSwitch = beats + 30; d.heroUntil = this.time + 20; this.attach(d); d.ch!.play(d.dance, 0.4); }
    this.battleUntil = beats + 30;
    this.battlers = [a, b].filter(Boolean) as Dancer[];
  }
  get battleActive() { return this.battlers.length > 0 && this.lastBeat < this.battleUntil; }
}
