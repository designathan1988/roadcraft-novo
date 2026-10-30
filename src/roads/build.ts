// Road building: snapping to nodes and segments, automatic junctions with
// the roads crossed, height profile with ramps (bridges and tunnels come out
// on their own), splitting into short segments, settling the terrain and removing
// buildings in the way. Everything becomes a journal of operations that undoes and
// redoes exactly, with the same ids.
// The public entry of construction/: every name it exported, from the part that holds it.

export { RoadJournal } from './construction/journal.ts';
export { snap } from './construction/snap.ts';
export type { Anchor } from './construction/snap.ts';
export { gradeLine, heightProfile } from './construction/grade.ts';
export type { Fixed } from './construction/grade.ts';
export { planPrice, planRoad } from './construction/plan.ts';
export type { RoadPlan } from './construction/plan.ts';
export { buildRoad } from './construction/execute.ts';
export { alongStreet, changeProfile, changeProfiles, demolishSeg, mirrorSymmetric, streetChain } from './construction/streetEdits.ts';
export { buildRoundabout, roundaboutRefusal } from './construction/roundabout.ts';
export { addCrossing, addHeightPoint, addUTurn, bendRoad, duplicateRoad, joinAt, moveNode, reverseRoad, roadBetweenJunctions, segPreview, splitAt, upgradeStep } from './construction/segmentEdits.ts';
export { closestT } from './geometry.ts';
export { bulbAt } from './junction.ts';
