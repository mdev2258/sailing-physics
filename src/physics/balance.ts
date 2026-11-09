import type { Boat, ForceItem } from './boat';

type V3 = [number, number, number];

/**
 * The force ledger, added up the way a sailor (or a yacht designer's free-body diagram) reads it:
 * in level axes that turn with the boat's heading: forward, to starboard, up, with moments about
 * the centre of gravity. In steady sailing every column sums to nothing:
 *   drive = drag,  heeling force = side force,  weight = buoyancy + planing lift,
 *   heeling moment = righting moment,  and the yaw moments cancel with whatever helm is on.
 */
export interface BalanceRow {
  key: string;
  label: string;
  /** Force along [forward, starboard, up] (N). */
  f: V3;
  /** Moment about the CG about [forward (+ = heels to starboard), starboard (+ = bow up), up (+ = bow to port)] (N·m). */
  m: V3;
  /** World-frame force and point of action. */
  fw: V3;
  at: V3;
}

export interface Balance {
  fwd: V3; stb: V3; up: V3; // level axes, world frame
  rows: BalanceRow[];
  net: BalanceRow;
  /** Sails + windage. */
  aero: BalanceRow;
  /** Hull drag and side force, board, rudder (not buoyancy, not planing lift). */
  hydro: BalanceRow;
  /** Rolling moment from wind and water (N·m, + = to starboard) and the one from buoyancy + planing lift opposing it. */
  heelingNm: number;
  rightingNm: number;
}

const GROUPS: Array<[string, string, string[]]> = [
  ['sails', 'Sails', ['main', 'jib', 'gennaker']],
  ['windage', 'Windage', ['windage']],
  ['hull', 'Hull drag & side force', ['friction', 'wave', 'hullside', 'transom', 'rigwater']],
  ['board', 'Daggerboard', ['board']],
  ['rudder', 'Rudder', ['rudder']],
  ['planing', 'Planing lift', ['planing']],
  ['buoyancy', 'Buoyancy', ['buoyancy']],
  ['weight', 'Weight', ['w_hull', 'w_rig', 'w_helm', 'w_crew', 'w_wing']],
  ['ground', 'Seabed', ['ground']],
];

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function blank(key: string, label: string): BalanceRow {
  return { key, label, f: [0, 0, 0], m: [0, 0, 0], fw: [0, 0, 0], at: [0, 0, 0] };
}

export function forceBalance(b: Boat): Balance {
  const R = b.R;
  const hl = Math.hypot(R[0], R[6]) || 1;
  const fwd: V3 = [R[0] / hl, 0, R[6] / hl];
  const up: V3 = [0, 1, 0];
  const stb: V3 = [-fwd[2], 0, fwd[0]]; // fwd × up
  const cg = b.pos;
  const byId = new Map<string, ForceItem>();
  for (const it of b.tel.ledger) byId.set(it.id, it);
  const add = (row: BalanceRow, it: ForceItem, wsum: { w: number }) => {
    const r = [it.at[0] - cg.x, it.at[1] - cg.y, it.at[2] - cg.z];
    const mw = [r[1] * it.f[2] - r[2] * it.f[1], r[2] * it.f[0] - r[0] * it.f[2], r[0] * it.f[1] - r[1] * it.f[0]];
    row.f[0] += dot(it.f, fwd); row.f[1] += dot(it.f, stb); row.f[2] += dot(it.f, up);
    row.m[0] += dot(mw, fwd); row.m[1] += dot(mw, stb); row.m[2] += dot(mw, up);
    const mag = Math.hypot(it.f[0], it.f[1], it.f[2]);
    for (let k = 0; k < 3; k++) { row.fw[k] += it.f[k]; row.at[k] += it.at[k] * mag; }
    wsum.w += mag;
  };
  const rows: BalanceRow[] = [];
  const net = blank('net', 'Net');
  const aero = blank('aero', 'Wind'), hydro = blank('hydro', 'Water');
  const wa = { w: 0 }, wh = { w: 0 }, wn = { w: 0 };
  for (const [key, label, ids] of GROUPS) {
    const row = blank(key, label);
    const w = { w: 0 };
    for (const id of ids) {
      const it = byId.get(id);
      if (!it) continue;
      add(row, it, w);
      add(net, it, wn);
      if (it.group === 'aero') add(aero, it, wa);
      else if (it.group === 'hydro' && id !== 'planing') add(hydro, it, wh);
    }
    if (w.w <= 0) continue;
    for (let k = 0; k < 3; k++) row.at[k] /= w.w;
    rows.push(row);
  }
  for (const [row, w] of [[aero, wa], [hydro, wh], [net, wn]] as const) for (let k = 0; k < 3; k++) row.at[k] = w.w > 0 ? row.at[k] / w.w : cg.getComponent(k);
  const get = (k: string) => rows.find((r) => r.key === k)?.m[0] ?? 0;
  return {
    fwd, stb, up, rows, net, aero, hydro,
    heelingNm: aero.m[0] + hydro.m[0],
    rightingNm: get('buoyancy') + get('planing') + get('weight') + get('ground'),
  };
}
