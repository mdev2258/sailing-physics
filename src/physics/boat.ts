import { Matrix3, Quaternion, Vector3 } from 'three';
import { DEG, G, bearingOf, clamp, interp, lerp, smoothstep, towards, wrap180 } from './math';
import { CELL_GRID, COCKPIT, HULL, buildCells, buildPanels, halfBreadth, hullPoint, keelSlope, keelY, sheerY, type Cell, type Panel } from './hull';
import { foilSection, newSectionOut, sailOptAlpha, sailSection, type FoilSection, type SailShape, type SectionOut } from './sections';
import { VortexSystem } from './vortex';
import { PLANING_CP_SHIFT, planingScale, sectionAddedMass, solve6 } from './planing';
import type { Environment } from './environment';
import type { BoatSetup, ControlParams } from './params';

type V3 = [number, number, number];

const L = HULL.L;
const deckAt = (x: number) => sheerY(x / L);

/** Rig & foil geometry in the body frame (metres). Approximate ISO layout. */
export const RIG = {
  mastX: 2.85,
  mastHeight: 6.3, // above deck
  boomAbove: 0.85,
  board: { x: 2.7, span: 1.0, chord: 0.3, strips: 8 },
  rudder: { x: -0.1, span: 0.8, chord: 0.24, strips: 6, maxDeg: 35 },
  spritLength: 1.15,
};
const MAST_DECK_Y = deckAt(RIG.mastX);
const RUDDER_TOP_Y = 0.05;
const HEAVE_ADDED = 1.6; // heave added mass / displacement
/** Planing beam (chine to chine in the after sections) and the deadrise of the run. */
const PLANING_BEAM = 2 * halfBreadth(0.2, keelY(0.2) + 0.12);
const DEADRISE_DEG = 6;
/** Where the bow wave crest sits (m from the transom) and how much of the wave-making shows as a transverse wave. */
const SELF_WAVE_BOW = 0.78 * L;
const SELF_WAVE_SHARE = 0.3;
// cdExtra: the open daggerboard slot, and the rudder stock and pintles dragging through the surface
const BOARD_SECTION: FoilSection = { clMax: 1.1, thickness: 0.09, cn90: 1.5, cdExtra: 0.004 };
const RUDDER_SECTION: FoilSection = { clMax: 1.05, thickness: 0.1, cn90: 1.5, cdExtra: 0.003 };

/** Cockpit layout (shared by physics seats and the 3D model), from the real boat. */
export { COCKPIT }; // defined with the hull so the buoyancy cells can leave the open cockpit out
/** Hiking wings: tube frames along the side decks, used with or without. */
export const WINGS = { x0: 0.95, x1: 2.65, massEachKg: 3.5 };
/** Half-beam of the gunwale at x (m). */
export const gunwaleZ = (x: number) => hullPoint(clamp(x / L, 0, 1), 1, 1)[2];

/** Mainsheet bridle: a rope between two transom eyes; the lower mainsheet block runs on it. */
export const BRIDLE = { x: 0.08, halfSpan: 0.45, minLength: 0.92, maxLength: 1.6 };
/** How high the block sits above the eyes when it's in the middle of the bridle (m). */
export function bridleRise(lengthM: number): number {
  const a = Math.max(lengthM, 2 * BRIDLE.halfSpan) / 2;
  return Math.sqrt(a * a - BRIDLE.halfSpan * BRIDLE.halfSpan);
}

/**
 * Wave-making resistance of the BUOYANT part of the hull, as a fraction of the buoyancy it is carrying,
 * vs Froude number. Once the hull planes, dynamic lift takes the weight (see the Savitsky term) and the
 * buoyancy this multiplies falls away, so the hump is something you climb over, not a wall.
 */
const WAVE_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.2, 0.003], [0.3, 0.01], [0.35, 0.018], [0.4, 0.03], [0.45, 0.048], [0.5, 0.066], [0.55, 0.08],
  [0.6, 0.088], [0.7, 0.088], [0.8, 0.082], [1.0, 0.068], [1.3, 0.054], [2.0, 0.04],
];

// ---------- Sails ----------

interface SailDef {
  name: 'main' | 'jib' | 'gennaker';
  p0: V3; // luff bottom (tack / gooseneck)
  p1: V3; // luff top (head)
  strips: number;
  shape: (u: number) => number; // chord distribution (relative)
  inertia: number; // about the luff axis, kg·m²
  stopDeg: number; // hard stop (shrouds / forestay)
  sheetRange: [number, number]; // sheet 0 → first, sheet 1 → second (deg)
  cd0: number; // section friction + mast / luff interference
  clScale: number; // <1: can't hold its designed shape (free-flying kite luff)
  luffHold: number; // lift kept when luffing (battens)
}

export interface SailStrip { u: number; p: V3; chord: number; area: number }

const v3 = (): V3 => [0, 0, 0];
const v3s = (n: number): V3[] => Array.from({ length: n }, v3);

export class SailRuntime {
  angle = 0; // rotation about the luff axis, + = clew to starboard
  rate = 0;
  axis: V3;
  strips: SailStrip[] = [];
  /** First element of this sail in the boat's air vortex system. */
  idx0 = 0;
  luffLen = 1;
  private c0 = 1;
  // ---- per strip (index 0 = foot) ----
  /** Effective angle of attack the section sees (rad): free stream + everything the vortices induce. */
  alpha: number[] = [];
  /** Effective flow at the strip (body frame, air relative to the sail). */
  flow: V3[] = [];
  /** Free-stream apparent wind at the strip, before induced velocities (body frame). */
  flowInf: V3[] = [];
  /** Separation point, lagged (dynamic stall): 1 = attached to the leech, 0 = separated from the luff. */
  fs: number[] = [];
  /** 0 = drawing … 1 = fully luffing / flogging. */
  luff: number[] = [];
  cl: number[] = [];
  cd: number[] = [];
  xcp: number[] = [];
  /** Total force on the strip (body frame, N) and where it acts (body frame). */
  stripForce: V3[] = [];
  stripAt: V3[] = [];
  /** Chord direction of each strip this step (body frame). */
  cdir: V3[] = [];
  wet: number[] = [];
  relB: V3[] = [];
  fwB: V3[] = [];
  depths: number[] = [];
  // ---- whole sail ----
  alphaMid = 0;
  force: V3 = [0, 0, 0]; // world, total
  ce: V3 = [0, 0, 0]; // world
  twistDeg = 0;
  luffTol = 6 * DEG;
  qMean = 0; // smoothed dynamic pressure on the sail (Pa): loads the leech in gusts
  sheetLimit = 0;
  /** Sheet load, as the force at the clew square to the foot (N), smoothed. */
  sheetLoadN = 0;
  submerged = 0;
  flying = true;
  cImp = 0;
  constructor(public def: SailDef, public area: number) {
    this.axis = [0, 1, 0];
    this.setAxis();
    this.rebuild(area);
  }
  get mid() { return this.strips.length >> 1; }
  setAxis() {
    const a = sub(this.def.p1, this.def.p0);
    const len = norm(a);
    this.luffLen = len;
    this.axis = [a[0] / len, a[1] / len, a[2] / len];
  }
  rebuild(area: number) {
    const d = this.def;
    this.area = area;
    const len = norm(sub(d.p1, d.p0));
    // chord is horizontal aft; strip area = chord × luff segment × sin(angle between them)
    const sinA = Math.sqrt(1 - (this.axis[0] * -1) ** 2);
    const n = d.strips;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d.shape((i + 0.5) / n);
    const c0 = area / ((sum / n) * len * sinA);
    this.c0 = c0;
    this.strips = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const chord = c0 * d.shape(u);
      this.strips.push({ u, p: lerp3(d.p0, d.p1, u), chord, area: (chord * len * sinA) / n });
    }
    const num = (x: number) => new Array<number>(n).fill(x);
    this.alpha = num(0); this.fs = num(1); this.luff = num(0); this.cl = num(0); this.cd = num(0); this.xcp = num(0.4);
    this.wet = num(0); this.depths = num(0.12);
    this.flow = v3s(n); this.flowInf = v3s(n); this.stripForce = v3s(n); this.stripAt = v3s(n);
    this.cdir = v3s(n); this.relB = v3s(n); this.fwB = v3s(n);
  }
  chordAt(u: number): number { return this.c0 * this.def.shape(u); }
  /** Chord unit vector (body frame) at height fraction u. */
  chordDir(u: number, out: V3): V3 {
    const side = this.angle >= 0 ? 1 : -1;
    return rotateAbout([-1, 0, 0], this.axis, this.angle + side * this.twistDeg * DEG * u, out);
  }
  /** Section shape of strip i, as the section model wants it. */
  shapeOf(i: number): SailShape {
    const d = this.def;
    return { depth: this.depths[i], luffTol: this.luffTol, cd0: d.cd0, clScale: d.clScale, luffHold: d.luffHold };
  }
  /** Best working angle of attack for the middle of the sail (what auto-trim aims for). */
  optAlpha(): number { return sailOptAlpha(this.depths[this.mid], this.luffTol, this.def.clScale); }
  /** Geometry for rendering: luff point, chord vector (incl. length) and camber depth at u. */
  section(u: number): { p: V3; c: V3; chord: number; depth: number } {
    const d = this.def;
    const n = d.strips;
    const k = clamp(Math.round(u * n - 0.5), 0, n - 1);
    return { p: lerp3(d.p0, d.p1, u), c: this.chordDir(u, [0, 0, 0]), chord: this.chordAt(u), depth: this.depths[k] };
  }
}

/** Daggerboard or rudder: a lifting line of strips from the hull down (index 0 = root). */
export class FoilRuntime {
  idx0 = 0;
  x = 0; yTop = 0; span = 0; chord = 0;
  cdir: V3 = [-1, 0, 0];
  alpha: number[]; fs: number[]; imm: number[]; cl: number[];
  flow: V3[]; flowInf: V3[]; stripForce: V3[]; stripAt: V3[];
  constructor(public name: 'board' | 'rudder', public n: number, public section: FoilSection) {
    const num = (x: number) => new Array<number>(n).fill(x);
    this.alpha = num(0); this.fs = num(1); this.imm = num(0); this.cl = num(0);
    this.flow = v3s(n); this.flowInf = v3s(n); this.stripForce = v3s(n); this.stripAt = v3s(n);
  }
}

/** Point on the (raked) mast `h` metres above the deck. */
export function mastPoint(h: number, rakeDeg: number): V3 {
  const r = rakeDeg * DEG;
  return [RIG.mastX - h * Math.sin(r), MAST_DECK_Y + h * Math.cos(r), 0];
}

function makeSailDefs(rakeDeg: number): SailDef[] {
  const mp = (h: number) => mastPoint(h, rakeDeg);
  const tackY = deckAt(L - 0.15) + 0.08;
  const hounds = mp(4.6);
  const genHead = mp(5.8);
  return [
    {
      name: 'main', p0: mp(RIG.boomAbove), p1: mp(RIG.mastHeight), strips: 12,
      shape: (u) => 0.15 + 0.85 * Math.sqrt(Math.max(0, 1 - u * u)), inertia: 6, stopDeg: 88, sheetRange: [85, 3],
      cd0: 0.022, clScale: 1, luffHold: 0.3,
    },
    {
      name: 'jib', p0: [L - 0.15, tackY, 0], p1: [hounds[0] + 0.05, hounds[1], 0], strips: 8,
      shape: (u) => 0.05 + 0.95 * (1 - u), inertia: 0.8, stopDeg: 75, sheetRange: [60, 10],
      cd0: 0.014, clScale: 1, luffHold: 0.12,
    },
    {
      name: 'gennaker', p0: [L + RIG.spritLength, tackY + 0.05, 0], p1: [genHead[0] + 0.12, genHead[1], 0], strips: 10,
      shape: (u) => 0.2 + 0.8 * Math.sqrt(Math.max(0, 1 - u * u)), inertia: 1.5, stopDeg: 125, sheetRange: [110, 20],
      // max lift ≈1.4 on the whole sail, in line with published asymmetric-spinnaker coefficients (ORC VPP)
      cd0: 0.05, clScale: 0.95, luffHold: 0.05,
    },
  ];
}

// ---------- Telemetry ----------

export interface ForceArrow { at: V3; f: V3 }
export type ForceGroup = 'aero' | 'hydro' | 'buoyancy' | 'weight' | 'contact';
/** One line of the force ledger: every force on the boat this step, where it acts, and what it is. */
export interface ForceItem extends ForceArrow { id: string; label: string; group: ForceGroup }

