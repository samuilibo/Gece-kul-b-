import * as THREE from 'three';
import { rng } from '../engine.ts';
import type { Archetype } from './assets.ts';

// region ids written by tools/build_characters.py
export const REG = { skin: 0, top: 1, bottom: 2, shoe: 3, sole: 4, hair: 5, eye: 6, dark: 7, outer: 8, hat: 9, acc: 10, lens: 11 } as const;

const SKIN = ['#f0c8a6', '#e2ae88', '#c98f66', '#a66d45', '#7c4c2d', '#54321e'];
const SKIN_RANGE: Record<string, [number, number]> = { m1: [0, 2], m2: [4, 5], m3: [0, 2], m4: [2, 4], f1: [0, 2], f2: [3, 5], f3: [0, 1], f4: [1, 3] };
const HAIR = ['#0c0a09', '#1d130d', '#3a2414', '#5b3a1e', '#8a5a2b', '#c9a15a', '#7a2a12', '#8d8d92'];
const HAIR_DYED = ['#ff3fb4', '#35c8ff', '#7dff6a', '#a45cff', '#ff7a1a', '#f4f4f4'];
const EYES = ['#3b2414', '#5a3a1c', '#2f5f8f', '#3f7a55', '#6f7f8f', '#22140c'];
const BRIGHT = ['#ff2e63', '#08d9d6', '#ffd23f', '#7b2cbf', '#06d6a0', '#ff7b00', '#3a86ff', '#ff5ec4', '#f1f1f1', '#c1121f', '#2ec4b6', '#b5e61d'];
const MUTED = ['#16161d', '#22223b', '#2b2d42', '#3d405b', '#1b263b', '#3c3c3c', '#4a4e69', '#283618', '#582f0e', '#f5f3f4'];
const DENIM = ['#1f3a5f', '#2c4a70', '#15202b', '#3b5b82', '#111318', '#4a5a6a'];
const SHOE = ['#f4f4f4', '#101014', '#e63946', '#ffd23f', '#2b2d42', '#06d6a0'];

export interface Look {
  arch: number;
  parts: string[];
  pal: THREE.Color[];        // 12 region colours
  lip: THREE.Color;
  brow: THREE.Color;
  eye: THREE.Color;
  beard: number;
  scale: number;             // uniform scale -> body height variety
  key: string;
  style: string;
}

const STYLES = ['club', 'sport', 'street', 'night', 'smart', 'party', 'retro'] as const;
const pick = <T,>(r: () => number, a: readonly T[]) => a[Math.floor(r() * a.length)];

