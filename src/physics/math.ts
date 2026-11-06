// Shared constants and small helpers. No DOM, no three.js scene code — safe to run in Node.

export const KN = 0.514444; // m/s per knot
export const DEG = Math.PI / 180;
export const G = 9.80665;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Wrap an angle in degrees to (-180, 180]. */
export function wrap180(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}
export const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * World frame: x = east, y = up, z = south (so north = -z). Right-handed, three.js style.
 * Returns the horizontal unit vector pointing TOWARDS compass bearing `deg`.
 */
export function towards(deg: number): { x: number; z: number } {
  const r = deg * DEG;
  return { x: Math.sin(r), z: -Math.cos(r) };
}

/** Compass bearing (0..360) that a horizontal world vector points towards. */
export function bearingOf(x: number, z: number): number {
  return wrap360(Math.atan2(x, -z) / DEG);
}

/** Piecewise-linear lookup in a sorted [x, y] table (clamped at the ends). */
export function interp(table: ReadonlyArray<readonly [number, number]>, x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** Deterministic PRNG so waves/gusts are reproducible for a given seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approx. standard normal from a uniform PRNG (Box–Muller). */
export function gaussian(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-9);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
