import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/physics/sim';
import { applyAssistLevel, defaultParams, type SimParams } from '../src/physics/params';
import { requestTack } from '../src/physics/assist';
import { airDensity, tideState, waterDensity } from '../src/physics/environment';
import { foilSection, newSectionOut, sailSection, sailStallAlpha, sailZeroLift } from '../src/physics/sections';
import { VortexSystem } from '../src/physics/vortex';
import { planingScale, savitskyDynamicCL } from '../src/physics/planing';
import { forceBalance } from '../src/physics/balance';
import { WaveField, fetchLimitedSea, solveK } from '../src/physics/waves';
import { G, KN, wrap180, wrap360 } from '../src/physics/math';
import { pointOfSail, tackName } from '../src/physics/pointsOfSail';
import { Quaternion, Vector3 } from 'three';

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
    expect(Math.abs(wrap180(t.cogDeg - p.tide.floodToDeg))).toBeLessThan(25);
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
    return { mainTwist: m.twistDeg, footDepth: m.depths[0], topDepth: m.depths[m.depths.length - 1], mainLimit: m.sheetLimit, jibDepth: j.depths[0], jibTwist: j.twistDeg, jibLimit: j.sheetLimit, jibLuffTol: j.luffTol, mainLuffTol: m.luffTol };
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
        p.wind.speedKn = 13; p.controls.autopilot = true; p.controls.autoHike = false;
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
    // a few degrees flatter at the same sheet position (in much more wind both are simply pinned on their ear)
    expect(run(true)).toBeLessThan(run(false) - 2);
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

describe('wings, slot and transom', () => {
  it('wings move the hiking rail out: more leverage from the same people', () => {
    const heel = (wings: boolean) => {
      const p = calm((p) => { p.wind.speedKn = 0; p.waves.autoFromWind = false; p.waves.heightM = 0; p.setup.wings = wings;
        p.controls.autoHike = false; p.controls.side = 'starboard'; p.controls.helmOut = 0.5; p.controls.crewOut = 0; });
      const sim = new Simulation(p);
      sim.reset(0, 0);
      sim.run(12);
      return sim.boat.tel.heelDeg;
    };
    const off = heel(false), on = heel(true);
    expect(off).toBeLessThan(40); // a settled heel, not a capsize
    expect(on).toBeGreaterThan(off + 1);
  });
  it('wings pay off in a breeze', () => {
    const vmg = (wings: boolean) => {
      const p = calm((p) => { p.wind.speedKn = 20; p.setup.wings = wings; p.controls.autopilot = true; p.controls.autoTrim = true; });
      const sim = sail(p, 45, 25);
      let v = 0;
      for (let i = 0; i < 20; i++) { sim.run(0.5); v += sim.boat.tel.vmgKn; }
      return v / 20;
    };
    expect(vmg(true)).toBeGreaterThan(vmg(false));
  });
  it('the jib heads the main (slot effect): the main sees a smaller angle of attack', () => {
    const alpha = (jibArea: number) => {
      const p = calm((p) => { p.setup.jibAreaM2 = jibArea; p.controls.autopilot = true; p.controls.mainsheet = 0.95; p.controls.jibSheet = 0.95; });
      const sim = sail(p, 45, 15);
      let a = 0;
      for (let i = 0; i < 10; i++) { sim.run(0.5); a += sim.boat.main.alphaMid; }
      return a / 10;
    };
    expect(alpha(3.9)).toBeLessThan(alpha(1.0));
  });
  it('weight aft in light air drags the transom and costs speed', () => {
    const speed = (aft: boolean) => {
      const p = calm((p) => { p.wind.speedKn = 5; p.controls.autopilot = true; p.controls.autoTrim = true; p.controls.autoHike = false;
        p.controls.crewOut = 0; p.controls.helmOut = 0.3; p.controls.crewFwd = aft ? -0.8 : 0.5; p.controls.helmFwd = aft ? -0.8 : 0.3; });
      const sim = sail(p, 60, 30);
      let v = 0;
      for (let i = 0; i < 20; i++) { sim.run(0.5); v += sim.boat.tel.stwKn; }
      return v / 20;
    };
    expect(speed(false)).toBeGreaterThan(speed(true));
  });
});

