// The traffic and pedestrian simulation checked in the real game (the machine's GPU), one scenario per Electron session
// with a user data folder of its own (never the game's). Prints "CHECK OK|FAILED name" lines and leaves each
// scenario's photo in the output folder.
// Usage: npx vite build && node tools/check-sim.mjs [output-folder] [scenario...]   (exits with code 1 if anything fails)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
// a first argument with a slash is the output folder; the rest are scenario names
const out = path.resolve(args[0] && /[\\/]/.test(args[0]) ? args.shift() : path.join(root, 'test-results', 'sim'));
fs.mkdirSync(out, { recursive: true });

const PRELUDE = `
const S = window.__S = window.__S || {};
const g = window.__cidade.game, a = g.api, w = g.world;
const errors = [];
const logError = console.error.bind(console);
console.error = (...x) => { errors.push(x.map(String).join(' ').slice(0, 300)); logError(...x); };
window.addEventListener('error', (e) => errors.push('error: ' + (e.message || e.error)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, why) => console.log('CHECK ' + (ok ? 'OK ' : 'FAILED ') + name + (ok ? '' : ': ' + why));
const stats = () => g.simStats && g.simStats.type === 'stats' ? g.simStats : null;
w.unlimited = true;
`;

const SCENARIOS = {
  // motion probe: what is near the camera, every 0.25 s for 20 s, at a junction with a light, one without, a
  // roundabout and a street with a bus stop; roadcraft 4.0's invariants (sim/invariants.ts) checked on it, and frames
  // about a second apart at each place
  'motion': { query: '?cidade&mapa=10&limpo&hora=11', limit: 900, steps: () => motionSteps() },
  // the generated 10 km city: traffic and people everywhere, figures for the whole city, a busy junction photographed
  'city-traffic': {
    query: '?cidade&mapa=10&limpo&hora=8',
    body: `
      await wait(45000);
      const s1 = stats();
      check('the city has traffic', s1 && s1.cars > 2000, 'cars ' + (s1 && s1.cars));
      check('the city has pedestrians', s1 && s1.peds > 2000, 'pedestrians ' + (s1 && s1.peds));
      check('the city speed is a speed (whole city, not the camera)', s1 && s1.speed > 1 && s1.speed < 25, 'speed ' + (s1 && s1.speed));
      await wait(20000);
      const s2 = stats();
      check('trips end', s2 && s2.arrived > s1.arrived, 'arrived ' + s1.arrived + ' -> ' + (s2 && s2.arrived));
      check('few trips are lost', s2 && (s2.lost - s1.lost) <= Math.max(10, (s2.arrived - s1.arrived) * 0.05), 'lost ' + s1.lost + ' -> ' + (s2 && s2.lost) + ' while ' + (s2.arrived - s1.arrived) + ' arrived');
      // a four-way junction with a light near the middle of the city, seen from a street corner
      const nc = w.roads.nodes.cols;
      let best = -1, bd = 1e9;
      for (let n = 0; n < w.roads.nodes.end; n++) {
        if (!w.roads.nodes.alive[n] || nc.deg[n] !== 4) continue;
        const d = Math.hypot(nc.x[n] - 600, nc.z[n] - 600);
        if (d < bd) { bd = d; best = n; }
      }
      check('a junction to look at', best >= 0, 'none');
      if (best >= 0) await g.view(nc.x[best], nc.z[best], 35, 30, 110, 8);
      await wait(8000);
      const s3 = stats();
      console.log('CHECK INFO cars ' + s3.cars + ' micro ' + s3.micro + ' peds ' + s3.peds + ' speed ' + (s3.speed * 3.6).toFixed(1) + ' km/h stopped ' + s3.stopped + ' arrived ' + s3.arrived + ' lost ' + s3.lost);
      check('nothing reached the console as an error', errors.length === 0, errors.slice(0, 3).join(' | '));
    `,
  },
  // C14: a network change the simulation cannot apply makes the page send the whole network; traffic goes on
  'resync': {
    query: '?vazio&hora=11&workers=3&cam=1500,1500,0,50,600',
    body: `
      const road = (ax, az, bx, bz) => { const r = a.road(ax, az, bx, bz); if (r !== 'ok') throw new Error('road refused: ' + r); };
      for (let i = 0; i < 4; i++) { road(1200, 1200 + i * 150, 1800, 1200 + i * 150); road(1200 + i * 150, 1200, 1200 + i * 150, 1800); }
      await wait(20000);
      const before = stats();
      check('traffic on the new streets', before && before.cars > 20, 'cars ' + (before && before.cars));
      // a node that still has segments: removing it throws inside the simulation's copy of the network
      let n = -1;
      for (let i = 0; i < w.roads.nodes.end && n < 0; i++) if (w.roads.nodes.alive[i] && w.roads.nodes.cols.deg[i] >= 3) n = i;
      const ops = new Float64Array(8); ops[0] = 2; ops[1] = n;
      g.sim.postMessage({ type: 'ops', ops, extra: [] });
      await wait(15000);
      const after = stats();
      check('the failure was reported', errors.some((e) => e.includes('node still connected')), errors.slice(0, 3).join(' | '));
      check('the page sent the whole network again', errors.some((e) => e.includes('rede reenviada')), errors.slice(0, 3).join(' | '));
      check('traffic goes on after it', after && after.cars > 20 && after.arrived >= 0, 'cars ' + (after && after.cars));
      const known = errors.filter((e) => !e.includes('node still connected') && !e.includes('rede reenviada') && !e.includes('network change'));
      check('no other error', known.length === 0, known.slice(0, 3).join(' | '));
    `,
  },
};

