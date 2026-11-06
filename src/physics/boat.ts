import { Matrix3, Quaternion, Vector3 } from 'three';
import { DEG, G, bearingOf, clamp, interp, lerp, smoothstep, towards, wrap180 } from './math';
import { CELL_GRID, HULL, buildCells, buildPanels, hullPoint, keelY, sheerY, type Cell, type Panel } from './hull';
import { foilCoeffs, sailCoeffs, stripForce, type Coeffs, type FoilSpec, type SailShape } from './coeffs';
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
  board: { x: 2.7, span: 1.0, chord: 0.3, strips: 5 },
  rudder: { x: -0.1, span: 0.8, chord: 0.24, strips: 4, maxDeg: 35 },
  spritLength: 1.15,
};
const MAST_DECK_Y = deckAt(RIG.mastX);

/** Cockpit layout (shared by physics seats and the 3D model), from the real boat. */
export const COCKPIT = { aftS: 0.04, fwdS: 0.6, sideDeckW: 0.3, floorY: 0.27, strapZ: 0.28 };
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

/** Residuary (wave-making) resistance / weight vs Froude number — light planing dinghy. */
const RESID_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.2, 0.003], [0.3, 0.01], [0.35, 0.018], [0.4, 0.03], [0.45, 0.05], [0.5, 0.072], [0.55, 0.09],
  [0.6, 0.1], [0.7, 0.1], [0.8, 0.092], [1.0, 0.078], [1.3, 0.068], [2.0, 0.068],
];
/** Dynamic (planing) lift / weight vs Froude number. */
const LIFT_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [0.4, 0], [0.5, 0.05], [0.7, 0.2], [1.0, 0.35], [1.5, 0.45], [3, 0.5],
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
  ceFrac: number; // chordwise centre of effort
}

export interface SailStrip { u: number; p: V3; chord: number; area: number }

export class SailRuntime {
  angle = 0; // rotation about the luff axis, + = clew to starboard
  rate = 0;
  axis: V3;
  strips: SailStrip[] = [];
  areaScale = 1;
  alpha: number[] = [];
  /** Apparent flow each strip sees (body frame, air relative to the sail), for flow visualisation. */
  flow: V3[] = [];
  alphaMid = 0;
  force: V3 = [0, 0, 0]; // world, total
  ce: V3 = [0, 0, 0]; // world
  depths: number[] = [];
  twistDeg = 0;
  luffTol = 6 * DEG;
  clMid = 0; // lift coefficient of the middle strip (drives the jib/main slot effect)
  qMean = 0; // smoothed dynamic pressure on the sail (Pa) — loads the leech in gusts
  sheetLimit = 0;
  submerged = 0;
  constructor(public def: SailDef, public area: number) {
    this.axis = [0, 1, 0];
    this.setAxis();
    this.rebuild(area);
  }
  setAxis() {
    const a = sub(this.def.p1, this.def.p0);
    const len = norm(a);
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
    this.strips = [];
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const chord = c0 * d.shape(u);
      this.strips.push({ u, p: lerp3(d.p0, d.p1, u), chord, area: (chord * len * sinA) / n });
    }
    this.alpha = new Array(n).fill(0);
    this.flow = Array.from({ length: n }, () => [0, 0, 0] as V3);
    this.depths = new Array(n).fill(0.12);
  }
  /** Chord unit vector (body frame) at height fraction u. */
  chordDir(u: number, out: V3): V3 {
    const side = this.angle >= 0 ? 1 : -1;
    return rotateAbout([-1, 0, 0], this.axis, this.angle + side * this.twistDeg * DEG * u, out);
  }
  /** Geometry for rendering: luff point, chord vector (incl. length) and camber depth at u. */
  section(u: number): { p: V3; c: V3; chord: number; depth: number } {
    const d = this.def;
    const n = d.strips;
    const s0 = this.strips[0];
    const c0 = s0.chord / d.shape(s0.u);
    const chord = c0 * d.shape(u);
    const k = clamp(Math.round(u * n - 0.5), 0, n - 1);
    return { p: lerp3(d.p0, d.p1, u), c: this.chordDir(u, [0, 0, 0]), chord, depth: this.depths[k] };
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
      name: 'main', p0: mp(RIG.boomAbove), p1: mp(RIG.mastHeight), strips: 6,
      shape: (u) => 0.15 + 0.85 * Math.sqrt(Math.max(0, 1 - u * u)), inertia: 6, stopDeg: 88, sheetRange: [85, 3], ceFrac: 0.42,
    },
    {
      name: 'jib', p0: [L - 0.15, tackY, 0], p1: [hounds[0] + 0.05, hounds[1], 0], strips: 4,
      shape: (u) => 0.05 + 0.95 * (1 - u), inertia: 0.8, stopDeg: 75, sheetRange: [60, 10], ceFrac: 0.4,
    },
    {
      name: 'gennaker', p0: [L + RIG.spritLength, tackY + 0.05, 0], p1: [genHead[0] + 0.12, genHead[1], 0], strips: 6,
      shape: (u) => 0.2 + 0.8 * Math.sqrt(Math.max(0, 1 - u * u)), inertia: 1.5, stopDeg: 125, sheetRange: [110, 20], ceFrac: 0.45,
    },
  ];
}

