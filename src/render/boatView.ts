import * as THREE from 'three';
import { HULL, hullPoint, keelY, sheerY } from '../physics/hull';
import { BRIDLE, COCKPIT, RIG, WINGS, bridleRise, mastPoint, type Boat, type SailRuntime } from '../physics/boat';
import { DEG, clamp, lerp } from '../physics/math';

const L = HULL.L;

function hullGeometry(): THREE.BufferGeometry {
  const NS = 64, NT = 14;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const white = new THREE.Color(0xf4f4f0), stripe = new THREE.Color(0x1d4f9c), bottom = new THREE.Color(0xe8e8e2);
  const push = (p: number[], c: THREE.Color) => { pos.push(p[0], p[1], p[2]); col.push(c.r, c.g, c.b); return pos.length / 3 - 1; };
  // skin, both sides
  for (const side of [-1, 1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= NS; i++) {
      for (let j = 0; j <= NT; j++) {
        const t = j / NT;
        push(hullPoint(i / NS, t, side), t > 0.82 && t < 0.93 ? stripe : t < 0.3 ? bottom : white);
      }
    }
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NT; j++) {
        const a = base + i * (NT + 1) + j, b = a + NT + 1;
        if (side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
        else idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  // transom
  const tb = pos.length / 3;
  for (let j = 0; j <= NT; j++) { push(hullPoint(0, j / NT, -1), white); push(hullPoint(0, j / NT, 1), white); }
  for (let j = 0; j < NT; j++) {
    const a = tb + j * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

type P3 = [number, number, number];
const hb = (s: number) => hullPoint(clamp(s, 0, 1), 1, 1)[2];
const zIn = (s: number) => Math.max(0.12, hb(s) - COCKPIT.sideDeckW); // inner edge of the side decks

/** Adds a (nu+1)×(nv+1) grid surface to the buffers. */
function addGrid(pos: number[], col: number[], idx: number[], nu: number, nv: number, f: (u: number, v: number) => P3, c: THREE.Color) {
  const base = pos.length / 3;
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const p = f(i / nu, j / nv); pos.push(p[0], p[1], p[2]); col.push(c.r, c.g, c.b); }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = base + i * (nv + 1) + j, b = a + nv + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
}

/**
 * ISO deck and cockpit, from the real boat: wide flat side decks (the buoyancy tanks you sit on),
 * a dropped self-draining floor, vertical coamings, a short aft deck and the foredeck up to the mast.
 */
function deckGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const deck = new THREE.Color(0xe9ebe6), floor = new THREE.Color(0xd2d6d0), face = new THREE.Color(0xdfe2dc);
  const { aftS, fwdS, floorY } = COCKPIT;
  const N = 40;
  // foredeck, cambered
  addGrid(pos, col, idx, N, 10, (u, v) => { const s = lerp(fwdS, 1, u), f = v * 2 - 1; return [s * L, sheerY(s) + 0.035 * (1 - f * f), f * hb(s)]; }, deck);
  // aft deck
  addGrid(pos, col, idx, 3, 10, (u, v) => { const s = lerp(0, aftS, u), f = v * 2 - 1; return [s * L, sheerY(s) + 0.01, f * hb(s)]; }, deck);
  for (const sd of [-1, 1]) {
    // side deck: flat bench from the gunwale in to the coaming
    addGrid(pos, col, idx, N, 3, (u, v) => { const s = lerp(aftS, fwdS, u); return [s * L, sheerY(s) + 0.012, sd * lerp(hb(s), zIn(s), v)]; }, deck);
    // coaming: the inner face of the side tank, down to the floor
    addGrid(pos, col, idx, N, 2, (u, v) => { const s = lerp(aftS, fwdS, u); return [s * L, lerp(sheerY(s) + 0.012, floorY, v), sd * (zIn(s) - 0.015 * v)]; }, face);
  }
  // cockpit floor
  addGrid(pos, col, idx, N, 8, (u, v) => { const s = lerp(aftS, fwdS, u); return [s * L, floorY, ((v * 2 - 1) * (zIn(s) - 0.015))]; }, floor);
  // aft lip and forward bulkhead, floor up to deck
  addGrid(pos, col, idx, 1, 8, (u, v) => [aftS * L, lerp(floorY, sheerY(aftS) + 0.01, u), (v * 2 - 1) * zIn(aftS)], face);
  addGrid(pos, col, idx, 1, 8, (u, v) => { const f = v * 2 - 1; return [fwdS * L, lerp(floorY, sheerY(fwdS) + 0.035 * (1 - f * f * (zIn(fwdS) / hb(fwdS)) ** 2), u), f * zIn(fwdS)]; }, face);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Hiking wings: an outer tube along each side, cross tubes back to the gunwale, and a mesh deck. */
function wingGroup(width: number): THREE.Group {
  const g = new THREE.Group();
  const tube = new THREE.MeshStandardMaterial({ color: 0xb7bec6, metalness: 0.7, roughness: 0.35 });
  const mesh = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.9, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const { x0, x1 } = WINGS;
  for (const sd of [-1, 1]) {
    const outer = (x: number): THREE.Vector3 => new THREE.Vector3(x, sheerY(x / L) + 0.03, sd * (hb(x / L) + width));
    const inner = (x: number): THREE.Vector3 => new THREE.Vector3(x, sheerY(x / L) + 0.02, sd * (hb(x / L) - 0.02));
    const pts = Array.from({ length: 12 }, (_, i) => outer(lerp(x0, x1, i / 11)));
    const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.019, 8), tube);
    g.add(rail);
    for (let i = 0; i < 4; i++) {
      const x = lerp(x0 + 0.05, x1 - 0.05, i / 3);
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1, 8), tube);
      placeSpar(c, inner(x), outer(x));
      g.add(c);
    }
    // trampoline mesh between gunwale and rail
    const pos: number[] = [], idx: number[] = [];
    for (let i = 0; i <= 12; i++) {
      const x = lerp(x0, x1, i / 12);
      const a = inner(x), b = outer(x);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    for (let i = 0; i < 12; i++) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    mg.setIndex(idx);
    mg.computeVertexNormals();
    g.add(new THREE.Mesh(mg, mesh));
  }
  return g;
}