/** The boat's centres (world frame) plus the stability numbers that come from them. */
export interface Centres {
  cg: V3; // centre of gravity (boat + crew)
  cb: V3; // centre of buoyancy
  ce: V3 | null; // centre of effort: where the total sail force acts
  clr: V3 | null; // centre of lateral resistance: where the lateral water force acts (incl. Munk couple)
  meta: V3 | null; // transverse metacentre (only defined once heeled a few degrees)
  planing: V3 | null; // centre of the dynamic (planing) pressure on the bottom
  gzM: number; // righting lever (m), + = trying to bring the boat upright
  rightingNm: number; // buoyancy × GZ
  leadM: number; // CE ahead of CLR along the boat (m): + = CE forward → bears away (lee helm)
  geoLeadM: number; // same, from sail-area and underwater-area centroids (the designer's "lead")
}

export interface Telemetry {
  headingDeg: number; cogDeg: number; heelDeg: number; pitchDeg: number;
  sogKn: number; stwKn: number; vmgKn: number; leewayDeg: number; fn: number; yawRateDegS: number;
  twsKn: number; twdDeg: number; twaDeg: number; awsKn: number; awaDeg: number;
  draftM: number; wettedM2: number; dispKg: number; planingLift: number;
  grounded: boolean; capsized: boolean;
  centres?: Centres;
  forces: { sails: ForceArrow; board: ForceArrow; rudder: ForceArrow; buoyancy: ForceArrow; gravity: ForceArrow; hull: ForceArrow };
  /** Every force on the boat, itemised. Sums to mass × acceleration (plus the water's added-mass reaction). */
  ledger: ForceItem[];
}

/** Accumulates a distributed force: total, and a magnitude-weighted point of action. */
class ForceAcc {
  fx = 0; fy = 0; fz = 0; mx = 0; my = 0; mz = 0; w = 0;
  constructor(public id: string, public label: string, public group: ForceGroup) {}
  reset() { this.fx = this.fy = this.fz = this.mx = this.my = this.mz = this.w = 0; }
  add(px: number, py: number, pz: number, fx: number, fy: number, fz: number) {
    this.fx += fx; this.fy += fy; this.fz += fz;
    const m = Math.sqrt(fx * fx + fy * fy + fz * fz);
    this.mx += px * m; this.my += py * m; this.mz += pz * m; this.w += m;
  }
  item(fallback: ArrayLike<number>): ForceItem {
    const at: V3 = this.w > 1e-9 ? [this.mx / this.w, this.my / this.w, this.mz / this.w] : [fallback[0], fallback[1], fallback[2]];
    return { id: this.id, label: this.label, group: this.group, at, f: [this.fx, this.fy, this.fz] };
  }
}

interface StripKin { speed: number; alpha: number; un: number; cperp: number; v: V3; n: V3; kj: V3; gsign: number }
const newKin = (): StripKin => ({ speed: 0, alpha: 0, un: 0, cperp: 1, v: [0, 0, 0], n: [0, 0, 1], kj: [0, 0, 0], gsign: 1 });

/**
 * Kinematics of one lifting strip. flow = fluid velocity relative to the surface; span and chord are unit
 * vectors (chord = leading edge → trailing edge). Fills in the flow speed and direction in the section
 * plane, the angle of attack (0..π), the section normal, the Kutta–Joukowski direction v × span and the
 * sign of circulation that lifts towards the side the flow is pushing.
 */
function stripKin(flow: ArrayLike<number>, span: ArrayLike<number>, chord: ArrayLike<number>, k: StripKin): boolean {
  const fs = flow[0] * span[0] + flow[1] * span[1] + flow[2] * span[2];
  const ux = flow[0] - fs * span[0], uy = flow[1] - fs * span[1], uz = flow[2] - fs * span[2];
  const speed = Math.hypot(ux, uy, uz);
  k.speed = speed;
  if (speed < 1e-4) return false;
  const cs = chord[0] * span[0] + chord[1] * span[1] + chord[2] * span[2];
  let cx = chord[0] - cs * span[0], cy = chord[1] - cs * span[1], cz = chord[2] - cs * span[2];
  const cl = Math.hypot(cx, cy, cz) || 1;
  k.cperp = cl;
  cx /= cl; cy /= cl; cz /= cl;
  const nx = cy * span[2] - cz * span[1], ny = cz * span[0] - cx * span[2], nz = cx * span[1] - cy * span[0];
  const un = ux * nx + uy * ny + uz * nz;
  const uc = ux * cx + uy * cy + uz * cz;
  k.un = un;
  k.alpha = Math.atan2(Math.abs(un), uc);
  const vx = ux / speed, vy = uy / speed, vz = uz / speed;
  k.v[0] = vx; k.v[1] = vy; k.v[2] = vz;
  k.n[0] = nx; k.n[1] = ny; k.n[2] = nz;
  // lift acts along ± (v × span); pick the sign that points to the side the flow pushes the surface
  const kx = vy * span[2] - vz * span[1], ky = vz * span[0] - vx * span[2], kz = vx * span[1] - vy * span[0];
  k.kj[0] = kx; k.kj[1] = ky; k.kj[2] = kz;
  const sg = un >= 0 ? 1 : -1;
  k.gsign = sg * (nx * kx + ny * ky + nz * kz) >= 0 ? 1 : -1;
  return true;
}

// ---------- Boat ----------

export class Boat {
  // rigid-body state (world frame, about the combined CG)
  pos = new Vector3();
  vel = new Vector3();
  q = new Quaternion();
  omega = new Vector3(); // body frame
  // internal state
  cgBody = new Vector3();
  mass = 0;
  rudder = 0; // radians, actual
  board = 1; // fraction down, actual
  genHoist = 0;
  side = 1; // +1 crew on starboard (windward = starboard)
  helm = new Vector3();
  crew = new Vector3();
  sails: SailRuntime[];
  foils: [FoilRuntime, FoilRuntime];
  /** Vortex systems: every sail strip in the air, every foil strip in the water (body frame). */
  aero: VortexSystem;
  hydro: VortexSystem;
  cells: Cell[];
  panels: Panel[];
  R = new Float64Array(9);
  origin = new Vector3();
  tel!: Telemetry;
  private setupKey = '';
  centres: Centres = { cg: [0, 0, 0], cb: [0, 0, 0], ce: null, clr: null, meta: null, planing: null, gzM: 0, rightingNm: 0, leadM: 0, geoLeadM: 0 };
  /** Buoyancy carried by each hull station (N) and where it acts (world): shows the wedge shifting as she heels. */
  stBuoy = new Float64Array(CELL_GRID.ns);
  stBuoyAt: V3[] = v3s(CELL_GRID.ns);
  /** Immersed depth of each station (m): whole section, and port / starboard halves. */
  stDepth = new Float64Array(CELL_GRID.ns);
  sideDepth = [new Float64Array(CELL_GRID.ns), new Float64Array(CELL_GRID.ns)];
  /** Planing force on each station (N, + = lifting), port and starboard halves of the bottom. */
  planingStrip = [new Float64Array(CELL_GRID.ns), new Float64Array(CELL_GRID.ns)];
  /** Where each of those acts (body frame). */
  planingAt: V3[][] = [v3s(CELL_GRID.ns), v3s(CELL_GRID.ns)];
  private plFlux = new Float64Array(CELL_GRID.ns);
  private plWet = new Float64Array(CELL_GRID.ns);
  private plHb = new Float64Array(CELL_GRID.ns);
  private plU = new Float64Array(CELL_GRID.ns);
  /** Weight of each mass item (body-frame position, kg), for the force ledger. */
  massItems: Array<{ id: string; label: string; m: number; p: V3 }> = [];
  private clrBody: V3 | null = null;
  private latFilt: V3 = [0, 0, 0];
  private etaCol: Float64Array;
  private inertia = new Matrix3();
  private ampSum = 0;
  private stepCount = 0;
  /** The hull's own wave: amplitude (m) and wavenumber (1/m) of the transverse wave it is making. */
  selfWave = { amp: 0, k: 0 };

  // scratch
  private F = [0, 0, 0];
  private T = [0, 0, 0];
  private w3 = new Float64Array(3);
  private air = new Float64Array(3);
  private sec: SectionOut = newSectionOut();
  private kin: StripKin = newKin();
  private M6 = new Float64Array(36);
  private b6 = new Float64Array(6);
  private acc = {
    friction: new ForceAcc('friction', 'Hull skin friction', 'hydro'),
    wave: new ForceAcc('wave', 'Hull wave-making', 'hydro'),
    planing: new ForceAcc('planing', 'Planing lift', 'hydro'),
    side: new ForceAcc('hullside', 'Hull side force & damping', 'hydro'),
    transom: new ForceAcc('transom', 'Transom drag', 'hydro'),
    board: new ForceAcc('board', 'Daggerboard', 'hydro'),
    rudder: new ForceAcc('rudder', 'Rudder', 'hydro'),
    misc: new ForceAcc('rigwater', 'Rig & wings in the water', 'hydro'),
    main: new ForceAcc('main', 'Mainsail', 'aero'),
    jib: new ForceAcc('jib', 'Jib', 'aero'),
    gennaker: new ForceAcc('gennaker', 'Gennaker', 'aero'),
    windage: new ForceAcc('windage', 'Windage (hull, rig, crew)', 'aero'),
    ground: new ForceAcc('ground', 'Seabed', 'contact'),
  };

  constructor(public setup: BoatSetup) {
    this.cells = buildCells();
    this.etaCol = new Float64Array(CELL_GRID.ns * CELL_GRID.nz);
    this.panels = buildPanels();
    const defs = makeSailDefs(setup.mastRakeDeg);
    this.sails = [new SailRuntime(defs[0], setup.mainAreaM2), new SailRuntime(defs[1], setup.jibAreaM2), new SailRuntime(defs[2], setup.gennakerAreaM2)];
    let n = 0;
    for (const s of this.sails) { s.idx0 = n; n += s.strips.length; }
    this.aero = new VortexSystem(n);
    this.aero.kappa.fill(1); // the sea is a wall under the sails
    this.foils = [new FoilRuntime('board', RIG.board.strips, BOARD_SECTION), new FoilRuntime('rudder', RIG.rudder.strips, RUDDER_SECTION)];
    this.foils[1].idx0 = this.foils[0].n;
    this.hydro = new VortexSystem(this.foils[0].n + this.foils[1].n);
  }

  get main() { return this.sails[0]; }
  get jib() { return this.sails[1]; }
  get gennaker() { return this.sails[2]; }

  // ----- frame helpers -----
  private updateR() {
    const { x, y, z, w } = this.q;
    const r = this.R;
    r[0] = 1 - 2 * (y * y + z * z); r[1] = 2 * (x * y - z * w); r[2] = 2 * (x * z + y * w);
    r[3] = 2 * (x * y + z * w); r[4] = 1 - 2 * (x * x + z * z); r[5] = 2 * (y * z - x * w);
    r[6] = 2 * (x * z - y * w); r[7] = 2 * (y * z + x * w); r[8] = 1 - 2 * (x * x + y * y);
  }
  toWorldDir(b: ArrayLike<number>, o: number[] | Float64Array): void {
    const r = this.R;
    const x = b[0], y = b[1], z = b[2];
    o[0] = r[0] * x + r[1] * y + r[2] * z;
    o[1] = r[3] * x + r[4] * y + r[5] * z;
    o[2] = r[6] * x + r[7] * y + r[8] * z;
  }
  toBodyDir(w: ArrayLike<number>, o: number[] | Float64Array): void {
    const r = this.R;
    const x = w[0], y = w[1], z = w[2];
    o[0] = r[0] * x + r[3] * y + r[6] * z;
    o[1] = r[1] * x + r[4] * y + r[7] * z;
    o[2] = r[2] * x + r[5] * y + r[8] * z;
  }
  toWorldPoint(b: ArrayLike<number>, o: number[] | Float64Array): void {
    this.toWorldDir(b, o);
    o[0] += this.origin.x; o[1] += this.origin.y; o[2] += this.origin.z;
  }
  toBodyPoint(w: ArrayLike<number>, o: number[] | Float64Array): void {
    this.toBodyDir([w[0] - this.origin.x, w[1] - this.origin.y, w[2] - this.origin.z], o);
  }
  /** Velocity (world) of a world-space point rigidly attached to the hull. */
  pointVel(p: ArrayLike<number>, o: number[] | Float64Array) {
    const wb = this.omega;
    const r = this.R;
    const wx = r[0] * wb.x + r[1] * wb.y + r[2] * wb.z;
    const wy = r[3] * wb.x + r[4] * wb.y + r[5] * wb.z;
    const wz = r[6] * wb.x + r[7] * wb.y + r[8] * wb.z;
    const rx = p[0] - this.pos.x, ry = p[1] - this.pos.y, rz = p[2] - this.pos.z;
    o[0] = this.vel.x + wy * rz - wz * ry;
    o[1] = this.vel.y + wz * rx - wx * rz;
    o[2] = this.vel.z + wx * ry - wy * rx;
  }
  private addForce(px: number, py: number, pz: number, fx: number, fy: number, fz: number, acc?: ForceAcc) {
    if (!(Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(fz))) return;
    const F = this.F, T = this.T;
    F[0] += fx; F[1] += fy; F[2] += fz;
    const rx = px - this.pos.x, ry = py - this.pos.y, rz = pz - this.pos.z;
    T[0] += ry * fz - rz * fy;
    T[1] += rz * fx - rx * fz;
    T[2] += rx * fy - ry * fx;
    if (acc) acc.add(px, py, pz, fx, fy, fz);
  }

