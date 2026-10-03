// Agent City — a cyberpunk skyline that wakes up while coding agents run.
// Each harness owns a district; each live session raises a megatower whose height
// tracks the tokens it has burned; subagents orbit their parent as satellite towers.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const Q = new URLSearchParams(location.search);
const DEMO = Q.has('demo');
const FPS = +Q.get('fps') || 30;
const RES = +Q.get('res') || Math.min(devicePixelRatio, 1.25);
const RAIN = Q.get('rain') !== '0';
const LABELS = Q.get('labels') !== '0';
document.documentElement.style.setProperty('--pad', (Q.get('pad') ?? 110) + 'px');

// ------------------------------------------------------------------ harnesses
const HARNESS = {
  claude:   { name: 'CLAUDE CODE', color: '#ff7a45', d: 0 },
  codex:    { name: 'CODEX',       color: '#27e8ff', d: 1 },
  hermes:   { name: 'HERMES',      color: '#b86bff', d: 2 },
  gemini:   { name: 'GEMINI',      color: '#4d7dff', d: 3 },
  copilot:  { name: 'COPILOT',     color: '#ff4fd8', d: 4 },
  pi:       { name: 'PI',          color: '#b6ff3b', d: 5 },
  opencode: { name: 'OPENCODE',    color: '#ffd23f', d: 6 },
  cursor:   { name: 'CURSOR',      color: '#dfe4ff', d: 7 },
  aider:    { name: 'AIDER',       color: '#3dff9a', d: 8 },
  amp:      { name: 'AMP',         color: '#ff3b5c', d: 9 },
  droid:    { name: 'DROID',       color: '#ff9f1c', d: 8 },
  goose:    { name: 'GOOSE',       color: '#9fd3ff', d: 9 },
  crush:    { name: 'CRUSH',       color: '#ff66aa', d: 9 },
};
const harness = (h) => HARNESS[h] || { name: h.toUpperCase(), color: '#ffffff', d: 9 };
// The city is split into one pie-slice district per installed harness (collector's
// `installed`); one harness owns the whole city. ND caps the slices.
const ND = 10;
const DISTRICTS_OVERRIDE = Q.get('districts')?.split(',').filter(Boolean);

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(RES);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const FOG = new THREE.Color('#0b0618');
scene.background = FOG.clone();
scene.fog = new THREE.FogExp2(FOG.clone(), 0.0058);
const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 1, 2000);
const CAM = { yaw: 0.62, pitch: 0.43, r: 245, target: new THREE.Vector3(0, 8, 0) };

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.4, 0.42);
composer.addPass(bloom);
composer.addPass(new OutputPass());
const finalPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAb: { value: 0.0035 }, uRes: { value: new THREE.Vector2() }, uGrain: { value: Q.get('grain') === '0' ? 0 : 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uAb; uniform vec2 uRes; uniform float uGrain; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5;
      float ab = uAb * (0.2 + dot(d,d) * 2.0);
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + d * ab).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - d * ab).b;
      float vig = smoothstep(0.95, 0.25, length(d * vec2(1.0, 1.25)));
      c *= mix(0.55, 1.0, vig);
      c += (h(vUv * uRes + fract(uTime) * 91.7) - 0.5) * 0.018 * uGrain;   // film grain (grain=0 for recordings)
      c *= 0.985 + 0.015 * sin(vUv.y * uRes.y * 1.2);
      gl_FragColor = vec4(c, 1.0);
    }`,
});
composer.addPass(finalPass);

// ------------------------------------------------------------------ shared GLSL
const GLSL_COMMON = `
  float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
  uniform vec3 uFogColor; uniform float uFogDensity;
  vec3 applyFog(vec3 c, float depth){ float f = 1.0 - exp(-uFogDensity*uFogDensity*depth*depth); return mix(c, uFogColor, f); }
