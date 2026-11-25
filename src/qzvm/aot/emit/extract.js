// src/qzvm/aot/emit/extract.js — M7 v2: sub-function numeric subtree extraction
// Identifies pure-numeric code fragments (loops, statement blocks) within functions
// for extraction as standalone AOT-compiled wasm functions.
// See M7_DESIGN.md for rules.

const ts = require("typescript");

// ── Expression classification ──────────────────────────────────────

const ARITH_OPS = new Set([
    ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.BarToken, ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.CaretToken,
    ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);
const CMP_OPS = new Set([
    ts.SyntaxKind.LessThanToken, ts.SyntaxKindGreaterThanToken,
    ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const MATH_FNS = new Set(["sqrt","abs","floor","ceil","trunc","round","pow","min","max",
    "log","log2","log10","exp","sin","cos","tan","asin","acos","atan","atan2",
    "sign","cbrt","hypot","fround","clz32"]);
const COMPOUND_OPS = new Set([
    ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
    ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
    ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.CaretEqualsToken,
    ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
]);

// Fix CMP_OPS (typo guard)
const CMP_OPS_FIXED = new Set([
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

/**
 * Determine if an expression is pure-numeric (no tagged ops).
 * @param node - AST expression node
 * @param numericVars - Set<string> of variable names known to hold numbers
 * @returns boolean
 */
function isNumericExpr(node, numericVars, checker) {
    if (!node) return false;
    if (ts.isNumericLiteral(node)) return true;
    if (ts.isIdentifier(node)) return numericVars.has(node.text) || (checker && isNumericTypeAt(node, checker, ts));
    if (ts.isParenthesizedExpression(node)) return isNumericExpr(node.expression, numericVars, checker);
    if (ts.isBinaryExpression(node)) {
        // Assignment: x = v / x += v → numeric if LHS identifier is numeric + RHS numeric
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            return ts.isIdentifier(node.left) && numericVars.has(node.left.text) &&
                isNumericExpr(node.right, numericVars, checker);
        }
        if (ARITH_OPS.has(node.operatorToken.kind) || CMP_OPS_FIXED.has(node.operatorToken.kind)) {
            // + with string operand → not numeric
            if (node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
                (isStringLike(node.left) || isStringLike(node.right))) return false;
            return isNumericExpr(node.left, numericVars, checker) && isNumericExpr(node.right, numericVars, checker);
        }
        return false;
    }
    if (ts.isPrefixUnaryExpression(node)) {
        const op = node.operator;
        if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken ||
            op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.PlusToken ||
            op === ts.SyntaxKind.TildeToken)
            return isNumericExpr(node.operand, numericVars, checker);
        return false;   // typeof, void, delete, !
    }
    if (ts.isPostfixUnaryExpression(node))
        return isNumericExpr(node.operand, numericVars, checker);
    if (ts.isCallExpression(node)) {
        // Math.* (all args numeric)
        if (ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === "Math" &&
            MATH_FNS.has(node.expression.name.text)) {
            return node.arguments.every(a => isNumericExpr(a, numericVars, checker));
        }
        return false;   // any other call = tagged
    }
    if (ts.isAsExpression(node) || ts.isNonNullExpression(node))
        return isNumericExpr(node.expression, numericVars, checker);
    // Everything else: property access, element access, literals (string/bool/null/undefined),
    // object/array literals, new, template, etc. → tagged
    return false;
}

function isStringLike(node) {
    return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node));
}

// ── Variable type tracking ─────────────────────────────────────────

/**
 * Determine if a TypeScript type is numeric (number or number-only union).
 */
function isNumberType(type, ts) {
    if (!type) return false;
    if (type.flags & ts.TypeFlags.Number) return true;
    if (type.flags & ts.TypeFlags.Union) {
        const members = type.types;
        return members && members.length > 0 && members.every(t => isNumberType(t, ts));
    }
    return false;
}

/**
 * Determine if an expression's static type is number (via checker).
 */
function isNumericTypeAt(node, checker, ts) {
    try {
        const type = checker.getTypeAtLocation(node);
        return isNumberType(type, ts);
    } catch (_) { return false; }
}

/**
 * Scan function body to determine which variables are always numeric.
 * Uses TypeChecker type inference when available (checker), falls back to syntax.
 * @param f - FunctionDeclaration
 * @param checker - TypeChecker (optional)
 * @returns Set<string> of variable names that are always numeric
 */
function buildNumericVars(f, checker) {
    const numericVars = new Set();
    // Params typed number (syntactic) OR checker says number
    for (const p of f.parameters) {
        if (!ts.isIdentifier(p.name)) continue;
        if ((p.type && p.type.kind === ts.SyntaxKind.NumberKeyword) ||
            (checker && isNumericTypeAt(p.name, checker, ts)))
            numericVars.add(p.name.text);
    }
    // Walk all declarations + assignments
    const walk = (n) => {
        if (!n) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
            // 显式 : number 注解优先（LICM 外提的合成声明带此注解；AST 重建后 checker
            // 可能无符号信息，此时按注解认定 numeric，与 TS 类型系统一致）。
            if (n.type && n.type.kind === ts.SyntaxKind.NumberKeyword) {
                numericVars.add(n.name.text);
            } else if (checker && isNumericTypeAt(n.name, checker, ts)) {
                numericVars.add(n.name.text);
            } else if (n.initializer && isNumericExpr(n.initializer, numericVars, checker)) {
                numericVars.add(n.name.text);
            } else if (n.initializer) {
                numericVars.delete(n.name.text);
            }
        }
        // Assignment: x = expr / x += expr
        if (ts.isExpressionStatement(n) && ts.isBinaryExpression(n.expression) &&
            ts.isAssignmentExpression(n.expression) && ts.isIdentifier(n.expression.left)) {
            const name = n.expression.left.text;
            if (checker && isNumericTypeAt(n.expression.left, checker, ts)) {
                numericVars.add(name);
            } else if (!isNumericExpr(n.expression.right, numericVars, checker)) {
                numericVars.delete(name);
            }
        }
        ts.forEachChild(n, walk);
    };
    if (f.body) walk(f.body);
    return numericVars;
}

