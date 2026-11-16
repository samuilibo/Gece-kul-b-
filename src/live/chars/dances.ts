// Original motion library. Each clip is a pure function time(beats) -> Pose.
import type * as THREE from 'three';
import type { Archetype } from './assets.ts';
import { REST_ARM, Rig, bake, type ArmSpec, type ClipDef, type LegSpec, type Pose, type V3 } from './anim.ts';

const TAU = Math.PI * 2;
const sin = (x: number) => Math.sin(TAU * x);
const cos = (x: number) => Math.cos(TAU * x);
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ss = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, w: number) => a + (b - a) * w;
const lv = (a: V3, b: V3, w: number): V3 => [lerp(a[0], b[0], w), lerp(a[1], b[1], w), lerp(a[2], b[2], w)];
const mod = (x: number, m: number) => ((x % m) + m) % m;
/** 1 on the beat, 0 on the off-beat. */
const down = (t: number) => 0.5 + 0.5 * cos(t);
/** Smooth 0..1 gate that is 1 inside [a, b] (period p), with soft edges. */
const gate = (t: number, a: number, b: number, p: number, e = 0.3) => { const u = mod(t, p); return ss(a - e, a, u) * (1 - ss(b - e, b, u)) + (a - e < 0 ? ss(p + a - e, p + a, u) : 0); };

const Z3: V3 = [0, 0, 0];
const arm = (h: V3, pole?: V3, wrist?: V3): ArmSpec => ({ h, pole, wrist });
const mixArm = (a: ArmSpec | undefined, b: ArmSpec | undefined, w: number): ArmSpec => {
  const A = a ?? REST_ARM, B = b ?? REST_ARM;
  const dp: V3 = [0.55, -0.6, -0.55];
  return { h: lv(A.h, B.h, w), pole: lv(A.pole ?? dp, B.pole ?? dp, w), wrist: lv(A.wrist ?? Z3, B.wrist ?? Z3, w) };
};
const mixLeg = (a: LegSpec | undefined, b: LegSpec | undefined, w: number): LegSpec => {
  const A = a ?? {}, B = b ?? {};
  return { p: lv(A.p ?? Z3, B.p ?? Z3, w), yaw: lerp(A.yaw ?? 0.14, B.yaw ?? 0.14, w), pitch: lerp(A.pitch ?? 0, B.pitch ?? 0, w), knee: lerp(A.knee ?? 0.08, B.knee ?? 0.08, w) };
};
export function mix(a: Pose, b: Pose, w: number): Pose {
  if (w <= 0) return a;
  if (w >= 1) return b;
  const v = (k: 'hip' | 'hipRot' | 'spine' | 'chest' | 'neck' | 'head') => lv(a[k] ?? Z3, b[k] ?? Z3, w);
  return {
    hip: v('hip'), hipRot: v('hipRot'), spine: v('spine'), chest: v('chest'), neck: v('neck'), head: v('head'),
    lArm: mixArm(a.lArm, b.lArm, w), rArm: mixArm(a.rArm, b.rArm, w), lLeg: mixLeg(a.lLeg, b.lLeg, w), rLeg: mixLeg(a.rLeg, b.rLeg, w),
    shrug: lerp(a.shrug ?? 0, b.shrug ?? 0, w),
  };
}
const flip = (v: V3 | undefined): V3 | undefined => (v ? [v[0], -v[1], -v[2]] : undefined);
/** Left/right mirror image of a pose. */
export function mirror(p: Pose): Pose {
  return {
    hip: p.hip ? [-p.hip[0], p.hip[1], p.hip[2]] : undefined, hipRot: flip(p.hipRot), spine: flip(p.spine), chest: flip(p.chest),
    neck: flip(p.neck), head: flip(p.head), lArm: p.rArm, rArm: p.lArm, lLeg: p.rLeg, rLeg: p.lLeg, shrug: p.shrug,
  };
}

interface FK { t: number; x?: number; z?: number; yaw?: number; pitch?: number; hop?: boolean }
/** Foot stays planted at each key; it only travels (lifted) during the window right before the next key. */
function footSeq(t: number, period: number, keys: FK[], lift = 0.07, move = 0.42): LegSpec {
  const u = mod(t, period);
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k++) if (keys[k].t <= u) i = k;
  if (u < keys[0].t) i = keys.length - 1;
  const cur = keys[i], nxt = keys[(i + 1) % keys.length];
  let tn = nxt.t;
  if (tn <= cur.t && (i + 1) % keys.length === 0) tn += period;
  let uu = u;
  if (u < keys[0].t) uu += period;
  const w = ss(0, 1, (uu - (tn - move)) / move);
  const a: V3 = [cur.x ?? 0, 0, cur.z ?? 0], b: V3 = [nxt.x ?? 0, 0, nxt.z ?? 0];
  const moved = Math.hypot(a[0] - b[0], a[2] - b[2]) > 0.01 || !!nxt.hop;
  const p = lv(a, b, w);
  p[1] = moved ? lift * Math.sin(Math.PI * clamp((uu - (tn - move)) / move)) : 0;
  return { p, yaw: lerp(cur.yaw ?? 0.14, nxt.yaw ?? 0.14, w), pitch: lerp(cur.pitch ?? 0, nxt.pitch ?? 0, w) + (moved ? 0.25 * Math.sin(Math.PI * clamp((uu - (tn - move)) / move)) : 0) };
}
const stepTouchL = (t: number, wdt = 0.14) => footSeq(t, 4, [{ t: 0, x: wdt }, { t: 3, x: 0.02 }]);
const stepTouchR = (t: number, wdt = 0.14) => footSeq(t, 4, [{ t: 1, x: 0.02 }, { t: 2, x: wdt }]);
const bentL = (t: number, amp = 0.08): ArmSpec => arm([0.28, -0.42 + amp * sin(t + 0.25), 0.42]);
const bentR = (t: number, amp = 0.08): ArmSpec => arm([0.28, -0.42 - amp * sin(t + 0.25), 0.42]);

