import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Simulation } from './physics/sim';
import { DEG, clamp, towards, wrap180, wrap360 } from './physics/math';
import { applyAssistLevel, type AssistLevel } from './physics/params';
import { NO_GO_DEG, requestTack } from './physics/assist';
import { Water } from './render/water';
import { BoatView } from './render/boatView';
import { FlowView } from './render/flowView';
import { CentresView } from './render/centresView';
import { ForceView } from './render/forceView';
import { WindView } from './render/windView';
import { LAYERS, loadLayers, type LayerId } from './render/layers';
import { forceBalance } from './physics/balance';
import { LayersPanel } from './ui/layersPanel';
import { BalancePanel } from './ui/balancePanel';
import { PointOfSailDial } from './ui/pointOfSail';
import { HeelGauge } from './ui/heelGauge';
import { TrimMode } from './ui/trimMode';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildGui, type ViewOptions } from './ui/gui';
import { Hud } from './ui/hud';
import './style.css';

const sim = new Simulation();
const p = sim.params;
applyAssistLevel(p.controls, 'easy'); // start friendly; M or the panel changes it
const view: ViewOptions = { paused: false, timeScale: 1, camera: 'orbit', showTrack: true, forceScaleN: 600 };
const layers = loadLayers();

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
document.getElementById('app')!.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.setSize(window.innerWidth, window.innerHeight);
labels.domElement.id = 'labels';
document.getElementById('app')!.appendChild(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 6000);
camera.position.set(-9, 5, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 3;
controls.maxDistance = 400;

const sky = new Sky();
sky.scale.setScalar(5000);
scene.add(sky);
const sunDir = new THREE.Vector3();
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x2a3c48, 0.9);
scene.add(sun, sun.target, hemi);
const water = new Water();
scene.add(water.mesh, water.deep);
const boatView = new BoatView();
scene.add(boatView.root);
const flowView = new FlowView();
scene.add(flowView.group);
const centresView = new CentresView();
scene.add(centresView.group);
const forceView = new ForceView();
scene.add(forceView.group);
const windView = new WindView();
scene.add(windView.group);

// Environment map from the sky, so the hull and sails pick up sky light.
const pmrem = new THREE.PMREMGenerator(renderer);
let envRT: THREE.WebGLRenderTarget | null = null;
let skyKey = '';
function updateSky() {
  const cloud = p.weather.cloud, fog = p.weather.fog;
  const key = `${cloud.toFixed(2)}|${fog.toFixed(2)}|${p.weather.rain.toFixed(2)}`;
  if (key === skyKey) return;
  skyKey = key;
  const u = sky.material.uniforms;
  u.turbidity.value = 2 + 12 * cloud + 6 * fog;
  u.rayleigh.value = 1.2 + 2 * cloud;
  u.mieCoefficient.value = 0.004 + 0.02 * cloud;
  u.mieDirectionalG.value = 0.8;
  sunDir.setFromSphericalCoords(1, (90 - 38) * DEG, 200 * DEG);
  u.sunPosition.value.copy(sunDir);
  sun.position.copy(sunDir).multiplyScalar(100);
  const dim = 1 - 0.65 * cloud - 0.3 * p.weather.rain;
  sun.intensity = 2.6 * dim;
  hemi.intensity = 0.7 + 0.5 * cloud;
  water.uniforms.uSunDir.value.copy(sunDir);
  (water.uniforms.uSunColor.value as THREE.Color).setRGB(dim, 0.95 * dim, 0.85 * dim);
  const grey = new THREE.Color(0xaab4bd);
  const fogCol = new THREE.Color(0xc4d2de).lerp(grey, cloud);
  (water.uniforms.uHorizon.value as THREE.Color).copy(fogCol);
  (water.uniforms.uZenith.value as THREE.Color).set(0x3a6ea5).lerp(grey, cloud * 0.8);
  (water.uniforms.uFogColor.value as THREE.Color).copy(fogCol);
  water.uniforms.uFogDensity.value = 0.0006 + 0.012 * fog * fog + 0.002 * p.weather.rain;
  scene.fog = new THREE.FogExp2(fogCol, water.uniforms.uFogDensity.value as number);
  sky.visible = fog < 0.6;
  scene.background = fogCol;
  envRT?.dispose();
  envRT = pmrem.fromScene(sky as unknown as THREE.Scene);
  scene.environment = envRT.texture;
}