// ---------- Telemetry ----------

export interface ForceArrow { at: V3; f: V3 }
/** The boat's centres (world frame) plus the stability numbers that come from them. */
export interface Centres {
  cg: V3; // centre of gravity (boat + crew)
  cb: V3; // centre of buoyancy
  ce: V3 | null; // centre of effort: where the total sail force acts
  clr: V3 | null; // centre of lateral resistance: where the lateral water force acts (incl. Munk couple)
  meta: V3 | null; // transverse metacentre (only defined once heeled a few degrees)
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
  cells: Cell[];
  panels: Panel[];
  R = new Float64Array(9);
  origin = new Vector3();
  tel!: Telemetry;
  private setupKey = '';
  centres: Centres = { cg: [0, 0, 0], cb: [0, 0, 0], ce: null, clr: null, meta: null, gzM: 0, rightingNm: 0, leadM: 0, geoLeadM: 0 };
  private clrBody: V3 | null = null;
  private latFilt: V3 = [0, 0, 0];
  private etaCol: Float64Array;
  private inertia = new Matrix3();
  private ampSum = 0;

  // scratch
  private F = [0, 0, 0];
  private T = [0, 0, 0];
  private w3 = new Float64Array(3);
  private air = new Float64Array(3);
  private cf: Coeffs = { cl: 0, cd: 0 };

