import { DEG, clamp, smoothstep } from './math';

/**
 * Two-dimensional section models (what one slice of a sail or foil does in the flow it actually sees).
 * Three-dimensional effects (induced drag, tip loss, the slot, downwash on the rudder) are NOT in here:
 * they come from the vortex system in vortex.ts, which feeds each section its effective angle of attack.
 *
 * Both models are built on Kirchhoff's separated-flow relation
 *
 *     cl = cla · ((1 + √fs) / 2)² · (α − α0)
 *
 * where fs is the chordwise position of the trailing-edge separation point (1 = fully attached,
 * 0 = separated from the leading edge). fs is a function of α and is also the thing a sailor reads off
 * the leech telltales, so the visual layers use it directly. Deep in the stall the section blends into
 * bluff-plate behaviour (normal force only), valid right round to 180°.
 */

export interface SectionOut {
  cl: number; // lift coefficient magnitude (direction is geometric, see vortex strip solve)
  cd: number; // profile + separation drag (no induced drag: that comes from the vortex system)
  fs: number; // static separation point at this angle, 0..1
  xcp: number; // centre of pressure, fraction of chord from the leading edge / luff
  luff: number; // 0 = sail drawing, 1 = fully luffing (foils: always 0)
}

export const newSectionOut = (): SectionOut => ({ cl: 0, cd: 0, fs: 1, xcp: 0.3, luff: 0 });

/** Bluff-plate normal-force coefficient vs angle (Hoerner's form), normalised to cn90 at 90°. */
const plateCn = (a: number, cn90: number) => cn90 / (0.44 + 0.56 / Math.max(Math.sin(a), 1e-3));

/** Leishman–Beddoes static separation-point curve. */
function separation(a: number, a1: number, s1: number, s2: number): number {
  return a < a1 ? 1 - 0.3 * Math.exp((a - a1) / s1) : 0.04 + 0.66 * Math.exp((a1 - a) / s2);
}
const kirchhoff = (fs: number) => { const k = (1 + Math.sqrt(clamp(fs, 0, 1))) / 2; return k * k; };

// ---------- Soft sails ----------

export interface SailShape {
  depth: number; // camber / chord
  luffTol: number; // angle (rad) below which the luff starts to lift
  cd0: number; // skin friction + mast/rigging interference
  clScale?: number; // <1 for sails that can't hold their designed shape (free-flying kite luff)
  luffHold?: number; // lift kept when fully luffing (battens hold a main; a kite just collapses)
}

const SAIL_CLA = 5.6; // 2π less ~10% for viscosity, per radian
/** Zero-lift angle of a cambered membrane (thin-aerofoil theory gives −2·camber for a circular arc). */
export const sailZeroLift = (depth: number) => -1.85 * depth;
export const sailClMax = (s: SailShape) => (0.95 + 5.5 * s.depth) * (s.clScale ?? 1);
/** Angle where the leech starts to separate in earnest (fs = 0.7): just short of maximum lift. */
export function sailStallAlpha(s: SailShape): number {
  return sailZeroLift(s.depth) + sailClMax(s) / (0.86 * SAIL_CLA);
}

/**
 * Soft-sail section. `a` = |α| (0..π) between the chord line and the local flow; `backed` = the flow is
 * pushing against the camber. `fsDyn` (optional) is the lagged separation point from the caller's
 * dynamic-stall state; without it the static curve is used.
 */
