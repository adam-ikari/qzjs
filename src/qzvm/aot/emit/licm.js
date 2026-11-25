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

function collectAssigned(n, out) {
    if (!n) return;
    if (ts.isBinaryExpression(n) && n.operatorToken && ts.isAssignmentOperator(n.operatorToken.kind)
        && ts.isIdentifier(n.left)) out.add(n.left.text);
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
        && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
        && ts.isIdentifier(n.operand)) out.add(n.operand.text);
    ts.forEachChild(n, (c) => collectAssigned(c, out));
}

/** 收集循环体里满足外提条件的调用节点。 */
function collectHoistable(root, pureNames, loopDeclared, loopAssigned, out) {
    if (!root) return;
    if (ts.isCallExpression(root) && ts.isIdentifier(root.expression) && pureNames.has(root.expression.text)
        && root.arguments.length > 0
        && root.arguments.every((a) => ts.isIdentifier(a) && !loopDeclared.has(a.text) && !loopAssigned.has(a.text))) {
        out.push(root);
        return; // 调用内部不再递归（纯函数无嵌套调用语义可提）
    }
    ts.forEachChild(root, (c) => collectHoistable(c, pureNames, loopDeclared, loopAssigned, out));
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
    const pureNames = new Set();
    for (const f of fns) if (f.name && hasPureTag(f, fnSf.get(f))) pureNames.add(f.name.text);
    if (!pureNames.size) return { hoisted: 0 };

    let counter = 0, hoisted = 0;
    const ctx = { sf: null };

    const rewriteBlock = (block) => {
        const out = [];
        for (const st of block.statements) {
            if (isLoop(st)) {
                const declared = new Set(), assigned = new Set();
                collectDeclared(st, declared);
                collectAssigned(st, assigned);
                const calls = [];
                collectHoistable(st.statement || st, pureNames, declared, assigned, calls);
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
