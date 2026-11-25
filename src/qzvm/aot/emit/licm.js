// src/qzvm/aot/emit/licm.js — 显式标注的循环不变调用外提（LICM）
//
// 目的：让 M7 能把「循环体里调用纯函数、但参数在循环外恒定」的循环抽成 num 片段。
// 现状：isNumericExpr 把普通函数调当 tagged 硬边界 → validationWork(validate(good)) 0 fragment；
// 外提后循环体变纯 f64 → M7 抽 1 fragment（ops=5, carried=t）。
//
// 安全边界（保守，显式标注才启用）：
//   1. 只有带 `// @qz-pure` 前导注释的函数才允许被外提；无标注一律不动。
//   2. 只外提实参全为标识符、且这些标识符不在循环内声明/不被循环内赋值的调用。
//   3. 外提后的声明带显式 `: number` 注解 → buildNumericVars 无需 checker 即可判 numeric。
//   4. 调用点原位换成同名标识符，求值次数从 N 次降为 1 次——仅在第 1、2 条成立时语义等价。
// 不自动推断纯度：误判会把副作用提到循环外，属静默错值，违背 100% 兼容硬约束。
// @qz-pure 契约 = 确定性、无副作用、对常量实参全函数（不抛异常）。verifyPure 校验前两者，
// 并检查函数体无 throw/try；全函数性由标注者保证（与 LLVM nounwind 同类契约）。

const ts = require("typescript");

function withPos(node, src) {
    if (src) ts.setTextRange(node, src);
    return node;
}

/** 前导注释里是否有 @qz-pure（不依赖 checker / JSDoc 解析开关）。 */
function hasPureTag(fn, sf) {
    if (!sf || !fn || fn.pos === undefined) return false;
    const ranges = ts.getLeadingCommentRanges(sf.text, fn.pos) || [];
    return ranges.some((r) => sf.text.slice(r.pos, r.end).includes("@qz-pure"));
}

function isLoop(st) {
    return st && (ts.isForStatement(st) || ts.isWhileStatement(st) || ts.isDoStatement(st));
}

function collectDeclared(n, out) {
    if (!n) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) out.add(n.name.text);
    ts.forEachChild(n, (c) => collectDeclared(c, out));
}

/** 收集被写的名字：标识符赋值 + 属性/元素写（o.x = / o[i] = / o.x++ 等）。
 *  属性写必须算——否则 readX(o) 在循环里外提后看不到 o.x 的逐轮变化。 */
function collectMutated(n, out) {
    if (!n) return;
    if (ts.isBinaryExpression(n) && n.operatorToken && ts.isAssignmentOperator(n.operatorToken.kind)) {
        const l = n.left;
        if (ts.isIdentifier(l)) out.add(l.text);
        else if (ts.isPropertyAccessExpression(l) && ts.isIdentifier(l.expression)) out.add(l.expression.text);
        else if (ts.isElementAccessExpression(l) && ts.isIdentifier(l.expression)) out.add(l.expression.text);
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
        && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
        const o = n.operand;
        if (ts.isIdentifier(o)) out.add(o.text);
        else if (ts.isPropertyAccessExpression(o) && ts.isIdentifier(o.expression)) out.add(o.expression.text);
        else if (ts.isElementAccessExpression(o) && ts.isIdentifier(o.expression)) out.add(o.expression.text);
    }
    if (n.kind === ts.SyntaxKind.DeleteKeyword) { /* delete 由 verifyPure 拒绝 */ }
    ts.forEachChild(n, (c) => collectMutated(c, out));
}

// 允许在「已证明纯」函数体内出现的调用：无副作用字符串方法 + Math.*。
// 其余调用（含未知函数、new、宿主 API）一律拒绝，避免标注说谎造成静默错值。
const PURE_METHODS = new Set(["indexOf", "lastIndexOf", "slice", "substring", "substr",
    "charAt", "charCodeAt", "startsWith", "endsWith", "includes", "toLowerCase", "toUpperCase",
    "trim", "split", "concat", "toString"]);