`;
const fogUniforms = { uFogColor: { value: FOG }, uFogDensity: { value: 0.0058 } };
const U = {
  uTime: { value: 0 },
  uGlobal: { value: 0.03 },
  uLevels: { value: new Array(ND + 1).fill(0.03) },
  uColors: { value: Array.from({ length: ND + 1 }, () => new THREE.Color('#ff3df2')) },
  uDistPos: { value: Array.from({ length: ND }, () => new THREE.Vector2(1e5, 1e5)) },
  ...fogUniforms,
};

// ------------------------------------------------------------------ city layout
const P = 8, ROAD = 2.0, HB = 19;          // block pitch, road width, half-extent in blocks
const rng = mulberry32(1337);
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

let districts = [];
let districtOrder = [];
const dIdx = (h) => Math.max(0, districtOrder.indexOf(h));
const wrapDeg = (a) => ((a + 540) % 360) - 180;
// bearing (degrees) of a ground point relative to the camera's line of sight; 0 = nearest the viewer
const bearingOf = (x, z) => wrapDeg((Math.atan2(x, z) - CAM.yaw) * 180 / Math.PI);

// ------------------------------------------------------------------ generic buildings
const BUILDING_VERT = `
  ${GLSL_COMMON}
  #ifdef TOWER
    uniform float uTLevel; uniform vec3 uTColor; uniform float uTSeed; uniform float uTScan;
  #else
    attribute float aSeed; attribute float aDistrict; attribute float aInfl;
    uniform float uLevels[${ND + 1}]; uniform vec3 uColors[${ND + 1}]; uniform float uGlobal;
  #endif
  varying vec2 vFaceUv; varying float vFace; varying float vHalfW; varying float vH;
  varying float vLevel; varying vec3 vTint; varying float vSeed; varying float vDepth; varying float vBaseY;
  void main(){
    vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vec3 lp = position * sc;
    if (abs(normal.y) > 0.5) { vFaceUv = lp.xz; vFace = 2.0; vHalfW = sc.x * 0.5; }
    else if (abs(normal.x) > 0.5) { vFaceUv = vec2(lp.z * sign(normal.x), lp.y); vFace = normal.x > 0. ? 0. : 3.; vHalfW = sc.z * 0.5; }
    else { vFaceUv = vec2(-lp.x * sign(normal.z), lp.y); vFace = normal.z > 0. ? 1. : 4.; vHalfW = sc.x * 0.5; }
    vH = sc.y;
    vBaseY = instanceMatrix[3].y;
    #ifdef TOWER
      vLevel = uTLevel; vTint = uTColor; vSeed = uTSeed;
    #else
      int d = int(aDistrict + 0.5);
      vLevel = mix(uGlobal, uLevels[d], aInfl);
      vTint = d == 0 ? mix(vec3(1.0,0.16,0.75), vec3(0.1,0.85,1.0), step(0.5, fract(aSeed * 7.13))) : uColors[d];
      vSeed = aSeed;
    #endif
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const BUILDING_FRAG = `
  ${GLSL_COMMON}
  uniform float uTime;
  #ifdef TOWER
    uniform float uTScan;
  #endif
  varying vec2 vFaceUv; varying float vFace; varying float vHalfW; varying float vH;
  varying float vLevel; varying vec3 vTint; varying float vSeed; varying float vDepth; varying float vBaseY;
  void main(){
    vec3 wall = vec3(0.010, 0.011, 0.020) + vec3(0.006, 0.004, 0.012) * (vFaceUv.y / max(vH, 1.0));
    vec3 col = wall;
    if (vFace > 1.5 && vFace < 2.5) {
      // roof: dark slab, a few rooftop lights, aviation blinkers on tall ones
      col = vec3(0.012, 0.012, 0.022);
      float rr = hash13(vec3(floor(vFaceUv * 2.0), vSeed * 91.));
      col += step(0.93, rr) * vec3(1.0, 0.8, 0.55) * 0.35 * (0.3 + vLevel);
      float tall = step(14.0, vH + vBaseY);
      float blink = step(0.5, fract(uTime * 0.7 + vSeed * 3.1));
      col += tall * blink * smoothstep(0.35, 0.0, length(vFaceUv)) * vec3(3.0, 0.15, 0.1);
      float rim = smoothstep(0.14, 0.0, vHalfW - max(abs(vFaceUv.x), abs(vFaceUv.y)));
      col += rim * vTint * (0.1 + 1.6 * vLevel * vLevel) * step(vSeed, 0.4);
      gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      return;
    }
    #ifdef TOWER
      vec2 cell = vec2(0.42, 0.52);
    #else
      vec2 cell = vec2(0.55, 0.72);
    #endif
    vec2 g = (vFaceUv + vec2(64.0, vBaseY)) / cell;
    vec2 id = floor(g); vec2 f = fract(g);
    float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.24, f.y) * step(f.y, 0.78);
    win *= step(0.45, vFaceUv.y) * step(vFaceUv.y, vH - 0.35);
    win *= step(0.12, vHalfW - abs(vFaceUv.x));
    float r = hash13(vec3(id, vSeed * 37.0 + vFace));
    float r2 = hash13(vec3(id.yx, vSeed * 11.0 + 3.0));
    float floorR = hash13(vec3(id.y, vSeed * 5.0, vFace));
    #ifdef TOWER
      float frac = mix(0.12, 0.8, vLevel);
    #else
      float frac = mix(0.05, 0.46, vLevel);
    #endif
    float lit = step(r, frac * (0.55 + 0.9 * floorR));
    float flick = step(0.992, hash13(vec3(id, floor(uTime * 0.6 + r2 * 40.0))));
    lit = abs(lit - flick * step(0.25, vLevel));
    vec3 warm = vec3(1.0, 0.66, 0.36), cool = vec3(0.5, 0.72, 1.0), white = vec3(0.92, 0.94, 1.0);
    vec3 wc = r2 < 0.42 ? warm : (r2 < 0.78 ? cool : white);
    wc = mix(wc, vTint, clamp(0.25 + 0.5 * vLevel, 0.0, 1.0) * step(0.55, r2));
    float wI = (0.75 + 0.8 * vLevel) * (0.5 + 0.5 * r2);
    col += win * lit * wc * wI;
    col += win * (1.0 - lit) * vec3(0.016, 0.02, 0.04);
    // neon trim on corners + crown
    float edge = vHalfW - abs(vFaceUv.x);
    float top = vH - vFaceUv.y;
    #ifdef TOWER
      float trimOn = 1.0;
      float strip = smoothstep(0.09, 0.0, abs(vFaceUv.x)) * step(0.5, vFaceUv.y);
      float scanY = fract(uTScan) * vH;
      float scan = smoothstep(1.4, 0.0, abs(vFaceUv.y - scanY)) * step(0.3, vLevel);
      col += (strip * (0.3 + 1.4 * vLevel) + scan * 1.2) * vTint;
      col += win * lit * scan * vTint * 0.8;
    #else
      float trimOn = step(vSeed, 0.33);
    #endif
    float trim = (smoothstep(0.1, 0.0, edge) * 0.8 + smoothstep(0.16, 0.0, top)) * trimOn;
    col += trim * vTint * (0.06 + 1.5 * vLevel * vLevel);
    // street-level glow bleeding up the facade
    col += vTint * 0.06 * vLevel * smoothstep(3.0, 0.0, vFaceUv.y + vBaseY);
    gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
  }`;

function buildingMaterial(tower = false, extra = {}) {
  return new THREE.ShaderMaterial({
    defines: tower ? { TOWER: 1 } : {},
    uniforms: tower ? { uTime: U.uTime, ...fogUniforms, ...extra } : U,
    vertexShader: BUILDING_VERT, fragmentShader: BUILDING_FRAG,
  });
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const genericGeo = boxGeo.clone();
// elevated highways (origin, unit direction); lots in their corridor stay clear
const HIGHWAYS = [
  { o: new THREE.Vector2(0, 38), d: new THREE.Vector2(1, -0.42).normalize(), y: 7.5 },
  { o: new THREE.Vector2(-40, 0), d: new THREE.Vector2(0.22, 1).normalize(), y: 10 },
];
const hwDist = (x, z, hw) => Math.abs((x - hw.o.x) * -hw.d.y + (z - hw.o.y) * hw.d.x);
const inCorridor = (x, z, pad = 0) => HIGHWAYS.some(hw => hwDist(x, z, hw) < 2.6 + pad);
const buildings = [];      // {x,z,w,d,h,y0,block}
const blockIdx = new Map(); // "bx,bz" -> [building indices]
const coreBlocks = (x, z) => Math.abs(x) <= 1 && Math.abs(z) <= 1;
function addB(x, z, w, d, h, y0, key) {
  const i = buildings.length;
  buildings.push({ x, z, w, d, h, y0 });
  if (!blockIdx.has(key)) blockIdx.set(key, []);
  blockIdx.get(key).push(i);
  return i;
}
for (let bx = -HB; bx <= HB; bx++) for (let bz = -HB; bz <= HB; bz++) {
  if (coreBlocks(bx, bz)) continue;
  const key = bx + ',' + bz;
  const cx = bx * P, cz = bz * P, inner = P - ROAD;
  const dist = Math.hypot(cx, cz);
  let bump = 1 + 1.5 * Math.exp(-((dist / 62) ** 2));
  const n = rng() < 0.16 ? 1 : rng() < 0.55 ? 2 : 3;
  const lot = inner / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (n === 3 && rng() < 0.12) continue; // occasional gap / courtyard
    const x = cx - inner / 2 + lot * (i + 0.5), z = cz - inner / 2 + lot * (j + 0.5);
    const w = lot * (0.72 + rng() * 0.2), d = lot * (0.72 + rng() * 0.2);
    if (inCorridor(x, z, Math.max(w, d) * 0.72)) continue;
    let h = (1.6 + Math.pow(rng(), 2.3) * (n === 1 ? 20 : 12)) * bump;
    if (rng() < 0.015 * bump) h *= 2.2;          // rare needles
    h = Math.min(h, 42);
    addB(x, z, w, d, h, 0, key);
    if (h > 12 && rng() < 0.45) {                   // setback crown
      const s = 0.55 + rng() * 0.2, h2 = h * (0.15 + rng() * 0.35);
      addB(x, z, w * s, d * s, h2, h, key);
    }
  }
}
const NB = buildings.length;
const aSeed = new Float32Array(NB), aDistrict = new Float32Array(NB), aInfl = new Float32Array(NB);
buildings.forEach((b, i) => { aSeed[i] = rng(); });
genericGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
genericGeo.setAttribute('aDistrict', new THREE.InstancedBufferAttribute(aDistrict, 1));
genericGeo.setAttribute('aInfl', new THREE.InstancedBufferAttribute(aInfl, 1));
const city = new THREE.InstancedMesh(genericGeo, buildingMaterial(false), NB);
city.frustumCulled = false;
const suppress = new Map(); // block key -> {v, target}
function writeBuilding(i, k = 1) {
  const b = buildings[i], e = city.instanceMatrix.array, o = i * 16;
  const h = Math.max(b.h * k, 0.0001);
  e.set([b.w, 0, 0, 0, 0, h, 0, 0, 0, 0, b.d, 0, b.x, b.y0 * k, b.z, 1], o);
}
for (let i = 0; i < NB; i++) writeBuilding(i);
scene.add(city);

// Split the city into equal slices, one per harness. Slice k is centred on bearing
// centre(k); with an even count a boundary runs down the line of sight so both
// front slices face the camera.
function layoutDistricts(order) {
  order = order.slice(0, ND);
  if (!order.length) order = ['claude'];
  districtOrder = order;
  const N = order.length, half = 180 / N;
  const centre = (k) => wrapDeg((N % 2 ? 0 : half) + k * 360 / N);
  const sliceOf = (x, z) => {
    const b = bearingOf(x, z);
    let best = 0, bd = 1e9;
    for (let k = 0; k < N; k++) { const d = Math.abs(wrapDeg(b - centre(k))); if (d < bd) { bd = d; best = k; } }
    return { k: best, edge: N > 1 ? (half - bd) * Math.PI / 180 * Math.hypot(x, z) : 1e9 };
  };
  const R = 6.2 * P;
  districts = order.map((h, k) => {
    const a = CAM.yaw + centre(k) * Math.PI / 180;
    const x = Math.sin(a) * R, z = Math.cos(a) * R;
    const slots = [];
    for (let bx = -HB + 2; bx <= HB - 2; bx++) for (let bz = -HB + 2; bz <= HB - 2; bz++) {
      if (Math.abs(bx) <= 1 && Math.abs(bz) <= 1) continue;
      if (inCorridor(bx * P, bz * P, 4.5)) continue;
      const sl = sliceOf(bx * P, bz * P);
      if (sl.k !== k || sl.edge < P * 0.9) continue;      // keep towers off the border
      slots.push({ bx, bz, d: Math.hypot(bx * P - x, bz * P - z) + rng() * 0.01, owner: null });
    }
    slots.sort((p, q) => p.d - q.d);
    slots.length = Math.min(slots.length, 48);
    return { i: k, h, x, z, slots, level: 0.03, color: new THREE.Color(harness(h).color) };
  });
  for (let k = 0; k < ND; k++) {
    U.uDistPos.value[k].set(k < N ? districts[k].x : 1e5, k < N ? districts[k].z : 1e5);
    U.uLevels.value[k + 1] = 0.03;
  }
  // every building belongs to a slice; it glows fully inside and fades near the borders
  // and towards the outskirts
  buildings.forEach((b, i) => {
    const sl = sliceOf(b.x, b.z), d = districts[sl.k];
    aDistrict[i] = sl.k + 1;
    const edge = Math.min(1, Math.max(0, sl.edge / 10));
    aInfl[i] = edge * (0.45 + 0.55 * Math.exp(-(((b.x - d.x) ** 2 + (b.z - d.z) ** 2) / (58 * 58))));
  });
  genericGeo.attributes.aDistrict.needsUpdate = true;
  genericGeo.attributes.aInfl.needsUpdate = true;
}

function setBlockSuppressed(bx, bz, on) {
  const key = bx + ',' + bz;
  const s = suppress.get(key) || { v: 0, target: 0 };
  s.target = on ? 1 : 0;
  suppress.set(key, s);
}
function updateSuppression(dt) {
  let dirty = false;
  for (const [key, s] of suppress) {
    if (s.v === s.target) continue;
    s.v = s.target > s.v ? Math.min(1, s.v + dt * 0.8) : Math.max(0, s.v - dt * 0.35);
    const k = 1 - easeInOut(s.v);
    for (const i of blockIdx.get(key) || []) writeBuilding(i, k);
    dirty = true;
  }
  if (dirty) city.instanceMatrix.needsUpdate = true;
}
const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

// ------------------------------------------------------------------ ground
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1400, 1400).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    uniforms: { ...U, uP: { value: P }, uRoad: { value: ROAD } },
    vertexShader: `varying vec3 vW; varying float vDepth;
      void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; vec4 mv = viewMatrix * w; vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      ${GLSL_COMMON}
      uniform float uP; uniform float uRoad; uniform float uTime; uniform float uGlobal;
      uniform vec2 uDistPos[${ND}]; uniform float uLevels[${ND + 1}]; uniform vec3 uColors[${ND + 1}];
      varying vec3 vW; varying float vDepth;
      void main(){
        vec2 p = vW.xz;
        vec2 q = mod(p + uP * 0.5, uP) - uP * 0.5;
        vec2 dr = uP * 0.5 - abs(q);                  // distance to road centre-line (per axis)
        float hw = uRoad * 0.5;
        float onRoad = max(step(dr.x, hw), step(dr.y, hw));
        vec3 tint = mix(vec3(1.0,0.2,0.8), vec3(0.1,0.8,1.0), 0.5 + 0.5 * sin(p.x * 0.01 + p.y * 0.013)) * uGlobal * 0.5;
        for (int i = 0; i < ${ND}; i++) {
          vec2 d = p - uDistPos[i];
          tint += uColors[i + 1] * uLevels[i + 1] * exp(-dot(d, d) / (30.0 * 30.0));
        }
        vec3 col = mix(vec3(0.006, 0.005, 0.012), vec3(0.014, 0.013, 0.024), onRoad);
        float curb = max(smoothstep(0.09, 0.0, abs(dr.x - hw)), smoothstep(0.09, 0.0, abs(dr.y - hw)));
        col += curb * tint * 1.0;
        float lane = max(smoothstep(0.05, 0.0, dr.x) * step(0.5, fract(p.y * 0.3)), smoothstep(0.05, 0.0, dr.y) * step(0.5, fract(p.x * 0.3)));
        col += lane * vec3(0.5, 0.45, 0.35) * (0.05 + 0.25 * uGlobal);
        float wet = hash13(vec3(floor(p * 3.0), 1.0));
        col += onRoad * tint * (0.03 + 0.06 * step(0.8, wet));
        float cityMask = step(abs(p.x), ${(HB + 0.5) * P}.0) * step(abs(p.y), ${(HB + 0.5) * P}.0);
        col *= mix(0.3, 1.0, cityMask);
        gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      }`,
  })
);
scene.add(ground);

