// Offline cook of the people (`npm run cook:people`): MakeHuman bodies (CC0) dressed in MakeHuman clothes (CC0),
// skinned to the game_engine rig reduced to 23 bones, with the Microsoft Rocketbox captures (MIT) retargeted onto
// each body and baked as bone palettes. Output: `public/cooked/people/people.bin` + `people.json` (versioned).
//
// Nothing here depends on the game's state. Node does the whole cook; only the WebP textures are decoded by
// Electron (`tools/cook-people-decode.cjs`), once, into `test-results/cook-cache/`.
//
//   node tools/cook-people.mjs            cook
//   node tools/cook-people.mjs --preview  cook and draw every variation to test-results/cook-preview/*.png
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';

/** Bump whenever the output changes meaning; `src/render/people/format.ts` must carry the same number. */
export const COOK_VERSION = 2;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public', 'models', 'people');
const MOTION = path.join(ROOT, 'public', 'models', 'citizens');
const OUT = path.join(ROOT, 'public', 'cooked', 'people');
const CACHE = path.join(ROOT, 'test-results', 'cook-cache');
const PREVIEW = process.argv.includes('--preview');

// ------------------------------------------------------------------------------------------------ small maths
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };
const QI = [0, 0, 0, 1];
function qrot(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
function qFromUnit(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) { const ax = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]); return qnorm([...norm(ax), 0]); }
  const c = cross(a, b);
  return qnorm([c[0], c[1], c[2], 1 + d]);
}
const qAxis = (axis, ang) => { const s = Math.sin(ang / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)]; };
function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d *= s;
  if (d > 0.9995) return qnorm(a.map((v, i) => v + (b[i] * s - v) * t));
  const th = Math.acos(d), sa = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / sa, wb = (Math.sin(t * th) / sa) * s;
  return a.map((v, i) => v * wa + b[i] * wb);
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));

/** Deterministic random numbers (mulberry32). */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------------------------------------ assets
const json = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const bin = (p) => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const baseMeta = json(path.join(SRC, 'base.json'));
const baseBuf = bin(path.join(SRC, 'base.bin'));
const section = (name) => baseMeta.sections.find((s) => s.name === name);
const NV = baseMeta.vertexCount;
const BASE_POS = new Float32Array(baseBuf, section('positions').byteOffset, NV * 3);
const BASE_UV = new Float32Array(baseBuf, section('uvs').byteOffset, section('uvs').count * 2);
const FACES = new Uint16Array(baseBuf, section('faceVerts').byteOffset, section('faceVerts').count * 4);
const FACE_UV = new Uint16Array(baseBuf, section('faceUvs').byteOffset, section('faceUvs').count * 4);
const FACE_GROUP = new Uint8Array(baseBuf, section('faceGroup').byteOffset, section('faceGroup').count);
const groupVerts = (name) => { const out = []; for (const [a, b] of baseMeta.vertexGroups[name] ?? []) for (let v = a; v <= b; v++) out.push(v); return out; };
const BODY_VERTS = groupVerts('body');

const pcaMeta = json(path.join(SRC, 'targets-macro-pca.json'));
const pcaBuf = bin(path.join(SRC, 'targets-macro-pca.bin'));
const PL = pcaMeta.layout;
const BASIS = new Int16Array(pcaBuf, PL.basis.byteOffset, PL.basis.count);
const COEFF = new Float32Array(pcaBuf, PL.coefficients.byteOffset, PL.coefficients.count);
const R_IDX = new Uint16Array(pcaBuf, PL.residualIndices.byteOffset, PL.residualIndices.count);
const R_DELTA = new Int16Array(pcaBuf, PL.residualDeltas.byteOffset, PL.residualDeltas.count * 3);
const localMeta = json(path.join(SRC, 'targets-local.json'));
const localBuf = bin(path.join(SRC, 'targets-local.bin'));
const L_IDX = new Uint16Array(localBuf, localMeta.layout.indices.byteOffset, localMeta.entryCount);
const L_DELTA = new Int16Array(localBuf, localMeta.layout.deltas.byteOffset, localMeta.entryCount * 3);
const MACRO = json(path.join(SRC, 'modifiers.json')).macro;

const skel = json(path.join(SRC, 'skeleton-game-engine.json'));
const wBuf = bin(path.join(SRC, 'weights-game-engine.bin'));
const W_JOINTS = new Uint8Array(wBuf, skel.weights.layout.joints.byteOffset, NV * 4);
const W_WEIGHTS = new Uint16Array(wBuf, skel.weights.layout.weights.byteOffset, NV * 4);
const ALL_BONES = skel.bones.map((b) => b.name);

// ------------------------------------------------------------------------------------------------ the rig
/** The bones kept: the game_engine rig without fingers (their weights go to the hand). */
export const BONES = ['Root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head',
  'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r'];
const NB = BONES.length;
const B = Object.fromEntries(BONES.map((n, i) => [n, i]));
const PARENT = BONES.map((n) => { const p = skel.bones.find((b) => b.name === n).parent; return p === null ? -1 : B[p]; });
/** Every rig bone to its kept bone (a finger to its hand). */
const KEEP_OF = ALL_BONES.map((name) => {
  let n = name;
  while (!(n in B)) n = skel.bones.find((b) => b.name === n).parent;
  return B[n];
});
const CAPTURE = { pelvis: 'Bip01_Pelvis', spine_01: 'Bip01_Spine', spine_02: 'Bip01_Spine1', spine_03: 'Bip01_Spine2', neck_01: 'Bip01_Neck', head: 'Bip01_Head' };
for (const [s, S] of [['l', 'L'], ['r', 'R']]) {
  Object.assign(CAPTURE, { [`clavicle_${s}`]: `Bip01_${S}_Clavicle`, [`upperarm_${s}`]: `Bip01_${S}_UpperArm`, [`lowerarm_${s}`]: `Bip01_${S}_Forearm`,
    [`hand_${s}`]: `Bip01_${S}_Hand`, [`thigh_${s}`]: `Bip01_${S}_Thigh`, [`calf_${s}`]: `Bip01_${S}_Calf`, [`foot_${s}`]: `Bip01_${S}_Foot`, [`ball_${s}`]: `Bip01_${S}_Toe0` });
}
/** Bones turned to the capture's bind posture, each pointed at the head of the second bone (rig names). */
const POSTURE = ['l', 'r'].flatMap((s) => [[`thigh_${s}`, `calf_${s}`], [`calf_${s}`, `foot_${s}`], [`foot_${s}`, `ball_${s}`],
  [`clavicle_${s}`, `upperarm_${s}`], [`upperarm_${s}`, `lowerarm_${s}`], [`lowerarm_${s}`, `hand_${s}`], [`hand_${s}`, `middle_01_${s}`]]);