describe('stability curve', () => {
  /** GZ at a forced heel, with the boat settled at its floating height (crew on the centreline). */
  function gzCurve(degs: number[]) {
    const p = calm((p) => { p.wind.speedKn = 0; p.waves.autoFromWind = false; p.waves.heightM = 0; p.controls.autoHike = false; p.controls.helmOut = 0; p.controls.crewOut = 0; });
    const sim = new Simulation(p);
    sim.reset(0, 0);
    sim.run(5);
    const b = sim.boat as unknown as { q: Quaternion; pos: Vector3; vel: Vector3; omega: Vector3; mass: number; F: number[]; step: (...a: unknown[]) => void; centres: { gzM: number } };
    const q0 = b.q.clone();
    const fwd = new Vector3(1, 0, 0).applyQuaternion(q0);
    const W = b.mass * G;
    return degs.map((deg) => {
      let lo = -1, hi = 1;
      for (let i = 0; i < 40; i++) {
        const y = (lo + hi) / 2;
        b.q.copy(new Quaternion().setFromAxisAngle(fwd, (deg * Math.PI) / 180).multiply(q0));
        b.pos.y = y; b.vel.set(0, 0, 0); b.omega.set(0, 0, 0);
        b.step(1e-7, 0, sim.env, p.controls);
        if (b.F[1] + W > W) lo = y; else hi = y; // too much buoyancy → float higher
      }
      return b.centres.gzM;
    });
  }
  it('has the classic dinghy shape: stiff at first, peak around 20–30°, vanishing before 80°', () => {
    const degs = [5, 10, 20, 25, 30, 50, 80];
    const gz = Object.fromEntries(gzCurve(degs).map((g, i) => [degs[i], g]));
    expect(gz[5] / Math.sin((5 * Math.PI) / 180)).toBeGreaterThan(0.8); // GM ≳ 0.8 m
    expect(gz[20]).toBeGreaterThan(gz[5]);
    expect(Math.max(gz[20], gz[25], gz[30])).toBeGreaterThan(gz[50]);
    expect(gz[80]).toBeLessThan(0); // past the angle of vanishing stability
  });
});

describe('assists for a friendlier sail', () => {
  const easy = (mod: (p: SimParams) => void = () => {}) => { const p = defaultParams(); applyAssistLevel(p.controls, 'easy'); mod(p); return p; };
  it('no-go guard: aiming straight at the wind holds you close hauled, still moving', () => {
    const p = easy();
    const sim = new Simulation(p);
    sim.reset(300, 3);
    p.controls.autopilot = true; p.controls.autopilotMode = 'heading'; p.controls.autopilotHeadingDeg = p.wind.fromDeg;
    sim.run(20);
    expect(Math.abs(sim.boat.tel.twaDeg)).toBeGreaterThan(35);
    expect(sim.boat.tel.stwKn).toBeGreaterThan(3);
  });
  it('an assisted tack comes out on the other tack with way on', () => {
    const p = easy();
    const sim = new Simulation(p);
    sim.reset(wrap360(p.wind.fromDeg - 45), 4);
    p.controls.autopilot = true; p.controls.autopilotMode = 'heading'; p.controls.autopilotHeadingDeg = wrap360(p.wind.fromDeg - 45);
    sim.run(10);
    const before = Math.sign(sim.boat.tel.twaDeg);
    requestTack(sim.boat, sim.assist, p.controls);
    sim.run(15);
    expect(Math.sign(sim.boat.tel.twaDeg)).toBe(-before);
    expect(sim.boat.tel.stwKn).toBeGreaterThan(3);
  });
  it('auto-right puts a capsized boat back up', () => {
    const p = easy((p) => { p.wind.speedKn = 22; p.controls.autoTrim = false; p.controls.autoHike = false; p.controls.crewOut = 0; p.controls.helmOut = 0; p.controls.mainsheet = 1; p.controls.jibSheet = 1; });
    const sim = new Simulation(p);
    sim.reset(wrap360(p.wind.fromDeg - 90), 3);
    let wentOver = false;
    for (let i = 0; i < 60 && !wentOver; i++) { sim.run(0.5); wentOver = sim.boat.tel.capsized; }
    expect(wentOver).toBe(true);
    // it gets put back up (with the sheets still pinned in 22 kn it may well go straight back over — fair)
    let minHeel = 90;
    for (let i = 0; i < 70; i++) { sim.run(0.1); minHeel = Math.min(minHeel, Math.abs(sim.boat.tel.heelDeg)); }
    expect(minHeel).toBeLessThan(15);
  });
  it('easy mode stays upright sailing every angle in a gusty 18 kn', () => {
    for (const twa of [45, 90, 135]) {
      const p = easy((p) => { p.wind.speedKn = 18; p.wind.gustiness = 0.4; });
      const sim = new Simulation(p);
      const h = wrap360(p.wind.fromDeg - twa);
      sim.reset(h, 3);
      p.controls.autopilot = true; p.controls.autopilotMode = 'heading'; p.controls.autopilotHeadingDeg = h;
      for (let i = 0; i < 60; i++) { sim.run(0.5); expect(sim.boat.tel.capsized).toBe(false); }
    }
  });
});

