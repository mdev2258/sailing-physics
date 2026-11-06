import GUI from 'lil-gui';
import type { SimParams } from '../physics/params';
import { BRIDLE } from '../physics/boat';

export interface ViewOptions {
  paused: boolean;
  timeScale: number;
  camera: 'orbit' | 'chase' | 'top';
  showForces: boolean;
  showTrack: boolean;
  forceScaleN: number;
}

export interface GuiActions {
  reset: () => void;
  rightBoat: () => void;
  startAt: (twaDeg: number) => void;
}

/** Every physics variable, grouped like a sailor thinks about them. */
export function buildGui(p: SimParams, view: ViewOptions, act: GuiActions): GUI {
  const gui = new GUI({ title: 'ISO sim — variables', width: 300 });
  const L = (c: ReturnType<GUI['add']>) => c.decimals(2).listen();

  const sim = gui.addFolder('Simulation');
  sim.add(view, 'paused').name('Paused (Space)').listen();
  sim.add(view, 'timeScale', { '¼×': 0.25, '½×': 0.5, '1×': 1, '2×': 2, '4×': 4 }).name('Time scale');
  sim.add(view, 'camera', ['orbit', 'chase', 'top']).name('Camera (C)').listen();
  sim.add(view, 'showForces').name('Show forces (F)').listen();
  sim.add(view, 'forceScaleN', 50, 1000, 10).name('Force arrow N per m');
  sim.add(view, 'showTrack').name('Show ground track');
  const start = { twa: 50 };
  sim.add(start, 'twa', -180, 180, 5).name('Restart at TWA°');
  sim.add({ go: () => act.startAt(start.twa) }, 'go').name('↺ Restart at that TWA');
  sim.add(act, 'rightBoat').name('⤴ Right the boat (R)');
  sim.add(act, 'reset').name('↺ Reset everything');

  const wind = gui.addFolder('Wind');
  wind.add(p.wind, 'speedKn', 0, 35, 0.5).name('True wind (kn @10 m)');
  wind.add(p.wind, 'fromDeg', 0, 359, 1).name('From (°T)');
  wind.add(p.wind, 'gustiness', 0, 1, 0.01).name('Gustiness');
  wind.add(p.wind, 'gustScaleM', 20, 400, 5).name('Gust size (m)');
  wind.add(p.wind, 'shiftAmpDeg', 0, 30, 0.5).name('Shift amplitude (°)');
  wind.add(p.wind, 'shiftPeriodS', 10, 900, 5).name('Shift period (s)');
  wind.add(p.wind, 'gradientExp', 0.05, 0.35, 0.005).name('Gradient exponent');

  const wx = gui.addFolder('Weather');
  wx.add(p.weather, 'airTempC', -10, 40, 0.5).name('Air temp (°C)');
  wx.add(p.weather, 'pressureHPa', 950, 1050, 1).name('Pressure (hPa)');
  wx.add(p.weather, 'humidityPct', 0, 100, 1).name('Humidity (%)');
  wx.add(p.weather, 'waterTempC', 0, 32, 0.5).name('Water temp (°C)');
  wx.add(p.weather, 'salinityPSU', 0, 40, 0.5).name('Salinity (PSU)');
  wx.add(p.weather, 'rain', 0, 1, 0.01).name('Rain');
  wx.add(p.weather, 'fog', 0, 1, 0.01).name('Fog');
  wx.add(p.weather, 'cloud', 0, 1, 0.01).name('Cloud');
  wx.close();

  const wv = gui.addFolder('Waves');
  wv.add(p.waves, 'autoFromWind').name('Wind-sea from wind + fetch');
  wv.add(p.waves, 'fetchKm', 0.2, 200, 0.1).name('Fetch (km)');
  wv.add(p.waves, 'heightM', 0, 3, 0.01).name('Hs (m) [manual]');
  wv.add(p.waves, 'periodS', 0.8, 12, 0.1).name('Tp (s) [manual]');
  wv.add(p.waves, 'lockToWind').name('Sea from wind direction');
  wv.add(p.waves, 'fromDeg', 0, 359, 1).name('Sea from (°T)');
  wv.add(p.waves, 'spreadDeg', 0, 90, 1).name('Directional spread (°)');
  wv.add(p.waves, 'swellHeightM', 0, 3, 0.01).name('Swell height (m)');
  wv.add(p.waves, 'swellPeriodS', 4, 20, 0.1).name('Swell period (s)');
  wv.add(p.waves, 'swellFromDeg', 0, 359, 1).name('Swell from (°T)');
  wv.add(p.waves, 'seed', 1, 999, 1).name('Random seed');
  wv.close();

  const td = gui.addFolder('Tide');
  td.add(p.tide, 'rangeM', 0, 8, 0.05).name('Range (m)');
  td.add(p.tide, 'chartDepthM', -2, 20, 0.1).name('Charted depth (m)');
  L(td.add(p.tide, 'hoursFromHW', -6.2, 6.2, 0.05).name('Hours from HW'));
  td.add(p.tide, 'periodH', 11, 13, 0.01).name('Period (h)');
  td.add(p.tide, 'maxStreamKn', 0, 5, 0.05).name('Max stream (kn)');
  td.add(p.tide, 'floodToDeg', 0, 359, 1).name('Flood sets to (°T)');
  td.add(p.tide, 'advanceWithSim').name('Tide clock runs');
  td.close();

  const c = p.controls;
  const helm = gui.addFolder('Helm & foils');
  L(helm.add(c, 'rudderDeg', -35, 35, 0.5).name('Rudder ° (+ = to starboard)  ←/→'));
  L(helm.add(c, 'boardDown', 0, 1, 0.01).name('Daggerboard down  B/N'));
  (helm.add(c, 'autopilot').name('Autopilot (P)')).listen();
  L(helm.add(c, 'autopilotHeadingDeg', 0, 359, 1).name('Autopilot heading (°)'));

  const sails = gui.addFolder('Sails & strings');
  L(sails.add(c, 'mainsheet', 0, 1, 0.01).name('Mainsheet  W/S'));
  L(sails.add(c, 'jibSheet', 0, 1, 0.01).name('Jib sheet  Q/A'));
  (sails.add(c, 'gennakerHoisted').name('Gennaker hoisted (G)')).listen();
  L(sails.add(c, 'gennakerSheet', 0, 1, 0.01).name('Gennaker sheet  E/D'));
  (sails.add(c, 'autoTrim').name('Auto-trim sheets')).listen();

  // Led to both side decks on the real boat; 0 = fully eased … 1 = bar tight.
  const lines = gui.addFolder('Control lines');
  L(lines.add(c, 'downhaul', 0, 1, 0.01).name('Downhaul (cunningham)'));
  L(lines.add(c, 'kicker', 0, 1, 0.01).name('Kicker'));
  L(lines.add(c, 'outhaul', 0, 1, 0.01).name('Outhaul'));
  L(lines.add(c, 'barberHauler', 0, 1, 0.01).name('Jib barber hauler (in & down)'));
  L(lines.add(c, 'bridleLengthM', BRIDLE.minLength, BRIDLE.maxLength, 0.01).name('Mainsheet bridle length (m)'));
  L(lines.add(c, 'forestayTension', 0, 1, 0.01).name('Forestay / rig tension'));

  const crew = gui.addFolder('Crew');
  L(crew.add(c, 'helmOut', -0.5, 1, 0.01).name('Helm out (0.5 side, 1 hike)'));
  L(crew.add(c, 'helmFwd', -0.8, 0.8, 0.01).name('Helm fore/aft (m)'));
  L(crew.add(c, 'crewOut', -0.5, 1, 0.01).name('Crew out (1 = flat on wire)  Z/X'));
  L(crew.add(c, 'crewFwd', -0.8, 0.8, 0.01).name('Crew fore/aft (m)'));
  crew.add(c, 'side', ['auto', 'port', 'starboard']).name('Side').listen();
  (crew.add(c, 'autoHike').name('Auto-hike (H)')).listen();
  crew.add(c, 'heelTargetDeg', 0, 20, 0.5).name('Auto-hike heel target (°)');

  const su = gui.addFolder('Boat setup');
  su.add(p.setup, 'hullMassKg', 60, 200, 1).name('Hull mass (kg)');
  su.add(p.setup, 'rigMassKg', 5, 40, 1).name('Rig mass (kg)');
  su.add(p.setup, 'helmMassKg', 30, 120, 1).name('Helm mass (kg)');
  su.add(p.setup, 'crewMassKg', 30, 120, 1).name('Crew mass (kg)');
  su.add(p.setup, 'mainAreaM2', 5, 16, 0.1).name('Main area (m²)');
  su.add(p.setup, 'jibAreaM2', 1, 8, 0.1).name('Jib area (m²)');
  su.add(p.setup, 'gennakerAreaM2', 5, 30, 0.1).name('Gennaker area (m²)');
  su.add(p.setup, 'mastRakeDeg', -2, 10, 0.25).name('Mast rake (°)');
  su.close();

  if (window.innerWidth < 700) gui.close();
  return gui;
}
