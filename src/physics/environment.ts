import { DEG, KN, clamp, mulberry32, towards } from './math';
import type { SimParams, TideParams, WeatherParams, WindParams } from './params';
import { WaveField } from './waves';

// ---------- Weather → fluid properties ----------

/** Moist-air density (ideal gas, Tetens saturation pressure). */
export function airDensity(w: WeatherParams): number {
  const T = w.airTempC + 273.15;
  const psat = 6.1078 * Math.pow(10, (7.5 * w.airTempC) / (w.airTempC + 237.3)); // hPa
  const pv = clamp(w.humidityPct / 100, 0, 1) * psat;
  const pd = w.pressureHPa - pv;
  return (pd * 100) / (287.05 * T) + (pv * 100) / (461.5 * T);
}

/** Water density: fresh-water polynomial (Tilton & Taylor) + linear salinity term. */
export function waterDensity(w: WeatherParams): number {
  const T = w.waterTempC;
  const fresh = 1000 * (1 - ((T + 288.9414) / (508929.2 * (T + 68.12963))) * (T - 3.9863) ** 2);
  return fresh + 0.78 * w.salinityPSU;
}

/** Kinematic viscosity of water (m²/s), used for Reynolds number / skin friction. */
export function waterViscosity(w: WeatherParams): number {
  const T = w.waterTempC;
  return (1.79e-6 / (1 + 0.0337 * T + 0.000221 * T * T)) * (1 + 0.0015 * w.salinityPSU);
}

// ---------- Tide ----------

export interface TideState {
  heightM: number; // height above chart datum
  depthM: number; // water depth at the sailing area
  streamMs: number; // signed: + flood, − ebb
  current: { x: number; z: number }; // world-frame water velocity
  hoursFromHW: number;
}

/** Harmonic semi-diurnal tide. Stream peaks mid-tide, slack at HW/LW (a simplification of real harbours). */
export function tideState(p: TideParams, simTimeS: number): TideState {
  let h = p.hoursFromHW + (p.advanceWithSim ? simTimeS / 3600 : 0);
  const half = p.periodH / 2;
  h = ((((h + half) % p.periodH) + p.periodH) % p.periodH) - half;
  const ph = (2 * Math.PI * h) / p.periodH;
  const heightM = 0.3 + p.rangeM / 2 + (p.rangeM / 2) * Math.cos(ph); // LW sits 0.3 m above CD
  const streamMs = p.maxStreamKn * KN * -Math.sin(ph); // rising (h<0) → flood
  const d = towards(p.floodToDeg);
  return {
    heightM, depthM: Math.max(p.chartDepthM + heightM, 0.05), streamMs,
    current: { x: d.x * streamMs, z: d.z * streamMs }, hoursFromHW: h,
  };
}

// ---------- Wind ----------

export interface GustComponent { kx: number; kz: number; w: number; phi: number }

/**
 * Wind field: power-law gradient, travelling gust patches (advected with the mean wind)
 * and an oscillating direction shift. Returns AIR velocity over the ground.
 */
export class WindField {
  p!: WindParams;
  gusts: GustComponent[] = [];
  meanVel = { x: 0, z: 0 };
  private seedKey = '';

  build(p: WindParams, seed: number) {
    this.p = p;
    const d = towards(p.fromDeg + 180);
    const U = p.speedKn * KN;
    this.meanVel = { x: d.x * U, z: d.z * U };
    const key = `${seed}|${p.gustScaleM}`;
    if (key !== this.seedKey) {
      this.seedKey = key;
      const rnd = mulberry32(seed * 7919 + 13);
      this.gusts = [1, 0.7, 1.45, 0.5].map((f) => {
        const lam = Math.max(5, p.gustScaleM * f);
        const ang = rnd() * Math.PI * 2;
        const k = (2 * Math.PI) / lam;
        return { kx: k * Math.cos(ang), kz: k * Math.sin(ang), w: (2 * Math.PI) / (30 + 40 * rnd()), phi: rnd() * Math.PI * 2 };
      });
    }
  }

  /** Normalised gust field (~unit standard deviation), frozen pattern advected with the mean wind. */
  gust(x: number, z: number, t: number): number {
    let g = 0;
    const ax = x - this.meanVel.x * t;
    const az = z - this.meanVel.z * t;
    for (const c of this.gusts) g += Math.sin(c.kx * ax + c.kz * az + c.w * t + c.phi);
    return g / Math.sqrt(this.gusts.length / 2);
  }

  fromDegAt(x: number, z: number, t: number): number {
    const p = this.p;
    const shift = p.shiftPeriodS > 0 ? p.shiftAmpDeg * Math.sin((2 * Math.PI * t) / p.shiftPeriodS) : 0;
    // gust patches carry a small local direction change too
    const local = 0.35 * p.shiftAmpDeg * Math.sin(0.7 * this.gust(z, x, t * 0.8));
    return p.fromDeg + shift + local;
  }

  /** Air velocity (m/s, world frame) at a point. `y` is height above the mean water level. */
  at(x: number, y: number, z: number, t: number, out: Float64Array | number[]): void {
    const p = this.p;
    const g = this.gust(x, z, t);
    const speed10 = p.speedKn * KN * Math.max(0, 1 + 0.5 * p.gustiness * g);
    const hf = Math.pow(Math.max(y, 0.3) / 10, p.gradientExp);
    const dir = (this.fromDegAt(x, z, t) + 180) * DEG;
    const s = speed10 * hf;
    out[0] = Math.sin(dir) * s;
    out[1] = 0;
    out[2] = -Math.cos(dir) * s;
  }
}

// ---------- Combined environment ----------

export class Environment {
  waves = new WaveField();
  wind = new WindField();
  rhoAir = 1.225;
  rhoWater = 1025;
  nuWater = 1.19e-6;
  tide!: TideState;
  private waveKey = '';

  constructor(params: SimParams) {
    this.update(params, 0, 0, 0, true);
  }

  update(params: SimParams, t: number, refX: number, refZ: number, force = false) {
    this.rhoAir = airDensity(params.weather);
    this.rhoWater = waterDensity(params.weather);
    this.nuWater = waterViscosity(params.weather);
    this.tide = tideState(params.tide, t);
    this.wind.build(params.wind, params.waves.seed);
    // Rebuild the wave spectrum only when something that shapes it changes (rounded so the
    // slowly-varying tide doesn't rebuild every step).
    const w = params.waves;
    const key = JSON.stringify([
      w, w.autoFromWind || w.lockToWind ? [params.wind.speedKn, params.wind.fromDeg] : 0,
      Math.round(this.tide.depthM * 10), Math.round(this.tide.current.x * 20), Math.round(this.tide.current.z * 20),
    ]);
    if (force || key !== this.waveKey) {
      this.waveKey = key;
      this.waves.build(w, params.wind.speedKn, params.wind.fromDeg, this.tide.depthM, this.tide.current, t, refX, refZ);
    }
  }

  /** Water velocity (tidal current + wave orbital) at a point; returns the surface elevation there. */
  water(x: number, y: number, z: number, t: number, out: Float64Array | number[]): number {
    const eta = this.waves.sample(x, y, z, t, out);
    out[0] += this.tide.current.x;
    out[2] += this.tide.current.z;
    return eta;
  }
}