// ----------------------------------------------------------------------------- dances
const idle = (t: number): Pose => ({
  hip: [0.018 * sin(t / 4), -0.02 - 0.008 * cos(t / 2), 0], spine: [0.02, 0, -0.02 * sin(t / 4)], head: [0.02 * cos(t / 2), 0.05 * sin(t / 4 + 0.1), 0],
  lArm: arm([0.2, -0.93, 0.1 + 0.02 * sin(t / 4)]), rArm: arm([0.2, -0.93, 0.1 - 0.02 * sin(t / 4)]),
});

const hiphopBounce = (t: number): Pose => {
  const d = down(t);
  return {
    hip: [0.04 * sin(t / 2), -0.07 - 0.06 * d, 0], hipRot: [0.05, 0, 0], spine: [0.14 + 0.07 * d, 0.1 * sin(t / 2), 0], head: [0.1 * d - 0.03, 0, 0],
    lArm: bentL(t, 0.1), rArm: bentR(t, 0.1), lLeg: { p: [0.07, 0, 0] }, rLeg: { p: [0.07, 0, 0] },
  };
};

const hiphopGroove = (t: number): Pose => {
  const d = down(t), sw = sin((t + 0.5) / 4);
  return {
    hip: [0.09 * sw, -0.07 - 0.04 * d, 0], hipRot: [0.03, 0.08 * sw, -0.05 * sw], spine: [0.1 + 0.05 * d, -0.12 * sw, 0.06 * sw], head: [0.06 * d, 0.1 * sw, 0],
    lArm: arm([0.3, -0.45, 0.3 + 0.22 * sin(t / 2)]), rArm: arm([0.3, -0.45, 0.3 - 0.22 * sin(t / 2)]), lLeg: stepTouchL(t), rLeg: stepTouchR(t),
  };
};

const runningMan = (ph: number): LegSpec => {
  const f = mod(ph, 2);
  if (f < 1) return { p: [0, 0, 0.2 - 0.28 * f], pitch: 0 };
  const v = f - 1;
  return { p: [0, 0.17 * Math.sin(Math.PI * v), -0.08 + 0.28 * ss(0, 1, v)], pitch: 0.55 * Math.sin(Math.PI * v) };
};
const shuffleRun = (t: number): Pose => ({
  hip: [0, -0.06 - 0.03 * cos(t), 0], hipRot: [0.04, 0.1 * sin(t / 2), 0], spine: [0.12, -0.14 * sin(t / 2), 0], head: [0.03, 0, 0],
  lArm: arm([0.24, -0.5, 0.12 - 0.26 * cos(t / 2)]), rArm: arm([0.24, -0.5, 0.12 + 0.26 * cos(t / 2)]),
  lLeg: runningMan(t), rLeg: runningMan(t + 1),
});

const shuffleT = (t: number): Pose => {
  const wl = gate(t, 0, 4, 8, 0.35);                 // 1 = left leg is the standing leg
  const k = 0.5 - 0.5 * cos(t);
  const stand: LegSpec = { p: [0.02, 0, 0], yaw: 0.14 + 0.42 * sin(t), pitch: 0.1 };
  const kick: LegSpec = { p: [0.08 + 0.18 * k, 0.04 + 0.13 * k, 0.03], yaw: 0.3, pitch: 0.3 * k };
  const s = wl * 2 - 1;
  return {
    hip: [0.05 * s, -0.07 - 0.03 * cos(t), 0], hipRot: [0.03, 0.1 * sin(t) * s, 0], spine: [0.1, -0.1 * sin(t) * s, -0.05 * s], head: [0.03, 0, 0],
    lArm: arm([0.3 + 0.15 * k * (1 - wl), -0.45, 0.25 + 0.15 * sin(t)]), rArm: arm([0.3 + 0.15 * k * wl, -0.45, 0.25 - 0.15 * sin(t)]),
    lLeg: mixLeg(kick, stand, wl), rLeg: mixLeg(stand, kick, wl),
  };
};

const breakToprock = (t: number): Pose => {
  const k = 0.5 + 0.5 * cos(t / 2);
  const open: V3 = [0.82, -0.12, 0.18], cross: V3 = [0.08, -0.32, 0.5];
  return {
    hip: [0, -0.08 - 0.04 * cos(t), 0], hipRot: [0.04, 0.12 * cos(t / 4), 0], spine: [0.1, 0.3 * cos(t / 4), 0], head: [0, -0.15 * cos(t / 4), 0],
    lArm: arm(lv(open, cross, k)), rArm: arm(lv(open, cross, k)),
    rLeg: footSeq(t, 4, [{ t: 0, x: -0.2, z: 0.2 }, { t: 1, x: 0.04, z: 0 }], 0.1), lLeg: footSeq(t, 4, [{ t: 2, x: -0.2, z: 0.2 }, { t: 3, x: 0.04, z: 0 }], 0.1),
  };
};