// ------------------------------------------------------------------ additive helpers
const additive = (color, opacity = 1) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
});
const beamMat = (color) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: new THREE.Color(color) }, uI: { value: 0 }, uTime: U.uTime },
  vertexShader: `varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uI; uniform float uTime; varying float vY;
    void main(){ float a = pow(1.0 - vY, 3.0) * uI * (0.75 + 0.25 * sin(uTime * 4.0 - vY * 40.0));
      gl_FragColor = vec4(uColor * a * 0.9, a); }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);

// ------------------------------------------------------------------ labels
function makeLabel(w = 512, h = 150) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, sizeAttenuation: false, fog: false }));
  sp.renderOrder = 10;
  sp.center.set(0.5, 0);
  return { c, ctx: c.getContext('2d'), tex, sp, key: '' };
}
function drawTag(L, color, top, mid, bot, state) {
  const key = [color, top, mid, bot, state].join('|');
  if (key === L.key) return;
  L.key = key;
  const { ctx, c } = L; const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const x0 = 26, y0 = 10, bw = W - 52, bh = H - 30;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x0 + bw - 18, y0); ctx.lineTo(x0 + bw, y0 + 18); ctx.lineTo(x0 + bw, y0 + bh);
  ctx.lineTo(x0 + 18, y0 + bh); ctx.lineTo(x0, y0 + bh - 18); ctx.closePath();
  ctx.fillStyle = 'rgba(6,4,16,0.72)'; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.shadowColor = color; ctx.shadowBlur = 16; ctx.stroke();
  ctx.restore();
  // stem
  ctx.strokeStyle = color; ctx.globalAlpha = 0.7; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2, y0 + bh); ctx.lineTo(W / 2, H); ctx.stroke(); ctx.globalAlpha = 1;
  ctx.font = '600 25px "SF Mono", Menlo, monospace'; ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10;
  let tp = top; while (ctx.measureText(tp).width > bw - 70 && tp.length > 4) tp = tp.slice(0, -2);
  ctx.fillText(tp === top ? top : tp + '…', x0 + 20, y0 + 36);
  ctx.shadowBlur = 0;
  ctx.fillStyle = state === 'working' ? color : '#6d6a88';
  ctx.beginPath(); ctx.arc(x0 + bw - 26, y0 + 27, 7, 0, 7); ctx.fill();
  ctx.font = '600 36px "SF Mono", Menlo, monospace'; ctx.fillStyle = '#f2f6ff';
  let m = mid; while (ctx.measureText(m).width > bw - 40 && m.length > 4) m = m.slice(0, -2);
  if (m !== mid) m += '…';
  ctx.fillText(m, x0 + 20, y0 + 78);
  ctx.font = '22px "SF Mono", Menlo, monospace'; ctx.fillStyle = 'rgba(210,225,255,0.7)';
  ctx.fillText(bot, x0 + 20, y0 + 108);
  L.tex.needsUpdate = true;
}
const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));

// ------------------------------------------------------------------ core spire
const core = new THREE.Group();
{
  const mat = buildingMaterial(true, {
    uTLevel: { value: 0.1 }, uTColor: { value: new THREE.Color('#e9f0ff') }, uTSeed: { value: 0.77 }, uTScan: { value: 0 },
  });
  core.userData.mat = mat;
  const tiers = [[9, 0, 26], [6.6, 26, 22], [4.2, 48, 16], [2.2, 64, 10]];
  for (const [w, y0, h] of tiers) {
    const m = new THREE.InstancedMesh(boxGeo, mat, 1);
    m.setMatrixAt(0, new THREE.Matrix4().compose(new THREE.Vector3(0, y0, 0), new THREE.Quaternion(), new THREE.Vector3(w, h, w)));
    m.frustumCulled = false; core.add(m);
  }
  const needle = new THREE.Mesh(new THREE.BoxGeometry(0.25, 16, 0.25).translate(0, 82, 0), additive('#ffffff', 0.9));
  core.add(needle);
  core.userData.rings = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(6.5 + i * 2.2, 0.07, 6, 96), additive(i === 1 ? '#ff3df2' : '#27e8ff', 0.8));
    ring.rotation.x = Math.PI / 2; ring.position.y = 30 + i * 12;
    core.add(ring); core.userData.rings.push(ring);
  }
  const beam = new THREE.Mesh(beamGeo, beamMat('#bfe9ff'));
  beam.scale.set(0.5, 260, 0.5); beam.position.y = 74;
  core.add(beam); core.userData.beam = beam;
  if (LABELS) { const L = makeLabel(); L.sp.scale.set(0.125, 0.0366, 1); L.sp.position.set(0, 99, 0); core.add(L.sp); core.userData.label = L; }
}
scene.add(core);
const CORE_TOP = new THREE.Vector3(0, 70, 0);

// ------------------------------------------------------------------ towers
const towers = new Map(); // agent id -> Tower
class Tower {
  constructor(agent, x, z, sub, parent, slot) {
    this.id = agent.id; this.sub = sub; this.parent = parent; this.slot = slot;
    this.x = x; this.z = z;
    const H = harness(agent.harness);
    this.color = new THREE.Color(H.color); this.hex = H.color; this.hname = H.name;
    this.w = sub ? 0.95 + rng() * 0.2 : 2.7 + rng() * 0.3;
    this.h = 0; this.hTarget = 0; this.level = 0; this.alive = true; this.fade = 1;
    this.born = performance.now() / 1000; this.packetAcc = 0;
    this.mat = buildingMaterial(true, {
      uTLevel: { value: 0 }, uTColor: { value: this.color }, uTSeed: { value: rng() }, uTScan: { value: rng() },
    });
    this.group = new THREE.Group();
    this.segs = (sub ? [[1, 0.7], [0.62, 0.3]] : [[1, 0.52], [0.76, 0.3], [0.5, 0.18]]).map(([s, f]) => {
      const m = new THREE.InstancedMesh(boxGeo, this.mat, 1); m.frustumCulled = false;
      this.group.add(m); return { m, s, f };
    });
    this.antenna = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1, 0.12).translate(0, 0.5, 0), additive(this.color, 0.9));
    this.group.add(this.antenna);
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(this.w * 0.62, sub ? 0.04 : 0.07, 6, 64), additive(this.color, 0.9));
    this.ring.rotation.x = Math.PI / 2; this.group.add(this.ring);
    this.beam = new THREE.Mesh(beamGeo, beamMat(H.color));
    this.beam.scale.set(sub ? 0.12 : 0.28, 200, sub ? 0.12 : 0.28);
    this.group.add(this.beam);
    this.pad = new THREE.Mesh(new THREE.RingGeometry(this.w * 0.75, this.w * 0.85, 48).rotateX(-Math.PI / 2), additive(this.color, 0.0));
    this.pad.position.y = 0.05; this.group.add(this.pad);
    this.shock = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2), additive(this.color, 0.0));
    this.shock.position.y = 0.1; this.group.add(this.shock);
    if (LABELS && !sub) {
      this.label = makeLabel(); this.label.sp.scale.set(0.125, 0.0366, 1); this.group.add(this.label.sp);
    }
    if (sub && parent) this.link = makeLink(this.color);
    this.group.position.set(x, 0, z);
    scene.add(this.group);
    this.update(agent);
  }
  update(agent) {
    this.agent = agent;
    const t = agent.tokens || 0;
    this.hTarget = this.sub ? Math.min(30, 7 + 5 * Math.log10(1 + t / 8000)) : Math.min(78, 22 + 14 * Math.log10(1 + t / 20000));
    this.working = agent.state === 'working';
    if (this.label) {
      // session name as the headline; the project folder rides in the header
      const vague = !agent.project || agent.project === 'unknown' || agent.project === '~';
      const top = vague || agent.title === agent.project ? this.hname : `${this.hname} · ${agent.project}`;
      const title = agent.title || (vague ? null : agent.project);
      const nsub = [...towers.values()].filter(o => o.parent === this && o.alive).length;
      drawTag(this.label, this.hex, top, title || '—', `${fmt(t)} tok${nsub ? ` · ${nsub} sub` : ''}${this.working ? '' : ' · idle'}`, agent.state);
    }
  }
  kill() { this.alive = false; }
  tick(dt, time) {
    const k = 1 - Math.exp(-dt * 0.9);
    const tgt = this.alive ? this.hTarget : 0;
    this.h += (tgt - this.h) * (this.alive ? k : 1 - Math.exp(-dt * 1.6));
    const lvTarget = !this.alive ? 0 : this.working ? 0.82 + 0.14 * Math.sin(time * 2.1 + this.x) : 0.24;
    this.level += (lvTarget - this.level) * (1 - Math.exp(-dt * 2.5));
    this.mat.uniforms.uTLevel.value = this.level;
    this.mat.uniforms.uTScan.value += dt * (this.working ? 0.28 : 0.04);
    let y = 0;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (const s of this.segs) {
      const sh = Math.max(this.h * s.f, 0.001);
      m4.compose(new THREE.Vector3(0, y, 0), q, new THREE.Vector3(this.w * s.s, sh, this.w * s.s));
      s.m.setMatrixAt(0, m4); s.m.instanceMatrix.needsUpdate = true;
      y += sh;
    }
    this.top = y;
    const ah = this.sub ? 1.5 : 5.5;
    this.antenna.position.y = y; this.antenna.scale.y = Math.max(0.001, ah * Math.min(1, this.h / 6));
    this.antenna.material.opacity = 0.35 + 0.6 * (Math.sin(time * 5 + this.x) > 0.6 ? 1 : 0.2);
    this.ring.position.y = y * (this.sub ? 0.7 : 0.52) + (this.working ? Math.sin(time * 1.4 + this.z) * 2 : 0);
    this.ring.rotation.z += dt * (this.working ? 1.2 : 0.2);
    this.ring.material.opacity = 0.25 + 0.7 * this.level;
    this.beam.position.y = y + ah;
    this.beam.material.uniforms.uI.value += ((this.alive && this.working ? (this.sub ? 0.35 : 0.6) : 0) - this.beam.material.uniforms.uI.value) * (1 - Math.exp(-dt * 3));
    this.pad.material.opacity = 0.15 + 0.6 * this.level;
    // birth shockwave
    const age = time - this.born;
    if (age < 2.5) {
      const s = 1 + age * (this.sub ? 5 : 14);
      this.shock.scale.set(s, 1, s); this.shock.material.opacity = (1 - age / 2.5) * 1.2;
    } else this.shock.material.opacity = 0;
    if (this.label) this.label.sp.position.y = y + ah + 2.5;
    if (this.link) updateLink(this.link, this, this.parent, time);
    return this.alive || this.h > 0.3;
  }
  dispose() {
    scene.remove(this.group);
    this.group.traverse(o => { if (o.material) { o.material.map?.dispose(); o.material.dispose(); } if (o.geometry && o.geometry !== boxGeo && o.geometry !== beamGeo) o.geometry.dispose(); });
    if (this.link) { scene.remove(this.link.line); this.link.line.geometry.dispose(); this.link.line.material.dispose(); }
  }
}

// light bridges between subagents and their parent
const LINK_N = 40;
function makeLink(color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINK_N * 3), 3));
  const t = new Float32Array(LINK_N); for (let i = 0; i < LINK_N; i++) t[i] = i / (LINK_N - 1);
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: U.uTime, uI: { value: 0 } },
    vertexShader: `attribute float aT; varying float vT; void main(){ vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uI; varying float vT;
      void main(){ float d = step(0.6, fract(vT * 8.0 - uTime * 1.6)); gl_FragColor = vec4(uColor * (0.35 + 2.0 * d) * uI, 1.0); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.Line(g, mat); line.frustumCulled = false; scene.add(line);
  return { line };
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _p = new THREE.Vector3();
function updateLink(link, sub, parent, time) {
  const arr = link.line.geometry.attributes.position.array;
  _a.set(sub.x, sub.top ?? 0, sub.z);
  _b.set(parent.x, (parent.top ?? 0) * 0.62, parent.z);
  _c.addVectors(_a, _b).multiplyScalar(0.5); _c.y = Math.max(_a.y, _b.y) + 4;
  for (let i = 0; i < LINK_N; i++) {
    const t = i / (LINK_N - 1);
    bez(_a, _c, _b, t, _p); arr[i * 3] = _p.x; arr[i * 3 + 1] = _p.y; arr[i * 3 + 2] = _p.z;
  }
  link.line.geometry.attributes.position.needsUpdate = true;
  const target = sub.alive ? (sub.working ? 1 : 0.35) : 0;
  const u = link.line.material.uniforms.uI; u.value += (target - u.value) * 0.08;
}
function bez(a, c, b, t, out) {
  const u = 1 - t;
  return out.set(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, u * u * a.z + 2 * u * t * c.z + t * t * b.z);
}

// ------------------------------------------------------------------ packets (token flow → core)
const MAXPK = 900;
const pkGeo = new THREE.BufferGeometry();
const pkPos = new Float32Array(MAXPK * 3), pkCol = new Float32Array(MAXPK * 3), pkSize = new Float32Array(MAXPK);
pkGeo.setAttribute('position', new THREE.BufferAttribute(pkPos, 3));
pkGeo.setAttribute('color', new THREE.BufferAttribute(pkCol, 3));
pkGeo.setAttribute('aSize', new THREE.BufferAttribute(pkSize, 1));
const packets = new THREE.Points(pkGeo, new THREE.ShaderMaterial({
  uniforms: { uScale: { value: innerHeight * RES * 0.5 } },
  vertexShader: `attribute float aSize; attribute vec3 color; varying vec3 vC; uniform float uScale;
    void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.); gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * a * a * 3.0, a); }`,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
}));
packets.frustumCulled = false; scene.add(packets);
const pk = Array.from({ length: MAXPK }, () => ({ on: false, t: 0, v: 0, a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), col: new THREE.Color() }));
let pkNext = 0;
function emitPacket(from, to, color, lift = 18) {
  const p = pk[pkNext]; pkNext = (pkNext + 1) % MAXPK;
  p.on = true; p.t = 0; p.v = 0.35 + rng() * 0.25;
  p.a.copy(from); p.b.copy(to);
  p.c.addVectors(from, to).multiplyScalar(0.5); p.c.y = Math.max(from.y, to.y) + lift + rng() * 10;
  p.c.x += (rng() - 0.5) * 12; p.c.z += (rng() - 0.5) * 12;
  p.col.copy(color);
}
function tickPackets(dt) {
  for (let i = 0; i < MAXPK; i++) {
    const p = pk[i];
    if (!p.on) { pkSize[i] = 0; continue; }
    p.t += dt * p.v;
    if (p.t >= 1) { p.on = false; pkSize[i] = 0; continue; }
    bez(p.a, p.c, p.b, p.t, _p);
    pkPos[i * 3] = _p.x; pkPos[i * 3 + 1] = _p.y; pkPos[i * 3 + 2] = _p.z;
    pkCol[i * 3] = p.col.r; pkCol[i * 3 + 1] = p.col.g; pkCol[i * 3 + 2] = p.col.b;
    pkSize[i] = 1.5 * Math.sin(Math.PI * p.t) + 0.4;
  }
  pkGeo.attributes.position.needsUpdate = pkGeo.attributes.color.needsUpdate = pkGeo.attributes.aSize.needsUpdate = true;
}

// ------------------------------------------------------------------ street traffic
const MAXCARS = 2200;
const carMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), MAXCARS);
carMesh.frustumCulled = false;
const cars = [];
const EXT = (HB + 0.5) * P;
for (let i = 0; i < MAXCARS; i++) {
  const axis = rng() < 0.5 ? 0 : 1;
  const road = Math.floor(rng() * (2 * HB)) - HB + 0.5;
  const dir = rng() < 0.5 ? 1 : -1;
  const lane = dir * (0.3 + (rng() < 0.5 ? 0 : 0.38));
  const tint = rng();
  const col = tint < 0.08 ? new THREE.Color(0.2, 1.4, 1.7) : tint < 0.14 ? new THREE.Color(1.7, 0.2, 1.3)
    : dir > 0 ? new THREE.Color(1.5, 1.45, 1.35) : new THREE.Color(1.8, 0.12, 0.15);
  carMesh.setColorAt(i, col);
  cars.push({ axis, c: road * P + lane, s: (rng() * 2 - 1) * EXT, v: dir * (9 + rng() * 9), len: 0.7 + rng() * 1.1 });
}
carMesh.instanceColor.needsUpdate = true;
scene.add(carMesh);
function tickCars(dt, count) {
  const e = carMesh.instanceMatrix.array;
  for (let i = 0; i < count; i++) {
    const c = cars[i];
    c.s += c.v * dt;
    if (c.s > EXT) c.s -= 2 * EXT; else if (c.s < -EXT) c.s += 2 * EXT;
    const L = c.len * (0.8 + Math.abs(c.v) / 14), o = i * 16;
    if (c.axis === 0) e.set([L, 0, 0, 0, 0, 0.07, 0, 0, 0, 0, 0.13, 0, c.s, 0.12, c.c, 1], o);
    else e.set([0.13, 0, 0, 0, 0, 0.07, 0, 0, 0, 0, L, 0, c.c, 0.12, c.s, 1], o);
  }
  carMesh.count = count;
  carMesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------ sky traffic
const MAXFLY = 90;
const flyMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), MAXFLY);
flyMesh.frustumCulled = false;
const flyers = [];
const FLY_COLORS = ['#27e8ff', '#ff3df2', '#ffd23f', '#ffffff', '#ff7a45'].map(c => new THREE.Color(c).multiplyScalar(1.6));
for (let i = 0; i < MAXFLY; i++) {
  const axis = rng() < 0.5 ? 0 : 1, dir = rng() < 0.5 ? 1 : -1;
  flyMesh.setColorAt(i, FLY_COLORS[Math.floor(rng() * FLY_COLORS.length)]);
  flyers.push({ axis, c: (Math.floor(rng() * 2 * HB) - HB + 0.5) * P + dir * 0.8, y: 20 + Math.floor(rng() * 5) * 7, s: (rng() * 2 - 1) * EXT, v: dir * (16 + rng() * 14) });
}
flyMesh.instanceColor.needsUpdate = true;
scene.add(flyMesh);
function tickFlyers(dt, count) {
  const e = flyMesh.instanceMatrix.array;
  for (let i = 0; i < count; i++) {
    const f = flyers[i];
    f.s += f.v * dt;
    if (f.s > EXT) f.s -= 2 * EXT; else if (f.s < -EXT) f.s += 2 * EXT;
    const o = i * 16, L = 1.5;
    if (f.axis === 0) e.set([L, 0, 0, 0, 0, 0.06, 0, 0, 0, 0, 0.1, 0, f.s, f.y, f.c, 1], o);
    else e.set([0.1, 0, 0, 0, 0, 0.06, 0, 0, 0, 0, L, 0, f.c, f.y, f.s, 1], o);
  }
  flyMesh.count = count;
  flyMesh.instanceMatrix.needsUpdate = true;
}


