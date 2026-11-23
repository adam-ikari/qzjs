# M7: Sub-Function Arithmetic Subtree Extraction

## Goal
Extract pure-numeric code fragments from ANY function (interp or wasm) into
standalone AOT-compiled wasm functions. Granularity = code fragment, not function.
No ratio threshold, no manual annotation — extract whatever is extractable.

## Core Concept: Numeric Subtree

A **numeric subtree** is a maximal connected region of the AST where:
- Every leaf is a NumericLiteral, a numeric-typed Identifier, or a numeric
  variable declared within the subtree.
- Every internal node is an arithmetic op: `+ - * / % ** | & ^ << >> >>>`,
  `++ --`, compound assign, unary `- + ~`, `Math.*`, `| 0` coercion.
- Control flow (for/while/do/if) is included IF its condition + all branches
  are numeric.
- **Hard boundary** = any tagged op: property access (`.x`), element access
  (`[i]` on non-number[]), method calls, host API calls (`JSON.parse`,
  `Object.keys`, ...), object/array literals, string literals, `new`,
  `typeof`, string-concat `+`.

When a tagged op is encountered, the numeric subtree ENDS. The tagged op's
result (if numeric) becomes a boundary value — a param to the next numeric
subtree.

## Extraction Granularity

### Level 1: Pure-numeric loop (best case)
Loop where condition + increment + entire body are pure-numeric.
→ Extract the **entire loop** as one AOT function.
Example: `computeWork` — whole for-loop is numeric → `__aot_loop_0(n, s_init) → s_final`.

### Level 2: Numeric statement block within a loop
Loop body has tagged statements + numeric statements. Consecutive numeric
statements form a block.
→ Extract the **block** as one AOT function, called per iteration.
Example: loop reads `item.x`/`item.y` (tagged, interp) then does heavy math
(x*x+y*y, sqrt, ...) → extract the math block as `__aot_frag_0(x, y, result) → result`.

### Level 3: Top-level numeric statement block
Consecutive pure-numeric statements at function top level (not in a loop).
→ Extract as AOT function. Less impactful (one-shot call) but still extracted.

### NOT extracted (stays in interp/wasm as-is)
- Single tagged statements (property reads, method calls, object literals).
- Mixed expressions where arithmetic is interleaved with tagged ops at the
  expression level (e.g., `t + m.id + m.total` — the `+` chain depends on
  tagged property reads; the arithmetic is too small to extract).
- If a numeric block has < 3 arithmetic ops AND is not in a loop → skip
  (call overhead exceeds benefit).

## Split Boundary Rules

```
function jsonWork(n) {
  const src = '{"id":7,...}';          // tagged (string literal) → BOUNDARY
  let t = 0;                            // numeric (assignment) → could be numeric
  for (let i = 0; i < n; i++) {         // loop — check body
    const o = JSON.parse(src);          // tagged (host API) → BOUNDARY
    const m = {id:o.id+i, ...};         // tagged (object literal + prop access) → BOUNDARY
    t = t + m.id + m.total + m.name.length;  // mixed — tagged operands (m.id etc.)
                                         // + arithmetic (+) but operands are tagged → NOT extractable
  }
  return t;                             // numeric (return identifier)
}
```
→ jsonWork: NO numeric subtrees worth extracting (all arithmetic depends on
tagged property reads, blocks are < 3 ops). Entire function stays interp.

```
function computeWork(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {         // loop — body is pure-numeric
    const a = i % 1000;                 // numeric (% on number + literal)
    const v = a * a;                    // numeric (* on numbers)
    s = (s+v-((v/7)|0)+((i*3)%13))%1000003;  // numeric (all arithmetic)
  }
  return s;
}
```
→ computeWork: entire loop is a pure-numeric subtree → extract as
`__aot_loop_0(n, s_init) → s_final`. Original function becomes:
```js
function computeWork(n) { let s = 0; s = __aot_loop_0(n, s); return s; }
```

## Extracted Function Calling Convention

### Signature
```
__aot_frag_N(p0: f64, p1: f64, ...) → f64   (or void if no return value)
```
- All params are f64 (number). The interp passes numeric values.
- Return is f64 (the computed result) or void.
- The fragment is compiled in **num mode** (f64 ABI, no NaN-boxing).
- The fragment is **pure**: no side effects on tagged state, no property
  access, no host API calls. Same inputs → same output.

### Free variable analysis
- Variables **read** within the fragment but **not declared** inside → free vars.
  These become params.
- Variables **declared** within the fragment + **read after** the fragment →
  return values. If > 1, pack into a single f64 return via a small struct
  in wasm memory (or split into multiple fragments — TBD).