/** A spar between two points. */
function spar(radius: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 10), new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.4 }));
  return m;
}
function placeSpar(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  m.position.copy(a).addScaledVector(d, 0.5);
  m.scale.set(1, Math.max(len, 1e-3), 1);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
}

class SailView {
  mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private readonly NR = 14;
  private readonly NC = 10;
  constructor(color: number, opacity = 0.96) {
    const NR = this.NR, NC = this.NC;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((NR + 1) * (NC + 1) * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < NR; i++) for (let j = 0; j < NC; j++) {
      const a = i * (NC + 1) + j, b = a + NC + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({
      color, side: THREE.DoubleSide, roughness: 0.75, transparent: opacity < 1, opacity,
    }));
    this.mesh.frustumCulled = false;
  }
  update(s: SailRuntime, hoist: number, t: number) {
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const NR = this.NR, NC = this.NC;
    const side = s.angle >= 0 ? 1 : -1;
    const ax = s.axis;
    // luffing flutter when the sail is near zero angle of attack
    const luff = clamp(1 - s.alphaMid / (s.luffTol * 1.2), 0, 1);
    for (let i = 0; i <= NR; i++) {
      const u = (i / NR) * hoist;
      const sec = s.section(Math.min(u, 0.999));
      const c = sec.c;
      // camber direction: towards the side the sail has swung to
      let nx = ax[1] * c[2] - ax[2] * c[1], ny = ax[2] * c[0] - ax[0] * c[2], nz = ax[0] * c[1] - ax[1] * c[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx = (nx / nl) * side; ny = (ny / nl) * side; nz = (nz / nl) * side;
      for (let j = 0; j <= NC; j++) {
        const x = j / NC;
        let bulge = sec.depth * sec.chord * 6.75 * x * (1 - x) ** 2 * 0.9; // max ≈ depth·chord at 1/3 chord
        bulge += luff * 0.06 * Math.sin(t * 18 + x * 9 + u * 4) * x * (1 - x) * 4;
        const k = (i * (NC + 1) + j) * 3;
        pos.array[k] = sec.p[0] + c[0] * sec.chord * x + nx * bulge;
        pos.array[k + 1] = sec.p[1] + c[1] * sec.chord * x + ny * bulge;
        pos.array[k + 2] = sec.p[2] + c[2] * sec.chord * x + nz * bulge;
      }
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

class Sailor {
  group = new THREE.Group();
  private torso: THREE.Mesh;
  private head: THREE.Mesh;
  private helmet: THREE.Mesh;
  private thigh: THREE.Mesh;
  private shin: THREE.Mesh;
  private arms!: THREE.Mesh;
  constructor(vest: number) {
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0b48f, roughness: 0.8 });
    const wetsuit = new THREE.MeshStandardMaterial({ color: 0x1d2633, roughness: 0.8 });
    // buoyancy aid over a wetsuit: a little deeper front-to-back than wide
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.36, 4, 12), new THREE.MeshStandardMaterial({ color: vest, roughness: 0.7 }));
    this.torso.geometry.scale(1, 1, 0.8);
    this.arms = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.5, 4, 8), wetsuit);
    this.arms.geometry.scale(1, 1, 3.2); // both arms as one band, reaching forward
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), skin);
    this.helmet = new THREE.Mesh(new THREE.SphereGeometry(0.118, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x20252c, roughness: 0.5 }));
    // both legs drawn together as one wide capsule per segment
    this.thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.3, 4, 8), wetsuit);
    this.shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.32, 4, 8), wetsuit);
    this.thigh.scale.set(1.5, 1, 1);
    this.shin.scale.set(1.4, 1, 1);
    this.group.add(this.torso, this.head, this.helmet, this.thigh, this.shin, this.arms);
  }
  private limb(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
    const d = b.clone().sub(a);
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  }
  /** Body-frame hip, torso direction, knee and foot. */
  pose(hip: THREE.Vector3, torsoDir: THREE.Vector3, knee: THREE.Vector3, foot: THREE.Vector3) {
    this.torso.position.copy(hip).addScaledVector(torsoDir, 0.36);
    this.torso.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), torsoDir);
    this.head.position.copy(hip).addScaledVector(torsoDir, 0.8);
    this.helmet.position.copy(this.head.position);
    this.helmet.quaternion.copy(this.torso.quaternion);
    this.limb(this.thigh, hip, knee);
    this.limb(this.shin, knee, foot);
    // arms: from the shoulders forward and down towards the knees (tiller extension / sheet)
    const shoulder = hip.clone().addScaledVector(torsoDir, 0.55);
    const hands = knee.clone().lerp(shoulder, 0.35).add(new THREE.Vector3(0.18, 0.05, 0));
    this.limb(this.arms, shoulder, hands);
  }
}