const breakFloor = (t: number): Pose => {
  const dn = ss(0, 0.9, t) * (1 - ss(6, 7, t));
  const beat = Math.floor(t), f = t - beat;
  const kk = dn * Math.sin(Math.PI * f) * (t < 6 ? 1 : 0);
  const leftKicks = beat % 2 === 0 ? 1 : 0;
  const wl = leftKicks ? kk : 0, wr = leftKicks ? 0 : kk;
  const sup: V3 = [0.5, -0.98, -0.3], bal: V3 = [0.55, 0.25, 0.3], crossed: V3 = [0.04, -0.27, 0.36];
  const end = ss(7, 7.4, t);
  return {
    hip: [0.05 * (wr - wl), -0.06 - 0.4 * dn - 0.04 * end * down(t), -0.12 * dn], hipRot: [-0.1 * dn, 0, 0], spine: [0.12 + 0.28 * dn, 0.25 * (wl - wr), 0],
    head: [-0.2 * dn, 0, 0],
    lArm: arm(lv(crossed, lv(bal, sup, leftKicks ? 0 : 1), dn)), rArm: arm(lv(crossed, lv(bal, sup, leftKicks ? 1 : 0), dn)),
    lLeg: { p: [0.07, 0.07 * wl, 0.4 * wl], pitch: 0.4 * dn * (1 - wl) }, rLeg: { p: [0.07, 0.07 * wr, 0.4 * wr], pitch: 0.4 * dn * (1 - wr) },
  };
};

interface RK { l: V3; r: V3; sy?: number; hy?: number; sp?: number; hx?: number; roll?: number }
const ROBOT_POLE: V3 = [0.85, 0.15, -0.3];
function robot(table: RK[]) {
  return (t: number): Pose => {
    const n = table.length, k = Math.floor(mod(t, n)), f = mod(t, n) - k;
    const a = table[(k + n - 1) % n], b = table[k];
    // snap into each pose in the first quarter beat, with a tiny mechanical overshoot
    const w = ss(0, 0.22, f) + 0.06 * Math.sin(Math.PI * clamp(f / 0.4)) * (f < 0.4 ? 1 : 0);
    const g = (x?: number, y?: number) => lerp(x ?? 0, y ?? 0, w);
    return {
      hip: [g(a.hx, b.hx), -0.03, 0], spine: [g(a.sp, b.sp), g(a.sy, b.sy), g(a.roll, b.roll)], head: [0, g(a.hy, b.hy), 0],
      lArm: arm(lv(a.l, b.l, w), ROBOT_POLE), rArm: arm(lv(a.r, b.r, w), ROBOT_POLE), lLeg: { p: [0.05, 0, 0] }, rLeg: { p: [0.05, 0, 0] },
    };
  };
}
const RA: V3 = [0.2, -0.92, 0.1], FWD: V3 = [0.5, 0.0, 0.62], UP90: V3 = [0.45, 0.5, 0.45], TEE: V3 = [0.95, 0.05, 0.02], HI: V3 = [0.3, 0.9, 0.15];
const robotA = robot([
  { l: FWD, r: RA }, { l: FWD, r: FWD }, { l: UP90, r: FWD, hy: 0.5 }, { l: UP90, r: UP90, hy: -0.5 },
  { l: UP90, r: UP90, sy: 0.45 }, { l: UP90, r: UP90, sy: -0.45 }, { l: TEE, r: TEE, sp: 0.25 }, { l: RA, r: RA },
]);
const robotB = robot([
  { l: TEE, r: RA, roll: -0.12, hx: 0.05 }, { l: TEE, r: TEE }, { l: HI, r: TEE, hy: 0.4 }, { l: HI, r: FWD, sy: 0.3 },
  { l: FWD, r: HI, sy: -0.3 }, { l: UP90, r: HI, hy: -0.4, hx: -0.05 }, { l: FWD, r: FWD, sp: 0.3 }, { l: RA, r: UP90, roll: 0.12 },
]);

const freestyleA = (t: number): Pose => {
  const s = sin(t / 2);
  return {
    hip: [0.07 * s, -0.06 - 0.04 * cos(t), 0], hipRot: [0, 0.1 * sin(t / 4), -0.05 * s], spine: [0.05, 0.16 * sin(t / 4), -0.09 * s], head: [0, 0.12 * sin(t / 4), 0.04 * s],
    lArm: arm([0.38 + 0.22 * sin(t / 4), 0.22 + 0.55 * (0.5 + 0.5 * sin(t / 2)), 0.25]),
    rArm: arm([0.38 - 0.22 * sin(t / 4), 0.22 + 0.55 * (0.5 - 0.5 * sin(t / 2)), 0.25]),
    lLeg: { p: [0.05, 0, 0], pitch: 0.36 * Math.max(0, s) }, rLeg: { p: [0.05, 0, 0], pitch: 0.36 * Math.max(0, -s) },
  };
};

const freestyleB = (t: number): Pose => {
  const up: V3 = [0.3, 0.6, 0.2], lo: V3 = [0.26, -0.55, 0.3];
  return {
    hip: [0.04 * sin(t / 4), -0.09 - 0.05 * cos(t), 0.06 * sin(t / 2 - 0.25)], hipRot: [-0.12 * sin(t / 2 - 0.2), 0, 0.05 * sin(t / 4)],
    spine: [0.2 * sin(t / 2), 0, -0.05 * sin(t / 4)], head: [-0.1 * sin(t / 2 + 0.1), 0, 0],
    lArm: arm(lv(up, lo, 0.5 - 0.5 * cos(t / 4))), rArm: arm(lv(up, lo, 0.5 - 0.5 * cos(t / 4 + 0.125))),
    lLeg: { p: [0.08, 0, 0.02] }, rLeg: { p: [0.08, 0, -0.02] },
  };
};

const houseJack = (t: number): Pose => ({
  hip: [0.02 * sin(t / 2), -0.08 - 0.06 * cos(t), 0.04 * sin(t)], hipRot: [0.12 * sin(t + 0.1), 0, 0], spine: [0.1 - 0.16 * sin(t + 0.1), 0.06 * sin(t / 2), 0],
  head: [0.08 * cos(t), 0, 0], lArm: arm([0.32, -0.45 + 0.1 * cos(t), 0.3]), rArm: arm([0.32, -0.45 + 0.1 * cos(t + 0.5), 0.3]),
  lLeg: { p: [0.06, 0, 0], pitch: 0.3 * Math.max(0, sin(t / 2)) }, rLeg: { p: [0.06, 0, 0], pitch: 0.3 * Math.max(0, -sin(t / 2)) },
});