// ------------------------------------------------------------------------------------------------ morphing
function stateWeights(parts, value) {
  const out = new Map();
  const x = Math.min(1, Math.max(0, value));
  const part = parts.find((p) => x >= p.lowest && x <= p.highest)
    ?? parts.reduce((best, p) => (Math.abs(x - (p.lowest + p.highest) / 2) < Math.abs(x - (best.lowest + best.highest) / 2) ? p : best));
  const lo = Math.max(0, part.lowest), hi = Math.min(1, part.highest);
  const t = hi > lo ? Math.min(1, Math.max(0, (x - lo) / (hi - lo))) : 0;
  if (part.low) out.set(part.low, (out.get(part.low) ?? 0) + (1 - t));
  if (part.high) out.set(part.high, (out.get(part.high) ?? 0) + t);
  return out;
}
const RACES = ['african', 'asian', 'caucasian'];
function macroWeights(names, params) {
  const factor = new Map();
  for (const [name, slider] of Object.entries(MACRO.macrotargets)) if (params[name] !== undefined) factor.set(name, stateWeights(slider.parts, params[name]));
  const total = RACES.reduce((s, r) => s + params[r], 0);
  factor.set('race', new Map(RACES.map((r) => [r, params[r] / total])));
  const owner = new Map();
  for (const [name, slider] of Object.entries(MACRO.macrotargets)) for (const p of slider.parts) for (const s of [p.low, p.high]) if (s) owner.set(s, name);
  for (const r of RACES) owner.set(r, 'race');
  const combos = new Set(Object.values(MACRO.combinations).map((c) => [...c].sort().join('|')));
  const out = new Map();
  for (const full of names) {
    const states = full.slice(full.lastIndexOf('/') + 1).replace(/^universal-/, '').split('-');
    const sliders = states.map((s) => owner.get(s));
    if (sliders.some((s) => s === undefined) || !combos.has([...sliders].sort().join('|'))) continue;
    let w = 1;
    for (let i = 0; i < states.length && w > 0; i++) w *= factor.get(sliders[i])?.get(states[i]) ?? 0;
    if (w > 1e-9) out.set(full, w);
  }
  return out;
}
/** The body for the macro sliders, decimetres, OBJ frame (+Y up, +Z forward). */
function shape(params) {
  const D = NV * 3, K = pcaMeta.components, scales = PL.basis.scales;
  const out = Float32Array.from(BASE_POS);
  const weights = macroWeights(pcaMeta.targets.map((t) => t.name), params);
  const rows = new Map(pcaMeta.targets.map((t) => [t.name, t]));
  const c = new Float64Array(K);
  for (const [name, w] of weights) { const t = rows.get(name); for (let k = 0; k < K; k++) c[k] += w * COEFF[t.row * K + k]; }
  for (let k = 0; k < K; k++) {
    const ck = c[k] * scales[k];
    if (ck === 0) continue;
    const o = k * D;
    for (let j = 0; j < D; j++) out[j] += ck * BASIS[o + j];
  }
  for (const [name, w] of weights) {
    const t = rows.get(name), s = w * t.residualScale;
    for (let e = t.residualStart; e < t.residualStart + t.residualCount; e++) {
      const v = R_IDX[e] * 3;
      out[v] += s * R_DELTA[e * 3]; out[v + 1] += s * R_DELTA[e * 3 + 1]; out[v + 2] += s * R_DELTA[e * 3 + 2];
    }
  }
  const breast = localMeta.targets.filter((t) => t.group === 'breast');
  const bw = macroWeights(breast.map((t) => t.name), params);
  for (const t of breast) {
    const w = bw.get(t.name);
    if (!w) continue;
    const s = w * t.scale;
    for (let e = t.start; e < t.start + t.count; e++) {
      const v = L_IDX[e] * 3;
      out[v] += s * L_DELTA[e * 3]; out[v + 1] += s * L_DELTA[e * 3 + 1]; out[v + 2] += s * L_DELTA[e * 3 + 2];
    }
  }
  return out;
}
const AGE_KNOTS = [[1, 0], [11, 0.1875], [18, 0.44], [25, 0.5], [90, 1]];
function ageFromYears(y) {
  for (let i = 1; i < AGE_KNOTS.length; i++) {
    const [y0, a0] = AGE_KNOTS[i - 1], [y1, a1] = AGE_KNOTS[i];
    if (y <= y1) return a0 + ((y - y0) / (y1 - y0)) * (a1 - a0);
  }
  return 1;
}