// ------------------------------------------------------------------ elevated highways
const HW_LEN = 2 * (HB + 3) * P;
const MAXHWCARS = 1400;
const hwCarMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), MAXHWCARS);
hwCarMesh.frustumCulled = false;
const hwCars = [];
for (const hw of HIGHWAYS) {
  const ang = Math.atan2(hw.d.x, hw.d.y);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.45, HW_LEN), new THREE.MeshBasicMaterial({ color: '#07060f' }));
  deck.position.set(hw.o.x, hw.y - 0.3, hw.o.y); deck.rotation.y = ang; scene.add(deck);
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, HW_LEN), additive(side > 0 ? '#ff3df2' : '#27e8ff', 0.0));
    rail.position.set(hw.o.x + -hw.d.y * 1.7 * side, hw.y + 0.05, hw.o.y + hw.d.x * 1.7 * side); rail.rotation.y = ang;
    scene.add(rail); (hw.rails ??= []).push(rail);
  }
  for (let s = -HW_LEN / 2; s < HW_LEN / 2; s += 14) {
    const x = hw.o.x + hw.d.x * s, z = hw.o.y + hw.d.y * s;
    if (Math.hypot(x, z) < 14) continue;
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.7, hw.y - 0.5, 0.7).translate(0, (hw.y - 0.5) / 2, 0), deck.material);
    pil.position.set(x, 0, z); scene.add(pil);
  }
}
for (let i = 0; i < MAXHWCARS; i++) {
  const hw = HIGHWAYS[i % HIGHWAYS.length], dir = rng() < 0.5 ? 1 : -1;
  const lane = dir * (0.35 + Math.floor(rng() * 3) * 0.42);
  hwCarMesh.setColorAt(i, dir > 0 ? new THREE.Color(2.2, 2.1, 1.9) : new THREE.Color(2.5, 0.16, 0.2));
  hwCars.push({ hw, lane, s: (rng() - 0.5) * HW_LEN, v: dir * (16 + rng() * 10), len: 1.2 + rng() * 1.6 });
}
hwCarMesh.instanceColor.needsUpdate = true;
scene.add(hwCarMesh);
function tickHighways(dt, count, A) {
  const e = hwCarMesh.instanceMatrix.array;
  for (let i = 0; i < count; i++) {
    const c = hwCars[i], hw = c.hw;
    c.s += c.v * dt;
    if (c.s > HW_LEN / 2) c.s -= HW_LEN; else if (c.s < -HW_LEN / 2) c.s += HW_LEN;
    const dx = hw.d.x, dz = hw.d.y, px = -dz, pz = dx, L = c.len * (0.8 + Math.abs(c.v) / 16);
    e.set([dx * L, 0, dz * L, 0, 0, 0.07, 0, 0, px * 0.14, 0, pz * 0.14, 0,
      hw.o.x + dx * c.s + px * c.lane, hw.y + 0.1, hw.o.y + dz * c.s + pz * c.lane, 1], i * 16);
  }
  hwCarMesh.count = count;
  hwCarMesh.instanceMatrix.needsUpdate = true;
  for (const hw of HIGHWAYS) for (const r of hw.rails) r.material.opacity = 0.15 + 0.85 * A;
}

