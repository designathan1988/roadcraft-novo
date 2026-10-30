// Saving and opening the city: the save slot (its store, the generation a save builds on, the tab's write lock, the
// city it holds, the block after a failed rebuild) and every flow on it (save, open, export, import, a previous
// city, a new map, the save before closing). This module owns that state; what belongs to the rest of the game (the
// layers, the sky, the camera, the buildings read) it reaches through SaveFlowHost.

import { MAP_SIZES } from '../config.ts';
import type { Lifecycle } from './lifecycle.ts';
import { Dirty, TILE_COUNT, cellsOfTile, tileId, tileX } from '../core/grid.ts';
import { SEG_REC, type BoxColumns, type JobResults, type RoadSave } from '../shared/contracts/worker.ts';
import { MapSizeError, decodeMeta } from '../platform/save.ts';
import { decodeExtra, type MapExtra } from '../platform/mapExtra.ts';
import { MapFileError, keepPreviousCity, packSlot, previousCities, readPackage, restorePrevious, savedIn, type SaveActions } from '../platform/mapFile.ts';
import { SaveSlot, SlotLock, TileFileError, WRITES_AT_ONCE, limiter, openSaveStore, type FileStore, type Generation } from '../platform/saveFiles.ts';
import type { JunctionSpec } from '../roads/control.ts';
import { setCustomProfiles, type Profile } from '../roads/profiles.ts';
import { repairDanglingEnds } from '../roads/repair.ts';
import { START_MONEY, type World } from '../world/world.ts';
import type { Transit } from '../world/transit.ts';
import type { JobPool } from '../jobs/pool.ts';
import type { CameraRig } from '../render/cameraRig.ts';
import type { Hud } from '../ui/hud.ts';
import { errorText } from '../shared/errors.ts';
import { t } from '../shared/i18n/index.ts';
import { loadSession, newMapSession, saveSession, type LoadHost, type NewMapHost, type SaveHost } from './session.ts';

/** The save slot of the city (one city per slot; previous cities are kept aside, platform/mapFile.ts). */
export const SLOT = 'cidade-1';

export interface SaveFlowHost {
  readonly world: World;
  readonly pool: JobPool;
  readonly hud: Hud;
  readonly rig: CameraRig;
  readonly transit: Transit;
  /** The game's lifecycle (app/lifecycle.ts): the flows start and end their operation there. */
  readonly life: Lifecycle;
  /** The time of day the save writes. */
  readonly hour: number;
  /** Lets go of the city on screen before another opens (lots under way, layers, props, lines, history). */
  clearForOpen(): void;
  /** Applies the opened map's extra (sky, weather, water, clouds, signs, street names, terminals, paint, clock). */
  applyExtra(ex: MapExtra): void;
  setHour(hour: number): void;
  setBiome(biome: number): void;
  insertBoxes(b: BoxColumns): void;
  resetCity(): void;
  generateTerrain(): Promise<void>;
  endRebuild(err: unknown, what: string): void;
  /** Asks the player before the city on screen is replaced with unsaved work. */
  discardOk(): boolean;
}

export class SaveFlow {
  /** The save files (saveFiles.ts): the browser's storage, or real files in the desktop game. */
  readonly saveStore: Promise<FileStore> = openSaveStore();
  /**
   * The committed generation of this city a save builds on (the one opened or saved last): a save writes only the
   * tiles that changed since and keeps the others' files. null: none (a new city): every tile in the save is written.
   */
  slotBase: Generation | null = null;
  /** The gameId of the city in the save slot (null: not known yet). */
  slotGame: number | null = null;
  /** In the browser, only the tab holding the slot's lock writes it (another tab of the game only reads). */
  private readonly slotLock: SlotLock;
  private h: SaveFlowHost;

  constructor(host: SaveFlowHost) {
    this.h = host;
    this.slotLock = new SlotLock(SLOT, () => this.h.hud.toast(t('save.nowWriter')));
  }

  async slot(): Promise<SaveSlot> { return new SaveSlot(await this.saveStore, SLOT); }

  /** The whole save as one file (the checks and the API). */
  async pack(): Promise<Blob | null> { return packSlot(await this.slot()); }

  /** Whether this tab writes the save (says why not when it does not). */
  async mayWrite(): Promise<boolean> {
    await this.slotLock.ready;
    if (!this.slotLock.writer) this.h.hud.toast(t('save.otherTab'));
    return this.slotLock.writer;
  }