// ------------------------------------------------------------------------------------------------ proxies
function loadProxy(name) {
  const meta = json(path.join(SRC, 'proxies', `${name}.json`));
  const buf = bin(path.join(SRC, 'proxies', `${name}.bin`));
  const L = meta.layout;
  const sec = (k, T) => (L[k] ? new T(buf, L[k].byteOffset, L[k].count) : new T(0));
  return { meta, refs: sec('refs', Uint32Array), weights: sec('weights', Float32Array), offsets: sec('offsets', Float32Array),
    uvs: sec('uvs', Float32Array), index: sec('index', Uint32Array), deleteVerts: sec('deleteVerts', Uint32Array),
    texture: meta.texture ? texture(path.join(SRC, 'proxies', meta.texture)) : null };
}
function fitProxy(p, dm) {
  const n = p.refs.length / 3;
  const axis = (i) => {
    const a = p.meta.scaleRefs[i * 2], b = p.meta.scaleRefs[i * 2 + 1];
    const d = Math.abs(dm[a * 3 + i] - dm[b * 3 + i]);
    return d > 0 ? d / p.meta.scaleBase[i] : 1;
  };
  const s = [axis(0), axis(1), axis(2)];
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) for (let c = 0; c < 3; c++) {
    let x = 0;
    for (let k = 0; k < 3; k++) x += p.weights[v * 3 + k] * dm[p.refs[v * 3 + k] * 3 + c];
    out[v * 3 + c] = x + p.offsets[v * 3 + c] * s[c];
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ textures
const TEX = new Map();
function texture(file) {
  if (TEX.has(file)) return TEX.get(file);
  const raw = path.join(CACHE, path.relative(SRC, file).replace(/[\\/]/g, '_') + '.rgba');
  if (!fs.existsSync(raw)) throw new Error(`texture not decoded: ${file}`);
  const b = fs.readFileSync(raw);
  const t = { w: b.readUInt32LE(0), h: b.readUInt32LE(4), d: new Uint8Array(b.buffer, b.byteOffset + 8, b.length - 8) };
  TEX.set(file, t);
  return t;
}
/** RGBA 0..1 (sRGB) at (u, v); OBJ texture space, v up. */
function sample(t, u, v, flip = true) {
  if (!flip) v = 1 - v;
  const x = Math.min(t.w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * t.w)));
  const y = Math.min(t.h - 1, Math.max(0, Math.floor((1 - (v - Math.floor(v))) * t.h)));
  const o = (y * t.w + x) * 4;
  return [t.d[o] / 255, t.d[o + 1] / 255, t.d[o + 2] / 255, t.d[o + 3] / 255];
}
function decodeAll(files) {
  const todo = files.filter((f) => !fs.existsSync(path.join(CACHE, path.relative(SRC, f).replace(/[\\/]/g, '_') + '.rgba')));
  if (!todo.length) return;
  fs.mkdirSync(CACHE, { recursive: true });
  const jobFile = path.join(CACHE, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify({ files: todo.map((src) => ({ src, out: path.join(CACHE, path.relative(SRC, src).replace(/[\\/]/g, '_') + '.rgba'), size: 512 })) }));
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = { ...process.env, COOK_DECODE_JOB: jobFile };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(exe, [path.join(ROOT, 'tools', 'cook-people-decode.cjs')], { env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('texture decode failed');
}

// ------------------------------------------------------------------------------------------------ the cast
/** Regions a vertex belongs to: the shader tints each its own way (`src/render/people/format.ts` REGION). */
const REGION = { skin: 0, hair: 1, top: 2, bottom: 3, shoes: 4, hat: 5, eyes: 6, phone: 8, cup: 9, bag: 10, paper: 11, umbrella: 12, helmet: 13 };
const BANDS = [{ name: 'child', years: 9 }, { name: 'young', years: 23 }, { name: 'adult', years: 41 }, { name: 'senior', years: 69 }];
const OUTFITS = {
  male: { child: ['male_casualsuit02', 'male_casualsuit04', 'male_casualsuit03', 'male_casualsuit06'],
    young: ['male_casualsuit03', 'male_casualsuit05', 'male_casualsuit02', 'male_casualsuit04'],
    adult: ['male_casualsuit01', 'male_worksuit01', 'male_elegantsuit01', 'male_casualsuit05'],
    senior: ['male_casualsuit06', 'male_elegantsuit01', 'male_casualsuit02', 'male_worksuit01'] },
  female: { child: ['female_casualsuit01', 'female_sportsuit01', 'female_casualsuit02', 'female_casualsuit01'],
    young: ['female_casualsuit02', 'female_sportsuit01', 'female_casualsuit01', 'female_elegantsuit01'],
    adult: ['female_elegantsuit01', 'female_casualsuit02', 'female_casualsuit01', 'female_elegantsuit01'],
    senior: ['female_casualsuit01', 'female_elegantsuit01', 'female_casualsuit02', 'female_elegantsuit01'] },
};
const HAIRS = { male: ['short02', 'short04', 'afro01', 'short03', 'short01'], female: ['bob02', 'long01', 'ponytail01', 'afro01', 'bob01', 'braid01'] };
/** Dominant ancestry of the four variations of a class (the city is Brazilian: mixed often). */
const ORIGINS = [
  { african: 0.8, asian: 0.05, caucasian: 0.15, skin: 'african' },
  { african: 0.1, asian: 0.05, caucasian: 0.85, skin: 'caucasian' },
  { african: 0.45, asian: 0.1, caucasian: 0.45, skin: 'african' },
  { african: 0.1, asian: 0.75, caucasian: 0.15, skin: 'asian' },
];

function castList() {
  const out = [];
  for (const sex of ['female', 'male']) for (const [bi, band] of BANDS.entries()) for (let k = 0; k < 4; k++) {
    const r = rng(1000 + out.length * 7919);
    const o = ORIGINS[(k + bi) % 4];
    const years = band.years + Math.round((r() - 0.5) * (band.name === 'child' ? 4 : 8));
    out.push({
      sex, band: band.name, years,
      params: { gender: sex === 'male' ? 1 : 0, age: ageFromYears(years), muscle: 0.35 + r() * 0.35, weight: (band.name === 'senior' ? 0.45 : 0.3) + r() * 0.4,
        height: 0.4 + r() * 0.22, proportions: 0.5, african: o.african, asian: o.asian, caucasian: o.caucasian, cupsize: 0.4 + r() * 0.3, firmness: 0.5 },
      skin: `${band.name === 'senior' ? 'old' : band.name === 'adult' ? 'middleage' : 'young'}_${o.skin}_${sex}`,
      outfit: OUTFITS[sex][band.name][k],
      hair: HAIRS[sex][(k * 3 + bi) % HAIRS[sex].length],
      shoes: `shoes0${1 + ((k + bi * 2 + (sex === 'male' ? 1 : 0)) % 6)}`,
      hat: sex === 'male' && ((band.name === 'senior' && k % 2 === 1) || (band.name === 'adult' && k === 2)) ? 'fedora01' : null,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ one body
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (c) => 0.3 * toLin(c[0]) + 0.59 * toLin(c[1]) + 0.11 * toLin(c[2]);

/** Kept-bone weights of a base vertex (top four, normalised). */
function baseSkin(v) {
  const acc = new Map();
  for (let k = 0; k < 4; k++) { const w = W_WEIGHTS[v * 4 + k] / 65535; if (w > 0) { const j = KEEP_OF[W_JOINTS[v * 4 + k]]; acc.set(j, (acc.get(j) ?? 0) + w); } }
  return acc;
}
function top4(acc) {
  const t = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const s = t.reduce((x, [, w]) => x + w, 0) || 1;
  const j = [0, 0, 0, 0], w = [0, 0, 0, 0];
  t.forEach(([jj, ww], i) => { j[i] = jj; w[i] = ww / s; });
  if (!t.length) { j[0] = B.pelvis; w[0] = 1; }
  return { j, w };
}

function buildBody(cast, capture) {
  const dm = shape(cast.params);
  let lowestDm = Infinity;
  for (const v of BODY_VERTS) lowestDm = Math.min(lowestDm, dm[v * 3 + 1]);
  const toM = (src) => { const out = new Float32Array(src.length); for (let i = 0; i < src.length; i += 3) { out[i] = src[i] / 10; out[i + 1] = (src[i + 1] - lowestDm) / 10; out[i + 2] = src[i + 2] / 10; } return out; };
  const m = toM(dm);
  const mean = (verts) => { const c = [0, 0, 0]; for (const v of verts) { c[0] += m[v * 3]; c[1] += m[v * 3 + 1]; c[2] += m[v * 3 + 2]; } return mul(c, 1 / Math.max(1, verts.length)); };
  const headOfRig = (name) => {
    const h = skel.bones.find((b) => b.name === name).head;
    if (h.strategy === 'CUBE') return mean(groupVerts(h.cubeName));
    if (h.strategy === 'VERTEX') return mean([h.vertexIndex]);
    if (h.strategy === 'XYZ') return [m[h.vertexIndices[0] * 3], m[h.vertexIndices[1] * 3 + 1], m[h.vertexIndices[2] * 3 + 2]];
    return mean(h.vertexIndices);
  };
  const heads = BONES.map(headOfRig);
  if (heads[B.thigh_l][0] <= 0) throw new Error('the rig left side is not +X');
  // Posture: every bone of POSTURE turned (about its head) to point as the capture's does; children follow.
  const corr = BONES.map(() => ({ q: QI, t: [0, 0, 0] }));
  const apply = (c, p) => add(qrot(c.q, p), c.t);
  const target = new Map(POSTURE);
  const order = [];
  const visit = (i) => { order.push(i); BONES.forEach((_, j) => { if (PARENT[j] === i) visit(j); }); };
  visit(0);
  for (const i of order) {
    const c = PARENT[i] < 0 ? { q: QI, t: [0, 0, 0] } : { ...corr[PARENT[i]] };
    const towards = target.get(BONES[i]);
    if (towards) {
      const childHead = towards.startsWith('middle_01') ? headOfRig(towards) : heads[B[towards]];
      const from = capture.bind.get(CAPTURE[BONES[i]]), to = capture.bind.get(towards.startsWith('middle_01') ? `Bip01_${towards.endsWith('_l') ? 'L' : 'R'}_Finger2` : CAPTURE[towards]);
      const h = apply(c, heads[i]);
      const now = norm(sub(apply(c, childHead), h));
      const turn = qFromUnit(now, norm(sub(to, from)));
      // x -> turn (c(x) - h) + h
      c.q = qmul(turn, c.q);
      c.t = add(sub(qrot(turn, c.t), qrot(turn, h)), h);
    }
    corr[i] = c;
  }
  const pose = (pts, skins) => {
    const out = new Float32Array(pts.length);
    for (let v = 0; v < pts.length / 3; v++) {
      const p = [pts[v * 3], pts[v * 3 + 1], pts[v * 3 + 2]];
      let r = [0, 0, 0];
      const s = skins[v];
      for (let k = 0; k < 4; k++) if (s.w[k] > 0) r = add(r, mul(apply(corr[s.j[k]], p), s.w[k]));
      out[v * 3] = r[0]; out[v * 3 + 1] = r[1]; out[v * 3 + 2] = r[2];
    }
    return out;
  };
  const bodySkin = Array.from({ length: NV }, (_, v) => top4(baseSkin(v)));
  const posed = pose(m, bodySkin);
  const bindHead = BONES.map((_, i) => apply(PARENT[i] < 0 ? corr[i] : corr[PARENT[i]], heads[i]));
  let low = Infinity, high = -Infinity;
  for (const v of BODY_VERTS) { low = Math.min(low, posed[v * 3 + 1]); high = Math.max(high, posed[v * 3 + 1]); }
  for (let i = 1; i < posed.length; i += 3) posed[i] -= low;
  for (const h of bindHead) h[1] -= low;
  const headBone = B.head;
  const rigid = (s) => (s.j.reduce((a, j, k) => a + (j === headBone ? s.w[k] : 0), 0) >= 0.5 ? { j: [headBone, 0, 0, 0], w: [1, 0, 0, 0] } : s);

  // the parts
  const parts = [];
  const items = [cast.outfit, cast.shoes, cast.hair, ...(cast.hat ? [cast.hat] : [])].map((name) => ({ name, p: loadProxy(name) }));
  const hidden = new Set();
  for (const { name, p } of items) if (name !== cast.hair && !p.meta.transparent) for (const v of p.deleteVerts) hidden.add(v);
  // body skin and eyes
  {
    const skinTex = texture(path.join(SRC, 'skins', `${cast.skin}.webp`));
    const bodyG = baseMeta.faceGroups.indexOf('body');
    const eyeG = new Set(['helper-l-eye', 'helper-r-eye'].map((n) => baseMeta.faceGroups.indexOf(n)));
    const map = new Map(), pos = [], col = [], reg = [], skin = [], tris = [];
    let eyeFront = -Infinity, eyeBack = Infinity;
    for (let f = 0; f < FACE_GROUP.length; f++) if (eyeG.has(FACE_GROUP[f])) for (let c = 0; c < 4; c++) { const v = FACES[f * 4 + c]; eyeFront = Math.max(eyeFront, posed[v * 3 + 2]); eyeBack = Math.min(eyeBack, posed[v * 3 + 2]); }
    const emit = (v, uv, eye) => {
      const key = v * 2 + (eye ? 1 : 0);
      if (map.has(key)) return map.get(key);
      const i = pos.length / 3;
      pos.push(posed[v * 3], posed[v * 3 + 1], posed[v * 3 + 2]);
      if (eye) {
        const t = (eyeFront - posed[v * 3 + 2]) / Math.max(1e-6, (eyeFront - eyeBack) / 2);
        col.push(...(t < 0.06 ? [0.05, 0.04, 0.035] : t < 0.2 ? [0.33, 0.22, 0.12] : [0.92, 0.9, 0.86]), 1);
        reg.push(REGION.eyes); skin.push(rigid(bodySkin[v]));
      } else {
        col.push(...sample(skinTex, BASE_UV[uv * 2], BASE_UV[uv * 2 + 1]));
        reg.push(REGION.skin); skin.push(bodySkin[v]);
      }
      map.set(key, i);
      return i;
    };
    for (let f = 0; f < FACE_GROUP.length; f++) {
      const g = FACE_GROUP[f], eye = eyeG.has(g);
      if (g !== bodyG && !eye) continue;
      const q = [FACES[f * 4], FACES[f * 4 + 1], FACES[f * 4 + 2], FACES[f * 4 + 3]];
      if (!eye && q.some((v) => hidden.has(v))) continue;
      const o = q.map((v, c) => emit(v, FACE_UV[f * 4 + c], eye));
      tris.push(o[0], o[1], o[2]);
      if (q[3] !== q[2]) tris.push(o[0], o[2], o[3]);
    }
    parts.push({ name: 'body', pos, col, reg, skin, tris, budget: [1500, 170, 56] });
  }
  for (const { name, p } of items) {
    const kind = name === cast.hair ? 'hair' : name === cast.hat ? 'hat' : name === cast.shoes ? 'shoes' : 'outfit';
    const fitted = fitProxy(p, dm);
    const n = fitted.length / 3;
    const skins = [];
    for (let v = 0; v < n; v++) {
      const acc = new Map();
      for (let k = 0; k < 3; k++) { const share = Math.max(0, p.weights[v * 3 + k]); for (const [j, w] of baseSkin(p.refs[v * 3 + k])) acc.set(j, (acc.get(j) ?? 0) + w * share); }
      const s = top4(acc);
      skins.push(kind === 'hair' || kind === 'hat' ? rigid(s) : s);
    }
    const pm = pose(toM(fitted), skins);
    for (let i = 1; i < pm.length; i += 3) pm[i] -= low;
    const pos = Array.from(pm), col = [], reg = [], tris = [];
    const hipY = bindHead[B.pelvis][1];
    const leg = new Set([B.thigh_l, B.thigh_r, B.calf_l, B.calf_r, B.foot_l, B.foot_r, B.ball_l, B.ball_r]);
    for (let v = 0; v < n; v++) {
      const c = p.texture ? sample(p.texture, p.uvs[v * 2], p.uvs[v * 2 + 1], false) : [0.5, 0.5, 0.5, 1];
      col.push(...c);
      const s = skins[v];
      reg.push(kind === 'hair' ? REGION.hair : kind === 'hat' ? REGION.hat : kind === 'shoes' ? REGION.shoes
        : leg.has(s.j[0]) || (s.j[0] === B.pelvis && pm[v * 3 + 1] < hipY + 0.02) ? REGION.bottom : REGION.top);
    }
    for (let i = 0; i + 2 < p.index.length; i += 3) {
      const a = p.index[i], b = p.index[i + 1], c = p.index[i + 2];
      if (p.meta.transparent && (col[a * 4 + 3] + col[b * 4 + 3] + col[c * 4 + 3]) / 3 < 0.45) continue;
      tris.push(a, b, c);
    }
    const budget = { hair: [380, 50, 14], hat: [140, 24, 8], shoes: [220, 24, 8], outfit: [1300, 150, 48] }[kind];
    parts.push({ name, kind, pos, col, reg, skin: skins, tris, budget, twoSided: kind === 'hair' });
  }
  parts.push(...props(bindHead));
  return { parts, bindHead, height: high - low };
}

/** Things held in the right hand (or worn: the bike helmet), modelled in the bind posture next to the bone. */
function props(head) {
  const out = [];
  const hand = head[B.hand_r], arm = head[B.lowerarm_r];
  const down = norm(sub(hand, arm));
  // the palm faces in (+X for the right hand); the fingers go on along `down`
  const side = norm(cross(down, [0, 0, 1]));
  const fwd = norm(cross(side, down));
  const at = add(hand, mul(down, 0.09));
  const box = (name, region, c, w, h, d, color, bone, axes) => {
    const [ax, ay, az] = axes;
    const pos = [], tris = [];
    for (let i = 0; i < 8; i++) {
      const p = add(add(add(c, mul(ax, ((i & 1) - 0.5) * w)), mul(ay, (((i >> 1) & 1) - 0.5) * h)), mul(az, (((i >> 2) & 1) - 0.5) * d));
      pos.push(...p);
    }
    for (const f of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) tris.push(f[0], f[1], f[2], f[0], f[2], f[3]);
    return { name, kind: 'prop', pos, col: Array(8).fill(0).flatMap(() => [...color, 1]), reg: Array(8).fill(region), skin: Array(8).fill({ j: [bone, 0, 0, 0], w: [1, 0, 0, 0] }), tris, budget: [12, 12, 12], twoSided: true };
  };
  const cyl = (name, region, base, axis, r0, r1, h, color, bone, seg = 8, capped = true) => {
    const u = norm(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), w = cross(axis, u);
    const pos = [], tris = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, d = add(mul(u, Math.cos(a)), mul(w, Math.sin(a)));
      pos.push(...add(base, mul(d, r0)), ...add(add(base, mul(axis, h)), mul(d, r1)));
    }
    for (let i = 0; i < seg; i++) { const a = i * 2, b = ((i + 1) % seg) * 2; tris.push(a, b, a + 1, b, b + 1, a + 1); }
    if (capped) { const c0 = pos.length / 3; pos.push(...base); for (let i = 0; i < seg; i++) tris.push(c0, ((i + 1) % seg) * 2, i * 2); }
    const n = pos.length / 3;
    return { name, kind: 'prop', pos, col: Array(n).fill(0).flatMap(() => [...color, 1]), reg: Array(n).fill(region), skin: Array(n).fill({ j: [bone, 0, 0, 0], w: [1, 0, 0, 0] }), tris, budget: [tris.length / 3, tris.length / 3, tris.length / 3], twoSided: true };
  };
  out.push(box('phone', REGION.phone, add(at, mul(side, 0.015)), 0.075, 0.15, 0.012, [0.08, 0.08, 0.09], B.hand_r, [fwd, down, side]));
  out.push(cyl('cup', REGION.cup, add(add(at, mul(side, 0.03)), mul(down, 0.05)), mul(down, -1), 0.032, 0.04, 0.11, [0.93, 0.92, 0.88], B.hand_r));
  out.push(box('bag', REGION.bag, add(hand, mul(down, 0.2)), 0.3, 0.26, 0.09, [0.8, 0.8, 0.8], B.hand_r, [fwd, down, side]));
  out.push(box('paper', REGION.paper, add(at, mul(side, 0.02)), 0.3, 0.36, 0.01, [0.86, 0.85, 0.8], B.hand_r, [fwd, down, side]));
  // umbrella: a pole up from the fist, a canopy cone above the head
  const up = mul(down, -1);
  out.push(cyl('pole', REGION.umbrella, add(at, mul(down, 0.05)), up, 0.012, 0.012, 1.02, [0.15, 0.15, 0.15], B.hand_r, 5, false));
  out.push(cyl('canopy', REGION.umbrella, add(at, mul(up, 0.8)), up, 0.52, 0.02, 0.24, [0.15, 0.17, 0.25], B.hand_r, 10, false));
  // bike helmet on the head
  const hd = head[B.head];
  out.push(cyl('helmet', REGION.helmet, add(hd, [0, 0.19, -0.01]), [0, 1, 0], 0.135, 0.06, 0.11, [0.9, 0.9, 0.9], B.head, 10, false));
  return out.map((p) => ({ ...p, reg: p.reg.map((r) => r) }));
}

// ------------------------------------------------------------------------------------------------ captures
function loadCaptures(sex) {
  const name = sex === 'male' ? 'Male' : 'Female';
  const walk = json(path.join(MOTION, `walk${name}.json`));
  const lib = json(path.join(MOTION, `rocketbox${name}.json`));
  const bones = walk.bones;
  const at = new Map(bones.map((n, i) => [n, i]));
  const bind = new Map(bones.map((n, i) => [n, walk.bind[i].p]));
  const bindQ = bones.map((_, i) => walk.bind[i].q);
  const b64 = (s) => { const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
  const clip = (c) => {
    const q = new Int16Array(b64(c.q)), pelvis = new Float32Array(b64(c.pelvis));
    return { frames: c.frames, duration: c.duration, loop: c.loop,
      q: (k, i) => qnorm([q[(k * bones.length + i) * 4] / 32767, q[(k * bones.length + i) * 4 + 1] / 32767, q[(k * bones.length + i) * 4 + 2] / 32767, q[(k * bones.length + i) * 4 + 3] / 32767]),
      pelvis: (k) => [pelvis[k * 3], pelvis[k * 3 + 1], pelvis[k * 3 + 2]] };
  };
  const walkClip = { frames: walk.frames.length, duration: walk.duration, loop: true, q: (k, i) => walk.frames[k].q[i], pelvis: (k) => walk.frames[k].pelvis };
  return { bones, at, bind, bindQ, walk: walkClip, lib: Object.fromEntries(Object.entries(lib.clips).map(([k, c]) => [k, clip(c)])) };
}

/** A clip as a list of frames of source world rotations by capture bone index, and the pelvis. */
function frames(src, start, count, step = 1) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = Math.min(src.frames - 1, start + i * step);
    out.push({ q: (b) => src.q(k, b), pelvis: src.pelvis(k) });
  }
  return out;
}
/** The walk with the right arm held as in one frame of another clip (relative to the upper chest). */
function withArm(walk, held, cap) {
  const chest = cap.at.get('Bip01_Spine2');
  const arm = new Set(cap.bones.map((n, i) => (/^Bip01_R_(Clavicle|UpperArm|Forearm|Hand|Finger)/.test(n) ? i : -1)).filter((i) => i >= 0));
  const local = new Map([...arm].map((b) => [b, qmul(qinv(held.q(chest)), held.q(b))]));
  return walk.map((f) => ({ pelvis: f.pelvis, q: (b) => (arm.has(b) ? qmul(f.q(chest), local.get(b)) : f.q(b)) }));
}
/** The frame of a clip where the right hand is furthest forward (+Z) relative to the pelvis. */
function handForward(src, cap) {
  const hand = cap.at.get('Bip01_R_Hand');
  let best = 0, bz = -Infinity;
  for (let k = 0; k < src.frames; k++) {
    // forward reach of the hand: FK over the capture's bind segments (pelvis..hand), positions not stored per frame
    const z = fkSource(src, cap, k, hand)[2] - src.pelvis(k)[2];
    if (z > bz) { bz = z; best = k; }
  }
  return best;
}
const SRC_CHAIN = { Bip01_R_Hand: ['Bip01_Pelvis', 'Bip01_Spine', 'Bip01_Spine1', 'Bip01_Spine2', 'Bip01_Neck', 'Bip01_R_Clavicle', 'Bip01_R_UpperArm', 'Bip01_R_Forearm', 'Bip01_R_Hand'] };
function fkSource(src, cap, k, boneIndex) {
  const chain = SRC_CHAIN[cap.bones[boneIndex]];
  let p = src.pelvis(k);
  for (let i = 1; i < chain.length; i++) {
    const a = cap.at.get(chain[i - 1]), b = cap.at.get(chain[i]);
    const seg = sub(cap.bind.get(chain[i]), cap.bind.get(chain[i - 1]));
    p = add(p, qrot(qmul(src.q(k, a), qinv(cap.bindQ[a])), seg));
  }
  return p;
}

/** One frame retargeted: per kept bone, the world rotation from bind and the head position. */
function retarget(f, cap, body, lockFeet) {
  const R = BONES.map(() => QI), P = BONES.map(() => [0, 0, 0]);
  const h = body.bindHead;
  const pelvisBind = cap.bind.get('Bip01_Pelvis');
  const scale = (h[B.pelvis][1] - Math.min(h[B.foot_l][1], h[B.foot_r][1])) / (pelvisBind[1] - Math.min(cap.bind.get('Bip01_L_Foot')[1], cap.bind.get('Bip01_R_Foot')[1]));
  for (let i = 0; i < NB; i++) {
    const name = CAPTURE[BONES[i]];
    if (name) { const s = cap.at.get(name); R[i] = qmul(f.q(s), qinv(cap.bindQ[s])); }
  }
  for (const i of topo()) {
    if (i === B.Root) { P[i] = h[i]; continue; }
    if (i === B.pelvis) { P[i] = add(h[i], mul(sub(f.pelvis, pelvisBind), scale)); continue; }
    const p = PARENT[i];
    P[i] = add(P[p], qrot(R[p], sub(h[i], h[p])));
  }
  if (lockFeet) {
    const feet = [B.foot_l, B.foot_r, B.ball_l, B.ball_r];
    const bindLow = Math.min(...feet.map((i) => h[i][1])), low = Math.min(...feet.map((i) => P[i][1]));
    for (let i = 1; i < NB; i++) P[i] = [P[i][0], P[i][1] + bindLow - low, P[i][2]];
  }
  return { R, P };
}
let TOPO = null;
function topo() {
  if (TOPO) return TOPO;
  TOPO = [];
  const visit = (i) => { TOPO.push(i); BONES.forEach((_, j) => { if (PARENT[j] === i) visit(j); }); };
  visit(0);
  return TOPO;
}

/** A pose as built by hand (the cyclist), from per-bone world rotations: positions by forward kinematics from `pelvis`. */
function fkPose(body, R, pelvis) {
  const h = body.bindHead, P = BONES.map(() => [0, 0, 0]);
  for (const i of topo()) {
    if (i === B.Root) P[i] = h[i];
    else if (i === B.pelvis) P[i] = pelvis;
    else P[i] = add(P[PARENT[i]], qrot(R[PARENT[i]], sub(h[i], h[PARENT[i]])));
  }
  return P;
}
/** Two-bone IK: rotations of the upper and lower bone (world, from bind) reaching `goal`, the middle joint towards `pole`. */
function twoBone(body, a, b, c, rootPos, goal, pole, parentR) {
  const h = body.bindHead;
  const l1 = len(sub(h[b], h[a])), l2 = len(sub(h[c], h[b]));
  let d = sub(goal, rootPos);
  const dl = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, len(d)));
  d = norm(d);
  const cosA = (l1 * l1 + dl * dl - l2 * l2) / (2 * l1 * dl);
  const bend = norm(sub(pole, mul(d, dot(pole, d))));
  const mid = add(rootPos, add(mul(d, cosA * l1), mul(bend, Math.sqrt(Math.max(0, 1 - cosA * cosA)) * l1)));
  const end = add(rootPos, mul(d, dl));
  const bind1 = norm(qrot(parentR, sub(h[b], h[a])));
  const R1 = qmul(qFromUnit(bind1, norm(sub(mid, rootPos))), parentR);
  const bind2 = norm(qrot(R1, sub(h[c], h[b])));
  const R2 = qmul(qFromUnit(bind2, norm(sub(end, mid))), R1);
  return [R1, R2];
}
/** One frame of pedalling a bicycle (the bike of `src/render/vehicles.ts`: saddle top 0.85 m at z -0.16, bars at y 0.92 z 0.38, bracket y 0.4 z 0.05). */
function pedalFrame(body, theta) {
  const h = body.bindHead;
  const R = BONES.map(() => QI);
  const pelvis = [0, 0.93, -0.14];
  const lean = qAxis([1, 0, 0], 0.5);
  for (const n of ['spine_01', 'spine_02', 'spine_03', 'clavicle_l', 'clavicle_r']) R[B[n]] = lean;
  R[B.neck_01] = qAxis([1, 0, 0], 0.2);
  R[B.head] = qAxis([1, 0, 0], 0.05);
  let P = fkPose(body, R, pelvis);
  for (const [s, sign, phase] of [['l', 1, 0], ['r', -1, Math.PI]]) {
    const a = theta + phase;
    const pedal = [sign * 0.13, 0.4 - Math.cos(a) * 0.17, 0.05 + Math.sin(a) * 0.17];
    const ankle = add(pedal, [0, 0.08, -0.06]);
    const [r1, r2] = twoBone(body, B[`thigh_${s}`], B[`calf_${s}`], B[`foot_${s}`], P[B[`thigh_${s}`]], ankle, [0, 0.4, 1], R[B.pelvis]);
    R[B[`thigh_${s}`]] = r1; R[B[`calf_${s}`]] = r2; R[B[`foot_${s}`]] = qAxis([1, 0, 0], 0.15 - Math.sin(a) * 0.2); R[B[`ball_${s}`]] = R[B[`foot_${s}`]];
    const grip = [sign * 0.24, 0.95, 0.36];
    const [u1, u2] = twoBone(body, B[`upperarm_${s}`], B[`lowerarm_${s}`], B[`hand_${s}`], P[B[`upperarm_${s}`]], grip, [sign * 0.6, -1, -0.3], R[B[`clavicle_${s}`]]);
    R[B[`upperarm_${s}`]] = u1; R[B[`lowerarm_${s}`]] = u2; R[B[`hand_${s}`]] = u2;
  }
  P = fkPose(body, R, pelvis);
  return { R, P };
}

/** The palette of a frame: per bone a 3x4 affine (rows), x' = R (x - h) + P. */
function palette(frame, body, out, o) {
  for (let i = 0; i < NB; i++) {
    const q = frame.R[i];
    const [x, y, z, w] = q;
    const m = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
    const h = body.bindHead[i];
    const t = sub(frame.P[i], [m[0] * h[0] + m[1] * h[1] + m[2] * h[2], m[3] * h[0] + m[4] * h[1] + m[5] * h[2], m[6] * h[0] + m[7] * h[1] + m[8] * h[2]]);
    const b = o + i * 12;
    out[b] = m[0]; out[b + 1] = m[1]; out[b + 2] = m[2]; out[b + 3] = t[0];
    out[b + 4] = m[3]; out[b + 5] = m[4]; out[b + 6] = m[5]; out[b + 7] = t[1];
    out[b + 8] = m[6]; out[b + 9] = m[7]; out[b + 10] = m[8]; out[b + 11] = t[2];
  }
}

/** Clips every variation carries, in this order (`src/render/people/format.ts` CLIP). */
const CLIPS = [
  { name: 'walk', fps: 30, loop: true }, { name: 'idle', fps: 10, loop: true }, { name: 'sit', fps: 10, loop: true },
  { name: 'walkPhone', fps: 30, loop: true }, { name: 'phone', fps: 10, loop: true }, { name: 'read', fps: 10, loop: true },
  { name: 'drink', fps: 10, loop: true }, { name: 'walkUmbrella', fps: 30, loop: true }, { name: 'umbrella', fps: 10, loop: true },
  { name: 'walkCarry', fps: 30, loop: true }, { name: 'pedal', fps: 30, loop: true },
];
const SEGMENT = 80;
function clipFrames(cap, body, name) {
  const walk = frames(cap.walk, 0, cap.walk.frames);
  const seg = (c, start = 40) => frames(cap.lib[c], Math.min(start, Math.max(0, cap.lib[c].frames - SEGMENT)), Math.min(SEGMENT, cap.lib[c].frames));
  const held = (c) => { const k = handForward(cap.lib[c], cap); return { q: (b) => cap.lib[c].q(k, b), pelvis: cap.lib[c].pelvis(k) }; };
  const lock = (fs) => fs.map((f) => retarget(f, cap, body, true));
  switch (name) {
    case 'walk': return lock(walk);
    case 'idle': return lock(frames(cap.lib.idle, 0, cap.lib.idle.frames));
    case 'sit': return seg('sitIdle', 0).map((f) => retarget(f, cap, body, false));
    case 'walkPhone': return lock(withArm(walk, held('phone'), cap));
    case 'phone': return lock(seg('phone'));
    case 'read': return lock(seg('read'));
    case 'drink': return lock(seg('drink'));
    case 'walkUmbrella': return lock(withArm(walk, held('umbrella'), cap));
    case 'umbrella': return lock(seg('umbrella'));
    // the bag's arm hangs still at the side, as standing (it does not swing with a weight in the hand)
    case 'walkCarry': return lock(withArm(walk, { q: (b) => cap.lib.idle.q(0, b), pelvis: cap.lib.idle.pelvis(0) }, cap));
    case 'pedal': return Array.from({ length: 30 }, (_, k) => pedalFrame(body, (k / 30) * Math.PI * 2));
  }
  throw new Error(name);
}
/** Loops a clip that does not: its last frames ease towards the first. */
function closeLoop(pal, frameCount, fade = 10) {
  const n = NB * 12;
  for (let i = 0; i < Math.min(fade, frameCount - 1); i++) {
    const k = frameCount - fade + i, w = (i + 1) / (fade + 1);
    for (let j = 0; j < n; j++) pal[k * n + j] = pal[k * n + j] * (1 - w) + pal[j] * w;
  }
}

// ------------------------------------------------------------------------------------------------ mesh work
function normals(pos, tris) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const f = cross(e1, e2);
    for (const v of [a, b, c]) { n[v] += f[0]; n[v + 1] += f[1]; n[v + 2] += f[2]; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}
function simplify(pos, tris, target) {
  if (tris.length / 3 <= target) return Uint32Array.from(tris);
  const idx = Uint32Array.from(tris), p = Float32Array.from(pos);
  let [out] = MeshoptSimplifier.simplify(idx, p, 3, target * 3, 0.01, []);
  if (out.length / 3 > target) [out] = MeshoptSimplifier.simplify(idx, p, 3, target * 3, 1, []);
  if (out.length / 3 > target * 1.05) [out] = MeshoptSimplifier.simplifySloppy(idx, p, 3, null, target * 3, 1);
  return out;
}
const octEncode = (n) => {
  const s = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]);
  let x = n[0] / s, y = n[1] / s;
  if (n[2] < 0) { const ox = x; x = (1 - Math.abs(y)) * Math.sign(ox || 1); y = (1 - Math.abs(ox)) * Math.sign(y || 1); }
  const q = (v) => Math.round((Math.max(-1, Math.min(1, v)) * 0.5 + 0.5) * 65535);
  return (q(x) | (q(y) << 16)) >>> 0;
};