// ------------------------------------------------------------------ label de-overlap (screen space)
const _v = new THREE.Vector3();
function relaxLabels() {
  const items = [];
  for (const t of towers.values()) if (t.label && t.h > 2) items.push(t.label);
  if (core.userData.label) items.push(core.userData.label);
  const sy = camera.projectionMatrix.elements[5];
  for (const L of items) {
    L.sp.getWorldPosition(_v); _v.project(camera);
    L.nx = _v.x; L.ny = _v.y; L.h = L.sp.scale.y * sy; L.w = L.sp.scale.x * sy / camera.aspect; L.off = 0;
  }
  items.sort((a, b) => a.ny - b.ny);
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (let j = 0; j < i; j++) {
        const b = items[j];
        if (Math.abs(a.nx - b.nx) > (a.w + b.w) / 2) continue;
        const ay = a.ny + a.off, by = b.ny + b.off;
        if (ay < by + b.h * 1.04 && ay + a.h > by) { a.off = by + b.h * 1.04 - a.ny; moved = true; }
      }
      if (!moved) break;
    }
    const target = -a.off / a.h;
    a.sp.center.y += (target - a.sp.center.y) * 0.15;
  }
}

// ------------------------------------------------------------------ rain
let rain;
if (RAIN) {
  const N = 4500, pos = new Float32Array(N * 6), aTop = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const x = (rng() - 0.5) * 320, y = rng() * 140, z = (rng() - 0.5) * 320;
    pos.set([x, y, z, x, y, z], i * 6); aTop[i * 2] = 1; aTop[i * 2 + 1] = 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aTop', new THREE.BufferAttribute(aTop, 1));
  rain = new THREE.LineSegments(g, new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uI: { value: 0.3 } },
    vertexShader: `attribute float aTop; uniform float uTime; varying float vA;
      void main(){ vec3 p = position; p.y = mod(p.y - uTime * 70.0, 140.0) + aTop * 1.6; p.x += aTop * 0.25;
        vA = aTop; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `uniform float uI; varying float vA; void main(){ gl_FragColor = vec4(vec3(0.55, 0.65, 1.0) * uI * (0.15 + 0.6 * vA), 1.0); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  rain.frustumCulled = false; scene.add(rain);
}

// ------------------------------------------------------------------ holo signage
const SIGNS = ['ネオン', 'コード', 'エージェント', 'トークン', '未来', '夜', '東京', 'SHIP IT', 'OPUS', 'RAMEN 24H', 'NO SLEEP', 'CTX 1M', 'DEPLOY', 'ヘルメス', 'git push', 'サブエージェント'];
const signs = [];
{
  const tall = buildings.map((b, i) => ({ b, i })).filter(({ b }) => b.y0 === 0 && b.h > 16 && Math.hypot(b.x, b.z) < 120);
  for (let k = 0; k < 22 && tall.length; k++) {
    const { b } = tall.splice(Math.floor(rng() * tall.length), 1)[0];
    const text = SIGNS[k % SIGNS.length];
    const vertical = /[　-鿿]/.test(text) && text.length <= 6;
    const c = document.createElement('canvas');
    c.width = vertical ? 128 : 512; c.height = vertical ? 128 * text.length : 128;
    const ctx = c.getContext('2d');
    const col = ['#ff3df2', '#27e8ff', '#ffd23f', '#ff5a36', '#b86bff'][k % 5];
    ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.shadowColor = col; ctx.shadowBlur = 14;
    ctx.strokeRect(8, 8, c.width - 16, c.height - 16);
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (vertical) {
      ctx.font = '700 84px "Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif';
      [...text].forEach((ch, j) => ctx.fillText(ch, 64, 64 + j * 128));
    } else {
      ctx.font = '700 64px "SF Mono", Menlo, monospace';
      ctx.fillText(text, 256, 66, 470);
    }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const sw = vertical ? 1.3 : 4.2, sh = vertical ? 1.3 * text.length : 1.05;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), mat);
    const faceZ = rng() < 0.6;
    const y = Math.min(b.h - sh / 2 - 0.5, 4 + rng() * (b.h - 6));
    if (faceZ) { m.position.set(b.x + (rng() - 0.5) * (b.w - sw) * 0.6, y, b.z + b.d / 2 + 0.06); }
    else { m.position.set(b.x + b.w / 2 + 0.06, y, b.z + (rng() - 0.5) * (b.d - sw) * 0.6); m.rotation.y = Math.PI / 2; }
    scene.add(m);
    signs.push({ m, phase: rng() * 100, glitch: rng() });
  }
}
function tickSigns(time, A) {
  for (const s of signs) {
    const flick = Math.sin(time * 23 + s.phase) > 0.97 - s.glitch * 0.05 ? 0.2 : 1;
    const on = A > 0.08 ? 1 : 0.12 + 0.1 * Math.sin(time * 0.5 + s.phase);
    s.m.material.opacity = Math.min(1, (0.25 + 1.4 * A) * on * flick);
  }
}

