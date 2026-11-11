/**
 * Vortex system: a numerical lifting line (Phillips & Snyder style) for a set of lifting strips.
 *
 * Every strip of every sail (or foil) carries a horseshoe vortex: a bound segment along its
 * quarter-chord line and two trailing legs running downstream to infinity. The strength Γ of each
 * horseshoe is whatever makes the Kutta–Joukowski lift ρ·Γ·V equal the lift its own 2-D section makes
 * at the angle of attack it REALLY sees, i.e. free stream plus the velocity induced by every other
 * vortex. Solving that gives, with no fudge factors:
 *   - induced drag and tip loss (the lift vector tilts back where the trailing vortices push down),
 *   - the jib/main slot (the main's upwash lifts the jib, the jib's downwash heads the main),
 *   - the kite's effect on everything behind it, the board's downwash on the rudder,
 *   - the mirror effect of the sea surface under the sails / the hull above the foils.
 * The same vortices give the velocity anywhere in space, which is what the flow layers draw.
 *
 * All vectors are in whatever frame the owner uses (the boat's body frame).
 */

const FOUR_PI = 4 * Math.PI;

/** Velocity at P induced by a straight vortex segment A→B of unit circulation, added to out. */
export function segmentVelocity(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  core2: number, out: Float64Array | number[], scale = 1,
): void {
  const r1x = px - ax, r1y = py - ay, r1z = pz - az;
  const r2x = px - bx, r2y = py - by, r2z = pz - bz;
  const r1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z);
  const r2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z);
  const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
  const den = r1 * r2 * (r1 * r2 + r1x * r2x + r1y * r2y + r1z * r2z) + core2;
  if (den < 1e-12) return;
  const k = (scale * (r1 + r2)) / (FOUR_PI * den);
  out[0] += k * cx; out[1] += k * cy; out[2] += k * cz;
}

/** Velocity at P induced by a semi-infinite vortex leaving A along unit direction d, unit circulation. */
export function rayVelocity(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number, dx: number, dy: number, dz: number,
  core2: number, out: Float64Array | number[], scale = 1,
): void {
  const rx = px - ax, ry = py - ay, rz = pz - az;
  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const den = r * (r - (rx * dx + ry * dy + rz * dz)) + core2;
  if (den < 1e-12) return;
  const k = scale / (FOUR_PI * den);
  out[0] += k * (dy * rz - dz * ry); out[1] += k * (dz * rx - dx * rz); out[2] += k * (dx * ry - dy * rx);
}

export class VortexSystem {
  /** Bound vortex ends (a = root / lower end, b = tip / upper end), 3 numbers per element. */
  a: Float64Array; b: Float64Array;
  /** Unit downstream direction of the trailing leg at each end (shared between neighbouring strips). */
  da: Float64Array; db: Float64Array;
  /** Unit chord direction and chord length (for spreading the bound vortex along the chord when drawing). */
  chordDir: Float64Array; chord: Float64Array;
  /** Circulation (m²/s), + = right-handed about a→b. */
  gamma: Float64Array;
  /** Mirror strength per element: +1 rigid wall (sea under a sail), −1 free surface at speed, 0 none. */
  kappa: Float64Array;
  /** Vortex core radius² (m²) per element: keeps the velocity finite close to a filament. */
  core2: Float64Array;
  /** 0 = this element is switched off (kite in its bag, foil strip out of the water). */
  active: Uint8Array;
  /** Mirror plane: point and unit normal. */
  planeP: [number, number, number] = [0, 0, 0];
  planeN: [number, number, number] = [0, 1, 0];
  /**
   * Control points (where the flow is sampled to get each strip's angle of attack) and bound points
   * (the middle of each bound vortex, where the Kutta–Joukowski force is taken). By default both sit
   * mid-way along the bound vortex: Prandtl's classical lifting line. Set `autoPoints = false` and fill
   * them yourself to put the control points at 3/4 chord (Weissinger's extended lifting line, right for
   * low aspect ratios, swept lines and closely coupled sails).
   */
  cp: Float64Array; bp: Float64Array;
  autoPoints = true;
  /** Influence coefficients: velocity at control point i (W) and at bound point i (Wb) per unit Γ of element j. */
  W: Float64Array; Wb: Float64Array;
  private tmp = new Float64Array(3);

