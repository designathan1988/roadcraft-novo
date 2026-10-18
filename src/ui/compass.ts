// The compass in the bottom-right corner, as Roadcraft's: a click turns the view to north, a drag across it turns
// and tilts the camera. The needle is rotated only when the shown degree changes.

import { t } from './i18n.ts';

export interface CompassHandlers {
  north(): void;
  /** A drag across the compass, in pixels. */
  drag(dx: number, dy: number): void;
}

export interface Compass { point(yaw: number): void }

/** A press that moves less than this is a click. */
const CLICK_SLOP = 4;

export function mountCompass(host: HTMLElement, h: CompassHandlers): Compass {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'v2-compass';
  b.title = t('compass.label');
  b.setAttribute('aria-label', t('compass.label'));
  b.innerHTML = `<svg viewBox="0 0 48 48" aria-hidden="true">
    <circle class="v2-compass-ring" cx="24" cy="24" r="21"/>
    <g class="v2-compass-needle">
      <path class="v2-compass-n" d="M24 6 29 24H19Z"/>
      <path class="v2-compass-s" d="M24 42 19 24h10Z"/>
      <text x="24" y="17.5" text-anchor="middle">N</text>
    </g>
  </svg>`;
  const needle = b.querySelector<SVGGElement>('.v2-compass-needle')!;
  host.append(b);
  let press: { id: number; x: number; y: number; moved: boolean } | null = null;
  b.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    b.setPointerCapture(e.pointerId);
    b.classList.add('held');
  });
  b.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
    press.moved = true;
    press.x = e.clientX; press.y = e.clientY;
    // the dial follows the hand: dragged right, north swings clockwise
    h.drag(-dx * 2, dy * 1.5);
  });
  const end = (e: PointerEvent): void => {
    if (!press || e.pointerId !== press.id) return;
    const click = !press.moved;
    press = null;
    b.classList.remove('held');
    if (click && e.type === 'pointerup') h.north();
  };
  b.addEventListener('pointerup', end);
  b.addEventListener('pointercancel', end);
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); h.north(); } });
  let shown = NaN;
  return {
    point(yaw) {
      const deg = Math.round(yaw * 180 / Math.PI);
      if (deg === shown) return;
      shown = deg;
      needle.style.transform = `rotate(${deg}deg)`;
    },
  };
}
