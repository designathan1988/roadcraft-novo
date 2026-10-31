// The named photo sets of tools/photos/run.mjs. A set: the page's query, its shots ([file name, page script]), and
// optionally its own env. Places that must be a street are found in the generated network (views.mjs) near a point,
// never a fixed coordinate (the 4.0 block grid put buildings where streets were). Scene sets build a small situation
// on an empty map and print a RESULT line with what they measured.
import { VIEWS, findStreetView, viewScript } from './views.mjs';
import { SCENES as INTERFACE } from './interface.mjs';

const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
const CITY = '?city&map=10&clear&hour=11';
const EMPTY = '?empty&hour=11';
const byName = Object.fromEntries(VIEWS.map((v) => [v.name, v]));

/** Page script: the street nearest (x, z) found, the camera on it looking `turn` degrees off its direction. */
const atStreet = ([x, z], { turn = 0, pitch, dist, hour = 11, ms = 4000, after = '' }) =>
  `(async()=>{const R=window.__roadcraft;const sv=(${findStreetView.toString()})(R,${x},${z},${dist},${pitch});` +
  `if(!sv){console.log('error: no street near ${x},${z}');return;}` +
  `await R.camera.view(sv.x,sv.z,sv.yaw+${turn},${pitch},${dist},${hour});${wait(ms)}${after}})()`;
const at = ([x, z], yaw, pitch, dist, hour, ms) => `(async()=>{await window.__roadcraft.camera.view(${x},${z},${yaw},${pitch},${dist},${hour});${wait(ms)}})()`;
const follow = (dist, pitch) => `const R=window.__roadcraft;R.ui.follow();${wait(1200)}R.camera.place({dist:${dist},pitch:${pitch}*Math.PI/180});${wait(2200)}`;

/** A scene on an empty map: `body` runs with g (the game), a (its script API), w (the world), X, Z (the scene's centre). */
const scene = (body) => `(async()=>{const R=window.__roadcraft,a=R.actions,w=R.world,X=1500,Z=1500;const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));${body}})()`;