  /**
   * Writes a new generation of the save: the changed tiles, the map's description and the manifest, then the commit
   * (saveFiles.ts); until the commit the save before stays the one that opens. Everything is copied at the start, in
   * one go (tiles, their ground and water, money, clock, junctions…), so the files describe one moment. A tile's mark
   * and `unsaved` are cleared only once the commit is written, and only if nothing changed after the copy; a failed
   * save leaves them set and the next save tries again. True when the save completed.
   */
  async save(auto = false): Promise<boolean> {
    const f = this, h = this.h;
    const host: SaveHost = {
      world: h.world, pool: h.pool, hud: h.hud, rig: h.rig, transit: h.transit, hour: h.hour,
      life: h.life,
      get slotBase() { return f.slotBase; }, set slotBase(v) { f.slotBase = v; },
      mayWrite: () => f.mayWrite(), slot: () => f.slot(), keepSlotForThisCity: (slot) => f.keepSlotForThisCity(slot),
    };
    return saveSession(host, auto);
  }

  /**
   * Opens the saved city: its committed generation, or the one before it when that one cannot be used (a file gone or
   * damaged); when no generation can be fully read, the newest is opened and its unreadable tiles come back from the
   * seed. Any failure after the world was cleared ends the flow (no hung loading screen) and blocks saving until
   * another city is opened or made, so the half-built world never overwrites the save. A storage that fails stops the
   * opening and touches nothing. True when the city opened.
   */
  async load(): Promise<boolean> {
    const f = this, h = this.h;
    const host: LoadHost = {
      life: h.life,
      hud: h.hud,
      slot: () => f.slot(),
      openGeneration: (slot, gen, last) => f.openGeneration(slot, gen, last),
      endRebuild: (err, what) => h.endRebuild(err, what),
    };
    return loadSession(host);
  }

