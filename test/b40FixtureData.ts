// The 4.0 outputs the b40 tests compare against, recorded before the 4.0 generation modules were deleted.
import fs from 'node:fs';
import zlib from 'node:zlib';

export interface FixtureEnv { W: number; D: number; backDoor: boolean; character: number; era: 0 | 1 | 2 }
export interface PlanFixture { kind: string; W: number; D: number; corner?: 'left' | 'right'; key: number; plan: unknown }
export interface MassedFixture {
  kind: string; use: 'residential' | 'commercial' | 'industrial'; density: 'low' | 'medium' | 'high';
  W: number; D: number; corner?: 'left' | 'right'; key: number; env: FixtureEnv; body: unknown;
  entrance: number; backDoor?: number; free: unknown[]; draws: number[];
}
export interface FurnishedFixture {
  kind: string; use: 'residential' | 'commercial' | 'industrial'; density: 'low' | 'medium' | 'high';
  W: number; D: number; corner?: 'left' | 'right'; key: number; env: FixtureEnv; body: unknown; draws: number[];
}

const raw = fs.readFileSync('test/fixtures/b40-generation.json.gz.b64', 'utf8');
export const FIX = JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString()) as {
  plans: PlanFixture[]; massed: MassedFixture[]; furnished: FurnishedFixture[];
};
