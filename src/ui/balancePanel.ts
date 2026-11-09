import type { Boat } from '../physics/boat';
import type { Balance, BalanceRow } from '../physics/balance';
import { G } from '../physics/math';
import { FORCE_COLORS } from '../render/forceView';

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const ROW_COLOR: Record<string, number> = {
  sails: FORCE_COLORS.aero, windage: FORCE_COLORS.aero, hull: FORCE_COLORS.hydro, board: FORCE_COLORS.board, rudder: FORCE_COLORS.rudder,
  planing: FORCE_COLORS.planing, buoyancy: FORCE_COLORS.buoyancy, weight: FORCE_COLORS.weight, ground: FORCE_COLORS.ground,
};
const num = (x: number) => { const r = Math.round(x); return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}`; };

/**
 * The force table: every force on the boat in newtons, forward / to starboard / up, and what the
 * moments are doing. Numbers are averaged over about half a second so they can be read.
 * When she's settled, the Net row is close to zero: that is what "in balance" means.
 */
export class BalancePanel {
  el: HTMLElement;
  private avg = new Map<string, { f: number[]; m: number[] }>();
  private scal = { heel: 0, right: 0, main: 0, jib: 0, kite: 0 };

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'balance';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  update(b: Boat, bal: Balance, dt: number, visible: boolean) {
    this.el.hidden = !visible;
    if (!visible) { this.avg.clear(); return; }
    const k = Math.min(1, dt / 0.5);
    const smooth = (r: BalanceRow) => {
      let a = this.avg.get(r.key);
      if (!a) { a = { f: [...r.f], m: [...r.m] }; this.avg.set(r.key, a); }
      for (let i = 0; i < 3; i++) { a.f[i] += (r.f[i] - a.f[i]) * k; a.m[i] += (r.m[i] - a.m[i]) * k; }
      return a;
    };
    const s = this.scal;
    const ema = (key: keyof typeof s, v: number) => { s[key] += (v - s[key]) * k; return s[key]; };
    let html = `<div class="bl-title">Force balance <span>newtons, level axes</span></div>
      <table><thead><tr><th></th><th>ahead</th><th>stbd</th><th>up</th></tr></thead><tbody>`;
    for (const r of bal.rows) {
      const a = smooth(r);
      html += `<tr><td><i style="background:${hex(ROW_COLOR[r.key] ?? 0xffffff)}"></i>${r.label}</td><td>${num(a.f[0])}</td><td>${num(a.f[1])}</td><td>${num(a.f[2])}</td></tr>`;
    }
    const n = smooth(bal.net);
    html += `<tr class="bl-net"><td title="What is left over accelerates her: near zero when she has settled">Net</td><td>${num(n.f[0])}</td><td>${num(n.f[1])}</td><td>${num(n.f[2])}</td></tr></tbody></table>`;
    const heel = ema('heel', bal.heelingNm), right = ema('right', bal.rightingNm);
    const sideOf = (m: number) => (Math.abs(m) < 15 ? '' : m > 0 ? ' to stbd' : ' to port');
    const wind = smooth(bal.aero), water = smooth(bal.hydro);
    const turn = (m: number) => (Math.abs(m) < 8 ? 'nothing' : `${Math.round(Math.abs(m))} N·m ${m > 0 ? 'to port' : 'to stbd'}`);
    const max = Math.max(Math.abs(heel), Math.abs(right), 1);
    html += `<div class="bl-mom">
      <div><span>Heeling moment <small>wind + water</small></span><b>${Math.round(Math.abs(heel))} N·m${sideOf(heel)}</b></div>
      <div class="bl-bar"><i style="width:${(Math.abs(heel) / max) * 100}%;background:${hex(FORCE_COLORS.heel)}"></i></div>
      <div><span>Righting moment <small>buoyancy + planing, about G</small></span><b>${Math.round(Math.abs(right))} N·m${sideOf(right)}</b></div>
      <div class="bl-bar"><i style="width:${(Math.abs(right) / max) * 100}%;background:${hex(FORCE_COLORS.buoyancy)}"></i></div>
      <div><span>Turning her <small>sails / hull + foils</small></span><b>${turn(wind.m[2])} / ${turn(water.m[2])}</b></div>
      <div><span>Sheet loads <small>main · jib · kite</small></span><b>${Math.round(ema('main', b.main.sheetLoadN) / G)} · ${Math.round(ema('jib', b.jib.sheetLoadN) / G)} · ${Math.round(ema('kite', b.gennaker.sheetLoadN) / G)} kg</b></div>
    </div>`;
    this.el.innerHTML = html;
  }
}
