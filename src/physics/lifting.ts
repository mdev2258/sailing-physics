import type { SectionOut } from './sections';
import { newSectionOut } from './sections';
import { VortexSystem, WAGNER, solveDense } from './vortex';

/**
 * A set of lifting strips (all the sails, or both foils) solved together.
 *
 * Each strip is a horseshoe vortex with its control point at 3/4 chord (Weissinger's extended lifting
 * line). Every step:
 *
 *  1. Flow at each control point = onset flow + what every vortex induces there, less the strip's own
 *     two-dimensional share (the section model already contains that). That gives the angle of attack
 *     the section really works at.
 *  2. Wagner: lift does not follow a change of angle at once. Half comes immediately, the rest as the
 *     shed vortex is left astern, over several chord lengths. Two state variables per strip carry that.
 *  3. The section model turns the lagged angle into lift and drag coefficients (stall, luffing and all).
 *  4. All circulations are corrected together with one Newton step: the strips' influence on each
 *     other goes into a matrix and is solved, rather than left to catch up over later steps. No
 *     numerical lag is left in the answer: any delay you see is Wagner's or the dynamic stall's.
 *  5. Force on each strip = Kutta–Joukowski lift ρ·Γ·V×ds with V taken at the bound vortex (so the
 *     induced flow there tilts the lift back: that is the induced drag) plus section drag.
 */

export interface StripKin { speed: number; alpha: number; un: number; uc: number; cperp: number; v: number[]; n: number[]; kj: number[]; gsign: number }
export const newKin = (): StripKin => ({ speed: 0, alpha: 0, un: 0, uc: 0, cperp: 1, v: [0, 0, 0], n: [0, 0, 1], kj: [0, 0, 0], gsign: 1 });

/**
 * Kinematics of one strip. flow = fluid velocity relative to the surface; span and chord are unit
 * vectors (chord = leading edge → trailing edge), given as arrays with an offset. Fills in the flow
 * speed and direction in the section plane, the angle of attack (0..π), the section normal
 * n = chord × span, the Kutta–Joukowski direction v × span and the sign of circulation that lifts
 * towards the side the flow is pushing.
 */
export function stripKin(fx: number, fy: number, fz: number, span: ArrayLike<number>, so: number, chord: ArrayLike<number>, co: number, k: StripKin): boolean {
  const sx = span[so], sy = span[so + 1], sz = span[so + 2];
  const fs = fx * sx + fy * sy + fz * sz;
  const ux = fx - fs * sx, uy = fy - fs * sy, uz = fz - fs * sz;
  const cs = chord[co] * sx + chord[co + 1] * sy + chord[co + 2] * sz;
  let cx = chord[co] - cs * sx, cy = chord[co + 1] - cs * sy, cz = chord[co + 2] - cs * sz;
  const cl = Math.hypot(cx, cy, cz) || 1;
  k.cperp = cl;
  cx /= cl; cy /= cl; cz /= cl;
  const nx = cy * sz - cz * sy, ny = cz * sx - cx * sz, nz = cx * sy - cy * sx;
  k.n[0] = nx; k.n[1] = ny; k.n[2] = nz;
  const speed = Math.hypot(ux, uy, uz);
  k.speed = speed;
  if (speed < 1e-4) return false;
  const un = ux * nx + uy * ny + uz * nz;
  const uc = ux * cx + uy * cy + uz * cz;
  k.un = un; k.uc = uc;
  k.alpha = Math.atan2(Math.abs(un), uc);
  const vx = ux / speed, vy = uy / speed, vz = uz / speed;
  k.v[0] = vx; k.v[1] = vy; k.v[2] = vz;
  // lift acts along ± (v × span); pick the sign that points to the side the flow pushes the surface
  const kx = vy * sz - vz * sy, ky = vz * sx - vx * sz, kz = vx * sy - vy * sx;
  k.kj[0] = kx; k.kj[1] = ky; k.kj[2] = kz;
  const sg = un >= 0 ? 1 : -1;
  k.gsign = sg * (nx * kx + ny * ky + nz * kz) >= 0 ? 1 : -1;
  return true;
}

/**
 * Section model callback: lift and drag coefficients of strip i at angle `alpha` (0..π), with the flow
 * pushing towards +n (`side` = 1) or −n. `probe` calls are for the lift slope only: don't touch state.
 */
export type SectionFn = (i: number, alpha: number, side: number, speed: number, out: SectionOut, probe: boolean) => void;

