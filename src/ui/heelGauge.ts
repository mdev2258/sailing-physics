import type { Boat } from '../physics/boat';
import { DEG, clamp } from '../physics/math';
import { HULL, hullPoint } from '../physics/hull';

/**
 * Clinometer, looking forward from astern (starboard on the right). The hull section tilts with
 * the heel, the crew are drawn where they really are, and the heel target from auto-hike is ticked.
 * Bands: green = sailing flat, amber = losing drive, red = on the way over.
 */
export class HeelGauge {
  el: HTMLElement;
  private cv: HTMLCanvasElement;
  private num: HTMLElement;
  private sub: HTMLElement;
  private shown = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'heel';
    this.el.innerHTML = `<canvas width="200" height="120" aria-label="Heel angle"></canvas><div class="heel-num">–</div><div class="heel-sub">–</div>`;
    this.cv = this.el.querySelector('canvas')!;
    this.num = this.el.querySelector('.heel-num')!;
    this.sub = this.el.querySelector('.heel-sub')!;
    parent.appendChild(this.el);
  }

  update(b: Boat, targetDeg: number, dt: number) {
    const heel = b.tel.heelDeg; // + = starboard side down
    // a little needle damping so it reads like a real clinometer, not a flicker
    this.shown += (heel - this.shown) * Math.min(1, dt * 8);
    const h = this.shown;
    const cssW = this.cv.clientWidth || 200;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(cssW * dpr), H = Math.round(cssW * 0.6 * dpr);
    if (this.cv.width !== W) { this.cv.width = W; this.cv.height = H; }
    const g = this.cv.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.9, R = Math.min(W * 0.46, H * 0.85);
    // screen angle measured from straight up, clockwise positive (= heeling to starboard)
    const at = (deg: number, r: number): [number, number] => [cx + Math.sin(deg * DEG) * r, cy - Math.cos(deg * DEG) * r];
    const band = (from: number, to: number, col: string) => {
      g.beginPath();
      g.arc(cx, cy, R, (-90 + from) * DEG, (-90 + to) * DEG);
      g.strokeStyle = col; g.lineWidth = W * 0.035; g.stroke();
    };
    for (const sd of [1, -1]) {
      band(sd > 0 ? 0 : -8, sd > 0 ? 8 : 0, '#2fe08a');
      band(sd > 0 ? 8 : -20, sd > 0 ? 20 : -8, '#ffb020');
      band(sd > 0 ? 20 : -60, sd > 0 ? 60 : -20, '#ff5a4d');
    }
    // ticks every 10°
    g.strokeStyle = '#e8eef3'; g.lineWidth = Math.max(1, W * 0.006);
    for (let d = -60; d <= 60; d += 10) {
      const [x0, y0] = at(d, R - W * 0.03), [x1, y1] = at(d, R + W * (d % 30 === 0 ? 0.035 : 0.02));
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
    g.fillStyle = '#9fb0bf';
    g.font = `${Math.round(W * 0.055)}px ui-sans-serif, system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const d of [-30, 30]) { const [x, y] = at(d, R - W * 0.09); g.fillText(`${Math.abs(d)}`, x, y); }
    g.fillText('P', cx - R * 0.95, cy - H * 0.06);
    g.fillText('S', cx + R * 0.95, cy - H * 0.06);
    // heel target (to leeward of the crew's side)
    const lee = -b.side;
    const [tx, ty] = at(lee * targetDeg, R + W * 0.05);
    g.fillStyle = '#e8eef3';
    g.beginPath(); g.arc(tx, ty, W * 0.012, 0, Math.PI * 2); g.fill();

    // hull section at mid-length + mast + crew, rotated by the heel
    g.save();
    g.translate(cx, cy - R * 0.32);
    g.rotate(clamp(h, -90, 90) * DEG);
    const k = (R * 0.55) / HULL.B; // metres → pixels
    const s = 0.45, yWl = 0.12; // section station, waterline height in body frame
    g.beginPath();
    for (let i = 0; i <= 12; i++) {
      const p = hullPoint(s, i / 12, 1);
      const x = p[2] * k, y = -(p[1] - yWl) * k;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    for (let i = 12; i >= 0; i--) {
      const p = hullPoint(s, i / 12, -1);
      g.lineTo(p[2] * k, -(p[1] - yWl) * k);
    }
    g.closePath();
    g.fillStyle = '#f4f4f0'; g.fill();
    g.strokeStyle = '#1d4f9c'; g.lineWidth = W * 0.012; g.stroke();
    // board
    g.fillStyle = '#222831';
    g.fillRect(-W * 0.006, yWl * k, W * 0.012, b.board * 1.0 * k * 0.55);
    // mast (stub)
    g.strokeStyle = '#c9ced3'; g.lineWidth = W * 0.012;
    g.beginPath(); g.moveTo(0, -(0.45 - yWl) * k); g.lineTo(0, -(0.45 - yWl) * k - R * 0.5); g.stroke();
    // crew where they are (z, y in the boat's frame)
    const dot = (z: number, y: number, col: string) => {
      g.fillStyle = col;
      g.beginPath(); g.arc(z * k, -(y - yWl) * k, W * 0.03, 0, Math.PI * 2); g.fill();
    };
    dot(b.helm.z, b.helm.y, '#d23b2a');
    dot(b.crew.z, b.crew.y, '#f2c230');
    g.restore();
    // waterline stays level
    g.strokeStyle = 'rgba(77,166,255,0.7)'; g.lineWidth = W * 0.008;
    g.beginPath(); g.moveTo(cx - R * 0.7, cy - R * 0.32); g.lineTo(cx + R * 0.7, cy - R * 0.32); g.stroke();
    // needle
    const [nx, ny] = at(clamp(h, -60, 60), R - W * 0.02);
    g.strokeStyle = '#ffffff'; g.lineWidth = W * 0.012;
    g.beginPath(); g.moveTo(cx, cy - R * 0.32); g.lineTo(nx, ny); g.stroke();

    const a = Math.abs(heel);
    const toLee = Math.sign(heel) === lee || a < 0.5;
    this.num.textContent = `${heel >= 0 ? 'S' : 'P'} ${a.toFixed(1)}°`;
    this.num.style.color = a < 8 ? '#2fe08a' : a < 20 ? '#ffb020' : '#ff5a4d';
    this.sub.textContent = a < 0.5 ? 'flat' : `${toLee ? 'to leeward' : 'to windward'} · target ${targetDeg}°`;
  }
}