  constructor(public n: number) {
    this.a = new Float64Array(3 * n); this.b = new Float64Array(3 * n);
    this.da = new Float64Array(3 * n); this.db = new Float64Array(3 * n);
    this.chordDir = new Float64Array(3 * n); this.chord = new Float64Array(n);
    this.gamma = new Float64Array(n); this.kappa = new Float64Array(n);
    this.core2 = new Float64Array(n).fill(0.01); this.active = new Uint8Array(n).fill(1);
    this.cp = new Float64Array(3 * n); this.bp = new Float64Array(3 * n);
    this.W = new Float64Array(3 * n * n); this.Wb = new Float64Array(3 * n * n);
  }

  /** Unit-circulation horseshoe j (no mirror) at point p, added to out. `spread` > 1 spreads the bound part along the chord. */
  private horseshoe(j: number, px: number, py: number, pz: number, out: Float64Array | number[], scale: number, spread: number) {
    const a = this.a, b = this.b, da = this.da, db = this.db, k = 3 * j;
    const c2 = this.core2[j];
    if (spread <= 1) {
      segmentVelocity(px, py, pz, a[k], a[k + 1], a[k + 2], b[k], b[k + 1], b[k + 2], c2, out, scale);
      rayVelocity(px, py, pz, b[k], b[k + 1], b[k + 2], db[k], db[k + 1], db[k + 2], c2, out, scale);
      rayVelocity(px, py, pz, a[k], a[k + 1], a[k + 2], da[k], da[k + 1], da[k + 2], c2, out, -scale);
      return;
    }
    // Thin-aerofoil-like chordwise loading: most of the circulation near the luff, tapering to the leech.
    // Each filament is its own complete horseshoe, so the field stays a legitimate (divergence-free) flow.
    const cd = this.chordDir, c = this.chord[j];
    for (let m = 0; m < 3; m++) {
      const off = (SPREAD_X[m] - 0.25) * c, w = scale * SPREAD_W[m];
      const ox = cd[k] * off, oy = cd[k + 1] * off, oz = cd[k + 2] * off;
      segmentVelocity(px, py, pz, a[k] + ox, a[k + 1] + oy, a[k + 2] + oz, b[k] + ox, b[k + 1] + oy, b[k + 2] + oz, c2, out, w);
      rayVelocity(px, py, pz, b[k] + ox, b[k + 1] + oy, b[k + 2] + oz, db[k], db[k + 1], db[k + 2], c2, out, w);
      rayVelocity(px, py, pz, a[k] + ox, a[k + 1] + oy, a[k + 2] + oz, da[k], da[k + 1], da[k + 2], c2, out, -w);
    }
  }

  /** Horseshoe j plus its mirror image, unit circulation, at p. (The image is far enough away to stay a single filament.) */
  private element(j: number, px: number, py: number, pz: number, out: Float64Array | number[], scale: number, spread: number) {
    this.horseshoe(j, px, py, pz, out, scale, spread);
    const kap = this.kappa[j];
    if (kap === 0) return;
    // image: evaluate the real system at the mirrored point, then mirror the velocity vector
    const n = this.planeN, p0 = this.planeP, t = this.tmp;
    const d = (px - p0[0]) * n[0] + (py - p0[1]) * n[1] + (pz - p0[2]) * n[2];
    t[0] = t[1] = t[2] = 0;
    this.horseshoe(j, px - 2 * d * n[0], py - 2 * d * n[1], pz - 2 * d * n[2], t, scale * kap, 1);
    const vn = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
    out[0] += t[0] - 2 * vn * n[0]; out[1] += t[1] - 2 * vn * n[1]; out[2] += t[2] - 2 * vn * n[2];
  }

