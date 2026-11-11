import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { RIG, type Boat, type SailRuntime } from '../physics/boat';
import type { Environment } from '../physics/environment';
import type { VortexSystem } from '../physics/vortex';
import type { LayerState } from './layers';

/**
 * Flow layers. Nothing here is a cartoon of what the flow "should" look like: every streamline is
 * integrated through the velocity field of the same vortex system the forces came from (apparent wind
 * or water stream, plus what every sail / foil strip induces, plus the mirror images in the sea and
 * the hull). So you see the upwash ahead of the jib, the air squeezing through the slot, the flow
 * speeding up over the leeward side, the wake bent to windward, the board's downwash on the rudder.
 * The one thing a vortex model cannot make on its own is a separated wake, so where the section model
 * says the flow has let go (its separation point, lagged like the real thing) the lines go ragged.
 */

type V3 = [number, number, number];
const NP = 42; // points per streamline

interface Stream { line: Line2; geo: LineGeometry; mat: LineMaterial; pos: Float32Array; col: Float32Array; phase: number; speed: number; live: boolean }

function makeStream(group: THREE.Group, width: number, onTop: boolean): Stream {
  const pos = new Float32Array(NP * 3), col = new Float32Array(NP * 3).fill(1);
  const geo = new LineGeometry();
  geo.setPositions(pos);
  geo.setColors(col);
  const mat = new LineMaterial({
    color: 0xffffff, vertexColors: true, linewidth: width, dashed: true, dashSize: 0.34, gapSize: 0.16,
    transparent: true, opacity: 0.92, depthTest: !onTop, depthWrite: false,
  });
  const line = new Line2(geo, mat);
  line.frustumCulled = false;
  line.visible = false;
  if (onTop) line.renderOrder = 15;
  group.add(line);
  return { line, geo, mat, pos, col, phase: Math.random() * 0.5, speed: 1, live: false };
}

/** Colour ramps by local speed ÷ free-stream speed. */
const AIR = { slow: new THREE.Color(0x2f6bff), mid: new THREE.Color(0xeef4f8), fast: new THREE.Color(0xff8a1f) };
const WATER = { slow: new THREE.Color(0x1746c9), mid: new THREE.Color(0xb9ecff), fast: new THREE.Color(0xfff2a8) };
const RAGGED = new THREE.Color(0xff4d4d), LUFF = new THREE.Color(0xffb020), OK = new THREE.Color(0x2fe08a);
const C = new THREE.Color();
function ramp(r: number, k: typeof AIR, out: THREE.Color): THREE.Color {
  return r < 1 ? out.copy(k.mid).lerp(k.slow, Math.min(1, (1 - r) / 0.22)) : out.copy(k.mid).lerp(k.fast, Math.min(1, (r - 1) / 0.25));
}

/** Where a body-frame point sits relative to one sail: strip, chordwise position, distance off the cloth. */
interface SailHit { i: number; x: number; d: number; n: V3; chord: number }
function sailLocal(s: SailRuntime, px: number, py: number, pz: number, hit: SailHit): boolean {
  const p0 = s.def.p0, ax = s.axis;
  const rx = px - p0[0], ry = py - p0[1], rz = pz - p0[2];
  const h = rx * ax[0] + ry * ax[1] + rz * ax[2];
  const u = h / s.luffLen;
  if (u < -0.03 || u > 1.03) return false;
  const i = s.stripIndex(Math.min(Math.max(u, 0), 1));
  const c = s.cdir[i], chord = s.chordAt(Math.min(Math.max(u, 0), 1));
  // offset from the luff at this height
  const ox = rx - ax[0] * h, oy = ry - ax[1] * h, oz = rz - ax[2] * h;
  const x = (ox * c[0] + oy * c[1] + oz * c[2]) / chord;
  if (x < -0.6 || x > 2.4) return false;
  // camber-side normal
  const cs = s.angle >= 0 ? 1 : -1;
  let nx = (ax[1] * c[2] - ax[2] * c[1]) * cs, ny = (ax[2] * c[0] - ax[0] * c[2]) * cs, nz = (ax[0] * c[1] - ax[1] * c[0]) * cs;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const xc = Math.min(Math.max(x, 0), 1);
  const bulge = s.depths[i] * chord * 6.075 * xc * (1 - xc) ** 2;
  hit.i = i; hit.x = x; hit.d = ox * nx + oy * ny + oz * nz - bulge; hit.chord = chord;
  hit.n[0] = nx; hit.n[1] = ny; hit.n[2] = nz;
  return true;
}