  /**
   * Rebuilds the world from generation `g`. A tile file that cannot be used (gone, cut, damaged, undecodable): with
   * `last` false the result is null and the world is left half built (the caller opens another generation); with
   * `last` its terrain comes back from the seed and it is counted. A storage failure throws.
   */
  async openGeneration(slot: SaveSlot, g: Generation, last: boolean): Promise<{ missing: number; damaged: number; repaired: number; cut: number } | null> {
    const w = this.h.world;
    const meta = decodeMeta(g.metaBytes);
    w.clearBuildings();
    w.items.clear();
    w.clearGround();
    w.roads.clear();
    // what the page holds of the city on screen (lots under way, layers, props, lines, history)
    this.h.clearForOpen();
    try { setCustomProfiles(meta.profiles ? JSON.parse(meta.profiles) as Profile[] : []); } catch { setCustomProfiles([]); }
    this.h.setBiome(meta.biome ?? 0);
    // the balance is saved even with unlimited money on (older saves wrote NaN then: the starting cash comes back)
    w.unlimited = meta.money !== undefined && Number.isNaN(meta.money);
    w.money = meta.money !== undefined && !Number.isNaN(meta.money) ? meta.money : START_MONEY;
    const roads: RoadSave[] = [];
    w.seed = meta.seed;
    w.gameId = meta.gameId;
    if (meta.hour !== undefined) this.h.setHour(meta.hour);
    if (meta.transit) this.h.transit.decode(meta.transit); else this.h.transit.clear();
    // the map's extra, field by field (platform/mapExtra.ts): what it sets is the page's (sky, water, clouds, signs...)
    this.h.applyExtra(decodeExtra(meta.extra));
    w.tileInSave.fill(0);
    for (const t of g.tiles.keys()) w.tileInSave[t] = 1;
    const unreadable: number[] = [];
    let missing = 0;
    const reads = limiter(WRITES_AT_ONCE);
    // every tile ends before the opening goes on or gives up (a tile still arriving would land in the next opening)
    const done = await Promise.allSettled(Array.from({ length: TILE_COUNT }, async (_, t) => {
      const ref = g.tiles.get(t);
      let r: JobResults['unpackTile'] | null = null;
      if (ref) {
        let why = g.missing.get(t) ?? '';
        let gone = !!why;
        if (!why) {
          try {
            const data = await reads(() => slot.readTile(g, t));
            r = await this.h.pool.run('unpackTile', { tile: t, data, hash: ref.hash }, { key: `terrain:${t}`, priority: 0, transfer: [data.buffer as ArrayBuffer] });
            why = r.ok ? '' : r.reason ?? 'unreadable';
          } catch (err) {
            // a storage failure stops the opening; a file that is gone or cut is a tile that cannot be used
            if (!(err instanceof TileFileError)) throw err;
            why = err.message; gone = true;
          }
        }
        if (why) { console.warn(`save: tile ${t} of generation ${g.gen} cannot be used: ${why}`); unreadable.push(t); if (gone) missing++; r = null; }
        else if (r) {
          if (!ref.hash) ref.hash = r.hash; // a save from before generations: the next one records it
          w.tileMin[t] = r.min; w.tileMax[t] = r.max;
          if (r.boxes) this.h.insertBoxes(r.boxes);
          if (r.roads) roads.push(r.roads);
          if (r.roads?.items) w.items.loadTile(r.roads.items);
          w.groundDirty.add(t); w.waterDirty.add(t);
          w.tileWater[t] = r.hasWater ? 1 : 0;
        }
      }
      if (!r && (last || !ref)) {
        // not in the save, or (as a last resort) unusable: the terrain comes back from the seed
        const gr = await this.h.pool.run('terrainGen', { seed: w.seed, tile: t }, { key: `terrain:${t}`, priority: 0 });
        w.tileMin[t] = gr.min; w.tileMax[t] = gr.max; w.tileWater[t] = gr.hasWater ? 1 : 0; w.waterDirty.add(t);
      }
      w.layerDirty.add(t);
      for (const c of cellsOfTile(t)) w.touchCell(c, Dirty.Terrain | Dirty.Buildings);
    }));
    const failed = done.find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
    if (unreadable.length && !last) return null;
    // roads: all nodes before the segments (segments link tiles). A segment saved with its first end whose other end
    // was in a tile that could not be read is left out (it would link to a node that is not there); its tile is
    // written again at the next save
    for (const r of roads) w.roads.loadNodes(r);
    const alive = w.roads.nodes.alive, nc = w.roads.nodes.cols, cutTiles = new Set<number>();
    let cut = 0;
    for (const r of roads) {
      const s = r.segs, keep: number[] = [];
      for (let k = 0; k < s.length; k += SEG_REC) {
        if (alive[s[k + 1]] && alive[s[k + 2]]) { for (let i = 0; i < SEG_REC; i++) keep.push(s[k + i]); continue; }
        cut++;
        const end = alive[s[k + 1]] ? s[k + 1] : s[k + 2];
        if (alive[end]) cutTiles.add(tileId(tileX(nc.x[end]), tileX(nc.z[end])));
      }
      w.roads.loadSegs(keep.length === s.length ? r : { ...r, segs: new Float32Array(keep) });
    }
    // the far road paint of every tile is made again (a tile that lost its roads would keep the old paint)
    for (let t = 0; t < TILE_COUNT; t++) w.dirty.mark(cellsOfTile(t)[0], Dirty.RoadPaint);
    try {
      for (const [id, spec] of meta.junctions ? JSON.parse(meta.junctions) as Array<[number, JunctionSpec]> : []) if (w.roads.nodes.alive[id]) w.roads.setJunction(id, spec);
    } catch { /* save without chosen junctions */ }
    // what was read is what the save holds (opening itself marked it unsaved: clearing the history, water, weather);
    // only the repair below and the tiles that lost a segment or could not be read need writing
    this.h.life.clean();
    w.saveDirty.fill(0);
    // a tile that could not be read now holds the seed's terrain: the next save writes it, so the damaged file stops
    // coming back at every opening (it was kept in quarantine)
    for (const t of [...cutTiles, ...unreadable]) { w.saveDirty[t] = 1; w.saveVer[t]++; }
    if (unreadable.length || cut) this.h.life.changed();
    // old maps: dead ends lying inside another road become junctions (marked to save)
    const repaired = repairDanglingEnds(w);
    if (repaired) this.h.life.changed();
    this.h.rig.restore(meta.camera);
    this.h.hud.viewChanged();
    this.slotGame = meta.gameId;
    this.slotBase = g;
    return { missing, damaged: unreadable.length - missing, repaired, cut };
  }

