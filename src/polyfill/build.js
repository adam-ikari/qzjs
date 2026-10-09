/**
 * qzjs Polyfill Build Script
 *
 * Bundles all polyfill modules into a single IIFE using esbuild,
 * then post-processes the output so `pal` is received as a closure
 * parameter from `__native_inject__`.
 *
 * Strategy:
 *   1. Source code imports `pal` from `pal.js` which defines it as
 *      `var pal = globalThis.__native_inject__`. This tells esbuild that
 *      `pal` is a defined module variable (not an undefined global),
 *      preventing it from being treated as an external.
 *   2. esbuild bundles with format:'iife' + globalName, producing:
 *      var qz_polyfill = (() => {
 *        var pal = globalThis.__native_inject__;
 *        function setupConsole(pal2) { ... }  // renamed to avoid shadowing
 *        setupConsole(pal);
 *        ...
 *      })();
 *   3. Post-process:
 *      - Strip "var qz_polyfill = " prefix
 *      - Replace arrow IIFE with named function: (() => { ... })()
 *        becomes (function(pal) { ... })(__native_inject__);
 *      - Remove "var pal = globalThis.__native_inject__;" since pal
 *        now comes from the IIFE parameter
 *
 * Outputs:
 *   qzjs/src/polyfill_default.c  — compiled polyfill bytecode (QZ_POLYFILL_MODE=rodata)
 *   qzjs/src/polyfill_<mode>.c   — same, for compressed|external|host (untracked, must match CMake)
 *   qzjs/dist/polyfill.bytecode  — raw bytecode file (for tests)
 *   qzjs/src/worker_boot_default.c — worker boot shim bytecode (qz_default_worker_boot)
 *   qzjs/dist/worker-boot.bytecode — raw worker boot bytecode file
 *   (polyfill.js is a temporary file used as qjsc input, not for distribution)
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Pin the working directory to polyfill/ so esbuild's emitted per-module
// comments (`// src/xxx.js`) and qjsc's bytecode are identical regardless of
// how build.js is invoked (npm --prefix from here, or node polyfill/build.js
// from the repo root). Without this, dist/polyfill.js + the generated
// bytecode drift between invocations and every rebuild shows a bogus diff.
process.chdir(__dirname);

// monorepo 后 build.js 在 src/polyfill/，仓库根是上两层（此前 polyfill/ 在根下，
// 上移一层即可；下移后漏改，手工 npm run build 的 fallback 会把 dist 写到 src/）。
const ROOT_DIR = path.resolve(__dirname, '..', '..');
// 输出目录：CMake 经 QZ_POLYFILL_GEN_DIR 指定构建目录（中间产物不进 src/）；
// 无 env 时 fallback 到仓库 dist/（手工 npm run build 场景）。
const GEN_DIR = process.env.QZ_POLYFILL_GEN_DIR || path.join(ROOT_DIR, 'dist');
const DIST_DIR = GEN_DIR;
const ENTRY_POINT = path.join(__dirname, 'src', 'index.js');

// Ensure dist directory exists
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

const isWatch = process.argv.includes('--watch');

// Locate qjsc (QuickJS-ng bytecode compiler). The caller MUST pass the path
// via $QJSC — build.js does not guess or scan directories. The CMake
// polyfill_rebuild target passes QJSC=<this build dir's qjsc> automatically;
// manual invocations must set it explicitly:
//   QJSC=<build-dir>/deps/quickjs-ng/qjsc node polyfill/build.js
function qjscVersion(qjsc) {
  // `qjsc --version` prints the version line and then exits 1 (it dumps
  // usage instead of handling the flag), so a non-zero status is expected:
  // read the captured output rather than treating the failure as "unknown".
  let out = '';
  try {
    out = execSync('"' + qjsc + '" --version', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  const m = out.match(/version\s+(\d+\.\d+\.\d+)/i);
  return m ? m[1] : null;
}

// pinned 的 deps/quickjs-ng 版本（QJS_VERSION_MAJOR/MINOR/PATCH）。读不到返回
// null（调用方视为「不校验」，而不是拿一个硬编码版本去比）。
function quickjsNgVersion() {
  try {
    const h = fs.readFileSync(
      path.join(ROOT_DIR, 'deps', 'quickjs-ng', 'quickjs.h'), 'utf8');
    const g = (k) => {
      const m = h.match(new RegExp('#define\\s+QJS_VERSION_' + k + '\\s+(\\d+)'));
      return m ? m[1] : null;
    };
    const maj = g('MAJOR'), min = g('MINOR'), pat = g('PATCH');
    return (maj && min && pat) ? (maj + '.' + min + '.' + pat) : null;
  } catch (_) {
    return null;
  }
}


// Polyfill embedding mode (matches CMake QZ_POLYFILL_MODE):
//   rodata (default) | compressed | external | host
// Legacy single letters C/A/B/D are normalised for backward compatibility.
const _modeRaw = (process.env.QZ_POLYFILL_MODE || 'rodata').trim();
const _modeLower = _modeRaw.toLowerCase();
const _modeLegacy = { c: 'rodata', a: 'compressed', b: 'external', d: 'host' };
const QZ_POLYFILL_MODE = _modeLegacy[_modeLower] || _modeLower;
if (!['rodata', 'compressed', 'external', 'host'].includes(QZ_POLYFILL_MODE)) {
  console.error(`[qzjs] invalid QZ_POLYFILL_MODE '${_modeRaw}' (expected rodata|compressed|external|host)`);
  process.exit(1);
}
// Generated C output — one file per mode, must match CMake's _polyfill_gen_c:
//   rodata → src/polyfill_default.c (tracked baseline, shipped so a fresh clone
//            compiles without the polyfill toolchain)
//   others → src/polyfill_<mode>.c (untracked, regenerated per build)
const OUT_C = path.join(GEN_DIR,
  QZ_POLYFILL_MODE === 'rodata' ? 'polyfill_default.c' : 'polyfill_' + QZ_POLYFILL_MODE + '.c');
const QZ_WITH_NONUTF_ENCODINGS = process.env.QZ_WITH_NONUTF_ENCODINGS === '1';
// gRPC/HTTP2 stack (http2.js + hpack.js + protobuf.js + grpc.js).
// Off by default: it is ~3.5k lines of JS that only upstream-calling scripts use.
const QZ_WITH_GRPC = process.env.QZ_WITH_GRPC === '1';

/*
 * QZ_WITH_GRPC gates the gRPC/HTTP2 stack (grpc.js + http2.js + hpack.js +
 * protobuf.js, ~3.5k lines) by swapping the virtual
 * `@qzjs/grpc-stack` module for an empty stub.
 *
 * A `define` + `if (QZ_WITH_GRPC)` guard is not enough: esbuild keeps the
 * `if (false) { … }` body verbatim unless minifying, so the imports stay
 * referenced and the whole stack ships in every build. `alias` removes it from
 * the module graph instead (and works with buildSync, unlike `plugins`).
 */
