// Club floor plan (metres). +Z = entrance (south), -Z = DJ stage (north), +X = VIP (east).
export const ROOM = { hx: 18, hz: 14, h: 9 };
export const STAGE = { x0: -8, x1: 8, z0: -14, z1: -9.5, y: 0.9 };
export const FLOOR = { x0: -8, x1: 8, z0: -8, z1: 3.5 };
export const VIP = { x0: 11, x1: 18, z0: -9, z1: 3, y: 0.45 };
export const LOUNGE = { x0: -18, x1: -11, z0: -9, z1: 4 };
export const DOOR = { x: 0, z: 14, w: 3, h: 3.2 };
export const BALCONY = { y: 4.4, depth: 5, thick: 0.35 };
export const DJ = { x: 0, z: -11.9 };
export const SPAWN = { x: 0, z: 16.2 };
export const COLUMNS: [number, number][] = [
  [13, -8], [13, -2], [13, 4], [-13, -8], [-13, -2], [-13, 4], [-7, 9], [7, 9], [13, 9], [-13, 9],
];
export const DISCO_BALLS: [number, number, number][] = [[0, 6.4, -2.5], [-5.2, 6.7, -5], [5.2, 6.7, -5]];
export const STAIRS = [
  // side stairs up to the stage (rise along -z) and the VIP steps (rise along -z)
  { x0: 8, x1: 9.6, z0: -12.6, z1: -9.5, top: STAGE.y, rise: 1.9 },
  { x0: -9.6, x1: -8, z0: -12.6, z1: -9.5, top: STAGE.y, rise: 1.9 },
  { x0: 12.5, x1: 15.5, z0: 3, z1: 4.3, top: VIP.y, rise: 1.3 },
];

export interface Seat { x: number; z: number; yaw: number; y: number }

/** Stairs from the dance-floor level up to the south balcony (rising towards -x), and the landing at the top. */
export const BAL_STAIR = { x0: -10.6, x1: -4.0, z0: 7.0, z1: 8.4 };
export const BAL_LANDING = { x0: -12.0, x1: -10.6, z0: 7.0, z1: 9.0 };
export const BAL_AREAS = [
  { x0: -18, x1: -13, z0: -14, z1: 14 }, { x0: 13, x1: 18, z0: -14, z1: 14 }, { x0: -13, x1: 13, z0: 9, z1: 14 },
];
export const BAL_TABLES: [number, number][] = [[-15.6, -9], [-15.6, -4], [-15.6, 1], [-15.6, 6], [15.6, -9], [15.6, -4], [15.6, 1], [15.6, 6], [-5, 12], [5, 12]];

/** Walkable surface height. level 1 = balcony. */
export function groundY(x: number, z: number, level = 0): number {
  if (level === 1) return BALCONY.y;
  if (x >= BAL_LANDING.x0 && x <= BAL_LANDING.x1 && z >= BAL_LANDING.z0 && z <= BAL_LANDING.z1) return BALCONY.y;
  if (x >= BAL_STAIR.x0 && x <= BAL_STAIR.x1 && z >= BAL_STAIR.z0 && z <= BAL_STAIR.z1) return BALCONY.y * Math.min(1, Math.max(0, (BAL_STAIR.x1 - x) / (BAL_STAIR.x1 - BAL_STAIR.x0)));
  if (x >= STAGE.x0 && x <= STAGE.x1 && z <= STAGE.z1) return STAGE.y;
  if (x >= VIP.x0 && z >= VIP.z0 && z <= VIP.z1) return VIP.y;
  for (const s of STAIRS) {
    if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) return s.top * Math.min(1, Math.max(0, (s.z1 - z) / s.rise));
  }
  return 0;
}

export interface Sofa { x: number; z: number; yaw: number; len: number; y: number }
export const SOFAS: Sofa[] = [
  // lounge (west wall + two booths)
  { x: -17.2, z: -6.5, yaw: Math.PI / 2, len: 3.6, y: 0 }, { x: -17.2, z: -1.5, yaw: Math.PI / 2, len: 3.6, y: 0 },
  { x: -17.2, z: 2.6, yaw: Math.PI / 2, len: 2.4, y: 0 }, { x: -13.6, z: -8.3, yaw: 0, len: 3.0, y: 0 },
  { x: -12.2, z: -4.2, yaw: -Math.PI / 2, len: 2.4, y: 0 }, { x: -12.2, z: 0.6, yaw: -Math.PI / 2, len: 2.4, y: 0 },
  // VIP (east wall + north side)
  { x: 17.2, z: -6.3, yaw: -Math.PI / 2, len: 3.6, y: VIP.y }, { x: 17.2, z: -1.6, yaw: -Math.PI / 2, len: 3.6, y: VIP.y },
  { x: 14.3, z: -8.3, yaw: 0, len: 3.4, y: VIP.y },
];
export const TABLES: [number, number, number][] = [
  [-15.7, -6.5, 0], [-15.7, -1.5, 0], [-15.8, 2.6, 0], [-13.6, -6.8, 0], [-13.7, -4.2, 0], [-13.7, 0.6, 0],
  [15.7, -6.3, VIP.y], [15.7, -1.6, VIP.y], [14.3, -6.8, VIP.y],
];

function sofaSeats(s: Sofa): Seat[] {
  const n = Math.max(2, Math.round(s.len / 0.75));
  const out: Seat[] = [];
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n - 0.5) * (s.len - 0.5);
    // local +x runs along the sofa, local +z is the sitting direction
    out.push({ x: s.x + Math.cos(s.yaw) * t + Math.sin(s.yaw) * 0.12, z: s.z - Math.sin(s.yaw) * t + Math.cos(s.yaw) * 0.12, yaw: s.yaw, y: s.y });
  }
  return out;
}
export const LOUNGE_SEATS: Seat[] = SOFAS.filter((s) => s.x < 0).flatMap(sofaSeats);
export const VIP_SEATS: Seat[] = SOFAS.filter((s) => s.x > 0).flatMap(sofaSeats);
export const STAGE_SLOTS: Seat[] = [-5.6, 5.6, -3.4, 3.4].map((x) => ({ x, z: -10.3, yaw: 0, y: STAGE.y }));