const houseStep = (t: number): Pose => {
  const l = footSeq(t, 4, [{ t: 0, z: 0.22, x: 0.03 }, { t: 1, z: 0, x: 0.03 }]);
  const r = footSeq(t, 4, [{ t: 2, z: 0.22, x: 0.03 }, { t: 3, z: 0, x: 0.03 }]);
  return {
    hip: [0.03 * sin(t / 4), -0.07 - 0.03 * cos(t), (l.p![2] + r.p![2]) / 2], hipRot: [0.03, 0.1 * sin(t / 4), 0], spine: [0.08, -0.15 * sin(t / 4), 0],
    lArm: arm([0.25, -0.5, 0.2 - 0.25 * cos(t / 4)]), rArm: arm([0.25, -0.5, 0.2 + 0.25 * cos(t / 4)]), lLeg: l, rLeg: r,
  };
};

const discoHalf = (t: number): Pose => {
  const w = ss(0.25, 0.75, 0.5 + 0.5 * cos(t / 4));     // 1 = pointing up
  const up: V3 = [0.72, 0.78 + 0.05 * cos(t), 0.18], dn: V3 = [-0.42, -0.55 - 0.04 * cos(t), 0.4];
  const s = 2 * w - 1;
  return {
    hip: [0.07 * s, -0.05 - 0.03 * cos(t), 0], hipRot: [0, -0.08 * s, 0.08 * s], spine: [0.02, -0.2 * s, -0.08 * s], head: [-0.08 * w, -0.25 * s, 0],
    rArm: arm(lv(dn, up, w), [0.6, -0.3, -0.6]), lArm: arm([0.42, -0.5, 0.02], [1, 0, -0.4]),
    lLeg: { p: [0.07, 0, 0] }, rLeg: { p: [0.07, 0, 0], pitch: 0.3 * (1 - w) },
  };
};
const discoPoint = (t: number): Pose => mix(discoHalf(t), mirror(discoHalf(t)), gate(t, 4, 8, 8, 0.4));

const discoRoll = (t: number): Pose => {
  const y = 0.28 * sin(t / 4), sw = sin((t + 0.5) / 4);
  return {
    hip: [0.08 * sw, -0.06 - 0.03 * cos(t), 0], spine: [0.04, 0.28 * sin(t / 4), 0.05 * sw], head: [0, 0.15 * sin(t / 4), 0],
    lArm: arm([0.12 + 0.08 * cos(2 * t), -0.2 + y + 0.1 * sin(2 * t), 0.52], [0.9, -0.2, -0.2]),
    rArm: arm([0.12 + 0.08 * cos(2 * t + 0.5), -0.2 + y + 0.1 * sin(2 * t + 0.5), 0.52], [0.9, -0.2, -0.2]),
    lLeg: stepTouchL(t, 0.16), rLeg: stepTouchR(t, 0.16),
  };
};

const twist = (t: number): Pose => {
  const s = sin(t), lowv = 0.5 - 0.5 * cos(t / 4);
  return {
    hip: [0, -0.08 - 0.13 * lowv, 0], hipRot: [0.02, 0.3 * s, 0], spine: [0.08 + 0.1 * lowv, -0.55 * s, 0], head: [0, 0.2 * s, 0],
    lArm: arm([0.32, -0.3, 0.35 + 0.2 * s]), rArm: arm([0.32, -0.3, 0.35 - 0.2 * s]),
    lLeg: { p: [0.04, 0, 0], yaw: 0.14 + 0.45 * s, pitch: 0.14 }, rLeg: { p: [0.04, 0, 0], yaw: 0.14 - 0.45 * s, pitch: 0.14 },
  };
};

const stepTouch = (t: number): Pose => {
  const sw = sin((t + 0.5) / 4);
  const c = Math.exp(-((mod(t, 2) - 1) ** 2) / 0.03);
  const open: V3 = [0.36, -0.4, 0.3], shut: V3 = [0.015, -0.15, 0.56];
  return {
    hip: [0.1 * sw, -0.05 - 0.03 * cos(t), 0], hipRot: [0, 0.06 * sw, -0.04 * sw], spine: [0.04, -0.08 * sw, 0.05 * sw], head: [0.02, 0.08 * sw, 0],
    lArm: arm(lv(open, shut, c), [0.9, -0.3, -0.2]), rArm: arm(lv(open, shut, c), [0.9, -0.3, -0.2]), lLeg: stepTouchL(t, 0.18), rLeg: stepTouchR(t, 0.18),
  };
};

const slowSway = (t: number): Pose => {
  const s = sin(t / 8);
  return {
    hip: [0.06 * s, -0.04 - 0.02 * cos(t / 4), 0], hipRot: [0, 0, -0.05 * s], spine: [0.02, 0.06 * s, 0.07 * s], head: [0.03, 0.08 * s, 0.1 * s],
    lArm: arm([0.16, -0.82, 0.2 + 0.05 * s]), rArm: arm([0.16, -0.82, 0.2 - 0.05 * s]),
    lLeg: { p: [0.04, 0, 0], pitch: 0.18 * Math.max(0, -s) }, rLeg: { p: [0.04, 0, 0], pitch: 0.18 * Math.max(0, s) },
  };
};

const pumpHalf = (t: number): Pose => {
  const d = down(t);
  return {
    hip: [0, -0.05 - 0.09 * d, 0], spine: [0.06 + 0.05 * d, 0.1, 0], head: [0.08 * d - 0.05, 0, 0],
    rArm: arm([0.26, 0.6 + 0.32 * d, 0.25], [0.7, -0.2, -0.5]), lArm: arm([0.3, -0.35 + 0.05 * d, 0.3]),
    lLeg: { p: [0.07, 0, 0], pitch: 0.26 * (1 - d) }, rLeg: { p: [0.07, 0, 0], pitch: 0.26 * (1 - d) },
  };
};
const edmPump = (t: number): Pose => mix(pumpHalf(t), mirror(pumpHalf(t)), gate(t, 4, 8, 8, 0.4));