// Math.random 非确定性 → 外提会把每轮不同值变成同一个，禁止。
const PURE_MATH = new Set(["sqrt", "abs", "floor", "ceil", "trunc", "round", "pow", "min", "max",
    "log", "log2", "log10", "exp", "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
    "sign", "cbrt", "hypot", "fround", "clz32"]);

/** 保守纯度验证：@qz-pure 标注只有在此函数确属纯函数时才生效。 */
function verifyPure(fn) {
    // 返回类型必须是显式 number：外提声明是 : number，函数返回非 number 会被当 f64 静默错值。
    if (!fn.type || fn.type.kind !== ts.SyntaxKind.NumberKeyword) return false;
    if (fn.asteriskToken || (fn.modifiers && fn.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword))) return false;
    // 允许写的名字 = 本函数内声明的局部变量（不含形参、不含模块级变量）
    const locals = new Set();
    const collectLocals = (n) => {
        if (!n) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) locals.add(n.name.text);
        ts.forEachChild(n, collectLocals);
    };
    if (fn.body) collectLocals(fn.body);
    let ok = true;
    const walk = (n) => {
        if (!ok || !n) return;
        if (n.kind === ts.SyntaxKind.NewExpression || n.kind === ts.SyntaxKind.AwaitExpression
            || n.kind === ts.SyntaxKind.YieldExpression || n.kind === ts.SyntaxKind.DeleteExpression
            || n.kind === ts.SyntaxKind.ThrowStatement || n.kind === ts.SyntaxKind.TryStatement) { ok = false; return; }
        if (ts.isBinaryExpression(n) && n.operatorToken && ts.isAssignmentOperator(n.operatorToken.kind)) {
            // 只允许写本函数内声明的局部 let/const；写形参 / 属性 / 元素 / 模块变量都拒绝。
            const l = n.left;
            const isLocal = ts.isIdentifier(l) && locals.has(l.text);
            if (!isLocal) { ok = false; return; }
        }
        if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
            && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) { ok = false; return; }
        if (ts.isCallExpression(n)) {
            const c = n.expression;
            const pure = (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)
                    && c.expression.text === "Math" && PURE_MATH.has(c.name.text))
                || (ts.isPropertyAccessExpression(c) && PURE_METHODS.has(c.name.text));
            if (!pure) { ok = false; return; }
        }
        ts.forEachChild(n, walk);
    };
    if (fn.body) walk(fn.body);
    return ok;
}

/** 收集函数体内 const 且初值为字面量的声明（可作循环不变实参）。
 *  不依赖 n.parent（ts.createProgram 的 AST 无 parent 指针），从 VariableStatement 往下取 flags。 */
function collectConstLiterals(body, out) {
    if (!body) return;
    const addList = (list) => {
        if (!(list.flags & ts.NodeFlags.Const)) return;
        for (const d of list.declarations) {
            if (ts.isIdentifier(d.name) && d.initializer
                && (ts.isObjectLiteralExpression(d.initializer)
                    || ts.isArrayLiteralExpression(d.initializer) || ts.isLiteralExpression(d.initializer))) {
                out.set(d.name.text, d);
            }
        }
    };
    const walk = (n) => {
        if (!n) return;
        if (ts.isVariableStatement(n)) addList(n.declarationList);
        ts.forEachChild(n, walk);
    };
    walk(body);
}

/** 收集循环体里满足外提条件的调用节点。 */
function collectHoistable(root, pureNames, constLits, fnMutated, out) {
    if (!root) return;
    if (ts.isCallExpression(root) && ts.isIdentifier(root.expression) && pureNames.has(root.expression.text)
        && root.arguments.length > 0
        && root.arguments.every((a) => ts.isIdentifier(a) && constLits.has(a.text) && !fnMutated.has(a.text))) {
        out.push(root);
        return; // 调用内部不再递归（纯函数无嵌套调用语义可提）
    }
    ts.forEachChild(root, (c) => collectHoistable(c, pureNames, constLits, fnMutated, out));
}

