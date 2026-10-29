// Saving the city: one generation of the save (the changed tiles, the map description and the manifest), built on the
// last committed generation. The game owns the state; this module only reads it through SaveHost.
import { TILE_COUNT, cellsOfTile, tileId, tileX } from '../core/grid.ts';
import { packTileHeights } from '../jobs/storage.ts';
import { WATER_TILE_RES } from '../world/ground.ts';
import { customProfiles } from '../roads/profiles.ts';
import { fogLevel } from '../render/scene.ts';
import { encodeMeta } from '../platform/save.ts';
import { KeptFileMissing, type Generation, type SaveSlot } from '../platform/saveFiles.ts';
import { boxTransfer } from '../shared/contracts/worker.ts';
import { t } from '../shared/i18n/index.ts';
import { errorText } from '../shared/errors.ts';
import type { JobPool } from '../jobs/pool.ts';
import type { World } from '../world/world.ts';
import type { Transit } from '../world/transit.ts';
import type { Cloud } from '../render/cloudPuffs.ts';
import type { CameraRig } from '../render/cameraRig.ts';
import type { SkyMode, WeatherCtl } from '../ui/hudActions.ts';

export interface SaveWater { waves: number; foam: number; current: number }

/** What saving needs from the game; no field here is a second owner of the state. */
export interface SaveHost {
  readonly world: World;
  readonly pool: JobPool;
  readonly hud: { toast(message: string): void };
  readonly rig: Pick<CameraRig, 'state'>;
  readonly transit: Transit;
  readonly settings: { paint?: string };
  readonly skyMode: SkyMode;
  readonly weatherCtl: WeatherCtl | null;
  readonly waterCtl: SaveWater;
  readonly clouds: Cloud[];
  readonly hour: number;
  readonly saveBlocked: boolean;
  readonly unsavedSerial: number;
  busy: boolean;
  unsaved: boolean;
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
  if (host.busy) return false;
  if (host.saveBlocked) {
    if (!auto) host.hud.toast(t('save.blocked'));
    return false;
  }
  // busy is taken before anything is awaited, so an opening asked for right after is refused while this save runs
  host.busy = true;
  if (!await host.mayWrite()) { host.busy = false; return false; }
  let slot: SaveSlot;
  try { slot = await host.slot(); await host.keepSlotForThisCity(slot); } catch (err) {
    host.busy = false;
    host.hud.toast(t('save.keepFailed', { message: errorText(err) }));
    return false;
  }
  let base: Generation | null;
  // the generation built on must still have every file (otherwise every tile in the save is written again)
  try { base = host.slotBase && await slot.hasFiles(host.slotBase) ? host.slotBase : null; } catch (err) {
    host.busy = false;
    host.hud.toast(t('save.failed', { message: errorText(err) }));
    return false;
  }
  const w = host.world;
  const serial = host.unsavedSerial;
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
    extra: JSON.stringify({ sky: host.skyMode, weather: host.weatherCtl, water: host.waterCtl, clouds: host.clouds, fog: fogLevel.value, terminals: host.transit.terminals,
      signs: [...w.signTexts], streets: [...w.streetNames], clock: w.clock, paint: host.settings.paint ?? 'br', unlimited: w.unlimited }) });
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
    if (host.unsavedSerial === serial) host.unsaved = false;
    if (auto) host.hud.toast(t('save.auto'));
    else host.hud.toast(tiles.length ? t('save.doneTiles', { tiles: tiles.length, mb: (bytes / 1024 / 1024).toFixed(1) }) : t('save.done'));
    return true;
  } catch (err) {
    console.error('save failed:', err);
    if (err instanceof KeptFileMissing) host.slotBase = null;
    host.hud.toast(t('save.failed', { message: errorText(err) }));
    return false;
  } finally {
    host.busy = false;
  }
}
