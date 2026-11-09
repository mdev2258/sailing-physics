import * as THREE from 'three';
import { KN } from '../physics/math';
import type { Boat } from '../physics/boat';
import type { Environment } from '../physics/environment';
import { ArrowSet, LabelSet } from './arrows';

const COL = { trueWind: 0x4da6ff, boat: 0xf2f5f7, apparent: 0xffe08a, heading: 0xffffff, track: 0x7fe3ff, tide: 0x9b6bff };
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
/** Metres drawn per m/s of speed (≈ 1 m per 2.5 kn). */
const SCALE = 1 / (2.5 * KN);

/**
 * The wind triangle, laid flat on the water to windward of the boat: boat velocity and true wind from
 * one corner, and the apparent wind closing the triangle (boat + apparent = true). Under the boat,
 * where she points against where she is actually going through the water: the gap is leeway.
 */
export class WindView {
  group = new THREE.Group();
  private arrows = new ArrowSet(10);
  private labels = new LabelSet('force-label');

  constructor() { this.group.add(this.arrows.group, this.labels.group); }

  update(b: Boat, env: Environment, t: number, visible: boolean) {
    this.group.visible = visible;
    const ar = this.arrows, lab = this.labels;
    ar.begin(); lab.begin();
    if (visible) {
      const tel = b.tel;
      const air = [0, 0, 0];
      env.wind.at(b.pos.x, 5, b.pos.z, t, air);
      const tws = Math.hypot(air[0], air[2]);
      const y = env.waves.elevation(b.pos.x, b.pos.z, t) + 0.45;
      // corner of the triangle: to windward and a little ahead, clear of the sails
      const R = b.R, hl = Math.hypot(R[0], R[6]) || 1;
      const fx = R[0] / hl, fz = R[6] / hl;
      const wx = tws > 0.1 ? -air[0] / tws : -fz, wz = tws > 0.1 ? -air[2] / tws : fx;
      const ox = b.pos.x + wx * 4.2 + fx * 1.5, oz = b.pos.z + wz * 4.2 + fz * 1.5;
      const vx = b.vel.x, vz = b.vel.z;
      const k = SCALE;
      ar.add(ox, y, oz, vx * k, 0, vz * k, COL.boat, 0.04);
      ar.add(ox, y, oz, air[0] * k, 0, air[2] * k, COL.trueWind, 0.04);
      ar.add(ox + vx * k, y, oz + vz * k, (air[0] - vx) * k, 0, (air[2] - vz) * k, COL.apparent, 0.04);
      const kn = (m: number) => (m / KN).toFixed(1);
      lab.put(`Boat ${kn(Math.hypot(vx, vz))} kn`, ox + vx * k * 0.55, y + 0.25, oz + vz * k * 0.55, hex(COL.boat));
      lab.put(`True wind ${kn(tws)} kn`, ox + air[0] * k * 0.6, y + 0.25, oz + air[2] * k * 0.6, hex(COL.trueWind));
      lab.put(`Apparent ${kn(Math.hypot(air[0] - vx, air[2] - vz))} kn · ${Math.abs(Math.round(tel.awaDeg))}°`,
        ox + vx * k + (air[0] - vx) * k * 0.5, y + 0.55, oz + vz * k + (air[2] - vz) * k * 0.5, hex(COL.apparent));
      // heading against track through the water
      const cur = env.tide.current;
      const sx = vx - cur.x, sz = vz - cur.z, stw = Math.hypot(sx, sz);
      const by = y - 0.25;
      ar.add(b.pos.x, by, b.pos.z, fx * 5.5, 0, fz * 5.5, COL.heading, 0.022);
      if (stw > 0.4) {
        ar.add(b.pos.x, by, b.pos.z, (sx / stw) * 5.5, 0, (sz / stw) * 5.5, COL.track, 0.022);
        lab.put(`Leeway ${Math.abs(tel.leewayDeg).toFixed(1)}°`, b.pos.x + (sx / stw) * 5.8, by + 0.2, b.pos.z + (sz / stw) * 5.8, hex(COL.track));
      }
      const tide = Math.hypot(cur.x, cur.z);
      if (tide > 0.08) {
        ar.add(ox, y, oz, cur.x * k, 0, cur.z * k, COL.tide, 0.03);
        lab.put(`Tide ${kn(tide)} kn`, ox + cur.x * k, y + 0.2, oz + cur.z * k, hex(COL.tide));
      }
    }
    ar.end(); lab.end();
    if (!visible) lab.hide();
  }
}
