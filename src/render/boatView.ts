import * as THREE from 'three';
import { HULL, hullPoint, keelY, sheerY } from '../physics/hull';
import { RIG, mastPoint, type Boat, type SailRuntime } from '../physics/boat';
import { DEG, clamp } from '../physics/math';

const L = HULL.L;

function hullGeometry(): THREE.BufferGeometry {
  const NS = 64, NT = 14;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const white = new THREE.Color(0xf4f4f0), stripe = new THREE.Color(0x1d4f9c), bottom = new THREE.Color(0xe8e8e2);
  const deckCol = new THREE.Color(0xd9dcd6);
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
  // deck (slight camber) with an open cockpit band left as a darker strip
  const NA = 6;
  const base = pos.length / 3;
  for (let i = 0; i <= NS; i++) {
    const s = i / NS;
    const hb = hullPoint(s, 1, 1)[2];
    for (let k = 0; k <= NA; k++) {
      const f = (k / NA) * 2 - 1;
      const camber = 0.03 * (1 - f * f);
      const cockpit = s > 0.08 && s < 0.62 && Math.abs(f) < 0.7;
      push([s * L, sheerY(s) + camber - (cockpit ? 0.12 : 0), f * hb], cockpit ? new THREE.Color(0xb9bdb6) : deckCol);
    }
  }
  for (let i = 0; i < NS; i++) {
    for (let k = 0; k < NA; k++) {
      const a = base + i * (NA + 1) + k, b = a + NA + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
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
  torso: THREE.Mesh;
  legs: THREE.Mesh;
  head: THREE.Mesh;
  constructor(vest: number) {
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0b48f, roughness: 0.8 });
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 4, 10), new THREE.MeshStandardMaterial({ color: vest, roughness: 0.7 }));
    this.legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.62, 4, 8), new THREE.MeshStandardMaterial({ color: 0x1d2633, roughness: 0.8 }));
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), skin);
    this.group.add(this.torso, this.legs, this.head);
  }
  /** hip = body-frame point, torsoDir/legDir = unit directions (body frame). */
  pose(hip: THREE.Vector3, torsoDir: THREE.Vector3, legDir: THREE.Vector3) {
    const up = new THREE.Vector3(0, 1, 0);
    this.torso.position.copy(hip).addScaledVector(torsoDir, 0.38);
    this.torso.quaternion.setFromUnitVectors(up, torsoDir);
    this.head.position.copy(hip).addScaledVector(torsoDir, 0.82);
    this.legs.position.copy(hip).addScaledVector(legDir, 0.42);
    this.legs.quaternion.setFromUnitVectors(up, legDir);
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

  constructor() {
    const hull = new THREE.Mesh(hullGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, side: THREE.DoubleSide }));
    hull.castShadow = true;
    this.root.add(hull);
    // wings / racks
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.5, roughness: 0.4 });
    for (const sd of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.03, 0.16), wingMat);
      w.position.set(1.75, sheerY(1.75 / L) + 0.02, sd * 0.94);
      this.root.add(w);
    }
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

  update(b: Boat, t: number, apparentBody: THREE.Vector3) {
    this.root.position.copy(b.origin);
    this.root.quaternion.copy(b.q);
    const rake = b.setup.mastRakeDeg;
    if (rake !== this.rakeKey) {
      this.rakeKey = rake;
      placeSpar(this.mast, new THREE.Vector3(...mastPoint(0, rake)), new THREE.Vector3(...mastPoint(RIG.mastHeight + 0.1, rake)));
    }
    // boom along the main foot
    const foot = b.main.section(0);
    const gp = new THREE.Vector3(...foot.p);
    placeSpar(this.boom, gp, gp.clone().addScaledVector(new THREE.Vector3(...foot.c), foot.chord * 1.03));
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
    this.poseSailor(this.helm, b.helm, b.side, false);
    const onWire = Math.abs(b.crew.z) > 1.1;
    const harness = this.poseSailor(this.crew, b.crew, b.side, true);
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

  /** Returns the harness point (body frame). */
  private poseSailor(s: Sailor, cg: THREE.Vector3, side: number, isCrew: boolean): THREE.Vector3 {
    const out = Math.abs(cg.z);
    const sd = Math.sign(cg.z) || side;
    const deck = sheerY(cg.x / L);
    if (isCrew && out > 1.1) {
      // trapeze: feet on the gunwale, body extended outboard
      const hip = new THREE.Vector3(cg.x, cg.y + 0.05, cg.z - sd * 0.1);
      const feet = new THREE.Vector3(cg.x + 0.15, deck + 0.02, sd * 0.92);
      const legDir = feet.clone().sub(hip).normalize();
      const torsoDir = new THREE.Vector3(0.1, 0.35, sd).normalize();
      s.pose(hip, torsoDir, legDir);
      return hip;
    }
    // sitting / hiking: hip on the side deck, lean out with hiking
    const hike = clamp((out - 0.9) / 0.6, 0, 1);
    const inboard = out < 0.6;
    const hip = new THREE.Vector3(cg.x, deck + (inboard ? -0.05 : 0.04), inboard ? cg.z : sd * Math.min(out, 1.0));
    const lean = hike * 70 * DEG;
    const torsoDir = new THREE.Vector3(0, Math.cos(lean), sd * Math.sin(lean)).normalize();
    const legDir = new THREE.Vector3(0.35, -0.35, -sd * 0.85).normalize();
    s.pose(hip, torsoDir, legDir);
    return hip;
  }
}