const handsUp = (t: number): Pose => {
  const s = sin(t / 2), d = down(t);
  return {
    hip: [0.05 * s, -0.05 - 0.06 * d, 0], spine: [-0.03, 0, -0.1 * s], head: [-0.1, 0, -0.05 * s],
    lArm: arm([0.3 + 0.22 * s, 0.9, 0.1], [0.8, 0, -0.4], [0, 0, 0.3 * s]), rArm: arm([0.3 - 0.22 * s, 0.9, 0.1], [0.8, 0, -0.4], [0, 0, -0.3 * s]),
    lLeg: { p: [0.06, 0, 0], pitch: 0.22 * (1 - d) }, rLeg: { p: [0.06, 0, 0], pitch: 0.22 * (1 - d) },
  };
};

const stompLeg = (u: number): LegSpec => { const v = clamp((mod(u, 2) - 1.45) / 0.55); return { p: [0.09, 0.14 * Math.sin(Math.PI * v), 0.04 * Math.sin(Math.PI * v)], pitch: 0.2 * Math.sin(Math.PI * v) }; };
const technoStomp = (t: number): Pose => {
  const d = down(t), dl = down(t / 2), dr = down(t / 2 + 0.5);
  return {
    hip: [0.04 * sin(t / 2 + 0.25), -0.1 - 0.05 * d, 0], hipRot: [0.08, 0, 0], spine: [0.2 + 0.06 * d, 0.1 * sin(t / 2), 0], head: [0.14 * d, 0, 0],
    lArm: arm([0.25, -0.3 - 0.32 * dl, 0.42]), rArm: arm([0.25, -0.3 - 0.32 * dr, 0.42]), lLeg: stompLeg(t), rLeg: stompLeg(t + 1),
  };
};

const tranceWave = (t: number): Pose => ({
  hip: [0.05 * sin(t / 8), -0.03 - 0.03 * down(t), 0], spine: [-0.07, 0.05 * sin(t / 8), 0.04 * sin(t / 8)], head: [-0.16, 0, 0.04 * sin(t / 8)],
  lArm: arm([0.86, 0.15 + 0.35 * sin(t / 4), 0.1], [0, -1, -0.2], [0, 0, 0.35 * cos(t / 4)]),
  rArm: arm([0.86, 0.15 + 0.35 * sin(t / 4 + 0.25), 0.1], [0, -1, -0.2], [0, 0, 0.35 * cos(t / 4 + 0.25)]),
  lLeg: { p: [0.06, 0, 0], pitch: 0.12 * (1 - down(t)) }, rLeg: { p: [0.06, 0, 0], pitch: 0.12 * (1 - down(t)) },
});

const arms90s = (t: number): Pose => ({
  hip: [0.06 * cos(t / 2), -0.07 - 0.03 * cos(t), 0.04 * sin(t / 2)], hipRot: [0, 0.1 * sin(t / 2), 0.04 * cos(t / 2)], spine: [0.06, 0.16 * sin(t / 2), 0], head: [0.03, 0.1 * sin(t / 2), 0],
  lArm: arm([0.18 + 0.15 * cos(t / 2), -0.25, 0.5 + 0.13 * sin(t / 2)], [0.9, -0.3, -0.2]), rArm: arm([0.18 - 0.15 * cos(t / 2), -0.25, 0.5 + 0.13 * sin(t / 2)], [0.9, -0.3, -0.2]),
  lLeg: { p: [0.07, 0, 0], pitch: 0.2 * Math.max(0, sin(t / 2)) }, rLeg: { p: [0.07, 0, 0], pitch: 0.2 * Math.max(0, -sin(t / 2)) },
});

// Line dance: grapevine right, grapevine left, forward/back, hip sway + hop. Everyone on the floor
// performs the same steps on the same beat, so neighbours never collide.
const D = 0.3;
const choreoA = (t: number): Pose => {
  const r = footSeq(t, 16, [{ t: 1, x: D }, { t: 3, x: 2 * D }, { t: 6, x: D }, { t: 8, x: 0 }, { t: 9, x: 0, z: 0.26 }, { t: 11, x: 0, z: 0 }, { t: 16, x: 0, hop: true }], 0.08);
  const l = footSeq(t, 16, [{ t: 2, x: -D }, { t: 4, x: -2 * D }, { t: 5, x: -D }, { t: 7, x: 0 }, { t: 10, x: 0, z: 0.26 }, { t: 12, x: 0, z: 0 }, { t: 16, x: 0, hop: true }], 0.08);
  const hx = (l.p![0] - r.p![0]) / 2, hz = (l.p![2] + r.p![2]) / 2;
  const clap = Math.exp(-((mod(t, 4)) ** 2) / 0.03) + Math.exp(-((mod(t, 4) - 4) ** 2) / 0.03);
  const fwd = gate(t, 9, 12, 16, 0.5), sway = gate(t, 12, 15.4, 16, 0.4);
  const hop = Math.sin(Math.PI * clamp((mod(t, 16) - 15.5) / 0.5));
  const open: V3 = [0.4, -0.45, 0.25 + 0.15 * sin(t / 2)], shut: V3 = [0.015, -0.15, 0.56], hi: V3 = [0.4, 0.85, 0.15];
  const la = lv(lv(open, hi, fwd), shut, clamp(clap) * (1 - fwd));
  const ra = lv(lv([open[0], open[1], 0.25 - 0.15 * sin(t / 2)], hi, fwd), shut, clamp(clap) * (1 - fwd));
  return {
    hip: [hx + 0.07 * sway * sin(t / 2), -0.06 - 0.03 * cos(t) + 0.1 * hop, hz], hipRot: [0, 0, -0.07 * sway * sin(t / 2)], spine: [0.04, 0.1 * sin(t / 4) * (1 - fwd), 0.06 * sway * sin(t / 2)],
    lArm: arm(la, [0.9, -0.3, -0.2]), rArm: arm(ra, [0.9, -0.3, -0.2]), lLeg: l, rLeg: r,
  };
};