  /**
   * Air velocity relative to the boat at a body-frame point: the apparent wind there plus everything the
   * sails' vortices induce. Body frame. This is the field the air-flow layer draws.
   */
  airVelocityBody(env: Environment, t: number, pb: ArrayLike<number>, out: number[], induced = true): void {
    const p = [0, 0, 0], v = [0, 0, 0];
    this.toWorldPoint(pb, p);
    env.wind.at(p[0], p[1], p[2], t, this.air);
    this.pointVel(p, v);
    this.toBodyDir([this.air[0] - v[0], this.air[1] - v[1], this.air[2] - v[2]], out);
    if (induced) this.aero.velocityAt(pb[0], pb[1], pb[2], out, true);
  }
  /** Water velocity relative to the boat at a body-frame point (stream + waves + the foils' vortices). */
  waterVelocityBody(env: Environment, t: number, pb: ArrayLike<number>, out: number[], induced = true): void {
    const p = [0, 0, 0], v = [0, 0, 0];
    this.toWorldPoint(pb, p);
    env.water(p[0], Math.min(p[1], 0), p[2], t, this.w3);
    this.pointVel(p, v);
    this.toBodyDir([this.w3[0] - v[0], this.w3[1] - v[1], this.w3[2] - v[2]], out);
    if (induced) this.hydro.velocityAt(pb[0], pb[1], pb[2], out, true);
  }

  // ----- mass properties -----
  private massProps() {
    const s = this.setup;
    const items: Array<{ id: string; label: string; m: number; p: V3; k: V3 }> = [
      { id: 'w_hull', label: 'Hull weight', m: s.hullMassKg, p: [0.42 * L, 0.24, 0], k: [0.45, 1.3, 1.25] },
      { id: 'w_rig', label: 'Rig weight', m: s.rigMassKg, p: [RIG.mastX, MAST_DECK_Y + 2.6, 0], k: [1.8, 0.2, 1.8] },
      { id: 'w_helm', label: 'Helm weight', m: s.helmMassKg, p: [this.helm.x, this.helm.y, this.helm.z], k: [0.3, 0.3, 0.3] },
      { id: 'w_crew', label: 'Crew weight', m: s.crewMassKg, p: [this.crew.x, this.crew.y, this.crew.z], k: [0.3, 0.3, 0.3] },
    ];
    if (s.wings) {
      const xm = (WINGS.x0 + WINGS.x1) / 2;
      for (const sd of [-1, 1]) items.push({ id: 'w_wing', label: 'Wing weight', m: WINGS.massEachKg, p: [xm, deckAt(xm), sd * (gunwaleZ(xm) + s.wingWidthM / 2)], k: [0.1, 0.5, 0.5] });
    }
    let m = 0, cx = 0, cy = 0, cz = 0;
    for (const it of items) { m += it.m; cx += it.m * it.p[0]; cy += it.m * it.p[1]; cz += it.m * it.p[2]; }
    cx /= m; cy /= m; cz /= m;
    let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
    for (const it of items) {
      const x = it.p[0] - cx, y = it.p[1] - cy, z = it.p[2] - cz;
      ixx += it.m * (y * y + z * z + it.k[0] ** 2);
      iyy += it.m * (x * x + z * z + it.k[1] ** 2);
      izz += it.m * (x * x + y * y + it.k[2] ** 2);
      ixy -= it.m * x * y; ixz -= it.m * x * z; iyz -= it.m * y * z;
    }
    this.mass = m;
    this.massItems = items;
    this.inertia.set(ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz);
    return new Vector3(cx, cy, cz);
  }

  /** Re-centre after crew move: system CG stays put, the hull moves under it (momentum conserved). */
  private refreshMass() {
    this.cgBody.copy(this.massProps());
    const o = [0, 0, 0];
    this.toWorldDir([this.cgBody.x, this.cgBody.y, this.cgBody.z], o);
    this.origin.set(this.pos.x - o[0], this.pos.y - o[1], this.pos.z - o[2]);
  }

  /** Where the hiking rail is at x: the gunwale, or the wing edge with wings on. */
  railZ(x: number): number {
    const w = this.setup.wings && x > WINGS.x0 - 0.1 && x < WINGS.x1 + 0.1 ? this.setup.wingWidthM : 0;
    return gunwaleZ(x) + w;
  }

  /**
   * Body-frame CG of each person from the controls. λ: −0.5 to leeward … 0 centreline … 0.5 sitting on
   * the rail … 1 full hike (helm) / flat on the wire (crew). With wings the rail is further out.
   */
  private crewTargets(c: ControlParams): { helm: V3; crew: V3 } {
    const s = this.side;
    const seat = (x: number, lam: number, trap: boolean): V3 => {
      const deck = deckAt(x);
      const rail = this.railZ(x);
      const sit = rail - 0.08; // hips on the edge
      if (lam <= 0.5) {
        const a = Math.abs(lam) * 2;
        // on the side deck at the edge, or down on the cockpit floor near the centreline
        return [x, lerp(COCKPIT.floorY + 0.3, deck + 0.28, smoothstep(0.2, 0.8, a)), s * lam * 2 * sit];
      }
      const h = (lam - 0.5) * 2;
      return trap ? [x, deck + 0.3 - 0.05 * h, s * (sit + 0.95 * h)] : [x, deck + 0.28 - 0.18 * h, s * (sit + 0.55 * h)];
    };
    return {
      helm: seat(clamp(1.45 + c.helmFwd, 0.4, 2.6), clamp(c.helmOut, -0.5, 1), false),
      crew: seat(clamp(2.15 + c.crewFwd, 1.0, 3.4), clamp(c.crewOut, -0.5, 1), true),
    };
  }

  /** Place the boat upright, floating, heading `headingDeg`, moving at `speed` m/s through the water. */
  reset(env: Environment, headingDeg: number, x = 0, z = 0, c?: ControlParams, speed = 0) {
    const psi = (90 - headingDeg) * DEG;
    this.q.setFromAxisAngle(new Vector3(0, 1, 0), psi);
    this.updateR();
    this.omega.set(0, 0, 0);
    // side from the wind: wind over starboard → crew to starboard, boom to port
    const w = [0, 0, 0];
    env.wind.at(x, 5, z, 0, w);
    const wb = [0, 0, 0];
    this.toBodyDir(w, wb);
    this.side = wb[2] < 0 ? 1 : -1;
    if (c && c.side !== 'auto') this.side = c.side === 'starboard' ? 1 : -1; // a manual side wins
    for (const s of this.sails) { s.angle = -this.side * 20 * DEG; s.rate = 0; s.fs.fill(1); s.sheetLoadN = 0; }
    for (const f of this.foils) f.fs.fill(1);
    this.aero.gamma.fill(0);
    this.hydro.gamma.fill(0);
    if (c) {
      const t = this.crewTargets(c);
      this.helm.set(...t.helm); this.crew.set(...t.crew);
      this.board = c.boardDown;
      this.genHoist = c.gennakerHoisted ? 1 : 0;
    } else {
      this.helm.set(1.45, 0.73, this.side * 0.98); this.crew.set(2.15, 0.75, this.side * 0.98);
    }
    this.cgBody.copy(this.massProps());
    // float with the keel ~0.11 m below the surface
    this.origin.set(x, -0.11, z);
    const o = [0, 0, 0];
    this.toWorldDir([this.cgBody.x, this.cgBody.y, this.cgBody.z], o);
    this.pos.set(x + o[0], -0.11 + o[1], z + o[2]);
    const f = towards(headingDeg);
    this.vel.set(env.tide.current.x + f.x * speed, 0, env.tide.current.z + f.z * speed);
    this.rudder = 0;
    this.latFilt = [0, 0, 0];
    this.selfWave.amp = 0;
    this.tel = this.telemetry(env, 0, emptyForces(), []);
  }

  /** Bring a capsized boat upright where it lies (the crew have done the righting). */
  rightBoat(env: Environment, t: number, c: ControlParams) {
    const head = this.tel.headingDeg;
    const p = this.pos.clone();
    this.reset(env, head, p.x, p.z, c, 0);
    this.vel.set(env.tide.current.x, 0, env.tide.current.z);
    this.tel = this.telemetry(env, t, emptyForces(), []);
  }

