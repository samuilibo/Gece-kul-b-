import * as THREE from 'three';
import type { Look } from './look.ts';

/** Uniforms shared by every character (same object reference in all materials). */
export const charGlobals = {
  uRim: { value: new THREE.Color(0.3, 0.2, 0.5) },
  uTime: { value: 0 },
  uMask: { value: null as THREE.Texture | null },
};

export function loadCharTextures(base = '/assets/characters') {
  const t = new THREE.TextureLoader().load(`${base}/face_mask.png`);
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  charGlobals.uMask.value = t;
}

export interface CharUniforms {
  uPal: { value: THREE.Color[] };
  uLip: { value: THREE.Color };
  uBrow: { value: THREE.Color };
  uEye: { value: THREE.Color };
  uBeard: { value: number };
  uGold: { value: number };
}

/** Fragment-shader patch shared by hero characters (uniform palette) and the GPU crowd (palette texture). */
export function patchCharFragment(fs: string, source: 'uniform' | 'texture'): string {
  const decl = source === 'uniform'
    ? `uniform vec3 uPal[12]; uniform vec3 uLip, uBrow, uEye; uniform float uBeard, uGold;
vec3 cPal(int i) { return uPal[i]; } vec3 cLip() { return uLip; } vec3 cBrow() { return uBrow; } vec3 cEye() { return uEye; }
float cBeard() { return uBeard; } float cGold() { return uGold; }`
    : `uniform highp sampler2D uLook; flat varying float vLook; varying float vGold;
vec4 cRow(int i) { return texelFetch(uLook, ivec2(i, int(vLook + 0.5)), 0); }
vec3 cPal(int i) { return cRow(i).rgb; } vec3 cLip() { return cRow(12).rgb; } vec3 cBrow() { return cRow(13).rgb; } vec3 cEye() { return cRow(14).rgb; }
float cBeard() { return cRow(14).a; } float cGold() { return vGold; }`;
  return fs
    .replace('#include <common>', `#include <common>
flat varying float vReg;
${decl}
uniform vec3 uRim; uniform float uTime; uniform sampler2D uMask;
float cRough; float cMetal;`)
    .replace('#include <color_fragment>', `
int reg = int(vReg + 0.5);
vec3 cBase = cPal(reg);
float gold = cGold(), beard = cBeard();
cRough = 0.78; cMetal = 0.0;
if (reg == 0) {
  vec4 mk = texture2D(uMask, vUv);
  vec3 brow = cBrow();
  cBase = mix(cBase, cLip(), mk.r * 0.8);
  cBase = mix(cBase, mix(cBase, brow, 0.75), mk.a * beard);
  cBase = mix(cBase, brow, mk.g * 0.95);
  cRough = 0.52 + 0.25 * max(mk.g, mk.a * beard) - 0.12 * mk.r;
} else if (reg == 6) {
  float er = vUv.x;
  vec3 iris = cEye() * (0.55 + 0.9 * smoothstep(0.05, 0.15, er)) * (1.0 - 0.6 * smoothstep(0.135, 0.165, er));
  cBase = er < 0.055 ? vec3(0.015) : er < 0.165 ? iris : vec3(0.9, 0.88, 0.86);
  cRough = 0.12;
} else if (reg == 5) { cRough = 0.46; }
else if (reg == 3) { cRough = 0.5; }
else if (reg == 4) { cRough = 0.65; }
else if (reg == 8) { cRough = 0.55; }
else if (reg == 10) { cRough = 0.3; cMetal = 0.9; }
else if (reg == 11) { cRough = 0.06; cMetal = 0.85; }
float gk = reg == 0 || reg == 6 ? 0.25 * gold : gold;
cBase = mix(cBase, vec3(1.0, 0.72, 0.22), gk);
cRough = mix(cRough, 0.32, gk); cMetal = mix(cMetal, 0.85, gk);
diffuseColor.rgb = cBase;`)
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = cRough;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = cMetal;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(1.0, 0.62, 0.15) * gold * (0.04 + 0.025 * sin(uTime * 7.0));
if (reg == 0) totalEmissiveRadiance += cBase * vec3(0.05, 0.022, 0.018);`)
    .replace('#include <opaque_fragment>', `float cFres = dot(normal, normal) > 1e-8 ? pow(1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))), 3.0) : 0.0;
outgoingLight += uRim * cFres * (0.55 + 0.6 * gold) * (1.0 - 0.6 * cMetal);
#include <opaque_fragment>`);
}

function compile(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }, u: CharUniforms) {
  Object.assign(shader.uniforms, u, charGlobals);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec4 _region;\nflat varying float vReg;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvReg = _region.x;');
  shader.fragmentShader = patchCharFragment(shader.fragmentShader, 'uniform');
}

/** Per-character material. All instances share one compiled program (same cache key). */
export function createCharMaterial(look: Look): { material: THREE.MeshStandardMaterial; uniforms: CharUniforms } {
  const uniforms: CharUniforms = {
    uPal: { value: look.pal }, uLip: { value: look.lip }, uBrow: { value: look.brow }, uEye: { value: look.eye },
    uBeard: { value: look.beard }, uGold: { value: 0 },
  };
  const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, shadowSide: THREE.FrontSide });
  material.defines = { USE_UV: '' };
  material.onBeforeCompile = (shader) => compile(shader, uniforms);
  material.customProgramCacheKey = () => 'neon-char-v1';
  return { material, uniforms };
}

export function applyLook(u: CharUniforms, look: Look) {
  u.uPal.value = look.pal; u.uLip.value = look.lip; u.uBrow.value = look.brow; u.uEye.value = look.eye; u.uBeard.value = look.beard;
}
