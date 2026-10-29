// Shared panel fragments. They live here (not in drawers.ts) so peoplePanel and any other panel can use them
// without importing drawers.ts back, which would create a runtime cycle.

import { el } from './dom.ts';

/** The section of things in the strip: a group with its title (for screen readers) and its cards. */
export function section(strip: HTMLElement, label: string): HTMLElement {
  const box = el('div', 'v2-section');
  box.append(el('div', 'v2-section-title', label));
  const items = el('div', 'v2-section-items');
  box.append(items);
  strip.append(box);
  return items;
}
