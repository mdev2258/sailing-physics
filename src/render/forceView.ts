import * as THREE from 'three';
import { G } from '../physics/math';
import type { Boat } from '../physics/boat';
import type { Balance } from '../physics/balance';
import { ArrowSet, LabelSet, fmtN } from './arrows';
import type { LayerState } from './layers';

/** Colours shared with the force table and the layer chips. */
export const FORCE_COLORS = {
  aero: 0xff5a4d, hydro: 0x4da6ff, weight: 0xf2f5f7, buoyancy: 0x3ddc84, planing: 0xffa94d, ground: 0xb08968,
  drive: 0x2fe08a, heel: 0xffd21f, drag: 0xff9d5c, side: 0x7fe3ff,
  ok: 0x2fe08a, luff: 0xffb020, stall: 0xff4d4d, board: 0x4da6ff, rudder: 0x9b6bff,
};
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** How much longer the per-strip arrows are drawn than the totals. */
export const DISTRIBUTION_GAIN = 5;

/**
 * Force layers.
 *  - resultants: the five arrows of the textbook diagram, each drawn where it really acts.
 *  - components: the sail force split into drive and heeling force, the water force into drag and side force.
 *  - distribution: the force on every strip of every sail and foil, buoyancy and planing lift
 *    station by station along the hull, and each weight on its own.
 * All lengths are newtons ÷ the "N per metre" scale, so the arrows can be compared by eye.
 */
