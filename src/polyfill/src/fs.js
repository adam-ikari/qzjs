/**
 * qzjs Polyfill - File System Extension API
 *
 * Provides node:fs-style async API based on PAL primitives.
 * PAL returns strings for fsExists ("true"/"false") and fsList (JSON array),
 * which this module parses into proper JS types.
 *
 * Mounted on globalThis.qzjs.fs
 */

export function setupFS(pal) {
  if (!globalThis.qzjs) globalThis.qzjs = {};

  var fs = {
    async readFile(path, options) {
      var data = await pal.fsRead(path);
      if (options && options.encoding) {
        return data;  // string
      }
      return data;  // for now, always returns string
    },

    /* Binary-safe read: resolves with an ArrayBuffer of the raw bytes. */
    async readFileBinary(path) {
      return await pal.fsReadBinary(path);
    },

    async writeFile(path, data, options) {
      await pal.fsWrite(path, typeof data === 'string' ? data : String(data));
    },

    async exists(path) {
      var result = await pal.fsExists(path);
      return result === 'true';  // PAL returns string "true"/"false"
    },

    async readdir(path) {
      var result = await pal.fsList(path);
      return JSON.parse(result);  // PAL returns JSON array string
    },

    async unlink(path) {
      await pal.fsRemove(path);
    },

    // Sync-style aliases (still async under the hood)
    readFileSync(path, options) {
      throw new Error('Synchronous fs operations not supported in qzjs');
    },
  };

  globalThis.qzjs.fs = fs;
}