### Loop-carried variables
For a pure-numeric loop extraction:
- Variables modified inside the loop + used after the loop → loop-carried.
- Each loop-carried variable: input param (value before loop) + return value
  (value after loop).
- Common case: single accumulator (one param + one return) — clean.
- Multiple accumulators: return a struct, or the loop is split.

### Interp → AOT call mechanism
The interp JS calls the AOT fragment via the wasm module's exports:
```js
// In interpJs (modified by the extractor):
function jsonWork(n) {
  // ... tagged parts in JS ...
  result = __wasm.__aot_frag_N(v0, v1, ...);  // calls wasm export
}
```
The glue/host provides `__wasm` = the wasm module instance's exports.
For in-module (merged wasm): the interp JS runs in the host (qzjs), which
has the wasm instance loaded via ext_wamr. The exports are accessible.

### Wasm → AOT call (internal)
If the original function is itself in wasm (not interp), the extracted
fragment is an internal wasm function call — no boundary crossing, zero
overhead. This is the case for functions that are fully numeric (like
computeWork) — but those are already entirely in wasm, so extraction is
moot (the whole function is already AOT).

Extraction is most impactful for **interp functions with numeric inner loops**.

## Extraction Pass Algorithm

```
for each function f in the module:
  fragments = findNumericFragments(f.body)
  for each fragment in fragments:
    if fragment.size < MIN_OPS and not inLoop: skip
    freeVars = analyzeFreeVars(fragment)
    loopCarried = analyzeLoopCarried(fragment)  // if fragment is a loop
    create wasm function __aot_frag_N(freeVars + loopCarried.inputs) → loopCarried.outputs
    emit fragment body in num mode
    replace fragment in f.body with call(__aot_frag_N, freeVars + loopCarried.inputs)
  if f had any fragments extracted:
    mark f as "partial-aot" (stays in interp if it has tagged parts,
    or in wasm if fully numeric post-extraction)
```

### MIN_OPS = 3
Minimum arithmetic operations for a standalone extraction (outside a loop).
Inside a loop, any numeric block ≥ 1 statement is extractable (call overhead
amortized over iterations).

## Variable Type Inference (TypeChecker)

The analysis uses the TypeScript TypeChecker (`checker.getTypeAtLocation`) to
determine variable types, not just syntax. This is critical for mixed code:
```js
const x = item.v;    // item.v is a property ACCESS (tagged op) but its static
                     // type is number → x is numeric → subsequent x*x is extractable
```
Without the checker, `x` would be classified tagged (because `item.v` is a
property access), and the numeric block `x*x+x*3` would be missed. With the
checker, `x` is known-number → the block is extracted. The `item.v` access
itself stays in interp (it's a runtime tagged op); only the arithmetic after
it is lifted to AOT.

Verified: mixedWork's loop body `{const item={v:i}; const x=item.v; const
a=x*x+x*3; const b=(a%7)+Math.sqrt(a*4); result=result+b;}` → finds ONE block
fragment (a/b/result, opCount=9.5, freeVars=[x,result]) + leaves item/x in interp.

## Extraction Integration (next step — mixed wasm+interp model)

Current architecture: either "all wasm" (merged) or "all interp" (interpJs).
M7 needs MIXED: a function splits into wasm fragments (numeric) + interp
fragments (tagged).

Integration plan:
1. For each fragment, create a synthetic FunctionDeclaration:
   `__aot_frag_N(p0:number, p1:number, ...): number { <fragment body>; return <carried>; }`
2. Add synthetic functions to fns → emitted to wasm in num mode (f64 ABI).
3. Rewrite the original function's interpJs: replace the fragment source text
   with a call `result = __aot_frag_N(x, result)`.
4. The interp JS (qzjs host) calls the wasm export via the module instance
   (host exposes wasm exports as a global, e.g. `__wasm.__aot_frag_N`).
5. The fragment is pure (no tagged state) — safe to call from interp.

Remaining: (a) AST parent pointers for splice (ts.setParentRecursive),
(b) interpJs text-level rewrite, (c) host wasm-export global for interp calls.

## What Changes from M7 v1 (whole-function)

- **Removed**: `aotWorthiness` ratio-based whole-function classification.
  No more `arithRatio >= 0.5` threshold, no more marking entire functions
  as interp based on ratio.
- **Kept**: semantic interpSet (async/generator/shared-state) — these are
  hard constraints (can't compile to wasm regardless of arithmetic content).
- **New**: sub-function extraction applies to ALL functions (including those
  in interpSet for semantic reasons). Even an async function can have its
  inner numeric loop extracted to AOT.
