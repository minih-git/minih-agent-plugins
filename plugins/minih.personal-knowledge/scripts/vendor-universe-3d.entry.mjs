/**
 * Vendor entry bundled by `scripts/build.mjs` into `view/vendor/universe-3d.mjs`.
 *
 * The Knowledge Universe 3D view needs `3d-force-graph`, the `three`
 * namespace, and three add-on classes from `three/examples/jsm`. They must
 * resolve to ONE copy of `three`, so the post-processing passes and the
 * CSS2D renderer share the same instance the graph runs on; this entry is
 * the way esbuild guarantees that. `fat lines` (Line2) give the lanes and
 * tethers real pixel widths, which plain WebGL lines cannot carry.
 */
export { default as ForceGraph3D } from "3d-force-graph";
export * as THREE from "three";
export { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
export { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
export { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
export { Line2 } from "three/examples/jsm/lines/Line2.js";
export { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
export { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
