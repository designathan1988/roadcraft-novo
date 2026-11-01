import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - the audit tools are plain ESM without declarations
import { auditStatic } from '../tools/render-audit/static.mjs';
// @ts-expect-error - the audit tools are plain ESM without declarations
import { TECHNIQUES } from '../tools/render-audit/catalog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A tiny source tree for one detector: the point is the negative control, not a real renderer. */
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'render-audit-'));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

function verdict(root: string, id: string): string {
  const report = auditStatic({ root });
  return report.results.find((r: { id: string; verdict: string }) => r.id === id)?.verdict ?? 'missing';
}

const OCCLUSION_GOOD = {
  'src/render/occlusion.ts': 'export class OcclusionBuffer { hidden(_box: unknown): boolean { return false; } }',
  'src/render/cellLayer.ts': 'const occluders = make(); if (occluders.hidden(box)) hide();',
};
const OCCLUSION_BAD = {
  'src/render/cellLayer.ts': 'const frustum = new THREE.Frustum(); if (frustum.intersectsBox(box)) draw();',
};

test('the occlusion detector sees the mechanism and its absence', (t) => {
  const good = fixture(OCCLUSION_GOOD), bad = fixture(OCCLUSION_BAD);
  t.after(() => { fs.rmSync(good, { recursive: true, force: true }); fs.rmSync(bad, { recursive: true, force: true }); });
  assert.equal(verdict(good, 'occlusion-culling'), 'present', 'a system and its call are present');
  assert.equal(verdict(bad, 'occlusion-culling'), 'absent', 'a frustum-only renderer is absent of occlusion');
});

const DEPTH_GOOD = {
  'src/render/depthPrepass.ts': 'const colorWrite = false; const depthTwin = makeTwin();',
  ...Object.fromEntries(['city', 'roads', 'terrain', 'props'].map((f) => [`src/render/${f}.ts`, 'layDepthFirst(material); const maskNode = mask;'])),
};
const DEPTH_BAD = {
  'src/render/depthPrepass.ts': 'const colorWrite = false; const depthTwin = makeTwin();',
  'src/render/city.ts': 'layDepthFirst(material); const maskNode = mask;',
  'src/render/roads.ts': 'const maskNode = mask;',
};

test('the depth-prepass detector requires coverage of the masked materials', (t) => {
  const good = fixture(DEPTH_GOOD), bad = fixture(DEPTH_BAD);
  t.after(() => { fs.rmSync(good, { recursive: true, force: true }); fs.rmSync(bad, { recursive: true, force: true }); });
  assert.equal(verdict(good, 'depth-prepass-coverage'), 'present');
  assert.equal(verdict(bad, 'depth-prepass-coverage'), 'partial');
});

const CLOUD_GOOD = { 'src/render/cloudShadow.ts': 'const CLOUD_SHADOW_MAP = target; sample(map);' };
const CLOUD_BAD = { 'src/render/cloudShadow.ts': 'Loop(MAX_CLOUDS, ({ i }) => { sample(i); });' };

test('the cloud-shadow detector distinguishes a map from a per-pixel loop', (t) => {
  const good = fixture(CLOUD_GOOD), bad = fixture(CLOUD_BAD);
  t.after(() => { fs.rmSync(good, { recursive: true, force: true }); fs.rmSync(bad, { recursive: true, force: true }); });
  assert.equal(verdict(good, 'cloud-shadow-map'), 'present');
  assert.equal(verdict(bad, 'cloud-shadow-map'), 'absent');
});

const WATER_GOOD = { 'src/render/terrain.ts': 'const m = new WaterNodeMaterial({ transparent: true, depthWrite: false }); sampleDepth(depth);' };
const WATER_BAD = { 'src/render/terrain.ts': 'const m = new WaterNodeMaterial({ transparent: true });' };

test('the water detector requires no depth write and an early-out', (t) => {
  const good = fixture(WATER_GOOD), bad = fixture(WATER_BAD);
  t.after(() => { fs.rmSync(good, { recursive: true, force: true }); fs.rmSync(bad, { recursive: true, force: true }); });
  assert.equal(verdict(good, 'water-early-out'), 'present');
  assert.equal(verdict(bad, 'water-early-out'), 'absent');
});

test('every technique has a source and a detection path', () => {
  const ids = new Set<string>();
  for (const t of TECHNIQUES) {
    assert.ok(!ids.has(t.id), `duplicate technique ${t.id}`);
    ids.add(t.id);
    assert.ok(t.sources.length > 0, `${t.id} has no source`);
    assert.ok((t.checks?.length ?? 0) > 0 || t.computed || t.runtime, `${t.id} has no detection path`);
    assert.ok(t.why.length > 20, `${t.id} has no reason`);
  }
});

test('the real tree now has a used occlusion culler', () => {
  const report = auditStatic({ root: REPO });
  const occ = report.results.find((r: { id: string; verdict: string }) => r.id === 'occlusion-culling');
  assert.equal(occ?.verdict, 'present', 'the new visibility.ts must be found and used by the cell layer');
});