const grpcStackEntry = QZ_WITH_GRPC
  ? path.join(__dirname, 'src', 'grpc-stack.js')
  : path.join(__dirname, 'src', 'grpc-stack-stub.js');

// Common esbuild options
const esbuildOptions = {
  entryPoints: [ENTRY_POINT],
  absWorkingDir: __dirname, // stable per-module comments (// src/xxx.js) regardless of how build.js is invoked
  bundle: true,
  format: 'iife',
  globalName: 'qz_polyfill',
  target: ['es2020'],
  minify: true,
  define: {
    'QZ_WITH_NONUTF_ENCODINGS': QZ_WITH_NONUTF_ENCODINGS ? '1' : '0',
  },
  alias: { '@qzjs/grpc-stack': grpcStackEntry },
};

/**
 * Post-process the esbuild IIFE output:
 *
 * Input (esbuild raw):
 *   var qz_polyfill = (() => {
 *     var pal = globalThis.__native_inject__;
 *     ...
 *   })();
 *
 * Output (our wrapper):
 *   (function(pal) {
 *     ...
 *   })(__native_inject__);
 */
function postProcess(js) {
  // 1. Strip "var qz_polyfill = " prefix
  js = js.replace(/^var qz_polyfill\s*=\s*/, '');

  // 2. Replace the arrow IIFE opening with a named function that takes `pal`
  //    After step 1, the string starts with: (() => {
  //    We need to replace that with: (function(pal) {
  //    Note: the outer ( is the IIFE invocation paren, () is the arrow params
  js = js.replace(/^\(\(\)\s*=>\s*\{/, '(function(pal) {');

  // 3. Replace the IIFE invocation: })();   =>   })(__native_inject__);
  //    No $ anchor: esbuild may append license comments after the IIFE close.
  js = js.replace(/\}\)\(\)\s*;\s*/, '})(__native_inject__);');

  // 4. Remove the "var pal = globalThis.__native_inject__;" line since
  //    pal is now provided by the IIFE parameter
  //    esbuild may output it with or without semicolons, various whitespace
  js = js.replace(/\s*var pal\s*=\s*globalThis\.__native_inject__\s*;?\s*\n?/, '\n');

  return js;
}

