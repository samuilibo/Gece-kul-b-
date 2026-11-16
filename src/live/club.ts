import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { ClubEvent, LightSettings } from '../../shared/protocol.ts';
import { rng, type AudioFrame, type Engine, type QualityProfile } from './engine.ts';
import { BALCONY, COLUMNS, DISCO_BALLS, DJ, DOOR, FLOOR, ROOM, SOFAS, STAGE, STAIRS, TABLES, VIP } from './layout.ts';

const HDR = (hex: THREE.ColorRepresentation, k: number) => new THREE.Color(hex).multiplyScalar(k);
const TAU = Math.PI * 2;

// ----------------------------------------------------------------------------- LED shader
const LED_FRAG = /* glsl */ `
uniform float uTime, uBeats, uKick, uBass, uPattern, uGain, uTextMix, uDot, uAspect;
uniform vec3 uA, uB, uC; uniform sampler2D uSpec, uText; uniform vec2 uCells;
varying vec2 vUv;
vec3 pal(float t){ t = fract(t) * 3.0; return t < 1.0 ? mix(uA, uB, t) : t < 2.0 ? mix(uB, uC, t - 1.0) : mix(uC, uA, t - 2.0); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec2 g = vUv * uCells; vec2 p = (floor(g) + 0.5) / uCells; vec2 f = fract(g) - 0.5;
  float dotMask = mix(smoothstep(0.5, 0.42, max(abs(f.x), abs(f.y))), smoothstep(0.48, 0.25, length(f)), uDot);
  vec3 col;
  if (uPattern < 0.5) {            // spectrum analyser, mirrored
    float s = texture2D(uSpec, vec2(abs(p.x - 0.5) * 1.9 + 0.02, 0.5)).r;
    float bar = step(p.y, s * 0.92 + 0.04);
    col = pal(p.y * 0.55 + uTime * 0.04) * bar * 1.5 + pal(p.x + uTime * 0.08) * 0.06;
  } else if (uPattern < 1.5) {     // plasma
    float v = sin(p.x * 9.0 + uTime * 1.3) + sin(p.y * 7.0 - uTime * 1.1) + sin((p.x + p.y) * 6.0 + uTime * 0.7) + sin(length(p - 0.5) * 14.0 - uBeats * 3.1416);
    col = pal(v * 0.16 + uTime * 0.03) * (0.5 + 0.6 * uKick);
  } else if (uPattern < 2.5) {     // beat rings
    float r = length((p - 0.5) * vec2(uAspect, 1.0));
    float v = fract(r * 2.5 - uBeats * 0.5);
    col = pal(r * 0.8 + uTime * 0.06) * smoothstep(0.0, 0.12, v) * smoothstep(0.45, 0.15, v) * 1.8;
  } else if (uPattern < 3.5) {     // marching columns
    float c = floor(p.x * 12.0);
    float on = step(0.5, fract((c + floor(uBeats)) * 0.25 + 0.01));
    float h = hash(vec2(c, floor(uBeats * 0.5)));
    col = pal(c / 12.0 + uBeats * 0.03) * on * step(p.y, 0.35 + 0.65 * h) * (0.5 + 0.8 * uKick);
  } else if (uPattern < 4.5) {     // checker (dance floor / retro)
    vec2 c = floor(g);
    float k = mod(c.x + c.y + floor(uBeats), 2.0);
    col = pal((c.x * 3.0 + c.y * 7.0) * 0.071 + floor(uBeats) * 0.13) * (0.12 + 0.88 * k * (0.45 + 0.55 * uKick));
  } else if (uPattern < 5.5) {     // sparkle
    float h = hash(floor(g) + floor(uBeats * 2.0) * 7.0);
    col = pal(h + uTime * 0.05) * step(0.80 - uBass * 0.35, h) * 1.4;
  } else {                         // ripple from centre (floor)
    float r = length((p - 0.5) * vec2(uAspect, 1.0));
    float v = sin(r * 22.0 - uBeats * 3.1416) * 0.5 + 0.5;
    col = pal(r * 1.3 - uTime * 0.05) * (0.15 + 0.85 * v * v) * (0.5 + 0.5 * uKick);
  }
  col *= uGain;
  vec4 tx = texture2D(uText, vUv);
  col = mix(col, tx.rgb * 2.4, tx.a * uTextMix);
  gl_FragColor = vec4(col * dotMask, 1.0);
}`;
const LED_VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

