/**
 * Planing: the dynamic pressure under a hull that is skimming rather than floating.
 *
 * Two classical results are combined.
 *
 * 1. Slender-body ("2D+t") theory gives the DISTRIBUTION. Watch a fixed slice of water as the hull
 *    passes over it: the bottom pushes it down at w = V × (local bottom angle to the flow), and the slice
 *    picks up downward momentum m·w, where m is the added mass of the wetted section, (π/8)·ρ·b² for a
 *    flat bottom of wetted breadth b. The hull feels the reaction, per metre of length:
 *
 *        f(x) = −V · d(m·w)/dx        (x forward)
 *
 *    So lift appears wherever the wetted breadth is growing (the stagnation line at the front of the
 *    wetted area) and wherever the bottom angle increases going forward. The same formula gives suction
 *    where the bottom falls away from the flow; that part is dropped, because beside a free surface the
 *    water separates rather than follow. What is left is lift governed by the angle the bottom makes
 *    with the water at the FRONT of the wetted area. Press the bow down and the wetted front moves
 *    forward on to the steeper forefoot, which lifts harder and further forward: that is what stops a
 *    planing dinghy tripping over her own bow (until she really is pressed too far).
 *
 * 2. Savitsky's planing-hull regression ("Hydrodynamic Design of Planing Hulls", 1964) gives the
 *    MAGNITUDE. Its dynamic term, CL = 0.0120·√λ·τ^1.1 on beam² (τ in degrees, λ = wetted length / beam),
 *    with the deadrise correction CLβ = CL − 0.0065·β·CL^0.6, is what tank tests actually measure.
 *    Slender theory alone gives CL = (π/4)·τ, right at λ ≈ 1 and low for longer wetted lengths, so the
 *    section added mass is scaled by k(λ, β) below to land on Savitsky. His centre of pressure for the
 *    dynamic term (75% of the wetted length from the transom, where slender theory puts it all at the
 *    leading edge) is matched by applying each strip's force a quarter of the wetted length further aft.
 *
 * Buoyancy is not in here: the sim integrates that over the real immersed hull.
 */

/** Savitsky's dynamic lift coefficient (based on beam²) for a prismatic surface. Used to calibrate, and by the tests. */
export function savitskyDynamicCL(tauDeg: number, lambda: number, deadriseDeg: number): number {
  if (tauDeg <= 0 || lambda <= 0) return 0;
  const cl0 = 0.012 * Math.sqrt(lambda) * Math.pow(Math.min(tauDeg, 15), 1.1);
  return Math.max(0, cl0 - 0.0065 * Math.max(deadriseDeg, 0) * Math.pow(cl0, 0.6));
}

/** Scale on the section added mass that makes slender theory reproduce Savitsky's lift. */
export function planingScale(lambda: number, deadriseDeg: number): number {
  return 0.98 * Math.sqrt(Math.max(lambda, 0.2)) * Math.min(1, Math.max(0.3, 1 - 0.0215 * deadriseDeg));
}

/** Added mass per metre of a flat section of wetted breadth b pushing down into the surface (kg/m). */
export const sectionAddedMass = (rho: number, b: number) => (Math.PI / 8) * rho * b * b;

/** Strip forces act this fraction of the wetted length aft of where slender theory puts them. */
export const PLANING_CP_SHIFT = 0.25;

/** Solve the 6×6 system M·x = b in place (Gaussian elimination, partial pivoting). M is row-major. */
export function solve6(M: Float64Array, b: Float64Array): boolean {
  const n = 6;
  for (let c = 0; c < n; c++) {
    let piv = c, best = Math.abs(M[c * n + c]);
    for (let r = c + 1; r < n; r++) { const v = Math.abs(M[r * n + c]); if (v > best) { best = v; piv = r; } }
    if (best < 1e-12) return false;
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[piv * n + k]; M[piv * n + k] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    const d = M[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      b[r] -= f * b[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * b[k];
    b[r] = s / M[r * n + r];
  }
  return true;
}
