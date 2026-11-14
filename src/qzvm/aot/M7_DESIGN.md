# M7: AST Auto-Analysis — AOT Target Identification

## Goal
Compiler automatically decides which functions → AOT (wasm) vs interp (JS).
No manual annotation. Based on arithmetic-vs-tagged op ratio + loop density.

## Existing Infrastructure
- `interpSet` (compile-ts.js:673): functions in this set skip wasm emit (line 1185),
  stay in `interpJs`. Currently populated by SEMANTIC reasons (async/generator/
  shared-state/call-propagation). M7 adds PERFORMANCE reasons.
- `funcMode` (layout.js:424): classifies num vs tagged ABI (crash prevention, not perf).
- `markI(name, why)`: adds to interpSet + records reason.

## AST Op Classification

### Arithmetic ops (weight +1, NumericLiteral +0.5)
- `BinaryExpression` with operator: `+ - * / % ** | & ^ << >> >>>`
  - Exception: `+` where either operand is `StringLiteral` or `TemplateExpression`
    → tagged (string concat).
- Compound assignment (`+= -= *= /= %= **= |= &= ^= <<= >>=`) → arithmetic.
- `UpdateExpression` (`++ --`) → arithmetic.
- `UnaryExpression` with `- + ~` (numeric) → arithmetic.
- `CallExpression` to `Math.*` (sqrt/abs/floor/ceil/round/pow/min/max/log/exp/sin/cos/...) → arithmetic.
- `NumericLiteral` → +0.5.

### Tagged ops (weight +1)
- `PropertyAccessExpression` (`.x`) — property read on object.
- `ElementAccessExpression` (`[x]`) — element access.
- `CallExpression` where callee is builtin global member:
  `JSON.parse/JSON.stringify/Object.keys/Object.values/Object.entries/Object.assign/
   Object.freeze/Array.from/Array.isArray/String(x)/parseInt/parseFloat/...` → tagged.
- `CallExpression` where callee is `PropertyAccessExpression` (method call: `x.indexOf/
  x.split/x.map/x.push/x.length/...`) → tagged.
- `ObjectLiteralExpression` `{...}` → tagged.
- `ArrayLiteralExpression` `[...]` → tagged (non-empty).
- `StringLiteral` / `TemplateExpression` / `NoSubstitutionTemplateLiteral` → tagged.
- `NewExpression` → tagged.
- `TypeOfExpression` → tagged.
- `BinaryExpression` `+` with string operand → tagged (see above).

### Neutral (weight 0)
- `Identifier`, `VariableDeclaration`, control flow (`If/For/While/Return/Block`).
- `AssignmentExpression` with `=` (RHS classified separately).
- `CallExpression` to user-defined functions (depends on callee's own classification).
- `AsExpression` / type assertions / `ParenthesizedExpression` (unwrap, classify inner).
- `TrueKeyword` / `FalseKeyword` / `NullKeyword` / `UndefinedKeyword`.

### Loop density
- `loopCount`: For/While/Do/ForOf/ForIn statements in function.
- `maxLoopDepth`: max nesting (depth tracked via recursion).

## Scoring Formula
```
totalOps   = arithOps + taggedOps
arithRatio = arithOps / max(totalOps, 1)
loopScore  = loopCount + maxLoopDepth * 2
```

### Decision
- **AOT-worthy**: `arithRatio >= 0.5 AND loopScore >= 1`
- **Interp**: otherwise → `markI(name, "tagged-heavy:ratio=" + arithRatio)`

### Threshold Rationale (from WAMR bench data)
| Function | arithRatio | loopScore | AOT ratio | Decision |
|---|---|---|---|---|
| computeWork | ~1.0 | 1 | 7.92× | AOT ✓ |
| jsonWork | ~0.29 | 1 | 0.51× | interp ✓ |
| validationWork | ~0.30 | 1 | 0.54× | interp ✓ |
| validate | ~0.38 | 0 | — | interp (no loop) ✓ |

- `arithRatio >= 0.5`: computeWork (pure arithmetic) gets 7.92× AOT. Tagged-heavy
  loads (<0.4 ratio) get <1×. 0.5 is the break-even point — below it AOT loses.
- `loopScore >= 1`: AOT only wins in hot loops (amortizes wasm call overhead).
  Non-looped functions with arithmetic get no AOT benefit (one-shot call overhead
  dominates).

## Call Propagation (existing, unchanged)
If function A calls interp-marked function B → A also interp (line 746).
This ensures validate()→interp propagates to validationWork()→interp.

## Integration Point
New function `aotWorthiness(f)` in layout.js (alongside `funcMode`).
Called in compile-ts.js after semantic interpSet is populated (line ~691),
before call-propagation loop (line ~746). Adds performance-based marks.

## funcMeta Extension
Add to funcMeta entries:
- `arithOps`: number
- `taggedOps`: number
- `arithRatio`: 0..1
- `loopScore`: number
- `aotDecision`: "aot" | "interp:tagged-heavy" | "interp:no-loop" | "interp:semantic"
