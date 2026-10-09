/**
 * PAL shim for esbuild bundling.
 *
 * This module provides `pal` as a named export so that esbuild can
 * resolve it as a proper module dependency instead of treating it as
 * an undefined global. At runtime, `pal` is obtained from the IIFE
 * closure parameter.
 *
 * The build script replaces the import of this module with a reference
 * to the `pal` IIFE parameter.
 */

// pal is provided by the IIFE wrapper at runtime via __native_inject__
export var pal = globalThis.__native_inject__;
