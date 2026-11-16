// Character / animation test page: /viewer?clip=shuffle_run&seed=5&n=6
// Shows generated characters playing any clip of the motion library (used for animation tests).
import * as THREE from 'three';
import { loadArchetypes } from '../live/chars/assets.ts';
import { Character } from '../live/chars/character.ts';
import { CLIPS } from '../live/chars/dances.ts';
import { makeLook } from '../live/chars/look.ts';
import { charGlobals, loadCharTextures } from '../live/chars/material.ts';

const q = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a24);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.4));
const dl = new THREE.DirectionalLight(0xffffff, 2.2); dl.position.set(2, 4, 3); scene.add(dl);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x2a2a34 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
scene.add(new THREE.GridHelper(40, 40, 0x555566, 0x333344));
const n = Number(q.get('n') ?? 4), dist = Number(q.get('d') ?? 2.6 + n * 0.75), ty = Number(q.get('y') ?? 0.95);
const ang = Number(q.get('view') ?? 0.35);
const cam = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 80);
cam.position.set(Math.sin(ang) * dist, ty + 0.5, Math.cos(ang) * dist); cam.lookAt(0, ty, 0);
loadCharTextures();
const names = (q.get('clip') ?? 'hiphop_bounce').split(',');
const bpm = Number(q.get('bpm') ?? 124), freeze = q.get('t');
const seed0 = Number(q.get('seed') ?? 1);

const arch = await loadArchetypes();
const chars: Character[] = [];
for (let i = 0; i < n; i++) {
  const look = makeLook((seed0 + i * 7919) * 2654435761 >>> 0, Number(q.get('outfit') ?? 0), 0, arch);
  const c = new Character(arch[look.arch], look);
  c.group.position.x = (i - (n - 1) / 2) * 1.1;
  c.play(names[i % names.length], 0);
  scene.add(c.group);
  chars.push(c);
}
const sel = document.createElement('select');
sel.style.cssText = 'position:fixed;left:10px;top:10px;font:14px sans-serif';
for (const k of Object.keys(CLIPS)) sel.add(new Option(k, k, false, k === names[0]));
sel.onchange = () => chars.forEach((c) => (CLIPS[sel.value].loop === false ? c.playOnce(sel.value) : c.play(sel.value)));
if (!q.has('shot')) document.body.appendChild(sel);

const clock = new THREE.Clock();
let beats = 0, frames = 0;
function frame() {
  const dt = Math.min(0.05, clock.getDelta());
  beats = freeze !== null ? Number(freeze) : beats + (dt * bpm) / 60;
  charGlobals.uTime.value += dt;
  const stride = 1.3;
  for (const c of chars) {
    if (freeze !== null && CLIPS[c.clipName]?.unit === 'cycle') { c.update(0, 0, 0, 0); (c.mixer as any)._actions[0].time = Number(freeze); c.mixer.update(0); }
    else c.update(freeze !== null ? 1e-4 : dt, beats, bpm / 60, stride);
  }
  renderer.render(scene, cam);
  if (++frames === 4) document.title = `ready ${renderer.info.render.triangles}`;
  requestAnimationFrame(frame);
}
frame();