// ------------------------------------------------------------------------------------------------ preview (PNG)
function png(file, w, h, rgb) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
/** Draws people (skinned on the CPU with the cooked palettes, like the shader) side by side, front view. */
function drawPreview(file, people, cellW = 160, cellH = 300, yaw = 0) {
  const cols = Math.min(8, people.length), rows = Math.ceil(people.length / cols);
  const W = cols * cellW, H = rows * cellH;
  const img = Buffer.alloc(W * H * 3, 200), zb = new Float32Array(W * H).fill(-Infinity);
  const sc = cellH / 2.1, light = norm([0.4, 0.8, 0.6]);
  people.forEach(({ verts, tris }, n) => {
    const ox = (n % cols) * cellW + cellW / 2, oy = Math.floor(n / cols) * cellH + cellH - 8;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = verts.map((v) => { const x = v.p[0] * c + v.p[2] * s, z = -v.p[0] * s + v.p[2] * c; return [ox - x * sc, oy - v.p[1] * sc, z]; });
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, d] = [P[tris[i]], P[tris[i + 1]], P[tris[i + 2]]];
      const va = verts[tris[i]];
      const nn = norm(cross(sub(verts[tris[i + 1]].p, va.p), sub(verts[tris[i + 2]].p, va.p)));
      const shade = 0.35 + 0.65 * Math.abs(dot(nn, light));
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], d[0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], d[0])));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], d[1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], d[1])));
      const area = (b[0] - a[0]) * (d[1] - a[1]) - (b[1] - a[1]) * (d[0] - a[0]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const w0 = ((b[0] - x) * (d[1] - y) - (b[1] - y) * (d[0] - x)) / area, w1 = ((d[0] - x) * (a[1] - y) - (d[1] - y) * (a[0] - x)) / area, w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * a[2] + w1 * b[2] + w2 * d[2];
        if (z <= zb[y * W + x]) continue;
        zb[y * W + x] = z;
        const col = va.c;
        for (let k = 0; k < 3; k++) img[(y * W + x) * 3 + k] = Math.min(255, Math.round(col[k] * 255 * shade));
      }
    }
  });
  png(file, W, H, img);
}

