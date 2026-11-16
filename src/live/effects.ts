import * as THREE from 'three';
import type { Engine } from './engine.ts';

const CONFETTI = 700, SPARKS = 1800;
const COLORS = [0xff2e63, 0x08d9d6, 0xffd23f, 0x7b2cbf, 0x06d6a0, 0xffffff, 0xff7b00];

/** Pooled particle effects (no allocation after start-up, so long streams do not leak). */
export class Effects {
  private conf: THREE.InstancedMesh;
  private cp = new Float32Array(CONFETTI * 3);
  private cv = new Float32Array(CONFETTI * 3);
  private cr = new Float32Array(CONFETTI * 4);     // rot x, rot z, spin, life
  private cNext = 0;
  private pts: THREE.Points;
  private sp: Float32Array;
  private sc: Float32Array;
  private sv = new Float32Array(SPARKS * 3);
  private sl = new Float32Array(SPARKS);
  private sbase = new Float32Array(SPARKS * 3);
  private sNext = 0;
  private shells: { at: number; pos: THREE.Vector3; color: THREE.Color }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();

  constructor(engine: Engine) {
    this.conf = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.07, 0.11), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), CONFETTI);
    this.conf.frustumCulled = false; this.conf.userData.noEnv = true;
    this.conf.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const c = new THREE.Color();
    for (let i = 0; i < CONFETTI; i++) { this.conf.setMatrixAt(i, this.m.makeScale(0, 0, 0)); this.conf.setColorAt(i, c.set(COLORS[i % COLORS.length]).multiplyScalar(1.3)); }
    this.conf.count = CONFETTI;
    engine.scene.add(this.conf);
    const g = new THREE.BufferGeometry();
    this.sp = new Float32Array(SPARKS * 3); this.sc = new Float32Array(SPARKS * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.sp, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.sc, 3).setUsage(THREE.DynamicDrawUsage));
    this.pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.16, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, sizeAttenuation: true }));
    this.pts.frustumCulled = false; this.pts.userData.noEnv = true; this.pts.renderOrder = 12;
    engine.scene.add(this.pts);
  }

  confetti(origin: THREE.Vector3, n = 220) {
    for (let k = 0; k < n; k++) {
      const i = this.cNext = (this.cNext + 1) % CONFETTI;
      const a = Math.random() * Math.PI * 2, r = Math.random() * 2.2;
      this.cp[i * 3] = origin.x + Math.cos(a) * r * 0.4; this.cp[i * 3 + 1] = origin.y; this.cp[i * 3 + 2] = origin.z + Math.sin(a) * r * 0.4;
      this.cv[i * 3] = Math.cos(a) * r; this.cv[i * 3 + 1] = 1.5 + Math.random() * 3.5; this.cv[i * 3 + 2] = Math.sin(a) * r;
      this.cr[i * 4] = Math.random() * 6; this.cr[i * 4 + 1] = Math.random() * 6; this.cr[i * 4 + 2] = 4 + Math.random() * 8; this.cr[i * 4 + 3] = 5 + Math.random() * 2;
    }
  }

  /** Indoor "fireworks": bursts of sparks under the ceiling, staggered over the duration. */
  fireworks(now: number, seconds: number, center: THREE.Vector3) {
    const n = Math.max(3, Math.round(seconds * 1.3));
    for (let k = 0; k < n; k++) {
      this.shells.push({ at: now + (k / n) * seconds, pos: new THREE.Vector3(center.x + (Math.random() - 0.5) * 12, 5.4 + Math.random() * 2, center.z + (Math.random() - 0.5) * 8), color: new THREE.Color(COLORS[Math.floor(Math.random() * COLORS.length)]) });
    }
  }

  private burst(pos: THREE.Vector3, color: THREE.Color) {
    for (let k = 0; k < 130; k++) {
      const i = this.sNext = (this.sNext + 1) % SPARKS;
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u), sp = 2.5 + Math.random() * 2.5;
      this.sp[i * 3] = pos.x; this.sp[i * 3 + 1] = pos.y; this.sp[i * 3 + 2] = pos.z;
      this.sv[i * 3] = Math.cos(a) * s * sp; this.sv[i * 3 + 1] = u * sp; this.sv[i * 3 + 2] = Math.sin(a) * s * sp;
      this.sl[i] = 1.1 + Math.random() * 0.7;
      const w = Math.random() < 0.2 ? 1 : 0;
      this.sbase[i * 3] = color.r * 2.2 + w; this.sbase[i * 3 + 1] = color.g * 2.2 + w; this.sbase[i * 3 + 2] = color.b * 2.2 + w;
    }
  }

  clear() { this.shells.length = 0; this.cr.fill(0); this.sl.fill(0); }

  update(dt: number, now: number) {
    for (let k = this.shells.length - 1; k >= 0; k--) if (this.shells[k].at <= now) { this.burst(this.shells[k].pos, this.shells[k].color); this.shells.splice(k, 1); }
    for (let i = 0; i < CONFETTI; i++) {
      const life = this.cr[i * 4 + 3];
      if (life <= 0) continue;
      this.cr[i * 4 + 3] = life - dt;
      const j = i * 3;
      this.cv[j] *= 1 - dt * 1.4; this.cv[j + 2] *= 1 - dt * 1.4;
      this.cv[j + 1] = Math.max(-1.1, this.cv[j + 1] - 5.5 * dt);
      this.cp[j] += (this.cv[j] + Math.sin(now * 3 + i) * 0.35) * dt; this.cp[j + 1] += this.cv[j + 1] * dt; this.cp[j + 2] += this.cv[j + 2] * dt;
      const landed = this.cp[j + 1] <= 0.04;
      if (landed) { this.cp[j + 1] = 0.04; this.cv[j] = this.cv[j + 2] = 0; } else { this.cr[i * 4] += this.cr[i * 4 + 2] * dt; this.cr[i * 4 + 1] += this.cr[i * 4 + 2] * 0.7 * dt; }
      const sc = life - dt <= 0 ? 0 : Math.min(1, life);
      this.m.compose(this.p.set(this.cp[j], this.cp[j + 1], this.cp[j + 2]), this.q.setFromEuler(this.e.set(landed ? Math.PI / 2 : this.cr[i * 4], 0, this.cr[i * 4 + 1])), this.s.set(sc, sc, sc));
      this.conf.setMatrixAt(i, this.m);
    }
    this.conf.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < SPARKS; i++) {
      const j = i * 3;
      if (this.sl[i] <= 0) { if (this.sc[j] || this.sc[j + 1] || this.sc[j + 2]) this.sc[j] = this.sc[j + 1] = this.sc[j + 2] = 0; continue; }
      this.sl[i] -= dt;
      const d = 1 - dt * 1.8;
      this.sv[j] *= d; this.sv[j + 1] = this.sv[j + 1] * d - 2.2 * dt; this.sv[j + 2] *= d;
      this.sp[j] += this.sv[j] * dt; this.sp[j + 1] += this.sv[j + 1] * dt; this.sp[j + 2] += this.sv[j + 2] * dt;
      const f = Math.max(0, Math.min(1, this.sl[i]));
      this.sc[j] = this.sbase[j] * f; this.sc[j + 1] = this.sbase[j + 1] * f; this.sc[j + 2] = this.sbase[j + 2] * f;
    }
    (this.pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pts.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