const BEAM_VERT = /* glsl */ `varying vec3 vN; varying vec3 vV; varying float vH;
void main(){ vH = uv.y; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const BEAM_FRAG = /* glsl */ `uniform vec3 uColor; uniform float uPower; varying vec3 vN; varying vec3 vV; varying float vH;
void main(){ float rim = pow(abs(dot(normalize(vN), normalize(vV))), 2.2); float a = rim * pow(vH, 1.6) * uPower; gl_FragColor = vec4(uColor * a, 1.0); }`;

function noiseTexture(size: number, seed: number, scale = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const r = rng(seed);
  const img = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) { const v = 150 + r() * 105 * scale; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  g.globalAlpha = 0.5; g.filter = 'blur(2px)'; g.drawImage(c, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function slatNormal() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 4;
  const g = c.getContext('2d')!;
  for (let x = 0; x < 64; x++) { const s = Math.sin((x / 64) * TAU * 4); g.fillStyle = `rgb(${128 + s * 110},128,${200})`; g.fillRect(x, 0, 1, 4); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function textTexture(text: string, w: number, h: number, opts: { font?: string; color?: string; glow?: string; outline?: boolean } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = h * 0.62;
  g.font = `${opts.font ?? '800'} ${size}px "Segoe UI", "Arial Black", Arial, sans-serif`;
  const m = g.measureText(text).width;
  if (m > w * 0.92) { size *= (w * 0.92) / m; g.font = `${opts.font ?? '800'} ${size}px "Segoe UI", "Arial Black", Arial, sans-serif`; }
  if (opts.outline) {
    g.lineWidth = size * 0.09; g.lineJoin = 'round'; g.strokeStyle = opts.color ?? '#fff';
    g.shadowColor = opts.glow ?? opts.color ?? '#fff'; g.shadowBlur = size * 0.18;
    g.strokeText(text, w / 2, h / 2); g.shadowBlur = 0;
    g.lineWidth = size * 0.03; g.strokeStyle = '#ffffff'; g.strokeText(text, w / 2, h / 2);
  } else { g.fillStyle = opts.color ?? '#fff'; g.fillText(text, w / 2, h / 2); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

interface Led { mat: THREE.ShaderMaterial; base: number; role: 'wall' | 'floor' | 'side' | 'booth' }
interface Beam { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; origin: THREE.Vector3; target: THREE.Vector3; light?: THREE.SpotLight; phase: number }

const LIGHT_MODES: Record<ClubEvent['light'], { wall: number[]; laser: number; disco: number; beamSpeed: number; ambient: number; strobe: number }> = {
  neon: { wall: [1, 0, 2, 3], laser: 0.6, disco: 0.25, beamSpeed: 1, ambient: 0.5, strobe: 0 },
  disco: { wall: [4, 1, 5], laser: 0.15, disco: 1, beamSpeed: 0.6, ambient: 0.7, strobe: 0 },
  techno: { wall: [3, 0, 5], laser: 0.8, disco: 0, beamSpeed: 1.8, ambient: 0.3, strobe: 1 },
  laser: { wall: [2, 5, 0], laser: 1, disco: 0.1, beamSpeed: 1.2, ambient: 0.3, strobe: 0 },
  warm: { wall: [1, 6], laser: 0.1, disco: 0.4, beamSpeed: 0.4, ambient: 0.85, strobe: 0 },
  color: { wall: [4, 1, 3, 2], laser: 0.4, disco: 0.6, beamSpeed: 0.9, ambient: 0.65, strobe: 0 },
  show: { wall: [2, 0, 3, 5], laser: 0.9, disco: 0.3, beamSpeed: 1.5, ambient: 0.45, strobe: 0 },
};

export class Club {
  group = new THREE.Group();
  palette = [new THREE.Color('#ff2bd6'), new THREE.Color('#19e3ff'), new THREE.Color('#7a5cff')];
  ambientTint = new THREE.Color('#6a5cff');
  private leds: Led[] = [];
  private beams: Beam[] = [];
  private spec = new THREE.DataTexture(new Uint8Array(64), 64, 1, THREE.RedFormat);
  private textCanvas = document.createElement('canvas');
  private textTex: THREE.CanvasTexture;
  private textUntil = 0;
  private textMix = 0;
  private strip: THREE.MeshBasicMaterial[] = [];
  private lasers!: THREE.InstancedMesh;
  private dots!: THREE.InstancedMesh;
  private dotDirs: THREE.Vector3[] = [];
  private balls: THREE.Mesh[] = [];
  private woofers!: THREE.InstancedMesh;
  private wooferBase: THREE.Matrix4[] = [];
  private fog!: THREE.Points;
  private hemi!: THREE.HemisphereLight;
  private key!: THREE.SpotLight;
  private follow!: Beam;
  private followUntil = 0;
  private followPos: (() => THREE.Vector3 | null) | null = null;
  private showUntil = 0;
  private ceiling!: THREE.Object3D;
  private sky!: THREE.Object3D;
  private neon: THREE.MeshBasicMaterial[] = [];
  private mode = LIGHT_MODES.neon;
  private modeName: ClubEvent['light'] = 'neon';
  private decor: ClubEvent['decor'] = 'default';
  private settings: LightSettings = { intensity: 1, lasers: true, fog: 0.6, strobe: false, mode: 'auto' };
  private profile: QualityProfile;
  private pmrem: THREE.PMREMGenerator;
  private envDirty = true;
  private testUntil = 0;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  private tmpC = new THREE.Color();

  constructor(private engine: Engine) {
    this.profile = engine.profile;
    this.pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.textCanvas.width = 1024; this.textCanvas.height = 384;
    this.textTex = new THREE.CanvasTexture(this.textCanvas);
    this.textTex.colorSpace = THREE.SRGBColorSpace;
    this.spec.needsUpdate = true;
    engine.scene.add(this.group);
    engine.scene.background = new THREE.Color(0x020207);
    engine.scene.fog = new THREE.FogExp2(0x0a0618, 0.012);
    this.buildShell();
    this.buildStage();
    this.buildFurniture();
    this.buildRig();
    this.buildSky();
    this.applyProfile(engine.profile);
    engine.onQualityChange((p) => this.applyProfile(p));
  }

  // ------------------------------------------------------------------ helpers
  private box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.group) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  private ledPlane(w: number, h: number, cells: [number, number], pattern: number, gain: number, role: Led['role'], dot = 1) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: LED_VERT, fragmentShader: LED_FRAG, toneMapped: false,
      uniforms: {
        uTime: { value: 0 }, uBeats: { value: 0 }, uKick: { value: 0 }, uBass: { value: 0 }, uPattern: { value: pattern }, uGain: { value: gain },
        uTextMix: { value: 0 }, uDot: { value: dot }, uAspect: { value: w / h }, uA: { value: this.palette[0] }, uB: { value: this.palette[1] },
        uC: { value: this.palette[2] }, uSpec: { value: this.spec }, uText: { value: this.textTex }, uCells: { value: new THREE.Vector2(...cells) },
      },
    });
    this.leds.push({ mat, base: gain, role });
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  }

  private stripMat(i: number, k = 2.2) {
    const m = new THREE.MeshBasicMaterial({ color: HDR(this.palette[i % 3], k), toneMapped: false });
    m.userData = { i: i % 3, k };
    this.strip.push(m);
    return m;
  }

  // ------------------------------------------------------------------ room shell
  private buildShell() {
    const { hx, hz, h } = ROOM;
    const rough = noiseTexture(256, 7);
    rough.repeat.set(10, 8);
    // mirror-polished floor: semi transparent over mirrored emissive geometry = cheap planar reflections
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x07070c, roughness: 0.28, metalness: 0.55, roughnessMap: rough, transparent: true, opacity: 0.86 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hz * 2 + 6), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, 3); floor.receiveShadow = true; floor.renderOrder = 1;
    this.group.add(floor);
    const under = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2 + 4, hz * 2 + 10), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    under.rotation.x = -Math.PI / 2; under.position.y = -9.2;
    this.group.add(under);

    const slat = slatNormal();
    const wallMat = (rx: number) => {
      const n = slat.clone(); n.repeat.set(rx, 1); n.needsUpdate = true;
      return new THREE.MeshStandardMaterial({ color: 0x101018, roughness: 0.62, metalness: 0.25, normalMap: n, normalScale: new THREE.Vector2(0.6, 0.6) });
    };
    const wall = (w: number, x: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat(w / 2));
      m.position.set(x, h / 2, z); m.rotation.y = ry;
      this.group.add(m);
      return m;
    };
    wall(hx * 2, 0, -hz, 0);
    wall(hz * 2, -hx, 0, Math.PI / 2);
    wall(hz * 2, hx, 0, -Math.PI / 2);
    // south wall with a doorway
    const sw = (hx * 2 - DOOR.w) / 2;
    wall(sw, -(DOOR.w / 2 + sw / 2), hz, Math.PI);
    wall(sw, DOOR.w / 2 + sw / 2, hz, Math.PI);
    const lintel = new THREE.Mesh(new THREE.PlaneGeometry(DOOR.w, h - DOOR.h), wallMat(1));
    lintel.position.set(0, DOOR.h + (h - DOOR.h) / 2, hz); lintel.rotation.y = Math.PI;
    this.group.add(lintel);
    // entrance vestibule
    const dark = new THREE.MeshStandardMaterial({ color: 0x0c0c12, roughness: 0.8 });
    this.box(0.2, 4, 4, dark, -DOOR.w / 2 - 0.1, 2, hz + 2);
    this.box(0.2, 4, 4, dark, DOOR.w / 2 + 0.1, 2, hz + 2);
    this.box(DOOR.w + 0.4, 0.2, 4, dark, 0, DOOR.h + 0.1, hz + 2);
    this.box(DOOR.w + 0.4, 4, 0.2, dark, 0, 2, hz + 4.1);
    const frame = this.stripMat(0, 3);
    this.box(0.08, DOOR.h, 0.08, frame, -DOOR.w / 2, DOOR.h / 2, hz - 0.05);
    this.box(0.08, DOOR.h, 0.08, frame, DOOR.w / 2, DOOR.h / 2, hz - 0.05);
    this.box(DOOR.w, 0.08, 0.08, frame, 0, DOOR.h, hz - 0.05);
    const doorLight = new THREE.PointLight(0xffc9a0, 14, 9, 1.6);
    doorLight.position.set(0, 2.9, hz + 1.5);
    this.group.add(doorLight);

    // ceiling (hidden for the rooftop decor)
    const ceil = new THREE.Group();
    const cm = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hz * 2), new THREE.MeshStandardMaterial({ color: 0x08080d, roughness: 0.9 }));
    cm.rotation.x = Math.PI / 2; cm.position.y = h;
    ceil.add(cm);
    for (let i = -3; i <= 3; i++) this.box(0.12, 0.06, hz * 2 - 2, this.stripMat(i + 3, 1.4), i * 4.8, h - 0.05, 0, ceil);
    this.group.add(ceil);
    this.ceiling = ceil;

    // red carpet + rope posts
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 11), new THREE.MeshStandardMaterial({ color: 0x8e0b1c, roughness: 0.95, roughnessMap: noiseTexture(128, 3) }));
    carpet.rotation.x = -Math.PI / 2; carpet.position.set(0, 0.012, hz - 3.4); carpet.receiveShadow = true; carpet.renderOrder = 2;
    this.group.add(carpet);
    const gold = new THREE.MeshStandardMaterial({ color: 0xd4a437, roughness: 0.25, metalness: 1 });
    const postGeo = new THREE.CylinderGeometry(0.035, 0.05, 1, 10);
    const posts: [number, number][] = [];
    for (let z = hz - 1.2; z >= hz - 8.4; z -= 2.4) for (const sx of [-1, 1]) posts.push([sx * 1.55, z]);
    const postsMesh = new THREE.InstancedMesh(postGeo, gold, posts.length);
    posts.forEach(([x, z], i) => postsMesh.setMatrixAt(i, this.tmpM.makeTranslation(x, 0.5, z)));
    this.group.add(postsMesh);
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x9c1027, roughness: 0.8 });
    for (const sx of [-1, 1]) {
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 7.2, 6), ropeMat);
      rope.rotation.x = Math.PI / 2; rope.position.set(sx * 1.55, 0.9, hz - 4.8);
      this.group.add(rope);
    }

    // columns + balcony
    const colMat = new THREE.MeshStandardMaterial({ color: 0x15151d, roughness: 0.35, metalness: 0.8 });
    const colMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.24, 0.24, BALCONY.y, 20), colMat, COLUMNS.length);
    const ringMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(0.26, 0.025, 6, 24), this.stripMat(1, 2.5), COLUMNS.length * 2);
    COLUMNS.forEach(([x, z], i) => {
      colMesh.setMatrixAt(i, this.tmpM.makeTranslation(x, BALCONY.y / 2, z));
      for (let k = 0; k < 2; k++) {
        this.tmpM.makeRotationX(Math.PI / 2).setPosition(x, 0.6 + k * 2.6, z);
        ringMesh.setMatrixAt(i * 2 + k, this.tmpM);
      }
    });
    colMesh.castShadow = true;
    this.group.add(colMesh, ringMesh);
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x0d0d14, roughness: 0.4, metalness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.16, depthWrite: false });
    const by = BALCONY.y, d = BALCONY.depth, th = BALCONY.thick;
    const slab = (w: number, dp: number, x: number, z: number) => this.box(w, th, dp, slabMat, x, by - th / 2, z);
    slab(d, hz * 2, hx - d / 2, 0); slab(d, hz * 2, -hx + d / 2, 0); slab(hx * 2 - d * 2, d, 0, hz - d / 2);
    const rail = (w: number, x: number, z: number, ry: number, strip: number) => {
      const g = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.05), glass);
      g.position.set(x, by + 0.55, z); g.rotation.y = ry; g.renderOrder = 3;
      this.group.add(g);
      const top = this.box(w, 0.04, 0.05, slabMat, x, by + 1.08, z); top.rotation.y = ry;
      const s = this.box(w, 0.07, 0.07, this.stripMat(strip, 2.6), x, by - th + 0.02, z); s.rotation.y = ry;
    };
    rail(hz * 2 - d, hx - d, -d / 2, Math.PI / 2, 0);
    rail(hz * 2 - d, -hx + d, -d / 2, Math.PI / 2, 1);
    rail(hx * 2 - d * 2, 0, hz - d, 0, 2);
    // balcony high tables
    const tbl = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 18), slabMat, 10);
    const leg = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.03, 1.05, 8), gold, 10);
    let ti = 0;
    for (const sx of [-1, 1]) for (const z of [-9, -4, 1, 6]) { tbl.setMatrixAt(ti, this.tmpM.makeTranslation(sx * 15.6, by + 1.07, z)); leg.setMatrixAt(ti++, this.tmpM.makeTranslation(sx * 15.6, by + 0.53, z)); }
    for (const x of [-5, 5]) { tbl.setMatrixAt(ti, this.tmpM.makeTranslation(x, by + 1.07, 12)); leg.setMatrixAt(ti++, this.tmpM.makeTranslation(x, by + 0.53, 12)); }
    this.group.add(tbl, leg);

    // LED columns on the side walls above the balcony + neon signs
    for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) {
      const p = this.ledPlane(1.6, 3.4, [8, 17], 5, 1.1, 'side');
      p.position.set(sx * (hx - 0.04), 6.9, -11 + i * 5.2); p.rotation.y = -sx * Math.PI / 2;
      this.group.add(p);
    }
    this.addNeon('NEON CLUB', 11, 2.4, new THREE.Vector3(0, 7.9, -hz + 0.25), 0, 0);
    this.addNeon('NEON CLUB', 7.5, 1.6, new THREE.Vector3(0, by + 2.6, hz - 0.08), Math.PI, 1);
    this.addNeon('VIP', 2.2, 1.0, new THREE.Vector3(hx - 0.08, 3.1, -3.5), -Math.PI / 2, 2);
    this.addNeon('LOUNGE', 3.6, 0.9, new THREE.Vector3(-hx + 0.08, 3.1, -2.5), Math.PI / 2, 1);
    this.addNeon('BAR', 2.4, 1.0, new THREE.Vector3(-hx + 0.08, 3.2, 9.6), Math.PI / 2, 0);
  }

  private addNeon(text: string, w: number, h: number, pos: THREE.Vector3, ry: number, pi: number) {
    const tex = textTexture(text, 1024, Math.round((1024 * h) / w), { outline: true, color: '#ffffff' });
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, color: HDR(this.palette[pi], 2.6), depthWrite: false, side: THREE.DoubleSide });
    mat.userData = { i: pi, k: 2.6 };
    this.neon.push(mat);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.copy(pos); m.rotation.y = ry; m.renderOrder = 4;
    this.group.add(m);
  }

  // ------------------------------------------------------------------ stage, DJ booth, LED wall, dance floor
  private buildStage() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0b11, roughness: 0.3, metalness: 0.7 });
    const st = this.box(STAGE.x1 - STAGE.x0, STAGE.y, STAGE.z1 - STAGE.z0, dark, 0, STAGE.y / 2, (STAGE.z0 + STAGE.z1) / 2);
    st.receiveShadow = true;
    const fascia = this.ledPlane(STAGE.x1 - STAGE.x0, STAGE.y - 0.1, [64, 3], 3, 1.2, 'booth');
    fascia.position.set(0, STAGE.y / 2, STAGE.z1 + 0.01);
    this.group.add(fascia);
    for (const s of STAIRS) {
      const n = 5, alongZ = s.rise;
      for (let i = 0; i < n; i++) {
        const hgt = (s.top * (i + 1)) / n;
        this.box(s.x1 - s.x0, hgt, alongZ / n, dark, (s.x0 + s.x1) / 2, hgt / 2, s.z1 - (i + 0.5) * (alongZ / n)).receiveShadow = true;
      }
      const rest = s.z1 - alongZ - s.z0;
      if (rest > 0.05) this.box(s.x1 - s.x0, s.top, rest, dark, (s.x0 + s.x1) / 2, s.top / 2, s.z0 + rest / 2).receiveShadow = true;
    }
    // main LED wall + mirrored copy under the floor
    const wall = this.ledPlane(16, 6, [96, 36], 1, 0.8, 'wall');
    wall.position.set(0, 4.5, -ROOM.hz + 0.2);
    this.group.add(wall);
    const mirror = new THREE.Mesh(wall.geometry, wall.material);
    mirror.position.set(0, -4.5, -ROOM.hz + 0.2); mirror.scale.y = -1;
    this.group.add(mirror);
    for (const sx of [-1, 1]) {
      const p = this.ledPlane(2.2, 6.4, [12, 36], 3, 1.1, 'side');
      p.position.set(sx * 10.2, 4.4, -ROOM.hz + 0.25);
      this.group.add(p);
    }
    // DJ booth
    const booth = new THREE.Group();
    booth.position.set(DJ.x, STAGE.y, DJ.z + 0.75);
    this.group.add(booth);
    this.box(3.6, 1.0, 0.9, dark, 0, 0.5, 0, booth).castShadow = true;
    const front = this.ledPlane(3.6, 0.95, [36, 10], 0, 1.4, 'booth');
    front.position.set(0, 0.5, 0.46);
    booth.add(front);
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.4, metalness: 0.6 });
    const jogMat = new THREE.MeshStandardMaterial({ color: 0x30303a, roughness: 0.2, metalness: 0.9 });
    for (const sx of [-1, 1]) {
      this.box(0.78, 0.09, 0.62, deckMat, sx * 1.05, 1.045, -0.05, booth);
      const jog = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 28), jogMat);
      jog.position.set(sx * 1.05, 1.11, 0); booth.add(jog);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.21, 0.012, 6, 28), this.stripMat(sx > 0 ? 0 : 1, 3));
      ring.rotation.x = Math.PI / 2; ring.position.set(sx * 1.05, 1.115, 0); booth.add(ring);
      const scr = this.box(0.3, 0.012, 0.16, this.stripMat(2, 1.3), sx * 1.05, 1.095, -0.26, booth);
      scr.rotation.x = -0.3;
    }
    this.box(0.62, 0.1, 0.62, deckMat, 0, 1.05, -0.05, booth);
    const knobs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8), jogMat, 16);
    for (let i = 0; i < 16; i++) knobs.setMatrixAt(i, this.tmpM.makeTranslation(-0.21 + (i % 4) * 0.14, 1.115, -0.26 + Math.floor(i / 4) * 0.11));
    booth.add(knobs);
    for (let i = 0; i < 4; i++) this.box(0.02, 0.012, 0.16, this.stripMat(i, 2.5), -0.21 + i * 0.14, 1.106, 0.17, booth);
    const boothLight = new THREE.PointLight(0x9fb4ff, 5, 5, 1.8);
    boothLight.position.set(0, 2.3, -0.6);
    booth.add(boothLight);

    // speaker stacks on stage + flown arrays
    const spk = new THREE.MeshStandardMaterial({ color: 0x08080b, roughness: 0.7, metalness: 0.2 });
    const cone = new THREE.MeshStandardMaterial({ color: 0x1c1c22, roughness: 0.5, metalness: 0.4 });
    const stacks: [number, number, number, number][] = [];
    for (const sx of [-1, 1]) {
      this.box(1.3, 3.3, 1.1, spk, sx * 7.1, STAGE.y + 1.65, -12.9).castShadow = true;
      for (let k = 0; k < 3; k++) stacks.push([sx * 7.1, STAGE.y + 0.6 + k * 1.05, -12.34, 0.42]);
      const fly = this.box(1.1, 2.4, 0.8, spk, sx * 9.3, 6.6, -10.2); fly.rotation.x = 0.22;
      for (let k = 0; k < 3; k++) stacks.push([sx * 9.3, 5.95 + k * 0.72, -9.76 - k * 0.15, 0.28]);
      this.box(1.2, 1.0, 1.0, spk, sx * 10.4, 0.5, -9).castShadow = true;
      stacks.push([sx * 10.4, 0.5, -8.49, 0.38]);
    }
    this.woofers = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 0.55, 0.12, 24, 1, false), cone, stacks.length);
    const rings = new THREE.InstancedMesh(new THREE.TorusGeometry(1.04, 0.05, 6, 28), this.stripMat(0, 2.2), stacks.length);
    stacks.forEach(([x, y, z, r], i) => {
      const m = new THREE.Matrix4().makeRotationX(Math.PI / 2).scale(new THREE.Vector3(r, 1, r)).setPosition(x, y, z);
      this.wooferBase.push(m);
      this.woofers.setMatrixAt(i, m);
      rings.setMatrixAt(i, new THREE.Matrix4().makeScale(r, r, r).setPosition(x, y, z + 0.03));
    });
    this.group.add(this.woofers, rings);

    // LED dance floor with a glossy cover
    const fw = FLOOR.x1 - FLOOR.x0, fd = FLOOR.z1 - FLOOR.z0;
    const tiles = this.ledPlane(fw, fd, [16, 11.5], 4, 0.85, 'floor', 0);
    tiles.rotation.x = -Math.PI / 2; tiles.position.set(0, 0.02, (FLOOR.z0 + FLOOR.z1) / 2); tiles.renderOrder = 2;
    this.group.add(tiles);
    const cover = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.06, metalness: 0.9, transparent: true, opacity: 0.32, depthWrite: false }));
    cover.rotation.x = -Math.PI / 2; cover.position.set(0, 0.03, (FLOOR.z0 + FLOOR.z1) / 2); cover.receiveShadow = true; cover.renderOrder = 3;
    this.group.add(cover);
    const edge = this.stripMat(1, 2.4);
    this.box(fw + 0.1, 0.04, 0.06, edge, 0, 0.03, FLOOR.z0); this.box(fw + 0.1, 0.04, 0.06, edge, 0, 0.03, FLOOR.z1);
    this.box(0.06, 0.04, fd, edge, FLOOR.x0, 0.03, (FLOOR.z0 + FLOOR.z1) / 2); this.box(0.06, 0.04, fd, edge, FLOOR.x1, 0.03, (FLOOR.z0 + FLOOR.z1) / 2);
  }

  // ------------------------------------------------------------------ VIP, lounge, bar
  private buildFurniture() {
    const dark = new THREE.MeshStandardMaterial({ color: 0x0d0d14, roughness: 0.35, metalness: 0.6 });
    const vw = VIP.x1 - VIP.x0, vd = VIP.z1 - VIP.z0;
    this.box(vw, VIP.y, vd, dark, (VIP.x0 + VIP.x1) / 2, VIP.y / 2, (VIP.z0 + VIP.z1) / 2).receiveShadow = true;
    this.box(0.07, 0.07, vd, this.stripMat(2, 2.6), VIP.x0, VIP.y - 0.04, (VIP.z0 + VIP.z1) / 2);
    this.box(vw, 0.07, 0.07, this.stripMat(2, 2.6), (VIP.x0 + VIP.x1) / 2, VIP.y - 0.04, VIP.z1);
    // velvet rope along the open west edge of the VIP platform
    const gold = new THREE.MeshStandardMaterial({ color: 0xd4a437, roughness: 0.25, metalness: 1 });
    const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.05, 1, 10), gold, 7);
    for (let i = 0; i < 7; i++) posts.setMatrixAt(i, this.tmpM.makeTranslation(VIP.x0 + 0.25, VIP.y + 0.5, VIP.z0 + 0.4 + i * ((vd - 0.8) / 6)));
    this.group.add(posts);
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, vd - 0.8, 6), new THREE.MeshStandardMaterial({ color: 0x9c1027, roughness: 0.8 }));
    rope.rotation.x = Math.PI / 2; rope.position.set(VIP.x0 + 0.25, VIP.y + 0.9, (VIP.z0 + VIP.z1) / 2);
    this.group.add(rope);

    // sofas: seat + back + arm rests as rounded boxes
    const leather = [new THREE.MeshStandardMaterial({ color: 0x2a0d3d, roughness: 0.45, metalness: 0.1 }), new THREE.MeshStandardMaterial({ color: 0x3d0d1c, roughness: 0.5, metalness: 0.1 })];
    for (const s of SOFAS) {
      const g = new THREE.Group();
      const mat = leather[s.x > 0 ? 1 : 0];
      const seat = new THREE.Mesh(new RoundedBoxGeometry(s.len, 0.42, 0.85, 3, 0.08), mat); seat.position.set(0, 0.21, 0);
      const back = new THREE.Mesh(new RoundedBoxGeometry(s.len, 0.6, 0.24, 3, 0.09), mat); back.position.set(0, 0.62, -0.36);
      g.add(seat, back);
      for (const sx of [-1, 1]) { const arm = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.36, 0.85, 3, 0.08), mat); arm.position.set(sx * (s.len / 2 + 0.06), 0.5, 0); g.add(arm); }
      const glow = this.box(s.len, 0.03, 0.04, this.stripMat(s.x > 0 ? 2 : 0, 2), 0, 0.03, 0.42, g);
      glow.visible = true;
      g.position.set(s.x, s.y, s.z); g.rotation.y = s.yaw;
      g.traverse((o) => { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = true; });
      this.group.add(g);
    }
    const top = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 24), new THREE.MeshStandardMaterial({ color: 0x050508, roughness: 0.08, metalness: 0.9 }), TABLES.length);
    const stem = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.16, 0.5, 12), gold, TABLES.length);
    const glassMat = new THREE.MeshBasicMaterial({ color: HDR(0x66e0ff, 1.6), toneMapped: false });
    const glasses = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.03, 0.022, 0.11, 8), glassMat, TABLES.length * 3);
    const r = rng(42);
    TABLES.forEach(([x, z, y], i) => {
      top.setMatrixAt(i, this.tmpM.makeTranslation(x, y + 0.52, z));
      stem.setMatrixAt(i, this.tmpM.makeTranslation(x, y + 0.25, z));
      for (let k = 0; k < 3; k++) {
        const a = r() * TAU;
        glasses.setMatrixAt(i * 3 + k, this.tmpM.makeTranslation(x + Math.cos(a) * 0.22, y + 0.6, z + Math.sin(a) * 0.22));
        glasses.setColorAt(i * 3 + k, HDR([0x66e0ff, 0xff66cc, 0xffd166][k], 1.5));
      }
    });
    this.group.add(top, stem, glasses);
    for (const [x, z, col] of [[14.5, -3, 0xffb07a], [-14.5, -2.5, 0xb48cff]] as const) {
      const l = new THREE.PointLight(col, 9, 10, 1.7);
      l.position.set(x, 3.3, z);
      this.group.add(l);
    }

    // bar (south-west corner)
    const bx = -15.4, bz = 9.4;
    this.box(0.9, 1.1, 7, dark, bx, 0.55, bz).castShadow = true;
    this.box(1.1, 0.06, 7.2, new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 0.06, metalness: 0.9 }), bx, 1.13, bz);
    this.box(0.05, 0.05, 7, this.stripMat(0, 2.8), bx + 0.46, 0.08, bz);
    this.box(0.05, 0.05, 7, this.stripMat(1, 2.2), bx + 0.5, 1.07, bz);
    for (let k = 0; k < 3; k++) this.box(0.3, 0.04, 6.6, dark, -17.75, 1.5 + k * 0.55, bz);
    const bottles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.04, 0.045, 0.3, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), 90);
    const cols = [0x35ff9e, 0xffb300, 0xff4d6d, 0x4dc3ff, 0xc77dff, 0xffffff];
    for (let i = 0; i < 90; i++) {
      bottles.setMatrixAt(i, this.tmpM.makeTranslation(-17.72, 1.68 + Math.floor(i / 30) * 0.55, bz - 3.1 + (i % 30) * 0.21));
      bottles.setColorAt(i, HDR(cols[Math.floor(r() * cols.length)], 0.7 + r() * 0.9));
    }
    this.group.add(bottles);
    const stools = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 16), leatherStool(), 7);
    const stoolLegs = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.025, 0.12, 0.74, 8), gold, 7);
    for (let i = 0; i < 7; i++) { stools.setMatrixAt(i, this.tmpM.makeTranslation(bx + 1.0, 0.77, bz - 2.9 + i * 0.97)); stoolLegs.setMatrixAt(i, this.tmpM.makeTranslation(bx + 1.0, 0.37, bz - 2.9 + i * 0.97)); }
    this.group.add(stools, stoolLegs);
    const barLight = new THREE.PointLight(0x58d6ff, 7, 8, 1.8);
    barLight.position.set(-15, 2.8, bz);
    this.group.add(barLight);
  }

  // ------------------------------------------------------------------ light rig
  private buildRig() {
    this.hemi = new THREE.HemisphereLight(0x8f7cff, 0x1a0a22, 0.55);
    this.group.add(this.hemi);
    this.key = new THREE.SpotLight(0xdfe6ff, 260, 26, 0.95, 0.7, 1.5);
    this.key.position.set(0, 8.7, -1.5);
    this.key.target.position.set(0, 0, -2.2);
    this.key.shadow.camera.near = 2; this.key.shadow.camera.far = 12; this.key.shadow.bias = -0.0008; this.key.shadow.normalBias = 0.02;
    this.group.add(this.key, this.key.target);
    // truss
    const truss = new THREE.MeshStandardMaterial({ color: 0x1b1b22, roughness: 0.4, metalness: 0.9 });
    const beamsGeo: [number, number, number, number, number, number][] = [
      [17, 0.14, 0.14, 0, 7.7, -7.2], [17, 0.14, 0.14, 0, 7.7, 2.6], [0.14, 0.14, 10, -8.4, 7.7, -2.3], [0.14, 0.14, 10, 8.4, 7.7, -2.3], [17, 0.14, 0.14, 0, 7.7, -2.3],
    ];
    for (const [w, h, d, x, y, z] of beamsGeo) this.box(w, h, d, truss, x, y, z);
    for (const [x, y, z] of DISCO_BALLS) {
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 3), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 1, flatShading: true, envMapIntensity: 3 }));
      ball.position.set(x, y, z);
      this.balls.push(ball);
      this.group.add(ball);
      this.box(0.02, 7.7 - y, 0.02, truss, x, (7.7 + y) / 2 + 0.25, z);
    }
    // moving heads
    const coneGeo = new THREE.CylinderGeometry(0.06, 1, 1, 24, 1, true);
    coneGeo.translate(0, -0.5, 0);
    coneGeo.rotateX(Math.PI / 2);          // apex at origin, opens along -Z (lookAt convention)
    const uvs = coneGeo.attributes.uv;
    for (let i = 0; i < uvs.count; i++) uvs.setY(i, uvs.getY(i));
    const fixtures: THREE.Vector3[] = [];
    for (let i = 0; i < 10; i++) {
      const row = i % 2, k = Math.floor(i / 2);
      fixtures.push(new THREE.Vector3(-6.8 + k * 3.4, 7.55, row ? 2.6 : -7.2));
    }
    const headMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.2, 0.34, 12), truss, fixtures.length);
    fixtures.forEach((p, i) => headMesh.setMatrixAt(i, this.tmpM.makeTranslation(p.x, p.y, p.z)));
    this.group.add(headMesh);
    const mk = (origin: THREE.Vector3, i: number): Beam => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
        uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uPower: { value: 1 } },
      });
      const mesh = new THREE.Mesh(coneGeo, mat);
      mesh.position.copy(origin); mesh.frustumCulled = false; mesh.renderOrder = 10;
      this.group.add(mesh);
      return { mesh, mat, origin, target: new THREE.Vector3(), phase: i * 1.7 };
    };
    fixtures.forEach((p, i) => this.beams.push(mk(p, i)));
    this.follow = mk(new THREE.Vector3(0, 8.4, 3.5), 99);
    this.follow.light = new THREE.SpotLight(0xfff2cc, 0, 22, 0.16, 0.5, 1.2);
    this.follow.light.position.copy(this.follow.origin);
    this.group.add(this.follow.light, this.follow.light.target);
    this.follow.mesh.visible = false;

    // lasers (one instanced draw call)
    this.lasers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.025, 0.025, 1).translate(0, 0, 0.5), new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), 24);
    this.lasers.frustumCulled = false; this.lasers.renderOrder = 11;
    this.lasers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.lasers);
    // disco-ball light flecks
    const dotGeo = new THREE.CircleGeometry(0.11, 8);
    this.dots = new THREE.InstancedMesh(dotGeo, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), 150);
    this.dots.frustumCulled = false; this.dots.renderOrder = 9;
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const r = rng(5);
    for (let i = 0; i < 150; i++) {
      const u = r() * 2 - 1, a = r() * TAU, s = Math.sqrt(1 - u * u);
      this.dotDirs.push(new THREE.Vector3(Math.cos(a) * s, u * 0.75 - 0.2, Math.sin(a) * s).normalize());
    }
    this.group.add(this.dots);
    // haze
    const n = 64, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = (r() - 0.5) * 30; pos[i * 3 + 1] = 0.8 + r() * 5.5; pos[i * 3 + 2] = (r() - 0.5) * 22; }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.14)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    this.fog = new THREE.Points(fg, new THREE.PointsMaterial({ map: new THREE.CanvasTexture(c), size: 9, transparent: true, opacity: 0.05, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.fog.frustumCulled = false; this.fog.renderOrder = 8;
    this.group.add(this.fog);
  }

  private buildSky() {
    const sky = new THREE.Group();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(150, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, toneMapped: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vP; float h(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        void main(){ vec3 d = normalize(vP); float t = clamp(d.y, 0.0, 1.0); vec3 c = mix(vec3(0.16, 0.05, 0.2), vec3(0.005, 0.01, 0.04), pow(t, 0.5));
          vec3 q = floor(d * 160.0); float s = step(0.9965, h(q)) * (0.4 + 0.6 * h(q + 1.0)); gl_FragColor = vec4(c + s * step(0.05, d.y), 1.0); }`,
    }));
    sky.add(dome);
    const r = rng(77);
    const n = 70;
    const win = document.createElement('canvas');
    win.width = 32; win.height = 64;
    const g = win.getContext('2d')!;
    g.fillStyle = '#05060c'; g.fillRect(0, 0, 32, 64);
    for (let y = 2; y < 64; y += 4) for (let x = 2; x < 32; x += 4) if (r() < 0.4) { g.fillStyle = r() < 0.7 ? '#ffd9a0' : '#9fd0ff'; g.fillRect(x, y, 2, 2); }
    const tex = new THREE.CanvasTexture(win);
    tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
    const city = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }), n);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + r() * 0.05, d = 55 + r() * 45, h = 14 + r() * 42, w = 7 + r() * 9;
      this.tmpM.compose(this.tmpV.set(Math.cos(a) * d, h / 2 - 6, Math.sin(a) * d), this.tmpQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -a), this.tmpS.set(w, h, w));
      city.setMatrixAt(i, this.tmpM);
    }
    sky.add(city);
    sky.visible = false;
    this.sky = sky;
    this.group.add(sky);
  }

  // ------------------------------------------------------------------ configuration
  applyProfile(p: QualityProfile) {
    this.profile = p;
    this.key.castShadow = p.shadows > 0;
    if (p.shadows) { this.key.shadow.mapSize.set(p.shadows, p.shadows); this.key.shadow.map?.dispose(); (this.key.shadow as unknown as { map: null }).map = null; }
    this.beams.forEach((b, i) => {
      b.mesh.visible = i < p.beams;
      const want = i < p.realSpots;
      if (want && !b.light) {
        b.light = new THREE.SpotLight(0xffffff, 0, 24, 0.3, 0.7, 1.3);
        b.light.position.copy(b.origin);
        this.group.add(b.light, b.light.target);
      }
      if (b.light) b.light.visible = want;
    });
    this.lasers.count = p.lasers;
    this.fog.visible = p.fogSprites > 0;
    this.fog.geometry.setDrawRange(0, p.fogSprites);
    this.envDirty = true;
  }

  setLights(l: LightSettings) { this.settings = { ...l }; this.refreshMode(); }

  setEvent(ev: ClubEvent) {
    ev.palette.forEach((c, i) => this.palette[i].set(c));
    this.modeName = ev.light;
    this.decor = ev.decor;
    this.refreshMode();
    for (const m of [...this.strip, ...this.neon]) m.color.copy(this.palette[m.userData.i]).multiplyScalar(m.userData.k);
    this.ambientTint.copy(this.palette[0]).lerp(this.palette[2], 0.5);
    this.ceiling.visible = ev.decor !== 'rooftop';
    this.sky.visible = ev.decor === 'rooftop';
    this.engine.scene.background = new THREE.Color(ev.decor === 'rooftop' ? 0x040616 : 0x020207);
    this.envDirty = true;
  }

  private refreshMode() {
    const name = this.settings.mode === 'auto' ? this.modeName : this.settings.mode;
    this.mode = LIGHT_MODES[name] ?? LIGHT_MODES.neon;
  }

  /** Message on the big LED wall behind the DJ. */
  djMessage(lines: string[], seconds: number, now: number) {
    const c = this.textCanvas, g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(0,0,0,0.82)'; g.fillRect(0, 0, c.width, c.height);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const sizes = [86, 120, 64];
    const ys = lines.length === 1 ? [192] : lines.length === 2 ? [130, 260] : [84, 196, 312];
    lines.slice(0, 3).forEach((line, i) => {
      let size = lines.length === 1 ? 130 : sizes[i];
      g.font = `800 ${size}px "Segoe UI", Arial, sans-serif`;
      const w = g.measureText(line).width;
      if (w > 960) { size *= 960 / w; g.font = `800 ${size}px "Segoe UI", Arial, sans-serif`; }
      g.fillStyle = i === 1 ? '#ffe27a' : '#ffffff';
      g.fillText(line, c.width / 2, ys[i]);
    });
    this.textTex.needsUpdate = true;
    this.textUntil = now + seconds;
  }

  lightShow(seconds: number, now: number) { this.showUntil = Math.max(this.showUntil, now + seconds); }
  lightTest(now: number) { this.testUntil = now + 6; }
  stopEffects() { this.followUntil = 0; this.showUntil = 0; this.textUntil = 0; this.testUntil = 0; }

  /** Follow-spot on a character (Super Chat effect). */
  spotlight(getPos: () => THREE.Vector3 | null, seconds: number, now: number) { this.followPos = getPos; this.followUntil = now + seconds; }

  // ------------------------------------------------------------------ per frame
  update(dt: number, t: number, a: AudioFrame) {
    const s = this.settings, mode = this.mode;
    const show = t < this.showUntil || t < this.testUntil;
    const I = s.intensity * (show ? 1.35 : 1);
    const kick = a.kick;
    // spectrum texture
    const sd = this.spec.image.data as Uint8Array;
    for (let i = 0; i < 64; i++) sd[i] = Math.min(255, a.spectrum[i] * 255);
    this.spec.needsUpdate = true;
    // LED surfaces
    const wantText = t < this.textUntil ? 1 : 0;
    this.textMix += (wantText - this.textMix) * Math.min(1, dt * 5);
    const bar = Math.floor(a.beats / 16);
    for (const l of this.leds) {
      const u = l.mat.uniforms;
      u.uTime.value = t; u.uBeats.value = a.beats; u.uKick.value = kick; u.uBass.value = a.bass;
      u.uGain.value = l.base * I * (0.75 + 0.35 * a.level);
      if (l.role === 'wall') { u.uPattern.value = show ? 2 : mode.wall[bar % mode.wall.length]; u.uTextMix.value = this.textMix; }
      else if (l.role === 'floor') u.uPattern.value = this.decor === 'retro' ? 4 : this.decor === 'battle' ? 2 : show ? 6 : [4, 6, 4, 2][bar % 4];
      else if (l.role === 'side') u.uPattern.value = show ? 3 : [5, 3, 0][bar % 3];
    }
    // strips + neon breathe with the beat
    for (const m of this.strip) m.color.copy(this.palette[m.userData.i]).multiplyScalar(m.userData.k * I * (0.7 + 0.5 * kick));
    this.neon.forEach((m, i) => m.color.copy(this.palette[m.userData.i]).multiplyScalar(m.userData.k * (0.92 + 0.08 * Math.sin(t * 13 + i * 2.1) * Math.sin(t * 2.3 + i))));
    // ambient
    this.hemi.intensity = (0.32 + 0.3 * mode.ambient) * (0.9 + 0.25 * a.level) * Math.min(1.3, 0.5 + 0.5 * s.intensity);
    this.hemi.color.copy(this.ambientTint).lerp(this.tmpC.set(0xffffff), 0.35);
    const strobeOn = s.strobe && mode.strobe > 0 && a.level > 0.55;
    // capped well below photosensitive thresholds: one soft flash per bar at most
    const flash = strobeOn && a.beat && a.beatCount % 4 === 0 ? 0.05 : 0;
    const vu = this.engine.vignette.uniforms.flash;
    vu.value = Math.max(flash, vu.value * Math.exp(-dt * 9));
    this.key.intensity = 190 * (0.55 + 0.45 * mode.ambient) * s.intensity;
    this.engine.bloom.strength = 0.58 + (show ? 0.15 : 0) + 0.08 * kick;
    const fogK = s.fog;
    (this.engine.scene.fog as THREE.FogExp2).density = 0.006 + 0.012 * fogK;
    (this.engine.scene.fog as THREE.FogExp2).color.copy(this.ambientTint).multiplyScalar(0.09);
    const fm = this.fog.material as THREE.PointsMaterial;
    fm.opacity = 0.05 * fogK * (0.8 + 0.6 * a.level); fm.color.copy(this.ambientTint).lerp(this.tmpC.set(0xffffff), 0.4);
    this.fog.rotation.y = t * 0.012;

    // moving heads
    const speed = mode.beamSpeed * (show ? 2 : 1);
    const pat = Math.floor(a.beats / 32) % 3;
    this.beams.forEach((b, i) => {
      if (!b.mesh.visible) return;
      const ph = t * 0.5 * speed + b.phase;
      let tx: number, tz: number;
      if (pat === 0) { tx = Math.sin(ph) * 6.5; tz = -2.5 + Math.cos(ph * 0.8) * 4.5; }
      else if (pat === 1) { tx = b.origin.x * 0.8 + Math.sin(a.beats * Math.PI * 0.25) * 3; tz = -2.5 + Math.sin(ph * 1.3 + i) * 5; }
      else { const ang = (i / this.beams.length) * TAU + t * 0.35 * speed; const rr = 3.5 + 2.5 * Math.sin(a.beats * Math.PI * 0.125); tx = Math.cos(ang) * rr; tz = -2.5 + Math.sin(ang) * rr; }
      b.target.set(tx, 0, tz);
      this.aim(b, this.palette[(i + Math.floor(a.beats / 8)) % 3], (0.5 + 0.7 * kick + (show ? 0.4 : 0)) * I, 0.055);
    });
    // follow spot
    const fp = t < this.followUntil ? this.followPos?.() : null;
    this.follow.mesh.visible = !!fp;
    if (fp) { this.follow.target.lerp(this.tmpV.copy(fp).setY(fp.y), Math.min(1, dt * 6)); this.aim(this.follow, this.tmpC.set(0xffe9b0), 1.3, 0.035, 200); }
    else if (this.follow.light) this.follow.light.intensity = 0;

    // lasers
    const laserAmt = s.lasers ? (show ? 1 : mode.laser) : 0;
    const nL = this.lasers.count;
    for (let i = 0; i < nL; i++) {
      const side = i % 2 ? 1 : -1, k = Math.floor(i / 2), half = nL / 2;
      const on = laserAmt > 0 && k / half < laserAmt + 0.001;
      const origin = this.tmpV.set(side * 7.4, 7.3, -13.2);
      const fan = (k / Math.max(1, half - 1) - 0.5);
      const sweep = Math.sin(a.beats * Math.PI * 0.25 + (side > 0 ? 0 : Math.PI)) * 0.5;
      const yaw = -side * 0.55 + fan * (0.9 + 0.3 * Math.sin(t * 0.4)) + sweep * 0.5;
      const pitch = -0.36 - 0.22 * Math.sin(a.beats * Math.PI * 0.125 + k * 0.4) - 0.06 * kick;
      this.tmpQ.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      this.tmpM.compose(origin, this.tmpQ, this.tmpS.set(1, 1, on ? 34 : 0.0001));
      this.lasers.setMatrixAt(i, this.tmpM);
      this.lasers.setColorAt(i, this.tmpC.copy(this.palette[(k + Math.floor(a.beats / 4)) % 3]).multiplyScalar(on ? (1.3 + 1.4 * kick) * I : 0));
    }
    this.lasers.instanceMatrix.needsUpdate = true;
    if (this.lasers.instanceColor) this.lasers.instanceColor.needsUpdate = true;

    // disco balls + flecks
    const discoGain = (mode.disco + (this.decor === 'retro' ? 0.2 : 0)) * I;
    this.balls.forEach((b, i) => { b.rotation.y = t * (0.35 + i * 0.07); });
    const per = Math.floor(this.dots.count / this.balls.length);
    let di = 0;
    const { hx, hz, h } = ROOM;
    for (let bi = 0; bi < this.balls.length; bi++) {
      const c = this.balls[bi].position, rot = this.balls[bi].rotation.y;
      const cs = Math.cos(rot), sn = Math.sin(rot);
      for (let k = 0; k < per; k++, di++) {
        const d0 = this.dotDirs[di];
        const dx = d0.x * cs - d0.z * sn, dz = d0.x * sn + d0.z * cs, dy = d0.y;
        // nearest hit with the room box
        let tt = 1e9, nx = 0, ny = 1, nz = 0;
        if (dy < 0) { const q = (0.035 - c.y) / dy; if (q < tt) { tt = q; nx = 0; ny = 1; nz = 0; } }
        if (dy > 0) { const q = (h - 0.05 - c.y) / dy; if (q < tt) { tt = q; nx = 0; ny = -1; nz = 0; } }
        if (dx > 0) { const q = (hx - 0.05 - c.x) / dx; if (q < tt) { tt = q; nx = -1; ny = 0; nz = 0; } }
        if (dx < 0) { const q = (-hx + 0.05 - c.x) / dx; if (q < tt) { tt = q; nx = 1; ny = 0; nz = 0; } }
        if (dz > 0) { const q = (hz - 0.05 - c.z) / dz; if (q < tt) { tt = q; nx = 0; ny = 0; nz = -1; } }
        if (dz < 0) { const q = (-hz + 0.3 - c.z) / dz; if (q < tt) { tt = q; nx = 0; ny = 0; nz = 1; } }
        this.tmpV.set(c.x + dx * tt, c.y + dy * tt, c.z + dz * tt);
        this.tmpQ.setFromUnitVectors(THREE.Object3D.DEFAULT_UP.clone().set(0, 0, 1), this.tmpS.set(nx, ny, nz));
        const sc = discoGain > 0.02 ? 0.7 + tt * 0.06 : 0.0001;
        this.tmpM.compose(this.tmpV, this.tmpQ, this.tmpS.set(sc, sc, sc));
        this.dots.setMatrixAt(di, this.tmpM);
        this.dots.setColorAt(di, this.tmpC.copy(this.palette[di % 3]).lerp(new THREE.Color(1, 1, 1), 0.6).multiplyScalar(discoGain * (0.5 + 0.5 * kick) * 1.2));
      }
    }
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;

    // woofers pump
    for (let i = 0; i < this.wooferBase.length; i++) {
      this.tmpM.copy(this.wooferBase[i]);
      this.tmpM.elements[14] += 0.05 * a.bass * (0.4 + 0.6 * kick);
      this.woofers.setMatrixAt(i, this.tmpM);
    }
    this.woofers.instanceMatrix.needsUpdate = true;

    if (this.envDirty) { this.envDirty = false; this.bakeEnv(); }
  }

  private aim(b: Beam, color: THREE.Color, power: number, widthK: number, lightPower = 85) {
    const dist = b.origin.distanceTo(b.target);
    b.mesh.lookAt(b.target);
    b.mesh.scale.set(dist * widthK * 2.2 + 0.2, dist * widthK * 2.2 + 0.2, dist);
    (b.mat.uniforms.uColor.value as THREE.Color).copy(color);
    b.mat.uniforms.uPower.value = power * 0.55;
    if (b.light?.visible !== false && b.light) {
      b.light.target.position.copy(b.target);
      b.light.color.copy(color);
      b.light.intensity = lightPower * power;
    }
  }

  /** Static environment map so that glossy materials pick up the club lighting. */
  private bakeEnv() {
    const scene = this.engine.scene;
    const hidden: THREE.Object3D[] = [];
    scene.traverse((o) => { if (o.userData.noEnv && o.visible) { o.visible = false; hidden.push(o); } });
    const prevFog = scene.fog;
    scene.fog = null;
    scene.position.y = -3;                 // capture from 3 m above the floor
    scene.updateMatrixWorld(true);
    const old = scene.environment;
    scene.environment = null;
    const rt = this.pmrem.fromScene(scene, 0.03, 0.1, 100);
    scene.position.y = 0;
    scene.updateMatrixWorld(true);
    scene.fog = prevFog;
    scene.environment = rt.texture;
    scene.environmentIntensity = 0.9;
    old?.dispose();
    for (const o of hidden) o.visible = true;
  }
}

function leatherStool() { return new THREE.MeshStandardMaterial({ color: 0x241028, roughness: 0.5 }); }