describe('seakeeping', () => {
  /** Heave amplitude ÷ wave amplitude, sailing upwind into regular waves of wavelength λ. */
  function heaveResponse(lambda: number) {
    const p = calm((p) => { p.controls.autopilot = true; p.controls.autoTrim = true; p.waves.autoFromWind = false; p.waves.heightM = 0; });
    const sim = new Simulation(p);
    const hdg = 315;
    sim.reset(hdg, 4);
    p.controls.autopilotHeadingDeg = hdg;
    const amp = Math.min(0.12, lambda / 30);
    const k = (2 * Math.PI) / lambda;
    const w = Math.sqrt(G * k * Math.tanh(k * sim.env.waves.depth));
    const dir = ((hdg + 180) * Math.PI) / 180;
    const comp = { kx: k * Math.sin(dir), kz: -k * Math.cos(dir), k, omega: w, omegaInt: w, amp, phase: 0, kh: k * sim.env.waves.depth, invSinhKh: 0 };
    const freeze = () => { sim.env.waves.comps = [comp]; };
    freeze(); sim.run(12); freeze();
    let lo = 9, hi = -9;
    for (let i = 0; i < 300; i++) { sim.step(); if (i % 50 === 0) freeze(); lo = Math.min(lo, sim.boat.pos.y); hi = Math.max(hi, sim.boat.pos.y); }
    return (hi - lo) / 2 / amp;
  }
  it('cuts through chop shorter than the boat, rides waves much longer than it', () => {
    expect(heaveResponse(2.5)).toBeLessThan(0.2);
    expect(heaveResponse(4)).toBeLessThan(0.5);
    expect(heaveResponse(14)).toBeGreaterThan(0.7);
  });
});

describe('section models', () => {
  const DEG = Math.PI / 180;
  const o = newSectionOut();
  const main = { depth: 0.12, luffTol: 6 * DEG, cd0: 0.022, luffHold: 0.3 };
  it('a sail section: zero lift below the chord line, peak lift just past the stall angle, bluff-plate drag square-on', () => {
    expect(sailZeroLift(0.12) / DEG).toBeLessThan(-10);
    const a1 = sailStallAlpha(main);
    const cl = (deg: number) => sailSection(deg * DEG, false, main, o).cl;
    expect(cl(a1 / DEG + 2)).toBeGreaterThan(1.4);
    expect(cl(a1 / DEG + 2)).toBeLessThan(1.8);
    expect(cl(35)).toBeLessThan(cl(a1 / DEG + 2) - 0.3); // stalled: less lift…
    expect(sailSection(35 * DEG, false, main, o).cd).toBeGreaterThan(0.4); // …and a lot more drag
    expect(sailSection(90 * DEG, false, main, o).cd).toBeGreaterThan(1.2);
    expect(sailSection(90 * DEG, false, main, o).cl).toBeLessThan(0.05);
  });
  it('a sail luffs below its entry angle: lift collapses and it drags', () => {
    const drawing = { ...sailSection(8 * DEG, false, main, o) };
    const luffing = { ...sailSection(1 * DEG, false, main, o) };
    expect(luffing.cl).toBeLessThan(drawing.cl * 0.45);
    expect(luffing.cd).toBeGreaterThan(drawing.cd);
    expect(luffing.luff).toBeGreaterThan(0.8);
  });
  it('the separation point walks forward from the leech as the angle goes up', () => {
    const fs = [4, 8, 14, 25].map((d) => sailSection(d * DEG, false, main, o).fs);
    expect(fs[0]).toBeGreaterThan(fs[1]);
    expect(fs[1]).toBeGreaterThan(fs[2]);
    expect(fs[2]).toBeGreaterThan(fs[3]);
    expect(fs[0]).toBeGreaterThan(0.75);
    expect(fs[3]).toBeLessThan(0.2);
  });
  it('a foil section: 2π-ish lift slope, stalls near 12°, low drag when attached', () => {
    const f = { clMax: 1.1, thickness: 0.09, cn90: 1.5 };
    const at = (deg: number) => ({ ...foilSection(deg * DEG, 8e5, f, o) });
    expect(at(4).cl / (4 * DEG)).toBeGreaterThan(5.5);
    expect(at(4).cl / (4 * DEG)).toBeLessThan(6.3);
    expect(at(4).cd).toBeLessThan(0.012);
    expect(at(12).cl).toBeGreaterThan(1.0);
    expect(at(20).cl).toBeLessThan(at(12).cl);
    expect(at(20).cd).toBeGreaterThan(0.15);
  });
});

