import { clamp, smoothstep } from './math';

/**
 * Parametric ISO-like planing hull. Body frame: origin at the transom on the centreline at the
 * lowest point of the rocker; x forward (bow at x = L), y up, z to starboard.
 * `s` = 0 at the transom … 1 at the bow.
 *
 * This is a plausible planing-dinghy shape built from the ISO's principal dimensions,
 * not a copy of the real lines plan.
 */
export const HULL = { L: 4.74, B: 1.75 };

const MAXB_S = 0.42;
/** Keel rise at the stem above the lowest point of the rocker (m): the forefoot sits just clear of the water at rest. */
const BOW_RISE = 0.16;
const BOW_POWER = 2.6;

/** Deck-level half-beam fraction (of B/2). Wide transom, fine bow. */
export function beamFrac(s: number): number {
  s = clamp(s, 0, 1);
  if (s < MAXB_S) return 0.8 + 0.2 * Math.sin((Math.PI / 2) * (s / MAXB_S));
  const u = (s - MAXB_S) / (1 - MAXB_S);
  return Math.pow(Math.max(0, 1 - u * u), 0.7);
}

/** Bottom (keel line) height — the rocker. */
export function keelY(s: number): number {
  s = clamp(s, 0, 1);
  if (s < 0.35) return 0.025 * ((0.35 - s) / 0.35) ** 2;
  return BOW_RISE * ((s - 0.35) / 0.65) ** BOW_POWER;
}

/** Slope of the keel line, d(keelY)/dx: negative in the run aft (it rises to the transom), positive forward. */
export function keelSlope(s: number, L = HULL.L): number {
  s = clamp(s, 0, 1);
  if (s < 0.35) return (-0.05 * (0.35 - s)) / (0.35 * 0.35 * L);
  return (BOW_RISE * BOW_POWER * Math.pow((s - 0.35) / 0.65, BOW_POWER - 1)) / (0.65 * L);
}

/** Sheer (gunwale) height. */
export function sheerY(s: number): number {
  s = clamp(s, 0, 1);
  return 0.42 + 0.06 * s + 0.12 * s ** 3;
}

/** Section fullness exponent: boxy aft (planing), finer V forward. */
function sectionPower(s: number): number {
  return 2.4 - 0.8 * smoothstep(0.55, 1, s);
}

/** Half-breadth of the hull at station s and height y (0 outside the hull). */
export function halfBreadth(s: number, y: number, B = HULL.B): number {
  const yk = keelY(s);
  const ys = sheerY(s);
  if (y <= yk || y > ys + 1e-9) return 0;
  const t = (y - yk) / (ys - yk);
  const p = sectionPower(s);
  return (B / 2) * beamFrac(s) * Math.pow(1 - Math.pow(1 - t, p), 1 / p);
}

/** Point on the hull skin: t = 0 keel … 1 sheer, side = ±1 (starboard +). */
export function hullPoint(s: number, t: number, side: number, L = HULL.L, B = HULL.B): [number, number, number] {
  const yk = keelY(s);
  const ys = sheerY(s);
  const y = yk + t * (ys - yk);
  const p = sectionPower(s);
  const hb = (B / 2) * beamFrac(s) * Math.pow(Math.max(0, 1 - Math.pow(1 - t, p)), 1 / p);
  return [s * L, y, side * hb];
}

export interface Cell { x: number; y: number; z: number; vol: number; hx: number; hy: number; hz: number; col: number; st: number }

/** Buoyancy grid resolution. Fine across the boat: the righting moment comes from a thin wedge at the bilge. */
export const CELL_GRID = { ns: 20, nv: 5, nz: 10 };

/**
 * The cockpit is open and self-draining: the volume above the floor, inboard of the side decks,
 * is sea, not floatation. Only the side tanks, under-floor space and bow/stern tanks float the boat.
 */
export const COCKPIT = { aftS: 0.04, fwdS: 0.6, sideDeckW: 0.3, floorY: 0.27, strapZ: 0.28 };
export const cockpitInnerZ = (s: number, B = HULL.B) => Math.max(0.12, (B / 2) * beamFrac(s) - COCKPIT.sideDeckW);
const inCockpit = (s: number, y: number, z: number) =>
  s > COCKPIT.aftS && s < COCKPIT.fwdS && y > COCKPIT.floorY && Math.abs(z) < cockpitInnerZ(s);
export interface Panel { x: number; y: number; z: number; nx: number; ny: number; nz: number; area: number; size: number }

/** Volume cells filling the (sealed, self-draining) hull — used for buoyancy at any attitude. */
export function buildCells(ns = CELL_GRID.ns, nv = CELL_GRID.nv, nz = CELL_GRID.nz, L = HULL.L, B = HULL.B): Cell[] {
  const cells: Cell[] = [];
  const dx = L / ns;
  for (let i = 0; i < ns; i++) {
    const s = (i + 0.5) / ns;
    const yk = keelY(s);
    const ys = sheerY(s);
    const dy = (ys - yk) / nv;
    for (let j = 0; j < nv; j++) {
      const y = yk + (j + 0.5) * dy;
      const hb = halfBreadth(s, y, B);
      if (hb <= 1e-4) continue;
      const dz = (2 * hb) / nz;
      for (let k = 0; k < nz; k++) {
        if (inCockpit(s, y, -hb + (k + 0.5) * dz)) continue; // open cockpit: not buoyant
        cells.push({ x: s * L, y, z: -hb + (k + 0.5) * dz, vol: dx * dy * dz, hx: dx / 2, hy: dy / 2, hz: dz / 2, col: i * nz + k, st: i });
      }
    }
  }
  return cells;
}

/** Skin panels (outward normals) — used for wetted area, skin friction and cross-flow damping. */
export function buildPanels(ns = 20, nt = 5, L = HULL.L, B = HULL.B): Panel[] {
  const panels: Panel[] = [];
  const push = (a: number[], b: number[], c: number[], d: number[], ref: number[]) => {
    const cx = (a[0] + b[0] + c[0] + d[0]) / 4;
    const cy = (a[1] + b[1] + c[1] + d[1]) / 4;
    const cz = (a[2] + b[2] + c[2] + d[2]) / 4;
    const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const e2 = [d[0] - b[0], d[1] - b[1], d[2] - b[2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-8) return;
    nx /= len; ny /= len; nz /= len;
    if (nx * (cx - ref[0]) + ny * (cy - ref[1]) + nz * (cz - ref[2]) < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const area = len / 2;
    panels.push({ x: cx, y: cy, z: cz, nx, ny, nz, area, size: Math.sqrt(area) });
  };
  for (const side of [-1, 1]) {
    for (let i = 0; i < ns; i++) {
      const s0 = i / ns, s1 = (i + 1) / ns;
      const sm = (s0 + s1) / 2;
      const ref = [sm * L, (keelY(sm) + sheerY(sm)) / 2 + 0.05, 0];
      for (let j = 0; j < nt; j++) {
        const t0 = j / nt, t1 = (j + 1) / nt;
        push(hullPoint(s0, t0, side, L, B), hullPoint(s1, t0, side, L, B), hullPoint(s1, t1, side, L, B), hullPoint(s0, t1, side, L, B), ref);
      }
    }
  }
  // Transom
  for (let j = 0; j < nt; j++) {
    const t0 = j / nt, t1 = (j + 1) / nt;
    push(hullPoint(0, t0, -1, L, B), hullPoint(0, t0, 1, L, B), hullPoint(0, t1, 1, L, B), hullPoint(0, t1, -1, L, B), [1, 0.25, 0]);
  }
  return panels;
}