export class FlowView {
  group = new THREE.Group();
  private air: Stream[] = [];
  private water: Stream[] = [];
  private heads: THREE.InstancedMesh;
  private tells: LineSegments2;
  private tellPos = new Float32Array(27 * 6);
  private tellCol = new Float32Array(27 * 6);
  private vort: LineSegments2;
  private vortPos = new Float32Array(64 * 6);
  private vortCol = new Float32Array(64 * 6);
  private frame = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private hit: SailHit = { i: 0, x: 0, d: 0, n: [0, 0, 1], chord: 1 };

  constructor() {
    for (let i = 0; i < 30; i++) this.air.push(makeStream(this.group, i % 10 >= 3 && i % 10 <= 6 ? 2.6 : 1.8, false));
    for (let i = 0; i < 16; i++) this.water.push(makeStream(this.group, 2.2, true));
    this.heads = new THREE.InstancedMesh(new THREE.ConeGeometry(0.045, 0.17, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 46);
    this.heads.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(46 * 3), 3);
    this.heads.frustumCulled = false;
    this.group.add(this.heads);
    const seg = (pos: Float32Array, col: Float32Array, width: number, onTop: boolean) => {
      const g = new LineSegmentsGeometry();
      g.setPositions(pos);
      g.setColors(col);
      const l = new LineSegments2(g, new LineMaterial({ vertexColors: true, linewidth: width, transparent: true, opacity: 0.95, depthTest: !onTop, depthWrite: false }));
      l.frustumCulled = false;
      if (onTop) l.renderOrder = 16;
      this.group.add(l);
      return l;
    };
    this.tells = seg(this.tellPos, this.tellCol, 3.2, false);
    this.vort = seg(this.vortPos, this.vortCol, 2.4, true);
  }

  update(b: Boat, env: Environment, t: number, dt: number, layers: LayerState) {
    this.group.position.copy(b.origin);
    this.group.quaternion.copy(b.q);
    this.frame++;
    let heads = 0;
    // ---- air ----
    for (const s of this.air) s.line.visible = layers.airflow && s.live;
    if (layers.airflow) {
      this.seedAir(b, env, t);
      for (const s of this.air) { this.animate(s, dt); if (s.live) heads = this.head(s, heads); }
    }
    // ---- water ----
    for (const s of this.water) s.line.visible = layers.waterflow && s.live;
    if (layers.waterflow) {
      this.seedWater(b, env, t);
      for (const s of this.water) { this.animate(s, dt); if (s.live) heads = this.head(s, heads); }
    }
    this.heads.count = heads;
    this.heads.instanceMatrix.needsUpdate = true;
    if (this.heads.instanceColor) this.heads.instanceColor.needsUpdate = true;
    this.tells.visible = layers.telltales;
    if (layers.telltales) this.telltales(b, t);
    this.vort.visible = layers.vortices;
    if (layers.vortices) this.vortices(b);
  }

  private animate(s: Stream, dt: number) {
    // dashes move at a fraction of the real flow speed so the eye can follow them
    s.phase = (s.phase + dt * s.speed * 0.35) % 0.5;
    s.mat.dashOffset = -s.phase;
  }

