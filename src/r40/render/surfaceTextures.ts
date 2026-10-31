import type { CompressedTexture, Texture } from 'three';

/** The surfaces baked at build time (`bake/catalogue.ts`), by name, as `surfaceBakeClient.ts` read them: every material takes its maps from here */

export interface SurfaceBake {
  readonly map: Texture;
  readonly normalMap: Texture;
  readonly roughnessMap: Texture;
}

/** Every mip level's texels, or none once let go. */
function hasTexels(texture: CompressedTexture): boolean {
  return texture.mipmaps.every((level) => level.data !== null);
}

/** The page's one set of baked textures: what it read, and where to read let-go texels again. */
class SurfaceTextureSet {
  readonly byName = new Map<string, CompressedTexture>();
  /** Textures whose texels were let go and are wanted again, until they come. */
  readonly wanted = new Set<string>();
  /** The build's files, fetched anew (`surfaceBakeClient.ts`); null keeps the texels. */
  source: ((names: readonly string[]) => void) | null = null;

  /** DO NOT keep a texture's texels once uploaded: some 250 MB of the page's heap were copies of what the GPU holds. */
  readonly letTexelsGo = (texture: Texture): void => {
    if (!this.source) return;
    for (const level of (texture as CompressedTexture).mipmaps) (level as { data: unknown }).data = null;
  };

  /** These textures' texels wanted again (to be uploaded anew); once until they come. */
  want(names: readonly string[]): void {
    const fresh = names.filter((name) => !this.wanted.has(name));
    if (fresh.length === 0 || !this.source) return;
    for (const name of fresh) this.wanted.add(name);
    this.source(fresh);
  }
}

const surfaces = new SurfaceTextureSet();

/** A baked texture by name, its anisotropy at least `anisotropy`; undefined where none was read (a worker, a test). */
function surfaceTextureOrNone(name: string, anisotropy: number): Texture | undefined {
  const texture = surfaces.byName.get(name);
  if (!texture || texture.anisotropy >= anisotropy) return texture;
  texture.anisotropy = anisotropy;
  // Texels let go: uploaded anew only once they are read back (an upload of none would draw it black).
  if (hasTexels(texture)) texture.needsUpdate = true;
  else surfaces.want([name]);
  return texture;
}

/** A surface's colour, normal and roughness maps; undefined where none were read (a worker, a test). */
export function surfaceMaps(key: string, anisotropy: number): SurfaceBake | undefined {
  const map = surfaceTextureOrNone(`${key}:map`, anisotropy);
  const normalMap = surfaceTextureOrNone(`${key}:normal`, anisotropy);
  const roughnessMap = surfaceTextureOrNone(`${key}:rough`, anisotropy);
  return map && normalMap && roughnessMap ? { map, normalMap, roughnessMap } : undefined;
}
