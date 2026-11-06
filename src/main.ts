import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Simulation } from './physics/sim';
import { DEG, clamp, towards, wrap360 } from './physics/math';
import { Water } from './render/water';
import { BoatView } from './render/boatView';
import { buildGui, type ViewOptions } from './ui/gui';
import { Hud } from './ui/hud';
import './style.css';

const sim = new Simulation();
const p = sim.params;
const view: ViewOptions = { paused: false, timeScale: 1, camera: 'orbit', showForces: false, showTrack: true, forceScaleN: 500 };

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
document.getElementById('app')!.appendChild(renderer.domElement);

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
scene.add(water.mesh);
const boatView = new BoatView();
scene.add(boatView.root);

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

// ---------- force arrows ----------
const forceDefs: Array<[keyof typeof sim.boat.tel.forces, number]> = [
  ['sails', 0xff4d4d], ['board', 0x4da6ff], ['rudder', 0x9b6bff], ['buoyancy', 0x3ddc84], ['gravity', 0xffffff], ['hull', 0xffb347],
];
const arrows = forceDefs.map(([, c]) => new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, c, 0.3, 0.15));
arrows.forEach((a) => scene.add(a));
function updateArrows() {
  arrows.forEach((a, i) => {
    a.visible = view.showForces;
    if (!view.showForces) return;
    const f = sim.boat.tel.forces[forceDefs[i][0]];
    const v = new THREE.Vector3(...f.f);
    const len = v.length() / view.forceScaleN;
    if (len < 0.02) { a.visible = false; return; }
    a.position.set(...f.at);
    a.setDirection(v.normalize());
    a.setLength(len, Math.min(0.4, len * 0.3), Math.min(0.2, len * 0.15));
  });
}

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
};
buildGui(p, view, actions);
const hud = new Hud(document.body);
const help = document.createElement('div');
help.id = 'help';
help.innerHTML = `<b>Keys</b> ←/→ rudder · W/S main · Q/A jib · E/D kite · G hoist kite · B/N board up/down · Z/X crew out/in ·
  H auto-hike · P autopilot · T tack/gybe (autopilot) · R right boat · F forces · C camera · Space pause · 1–5 time scale`;
document.body.appendChild(help);

// ---------- keyboard ----------
const held = new Set<string>();
let keyRudder = false;
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  held.add(e.code);
  const c = p.controls;
  switch (e.code) {
    case 'Space': view.paused = !view.paused; e.preventDefault(); break;
    case 'KeyG': c.gennakerHoisted = !c.gennakerHoisted; break;
    case 'KeyH': c.autoHike = !c.autoHike; break;
    case 'KeyP': c.autopilot = !c.autopilot; if (c.autopilot) c.autopilotHeadingDeg = Math.round(sim.boat.tel.headingDeg); break;
    case 'KeyT': {
      // tack or gybe through the wind onto the mirror-image TWA
      const t = sim.boat.tel;
      c.autopilot = true;
      c.autopilotHeadingDeg = Math.round(wrap360(t.headingDeg + 2 * t.twaDeg));
      break;
    }
    case 'KeyR': sim.rightBoat(); break;
    case 'KeyF': view.showForces = !view.showForces; break;
    case 'KeyC': view.camera = view.camera === 'orbit' ? 'chase' : view.camera === 'chase' ? 'top' : 'orbit'; break;
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
  if (held.has('ArrowLeft') || held.has('ArrowRight')) {
    keyRudder = true;
    c.autopilot = false;
    c.rudderDeg = ramp(c.rudderDeg, 'ArrowRight', 'ArrowLeft', 60, -35, 35);
  } else if (keyRudder) {
    // tiller springs back to the centre when you let go of the key
    c.rudderDeg -= Math.sign(c.rudderDeg) * Math.min(Math.abs(c.rudderDeg), 50 * dt);
    if (c.rudderDeg === 0) keyRudder = false;
  }
  const manualTrim = (k: string[]) => k.some((x) => held.has(x));
  if (manualTrim(['KeyW', 'KeyS', 'KeyQ', 'KeyA', 'KeyE', 'KeyD'])) c.autoTrim = false;
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
  if (view.camera === 'orbit') {
    controls.enabled = true;
    camera.position.add(delta);
    controls.target.add(delta);
    controls.target.lerp(cg, Math.min(1, dt * 2));
  } else {
    controls.enabled = false;
    const f = towards(sim.boat.tel.headingDeg);
    const want = view.camera === 'chase'
      ? new THREE.Vector3(cg.x - f.x * 11, cg.y + 4.5, cg.z - f.z * 11)
      : new THREE.Vector3(cg.x + 0.01, cg.y + 45, cg.z);
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
function frame(now: number) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  applyKeys(dt);
  if (!view.paused) sim.advance(dt, view.timeScale);
  updateSky();
  const b = sim.boat;
  water.update(sim.env.waves, sim.env.wind, sim.t, b.pos.x, b.pos.z, p.wind.speedKn);
  // apparent wind at the masthead, in the boat frame, for the burgee
  const air = [0, 0, 0];
  const top = [0, 0, 0];
  b.toWorldPoint([2.6, 6.9, 0], top);
  sim.env.wind.at(top[0], top[1], top[2], sim.t, air);
  const ab = [0, 0, 0];
  b.toBodyDir([air[0] - b.vel.x, 0, air[2] - b.vel.z], ab);
  boatView.update(b, sim.t, new THREE.Vector3(ab[0], ab[1], ab[2]), p.controls.bridleLengthM);
  for (const m of marks) m.position.y = sim.env.waves.elevation(m.position.x, m.position.z, sim.t) + 0.35;
  track.visible = view.showTrack;
  if (!view.paused) addTrack();
  updateArrows();
  updateRain(view.paused ? 0 : dt);
  updateCamera(dt);
  hudT += dt;
  if (hudT > 0.1) { hudT = 0; hud.update(sim, view.timeScale, view.paused); }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// handy for poking at the physics from the browser console
(window as unknown as { sim: Simulation }).sim = sim;
