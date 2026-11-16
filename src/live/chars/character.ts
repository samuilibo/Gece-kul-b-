import * as THREE from 'three';
import { buildGeometries, releaseGeometries, type Archetype } from './assets.ts';
import { relaxHands } from './anim.ts';
import { getClip, rigOf } from './dances.ts';
import type { Look } from './look.ts';
import { applyLook, createCharMaterial, type CharUniforms } from './material.ts';

const IDENT = new THREE.Matrix4();
const BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.7);
const mod = (x: number, m: number) => ((x % m) + m) % m;

export interface TagInfo { name: string; demo: boolean; vip: boolean; avatar?: string; platform?: string }
const PLATFORM_COLOR: Record<string, string> = { twitch: '#9146ff', kick: '#53fc18', tiktok: '#ff2c55' };

/** One rigged, clothed human: a single SkinnedMesh (one draw call) + skeleton + mixer + name tag. */
export class Character {
  group = new THREE.Group();
  mesh: THREE.SkinnedMesh;
  bones = new Map<string, THREE.Bone>();
  mixer: THREE.AnimationMixer;
  uniforms: CharUniforms;
  tag: THREE.Sprite | null = null;
  lod = 0;
  skip = false;                 // when true the sub-tree world matrices are not refreshed this frame
  clipName = '';
  phase = 0;                    // per-character beat offset for looping dances
  private geos: THREE.BufferGeometry[];
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private once: { action: THREE.AnimationAction; back: string } | null = null;
  private tagTex: THREE.CanvasTexture | null = null;
  private tagInfo: TagInfo | null = null;
  headY: number;

  constructor(public arch: Archetype, public look: Look) {
    this.geos = buildGeometries(arch, look.parts);
    const { material, uniforms } = createCharMaterial(look);
    this.uniforms = uniforms;
    this.mesh = new THREE.SkinnedMesh(this.geos[0], material);
    const list: THREE.Bone[] = [];
    for (const b of arch.bones) {
      const bone = new THREE.Bone();
      bone.name = b.name;
      bone.position.copy(b.pos);
      list.push(bone);
      this.bones.set(b.name, bone);
      if (b.parent >= 0) list[b.parent].add(bone); else this.group.add(bone);
    }
    relaxHands(rigOf(arch), this.bones);
    this.mesh.bind(new THREE.Skeleton(list, arch.inverses), IDENT);
    this.mesh.boundingSphere = BOUNDS;
    this.mesh.castShadow = true;
    this.group.add(this.mesh);
    this.group.scale.setScalar(look.scale);
    this.headY = arch.headTop * look.scale;
    this.mixer = new THREE.AnimationMixer(this.group);
    // animation LOD: a throttled character keeps last frame's matrices
    const base = this.group.updateMatrixWorld.bind(this.group);
    this.group.updateMatrixWorld = (force?: boolean) => { if (!this.skip) base(force); };
  }

  setLook(look: Look) {
    if (look.key !== this.look.key) {
      const old = this.geos;
      this.geos = buildGeometries(this.arch, look.parts);
      this.mesh.geometry = this.geos[this.lod];
      releaseGeometries(this.arch, old);
    }
    this.look = look;
    applyLook(this.uniforms, look);
    this.group.scale.setScalar(look.scale);
  }

  setLod(i: number, shadows: boolean) {
    if (i !== this.lod) { this.lod = i; this.mesh.geometry = this.geos[i]; }
    this.mesh.castShadow = shadows && i < 2;
  }

  private action(name: string) {
    let a = this.actions.get(name);
    if (!a) {
      const clip = getClip(this.arch, name);
      a = this.mixer.clipAction(clip);
      if (!clip.userData.loop) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions.set(name, a);
    }
    return a;
  }

  /** Cross-fades to a looping clip. Beat-synchronous clips are locked to the global beat clock. */
  play(name: string, fade = 0.35) {
    if (this.clipName === name && !this.once) return;
    const next = this.action(name);
    const prev = this.once?.action ?? this.current;
    this.once = null;
    next.reset(); next.enabled = true; next.setEffectiveWeight(1); next.play();
    if (prev && prev !== next) { prev.crossFadeTo(next, fade, false); } else next.fadeIn(fade);
    this.current = next;
    this.clipName = name;
  }

  /** Plays a one-shot gesture and returns to the previous loop afterwards. */
  playOnce(name: string, fade = 0.25) {
    const back = this.once?.back ?? this.clipName;
    const a = this.action(name);
    const prev = this.once?.action ?? this.current;
    a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.play();
    if (prev && prev !== a) prev.crossFadeTo(a, fade, false);
    this.once = { action: a, back };
    this.clipName = name;
  }

  get busy() { return this.once !== null; }