describe('vortex system (lifting line)', () => {
  const DEG = Math.PI / 180;
  /** Flat rectangular wing of the given aspect ratio at 5°, section slope 5.9/rad. Returns CL and induced CD. */
  function wing(n: number, AR: number, kappa = 0, gap = 0) {
    const U = 10, alpha = 5 * DEG, cla = 5.9;
    const sys = new VortexSystem(n);
    for (let i = 0; i < n; i++) {
      const k = 3 * i;
      sys.a[k + 1] = gap + (AR * i) / n; sys.b[k + 1] = gap + (AR * (i + 1)) / n;
      sys.da[k] = 1; sys.db[k] = 1; sys.core2[i] = (0.02 * AR / n) ** 2; sys.kappa[i] = kappa;
    }
    sys.buildInfluence();
    const ind = [0, 0, 0];
    for (let it = 0; it < 500; it++) for (let i = 0; i < n; i++) {
      sys.inducedAt(i, ind);
      sys.gamma[i] += 0.1 * (0.5 * U * cla * (alpha + Math.atan2(ind[2], U + ind[0])) - sys.gamma[i]);
    }
    let lift = 0, drag = 0;
    for (let i = 0; i < n; i++) { sys.inducedAt(i, ind); lift += (sys.gamma[i] * U * AR) / n; drag += (-sys.gamma[i] * ind[2] * AR) / n; }
    const q = 0.5 * U * U * AR;
    return { cl: lift / q, cdi: drag / q, sys };
  }
  it('reproduces Prandtl: lift and induced drag of a rectangular wing of aspect ratio 6', () => {
    const { cl, cdi } = wing(48, 6);
    // lifting-line theory: CL = a0·α / (1 + a0(1+τ)/(π·AR)), τ ≈ 0.17; CDi = CL²(1+δ)/(π·AR), δ ≈ 0.05
    expect(cl).toBeGreaterThan(0.365);
    expect(cl).toBeLessThan(0.39);
    const e = (cl * cl) / (Math.PI * 6 * cdi);
    expect(e).toBeGreaterThan(0.9);
    expect(e).toBeLessThan(1.02);
  });
  it('a wall at the root doubles the effective aspect ratio; a gap gives most of that back', () => {
    const free = wing(24, 3).cl, sealed = wing(24, 3, 1, 0).cl, gapped = wing(24, 3, 1, 0.6).cl, twice = wing(48, 6).cl;
    expect(sealed).toBeGreaterThan(free * 1.12);
    expect(Math.abs(sealed - twice)).toBeLessThan(0.01);
    expect(gapped).toBeLessThan(sealed);
    expect(gapped).toBeGreaterThan(free);
  });
  it('the field it draws is the field it solved: downwash behind the wing, upwash ahead, none far away', () => {
    const { sys } = wing(24, 6);
    const v = [0, 0, 0];
    sys.velocityAt(2, 3, 0, v);
    expect(v[2]).toBeLessThan(-0.05); // lift is +z, so the air behind is pushed −z
    const ahead = [0, 0, 0];
    sys.velocityAt(-2, 3, 0, ahead);
    expect(ahead[2]).toBeGreaterThan(0.01);
    const far = [0, 0, 0];
    sys.velocityAt(-200, 3, 0, far);
    expect(Math.hypot(far[0], far[1], far[2])).toBeLessThan(1e-3);
  });
});

