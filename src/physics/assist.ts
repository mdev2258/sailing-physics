import { DEG, clamp, wrap180 } from './math';
import { sailOptAlpha } from './coeffs';
import type { Boat } from './boat';
import type { ControlParams } from './params';

/**
 * Optional crew brains. They only move the same control variables a person would —
 * no forces are faked. Turn them off in the UI to sail it all yourself.
 */
export interface AssistState {
  hikeI: number; // integral part of the hiking demand
  trim: [number, number, number]; // sheet set-points from the angle-of-attack loop (main, jib, kite)
  depower: number; // smoothed proportional ease when overpowered
  hadTrim: boolean;
  gybing: number; // seconds left of "grab the falls and throw the boom across"
  tacking: number; // seconds left of an assisted tack/gybe (the no-go guard stands aside)
  capsizedFor: number; // seconds spent capsized (for auto-right)
}

export function newAssistState(): AssistState {
  return { hikeI: 0, trim: [0.85, 0.85, 0.5], depower: 0, hadTrim: false, gybing: 0, tacking: 0, capsizedFor: 0 };
}

export function applyAssists(boat: Boat, st: AssistState, c: ControlParams, dt: number) {
  const tel = boat.tel;
  if (!tel) return;
  const heelLee = -tel.heelDeg * boat.side; // + = heeled to leeward
  const heelRate = (-boat.omega.x * boat.side) / DEG;
  const err = heelLee - c.heelTargetDeg;

  if (c.autoTrim) {
    if (!st.hadTrim) st.trim = [c.mainsheet, c.jibSheet, c.gennakerSheet];
    // 1) slow loop: hold each sail just below its max-lift angle of attack
    const loop = (i: 0 | 1 | 2, alphaMid: number, depth: number) => {
      const target = sailOptAlpha(depth) * 0.8;
      st.trim[i] = clamp(st.trim[i] - 0.02 * ((alphaMid - target) / DEG) * dt, 0, 1);
    };
    loop(0, boat.main.alphaMid, boat.main.depths[3]);
    loop(1, boat.jib.alphaMid, boat.jib.depths[2]);
    if (boat.genHoist > 0.9) loop(2, boat.gennaker.alphaMid, boat.gennaker.depths[3]);
    // 2) fast proportional ease when overpowered (heel well past target), smoothed like a hand on the sheet
    const over = Math.max(0, err - 4 + 0.3 * heelRate);
    st.depower += (clamp(0.035 * over, 0, 0.9) - st.depower) * Math.min(1, 4 * dt);
    c.mainsheet = clamp(st.trim[0] - st.depower, 0, 1);
    // By the lee (boom on the windward side, wind well aft): pull the boom across, as a crew would.
    const byTheLee = Math.abs(tel.awaDeg) > 150 && Math.sign(tel.awaDeg) === Math.sign(boat.main.angle);
    if (byTheLee && st.gybing <= 0) st.gybing = 2.5;
    if (st.gybing > 0) {
      st.gybing -= dt;
      c.mainsheet = 1;
      if (Math.sign(tel.awaDeg) !== Math.sign(boat.main.angle) && Math.abs(boat.main.angle) > 10 * DEG) st.gybing = 0;
    }
    c.jibSheet = clamp(st.trim[1] - 0.3 * st.depower, 0, 1);
    c.gennakerSheet = clamp(st.trim[2] - (boat.genHoist > 0.5 ? 0.8 * st.depower : 0), 0, 1);
  }
  st.hadTrim = c.autoTrim;

  if (c.autoHike && !tel.capsized) {
    // PI + rate damping on heel. D ∈ [−1, 1]: −1 = both in to leeward … +1 = crew flat out, helm full hike.
    st.hikeI = clamp(st.hikeI + 0.015 * err * dt, -0.6, 1);
    const D = clamp(st.hikeI + 0.05 * err + 0.035 * heelRate, -1, 1);
    if (D < 0) {
      c.crewOut = 0.5 + D;
      c.helmOut = 0.5 + 0.5 * D;
    } else {
      c.crewOut = 0.5 + 0.5 * Math.min(1, D / 0.6);
      c.helmOut = 0.5 + 0.5 * clamp((D - 0.4) / 0.6, 0, 1);
    }
    // fore/aft: weight forward in light air, back when planing
    const aft = -0.7 * clamp((tel.fn - 0.45) / 0.35, 0, 1) + 0.25 * clamp((0.3 - tel.fn) / 0.2, 0, 1);
    c.crewFwd = aft;
    c.helmFwd = aft * 0.8;
  }

  // No-go guard: don't let the course be set inside ~40° of the wind (pinching into irons) unless tacking.
  st.tacking = Math.max(0, st.tacking - dt);
  if (c.noGoGuard && c.autopilot && c.autopilotMode === 'heading' && st.tacking <= 0) {
    const twaT = wrap180(tel.twdDeg - c.autopilotHeadingDeg);
    if (Math.abs(twaT) < NO_GO_DEG) {
      const sd = Math.sign(tel.twaDeg) || 1;
      c.autopilotHeadingDeg = ((tel.twdDeg - sd * NO_GO_DEG) % 360 + 360) % 360;
    }
  }

  if (c.autopilot && !tel.capsized) {
    // TWA mode steers to an angle off the true wind, following shifts like a helm would
    const target = c.autopilotMode === 'twa' ? tel.twdDeg - c.autopilotTwaDeg : c.autopilotHeadingDeg;
    const e = wrap180(target - tel.headingDeg);
    c.rudderDeg = clamp(1.2 * e - 0.8 * tel.yawRateDegS, -30, 30);
  }
}

/** Closest the no-go guard lets you point (true wind angle, degrees). */
export const NO_GO_DEG = 40;

/** Tack (or gybe) onto the mirror-image wind angle; the autopilot steers it, the guard stands aside. */
export function requestTack(boat: Boat, st: AssistState, c: ControlParams) {
  const t = boat.tel;
  const twa = Math.abs(t.twaDeg) < NO_GO_DEG ? NO_GO_DEG * (Math.sign(t.twaDeg) || 1) : t.twaDeg;
  c.autopilot = true;
  c.autopilotMode = 'heading';
  c.autopilotHeadingDeg = (((t.headingDeg + 2 * twa) % 360) + 360) % 360;
  st.tacking = 7;
}