// ------------------------------------------------------------ motion probe (scenario 'motion')

/** The places the probe watches (picked in the city by the first step). */
const MOTION_PLACES = ['signal', 'plain', 'ring', 'stop'];
/** Frames per place (about a second apart), samples per place (every 0.25 s) and the radius looked at (m). */
const MOTION_FRAMES = 5, MOTION_SAMPLES = 80, MOTION_R = 60;

function motionSteps() {
  const steps = [['motion-places', MOTION_PICK]];
  MOTION_PLACES.forEach((place, i) => {
    steps.push([`motion-${place}-0`, motionStart(i)]);
    for (let k = 1; k < MOTION_FRAMES; k++) steps.push([`motion-${place}-${k}`, '']);
    steps.push([`motion-${place}-end`, MOTION_CHECK]);
  });
  return steps;
}

// picks the places: a four-way junction with a light, a junction without one, a roundabout and a bus stop, all near
// the middle of the city
const MOTION_PICK = `
  S.inspect = (x, z, r) => new Promise((res) => {
    const h = (e) => { if (e.data && e.data.type === 'inspect') { g.sim.removeEventListener('message', h); res(e.data); } };
    g.sim.addEventListener('message', h);
    g.sim.postMessage({ type: 'inspect', x, z, r });
  });
  await wait(30000);
  const nc = w.roads.nodes.cols, sc = w.roads.segs.cols;
  const ringAt = (n) => w.roads.segsOf(n, []).some((s) => sc.flags[s] & 1);
  const cand = [];
  for (let n = 0; n < w.roads.nodes.end; n++) if (w.roads.nodes.alive[n] && nc.deg[n] >= 3) cand.push(n);
  cand.sort((a, b) => Math.hypot(nc.x[a] - 300, nc.z[a] - 300) - Math.hypot(nc.x[b] - 300, nc.z[b] - 300));
  const P = S.places = {};
  for (const n of cand.slice(0, 300)) {
    if (P.signal && P.plain) break;
    if (ringAt(n)) continue;
    const r = await S.inspect(nc.x[n], nc.z[n], 1);
    const lit = r.lights.some((v, i) => i % 2 === 0 && v === n);
    if (lit && !P.signal && nc.deg[n] === 4) P.signal = { x: nc.x[n], z: nc.z[n], node: n };
    if (!lit && !P.plain) P.plain = { x: nc.x[n], z: nc.z[n], node: n };
  }
  // a roundabout and a bus line: the generated city has none, so the probe builds them (a roundabout on another
  // four-way junction without a light, a line through the junction without one)
  const used = new Set([P.signal && P.signal.node, P.plain && P.plain.node]);
  const four = cand.slice(0, 300).find((n) => nc.deg[n] === 4 && !used.has(n) && !ringAt(n) && Math.hypot(nc.x[n] - P.plain.x, nc.z[n] - P.plain.z) > 150);
  if (four !== undefined) {
    const x = nc.x[four], z = nc.z[four];
    const m0 = g.roadTool.mode; g.roadTool.setMode('roundabout'); g.roadTool.click({ x, z }, false); g.roadTool.setMode(m0);
    let rb = 1e18;
    for (let s = 0; s < w.roads.segs.end; s++) {
      if (!w.roads.segs.alive[s] || !(sc.flags[s] & 1)) continue;
      const d = Math.hypot(sc.mx[s] - x, sc.mz[s] - z);
      if (d < rb) { rb = d; P.ring = { x, z, node: -1 }; }
    }
  }
  if (P.plain) {
    // stops on the sidewalk of the plain junction's arms, 30 m out from it
    const stops = [];
    for (const s of w.roads.segsOf(P.plain.node, [])) {
      const far = sc.a[s] === P.plain.node ? sc.b[s] : sc.a[s];
      const dx = nc.x[far] - P.plain.x, dz = nc.z[far] - P.plain.z, l = Math.hypot(dx, dz) || 1;
      stops.push(P.plain.x + dx / l * 30 + dz / l * 7, P.plain.z + dz / l * 30 - dx / l * 7);
    }
    a.line(0, stops, 3);
    const ln = g.transit.lines[g.transit.lines.length - 1];
    if (ln && ln.stops.length) P.stop = { x: ln.stops[0], z: ln.stops[1], node: -1 };
    console.log('CHECK INFO line ' + JSON.stringify(ln && ln.stops));
  }
  await wait(20000);
  console.log('CHECK INFO places ' + JSON.stringify(P));
  for (const k of ${JSON.stringify(MOTION_PLACES)}) check('a place to watch: ' + k, !!P[k], 'none in the city');
`;

