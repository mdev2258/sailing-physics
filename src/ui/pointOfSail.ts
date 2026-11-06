import type { Simulation } from '../physics/sim';
import { DEG } from '../physics/math';
import { SAIL_ZONES, pointOfSail, tackName } from '../physics/pointsOfSail';

/**
 * North-up points-of-sail dial: zones coloured round the true wind, the boat turned to its
 * heading with the boom on the side it really is, and a course-over-ground tick (tide/leeway).
 */
export class PointOfSailDial {
  el: HTMLElement;
  private cv: HTMLCanvasElement;
  private name: HTMLElement;
  private sub: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'pos';
    this.el.innerHTML = `<canvas width="200" height="200" aria-label="Points of sail"></canvas><div class="pos-name">–</div><div class="pos-sub">–</div>`;
    this.cv = this.el.querySelector('canvas')!;
    this.name = this.el.querySelector('.pos-name')!;
    this.sub = this.el.querySelector('.pos-sub')!;
    parent.appendChild(this.el);
  }

  update(sim: Simulation) {
    const b = sim.boat, t = b.tel;
    const css = this.cv.clientWidth || 200;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.cv.width !== Math.round(css * dpr)) { this.cv.width = this.cv.height = Math.round(css * dpr); }
    const g = this.cv.getContext('2d')!;
    const S = this.cv.width, c = S / 2, R = S * 0.42, w = S * 0.07;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);
    // screen angle for a compass bearing (north up, clockwise)
    const ang = (bearing: number) => (bearing - 90) * DEG;
    const twd = t.twdDeg;
    const boomWindward = Math.abs(t.twaDeg) > 150 && Math.sign(t.twaDeg) === Math.sign(b.main.angle);
    const pos = pointOfSail(t.twaDeg, boomWindward);
    // zones, mirrored either side of the wind
    SAIL_ZONES.forEach((z, i) => {
      for (const sd of [1, -1]) {
        g.beginPath();
        const a0 = ang(twd + sd * z.from), a1 = ang(twd + sd * Math.min(z.to, 180));
        g.arc(c, c, R, Math.min(a0, a1), Math.max(a0, a1));
        g.strokeStyle = z.color;
        // the ring is "where you'd be heading": heading = TWD − TWA, so you're on side −sign(TWA)
        const here = i === pos.zone && -Math.sign(t.twaDeg || 1) === sd;
        g.globalAlpha = here ? 1 : 0.35;
        g.lineWidth = here ? w * 1.35 : w;
        g.stroke();
      }
    });
    g.globalAlpha = 1;
    // wind arrow coming in from TWD
    const wa = ang(twd);
    const ox = c + Math.cos(wa) * (R + w), oy = c + Math.sin(wa) * (R + w);
    const ix = c + Math.cos(wa) * (R - w * 1.6), iy = c + Math.sin(wa) * (R - w * 1.6);
    g.strokeStyle = g.fillStyle = '#e8eef3';
    g.lineWidth = S * 0.018;
    g.beginPath(); g.moveTo(ox, oy); g.lineTo(ix, iy); g.stroke();
    g.beginPath();
    g.moveTo(ix, iy);
    g.lineTo(ix + Math.cos(wa + 0.45) * S * 0.06, iy + Math.sin(wa + 0.45) * S * 0.06);
    g.lineTo(ix + Math.cos(wa - 0.45) * S * 0.06, iy + Math.sin(wa - 0.45) * S * 0.06);
    g.fill();
    g.font = `600 ${Math.round(S * 0.065)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', c + S * 0.075, S * 0.04); // beside the top, so a northerly's arrow doesn't hide it
    // course over ground tick (where you're actually going)
    const ca = ang(t.cogDeg);
    g.setLineDash([S * 0.02, S * 0.02]);
    g.strokeStyle = '#9fb0bf'; g.lineWidth = S * 0.01;
    g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.cos(ca) * R * 0.85, c + Math.sin(ca) * R * 0.85); g.stroke();
    g.setLineDash([]);
    // boat, turned to its heading
    g.translate(c, c);
    g.rotate(t.headingDeg * DEG);
    const L = R * 0.62, B = L * 0.37;
    g.beginPath();
    g.moveTo(0, -L / 2);
    g.bezierCurveTo(B * 0.55, -L * 0.3, B * 0.5, L * 0.2, B * 0.4, L / 2);
    g.lineTo(-B * 0.4, L / 2);
    g.bezierCurveTo(-B * 0.5, L * 0.2, -B * 0.55, -L * 0.3, 0, -L / 2);
    g.fillStyle = '#f4f4f0'; g.fill();
    g.strokeStyle = '#1d4f9c'; g.lineWidth = S * 0.01; g.stroke();
    // boom: pivots at the mast, swung to its real angle (+ = to starboard)
    const mastY = -L * 0.1, boomLen = L * 0.48, ba = b.main.angle;
    g.strokeStyle = '#d23b2a'; g.lineWidth = S * 0.016;
    g.beginPath(); g.moveTo(0, mastY); g.lineTo(Math.sin(ba) * boomLen, mastY + Math.cos(ba) * boomLen); g.stroke();
    g.fillStyle = '#1b1b1b'; g.beginPath(); g.arc(0, mastY, S * 0.014, 0, Math.PI * 2); g.fill();
    g.setTransform(1, 0, 0, 1, 0, 0);

    this.name.textContent = pos.name;
    this.name.style.color = pos.name === 'By the lee' ? '#ff5a4d' : SAIL_ZONES[pos.zone].color;
    this.sub.textContent = `${pos.zone === 0 ? 'Head to wind' : tackName(b.main.angle)} · TWA ${Math.round(Math.abs(t.twaDeg))}° · AWA ${Math.round(Math.abs(t.awaDeg))}°`;
  }
}
