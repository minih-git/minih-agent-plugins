/**
 * Shared view utilities: the host bridge call with a timeout guard, a seeded
 * PRNG for deterministic star fields, and small color helpers.
 */

import { BRIDGE_TIMEOUT_MS } from "./strings.js";

export async function invokeBridge(channel, payload = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
  const bridge = window.pluginBridge;
  if (!bridge || typeof bridge.invoke !== "function") {
    const error = new Error("pluginBridge unavailable");
    error.code = "BRIDGE_MISSING";
    throw error;
  }
  let timerId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      const error = new Error(`Bridge call timed out after ${Math.round(timeoutMs / 1000)}s`);
      error.code = "BRIDGE_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([bridge.invoke(channel, payload), timeoutPromise]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

export function hasBridge() {
  return Boolean(window.pluginBridge && typeof window.pluginBridge.invoke === "function");
}

/** Deterministic 32-bit PRNG (mulberry32) for star fields and fixtures. */
export function createSeededRandom(seed = 0x5f3759df) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function hexToRgb(hex) {
  const clean = String(hex || "#94a3b8").replace("#", "");
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export function rgbaString(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1).toFixed(3)})`;
}

/** Mix a hex color toward white by `k` (§5.2: planets 0.55, labels 0.25). */
export function mixTowardWhite(hex, k) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}
