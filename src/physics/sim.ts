import { Boat } from './boat';
import { Environment } from './environment';
import { applyAssists, newAssistState, type AssistState } from './assist';
import { defaultParams, type SimParams } from './params';
import { wrap360 } from './math';

/** Fixed-timestep simulation: environment + boat + assists. Pure — runs in the browser or Node. */
export class Simulation {
  env: Environment;
  boat: Boat;
  t = 0;
  readonly dt = 1 / 200;
  assist: AssistState = newAssistState();
  private acc = 0;
  private steps = 0;

  constructor(public params: SimParams = defaultParams()) {
    this.env = new Environment(params);
    this.boat = new Boat(params.setup);
    this.reset();
  }

  /** Restart at the origin. Default heading: starboard tack, 60° off the true wind. */
  reset(headingDeg = wrap360(this.params.wind.fromDeg - 60), speedMs = 2) {
    this.t = 0;
    this.acc = 0;
    this.steps = 0;
    this.assist = newAssistState();
    this.env.update(this.params, 0, 0, 0, true);
    this.boat.reset(this.env, headingDeg, 0, 0, this.params.controls, speedMs);
    this.params.controls.autopilotHeadingDeg = Math.round(headingDeg);
  }

  rightBoat() {
    this.boat.rightBoat(this.env, this.t, this.params.controls);
  }

  step() {
    if (this.steps % 20 === 0) this.env.update(this.params, this.t, this.boat.pos.x, this.boat.pos.z);
    applyAssists(this.boat, this.assist, this.params.controls, this.dt);
    // auto-right: after a few seconds in the water, the crew have it back up
    const c = this.params.controls;
    if (c.autoRight && this.boat.tel.capsized) {
      this.assist.capsizedFor += this.dt;
      if (this.assist.capsizedFor > 4) { this.rightBoat(); this.assist.capsizedFor = 0; }
    } else this.assist.capsizedFor = 0;
    this.boat.step(this.dt, this.t, this.env, this.params.controls);
    this.t += this.dt;
    this.steps++;
  }

  /** Advance by wall-clock `realDt` seconds × `timeScale`; returns steps taken. */
  advance(realDt: number, timeScale = 1, maxSteps = 2000): number {
    this.acc += Math.min(realDt, 0.1) * timeScale;
    let n = 0;
    while (this.acc >= this.dt && n < maxSteps) {
      this.step();
      this.acc -= this.dt;
      n++;
    }
    if (n >= maxSteps) this.acc = 0; // can't keep up: drop time rather than spiral
    return n;
  }

  run(seconds: number) {
    const n = Math.round(seconds / this.dt);
    for (let i = 0; i < n; i++) this.step();
  }
}
