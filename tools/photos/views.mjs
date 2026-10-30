// The standard photo views, one table for tools/fotos.mjs and tools/budget.mjs. The street and night views are not
// fixed coordinates: a fixed point stops being a street when the city generator changes (the 4.0 block grid put a
// building at (0, 0) and at (177, 711), and both views photographed a facade). They are found in the generated
// network instead: the straight segment nearest the asked centre whose whole line of sight, from the target back to
// the eye, runs over roads, looked at along its own direction (the eye in the street, not behind a row of buildings).

/** yaw/pitch in degrees, dist in metres, hour of day; `street: [x, z]` = look along the street nearest (x, z). */
export const VIEWS = [
  { name: 'street', street: [0, 0], pitch: 18, dist: 90, hour: 11 },
  { name: 'district', at: [0, 0], yaw: 35, pitch: 50, dist: 420, hour: 11 },
  { name: 'city', at: [0, 0], yaw: 35, pitch: 45, dist: 2200, hour: 11 },
  { name: 'map', at: [0, 0], yaw: 0, pitch: 75, dist: 11000, hour: 11 },
  { name: 'night', street: [0, 0], pitch: 18, dist: 90, hour: 21 },
];

/**
 * Page-side: the street view nearest (cx, cz) for a camera at `dist` and `pitch`, or null when no straight street
 * within 600 m has a free line of sight. Runs in the game page (stringified), reading the road network.
 */
export function findStreetView(R, cx, cz, dist, pitch) {
  const net = R.world.roads, c = net.segs.cols, n = net.nodes.cols;
  const back = dist * Math.cos((pitch * Math.PI) / 180);
  const cand = [];
  net.forSegsNear(cx - 600, cz - 600, cx + 600, cz + 600, (s) => { cand.push(s); });
  let best = null, bestD = Infinity;
  for (const s of cand) {
    const ax = n.x[c.a[s]], az = n.z[c.a[s]], bx = n.x[c.b[s]], bz = n.z[c.b[s]];
    const mx = (ax + bx) / 2, mz = (az + bz) / 2, len = Math.hypot(bx - ax, bz - az);
    if (len < 40 || Math.hypot(c.cx[s] - mx, c.cz[s] - mz) > 0.5) continue; // short or curved
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    for (const sg of [1, -1]) {
      let free = true;
      for (let t = 0; t <= back && free; t += 10) free = !!net.nearestSeg(mx + sg * dx * t, mz + sg * dz * t, 6);
      if (!free) continue;
      const d = Math.hypot(mx - cx, mz - cz);
      if (d < bestD) { bestD = d; best = { x: mx, z: mz, yaw: (Math.atan2(sg * dx, sg * dz) * 180) / Math.PI }; }
    }
  }
  return best;
}

/**
 * Page script (a string for ROADCRAFT_SEQ / tools/shot.mjs) that puts the camera on view `v` and awaits it; on a street
 * view with no street found it prints `error: no street view` (the callers fail on it). `before` runs before the view
 * is set and `after` once it is (inside the same async function, `R` = the automation contract, window.__roadcraft).
 */
export function viewScript(v, { before = '', after = '' } = {}) {
  const set = v.street
    ? `const sv=(${findStreetView.toString()})(R,${v.street[0]},${v.street[1]},${v.dist},${v.pitch});` +
      `if(!sv){console.log('error: no street view near ${v.street[0]},${v.street[1]}');return;}` +
      `console.log('view: ${v.name} street at '+sv.x.toFixed(1)+','+sv.z.toFixed(1)+' yaw '+sv.yaw.toFixed(1));` +
      `await R.camera.view(sv.x,sv.z,sv.yaw,${v.pitch},${v.dist},${v.hour});`
    : `await R.camera.view(${v.at[0]},${v.at[1]},${v.yaw},${v.pitch},${v.dist},${v.hour});`;
  return `(async()=>{const R=window.__roadcraft;${before}${set}${after}})()`;
}
