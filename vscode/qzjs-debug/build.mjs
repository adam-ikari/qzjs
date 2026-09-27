// qzjs-debug build script — zero-config esbuild-free bundling via Bun.
// The adapter + extension are plain CommonJS; we just copy/transpile to out/.
import { build } from "esbuild";
import { mkdirSync, cpSync } from "node:fs";

mkdirSync("out", { recursive: true });

await build({
  entryPoints: ["src/extension.ts", "src/adapter/qzjsDebugSession.ts"],
  bundle: true,
  outdir: "out",
  platform: "node",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
});

cpSync("testdata", "out/testdata", { recursive: true });
console.log("built out/");
