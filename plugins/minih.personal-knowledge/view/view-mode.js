/**
 * Pure decision logic for the Knowledge Universe view mode (design doc §7).
 *
 * Kept free of DOM access so `node --test` can cover the WebGL-failure
 * fallback: the default view is 3D, the user's last choice wins while it is
 * still renderable, and a missing WebGL context falls back to the flat chart
 * with the "3D 不可用" notice.
 */

export const VIEW_MODE_STORAGE_KEY = "kg-universe:viewMode";
export const MODE_3D = "3d";
export const MODE_CHART = "chart";

/**
 * Decide the initial mode.
 *
 * @param {{ webglAvailable: boolean, storedMode?: string|null }} input
 * @returns {{ mode: "3d"|"chart", showFallbackNotice: boolean }}
 */
export function initialViewMode({ webglAvailable, storedMode = null } = {}) {
  const stored = storedMode === MODE_CHART || storedMode === MODE_3D ? storedMode : null;
  if (!webglAvailable) {
    // 3D cannot start (or just failed): chart mode, with the notice unless
    // the user had already picked the chart themselves.
    return { mode: MODE_CHART, showFallbackNotice: stored !== MODE_CHART };
  }
  return { mode: stored ?? MODE_3D, showFallbackNotice: false };
}

/** The modes the ⚙ menu may switch to, in display order. */
export function switchableModes() {
  return [MODE_3D, MODE_CHART];
}

/**
 * Whether a requested mode switch is possible. Chart mode is always
 * possible; 3D needs a live WebGL context.
 */
export function canSwitchTo(mode, { webglAvailable } = {}) {
  return mode === MODE_CHART || (mode === MODE_3D && Boolean(webglAvailable));
}
