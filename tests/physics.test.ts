import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/physics/sim';
import { defaultParams, type SimParams } from '../src/physics/params';
import { airDensity, tideState, waterDensity } from '../src/physics/environment';
import { WaveField, fetchLimitedSea, solveK } from '../src/physics/waves';
import { G, KN, wrap180, wrap360 } from '../src/physics/math';
import { pointOfSail, tackName } from '../src/physics/pointsOfSail';

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

describe('control lines', () => {
  const shape = (mod: (c: SimParams['controls']) => void) => {
    const p = defaultParams();
    mod(p.controls);
    const sim = new Simulation(p);
    sim.boat.updateSailShapes(p.controls);
    const m = sim.boat.main, j = sim.boat.jib;
    return { mainTwist: m.twistDeg, footDepth: m.depths[0], topDepth: m.depths[5], mainLimit: m.sheetLimit, jibDepth: j.depths[0], jibTwist: j.twistDeg, jibLimit: j.sheetLimit, jibLuffTol: j.luffTol, mainLuffTol: m.luffTol };
  };
  it('kicker holds the leech when the mainsheet is eased', () => {
    const off = shape((c) => { c.mainsheet = 0.4; c.kicker = 0; });
    const on = shape((c) => { c.mainsheet = 0.4; c.kicker = 1; });
    expect(on.mainTwist).toBeLessThan(off.mainTwist - 10);
  });
  it('kicker bends the mast and flattens the top', () => {
    const off = shape((c) => { c.kicker = 0; c.mainsheet = 1; });
    const on = shape((c) => { c.kicker = 1; c.mainsheet = 1; });
    expect(on.topDepth).toBeLessThan(off.topDepth);
  });
  it('outhaul flattens the foot much more than the head', () => {
    const off = shape((c) => { c.outhaul = 0; });
    const on = shape((c) => { c.outhaul = 1; });
    expect(off.footDepth - on.footDepth).toBeGreaterThan(0.04);
    expect(off.topDepth - on.topDepth).toBeLessThan(0.005);
  });
  it('downhaul flattens, opens the top and widens the groove', () => {
    const off = shape((c) => { c.downhaul = 0; });
    const on = shape((c) => { c.downhaul = 1; });
    expect(on.footDepth).toBeLessThan(off.footDepth);
    expect(on.mainTwist).toBeGreaterThan(off.mainTwist);
    expect(on.mainLuffTol).toBeLessThan(off.mainLuffTol);
  });
  it('barber hauler brings the jib lead in and firms the leech', () => {
    const off = shape((c) => { c.barberHauler = 0; c.jibSheet = 1; });
    const on = shape((c) => { c.barberHauler = 1; c.jibSheet = 1; });
    expect(on.jibLimit).toBeLessThan(off.jibLimit);
    expect(on.jibTwist).toBeLessThan(off.jibTwist);
  });
  it('short bridle: less twist two-blocked, but the boom can\'t reach the centreline', () => {
    const short = shape((c) => { c.bridleLengthM = 0.93; c.mainsheet = 1; c.kicker = 0; });
    const long = shape((c) => { c.bridleLengthM = 1.5; c.mainsheet = 1; c.kicker = 0; });
    expect(short.mainTwist).toBeLessThan(long.mainTwist);
    expect(short.mainLimit).toBeGreaterThan(long.mainLimit);
  });
  it('forestay tension flattens the jib and narrows its groove', () => {
    const slack = shape((c) => { c.forestayTension = 0; });
    const tight = shape((c) => { c.forestayTension = 1; });
    expect(tight.jibDepth).toBeLessThan(slack.jibDepth);
    expect(tight.jibLuffTol).toBeGreaterThan(slack.jibLuffTol);
  });
  it('de-powering with the lines reduces heel in a blow', () => {
    const run = (flat: boolean) => {
      const p = calm((p) => {
        p.wind.speedKn = 17; p.controls.autopilot = true; p.controls.autoHike = false;
        p.controls.crewOut = 1; p.controls.helmOut = 1; p.controls.mainsheet = 0.95; p.controls.jibSheet = 0.95;
        Object.assign(p.controls, flat
          ? { kicker: 1, downhaul: 1, outhaul: 1, forestayTension: 1 }
          : { kicker: 0, downhaul: 0, outhaul: 0, forestayTension: 0 });
      });
      const sim = sail(p, 50, 10);
      let heel = 0;
      for (let i = 0; i < 20; i++) { sim.run(0.5); heel += -sim.boat.tel.heelDeg * sim.boat.side; }
      return heel / 20;
    };
    expect(run(true)).toBeLessThan(run(false));
  });
});

