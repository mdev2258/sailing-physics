import GUI from 'lil-gui';
import type { Simulation } from '../physics/sim';
import { BRIDLE } from '../physics/boat';
import { pointOfSail } from '../physics/pointsOfSail';

/**
 * Trim mode: the boat steers itself at a chosen angle to the true wind and the crew hike
 * themselves, so all your attention goes on the sails. Only sail controls are shown, plus a
 * "best so far at this angle" score so you can tell whether a change actually helped.
 */
export class TrimMode {
  active = false;
  gui: GUI;
  private stats: HTMLElement;
  private saved: Record<string, unknown> = {};
  private ui = { twa: 45, tack: 'starboard' as 'starboard' | 'port' };
  private stwAvg = 0;
  private vmgAvg = 0;
  private best = new Map<string, { stw: number; vmg: number }>();

  constructor(private sim: Simulation, private onToggle: (on: boolean) => void) {
    const c = sim.params.controls;
    const gui = new GUI({ title: 'Sail trim mode', width: 300 });
    const L = (x: ReturnType<GUI['add']>) => x.decimals(2).listen();
    gui.add({ exit: () => this.toggle(false) }, 'exit').name('← Back to full sim (L)');

    const pos = gui.addFolder('Point of sail (the boat steers itself)');
    pos.add(this.ui, 'twa', 35, 180, 1).name('True wind angle °').onChange(() => this.applyTwa()).listen();
    pos.add(this.ui, 'tack', ['starboard', 'port']).name('Tack').onChange(() => this.applyTwa()).listen();
    const presets: Array<[string, number]> = [['Close hauled', 43], ['Close reach', 65], ['Beam reach', 90], ['Broad reach', 130], ['Run', 175]];
    for (const [name, a] of presets) pos.add({ go: () => { this.ui.twa = a; this.applyTwa(); } }, 'go').name(`${name} (${a}°)`);
    pos.add(sim.params.wind, 'speedKn', 0, 30, 0.5).name('True wind (kn)').listen();
    pos.add(sim.params.wind, 'gustiness', 0, 1, 0.01).name('Gustiness');

    const sheets = gui.addFolder('Sheets');
    L(sheets.add(c, 'mainsheet', 0, 1, 0.01).name('Mainsheet  W/S'));
    L(sheets.add(c, 'jibSheet', 0, 1, 0.01).name('Jib sheet  Q/A'));
    sheets.add(c, 'gennakerHoisted').name('Gennaker hoisted (G)').listen();
    L(sheets.add(c, 'gennakerSheet', 0, 1, 0.01).name('Gennaker sheet  E/D'));

    const lines = gui.addFolder('Control lines');
    L(lines.add(c, 'downhaul', 0, 1, 0.01).name('Downhaul (cunningham)'));
    L(lines.add(c, 'kicker', 0, 1, 0.01).name('Kicker'));
    L(lines.add(c, 'outhaul', 0, 1, 0.01).name('Outhaul'));
    L(lines.add(c, 'barberHauler', 0, 1, 0.01).name('Jib barber hauler'));
    L(lines.add(c, 'bridleLengthM', BRIDLE.minLength, BRIDLE.maxLength, 0.01).name('Mainsheet bridle (m)'));
    L(lines.add(c, 'forestayTension', 0, 1, 0.01).name('Forestay / rig tension'));

    const boat = gui.addFolder('Boat');
    L(boat.add(c, 'boardDown', 0, 1, 0.01).name('Daggerboard down'));
    boat.add(c, 'autoHike').name('Crew hike for me').listen();
    boat.add(c, 'heelTargetDeg', 0, 20, 0.5).name('Heel target (°)');
    boat.add({ reset: () => this.resetBest() }, 'reset').name('Reset best speeds');

    gui.hide();
    this.gui = gui;
    this.stats = document.createElement('div');
    this.stats.id = 'trimstats';
    this.stats.hidden = true;
    document.body.appendChild(this.stats);
  }

  private applyTwa() {
    const c = this.sim.params.controls;
    c.autopilotTwaDeg = (this.ui.tack === 'starboard' ? 1 : -1) * this.ui.twa;
  }

  private resetBest() { this.best.clear(); }

  nudgeTwa(deg: number) {
    this.ui.twa = Math.min(180, Math.max(35, this.ui.twa + deg));
    this.applyTwa();
  }

  switchTack() {
    this.ui.tack = this.ui.tack === 'starboard' ? 'port' : 'starboard';
    this.applyTwa();
  }

  toggle(on = !this.active) {
    if (on === this.active) return;
    const c = this.sim.params.controls;
    if (on) {
      this.saved = { autopilot: c.autopilot, autopilotMode: c.autopilotMode, autoTrim: c.autoTrim, autoHike: c.autoHike };
      const twa = this.sim.boat.tel.twaDeg;
      this.ui.tack = twa >= 0 ? 'starboard' : 'port';
      this.ui.twa = Math.max(35, Math.round(Math.abs(twa)));
      this.applyTwa();
      c.autopilot = true; c.autopilotMode = 'twa'; c.autoTrim = false; c.autoHike = true;
    } else {
      Object.assign(c, this.saved);
      c.autopilotHeadingDeg = Math.round(this.sim.boat.tel.headingDeg);
    }
    this.active = on;
    this.stats.hidden = !on;
    if (on) this.gui.show(); else this.gui.hide();
    this.onToggle(on);
  }

  /** Smoothed speed and VMG, and the best seen at this angle in this wind. */
  update(dt: number) {
    if (!this.active) return;
    const t = this.sim.boat.tel;
    const k = Math.min(1, dt / 2);
    this.stwAvg += (t.stwKn - this.stwAvg) * k;
    this.vmgAvg += (Math.abs(t.vmgKn) - this.vmgAvg) * k;
    const key = `${Math.round(this.ui.twa / 5) * 5}|${this.sim.params.wind.speedKn}|${this.sim.params.controls.gennakerHoisted}`;
    const b = this.best.get(key) ?? { stw: 0, vmg: 0 };
    if (this.sim.t > 3) { b.stw = Math.max(b.stw, this.stwAvg); b.vmg = Math.max(b.vmg, this.vmgAvg); }
    this.best.set(key, b);
    const name = pointOfSail(t.twaDeg, false).name;
    const useVmg = this.ui.twa < 70 || this.ui.twa > 120;
    const now = useVmg ? this.vmgAvg : this.stwAvg, top = useVmg ? b.vmg : b.stw;
    const pct = top > 0 ? Math.round((now / top) * 100) : 0;
    this.stats.innerHTML =
      `<div class="ts-title">${name} · TWA ${Math.round(Math.abs(t.twaDeg))}° · ${this.sim.params.wind.speedKn} kn</div>` +
      `<div class="ts-row"><span>${useVmg ? 'VMG' : 'Speed'}</span><b>${now.toFixed(2)} kn</b></div>` +
      `<div class="ts-row"><span>Best at this angle</span><b>${top > 0 ? `${top.toFixed(2)} kn` : '–'}</b></div>` +
      `<div class="ts-bar"><i style="width:${Math.min(100, pct)}%"></i></div>` +
      `<div class="ts-hint">${useVmg ? 'Upwind/downwind: VMG is what counts.' : 'Reaching: raw speed is what counts.'} Speeds are 2-second averages.</div>`;
  }
}
