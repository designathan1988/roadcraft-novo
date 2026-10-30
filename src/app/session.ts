// Saving the city: one generation of the save (the changed tiles, the map description and the manifest), built on the
// last committed generation. The game owns the state; this module only reads it through SaveHost.
import { MAP_SIZES } from '../config.ts';
import type { Lifecycle } from './lifecycle.ts';
import { Dirty, TILE_COUNT, cellsOfTile, tileId, tileX } from '../core/grid.ts';
import { packTileHeights } from '../jobs/storage.ts';
import { WATER_TILE_RES } from '../world/ground.ts';
import { customProfiles } from '../roads/profiles.ts';
import { MapSizeError, decodeMeta, encodeMeta } from '../platform/save.ts';
import { encodeExtra } from '../platform/mapExtra.ts';
import { QUARANTINE_UNREADABLE_TILES, quarantineSlot } from '../platform/mapFile.ts';
import { KeptFileMissing, type Generation, type Opened, type SaveSlot } from '../platform/saveFiles.ts';
import { boxTransfer } from '../shared/contracts/worker.ts';
import { plural, t } from '../shared/i18n/index.ts';
import { errorText } from '../shared/errors.ts';
import type { JobPool } from '../jobs/pool.ts';
import type { World } from '../world/world.ts';
import type { Transit } from '../world/transit.ts';
import type { CameraRig } from '../render/cameraRig.ts';
import { writeStored } from '../shared/storage.ts';


/** Changes the map size: the world arrays are sized to the map, so the page reloads. */
export function reloadWithMap(tiles: number, then: string): void {
  // without storage it goes through the URL
  writeStored('mapTiles', String(tiles));
  location.href = `${location.pathname}?map=${tiles}&${then}`;
}

export interface LoadReport { missing: number; damaged: number; repaired: number; cut: number }

/** What starting a new city needs from the Game. */
export interface NewMapHost {
  readonly life: Lifecycle;
  readonly world: World;
  readonly hud: { showLoading(message: string): void };
  resetCity(): void;
  generateTerrain(): Promise<void>;
  endRebuild(err: unknown, what: string): void;
}

/** Starts a new city with a fresh seed and generation id. */
/** A new empty map: from `seed` when given (the same terrain again), else from a new random one. */
export async function newMapSession(host: NewMapHost, seed?: number): Promise<void> {
  if (!host.life.begin('generating')) return;
  host.hud.showLoading(t('game.loading.terrain'));
  const w = host.world;
  try {
    host.resetCity();
    w.seed = seed ?? (Math.random() * 2 ** 32) >>> 0;
    w.gameId = (Math.random() * 2 ** 32) >>> 0;
    await host.generateTerrain();
    for (let tile = 0; tile < TILE_COUNT; tile++) for (const c of cellsOfTile(tile)) w.touchCell(c, Dirty.Terrain);
    // the new terrain comes from the seed: it only needs to be written after being edited
    w.saveDirty.fill(0);
    host.endRebuild(null, '');
  } catch (err) {
    host.endRebuild(err, t('game.flow.newMap'));
  }
}

/** What opening a city needs from the Game; the world itself stays the Game's. */
export interface LoadHost {
  readonly life: Lifecycle;
  readonly hud: { toast(message: string): void; showLoading(message: string): void };
  slot(): Promise<SaveSlot>;
  openGeneration(slot: SaveSlot, g: Generation, last: boolean): Promise<LoadReport | null>;
  endRebuild(err: unknown, what: string): void;
}

/**
 * Opens the saved city: its committed generation, or the one before it when that one cannot be used (a file gone or
 * damaged); when no generation can be fully read, the newest is opened and its unreadable tiles come back from the
 * seed. Any failure after the world was cleared ends the flow (no hung loading screen) and blocks saving until
 * another city is opened or made, so the half-built world never overwrites the save. A storage that fails stops the
 * opening and touches nothing. True when the city opened.
 */