// ---------- marks (anchored: show the tide setting you off) ----------
const marks: THREE.Mesh[] = [];
function placeMarks() {
  for (const m of marks) scene.remove(m);
  marks.length = 0;
  const up = towards(p.wind.fromDeg);
  const mk = (x: number, z: number, color: number) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 1.4, 16), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
    m.position.set(x, 0, z);
    scene.add(m);
    marks.push(m);
  };
  mk(up.x * 350, up.z * 350, 0xffd21f); // windward mark
  mk(-up.x * 40 + up.z * 25, -up.z * 40 - up.x * 25, 0xff6a1f); // leeward gate
  mk(-up.x * 40 - up.z * 25, -up.z * 40 + up.x * 25, 0xff6a1f);
}
placeMarks();

// ---------- ground track ----------
const MAXTRACK = 6000;
const trackGeo = new THREE.BufferGeometry();
trackGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXTRACK * 3), 3));
trackGeo.setDrawRange(0, 0);
const track = new THREE.Line(trackGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
track.frustumCulled = false;
scene.add(track);
let trackN = 0, lastTrackT = -1;
function addTrack() {
  if (sim.t - lastTrackT < 0.5) return;
  lastTrackT = sim.t;
  const arr = trackGeo.attributes.position.array as Float32Array;
  if (trackN >= MAXTRACK) { arr.copyWithin(0, 3); trackN--; }
  arr[trackN * 3] = sim.boat.pos.x; arr[trackN * 3 + 1] = 0.05; arr[trackN * 3 + 2] = sim.boat.pos.z;
  trackN++;
  trackGeo.setDrawRange(0, trackN);
  trackGeo.attributes.position.needsUpdate = true;
}
function clearTrack() { trackN = 0; lastTrackT = -1; trackGeo.setDrawRange(0, 0); }

// ---------- rain ----------
const RAIN = 4000;
const rainGeo = new THREE.BufferGeometry();
const rainPos = new Float32Array(RAIN * 6);
for (let i = 0; i < RAIN; i++) {
  const x = (Math.random() - 0.5) * 80, y = Math.random() * 40, z = (Math.random() - 0.5) * 80;
  rainPos.set([x, y, z, x, y - 0.5, z], i * 6);
}
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaabbcc, transparent: true, opacity: 0.4 }));
rain.frustumCulled = false;
scene.add(rain);
function updateRain(dt: number) {
  const r = p.weather.rain;
  rain.visible = r > 0.01;
  if (!rain.visible) return;
  const n = Math.floor(RAIN * r);
  rainGeo.setDrawRange(0, n * 2);
  const wind = [0, 0, 0];
  sim.env.wind.at(sim.boat.pos.x, 5, sim.boat.pos.z, sim.t, wind);
  for (let i = 0; i < n; i++) {
    const k = i * 6;
    let y = rainPos[k + 1] - 9 * dt;
    let x = rainPos[k] + wind[0] * dt * 0.5, z = rainPos[k + 2] + wind[2] * dt * 0.5;
    if (y < 0) { y += 40; x = (Math.random() - 0.5) * 80; z = (Math.random() - 0.5) * 80; }
    rainPos[k] = x; rainPos[k + 1] = y; rainPos[k + 2] = z;
    rainPos[k + 3] = x - wind[0] * 0.04; rainPos[k + 4] = y - 0.45; rainPos[k + 5] = z - wind[2] * 0.04;
  }
  rain.position.set(sim.boat.pos.x, 0, sim.boat.pos.z);
  rainGeo.attributes.position.needsUpdate = true;
}

