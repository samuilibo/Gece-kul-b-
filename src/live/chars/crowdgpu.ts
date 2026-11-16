// GPU crowd: draws hundreds of distant viewers with ONE instanced draw call per archetype.
//
// * Every looping motion of the library is baked once per archetype into a float texture that holds the
//   53 skinning matrices for every frame ("animation texture"). The vertex shader skins each instance by
//   reading its matrices for the current beat, so a far dancer costs the GPU a few texel fetches and no CPU.
// * Each viewer's look (palette, lips, brows, eyes, beard, which clothes are worn) lives in one row of a
//   shared "look texture"; the instance only stores its row index.
// * Geometry is the LOD3 mesh with every garment included; parts the viewer does not wear collapse to a
//   degenerate point in the vertex shader (one geometry per archetype covers every outfit).
// Clip time uses the same beat clock as the hero characters, so switching a viewer between the detailed
// skinned mesh and the crowd instance is seamless.
import * as THREE from 'three';
import type { Archetype, LodData } from './assets.ts';
import { Character } from './character.ts';
import { CLIPS, DANCES } from './dances.ts';
import type { Look } from './look.ts';
import { charGlobals, patchCharFragment } from './material.ts';

export const CROWD_CLIPS = [...DANCES, 'choreo_a', 'choreo_b', 'duo_lead', 'duo_follow', 'special', 'idle', 'sit'];
const FPB = 8;                       // baked frames per beat
const BONES_TEX_W = 53 * 4;
const LOOK_W = 18;                   // 0-11 palette, 12 lip, 13 brow, 14 eye+beard, 16-17 part masks (128 bits)
export const MAX_CROWD = 2048;

interface ClipInfo { row: number; frames: number }
interface Arch {
  mesh: THREE.InstancedMesh;
  attA: THREE.InstancedBufferAttribute;     // lookRow, clipRow, clipFrames, phase (beats)
  attB: THREE.InstancedBufferAttribute;     // gold, framesPerBeat
  clips: Map<string, ClipInfo>;
  groups: { hiddenBy?: string[]; part?: string }[];
  anim: THREE.DataTexture;
}

export interface CrowdInstance { arch: number; lookRow: number; clip: string; phase: number; gold: number; x: number; y: number; z: number; yaw: number; scale: number }