  constructor(public setup: BoatSetup) {
    this.cells = buildCells();
    this.etaCol = new Float64Array(CELL_GRID.ns * CELL_GRID.nz);
    this.panels = buildPanels();
    const defs = makeSailDefs(setup.mastRakeDeg);
    this.sails = [new SailRuntime(defs[0], setup.mainAreaM2), new SailRuntime(defs[1], setup.jibAreaM2), new SailRuntime(defs[2], setup.gennakerAreaM2)];
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
  /** Velocity (world) of a world-space point rigidly attached to the hull. */
  private pointVel(p: ArrayLike<number>, o: number[] | Float64Array) {
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
  private addForce(px: number, py: number, pz: number, fx: number, fy: number, fz: number) {
    if (!(Number.isFinite(fx) && Number.isFinite(fy) && Number.isFinite(fz))) return;
    const F = this.F, T = this.T;
    F[0] += fx; F[1] += fy; F[2] += fz;
    const rx = px - this.pos.x, ry = py - this.pos.y, rz = pz - this.pos.z;
    T[0] += ry * fz - rz * fy;
    T[1] += rz * fx - rx * fz;
    T[2] += rx * fy - ry * fx;
  }

  // ----- mass properties -----
  private massProps() {
    const s = this.setup;
    const items: Array<{ m: number; p: V3; k: V3 }> = [
      { m: s.hullMassKg, p: [0.42 * L, 0.24, 0], k: [0.45, 1.3, 1.25] },
      { m: s.rigMassKg, p: [RIG.mastX, MAST_DECK_Y + 2.6, 0], k: [1.8, 0.2, 1.8] },
      { m: s.helmMassKg, p: [this.helm.x, this.helm.y, this.helm.z], k: [0.3, 0.3, 0.3] },
      { m: s.crewMassKg, p: [this.crew.x, this.crew.y, this.crew.z], k: [0.3, 0.3, 0.3] },
    ];
    if (s.wings) {
      const xm = (WINGS.x0 + WINGS.x1) / 2;
      for (const sd of [-1, 1]) items.push({ m: WINGS.massEachKg, p: [xm, deckAt(xm), sd * (gunwaleZ(xm) + s.wingWidthM / 2)], k: [0.1, 0.5, 0.5] });
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
    for (const s of this.sails) { s.angle = -this.side * 20 * DEG; s.rate = 0; }
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
    this.tel = this.telemetry(env, 0, emptyForces());
  }

  /** Bring a capsized boat upright where it lies (the crew have done the righting). */
  rightBoat(env: Environment, t: number, c: ControlParams) {
    const head = this.tel.headingDeg;
    const p = this.pos.clone();
    this.reset(env, head, p.x, p.z, c, 0);
    this.vel.set(env.tide.current.x, 0, env.tide.current.z);
    this.tel = this.telemetry(env, t, emptyForces());
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
    const R = this.R;
    const rhoW = env.rhoWater, rhoA = env.rhoAir;
    const waves = env.waves;
    this.ampSum = waves.comps.reduce((s, k) => s + k.amp, 0);
    const amp = this.ampSum;
    const p = [0, 0, 0], v = [0, 0, 0], vb = [0, 0, 0], fw = [0, 0, 0], fb = [0, 0, 0], tmp = [0, 0, 0];
    const wv = this.w3;
    const forces = emptyForces();

    // ---- gravity ----
    F[1] -= this.mass * G;
    forces.gravity = { at: [this.pos.x, this.pos.y, this.pos.z], f: [0, -this.mass * G, 0] };

    // ---- hydrostatics: buoyancy of each volume cell under the local wave surface ----
    let bF = 0, bX = 0, bY = 0, bZ = 0, vSub = 0;
    // wave height once per vertical column of cells (they share x,z closely), not per cell
    const etaCol = this.etaCol;
    etaCol.fill(NaN);
    for (const cell of this.cells) {
      this.toWorldPoint([cell.x, cell.y, cell.z], p);
      const ext = Math.abs(R[3]) * 2 * cell.hx + Math.abs(R[4]) * 2 * cell.hy + Math.abs(R[5]) * 2 * cell.hz;
      const bottom = p[1] - ext / 2;
      if (bottom > amp) continue;
      let eta = 1e9;
      if (p[1] + ext / 2 >= -amp) {
        eta = etaCol[cell.col];
        if (Number.isNaN(eta)) eta = etaCol[cell.col] = waves.elevation(p[0], p[2], t);
      }
      const frac = clamp((eta - bottom) / ext, 0, 1);
      if (frac <= 0) continue;
      const fy = rhoW * G * cell.vol * frac;
      const cy = bottom + (frac * ext) / 2;
      bF += fy; bX += fy * p[0]; bY += fy * cy; bZ += fy * p[2];
      vSub += cell.vol * frac;
    }
    const cb: V3 = bF > 0 ? [bX / bF, bY / bF, bZ / bF] : [this.pos.x, this.pos.y, this.pos.z];
    if (bF > 0) this.addForce(cb[0], cb[1], cb[2], 0, bF, 0);
    forces.buoyancy = { at: cb, f: [0, bF, 0] };
    const vStatic = this.mass / rhoW;
    const subFrac = clamp(vSub / vStatic, 0, 1);

    // ---- speed through the water (at the CG) → Froude & Reynolds numbers ----
    env.water(this.pos.x, Math.min(this.pos.y, -0.05), this.pos.z, t, wv);
    const vrel = [this.vel.x - wv[0], this.vel.y - wv[1], this.vel.z - wv[2]];
    this.toBodyDir(vrel, vb);
    const u = vb[0];
    const vSway = vb[2];
    const lwl = 0.92 * L;
    const fn = Math.abs(u) / Math.sqrt(G * lwl);
    const re = Math.max((Math.abs(u) * lwl) / env.nuWater, 1e5);
    const cfr = (0.075 / (Math.log10(re) - 2) ** 2) * 1.1; // ITTC-57 + form factor

    // ---- hull skin panels: skin friction + cross-flow pressure drag/damping ----
    let wetted = 0;
    let hullFx = 0, hullFy = 0, hullFz = 0;
    // lateral (body z) water force and its first moments → dynamic centre of lateral resistance
    let latF = 0, latX = 0, latY = 0;
    let transomA = 0, transomDepth = 0; // immersed transom area and depth
    const nb = [0, 0, 0];
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
      // cross-flow: surge mostly handled by the resistance model, so damp it out here
      const vn = vb[0] * 0.1 * nb[0] + vb[1] * nb[1] + vb[2] * nb[2];
      const pn_ = -rhoW * a * (0.45 * vn * Math.abs(vn) + 0.25 * vn);
      const vnf = vb[0] * nb[0] + vb[1] * nb[1] + vb[2] * nb[2];
      const tx = vb[0] - vnf * nb[0], ty = vb[1] - vnf * nb[1], tz = vb[2] - vnf * nb[2];
      const vt = Math.hypot(tx, ty, tz);
      const ft = -0.5 * rhoW * cfr * a * vt;
      fb[0] = pn_ * nb[0] + ft * tx; fb[1] = pn_ * nb[1] + ft * ty; fb[2] = pn_ * nb[2] + ft * tz;
      // Forward-facing bottom (bow rocker) driven into the flow: stagnation pressure acts along
      // the panel normal — lifts the bow when it digs in, and costs drag (no free lunch).
      if (nb[0] > 0 && nb[1] < 0 && vb[0] > 0) {
        const vin = vb[0] * nb[0];
        const pr = 0.5 * rhoW * a * vin * vin;
        fb[0] -= pr * nb[0]; fb[1] -= pr * nb[1];
      }
      latF += fb[2]; latX += fb[2] * pn.x; latY += fb[2] * pn.y;
      this.toWorldDir(fb, fw);
      this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2]);
      hullFx += fw[0]; hullFy += fw[1]; hullFz += fw[2];
    }

    // ---- residuary (wave-making) resistance + planing lift ----
    const heel = Math.asin(clamp(-R[5], -1, 1));
    const pitch = Math.asin(clamp(R[3], -1, 1));
    const W = this.mass * G;
    let planingLift = 0;
    if (subFrac > 0.01) {
      const thetaOpt = 1.5 * DEG * smoothstep(0.4, 0.9, fn);
      const penalty = 1 + 1.5 * Math.sin(heel) ** 2 + 30 * (pitch - thetaOpt) ** 2;
      const rr = W * interp(RESID_TABLE, fn) * penalty * subFrac * (u < 0 ? 1.5 : 1);
      fb[0] = -Math.sign(u) * rr; fb[1] = 0; fb[2] = 0;
      this.toWorldDir(fb, fw);
      this.addForce(cb[0], cb[1], cb[2], fw[0], fw[1], fw[2]);
      hullFx += fw[0]; hullFy += fw[1]; hullFz += fw[2];
      if (u > 0) {
        // Savitsky-style trim dependence: bow-down trim cuts lift and moves its centre forward,
        // bow-up adds lift further aft — this is where a planing hull gets its pitch stiffness.
        const dTrim = (pitch - thetaOpt) / DEG;
        const trimFactor = clamp(1 + dTrim / 12, 0.5, 1.3);
        planingLift = W * interp(LIFT_TABLE, fn) * Math.cos(heel) ** 2 * subFrac * trimFactor;
        const xl = L * clamp(0.38 - 0.035 * dTrim, 0.25, 0.65);
        this.toWorldPoint([xl, keelY(xl / L), 0], p);
        this.toWorldDir([0, planingLift, 0], fw);
        this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2]);
      }
    }
    // Immersed-transom drag: at low speed the water can't leave the wide flat transom cleanly and
    // drags an eddy behind it; it runs dry above a transom Froude number of ~4.5 (why weight goes
    // forward in light airs).
    if (transomA > 0 && u > 0.05) {
      const fnT = u / Math.sqrt(G * Math.max(transomDepth, 0.005));
      const ct = 0.25 * clamp(1 - fnT / 4.5, 0, 1);
      const rt = 0.5 * rhoW * u * u * transomA * ct;
      this.toWorldPoint([0, 0.08, 0], p);
      this.toWorldDir([-rt, 0, 0], fw);
      this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2]);
      hullFx += fw[0]; hullFy += fw[1]; hullFz += fw[2];
    }
    forces.hull = { at: cb, f: [hullFx, hullFy, hullFz] };

    // ---- foils: daggerboard + rudder (strip theory) ----
    const foil = (xs: number, yTop: number, span: number, chord: number, n: number, chordDir: V3, spec: FoilSpec, arrow: ForceArrow, downwash = 0) => {
      const ds = span / n;
      let sx = 0, sy = 0, sz = 0, mx = 0, my = 0, mz = 0, tot = 0;
      for (let i = 0; i < n; i++) {
        this.toWorldPoint([xs, yTop - (i + 0.5) * ds, 0], p);
        if (p[1] > amp) continue;
        const eta = env.water(p[0], p[1], p[2], t, wv);
        const depth = eta - p[1];
        const immersion = smoothstep(0, 0.6 * chord, depth);
        if (immersion <= 0) continue;
        this.pointVel(p, v);
        tmp[0] = wv[0] - v[0]; tmp[1] = wv[1] - v[1]; tmp[2] = wv[2] - v[2];
        this.toBodyDir(tmp, vb);
        vb[2] += downwash * vSway; // sits in the board's downwash: sees less of the leeway
        stripForce(vb, [0, 1, 0], chordDir, 0.5 * rhoW * chord * ds * immersion, (a, o) => foilCoeffs(a, spec, o), this.cf, fb);
        latF += fb[2]; latX += fb[2] * xs; latY += fb[2] * (yTop - (i + 0.5) * ds);
        this.toWorldDir(fb, fw);
        this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2]);
        sx += fw[0]; sy += fw[1]; sz += fw[2];
        const m = Math.hypot(fw[0], fw[1], fw[2]);
        mx += p[0] * m; my += p[1] * m; mz += p[2] * m; tot += m;
      }
      arrow.f = [sx, sy, sz];
      if (tot > 0) arrow.at = [mx / tot, my / tot, mz / tot];
      else { this.toWorldPoint([xs, yTop - span / 2, 0], p); arrow.at = [p[0], p[1], p[2]]; }
    };
    const bSpan = RIG.board.span * this.board;
    const bTop = keelY(RIG.board.x / L);
    if (bSpan > 0.02) {
      foil(RIG.board.x, bTop, bSpan, RIG.board.chord, RIG.board.strips, [-1, 0, 0],
        { ar: Math.max(0.4, (2 * bSpan) / RIG.board.chord), clMax: 1.1, stall: 13 * DEG, cd0: 0.01, cn: 1.8 }, forces.board);
    }
    const rd = this.rudder;
    foil(RIG.rudder.x, 0.05, RIG.rudder.span, RIG.rudder.chord, RIG.rudder.strips, [-Math.cos(rd), 0, Math.sin(rd)],
      { ar: (1.6 * RIG.rudder.span) / RIG.rudder.chord, clMax: 1.05, stall: 14 * DEG, cd0: 0.011, cn: 1.8 }, forces.rudder,
      0.5 * clamp(bSpan / RIG.board.span, 0, 1));

    // ---- sails ----
    this.updateSailShapes(c);
    const gBody = [0, 0, 0];
    this.toBodyDir([0, -G, 0], gBody);
    let sFx = 0, sFy = 0, sFz = 0, sMx = 0, sMy = 0, sMz = 0, sTot = 0;
    const cdir: V3 = [0, 0, 0];
    const ceB = [0, 0, 0], rB = [0, 0, 0], relB = [0, 0, 0], camber = [0, 0, 0];
    // Jib/main slot: the jib's downwash heads the main (less angle of attack: the main luff backwinds
    // first), the main's upwash lifts the jib (more angle). Only while both sails are on the same side
    // and the wind isn't far aft; the kite's blanket takes over when it's up.
    const sameSide = Math.sign(this.main.angle) === Math.sign(this.jib.angle);
    const slot = sameSide ? (1 - this.genHoist) * smoothstep(125, 85, Math.abs(this.tel.awaDeg)) : 0;
    const headMain = 6 * DEG * clamp(this.jib.clMid, 0, 1.6) * 0.6 * slot;
    const liftJib = 3 * DEG * clamp(this.main.clMid, 0, 1.6) * slot;
    for (const sail of this.sails) {
      const isGen = sail.def.name === 'gennaker';
      // interference: with the kite up the jib sits in its wake and the main in its downwash
      const scale = isGen ? this.genHoist : sail.def.name === 'jib' ? 1 - 0.6 * this.genHoist : 1 - 0.15 * this.genHoist;
      sail.force = [0, 0, 0];
      if (isGen && scale < 0.02) { sail.angle = this.main.angle; sail.rate = 0; continue; }
      let torque = 0;
      let cImplicit = 0; // N·m·s/rad, integrated implicitly
      let fx = 0, fy = 0, fz = 0, cx = 0, cy = 0, cz = 0, ctot = 0;
      sail.submerged = 0;
      for (let i = 0; i < sail.strips.length; i++) {
        const st = sail.strips[i];
        sail.chordDir(st.u, cdir);
        const arm = st.chord * sail.def.ceFrac;
        ceB[0] = st.p[0] + cdir[0] * arm; ceB[1] = st.p[1] + cdir[1] * arm; ceB[2] = st.p[2] + cdir[2] * arm;
        this.toWorldPoint(ceB, p);
        this.pointVel(p, v);
        // the sail's own swing adds to its apparent flow
        rB[0] = ceB[0] - st.p[0]; rB[1] = ceB[1] - st.p[1]; rB[2] = ceB[2] - st.p[2];
        cross(sail.axis, rB, tmp);
        relB[0] = tmp[0] * sail.rate; relB[1] = tmp[1] * sail.rate; relB[2] = tmp[2] * sail.rate;
        const area = st.area * scale;
        // in the water?
        let wet = 0;
        if (p[1] < amp + 0.2) {
          const eta = env.water(p[0], p[1], p[2], t, wv);
          wet = smoothstep(-0.15, 0.15, eta - p[1]);
        }
        if (wet > 0) {
          sail.submerged += wet / sail.strips.length;
          tmp[0] = v[0] - wv[0]; tmp[1] = v[1] - wv[1]; tmp[2] = v[2] - wv[2];
          this.toBodyDir(tmp, vb);
          cross(cdir, sail.axis, nb);
          const nl = norm(nb as V3) || 1;
          nb[0] /= nl; nb[1] /= nl; nb[2] /= nl;
          // Hull motion: a flexible sail lying in the water — quadratic drag, speed-capped (it folds).
          const vn = clamp(vb[0] * nb[0] + vb[1] * nb[1] + vb[2] * nb[2], -1.5, 1.5);
          const fn_ = -rhoW * area * wet * (0.4 * vn * Math.abs(vn) + 0.3 * vn);
          fb[0] = fn_ * nb[0]; fb[1] = fn_ * nb[1]; fb[2] = fn_ * nb[2];
          // The sail's own swing through the water: handled as implicit damping (stiff otherwise).
          const vr = Math.abs(relB[0] * nb[0] + relB[1] * nb[1] + relB[2] * nb[2]);
          const r2 = rB[0] * rB[0] + rB[1] * rB[1] + rB[2] * rB[2];
          cImplicit += rhoW * area * wet * (0.75 * vr + 0.5) * r2;
        } else { fb[0] = fb[1] = fb[2] = 0; }
        if (wet < 1) {
          env.wind.at(p[0], p[1], p[2], t, this.air);
          tmp[0] = this.air[0] - v[0]; tmp[1] = this.air[1] - v[1]; tmp[2] = this.air[2] - v[2];
          this.toBodyDir(tmp, vb);
          vb[0] -= relB[0]; vb[1] -= relB[1]; vb[2] -= relB[2];
          const kite = sail.def.name === 'gennaker';
          // kite: max lift ≈1.4, in line with published asymmetric-spinnaker coefficients (ORC VPP)
          const shape: SailShape = { depth: sail.depths[i], luffTol: sail.luffTol, ar: kite ? 3.2 : 5.5, cd0: kite ? 0.06 : 0.03, clScale: kite ? 0.85 : 1 };
          const fa = [0, 0, 0];
          // camber bulges towards the side the clew has swung to
          cross(sail.axis, cdir, camber);
          const cs = sail.angle >= 0 ? 1 : -1;
          camber[0] *= cs; camber[1] *= cs; camber[2] *= cs;
          const slotRot = sail === this.main ? -cs * headMain : sail === this.jib ? cs * liftJib : 0;
          if (slotRot !== 0) rotateAbout([vb[0], vb[1], vb[2]], sail.axis, slotRot, vb as V3);
          sail.flow[i][0] = vb[0]; sail.flow[i][1] = vb[1]; sail.flow[i][2] = vb[2];
          sail.alpha[i] = stripForce(vb, sail.axis, cdir, 0.5 * rhoA * area * (1 - wet), (a, o, bk) => sailCoeffs(a, shape, o, bk), this.cf, fa, camber);
          if (i === Math.floor(sail.strips.length / 2)) {
            sail.clMid = this.cf.cl;
            const q = 0.5 * rhoA * (vb[0] * vb[0] + vb[1] * vb[1] + vb[2] * vb[2]);
            sail.qMean += (q - sail.qMean) * Math.min(1, dt / 0.4);
          }
          fb[0] += fa[0]; fb[1] += fa[1]; fb[2] += fa[2];
        }
        // torque about the luff axis drives the sail's swing
        cross(rB, fb, tmp);
        torque += tmp[0] * sail.axis[0] + tmp[1] * sail.axis[1] + tmp[2] * sail.axis[2];
        this.toWorldDir(fb, fw);
        this.addForce(p[0], p[1], p[2], fw[0], fw[1], fw[2]);
        fx += fw[0]; fy += fw[1]; fz += fw[2];
        const m = Math.hypot(fw[0], fw[1], fw[2]);
        cx += p[0] * m; cy += p[1] * m; cz += p[2] * m; ctot += m;
      }
      sail.alphaMid = sail.alpha[Math.floor(sail.strips.length / 2)];
      sail.force = [fx, fy, fz];
      if (ctot > 0) sail.ce = [cx / ctot, cy / ctot, cz / ctot];
      sFx += fx; sFy += fy; sFz += fz; sMx += cx; sMy += cy; sMz += cz; sTot += ctot;

      // gravity on boom + sail (only the main has a boom worth mentioning)
      const sm = sail.def.name === 'main' ? 6 : 1;
      sail.chordDir(0.15, cdir);
      const gr = [cdir[0] * 1.0, cdir[1] * 1.0, cdir[2] * 1.0];
      cross(gr, [gBody[0] * sm, gBody[1] * sm, gBody[2] * sm], tmp);
      torque += tmp[0] * sail.axis[0] + tmp[1] * sail.axis[1] + tmp[2] * sail.axis[2];

      // sheet (one-sided rope) + hard stop, then integrate the swing
      const lim = sail.sheetLimit;
      const a = Math.abs(sail.angle);
      const sg = Math.sign(sail.angle) || 1;
      const I = sail.def.inertia * (isGen ? Math.max(scale, 0.3) : 1);
      cImplicit += 2;
      if (a > lim) {
        const k = 7000;
        torque -= sg * k * (a - lim);
        cImplicit += Math.sqrt(k * I);
      }
      const stop = sail.def.stopDeg * DEG;
      if (a > stop) { torque -= sg * 30000 * (a - stop); cImplicit += 300; }
      // semi-implicit: rate' = (rate + τ/I·dt) / (1 + c·dt/I)
      sail.rate = (sail.rate + (torque / I) * dt) / (1 + (cImplicit * dt) / I);
      sail.rate = clamp(sail.rate, -12, 12);
      sail.angle += sail.rate * dt;
    }
    forces.sails = { at: sTot > 0 ? [sMx / sTot, sMy / sTot, sMz / sTot] : [this.pos.x, this.pos.y + 3, this.pos.z], f: [sFx, sFy, sFz] };

    // ---- windage: hull + crew bodies ----
    const windage = (bx: number, by: number, bz: number, cda: number) => {
      this.toWorldPoint([bx, by, bz], p);
      this.pointVel(p, v);
      env.wind.at(p[0], p[1], p[2], t, this.air);
      const ax = this.air[0] - v[0], ay = this.air[1] - v[1], az = this.air[2] - v[2];
      const sp = Math.hypot(ax, ay, az);
      const k = 0.5 * rhoA * cda * sp;
      this.addForce(p[0], p[1], p[2], k * ax, k * ay, k * az);
    };
    windage(0.5 * L, 0.7, 0, 0.5);
    windage(this.helm.x, this.helm.y + 0.2, this.helm.z, 0.3);
    windage(this.crew.x, this.crew.y + 0.2, this.crew.z, 0.35);

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
        this.addForce(p[0], p[1], p[2], k * rx, k * ry, k * rz);
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
      this.addForce(p[0], p[1], p[2], k * rx, k * ry + rhoW * G * vol * wet, k * rz);
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
      this.addForce(p[0], p[1], p[2], -fr * v[0], n, -fr * v[2]);
    };
    contact([RIG.board.x, bTop - bSpan, 0]);
    contact([RIG.rudder.x, 0.05 - RIG.rudder.span, 0]);
    for (const s of [0.1, 0.35, 0.6, 0.85]) contact([s * L, keelY(s), 0]);

    // ---- integrate (semi-implicit Euler), with added mass ----
    const mDisp = rhoW * vSub;
    const foilAdd = (span: number, chord: number) => rhoW * Math.PI * (chord / 2) ** 2 * span;
    const aBoard = foilAdd(bSpan, RIG.board.chord);
    const aRud = foilAdd(RIG.rudder.span, RIG.rudder.chord);
    const add = [0.05 * mDisp, 0.8 * mDisp, 0.4 * mDisp + aBoard + aRud];
    const fbody = [0, 0, 0];
    this.toBodyDir(F, fbody);
    const ab = [fbody[0] / (this.mass + add[0]), fbody[1] / (this.mass + add[1]), fbody[2] / (this.mass + add[2])];
    const aw = [0, 0, 0];
    this.toWorldDir(ab, aw);
    this.vel.x += aw[0] * dt; this.vel.y += aw[1] * dt; this.vel.z += aw[2] * dt;
    this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt; this.pos.z += this.vel.z * dt;

    const tb = [0, 0, 0];
    this.toBodyDir(T, tb);
    // Munk moment: a hull sliding sideways wants to turn broadside to the flow — with leeway this
    // turns the bow to windward (a real source of weather helm). Viscous effects cut it ~20%.
    const munk = 0.8 * (0.4 * mDisp - 0.05 * mDisp) * u * vSway;
    tb[1] += munk;
    const I = this.inertia;
    const dB = RIG.board.x - this.cgBody.x, dR = RIG.rudder.x - this.cgBody.x;
    const zB = this.cgBody.y - (bTop - bSpan / 2);
    const Ieff = I.clone();
    const e = Ieff.elements; // column-major, symmetric here
    e[0] += 0.15 * mDisp * 0.25 + aBoard * zB * zB + aRud * 0.3 * 0.3;
    e[4] += 0.4 * mDisp * (L / 4) ** 2 * 0.6 + aBoard * dB * dB + aRud * dR * dR;
    e[8] += 0.8 * mDisp * (L / 4) ** 2 * 0.6;
    const Iinv = Ieff.invert();
    const w = this.omega;
    const Iw = w.clone().applyMatrix3(I);
    const gyro = new Vector3().crossVectors(w, Iw);
    const wdot = new Vector3(tb[0] - gyro.x, tb[1] - gyro.y, tb[2] - gyro.z).applyMatrix3(Iinv);
    w.addScaledVector(wdot, dt);
    const wl = w.length();
    if (wl > 1e-9) {
      const dq = new Quaternion().setFromAxisAngle(w.clone().divideScalar(wl), wl * dt);
      this.q.multiply(dq).normalize();
    }
    this.updateR();
    const o = [0, 0, 0];
    this.toWorldDir([this.cgBody.x, this.cgBody.y, this.cgBody.z], o);
    this.origin.set(this.pos.x - o[0], this.pos.y - o[1], this.pos.z - o[2]);

    this.centresUpdate(dt, cb, bF, forces.sails, latF, latX, latY, munk, bSpan);
    this.tel = this.telemetry(env, t, forces, { wetted, vSub, planingLift, grounded, fn });
    this.tel.centres = this.centres;
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

  telemetry(env: Environment, t: number, forces: Telemetry['forces'],
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
      grounded: x.grounded, capsized: Math.abs(heel) > 70, forces,
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
