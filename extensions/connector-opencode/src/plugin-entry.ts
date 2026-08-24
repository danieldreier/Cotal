/**
 * OpenCode treats every named export from a plugin module as a plugin factory.
 * Keep the runtime bundle surface to the single factory even though plugin.ts
 * also exports diagnostic constants for source-level smoke tests.
 */
export { cotal } from "./plugin.js";