// ---------- actions / GUI / HUD ----------
const actions = {
  reset: () => { sim.reset(); clearTrack(); placeMarks(); },
  rightBoat: () => sim.rightBoat(),
  startAt: (twa: number) => { sim.reset(wrap360(p.wind.fromDeg - twa)); clearTrack(); },
  trimMode: () => trim.toggle(true),
  assistChanged: () => updateHelp(),
};
const gui = buildGui(p, view, actions);
const hud = new Hud(document.body);
const dial = new PointOfSailDial(document.body);
const heel = new HeelGauge(document.body);
const layersPanel = new LayersPanel(document.body, layers, () => updateHelp());
const balancePanel = new BalancePanel(document.body);
let cameraBeforeTrim: ViewOptions['camera'] = 'orbit';
let layersBeforeTrim = { ...layers };
const trim = new TrimMode(sim, (on) => {
  document.body.classList.toggle('trim-mode', on);
  if (on) {
    // looking up the rig: flow and telltales on, the hull's centres out of the way
    gui.hide(); cameraBeforeTrim = view.camera; layersBeforeTrim = { ...layers }; view.camera = 'trim';
    layers.airflow = true; layers.telltales = true; layers.centres = false;
  } else { gui.show(); view.camera = cameraBeforeTrim; Object.assign(layers, layersBeforeTrim); }
  layersPanel.sync();
});
const help = document.createElement('div');
help.id = 'help';
function updateHelp() {
  const c = p.controls;
  const steer = c.steerAssist ? '←/→ turn the boat (it holds the course)' + (c.noGoGuard ? ', hold into the wind to tack' : '') : '←/→ tiller';
  help.innerHTML = `<b>${c.assistLevel === 'custom' ? 'Custom assists' : c.assistLevel[0].toUpperCase() + c.assistLevel.slice(1) + ' mode'}</b> (M to change) · ${steer} ·
  T tack/gybe · W/S main · Q/A jib · E/D kite · G hoist kite · B/N board · Z/X crew out/in · H auto-hike · P autopilot ·
  R right boat · L sail trim mode · C camera · Space pause · 1–5 time scale · layers: the keys on the chips above`;
}
updateHelp();
document.body.appendChild(help);

// ---------- keyboard ----------
const held = new Set<string>();
let keyRudder = false;
let pushIntoWind = 0;
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  held.add(e.code);
  const c = p.controls;
  const layer = LAYERS.find((l) => l.key === e.code);
  if (layer) { layersPanel.toggle(layer.id as LayerId); return; }
  switch (e.code) {
    case 'Space': view.paused = !view.paused; e.preventDefault(); break;
    case 'KeyG': c.gennakerHoisted = !c.gennakerHoisted; break;
    case 'KeyH': c.autoHike = !c.autoHike; c.assistLevel = 'custom'; updateHelp(); break;
    case 'KeyP': c.autopilot = !c.autopilot; if (c.autopilot) c.autopilotHeadingDeg = Math.round(sim.boat.tel.headingDeg); break;
    case 'KeyT': if (trim.active) trim.switchTack(); else requestTack(sim.boat, sim.assist, c); break;
    case 'KeyM': {
      const order: AssistLevel[] = ['easy', 'normal', 'realistic'];
      const i = order.indexOf(c.assistLevel);
      applyAssistLevel(c, order[(i + 1) % order.length]);
      updateHelp();
      break;
    }
    case 'KeyR': sim.rightBoat(); break;
    case 'KeyC':
      if (trim.active) view.camera = view.camera === 'trim' ? 'orbit' : 'trim';
      else view.camera = view.camera === 'orbit' ? 'chase' : view.camera === 'chase' ? 'top' : 'orbit';
      break;
    case 'KeyL': trim.toggle(); break;
    case 'Digit1': view.timeScale = 0.25; break;
    case 'Digit2': view.timeScale = 0.5; break;
    case 'Digit3': view.timeScale = 1; break;
    case 'Digit4': view.timeScale = 2; break;
    case 'Digit5': view.timeScale = 4; break;
  }
});
window.addEventListener('keyup', (e) => held.delete(e.code));

