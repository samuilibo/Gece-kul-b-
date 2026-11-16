import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface LodData {
  attrs: Record<string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute>;
  parts: Map<string, Uint16Array>;                         // wearable part -> triangle indices
  skin: { idx: Uint16Array; hiddenBy: string[] }[];        // body skin, split by "covered by garment X"
}
export interface BoneDef { name: string; parent: number; pos: THREE.Vector3 }
export interface Archetype {
  id: string;
  index: number;
  gender: 'm' | 'f';
  height: number;
  eyeY: number;
  headTop: number;
  lods: LodData[];
  crowdLod: LodData | null;                               // LOD3, drawn by the GPU crowd renderer
  bones: BoneDef[];
  inverses: THREE.Matrix4[];
  rest: Map<string, THREE.Vector3>;                        // rest pose joint positions (model space)
  clips: Map<string, THREE.AnimationClip>;                 // baked lazily per archetype
  geoCache: Map<string, THREE.BufferGeometry[]>;
}

export const ARCHETYPE_IDS = ['m1', 'm2', 'm3', 'm4', 'f1', 'f2', 'f3', 'f4'];

function concat(list: Uint16Array[]): Uint16Array {
  let n = 0;
  for (const a of list) n += a.length;
  const out = new Uint16Array(n);
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

export async function loadArchetypes(base = '/assets/characters', onProgress?: (done: number, total: number) => void): Promise<Archetype[]> {
  const loader = new GLTFLoader();
  let done = 0;
  return Promise.all(ARCHETYPE_IDS.map(async (id, index) => {
    const gltf = await loader.loadAsync(`${base}/${id}.glb`);
    onProgress?.(++done, ARCHETYPE_IDS.length);
    const root = gltf.scene.children[0] ?? gltf.scene;
    const lm = (gltf.scene.getObjectByName(id)?.userData ?? root.userData) as { height: number; eyeY: number; headTop: number; gender: 'm' | 'f' };
    const lods: LodData[] = [];
    let skeleton: THREE.Skeleton | null = null;
    for (let li = 0; li < 4; li++) {
      const node = gltf.scene.getObjectByName(`LOD${li}`);
      if (!node) { if (li === 3) break; throw new Error(`${id}: LOD${li} missing`); }
      const meshes: THREE.SkinnedMesh[] = [];
      node.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
      skeleton ??= meshes[0].skeleton;
      const attrs = { ...meshes[0].geometry.attributes } as LodData['attrs'];
      const byPart = new Map<string, Uint16Array[]>();
      const skin: LodData['skin'] = [];
      for (const m of meshes) {
        const ud = m.geometry.userData as { name: string; part: string; hiddenBy?: string[] };
        const idx = m.geometry.index!.array as Uint16Array;
        if (ud.part === 'skin') skin.push({ idx, hiddenBy: ud.hiddenBy ?? [] });
        else { if (!byPart.has(ud.part)) byPart.set(ud.part, []); byPart.get(ud.part)!.push(idx); }
      }
      const parts = new Map<string, Uint16Array>();
      for (const [k, v] of byPart) parts.set(k, concat(v));
      lods.push({ attrs, parts, skin });
    }
    const sk = skeleton!;
    const bones: BoneDef[] = sk.bones.map((b) => ({ name: b.name, parent: sk.bones.indexOf(b.parent as THREE.Bone), pos: b.position.clone() }));
    const rest = new Map<string, THREE.Vector3>();
    bones.forEach((b) => rest.set(b.name, b.parent >= 0 ? rest.get(bones[b.parent].name)!.clone().add(b.pos) : b.pos.clone()));
    return {
      id, index, gender: lm.gender, height: lm.height, eyeY: lm.eyeY, headTop: lm.headTop, lods: lods.slice(0, 3), crowdLod: lods[3] ?? null, bones,
      inverses: sk.boneInverses.map((m) => m.clone()), rest, clips: new Map(), geoCache: new Map(),
    } satisfies Archetype;
  }));
}

/** One geometry (= one draw call) per LOD for a given set of worn parts. Attributes are shared. */
export function buildGeometries(a: Archetype, parts: string[]): THREE.BufferGeometry[] {
  const key = parts.join('|');
  const hit = a.geoCache.get(key);
  if (hit) { hit[0].userData.refs++; return hit; }
  const worn = new Set(parts);
  const geos = a.lods.map((lod) => {
    const list: Uint16Array[] = [];
    for (const s of lod.skin) if (!s.hiddenBy.some((h) => worn.has(h))) list.push(s.idx);
    for (const p of ['eyes', ...parts]) { const idx = lod.parts.get(p); if (idx) list.push(idx); }
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(lod.attrs)) g.setAttribute(name, attr);
    g.setIndex(new THREE.BufferAttribute(concat(list), 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.6);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-1.2, -0.2, -1.2), new THREE.Vector3(1.2, 2.3, 1.2));
    return g;
  });
  geos[0].userData.refs = 1;
  geos[0].userData.key = key;
  a.geoCache.set(key, geos);
  return geos;
}

/** Releases a geometry set; the shared vertex buffers stay alive, only the index buffers go. */
export function releaseGeometries(a: Archetype, geos: THREE.BufferGeometry[]) {
  if (--geos[0].userData.refs > 0) return;
  a.geoCache.delete(geos[0].userData.key);
  for (const g of geos) {
    // drop references to shared attributes first so dispose() only frees the index buffer
    for (const name of Object.keys(g.attributes)) g.deleteAttribute(name);
    g.dispose();
  }
}