// ── Statement classification ───────────────────────────────────────

/**
 * Classify a statement as pure-numeric (all expressions numeric).
 */
function isNumericStmt(stmt, numericVars, checker) {
    if (!stmt) return false;
    // Variable declaration: all initializers numeric
    if (ts.isVariableStatement(stmt)) {
        return stmt.declarationList.declarations.every(d =>
            !d.initializer || isNumericExpr(d.initializer, numericVars, checker));
    }
    // Expression statement: the expression is numeric
    if (ts.isExpressionStatement(stmt)) {
        return isNumericExpr(stmt.expression, numericVars, checker);
    }
    // Return: numeric expression (or no expression = void return)
    if (ts.isReturnStatement(stmt)) {
        return !stmt.expression || isNumericExpr(stmt.expression, numericVars, checker);
    }
    // If: condition + then + else all numeric
    if (ts.isIfStatement(stmt)) {
        if (!isNumericExpr(stmt.expression, numericVars, checker)) return false;
        if (!isNumericStmt(stmt.thenStatement, numericVars, checker)) return false;
        if (stmt.elseStatement && !isNumericStmt(stmt.elseStatement, numericVars, checker)) return false;
        return true;
    }
    // Block: all statements numeric
    if (ts.isBlock(stmt)) {
        return stmt.statements.every(s => isNumericStmt(s, numericVars, checker));
    }
    // For/While/Do: handled separately by findNumericFragments
    // Other statements (break, continue, throw, try, etc.) → not numeric
    return false;
}

// ── Fragment finding ───────────────────────────────────────────────

/**
 * Find extractable numeric fragments in a function body.
 * @param f - FunctionDeclaration
 * @returns Array of fragments:
 *   { type: "loop"|"block", stmts: [nodes], freeVars: [string], opCount: number, loopVar?: string }
 */
function findNumericFragments(f, checker) {
    const numericVars = buildNumericVars(f, checker);
    const fragments = [];

    if (!f.body || !ts.isBlock(f.body)) return fragments;
    const stmts = f.body.statements;

    let i = 0;
    while (i < stmts.length) {
        const stmt = stmts[i];

        if (ts.isForStatement(stmt) || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
            const loopNumeric = isLoopNumeric(stmt, numericVars, checker);
            if (loopNumeric.numeric) {
                fragments.push({
                    type: "loop",
                    node: stmt,
                    parentBlock: f.body,
                    startIdx: i,
                    endIdx: i + 1,
                    freeVars: loopNumeric.freeVars,
                    loopCarried: loopNumeric.loopCarried,
                    opCount: loopNumeric.opCount,
                    bodyStmts: loopNumeric.bodyStmts,
                });
                i++;
                continue;
            }
            // Loop body has tagged parts → scan body for numeric blocks (Level 2)
            if (stmt.statement && ts.isBlock(stmt.statement)) {
                const bodyFrags = findNumericBlocksInBody(stmt.statement.statements, numericVars, checker);
                for (const bf of bodyFrags) {
                    fragments.push({ ...bf, type: "block", inLoop: true, parentBlock: stmt.statement, parentLoop: stmt });
                }
            }
            i++;
            continue;
        }

        // Top-level: group consecutive numeric statements into blocks (Level 3)
        if (isNumericStmt(stmt, numericVars, checker)) {
            let j = i + 1;
            while (j < stmts.length && !ts.isForStatement(stmts[j]) && !ts.isWhileStatement(stmts[j]) &&
                   !ts.isDoStatement(stmts[j]) && isNumericStmt(stmts[j], numericVars, checker))
                j++;
            if (j > i + 1) {
                const block = Array.from(stmts.slice(i, j));
                fragments.push({
                    type: "block",
                    stmts: block,
                    parentBlock: f.body,
                    startIdx: i,
                    endIdx: j,
                    freeVars: analyzeFreeVars(block, numericVars),
                    opCount: countOps(block, numericVars),
                    inLoop: false,
                });
            }
            i = j;
            continue;
        }
        i++;
    }
    return fragments;
}