export class BoatView {
  root = new THREE.Group();
  private mast: THREE.Mesh;
  private boom: THREE.Mesh;
  private sprit: THREE.Mesh;
  private board: THREE.Mesh;
  private rudder: THREE.Group;
  private sails: SailView[];
  private helm = new Sailor(0xd23b2a);
  private crew = new Sailor(0xf2c230);
  private wire: THREE.Line;
  private burgee: THREE.Mesh;
  private rakeKey = NaN;
  private wings: THREE.Group | null = null;
  private wingKey = '';
  private bridle!: THREE.Line;
  private sheet!: THREE.Line;
  private block!: THREE.Mesh;

  constructor() {
    const hull = new THREE.Mesh(hullGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, side: THREE.DoubleSide }));
    hull.castShadow = true;
    this.root.add(hull);
    this.root.add(new THREE.Mesh(deckGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide })));
    this.addFittings();
    // mainsheet bridle + the sheet from the block to the boom end
    // mainsheet bridle + the sheet from the block to the boom end
    const lineMat = new THREE.LineBasicMaterial({ color: 0x2b4c8c });
    this.bridle = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 17 }, () => new THREE.Vector3())), lineMat);
    this.sheet = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x9a1f1f }));
    this.block = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    this.root.add(this.bridle, this.sheet, this.block);
    this.mast = spar(0.035, 0xc9ced3);
    this.boom = spar(0.035, 0xc9ced3);
    this.sprit = spar(0.025, 0x2a2a2a);
    this.root.add(this.mast, this.boom, this.sprit);
    this.board = new THREE.Mesh(new THREE.BoxGeometry(RIG.board.chord, 1, 0.025), new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.5 }));
    this.root.add(this.board);
    this.rudder = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(RIG.rudder.chord, RIG.rudder.span + 0.25, 0.022), new THREE.MeshStandardMaterial({ color: 0x222831 }));
    blade.position.set(-RIG.rudder.chord / 4, -(RIG.rudder.span + 0.25) / 2 + 0.3, 0);
    const tiller = spar(0.018, 0x6b4a2b);
    placeSpar(tiller, new THREE.Vector3(0, 0.55, 0), new THREE.Vector3(1.05, 0.62, 0));
    this.rudder.add(blade, tiller);
    this.rudder.position.set(RIG.rudder.x + 0.08, 0, 0);
    this.root.add(this.rudder);
    this.sails = [new SailView(0xf7f3e8), new SailView(0xf7f3e8), new SailView(0xd8352a, 0.97)];
    for (const s of this.sails) this.root.add(s.mesh);
    this.root.add(this.helm.group, this.crew.group);
    this.wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x333333 }));
    this.root.add(this.wire);
    this.burgee = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0xff3b3b }));
    this.root.add(this.burgee);
  }

  /** Centre console with board slot and ratchet, toe straps, control-line loops, aft hatch, mast gate. */
  private addFittings() {
    const { floorY, strapZ } = COCKPIT;
    const white = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.5 });
    const black = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
    const grey = new THREE.MeshStandardMaterial({ color: 0x4b5058, roughness: 0.6 });
    // centre console: runs forward to the daggerboard case
    const x0 = 1.45, x1 = 2.95, h = 0.13;
    const con = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, 0.2), white);
    con.position.set((x0 + x1) / 2, floorY + h / 2, 0);
    const slot = new THREE.Mesh(new THREE.BoxGeometry(RIG.board.chord + 0.04, 0.005, 0.035), black);
    slot.position.set(RIG.board.x, floorY + h + 0.003, 0);
    // mainsheet ratchet block on a boss at the aft end, with jammers either side
    const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.06, 14), white);
    boss.position.set(x0 + 0.08, floorY + h + 0.03, 0);
    const ratchet = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.016, 8, 16), black);
    ratchet.position.set(x0 + 0.08, floorY + h + 0.1, 0);
    ratchet.rotation.y = Math.PI / 2;
    this.root.add(con, slot, boss, ratchet);
    for (const sd of [-1, 1]) {
      const jam = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 0.03), grey);
      jam.position.set(x0 + 0.25, floorY + h + 0.015, sd * 0.06);
      this.root.add(jam);
      // toe strap, slightly lifted off the floor between its ends
      const strap = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.012, 0.075), black);
      strap.position.set(1.05, floorY + 0.05, sd * strapZ);
      this.root.add(strap);
    }
    // continuous control lines (red / blue) led round the inner edge of the side decks and across aft
    const loop = (off: number, color: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) { const x = lerp(2.65, 0.4, i / 10); pts.push(new THREE.Vector3(x, sheerY(x / L) + 0.02, -(zIn(x / L) + off))); }
      pts.push(new THREE.Vector3(0.38, floorY + 0.12, -0.2), new THREE.Vector3(0.38, floorY + 0.12, 0.2));
      for (let i = 0; i <= 10; i++) { const x = lerp(0.4, 2.65, i / 10); pts.push(new THREE.Vector3(x, sheerY(x / L) + 0.02, zIn(x / L) + off)); }
      this.root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color })));
    };
    loop(0.02, 0xc0392b);
    loop(0.045, 0x2f6fd6);
    // round inspection hatch on the aft deck, mast gate on the foredeck
    const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.012, 20), grey);
    hatch.position.set(0.1, sheerY(0.02) + 0.016, 0.42);
    const gate = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.12), grey);
    gate.position.set(RIG.mastX, sheerY(RIG.mastX / L) + 0.045, 0);
    this.root.add(hatch, gate);
  }

  private updateWings(b: Boat) {
    const key = `${b.setup.wings}|${b.setup.wingWidthM}`;
    if (key === this.wingKey) return;
    this.wingKey = key;
    if (this.wings) { this.root.remove(this.wings); this.wings = null; }
    if (b.setup.wings) { this.wings = wingGroup(b.setup.wingWidthM); this.root.add(this.wings); }
  }

  /** Bridle hangs as a V between the transom eyes; the block sits on it under the boom end. */
  private updateBridle(boomEnd: THREE.Vector3, lengthM: number) {
    const w = BRIDLE.halfSpan, y0 = sheerY(0) + 0.03, x = BRIDLE.x;
    const rise = bridleRise(lengthM);
    const a = Math.max(lengthM, 2 * w) / 2;
    // block slides along the bridle (an ellipse with the eyes as foci) towards the boom end
    const bz = clamp(boomEnd.z, -w * 0.95, w * 0.95);
    const by = y0 + rise * Math.sqrt(Math.max(0, 1 - (bz * bz) / (a * a)));
    const blk = new THREE.Vector3(x, by, bz);
    this.block.position.copy(blk);
    const eyeP = new THREE.Vector3(x, y0, -w), eyeS = new THREE.Vector3(x, y0, w);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const f = i / 16;
      pts.push(f <= 0.5 ? eyeP.clone().lerp(blk, f * 2) : blk.clone().lerp(eyeS, (f - 0.5) * 2));
    }
    (this.bridle.geometry as THREE.BufferGeometry).setFromPoints(pts);
    (this.sheet.geometry as THREE.BufferGeometry).setFromPoints([blk, boomEnd]);
  }

  update(b: Boat, t: number, apparentBody: THREE.Vector3, bridleLengthM = 1) {
    this.root.position.copy(b.origin);
    this.root.quaternion.copy(b.q);
    this.updateWings(b);
    const rake = b.setup.mastRakeDeg;
    if (rake !== this.rakeKey) {
      this.rakeKey = rake;
      placeSpar(this.mast, new THREE.Vector3(...mastPoint(0, rake)), new THREE.Vector3(...mastPoint(RIG.mastHeight + 0.1, rake)));
    }
    // boom along the main foot
    const foot = b.main.section(0);
    const gp = new THREE.Vector3(...foot.p);
    const boomEnd = gp.clone().addScaledVector(new THREE.Vector3(...foot.c), foot.chord * 1.03);
    placeSpar(this.boom, gp, boomEnd);
    this.updateBridle(boomEnd, bridleLengthM);
    // sprit extends with the hoist
    const bowP = new THREE.Vector3(L - 0.05, sheerY(0.99) + 0.05, 0);
    placeSpar(this.sprit, bowP, bowP.clone().add(new THREE.Vector3((RIG.spritLength + 0.05) * Math.max(b.genHoist, 0.02), 0.02, 0)));
    // foils
    const span = RIG.board.span * b.board + 0.35;
    this.board.scale.set(1, span, 1);
    this.board.position.set(RIG.board.x, keelY(RIG.board.x / L) - RIG.board.span * b.board + span / 2, 0);
    this.rudder.rotation.y = b.rudder;
    // sails
    this.sails[0].update(b.main, 1, t);
    this.sails[1].update(b.jib, 1, t);
    this.sails[2].mesh.visible = b.genHoist > 0.02;
    if (this.sails[2].mesh.visible) this.sails[2].update(b.gennaker, b.genHoist, t);
    // crew
    this.poseSailor(this.helm, b.helm, b.side, false, b);
    const onWire = Math.abs(b.crew.z) > b.railZ(b.crew.x) + 0.25;
    const harness = this.poseSailor(this.crew, b.crew, b.side, true, b);
    this.wire.visible = onWire;
    if (onWire) {
      const pts = [new THREE.Vector3(...mastPoint(4.6, rake)), harness];
      (this.wire.geometry as THREE.BufferGeometry).setFromPoints(pts);
    }
    // burgee points downwind of the apparent wind at the masthead
    const top = new THREE.Vector3(...mastPoint(RIG.mastHeight + 0.25, rake));
    const dir = apparentBody.clone().setY(0);
    if (dir.lengthSq() > 1e-6) {
      dir.normalize();
      this.burgee.position.copy(top).addScaledVector(dir, 0.17);
      this.burgee.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().negate());
    }
  }

  /** Poses a sailor from their CG in the boat frame; returns the harness point (for the trapeze wire). */
  private poseSailor(s: Sailor, cg: THREE.Vector3, side: number, isCrew: boolean, b: Boat): THREE.Vector3 {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const out = Math.abs(cg.z);
    const sd = Math.sign(cg.z) || side;
    const deck = sheerY(cg.x / L);
    const rail = b.railZ(cg.x);
    const floor = COCKPIT.floorY;
    if (isCrew && out > rail + 0.25) {
      // on the wire: feet on the rail, body straight out from them
      const feet = V(cg.x + 0.12, deck + 0.03, sd * (rail - 0.02));
      const hip = V(cg.x, cg.y + 0.02, cg.z - sd * 0.05);
      const legDir = hip.clone().sub(feet).normalize();
      const knee = feet.clone().lerp(hip, 0.5).add(V(0.04, 0.03, 0));
      const torsoDir = legDir.clone().add(V(0, 0.25, 0)).normalize();
      s.pose(hip, torsoDir, knee, feet);
      return hip;
    }
    if (out > rail - 0.3) {
      // sitting on the side deck edge, feet under the toe strap; lean out as they hike
      const hike = clamp((out - (rail - 0.08)) / 0.55, 0, 1);
      const hip = V(cg.x, deck + 0.06, sd * Math.min(rail - 0.04 + 0.12 * hike, rail + 0.1));
      const lean = (10 + 65 * hike) * DEG;
      const torsoDir = V(-0.08, Math.cos(lean), sd * Math.sin(lean)).normalize();
      const foot = V(cg.x + 0.35, floor + 0.05, sd * COCKPIT.strapZ);
      const knee = V(cg.x + 0.22, deck + 0.12 - 0.08 * hike, sd * lerp(rail - 0.3, (rail + COCKPIT.strapZ) / 2 + 0.05, 0.4));
      s.pose(hip, torsoDir, knee, foot);
      return hip;
    }
    // in the boat: sitting low on the floor, knees up
    const hip = V(cg.x, floor + 0.1, cg.z);
    s.pose(hip, V(-0.15, 1, 0).normalize(), V(cg.x + 0.32, floor + 0.38, cg.z), V(cg.x + 0.62, floor + 0.05, cg.z));
    return hip;
  }
}
