import { G, KN, clamp, gaussian, mulberry32, towards } from './math';
import type { WaveParams } from './params';

/**
 * Linear (Airy) wave field: a sum of sinusoidal components from a JONSWAP wind-sea
 * spectrum plus an optional narrow-band swell.
 *
 *   η(x,z,t) = Σ aᵢ cos(kᵢ·x − ωᵢ t + φᵢ)
 *
 * Finite-depth dispersion ω² = g k tanh(k h); the tidal stream Doppler-shifts the absolute
 * frequency (ω_abs = ω + k·U) and steepens waves running against it.
 */
export interface WaveComponent {
  kx: number;
  kz: number;
  k: number;
  omega: number; // absolute (ground-frame) angular frequency, used for phase
  omegaInt: number; // intrinsic frequency, used for orbital velocity
  amp: number;
  phase: number;
  kh: number;
  invSinhKh: number;
}

/** Newton solve of ω² = g k tanh(k h). */
export function solveK(omega: number, depth: number): number {
  let k = (omega * omega) / G;
  for (let i = 0; i < 30; i++) {
    const th = Math.tanh(k * depth);
    const f = G * k * th - omega * omega;
    const df = G * th + G * k * depth * (1 - th * th);
    const dk = f / df;
    k -= dk;
    if (Math.abs(dk) < 1e-10 * k) break;
  }
  return k;
}

/** JONSWAP fetch-limited growth (Hasselmann et al. 1973), capped at fully developed (Pierson–Moskowitz). */
export function fetchLimitedSea(windMs: number, fetchM: number): { hs: number; tp: number } {
  const U = Math.max(windMs, 0.5);
  const X = (G * Math.max(fetchM, 10)) / (U * U);
  let hs = (1.6e-3 * Math.sqrt(X) * U * U) / G;
  let fp = ((3.5 * G) / U) * Math.pow(X, -0.33);
  hs = Math.min(hs, (0.243 * U * U) / G);
  fp = Math.max(fp, (0.13 * G) / U);
  return { hs, tp: 1 / fp };
}

function jonswapShape(omega: number, omegaP: number, gamma = 3.3): number {
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaP) ** 2) / (2 * sigma * sigma * omegaP * omegaP));
  return Math.pow(omega, -5) * Math.exp(-1.25 * Math.pow(omegaP / omega, 4)) * Math.pow(gamma, r);
}

export class WaveField {
  comps: WaveComponent[] = [];
  depth = 5;
  hs = 0; // effective significant height after limits
  tp = 0;
  seaFromDeg = 0;