/** Check if a loop is entirely numeric (condition + increment + body). */
function isLoopNumeric(loop, numericVars, checker) {
    const localVars = new Set(numericVars);
    let opCount = 0;

    // For statement: init + condition + increment
    if (ts.isForStatement(loop)) {
        if (loop.initializer) {
            if (ts.isVariableDeclarationList(loop.initializer)) {
                for (const d of loop.initializer.declarations) {
                    if (d.initializer && isNumericExpr(d.initializer, localVars, checker) && ts.isIdentifier(d.name))
                        localVars.add(d.name.text);
                    else return { numeric: false };
                }
            } else if (!isNumericExpr(loop.initializer, localVars, checker))
                return { numeric: false };
        }
        if (loop.condition && !isNumericExpr(loop.condition, localVars, checker)) return { numeric: false };
        if (loop.incrementor && !isNumericExpr(loop.incrementor, localVars, checker)) return { numeric: false };
    } else if (ts.isWhileStatement(loop)) {
        if (!isNumericExpr(loop.expression, localVars, checker)) return { numeric: false };
    } else if (ts.isDoStatement(loop)) {
        if (!isNumericExpr(loop.expression, localVars, checker)) return { numeric: false };
    }

    // Body
    const body = loop.statement;
    const bodyStmts = ts.isBlock(body) ? Array.from(body.statements) : [body];
    if (!bodyStmts.every(s => isNumericStmt(s, localVars, checker))) return { numeric: false };

    opCount = countOps(bodyStmts, localVars);

    // Free vars: identifiers used in the loop but not params or locally declared
    const freeVars = analyzeFreeVars([...bodyStmts, loop], localVars, true);
    // Loop-carried: vars assigned in loop + declared before loop
    const loopCarried = analyzeLoopCarried(bodyStmts, localVars, numericVars);

    return { numeric: true, freeVars, loopCarried, opCount, bodyStmts };
}

/** Find consecutive numeric statement blocks within a list of statements. */
function findNumericBlocksInBody(stmts, numericVars, checker) {
    const blocks = [];
    let i = 0;
    while (i < stmts.length) {
        if (isNumericStmt(stmts[i], numericVars, checker)) {
            let j = i + 1;
            while (j < stmts.length && isNumericStmt(stmts[j], numericVars, checker)) j++;
            const block = Array.from(stmts.slice(i, j));
            const ops = countOps(block, numericVars);
            if (ops >= 3) {   // min 3 ops for per-iteration extraction
                blocks.push({
                    stmts: block,
                    freeVars: analyzeFreeVars(block, numericVars),
                    opCount: ops,
                    startIdx: i,
                    endIdx: j,
                });
            }
            i = j;
        } else {
            i++;
        }
    }
    return blocks;
}

/** Collect identifiers used in statements but not declared within (two-pass). */
function analyzeFreeVars(nodes, numericVars, isLoop) {
    // Pass 1: collect all declared names (including loop init vars)
    const declared = new Set();
    const collectDecl = (n) => {
        if (!n) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) declared.add(n.name.text);
        ts.forEachChild(n, collectDecl);
    };
    for (const node of nodes) collectDecl(node);
    // Pass 2: collect used numeric vars not declared in subtree
    const used = new Set();
    const collectUse = (n) => {
        if (!n) return;
        if (ts.isIdentifier(n) && numericVars.has(n.text) && !declared.has(n.text) && !used.has(n.text))
            used.add(n.text);
        ts.forEachChild(n, collectUse);
    };
    for (const node of nodes) collectUse(node);
    return [...used];
}

