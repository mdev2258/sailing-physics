import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/physics/sim';
import { defaultParams, type SimParams } from '../src/physics/params';
import { airDensity, tideState, waterDensity } from '../src/physics/environment';
import { WaveField, fetchLimitedSea, solveK } from '../src/physics/waves';
import { G, KN, wrap180, wrap360 } from '../src/physics/math';

/** Calm, steady conditions so each test isolates one effect. */
function calm(mod: (p: SimParams) => void = () => {}): SimParams {
  const p = defaultParams();
  p.wind.gustiness = 0;
  p.wind.shiftAmpDeg = 0;
  p.tide.maxStreamKn = 0;
  p.tide.advanceWithSim = false;
  mod(p);
  return p;
}

function sail(p: SimParams, twa: number, seconds: number, speed = 2) {
  const sim = new Simulation(p);
  const hdg = wrap360(p.wind.fromDeg - twa);
  sim.reset(hdg, speed);
  p.controls.autopilotHeadingDeg = hdg;
  sim.run(seconds);
  return sim;
}

describe('fluid properties', () => {
  it('air density at ISA sea level is 1.225 kg/m³', () => {
    const w = defaultParams().weather;
    expect(airDensity({ ...w, airTempC: 15, pressureHPa: 1013.25, humidityPct: 0 })).toBeCloseTo(1.225, 2);
  });
  it('humid air is lighter than dry air', () => {
    const w = { ...defaultParams().weather, airTempC: 25 };
    expect(airDensity({ ...w, humidityPct: 100 })).toBeLessThan(airDensity({ ...w, humidityPct: 0 }));
  });
  it('sea water ≈ 1026 kg/m³, fresh ≈ 999 kg/m³', () => {
    const w = { ...defaultParams().weather, waterTempC: 15 };
    expect(waterDensity({ ...w, salinityPSU: 35 })).toBeGreaterThan(1024);
    expect(waterDensity({ ...w, salinityPSU: 35 })).toBeLessThan(1028);
    expect(waterDensity({ ...w, salinityPSU: 0 })).toBeCloseTo(999.1, 0);
  });
});

describe('waves', () => {
  it('deep-water dispersion ω² = g k', () => {
    const w = 2 * Math.PI / 3;
    expect(solveK(w, 1000)).toBeCloseTo((w * w) / G, 6);
  });
  it('shallow water slows waves (larger k for the same ω)', () => {
    const w = 2 * Math.PI / 4;
    expect(solveK(w, 1)).toBeGreaterThan(solveK(w, 100));
  });
  it('spectrum reproduces the requested Hs', () => {
    const p = defaultParams().waves;
    const wf = new WaveField();
    wf.build({ ...p, autoFromWind: false, heightM: 0.5, periodS: 3 }, 12, 225, 30, { x: 0, z: 0 });
    expect(wf.hs).toBeGreaterThan(0.45);
    expect(wf.hs).toBeLessThan(0.52);
  });
  it('fetch-limited sea grows with wind and fetch', () => {
    const a = fetchLimitedSea(6, 2000), b = fetchLimitedSea(10, 2000), c = fetchLimitedSea(10, 20000);
    expect(b.hs).toBeGreaterThan(a.hs);
    expect(c.hs).toBeGreaterThan(b.hs);
    expect(c.tp).toBeGreaterThan(b.tp);
  });
});

describe('tide', () => {
  const t = defaultParams().tide;
  it('HW is highest and slack; mid-flood runs at max rate towards the flood direction', () => {
    const hw = tideState({ ...t, hoursFromHW: 0 }, 0);
    const lw = tideState({ ...t, hoursFromHW: -6.21 }, 0);
    const mid = tideState({ ...t, hoursFromHW: -3.1 }, 0);
    expect(hw.heightM - lw.heightM).toBeCloseTo(t.rangeM, 2);
    expect(Math.abs(hw.streamMs)).toBeLessThan(0.01);
    expect(mid.streamMs / KN).toBeCloseTo(t.maxStreamKn, 1);
  });
});

describe('boat statics', () => {
  it('floats upright with displacement equal to all-up mass', () => {
    const p = calm((p) => { p.wind.speedKn = 0; p.waves.autoFromWind = false; p.waves.heightM = 0; p.controls.autoHike = false; p.controls.crewOut = 0; p.controls.helmOut = 0; });
    const sim = new Simulation(p);
    sim.reset(0, 0);
    sim.run(15);
    const m = p.setup.hullMassKg + p.setup.rigMassKg + p.setup.helmMassKg + p.setup.crewMassKg;
    expect(sim.boat.tel.dispKg).toBeGreaterThan(m * 0.97);
    expect(sim.boat.tel.dispKg).toBeLessThan(m * 1.03);
    expect(Math.abs(sim.boat.tel.heelDeg)).toBeLessThan(1);
    expect(Math.abs(sim.boat.vel.y)).toBeLessThan(0.01);
  });
  it('both crew sitting on one side with no wind heels (and floods) a skiff', () => {
    const p = calm((p) => { p.wind.speedKn = 0; p.waves.autoFromWind = false; p.waves.heightM = 0; p.controls.autoHike = false; p.controls.side = 'starboard'; });
    const sim = new Simulation(p);
    sim.reset(0, 0);
    sim.run(10);
    expect(sim.boat.tel.heelDeg).toBeGreaterThan(20); // starboard down
  });
});