describe('planing', () => {
  it('the strip model is scaled to land on Savitsky for a flat bottom', () => {
    // slender theory: CL(beam²) = (π/4)·k·τ. Savitsky: 0.012·√λ·τ^1.1 less the deadrise correction.
    for (const [tau, lam] of [[3, 2], [4, 1.5], [2.5, 3]]) {
      const slender = (Math.PI / 4) * planingScale(lam, 0) * ((tau * Math.PI) / 180);
      const sav = savitskyDynamicCL(tau, lam, 0);
      expect(slender / sav).toBeGreaterThan(0.85);
      expect(slender / sav).toBeLessThan(1.15);
    }
    expect(planingScale(2, 15)).toBeLessThan(planingScale(2, 0)); // deadrise costs lift
  });
  /** Tow the boat at a fixed speed, free to heave and pitch, crew sat still. */
  function tow(kn: number, crewFwd: number) {
    const p = calm((p) => { p.wind.speedKn = 0; p.waves.autoFromWind = false; p.waves.heightM = 0; p.controls.autoHike = false;
      p.controls.helmOut = 0; p.controls.crewOut = 0; p.controls.helmFwd = crewFwd; p.controls.crewFwd = crewFwd; p.controls.mainsheet = 0; p.controls.jibSheet = 0; });
    const sim = new Simulation(p);
    sim.reset(90, 1);
    const V = kn * KN;
    let R = 0, pitch = 0, lift = 0, n = 0, lo = 99, hi = -99;
    for (let i = 0; i < 200 * 16; i++) {
      sim.boat.vel.x = Math.min(V, 1 + ((V - 1) * i) / 1200); sim.boat.vel.z = 0;
      sim.step();
      if (i < 200 * 12) continue;
      n++;
      for (const it of sim.boat.tel.ledger) if (['friction', 'wave', 'planing', 'hullside', 'transom'].includes(it.id)) R -= it.f[0];
      pitch += sim.boat.tel.pitchDeg; lift += sim.boat.tel.planingLift;
      lo = Math.min(lo, sim.boat.tel.pitchDeg); hi = Math.max(hi, sim.boat.tel.pitchDeg);
    }
    const W = sim.boat.mass * G;
    return { rw: R / n / W, pitch: pitch / n, lift: lift / n / W, swing: hi - lo };
  }
  it('towing tank: a gentle hump, then drag/weight stays near 0.1 to 0.15 once she planes', () => {
    const t4 = tow(4, 0), t7 = tow(7, 0), t12 = tow(12, -0.5), t16 = tow(16, -0.5);
    expect(t4.rw).toBeLessThan(0.04);
    expect(t7.rw).toBeGreaterThan(0.07);
    expect(t7.rw).toBeLessThan(0.14);
    expect(t12.rw).toBeGreaterThan(0.08);
    expect(t12.rw).toBeLessThan(0.15);
    expect(t16.rw).toBeLessThan(0.18);
    expect(t16.rw).toBeLessThan(t7.rw * 1.6); // nowhere near V²: that is what planing buys
    // she squats and lifts her bow climbing the hump, and carries more and more of her weight on dynamic lift
    expect(t7.pitch).toBeGreaterThan(t4.pitch + 0.8);
    expect(t12.lift).toBeGreaterThan(0.25);
    expect(t16.lift).toBeGreaterThan(t12.lift);
    expect(t16.swing).toBeLessThan(1); // and runs steady, no porpoising
  });
  it('weight aft pays once planing', () => {
    expect(tow(13, -0.7).rw).toBeLessThan(tow(13, 0.2).rw);
  });
});