const choreoB = (t: number): Pose => {
  const u = mod(t, 16);
  const base = (tt: number): Pose => ({ hip: [0.05 * sin(tt / 2), -0.06 - 0.04 * cos(tt), 0], lLeg: { p: [0.07, 0, 0] }, rLeg: { p: [0.07, 0, 0] } });
  const up: V3 = [0.55, 0.8, 0.2], side: V3 = [0.9, 0, 0.05], lo: V3 = [0.25, -0.6, 0.25];
  const a = (tt: number): Pose => { const w = 0.5 + 0.5 * cos(tt / 2); return { ...base(tt), spine: [0, 0.2 * (2 * w - 1), 0], rArm: arm(lv(lo, up, w)), lArm: arm(lv(up, lo, w)) }; };
  const b = (tt: number): Pose => ({ ...discoRoll(tt), lLeg: { p: [0.07, 0, 0] }, rLeg: { p: [0.07, 0, 0] } });
  const c = (tt: number): Pose => ({ ...handsUp(tt) });
  const d = (tt: number): Pose => { const cl = Math.exp(-((mod(tt, 1)) ** 2) / 0.02) + Math.exp(-((mod(tt, 1) - 1) ** 2) / 0.02); return { ...base(tt), spine: [0.05, 0.25 * sin(tt / 4), 0], lArm: arm(lv(side, [0.015, 0.1, 0.5], clamp(cl)), [0.6, -0.5, -0.4]), rArm: arm(lv(side, [0.015, 0.1, 0.5], clamp(cl)), [0.6, -0.5, -0.4]) }; };
  const blocks = [a, b, c, d];
  const k = Math.floor(u / 4), f = u - k * 4;
  const cur = blocks[k](t), nxt = blocks[(k + 1) % 4](t);
  return mix(cur, nxt, ss(3.6, 4, f));
};

const duoLead = (t: number): Pose => {
  const sw = sin((t + 0.5) / 4), pull = gate(t, 6, 8, 8, 0.5);
  return {
    hip: [0.1 * sw, -0.05 - 0.03 * cos(t), -0.07 * pull], hipRot: [0, 0, -0.04 * sw], spine: [0.03 - 0.1 * pull, 0, 0.05 * sw], head: [0, 0, 0.05 * sw],
    lArm: arm([0.2, -0.22 + 0.05 * sin(t / 2), 0.74 + 0.1 * pull], [0.7, -0.6, -0.2]), rArm: arm([0.2, -0.22 - 0.05 * sin(t / 2), 0.74 + 0.1 * pull], [0.7, -0.6, -0.2]),
    lLeg: stepTouchL(t, 0.18), rLeg: stepTouchR(t, 0.18),
  };
};
const duoFollow = (t: number): Pose => mirror(duoLead(t));

const special = (t: number): Pose => {
  const a = TAU * (t / 2);
  const l = footSeq(t, 8, [{ t: 0, x: 0.3 }, { t: 2, x: 0.04 }]), r = footSeq(t, 8, [{ t: 4, x: 0.3 }, { t: 6, x: 0.04 }]);
  const hx = (l.p![0] - r.p![0]) / 2, d = down(t);
  return {
    hip: [hx, -0.07 - 0.07 * d, 0], spine: [0.02, 0.2 * sin(t / 4), -0.3 * hx], head: [-0.06, 0.15 * sin(t / 4), 0],
    lArm: arm([0.2 + 0.72 * Math.abs(Math.cos(a)), 0.82 * Math.sin(a), 0.2], [0.3, -0.3, -0.9]), rArm: arm([0.2 + 0.72 * Math.abs(Math.cos(a)), 0.82 * Math.sin(a), 0.2], [0.3, -0.3, -0.9]),
    lLeg: l, rLeg: r,
  };
};

// ----------------------------------------------------------------------------- locomotion + gestures
function gait(stride: number, stance: number, liftH: number) {
  return (ph: number): LegSpec => {
    const f = mod(ph, 1), half = (stride * stance) / 2;
    if (f < stance) { const v = f / stance; return { p: [0, 0, half * (1 - 2 * v)], pitch: -0.22 * (1 - ss(0, 0.15, v)) + 0.5 * ss(0.72, 1, v), yaw: 0.1 }; }
    const v = (f - stance) / (1 - stance);
    return { p: [0, liftH * Math.sin(Math.PI * v), -half + 2 * half * ss(0, 1, v)], pitch: lerp(0.5, -0.22, ss(0, 1, v)), yaw: 0.1 };
  };
}
export const WALK_STRIDE = 1.3, RUN_STRIDE = 2.3;
const walkLeg = gait(WALK_STRIDE, 0.62, 0.09), runLeg = gait(RUN_STRIDE, 0.4, 0.2);
const walk = (u: number): Pose => ({
  hip: [0.02 * sin(u), -0.035 - 0.015 * cos(2 * u), 0], hipRot: [0.02, 0.08 * sin(u + 0.25), 0.03 * sin(u)], spine: [0.03, -0.16 * sin(u + 0.25), -0.03 * sin(u)],
  head: [0, 0.08 * sin(u + 0.25), 0], lArm: arm([0.16, -0.9, 0.08 - 0.26 * cos(u)]), rArm: arm([0.16, -0.9, 0.08 + 0.26 * cos(u)]),
  lLeg: walkLeg(u), rLeg: walkLeg(u + 0.5),
});
const run = (u: number): Pose => ({
  hip: [0.02 * sin(u), -0.06 + 0.035 * cos(2 * u + 0.2), 0], hipRot: [0.1, 0.12 * sin(u + 0.25), 0], spine: [0.14, -0.22 * sin(u + 0.25), 0],
  head: [-0.08, 0.1 * sin(u + 0.25), 0], lArm: arm([0.2, -0.42, 0.22 - 0.36 * cos(u)], [0.3, -0.3, -0.9]), rArm: arm([0.2, -0.42, 0.22 + 0.36 * cos(u)], [0.3, -0.3, -0.9]),
  lLeg: runLeg(u), rLeg: runLeg(u + 0.5),
});

