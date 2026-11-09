import * as THREE from 'three';
import type { WaveField } from '../physics/waves';
import type { WindField } from '../physics/environment';

export const MAX_WAVES = 16;

/**
 * Ocean surface displaced on the GPU by exactly the same wave components the physics uses,
 * so what you see is what the hull feels. Gust patches from the wind field darken the water.
 */
const vert = /* glsl */ `
  #define MAXW ${MAX_WAVES}
  uniform vec4 uWave[MAXW];   // kx, kz, amp, phaseNow
  uniform int uCount;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vSlope;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    float eta = 0.0, dx = 0.0, dz = 0.0;
    for (int i = 0; i < MAXW; i++) {
      if (i >= uCount) break;
      vec4 w = uWave[i];
      float th = w.x * wp.x + w.y * wp.z + w.w;
      eta += w.z * cos(th);
      float s = -w.z * sin(th);
      dx += s * w.x;
      dz += s * w.y;
    }
    wp.y += eta;
    vNormal = normalize(vec3(-dx, 1.0, -dz));
    vSlope = length(vec2(dx, dz));
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const frag = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec4 uGust[4];      // kx, kz, phaseNow, _
  uniform float uGustAmp;
  uniform float uRipple;
  uniform vec2 uBoat;
  uniform float uClear;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vSlope;

  float gust(vec2 p) {
    float g = 0.0;
    for (int i = 0; i < 4; i++) g += sin(uGust[i].x * p.x + uGust[i].y * p.y + uGust[i].z);
    return g / sqrt(2.0);
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  void main() {
    vec3 n = normalize(vNormal);
    float g = gust(vWorld.xz);
    // wind ripples: micro-normal noise, stronger in gusts
    float rip = uRipple * (1.0 + 0.6 * g * uGustAmp);
    vec2 cell = floor(vWorld.xz * 3.0);
    n = normalize(n + rip * 0.06 * vec3(hash(cell) - 0.5, 0.0, hash(cell + 7.0) - 0.5));
    vec3 v = normalize(cameraPosition - vWorld);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    vec3 r = reflect(-v, n);
    vec3 sky = mix(uHorizon, uZenith, clamp(r.y * 1.6, 0.0, 1.0));
    vec3 body = mix(uDeep, uShallow, clamp(0.5 + 0.5 * n.y - 0.4, 0.0, 1.0));
    // gusts read as darker patches, like on the real water
    body *= 1.0 - 0.18 * clamp(g * uGustAmp, -1.0, 1.0);
    vec3 col = mix(body, sky, fres);
    float spec = pow(max(dot(r, uSunDir), 0.0), 220.0);
    col += spec * uSunColor * 1.4;
    // whitecaps on steep crests
    float foam = smoothstep(0.32, 0.55, vSlope + 0.05 * hash(cell * 1.7));
    col = mix(col, vec3(0.92), foam * 0.7);
    float d = length(cameraPosition - vWorld);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
    col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
    // layers that live under the surface: let the water go glassy round the boat
    float a = 1.0 - uClear * (1.0 - smoothstep(3.5, 9.0, distance(vWorld.xz, uBoat)));
    gl_FragColor = vec4(col, a);
  }
`;

/** Non-uniform grid: ~0.5 m spacing under the boat, stretching to kilometres at the edge. */
function buildGrid(N = 384, R = 1500, a = 0.06): THREE.BufferGeometry {
  const map = (u: number) => R * (a * u + (1 - a) * u ** 5);
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  let k = 0;
  for (let j = 0; j <= N; j++) {
    const z = map((j / N) * 2 - 1);
    for (let i = 0; i <= N; i++) {
      pos[k++] = map((i / N) * 2 - 1);
      pos[k++] = 0;
      pos[k++] = z;
    }
  }
  const idx = new Uint32Array(N * N * 6);
  k = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a0 = j * (N + 1) + i, a1 = a0 + 1, b0 = a0 + N + 1, b1 = b0 + 1;
      idx[k++] = a0; idx[k++] = b0; idx[k++] = a1;
      idx[k++] = a1; idx[k++] = b0; idx[k++] = b1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 2);
  return geo;
}

export class Water {
  mesh: THREE.Mesh;
  /** Dark water below, seen only when the surface is made glassy for the under-water layers. */
  deep: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;

  constructor() {
    this.uniforms = {
      uWave: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
      uCount: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uZenith: { value: new THREE.Color(0x3a6ea5) },
      uHorizon: { value: new THREE.Color(0xb8c8d8) },
      uDeep: { value: new THREE.Color(0x0b2a3a) },
      uShallow: { value: new THREE.Color(0x1f5f6a) },
      uFogColor: { value: new THREE.Color(0xb8c8d8) },
      uFogDensity: { value: 0.0008 },
      uGust: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
      uGustAmp: { value: 0.3 },
      uRipple: { value: 1 },
      uBoat: { value: new THREE.Vector2() },
      uClear: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms });
    this.mesh = new THREE.Mesh(buildGrid(), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.deep = new THREE.Mesh(new THREE.CircleGeometry(16, 48), new THREE.MeshBasicMaterial({ color: 0x0a2733, fog: false }));
    this.deep.rotation.x = -Math.PI / 2;
    this.deep.visible = false;
  }

  /** Push the current wave/gust state; phases are folded on the CPU in double precision. */
  update(waves: WaveField, wind: WindField, t: number, centerX: number, centerZ: number, windKn: number, clear = 0) {
    (this.uniforms.uBoat.value as THREE.Vector2).set(centerX, centerZ);
    this.uniforms.uClear.value = clear;
    const mat = this.mesh.material as THREE.ShaderMaterial;
    // glassy, and drawn from underneath too, so the camera can go below and look up at the hull
    if (mat.transparent !== clear > 0) { mat.transparent = clear > 0; mat.depthWrite = clear === 0; mat.side = clear > 0 ? THREE.DoubleSide : THREE.FrontSide; mat.needsUpdate = true; }
    this.deep.visible = clear > 0;
    this.deep.position.set(centerX, -2.6, centerZ);
    const snap = 0.5;
    this.mesh.position.set(Math.round(centerX / snap) * snap, 0, Math.round(centerZ / snap) * snap);
    const arr = this.uniforms.uWave.value as THREE.Vector4[];
    const n = Math.min(waves.comps.length, MAX_WAVES);
    for (let i = 0; i < n; i++) {
      const c = waves.comps[i];
      const ph = (c.phase - c.omega * t) % (2 * Math.PI);
      arr[i].set(c.kx, c.kz, c.amp, ph);
    }
    this.uniforms.uCount.value = n;
    const g = this.uniforms.uGust.value as THREE.Vector4[];
    wind.gusts.forEach((c, i) => {
      // same formula as WindField.gust: sin(k·(x − U t) + w t + φ)
      const ph = (-(c.kx * wind.meanVel.x + c.kz * wind.meanVel.z) * t + c.w * t + c.phi) % (2 * Math.PI);
      g[i].set(c.kx, c.kz, ph, 0);
    });
    this.uniforms.uGustAmp.value = wind.p.gustiness * 1.5;
    this.uniforms.uRipple.value = Math.min(2, windKn / 10);
  }
}
