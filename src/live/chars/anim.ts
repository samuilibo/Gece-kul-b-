// Procedural animation: "puppet" poses -> two-bone IK -> baked AnimationClips.
// Every motion in this project is authored here in code (no third-party animation data).
import * as THREE from 'three';
import type { Archetype } from './assets.ts';

export type V3 = [number, number, number];
export interface ArmSpec {
  h: V3;            // hand target relative to the shoulder, in arm lengths: [outward, up, forward] in chest space
  pole?: V3;        // elbow hint direction [outward, up, forward]
  wrist?: V3;       // extra wrist rotation (euler)
}
export interface LegSpec {
  p?: V3;           // ankle offset from the neutral stance (metres): [outward, lift, forward]
  yaw?: number;     // toe-out angle (rad)
  pitch?: number;   // heel raise (rad)
  knee?: number;    // knee pole yaw offset (outward +)
}
export interface Pose {
  hip?: V3;         // pelvis offset (m): +x = character's left, +y up, +z forward
  hipRot?: V3;      // [pitch (forward +), yaw (to the left +), roll]
  spine?: V3;       // total bend spread over the three spine bones
  chest?: V3;
  neck?: V3;
  head?: V3;
  lArm?: ArmSpec; rArm?: ArmSpec;
  lLeg?: LegSpec; rLeg?: LegSpec;
  shrug?: number;
}
export type PoseFn = (t: number) => Pose;
export interface ClipDef { beats: number; fn: PoseFn; loop?: boolean; samples?: number; unit?: 'beat' | 'cycle'; stride?: number }

export const REST_ARM: ArmSpec = { h: [0.2, -0.93, 0.1] };
const ANIMATED = ['pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head', 'clavicle_l', 'clavicle_r', 'upperarm_l', 'upperarm_r',
  'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r', 'foot_l', 'foot_r', 'ball_l', 'ball_r'];

const _e = new THREE.Euler();
const euler = (v: V3 | undefined, out: THREE.Quaternion, k = 1) => (v ? out.setFromEuler(_e.set(v[0] * k, v[1] * k, v[2] * k, 'YXZ')) : out.identity());
const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion() };

/** Rig constants derived from an archetype's rest pose. */
export class Rig {
  rest: Map<string, THREE.Vector3>;
  local = new Map<string, THREE.Vector3>();
  stance: number;
  footYaw0: number;
  ballDist: number;
  armLen: number;
  constructor(public arch: Archetype) {
    this.rest = arch.rest;
    for (const b of arch.bones) this.local.set(b.name, b.pos);
    this.stance = this.rest.get('thigh_l')!.x * 0.95;
    const d = tmp.a.copy(this.rest.get('ball_l')!).sub(this.rest.get('foot_l')!);
    this.footYaw0 = Math.atan2(d.x, d.z);
    this.ballDist = Math.hypot(d.x, d.z);
    this.armLen = this.rest.get('upperarm_l')!.distanceTo(this.rest.get('lowerarm_l')!) + this.rest.get('lowerarm_l')!.distanceTo(this.rest.get('hand_l')!);
  }
}

export interface Solved { pelvis: THREE.Vector3; q: Map<string, THREE.Quaternion> }

