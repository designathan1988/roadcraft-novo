// Two fingers on a touch screen: spreading or pinching zooms around the point between them. One finger stays the
// game's own (tap, drag). The listener runs before the game's (capture phase): when the second finger lands, the
// first one's gesture is cancelled (the game ends its drag as for a lost pointer) and both fingers belong to the pinch
// until they lift.

interface Zoomable {
  /** One wheel notch: factor < 1 zooms in, at the screen point (ndc). */
  zoomAt(factor: number, ndcX: number, ndcY: number): void;
}

export function attachPinch(canvas: HTMLCanvasElement, cam: Zoomable): void {
  const touches = new Map<number, { x: number; y: number }>();
  let pinching = false;
  let last = 0;
  const spread = (): number => {
    const [a, b] = [...touches.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2 || pinching) { if (pinching) e.stopImmediatePropagation(); return; }
    pinching = true;
    last = spread();
    e.stopImmediatePropagation();
    // the first finger's gesture (a pan, a click) ends here
    for (const id of touches.keys()) {
      if (id === e.pointerId) continue;
      const p = touches.get(id)!;
      canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch', clientX: p.x, clientY: p.y, bubbles: true }));
    }
  }, true);
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinching) return;
    e.stopImmediatePropagation();
    if (touches.size < 2) return;
    const now = spread();
    if (now > 4 && last > 4) {
      const [a, b] = [...touches.values()], r = canvas.getBoundingClientRect();
      const mx = ((a.x + b.x) / 2 - r.left) / r.width * 2 - 1, my = -(((a.y + b.y) / 2 - r.top) / r.height * 2 - 1);
      cam.zoomAt(last / now, mx, my);
    }
    last = now;
  }, true);
  const lift = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    if (!pinching) return;
    e.stopImmediatePropagation();
    if (touches.size === 0) pinching = false;
  };
  canvas.addEventListener('pointerup', lift, true);
  canvas.addEventListener('pointercancel', (e) => { if (e.isTrusted) lift(e); }, true);
}