export function sailSection(a: number, backed: boolean, s: SailShape, out: SectionOut, fsDyn?: number): SectionOut {
  const f = s.depth;
  const a0 = sailZeroLift(f);
  const a1 = sailStallAlpha(s);
  const fsS = separation(a, a1, 4.5 * DEG, 9 * DEG);
  const fs = fsDyn === undefined ? fsS : fsDyn;
  // attached / partly separated (Kirchhoff)
  const clK = SAIL_CLA * kirchhoff(fs) * (a - a0) * (s.clScale ?? 1);
  // pressure drag from the separated part: attached flow recovers the suction on the curved front of
  // the sail ("camber thrust"); separated flow leaves the force normal to the chord.
  const cdK = s.cd0 + 0.6 * f * f + clK * Math.sin(a) * (1 - Math.sqrt(clamp(fs, 0, 1)));
  // fully stalled: bluff plate, with the camber still helping at moderate angles
  const cn90 = (1.25 + 1.0 * f) * (s.clScale ?? 1);
  const cosA = Math.cos(a);
  const ap = a - 0.9 * a0 * cosA * cosA;
  const cn = plateCn(ap, cn90);
  const clP = cn * Math.abs(cosA);
  const cdP = cn * Math.sin(a) + s.cd0;
  const w = smoothstep(a1 + 6 * DEG, a1 + 34 * DEG, a);
  let cl = (1 - w) * clK + w * clP;
  let cd = (1 - w) * cdK + w * cdP;
  // luffing: below the entry angle the front of a soft sail backs and it stops driving
  const flap = smoothstep(0, s.luffTol, a);
  const hold = s.luffHold ?? 0.25;
  cl *= hold + (1 - hold) * flap;
  cd += (1 - flap) * 0.08;
  let luff = 1 - flap;
  if (backed) {
    // Wind on the wrong side: at small angles the luff just curls and the sail flogs; only a properly
    // backed sail (large angle, it inverts) pulls like a plate.
    const inv = smoothstep(15 * DEG, 35 * DEG, a);
    cl = (0.12 + 0.88 * inv) * (w > 0.99 ? cl : Math.min(cl, clP + 0.2));
    cd = Math.max(cd, 0.12 * (1 - inv) + cd * inv);
    luff = Math.max(luff, 1 - inv);
  }
  out.cl = cl;
  out.cd = cd;
  out.fs = fsS;
  // centre of pressure: incidence loading sits at ¼ chord, camber loading at mid chord; stalled → mid chord
  const aa = Math.min(a, 0.6);
  const xAtt = (0.25 * aa + 0.5 * -a0) / (aa - a0);
  out.xcp = clamp(0.5 + (xAtt - 0.5) * Math.sqrt(clamp(fs, 0, 1)) * (1 - w), 0.25, 0.5);
  out.luff = luff;
  return out;
}

/** Best working angle for a sail of this shape (auto-trim target): leech just starting to break. */
export function sailOptAlpha(depth: number, luffTol = 6 * DEG, clScale = 1): number {
  return Math.max(sailStallAlpha({ depth, luffTol, cd0: 0, clScale }), luffTol + 2 * DEG);
}

// ---------- Foils (daggerboard, rudder) ----------

export interface FoilSection { clMax: number; thickness: number; cn90: number; cdExtra?: number }

const FOIL_CLA = 5.9;

/** Skin-friction drag of a thin symmetric section, both faces, with laminar→turbulent transition. */
export function foilCd0(re: number, thickness: number): number {
  const r = Math.max(re, 2e4);
  const lam = 1.328 / Math.sqrt(r);
  const turb = 0.074 / Math.pow(r, 0.2);
  const t = smoothstep(5.0, 6.4, Math.log10(r)); // transition between Re 1e5 and 2.5e6
  return 2 * (lam + (turb - lam) * t) * (1 + 2 * thickness + 60 * thickness ** 4);
}

/** Symmetric hydrofoil section. `a` = |α| (0..π), `re` = chord Reynolds number. */
export function foilSection(a: number, re: number, f: FoilSection, out: SectionOut, fsDyn?: number): SectionOut {
  const a1 = f.clMax / (0.86 * FOIL_CLA);
  const fsS = separation(a, a1, 2.2 * DEG, 3.5 * DEG);
  const fs = fsDyn === undefined ? fsS : fsDyn;
  const cd0 = foilCd0(re, f.thickness) + (f.cdExtra ?? 0);
  const clK = FOIL_CLA * kirchhoff(fs) * a;
  const cdK = cd0 + clK * Math.sin(a) * (1 - Math.sqrt(clamp(fs, 0, 1)));
  const cn = plateCn(a, f.cn90);
  const clP = cn * Math.abs(Math.cos(a));
  const cdP = cn * Math.sin(a) + cd0;
  const w = smoothstep(a1 + 3 * DEG, a1 + 14 * DEG, a);
  out.cl = (1 - w) * clK + w * clP;
  out.cd = (1 - w) * cdK + w * cdP;
  out.fs = fsS;
  out.xcp = 0.25 + 0.2 * w;
  out.luff = 0;
  return out;
}