export class ForceView {
  group = new THREE.Group();
  private big = new ArrowSet(32);
  private small = new ArrowSet(260, true, 0.9);
  private labels = new LabelSet('force-label');
  private dash: THREE.LineSegments;
  private dashPos = new Float32Array(8 * 6);

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.dashPos, 3));
    this.dash = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.1, gapSize: 0.07, depthTest: false, transparent: true, opacity: 0.7 }));
    this.dash.renderOrder = 19;
    this.dash.frustumCulled = false;
    this.group.add(this.big.group, this.small.group, this.labels.group, this.dash);
  }

  /** Totals are eased over about a quarter of a second: in chop the instantaneous values flicker too fast to read. */
  private ease = new Map<string, number[]>();
  private eased(key: string, v: ArrayLike<number>, k: number): number[] {
    let a = this.ease.get(key);
    if (!a) { a = [v[0], v[1], v[2]]; this.ease.set(key, a); }
    else for (let i = 0; i < 3; i++) a[i] += (v[i] - a[i]) * k;
    return a;
  }

  update(b: Boat, balNow: Balance, layers: LayerState, nPerM: number, dt = 1 / 60) {
    const ke = Math.min(1, dt / 0.25);
    const easeRow = <T extends Balance['aero']>(r: T): T => ({ ...r, f: this.eased(`${r.key}f`, r.f, ke), fw: this.eased(`${r.key}w`, r.fw, ke) });
    const bal: Balance = { ...balNow, rows: balNow.rows.map(easeRow), aero: easeRow(balNow.aero), hydro: easeRow(balNow.hydro) };
    const big = this.big, small = this.small, lab = this.labels;
    big.begin(); small.begin(); lab.begin();
    let nd = 0;
    const dp = this.dashPos;
    const dashed = (a: ArrayLike<number>, c: ArrayLike<number>) => {
      if (nd >= 8) return;
      dp.set([a[0], a[1], a[2], c[0], c[1], c[2]], nd * 6);
      nd++;
    };
    const k = 1 / nPerM;
    const cen = b.centres;
    // `along`: where on the arrow the label sits (1 = just past the tip), `lift`: how far above it
    const arrow = (at: ArrayLike<number>, f: ArrayLike<number>, color: number, text: string, r = 0.045, along = 1.04, lift = 0.08) => {
      const mag = Math.hypot(f[0], f[1], f[2]);
      if (mag * k < 0.03) return;
      big.add(at[0], at[1], at[2], f[0] * k, f[1] * k, f[2] * k, color, r);
      lab.put(`${text} ${fmtN(mag)}`, at[0] + f[0] * k * along, at[1] + f[1] * k * along + lift, at[2] + f[2] * k * along, hex(color));
    };
    const row = (key: string) => bal.rows.find((r) => r.key === key);
    const aeroAt = cen.ce ?? bal.aero.at, hydroAt = cen.clr ?? bal.hydro.at;

    if (layers.resultants) {
      arrow(aeroAt, bal.aero.fw, FORCE_COLORS.aero, 'Sails', 0.045, 1.04, 0.22);
      arrow(hydroAt, bal.hydro.fw, FORCE_COLORS.hydro, 'Hull + foils', 0.045, 1.04, 0.22);
      const w = row('weight'), bu = row('buoyancy'), pl = row('planing'), gr = row('ground');
      if (w) arrow(cen.cg, w.fw, FORCE_COLORS.weight, 'Weight');
      if (bu) arrow(cen.cb, bu.fw, FORCE_COLORS.buoyancy, 'Buoyancy');
      if (pl && cen.planing && Math.hypot(...pl.fw) > 25) arrow(cen.planing, pl.fw, FORCE_COLORS.planing, 'Planing lift');
      if (gr) arrow(gr.at, gr.fw, FORCE_COLORS.ground, 'Seabed');
    }

    if (layers.components) {
      const split = (at: ArrayLike<number>, r: Balance['aero'], c1: number, n1: string, c2: number, n2: string) => {
        if (Math.hypot(...r.fw) < 15) return;
        const a: number[] = [bal.fwd[0] * r.f[0], 0, bal.fwd[2] * r.f[0]];
        const s: number[] = [bal.stb[0] * r.f[1], 0, bal.stb[2] * r.f[1]];
        arrow(at, a, c1, n1, 0.03, 1.05, -0.2);
        arrow(at, s, c2, n2, 0.03, 0.75, -0.2);
        // close the parallelogram on the horizontal part of the total
        const tip = [at[0] + (a[0] + s[0]) * k, at[1], at[2] + (a[2] + s[2]) * k];
        dashed([at[0] + a[0] * k, at[1], at[2] + a[2] * k], tip);
        dashed([at[0] + s[0] * k, at[1], at[2] + s[2] * k], tip);
        if (!layers.resultants) big.add(at[0], at[1], at[2], (a[0] + s[0]) * k, r.f[2] * k, (a[2] + s[2]) * k, 0xffffff, 0.018);
      };
      split(aeroAt, bal.aero, FORCE_COLORS.drive, 'Drive', FORCE_COLORS.heel, 'Heeling force');
      split(hydroAt, bal.hydro, FORCE_COLORS.drag, bal.hydro.f[0] <= 0 ? 'Drag' : 'Push', FORCE_COLORS.side, 'Side force');
    }

    if (layers.distribution) {
      const kd = k * DISTRIBUTION_GAIN;
      const p = [0, 0, 0], f = [0, 0, 0];
      for (const s of b.sails) {
        if (!s.flying) continue;
        for (let i = 0; i < s.strips.length; i++) {
          b.toWorldPoint(s.stripAt[i], p);
          b.toWorldDir(s.stripForce[i], f);
          const c = s.luff[i] > 0.4 ? FORCE_COLORS.luff : s.fs[i] < 0.45 ? FORCE_COLORS.stall : FORCE_COLORS.ok;
          small.add(p[0], p[1], p[2], f[0] * kd, f[1] * kd, f[2] * kd, c, 0.02);
        }
      }
      for (const fo of b.foils) {
        if (fo.span < 0.05) continue;
        for (let i = 0; i < fo.n; i++) {
          b.toWorldPoint(fo.stripAt[i], p);
          b.toWorldDir(fo.stripForce[i], f);
          small.add(p[0], p[1], p[2], f[0] * kd, f[1] * kd, f[2] * kd, fo.name === 'board' ? FORCE_COLORS.board : FORCE_COLORS.rudder, 0.018);
        }
      }
      for (let i = 0; i < b.stBuoy.length; i++) {
        if (b.stBuoy[i] < 2) continue;
        const a = b.stBuoyAt[i];
        small.add(a[0], a[1], a[2], 0, b.stBuoy[i] * kd, 0, FORCE_COLORS.buoyancy, 0.016);
      }
      for (let sd = 0; sd < 2; sd++) for (let i = 0; i < b.planingStrip[sd].length; i++) {
        const v = b.planingStrip[sd][i];
        if (v < 2) continue;
        b.toWorldPoint(b.planingAt[sd][i], p);
        b.toWorldDir([0, v, 0], f);
        small.add(p[0], p[1], p[2], f[0] * kd, f[1] * kd, f[2] * kd, FORCE_COLORS.planing, 0.022);
      }
      for (const it of b.massItems) {
        b.toWorldPoint(it.p, p);
        small.add(p[0], p[1], p[2], 0, -it.m * G * kd * 0.2, 0, FORCE_COLORS.weight, 0.02); // weights at the totals' scale: they are big
        lab.put(`${it.label.replace(' weight', '')} ${Math.round(it.m)} kg`, p[0], p[1] - it.m * G * kd * 0.2 - 0.12, p[2], hex(FORCE_COLORS.weight));
      }
    }

    big.end(); small.end(); lab.end();
    (this.dash.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.dash.geometry.setDrawRange(0, nd * 2);
    this.dash.computeLineDistances();
    this.dash.visible = nd > 0;
  }
}
