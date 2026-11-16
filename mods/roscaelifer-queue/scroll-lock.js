const LINE_PX = 40;

/** Pixel deltas, taking the dominant axis when a backend reports both. */
function dominantPixelDelta(delta) {
  const x = delta?.x ?? 0;
  const y = delta?.y ?? 0;
  return Math.abs(x) > Math.abs(y) ? x : y;
}

/**
 * Lock a nested scrolling gesture to one axis.
 *
 * The handler is intentionally usable both on a transparent wheel guard over
 * a vertical scroller and on a custom horizontal viewport. Horizontal motion
 * is sent to `onHorizontalDelta`; vertical motion is left to the element below
 * the guard so its normal vertical scrolling still works.
 */
export function createColumnScrollLock({ onHorizontalDelta } = {}) {
  const g = { axis: null, accX: 0, accY: 0, lastAt: 0, pendingX: 0 };

  const reset = () => {
    g.axis = null;
    g.accX = 0;
    g.accY = 0;
    g.pendingX = 0;
  };

  const handleColumnScrollWheel = (e, cx) => {
    if (!e) return;

    // Shift-wheel is an explicit horizontal request. Some backends report it
    // in delta_lines (line counts), others in pixel delta.
    if (e?.modifiers?.shift) {
      const rawDelta = e?.delta_lines
        ? (e.delta_lines.y ?? 0) * LINE_PX
        : dominantPixelDelta(e?.delta);
      g.axis = "x";
      g.pendingX = 0;
      if (rawDelta !== 0) onHorizontalDelta?.(rawDelta, cx);
      cx?.stop_propagation();
      return;
    }

    // Discrete wheel events already carry their intended axis. Keep the axis
    // in the state so an outer handler can stop vertical bubbling after the
    // guard lets it pass through.
    if (e?.delta_lines) {
      // Line counts arrive without pixel meaning; scale them to a wheel step so
      // line-reporting devices scroll the lanes like pixel-reporting ones.
      const lx = (e.delta_lines.x ?? 0) * LINE_PX;
      const ly = (e.delta_lines.y ?? 0) * LINE_PX;
      if (Math.abs(lx) > Math.abs(ly)) {
        g.axis = "x";
        g.pendingX = 0;
        if (lx !== 0) onHorizontalDelta?.(lx, cx);
        cx?.stop_propagation();
      } else {
        g.axis = "y";
      }
      return;
    }

    const now = Date.now();
    if (e?.touch_phase === "started" || now - g.lastAt > 250) reset();
    g.lastAt = now;

    const rawDx = e?.delta?.x ?? 0;
    const rawDy = e?.delta?.y ?? 0;
    const dx = Math.abs(rawDx);
    const dy = Math.abs(rawDy);
    g.accX += dx;
    g.accY += dy;
    if (g.axis === null && dx > dy) g.pendingX += rawDx;

    if (g.axis === null) {
      const total = g.accX + g.accY;
      if ((g.accX >= 3 && g.accX > g.accY * 1.35) || (total >= 5 && g.accX > g.accY * 1.35)) {
        g.axis = "x";
      } else if (g.accY >= 3 || total >= 5) {
        g.axis = "y";
      }
    }

    if (g.axis === "x") {
      if (g.pendingX !== 0) {
        onHorizontalDelta?.(g.pendingX, cx);
        g.pendingX = 0;
      } else if (rawDx !== 0) {
        onHorizontalDelta?.(rawDx, cx);
      }
      cx?.stop_propagation();
      return;
    }

    if (g.axis === "y") return;

    // Before the axis is locked, suppress a horizontally dominant first frame
    // so its tiny vertical component cannot reach the nested vertical scroller.
    if (dx > dy) cx?.stop_propagation();
    // A vertically dominant undecided frame is deliberately left untouched.
  };

  handleColumnScrollWheel.isHorizontal = () => g.axis === "x";
  handleColumnScrollWheel.getGestureState = () => ({ ...g });
  return handleColumnScrollWheel;
}

export const createHorizontalWheelHandler = createColumnScrollLock;
