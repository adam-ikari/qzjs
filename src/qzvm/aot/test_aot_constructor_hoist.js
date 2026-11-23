#!/usr/bin/env node
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..", "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "qz-aot-ctor-"));
const src = path.join(out, "zodctor.ts");
const wamrc = process.env.WAMRC || path.join(root, "deps/wamr/wamr-compiler/build/wamrc");
fs.writeFileSync(src, [
    'import { z } from "/home/gem/project/report_mcp/node_modules/zod/src/v4/classic/index";',
    'const schema = z.object({ a: z.string() });',
    'export function bench(n: number): number {',
    '  let ok = 0;',
    '  for (let i = 0; i < n; i++) if (schema.safeParse({ a: "x" }).success) ok++;',
    '  return ok;',
    '}',
    "",
].join("\n"));

try {
    execFileSync(process.execPath,
        [path.join(root, "src/qzvm/aot/build.js"), "build", src, "zodctor", "--main", "bench(1)"],
        { cwd: root, env: { ...process.env, WAMRC: wamrc, AOT_OUT_DIR: out }, stdio: "pipe", timeout: 180000 });
    const stdout = execFileSync(path.join(root, "build/qzjs"), ["zodctor.glue.js"],
        { cwd: out, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
    assert.match(stdout, /bench\(1\) = 1\b/);
    console.log("PASS: $constructor 类值 hoist 后 zod AOT 可执行");
} finally {
    fs.rmSync(out, { recursive: true, force: true });
}