function applyKeys(dt: number) {
  const c = p.controls;
  const ramp = (v: number, up: string, down: string, rate: number, lo = 0, hi = 1) =>
    clamp(v + (held.has(up) ? rate * dt : 0) - (held.has(down) ? rate * dt : 0), lo, hi);
  if (trim.active) {
    // in trim mode the arrows choose the angle to the wind instead of steering
    if (held.has('ArrowLeft')) trim.nudgeTwa(-20 * dt);
    if (held.has('ArrowRight')) trim.nudgeTwa(20 * dt);
  } else if (c.steerAssist && (held.has('ArrowLeft') || held.has('ArrowRight'))) {
    // steer by course: the boat turns at a steady rate while you hold, and holds the course when you let go
    const dir = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
    if (!c.autopilot || c.autopilotMode !== 'heading') { c.autopilotHeadingDeg = Math.round(sim.boat.tel.headingDeg); }
    c.autopilot = true; c.autopilotMode = 'heading';
    const t = sim.boat.tel;
    const before = Math.abs(wrap180(t.twdDeg - c.autopilotHeadingDeg));
    c.autopilotHeadingDeg = wrap360(c.autopilotHeadingDeg + dir * 35 * dt);
    const after = Math.abs(wrap180(t.twdDeg - c.autopilotHeadingDeg));
    // keep pushing into the wind at the edge of the no-go zone → tack
    if (c.noGoGuard && after < before && after < NO_GO_DEG + 1.5) {
      pushIntoWind += dt;
      if (pushIntoWind > 0.6) { requestTack(sim.boat, sim.assist, c); pushIntoWind = 0; held.delete('ArrowLeft'); held.delete('ArrowRight'); }
    } else pushIntoWind = 0;
  } else if (held.has('ArrowLeft') || held.has('ArrowRight')) {
    keyRudder = true;
    c.autopilot = false;
    c.rudderDeg = ramp(c.rudderDeg, 'ArrowRight', 'ArrowLeft', 60, -35, 35);
  } else if (keyRudder) {
    // tiller springs back to the centre when you let go of the key
    c.rudderDeg -= Math.sign(c.rudderDeg) * Math.min(Math.abs(c.rudderDeg), 50 * dt);
    if (c.rudderDeg === 0) keyRudder = false;
  }
  const manualTrim = (k: string[]) => k.some((x) => held.has(x));
  if (manualTrim(['KeyW', 'KeyS', 'KeyQ', 'KeyA', 'KeyE', 'KeyD']) && c.autoTrim) { c.autoTrim = false; c.assistLevel = 'custom'; updateHelp(); }
  c.mainsheet = ramp(c.mainsheet, 'KeyW', 'KeyS', 0.4);
  c.jibSheet = ramp(c.jibSheet, 'KeyQ', 'KeyA', 0.4);
  c.gennakerSheet = ramp(c.gennakerSheet, 'KeyE', 'KeyD', 0.4);
  c.boardDown = ramp(c.boardDown, 'KeyN', 'KeyB', 0.5);
  if (held.has('KeyZ') || held.has('KeyX')) { c.autoHike = false; c.crewOut = ramp(c.crewOut, 'KeyZ', 'KeyX', 0.6, -0.5, 1); }
}

