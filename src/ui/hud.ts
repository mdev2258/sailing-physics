import type { Simulation } from '../physics/sim';
import { DEG } from '../physics/math';
import type { SailRuntime } from '../physics/boat';

const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const deg3 = (x: number) => `${Math.round(((x % 360) + 360) % 360).toString().padStart(3, '0')}°`;
const signed = (x: number) => `${x >= 0 ? 'S' : 'P'} ${Math.abs(Math.round(x))}°`;

/** Instrument panel: what a sailor would read off a good GPS + wind instrument, plus the physics. */
export class Hud {
  el: HTMLElement;
  private cells = new Map<string, HTMLElement>();
  private badges: HTMLElement;
  private trim: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'hud';
    const rows: Array<[string, string]> = [
      ['stw', 'Speed thru water'], ['sog', 'Speed over ground'], ['hdg', 'Heading'], ['cog', 'Course over ground'],
      ['vmg', 'VMG to wind'], ['heel', 'Heel'], ['pitch', 'Pitch'], ['lee', 'Leeway'],
      ['tws', 'True wind'], ['twa', 'True wind angle'], ['aws', 'Apparent wind'], ['fn', 'Froude no.'],
      ['tide', 'Tide'], ['stream', 'Stream'], ['sea', 'Sea state'], ['rho', 'ρ air / water'],
      ['main', 'Main shape'], ['jib', 'Jib shape'],
      ['lead', 'CE ahead of CLR'], ['gz', 'Righting lever GZ'],
      ['disp', 'Displacement'], ['wet', 'Wetted area'], ['time', 'Sim time'],
    ];
    this.el.innerHTML = `<div class="big"><span id="hud-stw">–</span><small>kn</small></div><div class="grid"></div><div class="trim"></div><div class="badges"></div>`;
    const grid = this.el.querySelector('.grid') as HTMLElement;
    for (const [k, label] of rows) {
      if (k === 'stw') continue;
      const row = document.createElement('div');
      row.innerHTML = `<span class="l">${label}</span><span class="v" id="hud-${k}">–</span>`;
      row.dataset.k = k;
      grid.appendChild(row);
      this.cells.set(k, row.querySelector('.v') as HTMLElement);
    }
    this.cells.set('stw', this.el.querySelector('#hud-stw') as HTMLElement);
    this.trim = this.el.querySelector('.trim') as HTMLElement;
    this.badges = this.el.querySelector('.badges') as HTMLElement;
    parent.appendChild(this.el);
  }

  update(sim: Simulation, timeScale: number, paused: boolean) {
    const b = sim.boat, t = b.tel, env = sim.env;
    const set = (k: string, v: string) => { const e = this.cells.get(k); if (e) e.textContent = v; };
    set('stw', fmt(t.stwKn));
    set('sog', `${fmt(t.sogKn)} kn`);
    set('hdg', deg3(t.headingDeg));
    set('cog', deg3(t.cogDeg));
    set('vmg', `${fmt(t.vmgKn)} kn`);
    set('heel', `${t.heelDeg >= 0 ? 'S' : 'P'} ${fmt(Math.abs(t.heelDeg))}°`);
    set('pitch', `${fmt(t.pitchDeg)}° ${t.pitchDeg >= 0 ? 'bow up' : 'bow dn'}`);
    set('lee', `${fmt(t.leewayDeg)}°`);
    set('tws', `${fmt(t.twsKn)} kn from ${deg3(t.twdDeg)}`);
    set('twa', signed(t.twaDeg));
    set('aws', `${fmt(t.awsKn)} kn @ ${signed(t.awaDeg)}`);
    set('fn', `${fmt(t.fn, 2)}${t.fn > 0.55 ? ' (planing)' : ''}`);
    const td = env.tide;
    const h = td.hoursFromHW;
    set('tide', `${fmt(td.heightM)} m CD · HW${h >= 0 ? '+' : '−'}${fmt(Math.abs(h))}h · depth ${fmt(td.depthM)} m`);
    set('stream', `${fmt(Math.abs(td.streamMs) / 0.514444, 2)} kn ${td.streamMs >= 0 ? 'flood' : 'ebb'}`);
    set('sea', `Hs ${fmt(env.waves.hs, 2)} m · Tp ${fmt(env.waves.tp)} s`);
    set('rho', `${fmt(env.rhoAir, 3)} / ${fmt(env.rhoWater, 0)} kg/m³`);
    const m = b.main, j = b.jib;
    set('main', `depth ${Math.round(m.depths[1] * 100)}/${Math.round(m.depths[m.depths.length - 3] * 100)}% · twist ${Math.round(m.twistDeg)}° · sheet stops ${Math.round(m.sheetLimit / DEG)}°`);
    set('jib', `depth ${Math.round(j.depths[0] * 100)}% · twist ${Math.round(j.twistDeg)}° · lead ${Math.round(j.sheetLimit / DEG)}°`);
    const cn = t.centres;
    if (cn) {
      set('lead', `${cn.ce && cn.clr ? `${fmt(cn.leadM, 2)} m` : '–'} (design ${fmt(cn.geoLeadM, 2)} m)`);
      set('gz', `${fmt(cn.gzM, 2)} m · RM ${fmt(cn.rightingNm / 1000, 2)} kN·m`);
    }
    set('disp', `${fmt(t.dispKg, 0)} kg · planing ${fmt((100 * Math.max(t.planingLift, 0)) / (b.mass * 9.80665), 0)}%`);
    set('wet', `${fmt(t.wettedM2, 2)} m²`);
    const mm = Math.floor(sim.t / 60), ss = Math.floor(sim.t % 60);
    set('time', `${mm}:${ss.toString().padStart(2, '0')}  ${paused ? '⏸' : `${timeScale}×`}`);

    // telltales: what the middle of each sail is doing (effective angle of attack, and whether the flow is holding on)
    const tell = (name: string, sl: SailRuntime, on: boolean) => {
      if (!on) return '';
      const k = sl.mid;
      const st = sl.luff[k] > 0.4 ? ['luffing', 'warn'] : sl.fs[k] < 0.45 ? ['stalled', 'bad'] : ['flowing', 'ok'];
      return `<span class="tt ${st[1]}">${name} α ${Math.round(sl.alphaMid / DEG)}° ${st[0]}</span>`;
    };
    this.trim.innerHTML = tell('Main', b.main, true) + tell('Jib', b.jib, true) + tell('Kite', b.gennaker, b.genHoist > 0.9);

    const badges: string[] = [];
    if (t.capsized) badges.push('<span class="badge bad">CAPSIZED — press R</span>');
    if (t.grounded) badges.push('<span class="badge warn">AGROUND</span>');
    if (t.fn > 0.55 && !t.capsized) badges.push('<span class="badge ok">PLANING</span>');
    if (Math.abs(t.awaDeg) < 25 && t.stwKn < 1.5) badges.push('<span class="badge warn">IN IRONS</span>');
    this.badges.innerHTML = badges.join('');
  }
}