export async function loadSession(host: LoadHost): Promise<boolean> {
  if (!host.life.begin('opening')) return false;
  let slot: SaveSlot, opened: Opened;
  try { slot = await host.slot(); opened = await slot.open(); } catch (err) {
    host.life.end('opening');
    host.hud.toast(t('save.storageFailed', { message: errorText(err) }));
    return false;
  }
  if (!opened.found) { host.life.end('opening'); host.hud.toast(t('save.none')); return false; }
  for (const p of opened.problems) console.warn('save:', p);
  const gens = opened.generations;
  // a save of another map size: the page reloads at that size and opens it there
  try { if (gens[0]) decodeMeta(gens[0].metaBytes); } catch (err) {
    if (err instanceof MapSizeError && MAP_SIZES.includes(err.tiles)) { host.life.end('opening'); reloadWithMap(err.tiles, 'open'); return false; }
  }
  if (!gens.length) {
    host.life.end('opening');
    const q = await quarantineSlot(slot, opened.problems.join('; '));
    host.hud.toast(t('save.damaged', { folder: q ?? '—' }));
    return false;
  }
  // generations whose every tile file is there first (newest first), then the others as a last resort
  const order = [...gens.filter((g) => !g.missing.size), ...gens.filter((g) => g.missing.size)];
  host.hud.showLoading(t('save.loading'));
  try {
    let report: LoadReport | null = null, used = order[0];
    // each generation in turn; when none opens whole, the newest opens with what of it can be read
    if (order.length > 1) for (let k = 0; k < order.length && !report; k++) report = await host.openGeneration(slot, (used = order[k]), false);
    if (!report) report = await host.openGeneration(slot, (used = order[0]), true);
    const fellBack = used.gen !== opened.newest;
    const q = fellBack || report!.missing || report!.damaged ? await quarantineSlot(slot, opened.problems.join('; ') || QUARANTINE_UNREADABLE_TILES) : null;
    if (fellBack) host.hud.toast(t('save.fallback', { folder: q ?? '—' }));
    if (report!.damaged) host.hud.toast(plural('save.tilesUnreadable', report!.damaged, { folder: q ?? '—' }));
    if (report!.missing) host.hud.toast(plural('save.tilesMissing', report!.missing, { folder: q ?? '—' }));
    if (report!.cut) host.hud.toast(plural('save.roadsCut', report!.cut));
    if (report!.repaired) host.hud.toast(plural('save.repaired', report!.repaired));
    host.endRebuild(null, '');
    host.hud.toast(t('save.loaded'));
    return true;
  } catch (err) {
    host.endRebuild(err, t('game.flow.load'));
    return false;
  }
}

/** What saving needs from the game; no field here is a second owner of the state. */
export interface SaveHost {
  readonly world: World;
  readonly pool: JobPool;
  readonly hud: { toast(message: string): void };
  readonly rig: Pick<CameraRig, 'state'>;
  readonly transit: Transit;
  readonly hour: number;
  readonly life: Lifecycle;
  slotBase: Generation | null;
  mayWrite(): Promise<boolean>;
  slot(): Promise<SaveSlot>;
  keepSlotForThisCity(slot: SaveSlot): Promise<void>;
}

/**
 * Writes a new generation of the save: the changed tiles, the map's description and the manifest, then the commit
 * (saveFiles.ts); until the commit the save before stays the one that opens. Everything is copied at the start, in
 * one go (tiles, their ground and water, money, clock, junctions…), so the files describe one moment. A tile's mark
 * and `unsaved` are cleared only once the commit is written, and only if nothing changed after the copy; a failed
 * save leaves them set and the next save tries again. True when the save completed.
 */
