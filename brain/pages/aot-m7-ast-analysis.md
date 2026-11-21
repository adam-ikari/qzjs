---
id: aot-m7-ast-analysis
title: "M7: AST auto-analysis for AOT target identification"
category: decision
status: active
tags: [aot, m7, ast, analysis]
created: "2026-11-14T18:52:23"
updated: "2026-11-14T20:07:06"
---

<!-- compiled_truth -->
## M7: Sub-Function Numeric Subtree Extraction (no annotation)

Direction: do NOT decide "whole function AOT vs interp" by arithmetic ratio
(the old `aotWorthiness >= 0.5` + `markI(tagged-heavy)` approach is retired).
Instead, split a typed function at the AST level: pure-numeric subtrees become
separate **num-mode wasm functions** (`__aot_frag_N`); the original function keeps
its tagged parts and calls the fragments. One function can yield many fragments
(loop-level + block-level) plus an arbitrary tagged remainder.

### Analysis (`findNumericFragments(f, checker)` in extract.js)
- Uses TypeChecker type inference (`checker.getTypeAtLocation → isNumberType`) as
  the deciding signal — syntax heuristics alone misclassify e.g. `const x = item.v`
  (property access) as tagged and lose the following `x*x`.
- Levels: (1) whole loop numeric → extract loop; (2) tagged loop body → extract
  numeric blocks inside; (3) top-level consecutive numeric statements → extract block.
- Each fragment carries `parentBlock` + `startIdx`/`endIdx`, `freeVars`,
  `loopCarried` (loop) / `analyzeBlockOutput` (block), `opCount`, `inLoop`.

### Extraction (`extractFragments(f, checker, counter)` in extract.js)
- Synthesizes `export function __aot_frag_N(<freeVars+carried>: number): number`
  (body = fragment stmts; `return <carried>`) and rewrites the original body,
  replacing the fragment range with `out = __aot_frag_N(args)`.
- **Every synthetic node must get a real source position** (`ts.setTextRange` from
  the fragment's first stmt) — the emitter's `_line` (DWARF) calls `getStart()`,
  which throws "Node must have a real position" on pos=-1 nodes.
- Factory signature trap: `ts.factory.createFunctionDeclaration` is **7 params**
  (modifiers, asteriskToken, name, typeParameters, parameters, type, body) — no
  leading node. An extra `undefined` silently shifts `name`/`body` to undefined.

### Integration (`compileTS` in compile-ts.js)
- Extraction runs BEFORE the declaration loop, only for non-num functions
  (`funcMode !== "num"` — pure-num functions need no split; pure-tagged yield 0
  fragments). `QZ_NO_M7=1` disables (A/B).
- Synthetic fns declared with **f64** ABI; registered in `fnMode` as
  `{mode:"num"}` so the call site inserts `f64ReinterpretI64` (arg) /
  `i64ReinterpretF64` (ret) — exact (numbers are raw f64 bits in the tagged i64).
- Emit order: synthetic fns FIRST, then the rewritten original (the call needs the
  callee already declared).

### Verified (WAMR, ext_wamr, N=200k, aotp.ts mixedWork)
- mixedWork = tagged `{mul:3}`/`cfg.mul` setup + hot numeric loop.
- WITH extraction: AOT **8.46×** vs qzjs-interp (check 257423, correct).
- WITHOUT extraction (`QZ_NO_M7=1`): AOT **1.88×** (tagged-mode i64 loop).
- → **4.5× gain** from extracting the loop into a num fragment.
- No regression: computeWork 8.94×, jsonWork 0.53×, validationWork 0.57×.
- WAMR-interp also benefits (257.889ms → 31.077ms) — num fragment vs tagged loop.

### Known constraint
- In-module memory ceiling = `INMOD_PAGES` 1024 = 64 MiB (arena [20MiB,64MiB)).
  validationWork(50k) sat near it; adding mixedWork's "mul" field pushed it over →
  bench validationWork N lowered to 20k for headroom. Pre-existing fragility,
  independent of M7.


## Timeline

- time: 2026-11-14T18:52:23
  kind: decision
  summary: "Created this page: M7: AST auto-analysis for AOT target identification"
  source: "commit f89d8c65, M7_DESIGN.md"
  affects: [aot-m7-ast-analysis]

- time: 2026-11-14T18:52:36
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: brain update-truth
  affects: [aot-m7-ast-analysis]

- time: 2026-11-14T20:06:57
  kind: decision
  summary: "M7 = sub-function numeric subtree extraction (not whole-function ratio)"
  source: "src/qzvm/aot/emit/extract.js; commit ce09b959"
  affects: [aot-m7-ast-analysis]

- time: 2026-11-14T20:07:06
  kind: reversal
  summary: "Superseded whole-function arithRatio>=0.5 + markI(tagged-heavy). Direction is now AST sub-function split: numeric subtrees -> num AOT fragments, tagged remainder stays. Verified mixedWork AOT 8.46x vs 1.88x without extraction."
  source: commit ce09b959
  affects: [aot-m7-ast-analysis]