// ------------------------------------------------------------------ state
let state = { agents: [], harnesses: {}, projects: [], working: 0, idle: 0, subagents: 0, tokensToday: 0, tpm: 0 };
let A = 0.02, shownTokens = 0, lastState = 0;
const offlineEl = document.getElementById('offline');

async function poll() {
  try {
    const s = DEMO ? demoState(performance.now() / 1000) : await (await fetch('/state', { cache: 'no-store' })).json();
    if (s && s.agents) { state = s; lastState = performance.now(); applyState(); }
    offlineEl.classList.remove('on');
  } catch { offlineEl.classList.add('on'); }
  setTimeout(poll, DEMO ? 500 : 1500);
}

// satellite lots around a parent tower, nearest-to-camera first
const SUB_OFFSETS = [[1, 1], [-1, 1], [1, -1], [0, 1], [1, 0], [-1, -1], [-1, 0], [0, -1]];
function claimSlot(d, id) {
  const free = d.slots.find(s => !s.owner);
  if (!free) return null;
  free.owner = id; setBlockSuppressed(free.bx, free.bz, true);
  return free;
}
function releaseSlot(slot) {
  if (!slot) return;
  slot.owner = null;
  setTimeout(() => {
    const taken = districts.some(d => d.slots.some(q => q.owner && q.bx === slot.bx && q.bz === slot.bz));
    if (!slot.owner && !taken) setBlockSuppressed(slot.bx, slot.bz, false);
  }, 2500);
}

