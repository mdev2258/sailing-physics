import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Boat, Centres } from '../physics/boat';

type Key = 'cg' | 'cb' | 'ce' | 'clr' | 'meta';
const DEFS: Record<Key, { label: string; title: string; color: number }> = {
  ce: { label: 'CE', title: 'Centre of effort: where the total sail force acts', color: 0xff4d4d },
  clr: { label: 'CLR', title: 'Centre of lateral resistance: where the sideways water force acts', color: 0x2fe08a },
  cg: { label: 'G', title: 'Centre of gravity: boat + crew', color: 0xffffff },
  cb: { label: 'B', title: 'Centre of buoyancy: centroid of the displaced water', color: 0x4da6ff },
  meta: { label: 'M', title: 'Transverse metacentre', color: 0xc38bff },
};

/**
 * Markers for the boat's centres, drawn through the hull and sails. Positions are smoothed in the
 * boat's frame (~0.3 s) so wave-by-wave flicker doesn't hide what they're doing.
 * The weight line through G and the buoyancy line through B show the righting couple (GZ).
 */
export class CentresView {
  group = new THREE.Group();
  private marks = new Map<Key, { mesh: THREE.Mesh; label: CSS2DObject; body: THREE.Vector3 | null }>();
  private weight: THREE.Line;
  private buoy: THREE.Line;
  private gz: THREE.Line;
  private gzLabel: CSS2DObject;
  private ceDrop: THREE.Line;
  private clrRise: THREE.Line;

  constructor() {
    for (const k of Object.keys(DEFS) as Key[]) {
      const d = DEFS[k];
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), new THREE.MeshBasicMaterial({ color: d.color, depthTest: false, transparent: true }));
      mesh.renderOrder = 10;
      const div = document.createElement('div');
      div.className = 'centre-label';
      div.textContent = d.label;
      div.title = d.title;
      div.style.color = `#${d.color.toString(16).padStart(6, '0')}`;
      const label = new CSS2DObject(div);
      label.position.set(0.16, 0.12, 0);
      mesh.add(label);
      this.group.add(mesh);
      this.marks.set(k, { mesh, label, body: null });
    }
    const line = (color: number, dashed = false) => {
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, dashSize: 0.12, gapSize: 0.08, depthTest: false, transparent: true, opacity: 0.85 })
        : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), mat);
      l.renderOrder = 9;
      l.frustumCulled = false;
      this.group.add(l);
      return l;
    };
    this.weight = line(0xffffff);
    this.buoy = line(0x4da6ff);
    this.gz = line(0xffd21f);
    this.ceDrop = line(0xff4d4d, true);
    this.clrRise = line(0x2fe08a, true);
    const gzDiv = document.createElement('div');
    gzDiv.className = 'centre-label gz';
    this.gzLabel = new CSS2DObject(gzDiv);
    this.group.add(this.gzLabel);
  }

  update(b: Boat, dt: number, visible: boolean) {
    this.group.visible = visible;
    for (const m of this.marks.values()) m.label.visible = visible;
    this.gzLabel.visible = visible;
    const c: Centres | undefined = b.tel.centres;
    if (!visible || !c) return;
    const inv = b.q.clone().invert();
    const toBody = (w: number[]) => new THREE.Vector3(w[0], w[1], w[2]).sub(b.origin).applyQuaternion(inv);
    const toWorld = (v: THREE.Vector3) => v.clone().applyQuaternion(b.q).add(b.origin);
    const k = Math.min(1, dt / 0.3);
    const world: Partial<Record<Key, THREE.Vector3>> = {};
    for (const key of Object.keys(DEFS) as Key[]) {
      const m = this.marks.get(key)!;
      const w = c[key];
      if (!w) { m.body = null; m.mesh.visible = false; m.label.visible = false; continue; }
      const target = toBody(w);
      if (!m.body) m.body = target; else m.body.lerp(target, k);
      const p = toWorld(m.body);
      m.mesh.position.copy(p);
      m.mesh.visible = true;
      m.label.visible = true;
      world[key] = p;
    }
    const set = (l: THREE.Line, a?: THREE.Vector3, bb?: THREE.Vector3) => {
      l.visible = !!(a && bb);
      if (a && bb) { (l.geometry as THREE.BufferGeometry).setFromPoints([a, bb]); l.computeLineDistances(); }
    };
    const G = world.cg, B = world.cb;
    // weight acts straight down through G, buoyancy straight up through B
    set(this.weight, G, G && G.clone().add(new THREE.Vector3(0, -0.9, 0)));
    set(this.buoy, B, B && B.clone().add(new THREE.Vector3(0, 1.3, 0)));
    // GZ: the horizontal gap between those two lines, drawn at G's height
    if (G && B && Math.abs(c.gzM) > 0.02) {
      const Z = new THREE.Vector3(B.x, G.y, B.z);
      set(this.gz, G, Z);
      this.gzLabel.position.copy(G).lerp(Z, 0.5).add(new THREE.Vector3(0, 0.15, 0));
      (this.gzLabel.element as HTMLElement).textContent = `GZ ${c.gzM.toFixed(2)} m`;
    } else { set(this.gz); this.gzLabel.visible = false; }
    // CE straight down and CLR straight up to the waterline: the fore-and-aft gap between them is the lead
    set(this.ceDrop, world.ce, world.ce && new THREE.Vector3(world.ce.x, 0, world.ce.z));
    set(this.clrRise, world.clr, world.clr && new THREE.Vector3(world.clr.x, 0.4, world.clr.z));
  }
}