  private head(s: Stream, k: number): number {
    if (k >= 46) return k;
    const j = NP - 2, p = s.pos;
    const a = new THREE.Vector3(p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
    const d = new THREE.Vector3(p[j * 3 + 3], p[j * 3 + 4], p[j * 3 + 5]).sub(a);
    if (d.lengthSq() < 1e-8) return k;
    this.q.setFromUnitVectors(this.up, d.normalize());
    this.m4.compose(a.addScaledVector(d, 0.2), this.q, new THREE.Vector3(1, 1, 1));
    this.heads.setMatrixAt(k, this.m4);
    this.heads.setColorAt(k, C.setRGB(s.col[j * 3], s.col[j * 3 + 1], s.col[j * 3 + 2]));
    return k + 1;
  }

  /** Air streamlines: three heights, ten across, re-integrated a third at a time. */
  private seedAir(b: Boat, env: Environment, t: number) {
    const kite = b.genHoist > 0.5;
    const ref: V3 = [0, 0, 0];
    b.airVelocityBody(env, t, [RIG.mastX, 3.3, 0], ref, false);
    const hl = Math.hypot(ref[0], ref[2]);
    if (hl < 0.4) { for (const s of this.air) s.live = false; return; }
    const dx = ref[0] / hl, dz = ref[2] / hl; // where the wind is going, across the boat
    const across = [-2.5, -1.6, -1.0, -0.5, -0.17, 0.17, 0.5, 1.0, 1.6, 2.5];
    const heights = [1.75, 3.3, 4.85];
    const cx = RIG.mastX + (kite ? 1.5 : 0.6), back = kite ? 4.2 : 3.2, ds = kite ? 0.26 : 0.21;
    for (let li = this.frame % 3; li < this.air.length; li += 3) {
      const s = this.air[li];
      const h = heights[Math.floor(li / 10)], a = across[li % 10];
      this.traceAir(b, env, t, s, cx - dx * back - dz * a, h, -dz * back + dx * a, ds, li);
    }
  }

  private traceAir(b: Boat, env: Environment, t: number, s: Stream, x: number, y: number, z: number, ds: number, li: number) {
    const sys = b.aero;
    const vInf: V3 = [0, 0, 0], v: V3 = [0, 0, 0];
    b.airVelocityBody(env, t, [x, y, z], vInf, false);
    const sInf = Math.hypot(vInf[0], vInf[1], vInf[2]);
    s.live = sInf > 0.3;
    if (!s.live) return;
    s.speed = sInf;
    const pos = s.pos, col = s.col, hit = this.hit;
    const sails = b.sails.filter((sl) => sl.flying);
    const side = sails.map(() => 0); // which face of each sail this line is running along
    for (let k = 0; k < NP; k++) {
      v[0] = 0; v[1] = 0; v[2] = 0;
      sys.velocityAt(x, y, z, v, true);
      // right inside a vortex core the model's swirl is far stronger than a real, diffused core: rein it in
      const vi = Math.hypot(v[0], v[1], v[2]), cap = 0.85 * sInf;
      const kk = vi > cap ? cap / vi : 1;
      v[0] = vInf[0] + v[0] * kk; v[1] = vInf[1] + v[1] * kk; v[2] = vInf[2] + v[2] * kk;
      const sp = Math.hypot(v[0], v[1], v[2]) || 1e-6;
      ramp(sp / sInf, AIR, C);
      let jx = 0, jy = 0, jz = 0;
      // keep the line off the cloth, and rough it up where the section says the flow has let go
      for (let si = 0; si < sails.length; si++) {
        const sl = sails[si];
        if (!sailLocal(sl, x, y, z, hit)) continue;
        const onSail = hit.x > -0.04 && hit.x < 1.04;
        if (onSail) {
          if (side[si] === 0) side[si] = hit.d >= 0 ? 1 : -1;
          const gap = 0.06;
          if (hit.d * side[si] < gap) {
            const push = side[si] * gap - hit.d;
            x += hit.n[0] * push; y += hit.n[1] * push; z += hit.n[2] * push;
            // slide: drop the part of the velocity that points into the cloth
            const vn = (v[0] * hit.n[0] + v[1] * hit.n[1] + v[2] * hit.n[2]) * side[si];
            if (vn < 0) { v[0] -= hit.n[0] * vn * side[si]; v[1] -= hit.n[1] * vn * side[si]; v[2] -= hit.n[2] * vn * side[si]; }
            hit.d = side[si] * gap;
          }
        } else if (hit.x <= -0.04) side[si] = 0;
        const fs = sl.fs[hit.i], luff = sl.luff[hit.i];
        // separated: leeward (camber) side, behind the separation point, out to a chord and a bit downstream
        if (fs < 0.6 && hit.d > 0 && hit.d < 0.15 + 0.7 * hit.chord * (1 - fs) && hit.x > Math.max(fs - 0.05, 0.08) && hit.x < 2.3) {
          const amt = (1 - fs) * Math.min(1, (hit.x - fs + 0.25) * 1.6) * (1 - hit.d / (0.15 + 0.7 * hit.chord));
          const w = 0.16 * amt * (Math.sin(t * 8.3 + k * 1.31 + li * 2.1) + 0.6 * Math.sin(t * 13.7 + k * 2.9 + li));
          jx += hit.n[0] * w; jy += hit.n[1] * w + 0.05 * amt * Math.sin(t * 6.1 + k * 1.7); jz += hit.n[2] * w;
          C.lerp(RAGGED, Math.min(1, amt * 1.4));
        } else if (luff > 0.35 && Math.abs(hit.d) < 0.3 && hit.x > -0.15 && hit.x < 0.6) {
          const w = 0.05 * luff * Math.sin(t * 21 + k * 2.3 + li);
          jx += hit.n[0] * w; jy += hit.n[1] * w; jz += hit.n[2] * w;
          C.lerp(LUFF, Math.min(1, luff));
        }
      }
      const o = k * 3;
      pos[o] = x + jx; pos[o + 1] = y + jy; pos[o + 2] = z + jz;
      col[o] = C.r; col[o + 1] = C.g; col[o + 2] = C.b;
      const st = ds / (Math.hypot(v[0], v[1], v[2]) || 1e-6);
      x += v[0] * st; y += v[1] * st; z += v[2] * st;
    }
    s.geo.setPositions(pos);
    s.geo.setColors(col);
    s.line.computeLineDistances();
    s.line.visible = true;
  }

  /** Water streamlines at two depths past the board and rudder. */
  private seedWater(b: Boat, env: Environment, t: number) {
    const ref: V3 = [0, 0, 0];
    b.waterVelocityBody(env, t, [RIG.board.x, -0.4, 0], ref, false);
    const hl = Math.hypot(ref[0], ref[2]);
    if (hl < 0.35 || b.tel.capsized) { for (const s of this.water) s.live = false; return; }
    const dx = ref[0] / hl, dz = ref[2] / hl;
    const across = [-1.15, -0.55, -0.24, -0.07, 0.07, 0.24, 0.55, 1.15];
    const depths = [-0.28, -0.66];
    for (let li = this.frame % 2; li < this.water.length; li += 2) {
      const s = this.water[li];
      const y = depths[Math.floor(li / 8)], a = across[li % 8];
      this.traceWater(b, env, t, s, RIG.board.x - dx * 2.3 - dz * a, y, -dz * 2.3 + dx * a);
    }
  }

  private traceWater(b: Boat, env: Environment, t: number, s: Stream, x: number, y: number, z: number) {
    const sys: VortexSystem = b.hydro;
    const vInf: V3 = [0, 0, 0], v: V3 = [0, 0, 0];
    b.waterVelocityBody(env, t, [x, y, z], vInf, false);
    vInf[1] *= 0.3; // keep the lines at their depth: the picture is the plan view of the flow
    const sInf = Math.hypot(vInf[0], vInf[1], vInf[2]);
    s.live = sInf > 0.3;
    if (!s.live) return;
    s.speed = sInf * 1.6;
    const pos = s.pos, col = s.col, ds = 0.19;
    for (let k = 0; k < NP; k++) {
      v[0] = vInf[0]; v[1] = vInf[1]; v[2] = vInf[2];
      sys.velocityAt(x, y, z, v, true);
      // keep off the blades
      for (const f of b.foils) {
        if (f.span < 0.05 || y > f.yTop || y < f.yTop - f.span - 0.02) continue;
        const c = f.cdir;
        const lx = x - (f.x - c[0] * 0.25 * f.chord), lz = z - -c[2] * 0.25 * f.chord;
        const along = (lx * c[0] + lz * c[2]) / f.chord;
        if (along < -0.1 || along > 1.1) continue;
        const nx = -c[2], nz = c[0]; // blade normal (horizontal)
        const d = lx * nx + lz * nz;
        const gap = 0.035;
        if (Math.abs(d) < gap) {
          const sd = d >= 0 ? 1 : -1;
          x += nx * (sd * gap - d); z += nz * (sd * gap - d);
          const vn = (v[0] * nx + v[2] * nz) * sd;
          if (vn < 0) { v[0] -= nx * vn * sd; v[2] -= nz * vn * sd; }
        }
      }
      const sp = Math.hypot(v[0], v[1], v[2]) || 1e-6;
      ramp(sp / sInf, WATER, C);
      const o = k * 3;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      col[o] = C.r; col[o + 1] = C.g; col[o + 2] = C.b;
      const st = ds / sp;
      x += v[0] * st; y += v[1] * st; z += v[2] * st;
    }
    s.geo.setPositions(pos);
    s.geo.setColors(col);
    s.line.computeLineDistances();
    s.line.visible = true;
  }

  /** Luff telltales either side and a leech ribbon, at three heights on each sail. */
  private telltales(b: Boat, t: number) {
    const pos = this.tellPos, col = this.tellCol;
    pos.fill(0);
    let k = 0;
    const put = (p: V3, d: V3, len: number, c: THREE.Color) => {
      const dl = Math.hypot(d[0], d[1], d[2]) || 1;
      pos[k] = p[0]; pos[k + 1] = p[1]; pos[k + 2] = p[2];
      pos[k + 3] = p[0] + (d[0] / dl) * len; pos[k + 4] = p[1] + (d[1] / dl) * len; pos[k + 5] = p[2] + (d[2] / dl) * len;
      for (let j = 0; j < 6; j += 3) { col[k + j] = c.r; col[k + j + 1] = c.g; col[k + j + 2] = c.b; }
      k += 6;
    };
    const p: V3 = [0, 0, 0], d: V3 = [0, 0, 0];
    for (const s of b.sails) {
      if (!s.flying || (s.def.name === 'gennaker' && b.genHoist < 0.9)) continue;
      const ax = s.axis, cs = s.angle >= 0 ? 1 : -1;
      for (const fr of [0.25, 0.5, 0.75]) {
        const i = s.stripIndex(fr);
        const st = s.strips[i], c = s.cdir[i];
        let nx = (ax[1] * c[2] - ax[2] * c[1]) * cs, ny = (ax[2] * c[0] - ax[0] * c[2]) * cs, nz = (ax[0] * c[1] - ax[1] * c[0]) * cs;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const fs = s.fs[i], luff = s.luff[i], depth = s.depths[i];
        const at = (x: number, off: number) => {
          const bulge = depth * st.chord * 6.075 * x * (1 - x) ** 2 + off;
          p[0] = st.p[0] + c[0] * st.chord * x + nx * bulge; p[1] = st.p[1] + c[1] * st.chord * x + ny * bulge; p[2] = st.p[2] + c[2] * st.chord * x + nz * bulge;
        };
        const wob = (f: number, a: number) => a * Math.sin(t * f + i * 1.9 + fr * 7);
        // windward luff telltale: lifts and flicks when the sail is luffing
        at(0.16, -0.035);
        const lift = Math.min(1, luff * 1.5);
        d[0] = c[0] * (1 - lift) + ax[0] * lift + nx * wob(19, 0.5 * lift) * -1; d[1] = c[1] * (1 - lift) + ax[1] * lift + wob(23, 0.3 * lift); d[2] = c[2] * (1 - lift) + ax[2] * lift - nz * wob(19, 0.5 * lift);
        put(p, d, 0.3, lift > 0.3 ? LUFF : OK);
        // leeward luff telltale: droops and whirls when the leeward side has stalled
        at(0.16, 0.035);
        const stall = Math.min(1, Math.max(0, (0.55 - fs) / 0.35)) * (1 - lift);
        d[0] = c[0] * (1 - 1.3 * stall) - ax[0] * stall + nx * wob(11, 0.6 * stall); d[1] = c[1] * (1 - 1.3 * stall) - ax[1] * stall + wob(7, 0.4 * stall); d[2] = c[2] * (1 - 1.3 * stall) - ax[2] * stall + nz * wob(11, 0.6 * stall);
        put(p, d, 0.3, stall > 0.3 ? RAGGED : lift > 0.3 ? LUFF : OK);
        // leech ribbon: streams aft while the flow reaches the leech, curls round behind when it doesn't
        at(1.0, 0);
        const sep = Math.min(1, Math.max(0, (0.7 - fs) / 0.4));
        d[0] = c[0] * (1 - 1.2 * sep) + nx * (0.9 * sep + wob(9, 0.3 * sep)); d[1] = c[1] * (1 - 1.2 * sep) + ny * 0.9 * sep - 0.3 * sep + wob(13, 0.1 + 0.2 * sep) * 0.3; d[2] = c[2] * (1 - 1.2 * sep) + nz * (0.9 * sep + wob(9, 0.3 * sep));
        put(p, d, 0.36, sep > 0.35 ? RAGGED : OK);
      }
    }
    (this.tells.geometry as LineSegmentsGeometry).setPositions(pos);
    (this.tells.geometry as LineSegmentsGeometry).setColors(col);
  }

  /** Trailing vortices: wherever circulation changes along a sail or foil, that much vorticity streams away downwind. */
  private vortices(b: Boat) {
    const pos = this.vortPos, col = this.vortCol;
    pos.fill(0);
    let k = 0;
    // sails are indexed foot → head (element.a is the lower node); foils root → tip (element.b is the upper node)
    const one = (sys: VortexSystem, idx0: number, n: number, len: number, hue: THREE.Color, rootFirst: boolean) => {
      let gmax = 1e-6;
      for (let i = 0; i < n; i++) gmax = Math.max(gmax, Math.abs(sys.gamma[idx0 + i]));
      for (let j = 0; j <= n && k < pos.length; j++) {
        const below = j > 0 ? sys.gamma[idx0 + j - 1] : 0, above = j < n ? sys.gamma[idx0 + j] : 0;
        const s = Math.abs(above - below) / gmax;
        if (s < 0.22 || gmax < 0.05) continue;
        const e = 3 * (idx0 + Math.min(j, n - 1));
        const first = rootFirst ? j >= n : j < n;
        const src = first ? sys.a : sys.b, dir = first ? sys.da : sys.db;
        const L = len * Math.min(1, 0.35 + s);
        pos[k] = src[e]; pos[k + 1] = src[e + 1]; pos[k + 2] = src[e + 2];
        pos[k + 3] = src[e] + dir[e] * L; pos[k + 4] = src[e + 1] + dir[e + 1] * L; pos[k + 5] = src[e + 2] + dir[e + 2] * L;
        C.copy(hue).multiplyScalar(0.35 + 0.65 * Math.min(1, s));
        for (let q = 0; q < 6; q += 3) { col[k + q] = C.r; col[k + q + 1] = C.g; col[k + q + 2] = C.b; }
        k += 6;
      }
    };
    const airHue = new THREE.Color(0xd7b8ff), waterHue = new THREE.Color(0x8ff0ff);
    for (const s of b.sails) if (s.flying) one(b.aero, s.idx0, s.strips.length, 6, airHue, false);
    for (const f of b.foils) if (f.span > 0.05) one(b.hydro, f.idx0, f.n, 3, waterHue, true);
    (this.vort.geometry as LineSegmentsGeometry).setPositions(pos);
    (this.vort.geometry as LineSegmentsGeometry).setColors(col);
  }
}