function applyState() {
  const order = DISTRICTS_OVERRIDE || state.installed
    || [...new Set(['claude', ...Object.keys(state.harnesses || {})])];
  if (order.join() !== districtOrder.join() || !districts.length) {
    // new harness layout: clear the skyline and rebuild every tower in its new slice
    for (const t of towers.values()) { releaseSlot(t.slot); t.dispose(); }
    towers.clear();
    layoutDistricts(order);
  }
  const seen = new Set();
  const byId = new Map(state.agents.map(a => [a.id, a]));
  // parents first so subagents can attach
  const ordered = [...state.agents].sort((a, b) => (!!a.parent) - (!!b.parent));
  for (const a of ordered) {
    seen.add(a.id);
    let t = towers.get(a.id);
    if (t && t.alive) { t.update(a); continue; }
    const parent = a.parent && towers.get(a.parent);
    if (parent && parent.alive && parent.slot) {
      const siblings = [...towers.values()].filter(o => o.parent === parent && o.alive);
      const used = new Set(siblings.map(o => o.subIdx));
      const k = [0, 1, 2, 3, 4, 5, 6, 7].find(i => !used.has(i));
      if (k === undefined) continue;
      const [ox, oz] = SUB_OFFSETS[k];
      t = new Tower(a, parent.x + ox * 2.3, parent.z + oz * 2.3, true, parent, null);
      t.subIdx = k;
    } else {
      if (byId.has(a.parent) && !parent) continue; // parent not built yet; next poll
      const d = districts[dIdx(a.harness)];
      const slot = claimSlot(d, a.id);
      if (!slot) continue;
      t = new Tower(a, slot.bx * P, slot.bz * P, false, null, slot);
    }
    towers.set(a.id, t);
  }
  for (const [id, t] of towers) {
    if (!seen.has(id) && t.alive) { t.kill(); releaseSlot(t.slot); }
  }
  // district levels
  const lv = new Array(ND).fill(0.03);
  const col = new Array(ND).fill(null);
  for (const [h, info] of Object.entries(state.harnesses || {})) {
    const H = harness(h), d = dIdx(h);
    const v = info.working > 0 ? Math.min(1, 0.55 + 0.1 * info.working + 0.2 * Math.min(1, info.tpm / 150000))
      : info.idle > 0 ? 0.18 : info.tokensToday > 0 ? 0.07 : 0.03;
    if (v >= lv[d]) { lv[d] = v; col[d] = H.color; }
  }
  districts.forEach((d, i) => { d.levelTarget = lv[i]; if (col[i]) d.color.set(col[i]); });
  updateHud();
}

// ------------------------------------------------------------------ HUD
const $ = (id) => document.getElementById(id);
function updateHud() {
  const s = state;
  $('projects').textContent = s.projects.length;
  $('projects-s').textContent = s.projects.slice(0, 3).join(' · ') + (s.projects.length > 3 ? ' …' : '');
  const main = s.working - s.subagents;
  $('agents').textContent = s.working;
  $('agents-s').textContent = s.working ? `${main} lead${main === 1 ? '' : 's'}${s.subagents ? ` · ${s.subagents} sub` : ''}${s.idle ? ` · ${s.idle} idle` : ''}` : s.idle ? `${s.idle} idle` : 'city asleep';
  $('tokens-s').textContent = s.tpm > 0 ? `${fmt(s.tpm)} / min` : '';
  const chips = $('chips');
  const blank = { working: 0, idle: 0, tokensToday: 0 };
  const hs = [...new Set([...districtOrder, ...Object.keys(s.harnesses || {})])]
    .map(h => [h, s.harnesses?.[h] || blank]).filter(([h, v]) => districtOrder.includes(h) || v.working || v.idle || v.tokensToday);
  chips.innerHTML = hs.map(([h, v]) => {
    const H = harness(h);
    const n = v.working ? `<b>${v.working}</b>▲` : v.idle ? `${v.idle} idle` : '';
    return `<div class="chip ${v.working ? 'on' : ''}" style="--c:${H.color}"><i></i>${H.name} ${n} <span style="opacity:.6">${fmt(v.tokensToday)}</span></div>`;
  }).join('');
}