  /** Rebuild the influence matrices from the current geometry. */
  buildInfluence(): void {
    const n = this.n, W = this.W, Wb = this.Wb, a = this.a, b = this.b, cp = this.cp, bp = this.bp;
    const v = [0, 0, 0];
    if (this.autoPoints) {
      for (let k = 0; k < 3 * n; k++) cp[k] = bp[k] = (a[k] + b[k]) / 2;
    }
    const same = this.autoPoints;
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      for (let j = 0; j < n; j++) {
        const k = 3 * (i * n + j);
        if (!this.active[j] || !this.active[i]) { W[k] = W[k + 1] = W[k + 2] = Wb[k] = Wb[k + 1] = Wb[k + 2] = 0; continue; }
        v[0] = v[1] = v[2] = 0;
        this.element(j, cp[i3], cp[i3 + 1], cp[i3 + 2], v, 1, 1);
        W[k] = v[0]; W[k + 1] = v[1]; W[k + 2] = v[2];
        if (!same) { v[0] = v[1] = v[2] = 0; this.element(j, bp[i3], bp[i3 + 1], bp[i3 + 2], v, 1, 1); }
        Wb[k] = v[0]; Wb[k + 1] = v[1]; Wb[k + 2] = v[2];
      }
    }
  }

  /** Velocity induced at control point i by the whole system (current Γ). */
  inducedAt(i: number, out: Float64Array | number[]): void { this.dot(this.W, i, out); }
  /** Velocity induced at bound point i (the one that tilts the lift vector: induced drag). */
  inducedAtBound(i: number, out: Float64Array | number[]): void { this.dot(this.Wb, i, out); }
  private dot(W: Float64Array, i: number, out: Float64Array | number[]): void {
    const n = this.n, g = this.gamma;
    let x = 0, y = 0, z = 0;
    for (let j = 0, k = 3 * i * n; j < n; j++, k += 3) {
      const gj = g[j];
      if (gj === 0) continue;
      x += W[k] * gj; y += W[k + 1] * gj; z += W[k + 2] * gj;
    }
    out[0] = x; out[1] = y; out[2] = z;
  }

  /**
   * Induced velocity anywhere in space (added to out). With `spread`, the bound vortex of any element
   * the point is close to is spread along its chord, so the near field bends round the surface the way
   * the real flow does; far away the difference is nothing and the single filament is used.
   */
  velocityAt(px: number, py: number, pz: number, out: Float64Array | number[], spread = false): void {
    const g = this.gamma, a = this.a, b = this.b;
    for (let j = 0; j < this.n; j++) {
      if (!this.active[j] || g[j] === 0) continue;
      let sp = 1;
      if (spread) {
        const k = 3 * j, c = this.chord[j];
        const dx = px - (a[k] + b[k]) / 2, dy = py - (a[k + 1] + b[k + 1]) / 2, dz = pz - (a[k + 2] + b[k + 2]) / 2;
        if (dx * dx + dy * dy + dz * dz < 4 * c * c + 1) sp = 3;
      }
      this.element(j, px, py, pz, out, g[j], sp);
    }
  }
}

const SPREAD_X = [0.08, 0.3, 0.68];
const SPREAD_W = [0.45, 0.35, 0.2];

/** Solve the dense n×n system A·x = b in place (row-major A, partial pivoting). Returns false if singular. */
export function solveDense(A: Float64Array, b: Float64Array, n: number): boolean {
  for (let c = 0; c < n; c++) {
    let piv = c, best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-12) return false;
    if (piv !== c) {
      for (let k = c; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    const d = 1 / A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] * d;
      if (f === 0) continue;
      const rn = r * n, cn = c * n;
      for (let k = c + 1; k < n; k++) A[rn + k] -= f * A[cn + k];
      b[r] -= f * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    const rn = r * n;
    for (let k = r + 1; k < n; k++) sum -= A[rn + k] * b[k];
    b[r] = sum / A[rn + r];
  }
  return true;
}

/**
 * Wagner's indicial lift, in R.T. Jones's two-exponential form. A step change in the downwash at 3/4
 * chord gives half its lift at once and the rest over the next several chord lengths of travel, as the
 * shed vortex is left behind: φ(s) = 1 − 0.165·e^(−0.0455 s) − 0.335·e^(−0.3 s), s in half-chords.
 */
export const WAGNER = { A1: 0.165, b1: 0.0455, A2: 0.335, b2: 0.3 };
