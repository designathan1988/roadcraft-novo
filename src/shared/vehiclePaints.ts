// The vehicle paint palette, shared by the simulation, the renderer and the interface's colour swatches.
// Pure data: no three.js and no UI import, so `ui` and `render` can both use it without depending on each other.

// a real fleet: much white, silver and grey, some black and a few brightly coloured cars
export const PAINTS = [
  0xf2f2f0, 0x1c1d20, 0x8c8f94, 0xb5b8bc, 0xe8e8e4, 0xb3221f, 0x2a5aa8, 0xc4c7cb,
  0x2f7a4a, 0xd8c39a, 0x5f6368, 0xe4b512, 0x3f74c9, 0xd96a1d, 0x8e1b1b, 0x1f6f78,
];