const sit = (t: number): Pose => ({
  hip: [0, -0.37, -0.03], hipRot: [-0.1, 0, 0], spine: [-0.04 + 0.02 * cos(t), 0.04 * sin(t / 4), 0], head: [0.06 + 0.05 * cos(t), 0.1 * sin(t / 4), 0],
  lArm: arm([0.12, -0.6, 0.42]), rArm: arm([0.12, -0.6, 0.42 + 0.03 * cos(t)]),
  lLeg: { p: [0.05, 0, 0.36], yaw: 0.2 }, rLeg: { p: [0.05, 0, 0.36], yaw: 0.2, pitch: 0.12 * (0.5 - 0.5 * cos(t)) },
});

const wave = (t: number): Pose => {
  const w = ss(0, 0.6, t) * (1 - ss(3.3, 4, t));
  return {
    hip: [-0.02 * w, -0.02, 0], spine: [0, -0.06 * w, 0.05 * w], head: [-0.04 * w, -0.12 * w, -0.05 * w],
    rArm: mixArm(REST_ARM, arm([0.5 + 0.16 * sin(t * 1.5), 0.82, 0.25], [0.8, -0.5, -0.2], [0, 0, 0.4 * sin(t * 1.5)]), w), lArm: REST_ARM,
  };
};

const jump = (t: number): Pose => {
  const crouch = ss(0, 0.45, t) * (1 - ss(0.45, 0.62, t)) + 0.8 * ss(1.3, 1.42, t) * (1 - ss(1.42, 1.9, t));
  const air = t > 0.6 && t < 1.3 ? Math.sin((Math.PI * (t - 0.6)) / 0.7) : 0;
  const y = -0.2 * crouch + 0.4 * air;
  const fy = Math.max(0, 0.4 * air - 0.03), up = ss(0.5, 0.8, t) * (1 - ss(1.25, 1.6, t));
  const back: V3 = [0.22, -0.75, -0.32], hi: V3 = [0.36, 0.86, 0.2];
  const a = lv(lv(REST_ARM.h, back, ss(0, 0.4, t) * (1 - ss(0.45, 0.6, t))), hi, up);
  return {
    hip: [0, y, 0], spine: [0.22 * crouch - 0.06 * air, 0, 0], head: [-0.1 * air + 0.05 * crouch, 0, 0], lArm: arm(a), rArm: arm(a),
    lLeg: { p: [0.03, fy, 0], pitch: 0.6 * Math.min(1, air * 2) }, rLeg: { p: [0.03, fy, 0], pitch: 0.6 * Math.min(1, air * 2) },
  };
};

const clap = (t: number): Pose => {
  const c = clamp(Math.exp(-(mod(t, 1) ** 2) / 0.02) + Math.exp(-((mod(t, 1) - 1) ** 2) / 0.02));
  const w = ss(0, 0.4, t) * (1 - ss(3.6, 4, t));
  const open: V3 = [0.3, 0.05, 0.45], shut: V3 = [0.012, 0.05, 0.55];
  return {
    hip: [0.03 * sin(t / 2), -0.04 - 0.03 * cos(t), 0], spine: [0.03, 0, 0], head: [0.04 * cos(t), 0, 0],
    lArm: mixArm(REST_ARM, arm(lv(open, shut, c), [0.9, -0.3, -0.2]), w), rArm: mixArm(REST_ARM, arm(lv(open, shut, c), [0.9, -0.3, -0.2]), w),
  };
};