// ---------- camera ----------
const lastCg = sim.boat.pos.clone();
controls.target.copy(lastCg);
function updateCamera(dt: number) {
  const cg = sim.boat.pos;
  const delta = cg.clone().sub(lastCg);
  lastCg.copy(cg);
  if (delta.length() > 50) delta.set(0, 0, 0); // reset jump
  // top view is north-up, like a chart; the others keep y up
  camera.up.set(0, 1, 0);
  if (view.camera === 'top') camera.up.set(0, 0, -1);
  // with an under-water layer on, you may take the camera below the surface and look up at the hull
  controls.maxPolarAngle = Math.PI * (layers.xray || layers.waterflow || layers.hullpressure ? 0.93 : 0.495);
  if (view.camera === 'orbit') {
    controls.enabled = true;
    camera.position.add(delta);
    controls.target.add(delta);
    controls.target.lerp(cg, Math.min(1, dt * 2));
  } else {
    controls.enabled = false;
    const f = towards(sim.boat.tel.headingDeg);
    if (view.camera === 'trim') {
      // behind the helm on the windward quarter, looking up the sails; turns with the boat but stays level
      const r = towards(sim.boat.tel.headingDeg + 90);
      const sd = sim.boat.side;
      const want = new THREE.Vector3(cg.x - f.x * 8.5 + r.x * sd * 3.2, 4.6, cg.z - f.z * 8.5 + r.z * sd * 3.2);
      camera.position.lerp(want, Math.min(1, dt * 2.5));
      camera.position.add(delta);
      controls.target.set(cg.x + f.x * 1.2 - r.x * sd * 0.6, 3.0, cg.z + f.z * 1.2 - r.z * sd * 0.6);
      camera.lookAt(controls.target);
      controls.update();
      return;
    }
    const want = view.camera === 'chase'
      ? new THREE.Vector3(cg.x - f.x * 11, cg.y + 4.5, cg.z - f.z * 11)
      : new THREE.Vector3(cg.x, cg.y + 45, cg.z + 0.01);
    camera.position.lerp(want, Math.min(1, dt * 3));
    camera.position.add(delta);
    controls.target.copy(cg);
    camera.lookAt(cg.x, cg.y + 1, cg.z);
  }
  controls.update();
}

// ---------- loop ----------
let last = performance.now();
let hudT = 0;
let balT = 0;
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  applyKeys(dt);
  if (!view.paused) sim.advance(dt, view.timeScale);
  updateSky();
  const b = sim.boat;
  // layers that live under the surface need to be seen through it
  const clear = layers.xray || layers.waterflow || layers.hullpressure ? 0.78 : layers.distribution || layers.vortices ? 0.5 : 0;
  water.update(sim.env.waves, sim.env.wind, sim.t, b.pos.x, b.pos.z, p.wind.speedKn, clear);
  // apparent wind at the masthead, in the boat frame, for the burgee
  const air = [0, 0, 0];
  const top = [0, 0, 0];
  b.toWorldPoint([2.6, 6.9, 0], top);
  sim.env.wind.at(top[0], top[1], top[2], sim.t, air);
  const ab = [0, 0, 0];
  b.toBodyDir([air[0] - b.vel.x, 0, air[2] - b.vel.z], ab);
  boatView.update(b, sim.t, new THREE.Vector3(ab[0], ab[1], ab[2]), p.controls.bridleLengthM,
    { sailPressure: layers.sailpressure, hullPressure: layers.hullpressure, xray: layers.xray }, sim.env);
  flowView.update(b, sim.env, sim.t, view.paused ? 0 : dt * view.timeScale, layers);
  centresView.update(b, dt, layers.centres);
  const bal = forceBalance(b);
  forceView.update(b, bal, layers, view.forceScaleN, view.paused ? 1 : dt);
  windView.update(b, sim.env, sim.t, layers.wind);
  balT += dt;
  if (balT > 0.15 || !layers.balance) { balancePanel.update(b, bal, balT, layers.balance); balT = 0; }
  heel.update(b, p.controls.heelTargetDeg, dt);
  trim.update(dt);
  for (const m of marks) m.position.y = sim.env.waves.elevation(m.position.x, m.position.z, sim.t) + 0.35;
  track.visible = view.showTrack;
  if (!view.paused) addTrack();
  updateRain(view.paused ? 0 : dt);
  updateCamera(dt);
  hudT += dt;
  if (hudT > 0.1) { hudT = 0; hud.update(sim, view.timeScale, view.paused); dial.update(sim); }
  renderer.render(scene, camera);
  labels.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labels.setSize(window.innerWidth, window.innerHeight);
});

// handy for poking at the physics from the browser console
(window as unknown as { sim: Simulation }).sim = sim;
(window as unknown as { three: unknown }).three = { camera, controls, view, layers, layersPanel, flowView, forceView, boatView };
(window as unknown as { balance: unknown }).balance = () => forceBalance(sim.boat);
