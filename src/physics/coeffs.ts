import { DEG, smoothstep } from './math';

/**
 * Lift/drag coefficient models valid for the full 0..180° angle-of-attack range.
 * Pre-stall: attached-flow curves. Post-stall: blended into flat-plate behaviour
 * (normal-force coefficient Cn·sinα split into lift = Cn·sinα·|cosα|, drag = Cn·sin²α).
 */

export interface Coeffs { cl: number; cd: number }

export interface FoilSpec { ar: number; clMax: number; stall: number; cd0: number; cn: number }

/** Symmetric hydrofoil (daggerboard, rudder). `a` = |α| in radians, 0..π. */
export function foilCoeffs(a: number, f: FoilSpec, out: Coeffs): Coeffs {
  const cla = (2 * Math.PI * f.ar) / (f.ar + 2); // finite-wing lift slope (Helmbold-style)
  const clPre = f.clMax * Math.tanh((cla * a) / f.clMax);
  const cdPre = f.cd0 + (clPre * clPre) / (Math.PI * f.ar * 0.9);
  const w = smoothstep(f.stall, f.stall + 8 * DEG, a);
  const s = Math.sin(a);
  const clFp = 0.5 * f.cn * Math.abs(Math.sin(2 * a));
  const cdFp = f.cn * s * s + f.cd0;
  out.cl = (1 - w) * clPre + w * clFp;
  out.cd = (1 - w) * cdPre + w * cdFp;
  return out;
}

export interface SailShape { depth: number; luffTol: number; ar: number; cd0: number; clScale?: number }

/**
 * Soft sail. Depth (camber/chord) sets max lift and the optimum angle; below `luffTol`
 * the luff lifts and the sail flogs (little lift, extra drag).
 */
export function sailCoeffs(a: number, s: SailShape, out: Coeffs, backed = false): Coeffs {
  // clScale < 1 for sails that can't hold their designed shape (an asymmetric kite's free-flying luff)
  const clMax = (0.9 + 4.5 * s.depth) * (s.clScale ?? 1);
  const aOpt = (12 + 70 * s.depth) * DEG;
  const flap = smoothstep(0, s.luffTol, a);
  const x = Math.min(a / aOpt, 1);
  const clPre = clMax * Math.sin((Math.PI / 2) * x) * (0.25 + 0.75 * flap);
  const cdPre = s.cd0 + 0.6 * s.depth * s.depth + (1 - flap) * 0.08 + (clPre * clPre) / (Math.PI * s.ar);
  const w = smoothstep(aOpt, aOpt + 30 * DEG, a);
  const sn = Math.sin(a);
  const cn = 1.4;
  const clFp = 0.5 * cn * Math.abs(Math.sin(2 * a));
  const cdFp = cn * sn * sn + 0.02;
  out.cl = (1 - w) * clPre + w * clFp;
  out.cd = (1 - w) * cdPre + w * cdFp;
  if (backed) {
    // Wind on the wrong side of a soft sail: at small angles the luff just curls and it flogs;
    // only a properly backed sail (large angle, it inverts) pulls like a flat plate.
    const inv = smoothstep(15 * DEG, 35 * DEG, a);
    out.cl *= 0.12 + 0.88 * inv;
    out.cd = Math.max(out.cd, 0.12 * (1 - inv) + out.cd * inv);
  }
  return out;
}

/** Optimum (max-lift) angle of attack for a sail of given depth — used by auto-trim. */
export const sailOptAlpha = (depth: number) => (12 + 70 * depth) * DEG;

/**
 * Lift + drag on a strip of a lifting surface.
 * flow: fluid velocity RELATIVE to the surface. span, chord: unit vectors (chord = LE→TE / luff→leech).
 * Writes force to `f`, returns |α| (radians, 0..π).
 */
export function stripForce(
  flow: number[], span: number[], chord: number[], halfRhoA: number,
  coeffFn: (a: number, out: Coeffs, backed: boolean) => Coeffs, tmp: Coeffs, f: number[],
  camberSide?: number[],
): number {
  // flow component perpendicular to the span
  const fs = flow[0] * span[0] + flow[1] * span[1] + flow[2] * span[2];
  const ux = flow[0] - fs * span[0], uy = flow[1] - fs * span[1], uz = flow[2] - fs * span[2];
  const speed = Math.hypot(ux, uy, uz);
  f[0] = f[1] = f[2] = 0;
  if (speed < 1e-5) return 0;
  // chord perpendicular to span, and surface normal
  const cs = chord[0] * span[0] + chord[1] * span[1] + chord[2] * span[2];
  let cx = chord[0] - cs * span[0], cy = chord[1] - cs * span[1], cz = chord[2] - cs * span[2];
  const cl = Math.hypot(cx, cy, cz) || 1;
  cx /= cl; cy /= cl; cz /= cl;
  const nx = cy * span[2] - cz * span[1];
  const ny = cz * span[0] - cx * span[2];
  const nz = cx * span[1] - cy * span[0];
  const un = ux * nx + uy * ny + uz * nz;
  const uc = ux * cx + uy * cy + uz * cz;
  const a = Math.atan2(Math.abs(un), uc);
  // backed = flow pushing the surface against its camber side (soft sails only care)
  const backed = camberSide ? (un >= 0 ? 1 : -1) * (nx * camberSide[0] + ny * camberSide[1] + nz * camberSide[2]) < 0 : false;
  coeffFn(a, tmp, backed);
  const vx = ux / speed, vy = uy / speed, vz = uz / speed;
  // lift ⟂ flow, towards the side the flow pushes the surface
  const sg = un >= 0 ? 1 : -1;
  const d = sg * (nx * vx + ny * vy + nz * vz);
  let lx = sg * nx - d * vx, ly = sg * ny - d * vy, lz = sg * nz - d * vz;
  const ll = Math.hypot(lx, ly, lz);
  if (ll > 1e-9) { lx /= ll; ly /= ll; lz /= ll; } else { lx = ly = lz = 0; }
  const q = halfRhoA * speed * speed;
  f[0] = q * (tmp.cl * lx + tmp.cd * vx);
  f[1] = q * (tmp.cl * ly + tmp.cd * vy);
  f[2] = q * (tmp.cl * lz + tmp.cd * vz);
  return a;
}