describe('forces add up', () => {
  it('steady sailing: the ledger sums to (almost) nothing, drive = drag and side force = side force', () => {
    const p = calm((p) => { p.controls.autopilot = true; p.controls.autoTrim = true; p.waves.autoFromWind = false; p.waves.heightM = 0; });
    const sim = sail(p, 60, 40);
    const net = [0, 0, 0], aero = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < 400; i++) {
      sim.step();
      n++;
      for (const it of sim.boat.tel.ledger) for (let k = 0; k < 3; k++) { net[k] += it.f[k]; if (it.group === 'aero') aero[k] += it.f[k]; }
    }
    const W = sim.boat.mass * G;
    const sailForce = Math.hypot(aero[0], aero[1], aero[2]) / n;
    expect(sailForce).toBeGreaterThan(200);
    for (let k = 0; k < 3; k++) expect(Math.abs(net[k] / n)).toBeLessThan(0.02 * W);
    // every group is there
    const ids = sim.boat.tel.ledger.map((l) => l.id);
    for (const id of ['w_hull', 'w_helm', 'w_crew', 'buoyancy', 'friction', 'wave', 'board', 'rudder', 'main', 'jib', 'windage']) expect(ids).toContain(id);
  });
  it('the balance sheet: drive ≈ drag, heeling force ≈ side force, heeling moment ≈ righting moment', () => {
    const p = calm((p) => { p.controls.autopilot = true; p.controls.autoTrim = true; p.waves.autoFromWind = false; p.waves.heightM = 0; });
    const sim = sail(p, 55, 40);
    const acc = { drive: 0, drag: 0, heelF: 0, sideF: 0, heelM: 0, rightM: 0, up: 0 };
    const N = 400;
    for (let i = 0; i < N; i++) {
      sim.step();
      const bal = forceBalance(sim.boat);
      acc.drive += bal.aero.f[0]; acc.drag += bal.hydro.f[0]; acc.heelF += bal.aero.f[1]; acc.sideF += bal.hydro.f[1];
      acc.heelM += bal.heelingNm; acc.rightM += bal.rightingNm;
      // rows add up to the net row
      const sum = bal.rows.reduce((s, r) => s + r.f[2], 0);
      expect(Math.abs(sum - bal.net.f[2])).toBeLessThan(1e-6);
      acc.up += bal.net.f[2];
    }
    for (const k of Object.keys(acc) as Array<keyof typeof acc>) acc[k] /= N;
    expect(acc.drive).toBeGreaterThan(100);
    expect(Math.abs(acc.drive + acc.drag)).toBeLessThan(0.12 * acc.drive); // planing drag and windage sit in other rows
    expect(Math.abs(acc.heelF)).toBeGreaterThan(200);
    expect(Math.abs(acc.heelF + acc.sideF)).toBeLessThan(0.12 * Math.abs(acc.heelF));
    expect(Math.abs(acc.heelM)).toBeGreaterThan(800);
    expect(Math.abs(acc.heelM + acc.rightM)).toBeLessThan(0.1 * Math.abs(acc.heelM));
    expect(Math.sign(acc.heelM)).toBe(-Math.sign(acc.rightM));
    expect(Math.abs(acc.up)).toBeLessThan(0.02 * sim.boat.mass * G);
  });
  it('the rudder works in the board\'s downwash: it sees less leeway than the board does', () => {
    const p = calm((p) => { p.controls.autopilot = true; p.controls.autoTrim = true; p.waves.autoFromWind = false; p.waves.heightM = 0; });
    const sim = sail(p, 50, 30);
    const [board, rudder] = sim.boat.foils;
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    // free-stream angle at the rudder vs the effective one after the board's trailing vortices
    const k = rudder.n >> 1;
    const inf = Math.atan2(Math.abs(rudder.flowInf[k][2]), Math.abs(rudder.flowInf[k][0]));
    const eff = Math.atan2(Math.abs(rudder.flow[k][2]), Math.abs(rudder.flow[k][0]));
    expect(mean(board.cl)).toBeGreaterThan(0.1);
    expect(Math.abs(sim.boat.rudder)).toBeLessThan(0.1);
    expect(eff).toBeLessThan(inf * 0.9);
  });
  it('induced drag is real: the rig as a whole drags far more than its sections do', () => {
    const p = calm((p) => { p.controls.autopilot = true; p.controls.autoTrim = true; p.waves.autoFromWind = false; p.waves.heightM = 0; });
    const sim = sail(p, 45, 30);
    const m = sim.boat.main;
    // lift tilted back by the induced flow: effective angle of attack is well below the geometric one
    const k = m.mid;
    const ang = (f: number[]) => Math.atan2(Math.hypot(f[1], f[2]), -f[0]);
    expect(Math.abs(ang(m.flow[k]) - ang(m.flowInf[k]))).toBeGreaterThan(1 * DEG_);
    expect(sim.boat.aero.gamma.some((g) => Math.abs(g) > 1)).toBe(true);
  });
});
const DEG_ = Math.PI / 180;