if (isWatch) {
  // Watch mode — for development, writes raw output without post-processing
  esbuild.context({
    ...esbuildOptions,
    outfile: path.join(DIST_DIR, 'polyfill.js'),
    logLevel: 'info',
  }).then(ctx => {
    console.log('Note: Watch mode writes raw esbuild output. Run `npm run build` for post-processed output.');
    ctx.watch();
  }).catch(err => {
    console.error('Watch build failed:', err);
    process.exit(1);
  });
} else {
  // One-shot build
  const result = esbuild.buildSync({
    ...esbuildOptions,
    write: false,
  });

  // Get the bundled JS from esbuild output
  let js = result.outputFiles[0].text;

  // Post-process to inject pal as IIFE parameter
  js = postProcess(js);

  // Write polyfill.js (temporary file for qjsc input)
  const polyfillJsPath = path.join(DIST_DIR, 'polyfill.js');
  fs.writeFileSync(polyfillJsPath, js);

  // Generate bytecode using qjsc, then inline as C header
  const QJSC = process.env.QJSC;
  if (!QJSC) {
    console.error('[qzjs] ERROR: $QJSC not set. CMake passes it automatically; ' +
      'for manual builds: QJSC=<path-to-qjsc> node build.js');
    process.exit(1);
  }
  const _qjscVer = qjscVersion(QJSC);
  // 期望版本从 pinned 的 deps/quickjs-ng 头读，别硬编码：submodule 升级后硬编码
  // 的字符串必然漂移，每次构建刷一条假 WARNING（0.16.x 时代码已升 0.17.0）。
  const _expectedVer = quickjsNgVersion();
  if (_qjscVer && _expectedVer && _qjscVer !== _expectedVer) {
    console.error('[qzjs] WARNING: ' + QJSC + ' is version ' + _qjscVer +
      ', expected ' + _expectedVer + ' (pinned deps/quickjs-ng). ' +
      'Bytecode may be rejected by the engine.');
  }

  // Compile <src> with qjsc → <bcPath> bytecode file; return the bytes.
  function compileToBytecode(srcPath, bcPath) {
    execSync(QJSC + ' -s -C -b -o ' + bcPath + ' ' + srcPath, { stdio: 'pipe' });
    const bytes = fs.readFileSync(bcPath);
    console.log('Compiled: ' + bcPath + ' (' + bytes.length + ' bytes)');
    return bytes;
  }

  // Write <bytes> as a C array <symbol>[] + <symbol>_len into <cPath>.
  function writeCArray(cPath, symbol, bytes) {
    let cSrc = '/* Auto-generated by polyfill/build.js — do not edit */\n';
    cSrc += '#include <stdint.h>\n';
    cSrc += '#include <stddef.h>\n\n';
    cSrc += 'const uint8_t ' + symbol + '[] = {\n';
    for (let i = 0; i < bytes.length; i++) {
      cSrc += '0x' + bytes[i].toString(16).padStart(2, '0') + ',';
      if ((i + 1) % 16 === 0) {
        cSrc += '\n';
      }
    }
    cSrc += '\n};\n\n';
    cSrc += 'const size_t ' + symbol + '_len = ' + bytes.length + ';\n';
    fs.writeFileSync(cPath, cSrc);
    console.log('Written: ' + cPath + ' (' + bytes.length + ' bytes in array)');
  }
  try {
    // WinterTC polyfill bundle — compile to bytecode, then emit per mode
    const polyfillBytes = compileToBytecode(
      polyfillJsPath,
      path.join(DIST_DIR, 'polyfill.bytecode'));

    if (QZ_POLYFILL_MODE === 'rodata') {
      // Mode C: const array baked into .rodata (default)
      writeCArray(OUT_C,
        'qz_default_polyfill', polyfillBytes);
    } else if (QZ_POLYFILL_MODE === 'compressed') {
      // compressed: lz4 raw-block via the vendored-lz4 build tool
      // (cmake target qz_lz4_compress; same lz4 as the C decoder).
      // $QJSC-independent: tool binary path from CMake cache is passed as
      // QZ_LZ4_COMPRESS (set in CMakeLists), fall back to repo tool path.
      let tool = process.env.QZ_LZ4_COMPRESS;
      if (!tool) {
        // Best-effort default: build tree tool (cmake --build <dir> --target
        // qz_lz4_compress) — the polyfill_rebuild custom target guarantees
        // it exists before this runs in a CMake-driven build.
        tool = 'qz_lz4_compress';
      }
      const compressed = execSync(
        (fs.existsSync(tool) ? `"${tool}"` : tool),
        { input: polyfillBytes, maxBuffer: 4 * 1024 * 1024 });
      const origLen = polyfillBytes.length;
      let cSrc = '/* Auto-generated by polyfill/build.js — do not edit */\n';
      cSrc += '#include <stdint.h>\n';
      cSrc += '#include <stddef.h>\n\n';
      cSrc += '/* lz4-block-compressed polyfill bytecode (raw block, no frame) */\n';
      cSrc += 'const uint8_t qz_default_polyfill_compressed[] = {\n';
      for (let i = 0; i < compressed.length; i++) {
        cSrc += '0x' + compressed[i].toString(16).padStart(2, '0') + ',';
        if ((i + 1) % 16 === 0) cSrc += '\n';
      }
      cSrc += '\n};\n\n';
      cSrc += 'const size_t qz_default_polyfill_compressed_len = ' + compressed.length + ';\n';
      cSrc += 'const size_t qz_default_polyfill_orig_len = ' + origLen + ';\n';
      fs.writeFileSync(OUT_C, cSrc);
      console.log('Written: ' + OUT_C + ' (lz4 ' + compressed.length + ' -> ' + origLen + ' bytes)');
    } else if (QZ_POLYFILL_MODE === 'external') {
      // Mode B: external .polyfill file — no embedded bytecode, but the
      // SHA-256 of the official bytecode IS embedded as the compile-time
      // integrity anchor: the loader (external mode) refuses any file whose
      // content does not match. Custom bytecode builds must update this hash.
      const digest = require('crypto').createHash('sha256')
        .update(polyfillBytes).digest();
      let cSrc = '/* Auto-generated by polyfill/build.js — do not edit */\n';
      cSrc += '#include <stdint.h>\n';
      cSrc += '#include <stddef.h>\n';
      cSrc += '/* QZ_POLYFILL_MODE=external: bytecode loaded at runtime from\n';
      cSrc += ' * external .polyfill file.  No embedded data. */\n\n';
      cSrc += '/* SHA-256 of the official external polyfill bytecode\n';
      cSrc += ' * (dist/polyfill_default.polyfill). The external-mode loader\n';
      cSrc += ' * rejects any file that does not match this digest.\n';
      cSrc += ' * Custom polyfill builds: regenerate with build.js. */\n';
      cSrc += 'const uint8_t qz_polyfill_external_sha256[32] = {\n';
      for (let i = 0; i < 32; i++) {
        cSrc += '0x' + digest[i].toString(16).padStart(2, '0') + ',';
        if ((i + 1) % 8 === 0) cSrc += '\n';
      }
      cSrc += '};\n';
      fs.writeFileSync(OUT_C, cSrc);
      console.log('Written: ' + OUT_C + ' (B mode + sha256 ' + digest.toString('hex') + ')');
      // Write the .polyfill file (raw bytecode) for distribution
      const polyfillPath = path.join(DIST_DIR, 'polyfill_default.polyfill');
      fs.writeFileSync(polyfillPath, polyfillBytes);
      console.log('Written: ' + polyfillPath + ' (' + polyfillBytes.length + ' bytes)');
    } else if (QZ_POLYFILL_MODE === 'host') {
      // Mode D: host-provided via custom hook — no embedded bytecode
      let cSrc = '/* Auto-generated by polyfill/build.js — do not edit */\n';
      cSrc += '#include <stdint.h>\n';
      cSrc += '#include <stddef.h>\n';
      cSrc += '/* QZ_POLYFILL_MODE=host: bytecode provided by host via\n';
      cSrc += ' * qz_polyfill_load_custom().  No embedded data. */\n';
      fs.writeFileSync(OUT_C, cSrc);
      console.log('Written: ' + OUT_C + ' (D mode placeholder)');
    } else {
      console.error('Unknown QZ_POLYFILL_MODE: ' + QZ_POLYFILL_MODE + ' (expected rodata|compressed|external|host)');
      process.exit(1);
    }

    // Worker boot shim — always const array (independent of polyfill mode)
    const bootBytes = compileToBytecode(
      path.join(__dirname, 'src', 'worker-boot.js'),
      path.join(DIST_DIR, 'worker-boot.bytecode'));
    writeCArray(path.join(GEN_DIR, 'worker_boot_default.c'),
      'qz_default_worker_boot', bootBytes);
  } catch (e) {
    console.error('Error: qjsc not found, cannot generate bytecode header: ' + e.message);
    process.exit(1);
  }
}