describe('points of sail', () => {
  it('names follow the RYA wheel', () => {
    expect(pointOfSail(20, false).name).toBe('No-go zone');
    expect(pointOfSail(-45, false).name).toBe('Close hauled');
    expect(pointOfSail(65, false).name).toBe('Close reach');
    expect(pointOfSail(90, false).name).toBe('Beam reach');
    expect(pointOfSail(-130, false).name).toBe('Broad reach');
    expect(pointOfSail(160, false).name).toBe('Training run');
    expect(pointOfSail(178, false).name).toBe('Run');
    expect(pointOfSail(170, true).name).toBe('By the lee');
  });
  it('tack is named from the side the wind comes over (boom opposite)', () => {
    expect(tackName(-0.5)).toBe('Starboard tack');
    expect(tackName(0.5)).toBe('Port tack');
  });
  it('wind comes from true north by default', () => {
    expect(defaultParams().wind.fromDeg).toBe(0);
  });
});

describe('centres', () => {
  it('at rest, G and B line up vertically (GZ ≈ 0) even when the crew heel it', () => {
    const p = calm((p) => { p.wind.speedKn = 0; p.waves.autoFromWind = false; p.waves.heightM = 0; p.controls.autoHike = false; p.controls.side = 'starboard'; p.controls.crewOut = 0.3; p.controls.helmOut = 0; });
    const sim = new Simulation(p);
    sim.reset(0, 0);
    sim.run(15);
    const c = sim.boat.centres;
    expect(sim.boat.tel.heelDeg).toBeGreaterThan(3);
    expect(Math.abs(c.gzM)).toBeLessThan(0.02);
    expect(c.meta).not.toBeNull();
    expect(c.meta![1]).toBeGreaterThan(c.cg[1]); // M above G: stable
  });
  it('sailing upwind: crew out gives a real righting lever; CE sits over the CLR when balanced', () => {
    const p = calm((p) => { p.controls.autopilot = true; p.controls.autoTrim = true; });
    const sim = sail(p, 45, 30);
    const c = sim.boat.centres;
    expect(c.gzM).toBeGreaterThan(0.3);
    expect(c.rightingNm).toBeGreaterThan(500);
    expect(c.ce).not.toBeNull();
    expect(c.clr).not.toBeNull();
    expect(Math.abs(c.leadM)).toBeLessThan(0.4); // dynamic: balanced → small rudder → CE ≈ over CLR
    expect(c.geoLeadM).toBeGreaterThan(0); // designer's lead: CE drawn ahead of CLR
    expect(c.geoLeadM).toBeLessThan(0.8);
  });
});

describe('trim-mode autopilot', () => {
  it('holds a true wind angle through a wind shift', () => {
    const p = calm((p) => { p.controls.autopilot = true; p.controls.autopilotMode = 'twa'; p.controls.autopilotTwaDeg = 90; p.controls.autoTrim = true; });
    const sim = new Simulation(p);
    sim.reset(wrap360(p.wind.fromDeg - 90), 3);
    sim.run(15);
    expect(Math.abs(sim.boat.tel.twaDeg - 90)).toBeLessThan(8);
    p.wind.fromDeg = 30; // 30° veer
    sim.run(20);
    expect(Math.abs(sim.boat.tel.twaDeg - 90)).toBeLessThan(8);
    expect(Math.abs(wrap180(sim.boat.tel.headingDeg - 300))).toBeLessThan(10);
  });
});