  build(p: WaveParams, windKn: number, windFromDeg: number, depth: number, cur: { x: number; z: number }, t = 0, refX = 0, refZ = 0) {
    const old = this.comps;
    this.depth = Math.max(depth, 0.3);
    const rnd = mulberry32(p.seed);
    let hs = p.heightM;
    let tp = p.periodS;
    if (p.autoFromWind) {
      const s = fetchLimitedSea(windKn * KN, p.fetchKm * 1000);
      hs = s.hs;
      tp = s.tp;
    }
    const from = p.lockToWind ? windFromDeg : p.fromDeg;
    this.seaFromDeg = from;
    const comps: WaveComponent[] = [];

    const addComponent = (omegaInt: number, amp: number, travelDeg: number) => {
      const k = solveK(omegaInt, this.depth);
      const d = towards(travelDeg);
      // Wave–current interaction: Doppler shift + approximate steepening against the stream.
      const ukDot = cur.x * d.x + cur.z * d.z;
      const c = omegaInt / k;
      const steepen = clamp(1 / Math.sqrt(Math.max(0.3, 1 + (2 * ukDot) / c)), 0.6, 1.8);
      const a = Math.min(amp * steepen, 0.3 / k); // keep each component below breaking steepness
      const kh = k * this.depth;
      comps.push({
        kx: k * d.x, kz: k * d.z, k, omegaInt, omega: omegaInt + k * ukDot, amp: a,
        phase: rnd() * Math.PI * 2, kh, invSinhKh: kh < 6 ? 1 / Math.sinh(kh) : 0,
      });
    };

    // Wind-sea: 12 bands from 0.75 ωp to 2.6 ωp, amplitudes normalised to Hs.
    const N = 12;
    if (hs > 0.005 && tp > 0.3) {
      const wp = (2 * Math.PI) / tp;
      const w0 = 0.75 * wp;
      const w1 = 2.6 * wp;
      const dw = (w1 - w0) / N;
      const raw: number[] = [];
      for (let i = 0; i < N; i++) raw.push(Math.sqrt(2 * jonswapShape(w0 + (i + 0.5) * dw, wp) * dw));
      const m0 = raw.reduce((s, a) => s + (a * a) / 2, 0);
      const scale = hs / 4 / Math.sqrt(m0);
      for (let i = 0; i < N; i++) {
        const w = w0 + (i + 0.5) * dw * (0.9 + 0.2 * rnd());
        addComponent(w, raw[i] * scale, from + 180 + 0.6 * p.spreadDeg * gaussian(rnd));
      }
    }
    // Swell: 3 narrow-band components.
    if (p.swellHeightM > 0.005) {
      const a = (p.swellHeightM / 4) * Math.sqrt(2 / 3);
      for (const f of [0.95, 1.0, 1.06]) addComponent((2 * Math.PI) / (p.swellPeriodS * f), a, p.swellFromDeg + 180 + (rnd() - 0.5) * 8);
    }

    // Depth-limited breaking: Hs can't exceed ~0.6 h.
    let m0 = comps.reduce((s, c) => s + (c.amp * c.amp) / 2, 0);
    const hsEff = 4 * Math.sqrt(m0);
    const hsMax = 0.6 * this.depth;
    if (hsEff > hsMax) for (const c of comps) c.amp *= hsMax / hsEff;
    m0 = comps.reduce((s, c) => s + (c.amp * c.amp) / 2, 0);
    this.hs = 4 * Math.sqrt(m0);
    this.tp = tp;

    // Keep phase continuous at the reference point when the field is rebuilt mid-run
    // (tide changes depth/current slowly, so components are rebuilt in the same order).
    if (old.length === comps.length) {
      for (let i = 0; i < comps.length; i++) {
        const o = old[i];
        const n = comps[i];
        const thOld = o.kx * refX + o.kz * refZ - o.omega * t + o.phase;
        n.phase = thOld - (n.kx * refX + n.kz * refZ - n.omega * t);
      }
    }
    this.comps = comps;
  }

  elevation(x: number, z: number, t: number): number {
    let eta = 0;
    for (const c of this.comps) eta += c.amp * Math.cos(c.kx * x + c.kz * z - c.omega * t + c.phase);
    return eta;
  }

  /** Surface elevation at (x,z) and orbital velocity at (x,y,z), written to out[0..2]. */
  sample(x: number, y: number, z: number, t: number, out: Float64Array | number[]): number {
    let eta = 0, vx = 0, vy = 0, vz = 0;
    const yy = Math.min(y, 0);
    const h = this.depth;
    for (const c of this.comps) {
      const th = c.kx * x + c.kz * z - c.omega * t + c.phase;
      const ca = Math.cos(th);
      const sa = Math.sin(th);
      eta += c.amp * ca;
      let fh: number, fv: number;
      if (c.invSinhKh === 0) {
        fh = fv = Math.exp(c.k * yy);
      } else {
        const zz = Math.max(yy + h, 0) * c.k;
        fh = Math.cosh(zz) * c.invSinhKh;
        fv = Math.sinh(zz) * c.invSinhKh;
      }
      const aw = c.amp * c.omegaInt;
      const horiz = (aw * fh * ca) / c.k;
      vx += horiz * c.kx;
      vz += horiz * c.kz;
      vy += aw * fv * sa;
    }
    out[0] = vx;
    out[1] = vy;
    out[2] = vz;
    return eta;
  }
}