/** Solves one pose into local bone rotations. Feet are IK targets, so planted feet never slide. */
export function solve(rig: Rig, pose: Pose, out: Solved): Solved {
  const R = rig.rest, L = rig.local;
  const wq = new Map<string, THREE.Quaternion>();     // world rotations
  const wp = new Map<string, THREE.Vector3>();        // world positions
  const set = (name: string, parent: string, localQ: THREE.Quaternion) => {
    const pq = wq.get(parent)!;
    wp.set(name, L.get(name)!.clone().applyQuaternion(pq).add(wp.get(parent)!));
    wq.set(name, pq.clone().multiply(localQ));
    out.q.get(name)!.copy(localQ);
  };
  // ---- pelvis (with reach limiting so that planted feet stay planted)
  const hip = pose.hip ?? [0, 0, 0];
  const pelvis = out.pelvis.copy(R.get('pelvis')!).add(tmp.a.set(hip[0], hip[1] + 0.004, hip[2]));
  const qPelvis = euler(pose.hipRot, new THREE.Quaternion());
  const feet = (['l', 'r'] as const).map((s) => {
    const side = s === 'l' ? 1 : -1;
    const spec = (s === 'l' ? pose.lLeg : pose.rLeg) ?? {};
    const p = spec.p ?? [0, 0, 0];
    const pitch = spec.pitch ?? 0;
    const ankleRest = R.get(`foot_${s}`)!;
    const target = new THREE.Vector3(side * (rig.stance + p[0]), ankleRest.y + p[1] + Math.sin(Math.max(0, pitch)) * rig.ballDist, p[2]);
    return { s, side, spec, target, pitch };
  });
  for (let iter = 0; iter < 2; iter++) {
    for (const f of feet) {
      const hj = tmp.a.copy(L.get(`thigh_${f.s}`)!).applyQuaternion(qPelvis).add(pelvis);
      const reach = (R.get(`thigh_${f.s}`)!.distanceTo(R.get(`calf_${f.s}`)!) + R.get(`calf_${f.s}`)!.distanceTo(R.get(`foot_${f.s}`)!)) * 0.996;
      const dh2 = (hj.x - f.target.x) ** 2 + (hj.z - f.target.z) ** 2;
      const maxY = f.target.y + Math.sqrt(Math.max(reach * reach - dh2, 0.0025));
      if (hj.y > maxY) pelvis.y -= hj.y - maxY;
    }
  }
  wp.set('Root', new THREE.Vector3());
  wq.set('Root', new THREE.Quaternion());
  wp.set('pelvis', pelvis.clone());
  wq.set('pelvis', qPelvis);
  out.q.get('pelvis')!.copy(qPelvis);
  // ---- spine, neck, head
  const third = euler(pose.spine, new THREE.Quaternion(), 1 / 3);
  set('spine_01', 'pelvis', third);
  set('spine_02', 'spine_01', third);
  set('spine_03', 'spine_02', third.clone().multiply(euler(pose.chest, tmp.q)));
  const nq = euler(pose.neck, new THREE.Quaternion()).multiply(euler(pose.head, tmp.q, 0.4));
  set('neck_01', 'spine_03', nq);
  set('head', 'neck_01', euler(pose.head, new THREE.Quaternion(), 0.6));
  const chestQ = wq.get('spine_03')!;
  // ---- arms
  for (const s of ['l', 'r'] as const) {
    const side = s === 'l' ? 1 : -1;
    const spec = (s === 'l' ? pose.lArm : pose.rArm) ?? REST_ARM;
    const shrug = pose.shrug ?? 0;
    set(`clavicle_${s}`, 'spine_03', new THREE.Quaternion().setFromEuler(_e.set(0, 0, side * shrug, 'YXZ')));
    const clavQ = wq.get(`clavicle_${s}`)!;
    const S = L.get(`upperarm_${s}`)!.clone().applyQuaternion(clavQ).add(wp.get(`clavicle_${s}`)!);
    const rU = tmp.a.copy(R.get(`lowerarm_${s}`)!).sub(R.get(`upperarm_${s}`)!);
    const l1 = rU.length();
    const dirU0 = rU.clone().normalize();
    const rL = tmp.b.copy(R.get(`hand_${s}`)!).sub(R.get(`lowerarm_${s}`)!);
    const l2 = rL.length();
    const dirL0 = rL.clone().normalize();
    const h = spec.h;
    const T = new THREE.Vector3(side * h[0], h[1], h[2]).multiplyScalar(rig.armLen).applyQuaternion(chestQ).add(S);
    const to = T.clone().sub(S);
    const d = THREE.MathUtils.clamp(to.length(), Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.998);
    to.normalize();
    const pl = spec.pole ?? [0.55, -0.6, -0.55];
    const pole = new THREE.Vector3(side * pl[0], pl[1], pl[2]).applyQuaternion(chestQ);
    pole.addScaledVector(to, -pole.dot(to));
    if (pole.lengthSq() < 1e-6) pole.set(side, 0, 0);
    pole.normalize();
    const aLen = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const hLen = Math.sqrt(Math.max(l1 * l1 - aLen * aLen, 0));
    const E = S.clone().addScaledVector(to, aLen).addScaledVector(pole, hLen);
    const Tc = S.clone().addScaledVector(to, d);
    const qU = new THREE.Quaternion().setFromUnitVectors(dirU0.clone().applyQuaternion(clavQ), E.clone().sub(S).normalize()).multiply(clavQ);
    const qL = new THREE.Quaternion().setFromUnitVectors(dirL0.clone().applyQuaternion(qU), Tc.clone().sub(E).normalize()).multiply(qU);
    out.q.get(`upperarm_${s}`)!.copy(clavQ).invert().multiply(qU);
    out.q.get(`lowerarm_${s}`)!.copy(qU).invert().multiply(qL);
    const w = spec.wrist;
    out.q.get(`hand_${s}`)!.setFromEuler(_e.set(w ? w[0] : 0, w ? side * w[1] : 0, w ? side * w[2] : 0, 'YXZ'));
  }
  // ---- legs
  for (const f of feet) {
    const s = f.s, side = f.side;
    const H = L.get(`thigh_${s}`)!.clone().applyQuaternion(qPelvis).add(wp.get('pelvis')!);
    const rT = tmp.a.copy(R.get(`calf_${s}`)!).sub(R.get(`thigh_${s}`)!);
    const l1 = rT.length();
    const dirT0 = rT.clone().normalize();
    const rC = tmp.b.copy(R.get(`foot_${s}`)!).sub(R.get(`calf_${s}`)!);
    const l2 = rC.length();
    const dirC0 = rC.clone().normalize();
    const to = f.target.clone().sub(H);
    const d = THREE.MathUtils.clamp(to.length(), Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.999);
    to.normalize();
    const yaw = side * ((f.spec.yaw ?? 0.14));
    const ky = yaw + side * (f.spec.knee ?? 0.08);
    const pole = new THREE.Vector3(Math.sin(ky), 0.05, Math.cos(ky));
    pole.addScaledVector(to, -pole.dot(to)).normalize();
    const aLen = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const hLen = Math.sqrt(Math.max(l1 * l1 - aLen * aLen, 0));
    const K = H.clone().addScaledVector(to, aLen).addScaledVector(pole, hLen);
    const A = H.clone().addScaledVector(to, d);
    const qT = new THREE.Quaternion().setFromUnitVectors(dirT0.clone().applyQuaternion(qPelvis), K.clone().sub(H).normalize()).multiply(qPelvis);
    const qC = new THREE.Quaternion().setFromUnitVectors(dirC0.clone().applyQuaternion(qT), A.clone().sub(K).normalize()).multiply(qT);
    out.q.get(`thigh_${s}`)!.copy(qPelvis).invert().multiply(qT);
    out.q.get(`calf_${s}`)!.copy(qT).invert().multiply(qC);
    // the foot is oriented in world space: flat on the floor unless a heel raise is requested
    const qF = new THREE.Quaternion().setFromEuler(_e.set(f.pitch, yaw - side * rig.footYaw0, 0, 'YXZ'));
    out.q.get(`foot_${s}`)!.copy(qC).invert().multiply(qF);
    out.q.get(`ball_${s}`)!.setFromEuler(_e.set(-Math.max(0, f.pitch) * 0.9, 0, 0, 'YXZ'));
  }
  return out;
}