// goes to place i, lets the window fill, and starts sampling in the background (the frames are taken meanwhile)
const motionStart = (i) => `
  const name = ${JSON.stringify(MOTION_PLACES)}[${i}], P = S.places[name];
  S.place = name; S.samples = []; S.done = !P;
  if (P) {
    await g.view(P.x, P.z, 35, 38, 70, 11);
    await wait(8000);
    const people = () => {
      const rd = g.poses, d = rd.data, n = rd.count, out = [];
      for (let k = 0; k < n; k++) {
        const o = k * 11, type = Math.floor((d[o + 8] % 65536) / 256);
        if (type !== 3 || Math.hypot(d[o + 4] - P.x, d[o + 6] - P.z) > ${MOTION_R}) continue;
        out.push(d[o + 4], d[o + 6], d[o], d[o + 2], d[o + 10]);
      }
      return { list: out, dt: rd.dt };
    };
    (async () => {
      for (let k = 0; k < ${MOTION_SAMPLES}; k++) {
        const t = performance.now();
        const r = await S.inspect(P.x, P.z, ${MOTION_R});
        r.people = people();
        S.samples.push(r);
        await wait(Math.max(0, 250 - (performance.now() - t)));
      }
      S.done = true;
    })();
  }
`;

// waits for the samples and checks them (roadcraft 4.0 sim/invariants.ts, and what a player sees)
const MOTION_CHECK = `
  while (!S.done) await wait(200);
  const name = S.place, smp = S.samples;
  if (!smp.length) console.log('CHECK INFO ' + name + ': no place, skipped');
  else await (async () => {
  const V = 18, Q = 12, W = [1.8, 2.55, 2.5, 0.8, 3.0];
  const RED = 1, BAY = 2, LEAVING = 4, STOP = 8, GATE = 32;
  const f1 = (x) => x.toFixed(1);
  // vehicles
  const stall = new Map(), box = new Map(), offLane = new Map(), seenV = new Set(), movedV = new Set();
  let worstWait = 0, waitEx = '', worstStall = 0, stallEx = '', worstBox = 0, boxEx = '', offEx = '', overlaps = 0, overlapEx = '';
  const clashes = new Set(); let clashEx = '';
  const corners = (v, o) => {
    const x = v[o + 2], z = v[o + 3], y = v[o + 4], L = v[o + 5] / 2, H = W[v[o + 1]] / 2;
    const fx = Math.sin(y), fz = Math.cos(y), sx = Math.cos(y), sz = -Math.sin(y);
    return [[x + fx * L + sx * H, z + fz * L + sz * H], [x + fx * L - sx * H, z + fz * L - sz * H], [x - fx * L - sx * H, z - fz * L - sz * H], [x - fx * L + sx * H, z - fz * L + sz * H]];
  };
  const depth = (A, B) => {
    let best = 1e9;
    for (const P of [A, B]) for (let i = 0; i < 4; i++) {
      const ax = -(P[(i + 1) % 4][1] - P[i][1]), az = P[(i + 1) % 4][0] - P[i][0], l = Math.hypot(ax, az) || 1;
      let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
      for (const p of A) { const t = (p[0] * ax + p[1] * az) / l; a0 = Math.min(a0, t); a1 = Math.max(a1, t); }
      for (const p of B) { const t = (p[0] * ax + p[1] * az) / l; b0 = Math.min(b0, t); b1 = Math.max(b1, t); }
      best = Math.min(best, Math.min(a1, b1) - Math.max(a0, b0));
    }
    return best;
  };
  const first = new Map();
  for (let i = 0; i < smp.length; i++) {
    const r = smp[i], v = r.vehicles, n = v.length / V, dt = i ? r.time - smp[i - 1].time : 0;
    for (let a = 0; a < n; a++) {
      const o = a * V, id = v[o], fl = v[o + 9], still = v[o + 6] < 0.1, conn = v[o + 7];
      seenV.add(id);
      if (!first.has(id)) first.set(id, [v[o + 2], v[o + 3]]);
      else if (Math.hypot(v[o + 2] - first.get(id)[0], v[o + 3] - first.get(id)[1]) > 2) movedV.add(id);
      const why = (fl & (RED | BAY | LEAVING | STOP | GATE)) || (v[o + 10] < 8 && v[o + 11] < 1);
      const st = still && !why && conn < 0 ? (stall.get(id) || 0) + dt : 0;
      stall.set(id, st);
      if (st > worstStall) { worstStall = st; stallEx = 'vehicle ' + id + ' (kind ' + v[o + 1] + ') at ' + f1(v[o + 2]) + ',' + f1(v[o + 3]) + ' to the line ' + f1(v[o + 12]) + ' m, flags ' + fl; }
      // waiting at its line not for a red: a junction that never lets it go (roadcraft invariants.ts greenBlocked)
      if (conn < 0 && !(fl & RED) && v[o + 13] > worstWait) { worstWait = v[o + 13]; waitEx = 'vehicle ' + id + ' at ' + f1(v[o + 2]) + ',' + f1(v[o + 3]) + ' waiting ' + f1(v[o + 13]) + ' s at its line, flags ' + fl; }
      const bx = still && conn >= 0 ? (box.get(id) || 0) + dt : 0;
      box.set(id, bx);
      if (bx > worstBox) { worstBox = bx; boxEx = 'vehicle ' + id + ' (kind ' + v[o + 1] + ') at ' + f1(v[o + 2]) + ',' + f1(v[o + 3]) + ' on connection ' + conn; }
      // past the junction's edge (the distance counts from the setback), over something that is not a lane
      if (v[o + 1] !== 4 && !(fl & (BAY | LEAVING)) && v[o + 17] > 1 && v[o + 16] !== 1) {
        offLane.set(id, (offLane.get(id) || 0) + 1);
        if (offLane.get(id) >= 2 && !offEx) offEx = 'vehicle ' + id + ' at ' + f1(v[o + 2]) + ',' + f1(v[o + 3]) + ' over strip ' + v[o + 16];
      }
    }
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const oa = a * V, ob = b * V;
      if (v[oa + 1] === 4 || v[ob + 1] === 4 || Math.hypot(v[oa + 2] - v[ob + 2], v[oa + 3] - v[ob + 3]) > 16) continue;
      const d = depth(corners(v, oa), corners(v, ob));
      if (d > 0.25) { overlaps++; if (!overlapEx) overlapEx = 'vehicles ' + v[oa] + ' and ' + v[ob] + ' at ' + f1(v[oa + 2]) + ',' + f1(v[oa + 3]) + ' (' + f1(d) + ' m into each other)'; }
    }
    for (let k = 0; k < r.clashes.length; k += 4) {
      const key = Math.min(r.clashes[k], r.clashes[k + 1]) + '/' + Math.max(r.clashes[k], r.clashes[k + 1]);
      if (!clashes.has(key) && !clashEx) clashEx = 'vehicles ' + key + ' over the crossing point ' + f1(r.clashes[k + 2]) + ',' + f1(r.clashes[k + 3]);
      clashes.add(key);
    }
  }
  const ranRed = smp[smp.length - 1].ranRed - smp[0].ranRed;
  // people (the simulation's pedestrians, by id)
  let walkS = 0, offSpeed = 0, speedEx = '', inPlace = 0, inPlaceEx = '', redCross = 0, redEx = '', inCar = 0, inCarEx = '';
  const offWalk = new Map(); let offWalkEx = '';
  const lastP = new Map(), startP = new Map(), modes = [0, 0, 0, 0, 0];
  for (let i = 0; i < smp.length; i++) {
    const r = smp[i], p = r.peds, n = p.length / Q, v = r.vehicles, nv = v.length / V;
    const light = new Map();
    for (let k = 0; k < r.lights.length; k += 2) light.set(r.lights[k], r.lights[k + 1]);
    for (let a = 0; a < n; a++) {
      const o = a * Q, id = p[o], x = p[o + 1], z = p[o + 2], speed = p[o + 4], mode = p[o + 5], arm = p[o + 6], bike = p[o + 8];
      if (i === smp.length - 1) modes[mode]++;
      if (!startP.has(id)) startP.set(id, [x, z, r.time]);
      const prev = lastP.get(id);
      const walking = !bike && (mode === 0 || mode === 1);
      if (walking) {
        // its own pace when nothing is in its way (behind someone it walks at theirs, or stops: p[o + 11] < 1)
        if (p[o + 11] > 0.999) walkS++;
        if (p[o + 11] > 0.999 && (speed < 1.15 || speed > 1.55)) { offSpeed++; if (!speedEx) speedEx = 'person ' + id + ' at ' + f1(speed) + ' m/s'; }
        if (prev && prev[3] === i - 1 && (prev[2] === 0 || prev[2] === 1) && Math.hypot(x - prev[0], z - prev[1]) < 0.05 && speed > 0.5) { inPlace++; if (!inPlaceEx) inPlaceEx = 'person ' + id + ' at ' + f1(x) + ',' + f1(z) + ' in mode ' + mode; }
      }
      // on a lane, parking strip or bike lane beyond the crosswalks (they lie within 4.5 m of the junction's edge)
      if (!bike && (p[o + 9] === 1 || p[o + 9] === 2 || p[o + 9] === 3) && p[o + 10] > 4.5) {
        offWalk.set(id, (offWalk.get(id) || 0) + 1);
        if (offWalk.get(id) >= 2 && !offWalkEx) offWalkEx = 'person ' + id + ' at ' + f1(x) + ',' + f1(z) + ' on strip ' + p[o + 9] + ' ' + f1(p[o + 10]) + ' m past the junction (mode ' + mode + ')';
      }
      // starting to cross: never over an arm whose traffic has the green
      if (arm > 0 && (!prev || prev[4] === 0)) {
        const st = light.get(p[o + 7]);
        if (st && (st & 64) === 0 && (st & (1 << (arm - 1)))) { redCross++; if (!redEx) redEx = 'person ' + id + ' crossing arm ' + (arm - 1) + ' of node ' + p[o + 7] + ' (light ' + st + ')'; }
      }
      for (let b = 0; b < nv && !bike; b++) {
        const ob = b * V, y = v[ob + 4], dx = x - v[ob + 2], dz = z - v[ob + 3];
        const lf = dx * Math.sin(y) + dz * Math.cos(y), ls = dx * Math.cos(y) - dz * Math.sin(y);
        if (v[ob + 1] !== 4 && Math.abs(lf) < v[ob + 5] / 2 - 0.15 && Math.abs(ls) < W[v[ob + 1]] / 2 - 0.15) { inCar++; if (!inCarEx) inCarEx = 'person ' + id + ' (mode ' + mode + ', strip ' + p[o + 9] + ') inside vehicle ' + v[ob] + ' (kind ' + v[ob + 1] + ', ' + f1(v[ob + 6]) + ' m/s, flags ' + v[ob + 9] + ', connection ' + v[ob + 7] + ') at ' + f1(x) + ',' + f1(z); }
      }
      lastP.set(id, [x, z, mode, i, arm]);
    }
  }
  let moved = 0, walkers = 0;
  const end = smp[smp.length - 1];
  for (let a = 0; a < end.peds.length / Q; a++) {
    const o = a * Q, s0 = startP.get(end.peds[o]);
    if (!s0 || end.time - s0[2] < 4) continue;
    walkers++;
    if (Math.hypot(end.peds[o + 1] - s0[0], end.peds[o + 2] - s0[1]) > 1) moved++;
  }
  // people as drawn (pose buffer: pedestrians and those at the stops): bodies apart, feet matching the ground speed
  let fused = 0, fusedEx = '', anim = 0, animBad = 0, animEx = '';
  let prevPairs = new Set();
  for (let i = 0; i < smp.length; i++) {
    const L = smp[i].people.list, dtp = smp[i].people.dt / 1000, n = L.length / 5, pairs = new Set();
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      if (Math.hypot(L[a * 5] - L[b * 5], L[a * 5 + 1] - L[b * 5 + 1]) >= 0.35) continue;
      const key = Math.round((L[a * 5] + L[b * 5]) * 2) + ',' + Math.round((L[a * 5 + 1] + L[b * 5 + 1]) * 2);
      pairs.add(key);
      if (prevPairs.has(key)) { fused++; if (!fusedEx) fusedEx = 'two people within 0.35 m at ' + f1(L[a * 5]) + ',' + f1(L[a * 5 + 1]); }
    }
    prevPairs = pairs;
    if (!i) continue;
    const P0 = smp[i - 1].people.list, dts = smp[i].time - smp[i - 1].time;
    for (let a = 0; a < n; a++) {
      const x = L[a * 5], z = L[a * 5 + 1], look = L[a * 5 + 4];
      const rec = Math.hypot(x - L[a * 5 + 2], z - L[a * 5 + 3]) / Math.max(1e-3, dtp);
      let best = 1e9;
      for (let b = 0; b < P0.length; b += 5) if (P0[b + 4] === look) best = Math.min(best, Math.hypot(x - P0[b], z - P0[b + 1]));
      if (best > 1 || dts <= 0) continue;
      const seen = best / dts;
      anim++;
      if ((seen > 0.6 && rec < 0.3) || (seen < 0.1 && rec > 0.6)) { animBad++; if (!animEx) animEx = 'person at ' + f1(x) + ',' + f1(z) + ' moving ' + f1(seen) + ' m/s, feet for ' + f1(rec) + ' m/s'; }
    }
  }
  console.log('CHECK INFO ' + name + ': ' + seenV.size + ' vehicles (' + movedV.size + ' moved over 2 m), people by mode now (sidewalk, line, waiting, standing, leaving) ' + modes.join('/') + ', ' + moved + ' of ' + walkers + ' people seen for 4 s moved over 1 m');
  check(name + ': vehicles there', seenV.size > 0, 'none');
  check(name + ': no vehicle stands without a reason (red, queue, bay, stop, give way) for over 5 s', worstStall <= 5, f1(worstStall) + ' s: ' + stallEx);
  check(name + ': no vehicle waits at its line over 30 s but for a red', worstWait <= 30, f1(worstWait) + ' s: ' + waitEx);
  check(name + ': no vehicle stands inside the junction for over 10 s', worstBox <= 10, f1(worstBox) + ' s: ' + boxEx);
  check(name + ': vehicles keep to their lane', !offEx, offEx);
  check(name + ': vehicle bodies never overlap', overlaps === 0, overlaps + ' times; ' + overlapEx);
  check(name + ': never two vehicles over the crossing point of their paths in a junction', clashes.size === 0, clashes.size + ' pairs; ' + clashEx);
  check(name + ': nobody enters a junction on red', ranRed === 0, ranRed + ' entered on red');
  check(name + ': people walk at 1.2-1.5 m/s', walkS > 0 && offSpeed <= walkS * 0.05, offSpeed + ' of ' + walkS + ' samples; ' + speedEx);
  check(name + ': people move (most of those seen for 4 s went somewhere)', walkers > 0 && moved >= walkers * 0.5, moved + ' of ' + walkers);
  check(name + ': people only on the sidewalk and the crosswalks', !offWalkEx, offWalkEx);
  check(name + ': people start crossing only when the light lets them', redCross === 0, redCross + '; ' + redEx);
  check(name + ': nobody inside a vehicle', inCar === 0, inCar + '; ' + inCarEx);
  check(name + ': people never inside each other', fused === 0, fused + ' times; ' + fusedEx);
  check(name + ': nobody walks in place', inPlace === 0, inPlace + '; ' + inPlaceEx);
  check(name + ': the feet follow the ground speed', anim > 0 && animBad <= anim * 0.02, animBad + ' of ' + anim + '; ' + animEx);
  })();
`;