// ------------------------------------------------------------------ demo feed
const demo = { t0: null, tokens: 215_399_164, agents: new Map() };
function demoState(now) {
  if (demo.t0 === null) demo.t0 = now;
  const t = (now - demo.t0) % 120;
  const plan = [
    // id, harness, project, start, end, parent, rate(tok/s)
    ['c1', 'claude', 'agent-city', 4, 100, null, 2600],
    ['c1a', 'claude', 'lisp-interp', 9, 70, 'c1', 900], ['c1b', 'claude', 'drum-machine', 9.5, 64, 'c1', 800],
    ['c1c', 'claude', 'fractals', 10, 80, 'c1', 1000], ['c1d', 'claude', 'roguelike', 10.5, 75, 'c1', 700],
    ['c1e', 'claude', 'csv-sql', 11, 58, 'c1', 600], ['c1f', 'claude', 'namegen', 11.5, 50, 'c1', 500],
    ['x1', 'codex', 'bufo-store', 16, 95, null, 2100], ['x1a', 'codex', 'Ampere', 26, 80, 'x1', 700], ['x1b', 'codex', 'Faraday', 28, 74, 'x1', 600],
    ['h1', 'hermes', 'telegram', 22, 60, null, 800],
    ['c2', 'claude', 'iron-front', 30, 105, null, 1800],
    ['g1', 'gemini', 'sentinel', 36, 90, null, 1200],
    ['p1', 'pi', 'epoch-ii', 44, 88, null, 900],
  ];
  const agents = [];
  const hs = {};
  let working = 0, sub = 0, tpm = 0;
  for (const [id, h, proj, s, e, parent, rate] of plan) {
    if (t < s || t > e + 12) continue;
    const st = t <= e ? 'working' : 'idle';
    const tok = Math.round(rate * 40 * Math.min(t, e) - rate * 40 * s + 30000);
    agents.push({ id, harness: h, project: proj, title: parent ? proj : null, state: st, sub: !!parent, parent, tokens: tok });
    hs[h] ??= { working: 0, idle: 0, subagents: 0, tokensToday: 3_000_000, tpm: 0 };
    if (st === 'working') { hs[h].working++; working++; tpm += rate * 60; hs[h].tpm += rate * 60; if (parent) { sub++; hs[h].subagents++; } } else hs[h].idle++;
  }
  demo.tokens += tpm / 120;
  hs.claude ??= { working: 0, idle: 0, subagents: 0, tokensToday: 0, tpm: 0 };
  hs.claude.tokensToday = Math.round(demo.tokens * 0.86);
  const projects = [...new Set(agents.filter(a => a.state === 'working' && !a.sub).map(a => a.project))];
  return { installed: ['claude', 'codex', 'hermes', 'gemini', 'pi'], agents, harnesses: hs, projects, working, idle: agents.length - working, subagents: sub, tokensToday: Math.round(demo.tokens), tpm };
}

// ------------------------------------------------------------------ main loop
let lastT = performance.now();
let acc = 0, time = 0;
function frame() {
  requestAnimationFrame(frame);
  const nowT = performance.now(), dtRaw = (nowT - lastT) / 1000; lastT = nowT;
  acc += dtRaw;
  const idle = A < 0.05 && towers.size === 0;
  const minDt = 1 / (idle ? Math.min(FPS, 20) : FPS);
  if (acc < minDt * 0.95) return;
  const dt = Math.min(acc, 0.1); acc = 0; time += dt;
  U.uTime.value = time;

  // global activity
  const tgtA = state.working > 0 ? Math.min(1, 0.42 + 0.07 * state.working + 0.25 * Math.min(1, state.tpm / 300000)) : state.idle > 0 ? 0.1 : 0.02;
  A += (tgtA - A) * (1 - Math.exp(-dt * 0.8));
  U.uGlobal.value = 0.03 + 0.42 * A;
  districts.forEach((d, i) => {
    d.level += ((d.levelTarget ?? 0.03) - d.level) * (1 - Math.exp(-dt * 1.2));
    U.uLevels.value[i + 1] = d.level;
    U.uColors.value[i + 1].copy(d.color);
  });
  FOG.setRGB(0.012 + 0.02 * A, 0.006 + 0.004 * A, 0.03 + 0.03 * A, THREE.SRGBColorSpace);
  scene.background.copy(FOG); scene.fog.color.copy(FOG);
  bloom.strength = 0.42 + 0.3 * A;

  // camera: slow sway + breathing dolly
  const yaw = CAM.yaw + Math.sin(time * 0.018) * 0.2;
  const pitch = CAM.pitch + Math.sin(time * 0.013) * 0.035;
  const r = CAM.r + Math.sin(time * 0.021) * 8;
  camera.position.set(Math.sin(yaw) * Math.cos(pitch) * r, Math.sin(pitch) * r, Math.cos(yaw) * Math.cos(pitch) * r).add(CAM.target);
  camera.lookAt(CAM.target);

  updateSuppression(dt);
  for (const [id, t] of towers) {
    if (!t.tick(dt, time)) { t.dispose(); towers.delete(id); continue; }
    if (t.alive && t.working && t.h > 4) {
      const hs = state.harnesses?.[t.agent.harness];
      const share = hs && hs.working ? hs.tpm / hs.working : 20000;
      t.packetAcc += dt * (t.sub ? 0.6 : 1.2) * (0.6 + Math.min(3, share / 60000));
      while (t.packetAcc > 1) {
        t.packetAcc -= 1;
        _a.set(t.x, t.top + 1, t.z);
        if (t.sub && t.parent) emitPacket(_a, _b.set(t.parent.x, t.parent.top * 0.62, t.parent.z), t.color, 3);
        else emitPacket(_a, CORE_TOP, t.color, 22);
      }
    }
  }
  tickPackets(dt);
  tickCars(dt, Math.floor(160 + (MAXCARS - 160) * Math.min(1, A * 1.1)));
  tickFlyers(dt, Math.floor(MAXFLY * Math.min(1, Math.max(0, (A - 0.08) * 1.1))));
  tickSigns(time, A);
  tickHighways(dt, Math.floor(120 + (MAXHWCARS - 120) * Math.min(1, A * 1.1)), A);
  relaxLabels();
  if (rain) rain.material.uniforms.uI.value = 0.12 + 0.06 * A;

  // core
  const cm = core.userData.mat.uniforms;
  cm.uTLevel.value = 0.12 + 0.75 * A;
  cm.uTScan.value += dt * (0.05 + 0.3 * A);
  core.userData.rings.forEach((r, i) => { r.rotation.z += dt * (0.1 + A) * (i % 2 ? -1 : 1); r.material.opacity = 0.15 + 0.8 * A; });
  core.userData.beam.material.uniforms.uI.value = 0.06 + 0.4 * A;
  if (core.userData.label) drawTag(core.userData.label, '#e9f0ff', 'LOCALHOST', fmt(state.tokensToday) + ' tok', `${state.working} active · ${fmt(state.tpm)}/min`, state.working ? 'working' : 'idle');

  // HUD token counter eases toward the real number
  shownTokens += (state.tokensToday - shownTokens) * (1 - Math.exp(-dt * 2));
  if (Math.abs(state.tokensToday - shownTokens) < 1) shownTokens = state.tokensToday;
  $('tokens').textContent = Math.round(shownTokens).toLocaleString('en-US');

  finalPass.uniforms.uTime.value = time;
  composer.render(dt);
}

function resize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  finalPass.uniforms.uRes.value.set(innerWidth * RES, innerHeight * RES);
  packets.material.uniforms.uScale.value = innerHeight * RES * 0.5;
}
addEventListener('resize', resize);
resize();
poll();
frame();