// ----------------------------------------------------------------------------- DJ
const DECK_L: V3 = [0.5, -0.52, 0.6], MIXER_R: V3 = [-0.22, -0.54, 0.6];
const djMix = (t: number): Pose => {
  const d = down(t), ear = gate(t, 4, 6, 8, 0.5);
  return {
    hip: [0.03 * sin(t / 4), -0.03 - 0.03 * d, 0], hipRot: [0.05, 0, 0], spine: [0.2 + 0.03 * d, 0.06 * sin(t / 4), 0], head: [0.1 * d - 0.02, 0.12 * sin(t / 8), 0.08 * ear],
    lArm: mixArm(arm([DECK_L[0] + 0.03 * sin(2 * t), DECK_L[1], DECK_L[2] + 0.03 * cos(2 * t)]), arm([0.14, 0.42, 0.12], [1, -0.2, 0]), ear),
    rArm: arm([MIXER_R[0] + 0.05 * sin(t / 2), MIXER_R[1], MIXER_R[2]], undefined, [0, 0.3 * sin(t), 0]), lLeg: { p: [0.05, 0, 0] }, rLeg: { p: [0.05, 0, 0] },
  };
};
const djHype = (t: number): Pose => {
  const d = down(t);
  return {
    hip: [0, -0.04 - 0.07 * d, 0], spine: [0.1 + 0.05 * d, 0.12, 0], head: [0.1 * d - 0.05, 0, 0],
    rArm: arm([0.3, 0.68 + 0.26 * d, 0.3], [0.7, -0.2, -0.5]), lArm: arm(DECK_L), lLeg: { p: [0.05, 0, 0], pitch: 0.2 * (1 - d) }, rLeg: { p: [0.05, 0, 0], pitch: 0.2 * (1 - d) },
  };
};
const djTransition = (t: number): Pose => {
  const rise = ss(1.5, 5, t) * (1 - ss(6.6, 7.2, t)), point = ss(6.6, 7.2, t) * (1 - ss(7.6, 8, t));
  const c = t > 4.6 && t < 6.6 ? clamp(Math.exp(-((mod(t, 1)) ** 2) / 0.02) + Math.exp(-((mod(t, 1) - 1) ** 2) / 0.02)) : 0;
  const wide: V3 = [0.75, 0.75, 0.1], shut: V3 = [0.012, 0.92, 0.15], fwd: V3 = [0.2, 0.12, 0.9];
  const lh = lv(lv(lv(DECK_L, lv(wide, shut, c), rise), fwd, point), REST_ARM.h, 0);
  const rh = lv(lv([-DECK_L[0] * -0.4, MIXER_R[1], MIXER_R[2]], lv(wide, shut, c), rise), fwd, point);
  return {
    hip: [0, -0.03 - 0.05 * down(t) * rise, 0], spine: [0.2 * (1 - rise) - 0.05 * rise, 0, 0], head: [-0.12 * rise, 0, 0],
    lArm: arm(lh, [0.7, -0.3, -0.5]), rArm: arm(rh, [0.7, -0.3, -0.5]), lLeg: { p: [0.05, 0, 0] }, rLeg: { p: [0.05, 0, 0] },
  };
};

export const CLIPS: Record<string, ClipDef> = {
  idle: { beats: 4, fn: idle, samples: 6 },
  hiphop_bounce: { beats: 4, fn: hiphopBounce }, hiphop_groove: { beats: 4, fn: hiphopGroove },
  shuffle_run: { beats: 2, fn: shuffleRun, samples: 16 }, shuffle_t: { beats: 8, fn: shuffleT, samples: 16 },
  break_toprock: { beats: 4, fn: breakToprock }, break_floor: { beats: 8, fn: breakFloor, samples: 16 },
  robot_a: { beats: 8, fn: robotA, samples: 16 }, robot_b: { beats: 8, fn: robotB, samples: 16 },
  freestyle_a: { beats: 8, fn: freestyleA }, freestyle_b: { beats: 8, fn: freestyleB },
  house_jack: { beats: 2, fn: houseJack }, house_step: { beats: 4, fn: houseStep },
  disco_point: { beats: 8, fn: discoPoint }, disco_roll: { beats: 4, fn: discoRoll },
  twist: { beats: 4, fn: twist }, step_touch: { beats: 4, fn: stepTouch }, slow_sway: { beats: 8, fn: slowSway, samples: 6 },
  edm_pump: { beats: 8, fn: edmPump }, hands_up: { beats: 4, fn: handsUp }, techno_stomp: { beats: 2, fn: technoStomp, samples: 16 },
  trance_wave: { beats: 8, fn: tranceWave, samples: 8 }, arms_90s: { beats: 4, fn: arms90s },
  choreo_a: { beats: 16, fn: choreoA }, choreo_b: { beats: 16, fn: choreoB },
  duo_lead: { beats: 8, fn: duoLead }, duo_follow: { beats: 8, fn: duoFollow }, special: { beats: 8, fn: special },
  walk: { beats: 1, fn: walk, samples: 32, unit: 'cycle', stride: WALK_STRIDE }, run: { beats: 1, fn: run, samples: 32, unit: 'cycle', stride: RUN_STRIDE },
  sit: { beats: 4, fn: sit, samples: 6 },
  wave: { beats: 4, fn: wave, loop: false }, jump: { beats: 2, fn: jump, loop: false, samples: 24 }, clap: { beats: 4, fn: clap, loop: false },
  dj_mix: { beats: 8, fn: djMix }, dj_hype: { beats: 4, fn: djHype }, dj_transition: { beats: 8, fn: djTransition, loop: false },
};

/** Dances a viewer can get from !dance (random) or by name. */
export const DANCES = ['hiphop_bounce', 'hiphop_groove', 'shuffle_run', 'shuffle_t', 'break_toprock', 'break_floor', 'robot_a', 'robot_b', 'freestyle_a',
  'freestyle_b', 'house_jack', 'house_step', 'disco_point', 'disco_roll', 'twist', 'step_touch', 'slow_sway', 'edm_pump', 'hands_up', 'techno_stomp',
  'trance_wave', 'arms_90s'];
export const DANCE_ALIASES: Record<string, string[]> = {
  hiphop: ['hiphop_bounce', 'hiphop_groove'], shuffle: ['shuffle_run', 'shuffle_t'], breakdance: ['break_toprock', 'break_floor'], break: ['break_toprock', 'break_floor'],
  robot: ['robot_a', 'robot_b'], freestyle: ['freestyle_a', 'freestyle_b'], house: ['house_jack', 'house_step'], disco: ['disco_point', 'disco_roll'],
  slow: ['slow_sway'], yavas: ['slow_sway'], twist: ['twist'], techno: ['techno_stomp'], trance: ['trance_wave'], edm: ['edm_pump', 'hands_up'], '90s': ['arms_90s', 'twist'],
};

const rigs = new WeakMap<Archetype, Rig>();
export function rigOf(a: Archetype): Rig {
  let r = rigs.get(a);
  if (!r) { r = new Rig(a); rigs.set(a, r); }
  return r;
}
export function getClip(a: Archetype, name: string): THREE.AnimationClip {
  let c = a.clips.get(name);
  if (!c) { c = bake(rigOf(a), name, CLIPS[name] ?? CLIPS.idle); a.clips.set(name, c); }
  return c;
}