  /** Saves and downloads the whole map as a .cidade file (only a save that completed is exported, nothing else). */
  async exportMap(): Promise<void> {
    if (!await this.save()) { this.h.hud.toast(t('save.exportNotSaved')); return; }
    if (!this.h.life.begin('exporting')) return;
    let blob: Blob | null;
    try { blob = await packSlot(await this.slot()); } catch (err) {
      this.h.hud.toast(t('save.failed', { message: errorText(err) }));
      return;
    } finally { this.h.life.end('exporting'); }
    if (!blob) { this.h.hud.toast(t('save.exportNothing')); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cidade-${this.h.world.seed}.cidade`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    this.h.hud.toast(t('save.exported', { mb: (blob.size / 1024 / 1024).toFixed(1) }));
  }

  /**
   * Opens a map from a file. The file is read and checked (its map description and every file it lists) before
   * anything is touched; the city saved before is kept as a previous city; then the file's save is committed as a new
   * generation of the slot and opened.
   */
  async importMap(file: Blob): Promise<void> {
    if (!this.h.life.begin('importing')) return;
    if (!await this.mayWrite()) { this.h.life.end('importing'); return; }
    let kept: string | null;
    try {
      const saved = await savedIn(await readPackage(file));
      try { decodeMeta(saved.meta); } catch (err) {
        if (!(err instanceof MapSizeError && MAP_SIZES.includes(err.tiles))) throw new MapFileError(/newer/.test(errorText(err)) ? 'save.file.newer' : 'save.file.damaged', errorText(err));
      }
      const slot = await this.slot();
      kept = await keepPreviousCity(slot);
      await slot.adopt(saved.meta, saved.tiles, saved.gameId, saved.seed);
    } catch (err) {
      this.h.hud.toast(t('save.importFailed', { why: err instanceof MapFileError ? t(err.key) : errorText(err) }));
      return;
    } finally {
      this.h.life.end('importing');
    }
    this.slotGame = null;
    this.slotBase = null;
    if (kept) this.h.hud.toast(t('save.keptPrevious', { folder: kept }));
    await this.load();
  }

  /**
   * The slot holds one city. Before the first save of another city (a new map, a generated one, an imported one), the
   * city saved there is copied aside as a previous city, never overwritten. Throws when the copy fails (nothing is
   * written then).
   */
  async keepSlotForThisCity(slot: SaveSlot): Promise<void> {
    const w = this.h.world;
    if (this.slotGame === w.gameId) return;
    const opened = await slot.open();
    // a save that cannot be read (damaged) is kept aside too
    if (opened.found && opened.generations[0]?.game !== w.gameId) {
      const kept = await keepPreviousCity(slot);
      if (kept) this.h.hud.toast(t('save.keptPrevious', { folder: kept }));
    }
    this.slotGame = w.gameId;
  }

  /** The previous cities kept aside (mapFile.ts), for the interface (hudActions). */
  actions(): SaveActions {
    return {
      previousCities: async () => previousCities(await this.saveStore, SLOT),
      openPreviousCity: (folder) => { if (this.h.discardOk()) void this.openPreviousCity(folder); },
    };
  }

  /**
   * Puts a previous city back in the save and opens it: the city in the save goes aside first (a previous city in its
   * turn), then the previous city's save becomes a new generation of the slot.
   */
  async openPreviousCity(folder: string): Promise<void> {
    if (!this.h.life.begin('importing')) return;
    if (!await this.mayWrite()) { this.h.life.end('importing'); return; }
    let kept: string | null;
    try { kept = await restorePrevious(await this.slot(), folder); } catch (err) {
      this.h.hud.toast(t('save.previousFailed', { why: errorText(err) }));
      return;
    } finally {
      this.h.life.end('importing');
    }
    this.slotGame = null;
    this.slotBase = null;
    if (kept) this.h.hud.toast(t('save.keptPrevious', { folder: kept }));
    await this.load();
  }

  /** A new empty map (`seed`: the same terrain again; none: a new one). */
  async newMap(seed?: number): Promise<void> {
    const h = this.h;
    const host: NewMapHost = {
      life: h.life,
      world: h.world, hud: h.hud,
      resetCity: () => h.resetCity(),
      generateTerrain: () => h.generateTerrain(),
      endRebuild: (err, what) => h.endRebuild(err, what),
    };
    return newMapSession(host, seed);
  }

  /** The window is closing: a save under way is waited for, then what is still unsaved is written. */
  async saveBeforeClose(): Promise<void> {
    // the operation under way ends (an opening or a save); a half-built world (Failed) is never written
    await this.h.life.whenIdle(20000);
    if ((this.h.life.unsaved || this.h.world.saveDirty.includes(1)) && !this.h.life.failed) await this.save(true);
  }
}