const names = args.length ? args : Object.keys(SCENARIOS);
let failed = 0;
for (const name of names) {
  const sc = SCENARIOS[name];
  if (!sc) { console.log(`unknown scenario ${name}`); failed++; continue; }
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'roadcraft-sim-'));
  // a scenario is one script (`body`, one photo) or several in a row (`steps`: [photo name, script], a photo after
  // each); the prelude runs before each, and the last prints the end
  const steps = sc.steps ? sc.steps() : [[name, sc.body]];
  const wrap = (body, last) => !body && !last ? '' : `(async()=>{${PRELUDE}\ntry {${body}\n} catch (e) { check('scenario ran to the end', false, e && e.stack || e); }\n${last ? "console.log('CHECK END');" : ''}})()`;
  const files = steps.map(([n]) => path.join(out, `${n}.png`));
  const scripts = steps.map(([, b], i) => wrap(b, i === steps.length - 1));
  const lines = await new Promise((resolve) => {
    const got = [];
    const seq = JSON.stringify(files.slice(1).map((file, i) => [file, scripts[i + 1]]));
    const p = spawn(process.execPath, [path.join(root, 'tools', 'shot.mjs'), files[0], sc.query, scripts[0]],
      { cwd: root, env: { ...process.env, CIDADE_USER_DATA: own, CIDADE_SETTLE: '1', CIDADE_LIMIT: String(sc.limit ?? 600), CIDADE_SEQ: seq } });
    p.stdout.on('data', (d) => got.push(...String(d).split('\n')));
    p.on('exit', () => resolve(got));
  });
  const checks = lines.filter((l) => l.includes('CHECK ')).map((l) => l.slice(l.indexOf('CHECK ') + 6));
  if (!checks.includes('END')) checks.push('FAILED the session did not finish (hung or crashed) after: ' + (checks[checks.length - 1] ?? 'nothing'));
  const bad = checks.filter((c) => c.startsWith('FAILED'));
  failed += bad.length;
  console.log(`${name}: ${checks.filter((c) => c.startsWith('OK')).length} ok, ${bad.length} failed (photo${files.length > 1 ? 's ' + path.join(out, name + '-*.png') : ' ' + files[0]})`);
  for (const c of checks.filter((c) => c.startsWith('INFO') || c.startsWith('FAILED'))) console.log('  ' + c);
  fs.rmSync(own, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? `sim check: ${failed} FAILED` : 'sim check: ok');
process.exit(failed ? 1 : 0);