/** Loop-carried: vars declared OUTSIDE the loop + assigned INSIDE (read+write). */
function analyzeLoopCarried(bodyStmts, localVars, outerNumericVars) {
    // Vars declared inside the loop body (per-iteration, not carried)
    const insideDeclared = new Set();
    const collectDecl = (n) => {
        if (!n) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) insideDeclared.add(n.name.text);
        ts.forEachChild(n, collectDecl);
    };
    for (const s of bodyStmts) collectDecl(s);
    // Vars assigned inside the loop (x = ... / x += ...) that are declared outside
    const carried = new Set();
    const collectAssign = (n) => {
        if (!n) return;
        if (ts.isBinaryExpression(n) && ts.isAssignmentExpression(n) && ts.isIdentifier(n.left)) {
            const name = n.left.text;
            if (!insideDeclared.has(name) && outerNumericVars.has(name)) carried.add(name);
        }
        ts.forEachChild(n, collectAssign);
    };
    for (const s of bodyStmts) collectAssign(s);
    return [...carried];
}

/** Count arithmetic ops in statements. */
function countOps(nodes, numericVars) {
    let count = 0;
    const walk = (n) => {
        if (!n) return;
        if (ts.isBinaryExpression(n) && (ARITH_OPS.has(n.operatorToken.kind) || CMP_OPS_FIXED.has(n.operatorToken.kind)))
            count++;
        if (ts.isPrefixUnaryExpression(n) && (n.operator === ts.SyntaxKind.PlusPlusToken ||
            n.operator === ts.SyntaxKind.MinusMinusToken || n.operator === ts.SyntaxKind.MinusToken ||
            n.operator === ts.SyntaxKind.PlusToken || n.operator === ts.SyntaxKind.TildeToken)) count++;
        if (ts.isPostfixUnaryExpression(n)) count++;
        if (ts.isNumericLiteral(n)) count += 0.5;
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
            ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "Math" &&
            MATH_FNS.has(n.expression.name.text)) count++;
        ts.forEachChild(n, walk);
    };
    for (const node of nodes) walk(node);
    return count;
}

module.exports = { isNumericExpr, isNumericStmt, buildNumericVars, findNumericFragments, countOps };

// ── Extraction: synthetic num functions + original rewrite ──────────

/** Find the variable assigned inside a block that is declared outside (output). */
function analyzeBlockOutput(blockStmts, freeVars) {
    const freeSet = new Set(freeVars);
    const assigned = new Set();
    const collectAssign = (n) => {
        if (!n) return;
        if (ts.isBinaryExpression(n) && ts.isAssignmentExpression(n) && ts.isIdentifier(n.left))
            assigned.add(n.left.text);
        ts.forEachChild(n, collectAssign);
    };
    for (const s of blockStmts) collectAssign(s);
    // Output = assigned vars that are also free (read from outside)
    return [...assigned].filter(a => freeSet.has(a));
}

/** Build a synthetic num-mode function declaration for a fragment. */
function buildSyntheticFunction(frag, fname) {
    const srcPos = frag.type === "loop" ? frag.node : (frag.stmts && frag.stmts[0]);
    const carried = frag.type === "loop"
        ? (frag.loopCarried || [])
        : analyzeBlockOutput(frag.stmts || [], frag.freeVars || []);
    const freeVars = frag.freeVars || [];
    const paramNames = [...new Set([...freeVars, ...carried])];
    const numType = () => withPos(ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword), srcPos);
    const params = paramNames.map(nm =>
        withPos(ts.factory.createParameterDeclaration(
            undefined, undefined, nm, undefined, numType(), undefined), srcPos));
    const bodyStmts = frag.type === "loop" ? [frag.node] : (frag.stmts || []);
    const retVar = carried[0] || null;
    const stmts = [...bodyStmts];
    if (retVar) {
        stmts.push(withPos(ts.factory.createReturnStatement(
            withPos(ts.factory.createIdentifier(retVar), srcPos)), srcPos));
    }
    const body = withPos(ts.factory.createBlock(stmts, true), srcPos);
    const retType = retVar ? numType() : withPos(ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword), srcPos);
    return withPos(ts.factory.createFunctionDeclaration(
        [withPos(ts.factory.createModifier(ts.SyntaxKind.ExportKeyword), srcPos)],
        undefined, withPos(ts.factory.createIdentifier(fname), srcPos), undefined, params, retType, body), srcPos);
}

/** Set a real source position on a synthetic node (emitter _line needs it). */
function withPos(node, src) {
    if (src) ts.setTextRange(node, src);
    return node;
}