  /**
   * @param dt seconds since this character was last updated (may span several frames)
   * @param beats global beat clock, @param bps beats per second, @param speed ground speed for gait clips
   */
  update(dt: number, beats: number, bps: number, speed: number) {
    if (this.once) {
      const a = this.once.action, clip = a.getClip();
      a.timeScale = bps;
      if (a.time >= clip.duration - 0.3 * bps - 1e-3) { const back = this.once.back; this.once = null; this.current = a; this.clipName = ''; this.play(back || 'idle', 0.3); }
    }
    const c = this.current;
    if (c && !this.once) {
      const clip = c.getClip();
      if (clip.userData.unit === 'cycle') c.timeScale = speed / (clip.userData.stride as number);
      else if (clip.userData.loop) { c.timeScale = 0; c.time = mod(beats + this.phase, clip.duration); }
      else c.timeScale = bps;
    }
    this.mixer.update(dt);
  }

  // ------------------------------------------------------------------ name tag
  setTag(info: TagInfo | null) {
    if (!info) { if (this.tag) this.tag.visible = false; return; }
    const same = this.tagInfo && this.tagInfo.name === info.name && this.tagInfo.vip === info.vip && this.tagInfo.avatar === info.avatar && this.tagInfo.platform === info.platform;
    if (!this.tag) {
      const c = document.createElement('canvas');
      c.width = 384; c.height = 96;
      this.tagTex = new THREE.CanvasTexture(c);
      this.tagTex.colorSpace = THREE.SRGBColorSpace;
      this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthWrite: false, toneMapped: false, fog: false, color: new THREE.Color(0.62, 0.62, 0.62) }));
      this.tag.renderOrder = 20;
      this.tag.userData.noEnv = true;
      this.group.add(this.tag);
    }
    this.tag.visible = true;
    const inv = 1 / this.look.scale;
    this.tag.position.set(0, (this.headY + 0.28) * inv, 0);
    this.tag.scale.set(1.1 * inv, 0.275 * inv, 1);
    if (same) return;
    this.tagInfo = { ...info };
    this.drawTag(null);
    if (info.avatar) {
      const img = new Image();
      img.onload = () => { if (this.tagInfo?.avatar === info.avatar) this.drawTag(img); };
      img.src = info.avatar;
    }
  }

  private drawTag(avatar: HTMLImageElement | null) {
    const info = this.tagInfo!, c = this.tagTex!.image as HTMLCanvasElement, g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    g.font = '700 40px "Segoe UI", Arial, sans-serif';
    const badge = info.demo ? 'DEMO' : info.vip ? 'VIP' : '';
    g.font = '800 24px "Segoe UI", Arial, sans-serif';
    const bw = badge ? g.measureText(badge).width + 20 : 0;
    g.font = '700 40px "Segoe UI", Arial, sans-serif';
    let name = info.name;
    const maxW = c.width - 40 - (avatar ? 76 : 0) - (bw ? bw + 10 : 0) - (info.platform && PLATFORM_COLOR[info.platform] ? 22 : 0);
    while (g.measureText(name).width > maxW && name.length > 3) name = name.slice(0, -2) + '…';
    const tw = g.measureText(name).width;
    const dot = info.platform && PLATFORM_COLOR[info.platform] ? 22 : 0;   // small platform marker for multi-platform streams
    const w = tw + 36 + dot + (avatar ? 76 : 0) + (bw ? bw + 10 : 0), x0 = (c.width - w) / 2;
    g.fillStyle = 'rgba(8,6,18,0.62)';
    g.beginPath(); g.roundRect(x0, 12, w, 72, 36); g.fill();
    let x = x0 + 18;
    if (avatar) {
      g.save(); g.beginPath(); g.arc(x0 + 40, 48, 30, 0, Math.PI * 2); g.clip();
      g.drawImage(avatar, x0 + 10, 18, 60, 60); g.restore();
      x = x0 + 80;
    }
    g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.textAlign = 'left';
    if (dot) { g.fillStyle = PLATFORM_COLOR[info.platform!]; g.beginPath(); g.arc(x + 8, 48, 8, 0, Math.PI * 2); g.fill(); x += dot; g.fillStyle = '#ffffff'; }
    g.fillText(name, x, 50);
    if (badge) {
      const bx = x + tw + 10;
      g.fillStyle = info.demo ? '#ff9f1c' : '#ffd23f';
      g.beginPath(); g.roundRect(bx, 30, bw, 36, 10); g.fill();
      g.fillStyle = '#111'; g.font = '800 24px "Segoe UI", Arial, sans-serif'; g.textAlign = 'center';
      g.fillText(badge, bx + bw / 2, 49);
    }
    this.tagTex!.needsUpdate = true;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.group);
    this.group.removeFromParent();
    releaseGeometries(this.arch, this.geos);
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.skeleton.dispose();
    this.tagTex?.dispose();
    (this.tag?.material as THREE.Material | undefined)?.dispose();
  }
}