/** Deterministic appearance from (seed, outfit, color). !outfit / !color only bump the counters. */
export function makeLook(seed: number, outfit: number, color: number, archetypes: Archetype[]): Look {
  const r = rng(seed);
  const arch = Math.floor(r() * archetypes.length);
  const a = archetypes[arch];
  const fem = a.gender === 'f';
  const [s0, s1] = SKIN_RANGE[a.id] ?? [0, 5];
  const skin = new THREE.Color(SKIN[s0 + Math.floor(r() * (s1 - s0 + 1))]);
  skin.offsetHSL((r() - 0.5) * 0.015, (r() - 0.5) * 0.08, (r() - 0.5) * 0.05);
  const dyed = r() < 0.16;
  const hairCol = new THREE.Color(dyed ? pick(r, HAIR_DYED) : pick(r, HAIR));
  const eye = new THREE.Color(pick(r, EYES));
  const beard = !fem && r() < 0.4 ? 0.35 + r() * 0.55 : 0;
  const scale = (fem ? 1.64 : 1.77) * (0.95 + r() * 0.1) / a.height;
  const hairBase = fem ? ['hair_long', 'hair_bob', 'hair_pony', 'hair_bun', 'hair_long', 'hair_afro', 'hair_short']
    : ['hair_short', 'hair_buzz', 'hair_short', 'hair_afro', 'hair_bun', 'hair_long', 'hair_buzz'];
  let hair = pick(r, hairBase);
  const glasses = r();
  const band = r() < 0.3;
  const styleBase = Math.floor(r() * STYLES.length);

  // ---- outfit: depends on the !outfit counter
  const ro = rng((seed ^ 0x9e3779b9) + outfit * 7919);
  const style = STYLES[(styleBase + outfit) % STYLES.length];
  let top = 'top_tee', bottom = 'bot_pants', shoe = 'shoe_sneaker', outer = '', hat = '', acc = '';
  let dress = false;
  switch (style) {
    case 'club': top = pick(ro, ['top_tee', 'top_long', 'top_tank']); bottom = fem ? pick(ro, ['bot_pants', 'bot_skirt', 'bot_leggings']) : pick(ro, ['bot_pants', 'bot_baggy']); break;
    case 'sport': top = pick(ro, ['top_tank', 'top_tee']); bottom = fem ? pick(ro, ['bot_leggings', 'bot_shorts']) : 'bot_shorts'; hat = ro() < 0.35 ? 'hat_cap' : ''; acc = ro() < 0.3 ? 'acc_headphones' : ''; break;
    case 'street': top = 'top_hoodie'; bottom = pick(ro, ['bot_baggy', 'bot_pants']); hat = pick(ro, ['hat_cap', 'hat_beanie', '', '']); break;
    case 'night': top = pick(ro, ['top_tee', 'top_tank']); outer = 'outer_jacket'; bottom = fem && ro() < 0.5 ? 'bot_skirt' : 'bot_pants'; shoe = 'shoe_boot'; break;
    case 'smart': top = 'top_long'; outer = 'outer_vest'; bottom = 'bot_pants'; shoe = 'shoe_boot'; break;
    case 'party': if (fem) { top = pick(ro, ['top_tank', 'top_tee']); bottom = 'bot_skirt'; dress = true; } else { top = 'top_tee'; outer = 'outer_vest'; bottom = 'bot_shorts'; } break;
    case 'retro': top = pick(ro, ['top_tee', 'top_long']); bottom = fem ? 'bot_skirt' : 'bot_baggy'; acc = 'acc_shades'; break;
  }
  if (!acc) acc = glasses < 0.12 ? 'acc_glasses' : glasses < 0.3 ? 'acc_shades' : glasses < 0.36 && !hat ? 'acc_headphones' : '';
  if (hat) {
    // hats sit on the scalp: full hair volumes are swapped for versions that fit underneath
    hair = hair === 'hair_long' ? 'hair_long_low' : hair === 'hair_bob' ? 'hair_bob_low' : 'hair_buzz';
    if (acc === 'acc_headphones') acc = '';
  }
  const parts = [top, bottom, shoe, hair];
  if (bottom === 'bot_skirt') parts.push('bot_under');
  if (outer) parts.push(outer);
  if (hat) parts.push(hat);
  if (acc) parts.push(acc);
  if (band) parts.push('acc_band');
  if (hair.endsWith('_low')) parts.push('hair_buzz');

  // ---- colours: depend on the !color counter
  const rc = rng((seed ^ 0x51ed270b) + color * 104729 + outfit * 31);
  const pal: THREE.Color[] = [];
  for (let i = 0; i < 12; i++) pal.push(new THREE.Color(0x808080));
  const brightTop = style !== 'smart' && rc() < 0.7;
  const topCol = new THREE.Color(brightTop ? pick(rc, BRIGHT) : pick(rc, MUTED));
  const botCol = new THREE.Color(dress ? topCol : style === 'sport' || style === 'retro' ? pick(rc, [...MUTED, ...BRIGHT]) : rc() < 0.5 ? pick(rc, DENIM) : pick(rc, MUTED));
  pal[REG.skin] = skin;
  pal[REG.top] = topCol;
  pal[REG.bottom] = botCol;
  pal[REG.shoe] = new THREE.Color(pick(rc, SHOE));
  pal[REG.sole] = new THREE.Color(rc() < 0.7 ? '#f2f2f2' : '#151515');
  pal[REG.hair] = hairCol;
  pal[REG.eye] = new THREE.Color('#ffffff');
  pal[REG.dark] = new THREE.Color('#0a0808');
  pal[REG.outer] = new THREE.Color(style === 'night' ? pick(rc, ['#0e0e12', '#3a1f14', '#1d2b53', '#5c0f1f', '#f1f1f1']) : pick(rc, MUTED));
  pal[REG.hat] = new THREE.Color(rc() < 0.5 ? pick(rc, BRIGHT) : pick(rc, MUTED));
  pal[REG.acc] = new THREE.Color(acc === 'acc_headphones' ? pick(rc, ['#f1f1f1', '#111111', '#ff2e63']) : pick(rc, ['#d4af37', '#c0c0c8', '#22222a', '#ff5ec4']));
  pal[REG.lens] = new THREE.Color(pick(rc, ['#050508', '#1a0f2e', '#2a1206']));
  const lip = skin.clone().lerp(new THREE.Color(fem ? pick(r, ['#b3243b', '#c2456b', '#8e2b3d', '#d16a6a']) : '#9c5a4c'), fem ? 0.75 : 0.3);
  const brow = hairCol.clone().lerp(new THREE.Color('#1a120c'), dyed ? 0.8 : 0.35);
  return { arch, parts, pal, lip, brow, eye, beard, scale, style, key: `${arch}:${parts.join(',')}` };
}