function makeHoistDecl(name, call, src) {
    const numType = () => withPos(ts.factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword), src);
    const decl = withPos(ts.factory.createVariableDeclaration(
        withPos(ts.factory.createIdentifier(name), src), undefined, numType(), call), src);
    const list = withPos(ts.factory.createVariableDeclarationList([decl], ts.NodeFlags.Const), src);
    return withPos(ts.factory.createVariableStatement(undefined, list), src);
}

/** 把循环里的调用原位换成外提变量名（ts.transform 逐节点重建，避免手写 update 漏节点类型）。 */
function replaceCalls(loop, mapping, sf) {
    const tr = (ctx) => (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const key = node.expression.text + "(" + node.arguments.map((a) => a.getText(sf)).join(",") + ")";
            if (mapping.has(key)) return withPos(ts.factory.createIdentifier(mapping.get(key)), node);
        }
        return ts.visitEachChild(node, tr(ctx), ctx);
    };
    return ts.transform(loop, [tr]).transformed[0];
}

/**
 * 对一组顶层函数做 LICM 变换（原地替换 fns 数组里的函数节点）。
 * @param fns Array<ts.FunctionDeclaration>  compileTS 收集的顶层函数
 * @param fnSf Map<node, SourceFile>          函数节点 → 所属源文件
 * @returns {hoisted: number}                外提次数（诊断用）
 */
function hoistPureCalls(fns, fnSf) {
    if (process.env.QZ_NO_LICM) return { hoisted: 0 };
    const pureNames = new Set();
    for (const f of fns) {
        if (f.name && hasPureTag(f, fnSf.get(f)) && verifyPure(f)) pureNames.add(f.name.text);
    }
    if (!pureNames.size) return { hoisted: 0 };

    let counter = 0, hoisted = 0;
    const ctx = { sf: null, constLits: new Map(), fnMutated: new Set() };

    const rewriteBlock = (block) => {
        const out = [];
        for (const st of block.statements) {
            if (isLoop(st)) {
                const calls = [];
                collectHoistable(st.statement || st, pureNames, ctx.constLits, ctx.fnMutated, calls);
                const mapping = new Map();
                const hoists = [];
                for (const call of calls) {
                    const key = call.expression.text + "(" + call.arguments.map((a) => a.getText(ctx.sf)).join(",") + ")";
                    if (mapping.has(key)) continue;
                    const name = "__licm_" + (counter++);
                    mapping.set(key, name);
                    hoists.push(makeHoistDecl(name, call, st));
                    hoisted++;
                }
                if (hoists.length) {
                    out.push(...hoists, replaceCalls(st, mapping, ctx.sf));
                } else {
                    out.push(st);
                }
                continue;
            }
            if (ts.isBlock(st)) { out.push(rewriteBlock(st)); continue; }
            out.push(st);
        }
        return withPos(ts.factory.updateBlock(block, out), block);
    };

    for (let k = 0; k < fns.length; k++) {
        const fn = fns[k];
        if (!fn.body || pureNames.has(fn.name && fn.name.text)) continue;
        ctx.sf = fnSf.get(fn);
        if (!ctx.sf) continue;
        ctx.constLits = new Map();
        ctx.fnMutated = new Set();
        collectConstLiterals(fn.body, ctx.constLits);
        collectMutated(fn.body, ctx.fnMutated);
        const before = hoisted;
        const newBody = rewriteBlock(fn.body);
        if (hoisted !== before) {
            fns[k] = ts.factory.updateFunctionDeclaration(
                fn, fn.modifiers, fn.asteriskToken, fn.name, fn.typeParameters,
                fn.parameters, fn.type, newBody);
        }
    }
    return { hoisted };
}

module.exports = { hoistPureCalls, hasPureTag };
