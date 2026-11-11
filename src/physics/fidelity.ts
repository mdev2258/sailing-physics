/**
 * How finely the boat is cut up. The physics is the same at every level; only the resolution changes:
 * more strips up each sail and down each foil, more buoyancy cells and skin panels on the hull, more
 * turbulence in the wind, more directions in the wave-resistance integral, a shorter time step.
 * Results converge as you go up (the test suite checks the levels agree to a few per cent).
 */
export type FidelityLevel = 'laptop' | 'pc' | 'max';

export interface Fidelity {
  label: string;
  /** Lifting strips per sail / foil (cosine-spaced: finer towards the ends, where the loading changes fastest). */
  strips: { main: number; jib: number; gennaker: number; board: number; rudder: number };
  /** Buoyancy cells: stations along the hull × layers up it × columns across it. */
  cells: { ns: number; nv: number; nz: number };
  /** Skin panels each side: stations × girth-wise. */
  panels: { ns: number; nt: number };
  /** Fourier modes in the turbulent wind field. */
  windModes: number;
  /** Wave directions in the wave-resistance integral. */
  waveAngles: number;
  /** Steps between rebuilds of the vortex influence matrices, and between wave-resistance evaluations. */
  aeroEvery: number;
  waveEvery: number;
  /** Physics rate (Hz). */
  hz: number;
}

export const FIDELITY: Record<FidelityLevel, Fidelity> = {
  laptop: {
    label: 'Laptop', strips: { main: 12, jib: 8, gennaker: 10, board: 8, rudder: 6 },
    cells: { ns: 20, nv: 5, nz: 10 }, panels: { ns: 20, nt: 5 }, windModes: 24, waveAngles: 28, aeroEvery: 2, waveEvery: 8, hz: 200,
  },
  pc: {
    label: 'PC', strips: { main: 20, jib: 14, gennaker: 16, board: 12, rudder: 9 },
    cells: { ns: 36, nv: 8, nz: 16 }, panels: { ns: 36, nt: 8 }, windModes: 64, waveAngles: 44, aeroEvery: 2, waveEvery: 6, hz: 240,
  },
  max: {
    label: 'Max', strips: { main: 28, jib: 20, gennaker: 22, board: 16, rudder: 12 },
    cells: { ns: 48, nv: 10, nz: 22 }, panels: { ns: 48, nt: 10 }, windModes: 96, waveAngles: 60, aeroEvery: 2, waveEvery: 6, hz: 300,
  },
};

/**
 * Strip spacing along a span, 0..1. Part cosine, part uniform: strips crowd towards both ends, where a
 * lifting line's loading falls away steeply, without the end ones shrinking to nothing.
 */
export function spanSpacing(xi: number): number {
  return 0.35 * xi + 0.65 * 0.5 * (1 - Math.cos(Math.PI * xi));
}