export async function saveSession(host: SaveHost, auto = false): Promise<boolean> {
  // the half-built world of a failed opening or generation is never saved
  if (host.life.failed) {
    if (!auto) host.hud.toast(t('save.blocked'));
    return false;
  }
  // the save starts before anything is awaited, so an opening asked for right after is refused while it runs
  if (!host.life.begin('saving')) return false;
  if (!await host.mayWrite()) { host.life.end('saving'); return false; }
  let slot: SaveSlot;
  try { slot = await host.slot(); await host.keepSlotForThisCity(slot); } catch (err) {
    host.life.end('saving');
    host.hud.toast(t('save.keepFailed', { message: errorText(err) }));
    return false;
  }
  let base: Generation | null;
  // the generation built on must still have every file (otherwise every tile in the save is written again)
  try { base = host.slotBase && await slot.hasFiles(host.slotBase) ? host.slotBase : null; } catch (err) {
    host.life.end('saving');
    host.hud.toast(t('save.failed', { message: errorText(err) }));
    return false;
  }
  const w = host.world;
  const serial = host.life.serial;
  // a tile is written when it changed, or when the save holds it but the generation built on does not
  const listed = new Uint8Array(w.tileInSave);
  const tiles: number[] = [];
  for (let t = 0; t < TILE_COUNT; t++) if (w.saveDirty[t] || (listed[t] && !base?.tiles.has(t))) tiles.push(t);
  const versions = tiles.map((t) => w.saveVer[t]);
  for (const t of tiles) listed[t] = 1;
  const tileOf = (x: number, z: number) => tileId(tileX(x), tileX(z));
  const gl = WATER_TILE_RES * WATER_TILE_RES;
  const packs = tiles.map((t) => {
    const heights = packTileHeights(w.heights, t);
    const boxes = w.gatherBoxes(cellsOfTile(t));
    const roads = w.roads.saveTile(t, tileOf);
    roads.items = w.items.saveTile(tileOf, t, cellsOfTile(t));
    const ground = w.ground32.slice(t * gl, (t + 1) * gl), water = w.water.slice(t * gl, (t + 1) * gl);
    return host.pool.run('packTile', { tile: t, heights, boxes, roads, ground, water }, { priority: -1,
      transfer: [heights.buffer as ArrayBuffer, ...boxTransfer(boxes), roads.nodes.buffer as ArrayBuffer, roads.segs.buffer as ArrayBuffer, roads.items.buffer as ArrayBuffer, ground.buffer, water.buffer] });
  });
  for (const p of packs) p.catch(() => { /* reported below */ });
  const meta = encodeMeta({ seed: w.seed, gameId: w.gameId, tiles: listed, camera: host.rig.state(), hour: host.hour, transit: host.transit.encode(), profiles: JSON.stringify(customProfiles()), money: w.money, junctions: JSON.stringify([...w.roads.junctions]), biome: w.biome,
    extra: encodeExtra({ weather: w.look.weather, water: w.look.water, clouds: [...w.look.clouds], fog: w.look.fog, terminals: host.transit.terminals,
      signs: [...w.signTexts], streets: [...w.streetNames], clock: w.clock, paint: w.look.paint, unlimited: w.unlimited }) });
  try {
    const writer = await slot.begin();
    let bytes = 0;
    // every write ends before the save does: a failed save never leaves a write running into the next one
    const written = await Promise.allSettled(tiles.map(async (t, k) => { const r = await packs[k]; bytes += r.data.length; await writer.tile(t, r.data, r.hash); }));
    const failed = written.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    const inSave: number[] = [];
    for (let t = 0; t < TILE_COUNT; t++) if (listed[t]) inSave.push(t);
    host.slotBase = await writer.commit(meta, inSave, base, w.gameId, w.seed);
    tiles.forEach((t, k) => { w.tileInSave[t] = 1; if (w.saveVer[t] === versions[k]) w.saveDirty[t] = 0; });
    host.life.saved(serial);
    if (auto) host.hud.toast(t('save.auto'));
    else host.hud.toast(tiles.length ? t('save.doneTiles', { tiles: tiles.length, mb: (bytes / 1024 / 1024).toFixed(1) }) : t('save.done'));
    return true;
  } catch (err) {
    console.error('save failed:', err);
    if (err instanceof KeptFileMissing) host.slotBase = null;
    host.hud.toast(t('save.failed', { message: errorText(err) }));
    return false;
  } finally {
    host.life.end('saving');
  }
}