// ------------------------------------------------------------------------------------------------ the cook
async function main() {
  await MeshoptSimplifier.ready;
  const cast = castList();
  const used = new Set();
  for (const c of cast) {
    used.add(path.join(SRC, 'skins', `${c.skin}.webp`));
    for (const n of [c.outfit, c.shoes, c.hair, c.hat].filter(Boolean)) { const m = json(path.join(SRC, 'proxies', `${n}.json`)); if (m.texture) used.add(path.join(SRC, 'proxies', m.texture)); }
  }
  decodeAll([...used]);
  const captures = { male: loadCaptures('male'), female: loadCaptures('female') };
  const vpos = [], vattr = [], index = [], variations = [], palettes = [];
  const lodTris = [[], [], []];
  const clipSets = {};
  let paletteFrames = 0;
  const previews = [];
  for (const [vi, c] of cast.entries()) {
    const cap = captures[c.sex];
    const body = buildBody(c, cap);
    // simplify each part to its share, two levels; then keep only the vertices the levels use
    const lists = [[], [], []];
    const keep = new Map();
    const verts = [];
    for (const part of body.parts) {
      const nrm = normals(part.pos, part.tris);
      const full = Array.from(part.tris);
      for (let lod = 0; lod < 3; lod++) {
        // the farthest level keeps only the things that read from far: the bag, the umbrella's canopy, the helmet
        if (lod === 2 && ['phone', 'cup', 'paper', 'pole'].includes(part.name)) continue;
        if (part.kind === 'prop' || part.budget[lod] > 0) {
          let t = part.kind === 'prop' ? Uint32Array.from(full) : simplify(part.pos, full, part.budget[lod]);
          const emit = (v, flip) => {
            const key = `${part.name}:${v}:${flip ? 1 : 0}`;
            if (!keep.has(key)) {
              keep.set(key, verts.length);
              const n = flip ? mul([nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]], -1) : [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]];
              const col = part.col.slice(v * 4, v * 4 + 4);
              verts.push({ p: [part.pos[v * 3], part.pos[v * 3 + 1], part.pos[v * 3 + 2]], n, c: col, r: part.reg[v], s: part.skin[v] });
            }
            return keep.get(key);
          };
          for (let i = 0; i < t.length; i += 3) {
            if (part.reg[t[i]] === REGION.eyes && lod > 0) continue;
            lists[lod].push(emit(t[i], false), emit(t[i + 1], false), emit(t[i + 2], false));
            if (part.twoSided && lod < 2) lists[lod].push(emit(t[i], true), emit(t[i + 2], true), emit(t[i + 1], true));
          }
        }
      }
    }
    // tint detail: each vertex's brightness against its item's mean (the shader recolours by it)
    const meanLum = new Map();
    for (const v of verts) { const m = meanLum.get(v.r) ?? [0, 0]; m[0] += lum(v.c); m[1]++; meanLum.set(v.r, m); }
    const base = vpos.length / 4;
    for (const v of verts) {
      const ml = meanLum.get(v.r);
      vpos.push(v.p[0], v.p[1], v.p[2], Math.min(3, lum(v.c) / Math.max(1e-3, ml[0] / ml[1])));
      const q8 = v.s.w.map((w) => Math.round(w * 255));
      q8[0] += 255 - q8.reduce((a, b) => a + b, 0);
      vattr.push(octEncode(v.n),
        (Math.round(v.c[0] * 255) | (Math.round(v.c[1] * 255) << 8) | (Math.round(v.c[2] * 255) << 16) | (v.r << 24)) >>> 0,
        (v.s.j[0] | (v.s.j[1] << 8) | (v.s.j[2] << 16) | (v.s.j[3] << 24)) >>> 0,
        (q8[0] | (q8[1] << 8) | (q8[2] << 16) | (q8[3] << 24)) >>> 0);
    }
    const lods = lists.map((l) => { const start = index.length; for (const i of l) index.push(base + i); return [start, l.length / 3]; });
    lods.forEach((l, i) => lodTris[i].push(l[1]));
    // clips
    let clipStart = 0;
    const table = [];
    const pal = [];
    for (const clip of CLIPS) {
      const fr = clipFrames(cap, body, clip.name);
      const arr = new Float32Array(fr.length * NB * 12);
      fr.forEach((f, k) => palette(f, body, arr, k * NB * 12));
      if (['sit', 'phone', 'read', 'drink', 'umbrella', 'idle'].includes(clip.name)) closeLoop(arr, fr.length);
      table.push({ name: clip.name, start: clipStart, frames: fr.length, fps: clip.fps, loop: clip.loop,
        pelvis: [fr[0].P[B.pelvis][1], fr[0].P[B.pelvis][2]] });
      clipStart += fr.length;
      pal.push(arr);
    }
    const set = c.sex === 'female' ? 0 : 1;
    if (!clipSets[set]) clipSets[set] = table;
    else if (table.some((t, i) => t.frames !== clipSets[set][i].frames)) throw new Error('clips differ in length within a sex');
    const paletteStart = paletteFrames;
    paletteFrames += clipStart;
    palettes.push(...pal);
    variations.push({ clipSet: set, paletteStart, sex: c.sex, band: c.band, years: c.years, height: +body.height.toFixed(3), outfit: c.outfit, hair: c.hair, shoes: c.shoes, hat: c.hat, skin: c.skin, lod: lods, sitPelvis: table[2].pelvis.map((x) => +x.toFixed(3)),
      walkAdvance: +(cap.walk === captures.male.walk ? 1.495864 : 1.596625).toFixed(4) * ((body.bindHead[B.pelvis][1]) / 0.9) });
    console.log(`${vi.toString().padStart(2)} ${c.sex} ${c.band} ${c.outfit} ${c.hair}: ${verts.length} vertices, ${lods.map((l) => l[1]).join(' / ')} triangles, ${body.height.toFixed(2)} m`);
    if (PREVIEW) previews.push({ verts, lists, pal, table });
  }
  const pal = new Float32Array(palettes.reduce((s, a) => s + a.length, 0));
  { let o = 0; for (const a of palettes) { pal.set(a, o); o += a.length; } }
  const sections = [['vpos', new Float32Array(vpos)], ['vattr', new Uint32Array(vattr)], ['index', new Uint32Array(index)], ['palette', pal]];
  let at = 0;
  const layout = {};
  for (const [name, arr] of sections) { at = Math.ceil(at / 256) * 256; layout[name] = { byteOffset: at, count: arr.length }; at += arr.byteLength; }
  const out = Buffer.alloc(at);
  for (const [name, arr] of sections) Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(out, layout[name].byteOffset);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'people.bin'), out);
  const meta = {
    format: 'roadcraft5-people', version: COOK_VERSION, bytes: at, bones: BONES, parents: PARENT, regions: REGION,
    clipSets: [clipSets[0].map(({ pelvis, ...t }) => t), clipSets[1].map(({ pelvis, ...t }) => t)], paletteFrames, maxTris: lodTris.map((t) => Math.max(...t)),
    vertices: vpos.length / 4, layout, variations,
    sources: { makehuman: 'public/models/people (CC0-1.0, LICENSE-MakeHuman-CC0.txt, LICENSES.json)', rocketbox: 'public/models/citizens (MIT, LICENSE-MICROSOFT.txt)' },
  };
  fs.writeFileSync(path.join(OUT, 'people.json'), JSON.stringify(meta, null, 1));
  console.log(`people.bin ${(at / 1e6).toFixed(1)} MB: ${meta.vertices} vertices, ${index.length / 3} triangles, palettes ${(pal.byteLength / 1e6).toFixed(1)} MB, max ${meta.maxTris.join(' / ')} triangles a person`);
  if (PREVIEW) writePreviews(previews);
}