export class LiftingSet {
  readonly n: number;
  /** Per strip, set by the owner before solve(). */
  span: Float64Array; // unit span direction (3n)
  chordP: Float64Array; // chord measured square to the span (m)
  ds: Float64Array; // strip length along the span (m)
  area: Float64Array; // strip area that is actually working (m²): hoist, immersion
  live: Float64Array; // same, as a 0..1 factor on the circulation
  vinf: Float64Array; // onset flow at the strip (3n)
  /** Wagner states. */
  x1: Float64Array; x2: Float64Array;
  /** Results. */
  alpha: Float64Array; cl: Float64Array; cd: Float64Array; xcp: Float64Array; luff: Float64Array; fsStatic: Float64Array;
  speed: Float64Array; side: Float64Array;
  /** Effective flow at the control point (what the section sees) and at the bound vortex (3n each). */
  vcp: Float64Array; vb: Float64Array;
  /** Force on each strip (3n, N) in the owner's frame. */
  force: Float64Array;
  private J: Float64Array; private r: Float64Array; private slope: Float64Array; private hsg: Float64Array;
  private relax: Float64Array; private lastRes: Float64Array;
  private kin = newKin();
  private sec = newSectionOut(); private probe = newSectionOut();

  constructor(public sys: VortexSystem) {
    const n = sys.n;
    this.n = n;
    const f = (m: number) => new Float64Array(m);
    this.span = f(3 * n); this.chordP = f(n).fill(1); this.ds = f(n); this.area = f(n); this.live = f(n); this.vinf = f(3 * n);
    this.x1 = f(n); this.x2 = f(n);
    this.alpha = f(n); this.cl = f(n); this.cd = f(n); this.xcp = f(n).fill(0.3); this.luff = f(n); this.fsStatic = f(n).fill(1);
    this.speed = f(n); this.side = f(n).fill(1);
    this.vcp = f(3 * n); this.vb = f(3 * n); this.force = f(3 * n);
    this.J = f(n * n); this.r = f(n); this.slope = f(n); this.hsg = f(n); this.relax = f(n).fill(1); this.lastRes = f(n);
    sys.autoPoints = false;
  }

  reset() { this.x1.fill(0); this.x2.fill(0); this.sys.gamma.fill(0); this.relax.fill(1); this.lastRes.fill(0); }