  // ===================================================================================
  step(dt: number, t: number, env: Environment, c: ControlParams) {
    const su = this.setup;
    const setupKey = `${su.mainAreaM2}|${su.jibAreaM2}|${su.gennakerAreaM2}|${su.mastRakeDeg}`;
    if (setupKey !== this.setupKey) {
      this.setupKey = setupKey;
      const defs = makeSailDefs(su.mastRakeDeg);
      const areas = [su.mainAreaM2, su.jibAreaM2, su.gennakerAreaM2];
      this.sails.forEach((sl, i) => { sl.def = defs[i]; sl.setAxis(); sl.rebuild(areas[i]); });
    }
    this.updateR();
    this.stepCount++;

    // ---- actuators: finite rates, like real hands ----
    const rudCmd = clamp(c.rudderDeg, -RIG.rudder.maxDeg, RIG.rudder.maxDeg) * DEG;
    this.rudder += clamp(rudCmd - this.rudder, -150 * DEG * dt, 150 * DEG * dt);
    this.board += clamp(clamp(c.boardDown, 0, 1) - this.board, -0.5 * dt, 0.5 * dt);
    this.genHoist += clamp((c.gennakerHoisted ? 1 : 0) - this.genHoist, -dt / 2.5, dt / 3);
    // side: auto = windward, i.e. opposite the boom
    if (c.side === 'auto') {
      if (this.main.angle > 4 * DEG) this.side = -1;
      else if (this.main.angle < -4 * DEG) this.side = 1;
    } else this.side = c.side === 'starboard' ? 1 : -1;
    const tg = this.crewTargets(c);
    moveToward(this.helm, tg.helm, 1.2 * dt);
    moveToward(this.crew, tg.crew, 1.2 * dt);
    this.refreshMass();

    const F = this.F, T = this.T;
    F[0] = F[1] = F[2] = T[0] = T[1] = T[2] = 0;
    const A = this.acc;
    for (const k in A) A[k as keyof typeof A].reset();
    const R = this.R;
    const rhoW = env.rhoWater, rhoA = env.rhoAir;
    const waves = env.waves;
    this.ampSum = waves.comps.reduce((s, k) => s + k.amp, 0);
    const amp = this.ampSum;
    const p = [0, 0, 0], v = [0, 0, 0], vb = [0, 0, 0], fw = [0, 0, 0], fb = [0, 0, 0], tmp = [0, 0, 0];
    const wv = this.w3;
    const forces = emptyForces();
    const ledger: ForceItem[] = [];

    // ---- gravity: one force per thing that weighs something ----
    F[1] -= this.mass * G;
    forces.gravity = { at: [this.pos.x, this.pos.y, this.pos.z], f: [0, -this.mass * G, 0] };
    let wingKg = 0;
    for (const it of this.massItems) {
      if (it.id === 'w_wing') { wingKg += it.m; continue; }
      const at: V3 = [0, 0, 0];
      this.toWorldPoint(it.p, at);
      ledger.push({ id: it.id, label: it.label, group: 'weight', at, f: [0, -it.m * G, 0] });
    }
    if (wingKg > 0) {
      const at: V3 = [0, 0, 0];
      const xm = (WINGS.x0 + WINGS.x1) / 2;
      this.toWorldPoint([xm, deckAt(xm), 0], at);
      ledger.push({ id: 'w_wing', label: 'Wings weight', group: 'weight', at, f: [0, -wingKg * G, 0] });
    }

    // ---- hydrostatics: buoyancy of each volume cell under the local wave surface ----
    let bF = 0, bX = 0, bY = 0, bZ = 0, vSub = 0;
    const stB = this.stBuoy, stAt = this.stBuoyAt, stD = this.stDepth, sdP = this.sideDepth[0], sdS = this.sideDepth[1];
    stB.fill(0); stD.fill(0); sdP.fill(0); sdS.fill(0);
    for (const a of stAt) a[0] = a[1] = a[2] = 0;
    // wave height once per vertical column of cells (they share x,z closely), not per cell
    const etaCol = this.etaCol;
    etaCol.fill(NaN);
    const swA = this.selfWave.amp, swK = this.selfWave.k;
    const relief = 0.55 * smoothstep(0.5, 1.0, this.tel.fn) * (this.tel.stwKn > 0 ? 1 : 0);
    const swMean = swA > 0 ? Math.sin(swK * SELF_WAVE_BOW) / (swK * SELF_WAVE_BOW) : 0;
    for (const cell of this.cells) {
      this.toWorldPoint([cell.x, cell.y, cell.z], p);
      const ext = Math.abs(R[3]) * 2 * cell.hx + Math.abs(R[4]) * 2 * cell.hy + Math.abs(R[5]) * 2 * cell.hz;
      const bottom = p[1] - ext / 2;
      if (bottom > amp) continue;
      let eta = 1e9;
      if (p[1] + ext / 2 >= -amp) {
        eta = etaCol[cell.col];
        // Froude–Krylov: the wave's pressure is felt at the hull's depth, not at the surface.
        // Column cells are visited bottom-up, so the first one gives the column's depth.
        if (Number.isNaN(eta)) {
          eta = waves.pressureHead(p[0], p[2], t, -0.5 * bottom);
          // the hull's own wave system: crest at the bow, trough working aft as she speeds up
          if (swA > 0) eta += swA * ((cell.x < SELF_WAVE_BOW ? Math.cos(swK * (SELF_WAVE_BOW - cell.x)) : Math.exp((SELF_WAVE_BOW - cell.x) / 0.3)) - swMean);
          etaCol[cell.col] = eta;
        }
      }
      const frac = clamp((eta - bottom) / ext, 0, 1);
      if (frac <= 0) continue;
      // Once the transom runs dry the bottom pressure has to fall to atmospheric at its edge, so the
      // after sections carry less than their still-water buoyancy (Savitsky's buoyant term is about
      // half the static wedge). This is what lets the stern settle and the bow lift on to the plane.
      const fy = rhoW * G * cell.vol * frac * (1 - relief * Math.exp(-cell.x / 1.2));
      const cy = bottom + (frac * ext) / 2;
      bF += fy; bX += fy * p[0]; bY += fy * cy; bZ += fy * p[2];
      vSub += cell.vol * frac;
      const st = cell.st;
      stB[st] += fy;
      const sa = stAt[st];
      sa[0] += fy * p[0]; sa[1] += fy * cy; sa[2] += fy * p[2];
      const im = Math.min(eta - bottom, 1.5);
      if (im > stD[st]) stD[st] = im;
      const sd = cell.z >= 0 ? sdS : sdP;
      if (im > sd[st]) sd[st] = im;
    }
    for (let i = 0; i < stB.length; i++) if (stB[i] > 0) { const a = stAt[i]; a[0] /= stB[i]; a[1] /= stB[i]; a[2] /= stB[i]; }
    const cb: V3 = bF > 0 ? [bX / bF, bY / bF, bZ / bF] : [this.pos.x, this.pos.y, this.pos.z];
    if (bF > 0) this.addForce(cb[0], cb[1], cb[2], 0, bF, 0);
    forces.buoyancy = { at: cb, f: [0, bF, 0] };
    ledger.push({ id: 'buoyancy', label: 'Buoyancy', group: 'buoyancy', at: cb, f: [0, bF, 0] });
    const vStatic = this.mass / rhoW;
    const subFrac = clamp(vSub / vStatic, 0, 1);

    // ---- speed through the water (at the CG) → Froude & Reynolds numbers ----
    env.water(this.pos.x, Math.min(this.pos.y, -0.05), this.pos.z, t, wv);
    const waterAtCg: V3 = [wv[0], wv[1], wv[2]];
    const vrel = [this.vel.x - wv[0], this.vel.y - wv[1], this.vel.z - wv[2]];
    this.toBodyDir(vrel, vb);
    const u = vb[0];
    const vSway = vb[2];
    const lwl = 0.92 * L;
    const fn = Math.abs(u) / Math.sqrt(G * lwl);
    const re = Math.max((Math.abs(u) * lwl) / env.nuWater, 1e5);
    // ITTC-57 friction line, plus form factor and the real-boat extras (bailers, slot gasket, chine edges),
    // plus the sheet of spray a planing bottom throws forward and sideways, which is friction too.
    const cfr = (0.075 / (Math.log10(re) - 2) ** 2) * (1.2 + 0.15 * smoothstep(0.5, 1.0, fn));

    // ---- hull skin panels: skin friction + cross-flow drag + wave-radiation damping ----
    let wetted = 0;
    // lateral (body z) water force and its first moments → dynamic centre of lateral resistance
    let latF = 0, latX = 0, latY = 0;
    let transomA = 0, transomDepth = 0; // immersed transom area and depth
    const nb = [0, 0, 0], cfw = [0, 0, 0], cfb = [0, 0, 0];
    const hdl = Math.hypot(R[0], R[6]) || 1;
    const hdx = R[0] / hdl, hdz = R[6] / hdl; // level heading
    for (const pn of this.panels) {
      this.toWorldPoint([pn.x, pn.y, pn.z], p);
      const half = pn.size / 2;
      if (p[1] - half > amp) continue;
      const eta = env.water(p[0], p[1], p[2], t, wv);
      const fr = clamp((eta - (p[1] - half)) / pn.size, 0, 1);
      if (fr <= 0) continue;
      const a = pn.area * fr;
      wetted += a;
      if (pn.nx < -0.9) { transomA += a; transomDepth = Math.max(transomDepth, eta - (p[1] - half)); }
      this.pointVel(p, v);
      tmp[0] = v[0] - wv[0]; tmp[1] = v[1] - wv[1]; tmp[2] = v[2] - wv[2];
      this.toBodyDir(tmp, vb);
      nb[0] = pn.nx; nb[1] = pn.ny; nb[2] = pn.nz;
      // Normal pressure from motion ACROSS the hull (heave, sway, roll, pitch, yaw). Level forward
      // motion is taken out first: the pressure field of a hull running ahead at some trim is the
      // wave-making and planing terms below, and must not be counted twice here.
      //   quadratic: cross-flow drag (Cd ≈ 0.9), linear: wave-radiation damping (ζ ≈ 0.35 in heave)
      const ahead = tmp[0] * hdx + tmp[2] * hdz;
      cfw[0] = tmp[0] - ahead * hdx; cfw[1] = tmp[1]; cfw[2] = tmp[2] - ahead * hdz;
      this.toBodyDir(cfw, cfb);
      const vn = cfb[0] * nb[0] + cfb[1] * nb[1] + cfb[2] * nb[2];
      const pn_ = -rhoW * a * (0.45 * vn * Math.abs(vn) + 1.0 * vn);
      fb[0] = pn_ * nb[0]; fb[1] = pn_ * nb[1]; fb[2] = pn_ * nb[2];
      latF += fb[2]; latX += fb[2] * pn.x; latY += fb[2] * pn.y;
      this.toWorldDir(fb, fw);
      this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2], A.side);
      // skin friction along the local flow over the panel
      const vnf = vb[0] * nb[0] + vb[1] * nb[1] + vb[2] * nb[2];
      const tx = vb[0] - vnf * nb[0], ty = vb[1] - vnf * nb[1], tz = vb[2] - vnf * nb[2];
      const ft = -0.5 * rhoW * cfr * a * Math.hypot(tx, ty, tz);
      fb[0] = ft * tx; fb[1] = ft * ty; fb[2] = ft * tz;
      latF += fb[2]; latX += fb[2] * pn.x; latY += fb[2] * pn.y;
      this.toWorldDir(fb, fw);
      this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2], A.friction);
    }

    // ---- wave-making resistance of the buoyant hull ----
    const heel = Math.asin(clamp(-R[5], -1, 1));
    const pitch = Math.asin(clamp(R[3], -1, 1));
    const cbBody: V3 = [0, 0, 0];
    this.toBodyPoint(cb, cbBody);
    if (subFrac > 0.01) {
      const thetaOpt = 1.5 * DEG * smoothstep(0.4, 0.9, fn);
      const penalty = 1 + 1.5 * Math.sin(heel) ** 2 + 30 * (pitch - thetaOpt) ** 2;
      const rr = bF * interp(WAVE_TABLE, fn) * penalty * (u < 0 ? 1.5 : 1);
      this.toWorldDir([-Math.sign(u) * rr, 0, 0], fw);
      this.addForce(cb[0], cb[1], cb[2], fw[0], fw[1], fw[2], A.wave);
      // The energy that resistance carries away is in the wave the hull drags along: a transverse wave of
      // amplitude a across beam B costs ¼·ρ·g·a²·B. Most of a dinghy's wave-making goes into the diverging
      // (bow) waves, so only part of it shows up as the crest-at-the-bow, trough-at-the-stern profile
      // that makes her squat and lift her bow as she climbs the hump.
      const aw = u > 0.5 ? SELF_WAVE_SHARE * Math.sqrt((4 * rr) / (rhoW * G * PLANING_BEAM)) : 0;
      this.selfWave.amp += (aw - this.selfWave.amp) * Math.min(1, dt / 0.5);
      this.selfWave.k = G / Math.max(u * u, 0.25);
      // The hull as a (very) low-aspect-ratio keel: slender-body side force, π/2·ρ·T²·U·v, where T is
      // the deepest immersed section. Negligible upright, real once a chine or gunwale digs in.
      let tMax = 0;
      for (let i = 0; i < stD.length; i++) if (stD[i] > tMax) tMax = stD[i];
      tMax = Math.min(tMax, 0.5);
      const vs = clamp(vSway, -0.3 * Math.abs(u), 0.3 * Math.abs(u));
      const fz = -(Math.PI / 2) * rhoW * tMax * tMax * Math.abs(u) * vs;
      latF += fz; latX += fz * cbBody[0]; latY += fz * cbBody[1];
      this.toWorldDir([0, 0, fz], fw);
      this.addForce(cb[0], cb[1], cb[2], fw[0], fw[1], fw[2], A.side);
    }

    // ---- planing: dynamic pressure on each half of the bottom, station by station (see planing.ts) ----
    let planingLift = 0;
    const flux = this.plFlux, plW = this.plWet, plH = this.plHb, plU = this.plU;
    for (const pf of this.planingStrip) pf.fill(0);
    if (u > 0.3) {
      const NS = CELL_GRID.ns, dx = L / NS;
      const fade = smoothstep(0.35, 0.9, u / Math.sqrt(G * PLANING_BEAM));
      const heelDeg = heel / DEG;
      for (let sd = 0; sd < 2 && fade > 0; sd++) {
        const dep = this.sideDepth[sd];
        const sgn = sd === 1 ? 1 : -1;
        let lm = 0;
        for (let i = 0; i < NS; i++) { plW[i] = smoothstep(0.004, 0.035, dep[i]); lm += plW[i] * dx; }
        if (lm < 0.25) continue;
        const beta = clamp(DEADRISE_DEG - sgn * heelDeg, 0, 40); // the side she heels onto runs flatter
        const k = planingScale(lm / PLANING_BEAM, beta) * fade;
        // momentum flux m·w the bottom is giving the water at each station, working aft from the bow
        let bEnv = 0;
        for (let i = NS - 1; i >= 0; i--) {
          flux[i] = 0;
          if (plW[i] <= 0) { bEnv = 0; continue; }
          const s = (i + 0.5) / NS;
          const hb = halfBreadth(s, keelY(s) + Math.min(dep[i], 0.3));
          bEnv = Math.max(bEnv, hb); // water thrown clear at the chine doesn't close back in as the hull narrows aft
          plH[i] = hb;
          this.toWorldPoint([s * L, keelY(s), sgn * 0.5 * hb], p);
          env.water(p[0], Math.min(p[1], 0), p[2], t, wv);
          this.pointVel(p, v);
          tmp[0] = v[0] - wv[0]; tmp[1] = v[1] - wv[1]; tmp[2] = v[2] - wv[2];
          this.toBodyDir(tmp, vb);
          plU[i] = Math.max(vb[0], 0);
          // speed of the bottom into the water: its own slope to the flow, plus heave / pitch / roll motion
          // (a bottom moving AWAY from the water gives it nothing: no flux, so none to hand back further aft)
          const w = Math.max(-vb[1] + vb[0] * keelSlope(s), 0);
          flux[i] = 0.5 * k * sectionAddedMass(rhoW, 2 * bEnv) * plW[i] * w;
        }
        const strip = this.planingStrip[sd];
        for (let i = 0; i < NS; i++) {
          const wetA = plW[i] > 0, wetF = i + 1 < NS && plW[i + 1] > 0;
          if (!wetA) continue; // water leaving a wetted patch into air behind it keeps its momentum
          const V = wetF ? 0.5 * (plU[i] + plU[i + 1]) : plU[i];
          let f = -V * ((wetF ? flux[i + 1] : 0) - flux[i]);
          // Suction is not kept. Slender theory would pull the run down behind every lifting patch (and
          // pull the bow under whenever she trims by the head), but that needs the water to follow a
          // bottom that is moving away from it, and next to a free surface it lets go instead.
          if (f <= 0) continue;
          const xs = (i + (wetF ? 1 : 0.75)) * dx;
          const xa = Math.max(xs - PLANING_CP_SHIFT * lm, 0.5 * dx);
          const sl = Math.atan(keelSlope(xs / L));
          // pressure acts square to the bottom, so the bottom's slope tilts it aft: that is the planing drag
          const pa = this.planingAt[sd][i];
          pa[0] = xa; pa[1] = keelY(xa / L); pa[2] = sgn * 0.5 * plH[i];
          this.toWorldPoint(pa, p);
          this.toWorldDir([-Math.sin(sl) * f, Math.cos(sl) * f, 0], fw);
          this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2], A.planing);
          planingLift += fw[1];
          strip[i] = f;
        }
      }
    }

    // Immersed-transom drag: at low speed the water can't leave the wide flat transom cleanly and
    // drags an eddy behind it; it runs dry above a transom Froude number of ~3.5 (why weight goes
    // forward in light airs).
    if (transomA > 0 && u > 0.05) {
      const fnT = u / Math.sqrt(G * Math.max(transomDepth, 0.005));
      const ct = 0.25 * clamp(1 - fnT / 3.5, 0, 1);
      const rt = 0.5 * rhoW * u * u * transomA * ct;
      this.toWorldPoint([0, 0.08, 0], p);
      this.toWorldDir([-rt, 0, 0], fw);
      this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2], A.transom);
    }
    const hullF: V3 = [0, 0, 0];
    for (const a of [A.friction, A.wave, A.planing, A.side, A.transom]) { hullF[0] += a.fx; hullF[1] += a.fy; hullF[2] += a.fz; }
    forces.hull = { at: cb, f: hullF };

    // ---- foils: daggerboard + rudder as lifting lines in the water ----
    const bSpan = RIG.board.span * this.board;
    const bTop = keelY(RIG.board.x / L);
    const lat = this.solveFoils(dt, t, env, bSpan, bTop, amp);
    latF += lat[0]; latX += lat[1]; latY += lat[2];
    forces.board = A.board.item(this.pos.toArray());
    forces.rudder = A.rudder.item(this.pos.toArray());
    if (A.board.w === 0) { this.toWorldPoint([RIG.board.x, bTop - bSpan / 2, 0], p); forces.board.at = [p[0], p[1], p[2]]; }
    if (A.rudder.w === 0) { this.toWorldPoint([RIG.rudder.x, RUDDER_TOP_Y - RIG.rudder.span / 2, 0], p); forces.rudder.at = [p[0], p[1], p[2]]; }

    // ---- sails: every strip a horseshoe vortex in the air ----
    this.updateSailShapes(c);
    this.solveSails(dt, t, env, amp);
    let sFx = 0, sFy = 0, sFz = 0, sMx = 0, sMy = 0, sMz = 0, sTot = 0;
    for (const a of [A.main, A.jib, A.gennaker]) { sFx += a.fx; sFy += a.fy; sFz += a.fz; sMx += a.mx; sMy += a.my; sMz += a.mz; sTot += a.w; }
    forces.sails = { at: sTot > 0 ? [sMx / sTot, sMy / sTot, sMz / sTot] : [this.pos.x, this.pos.y + 3, this.pos.z], f: [sFx, sFy, sFz] };

    // ---- windage: hull, rig and crew bodies (drag areas per body axis, m²) ----
    const windage = (bx: number, by: number, bz: number, cx: number, cy: number, cz: number) => {
      this.toWorldPoint([bx, by, bz], p);
      this.pointVel(p, v);
      env.wind.at(p[0], p[1], p[2], t, this.air);
      tmp[0] = this.air[0] - v[0]; tmp[1] = this.air[1] - v[1]; tmp[2] = this.air[2] - v[2];
      this.toBodyDir(tmp, vb);
      const k = 0.5 * rhoA * Math.hypot(vb[0], vb[1], vb[2]);
      this.toWorldDir([k * cx * vb[0], k * cy * vb[1], k * cz * vb[2]], fw);
      this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2], A.windage);
    };
    windage(0.5 * L, 0.5, 0, 0.25, 1.2, 0.95); // hull: slippery end-on, a barn door side-on
    for (const h of [1.2, 3.2, 5.4]) { const m = mastPoint(h, su.mastRakeDeg); windage(m[0], m[1], m[2], 0.13, 0, 0.13); } // mast, shrouds, trapeze wires
    windage(this.helm.x, this.helm.y + 0.2, this.helm.z, 0.3, 0.3, 0.3);
    const onWire = clamp((Math.abs(this.crew.z) - this.railZ(this.crew.x)) / 0.6, 0, 1);
    windage(this.crew.x, this.crew.y + 0.2, this.crew.z, 0.35 + 0.2 * onWire, 0.35, 0.35);

    // ---- wings dragging in the water when heeled hard (open tube frames: drag only) ----
    if (this.setup.wings) {
      for (const sd of [-1, 1]) for (const xw of [WINGS.x0 + 0.2, (WINGS.x0 + WINGS.x1) / 2, WINGS.x1 - 0.2]) {
        this.toWorldPoint([xw, deckAt(xw), sd * this.railZ(xw)], p);
        if (p[1] > amp + 0.05) continue;
        const eta = env.water(p[0], p[1], p[2], t, wv);
        const wet = smoothstep(-0.03, 0.08, eta - p[1]);
        if (wet <= 0) continue;
        this.pointVel(p, v);
        const rx = v[0] - wv[0], ry = v[1] - wv[1], rz = v[2] - wv[2];
        const sp = Math.hypot(rx, ry, rz);
        const k = -0.5 * rhoW * 0.12 * sp * wet; // ~0.12 m² of tube per section
        this.addForce(p[0], p[1], p[2], k * rx, k * ry, k * rz, A.misc);
      }
    }

    // ---- mast in the water (capsize): buoyancy of the sealed spar + cylinder drag ----
    const mastSeg = RIG.mastHeight / 6;
    for (let i = 0; i < 6; i++) {
      this.toWorldPoint(mastPoint((i + 0.5) * mastSeg, this.setup.mastRakeDeg), p);
      if (p[1] > amp + 0.1) continue;
      const eta = env.water(p[0], p[1], p[2], t, wv);
      const wet = smoothstep(-0.04, 0.04, eta - p[1]);
      if (wet <= 0) continue;
      const vol = Math.PI * 0.035 * 0.035 * mastSeg;
      this.pointVel(p, v);
      const rx = v[0] - wv[0], ry = v[1] - wv[1], rz = v[2] - wv[2];
      const sp = Math.hypot(rx, ry, rz);
      const k = -0.5 * rhoW * 1.2 * 0.07 * mastSeg * sp * wet;
      this.addForce(p[0], p[1], p[2], k * rx, k * ry + rhoW * G * vol * wet, k * rz, A.misc);
    }

    // ---- grounding (Emsworth at low water…) ----
    let grounded = false;
    const seabed = -env.tide.depthM;
    const contact = (b: V3) => {
      this.toWorldPoint(b, p);
      const pen = seabed - p[1];
      if (pen <= 0) return;
      grounded = true;
      this.pointVel(p, v);
      const n = Math.max(0, 3e4 * pen - 3e3 * v[1]);
      const vh = Math.hypot(v[0], v[2]);
      const fr = (0.5 * n) / Math.max(vh, 0.05);
      this.addForce(p[0], p[1], p[2], -fr * v[0], n, -fr * v[2], A.ground);
    };
    contact([RIG.board.x, bTop - bSpan, 0]);
    contact([RIG.rudder.x, RUDDER_TOP_Y - RIG.rudder.span, 0]);
    for (const s of [0.1, 0.35, 0.6, 0.85]) contact([s * L, keelY(s), 0]);

    // ---- integrate: 6-DOF rigid body + the water's added mass ----
    const munk = this.integrate(dt, waterAtCg, cbBody, rhoW * vSub, rhoW, bSpan, bTop);

    for (const k in A) {
      const a = A[k as keyof typeof A];
      if (a.w > 0) ledger.push(a.item(cb));
    }
    this.centresUpdate(dt, cb, bF, forces.sails, latF, latX, latY, munk, bSpan);
    this.centres.planing = A.planing.w > 1 ? A.planing.item(cb).at : null;
    this.tel = this.telemetry(env, t, forces, ledger, { wetted, vSub, planingLift, grounded, fn });
    this.tel.centres = this.centres;
  }

  /**
   * Daggerboard and rudder. Each strip sees the water coming at it (boat motion, stream, wave orbitals)
   * plus what the other strips' vortices induce: so the rudder works in the board's downwash, the tips
   * lose lift, and the hull bottom acts as an end plate. Returns [ΣFz, ΣFz·x, ΣFz·y] in the body frame.
   */
  private solveFoils(dt: number, t: number, env: Environment, bSpan: number, bTop: number, amp: number): V3 {
    const sys = this.hydro, rhoW = env.rhoWater, A = this.acc;
    const p = [0, 0, 0], v = [0, 0, 0], tmp = [0, 0, 0], fw = [0, 0, 0], ind = [0, 0, 0], V = [0, 0, 0];
    const wv = this.w3, kin = this.kin, sec = this.sec;
    const up: V3 = [0, 1, 0];
    const [board, rud] = this.foils;
    board.x = RIG.board.x; board.yTop = bTop; board.span = bSpan; board.chord = RIG.board.chord; board.cdir = [-1, 0, 0];
    const rd = this.rudder;
    rud.x = RIG.rudder.x; rud.yTop = RUDDER_TOP_Y; rud.span = RIG.rudder.span; rud.chord = RIG.rudder.chord; rud.cdir = [-Math.cos(rd), 0, Math.sin(rd)];
    sys.planeP = [0, 0.04, 0]; sys.planeN = [0, 1, 0];
    // geometry + free stream
    for (const f of this.foils) {
      const ds = f.span / f.n;
      const on = f.span > 0.02;
      // how well the hull seals the root: a board under the hull is end-plated, a transom-hung rudder
      // half so (the surface just behind the transom gives way), and neither if the root is in the air
      this.toWorldPoint([f.x, f.yTop, 0], p);
      const rootDepth = p[1] > amp ? -1 : env.waves.elevation(p[0], p[2], t) - p[1];
      const seal = (f.name === 'board' ? 0.9 : 0.5) * smoothstep(-0.02, 0.05, rootDepth);
      for (let i = 0; i < f.n; i++) {
        const el = f.idx0 + i, k = 3 * el;
        const y = f.yTop - (i + 0.5) * ds;
        this.toWorldPoint([f.x, y, 0], p);
        let imm = 0;
        if (on && p[1] <= amp) {
          const eta = env.water(p[0], p[1], p[2], t, wv);
          imm = smoothstep(0, 0.6 * f.chord, eta - p[1]);
        }
        f.imm[i] = imm;
        const fi = f.flowInf[i];
        if (imm > 0) {
          this.pointVel(p, v);
          tmp[0] = wv[0] - v[0]; tmp[1] = wv[1] - v[1]; tmp[2] = wv[2] - v[2];
          this.toBodyDir(tmp, fi);
        } else fi[0] = fi[1] = fi[2] = 0;
        sys.a[k] = f.x; sys.a[k + 1] = y - ds / 2; sys.a[k + 2] = 0;
        sys.b[k] = f.x; sys.b[k + 1] = y + ds / 2; sys.b[k + 2] = 0;
        sys.chordDir[k] = f.cdir[0]; sys.chordDir[k + 1] = f.cdir[1]; sys.chordDir[k + 2] = f.cdir[2];
        sys.chord[el] = f.chord;
        sys.core2[el] = (0.2 * ds) ** 2 + 1e-5;
        sys.kappa[el] = seal;
        sys.active[el] = imm > 0.02 ? 1 : 0;
        if (!sys.active[el]) sys.gamma[el] = 0;
      }
      // trailing legs leave each node along the local stream (node j sits above strip j)
      for (let j = 0; j <= f.n; j++) {
        const a = f.flowInf[Math.max(j - 1, 0)], b = f.flowInf[Math.min(j, f.n - 1)];
        let dx = a[0] + b[0], dy = a[1] + b[1], dz = a[2] + b[2];
        const dl = Math.hypot(dx, dy, dz);
        if (dl < 1e-6) { dx = -1; dy = 0; dz = 0; } else { dx /= dl; dy /= dl; dz /= dl; }
        if (j < f.n) { const k = 3 * (f.idx0 + j); sys.db[k] = dx; sys.db[k + 1] = dy; sys.db[k + 2] = dz; }
        if (j > 0) { const k = 3 * (f.idx0 + j - 1); sys.da[k] = dx; sys.da[k + 1] = dy; sys.da[k + 2] = dz; }
      }
    }
    if (this.stepCount % 2 === 1) sys.buildInfluence();
    // solve each strip against the field of all the others
    let latF = 0, latX = 0, latY = 0;
    for (const f of this.foils) {
      const ds = f.span / f.n;
      const acc = f.name === 'board' ? A.board : A.rudder;
      for (let i = 0; i < f.n; i++) {
        const el = f.idx0 + i;
        const sf = f.stripForce[i], at = f.stripAt[i], fl = f.flow[i];
        const y = f.yTop - (i + 0.5) * ds;
        sf[0] = sf[1] = sf[2] = 0;
        at[0] = f.x; at[1] = y; at[2] = 0;
        fl[0] = fl[1] = fl[2] = 0;
        const imm = f.imm[i];
        if (!sys.active[el]) { f.alpha[i] = 0; f.cl[i] = 0; f.fs[i] = 1; continue; }
        sys.inducedAt(el, ind);
        const fi = f.flowInf[i];
        V[0] = fi[0] + ind[0]; V[1] = fi[1] + ind[1]; V[2] = fi[2] + ind[2];
        fl[0] = V[0]; fl[1] = V[1]; fl[2] = V[2];
        if (!stripKin(V, up, f.cdir, kin)) continue;
        const sp = kin.speed;
        foilSection(kin.alpha, (sp * f.chord) / env.nuWater, f.section, sec, f.fs[i]);
        // separation and circulation both take a few chord lengths of travel to catch up
        const rate = Math.max(sp / f.chord, 4);
        f.fs[i] += (sec.fs - f.fs[i]) * (1 - Math.exp((-dt * rate) / (sec.fs < f.fs[i] ? 3 : 6)));
        const gT = kin.gsign * 0.5 * sp * f.chord * sec.cl * imm;
        sys.gamma[el] += (gT - sys.gamma[el]) * (1 - Math.exp((-dt * rate) / 2));
        const lift = rhoW * sys.gamma[el] * sp * ds;
        const drag = 0.5 * rhoW * sp * sp * f.chord * ds * imm * sec.cd;
        sf[0] = lift * kin.kj[0] + drag * kin.v[0]; sf[1] = lift * kin.kj[1] + drag * kin.v[1]; sf[2] = lift * kin.kj[2] + drag * kin.v[2];
        const off = (sec.xcp - 0.25) * f.chord;
        at[0] = f.x + f.cdir[0] * off; at[2] = f.cdir[2] * off;
        f.alpha[i] = kin.alpha; f.cl[i] = sec.cl;
        latF += sf[2]; latX += sf[2] * at[0]; latY += sf[2] * y;
        this.toWorldPoint(at, p);
        this.toWorldDir(sf, fw);
        this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2], acc);
      }
    }
    return [latF, latX, latY];
  }

  /**
   * Sails. Pass 1 works out where every strip is and the apparent wind it would see alone; the vortex
   * system then adds what the rest of the rig induces there, and pass 2 turns that into section forces,
   * swings each sail about its luff against its sheet, and hands the loads to the hull.
   */
  private solveSails(dt: number, t: number, env: Environment, amp: number) {
    const sys = this.aero, rhoA = env.rhoAir, rhoW = env.rhoWater, A = this.acc;
    const p = [0, 0, 0], v = [0, 0, 0], vb = [0, 0, 0], tmp = [0, 0, 0], fw = [0, 0, 0], nb = [0, 0, 0];
    const ind = [0, 0, 0], V = [0, 0, 0], kp = [0, 0, 0], rB = [0, 0, 0], camber = [0, 0, 0];
    const wv = this.w3, kin = this.kin, sec = this.sec;
    const nodeA: V3 = [0, 0, 0], nodeB: V3 = [0, 0, 0], cd: V3 = [0, 0, 0];
    // mirror plane: the sea under the rig, in the boat's frame
    const eta0 = env.waves.elevation(this.pos.x, this.pos.z, t);
    this.toBodyPoint([this.pos.x, eta0, this.pos.z], sys.planeP);
    sys.planeN = [this.R[3], this.R[4], this.R[5]];

    // ---- pass 1: geometry, wet strips, free-stream apparent wind ----
    for (const sail of this.sails) {
      const isGen = sail.def.name === 'gennaker';
      const scale = isGen ? this.genHoist : 1;
      const n = sail.strips.length;
      sail.flying = !(isGen && scale < 0.02);
      sail.cImp = 0;
      sail.submerged = 0;
      if (!sail.flying) {
        sail.angle = this.main.angle; sail.rate = 0;
        for (let i = 0; i < n; i++) { sys.active[sail.idx0 + i] = 0; sys.gamma[sail.idx0 + i] = 0; }
        continue;
      }
      const ax = sail.axis, p0 = sail.def.p0, p1 = sail.def.p1;
      const node = (uu: number, o: V3) => {
        sail.chordDir(uu, cd);
        const q = 0.25 * sail.chordAt(uu);
        o[0] = lerp(p0[0], p1[0], uu) + cd[0] * q; o[1] = lerp(p0[1], p1[1], uu) + cd[1] * q; o[2] = lerp(p0[2], p1[2], uu) + cd[2] * q;
      };
      for (let i = 0; i < n; i++) {
        const st = sail.strips[i], el = sail.idx0 + i, k = 3 * el;
        const cdir = sail.chordDir(st.u, sail.cdir[i]);
        node(i / n, nodeA); node((i + 1) / n, nodeB);
        sys.a[k] = nodeA[0]; sys.a[k + 1] = nodeA[1]; sys.a[k + 2] = nodeA[2];
        sys.b[k] = nodeB[0]; sys.b[k + 1] = nodeB[1]; sys.b[k + 2] = nodeB[2];
        sys.chordDir[k] = cdir[0]; sys.chordDir[k + 1] = cdir[1]; sys.chordDir[k + 2] = cdir[2];
        sys.chord[el] = st.chord;
        sys.core2[el] = (0.2 * (sail.luffLen / n)) ** 2;
        // the point the strip's force acts at, and how fast that point is moving
        const arm = st.chord * sail.xcp[i];
        kp[0] = st.p[0] + cdir[0] * arm; kp[1] = st.p[1] + cdir[1] * arm; kp[2] = st.p[2] + cdir[2] * arm;
        this.toWorldPoint(kp, p);
        this.pointVel(p, v);
        // the sail's own swing adds to its apparent flow
        rB[0] = kp[0] - st.p[0]; rB[1] = kp[1] - st.p[1]; rB[2] = kp[2] - st.p[2];
        cross(ax, rB, tmp);
        const relB = sail.relB[i];
        relB[0] = tmp[0] * sail.rate; relB[1] = tmp[1] * sail.rate; relB[2] = tmp[2] * sail.rate;
        const area = st.area * scale;
        // in the water?
        let wet = 0;
        if (p[1] < amp + 0.2) {
          const eta = env.water(p[0], p[1], p[2], t, wv);
          wet = smoothstep(-0.15, 0.15, eta - p[1]);
        }
        sail.wet[i] = wet;
        const fwB = sail.fwB[i];
        fwB[0] = fwB[1] = fwB[2] = 0;
        if (wet > 0) {
          sail.submerged += wet / n;
          tmp[0] = v[0] - wv[0]; tmp[1] = v[1] - wv[1]; tmp[2] = v[2] - wv[2];
          this.toBodyDir(tmp, vb);
          cross(cdir, ax, nb);
          const nl = norm(nb) || 1;
          nb[0] /= nl; nb[1] /= nl; nb[2] /= nl;
          // Hull motion: a flexible sail lying in the water — quadratic drag, speed-capped (it folds).
          const vn = clamp(vb[0] * nb[0] + vb[1] * nb[1] + vb[2] * nb[2], -1.5, 1.5);
          const fn_ = -rhoW * area * wet * (0.4 * vn * Math.abs(vn) + 0.3 * vn);
          fwB[0] = fn_ * nb[0]; fwB[1] = fn_ * nb[1]; fwB[2] = fn_ * nb[2];
          // The sail's own swing through the water: handled as implicit damping (stiff otherwise).
          const vr = Math.abs(relB[0] * nb[0] + relB[1] * nb[1] + relB[2] * nb[2]);
          const r2 = rB[0] * rB[0] + rB[1] * rB[1] + rB[2] * rB[2];
          sail.cImp += rhoW * area * wet * (0.75 * vr + 0.5) * r2;
        }
        const fi = sail.flowInf[i];
        if (wet < 1) {
          env.wind.at(p[0], p[1], p[2], t, this.air);
          tmp[0] = this.air[0] - v[0]; tmp[1] = this.air[1] - v[1]; tmp[2] = this.air[2] - v[2];
          this.toBodyDir(tmp, fi);
          fi[0] -= relB[0]; fi[1] -= relB[1]; fi[2] -= relB[2];
        } else fi[0] = fi[1] = fi[2] = 0;
        sys.active[el] = wet < 0.5 ? 1 : 0;
        if (!sys.active[el]) sys.gamma[el] = 0;
      }
      // trailing legs leave each node along the local apparent wind (node j sits below strip j)
      for (let j = 0; j <= n; j++) {
        const a = sail.flowInf[Math.max(j - 1, 0)], b = sail.flowInf[Math.min(j, n - 1)];
        let dx = a[0] + b[0], dy = a[1] + b[1], dz = a[2] + b[2];
        const dl = Math.hypot(dx, dy, dz);
        if (dl < 1e-6) { dx = -1; dy = 0; dz = 0; } else { dx /= dl; dy /= dl; dz /= dl; }
        if (j < n) { const k = 3 * (sail.idx0 + j); sys.da[k] = dx; sys.da[k + 1] = dy; sys.da[k + 2] = dz; }
        if (j > 0) { const k = 3 * (sail.idx0 + j - 1); sys.db[k] = dx; sys.db[k + 1] = dy; sys.db[k + 2] = dz; }
      }
    }
    if (this.stepCount % 2 === 0) sys.buildInfluence();

    // ---- pass 2: section forces, sail swing, loads into the hull ----
    const gBody = [0, 0, 0];
    this.toBodyDir([0, -G, 0], gBody);
    for (const sail of this.sails) {
      const isGen = sail.def.name === 'gennaker';
      const scale = isGen ? this.genHoist : 1;
      const n = sail.strips.length;
      const acc = sail.def.name === 'main' ? A.main : isGen ? A.gennaker : A.jib;
      sail.force = [0, 0, 0];
      if (!sail.flying) {
        for (let i = 0; i < n; i++) { const sf = sail.stripForce[i]; sf[0] = sf[1] = sf[2] = 0; sail.alpha[i] = 0; sail.cl[i] = 0; }
        sail.sheetLoadN = 0;
        continue;
      }
      const ax = sail.axis;
      const dsLuff = (sail.luffLen / n);
      const cs = sail.angle >= 0 ? 1 : -1;
      let torque = 0;
      let cImplicit = sail.cImp; // N·m·s/rad, integrated implicitly
      for (let i = 0; i < n; i++) {
        const st = sail.strips[i], el = sail.idx0 + i;
        const cdir = sail.cdir[i], wet = sail.wet[i], fi = sail.flowInf[i];
        const sf = sail.stripForce[i], at = sail.stripAt[i], fl = sail.flow[i];
        const fwB = sail.fwB[i];
        sf[0] = fwB[0]; sf[1] = fwB[1]; sf[2] = fwB[2];
        fl[0] = fi[0]; fl[1] = fi[1]; fl[2] = fi[2];
        let xcp = sail.xcp[i];
        if (wet < 1) {
          sys.inducedAt(el, ind);
          V[0] = fi[0] + ind[0]; V[1] = fi[1] + ind[1]; V[2] = fi[2] + ind[2];
          if (stripKin(V, ax, cdir, kin)) {
            fl[0] = V[0]; fl[1] = V[1]; fl[2] = V[2];
            // camber bulges towards the side the clew has swung to; the wind on the other face is "backed"
            cross(ax, cdir, camber);
            const backed = (kin.un >= 0 ? 1 : -1) * cs * (kin.n[0] * camber[0] + kin.n[1] * camber[1] + kin.n[2] * camber[2]) < 0;
            sailSection(kin.alpha, backed, sail.shapeOf(i), sec, sail.fs[i]);
            const sp = kin.speed;
            const chordP = st.chord * kin.cperp;
            const rate = Math.max(sp / chordP, 1.5);
            // dynamic stall: separation is quick to spread, slow to re-attach
            sail.fs[i] += (sec.fs - sail.fs[i]) * (1 - Math.exp((-dt * rate) / (sec.fs < sail.fs[i] ? 3 : 6)));
            const live = scale * (1 - wet);
            const gT = sys.active[el] ? kin.gsign * 0.5 * sp * chordP * sec.cl * live : 0;
            sys.gamma[el] += (gT - sys.gamma[el]) * (1 - Math.exp((-dt * rate) / 2));
            const lift = rhoA * sys.gamma[el] * sp * dsLuff;
            const drag = 0.5 * rhoA * sp * sp * st.area * live * sec.cd;
            sf[0] += lift * kin.kj[0] + drag * kin.v[0]; sf[1] += lift * kin.kj[1] + drag * kin.v[1]; sf[2] += lift * kin.kj[2] + drag * kin.v[2];
            xcp = sec.xcp;
            sail.alpha[i] = kin.alpha; sail.cl[i] = sec.cl; sail.cd[i] = sec.cd; sail.luff[i] = sec.luff;
            if (i === sail.mid) sail.qMean += (0.5 * rhoA * sp * sp - sail.qMean) * Math.min(1, dt / 0.4);
          }
        }
        sail.xcp[i] += (xcp - sail.xcp[i]) * Math.min(1, dt / 0.1);
        const arm = st.chord * sail.xcp[i];
        rB[0] = cdir[0] * arm; rB[1] = cdir[1] * arm; rB[2] = cdir[2] * arm;
        at[0] = st.p[0] + rB[0]; at[1] = st.p[1] + rB[1]; at[2] = st.p[2] + rB[2];
        // torque about the luff axis drives the sail's swing
        cross(rB, sf, tmp);
        torque += tmp[0] * ax[0] + tmp[1] * ax[1] + tmp[2] * ax[2];
        this.toWorldPoint(at, p);
        this.toWorldDir(sf, fw);
        this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2], acc);
      }
      sail.alphaMid = sail.alpha[sail.mid];
      sail.force = [acc.fx, acc.fy, acc.fz];
      if (acc.w > 0) sail.ce = [acc.mx / acc.w, acc.my / acc.w, acc.mz / acc.w];

      // gravity on boom + sail (only the main has a boom worth mentioning)
      const sm = sail.def.name === 'main' ? 6 : 1;
      const cd15 = sail.chordDir(0.15, cd);
      cross(cd15, [gBody[0] * sm, gBody[1] * sm, gBody[2] * sm], tmp);
      torque += tmp[0] * ax[0] + tmp[1] * ax[1] + tmp[2] * ax[2];

      // sheet (one-sided rope) + hard stop, then integrate the swing
      const lim = sail.sheetLimit;
      const a = Math.abs(sail.angle);
      const sg = Math.sign(sail.angle) || 1;
      const I = sail.def.inertia * (isGen ? Math.max(scale, 0.3) : 1);
      cImplicit += 2;
      let sheetTorque = 0;
      if (a > lim) {
        const k = 7000;
        sheetTorque = k * (a - lim);
        torque -= sg * sheetTorque;
        cImplicit += Math.sqrt(k * I);
      }
      sail.sheetLoadN += (sheetTorque / Math.max(sail.chordAt(0), 0.5) - sail.sheetLoadN) * Math.min(1, dt / 0.25);
      const stop = sail.def.stopDeg * DEG;
      if (a > stop) { torque -= sg * 30000 * (a - stop); cImplicit += 300; }
      // semi-implicit: rate' = (rate + τ/I·dt) / (1 + c·dt/I)
      sail.rate = (sail.rate + (torque / I) * dt) / (1 + (cImplicit * dt) / I);
      sail.rate = clamp(sail.rate, -12, 12);
      sail.angle += sail.rate * dt;
    }
  }

  /**
   * Rigid-body step with the water's added mass. The hull, board and rudder each drag a mass of water
   * with them (different in each direction); written as Kirchhoff's equations in the body frame this
   * gives a full 6×6 mass matrix plus the momentum-turning terms, of which the best known is the Munk
   * moment: a hull sliding sideways wants to turn broadside-on. Returns that yaw moment (N·m, body y).
   */
  private integrate(dt: number, waterVel: V3, cbBody: V3, mDisp: number, rhoW: number, bSpan: number, bTop: number): number {
    const M = this.M6, b = this.b6;
    M.fill(0);
    const m = this.mass;
    const vB = [0, 0, 0], wB = [0, 0, 0], fB = [0, 0, 0], tB = [0, 0, 0];
    this.toBodyDir([this.vel.x, this.vel.y, this.vel.z], vB);
    this.toBodyDir(waterVel, wB);
    this.toBodyDir(this.F, fB);
    this.toBodyDir(this.T, tB);
    const w = this.omega;
    const om = [w.x, w.y, w.z];
    const vRel = [vB[0] - wB[0], vB[1] - wB[1], vB[2] - wB[2]];
    const cg = this.cgBody;
    const foilAdd = (span: number, chord: number) => rhoW * Math.PI * (chord / 2) ** 2 * span;
    const aBoard = foilAdd(bSpan, RIG.board.chord), aRud = foilAdd(RIG.rudder.span, RIG.rudder.chord);
    const sr = Math.sin(this.rudder), cr = Math.cos(this.rudder);
    // Added-mass elements: position relative to the CG and a 3×3 added-mass tensor (body axes).
    // A flat planing hull heaving has to shove a lot of water with it; sideways it is the foils that count.
    // `Ac` is the tensor used for the momentum-turning terms. For the hull it leaves the big heave term out:
    // at speed, the pressure a flat bottom makes by pushing water down IS the planing lift, already in
    // the ledger with its own centre of pressure, and counting it again here would trip the boat on its nose.
    const hullA = [0.05 * mDisp, 0, 0, 0, HEAVE_ADDED * mDisp, 0, 0, 0, 0.4 * mDisp];
    const hullAc = [0.05 * mDisp, 0, 0, 0, 0.05 * mDisp, 0, 0, 0, 0.4 * mDisp];
    const rudA = [aRud * sr * sr, 0, aRud * sr * cr, 0, 0, 0, aRud * sr * cr, 0, aRud * cr * cr];
    const brdA = [0, 0, 0, 0, 0, 0, 0, 0, aBoard];
    const els: Array<{ r: number[]; A: number[]; Ac: number[]; munk: number }> = [
      { r: [cbBody[0] - cg.x, cbBody[1] - cg.y, cbBody[2] - cg.z], A: hullA, Ac: hullAc, munk: 0.8 },
      { r: [RIG.board.x - cg.x, bTop - bSpan / 2 - cg.y, -cg.z], A: brdA, Ac: brdA, munk: 0 },
      { r: [RIG.rudder.x - cg.x, RUDDER_TOP_Y - RIG.rudder.span / 2 - cg.y, -cg.z], A: rudA, Ac: rudA, munk: 0 },
    ];
    // rotational added inertia of the hull (roll, yaw, pitch about body x, y, z)
    const aRot = [0.15 * mDisp * 0.25, 0.4 * mDisp * (L / 4) ** 2 * 0.6, HEAVE_ADDED * mDisp * (L / 4) ** 2 * 0.6];
    const I = this.inertia.elements; // column-major, symmetric
    for (let i = 0; i < 3; i++) {
      M[i * 6 + i] = m;
      for (let j = 0; j < 3; j++) M[(3 + i) * 6 + 3 + j] = I[j * 3 + i];
      M[(3 + i) * 6 + 3 + i] += aRot[i];
    }
    const lin = [fB[0], fB[1], fB[2]];
    const Iw = [I[0] * om[0] + I[3] * om[1] + I[6] * om[2], I[1] * om[0] + I[4] * om[1] + I[7] * om[2], I[2] * om[0] + I[5] * om[1] + I[8] * om[2]];
    const aw = [aRot[0] * om[0], aRot[1] * om[1], aRot[2] * om[2]];
    const ang = [
      tB[0] - (om[1] * (Iw[2] + aw[2]) - om[2] * (Iw[1] + aw[1])),
      tB[1] - (om[2] * (Iw[0] + aw[0]) - om[0] * (Iw[2] + aw[2])),
      tB[2] - (om[0] * (Iw[1] + aw[1]) - om[1] * (Iw[0] + aw[0])),
    ];
    let munk = 0;
    const S = [0, 0, 0, 0, 0, 0, 0, 0, 0], AS = [0, 0, 0, 0, 0, 0, 0, 0, 0], SA = [0, 0, 0, 0, 0, 0, 0, 0, 0], SAS = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const uu = [0, 0, 0], pp = [0, 0, 0], g = [0, 0, 0], t3 = [0, 0, 0];
    cross(om, vRel, t3);
    const wxv = [t3[0], t3[1], t3[2]];
    for (const e of els) {
      const r = e.r, Ae = e.A;
      S[0] = 0; S[1] = -r[2]; S[2] = r[1]; S[3] = r[2]; S[4] = 0; S[5] = -r[0]; S[6] = -r[1]; S[7] = r[0]; S[8] = 0;
      mul3(Ae, S, AS); mul3(S, Ae, SA); mul3(S, AS, SAS);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        M[i * 6 + j] += Ae[i * 3 + j];
        M[i * 6 + 3 + j] -= AS[i * 3 + j];
        M[(3 + i) * 6 + j] += SA[i * 3 + j];
        M[(3 + i) * 6 + 3 + j] -= SAS[i * 3 + j];
      }
      // velocity of the element through the water, the fluid momentum it carries, and the turning terms
      cross(om, r, t3);
      uu[0] = vRel[0] + t3[0]; uu[1] = vRel[1] + t3[1]; uu[2] = vRel[2] + t3[2];
      mulv3(e.Ac, uu, pp);
      mulv3(e.Ac, wxv, g);
      cross(om, pp, t3);
      g[0] -= t3[0]; g[1] -= t3[1]; g[2] -= t3[2];
      lin[0] += g[0]; lin[1] += g[1]; lin[2] += g[2];
      cross(r, g, t3);
      ang[0] += t3[0]; ang[1] += t3[1]; ang[2] += t3[2];
      if (e.munk > 0) {
        cross(uu, pp, t3);
        ang[0] -= e.munk * t3[0]; ang[1] -= e.munk * t3[1]; ang[2] -= e.munk * t3[2];
        munk -= e.munk * t3[1];
      }
    }
    b[0] = lin[0]; b[1] = lin[1]; b[2] = lin[2]; b[3] = ang[0]; b[4] = ang[1]; b[5] = ang[2];
    if (!solve6(M, b) || !b.every(Number.isFinite)) return munk;
    // semi-implicit Euler: new velocities first, then positions with them
    const aW = [0, 0, 0];
    this.toWorldDir([b[0], b[1], b[2]], aW);
    this.vel.x += aW[0] * dt; this.vel.y += aW[1] * dt; this.vel.z += aW[2] * dt;
    this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt; this.pos.z += this.vel.z * dt;
    w.x += b[3] * dt; w.y += b[4] * dt; w.z += b[5] * dt;
    const wl = w.length();
    if (wl > 1e-9) {
      const dq = new Quaternion().setFromAxisAngle(w.clone().divideScalar(wl), wl * dt);
      this.q.multiply(dq).normalize();
    }
    this.updateR();
    const o = [0, 0, 0];
    this.toWorldDir([cg.x, cg.y, cg.z], o);
    this.origin.set(this.pos.x - o[0], this.pos.y - o[1], this.pos.z - o[2]);
    return munk;
  }

  private centresUpdate(dt: number, cb: V3, buoy: number, sails: ForceArrow, latF: number, latX: number, latY: number, munk: number, bSpan: number) {
    const R = this.R;
    const c = this.centres;
    c.cg = [this.pos.x, this.pos.y, this.pos.z];
    c.cb = cb;
    const body = (w: ArrayLike<number>): V3 => {
      const o: V3 = [0, 0, 0];
      this.toBodyDir([w[0] - this.origin.x, w[1] - this.origin.y, w[2] - this.origin.z], o);
      return o;
    };
    const world = (b: V3): V3 => { const o: V3 = [0, 0, 0]; this.toWorldPoint(b, o); return o; };
    c.ce = Math.hypot(...sails.f) > 5 ? sails.at : null;
    // CLR: x where the lateral force would have to act to give the same yaw moment (the Munk couple shifts it)
    // Average the side force and its moments separately (~1 s), then divide: in waves the
    // instantaneous force is sometimes nearly a pure couple, with no meaningful point of action.
    const k = Math.min(1, dt / 1.0);
    const f = this.latFilt;
    f[0] += (latF - f[0]) * k; f[1] += (latX - munk - f[1]) * k; f[2] += (latY - f[2]) * k;
    this.clrBody = Math.abs(f[0]) > 60 ? [clamp(f[1] / f[0], -0.3, L), clamp(f[2] / f[0], -1.2, 0.3), 0] : null;
    c.clr = this.clrBody ? world(this.clrBody) : null;
    // GZ: horizontal gap between the weight acting down through G and buoyancy acting up through B,
    // measured athwartships; positive when it rights the boat.
    const zx = R[2], zz = R[8];
    const zl = Math.hypot(zx, zz) || 1;
    const heel = Math.asin(clamp(-R[5], -1, 1));
    const gz = ((cb[0] - this.pos.x) * zx + (cb[2] - this.pos.z) * zz) / zl * Math.sign(heel || 1);
    c.gzM = Math.abs(heel) > 0.5 * DEG ? gz : 0;
    c.rightingNm = c.gzM * buoy;
    // Metacentre: where buoyancy's vertical line crosses the boat's centreplane.
    const ny = R[5];
    if (Math.abs(heel) > 4 * DEG && Math.abs(heel) < 80 * DEG && buoy > 0) {
      const nx = R[2], nz = R[8];
      const s = -(nx * (cb[0] - this.origin.x) + ny * (cb[1] - this.origin.y) + nz * (cb[2] - this.origin.z)) / ny;
      c.meta = [cb[0], cb[1] + s, cb[2]];
    } else c.meta = null;
    // lead along the boat (body x) from the dynamic centres…
    c.leadM = c.ce && this.clrBody ? body(c.ce)[0] - this.clrBody[0] : 0;
    // …and the geometric one: sail-area centroid vs underwater lateral-area centroid
    let aS = 0, xS = 0;
    for (const sl of this.sails) {
      const sc = sl.def.name === 'gennaker' ? this.genHoist : 1;
      for (const st of sl.strips) { const a = st.area * sc; aS += a; xS += a * (st.p[0] - 0.4 * st.chord); }
    }
    let aL = 0, xL = 0;
    for (const cell of this.cells) {
      const p = world([cell.x, cell.y, cell.z]);
      if (p[1] < 0) { const a = (2 * cell.hx * 2 * cell.hy) / CELL_GRID.nz; aL += a; xL += a * cell.x; }
    }
    const aB = RIG.board.chord * bSpan, aR = RIG.rudder.chord * RIG.rudder.span;
    aL += aB + aR; xL += aB * RIG.board.x + aR * RIG.rudder.x;
    c.geoLeadM = aS > 0 && aL > 0 ? xS / aS - xL / aL : 0;
  }

  /**
   * Sail shape from the control lines: depth (camber), twist, luff tolerance and how far in the
   * sheet can bring each sail. Public so tests (and curious people) can poke at it directly.
   */
  updateSailShapes(c: ControlParams) {
    const ctl = (x: number) => clamp(x, 0, 1);
    const kicker = ctl(c.kicker), downhaul = ctl(c.downhaul), outhaul = ctl(c.outhaul);
    const forestay = ctl(c.forestayTension), barber = ctl(c.barberHauler);

    // --- Main ---
    const m = this.main;
    const sheetPull = smoothstep(0.55, 1.0, c.mainsheet); // how hard the sheet is on
    const rise = bridleRise(c.bridleLengthM);
    // A long bridle lifts the block, so the sheet pulls the boom in more than down: less leech tension.
    const sheetLeech = sheetPull * clamp(1.15 - 1.4 * rise, 0.35, 1);
    // The kicker holds the leech at any boom angle; the two add (they pull on the same boom).
    const leech = 1 - (1 - sheetLeech) * (1 - kicker);
    // Mast bend: kicker shoves the gooseneck forward (more when sheeted), rig tension pre-bends.
    const bend = clamp(0.35 * kicker + 0.35 * kicker * sheetPull + 0.3 * forestay, 0, 1);
    // Under load the leech stretches open (cloth, battens, mast tip): sails twist off in gusts and
    // depower themselves a little; good leech tension resists it. 39 Pa ≈ 16 kn apparent.
    const gustTwist = Math.min(12, 8 * (m.qMean / 39) * (1 - 0.6 * leech));
    m.twistDeg = 3 + 22 * (1 - leech) + 5 * downhaul + 3 * bend + gustTwist;
    // Downhaul pulls the draft forward: a rounder entry keeps working at lower angles (wider groove).
    m.luffTol = (7 - 3 * downhaul) * DEG;
    m.strips.forEach((st, i) => {
      const u = st.u;
      m.depths[i] = clamp(
        0.16
          - 0.07 * outhaul * Math.max(0, 1 - u / 0.65) // outhaul: foot, fading out by ~⅔ height
          - 0.025 * downhaul // downhaul: flattens the whole luff
          - 0.04 * bend * Math.pow(u, 0.7), // bend: flattens the middle and top
        0.04, 0.2);
    });
    // A tight, short bridle is a straight line: the block slides to leeward and the boom can't centre.
    const minBoom = 2 + 10 * Math.exp(-rise / 0.07);
    m.sheetLimit = lerp(m.def.sheetRange[0], minBoom, ctl(c.mainsheet)) * DEG;

    // --- Jib ---
    const j = this.jib;
    // Forestay tension sets sag: slack = fuller, forgiving entry; tight = flat, narrow groove, points higher.
    j.depths.fill(0.155 - 0.055 * forestay);
    j.luffTol = (4 + 4 * forestay) * DEG;
    // Barber hauler pulls the lead in and down: tighter sheeting angle and a firmer leech.
    const js = ctl(c.jibSheet);
    j.twistDeg = Math.max(2, 6 + 14 * (1 - js) * (1 - 0.5 * barber) - 3 * barber * js)
      + Math.min(8, 4 * (j.qMean / 39) * (1 - 0.5 * forestay));
    const minJib = lerp(13, 8, barber);
    j.sheetLimit = lerp(j.def.sheetRange[0], minJib, js) * DEG;

    // --- Gennaker ---
    const g = this.gennaker;
    g.twistDeg = 8 + 12 * (1 - c.gennakerSheet);
    g.luffTol = 8 * DEG;
    g.depths.fill(0.17);
    g.sheetLimit = lerp(g.def.sheetRange[0], g.def.sheetRange[1], ctl(c.gennakerSheet)) * DEG;
  }

  telemetry(env: Environment, t: number, forces: Telemetry['forces'], ledger: ForceItem[],
    x: { wetted: number; vSub: number; planingLift: number; grounded: boolean; fn: number } = { wetted: 0, vSub: 0, planingLift: 0, grounded: false, fn: 0 }): Telemetry {
    const R = this.R;
    const heading = bearingOf(R[0], R[6]);
    const heel = Math.asin(clamp(-R[5], -1, 1)) / DEG;
    const pitch = Math.asin(clamp(R[3], -1, 1)) / DEG;
    const cur = env.tide.current;
    const sx = this.vel.x - cur.x, sz = this.vel.z - cur.z;
    const stw = Math.hypot(sx, sz);
    const sog = Math.hypot(this.vel.x, this.vel.z);
    const air = [0, 0, 0];
    env.wind.at(this.pos.x, 10, this.pos.z, t, air);
    const tws = Math.hypot(air[0], air[2]);
    const twd = bearingOf(-air[0], -air[2]);
    env.wind.at(this.pos.x, 5, this.pos.z, t, air);
    const app = [air[0] - this.vel.x, 0, air[2] - this.vel.z];
    const ab = [0, 0, 0];
    this.toBodyDir(app, ab);
    const up = towards(twd);
    const wy = [0, 0, 0];
    this.toWorldDir([this.omega.x, this.omega.y, this.omega.z], wy);
    return {
      headingDeg: heading, cogDeg: bearingOf(this.vel.x, this.vel.z), heelDeg: heel, pitchDeg: pitch,
      sogKn: sog / 0.514444, stwKn: stw / 0.514444,
      vmgKn: (this.vel.x * up.x + this.vel.z * up.z) / 0.514444,
      leewayDeg: stw > 0.2 ? wrap180(bearingOf(sx, sz) - heading) : 0,
      fn: x.fn, yawRateDegS: -wy[1] / DEG,
      twsKn: tws / 0.514444, twdDeg: twd, twaDeg: wrap180(twd - heading),
      awsKn: Math.hypot(app[0], app[2]) / 0.514444, awaDeg: Math.atan2(-ab[2], -ab[0]) / DEG,
      draftM: this.lowestDraft(env, t), wettedM2: x.wetted, dispKg: x.vSub * env.rhoWater, planingLift: x.planingLift,
      grounded: x.grounded, capsized: Math.abs(heel) > 70, forces, ledger,
    };
  }

  private lowestDraft(env: Environment, t: number): number {
    const p = [0, 0, 0];
    this.toWorldPoint([0.35 * L, keelY(0.35), 0], p);
    return env.waves.elevation(p[0], p[2], t) - p[1];
  }
}

