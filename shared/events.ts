import type { ClubEvent } from './protocol.ts';

/** Night programme. Each event changes music genre, light rig, palette, decor and dances. */
export const EVENTS: ClubEvent[] = [
  { id: 'neon', name: { tr: 'Neon Night', en: 'Neon Night' }, genre: 'edm', palette: ['#ff2bd6', '#19e3ff', '#7a5cff'],
    dances: ['edm_pump', 'freestyle_a', 'house_jack', 'shuffle_run', 'hands_up'], light: 'neon', decor: 'default' },
  { id: 'retro', name: { tr: 'Retro Disco', en: 'Retro Disco' }, genre: 'disco', palette: ['#ffb300', '#ff3d7f', '#a64dff'],
    dances: ['disco_point', 'disco_roll', 'twist', 'step_touch'], light: 'disco', decor: 'retro' },
  { id: 'techno', name: { tr: 'Techno Festival', en: 'Techno Festival' }, genre: 'techno', palette: ['#ff1a1a', '#ffffff', '#3355ff'],
    dances: ['techno_stomp', 'edm_pump', 'shuffle_run', 'shuffle_t', 'robot_a'], light: 'techno', decor: 'default' },
  { id: '90s', name: { tr: "90'lar Gecesi", en: '90s Night' }, genre: 'synthwave', palette: ['#00ffa6', '#ff5ac8', '#ffe14d'],
    dances: ['twist', 'arms_90s', 'step_touch', 'hiphop_bounce', 'robot_b'], light: 'color', decor: 'retro' },
  { id: 'battle', name: { tr: 'Dans Kapışması', en: 'Dance Battle' }, genre: 'hiphop', palette: ['#ff6a00', '#00c2ff', '#ffffff'],
    dances: ['break_toprock', 'break_floor', 'hiphop_bounce', 'hiphop_groove', 'freestyle_b'], light: 'show', decor: 'battle', special: 'battle' },
  { id: 'choreo', name: { tr: 'Grup Koreografisi', en: 'Group Choreography' }, genre: 'deephouse', palette: ['#31ffb0', '#3d7bff', '#ff4de1'],
    dances: ['choreo_a', 'choreo_b'], light: 'color', decor: 'default', special: 'choreo' },
  { id: 'djshow', name: { tr: 'DJ Show', en: 'DJ Show' }, genre: 'progressive', palette: ['#4d7dff', '#b44dff', '#ffffff'],
    dances: ['hands_up', 'edm_pump', 'house_jack', 'freestyle_a'], light: 'show', decor: 'default', special: 'djshow' },
  { id: 'laser', name: { tr: 'Lazer Gösterisi', en: 'Laser Show' }, genre: 'trance', palette: ['#00ff66', '#00d0ff', '#ff00aa'],
    dances: ['trance_wave', 'hands_up', 'freestyle_a', 'shuffle_t'], light: 'laser', decor: 'default', special: 'lasershow' },
  { id: 'color', name: { tr: 'Renk Temalı Parti', en: 'Colour Party' }, genre: 'turkish', palette: ['#ff3355', '#ffd23f', '#3bceac'],
    dances: ['freestyle_b', 'step_touch', 'disco_roll', 'house_step', 'hiphop_groove'], light: 'color', decor: 'default' },
  { id: 'rooftop', name: { tr: 'Rooftop Party', en: 'Rooftop Party' }, genre: 'deephouse', palette: ['#ff9d5c', '#ff5c8a', '#6c5cff'],
    dances: ['house_step', 'house_jack', 'slow_sway', 'step_touch', 'freestyle_a'], light: 'warm', decor: 'rooftop' },
];

export const eventById = (id: string) => EVENTS.find((e) => e.id === id) ?? EVENTS[0];
