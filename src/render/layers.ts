/**
 * The layers: every one draws numbers the physics actually computed this step, and each can be
 * switched on its own so you can look at one thing at a time or stack them up.
 */
export type LayerId =
  | 'airflow' | 'waterflow' | 'telltales' | 'vortices'
  | 'sailpressure' | 'hullpressure'
  | 'resultants' | 'components' | 'distribution' | 'balance'
  | 'centres' | 'wind' | 'xray';

export interface LayerDef {
  id: LayerId;
  label: string;
  group: 'Flow' | 'Pressure' | 'Forces' | 'Geometry';
  /** Swatch colour of the chip (the layer's main colour in the scene). */
  color: string;
  hint: string;
  key?: string; // keyboard shortcut (KeyboardEvent.code)
  on: boolean; // default
}

export const LAYERS: LayerDef[] = [
  { id: 'airflow', label: 'Air flow', group: 'Flow', color: '#ffd9a0', key: 'KeyV', on: true,
    hint: 'Streamlines through the rig, from the same vortex system that makes the sail forces. Blue = slowed (high pressure, windward side), orange = speeded up (suction, leeward side). Ragged red = separated.' },
  { id: 'waterflow', label: 'Water flow', group: 'Flow', color: '#7fe3ff', key: 'KeyU', on: false,
    hint: 'Streamlines past the daggerboard and rudder: leeway coming in, the board bending it, the downwash the rudder then works in.' },
  { id: 'telltales', label: 'Telltales', group: 'Flow', color: '#2fe08a', key: 'KeyY', on: true,
    hint: 'Luff and leech telltales on each sail. Green streaming = attached, amber lifting = luffing, red drooping = stalled.' },
  { id: 'vortices', label: 'Tip vortices', group: 'Flow', color: '#d7b8ff', key: 'KeyO', on: false,
    hint: 'The trailing vortices shed from the head and foot of each sail and the tips of the foils. Their strength is the induced drag you are paying.' },
  { id: 'sailpressure', label: 'Sail pressure', group: 'Pressure', color: '#ff6a3d', key: 'KeyI', on: false,
    hint: 'Pressure difference across the cloth. Deep red = hard loaded, pale = lightly loaded, blue = backwinded (luffing).' },
  { id: 'hullpressure', label: 'Wetted hull', group: 'Pressure', color: '#3fa7ff', key: 'KeyJ', on: false,
    hint: 'What the water is doing to the hull: blue deepens with static pressure (depth), orange patches are planing pressure.' },
  { id: 'resultants', label: 'Forces', group: 'Forces', color: '#ff5a4d', key: 'KeyF', on: false,
    hint: 'The totals: sail force at the CE, water force at the CLR, weight through G, buoyancy through B, planing lift.' },
  { id: 'components', label: 'Drive / heel split', group: 'Forces', color: '#ffd21f', key: 'Digit6', on: false,
    hint: 'Sail force split into drive and heeling force; water force split into drag and side force. Balanced when the pairs match.' },
  { id: 'distribution', label: 'Force distribution', group: 'Forces', color: '#ffa94d', key: 'Digit7', on: false,
    hint: 'Force on every strip of every sail and foil, buoyancy and planing lift station by station, and each weight. Drawn 5× longer than the totals.' },
  { id: 'balance', label: 'Force table', group: 'Forces', color: '#e8eef3', key: 'Digit8', on: false,
    hint: 'Every force in newtons, forward / sideways / up, and the heeling, righting and turning moments.' },
  { id: 'centres', label: 'Centres', group: 'Geometry', color: '#c38bff', key: 'KeyK', on: true,
    hint: 'CE, CLR, G, B, M and the planing centre, with the GZ righting lever.' },
  { id: 'wind', label: 'Wind triangle', group: 'Geometry', color: '#9fd0ff', key: 'Digit9', on: false,
    hint: 'True wind, boat velocity and the apparent wind they add up to; heading against the track through the water (leeway).' },
  { id: 'xray', label: 'X-ray boat', group: 'Geometry', color: '#b9c6d2', key: 'Digit0', on: false,
    hint: 'See-through hull, sails and water, so nothing hides behind them.' },
];

export type LayerState = Record<LayerId, boolean>;

/** 'KeyV' → 'V', 'Digit6' → '6'. */
export const keyLabel = (code?: string) => (code ? code.replace(/^Key|^Digit/, '') : '');

const STORE = 'iso-sim-layers';

export function loadLayers(): LayerState {
  const st = Object.fromEntries(LAYERS.map((l) => [l.id, l.on])) as LayerState;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<LayerState>;
    for (const l of LAYERS) if (typeof saved[l.id] === 'boolean') st[l.id] = saved[l.id] as boolean;
  } catch { /* private window, blocked storage: defaults are fine */ }
  return st;
}

export function saveLayers(st: LayerState) {
  try { localStorage.setItem(STORE, JSON.stringify(st)); } catch { /* ignore */ }
}
