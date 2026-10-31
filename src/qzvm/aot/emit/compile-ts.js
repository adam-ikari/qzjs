/* compile-ts.js — 多文件收集/契约分析/两趟发射主流程
 * emitter.js 拆分件；模块图见 ../emitter.js 顶部注释。 */
"use strict";
const ts = require("typescript");
const fs = require("fs");
const path = require("path");
const { Module } = require("../wasm-encoder.js");
const { registerQz, stripTsTypes, usesArguments, ctorName, symbolNameOf, methName, staticMethName } = require("./consts.js");
const { SCRATCH, STR_BASE, STR_BUMP, INMOD_HOST_LIMIT, INMOD_STR_BUMP, INMOD_TABLE_CAP, INMOD_STR_BASE, INMOD_PAGES, memLayout, emitBumpAlloc, emitMemHelpers, emitStringHelpers, emitNumArrHelpers, numArrNames, funcMode } = require("./layout.js");
const { Emitter } = require("./emitter.js");
require("./tagged.js");   // 副作用：挂上 Emitter.prototype 的 tagged 发射方法

function compileTS(input, outWasm, opts = {}) {
    // tsc 的 createProgram **自带模块解析**（import 链）：它把被 import 的 .ts 文件全部
    // 纳入 program.getSourceFiles()。这是现成的 TS 内联工具——不自己实现模块图遍历。
    // 每个源文件（非声明文件）的顶层函数/类都编进**同一个** wasm 模块（内联）；跨文件
    // 引用经 tsc 解析后是同模块内的普通 call（名字域 = wasm 函数索引）。
    // module: None —— interp 回退要直接 emit 出可内联的 JS（见下方 interpJs），不希望 tsc 生成
    // require/exports 包装；wasm 路径只用 AST，不受影响。
    const compilerOpts = { strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, moduleResolution: ts.ModuleResolutionKind.NodeJs };
    const program = ts.createProgram([input], compilerOpts);
    /* tsc 的 program 会把 `import type` 的传递依赖也收进来（类型检查需要），但这些文件在
     * 运行时被完全擦除：内联它们会污染名字域，并把无关 async 代码拖进 interp 判定
     * （实测 zod util.ts：83 个 program 源文件里运行时只依赖 2 个，却因类型依赖链上的
     *  async 整棵退 interp）。故只沿**运行时导入边**（值导入 / 副作用导入 / 值 re-export）
     * 求闭包；类型导入/导出不产生运行时语义，直接剪掉。
     * 依赖在前（DFS 后序）：模块级 `const` 初值按此顺序执行。 */
    const sfs = (() => {
        const byPath = new Map(program.getSourceFiles().map(f => [path.resolve(f.fileName), f]));
        const state = new Map();   // path → 1 访问中（环）/ 2 完成
        const out = [];
        const runtimeEdge = (st) => {
            if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
                if (!st.importClause) return st.moduleSpecifier.text;              // 副作用导入
                if (st.importClause.isTypeOnly) return null;
                if (st.importClause.name) return st.moduleSpecifier.text;          // 默认绑定
                const nb = st.importClause.namedBindings;
                if (nb && ts.isNamespaceImport(nb)) return st.moduleSpecifier.text;
                if (nb && ts.isNamedImports(nb) && nb.elements.some(el => !el.isTypeOnly)) return st.moduleSpecifier.text;
                return null;
            }
            if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
                if (!st.exportClause) return st.moduleSpecifier.text;              // export * from
                if (ts.isNamespaceExport(st.exportClause)) return st.moduleSpecifier.text;
                if (ts.isNamedExports(st.exportClause) && st.exportClause.elements.some(el => !el.isTypeOnly))
                    return st.moduleSpecifier.text;
            }
            if (ts.isImportEqualsDeclaration(st) && !st.isTypeOnly
                && ts.isExternalModuleReference(st.moduleReference) && ts.isStringLiteral(st.moduleReference.expression))
                return st.moduleReference.expression.text;
            return null;
        };
        const visit = (f) => {
            const key = path.resolve(f.fileName);
            if (state.has(key)) return;             // 已完成或环：环保持相对顺序
            state.set(key, 1);
            for (const st of f.statements) {
                const spec = runtimeEdge(st);
                if (!spec) continue;
                const r = ts.resolveModuleName(spec, f.fileName, compilerOpts, ts.sys).resolvedModule;
                const dep = r && byPath.get(path.resolve(r.resolvedFileName));
                if (dep) visit(dep);
            }
            state.set(key, 2);
            if (!f.isDeclarationFile && f.fileName.endsWith(".ts")) out.push(f);
        };
        const entry = program.getSourceFile(input);
        if (entry) visit(entry);
        return out;
    })();
    // 语法错误的源码必须 loud 拒绝：TS 照常产出（残缺）AST，编译「成功」但语义错值。
    // oracle（V8 跑 tsc 转译产物）则直接抛 —— 静默错值比报错更糟。逐文件查解析诊断。
    for (const f of sfs) {
        const diags = (f.parseDiagnostics || program.getSyntacticDiagnostics(f)).filter(d => d.category === ts.DiagnosticCategory.Error);
        if (diags.length) {
            const d = diags[0];
            const pos = f.getLineAndCharacterOfPosition(d.start || 0);
            throw new Error(`[inline] 源码语法错误: ${path.basename(f.fileName)}:${pos.line + 1}:${pos.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
        }
    }
    const sf = program.getSourceFile(input);   // 入口文件（默认 em.sf；逐函数按源文件覆盖）
    // 收集顶层函数/类，并记录各自源文件（`ts.getSourceFileOfNode` 需要 parent 指针，
    // 而未绑定的 program 里 parent 为空；收集时就近记录，避免额外触发类型绑定）。
    const fns = [];
    const fnSf = new Map();          // 函数节点 → 源文件（逐函数设 em.sf，供行号/DWARF）
    const clsStmts = [];
    const clsExprMap = new Map();     // ClassExpression 节点 → 合成类名
    const clsExprSynthDecls = new WeakSet();   // 类表达式合成的 ClassDeclaration（值仍在创建点克隆，不做提升捕获检查）
    const nestedClsDecls = new WeakSet();      // 非模块顶层的 class 声明：提升后读不到外层局部 → collectClasses 校验
    const aliasClsExprDecls = new WeakSet();   // `const C = class {…}` 初值位置的类表达式：C 只作类名别名（类值不物化）
    const declaredNames = new Set();           // 全部文件内声明过的名字（判定「外层绑定」vs「宿主全局」）
    const noteDeclared = (pat) => {
        if (!pat) return;
        if (ts.isIdentifier(pat)) { declaredNames.add(pat.text); return; }
        if (ts.isObjectBindingPattern(pat) || ts.isArrayBindingPattern(pat))
            for (const el of pat.elements) if (ts.isBindingElement(el)) noteDeclared(el.name);
    };
    const scanDeclaredNames = (root) => {
        const visit = (n) => {
            if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) noteDeclared(n.name);
            else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isEnumDeclaration(n) || ts.isModuleDeclaration(n))
                && n.name && ts.isIdentifier(n.name)) declaredNames.add(n.name.text);
            else if (ts.isCatchClause(n) && n.variableDeclaration) noteDeclared(n.variableDeclaration.name);
            ts.forEachChild(n, visit);
        };
        visit(root);
    };
    const clsExprSeqRef = { n: 0 };
    let clsExprSeq = 0;
    let defaultSeq = 0;   // 匿名默认导出合成名序号（`__default_N`）
    const enumStmts = [];         // TS enum（值语义，非纯类型 → 编译期求值）
    // 递归收集：函数/类声明**任意深度**均提升到模块级（函数内定义的 class/function 亦可编译）。
    // 提升后不再深入其体（避免重复收集其内部声明）。
    // 顶层函数声明 → 模块级 wasm 函数；**嵌套**函数声明 → 闭包（lambda+env，见 _emitFnDeclClosures），
    // 否则其对外层局部的捕获会丢失（此前整树提升 → 编译期「未定义变量」）。
    const hoistedFns = new Set();
    // enum 初值常量折叠（数字/字符串字面量、一元 +/-/~、四则、位运算、括号）
    const enumConstValue = (node, self) => {
        if (!node) return null;
        if (ts.isParenthesizedExpression(node)) return enumConstValue(node.expression, self);
        if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""));
        if (ts.isStringLiteral(node)) return node.text;
        if (ts.isPrefixUnaryExpression(node)) {
            const v = enumConstValue(node.operand, self);
            if (typeof v !== "number") return null;
            switch (node.operator) { case ts.SyntaxKind.MinusToken: return -v; case ts.SyntaxKind.PlusToken: return v; case ts.SyntaxKind.TildeToken: return ~v; default: return null; }
        }
        if (ts.isBinaryExpression(node)) {
            const l = enumConstValue(node.left, self), r2 = enumConstValue(node.right, self);
            if (typeof l !== "number" || typeof r2 !== "number") return null;
            switch (node.operatorToken.kind) {
                case ts.SyntaxKind.PlusToken: return l + r2; case ts.SyntaxKind.MinusToken: return l - r2;
                case ts.SyntaxKind.AsteriskToken: return l * r2; case ts.SyntaxKind.SlashToken: return l / r2;
                case ts.SyntaxKind.PercentToken: return l % r2; case ts.SyntaxKind.LessThanLessThanToken: return l << r2;
                case ts.SyntaxKind.GreaterThanGreaterThanToken: return l >> r2;
                case ts.SyntaxKind.AmpersandToken: return l & r2; case ts.SyntaxKind.BarToken: return l | r2;
                case ts.SyntaxKind.CaretToken: return l ^ r2; default: return null;
            }
        }
        return null;
    };
    const modSymLit = new Map();     // 模块级 const 持有 Symbol.<well-known>（名字 → "@@<sym>"），供类计算属性名解析
    const modConstLit = new Map();   // 模块级字面量 const（名字 → 字符串/数值），供计算属性名折叠
    const modVars = [];          // 模块级变量声明（含初值）
    const modStmts = [];         // 模块级变量语句（合成 __module_init 的函数体）
    const checker = program.getTypeChecker();   // 收集阶段就要解析符号身份（see `export namespace` 展平）
    const nsAlias = new Map();       // 命名空间本地名 → Map(成员名 → 目标顶层名)；收集阶段就要写（see `export namespace`）
    const nsAliasByFile = {};        // 文件名 → (命名空间本地名 → 成员表)：跨文件同名导入隔离
    const collectDecls = (f) => {
        scanDeclaredNames(f);
        // nested：不在模块顶层语句位置（函数/块/循环内）——类被提升后其外层绑定不可见；
        // aliasInit：当前节点是 `const C = class {…}` 的初值（该形式只把 C 当类名别名，类值不物化）。
        const walkCls = (n, bind, nested, aliasInit) => {   // class 仍整树提升（含函数内 class）；bind = 最近绑定名（class 表达式名推断用，勿依赖 n.parent：collectDecls 阶段尚未类型绑定）
            if (ts.isClassDeclaration(n)) {
                clsStmts.push(n);
                if (nested) nestedClsDecls.add(n);
            }
            if (ts.isEnumDeclaration(n)) enumStmts.push(n);
            if (ts.isClassExpression(n) && !clsExprMap.has(n)) {   // 类表达式：合成类名（用于 new / instanceof）
                let synth = n.name ? n.name.text : (bind || null);   // JS 名推断：`const C = class {}` → C.name === "C"
                if (!synth || clsStmts.some(d2 => d2.name && d2.name.text === synth) || fns.some(f2 => f2.name.text === synth)) {
                    synth = "__clsExpr_" + (++clsExprSeq);   // 无绑定名/重名 → 合成名
                }
                clsExprMap.set(n, synth);
                const decl = ts.factory.createClassDeclaration(n.modifiers, ts.factory.createIdentifier(synth), n.typeParameters, n.heritageClauses, n.members);
                decl.pos = n.pos; decl.end = n.end;
                clsExprSynthDecls.add(decl);
                if (aliasInit) aliasClsExprDecls.add(decl);
                clsStmts.push(decl);
            }
            let childBind = bind;
            if ((ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n) || ts.isBindingElement(n))
                && n.name && ts.isIdentifier(n.name)) childBind = n.name.text;
            ts.forEachChild(n, (c) => walkCls(
                c, childBind, !ts.isSourceFile(n),
                ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer === c));
        };
        /* `export namespace X { export const f = …, export function g(){} }`：TS 命名空间是
         * 编译期构造，内联后模块边界消失 → 把**有值**的成员就地改名为 `X$<member>` 并按
         * 普通顶层声明收集，同时登记 nsAlias（`X.member` → `X$member`），
         * `X.member(...)` 与 `X.member` 作值两条路径都走既有 nsAlias 解析。
         * 此前整个 ModuleDeclaration 被 filter 掉 → 「未定义捕获变量: util」（zod v3 全部文件）。 */
        const decls = [];
        for (const st of f.statements) {
            if (!ts.isModuleDeclaration(st) || !st.name || !ts.isIdentifier(st.name) || !st.body
                || !ts.isModuleBlock(st.body)) { decls.push(st); continue; }
            const nsName = st.name.text;
            const members = nsAlias.get(nsName) || new Map();
            for (const mem of st.body.statements) {
                if (ts.isTypeAliasDeclaration(mem) || ts.isInterfaceDeclaration(mem)) continue;   // 纯类型：无值可发射
                const flat = nsName + "$" + (mem.name ? mem.name.text : "__anon");
                if (ts.isFunctionDeclaration(mem) && mem.name && mem.body) {
                    members.set(mem.name.text, flat);
                    mem.name = ts.factory.createIdentifier(flat);
                    decls.push(mem);
                } else if (ts.isVariableStatement(mem)) {
                    for (const d of mem.declarationList.declarations) {
                        if (!ts.isIdentifier(d.name)) continue;
                        members.set(d.name.text, nsName + "$" + d.name.text);
                        d.name = ts.factory.createIdentifier(nsName + "$" + d.name.text);
                    }
                    decls.push(mem);
                }
            }
            /* 成员体内对**同命名空间成员**的裸名引用要跟着改名（`return a + sep + b` 里的 sep）。
             * 靠 checker 符号身份判定：符号的某个声明在 st.body 内 → 换成展平名。
             * 属性访问的 name 位置（`util.sep` 的 sep）不动，那条走 nsAlias 在发射期解析。 */
            for (const mem of st.body.statements) {
                const visit = (n) => {
                    if (ts.isIdentifier(n)) {
                        const p = n.parent;
                        const isPropName = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isQualifiedName(p) && p.right === n));
                        if (!isPropName) {
                            const sym = checker.getSymbolAtLocation(n);
                            if (sym && sym.declarations && sym.declarations.some(d => d.pos >= st.body.pos && d.end <= st.body.end)) {
                                const tgt = members.get(n.text);
                                if (tgt !== undefined) { n.escapedText = tgt; return; }
                            }
                        }
                    }
                    ts.forEachChild(n, visit);
                };
                visit(mem);
            }
            nsAlias.set(nsName, members);
        }
        for (const st of decls) {
            /* 匿名默认导出 `export default function(){}` / `export default class{}`：TS 符号表里
             * valueDeclaration.name 为空 → 无稳定顶层名可折回，此前整条 import 链失败（104/125）。
             * 就地补合成名 `__default_N`（节点身份不变，checker 仍指向它；后续 emit/解析走 st.name.text）。
             * 已有 `__clsExpr_N` 合成名先例，同机制。 */
            if (!st.name && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st))) {
                const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : null;
                if (mods && mods.some(m => m.kind === ts.SyntaxKind.DefaultKeyword))
                    st.name = ts.factory.createIdentifier("__default_" + (++defaultSeq));
            }
            // TS 重载签名（`export function issue(x: string): R;`）只有类型、没有实现体：
            // 不与实现体同名冲突（此前当成独立函数收集 → 「顶层函数名冲突」连带整棵 import 树失败），
            // 也无 body 可发射。实现体是后面那个同名的带 body 声明，正常入列。
            if (ts.isFunctionDeclaration(st) && st.name && st.body) { fns.push(st); fnSf.set(st, f); hoistedFns.add(st); }
            if (ts.isVariableStatement(st)) {                       // 模块级 const/let → wasm 全局（模块初始化时赋值一次）
                for (const d of st.declarationList.declarations) {
                    // 无初值的模块级 `let x: T;` 也要分配全局（zod v4 `let installing: object | undefined;`
                    // 否则读它报「未定义变量」）。全局初值 undefined，语句本身留在 __module_init 里不赋值。
                    if (!ts.isIdentifier(d.name)) continue;
                    modVars.push(d);
                    if (!d.initializer) continue;
                    if (ts.isStringLiteral(d.initializer)) modConstLit.set(d.name.text, d.initializer.text);   // 字面量 const → 计算属性名可折叠
                    else if (ts.isNumericLiteral(d.initializer)) modConstLit.set(d.name.text, Number(d.initializer.text.replace(/_/g, "")));
                    else if (ts.isPropertyAccessExpression(d.initializer)) { const sx0 = symbolNameOf(d.initializer); if (sx0) modSymLit.set(d.name.text, sx0); }   // const s = Symbol.iterator → 类计算属性名可静态解析
                }
                modStmts.push(st);
            } else if (!ts.isFunctionDeclaration(st) && !ts.isClassDeclaration(st) && !ts.isInterfaceDeclaration(st)
                && !ts.isEnumDeclaration(st) && !ts.isEnumMember(st)
                && !ts.isTypeAliasDeclaration(st) && !ts.isModuleDeclaration(st)
                && st.kind !== ts.SyntaxKind.ImportDeclaration && st.kind !== ts.SyntaxKind.ExportDeclaration
                && st.kind !== ts.SyntaxKind.ExportAssignment) {
                modStmts.push(st);   // 模块级其它语句（表达式副作用、if/for/try 等）→ 纳入 __module_init（此前被**静默丢弃**）
            }
            walkCls(st);
        }
    };
    for (const f of sfs) collectDecls(f);
    // 模块级 const 的**静态键序**（对象字面量 + 对已知 const 的展开；未知则整条跳过 = 保持既有行为）
    const modObjKeys = new Map();
    {
        const keysOfNode = (node, depth) => {
            if (!node || depth > 8 || !ts.isObjectLiteralExpression(node)) return null;
            const out = [];
            for (const prop of node.properties) {
                if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
                    if (!ts.isIdentifier(prop.name) && !ts.isStringLiteral(prop.name) && !ts.isNumericLiteral(prop.name)) return null;
                    const nm = prop.name.text;
                    if (out.indexOf(nm) < 0) out.push(nm);
                } else if (ts.isSpreadAssignment(prop)) {
                    const sub = ts.isIdentifier(prop.expression) ? modObjKeys.get(prop.expression.text) : keysOfNode(prop.expression, depth + 1);
                    if (!sub) return null;
                    for (const nm2 of sub) if (out.indexOf(nm2) < 0) out.push(nm2);
                } else return null;   // 方法/访问器/计算键 → 无法静态定序
            }
            return out;
        };
        for (const d of modVars) if (ts.isIdentifier(d.name) && d.initializer) {
            const ks = keysOfNode(d.initializer, 0);
            if (ks) modObjKeys.set(d.name.text, ks);
        }
    }
    if (modStmts.length) {
        // 合成模块初始化函数：体 = 模块级变量语句（按源序），返回值 void；实例化时由 start 段自动执行。
        const initFn = ts.factory.createFunctionDeclaration(undefined, undefined, "__module_init", undefined, [],
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword), ts.factory.createBlock(modStmts, true));
        const anchor = modStmts[0];                 // 合成节点需真实位置（DWARF/行号），借用首条语句范围
        initFn.pos = anchor.pos; initFn.end = anchor.end; initFn.parent = sf;
        initFn.body.pos = anchor.pos; initFn.body.end = anchor.end; initFn.body.parent = initFn;
        fns.push(initFn); fnSf.set(initFn, sf); hoistedFns.add(initFn);
    }
    // 预登记所有属性名（POJO/实例容量统一；否则「运行期新增字段」会越界写、静态读会错位）。
    const preNames = [];
    let usesFreeze = false;
    let usesDynAcc = false;            // 程序内出现 Object.defineProperty → POJO/实例属性读改写走宿主（可能定义了访问器）
    let usesProto = false;             // 程序内出现 __proto__ 字面量键 或 setPrototypeOf → POJO/实例属性读须回落真实原型链
    let usesKeyOrder = false;          // 程序是否观察对象键序（Object.keys/for-in/JSON/spread）→ 需要插入序跟踪                  // 程序内是否出现 freeze/seal/preventExtensions（写保护检查只在需要时发射）
    {
        const seenN = new Set(), push = (t) => { if (t !== undefined && t !== null && !seenN.has(t)) { seenN.add(t); preNames.push(t); } };
        const walkNames = (n) => {
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
                && /^(Object|JSON)$/.test(n.expression.expression.text)
                && /^(keys|values|entries|assign|fromEntries|getOwnPropertyNames|stringify)$/.test(n.expression.name.text)) usesKeyOrder = true;
            if (ts.isForInStatement(n) || ts.isSpreadAssignment(n)) usesKeyOrder = true;
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
                && n.expression.expression.text === "Object" && /^(defineProperty|defineProperties)$/.test(n.expression.name.text)) usesDynAcc = true;
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
                && n.expression.expression.text === "Object" && /^(freeze|seal|preventExtensions)$/.test(n.expression.name.text)) usesFreeze = true;
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
                && /^(Object|Reflect)$/.test(n.expression.expression.text) && n.expression.name.text === "setPrototypeOf") usesProto = true;
            if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === "__proto__") usesProto = true;
            if (ts.isPropertyAccessExpression(n)) push(n.name.text);
            else if (ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) push(n.name.text);
            else if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) push(n.name.text);
            else if (ts.isBindingElement(n)) { if (n.propertyName) push(n.propertyName.text); if (ts.isIdentifier(n.name)) push(n.name.text); }
            else if (ts.isElementAccessExpression(n) && (ts.isStringLiteral(n.argumentExpression) || ts.isNumericLiteral(n.argumentExpression))) push(n.argumentExpression.text);
            ts.forEachChild(n, walkNames);
        };
        for (const f of sfs) walkNames(f);
    }
    /* **没有函数级 interp 通道**的位置里的 async/generator：类方法/字段初值（方法体由 wasm
     * 发射器直接编译，无法像顶层函数那样整体换成 JS 副本；类还会被整树提升，嵌套在函数体内的类
     * 同样发射）与模块级语句（`const fn = async () => …` / `const g = function* (){}` 是
     * __module_init 里的 lambda，而 __module_init 必须留在 wasm 侧初始化全局）。任一命中即
     * 整个模块退 interp：wasm 侧不发射函数/类，挂起语义由 interp 的 JS 副本承载。
     * 顶层函数体内的 async/generator（任意深度）不在此列——containsSuspend 会把该顶层函数
     * 整体退 interp。故必须在 hasClasses 之前算出来。 */
    let hasSuspendOutsideFn = false;
    const isSuspendFnLike = (n) => ts.isFunctionLike(n)
        && ((!!n.modifiers && n.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) || !!n.asteriskToken);
    {
        const scanClass = (n) => {
            if (hasSuspendOutsideFn) return;
            if (isSuspendFnLike(n)) { hasSuspendOutsideFn = true; return; }
            ts.forEachChild(n, scanClass);
        };
        for (const c of clsStmts) scanClass(c);          // 含嵌套/类表达式（均会被提升发射）
        for (const c of clsExprMap.keys()) scanClass(c);
        const walk = (n) => {
            if (hasSuspendOutsideFn) return;
            if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;   // 已由 clsStmts 覆盖
            if (ts.isFunctionDeclaration(n) && hoistedFns.has(n)) return;      // 顶层函数：containsSuspend 负责
            if (isSuspendFnLike(n)) { hasSuspendOutsideFn = true; return; }
            ts.forEachChild(n, walk);
        };
        for (const f of sfs) walk(f);
    }
    const hasClasses = clsStmts.length > 0 && !hasSuspendOutsideFn;
    // TS enum 编译期求值：{ 名字 → {fwd: 成员→值, rev: 值→成员名} }。字符串枚举无反向映射（与 TS 一致）。
    const enums = new Map();
    for (const st of enumStmts) {
        if (!st.name) throw new Error("[tagged] 匿名 enum 不支持");
        const fwd = new Map(), rev = new Map();
        let nextIdx = 0, isStr = false;
        for (const mem of st.members) {
            if (!ts.isIdentifier(mem.name)) throw new Error("[tagged] enum 成员名须为标识符");
            let val = nextIdx;
            if (mem.initializer) {
                const iv = enumConstValue(mem.initializer);
                if (iv === null) throw new Error("[tagged] enum 初值仅支持数字/字符串字面量与简单算术：" + st.name.text + "." + mem.name.text);
                val = iv;
            }
            fwd.set(mem.name.text, val);
            if (typeof val === "string") isStr = true; else { rev.set(String(val), mem.name.text); nextIdx = (typeof val === "number" ? val : 0) + 1; }
        }
        enums.set(st.name.text, { fwd, rev, isStr });
    }
    // import 绑定：{ 本地名 → 目标顶层函数名 }。模块图由 tsc 解析（createProgram），
    // 用 checker 穿透 re-export 链解析到最终目标——AST 级 `sp.propertyName` 只
    // 处理 `import { x as y }` 自身别名，穿不过 `export { x as y } from` 链。
    // 同时检测外部模块 re-export（不可内联 → 显式报错，不静默丢绑定）。
    const sfNames = new Set(sfs.map(f => f.fileName));
    const importAlias = new Map();
    const classAlias = new Map();    // 导入的类本地名 → 目标类名（默认/具名导入类）+ 类表达式绑定
    {
        const walkCE = (n) => {
            if ((ts.isVariableDeclaration(n) || ts.isBindingElement(n) || ts.isPropertyAssignment(n)) && n.initializer && ts.isClassExpression(n.initializer)
                && clsExprMap.has(n.initializer)) {
                const nm = (n.name && ts.isIdentifier(n.name)) ? n.name.text : null;
                if (nm) classAlias.set(nm, clsExprMap.get(n.initializer));
            }
            ts.forEachChild(n, walkCE);
        };
        for (const f of sfs) walkCE(f);
    }
    for (const f of sfs) {
        for (const st of f.statements) {
            if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
                // `export type { X } from './m'` 是纯类型 re-export：目标文件不在运行时闭包里，
                // 不产生绑定，与类型导入同待遇（否则会误报「外部模块 re-export 不支持内联」）。
                if (st.isTypeOnly) continue;
                if (st.exportClause && ts.isNamedExports(st.exportClause)) {
                    for (const el of st.exportClause.elements) {
                        if (el.isTypeOnly) continue;
                        const sym = checker.getSymbolAtLocation(el.name);
                        if (!sym || !(sym.flags & ts.SymbolFlags.Alias))
                            throw new Error(`[inline] 外部模块 re-export 不支持内联: "${el.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                        const tgt = checker.getAliasedSymbol(sym);
                        const decl = tgt.valueDeclaration || (tgt.declarations && tgt.declarations[0]);
                        const declFile = decl && ts.getSourceFileOfNode(decl);
                        if (!declFile || !sfNames.has(declFile.fileName))
                            throw new Error(`[inline] 外部模块 re-export 不支持内联: "${el.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                    }
                } else {
                    /* `export * from './m'`：不产生新绑定（内联后模块边界已消失，目标文件的顶层
                     * 声明本就在同一 wasm 模块里），故无需发射任何代码，只需确认目标在源码集合内。
                     * 消费方 `import { x } from './external'` 经 checker 的 getAliasedSymbol
                     * 自动穿透 star 链解析到真实声明 —— 与具名 re-export 同一路径。 */
                    const modSym = checker.getSymbolAtLocation(st.moduleSpecifier);
                    const modDecl = modSym && modSym.declarations && modSym.declarations[0];
                    const modFile = modDecl && ts.getSourceFileOfNode(modDecl);
                    if (!modFile || !sfNames.has(modFile.fileName))
                        throw new Error(`[inline] export * 来自外部模块，不支持内联: "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                }
                continue;
            }
            if (!ts.isImportDeclaration(st) || !st.importClause) continue;
            const ic = st.importClause;
            // `import type ...` 是纯类型导入，不产生运行时绑定。若仍登记进 importAlias/fnNames，
            // 会让同名局部变量（zod v4 `const checks: checks.$ZodCheck[]` + 参数 `checks`）的闭包
            // 捕获分析误判为「顶层函数名」而漏捕获 → 「未定义捕获变量: checks」。
            if (ic.isTypeOnly) continue;
            // 默认导入：`import d from './m'`。目标须为源码内声明的函数/类；折回目标顶层名，
            // 与具名导入同机制。
            if (ic.name) {
                const sym = checker.getSymbolAtLocation(ic.name);
                const tgt = (sym && (sym.flags & ts.SymbolFlags.Alias)) ? checker.getAliasedSymbol(sym) : null;
                const decl = tgt && (tgt.valueDeclaration || (tgt.declarations && tgt.declarations[0]));
                const declFile = decl && ts.getSourceFileOfNode(decl);
                if (!declFile || !sfNames.has(declFile.fileName))
                    throw new Error(`[inline] 默认导入来自外部模块，不支持内联: "${ic.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                if (!decl.name)   // `export default function(){}` 匿名默认导出：无稳定顶层名
                    throw new Error(`[inline] 匿名默认导出不支持内联（请给函数/类命名）（${path.basename(declFile.fileName)}）`);
                importAlias.set(ic.name.text, decl.name.text);
                if (ts.isClassDeclaration(decl)) classAlias.set(ic.name.text, decl.name.text);
            }
            if (!ic.namedBindings) continue;
            // 命名空间导入：`import * as ns from './m'` → 记录 ns → { 成员名 ↦ 目标顶层名 }。
            // 用 checker 模块导出表（穿透 re-export 链）；外部模块成员不在源码内 → 显式报错。
            if (ts.isNamespaceImport(ic.namedBindings)) {
                const modSym = checker.getSymbolAtLocation(st.moduleSpecifier);
                if (!modSym)
                    throw new Error(`[inline] 命名空间导入来自外部模块，不支持内联: "${ic.namedBindings.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                const members = new Map();
                for (const e of checker.getExportsOfModule(modSym)) {
                    const t = (e.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(e) : e;
                    if (!t || !t.name) continue;
                    const d = t.valueDeclaration || (t.declarations && t.declarations[0]);
                    const df = d && ts.getSourceFileOfNode(d);
                    if (!df || !sfNames.has(df.fileName))
                        throw new Error(`[inline] 命名空间导入含外部模块成员，不支持内联: "${e.name}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                    members.set(e.name, t.name);
                }
                importAlias.set(ic.namedBindings.name.text, ic.namedBindings.name.text);
                nsAlias.set(ic.namedBindings.name.text, members);
                // 同名 namespace 导入在不同文件可指向不同模块（zod：core/api.ts 的 `checks`
                // = core/checks.js，classic/schemas.ts 的 `checks` = classic/checks.js）。
                // 全局表后写覆盖前值 → 成员解析错模块。按文件另存一份，_nsMember 优先查它。
                (nsAliasByFile[f.fileName] = nsAliasByFile[f.fileName] || new Map())
                    .set(ic.namedBindings.name.text, members);
                continue;
            }
            if (!ts.isNamedImports(ic.namedBindings)) continue;
            for (const sp of ic.namedBindings.elements) {
                if (sp.isTypeOnly) continue;   // `import { type X }`：纯类型 specifier，同上
                const sym = checker.getSymbolAtLocation(sp.name);
                if (sym && (sym.flags & ts.SymbolFlags.Alias)) {
                    const tgt = checker.getAliasedSymbol(sym);
                    if (tgt && tgt.name) {
                        const decl = tgt.valueDeclaration || (tgt.declarations && tgt.declarations[0]);
                        const declFile = decl && ts.getSourceFileOfNode(decl);
                        if (declFile && sfNames.has(declFile.fileName)) {
                            importAlias.set(sp.name.text, tgt.name);
                            if (ts.isClassDeclaration(decl)) classAlias.set(sp.name.text, tgt.name);
                            continue;
                        }
                        throw new Error(`[inline] 外部模块导入不支持内联: "${sp.name.text}" from "${st.moduleSpecifier.text}"（${path.basename(f.fileName)}）`);
                    }
                }
                importAlias.set(sp.name.text, sp.propertyName ? sp.propertyName.text : sp.name.text);
            }
        }
    }
    // 内联到同一 wasm 模块 ⇒ 顶层函数名必须全局唯一。
    // 跨文件同名是真实常态（zod v4 core/compile.ts 与 core/schemas.ts 各有一份
    // `getTupleOptStart`，都是模块私有）。私有函数的作用域就是其模块，改名安全；
    // 导出函数的名字是外部契约（import 侧按名解析），不能改，只能报错。
    // 改名走 AST + 符号身份：先按 checker 拿目标符号，再重写该文件内所有指向它的
    // 标识符，这样调用点自动跟着改（只改声明节点会让调用点仍指向旧名）。
    {
        const byName = new Map();          // 原名 → [fnNode...]
        for (const f of fns) {
            const n = f.name.text;
            if (!byName.has(n)) byName.set(n, []);
            byName.get(n).push(f);
        }
        const isExported = (node) => {
            const mods = ts.getModifiers(node);
            return !!(mods && mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword));
        };
        const renameInFile = (sf3, oldName, newName) => {
            const decl = sf3.statements.find(st => ts.isFunctionDeclaration(st) && st.name && st.name.text === oldName);
            if (!decl) return;
            const target = checker.getSymbolAtLocation(decl.name);
            if (!target) return;
            const visit = (n) => {
                if (ts.isIdentifier(n) && n.text === oldName && checker.getSymbolAtLocation(n) === target)
                    n.escapedText = newName;      // .text 反映 escapedText；emitter 全程只读 .text
                ts.forEachChild(n, visit);
            };
            visit(sf3);
        };
        for (const [oldName, group] of byName) {
            if (group.length < 2) continue;
            // 内联后所有文件共享一个 wasm 名字域。同名函数里**入口文件**的那个保留原名
            // （外部契约名）；其余文件的一律按文件前缀重命名——包括导出的（zod 自身就有
            // `util.nullish(any): boolean` 与 `classic/schemas.nullish(T): ZodOptional` 这种
            // 不同语义的同名导出）。重写的是同一文件内指向该声明的全部引用（renameInFile）。
            const isEntry = (f) => (fnSf.get(f) || {}).fileName === input;
            const keeper = group.find(isEntry) || group.find(isExported) || group[0];
            for (const f of group) {
                if (f === keeper) continue;
                const sf3 = fnSf.get(f);
                if (!sf3) continue;
                const stem = path.basename(sf3.fileName).replace(/\.(ts|tsx|js|mts|cts)$/, "").replace(/[^A-Za-z0-9_$]/g, "_");
                renameInFile(sf3, oldName, `__m_${stem}_${oldName}`);
            }
        }
        // 重命名后重建 importAlias：上面登记时读的是 **Symbol.name**（不受 escapedText 改写影响），
        // 仍是旧名 → 导入方会调到同名的另一份。改读声明节点的 name.text（已被 renameInFile 改写）。
        if (fns.length) {
            for (const f of sfs) {
                for (const st of f.statements) {
                    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
                    const nb = st.importClause.namedBindings;
                    const specs = nb && ts.isNamedImports(nb) ? nb.elements : [];
                    for (const sp of specs) {
                        if (sp.isTypeOnly) continue;
                        const sym = checker.getSymbolAtLocation(sp.name);
                        if (!sym || !(sym.flags & ts.SymbolFlags.Alias)) continue;
                        const tgt = checker.getAliasedSymbol(sym);
                        const d = tgt && (tgt.valueDeclaration || (tgt.declarations && tgt.declarations[0]));
                        if (d && d.name && ts.isIdentifier(d.name)) importAlias.set(sp.name.text, d.name.text);
                    }
                    if (st.importClause.name) {          // 默认导入
                        const sym = checker.getSymbolAtLocation(st.importClause.name);
                        if (sym && (sym.flags & ts.SymbolFlags.Alias)) {
                            const tgt = checker.getAliasedSymbol(sym);
                            const d = tgt && (tgt.valueDeclaration || (tgt.declarations && tgt.declarations[0]));
                            if (d && d.name && ts.isIdentifier(d.name)) importAlias.set(st.importClause.name.text, d.name.text);
                        }
                    }
                }
            }
        }
    }
    // ── interp 回退：opts.interp 列出的函数不编 wasm，退到 JS 跑在宿主解释器里。
    // 理由：字符串操作在 wasm 里每轮循环都跨 qz.add 调宿主 → 跨界开销吃掉 AOT 收益。
    // 传递闭包：wasm 函数调 interp 函数 = 该函数也须 interp（wasm 内无该函数索引）。
    const allFnNames = new Set(fns.map(f => f.name.text));
    // async / generator 函数无法在 wasm 里表达暂停/恢复（await/yield 需 CPS 或状态机）→ 自动走
    //   interp：产物是剥类型的原生 JS，`async`/`await`/`function*` 语义由宿主直接提供
    //   （零自研状态机）。此前把 async strip 成同步、await 作 identity（`await p` 拿到 Promise
    //   句柄）；generator 只降级「平坦 yield」为数组（`.next()` 被逐步消费时语义错）。
    // 嵌套 async/generator（函数体内的 `async () => {}` / `function* g(){}`）同样无 wasm 通道，
    //   判据是「函数体内任意深度出现挂起语义」→ 整个顶层函数退 interp，闭包作为原生 JS 闭包存活。
    // 安全性由下方双域守卫保证：一旦它与 wasm 侧共享可变模块级变量，会**整模块退 interp**（单域），
    // 绝不会出现两侧各存一份的静默错值。
    const interpSet = new Set(opts.interp || []);
    const containsSuspend = (root) => {
        let hit = false;
        const walk = (n) => {
            if (hit) return;
            if (ts.isFunctionLike(n)
                && ((n.modifiers && n.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) || n.asteriskToken)) { hit = true; return; }
            ts.forEachChild(n, walk);
        };
        walk(root);
        return hit;
    };
    // `__module_init` 不参与判据：它的体是**所有模块级语句**，形状上必然「含有 async 调用」，
    // 但那些调用只是普通调用，不需要它自己变成 async。若把它推进 interp，wasm 侧模块级变量的
    // 初始化就永不执行（实测 zod：`未定义函数: initializeContext`，因为持有它的模块级 const 从未赋值）。
    for (const f of fns) {
        if (f.name.text === "__module_init") continue;
        const isAsync = !!f.modifiers && f.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
        if (isAsync || f.asteriskToken || (f.body && containsSuspend(f.body))) interpSet.add(f.name.text);
    }
    // 类体/模块级语句里有 async/generator → 整模块退 interp（无函数级 interp 通道，见 hasClasses 判定）。
    // 声明侧已算出 hasSuspendOutsideFn（含被 inline 的所有源文件），这里直接复用。
    if (hasSuspendOutsideFn) for (const f of fns) if (f.name) interpSet.add(f.name.text);
    if (interpSet.size > 0) {
        // 调用图：顶层函数 → 它调用的顶层函数集
        const calls = new Map();
        for (const f of fns) {
            const callees = new Set();
            const walk = (n) => {
                if (ts.isCallExpression(n) && n.expression && ts.isIdentifier(n.expression)) {
                    const resolved = importAlias.get(n.expression.text) || n.expression.text;
                    if (allFnNames.has(resolved)) callees.add(resolved);
                }
                ts.forEachChild(n, walk);
            };
            if (f.body) walk(f.body);
            calls.set(f.name.text, callees);
        }
        /* 类方法体也属 wasm 侧发射单元，且**没有**函数级 interp 通道：方法里调用了一个已退 interp 的
         * 顶层函数，wasm 侧就找不到它（实测 zod：构造器调 initializeContext → 「未定义函数」，
         * 因为该名字所在的 util 函数被 async 的传递闭包整体拉走了）。故类方法体也必须参与判据，
         * 一旦命中 interp 侧，只能整模块退 interp（见下方）。 */
        const classCalls = new Set();
        {
            const grab = (n) => {
                if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
                    || ts.isConstructorDeclaration(n)) {
                    const walk = (x) => {
                        if (ts.isCallExpression(x) && x.expression && ts.isIdentifier(x.expression)) {
                            const resolved = importAlias.get(x.expression.text) || x.expression.text;
                            if (allFnNames.has(resolved)) classCalls.add(resolved);
                        }
                        ts.forEachChild(x, walk);
                    };
                    if (n.body) walk(n.body);
                }
                ts.forEachChild(n, grab);
            };
            for (const f of sfs) grab(f);
        }
        // 传递闭包
        // `__module_init` 例外：它是模块级变量**初始化**的唯一执行点，必须留在 wasm 侧。
        // 若它被拉进 interp（模块级语句调用了 async 函数就会发生），wasm 全局的初值永不赋值
        // → 所有 wasm 函数读模块级变量得到 0/undefined（实测 zod compile.ts：interpSet 含
        // __module_init，wasm 侧不再导出它）。它不被任何 wasm 函数「调用」（由宿主 start 段触发），
        // 拉进来没有意义，只会丢初始化。
        const NON_INTERP = new Set(["__module_init"]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const [fn, callees] of calls) {
                if (interpSet.has(fn) || NON_INTERP.has(fn)) continue;
                for (const callee of callees) {
                    if (interpSet.has(callee)) { interpSet.add(fn); changed = true; break; }
                }
            }
        }
        // 类方法调用了 interp 侧函数 → 无法局部修补（方法不参与 interp 转移）→ 整模块退 interp。
        for (const callee of classCalls) {
            if (interpSet.has(callee)) { for (const f of fns) if (f.name) interpSet.add(f.name.text); break; }
        }
    }
    // 整模块退 interp 后 wasm 侧不承载任何函数 → 也不能发射类（类方法体属 wasm 侧发射单元）。
    // 否则构造器里调用已退 interp 的顶层函数会报「未定义函数」。hasClasses 是 const，用独立标记。
    const emitClassesToWasm = hasClasses && !fns.every(f => interpSet.has(f.name.text));
    // interp 函数的产物是 `new Function(interpJs)` 里的独立 JS 副本，模块级 `let x` 在那里另有一份
    // （stripModuleSyntax 保留变量语句）。wasm 侧同名变量是 wasm 全局。两侧各自读写、互不可见：
    // **同一变量被两侧都触碰 = 静默错值**（实测：wasm 侧把 total 加到 5，interp 侧仍读 0）。
    // 只对**可变**变量处理：`const` 两侧初值相同且不可变 → 副本等价，无害（zod 的 `compile.ts`
    // 等 107 个文件正是这种形态，若一律报错会把已可编译的代码全判死）。
    // 冲突时**不报错**，而是整模块退 interp（单域，无双状态）：把所有顶层函数（含 __module_init）
    // 纳入 interpSet，wasm 侧不再承载任何函数，模块级变量只有 interp 那唯一一份 → 语义自洽。
    // 代价是该模块失去 AOT 加速（它本来也因 async 编不出 wasm），换来正确性。
    const tryWholeModuleInterp = () => {
        for (const f of fns) if (f.name) interpSet.add(f.name.text);
    };
    const mutableModNames = (() => {
        const out = new Set();
        for (const v of modVars) {
            const list = v.parent;                       // VariableDeclarationList（v.parent.parent 是语句）
            const isConst = !!list && !!(list.flags & ts.NodeFlags.Const);
            // `const` 只在**原始值**上无害：`const cache = {}` / `const arr = []` 两侧各有一份对象，
            // 一侧写字段另一侧读不到 → 同样是错值。故只有「const 且初值为原始字面量」才排除。
            const init = v.initializer;
            const prim = !!init && (ts.isStringLiteral(init) || ts.isNumericLiteral(init)
                || init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword
                || init.kind === ts.SyntaxKind.NullKeyword
                || ts.isPrefixUnaryExpression(init) && ts.isNumericLiteral(init.operand));
            if (!isConst || !prim) out.add(v.name.text);
        }
        return out;
    })();
    if (interpSet.size > 0 && mutableModNames.size > 0) {
        const modVarNames = mutableModNames;
        const touched = (root) => {                  // 该语法树里引用到的模块级变量名
            const hit = new Set();
            const walk = (n) => {
                if (ts.isIdentifier(n) && modVarNames.has(n.text)) hit.add(n.text);
                ts.forEachChild(n, walk);
            };
            walk(root);
            return hit;
        };
        const interpSide = new Map();                // 变量名 → 首个触碰它的 interp 函数名
        for (const f of fns) {
            if (!interpSet.has(f.name.text) || !f.body) continue;
            for (const name of touched(f.body)) if (!interpSide.has(name)) interpSide.set(name, f.name.text);
        }
        const clash = [];
        for (const f of fns) {
            if (interpSet.has(f.name.text) || !f.body) continue;
            for (const name of touched(f.body)) if (interpSide.has(name)) clash.push(`${name}（${interpSide.get(name)} interp / ${f.name.text} wasm）`);
        }
        for (const st of modStmts) {                 // __module_init 属 wasm 侧
            for (const name of touched(st)) if (interpSide.has(name)) clash.push(`${name}（${interpSide.get(name)} interp / __module_init wasm）`);
        }
        // 有冲突 → 整模块退 interp。mutating interpSet 后**必须重算**：此时无 wasm 侧函数，
        // 冲突自然消失（模块级变量只剩 interp 一份）。
        if (clash.length) tryWholeModuleInterp();
    }
    // TS→JS（去类型）供 glue 内联 interp 函数。
    // 内联后是**单一作用域**（模块边界已由 inlining 消除），故须剥掉模块语法：
    //  ① 删 import/export 声明；
    //  ② `import { pad as fill }` 的**引用点**重写成目标顶层函数名（fill → pad）——tsc 的模块
    //     transform 本来会把引用改写成 `str2_1.pad`（依赖 require），内联后没有它，必须自己重写；
    //  ③ 剥 export/default 修饰符（否则 emit 出 `exports.X = X`，glue 里没有 exports）。
    // 用 checker（上方已创建）精确定位 import 绑定（而非按名字猜），program.emit 复用同一 AST。
    //
    // 坑：`program.emit` 会**跳过 external library 文件**（`node_modules` 下的源文件被 tsc 当作
    // 外部库，实测 `program.emit(sf)` 对它们返回空串）。而 interp 函数可能来自任意被 inline 的
    // 文件（zod：`initializeContext` 在 to-json-schema.ts）→ 漏掉就得到「未定义函数」。
    //  修法：再建一个 program，把这些文件全部列为 root（root 不受 external 判定影响）。
    //  但**必须复用 prog1 的 SourceFile 对象**：collectDecls 给匿名 `export default function(){}`
    //  就地补过合成名 `__default_N`（写在节点上），重新解析会得到无名的声明 → tsc transform
    //  直接 `Debug Failure`；且 strip 里的 import 改名依赖同一符号表。故用自定义 host 返回旧节点。
    let interpJs = "";
    if (interpSet.size > 0) {
        const sfByFile = new Map(sfs.map(f => [path.resolve(f.fileName), f]));
        const baseHost = ts.createCompilerHost({ strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, moduleResolution: ts.ModuleResolutionKind.NodeJs });
        const host = {
            ...baseHost,
            getSourceFile: (fileName, langVersion) => sfByFile.get(path.resolve(fileName)) || baseHost.getSourceFile(fileName, langVersion),
            fileExists: (f) => sfByFile.has(path.resolve(f)) || baseHost.fileExists(f),
            readFile: (f) => { const s = sfByFile.get(path.resolve(f)); return s ? s.text : baseHost.readFile(f); },
        };
        const prog2 = ts.createProgram(sfs.map(f => f.fileName), {
            strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
        }, host);
        const checker2 = prog2.getTypeChecker();
        /* 清掉「这是模块」的标记再 emit：`module: None` 仍会因 SourceFile 上的
         * impliedNodeFormat / externalModuleIndicator 走 CommonJS transform，产出
         * `exports.X = …` + `require("./x.js")`（实测 zod parse.ts：189 处 exports.*）。
         * 清掉后 emit 出干净 ESM（import 声明留给 strip transform 删）。 */
        for (const f of prog2.getSourceFiles()) {
            f.externalModuleIndicator = undefined;
            f.commonJsModuleIndicator = undefined;
            f.impliedNodeFormat = undefined;
            if (typeof f.transformFlags === "number") f.transformFlags &= ~ts.TransformFlags.ContainsES2015Module;
        }
        /* 内联把多个文件拼进**同一作用域**，各文件私有的同名顶层声明会互相撞车
         * （实测 zod：61 个 locale 各有一份 `const error`，拼起来 `Identifier 'error' has already
         * been declared`）。这些名字在 TS 语义里是文件私有的，不存在跨文件引用 → 按文件加后缀
         * 改名即可。导出名不能改（宿主按原名取 interp 函数），故只处理未导出的重复名。 */
        const symRename = new Map();   // symbol → 新名
        const fileRename = new Map();  // fileName → Map(旧名 → 新名)；兜底按文件查（见 identifier 分支）
        /* prog2 的 getSourceFiles() 仍含类型依赖（见 sfs 的注释）：重名判定与拼接都必须
         * 只看**运行时文件**，否则类型文件里的同名声明会把真正的运行时声明无谓改名，
         * 类型文件自身也会被拼进 interpJs（运行时不该存在）。 */
        const runtimeKeys = new Set(sfs.map(f => path.resolve(f.fileName)));
        {
            const byName = new Map();  // name → [{ sym, sfIdx, exported }]
            prog2.getSourceFiles().forEach((f, sfIdx) => {
                if (f.isDeclarationFile || !f.fileName.endsWith(".ts") || !runtimeKeys.has(path.resolve(f.fileName))) return;
                for (const st of f.statements) {
                    /* TS 7 里 `const error = () => …` 的 kind 是 FirstStatement（非 VariableStatement），
                     * `ts.isVariableStatement` 判不出，故按「有声明名」通用收集。 */
                    const decls = st.declarationList ? st.declarationList.declarations
                        : (st.name || st.body) && !ts.isImportDeclaration(st) ? [st] : [];
                    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : null;
                    const exported = !!(mods && mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword));
                    for (const d of decls) {
                        const nm = d.name && ts.isIdentifier(d.name) ? d.name.text : null;
                        if (!nm) continue;
                        const sym = checker2.getSymbolAtLocation(d.name);
                        if (!sym) continue;
                        if (!byName.has(nm)) byName.set(nm, []);
                        byName.get(nm).push({ sym, sfIdx, exported });
                    }
                }
            });
            for (const [nm, list] of byName) {
                if (list.length < 2) continue;
                /* 只改**未导出**的那些：导出名是宿主取 interp 函数的键，不能动。
                 * 同名的导出 + 私有并存（zod：api.ts 导出 `_emoji`，regexes.ts 私有 `_emoji`）
                 * 时，只给私有那份加后缀，两者仍是不同符号 → 引用点各自解析，语义不变。 */
                for (const { sym, sfIdx, exported } of list) {
                    if (exported) continue;
                    const newName = `${nm}$f${sfIdx}`;
                    symRename.set(sym, newName);
                    const key = prog2.getSourceFiles()[sfIdx].fileName;
                    if (!fileRename.has(key)) fileRename.set(key, new Map());
                    fileRename.get(key).set(nm, newName);
                }
            }
        }
        const stripModuleSyntax = (ctx) => (sf2) => {
            const visit = (n) => {
                if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return undefined;
                // `export default <名>;` → 顶层声明已在；非纯标识符则退成表达式语句（去 export default）。
                if (ts.isExportAssignment(n)) {
                    return ts.isIdentifier(n.expression) ? undefined
                        : ts.factory.createExpressionStatement(ts.visitNode(n.expression, visit));
                }
                if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
                    // 按当前文件查：同名 namespace 导入在不同文件指向不同模块（见 nsAliasByFile）
                    const byFile2 = nsAliasByFile[sf2.fileName];
                    const nsMap = byFile2 ? byFile2.get(n.expression.text) : nsAlias.get(n.expression.text);
                    const resolved = nsMap && nsMap.get(n.name.text);
                    if (resolved !== undefined) return ts.factory.createIdentifier(resolved);
                    return ts.visitEachChild(n, visit, ctx);
                }
                if (ts.isIdentifier(n)) {
                    /* checker2 对**已被访问/替换过**的引用点返回 undefined（声明点正常）。
                     * 节点是 prog1 的原对象 → 回退 prog1 的 checker 拿同一符号。 */
                    const sym = checker2.getSymbolAtLocation(n) || checker.getSymbolAtLocation(n);
                    /* 文件私有重名（见 symRename）：声明与所有引用点同符号 → 一起改名，语义不变。
                     * import 绑定是 alias 符号，先解析到目标再查（`import { validateURL }`）。 */
                    const direct = sym && symRename.get(sym);
                    if (direct !== undefined) return ts.factory.createIdentifier(direct);
                    /* 兜底：tsc 对某些引用点（`return error();` 的调用位）不建符号绑定，
                     * 两个 checker 都返回 undefined。此时按「文件名 + 名字」查改名表——
                     * 内联后的引用只可能指向**本文件**的私有声明（跨文件引用走 import，已被
                     * 上面的 alias 分支处理），故文件级匹配安全。 */
                    if (!sym) {
                        /* 排除**非引用**位置：属性名 `a.error`、字符串键、声明名本身（声明名有
                         * sym，走不到这里）、`{ error: 1 }` 的键。 */
                        const p = n.parent;
                        const isPropName = p && ((ts.isPropertyAccessExpression(p) && p.name === n)
                            || (ts.isPropertyAssignment(p) && p.name === n)
                            || (ts.isMethodDeclaration(p) && p.name === n));
                        if (!isPropName) {
                            const byFileRename = fileRename.get(sf2.fileName);
                            const hit = byFileRename && byFileRename.get(n.text);
                            if (hit !== undefined) return ts.factory.createIdentifier(hit);
                        }
                    }
                    if (sym && (sym.flags & ts.SymbolFlags.Alias) && sym.declarations) {
                        const d0 = sym.declarations[0];
                        if (ts.isImportSpecifier(d0) || ts.isImportClause(d0)) {   // 具名 / 默认导入
                            const target = checker2.getAliasedSymbol(sym);
                            if (!target) return n;
                            const renamed = symRename.get(target);
                            if (renamed !== undefined) return ts.factory.createIdentifier(renamed);
                            // 无条件换新节点：即便同名，也须脱离 tsc 的模块绑定，否则 after 阶段
                            // 的模块 transform 会把它改写成 `(0, mod_1.x)`（内联后无 require）。
                            // 匿名默认导出：target.name 为 "default"，但 collectDecls 已就地补合成名
                            // 到声明节点（`__default_N`），从 valueDeclaration 取真名。
                            const decl = target.valueDeclaration || (target.declarations && target.declarations[0]);
                            const realName = (decl && decl.name && decl.name.text) || target.name;
                            return ts.factory.createIdentifier(realName);
                        }
                    }
                    return n;
                }
                if (ts.canHaveModifiers(n)) {
                    const mods = ts.getModifiers(n);
                    const EXP = ts.SyntaxKind.ExportKeyword, DEF = ts.SyntaxKind.DefaultKeyword;
                    if (mods && mods.some(m => m.kind === EXP || m.kind === DEF))
                        n = ts.factory.replaceModifiers(n, mods.filter(m => m.kind !== EXP && m.kind !== DEF));
                }
                return ts.visitEachChild(n, visit, ctx);
            };
            const out = ts.visitNode(sf2, visit);
            if (out) {   // 清掉「这是模块」的标记 → emit 不再生成 __esModule 包装
                out.externalModuleIndicator = undefined;
                if (typeof out.transformFlags === "number") out.transformFlags &= ~ts.TransformFlags.ContainsES2015Module;
            }
            return out;
        };
        /* 拼接顺序必须满足**依赖在前**：`const` 的初值在拼接后按出现顺序求值，
         * 若 A 的模块级 `const` 引用了 B 的（`parse.ts` 里 `const parse = _parse($ZodRealError)`，
         * `$ZodRealError` 在 `errors.ts`），B 必须先出现，否则 TDZ 报
         * 「Cannot access '$ZodRealError' before initialization」。
         * 按 import 图做 DFS 后序得到拓扑序；有环时退回原序（只能靠函数调用，不在初始化期求值）。 */
        const interpFiles = prog2.getSourceFiles().filter(f => !f.isDeclarationFile && f.fileName.endsWith(".ts")
            && runtimeKeys.has(path.resolve(f.fileName)));
        const byName = new Map(interpFiles.map(f => [path.resolve(f.fileName), f]));
        const order = [];
        const state = new Map();   // path → 1 访问中 / 2 完成
        const visitFile = (f) => {
            const key = path.resolve(f.fileName);
            if (state.get(key) === 2) return;
            if (state.get(key) === 1) return;   // 环：跳过，保持原相对顺序
            state.set(key, 1);
            for (const st of f.statements) {
                if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
                const spec = st.moduleSpecifier.text;
                if (!spec.startsWith(".")) continue;
                const resolved = path.resolve(path.dirname(f.fileName), spec.replace(/\.js$/, ".ts"));
                const dep = byName.get(resolved);
                if (dep) visitFile(dep);
            }
            state.set(key, 2);
            order.push(f);
        };
        for (const f of interpFiles) visitFile(f);
        /* 只 emit **运行时文件**（prog2 的 roots 全部是 root，不会被 external 判定跳过）：
         * 整 program emit 会把类型依赖也转成 JS 拼进来，等于撤销上面的剪枝。
         * strip transform 用 checker2（prog2 的符号表）解析 import 绑定 → 引用点改名正确。 */
        const emitted = new Map();
        for (const sf2 of order) {
            prog2.emit(sf2, (fname, text) => { emitted.set(fname, text); }, undefined, false, { before: [stripModuleSyntax] });
            const text = emitted.get(sf2.fileName.replace(/\.ts$/, ".js"));
            if (text) interpJs += text + "\n";
        }
    }
    // interp 函数不占 wasm，故不参与「是否需要 tagged 运行时」的判定。
    const hasNumArr = fns.some(f => !interpSet.has(f.name.text) && funcMode(f) === "num" && numArrNames(f).size > 0);
    const anyTagged = fns.some(f => !interpSet.has(f.name.text) && funcMode(f) === "tagged") || emitClassesToWasm || hasNumArr;
    // 顶层函数名 → {mode, void}：跨模式调用点据此插入 f64↔i64 按位重解释。
    // interp 函数不进 wasm（其调用者经传递闭包一并退），故不在表内 —— 表内即 wasm 内可直调者。
    const fnMode = new Map();
    for (const st of fns) {
        if (interpSet.has(st.name.text)) continue;
        fnMode.set(st.name.text, {
            mode: funcMode(st),
            void: !!st.type && st.type.kind === ts.SyntaxKind.VoidKeyword,
        });
    }


    /* 单趟发射：对给定 module 走完「注册 → 声明 → 发射 body → 导出」。
     * 调两趟：① collect 模式**采出实际用到**的 qz.* 契约面（产物丢弃）；
     *         ② 按该子集注册后真发。
     * 为什么必须两趟：import 索引要在 declareFunc 之前定妥（funcidx = codeIdx +
     * imports.length），无法边发射边补登记。见 brain [[aot-generic-compiler-target]]：
     * import 面 = 需求驱动的最小契约面，不是 qzjs 私有 ABI 全集。 */
    const emitAll = (m, contract, passOpts) => {
        const _opts = passOpts || {};
        const em = new Emitter(m);
        em.sf = sf;
        em.hoistedFns = hoistedFns;   // 顶层函数声明（其余函数声明按闭包处理）
        em.fieldMap = new Map([["__cls", 0], ...preNames.map((n, i) => [n, i + 1])]);   // 预登记字段表（与产物一起冻结）
        em.importAlias = importAlias;    // 跨文件 import 别名 → 目标顶层函数名
        em.nsAlias = nsAlias;            // 命名空间导入解析表
        em.classAlias = classAlias;      // 导入类本地名 → 目标类名
        em.fnMode = fnMode;              // 顶层函数名 → {mode, void}（跨模式调用 ABI 转换用）
        em.usesFreeze = usesFreeze;
        em.clsExprMap = clsExprMap;      // 类表达式节点 → 合成类名（声明处跳过初值求值）
        em.clsExprSynthDecls = clsExprSynthDecls;
        em.nestedClsDecls = nestedClsDecls;       // 函数/块内 class 声明（提升后外层绑定不可见）
        em.aliasClsExprDecls = aliasClsExprDecls; // `const C = class {…}` 初值位置（类值不物化）
        em.declaredNames = declaredNames;         // 全程序声明名（外层绑定 vs 宿主全局）
        em.usesKeyOrder = usesKeyOrder;
        em.usesDynAcc = usesDynAcc;
        em.usesProto = usesProto;
        em.enums = enums;                // TS enum：编译期求值表（名字 → {fwd, rev}）
        em.modConstLit = modConstLit;    // 模块级字面量 const（计算属性名折叠用）
        em._modSymLit = modSymLit;       // 模块级 Symbol.<well-known> 常量
        em.nsAliasByFile = nsAliasByFile;   // 跨文件同名 namespace 导入隔离表（_nsMember 按 em.sf 查）
        em.checker = checker;            // 符号身份（TDZ 判据：同名遮蔽必须按符号区分，不能按文本）
        em.protNameId = (n) => em._strId(n);

        em._fnHasThis = new Map();       // 顶层函数名 → 是否带 TS this 形参（receiver 由宿主前置）
        em._fnArgs = new Set();   // 顶层函数名 → 函数体引用 arguments（需全量实参数组）
        em._fnParams = new Map();        // 顶层函数名 → 形参数量（调用点按 JS 元数语义补 undefined/截断）
        em._fnNodes = new Map();         // 顶层函数名 → 声明节点（rest 形参打包用）
        for (const st of fns) em._fnNodes.set(st.name.text, st);
        for (const st of fns) { if (st.body && usesArguments(st.body)) em._fnArgs.add(st.name.text); em.fnNames.add(st.name.text); em._fnHasThis.set(st.name.text, st.parameters.some(p2 => ts.isIdentifier(p2.name) && p2.name.text === "this")); em._fnParams.set(st.name.text, st.parameters.length); }
        // 导入名也是「顶层函数」（排除闭包捕获误判）。命名空间导入名除外——它只是
        // `ns.member` 的前缀（由 nsAlias 改写成目标名），不持有函数值；若登记会让同名
        // 局部变量（zod `const checks` 与 `import * as checks`）漏捕获。
        for (const local of importAlias.keys()) if (!nsAlias.has(local)) em.fnNames.add(local);
        em.moduleGlobals = em.moduleGlobals || new Map();
        em._modObjKeys = modObjKeys;    // 模块级 const 的静态键序（对象字面量 + 已知 const 展开）
        em._inModInit = false;
        if (!m.collect) {
            if (contract) registerQz(m, contract);
        }
        if (anyTagged) {
            em._inModuleLink = !!opts.inModuleLink;
            em._scratch = (opts.inModuleLink ? INMOD_HOST_LIMIT : SCRATCH);
            /* in-module 合并形态：emitter 产物与 libqzvm 共享同一 linear memory。
             * libqzvm 的 wasi-libc 堆从 __heap_base 起向上增长（实测 5 万对象后堆顶
             * 7.19MiB）；若 emitter 仍用 [128,16MiB) 作 bump arena 会与之重叠。
             * → in-module 下整体后移：libqzvm 段 [0, INMOD_HOST_LIMIT) 预留，
             *   bump arena [INMOD_HOST_LIMIT, INMOD_STR_BASE)，字面量段起于 INMOD_STR_BASE。
             * 独立模式保留原布局：bump [128,16MiB) + 字面量 [16MiB,40MiB)。*/
            const layout = opts.inModuleLink ? null : memLayout(opts);
            // 独立档新布局：字面量段从 STR_BASE(128) 起向上，arena 接在其后。
            // arenaBase 由第一趟发射的 _litCursor 得出（emitAll 的 opts.arenaBase 传入）；缺省 = STR_BASE。
            em._strBase = opts.inModuleLink ? INMOD_STR_BASE : STR_BASE;
            em._strBump = opts.inModuleLink ? (INMOD_STR_BUMP + 64)
                : (_opts.arenaBase !== undefined ? _opts.arenaBase : STR_BASE);
            if (opts.inModuleLink) {
                m.importMemory("qz", "memory", INMOD_PAGES, INMOD_PAGES);
                m.exportMemory(0);   // re-export 链接到的 memory（导入 memory 索引恒 0），供宿主驱动读结果
                m.addTableImport(INMOD_TABLE_CAP, "__indirect_function_table", "qz");
            } else {
                m.addMemory(layout.pages, layout.maxPages);   // 初 40MiB，上限 640MiB（qzs_ckmem 按需 grow）
            }
            m.addGlobal("i32", em._strBump);                 // global0 = bump 堆（字符串/对象）
            m.addGlobal("i64", 0);                           // global1 = __err（异常值；0 = 无错）
            // global2 = arena 上界（字节）。初值 = 内存总字节；扩容时 qzs_ckmem 抬高它。
            // in-module 档内存由 C 侧管、不可 grow，故给常量上界（等价原行为）。
            em._arenaCeilGlobal = m.addGlobal("i32", opts.inModuleLink ? INMOD_STR_BASE : (layout.pages << 16));
            /* 空闲链链头：0 = 空链。链节点复用块头 [hdr+0] 存 next（释放时 rc 已无意义）。
             * qzs_rc_dec（rc 归零）与宿主 GC 清扫都往这里挂，emitBumpAlloc 优先从此取。 */
            em._freeListGlobal = m.addGlobal("i32", 0);
            // emitBumpAlloc 的工作状态：该函数在任意表达式求值中间被调，不能安全新增 wasm 局部变量。
            em._freeCurGlobal = m.addGlobal("i32", 0);       // 遍历游标
            em._freeHitGlobal = m.addGlobal("i32", 0);       // 0=未命中；否则=数据区偏移
            m.freeGlobals = { list: em._freeListGlobal, cur: em._freeCurGlobal, hit: em._freeHitGlobal };
            em.moduleGlobals = new Map();                    // 模块级变量名 → wasm 全局索引（i64 tagged，索引 2 起）
            em._modInitNames = new Set(modVars.map(v => v.name.text));
            for (const v of modVars) em.moduleGlobals.set(v.name.text, m.addGlobal("i64", v.initializer ? 0 : 0x7ff9000000000000n));   // 无初值 → undefined（否则读作数值 0）
            em._argGlobal = m.addGlobal("i64", 0);      // __args：调用点写入「全量实参数组」（arguments 支持）
            m.declareFunc("qzs_setargs", ["i64"], []);  // 宿主侧写入（闭包调用经 closureCall）
            m.exportFn("qzs_setargs", "qzs_setargs");
            m.startBody("qzs_setargs", []);
            m.localGet(0); m.globalSet(em._argGlobal);
            m.endBody();
            m.declareFunc("qzs_getargs", [], ["i64"]);   // 诊断导出（只读）
            m.exportFn("qzs_getargs", "qzs_getargs");
            m.startBody("qzs_getargs", []);
            m.globalGet(em._argGlobal);
            m.endBody();
            emitMemHelpers(m, em._strBase || STR_BASE,
                opts.inModuleLink ? undefined : em._arenaCeilGlobal,   // in-module：不可 grow，走常量上界
                opts.inModuleLink ? 0 : layout.maxPages);
            emitStringHelpers(m);
            emitNumArrHelpers(m);
        }
        for (const st of fns) {
            if (interpSet.has(st.name.text)) continue;   // interp 函数不进 wasm
            const isVoid = !!st.type && st.type.kind === ts.SyntaxKind.VoidKeyword;
            const isNum = funcMode(st) === "num";
            const vt = isNum ? "f64" : "i64";   // num=f64；tagged=i64（NaN-box）
            m.declareFunc(st.name.text, st.parameters.map(() => vt), isVoid ? [] : [vt]);
        }
        // 阶段1.5：收集类（登记方法/构造器签名）——须在发射体前
        if (emitClassesToWasm) em.collectClasses(clsStmts);
        // 阶段1.5b：扫描 lambda（顶层函数体 + 类方法/构造器体 + 字段初值），登记 __lam_N 签名
        let lamSeq = 0;
        for (const st of fns) {
            if (interpSet.has(st.name.text)) continue;
            for (const lam of em._collectLambdas(st.body)) em.emitLambda(lam, lamSeq++);
        }
        for (const cname of em._classList) {
            const c = em.classes.get(cname);
            if (c.ctor) for (const lam of em._collectLambdas(c.ctor.body)) em.emitLambda(lam, lamSeq++);
            for (const mth of c.methods) for (const lam of em._collectLambdas(mth.node.body)) em.emitLambda(lam, lamSeq++);
            // 字段初值内的闭包（如 `getV = () => this.v`）**不**在此预登记：它们需要在构造器上下文里登记，
            // 才能把 `this`（ctor 的 local 0）纳入捕获集；否则 this 在闭包内为 undefined（运行时错）。
        }
        // 阶段2：逐个发射 body（顶层函数 + lambda + 类方法/构造器）
        for (const st of fns) { if (interpSet.has(st.name.text)) continue; em.sf = fnSf.get(st) || sf; em.emitFunc(st); }
        em.emitLambdaBodies();
        if (emitClassesToWasm) em.emitClassBodies();
        em.emitLambdaBodies();   // 类体发射期间惰性登记的闭包（对象字面量访问器/方法）
        for (const cname of em._classList) {
            const c = em.classes.get(cname);
            for (const mth of c.methods) { const en = methName(cname, mth.accessor === "set" ? mth.name + "$set" : mth.name); m.exportFn(en, en); }
            for (const sm of c.staticMethods) { const en = staticMethName(cname, sm.name + (sm.accessor === "set" ? "$set" : "")); m.exportFn(en, en); }
            m.exportFn(ctorName(cname), ctorName(cname));
        }
        if (m.memory !== null) m.exportMemory();
        if (anyTagged) {
            m.exportGlobal("__bump", m.globalIdx());

            /* 模块级变量作 GC 静态根。**不能**用 exportGlobal 暴露 i64 全局：
             * qzjs 的 WebAssembly 绑定把 i64 全局降级为 Number，超过 2^53 的位型被抹平
             * （实测：句柄 0x7FF9000000000400 读回成 0x7FF9000000000000 → 高 16 位丢失）。
             * 改为导出 __dump_roots(dest)：把每个根的 i64 原值写进线性内存，宿主按 i64 读。 */
            /* dest 由宿主传入（通常 = 当前 bump）：写在那里、宿主立即读，
             * 不占固定布局区也能容纳任意多个模块级变量。 */
            m.declareFunc("__dump_roots", ["i32"], ["i32"]);   // param0=dest, local1=i
            m.startBody("__dump_roots", ["i32"], ["i32"]);
            m.i32Const(0); m.localSet(1);
            for (const [, gidx] of em.moduleGlobals) {
                m.localGet(0); m.localGet(1); m.i32Const(8); m.i32Mul(); m.i32Add();
                m.globalGet(gidx); m.i64Store(3, 0);
                m.localGet(1); m.i32Const(1); m.i32Add(); m.localSet(1);
            }
            m.localGet(1);                                     // 返回根个数
            m.endBody();
            m.exportFn("__dump_roots", "__dump_roots");
            m.exportGlobal("__freelist", em._freeListGlobal);   // GC 清扫时需要写入空闲链头
            m.exportGlobal("__err", 1);                       // 跨函数 throw 出口：glue 调用后检查，非 0 则向宿主抛出
            m.declareFunc("__set_err", ["i64"], []);          // 宿主侧抛出（如 reduce 空数组）：设 __err，调用点检查后转异常
            m.startBody("__set_err", []);
            m.localGet(0); m.globalSet(1);
            m.endBody();
            m.exportFn("__set_err", "__set_err");
            /* __bump_reset()：**空操作**（保留导出名以兼容既有 glue，行为改为无害）。
             * 历史实现把 bump 无条件重置到模块初始化水位 perm，其前提「模块级对象都分配在
             * perm 以下」**不成立**——`cache.slot = {...}` 恰分配在 perm 之上，下次调用即覆盖它，
             * 读回错值（实测：setSlot(7) 后 allocThenRead() 得 undefined，V8 得 7）。
             * 无静态证明的跨调用复位 = use-after-free，故禁用。
             * 回收职责移交引用计数（qzs_rc_dec：rc 归零立即挂空闲链，可被复用）；
             * 循环回滚 _arenaLoopEnter 与函数回滚 _fnArenaFree 保留——那两处有局部证明。 */
            em._permBumpGlobal = m.addGlobal("i32", em._strBump || STR_BUMP);
            m.exportGlobal("__perm_bump", em._permBumpGlobal);
            m.declareFunc("__bump_reset", [], []);
            m.startBody("__bump_reset", [], []);
            m.endBody();
            m.exportFn("__bump_reset", "__bump_reset");
            // __bump_seal()：模块初始化完时调用，把当前 bump 记为永久基址。
            m.declareFunc("__bump_seal", [], []);
            m.startBody("__bump_seal", [], []);
            m.globalGet(0); m.globalSet(em._permBumpGlobal);
            m.endBody();
            m.exportFn("__bump_seal", "__bump_seal");
        }
        em.emitLambdaBodies();                                // __module_init 体内惰性登记的闭包
        for (const meta of em._lamById.values()) m.exportFn(meta.fname, meta.fname);
        // 模块初始化**不再**放入 start 段：start 段执行时宿主 mem/导出/类元尚未绑定，
        // 任何模块级闭包调用（如 `const y = f(2)`）都会因 closure_call 读闭包头而崩。
        // 保持 __module_init 为普通导出，由宿主在各 bind 完成后调用（qzvm.js: tryRunModuleInit）。
        return em;
    };

    // 第一趟：采集实际用到的 qz.* 符号。总跑（非仅 tagged）——num 模式也可能
    // 调 qz.math_pow（** 运算）；不跑则 contract=null → registerQz 不执行 → import 未注册。
    // 同时它给出字面量段末尾（_litCursor）→ 第二趟据此定 arena 基址。
    const mc = new Module({ collectImports: true });
    const em1 = emitAll(mc, null);
    let contract = mc.collected;
    // 字面量段 [STR_BASE, litEnd) 是编译期常量；arena 接在其后（对齐到 8）。
    const litEnd = Math.max((em1._litCursor || STR_BASE) | 0, STR_BASE);
    const arenaBase = opts.inModuleLink ? undefined : ((litEnd + 7) & ~7);
    // 第二趟：按采集到的子集注册契约面，真发产物。
    const m = new Module({ debug: !!opts.debug, debugLine: !!opts.debug || !!opts.debugLine, srcFile: input });
    const em = emitAll(m, contract, { arenaBase });
    em._trampSlots = em._trampSlots || new Map();
    /* 类方法蹦床：与闭包蹦床同模式（统一 5 参 (i64 self, i64×4)），供 C 侧类原语
     * 按 clsId+方法名 查表分派。每条 classMeta 项记录方法名→槽。 */
    em._clsTrampSlots = new Map();   // 导出名 → 表槽
    /* 类方法蹦床只为 in-module 档生成：需要共享 funcref 表（表由 libqzvm 导入）。
     * 独立档（test_aot 的 JS 宿主）没有表，生成蹦床会 elem 越界。 */
    const clsMetaBuild = em._classList.map(cname => {
        const c = em.classes.get(cname);
        const mthToSlot = (mthName) => {
            /* 蹦床 + 表槽仅 in-module 档：独立档由 JS 宿主按 classMeta.methods.name 直调导出。*/
            if (!em._inModuleLink) return undefined;
            if (!em._clsTrampSlots.has(mthName)) {
                const tn = mthName + "$t";
                m.declareFunc(tn, ["i64", "i64", "i64", "i64", "i64"], ["i64"]);
                m.startBody(tn, []);
                /* 蹦床统一 5 参 (self, a0..a3)；类方法签名也是 5 参 (self, a0..a3) →
                 * 直接转发 5 个 locals，多余/不足由 wasm 严格校验。
                 * 但部分方法签名含第 6 槽（>4 形参）→ 这种蹦床用 6 参版。 */
                const isLong = mthName.includes("$set") ? false : false;  // 简化：当前都 5 参
                for (let k = 0; k < 5; k++) m.localGet(k);
                m.call(mthName);
                /* void 方法（ctor/$set）→ 补 undefined 句柄作返回值 */
                if (mthName.includes("$ctor") || mthName.includes("$set")) em._emitUndefined();
                m.return_();
                m.endBody();
                const base = em._inModuleLink ? INMOD_TABLE_CAP : 1;
                const slot = base + ((em._trampSlots && em._trampSlots.size) || 0) + em._clsTrampSlots.size;
                em._clsTrampSlots.set(mthName, slot);
                m.addElem(slot, m._funcIdx[tn]);
            }
            return em._clsTrampSlots.get(mthName);
        };
        const methods = {}, getters = {}, setters = {}, staticMethods = {};
        for (const mth of c.methods) {
            const en = methName(cname, mth.accessor === "set" ? mth.name + "$set" : mth.name);
            const slot = mthToSlot(en);
            const nameStrId = em._strId(mth.name);
            if (mth.accessor === "set") setters[mth.name] = { slot, nameStrId, name: en, n: mth.node.parameters.length };
            else if (mth.accessor === "get") getters[mth.name] = { slot, nameStrId, name: en, n: 0 };
            else methods[mth.name] = { slot, nameStrId, name: en, n: mth.node.parameters.length,
                                       rest: !!(mth.node.parameters.length && mth.node.parameters[mth.node.parameters.length - 1].dotDotDotToken) };
        }
        for (const smth of (c.staticMethods || [])) {
            if (smth.accessor) continue;
            const en = staticMethName(cname, smth.name);
            const slot = mthToSlot(en);
            const nameStrId = em._strId(smth.name);
            staticMethods[smth.name] = { slot, nameStrId, name: en, n: smth.node.parameters.length };
        }
        const p = c.parent ? em.classes.get(c.parent) : null;
        const ctorSlot = em._inModuleLink ? mthToSlot(ctorName(cname)) : undefined;
        return { id: c.id, name: cname, parent: p ? p.id : null, builtinParent: (c.parent && !p) ? c.parent : null,
                 methods, getters, setters, staticMethods, ctorSlot,
                 ctor: ctorName(cname), size: ((em.fieldMap ? em.fieldMap.size : 0) + 1) * 8 };
    });
    em._clsMetaBuild = clsMetaBuild;
    /* 类方法蹦床进表后，再补一次启动函数（与闭包共用同一表，槽区间共享）。 */
    const totalTramp = ((em._trampSlots && em._trampSlots.size) || 0) + (em._clsTrampSlots ? em._clsTrampSlots.size : 0);
    if (em._trampSlots && em._trampSlots.size) {
        for (const [tn, slot] of em._trampSlots) {
            const fi = m._funcIdx[tn];
            if (fi !== undefined) m.addElem(slot, fi);
        }
    }
    if (totalTramp > 0) {
        m.emitTableInit(totalTramp, INMOD_TABLE_CAP);
    }
    fs.writeFileSync(outWasm, m.build());
    // funcMeta: 每导出函数 {name, mode(num/tagged), params}
    const funcMeta = fns.map(f => ({
        name: f.name.text,
        mode: interpSet.has(f.name.text) ? "interp" : funcMode(f),   // interp = 不编 wasm，glue 走宿主 JS
        params: f.parameters.length,
        async: !!(f.modifiers && f.modifiers.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)),
    }));
    const lamMeta = {};
    for (const [lamNode, meta] of em._lamById.entries()) {
        let src = null;
        try { const sf0 = lamNode.getSourceFile && lamNode.getSourceFile(); if (sf0) src = stripTsTypes(lamNode, sf0); } catch (_) {}
        lamMeta[m._funcIdx[meta.fname]] = { name: meta.fname, n: meta.n, rest: !!meta.rest, synthThis: !!meta.synthThis, src, needsArgs: !!(lamNode && lamNode._qzNeedsArgs) };
    }
    const classMeta = em._clsMetaBuild || [];
    return { module: m, strings: em.strings || [], fields: em.fieldMap ? [...em.fieldMap.keys()] : [], funcMeta, lamMeta, classMeta, interpJs, trampSlots: em._trampSlots || new Map(),
             arenaEnd: opts.inModuleLink ? null : memLayout(opts).arenaEnd };
}


module.exports = { compileTS };
