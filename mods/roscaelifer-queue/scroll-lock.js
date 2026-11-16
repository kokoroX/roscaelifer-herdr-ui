/**
 * Column scroll lock.
 *
 * A column scrolls vertically inside a horizontally scrolling row. A fast
 * vertical swipe on a touchpad regularly carries a little horizontal drift,
 * which the outer horizontal container would otherwise read as a sideways pan.
 *
 * Each gesture therefore locks to a single axis: once the accumulated motion is
 * clearly vertical, the event is swallowed so it never reaches the outer
 * horizontal scroller. The lock is kept past the end of the touch phase because
 * momentum keeps sending events whose residual sideways component must not pan
 * the board.
 */

/**
 * Create an independent scroll-wheel handler with its own gesture state.
 *
 * The returned function can be attached to `on_scroll_wheel` of a vertically
 * scrollable column nested in a horizontally scrollable container.
 *
 * @returns {(e: any, cx: any) => void} Wheel handler bound to this gesture state.
 */
export function createColumnScrollLock() {
  const g = { axis: null, accX: 0, accY: 0, lastAt: 0 };

  return function handleColumnScrollWheel(e, cx) {
    if (!e) return;
    // Shift is an explicit request for horizontal scrolling.
    if (e?.modifiers?.shift) return;
    const lines = e?.delta_lines;
    if (lines) {
      // A discrete wheel notch: its dominant axis is the whole intent.
      if (Math.abs(lines?.x ?? 0) > Math.abs(lines?.y ?? 0)) return;
      cx?.stop_propagation();
      return;
    }
    const now = Date.now();
    if (e?.touch_phase === "started" || now - g.lastAt > 250) {
      g.axis = null;
      g.accX = 0;
      g.accY = 0;
    }
    g.lastAt = now;
    const dx = Math.abs(e?.delta?.x ?? 0);
    const dy = Math.abs(e?.delta?.y ?? 0);
    g.accX += dx;
    g.accY += dy;
    // Decide the axis from accumulated motion so one jittery frame cannot
    // flip it. The lock is kept past `ended`: momentum keeps sending events
    // with a residual sideways component that must not pan the board.
    if (g.axis === null) {
      const total = g.accX + g.accY;
      if ((g.accX >= 4 && g.accX > g.accY * 1.5) || (total >= 6 && g.accX > g.accY * 1.5)) {
        g.axis = "x";
      } else if (g.accY >= 4 || total >= 6) {
        g.axis = "y";
      }
    }
    if (g.axis === "x") return;
    if (g.axis === "y" || dy >= dx) cx?.stop_propagation();
  };
}