export function newSolved(): Solved {
  const q = new Map<string, THREE.Quaternion>();
  for (const n of ANIMATED) q.set(n, new THREE.Quaternion());
  return { pelvis: new THREE.Vector3(), q };
}

/** Samples a pose function into an AnimationClip. Clip time is measured in beats (or gait cycles). */
export function bake(rig: Rig, name: string, def: ClipDef): THREE.AnimationClip {
  const per = def.samples ?? 12;
  const n = Math.round(def.beats * per);
  const times = new Float32Array(n + 1);
  const pos = new Float32Array((n + 1) * 3);
  const quats = new Map<string, Float32Array>();
  for (const b of ANIMATED) quats.set(b, new Float32Array((n + 1) * 4));
  const s = newSolved();
  const prev = new Map<string, THREE.Quaternion>();
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * def.beats;
    times[i] = t;
    solve(rig, def.fn(def.loop === false ? t : i === n ? 0 : t), s);
    s.pelvis.toArray(pos, i * 3);
    for (const b of ANIMATED) {
      const q = s.q.get(b)!;
      const p = prev.get(b);
      if (p && p.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);      // keep hemispheres continuous
      (p ?? prev.set(b, new THREE.Quaternion()).get(b)!).copy(q);
      q.toArray(quats.get(b)!, i * 4);
    }
  }
  const tracks: THREE.KeyframeTrack[] = [new THREE.VectorKeyframeTrack('pelvis.position', times as unknown as number[], pos as unknown as number[])];
  for (const b of ANIMATED) tracks.push(new THREE.QuaternionKeyframeTrack(`${b}.quaternion`, times as unknown as number[], quats.get(b)! as unknown as number[]));
  const clip = new THREE.AnimationClip(name, def.beats, tracks);
  clip.userData = { unit: def.unit ?? 'beat', loop: def.loop !== false, stride: def.stride ?? 0 };
  return clip;
}

/** Relaxed finger curl applied once to the bind pose (fingers have no animation tracks). */
export function relaxHands(rig: Rig, bones: Map<string, THREE.Bone>, amount = 0.32) {
  for (const s of ['l', 'r'] as const) {
    const side = s === 'l' ? 1 : -1;
    const hand = rig.rest.get(`hand_${s}`)!;
    const n = tmp.a.copy(rig.rest.get(`index_01_${s}`)!).sub(hand).cross(tmp.b.copy(rig.rest.get(`pinky_01_${s}`)!).sub(hand)).normalize();
    if (n.y - side * n.x > 0) n.negate();      // palms face down / inward in the rest pose
    for (const f of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
      for (let k = 1; k <= 3; k++) {
        const name = `${f}_0${k}_${s}`;
        const next = rig.rest.get(k < 3 ? `${f}_0${k + 1}_${s}` : name)!;
        const dir = k < 3 ? tmp.c.copy(next).sub(rig.rest.get(name)!).normalize() : tmp.c.copy(rig.rest.get(name)!).sub(rig.rest.get(`${f}_02_${s}`)!).normalize();
        const axis = new THREE.Vector3().crossVectors(dir, n).normalize();
        bones.get(name)?.quaternion.setFromAxisAngle(axis, amount * (f === 'thumb' ? 0.4 : 1) * (k === 1 ? 0.7 : 1));
      }
    }
  }
}