  solve(dt: number, rho: number, section: SectionFn): void {
    const n = this.n, sys = this.sys, g = sys.gamma, W = sys.W, cdir = sys.chordDir;
    const kin = this.kin, sec = this.sec, pr = this.probe;
    const J = this.J, r = this.r;
    const ind = [0, 0, 0];
    const instant = 1 - WAGNER.A1 - WAGNER.A2;
    J.fill(0);
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      r[i] = 0;
      this.slope[i] = 0;
      J[i * n + i] = 1;
      if (!sys.active[i]) { g[i] = 0; this.x1[i] = this.x2[i] = 0; this.cl[i] = this.cd[i] = this.alpha[i] = 0; continue; }
      const cP = this.chordP[i];
      sys.inducedAt(i, ind);
      // section normal first (geometry only), then the flow with the strip's own 2-D downwash put back
      stripKin(1, 0, 0, this.span, i3, cdir, i3, kin);
      const own = g[i] / (Math.PI * cP);
      const vx = this.vinf[i3] + ind[0] + own * kin.n[0], vy = this.vinf[i3 + 1] + ind[1] + own * kin.n[1], vz = this.vinf[i3 + 2] + ind[2] + own * kin.n[2];
      this.vcp[i3] = vx; this.vcp[i3 + 1] = vy; this.vcp[i3 + 2] = vz;
      if (!stripKin(vx, vy, vz, this.span, i3, cdir, i3, kin)) { r[i] = -g[i]; this.cl[i] = this.cd[i] = 0; continue; }
      const sp = kin.speed;
      // Wagner: the lagged part of the 3/4-chord downwash
      const rate = (2 * Math.max(sp, 0.5)) / cP;
      const e1 = Math.exp(-dt * rate * WAGNER.b1), e2 = Math.exp(-dt * rate * WAGNER.b2);
      this.x1[i] = this.x1[i] * e1 + WAGNER.A1 * kin.un * (1 - e1);
      this.x2[i] = this.x2[i] * e2 + WAGNER.A2 * kin.un * (1 - e2);
      const unE = kin.un * instant + this.x1[i] + this.x2[i];
      const a = Math.atan2(Math.abs(unE), kin.uc);
      const side = unE >= 0 ? 1 : -1;
      section(i, a, side, sp, sec, false);
      this.alpha[i] = a; this.cl[i] = sec.cl; this.cd[i] = sec.cd; this.xcp[i] = sec.xcp; this.luff[i] = sec.luff; this.fsStatic[i] = sec.fs;
      this.speed[i] = sp; this.side[i] = side;
      // which way round the circulation goes for lift towards the pushed side
      const h = kin.n[0] * kin.kj[0] + kin.n[1] * kin.kj[1] + kin.n[2] * kin.kj[2] >= 0 ? 1 : -1;
      const live = this.live[i];
      r[i] = side * h * 0.5 * sp * cP * sec.cl * live - g[i];
      // lift slope at this angle with the separation point held where it is (that IS the slope the flow
      // responds with over one step), for the Newton matrix. Never negative: a falling lift curve is
      // left to the next step rather than allowed to make the system singular.
      if (kin.uc > 0) {
        const da = 0.006;
        section(i, a + da, side, sp, pr, true);
        const hi = pr.cl;
        const lo = Math.max(a - da, 0);
        section(i, lo, side, sp, pr, true);
        // (a soft sail coming out of a luff gains lift far faster than 2π per radian: the true slope has to go in,
        // or neighbouring strips fight each other through their shared trailing vortex)
        const slope = Math.min(Math.max((hi - pr.cl) / (a + da - lo), 0), 60);
        const s = h * 0.5 * instant * cP * live * slope * (kin.uc / sp);
        this.slope[i] = s;
        if (s !== 0) {
          const row = i * n;
          for (let j = 0, k = 3 * row; j < n; j++, k += 3) J[row + j] -= s * (kin.n[0] * W[k] + kin.n[1] * W[k + 1] + kin.n[2] * W[k + 2]);
          J[row + i] -= s / (Math.PI * cP);
        }
      }
    }
    // One Newton step for every circulation at once. A lift curve has corners (the stall, the luff, the
    // flip when a sail is backed) where a full step overshoots and comes straight back; whenever a
    // strip's error changes sign from one step to the next its step is halved, and it grows back while
    // the error keeps its sign. That settles on the answer in a few steps instead of chattering round it.
    const res = this.hsg, om = this.relax, last = this.lastRes;
    res.set(r);
    if (!solveDense(J, r, n)) for (let i = 0; i < n; i++) r[i] = 0.3 * res[i];
    for (let i = 0; i < n; i++) {
      if (!sys.active[i]) { om[i] = 1; last[i] = 0; continue; }
      om[i] = res[i] * last[i] < 0 ? Math.max(0.06, om[i] * 0.5) : Math.min(1, om[i] * 1.2);
      last[i] = res[i];
      const lim = 0.6 * Math.max(this.speed[i], 1) * this.chordP[i] * Math.max(this.live[i], 0.05) + 0.05;
      const d = r[i] * om[i];
      g[i] += Number.isFinite(d) ? Math.max(-lim, Math.min(lim, d)) : 0;
    }
    // forces: lift square to the flow at the bound vortex, drag along it
    const f = this.force;
    for (let i = 0; i < n; i++) {
      const i3 = 3 * i;
      f[i3] = f[i3 + 1] = f[i3 + 2] = 0;
      if (!sys.active[i]) { this.vb[i3] = this.vb[i3 + 1] = this.vb[i3 + 2] = 0; continue; }
      sys.inducedAtBound(i, ind);
      const vx = this.vinf[i3] + ind[0], vy = this.vinf[i3 + 1] + ind[1], vz = this.vinf[i3 + 2] + ind[2];
      this.vb[i3] = vx; this.vb[i3 + 1] = vy; this.vb[i3 + 2] = vz;
      if (!stripKin(vx, vy, vz, this.span, i3, cdir, i3, kin)) continue;
      const sp = kin.speed;
      const lift = rho * g[i] * sp * this.ds[i];
      const drag = 0.5 * rho * sp * sp * this.area[i] * this.cd[i];
      f[i3] = lift * kin.kj[0] + drag * kin.v[0]; f[i3 + 1] = lift * kin.kj[1] + drag * kin.v[1]; f[i3 + 2] = lift * kin.kj[2] + drag * kin.v[2];
    }
  }
}