describe('sailing', () => {
  it('beats upwind in 12 kn at a plausible speed and leeway', () => {
    const p = calm((p) => { p.controls.autopilot = true; p.controls.autoTrim = true; });
    const sim = sail(p, 45, 40);
    const t = sim.boat.tel;
    expect(t.stwKn).toBeGreaterThan(4.5);
    expect(t.stwKn).toBeLessThan(7.5);
    expect(Math.abs(t.leewayDeg)).toBeLessThan(8);
    expect(t.vmgKn).toBeGreaterThan(3);
    expect(t.capsized).toBe(false);
  });
  it('carries light weather helm: left alone upwind it rounds up', () => {
    const p = calm((p) => { p.controls.autoTrim = true; });
    const sim = sail(p, 45, 25);
    expect(Math.abs(wrap180(sim.boat.tel.twaDeg))).toBeLessThan(45);
  });
  it('positive rudder turns the bow to starboard', () => {
    const p = calm();
    const sim = sail(p, 60, 3, 3);
    const h0 = sim.boat.tel.headingDeg;
    p.controls.rudderDeg = 15;
    sim.run(2);
    expect(wrap180(sim.boat.tel.headingDeg - h0)).toBeGreaterThan(5);
  });
  it('planes on a 16 kn reach', () => {
    const p = calm((p) => { p.wind.speedKn = 16; p.controls.autopilot = true; p.controls.autoTrim = true; });
    const sim = sail(p, 110, 40);
    expect(sim.boat.tel.fn).toBeGreaterThan(0.6);
    expect(sim.boat.tel.planingLift).toBeGreaterThan(0);
  });
  it('the gennaker makes it faster downwind', () => {
    const run = (kite: boolean) => {
      const p = calm((p) => { p.wind.speedKn = 14; p.controls.autopilot = true; p.controls.autoTrim = true; p.controls.gennakerHoisted = kite; p.controls.boardDown = 0.5; });
      return sail(p, 135, 45).boat.tel.stwKn;
    };
    expect(run(true)).toBeGreaterThan(run(false) * 1.1);
  });
  it('capsizes when overpowered with nobody hiking', () => {
    const p = calm((p) => { p.wind.speedKn = 22; p.controls.autoHike = false; p.controls.crewOut = 0; p.controls.helmOut = 0; p.controls.mainsheet = 1; p.controls.jibSheet = 1; });
    const sim = sail(p, 90, 30);
    expect(sim.boat.tel.capsized).toBe(true);
  });
});

describe('tide on the boat', () => {
  it('drifts with the stream over the ground, not through the water', () => {
    const p = calm((p) => {
      p.wind.speedKn = 0; p.waves.autoFromWind = false; p.waves.heightM = 0;
      p.tide.maxStreamKn = 1.5; p.tide.hoursFromHW = -3.1; p.controls.autoHike = false; p.controls.crewOut = 0; p.controls.helmOut = 0;
    });
    const sim = new Simulation(p);
    sim.reset(90, 0);
    sim.run(60);
    const t = sim.boat.tel;
    expect(t.sogKn).toBeGreaterThan(1.0);
    expect(t.sogKn).toBeLessThan(1.6);
    // the drift itself makes a breeze over the flagging sails, which pushes it back through the water a little
    expect(t.stwKn).toBeLessThan(0.6);
    expect(Math.abs(wrap180(t.cogDeg - p.tide.floodToDeg))).toBeLessThan(20);
  });
});

describe('robustness', () => {
  it('stays finite in a 25 kn blow with 1 m sea and swell', () => {
    const p = defaultParams();
    p.wind.speedKn = 25; p.wind.gustiness = 0.6;
    p.waves.autoFromWind = false; p.waves.heightM = 1; p.waves.periodS = 3.5; p.waves.swellHeightM = 0.8;
    p.controls.autoTrim = true;
    const sim = new Simulation(p);
    sim.reset(wrap360(p.wind.fromDeg - 70), 3);
    for (let i = 0; i < 12; i++) {
      sim.run(5);
      if (sim.boat.tel.capsized) sim.rightBoat();
      expect(Number.isFinite(sim.boat.pos.x + sim.boat.pos.y + sim.boat.omega.x)).toBe(true);
    }
  });
});