function writePreviews(previews) {
  const skinned = (pv, lod, clip, frame) => {
    const t = pv.table[clip], arr = pv.pal[clip], o = (frame % t.frames) * NB * 12;
    const verts = pv.verts.map((v) => {
      let p = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const w = v.s.w[k]; if (!w) continue;
        const b = o + v.s.j[k] * 12;
        p = add(p, mul([arr[b] * v.p[0] + arr[b + 1] * v.p[1] + arr[b + 2] * v.p[2] + arr[b + 3], arr[b + 4] * v.p[0] + arr[b + 5] * v.p[1] + arr[b + 6] * v.p[2] + arr[b + 7], arr[b + 8] * v.p[0] + arr[b + 9] * v.p[1] + arr[b + 10] * v.p[2] + arr[b + 11]], w));
      }
      const visible = v.r < 8 || (clip === 3 && v.r === REGION.phone) || (clip === 6 && v.r === REGION.cup) || (clip === 7 && v.r === REGION.umbrella) || (clip === 10 && v.r === REGION.helmet) || (clip === 9 && v.r === REGION.bag);
      return { p: visible ? p : [0, -10, 0], c: v.c };
    });
    return { verts, tris: pv.lists[lod] };
  };
  const dir = path.join(ROOT, 'test-results', 'cook-preview');
  drawPreview(path.join(dir, 'lod0-idle.png'), previews.map((pv) => skinned(pv, 0, 1, 0)));
  drawPreview(path.join(dir, 'lod1-idle.png'), previews.map((pv) => skinned(pv, 1, 1, 0)));
  drawPreview(path.join(dir, 'lod2-idle.png'), previews.map((pv) => skinned(pv, 2, 1, 0)));
  for (const [ci, name] of [[0, 'walk'], [3, 'walkPhone'], [2, 'sit'], [10, 'pedal'], [7, 'walkUmbrella'], [6, 'drink'], [9, 'walkCarry']]) {
    const sel = previews.slice(0, 16);
    drawPreview(path.join(dir, `${name}-side.png`), sel.flatMap((pv) => [0, 8].map((f) => skinned(pv, 0, ci, f))).slice(0, 16), 160, 300, Math.PI / 2);
    drawPreview(path.join(dir, `${name}-front.png`), sel.slice(0, 8).map((pv) => skinned(pv, 0, ci, 4)), 160, 300, 0);
  }
  console.log(`previews in ${dir}`);
}

await main();