/** Build the call statement replacing a fragment: [out =] __aot_frag_N(args). */
function buildCallStatement(frag, fname) {
    const carried = frag.type === "loop"
        ? (frag.loopCarried || [])
        : analyzeBlockOutput(frag.stmts || [], frag.freeVars || []);
    const freeVars = frag.freeVars || [];
    const paramNames = [...new Set([...freeVars, ...carried])];
    const srcPos = frag.type === "loop" ? frag.node : (frag.stmts && frag.stmts[0]);
    const args = paramNames.map(nm => withPos(ts.factory.createIdentifier(nm), srcPos));
    const callee = withPos(ts.factory.createIdentifier(fname), srcPos);
    const call = withPos(ts.factory.createCallExpression(callee, undefined, args), srcPos);
    if (carried.length === 1) {
        const lhs = withPos(ts.factory.createIdentifier(carried[0]), srcPos);
        const assign = withPos(ts.factory.createBinaryExpression(lhs, ts.SyntaxKind.EqualsToken, call), srcPos);
        return withPos(ts.factory.createExpressionStatement(assign), srcPos);
    }
    return withPos(ts.factory.createExpressionStatement(call), srcPos);
}

/**
 * Extract numeric fragments from f: create synthetic num functions + rewrite f's body.
 * Returns { syntheticFunctions: [FunctionDeclaration], rewrittenFunction, fragments }.
 * Only extracts within a single parent block level (function body + top-level loops).
 * counter: { n } mutable counter for unique fragment names.
 */
function extractFragments(f, checker, counter) {
    const fragments = findNumericFragments(f, checker);
    if (fragments.length === 0) return { syntheticFunctions: [], rewrittenFunction: f, fragments };

    const syntheticFunctions = [];
    // Group edits by parentBlock
    const editsByBlock = new Map();
    // Filter: skip fragments without a clear output? Keep loops (carried) + blocks (output).
    const kept = [];
    for (const frag of fragments) {
        const carried = frag.type === "loop" ? (frag.loopCarried || [])
            : analyzeBlockOutput(frag.stmts || [], frag.freeVars || []);
        if (carried.length === 0) continue;   // no output → skip (e.g. pure void computation)
        const fname = "__aot_frag_" + (counter.n++);
        syntheticFunctions.push(buildSyntheticFunction(frag, fname));
        const rep = buildCallStatement(frag, fname);
        if (!editsByBlock.has(frag.parentBlock)) editsByBlock.set(frag.parentBlock, []);
        editsByBlock.get(frag.parentBlock).push({ startIdx: frag.startIdx, endIdx: frag.endIdx, replacement: rep });
        kept.push({ frag, fname });
    }
    if (kept.length === 0) return { syntheticFunctions: [], rewrittenFunction: f, fragments };

    // Apply edits: for each parent block, build new statement list
    const newBodies = new Map();
    for (const [block, edits] of editsByBlock) {
        const stmts = [...block.statements];
        edits.sort((a, b) => b.startIdx - a.startIdx);   // reverse to preserve indices
        for (const e of edits) stmts.splice(e.startIdx, e.endIdx - e.startIdx, e.replacement);
        newBodies.set(block, stmts);
    }

    // Recursively rebuild the function body, replacing loop-body blocks that have edits
    const rebuildBlock = (block) => {
        let stmts = block.statements;
        if (newBodies.has(block)) stmts = newBodies.get(block);
        // Also rebuild nested loop bodies that had edits
        const newStmts = stmts.map(stmt => {
            if ((ts.isForStatement(stmt) || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) &&
                stmt.statement && ts.isBlock(stmt.statement) && newBodies.has(stmt.statement)) {
                const newLoopBody = rebuildBlock(stmt.statement);
                if (ts.isForStatement(stmt))
                    return ts.factory.updateForStatement(stmt, stmt.initializer, stmt.condition, stmt.incrementor, newLoopBody);
                if (ts.isWhileStatement(stmt))
                    return ts.factory.updateWhileStatement(stmt, stmt.expression, newLoopBody);
                return ts.factory.updateDoStatement(stmt, newLoopBody, stmt.expression);
            }
            return stmt;
        });
        return ts.factory.updateBlock(block, newStmts);
    };

    const newBody = rebuildBlock(f.body);
    const newFn = ts.factory.updateFunctionDeclaration(
        f, f.modifiers, f.asteriskToken, f.name, f.typeParameters,
        f.parameters, f.type, newBody);
    return { syntheticFunctions, rewrittenFunction: newFn, fragments: kept.map(k => k.frag) };
}

module.exports.__extractFragments = extractFragments;