// ---------- small vector helpers ----------
function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function norm(a: ArrayLike<number>): number { return Math.hypot(a[0], a[1], a[2]); }
function lerp3(a: V3, b: V3, t: number): V3 { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function cross(a: ArrayLike<number>, b: ArrayLike<number>, o: number[]): number[] {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  o[0] = x; o[1] = y; o[2] = z;
  return o;
}
/** 3×3 (row-major) products. */
function mul3(a: number[], b: number[], o: number[]) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
}
function mulv3(a: number[], v: number[], o: number[]) {
  const x = v[0], y = v[1], z = v[2];
  o[0] = a[0] * x + a[1] * y + a[2] * z; o[1] = a[3] * x + a[4] * y + a[5] * z; o[2] = a[6] * x + a[7] * y + a[8] * z;
}
/** Rodrigues rotation of v about unit axis k by angle th. */
function rotateAbout(v: V3, k: V3, th: number, o: V3): V3 {
  const c = Math.cos(th), s = Math.sin(th);
  const d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  const cx = k[1] * v[2] - k[2] * v[1], cy = k[2] * v[0] - k[0] * v[2], cz = k[0] * v[1] - k[1] * v[0];
  o[0] = v[0] * c + cx * s + k[0] * d;
  o[1] = v[1] * c + cy * s + k[1] * d;
  o[2] = v[2] * c + cz * s + k[2] * d;
  return o;
}
function moveToward(cur: Vector3, target: V3, maxStep: number) {
  const dx = target[0] - cur.x, dy = target[1] - cur.y, dz = target[2] - cur.z;
  const d = Math.hypot(dx, dy, dz);
  if (d <= maxStep || d < 1e-9) cur.set(target[0], target[1], target[2]);
  else cur.set(cur.x + (dx / d) * maxStep, cur.y + (dy / d) * maxStep, cur.z + (dz / d) * maxStep);
}
function emptyForces(): Telemetry['forces'] {
  const z = (): ForceArrow => ({ at: [0, 0, 0], f: [0, 0, 0] });
  return { sails: z(), board: z(), rudder: z(), buoyancy: z(), gravity: z(), hull: z() };
}