/** Duplicates vertices per triangle group so that every vertex knows which (skin or garment) group it belongs to. */
function crowdGeometry(lod: LodData) {
  const groups: Arch['groups'] = [];
  const lists: Uint16Array[] = [];
  for (const s of lod.skin) { groups.push({ hiddenBy: s.hiddenBy }); lists.push(s.idx); }
  for (const [part, idx] of lod.parts) { groups.push({ part }); lists.push(idx); }
  const a = lod.attrs as Record<string, THREE.BufferAttribute>;
  let nv = 0, ni = 0;
  const maps = lists.map((idx) => { const m = new Map<number, number>(); for (const v of idx) if (!m.has(v)) m.set(v, nv++); ni += idx.length; return m; });
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const si = new Float32Array(nv * 4), sw = new Float32Array(nv * 4), reg = new Float32Array(nv), grp = new Float32Array(nv);
  const index = new Uint32Array(ni);
  let o = 0;
  maps.forEach((m, gi) => {
    for (const [src, dst] of m) {
      pos[dst * 3] = a.position.getX(src); pos[dst * 3 + 1] = a.position.getY(src); pos[dst * 3 + 2] = a.position.getZ(src);
      nor[dst * 3] = a.normal.getX(src); nor[dst * 3 + 1] = a.normal.getY(src); nor[dst * 3 + 2] = a.normal.getZ(src);
      if (a.uv) { uv[dst * 2] = a.uv.getX(src); uv[dst * 2 + 1] = a.uv.getY(src); }
      for (let k = 0; k < 4; k++) { si[dst * 4 + k] = a.skinIndex.getComponent(src, k); sw[dst * 4 + k] = a.skinWeight.getComponent(src, k); }
      reg[dst] = a._region.getX(src);
      grp[dst] = gi;
    }
    for (const v of lists[gi]) index[o++] = m.get(v)!;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setAttribute('aReg', new THREE.BufferAttribute(reg, 1));
  g.setAttribute('aGroup', new THREE.BufferAttribute(grp, 1));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return { geometry: g, groups };
}

/** Samples every crowd clip on a throw-away skeleton and stores the skinning matrices row by row. */
function bakeAnimation(a: Archetype, look: Look): { tex: THREE.DataTexture; clips: Map<string, ClipInfo> } {
  const rig = new Character(a, look);
  rig.group.scale.setScalar(1);
  const clips = new Map<string, ClipInfo>();
  let rows = 0;
  for (const name of CROWD_CLIPS) { const frames = Math.max(1, Math.round((CLIPS[name]?.beats ?? 4) * FPB)); clips.set(name, { row: rows, frames }); rows += frames; }
  const data = new Float32Array(BONES_TEX_W * rows * 4);
  const skel = rig.mesh.skeleton;
  for (const name of CROWD_CLIPS) {
    const info = clips.get(name)!;
    rig.reset();
    rig.play(name, 0);
    for (let f = 0; f < info.frames; f++) {
      rig.update(0, f / FPB, 1, 0);                    // beat-locked clips: time = beats
      rig.group.updateMatrixWorld(true);
      skel.update();
      data.set(skel.boneMatrices!, (info.row + f) * BONES_TEX_W * 4);
    }
  }
  rig.dispose();
  const tex = new THREE.DataTexture(data, BONES_TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return { tex, clips };
}

function crowdMaterial(anim: THREE.DataTexture, look: THREE.DataTexture, beats: { value: number }) {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  m.defines = { USE_UV: '' };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, charGlobals, { uAnim: { value: anim }, uLook: { value: look }, uBeats: beats });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 skinIndex; attribute vec4 skinWeight; attribute float aReg; attribute float aGroup;
attribute vec4 aInstA; attribute vec4 aInstB;
uniform highp sampler2D uAnim; uniform highp sampler2D uLook; uniform float uBeats;
flat varying float vReg; flat varying float vLook; varying float vGold;
mat4 cBone(int row, float b) { int x = int(b + 0.5) * 4;
  return mat4(texelFetch(uAnim, ivec2(x, row), 0), texelFetch(uAnim, ivec2(x + 1, row), 0), texelFetch(uAnim, ivec2(x + 2, row), 0), texelFetch(uAnim, ivec2(x + 3, row), 0)); }`)
      .replace('#include <beginnormal_vertex>', `
float cFrames = aInstA.z, cFpb = aInstB.y;
float cT = mod(uBeats + aInstA.w, cFrames / cFpb) * cFpb;
int cRowI = int(aInstA.y + 0.5) + int(mod(floor(cT), cFrames));
mat4 cSkin = skinWeight.x * cBone(cRowI, skinIndex.x) + skinWeight.y * cBone(cRowI, skinIndex.y)
           + skinWeight.z * cBone(cRowI, skinIndex.z) + skinWeight.w * cBone(cRowI, skinIndex.w);
vec3 objectNormal = mat3(cSkin) * normal;`)
      .replace('#include <begin_vertex>', `
vec3 transformed = (cSkin * vec4(position, 1.0)).xyz;
int gi = int(aGroup + 0.5);
vec4 cMask = texelFetch(uLook, ivec2(16 + gi / 64, int(aInstA.x + 0.5)), 0);
float cWord = cMask[(gi % 64) / 16];
if (mod(floor(cWord / exp2(float(gi % 16))), 2.0) < 0.5) transformed = vec3(0.0, -60.0, 0.0);   // garment not worn: degenerate
vReg = aReg; vLook = aInstA.x; vGold = aInstB.x;`);
    shader.fragmentShader = patchCharFragment(shader.fragmentShader, 'texture');
  };
  m.customProgramCacheKey = () => 'neon-crowd-v1';
  return m;
}

export class CrowdGPU {
  ready = false;
  private archs: (Arch | null)[] = [];
  private lookTex: THREE.DataTexture;
  private lookData: Float32Array;
  private freeRows: number[] = [];
  private lookDirty = false;
  private beats = { value: 0 };
  group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.lookData = new Float32Array(LOOK_W * MAX_CROWD * 4);
    this.lookTex = new THREE.DataTexture(this.lookData, LOOK_W, MAX_CROWD, THREE.RGBAFormat, THREE.FloatType);
    this.lookTex.minFilter = this.lookTex.magFilter = THREE.NearestFilter;
    this.lookTex.needsUpdate = true;
    for (let i = MAX_CROWD - 1; i >= 0; i--) this.freeRows.push(i);
    this.group.userData.noEnv = true;
    scene.add(this.group);
  }

  /** Bakes all archetypes, yielding between them so the page stays responsive. */
  async init(archetypes: Archetype[], sampleLook: (a: Archetype) => Look) {
    for (const a of archetypes) {
      await new Promise((r) => setTimeout(r, 0));
      if (!a.crowdLod) { this.archs.push(null); continue; }
      const { geometry, groups } = crowdGeometry(a.crowdLod);
      const { tex, clips } = bakeAnimation(a, sampleLook(a));
      const mesh = new THREE.InstancedMesh(geometry, crowdMaterial(tex, this.lookTex, this.beats), MAX_CROWD);
      const attA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CROWD * 4), 4).setUsage(THREE.DynamicDrawUsage);
      const attB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CROWD * 4), 4).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('aInstA', attA);
      geometry.setAttribute('aInstB', attB);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;                 // culled per instance on the CPU
      mesh.castShadow = false;
      mesh.userData.noEnv = true;
      this.group.add(mesh);
      this.archs.push({ mesh, attA, attB, clips, groups, anim: tex });
    }
    this.ready = true;
  }

  hasClip(arch: number, clip: string) { return !!this.archs[arch]?.clips.has(clip); }

  // ------------------------------------------------------------------ look rows
  allocLook(arch: number, look: Look): number {
    const row = this.freeRows.pop();
    if (row === undefined) return -1;
    this.writeLook(row, arch, look);
    return row;
  }
  freeLook(row: number) { if (row >= 0) this.freeRows.push(row); }

  writeLook(row: number, arch: number, look: Look) {
    const d = this.lookData, base = row * LOOK_W * 4;
    const put = (texel: number, r: number, g: number, b: number, a = 1) => { const o = base + texel * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a; };
    look.pal.forEach((c, i) => put(i, c.r, c.g, c.b));
    put(12, look.lip.r, look.lip.g, look.lip.b);
    put(13, look.brow.r, look.brow.g, look.brow.b);
    put(14, look.eye.r, look.eye.g, look.eye.b, look.beard);
    const a = this.archs[arch];
    const words = new Float32Array(8);
    if (a) {
      const worn = new Set(['eyes', ...look.parts]);
      a.groups.forEach((g, gi) => {
        const vis = g.part ? worn.has(g.part) : !g.hiddenBy!.some((h) => worn.has(h));
        if (vis && gi < 128) words[gi >> 4] += 2 ** (gi & 15);
      });
    }
    put(16, words[0], words[1], words[2], words[3]);
    put(17, words[4], words[5], words[6], words[7]);
    this.lookDirty = true;
  }

  // ------------------------------------------------------------------ per frame
  private counts: number[] = [];
  begin(beats: number) {
    this.beats.value = beats;
    this.counts = this.archs.map(() => 0);
  }

  push(i: CrowdInstance) {
    const a = this.archs[i.arch];
    if (!a || i.lookRow < 0) return false;
    const info = a.clips.get(i.clip) ?? a.clips.get('idle')!;
    const n = this.counts[i.arch]++;
    if (n >= MAX_CROWD) return false;
    const m = a.mesh.instanceMatrix.array as Float32Array, o = n * 16;
    const c = Math.cos(i.yaw) * i.scale, s = Math.sin(i.yaw) * i.scale;
    m[o] = c; m[o + 1] = 0; m[o + 2] = -s; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = i.scale; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = s; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0;
    m[o + 12] = i.x; m[o + 13] = i.y; m[o + 14] = i.z; m[o + 15] = 1;
    const A = a.attA.array as Float32Array, B = a.attB.array as Float32Array;
    A[n * 4] = i.lookRow; A[n * 4 + 1] = info.row; A[n * 4 + 2] = info.frames; A[n * 4 + 3] = i.phase;
    B[n * 4] = i.gold; B[n * 4 + 1] = FPB;
    return true;
  }

  end() {
    this.archs.forEach((a, k) => {
      if (!a) return;
      const n = this.counts[k] ?? 0;
      a.mesh.count = n;
      if (n) {
        a.mesh.instanceMatrix.clearUpdateRanges(); a.mesh.instanceMatrix.addUpdateRange(0, n * 16); a.mesh.instanceMatrix.needsUpdate = true;
        a.attA.clearUpdateRanges(); a.attA.addUpdateRange(0, n * 4); a.attA.needsUpdate = true;
        a.attB.clearUpdateRanges(); a.attB.addUpdateRange(0, n * 4); a.attB.needsUpdate = true;
      }
    });
    if (this.lookDirty) { this.lookTex.needsUpdate = true; this.lookDirty = false; }
  }

  get instances() { return this.counts.reduce((s, n) => s + n, 0); }
}