const STREET = [177, 711];
export const SETS = {
  // the standard views (also tools/fotos.mjs and tools/budget.mjs)
  standard: { query: CITY, shots: [['01-street', viewScript(byName.street, { after: wait(6000) })], ['02-district', viewScript(byName.district, { after: wait(6000) })],
    ['03-city', viewScript(byName.city, { after: wait(8000) })], ['04-night', viewScript(byName.night, { after: wait(6000) })]] },
  // a car close up, day and night, then followed
  car: { query: CITY, shots: [
    ['01-car-8m', atStreet(STREET, { pitch: 8, dist: 8 })], ['02-car-12m', atStreet(STREET, { turn: 180, pitch: 8, dist: 12 })], ['03-car-16m', atStreet(STREET, { pitch: 10, dist: 16 })],
    ['04-car-8m-night', atStreet(STREET, { pitch: 8, dist: 8, hour: 21 })], ['05-car-12m-night', atStreet(STREET, { turn: 180, pitch: 8, dist: 12, hour: 21 })],
    ['06-car-16m-night', atStreet(STREET, { pitch: 10, dist: 16, hour: 21 })], ['07-following-a-car', atStreet(STREET, { pitch: 8, dist: 12, after: `R.ui.follow();${wait(2500)}` })]] },
  // cars at 20, 100 and 500 m, day and night, and followed at those distances
  cars: { query: CITY, shots: [
    ...[[20, 8], [100, 18], [500, 28]].flatMap(([d, p]) => [[`car-${d}m-day`, atStreet(STREET, { pitch: p, dist: d, ms: 4500 })], [`car-${d}m-night`, atStreet(STREET, { pitch: p, dist: d, hour: 21, ms: 4500 })]]),
    ...[20, 100, 500].map((d) => [`follow-${d}m`, atStreet(STREET, { pitch: 8, dist: 20, ms: 3000, after: follow(d, 10) })])].map(([n, s], i) => [`${String(i + 1).padStart(2, '0')}-${n}`, s]) },
  // people placed on the sidewalk, near and far, day and night
  people: { query: CITY, shots: [
    ['01-people-2m-day', atStreet(STREET, { pitch: 4, dist: 2, ms: 2500, after: `for(let k=0;k<150&&!R.people.ready();k++)${wait(200)}const t=R.camera.pose();R.actions.people(t.x,t.z,{count:8,mode:'group',mixed:true});R.actions.people(t.x+6,t.z,{count:4,mode:'walk',mixed:true,hold:'phone'});${wait(1200)}` })],
    ['02-people-20m-day', atStreet(STREET, { pitch: 10, dist: 20, ms: 2500 })], ['03-people-100m-day', atStreet(STREET, { pitch: 18, dist: 100, ms: 2500 })],
    ['04-people-2m-night', atStreet(STREET, { pitch: 4, dist: 2, hour: 21, ms: 2500 })], ['05-people-20m-night', atStreet(STREET, { pitch: 10, dist: 20, hour: 21, ms: 2500 })]] },
  // three streets, cars and buildings near and far, the city by day and by night
  survey: { query: CITY, shots: (() => {
    const A = [177, 711], B = [57, 591], C = [297, 831];
    return [['01-car-a-near-day', atStreet(A, { pitch: 8, dist: 12, ms: 4500 })], ['02-car-a-mid-day', atStreet(A, { turn: 180, pitch: 12, dist: 35, ms: 4500 })],
      ['03-car-a-side-day', atStreet(A, { turn: 90, pitch: 10, dist: 18, ms: 4500 })], ['04-car-b-near-day', atStreet(B, { pitch: 8, dist: 14, ms: 4500 })],
      ['05-car-b-mid-day', atStreet(B, { turn: 180, pitch: 14, dist: 40, ms: 4500 })], ['06-car-c-near-day', atStreet(C, { pitch: 9, dist: 12, ms: 4500 })],
      ['07-car-c-mid-night', atStreet(C, { turn: 180, pitch: 12, dist: 30, hour: 21, ms: 4500 })], ['08-street-b-night', atStreet(B, { turn: 90, pitch: 16, dist: 55, hour: 21, ms: 4500 })],
      ['09-buildings-a-120m', atStreet(A, { pitch: 34, dist: 120, ms: 5000 })], ['10-buildings-b-220m', atStreet(B, { turn: 180, pitch: 40, dist: 220, ms: 5000 })],
      ['11-district-c-400m', at(C, 35, 48, 400, 11, 6000)], ['12-centre-near', at([0, 0], 35, 20, 450, 11, 5000)], ['13-centre-far-night', at([0, 0], 215, 40, 900, 21, 6000)],
      ['14-city-day', at([0, 0], 35, 45, 2200, 11, 8000)], ['15-city-night', at([0, 0], 215, 45, 2200, 21, 8000)]];
  })() },
  // the standard views plus the street close, from both sides, and the city at night
  witness: { query: CITY, shots: [['01-street', viewScript(byName.street, { after: wait(6000) })], ['02-street-near', atStreet(STREET, { pitch: 12, dist: 22, ms: 5000 })],
    ['03-street-near-night', atStreet(STREET, { turn: 180, pitch: 12, dist: 22, hour: 21, ms: 5000 })], ['04-district', viewScript(byName.district, { after: wait(6000) })],
    ['05-city', viewScript(byName.city, { after: wait(8000) })], ['06-night', viewScript(byName.night, { after: wait(6000) })],
    ['07-street-other-side', atStreet(STREET, { turn: 180, pitch: 14, dist: 30, ms: 5000 })], ['08-city-night', at([0, 0], 35, 45, 2200, 21, 8000)]] },
  // a bus on a square of streets turning 90° at the corner, 30 frames 1.5 s apart (motion)
  'bus-turn': { query: EMPTY, shots: [['01-fixed-block', `(async()=>{const R=window.__roadcraft;
    const made=[[1500,1500,1700,1500],[1700,1500,1700,1700],[1700,1700,1500,1700],[1500,1700,1500,1500]].map(([ax,az,bx,bz])=>R.actions.road(ax,az,bx,bz));
    console.log('ROADS '+made.join(','));
    // the line runs east along the south side, then north at the corner: the last leg is the 90° turn
    R.actions.line(0,[1550,1500,1650,1500,1700,1550],3); await R.camera.view(1700,1500,35,30,75,11); ${wait(1500)}})()`],
    ...Array.from({ length: 29 }, (_, i) => [`${String(i + 2).padStart(2, '0')}-frame`, `(async()=>{${wait(1500)}})()`])] },
  // a bus line round four junctions near the street, then buses followed at 13 junctions
  'bus-follow': { query: CITY, shots: [['01-wide-line', `(async()=>{const R=window.__roadcraft,n=R.world.roads,nc=n.nodes.cols;
    const sv=(${findStreetView.toString()})(R,${STREET[0]},${STREET[1]},90,18); if(!sv){console.log('error: no street');return;}
    const picks=[]; for(const [dx,dz] of [[-80,-80],[80,-80],[80,80],[-80,80]]){ let best=-1,bd=1e9;
      for(let i=0;i<nc.x.length;i++){ if(!n.nodes.alive[i]||nc.deg[i]<2)continue; const d=Math.hypot(nc.x[i]-(sv.x+dx),nc.z[i]-(sv.z+dz)); if(d<bd){bd=d;best=i;} }
      if(best>=0)picks.push(nc.x[best],nc.z[best]); }
    R.actions.line(0,picks,4); await R.camera.view(sv.x,sv.z,sv.yaw,18,90,11); ${wait(4500)}})()`],
    ...Array.from({ length: 13 }, (_, i) => [`${String(i + 2).padStart(2, '0')}-follow-${String.fromCharCode(97 + i)}`, `(async()=>{const R=window.__roadcraft,r=R.sim.poses(),d=r.data,n=R.world.roads,nc=n.nodes.cols;
      if(!R.camera.following()){ let jx=0,jz=0,jd=1e9;
        for(let i=0;i<nc.x.length;i++){ if(!n.nodes.alive[i]||nc.deg[i]<3)continue; const q=Math.hypot(nc.x[i]-R.camera.pose().eye.x,nc.z[i]-R.camera.pose().eye.z); if(q>30&&q<jd){jd=q;jx=nc.x[i];jz=nc.z[i];} }
        let best=-1,bd=1e9; for(let i=0;i<r.count;i++){ const o=i*11; if(Math.floor((d[o+8]%65536)/256)!==1)continue; const dd=Math.hypot(d[o+4]-jx,d[o+6]-jz); if(dd<bd){bd=dd;best=i;} }
        if(best>=0){const o=best*11;R.camera.followAt(d[o+4],d[o+6],40);R.camera.place({dist:28,pitch:10*Math.PI/180});} }
      ${wait(2200)}})()`])] },
  // the camera following a car
  follow: { query: CITY, shots: [['01-following', atStreet(STREET, { pitch: 12, dist: 20, ms: 3500, after: `R.ui.follow();${wait(2500)}` })]] },
  // the interface, panel by panel (tools/photos/interface.mjs); 'start' opens on the title screen, 'english' in English
  interface: { query: `${CITY}&cam=0,0,35,32,260`, shots: Object.entries(INTERFACE), env: { ROADCRAFT_SETTLE: '2' },
    queryFor: (names) => (names[0] === 'start' ? '?map=10&clear&hour=11' : `${CITY}&cam=0,0,35,32,260${names.length === 1 && names[0] === 'english' ? '&lang=en' : ''}${names.length === 1 && names[0] === 'health' ? '&dev' : ''}`) },

  // ---- scenes on an empty map, each printing RESULT <name> {measured}
  // growth: a zoned street growing slowly (2 buildings/s); the next lot is the free one nearest the last, so the street
  // fills in order from the first; at most 3 floors over the neighbour
  growth: { query: EMPTY, shots: [['growth', scene(`a.road(X - 300, Z, X + 300, Z, 'profile.localStreet'); R.cities.growthRate(2);
    a.zone(X - 150, Z, 170, 6); a.zone(X + 150, Z, 170, 6); await wait(7000); R.cities.growthRate(0);
    const col = w.buildings.cols, ids = [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]);
    console.log('RESULT growth ' + JSON.stringify({ buildings: ids.length, order: ids.map((i) => [Math.round(col.x[i] - X), Math.round(col.z[i] - Z), col.floors[i]]) }));
    await R.camera.view(X, Z, 15, 40, 330, 11);`)]] },
  // wear: a grown street, the city clock runs 25 days; half the buildings are renovated (Shift+click)
  wear: { query: EMPTY, shots: [['wear', scene(`a.road(X - 200, Z, X + 200, Z, 'profile.localStreet'); a.zone(X - 100, Z, 120, 1); a.zone(X + 100, Z, 120, 1);
    await a.grow(); a.passTime(25 * 1440);
    const col = w.buildings.cols, ids = [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]);
    for (const id of ids) if (col.x[id] < X) a.renovate(col.x[id], col.z[id]);
    console.log('RESULT wear ' + JSON.stringify({ buildings: ids.length, decayLeft: ids.filter((i) => col.x[i] < X).map((i) => col.decay[i]), decayRight: ids.filter((i) => col.x[i] >= X).map((i) => col.decay[i]) }));
    R.tools.set('building'); R.tools.select(ids.find((i) => col.x[i] >= X && col.floors[i] > 0) ?? -1); await R.camera.view(X, Z, 20, 35, 260, 11);`)]] },
  // road economy: an avenue on the ground, the same raised as a bridge (2.5×), demolishing gives 25 % back, no cash refuses
  economy: { query: EMPTY, shots: [['economy', scene(`const m0 = w.money; a.road(X - 250, Z - 80, X + 250, Z - 80, 'profile.avenue'); const m1 = w.money;
    a.road(X - 250, Z + 80, X + 250, Z + 80, 'profile.avenue', 9); const m2 = w.money;
    const n = a.demolish(X - 60, Z - 95, X + 60, Z - 65); const m3 = w.money;
    w.money = 1000; const r = a.road(X - 250, Z + 220, X + 250, Z + 220, 'profile.avenue'); const intact = w.money === 1000; w.money = m3;
    console.log('RESULT economy ' + JSON.stringify({ start: m0, ground: m0 - m1, bridge: m1 - m2, refunded: m3 - m2, demolished: n, noCash: r, cashIntact: intact }));
    await R.camera.view(X, Z, 30, 45, 560, 11);`)]] },
  // polygon lots: 5 clicks (pentagon), a lot split by a line and a lot with a curved side; each outline marked with a wall
  'polygon-lots': { query: EMPTY, shots: [['polygon-lots', scene(`a.road(X - 200, Z - 40, X + 200, Z - 40, 'profile.localStreet');
    const outline = () => { const col = w.buildings.cols; for (let id = 0; id < w.buildings.end; id++) { if (!w.buildings.alive[id]) continue;
      const o = w.lotOutline(id), c = Math.cos(col.rot[id]), s = Math.sin(col.rot[id]); const P = (k) => [col.x[id] + o[k] * c + o[k + 1] * s, col.z[id] - o[k] * s + o[k + 1] * c];
      for (let k = 0; k < o.length; k += 2) { const p = P(k), q = P((k + 2) % o.length); w.items.add([p[0], p[1], q[0], q[1], 21, 0]); } } };
    const pent = a.lotPoly([X - 150, Z - 25, X - 110, Z - 25, X - 100, Z + 5, X - 130, Z + 30, X - 158, Z + 8], 1);
    a.lotPoly([X - 40, Z - 25, X + 10, Z - 25, X + 10, Z + 25, X - 40, Z + 25], 2); a.lotLine(X - 25, Z - 35, X - 5, Z + 35);
    a.lotPoly([X + 60, Z - 25, X + 110, Z - 25, X + 110, Z + 20, X + 60, Z + 20], 1); a.lotCurve(X + 85, Z + 19, X + 85, Z + 32); outline();
    console.log('RESULT polygon-lots ' + JSON.stringify({ pentagon: pent, corners: [...Array(w.buildings.end).keys()].filter((i) => w.buildings.alive[i]).map((i) => w.buildings.cols.shapeN[i]), lots: w.buildings.size }));
    await R.camera.view(X - 20, Z + 5, 0, 62, 210, 11);`)]] },
  // manoeuvres (Reeds-Shepp, near the camera): streets with parking and sheds; waits for a manoeuvre of kind MANOEUVRE
  // (3 truck backing to a dock, 1 car into a space, 2 out of a space, 4 stopped at the kerb dropping a passenger)
  manoeuvres: { query: EMPTY, shots: [['manoeuvres', scene(`if (R.sim.paused()) R.sim.togglePause();
    if (!w.roads.segs.size) { for (let i = 0; i < 4; i++) { a.road(X - 240, Z - 240 + i * 160, X + 240, Z - 240 + i * 160, 'profile.streetWithParking'); a.road(X - 240 + i * 160, Z - 240, X - 240 + i * 160, Z + 240, 'profile.streetWithParking'); }
      a.zone(X - 80, Z, 260, 1); a.zone(X + 80, Z + 80, 140, 2); await a.grow();
      // sheds facing the street (the dock is at the gate)
      for (const [x0, z0] of [[X - 200, Z - 232], [X - 40, Z - 232], [X + 120, Z - 232]]) a.lot(x0, z0, x0 + 60, z0, x0 + 60, z0 + 60, 3, 2);
      R.tools.select(-1); await R.camera.view(X, Z, 20, 50, 380, 11); }
    const want = Number(globalThis.MANOEUVRE ?? 3); let hit = null, info = null;
    for (let k = 0; k < 120 && !hit; k++) { await wait(1000); info = await a.manoeuvres(); for (let i = 0; i < info.list.length; i += 4) if (info.list[i + 2] === want && info.list[i + 3] > 0.15 && info.list[i + 3] < 0.85) { hit = [info.list[i], info.list[i + 1]]; break; } }
    console.log('RESULT manoeuvres ' + JSON.stringify({ want, found: hit, planned: info?.planned, kerb: info?.kerbStops, docked: info?.docked, running: (info?.list.length ?? 0) / 4 }));
    if (hit) { if (!R.sim.paused()) R.sim.togglePause(); await R.camera.view(hit[0], hit[1], 30, 62, 55, 11); }`)]] },
  // impossible nodes (two roads under 25° apart do not close the junction): counted in the generated city, the camera on the first
  'impossible-nodes': { query: CITY, shots: [['impossible-nodes', `(async()=>{const R=window.__roadcraft,H=R.ui;const list=H.impossibleList();
    console.log('RESULT impossible-nodes '+JSON.stringify({total:H.impossibleNodes(),first:list.slice(0,20)}));
    if(list.length)await R.camera.view(list[1],list[2],30,55,120,11);})()`]] },
  // old map repair (a loose end inside another road becomes a junction on opening), then quarantine (a damaged tile
  // comes back from the original relief; the whole save is copied to saves/quarantine-<date>-… and never deleted)
  'repair-quarantine': { query: EMPTY, shots: [['01-repair', scene(`const net = w.roads; a.road(X - 200, Z, X + 200, Z, 'profile.localStreet');
    const c = net.addNode({ x: X + 20, z: Z + 90, y: a.ground(X + 20, Z + 90) }), d = net.addNode({ x: X + 20, z: Z + 1, y: a.ground(X + 20, Z) });
    net.addSeg({ a: c, b: d, cx: X + 20, cz: Z + 45, profile: 0, flags: 0 }); const before = net.nodes.cols.deg[d];
    await R.saves.save(); await wait(500); await R.saves.load(); await wait(1500);
    const n = net.nearestNode(X + 20, Z, 3);
    console.log('RESULT repair ' + JSON.stringify({ endBefore: before, newNode: n, degreeAfter: n >= 0 ? net.nodes.cols.deg[n] : -1, roads: net.segs.size }));
    await R.camera.view(X + 20, Z, 20, 55, 160, 11);`)],
    ['02-quarantine', scene(`const root = await navigator.storage.getDirectory(), saves = await root.getDirectoryHandle('saves'), dir = await saves.getDirectoryHandle('cidade-1');
    // the scene's tile (x, z = 1500, 1500)
    const name = 'tile_0066.bin', h = await dir.getFileHandle(name); const wr = await h.createWritable(); await wr.write(new Uint8Array([1, 2, 3, 4, 5])); await wr.close();
    await R.saves.load(); await wait(1500);
    const q = []; for await (const [n] of saves) if (/^(quarentena|quarantine)/.test(n)) q.push(n);
    console.log('RESULT quarantine ' + JSON.stringify({ damaged: name, quarantine: q, roads: w.roads.segs.size }));
    await R.camera.view(X + 20, Z, 20, 55, 160, 11);`)]] },
  // transit: a railway crossing streets (level crossing) with a train line; waits for the barrier to come down as the
  // train arrives; also an out-and-back bus line whose return stops are on the other side of the street
  transit: { query: EMPTY, shots: [['transit', scene(`const net = w.roads; w.unlimited = true;
    a.road(X - 700, Z, X + 700, Z, 'profile.doubleRailway'); for (const dx of [-350, 0, 350]) a.road(X + dx, Z - 300, X + dx, Z + 300, 'profile.localStreet');
    a.road(X - 350, Z + 200, X + 350, Z + 200, 'profile.localStreet'); a.zone(X, Z + 250, 300, 1); a.zone(X, Z - 200, 300, 2); await a.grow();
    a.line(1, [X - 650, Z, X + 650, Z], 2); a.line(0, [X - 300, Z + 209, X - 100, Z + 209, X + 100, Z + 209, X + 300, Z + 209], 3);
    const sig = R.sim.signals(); const node = net.nearestNode(X, Z, 5); let down = false, probe = null;
    for (let k = 0; k < 240 && !down; k++) { await wait(500); probe = await a.manoeuvres(); down = (sig[node] & 128) !== 0 || probe.crossings.length > 0; }
    const st = R.sim.stats()?.lines ?? [];
    console.log('RESULT transit ' + JSON.stringify({ barrierDown: down, node, closed: probe?.crossings, trains: probe?.trains, lines: st.map((l) => ({ id: l.id, vehicles: l.buses, waiting: l.waiting, perHour: l.perHour })) }));
    if (down && !R.sim.paused()) R.sim.togglePause();
    const at = probe?.crossings?.length ? probe.crossings[0] : node; await R.camera.view(net.nodes.cols.x[at], net.nodes.cols.z[at], 35, 50, 110, 11);`)]] },
};
