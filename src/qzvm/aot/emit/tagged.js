/* tagged.js — tagged 模式发射：动态值（对象/字符串/unknown）语句与表达式
 * emitter.js 拆分件；模块图见 ../emitter.js 顶部注释。 */
"use strict";
const ts = require("typescript");
const { BUILTIN_GLOBALS, EMITTER_BUILTIN_CTORS, ctorName, methName, staticMethName } = require("./consts.js");
const { RC_HDR, K_PLAIN, K_POJO, K_ARR, SCRATCH, STR_BASE, emitBumpAlloc, emitBumpSet, f64Bits } = require("./layout.js");
const { Emitter } = require("./emitter.js");
require("./tagged-core.js");   // 副作用：挂 _foldPropName/_fnArenaFree 等 tagged 公共方法

Emitter.prototype.emitTaggedBlock = function (node) { for (const st of node.statements) this.emitTaggedStmt(st); };
Emitter.prototype.emitTaggedStmt = function (s) {
    this.m.markLine(this._line(s));
    if (ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s)) return;   // 已提升为模块级（见 collectDecls）
    if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) this._emitBindingDecl(d);
        return;
    }
    if (ts.isReturnStatement(s)) {   // 无值 return; → undefined（tagged 函数返回 i64，不能裸 return）
        if (this._finallyStack && this._finallyStack.length) {
            const t = this._expEnter();
            if (s.expression) this.emitTaggedExpr(s.expression); else this._emitUndefined();
            this.m.localSet(t.v);                    // 先求返回值（JS：先算表达式，再跑 finally）
            this._emitPendingFinally(true, false);
            this.m.localGet(t.v);
            this._expLeave();
        } else {
            if (s.expression) this.emitTaggedExpr(s.expression); else this._emitUndefined();
        }
        // 函数级 arena 回滚：返回值已算好（标量，不指向 arena），把 bump 复位到函数入口。
        // 必须在返回值求值之后——求值本身可能还要分配。
        if (this._fnArenaFreeThis) { this.m.localGet(this._fnArenaSlot); this.m.globalSet(0); }
        this.m.return_(); return; }
    if (ts.isBreakStatement(s)) { this._jumpOut(s.label && s.label.text, true); return; }
    if (ts.isContinueStatement(s)) { this._jumpOut(s.label && s.label.text, false); return; }
    if (ts.isDoStatement(s)) { this.emitDoWhile(s, true); return; }
    if (ts.isSwitchStatement(s)) { this.emitSwitch(s, true); return; }
    if (ts.isThrowStatement(s)) {
        if (this.mode !== "tagged") throw new Error("[num] throw 不支持（仅 tagged）");
        this.emitTaggedExpr(s.expression); this.m.globalSet(1);   // __err = 值
        if (!this._tryStack.length) {
            // 跨函数传播：本函数无 try → 跑完待执行 finally（异常离开函数）后 return undefined；
            // 调用方（try 内的调用点）检查 __err 并跳到其 catch。
            this._emitPendingFinally(true, false);
            if (!this._fnVoid) this._emitUndefined();
            this.m.return_();
            return;
        }
        this._emitPendingFinally(true, true);                     // 同函数内：穿出的 finally
        this.m.br(this.depth - this._tryStack[this._tryStack.length - 1].errBrk);
        return;
    }
    if (ts.isTryStatement(s)) { this.emitTry(s, true); return; }
    if (ts.isIfStatement(s)) {
        this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        this.m.ifBlock(); this.depth++;          // 条件已归约为裸 i32 布尔
        this.emitTaggedStmt(s.thenStatement);
        if (s.elseStatement) { this.m.else_(); this.emitTaggedStmt(s.elseStatement); }
        this.depth--; this.m.end(); return;
    }
    if (ts.isWhileStatement(s)) {
        // while 的 continue 直接跳回条件（无独立 cont 块），会跳过下面的复位 → 该轮不回收，
        // 只是少优化、不影响正确性。
        const saveSlot = this._arenaLoopEnter(s.statement || s);
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        this.labels.push({ brk: this.depth - 1, cont: this.depth, label: this._curLabel() });
        this.emitCondI32(s.expression !== undefined ? s.expression : s.condition);
        this.m.i32Eqz(); this.m.brIf(1);
        { const cap = this._loopCaptured([], s.statement || s);                                 // let/const 每迭代绑定
          if (cap) this._emitPerIterEnv(cap.headerNames, cap.bodyNames); }
        this.emitTaggedStmt(s.statement);
        this._arenaLoopLeave(saveSlot);
        this.m.br(0);
        this.labels.pop(); this.depth--; this.m.end(); this.depth--; this.m.end(); return;
    }
    if (ts.isForStatement(s)) {
        if (s.initializer) {
            if (ts.isVariableDeclarationList(s.initializer)) {
                for (const d of s.initializer.declarations) if (d.initializer) { this.emitTaggedExpr(d.initializer); this._emitVarStore(d.name.text, this.scratchB); this.m.drop(); }
            } else { this.emitTaggedExpr(s.initializer); this.m.drop(); }
        }
        // 循环级 arena 回滚：循环体分配的对象若不逃逸出当前迭代，每轮末尾把 bump 复位到入口，
        // 分配量从 O(迭代数) 降为 O(1)——否则 40 万次分配即耗尽 16 MiB arena 崩溃。
        // 恢复点放在 cont 块之后（continue 也经过），incrementor 之前（它只操作循环头标量）。
        const saveSlot = this._arenaLoopEnter(s.statement || s);
        // block(brk) loop block(cont) body end; incr; br 0 end end（continue 跳 incr 前）
        this.m.block(); this.depth++; this.m.loop(); this.depth++;
        if (s.condition) { this.emitCondI32(s.condition); this.m.i32Eqz(); this.m.brIf(1); }
        this.m.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        if (s.statement) this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; this.m.end();                       // end cont block
        this._arenaLoopLeave(saveSlot);
        { const neg = this._loopCaptured(this._headerNames(s), s.statement || s);               // for(let i…) 闭包捕获 → 增量前换新绑定
          if (neg) this._emitPerIterEnv(neg.headerNames, neg.bodyNames); }
        if (s.incrementor) { this.emitTaggedExpr(s.incrementor); this.m.drop(); }
        this.m.br(0);
        this.depth--; this.m.end();                       // end loop
        this.depth--; this.m.end(); return;               // end brk block
    }
    if (ts.isForInStatement(s)) {
        // for (k in o) → for (k of Object.keys(o))（复用 for-of 机制；键为字符串）
        const withPos = (n, p) => { n.pos = p.pos; n.end = p.end; return n; };
        const obj = withPos(ts.factory.createIdentifier("Object"), s.expression);
        const keysProp = withPos(ts.factory.createPropertyAccessExpression(obj, "keysIn"), s.expression);   // keysIn：自有+继承可枚举键（JS for-in 语义）
        const keysCall = withPos(ts.factory.createCallExpression(keysProp, undefined, [s.expression]), s.expression);
        const forOf = withPos(ts.factory.createForOfStatement(undefined, s.initializer, keysCall, s.statement), s);
        this.emitTaggedStmt(forOf);
        return;
    }
    if (ts.isForOfStatement(s)) {
        // for (let x of arr) body：惰性迭代（JS 语义）——wasm 数组按索引直读（长度每轮重读，
        // 迭代期间 push/delete 可见）；字符串经 str_chars 转码点数组；其它可迭代（Set/Map/
        // 自定义迭代器/迭代器对象）走 iter_new/iter_pull/iter_val（逐个 next()）；正常完成与
        // break 时对宿主迭代器调用 iter_close（JS 迭代协议要求关闭）。
        // 结构：block(brk) loop [cond→done flag; brIf(brk→close)] block(cont) body end cont br(0→loop)
        //        end loop [close-on-completion] end brk。
        const M = this.m;
        if (!ts.isVariableDeclarationList(s.initializer) || s.initializer.declarations.length !== 1)
            throw new Error("[tagged] for-of 仅支持 let x of arr / let [a,b] of arr");
        const bindName = s.initializer.declarations[0].name;
        if (ts.isIdentifier(bindName) && this._local(bindName.text) === undefined) throw new Error("未定义 for-of 变量");
        const arrL = this.forOfBase + this.forOfCount * 3;       // 本层迭代目标 local（i64）
        const idxL = arrL + 1;                                   // 本层索引 local（仅数组模式用）
        const lenL = arrL + 2;                                   // 占位（保留以不破坏 forOfBase 步长）
        void lenL;
        this.forOfCount++;
        this.emitTaggedExpr(s.expression); M.localSet(arrL);     // 迭代目标（i64）
        // 字符串 → 码点字符数组（for…of 按码点迭代："😀".length=2 但迭代 1 次）
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.ifBlock("void");
        M.localGet(arrL); M.call("qz.str_chars"); M.localSet(arrL);              // 字符串 → 码点数组
        M.end();
        // 非 wasm 数组（宿主可迭代）→ 建立宿主迭代器（惰性逐次 next()）
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.i32Eqz();
        M.ifBlock("void");
        M.localGet(arrL); M.call("qz.iter_new"); M.localSet(arrL);
        M.end();
        M.i32Const(0); M.localSet(idxL);                         // i = 0（数组模式）
        M.block(); this.depth++; M.loop(); this.depth++;
        // 条件：数组模式 = idx >= 本轮长度（live）；宿主模式 = iter_pull 返回 done（!=0）
        //   两分支统一为 i32 done-flag；if/else 结束后单一 brIf(1)（br 1 = brk → 经 close 退出）
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("i32");
        M.localGet(idxL);
        this._emitLengthOf(arrL); M.f64ReinterpretI64(); M.i32TruncF64S();
        M.i32GeS();                                             // idx >= len → 1（done）
        M.else_();
        M.localGet(arrL); M.call("qz.iter_pull"); M.i64Const(0n); M.i64Ne();    // done flag = (pull != 0)
        M.end();
        M.brIf(1);                                              // done → 退出循环（→ close）
        M.block(); this.depth++;
        this.labels.push({ brk: this.depth - 2, cont: this.depth, label: this._curLabel() });
        // 元素：wasm 数组(0x7FFB) → 内存 dataOff + idx*8（并 idx++）；宿主迭代器 → iter_val
        { const cap = this._loopCaptured(this._headerNames(s), s.statement || s);              // let/const 每迭代绑定
          if (cap) this._emitPerIterEnv(cap.headerNames, cap.bodyNames); }
        M.localGet(arrL); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(arrL); M.i32WrapI64(); M.i32Load(2, 8);       // dataOff
        M.localGet(idxL); M.i32Const(8); M.i32Mul(); M.i32Add(); // dataOff + idx*8
        M.i64Load(3, 0);                                         // 元素（i64）
        M.localGet(idxL); M.i32Const(1); M.i32Add(); M.localSet(idxL);   // i++（下一轮）
        M.else_();
        M.localGet(arrL); M.call("qz.iter_val");                // 宿主迭代器当前值（i64）
        M.end();
        if (ts.isIdentifier(bindName)) {
            this._emitVarStore(bindName.text, this.scratchB); this.m.drop();     // x = arr[i]（被捕获则写 env）
        } else {
            const tb = this._expEnter();
            M.localSet(tb.v);
            this._emitDestructurePattern(bindName, tb.v);                       // let [k,v] of …
            this._expLeave();
        }
        if (s.statement) this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; M.end();                                  // end cont
        M.br(0);                                                // 下一轮（→ loop 头 → 条件）
        this.depth--; M.end();                                  // end loop
        this.depth--; M.end();                                  // end brk（iter_close 移到 block 外：wasm br 到 block = 跳到 end 后，故 brIf(1) 落到此处）
        // 正常完成 / break → iter_close（brk block 外：brIf(1) done 与 break 均跳到 brk.end 后 → 落到此处）
        M.localGet(arrL); M.call("qz.iter_close");
        this.forOfCount--;
        return;
    }
    if (ts.isLabeledStatement(s)) {
        if (ts.isIterationStatement(s.statement, false)) { this._labelStack.push(s.label.text); this.emitTaggedStmt(s.statement); return; }
        this.m.block("void"); this.depth++;                       // 非循环标签块：break label → 跳到块尾
        this.labels.push({ brk: this.depth, cont: null, label: s.label.text });
        this.emitTaggedStmt(s.statement);
        this.labels.pop();
        this.depth--; this.m.end();
        return;
    }
    if (ts.isBlock(s)) {
        if (this._shadowBlocks && this._shadowBlocks.has(s)) {
            const M0 = this.m, saved = [];
            let n0 = 0;
            for (const st of s.statements) {
                if (!ts.isVariableStatement(st)) continue;
                for (const d of st.declarationList.declarations) {
                    const nm = ts.isIdentifier(d.name) ? d.name.text : null;
                    if (!nm) continue;
                    const li = this._local(nm);                       // 外层同名局部
                    const slot = this._local("$sh" + n0);              // 保存槽（本函数 i64 值局部）
                    if (li === undefined || slot === undefined) continue;
                    n0++;
                    M0.localGet(li); M0.localSet(slot);
                    saved.push([li, slot]);
                }
            }
            this.emitTaggedBlock(s);
            for (let i = saved.length - 1; i >= 0; i--) { M0.localGet(saved[i][1]); M0.localSet(saved[i][0]); }   // 恢复外层绑定（块级 let/const 遮蔽）
            return;
        }
        this.emitTaggedBlock(s); return;
    }
    if (ts.isExpressionStatement(s)) {
        // console.log(x) → qz.log（边界输出）
        const ex = s.expression;
        if (ts.isCallExpression(ex) && ts.isPropertyAccessExpression(ex.expression) && ex.expression.expression.text === "console") {
            for (const a of ex.arguments) { this.emitTaggedExpr(a); this.m.call("qz.log"); }
            return;
        }
        if (ts.isCallExpression(ex) && ts.isSuperKeyword(ex.expression)) { this.emitTaggedExpr(ex); return; }
        this.emitTaggedExpr(ex); this.m.drop(); return;
    }
    if (ts.isEmptyStatement(s)) return;
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isModuleDeclaration(s)
        || s.kind === ts.SyntaxKind.ImportDeclaration || s.kind === ts.SyntaxKind.ExportDeclaration) return;   // TS 类型层/导入导出：擦除
    throw new Error("[tagged] 不支持的语句: " + ts.SyntaxKind[s.kind]);
};
// try/catch/finally：__err(global1) + 结构化 br。
//   block $done → block $err → <try> → br $done | end $err → <catch> → end $done → <finally>
// throw 跳 $err 后（catch）；正常跳 $done 后（跳过 catch）。finally 两路都会执行。
Emitter.prototype.emitTry = function (s, tagged) {
    const M = this.m;
    const fin = s.finallyBlock;
    const finTok = fin ? {} : null;                // 该 try 的身份令牌（throw 时判断此 finally 是否已被「自然流」负责）
    if (fin) { this._finallyStack = this._finallyStack || []; this._finallyStack.push({ node: fin, tok: finTok, labelsLen: (this.labels || []).length, tryDepth: (this._tryStack || []).length }); }
    M.block(); this.depth++;                       // $done
    M.block(); this.depth++;                       // $err
    this._tryStack.push({ errBrk: this.depth, tok: finTok });   // 记录 $err 相对深度（throw 用）
    M.i64Const(0n); M.globalSet(1);                              // 进入 try：清 __err
    if (tagged) this.emitTaggedBlock(s.tryBlock); else this.emitBlock(s.tryBlock);
    M.br(this.depth - (this.depth - 1));           // 正常 → 跳 $done 后（跳过 catch）
    this._tryStack.pop();
    this.depth--; M.end();                         // end $err → catch 入口
    const c = s.catchClause;
    if (c) {
        const cv = c.variableDeclaration && c.variableDeclaration.name;
        if (cv && ts.isIdentifier(cv)) {
            const idx = this._local(cv.text);
            if (idx !== undefined) { M.globalGet(1); M.localSet(idx); }   // catch 变量 = __err
        } else if (cv) {
            // catch 解构（{a, b} / [x, y]）：从 __err 读出各分量并绑定（此前静默不绑定 → 全 0）
            const t = this._expEnter();
            M.globalGet(1); M.localSet(t.x);
            if (ts.isObjectBindingPattern(cv)) {
                for (const el of cv.elements) {
                    if (!ts.isIdentifier(el.name)) throw new Error("[tagged] catch 对象解构仅支持标识符（含改名）");
                    if (el.dotDotDotToken) throw new Error("[tagged] catch 解构暂不支持 rest");
                    if (el.initializer) throw new Error("[tagged] catch 解构暂不支持默认值");
                    const key = ts.isIdentifier(el.propertyName || el.name) ? (el.propertyName || el.name).text : null;
                    if (key === null) throw new Error("[tagged] catch 解构键必须为标识符");
                    this._emitPropReadFromLocal(t.x, key);
                    const idx = this._local(el.name.text);
                    if (idx !== undefined) M.localSet(idx); else M.drop();
                }
            } else if (ts.isArrayBindingPattern(cv)) {
                let i = 0;
                for (const el of cv.elements) {
                    if (ts.isOmittedExpression(el)) { i++; continue; }
                    if (!ts.isIdentifier(el.name)) throw new Error("[tagged] catch 数组解构仅支持标识符");
                    if (el.initializer) throw new Error("[tagged] catch 解构暂不支持默认值");
                    this._emitElemOf(t.x, ts.factory.createNumericLiteral(i));
                    const idx = this._local(el.name.text);
                    if (idx !== undefined) M.localSet(idx); else M.drop();
                    i++;
                }
            } else {
                throw new Error("[tagged] 不支持的 catch 绑定模式");
            }
            this._expLeave();
        }
        M.i64Const(0n); M.globalSet(1);                          // catch 入口即清 __err（否则 catch 体内调用点的 err 检查会重复触发）
        if (tagged) this.emitTaggedBlock(c.block); else this.emitBlock(c.block);
        M.i64Const(0n); M.globalSet(1);                          // catch 处理完：清 __err
    }
    this.depth--; M.end();                         // end $done
    if (fin) {
        this._finallyStack.pop();
        if (tagged) this.emitTaggedBlock(fin); else this.emitBlock(fin);
        if (!c) this._emitErrCheck(false);         // try-finally（无 catch）：finally 后必须重新抛出
    }
};
// 运行待执行 finally 块（return/throw 鳚出 try 时由 JS 语义要求；最内层先跑）
Emitter.prototype._emitPendingFinally = function (tagged, forThrow) {
    const st = this._finallyStack;
    if (!st || !st.length) return;
    // throw：目标 catch = 最内层仍在 tryStack 的 try。只运行**位于其内部**的 finally
    // （入栈深度 >= 当前 tryStack 长度）；目标 try 自己的 finally 由其 catch 之后的正常路径负责。
    const curDepth = (this._tryStack || []).length;
    for (let i = st.length - 1; i >= 0; i--) {
        const e = st[i];
        if (forThrow && ((e.tryDepth === undefined ? -1 : e.tryDepth) < curDepth)) continue;   // 目标及其外层：不在此跑
        this._finallyStack = st.slice(0, i);        // 防重入：finally 体内的 return/throw 不再重复跑本层
        { const savedTry = this._tryStack;          // 本 try 已退出：体内 throw 应归向外层 try（否则 br 回本 try 的 $err → 落回正常路径 finally → 重复执行）
          this._tryStack = (this._tryStack || []).slice(0, e.tryDepth === undefined ? 0 : e.tryDepth);
          try { if (tagged) this.emitTaggedBlock(e.node); else this.emitBlock(e.node); }
          finally { this._tryStack = savedTry; } }
    }
    this._finallyStack = st;
};

// switch：entry-index 方案。先算入口 clause 序号（无匹配→default，无 default→len），
// 再按源码序遍历，swIdx<=i 激活（fallthrough 天然正确，default 位置无关）。break → 外层 block。
Emitter.prototype.emitSwitch = function (s, tagged) {
    const M = this.m;
    const clauses = s.caseBlock.clauses;
    let defaultIdx = clauses.findIndex(c => ts.isDefaultClause(c));
    if (defaultIdx < 0) defaultIdx = clauses.length;
    M.block(); this.depth++;
    this.labels.push({ brk: this.depth, cont: null, label: this._curLabel() });
    if (tagged) this.emitTaggedExpr(s.expression); else this.emitExpr(s.expression);
    M.localSet(this.scratch);
    M.i32Const(defaultIdx); M.localSet(this.swIdx);
    // scan：首个 disc===caseVal → entry=i 并跳出（br 1 出 scan block）；全不匹配保持 defaultIdx。
    M.block(); this.depth++;
    for (let i = 0; i < clauses.length; i++) {
        const c = clauses[i];
        if (ts.isDefaultClause(c)) continue;
        M.localGet(this.scratch);
        if (tagged) { this.emitTaggedExpr(c.expression); M.call("qz.seq"); M.call("qz.truthy"); }
        else { this.emitExpr(c.expression); M.f64Eq(); }
        M.ifBlock(); this.depth++;
        M.i32Const(i); M.localSet(this.swIdx);
        M.br(1);
        M.end(); this.depth--;
    }
    this.depth--; M.end();                                  // end scan
    for (let i = 0; i < clauses.length; i++) {                          // 源码序执行（fallthrough）
        M.localGet(this.swIdx); M.i32Const(i); M.i32LeS();
        M.ifBlock(); this.depth++;
        for (const st of clauses[i].statements) { if (tagged) this.emitTaggedStmt(st); else this.emitStmt(st); }
        M.end(); this.depth--;
    }
    this.labels.pop();
    this.depth--; M.end();
};
Emitter.prototype.emitTaggedExpr = function (e) {
    if (ts.isNumericLiteral(e)) {
        this.m.i64ConstBits(...f64Bits(Number(e.text)));   // 数值 = 原始 f64 位型
        return;
    }
    if (ts.isBigIntLiteral(e)) {                       // BigInt 字面量（10n/0x10n/1_000n → 去 _ 与 n 后缀）→ HOST 句柄（BIG_HI|槽）
        this.m.i32Const(this._strId(e.text.replace(/_/g, "").replace(/n$/i, "")));
        this.m.call("qz.bigint_lit");
        return;
    }
    if (ts.isStringLiteral(e)) { this._emitStrLitHandle(e.text); return; }
    if (ts.isNoSubstitutionTemplateLiteral(e)) { this._emitStrLitHandle(e.text); return; }
    if (e.kind === ts.SyntaxKind.TrueKeyword) { this.m.i64ConstBits(1, 0x7ffc0000); return; }   // tagged bool 0x7FFC|1（非 f64 1.0：bool 与 number 须区分）
    if (e.kind === ts.SyntaxKind.FalseKeyword) { this.m.i64ConstBits(0, 0x7ffc0000); return; }  // 0x7FFC|0
    if (e.kind === ts.SyntaxKind.NullKeyword) { this._emitNull(); return; }              // 0x7FF9|1（固定 null 槽；区别于 undefined 的 |0）
    if (ts.isIdentifier(e) && e.text === "undefined") { this._emitUndefined(); return; } // 0x7FF9|0
    if (ts.isTemplateExpression(e)) {
        // `head${e1}lit1${e2}lit2…`：逐段 _emitConcat（栈 [a,b]→句柄）。空段字面量为空串。
        this._emitStrLitHandle(e.head.text);
        for (const span of e.templateSpans) {
            this.emitTaggedExpr(span.expression);
            this.m.call("qz.to_string");     // 模板内插值 = ToString（string hint），不是 ToPrimitive(default)
            this._emitConcat();
            this._emitStrLitHandle(span.literal ? span.literal.text : "");
            this._emitConcat();
        }
        return;
    }
    if (ts.isThis(e)) {
        if (this.capMap.has("this")) { this._emitCapturedRead("this"); return; }   // 方法内闭包捕获 this → 经 env
        // 声明了 `this` 形参的函数/闭包：this = receiver 槽（被调方按约定前置；无 receiver 时该槽即 undefined，与 JS 严格模式等价）
        if (this._inStaticMethod && this._curClassObj && !this._inStaticInit) {   // 静态方法：this = self 槽（调用点传接收者类）；未传 → 回退定义类
            const M = this.m, tS = this._expEnter();
            M.localGet(0); M.localSet(tS.v);
            M.localGet(tS.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
            M.localGet(tS.v); M.i64Const(0xffffffffn); M.i64And(); M.i64Const(8n); M.i64LtU();
            M.i32And();
            M.ifBlock("i64");
            M.i32Const(this._curClassObj.id); M.call("qz.class_value");
            M.else_();
            M.localGet(tS.v);
            M.end();
            this._expLeave();
            return;
        }
        const idx = this._local("this");
        if (idx === undefined) throw new Error("[tagged] this 仅在类方法/构造器内可用");
        this.m.localGet(idx); return;
    }
    if (ts.isTaggedTemplateExpression(e)) {
        // tag`a${1}b`：构造字面量数组 [a, b]（含 raw 省略）+ 值 1 → closure_call(tag, arr, a0, a1, a2)
        const M = this.m, t = this._expEnter();
        // rawOf：从模板字面量节点取源码原文（去定界符）——String.raw 与用户标签共用
        const rawOf = (lit) => {
            let txt = lit.getText();
            if (txt.startsWith("`") || txt.startsWith("}")) txt = txt.slice(1);
            if (txt.endsWith("${")) txt = txt.slice(0, -2);
            else if (txt.endsWith("`")) txt = txt.slice(0, -1);
            return txt;
        };
        // String.raw`…`：raw 文本 = 各段源码原文（去定界符）→ 直接按 ToString 拼接（无需 strings.raw 表）
        if (ts.isPropertyAccessExpression(e.tag) && ts.isIdentifier(e.tag.expression) && e.tag.expression.text === "String" && e.tag.name.text === "raw") {
            const noSub = ts.isNoSubstitutionTemplateLiteral(e.template);
            const spans = noSub ? [] : e.template.templateSpans;
            this._emitStrLitHandle(noSub ? rawOf(e.template) : rawOf(e.template.head));   // 首段 raw
            for (const sp of spans) {
                this.emitTaggedExpr(sp.expression);
                M.call("qz.to_string");                                  // ToString（string hint）
                this._emitConcat();
                this._emitStrLitHandle(rawOf(sp.literal));
                this._emitConcat();
            }
            this._expLeave();
            return;
        }
        const noSub0 = ts.isNoSubstitutionTemplateLiteral(e.template);
        // 标签为**已知形参**的函数（本作用域函数声明/闭包）→ 按形参表落栈（rest 打包 / 元数补齐；否则 rest 形参会拿到非数组）
        const tagName0 = ts.isIdentifier(e.tag) ? e.tag.text : null;
        const cp0 = tagName0 ? (this._calleeParams(tagName0) || null) : null;
        if (cp0 && cp0.length) {
            const parts0 = [ts.factory.createStringLiteral(noSub0 ? e.template.text : e.template.head.text)]
                .concat((noSub0 ? [] : e.template.templateSpans).map(sp => ts.factory.createStringLiteral(sp.literal.text)));
            const lit0 = ts.factory.createArrayLiteralExpression(parts0);
            lit0.pos = e.pos; lit0.end = e.end;
            const argNodes = [lit0].concat((noSub0 ? [] : e.template.templateSpans).map(sp => sp.expression));
            // raw strings 数组 → tagged_strings(cooked, raw) → 带 .raw 的 strings 对象
            const rawParts0 = [ts.factory.createStringLiteral(noSub0 ? rawOf(e.template) : rawOf(e.template.head))]
                .concat((noSub0 ? [] : e.template.templateSpans).map(sp => ts.factory.createStringLiteral(rawOf(sp.literal))));
            const rawLit0 = ts.factory.createArrayLiteralExpression(rawParts0);
            rawLit0.pos = e.pos; rawLit0.end = e.end;
            const tStrings = this._expEnter();
            this.emitTaggedExpr(lit0); this.emitTaggedExpr(rawLit0); M.call("qz.tagged_strings"); M.localSet(tStrings.v);
            this._expLeave();
            // 顶层函数标签：无闭包句柄 → 直接 wasm 调用（否则会误走「未定义捕获变量」）
            if (tagName0 && this.fnNames && this.fnNames.has(tagName0) && this._local(tagName0) === undefined
                && !(this.capMap && this.capMap.has(tagName0))
                && !(this.moduleGlobals && this.moduleGlobals.get(tagName0) !== undefined)) {
                M.localGet(tStrings.v);
                this._emitCallArgs(cp0.slice(1), argNodes.slice(1), tagName0, false);   // 其余按形参表（rest 打包；直接调用无 ovf）
                M.call(tagName0);
                this._emitErrCheck();
                this._expLeave();
                return;
            }
            this.emitTaggedExpr(e.tag); M.localSet(t.v);
            M.localGet(t.v);
            M.localGet(tStrings.v);                                   // 第 1 参：strings 对象（含 .raw）
            this._emitCallArgs(cp0.slice(1), argNodes.slice(1), tagName0, true);   // 其余按形参表（rest 打包/元数补齐）
            const pushed = 1 + (cp0.length > 4 ? 3 : cp0.length - 1);
            for (let i = pushed; i < 4; i++) this._emitUndefined();
            if (cp0.length > 4) {                                    // 第 6 参：溢出实参数组
                const ovfT = ts.factory.createArrayLiteralExpression(argNodes.slice(3));
                ovfT.pos = e.pos; ovfT.end = e.end;
                this.emitTaggedExpr(ovfT);
            } else this._emitUndefined();
            this._emitUndefined();                    // recv（普通调用 = undefined）
            M.call("qz.call_value");
            this._emitErrCheck();
            this._expLeave();
            return;
        }
        this.emitTaggedExpr(e.tag); M.localSet(t.v);                       // 标签（闭包句柄）
        const noSub = ts.isNoSubstitutionTemplateLiteral(e.template);
        const spans = noSub ? [] : e.template.templateSpans;
        const parts = [ts.factory.createStringLiteral(noSub ? e.template.text : e.template.head.text)]
            .concat(spans.map(sp => ts.factory.createStringLiteral(sp.literal.text)));
        const lit = ts.factory.createArrayLiteralExpression(parts);
        lit.pos = e.pos; lit.end = e.end;
        const rawParts = [ts.factory.createStringLiteral(noSub ? rawOf(e.template) : rawOf(e.template.head))]
            .concat(spans.map(sp => ts.factory.createStringLiteral(rawOf(sp.literal))));
        const rawLit = ts.factory.createArrayLiteralExpression(rawParts);
        rawLit.pos = e.pos; rawLit.end = e.end;
        this.emitTaggedExpr(lit); this.emitTaggedExpr(rawLit); M.call("qz.tagged_strings"); M.localSet(t.w);   // strings = {cooked..., raw}
        M.localGet(t.v); M.localGet(t.w);
        for (let i = 0; i < 3; i++) {
            if (i < spans.length) this.emitTaggedExpr(spans[i].expression);
            else this._emitUndefined();
        }
        this._emitUndefined();   // 第 6 参（ovf）
        this._emitUndefined();   // 第 7 参（recv；普通调用 = undefined）
        M.call("qz.call_value");
        this._emitErrCheck();
        this._expLeave();
        return;
    }
    if (ts.isRegularExpressionLiteral(e)) {
        this.m.i32Const(this._strId(e.text));        // 含定界符与 flags 的原文（宿主解析）
        this.m.call("qz.regex");
        return;
    }
    if (ts.isIdentifier(e)) {
        if (e.text === "arguments") {
            const ai = this._local("arguments");
            if (ai !== undefined) { this.m.localGet(ai); return; }   // 全量实参数组（调用点/宿主经 __args 写入）
            throw new Error("[tagged] `arguments` 仅支持顶层函数体与闭包体（类方法内为已知 loud——见 ASSESSMENT）");
        }
        if (this.capMap.has(e.text)) { this._emitCapturedRead(e.text); return; }   // 捕获名优先走 env（与本体共享）
        const idx = this._local(e.text);
        if (idx !== undefined) { this.m.localGet(idx); return; }
        // 数值全局常量（无需 import）：NaN/Infinity
        if (e.text === "NaN") { this.m.i64ConstBits(...f64Bits(NaN)); return; }
        if (e.text === "Infinity") { this.m.i64ConstBits(...f64Bits(Infinity)); return; }
        {   // 类名作值 → 宿主构造器对象句柄（prototype 链/静态方法）；new C(...) 仍走专用路径
            const cnV = this._className(e.text) || (this.classes.has(e.text) ? e.text : undefined);   // 闭包内 _className 可能失配 → 兜底按原名查类
            const cV = cnV && this.classes.get(cnV);
            if (cV) { this._emitClassValue(cV); return; }
        }
        if (BUILTIN_GLOBALS.has(e.text)) {          // 内建全局作值（String/Number/Array/…）
            this.m.i32Const(this._strId(e.text)); this.m.call("qz.builtin_value"); return;
        }
        {   // namespace 导入名作**值**（`{ iso: _iso }`）：内联后没有运行期模块对象，
            // 但它就是「成员名 → 目标顶层名」的映射 → 合成同形对象字面量。
            const nm = !this._local(e.text) && !this.capMap.has(e.text) && !this.classes.has(e.text)
                && this._nsMembers(e.text);
            if (nm) {
                const props = [];
                for (const [k, target] of nm) {
                    const id = ts.factory.createIdentifier(target);
                    id.pos = e.pos; id.end = e.end;
                    const pa = ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(k), id);
                    pa.pos = e.pos; pa.end = e.end;
                    props.push(pa);
                }
                const lit = ts.factory.createObjectLiteralExpression(props, false);
                lit.pos = e.pos; lit.end = e.end;
                this.emitTaggedExpr(lit);
                return;
            }
        }
        this._emitCapturedRead(e.text); return;
    }
    if (ts.isClassExpression(e)) {                       // 类表达式作值 → 宿主构造器对象句柄（class_value）
        const synth = this.clsExprMap && this.clsExprMap.get(e);
        if (process.env.QZDBG) console.error("[cex]", synth, "inClasses=", !!(synth && this.classes.get(synth)));
        const cnC = synth && this.classes.get(synth);
        if (cnC) {
            /* 每次求值一个新类（JS 语义）：克隆 classMeta 项 → 独立 clsId，
             * 否则工厂产出的多个类共享 id → instanceof 误判 / .name 串味。
             * 动态父（`class extends Base2`，Base2 是形参）例外：正交要求
             * 运行期父链可查（super() 按 clsId 找父构造），故走 class_value_dyn
             * 记录运行时父——与声明式类的链接路径一致。*/
            const dynN = this._dynParentExpr(cnC);
            if (dynN) { this._emitClassValue(cnC); return; }
            /* 类方法/getter 捕获外层变量（`(label) => class { get l(){ return label; } }`）：
             * 必须在**创建点**把捕获值复制到类 env 并挂到 statics @@qzEnv。
             * 克隆 classMeta 不会克隆 env 槽——漏了这步，克隆出的类方法读 env 得到空值
             * （静默 undefined）。复用 _emitClassValue 的捕获段。*/
            /* 类表达式 + 方法捕获：clone 出的多个类当前共享同一 statics 槽
             * （类方法读 env 用 static_get(strId(类名), "@@qzEnv")，匿名类/工厂
             * 类名相同 → 后创建者覆盖前者的捕获，`A`/`B` 读同一 label）。
             * 与其静默错值，先 loud 报错，等 statics 键带 clsId 后再放开。*/
            /* 捕获 env 必须随克隆走：克隆出独立的 clsId 后把 env 存到该 clsId 键下，
             * 方法体按实例运行时 clsId 读（class_env_get）→ A/B 各持一份，不串味。*/
            this.m.i32Const(cnC.id);
            if (process.env.QZDBG) console.error("[cev]", cnC.name, "captured=", JSON.stringify(cnC.captured));
            if (cnC.captured && cnC.captured.length) this._emitClassCaptureEnvValue(cnC);
            else this.m.i64Const(0n);
            this.m.i32Const(this._strId("@@qzEnv"));
            this.m.call("qz.class_expr_value");
            return;
        }
        throw new Error("[tagged] 类表达式作值未实现");
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
        // 属性值位置的函数表达式若已合成「this 形参」闭包（见 _collectLambdas/_synthSelfFn）→ 发合成节点
        const synth = this._synthLambdas && this._synthLambdas.get(e);
        this._emitLambdaNew(synth || e);
        return;
    }
    if (ts.isParenthesizedExpression(e)) { this.emitTaggedExpr(e.expression); return; }
    // 纯类型层构造（运行时恒等，TS 会在 emit 前擦除）→ 直接透传：
    // `as T` / `x!` / `e satisfies T` / 尖括号断言 `<T>e`。
    if (ts.isAsExpression(e) || ts.isNonNullExpression(e)
        || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) { this.emitTaggedExpr(e.expression); return; }
    if (ts.isTypeOfExpression(e)) {
        // 内联分类：0x7FFA→"string"；0x7FFB→"object"；
        //   0x7FF9|0→"undefined"（_emitUndefined 的 null/undefined 统一句柄）；0x7FF9|≠0→"object"；
        //   0x7FFC→"boolean"；其余→"number"。
        //   注：0x7FF9 低 32 位对「宿主 handles 索引」与「POJO 内存 offset」同空间，
        //   function 值落此分支也得 "object"（JS 应为 "function"）——已知限制（函数作值少见）。
        const M = this.m;
        if (ts.isIdentifier(e.expression)
            && (this.fnNames.has(e.expression.text) || (this._fnVars && this._fnVars.has(e.expression.text)))) {
            this._emitStrLitHandle("function");   // 函数值（顶层函数名 / 持有闭包的变量）
            return;
        }
        if (this._classOfExpr(e.expression) !== null || ts.isClassExpression(e.expression)) {
            this._emitStrLitHandle("function");   // typeof <类名>/<类表达式> → "function"（class 是函数对象）
            return;
        }
        // 内建全局：typeof Math/JSON → "object"；typeof Symbol/parseInt/… → "function"（JS 语义，免宿主调用）
        if (ts.isIdentifier(e.expression) && BUILTIN_GLOBALS.has(e.expression.text)) {
            const isObj = /^(Math|JSON|Reflect)$/.test(e.expression.text);
            this._emitStrLitHandle(isObj ? "object" : "function");
            return;
        }
        // `typeof x` 对**未声明**标识符恒 "undefined"（规范特例：typeof 不抛 ReferenceError）。
        // zod：`typeof URL !== "undefined"` 里 URL 无内联绑定（lib 全局类型，无运行期值）。
        if (ts.isIdentifier(e.expression)) {
            const nm = e.expression.text;
            const known = this._local(nm) !== undefined || this.capMap.has(nm) || this.classes.has(nm)
                || (this.moduleGlobals && this.moduleGlobals.get(nm) !== undefined)
                || this._fnName(nm) !== nm || this.fnNames.has(nm)
                || nm === "NaN" || nm === "Infinity";   // 数值全局常量，永远有值（typeof → "number"）
            if (!known) { this._emitStrLitHandle("undefined"); return; }
        }
        this.emitTaggedExpr(e.expression); M.localSet(this.scratch);
        M.block("i64"); this.depth++;
        // 宿主值（0x7FFD）：可能是 JS 函数（对象字面量方法 / 宿主回调）→ 由宿主判定
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
        M.ifBlock("i64");
        M.localGet(this.scratch); M.call("qz.typeof_host");
        M.ifBlock("i64");
        this._emitStrLitHandle("function");
        M.else_();
        M.localGet(this.scratch); M.call("qz.is_symbol_host");
        M.ifBlock("i64");
        this._emitStrLitHandle("symbol");
        M.else_();
        this._emitStrLitHandle("object");
        M.end();
        M.end();
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7fffn); M.i64Eq();
        M.ifBlock("i64");
        this._emitStrLitHandle("function");   // 闭包值（函数）
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
        M.ifBlock("i64");
        this._emitStrLitHandle("string");
        M.else_();
        // 0x7FF8|低32≠0 → "bigint"（0x7FF8|0 = canonical NaN → 落后面 "number"）
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff8n); M.i64Eq();
        M.localGet(this.scratch); M.i64Const(0xffff_ffffn); M.i64And(); M.i64Eqz(); M.i32Eqz();
        M.i32And();
        M.ifBlock("i64");
        this._emitStrLitHandle("bigint");
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
        M.i32Or();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffen); M.i64Eq();   // 类实例 → "object"
        M.i32Or();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();   // 宿主对象 → "object"
        M.i32Or();
        M.ifBlock("i64");
        // 0x7FF9|0 → "undefined"（null 亦映射 0x7FF9|0；JS typeof null="object" —— null 字面量
        // 由 emitTaggedExpr 直接产 0x7FF9|0，与 undefined 同表示，故 null 也报 "undefined"。
        // 已知限制：null/undefined 句柄不区分（表示层统一），typeof 优先报 "undefined"。）
        M.localGet(this.scratch); M.i64Const(0xffff_ffffn); M.i64And(); M.i64Eqz();
        M.ifBlock("i64");
        this._emitStrLitHandle("undefined");
        M.else_();
        this._emitStrLitHandle("object");
        M.end();
        M.else_();
        M.localGet(this.scratch); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffcn); M.i64Eq();
        M.ifBlock("i64");
        this._emitStrLitHandle("boolean");
        M.else_();
        this._emitStrLitHandle("number");
        M.end();
        M.end(); M.end(); M.end();   // 关 ifBool / ifObj / ifStr / ifBig
        M.end();                     // 关 ifClo
        M.end();                     // 关 ifHost 外层
        this.depth--; M.end();       // 关 block(i64)
        return;
    }
    // `{ ...ns }`：ns 是 `import * as ns from "./m"` 的模块对象 —— 内联后没有运行期模块对象，
    // 但成员表已知（nsAlias）。改写为逐个 PropertyAssignment，值 = 目标顶层名标识符。
    // zod：`export * from "./schemas.js"` 在 classic/from-json-schema.ts 里物化成 `{ ..._schemas }`。
    if (ts.isObjectLiteralExpression(e)) {
        const hasNsSpread = e.properties.some(p =>
            ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression) && this._nsMembers(p.expression.text));
        if (hasNsSpread) {
            const props = [];
            for (const p of e.properties) {
                if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression)) {
                    const nm = this._nsMembers(p.expression.text);
                    if (nm) {
                        for (const [k, target] of nm) {
                            const id = ts.factory.createIdentifier(target);
                            id.pos = p.pos; id.end = p.end;
                            const pa = ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(k), id);
                            pa.pos = p.pos; pa.end = p.end;
                            props.push(pa);
                        }
                        continue;
                    }
                }
                props.push(p);
            }
            const lit2 = ts.factory.createObjectLiteralExpression(props, false);
            lit2.pos = e.pos; lit2.end = e.end;
            this.emitTaggedExpr(lit2);
            return;
        }
    }
    if (ts.isObjectLiteralExpression(e)
        && e.properties.some(p => ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p))) {
        // 含方法/访问器的对象字面量也支持展开：按源码序用 qz.obj_merge 就地并入（宿主对象目标）
        // 宿主对象(0x7FFD)：方法 → 闭包包装值；访问器 → defineProperty(get/set 回调 wasm 闭包)。
        const M = this.m, t = this._expEnter();
        M.call("qz.obj_new"); M.localSet(t.v);
        const doneA = new Set();
        for (const p of e.properties) {
            const nm = p.name && p.name.text;
            if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) {   // 计算键：运行期键 → qz.set_index
                M.localGet(t.v);
                this.emitTaggedExpr(p.name.expression);
                this.emitTaggedExpr(p.initializer);
                M.call("qz.set_index");
            } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
                M.localGet(t.v); M.i32Const(this._strId(nm));
                this.emitTaggedExpr(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer);
                M.call("qz.object_set");
            } else if (ts.isSpreadAssignment(p)) {
                M.localGet(t.v);
                this.emitTaggedExpr(p.expression);
                M.call("qz.obj_merge");
            } else if (ts.isMethodDeclaration(p)) {
                if (nm !== undefined) {                                   // 字符串名
                    M.localGet(t.v); M.i32Const(this._strId(nm));
                    this.emitTaggedExpr(this._memberLambda(p));
                    M.call("qz.object_set_method");
                } else if (p.name && ts.isComputedPropertyName(p.name)) { // 计算键名（Symbol.iterator 等）
                    M.localGet(t.v); this.emitTaggedExpr(p.name.expression);
                    this.emitTaggedExpr(this._memberLambda(p));
                    M.call("qz.object_set_method_key");
                } else throw new Error("[tagged] 对象字面量方法名不支持");
            } else if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
                if (doneA.has(nm)) continue;
                doneA.add(nm);
                const g = e.properties.find(q => ts.isGetAccessorDeclaration(q) && q.name.text === nm);
                const st = e.properties.find(q => ts.isSetAccessorDeclaration(q) && q.name.text === nm);
                M.localGet(t.v); M.i32Const(this._strId(nm));
                if (g) this.emitTaggedExpr(this._memberLambda(g)); else this._emitUndefined();
                if (st) this.emitTaggedExpr(this._memberLambda(st)); else this._emitUndefined();
                M.call("qz.obj_accessor");
            } else throw new Error("[tagged] 对象字面量属性形式不支持");
        }
        M.localGet(t.v);
        this._expLeave();
        return;
    }
    if (ts.isObjectLiteralExpression(e)) {
        // POJO：字段驻留 wasm 线性内存（零跨界读写）。句柄 = box(高16位0x7FF9 | offset)。字段宽 8 字节（i64）。
        if (e.properties.some(p => ts.isSpreadAssignment(p))) {
            // {..a, k: v}：分配统一容量的新 POJO → 展开段做**内存级浅拷贝**（嵌套句柄原样复制 = JS 别名语义）+
            // 宿主对象/非 POJO 源走 qz.obj_merge（物化后逐键写）；显式属性直接写各自字段槽。
            const Ma = this.m, ta = this._expEnter();
            const cap = this._instSize();
            emitBumpAlloc(Ma, () => Ma.i32Const(cap));            // → off(i32)
            Ma.localSet(ta.a);
            Ma.localGet(ta.a); Ma.i64ExtendI32U(); Ma.i64ConstBits(0, 0x7ff90000); Ma.i64Or(); Ma.localSet(ta.v);
            Ma.localGet(ta.a); Ma.i32Const(0); Ma.i32Store(2, 0);                  // [0]=clsId（POJO=0）
            Ma.localGet(ta.a); Ma.i32Const(cap); Ma.i32Store(2, 4);                // [4]=size
            Ma.localGet(ta.a); Ma.i32Const(RC_HDR); Ma.i32Sub(); Ma.i32Const(K_POJO); Ma.i32Store(2, 8);  // GC 需知槽是句柄
            Ma.localGet(ta.a); this._emitFillUndef(cap);                           // 未赋值槽 = undefined
            for (const p of e.properties) {
                if (ts.isSpreadAssignment(p)) {
                    this.emitTaggedExpr(p.expression); Ma.localSet(ta.w);
                    Ma.localGet(ta.w); Ma.i64Const(48n); Ma.i64ShrU(); Ma.i64Const(0x7ff9n); Ma.i64Eq();
                    Ma.localGet(ta.w); Ma.i64Const(48n); Ma.i64ShrU(); Ma.i64Const(0x7ffen); Ma.i64Eq();
                    Ma.i32Or();
                    Ma.i32Const(this.usesDynAcc ? 0 : 1); Ma.i32And();   // 程序内存在运行时访问器（defineProperty）→ 一律走 obj_merge（槽级合并会丢访问器键）
                    Ma.ifBlock("void");
                    // 槽级合并：仅当源槽≠undefined 才写入（JS：后展开段只覆盖其自有键；undefined 槽不覆盖）
                    Ma.localGet(ta.a); Ma.i32Const(8); Ma.i32Add(); Ma.localSet(ta.b);        // dst 游标（a 保留 = 新对象）
                    Ma.localGet(ta.w); Ma.i32WrapI64(); Ma.i32Const(8); Ma.i32Add(); Ma.localSet(ta.c);   // src 游标
                    Ma.localGet(ta.a); Ma.i32Const(cap); Ma.i32Add(); Ma.localSet(ta.d);      // dst 末尾
                    Ma.block("void"); Ma.loop("void");
                    Ma.localGet(ta.b); Ma.localGet(ta.d); Ma.i32GeU(); Ma.brIf(1);            // 到尾 → 退出
                    Ma.localGet(ta.c); Ma.i64Load(3, 0);
                    Ma.i64ConstBits(0, 0x7ff90000); Ma.i64Eq(); Ma.i32Eqz();
                    Ma.ifBlock("void");
                    Ma.localGet(ta.b); Ma.localGet(ta.c); Ma.i64Load(3, 0); Ma.i64Store(3, 0);
                    Ma.end();
                    Ma.localGet(ta.b); Ma.i32Const(8); Ma.i32Add(); Ma.localSet(ta.b);
                    Ma.localGet(ta.c); Ma.i32Const(8); Ma.i32Add(); Ma.localSet(ta.c);
                    Ma.br(0);
                    Ma.end(); Ma.end();
                    if (this.usesKeyOrder) { Ma.localGet(ta.v); Ma.localGet(ta.w); Ma.call("qz.spread_order"); }   // 键序补登记（否则合并后键序退化为槽序）
                    Ma.else_();
                    Ma.localGet(ta.v); Ma.localGet(ta.w); Ma.call("qz.obj_merge");      // 宿主对象等 → 物化合并
                    if (this.usesKeyOrder) { Ma.localGet(ta.v); Ma.localGet(ta.w); Ma.call("qz.spread_order"); }
                    Ma.end();
                } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
                    if (ts.isComputedPropertyName(p.name)) {
                        // 计算键 `{ [k]: v }`：键在运行期才知道，写不进静态字段槽 → 经宿主 set_index
                        // （POJO 上落 extras，get_index 同表读取）。
                        Ma.localGet(ta.v);
                        this.emitTaggedExpr(p.name.expression);
                        this.emitTaggedExpr(p.initializer);
                        Ma.call("qz.set_index");
                    } else {
                        Ma.localGet(ta.v); Ma.i32WrapI64();
                        this.emitTaggedExpr(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer);
                        Ma.i64Store(3, this._fieldIndex(p.name.text));
                    }
                    if (this.usesKeyOrder && !ts.isComputedPropertyName(p.name)) { Ma.localGet(ta.v); this._emitStrLitHandle(p.name.text); Ma.call("qz.field_order"); }   // 显式属性也登记键序
                } else throw new Error("[tagged] 对象展开仅支持 属性/展开 混合（方法/访问器不支持）");
            }
            Ma.localGet(ta.v);
            this._expLeave();
            return;
        }
        if (e.properties.some(p => !ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p))) {
            throw new Error("[tagged] 对象字面量只支持 { x: v } / { x } 形式（方法/访问器/计算属性名不支持）");
        }
        const hasComputedKey = e.properties.some(p => ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name));
        const NF = e.properties.length;
        // 字段偏移用全局 fieldMap（名→固定偏移，POJO 隐式形状）：与读取端 _fieldIndex 一致。
        // 分配 size = 最大字段字节偏移 + 8（偏移 0 保留给 __cls 头，POJO 留 0 亦无害）。
        for (const p of e.properties) this._fieldIndex(p.name.text);   // 字段已在预登记表中
        const size = this._instSize();   // 统一容量：所有字段名皆可写（支持运行期新增字段），未赋值槽 = undefined
        emitBumpAlloc(this.m, () => this.m.i32Const(size));   // → offset(i32)（越界 trap）
        this.m.i64ExtendI32U(); this.m.i64ConstBits(0, 0x7ff90000); this.m.i64Or();   // 句柄 = 高16位0x7FF9 | offset(低32)
        const slot = this.objBase + this._objDepth;   // 本层句柄槽（嵌套各占一层，避免内层覆盖）
        this._objDepth++;
        this.m.localSet(slot);                        // 句柄 → slot（i64）
        // 头：[0]=clsId(0=非实例)、[4]=size；槽 [8,size) 全写 undefined 句柄（未赋值字段 = undefined）
        this.m.localGet(slot); this.m.i32WrapI64(); this.m.i32Const(0); this.m.i32Store(2, 0);
        this.m.localGet(slot); this.m.i32WrapI64(); this.m.i32Const(size); this.m.i32Store(2, 4);
        // 块头 kind = K_POJO：让 qzs_rc_dec 知道槽 [8, size) 每 8 字节是一个子句柄，可级联。
        this.m.localGet(slot); this.m.i32WrapI64(); this.m.i32Const(RC_HDR); this.m.i32Sub();
        this.m.i32Const(K_POJO); this.m.i32Store(2, 8);
        this.m.localGet(slot); this.m.i32WrapI64(); this._emitFillUndef(size);
        for (let i = 0; i < NF; i++) {
            const p = e.properties[i];
            if (ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name)) {
                // {[k]: v}：运行期键 → 宿主按名写入（预登记槽命中走内存，未命中进 extras）
                if (this.usesKeyOrder) { this.m.localGet(slot); this.emitTaggedExpr(p.name.expression); this.m.call("qz.field_order"); }
                this.m.localGet(slot);
                this.emitTaggedExpr(p.name.expression);
                this.emitTaggedExpr(p.initializer);
                this.m.call("qz.set_index");
                continue;
            }
            this.m.localGet(slot);                    // [h]
            this.m.i32WrapI64();                      // 低32位=offset
            this.emitTaggedExpr(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer);   // 简写 {x} ≡ {x: x}
            this.m.i64Store(3, this._fieldIndex(p.name.text));   // memory[off + 字段字节偏移] = val
            if (this.usesKeyOrder && hasComputedKey) {   // 含计算键时逐属性按**源码序**登记（否则计算键会被批量登记挤到最前）
                this.m.localGet(slot); this._emitStrLitHandle(p.name.text); this.m.call("qz.field_order");
            }
        }
        if (this.usesKeyOrder && !hasComputedKey) {    // 插入序：字面量名序（编译期常量，一次登记；含计算键时已逐属性登记）
            const nmList = e.properties.map(p => (p.name && p.name.text ? p.name.text : "")).filter(x => x !== "");
            if (nmList.length) { this.m.localGet(slot); this.m.i32Const(this._strId(nmList.join("\u0000"))); this.m.call("qz.field_order_lit"); }
        }
        this.m.localGet(slot);
        this._objDepth--;
        return;
    }
    if (ts.isArrayLiteralExpression(e)) {
        const Mt = this.m, t = this._expEnter();   // headerOff 须存活于元素（可含嵌套字面量）求值
        if (e.elements.some(el => ts.isSpreadElement(el))) {
            // [..a, x] → ([] concat a) concat [x]；concat 由宿主 doArrMethod 处理（返回新数组句柄）
            this.emitTaggedExpr(ts.factory.createArrayLiteralExpression([])); Mt.localSet(t.v);
            for (const el of e.elements) {
                if (ts.isSpreadElement(el)) {                         // [...x]：迭代协议（数组/字符串/迭代器/Map/Set）
                    Mt.localGet(t.v); this.emitTaggedExpr(el.expression); Mt.call("qz.spread_into"); Mt.localSet(t.v);
                    continue;
                }
                Mt.localGet(t.v);                                     // [..a, x]：把单元素数组 concat 进去
                Mt.i32Const(this._strId("concat"));
                this.emitTaggedExpr(ts.factory.createArrayLiteralExpression([el]));
                this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                this._emitUndefined();   // ovf（实参 4..；当前恒 undefined，>4 形参支持后由调用点传入）
                Mt.call("qz.method_call");
                Mt.localSet(t.v);
            }
            Mt.localGet(t.v);
            this._expLeave();
            return;
        }
        // 数组：稳定句柄布局 header(16B: len,cap,dataOff,pad) + data 块(elem i64×N)。
        // 句柄 = 0x7FFB|headerOff；push 增长只换 data 块、句柄不变（支持别名/传参/属性）。
        const N = e.elements.length;
        const total = 16 + N * 8;
        emitBumpAlloc(this.m, () => this.m.i32Const(total));   // → headerOff(i32)（越界 trap）
        Mt.localSet(t.a);
        Mt.localGet(t.a); Mt.i32Const(N); Mt.i32Store(2, 0);    // len
        Mt.localGet(t.a); Mt.i32Const(N); Mt.i32Store(2, 4);    // cap
        Mt.localGet(t.a); Mt.localGet(t.a); Mt.i32Const(16); Mt.i32Add(); Mt.i32Store(2, 8);   // dataOff = off+16
        /* 块头 kind/nslots：**必须**写，否则 GC 视此块为无子引用（K_PLAIN），
         * 数组元素持有的对象会被判不可达而回收 → 用-after-free（实测：keep=[{v:99},5] 后
         * gc 报 freed=48，正是那个 {v:99}）。块头 = headerOff - RC_HDR。 */
        Mt.localGet(t.a); Mt.i32Const(RC_HDR); Mt.i32Sub(); Mt.i32Const(K_ARR); Mt.i32Store(2, 8);
        Mt.localGet(t.a); Mt.i32Const(RC_HDR); Mt.i32Sub(); Mt.i32Const(N); Mt.i32Store(2, 12);
        for (let i = 0; i < N; i++) {
            Mt.localGet(t.a); Mt.i32Load(2, 8);            // dataOff
            if (ts.isOmittedExpression(e.elements[i])) Mt.i64ConstBits(2, 0x7ff90000);   // [1,,3] → 洞
            else this.emitTaggedExpr(e.elements[i]);
            Mt.i64Store(3, i * 8);
        }
        Mt.localGet(t.a); Mt.i64ExtendI32U();
        Mt.i64ConstBits(0, 0x7ffb0000); Mt.i64Or();               // 句柄
        this._expLeave();
        return;
    }
    // 可选链 `o?.x` / `o?.[i]` / `o?.length`：base 求值一次 → 若 null/undefined 则结果 undefined（短路，不求 index），否则按普通访问。
    if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && e.questionDotToken) {
        const M = this.m;
        this.emitTaggedExpr(e.expression); M.localSet(this.scratchObj);
        M.localGet(this.scratchObj); M.call("qz.is_nullish");
        M.ifBlock("i64");
        this._emitUndefined();
        M.else_();
        if (ts.isPropertyAccessExpression(e)) {
            if (e.name.text === "length") this._emitLengthOf(this.scratchObj);
            else this._emitPropReadFromLocal(this.scratchObj, e.name.text);
        } else {
            this._emitElemOf(this.scratchObj, e.argumentExpression);
        }
        M.end();
        return;
    }
    // 内建全局成员读（非调用）：Math.PI / Number.MAX_SAFE_INTEGER / … → qz.builtin（常量表）
    // TS enum：Color.Red → 编译期值；Color[0] → 反向成员名（字符串枚举无反向映射 → undefined）
    if (this.enums && ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && this.enums.has(e.expression.text)) {
        const en = this.enums.get(e.expression.text);
        if (!en.fwd.has(e.name.text)) throw new Error(`[tagged] enum ${e.expression.text} 无成员 ${e.name.text}`);
        const v = en.fwd.get(e.name.text);
        if (typeof v === "string") this._emitStrLitHandle(v); else this.m.i64ConstBits(...f64Bits(v));
        return;
    }
    if (this.enums && ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && this.enums.has(e.expression.text)
        && (ts.isNumericLiteral(e.argumentExpression) || ts.isStringLiteral(e.argumentExpression))) {
        const en = this.enums.get(e.expression.text);
        const k = e.argumentExpression.text;
        const nm = en.rev.get(k);
        if (nm === undefined) this._emitUndefined(); else this._emitStrLitHandle(nm);
        return;
    }
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && ts.isIdentifier(e.expression)
        && BUILTIN_GLOBALS.has(e.expression.text)) {
        // 常量（Math.PI）→ 值；函数（Math.expm1 / JSON.stringify）→ 宿主函数句柄（truthy、typeof function）
        this.m.i32Const(this._strId(e.expression.text + "." + e.name.text));
        this.m.call("qz.builtin_member");
        return;
    }
    if (ts.isElementAccessExpression(e)) {
        const sk0 = this._symKeyName(e.argumentExpression);
        if (sk0) {                                            // o[Symbol.iterator] ≡ o["@@iterator"]
            const ts2 = this._expEnter();
            this.emitTaggedExpr(e.expression); ts2 && this.m.localSet(ts2.v);
            this._emitPropReadFromLocal(ts2.v, sk0);
            this._expLeave();
            return;
        }
        // o[k]：字符串键（动态）→ 宿主 qz.get_index（POJO 按字段名表 / 宿主对象按索引）；
        //       数值键 → wasm 内存快路径（数组 dataOff + i*8）。
        const Mi = this.m, t = this._expEnter();
        this.emitTaggedExpr(e.expression); Mi.localSet(t.v);
        this._emitElemOf(t.v, e.argumentExpression);
        this._expLeave();
        return;
    }
    // 类静态字段 C.x（C 为已收集类名）→ 确保静态已初始化 + 宿主 static_get
    // 私有成员访问 this.#v / obj.#m()：名字按「当前类」限定（JS 私有名仅同类可访问）
    if (ts.isPropertyAccessExpression(e) && ts.isPrivateIdentifier(e.name) && this._curClass && !this._isClassName(e.expression)) {   // 类名接收者（P.#s）→ 走静态路径
        const pn = "#" + this._curClass + "#" + e.name.text;
        const c = this.classes.get(this._curClass);
        if (c && (c.methods || []).some(m => m.name === pn)) {   // 私有方法：同名按类名限定
            this._emitDynMethod(e.expression, pn, []);
            return;
        }
        const tp = this._expEnter();                              // 私有字段：类名限定名读字段槽
        this.emitTaggedExpr(e.expression); this.m.localSet(tp.v);
        this._emitPropReadFromLocal(tp.v, pn);
        this._expLeave();
        return;
    }
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && this._inStaticMethod && !this._inStaticInit && ts.isThis(e.expression)) {
        // this.x 于静态方法内：接收者为运行时代（B.describe() 继承自 A 时 this = B）→ 宿主沿句柄 __qzClsId 的原型链查静态字段
        this._emitThisReceiver();
        this.m.i32Const(this._strId(e.name.text));
        this.m.call("qz.static_get_dyn");
        return;
    }
    if (ts.isPropertyAccessExpression(e) && !e.questionDotToken && this._isClassName(e.expression)) {
        const cn = this._classOfExpr(e.expression);
        const got = this._findStaticAccessor(cn, e.name.text, "get");
        if (got && got.acc) this._checkStaticThis(got.cname, cn, got.acc, e.name.text);
        if (got) {                                            // 静态 getter（含继承）→ 直调 __sm_<owner>$<name>
            this._emitStaticsGuard(got.cname);
            this._emitClassValue(this.classes.get(cn));   // self = 接收者类（子类调用父 getter 时 this = 子类）
            for (let i = 0; i < 4; i++) this._emitUndefined();
            this.m.call(staticMethName(got.cname, got.acc.name));
            return;
        }
        if (e.name.text === "prototype") {                     // C.prototype → 类对象上的 prototype（JS 语义）
            this.m.i32Const(this.classes.get(cn).id); this.m.call("qz.class_value");
            this.m.i32Const(this._strId("prototype")); this.m.call("qz.prop_get");
            return;
        }
        // 静态字段可继承/可被派生类遮蔽：先初始化父链各层，再**运行时**从当前类向上找持有者
        const chain = [];
        for (let x = cn; x; x = this.classes.get(x).parent) chain.push(x);
        for (const x of chain.slice().reverse()) this._emitStaticsGuard(x);
        const M3 = this.m, ts2 = this._expEnter();
        M3.i32Const(this.classes.get(cn).id); M3.call("qz.class_value"); M3.i32Const(this._strId(e.name.text)); M3.call("qz.prop_get"); M3.localSet(ts2.v);   // 初值 = 类对象属性（.name/.toString/prototype…），静态字段叠加上覆
        for (const x of chain.slice().reverse()) {          // 父 → 子：越派生越后写（遮蔽父类同名字段）
            M3.i32Const(this._strId(x)); M3.i32Const(this._strId(this._staticKey(x, e.name))); M3.call("qz.statics_has");   // 私有静态字段需类名限定
            M3.ifBlock("void");
            M3.i32Const(this._strId(x)); M3.i32Const(this._strId(this._staticKey(x, e.name))); M3.call("qz.static_get");
            M3.localSet(ts2.v);
            M3.end();
        }
        M3.localGet(ts2.v);
        this._expLeave();
        return;
    }
    if (ts.isPropertyAccessExpression(e) && ts.isSuperKeyword(e.expression)) {
        // super.v：父类 getter → 调之；否则按字段偏移直读（父类字段与子类共用同一 fieldMap 偏移）
        const parent = this._curClassObj && this._curClassObj.parent;
        if (!parent) throw new Error("[tagged] super.<prop> 仅在派生类方法内可用");
        // 实例访问器：沿父链找 get
        let owner = parent, acc = null;
        while (owner && !acc) {
            const cl = this.classes.get(owner);
            acc = (cl.methods || []).find(m => m.accessor === "get" && m.name === e.name.text) || null;
            if (!acc) owner = cl.parent;
        }
        if (acc) { this._emitThisReceiver(); for (let i = 0; i < 4; i++) this._emitUndefined(); this.m.call(methName(owner, acc.name)); return; }
        this._emitThisReceiver(); this.m.i32WrapI64(); this.m.i64Load(3, this._fieldIndex(e.name.text));
        return;
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "length") {
        // .length：字符串(0x7FFA) → qzs_utf16len（UTF-16 码元数，非 UTF-8 字节数："你好".length=2）；
        //   数组(0x7FFB) → 结构首 i32（元素数）；其余 → qz.str_len（跨界，罕见）。
        this.emitTaggedExpr(e.expression);
        this.m.localSet(this.scratch);
        this.m.localGet(this.scratch); this.m.i64Const(48n); this.m.i64ShrU();
        this.m.i64Const(0x7ffan); this.m.i64Eq();
        this.m.ifBlock("i64");
        this.m.localGet(this.scratch); this.m.i32WrapI64(); this.m.call("qzs_utf16len");
        this.m.f64ConvertI32U(); this.m.i64ReinterpretF64();
        this.m.else_();
        this.m.localGet(this.scratch); this.m.i64Const(48n); this.m.i64ShrU();
        this.m.i64Const(0x7ffbn); this.m.i64Eq();
        this.m.ifBlock("i64");
        this.m.localGet(this.scratch); this.m.i32WrapI64(); this.m.i32Load(2, 0);
        this.m.f64ConvertI32U(); this.m.i64ReinterpretF64();
        this.m.else_();
        // 其余（POJO/实例/宿主对象/闭包值）：走宿主属性读取（此前一律 qz.str_len → 读内存当字符串长度，静默错值）
        this.m.localGet(this.scratch); this.m.i32Const(this._strId("length")); this.m.call("qz.prop_get");
        this.m.end(); this.m.end();
        return;
    }
    if (ts.isPropertyAccessExpression(e)) {
        // `ns.member`（命名空间导入成员作值，如 `util.codePointLength`、`util.esc`）：
        // 解析为目标顶层名后按普通标识符读（局部/捕获/模块级/顶层函数值），
        // 与 stripModuleSyntax 的改写规则一致。否则会落到下面读 e.expression=命名空间名 → 未定义捕获变量。
        if (ts.isIdentifier(e.expression)) {
            const nsResolved = this._nsMember(e.expression.text, e.name.text);
            if (nsResolved !== undefined) { this.emitTaggedExpr(ts.factory.createIdentifier(nsResolved)); return; }
        }
        const M = this.m, t = this._expEnter();
        // obj.a：宿主对象(0x7FFD) → qz.object_get；POJO(0x7FF9|off≥8)/类实例(0x7FFE|off)
        this.emitTaggedExpr(e.expression); M.localSet(t.v);
        this._emitPropReadFromLocal(t.v, e.name.text);
        this._emitErrCheck();          // undefined/null 读属性 → TypeError（转入本函数 catch）
        this._expLeave();
        return;
    }
    if (ts.isNewExpression(e) && e.arguments.some(a => ts.isSpreadElement(a))) {
        const M = this.m, t = this._expEnter();
        const lit = ts.factory.createArrayLiteralExpression(e.arguments);
        lit.pos = e.pos; lit.end = e.end;
        this.emitTaggedExpr(lit); M.localSet(t.y);                       // 实参数组（受保护）
        this._emitNewCall({ expression: e.expression, arguments: [] }, (i) => this._emitElemOf(t.y, ts.factory.createNumericLiteral(i)));
        this._expLeave();
        return;
    }
    if (ts.isNewExpression(e)) { this._emitNewCall(e); return; }
    if (ts.isCallExpression(e) && e.questionDotToken) {
        const M = this.m, t = this._expEnter();
        this.emitTaggedExpr(e.expression); M.localSet(t.v);        // 被调值（只求值一次）
        M.localGet(t.v); M.call("qz.is_nullish");
        M.ifBlock("i64");
        this._emitUndefined();
        M.else_();
        M.localGet(t.v);
        for (let i = 0; i < 4; i++) { if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined(); }
        this._emitUndefined();                                    // 第 6 参（溢出实参）：可选调用不打包
        this._emitUndefined();                                    // 第 7 参（recv）
        M.call("qz.call_value");
        this._emitErrCheck();
        M.end();
        this._expLeave();
        return;
    }
    if (ts.isCallExpression(e) && ts.isSuperKeyword(e.expression)) {
        if (!this._curClassObj) throw new Error("[tagged] super() 仅在构造器内可用");
        const par = this._curClassObj.parent;
        if (par && !this.classes.has(par)) {                  // 父类为内建（Error 族…）→ 写 message/name 字段
            const M2 = this.m;
            M2.localGet(0); M2.i32WrapI64();
            if (e.arguments && e.arguments.length) this.emitTaggedExpr(e.arguments[0]); else this._emitUndefined();
            M2.i64Store(3, this._fieldIndex("message"));
            M2.localGet(0); M2.i32WrapI64(); this._emitStrLitHandle(par);
            M2.i64Store(3, this._fieldIndex("name"));
            this._emitFieldDefaults(this._curClassObj);
            return;
        }
        this._emitSuperCall(this._curClassObj, e.arguments || []); return;
    }
    // super.m(args)：父类方法**静态**直调（继承链编译期已知 → 无虚派发，与 JS super 语义一致）
    if (ts.isPropertyAccessExpression(e) && ts.isSuperKeyword(e.expression)) {
        // super.v：父类 getter → 调之；否则按字段偏移直读（父类字段与子类共用同一 fieldMap 偏移）
        const parent = this._curClassObj && this._curClassObj.parent;
        if (!parent) throw new Error("[tagged] super.<prop> 仅在派生类方法内可用");
        // 实例访问器：沿父链找 get
        let owner = parent, acc = null;
        while (owner && !acc) {
            const cl = this.classes.get(owner);
            acc = (cl.methods || []).find(m => m.accessor === "get" && m.name === e.name.text) || null;
            if (!acc) owner = cl.parent;
        }
        if (acc) { this._emitThisReceiver(); for (let i = 0; i < 4; i++) this._emitUndefined(); this.m.call(methName(owner, acc.name)); return; }
        this._emitThisReceiver(); this.m.i32WrapI64(); this.m.i64Load(3, this._fieldIndex(e.name.text));
        return;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)
        && ts.isSuperKeyword(e.expression.expression)) {
        const owner = this._curClassObj && this._curClassObj.parent;
        const method = e.expression.name.text;
        if (!this._curClassObj && this._inLitMethod) {          // 对象字面量方法内的 super.m(args)：运行时解析（宿主走 receiver 的原型链，this = receiver）
            const M4 = this.m;
            this._emitThisReceiver();
            M4.i32Const(this._strId(method));
            for (let i = 0; i < 4; i++) {
                if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
            }
            this._emitUndefined();   // ovf：>4 实参暂不打包（对象字面量 super 调用的窄面）
            M4.call("qz.super_method");
            this._emitErrCheck();
            return;
        }
        let c = owner, isStaticM = false;
        while (c) {                                          // 父链上查实例方法，其次静态方法（static super.m()）
            const cl = this.classes.get(c);
            if ((cl.methods || []).some(m => m.name === method)) { isStaticM = false; break; }
            if ((cl.staticMethods || []).some(m => m.name === method)) { isStaticM = true; break; }
            c = cl.parent;
        }
        if (!c) throw new Error(`[tagged] super.${method}() 在父类链上未定义`);
        if (isStaticM) {                                     // 静态父方法：self = 当前 self 槽（super 静态调用保持原接收者）
            this._emitStaticsGuard(c);
            this.m.localGet(0);
            for (let i = 0; i < 4; i++) {
                if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
            }
            this.m.call(staticMethName(c, method));
            return;
        }
        this._emitThisReceiver();                            // self = this（闭包内 this 走捕获/形参槽，local0 是 blk）
        for (let i = 0; i < 4; i++) {
            if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
        }
        this.m.call(methName(c, method));
        return;
    }
    // 调用实参含展开 f(...a, x)：wasm 静态元数无法承载 → 实参先构造成数组，宿主按名/闭包动态派发
    // 内建全局/成员调用 >4 实参（Object.assign(a,b,c,d,e)）同样走此路径：宿主 builtin_spread 全量透传（直接路径只有 4 个实参槽）
    if (ts.isCallExpression(e) && (e.arguments.some(a => ts.isSpreadElement(a))
        || (e.arguments.length > 4 && ((ts.isIdentifier(e.expression) && BUILTIN_GLOBALS.has(e.expression.text))
            || (ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && BUILTIN_GLOBALS.has(e.expression.expression.text)))))) {
        this._emitSpreadCall(e);
        return;
    }
    if (ts.isCallExpression(e)) {
        if (ts.isPropertyAccessExpression(e.expression)) {
            // 内建全局成员调用 Math.floor(x) / JSON.stringify(x) / Object.keys(o) → qz.builtin
            if (ts.isIdentifier(e.expression.expression) && BUILTIN_GLOBALS.has(e.expression.expression.text)) {
                this._emitBuiltinCall(e.expression.expression.text + "." + e.expression.name.text, e.arguments); return;
            }
            const rx = e.expression.expression, method = e.expression.name.text;
            // 命名空间成员 `ns.foo(...)`：解析为目标顶层函数直调（非动态方法派发）。
            if (ts.isIdentifier(rx)) {
                const resolved = this._nsMember(rx.text, method);
                if (resolved !== undefined) {
                    // 命名空间里有值成员是 const 箭头函数（`export const f = (…) => …`）：
                    // 展平后是模块级全局持闭包，没有 _funcIdx → 取全局值后走值调用。
                    if (this.m._funcIdx[this._fnName(resolved)] === undefined) {
                        this._emitClosureCall(resolved, e.arguments);
                        return;
                    }
                    const cn = this._calleeInfo(resolved);
                    const xn = cn && cn.mode !== this.mode;
                    for (const a of e.arguments) { this.emitTaggedExpr(a); if (xn) this._argToCallee(resolved); }
                    this.m.call(this._fnName(resolved));
                    this._retFromCallee(resolved); return;
                }
            }
            // 类静态方法优先：C.push/C.pop 等与数组方法同名，不能走数组快路径
            if (this._isClassName(rx)) { this._emitDynMethod(rx, method, e.arguments); return; }
            // 多参变参数组方法（push/unshift/splice/concat 超 4 参）：实参合成数组 → 宿主 arr_apply
            if (["push", "unshift", "splice"].includes(method) && e.arguments.length > 1) {   // concat 双份（字符串/数组）→ 仍走宿主 method_call
                const M = this.m, t = this._expEnter();
                this.emitTaggedExpr(rx); M.localSet(t.v);
                const lit = ts.factory.createArrayLiteralExpression(e.arguments);
                lit.pos = e.pos; lit.end = e.end;
                this.emitTaggedExpr(lit); M.localSet(t.w);
                M.localGet(t.v); M.i32Const(this._strId(method)); M.localGet(t.w); M.call("qz.arr_apply");
                this._expLeave();
                return;
            }
            // push/pop 快路径：运行时守卫——仅接收者为 wasm 数组(0x7FFB)时走内存直写；
            // 否则退回通用方法派发（对象字面量/类实例的同名 push/pop 方法此前被误判 → 静默错值）。
            if ((method === "push" && e.arguments.length === 1) || (method === "pop" && e.arguments.length === 0)) {
                const Mg = this.m, tg = this._expEnter();
                this.emitTaggedExpr(rx); Mg.localSet(tg.v);                 // 接收者只求值一次
                Mg.localGet(tg.v); Mg.i64Const(48n); Mg.i64ShrU(); Mg.i64Const(0x7ffbn); Mg.i64Eq();
                Mg.ifBlock("i64");
                this.depth++;                       // 守卫的 if 块也要计入 br 深度（分支内含 errCheck/短路等 br）
                if (method === "push") this._emitArrayPush(rx, e.arguments[0], tg.v); else this._emitArrayPop(rx, tg.v);
                Mg.else_();
                this._emitDynMethod(rx, method, e.arguments);
                Mg.end();
                this.depth--;
                this._expLeave();
                return;
            }
            this._emitDynMethod(rx, method, e.arguments); return;
        }
        // IIFE（(() => 42)() / 函数表达式立即调用）：先求值为闭包句柄 → closure_call
        if (ts.isParenthesizedExpression(e.expression)
            && (ts.isArrowFunction(e.expression.expression) || ts.isFunctionExpression(e.expression.expression))) {
            const M2 = this.m, t2 = this._expEnter();
            const inner = e.expression.expression;
            this.emitTaggedExpr(e.expression); M2.localSet(t2.v);
            M2.localGet(t2.v);
            for (let i = 0; i < 4; i++) {
                if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
            }
            if (inner.parameters.length > 4 || e.arguments.length > 4) {   // 溢出实参 → 第 6 参（call_value）
                const ovfI = e.arguments.slice(3);
                const litI = ts.factory.createArrayLiteralExpression(ovfI);
                litI.pos = e.pos; litI.end = e.end;
                this.emitTaggedExpr(litI);
                this._emitUndefined();                                    // 第 7 参（recv）
                M2.call("qz.call_value");
            } else { this._emitUndefined(); M2.call("qz.closure_call"); }   // recv（普通调用 = undefined）
            this._emitErrCheck();
            this._expLeave();
            return;
        }
        if (ts.isElementAccessExpression(e.expression)) {
            const sk1 = this._symKeyName(e.expression.argumentExpression);
            if (sk1) { this._emitDynMethod(e.expression.expression, sk1, e.arguments); return; }   // o[Symbol.x](…) ≡ o["@@x"](…)
        }
        if (!ts.isIdentifier(e.expression)) {
            // `obj.f(...)`：f 是属性值（方法简写/具名函数表达式都是闭包值）→ 传 obj 作 receiver，
            // 否则闭包体里的 `this` 无法绑定（zod：`parse: function _parse(){ …this… }`）。
            const recvV = ts.isPropertyAccessExpression(e.expression) ? e.expression.expression : undefined;
            this._emitValueCall(e.expression, e.arguments, recvV);   // 值调用：宿主按句柄类型分派（闭包/宿主函数）
            return;
        }
        const fn = e.expression.text;
        // 内建全局函数调用 String(x) / parseInt(s) / isNaN(x) / JSON… → qz.builtin
        if (BUILTIN_GLOBALS.has(fn)) { this._emitBuiltinCall(fn, e.arguments); return; }
        {   // 自递归直调：本 lambda 调自身 → 直接 call 自己的 wasm 函数（不经 closure_call，省宿主栈）
            const S = this._lamSelf;
            if (S && S.name === fn && !S.rest && S.n <= 4 && e.arguments.length <= 4 && !e.arguments.some((a2) => ts.isSpreadElement(a2))) {
                const M2 = this.m;
                M2.localGet(0);                          // blk（i32）
                for (let i = 0; i < S.n; i++) { if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined(); }
                M2.call(S.fname);
                const ciS = this._calleeInfo(S.name);
                if (ciS && ciS.void) this._emitUndefined();   // void 自递归无返回值 → 补 undefined 保持一值
                this._emitErrCheck();
                return;
            }
        }
        // JS 作用域：局部/捕获名遮蔽同名顶层函数（如参数 g 遮蔽顶层 g）→ 优先按闭包处理
        if (this.capMap.has(fn) || this._local(fn) !== undefined) {
            this._emitClosureCall(fn, e.arguments);
            return;
        }
        if (this.m._funcIdx[this._fnName(fn)] === undefined) {
            // 没有对应的 wasm 函数 → 名字持有闭包值：closure_call(handle, a0..a3)。
            // 句柄来源：本层局部变量、**捕获**，或模块级 const（含跨文件导入的模块级闭包
            // `export const makeIssue = (...) => ...` —— 导入名在 fnNames 里但没有 _funcIdx，
            // 直调会撞 wasm-encoder 的「call 未定义」）。
            this._emitClosureCall(fn, e.arguments);
            return;
        }
        const ct = this._calleeInfo(fn);
        const xt = ct && ct.mode !== this.mode;
        // JS 元数语义：实参多于形参 → 被调函数只见前 nPar 个；少于 → 余下为 undefined。
        // num 模式被调函数（f64 ABI）无法表示 undefined → 少传直接报错（loud），不静默补 0。
        const nPar = (this._fnParams && this._fnParams.get(this._fnName(fn))) ?? e.arguments.length;
        const calleeNum = !!ct && ct.mode === "num";
        if (calleeNum && e.arguments.length < nPar) {
            throw new Error(`[tagged] num 函数 ${fn} 需 ${nPar} 个实参（JS 少传 → undefined 无法在 f64 ABI 表示）`);
        }
        const calleeParams = !calleeNum ? (this._calleeParams(fn) || this._calleeParams(this._fnName(fn))) : null;
        if (calleeParams && calleeParams.length === nPar && calleeParams.some(p => p.dotDotDotToken && p === calleeParams[nPar - 1])) {
            this._emitCallArgs(calleeParams, e.arguments, fn);       // rest 收尾：打包余下实参
        } else {
            const nPass = calleeNum ? e.arguments.length : nPar;
            for (let i = 0; i < nPass; i++) {
                if (i < e.arguments.length) { this.emitTaggedExpr(e.arguments[i]); if (xt) this._argToCallee(fn); }
                else this._emitUndefined();
            }
        }
        if (this._fnArgs && this._fnArgs.has(this._fnName(fn)) && this._argGlobal !== undefined
            && !e.arguments.some(a2 => ts.isSpreadElement(a2))) {   // 被调需要 arguments：构造全量实参数组写入 __args
            const litA = ts.factory.createArrayLiteralExpression(e.arguments);
            litA.pos = e.pos; litA.end = e.end;
            this.emitTaggedExpr(litA);
            this.m.globalSet(this._argGlobal);
        }
        this.m.call(this._fnName(fn));
        this._retFromCallee(fn);
        if (ct && ct.void) this._emitUndefined();                 // void 被调：tagged 表达式恒出一值（语义 undefined）
        this._emitErrCheck();
        return;
    }
    if (ts.isConditionalExpression(e)) {                                                     // a ? b : c
        this.emitCondI32(e.condition);
        this.m.ifBlock("i64");
        this.emitTaggedExpr(e.whenTrue);
        this.m.else_();
        this.emitTaggedExpr(e.whenFalse);
        this.m.end();
        return;
    }
    if (ts.isVoidExpression(e)) { this.emitTaggedExpr(e.expression); this.m.drop(); this._emitUndefined(); return; }   // void x → undefined（求值副作用，丢弃值）
    if (ts.isDeleteExpression(e)) {
        // delete obj.k：宿主对象(0x7FFD) → qz.object_delete；POJO → 槽写 undefined sentinel（等价删除）。返回 true。
        const M = this.m;
        const op = e.expression;
        const t = this._expEnter();
        this.emitTaggedExpr(op.expression); M.localSet(t.v);
        if (ts.isElementAccessExpression(op)) {          // delete o[k] / delete a[i] → 宿主按 tag 删除
            this.emitTaggedExpr(op.argumentExpression); M.localSet(t.w);
            M.localGet(t.v); M.localGet(t.w); M.call("qz.delete_index");
            M.drop();
        } else if (ts.isPropertyAccessExpression(op)) {
            // delete obj.k：宿主对象真删（原型可透出）；POJO/实例槽置 undefined（等价删除）——统一由 prop_delete 处理
            M.localGet(t.v); M.i32Const(this._strId(op.name.text)); M.call("qz.prop_delete");
            if (this.usesKeyOrder) { M.localGet(t.v); this._emitStrLitHandle(op.name.text); M.call("qz.field_order_del"); }   // 插入序名单同步移除
            this._emitErrCheck(false);
        } else throw new Error("[tagged] delete 仅支持属性/下标（delete obj.k / delete a[i]）");
        this._expLeave();
        M.i64ConstBits(1, 0x7ffc0000);   // true（tagged bool）
        return;
    }
    if (ts.isPrefixUnaryExpression(e)) {
        if (e.operator === ts.SyntaxKind.PlusPlusToken || e.operator === ts.SyntaxKind.MinusMinusToken) {
            const inc = e.operator === ts.SyntaxKind.PlusPlusToken;
            if (ts.isPropertyAccessExpression(e.operand)) {
                // ++C.n / --C.n（类静态字段）：guard → static_get ± 1 → static_set；结果=新值
                if (this._isClassName(e.operand.expression)) {
                    const cn = e.operand.expression.text, Mc = this.m;
                    this._emitStaticsGuard(cn);
                    Mc.i32Const(this._strId(cn)); Mc.i32Const(this._strId(this._staticKey(cn, e.operand.name))); Mc.call("qz.static_get");
                    Mc.i64ConstBits(...f64Bits(1));
                    this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? Mc.f64Add : Mc.f64Sub);
                    Mc.localSet(this.scratch);
                    Mc.i32Const(this._strId(cn)); Mc.i32Const(this._strId(this._staticKey(cn, e.operand.name))); Mc.localGet(this.scratch); Mc.call("qz.static_set");
                    Mc.localGet(this.scratch);
                    return;
                }
                // ++obj.a / --obj.a：接收者求值一次 → 读字段 ± 1 → 写回；结果=新值
                const off = this._fieldIndex(ts.isPrivateIdentifier(e.operand.name) && this._curClass ? "#" + this._curClass + "#" + e.operand.name.text : e.operand.name.text);
                this.emitTaggedExpr(e.operand.expression);
                this.m.localSet(this.scratchObj);
                this.m.localGet(this.scratchObj); this.m.i32Const(this._strId(ts.isPrivateIdentifier(e.operand.name) && this._curClass ? "#" + this._curClass + "#" + e.operand.name.text : e.operand.name.text)); this.m.call("qz.prop_get");
                this.m.i64ConstBits(...f64Bits(1));
                this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? this.m.f64Add : this.m.f64Sub);
                this.m.localSet(this.scratch);
                {   // 宿主对象(0x7FFD) → qz.prop_set（对象字面量方法里的 this.x++）；否则写内存字段
                    const M2 = this.m, t2 = this._expEnter();
                    M2.localGet(this.scratchObj); M2.localSet(t2.v);
                    M2.localGet(t2.v); M2.i64Const(48n); M2.i64ShrU(); M2.i64Const(0x7ffdn); M2.i64Eq();
                    M2.ifBlock("void");
                    M2.localGet(t2.v); M2.i32Const(this._strId(e.operand.name.text)); M2.localGet(this.scratch); M2.call("qz.prop_set");
                    this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
                    M2.else_();
                    M2.localGet(t2.v); M2.i32WrapI64(); M2.localGet(this.scratch); M2.i64Store(3, off);
                    M2.end();
                    this._expLeave();
                }
                this.m.localGet(this.scratch);   // 表达式结果=新值
                return;
            }
            // ++x / --x：x = x ± 1，返回新值（含闭包捕获变量）
            this._emitVarGet(e.operand.text);
            this.m.i64ConstBits(...f64Bits(1));
            this.emitGuardedOp(e.operator === ts.SyntaxKind.PlusPlusToken ? "qz.add" : "qz.sub",
                               e.operator === ts.SyntaxKind.PlusPlusToken ? this.m.f64Add : this.m.f64Sub);
            this._emitVarStore(e.operand.text, this.scratchB);   // 写回 + 新值留栈（表达式结果）
            return;
        }
        this.emitTaggedExpr(e.operand);
        if (e.operator === ts.SyntaxKind.ExclamationToken) {
            this.m.call("qz.truthy"); this.m.i32Eqz(); this.emitBoxBool();
        } else if (e.operator === ts.SyntaxKind.TildeToken) {
            // 双路径：BigInt → binop op 11（~x，精确位反）；其余 qz.bnot（ToInt32 语义）
            const M3 = this.m, t3 = this._expEnter();
            M3.localSet(this.scratchB);
            this._emitIsBig(this.scratchB);
            M3.ifBlock("i64");
            M3.i32Const(11); M3.localGet(this.scratchB); M3.localGet(this.scratchB);
            M3.call("qz.bigint_binop");                       // b = dummy（op 11 忽略）
            M3.else_();
            M3.localGet(this.scratchB);
            this.m.call("qz.bnot");          // ~a = ~(ToInt32(ToNumber(a)))，宿主解引用（含字符串/句柄）
            M3.end();
            this._expLeave();
        } else if (e.operator === ts.SyntaxKind.PlusToken) {
            this.m.call("qz.to_num");        // +a = ToNumber(a)
        } else if (e.operator === ts.SyntaxKind.MinusToken) {
            // 双路径：BigInt(0x7FF8) → 0n - x（binop 1，除零安全）；句柄/纯数 → 原 guard（qz.neg / f64Neg）
            const M3 = this.m, t3 = this._expEnter();
            M3.localSet(this.scratchB);
            this._emitIsBig(this.scratchB);
            M3.ifBlock("i64");
            M3.i32Const(this._strId("0")); M3.call("qz.bigint_lit"); M3.localSet(t3.w);   // zeroH
            M3.i32Const(1); M3.localGet(t3.w); M3.localGet(this.scratchB);
            M3.call("qz.bigint_binop");
            M3.else_();
            M3.localGet(this.scratchB);
            this._emitUnaryNum("qz.neg", this.m.f64Neg);   // JS：-a = -ToNumber(a)（对象走 valueOf，此前裸取反 → 静默 NaN）
            M3.end();
            this._expLeave();
        }
        return;
    }
    if (ts.isPostfixUnaryExpression(e)) {                                                    // x++ / x--（guard 命中走原生 f64）
        const inc = e.operator === ts.SyntaxKind.PlusPlusToken;
        if (ts.isPropertyAccessExpression(e.operand)) {
            // C.n++ / C.n--（类静态字段）：结果=旧值，静态槽写回 ±1
            if (this._isClassName(e.operand.expression)) {
                const cn = e.operand.expression.text, Mc = this.m;
                this._emitStaticsGuard(cn);
                Mc.i32Const(this._strId(cn)); Mc.i32Const(this._strId(this._staticKey(cn, e.operand.name))); Mc.call("qz.static_get");
                Mc.localSet(this.scratch);            // scratch=旧值（表达式结果）
                Mc.localGet(this.scratch); Mc.i64ConstBits(...f64Bits(1));
                this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? Mc.f64Add : Mc.f64Sub);
                Mc.localSet(this.scratchB);
                Mc.i32Const(this._strId(cn)); Mc.i32Const(this._strId(this._staticKey(cn, e.operand.name))); Mc.localGet(this.scratchB); Mc.call("qz.static_set");
                Mc.localGet(this.scratch);
                return;
            }
            // this.n++ / obj.a--：接收者求值一次 → 旧值留栈为结果，字段写回 ±1
            const off = this._fieldIndex(ts.isPrivateIdentifier(e.operand.name) && this._curClass ? "#" + this._curClass + "#" + e.operand.name.text : e.operand.name.text);
            this.emitTaggedExpr(e.operand.expression);
            this.m.localSet(this.scratchObj);
            this.m.localGet(this.scratchObj); this.m.i32Const(this._strId(ts.isPrivateIdentifier(e.operand.name) && this._curClass ? "#" + this._curClass + "#" + e.operand.name.text : e.operand.name.text)); this.m.call("qz.prop_get");
            this.m.localSet(this.scratch);          // scratch=旧值（表达式结果）
            this.m.localGet(this.scratch);
            this.m.i64ConstBits(...f64Bits(1));
            this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? this.m.f64Add : this.m.f64Sub);
            this.m.localSet(this.scratchB);         // scratchB=新值
            {   // 宿主对象 → qz.prop_set；否则写内存字段
                const M2 = this.m, t2 = this._expEnter();
                M2.localGet(this.scratchObj); M2.localSet(t2.v);
                M2.localGet(t2.v); M2.i64Const(48n); M2.i64ShrU(); M2.i64Const(0x7ffdn); M2.i64Eq();
                M2.ifBlock("void");
                M2.localGet(t2.v); M2.i32Const(this._strId(e.operand.name.text)); M2.localGet(this.scratchB); M2.call("qz.prop_set");
                this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
                M2.else_();
                M2.localGet(t2.v); M2.i32WrapI64(); M2.localGet(this.scratchB); M2.i64Store(3, off);
                M2.end();
                this._expLeave();
            }
            this.m.localGet(this.scratch);          // 留旧值
            return;
        }
        this._emitVarGet(e.operand.text); this.m.localSet(this.scratch);   // scratch=旧值（表达式结果）
        this._emitVarGet(e.operand.text);
        this.m.i64ConstBits(...f64Bits(1));
        this.emitGuardedOp(inc ? "qz.add" : "qz.sub", inc ? this.m.f64Add : this.m.f64Sub);
        this._emitVarStore(e.operand.text, this.scratchB);   // 写回（栈留新值）
        this.m.drop();
        this.m.localGet(this.scratch);                          // 留旧值
        return;
    }
    if (ts.isBinaryExpression(e)) { this.emitTaggedBinary(e); return; }
    if (ts.isAwaitExpression(e)) throw new Error("[tagged] await 出现在非 async 编译路径：wasm 无挂起/恢复（顶层 async 已转 interp）");
    // `new.target`（MetaProperty）：AOT 下每个 `new C(...)` 的类静态已知，构造器内
    // new.target ≡ 当前类 → 用类值句柄（`new.target.prototype` 因此得该类原型）。
    // `import.meta`：模块已内联，无运行期模块对象 → undefined。
    if (e.kind === ts.SyntaxKind.MetaProperty) {
        if (e.keywordToken === ts.SyntaxKind.NewKeyword && this._curClass && this.classes.has(this._curClass)) {
            this._emitClassValue(this.classes.get(this._curClass));
            return;
        }
        this._emitUndefined();
        return;
    }
    throw new Error("[tagged] 不支持的表达式: " + ts.SyntaxKind[e.kind]);
};
// 栈顶裸 i32 布尔 → tagged 值（i64）：f64 位型的 0.0/1.0。
// 裸 i32(0/1) → tagged bool（0x7FFC|低32=0/1）。
// 注意：不是 f64 0.0/1.0 —— bool 与 number 在 JS 中须区分（"s"+true="strue" ≠ "s1"），
// 宿主 toJS/truthy 按 0x7FFC tag 还原真布尔。与整数 0/1 i64 亦不同。
Emitter.prototype.emitBoxBool = function () {
    this.m.i64ExtendI32U(); this.m.i64ConstBits(0, 0x7ffc0000); this.m.i64Or();
};
// tagged 值 → 裸 i32 布尔（条件用）。比较二元表达式走 guard 特化：命中 number
// 走原生 f64 谓词（零跨界）；回退才调 qz.<op>。其余表达式经 qz.truthy。
const CMP_GUARD = {
    [ts.SyntaxKind.LessThanToken]: ["qz.lt", "f64Lt"],
    [ts.SyntaxKind.GreaterThanToken]: ["qz.gt", "f64Gt"],
    [ts.SyntaxKind.LessThanEqualsToken]: ["qz.le", "f64Le"],
    [ts.SyntaxKind.GreaterThanEqualsToken]: ["qz.ge", "f64Ge"],
    [ts.SyntaxKind.EqualsEqualsToken]: ["qz.eq", "f64Eq"],
    [ts.SyntaxKind.EqualsEqualsEqualsToken]: ["qz.seq", "f64Eq"],
    [ts.SyntaxKind.ExclamationEqualsToken]: ["qz.ne", "f64Ne"],
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: ["qz.sne", "f64Ne"],
};
// 栈顶 i64 句柄判定 → 在栈上留 i32：非「纯 f64 数值」即 true。
// 句柄标签恰好连续占满 [0x7FF8_0000_0000_0001, 0x7FFF_FFFF_FFFF_FFFF]：
//   0x7FF8 BigInt(槽) | 0x7FF9 对象 | 0x7FFA 字符串 | 0x7FFB wasm 数组 | 0x7FFC 布尔
//   0x7FFD 宿主对象 | 0x7FFE 类实例 | 0x7FFF 闭包
// 唯一坑：0x7FF8|0 是 canonical NaN（box(NaN) 的位型），必须当数值——它正好卡在区间下界前一位。
// 于是整个判定退化为一次无符号区间测试：bits - 基址 <= 跨度。负数位型（≥0x8000…）因无符号
// 减法结果越界而天然排除，无需额外分支。24+ 条指令 → 5 条。
Emitter.prototype._emitIsHandle = function (scratch) {
    const M = this.m;
    M.localGet(scratch); M.i64Const(0x7ff8_0000_0000_0001n); M.i64Sub();
    M.i64Const(0x0007_ffff_ffff_fffen); M.i64LeU();
};
// BigInt 句柄判定（0x7FF8|低32=handles 槽，槽位从 2 起）：_emitBinOp 双 BIG 前置路由用。
// 排除 0x7FF8|0 —— 那是 canonical NaN（box(NaN) 恰产此位型；BIG 槽恒 payload≠0）。
// 同样退化为无符号区间测试：BIG 位型恰好是 [0x7FF8_0000_0000_0001, 0x7FF8_FFFF_FFFF_FFFF]。
Emitter.prototype._emitIsBig = function (scratch) {
    const M = this.m;
    M.localGet(scratch); M.i64Const(0x7ff8_0000_0000_0001n); M.i64Sub();
    M.i64Const(0x0000_0000_ffff_fffen); M.i64LeU();
};
// 纯数字判定 = 非句柄(0x7FF9)/字符串(0x7FFA)/数组(0x7FFB)/布尔(0x7FFC)/实例(0x7FFE)。
// 用于 _emitConcat 区分「数值」与「须走宿主 ToPrimitive/ToNumber 的值」。
Emitter.prototype._emitIsPureNum = function (scratch) {
    const M = this.m;
    M.localGet(scratch); M.i64Const(48n); M.i64ShrU(); M.i32WrapI64(); M.localSet(this.sT[0]);   // hi16
    M.localGet(this.sT[0]); M.i32Const(0x7ff9); M.i32Eq();
    M.localGet(this.sT[0]); M.i32Const(0x7ffa); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7ffb); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7ffc); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7ffe); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7ffd); M.i32Eq(); M.i32Or();
    M.localGet(this.sT[0]); M.i32Const(0x7fff); M.i32Eq(); M.i32Or();   // 闭包值
    M.i32Eqz();
};
Emitter.prototype.emitCmpI32 = function (qzName, f64cmp) {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB);
    M.i32Or();
    M.ifBlock("i32");
    // 含句柄：回退 qz.<op>，返回 tagged bool（0x7FFC|低32=0/1）→ i32WrapI64 取低32 转 i32
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call(qzName);
    M.i32WrapI64();
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64();
    M.localGet(this.scratchB); M.f64ReinterpretI64();
    M[f64cmp]();
    M.end();
};
Emitter.prototype.emitCondI32 = function (expr) {
    if (ts.isBinaryExpression(expr) && CMP_GUARD[expr.operatorToken.kind]) {
        const [qz, f64] = CMP_GUARD[expr.operatorToken.kind];
        this.emitTaggedExpr(expr.left); this.emitTaggedExpr(expr.right);
        this.emitCmpI32(qz, f64);
        return;
    }
    this.emitTaggedExpr(expr); this.m.call("qz.truthy");
};
// guarded 数值特化：栈 [a b] → 都是 tagged number 走原生指令，否则回退 qz.* 跨界。
// 数值=原始 f64 位型，句柄=高16位 0x7FF9（对象）/0x7FFA（字符串）→ reinterpret 后原生 f64 运算（零跨界）。
// cmp=true 时 fastEmit 产出 i32 谓词（f64.lt 等），需 extend 回 i64。
// 一元数值运算 guard：句柄（对象/字符串）→ 宿主 qz.<op>；纯数值 → 内联 f64。
Emitter.prototype._emitUnaryNum = function (qzName, fastEmit) {
    const M = this.m;
    M.localSet(this.scratchB);
    this._emitIsHandle(this.scratchB);
    M.ifBlock("i64");
    M.localGet(this.scratchB); M.call(qzName);
    M.else_();
    M.localGet(this.scratchB); M.f64ReinterpretI64();
    fastEmit.call(M);
    M.i64ReinterpretF64();
    M.end();
};
Emitter.prototype.emitGuardedOp = function (qzName, fastEmit, cmp) {
    this.m.localSet(this.scratchB);
    this.m.localSet(this.scratchA);
    // guard: 任一操作数是句柄即回退 qz.*（覆盖对象 + 字符串两种句柄）
    this._emitIsHandle(this.scratchA);
    this._emitIsHandle(this.scratchB);
    this.m.i32Or();
    this.m.ifBlock("i64");
    this.m.localGet(this.scratchA); this.m.localGet(this.scratchB); this.m.call(qzName);
    this.m.else_();
    this.m.localGet(this.scratchA); this.m.f64ReinterpretI64();
    this.m.localGet(this.scratchB); this.m.f64ReinterpretI64();
    fastEmit.call(this.m);
    // cmp: 谓词产裸 i32 → tagged bool（0x7FFC|低32=0/1）；与宿主 bool() 对齐（先前 f64 0.0/1.0 与数字混淆）
    if (cmp) this.emitBoxBool(); else this.m.i64ReinterpretF64();
    this.m.end();
};

// 位运算 guard：命中双 number → f64→i32 截断 → 原生 i32 运算 → f64（JS 32 位语义）；
// 任一为句柄 → 回退 qz.<op>（宿主 JS 位运算）。unsigned（>>>）结果按无符号回 f64。
// 压入 i32：该 f64 local 是否在 i32TruncF64S 安全域（非 NaN、|x| < 2^31）。
// JS 位运算用 ToInt32/ToUint32（mod 2^32 环绕、NaN→0）；wasm i32.trunc_f64_s 会 trap，
// 故只对安全域走内联快路径，越界/NaN 交宿主（qz.bor 等已按 JS 语义 toJS|0）。
Emitter.prototype._emitInt32Safe = function (local) {
    const M = this.m;
    M.localGet(local); M.f64ReinterpretI64(); M.f64Const(2147483648); M.f64Lt();   // x < 2^31
    M.localGet(local); M.f64ReinterpretI64(); M.f64Const(-2147483648); M.f64Gt();  // x > -2^31
    M.i32And();
    M.localGet(local); M.f64ReinterpretI64(); M.localGet(local); M.f64ReinterpretI64(); M.f64Eq();   // 非 NaN
    M.i32And();
};
Emitter.prototype.emitGuardedBit = function (qzName, i32op, unsigned) {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB); M.i32Or();   // 1 个条件值
    this._emitInt32Safe(this.scratchA); M.i32Or();     // 累进合并（此前少一次合并 → 栈上多留 i32）
    this._emitInt32Safe(this.scratchB); M.i32Or();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call(qzName);
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64(); M.i32TruncF64S();
    M.localSet(this.sT[0]);
    M.localGet(this.scratchB); M.f64ReinterpretI64(); M.i32TruncF64S();
    M.localSet(this.sT[1]);
    M.localGet(this.sT[0]); M.localGet(this.sT[1]); i32op.call(M);
    unsigned ? M.f64ConvertI32U() : M.f64ConvertI32S();
    M.i64ReinterpretF64();
    M.end();
};

// % 专用 guard：命中 number 走 wasm 内 a - trunc(a/b)*b（= JS 余数语义，含负数/除零 NaN），
// 否则回退 qz.rem。f64 无原生 rem，故不复用 emitGuardedOp 的 fastEmit 模型。
Emitter.prototype.emitTaggedRem = function () {
    const M = this.m;
    M.localSet(this.scratchB); M.localSet(this.scratchA);
    this._emitIsHandle(this.scratchA); this._emitIsHandle(this.scratchB); M.i32Or();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    M.localGet(this.scratchA); M.f64ReinterpretI64(); M.localSet(this.scratchFA);
    M.localGet(this.scratchB); M.f64ReinterpretI64(); M.localSet(this.scratchFB);
    // |b|==Inf → qz.rem（宿主：x % ±Inf = x，含 NaN）
    M.localGet(this.scratchFB); M.f64Neg(); M.localGet(this.scratchFB); M.f64Max();
    M.f64Const(Infinity); M.f64Eq();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    // q = a/b；q 非有限 → qz.rem（除零、NaN、差溢出）
    M.localGet(this.scratchFA); M.localGet(this.scratchFB); M.f64Div();
    M.i64ReinterpretF64(); M.localSet(this.scratch);    // q → i64 暂存
    M.localGet(this.scratch); M.f64ReinterpretI64();
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Ne();     // qNaN
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Neg();
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Max();    // |q|
    M.f64Const(Infinity); M.f64Eq();                    // |q|==Inf
    M.i32Or();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    // r = a - b*trunc(q)
    M.localGet(this.scratchFA);
    M.localGet(this.scratchFB);
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Trunc();
    M.f64Mul(); M.f64Sub();
    // 零余数 → qz.rem（宿主保号 -0/+0）
    M.i64ReinterpretF64(); M.localSet(this.scratch);
    M.localGet(this.scratch); M.f64ReinterpretI64(); M.f64Const(0); M.f64Eq();
    M.ifBlock("i64");
    M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.rem");
    M.else_();
    M.localGet(this.scratch);
    M.end();
    M.end();
    M.end();
    M.end();
};
// 属性/索引赋值：值已在栈（i64）。注意会重新求值 receiver（读+写各一次；无副作用表达式安全）。
Emitter.prototype._emitStoreProp = function (left) {
    const M = this.m, t = this._expEnter();       // 值/接收者须存活于嵌套求值
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && this.fnNames && this.fnNames.has(left.expression.text)
        && !this.capMap.has(left.expression.text) && this._local(left.expression.text) === undefined
        && !(this.moduleGlobals && this.moduleGlobals.get(left.expression.text) !== undefined)) {
        // 顶层函数作值（宿主函数句柄）：属性写走宿主 qz.prop_set（内存快路径会写到句柄低 32 位 → 静默错/越界）
        M.localSet(t.w);                                  // 值入槽（本分支前未被保存）
        this.emitTaggedExpr(left.expression); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set");
        M.localGet(t.w);
        this._expLeave();
        return;
    }
    if (ts.isPropertyAccessExpression(left) && ts.isSuperKeyword(left.expression)) {   // super.v = x：父类 setter 优先，否则按父类字段槽直写
        const parent = this._curClassObj && this._curClassObj.parent;
        if (!parent) throw new Error("[tagged] super.<prop> 仅在派生类方法内可用");
        M.localSet(t.w);
        let owner = parent, acc = null;
        while (owner && !acc) {
            const cl = this.classes.get(owner);
            acc = (cl.methods || []).find(m => m.accessor === "set" && m.name === left.name.text) || null;
            if (!acc) owner = cl.parent;
        }
        if (acc) { this.m.localGet(0); this.m.localGet(t.w); for (let i = 0; i < 3; i++) this._emitUndefined(); this.m.call(methName(owner, acc.name + "$set")); }
        else { this.m.localGet(0); this.m.i32WrapI64(); this.m.localGet(t.w); this.m.i64Store(3, this._fieldIndex(left.name.text)); }
        this.m.localGet(t.w);
        this._expLeave();
        return;
    }
    if (ts.isPropertyAccessExpression(left) && ts.isPrivateIdentifier(left.name) && this._isClassName(left.expression)) {
        // 静态私有字段写 C.#n = v（类名接收者）→ 宿主 static_set（键 = #类名#名，与读路径 _staticKey 一致）
        const cn = this._classOfExpr(left.expression);
        M.localSet(t.w);
        this._emitStaticsGuard(cn);
        M.i32Const(this._strId(cn)); M.i32Const(this._strId(this._staticKey(cn, left.name))); M.localGet(t.w); M.call("qz.static_set");
        M.localGet(t.w);
        this._expLeave();
        return;
    }
    const privName = ts.isPrivateIdentifier(left.name) && this._curClass ? "#" + this._curClass + "#" + left.name.text : null;
    if (privName) {                               // 私有字段写：类名限定名（普通字段槽）
        M.localSet(t.w);
        this.emitTaggedExpr(left.expression); M.localSet(t.v);
        M.localGet(t.v); M.i32WrapI64(); M.localGet(t.w); M.i64Store(3, this._fieldIndex(privName));
        M.localGet(t.w);
        this._expLeave();
        return;
    }
    // 类静态字段写 C.x = v → 宿主 qz.static_set
    if (this._isClassName(left.expression)) {
        const cn = this._classOfExpr(left.expression);
        const got = this._findStaticAccessor(cn, left.name.text, "set");
        if (got && got.acc) this._checkStaticThis(got.cname, cn, got.acc, left.name.text);
        M.localSet(t.w);                           // 值（i64）
        this._emitStaticsGuard(cn);
        if (got) {                                 // 静态 setter（含继承）→ 直调 __sm_<owner>$<name>$set
            this._emitUndefined();
            M.localGet(t.w);
            for (let i = 0; i < 3; i++) this._emitUndefined();
            M.call(staticMethName(got.cname, got.acc.name + "$set"));
            M.localGet(t.w);
            this._expLeave();
            return;
        }
        this._emitStaticsGuard(cn);               // 写总是落在接收者类（JS：派生的静态属性是自有属性）
        M.i32Const(this._strId(cn)); M.i32Const(this._strId(this._staticKey(cn, left.name))); M.localGet(t.w); M.call("qz.static_set");
        M.localGet(t.w);                           // 赋值表达式返回所赋之值
        this._expLeave();
        return;
    }
    M.localSet(t.w);                              // 值（i64）
    if (this._hasAccessor(left.name.text, "set")) {   // 程序内有该名 setter → 宿主分派（实例经继承链）
        this.emitTaggedExpr(left.expression); M.localSet(t.v);
        M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set");
        this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
        M.localGet(t.w);
        this._expLeave();
        return;
    }
    this.emitTaggedExpr(left.expression);         // obj 句柄
    M.localSet(t.v);
    if (this.usesKeyOrder) {                      // 插入序登记（Object.keys/for-in/JSON 依赖）
        M.localGet(t.v); this._emitStrLitHandle(left.name.text); M.call("qz.field_order");
    }
    if (this.usesFreeze) {                        // freeze/seal/preventExtensions 出现在程序内 → 写前查写保护（strict：抛 TypeError）
        M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.call("qz.prot_check");
        this._emitErrCheck(false);
    }
    // undefined/null 接收者写属性 → 走 prop_set（host 抛 TypeError，JS 语义）
    M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ff9n); M.i64Eq();
    M.localGet(t.v); M.i32WrapI64(); M.i32Const(8); M.i32LtU(); M.i32And();
    M.ifBlock("void");
    M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set");   // undefined/null → host 抛 TypeError
    M.else_();
    // 宿主对象(0x7FFD) → qz.object_set（写 handles[idx][name]）；POJO → wasm 内存 store
    M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
    M.ifBlock("void");
    M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.object_set");
    M.else_();
    // 闭包值(0x7FFF)/字符串(0x7FFA)/数组(0x7FFB) → 宿主 prop_set。
    // 内存快路径对 POJO(0x7FF9) 和类实例(0x7FFE) 都合法：二者布局一致
    // （[off]=clsId [off+4]=size [off+8..]=fields），可直接 i64Store 字段槽。
    // 闭包值偏移当基址做 i64Store 会**静默写坏线性内存**
    // （`ctor.prototype.m = f` 即此：ctor 是闭包值，prototype 无处安放）。
    M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7fffn); M.i64Eq();
    M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
    M.i32Or();
    M.localGet(t.v); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
    M.i32Or();
    M.ifBlock("void");
    M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set");
    M.else_();
    if (this.usesDynAcc) { M.localGet(t.v); M.i32Const(this._strId(left.name.text)); M.localGet(t.w); M.call("qz.prop_set"); }   // 访问器表
    else { M.localGet(t.v); M.i32WrapI64(); M.localGet(t.w); M.i64Store(3, this._fieldIndex(left.name.text)); }
    M.end();
    M.end();
    M.end();
    this._emitErrCheck(false);                    // undefined/null 写属性 → TypeError（转入本函数 catch；链外检查避免嵌套深度问题）
    M.localGet(t.w);                              // 赋值表达式返回所赋之值
    this._expLeave();
};
// `.length=` 赋值：数组(0x7FFB) → qz.arr_set_len（宿主截断/扩容）；其余 → 普通字段存储
// （POJO 恰有 length 字段）。返回所赋之值（JS 语义）。scratch=值, scratchA=接收者（皆 i64）。
Emitter.prototype._emitStoreLength = function (left) {
    const M = this.m;
    M.localSet(this.scratch);                       // 值 → scratch（i64）
    this.emitTaggedExpr(left.expression);           // 接收者
    M.localSet(this.scratchA);
    M.localGet(this.scratchA); M.i64Const(48n); M.i64ShrU();
    M.i64Const(0x7ffbn); M.i64Eq();
    M.ifBlock("void");
    M.localGet(this.scratchA); M.localGet(this.scratch); M.call("qz.arr_set_len"); M.drop();   // 数组：宿主处理
    M.else_();
    M.localGet(this.scratchA); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffdn); M.i64Eq();
    M.ifBlock("void");
    M.localGet(this.scratchA); this._emitStrLitHandle("length"); M.localGet(this.scratch); M.call("qz.set_index");   // 宿主对象（Object.create(Array.prototype)）：属性写 length（此前按 POJO 字段写 → 静默丢）
    M.else_();
    M.localGet(this.scratchA); M.i32WrapI64();
    M.localGet(this.scratch); M.i64Store(3, this._fieldIndex("length"));             // POJO/实例：字段
    M.end();
    M.end();
    M.localGet(this.scratch);                       // 赋值表达式返回所赋之值
};
Emitter.prototype._hasSideEffects = function (n) {
    if (n === undefined || n === null) return false;
    if (ts.isIdentifier(n) || ts.isLiteralExpression(n)) return false;
    if (n.kind === ts.SyntaxKind.SuperKeyword) return false;   // super 是静态引用（无副作用）
    if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isPropertyAccessExpression(n)) return this._hasSideEffects(n.expression);
    if (ts.isElementAccessExpression(n)) return this._hasSideEffects(n.expression) || this._hasSideEffects(n.argumentExpression);
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) return this._hasSideEffects(n.expression);
    if (ts.isPrefixUnaryExpression(n) && (n.operator === ts.SyntaxKind.PlusToken || n.operator === ts.SyntaxKind.MinusToken)) return this._hasSideEffects(n.operand);
    return true;
};
Emitter.prototype._emitStoreElem = function (left, preObj, preKey) {
    const M = this.m, t = this._expEnter();       // 值/键/接收者须存活于嵌套求值
    M.localSet(t.w);                              // 值（i64）
    if (preKey !== undefined) { M.localGet(preKey); M.localSet(t.v); } else { this.emitTaggedExpr(left.argumentExpression); M.localSet(t.v); }   // 键
    M.localGet(t.v); this._emitIsStr();
    M.ifBlock("void");
    if (preObj !== undefined) { M.localGet(preObj); M.localSet(t.x); } else { this.emitTaggedExpr(left.expression); M.localSet(t.x); }
    if (this.usesKeyOrder) { M.localGet(t.x); M.localGet(t.v); M.call("qz.field_order"); }   // 插入序登记
    M.localGet(t.x); M.localGet(t.v); M.localGet(t.w); M.call("qz.set_index");   // 字符串键 → 宿主
    this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
    M.else_();
    if (preObj !== undefined) { M.localGet(preObj); M.localSet(t.x); } else { this.emitTaggedExpr(left.expression); M.localSet(t.x); }
    M.localGet(t.x); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
    M.ifBlock("void");                                             // wasm 数组 + 数值键
    this._emitInt32Safe(t.v);
    M.ifBlock("void");
    M.localGet(t.v); M.f64ReinterpretI64(); M.i32TruncF64S(); M.localSet(t.a);
    M.localGet(t.a); M.localGet(t.x); M.i32WrapI64(); M.i32Load(2, 0); M.i32LtU();
    M.ifBlock("void");
    M.localGet(t.x); M.i32WrapI64(); M.i32Load(2, 8);
    M.localGet(t.a); M.i32Const(8); M.i32Mul(); M.i32Add();
    M.localGet(t.w); M.i64Store(3, 0);
    M.else_();
    M.localGet(t.x); M.localGet(t.v); M.localGet(t.w); M.call("qz.arr_set_index"); M.drop();   // 越界 → 扩容（JS 语义）
    M.end();
    M.else_();
    M.localGet(t.x); M.localGet(t.v); M.localGet(t.w); M.call("qz.arr_set_index"); M.drop();
    M.end();
    M.else_();
    M.localGet(t.x); M.localGet(t.v); M.localGet(t.w); M.call("qz.set_index");       // 其它接收者 → 宿主
    this._emitErrCheck(false);   // 冻结/不可扩展对象写入 → 抛 TypeError（转入 catch）
    M.end();
    M.end();
    M.localGet(t.w);                              // 返回所赋之值
    this._expLeave();
};
// undefined = 句柄 0x7FF9|0（qzvm handles[0]=undefined）
Emitter.prototype._emitUndefined = function () { this.m.i64ConstBits(0, 0x7ff90000); };
// null = 句柄 0x7FF9|1（qzvm handles[1]=null 固定槽）。与 undefined 区分：typeof/宽松 == 语义不同。
Emitter.prototype._emitNull = function () { this.m.i64ConstBits(1, 0x7ff90000); };
Emitter.prototype._emitArrayPush = function (rx, arg, hv) {
    const M = this.m;
    const t = this._expEnter();                               // 接收者/值用可重入槽（arg 求值可能覆盖 scratch）
    if (hv !== undefined) M.localGet(hv); else this.emitTaggedExpr(rx); M.localSet(t.v);   // 数组句柄（hv = 调用点已求值）
    void rx;
    this.emitTaggedExpr(arg); M.localSet(t.w);                // 待压值
    M.localGet(t.v); M.i32WrapI64(); M.localSet(t.a);         // h
    M.localGet(t.a); M.i32Load(2,0);                          // len
    M.localGet(t.a); M.i32Load(2,4);                          // cap
    M.i32GeS();
    M.ifBlock();
      M.localGet(t.a); M.i32Load(2,4); M.i32Eqz();            // cap==0
      M.ifBlock("i32"); M.i32Const(4); M.else_();
        M.localGet(t.a); M.i32Load(2,4); M.i32Const(2); M.i32Mul();
      M.end();
      M.localSet(t.b);                                        // newCap
      M.globalGet(0); M.localSet(t.c);                        // newData = bump
      emitBumpSet(M, () => { M.globalGet(0); M.localGet(t.b); M.i32Const(8); M.i32Mul(); M.i32Add(); });   // bump += newCap*8
      M.localGet(t.c);                                        // dest
      M.localGet(t.a); M.i32Load(2,8);                        // src = oldData
      M.localGet(t.a); M.i32Load(2,0); M.i32Const(8); M.i32Mul();   // n = len*8
      M.call("qzs_memcpy");
      M.localGet(t.a); M.localGet(t.c); M.i32Store(2,8);      // header.dataOff = newData
      M.localGet(t.a); M.localGet(t.b); M.i32Store(2,4);      // header.cap = newCap
    M.end();
    M.localGet(t.a); M.i32Load(2,8);                          // dataOff
    M.localGet(t.a); M.i32Load(2,0); M.i32Const(8); M.i32Mul(); M.i32Add();
    M.localGet(t.w); M.i64Store(3,0);                         // data[len] = val
    M.localGet(t.a);
    M.localGet(t.a); M.i32Load(2,0); M.i32Const(1); M.i32Add(); M.i32Store(2,0);   // len++
    M.localGet(t.a); M.i32Load(2,0);
    M.f64ConvertI32U(); M.i64ReinterpretF64();                // 返回新长度（number）
    this._expLeave();
};
// a.pop()：空 → undefined；否则取末元素 + len--。
Emitter.prototype._emitArrayPop = function (rx, hv) {
    const M = this.m;
    const t = this._expEnter();
    if (hv !== undefined) M.localGet(hv); else this.emitTaggedExpr(rx); M.localSet(t.v);
    void rx;
    M.localGet(t.v); M.i32WrapI64(); M.localSet(t.a);         // h
    M.localGet(t.a); M.i32Load(2,0); M.i32Eqz();
    M.ifBlock("i64");
      this._emitUndefined();
    M.else_();
      M.localGet(t.a); M.i32Load(2,0); M.i32Const(1); M.i32Sub(); M.localSet(t.b);   // i = len-1
      M.localGet(t.a); M.localGet(t.b); M.i32Store(2,0);
      M.localGet(t.a); M.i32Load(2,8);                        // dataOff
      M.localGet(t.b); M.i32Const(8); M.i32Mul(); M.i32Add();
      M.i64Load(3,0);
    M.end();
    this._expLeave();
};
// x.method(...)：字符串/通用方法经 qz.str_method(recv, nameId, a0, a1) 回退（正确处理 UTF-8）。
// 结果 = 句柄（字符串 toJS 还原；数值方法如 charCodeAt/indexOf 结果亦 join handles 表 → toJS 为 number）。
// 箭头/函数表达式求值：bump 分配 [funcidx:i32][nCaps:i32][cell×N]，
// 捕获变量逐个求值存入 cell，返回句柄 0x7FF9|off。
Emitter.prototype._emitLambdaNew = function (lam, selfName) {
    const M = this.m;
    if (selfName && !lam._qzSelfName) lam._qzSelfName = selfName;   // 自递归直调用（绑定名）
    let meta = this._lamById.get(lam);
    if (!meta) {                                   // 惰性登记（合成箭头/访问器闭包，不在预扫描列表内）
        this._lamAuto = (this._lamAuto || 0) + 1;
        this.emitLambda(lam, "x" + this._lamAuto);
        meta = this._lamById.get(lam);
    }
    const fidx = this.m._funcIdx[meta.fname];
    // 闭包值 = [funcidx:i32][envIdx:i32][arity:i32][nameStrId:i32]（envIdx=0 表示无捕获）；捕获值不再拷贝（共享环境）。
    emitBumpAlloc(M, () => M.i32Const(16));           // → off(i32)（越界 trap）
    M.localSet(this.cloOff);
    /* [off] = 蹦床表槽（C 侧 closure_call 经 call_indirect 分派）；无蹦床时退回 funcidx */
    M.localGet(this.cloOff); M.i32Const(meta.tableSlot !== undefined ? meta.tableSlot : fidx); M.i32Store(2, 0);
    M.localGet(this.cloOff); (this.envRef !== undefined ? M.localGet(this.envRef) : M.i32Const(0)); M.i32Store(2, 4);
    M.localGet(this.cloOff); M.i32Const(lam.parameters ? lam.parameters.length : 0); M.i32Store(2, 8);
    M.localGet(this.cloOff); M.i32Const(lam.name && ts.isIdentifier(lam.name) ? this._strId(lam.name.text) : -1); M.i32Store(2, 12);
    M.localGet(this.cloOff); M.i64ExtendI32U();
    M.i64ConstBits(0, 0x7fff0000); M.i64Or();
};
// 类实例分配：size 覆盖全局字段表最大偏移（+8 头），clsId 写 [0]；返回 self 句柄。
// 把 [base+8, base+size) 的槽逐个写为 undefined 句柄（POJO/实例字段「未赋值」表示）。
// size 是编译期常量（全局字段表最大偏移 +8 头）：小对象直接展开成定长 store，
// 省掉每次分配的循环控制开销（比较/分支/指针自增）——分配是热路径上的逐次操作。
// 大对象（字段多）仍用循环，避免代码膨胀。
Emitter.prototype._emitFillUndef = function (size) {
    const M = this.m, t = this._expEnter();
    M.localSet(t.a);                                                     // base(i32) ← 栈顶
    // 只在 size 是编译期常量时展开（调用点也可能传运行时变量）
    const n = (typeof size === "number") ? Math.ceil((size - 8) / 8) : 0;
    if (n > 0 && n <= 8) {
        for (let i = 0; i < n; i++) {
            M.localGet(t.a); M.i32Const(8 + i * 8); M.i32Add();          // base + 8 + i*8
            M.i64ConstBits(0, 0x7ff90000); M.i64Store(3, 0);
        }
        this._expLeave();
        return;
    }
    M.localGet(t.a); M.i32Const(8); M.i32Add(); M.localSet(t.c);         // p = base + 8
    M.localGet(t.a); M.i32Const(size); M.i32Add(); M.localSet(t.b);      // end = base + size
    M.block("void"); M.loop("void");
    M.localGet(t.c); M.localGet(t.b); M.i32GeU(); M.brIf(1);             // p >= end → 出循环
    M.localGet(t.c); M.i64ConstBits(0, 0x7ff90000); M.i64Store(3, 0);
    M.localGet(t.c); M.i32Const(8); M.i32Add(); M.localSet(t.c);
    M.br(0);
    M.end(); M.end();
    this._expLeave();
};
Emitter.prototype._instSize = function () {
    return ((this.fieldMap ? this.fieldMap.size : 0) + 1) * 8;
};
Emitter.prototype._emitNewCall = function (e, argSrc) {
    const M = this.m;
    let tgt = e.expression;                                  // new (C as any)(…) / new (C)() 亦按类名解析
    while (tgt && (ts.isParenthesizedExpression(tgt) || ts.isAsExpression(tgt) || ts.isNonNullExpression(tgt)
        || ts.isTypeAssertionExpression(tgt) || ts.isSatisfiesExpression(tgt))) tgt = tgt.expression;
    // `new ns.C(...)`：命名空间成员访问 → 解析到目标类名，改写成标识符后走静态构造
    // （zod 里大量 new checks.$ZodCheckXxx）。命名空间成员不在 classes 里时落到下面的动态路径。
    if (ts.isPropertyAccessExpression(tgt) && ts.isIdentifier(tgt.expression)) {
        const nsCls = this._nsMember(tgt.expression.text, tgt.name.text);
        if (nsCls && this.classes.has(nsCls)) tgt = ts.factory.createIdentifier(nsCls);
    }
    // 其他非标识符目标（深层属性链 `new inst._zod.constr(...)`、条件式 `new (a ?? b)(...)`）：
    // 运行时求值成类对象，交宿主按 __qzClsId 建实例。
    if (!ts.isIdentifier(tgt)) {
        if (argSrc) throw new Error("[tagged] new 动态目标的实参展开不支持");
        if (e.arguments.length > 4) throw new Error("[tagged] new 最多 4 参");
        const M2 = this.m, tg2 = this._expEnter();
        this.emitTaggedExpr(tgt); M2.localSet(tg2.w);
        M2.localGet(tg2.w);
        for (let i = 0; i < 4; i++) {
            if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
        }
        M2.call("qz.new_dynamic");
        this._expLeave();
        return;
    }
    const cname = this._className(tgt.text);   // 导入类本地名 → 目标类名
    // 内建类（Error/Map/Set/Date/Array/RegExp/…）→ 宿主 qz.builtin（构造语义）；未登记者报错
    if (!this.classes.has(cname)) {
        if (EMITTER_BUILTIN_CTORS.has(tgt.text)) { this._emitBuiltinCall(tgt.text, e.arguments); return; }
        {   // 动态类值（类表达式工厂 / 变量持有类）：运行时取类对象 → 宿主按 __qzClsId 建实例
            const resolvable = this._local(tgt.text) !== undefined || this.capMap.has(tgt.text)
                || (this.moduleGlobals && this.moduleGlobals.has(tgt.text))
                || (this.fnNames && this.fnNames.has(tgt.text));    // 顶层函数作类（JS function-as-class：Dog.prototype = …）
            if (resolvable) {
                /* 类表达式/动态类值（new A()）：若 tgt 对应一个已知类（含捕获），
                 * 先触发 statics guard 建立类捕获 env（_emitClassCaptureEnv 经 class_value）。
                 * 否则类方法读捕获 env 拿到空（声明式类表达式的捕获缺口）。*/
                const dynCn = this._className(tgt.text) || (this.classes.has(tgt.text) ? tgt.text : undefined);
                const dynC = dynCn && this.classes.get(dynCn);
                if (dynC) { this._emitStaticsGuard(dynC.name); }
                const M2 = this.m, tg2 = this._expEnter();
                this.emitTaggedExpr(tgt); M2.localSet(tg2.w);        // 类对象 → 槽（先求值，避免嵌套副作用）
                M2.localGet(tg2.w);                                  // 参数序：obj, a0..a3
                for (let i = 0; i < 4; i++) {
                    if (i < e.arguments.length) this.emitTaggedExpr(e.arguments[i]); else this._emitUndefined();
                }
                M2.call("qz.new_dynamic");
                this._expLeave();
                return;
            }
        }
        throw new Error(BUILTIN_GLOBALS.has(tgt.text)
            ? `[tagged] 内建类 ${tgt.text} 未实现（支持 Error 族/Map/Set/Date/Array/RegExp）`
            : "[tagged] new 未知类: " + tgt.text);
    }
    const c = this.classes.get(cname);
    if (this._dynParentExpr(c)) this._emitStaticsGuard(cname);   // 动态父：构造前先建立运行时父链（statics guard 内）
    const args = e.arguments;
    if (args.length > 4) throw new Error("[tagged] new 最多 4 参");
    const te = this._expEnter();                            // 实例 off / ctor 实参用可重入槽（嵌套 new 不覆盖）
    { const argSlots = [te.w, te.x, te.y, te.z];   // self 占 te.v，实参用 w/x/y/z
      for (let i = 0; i < 4; i++) {
        if (argSrc) argSrc(i);                                    // 实参来自运行期数组（new C(...args)）
        else if (i < args.length) this.emitTaggedExpr(args[i]);
        else this._emitUndefined();
        M.localSet(argSlots[i]);
      } }
    // 内联 bump 分配（与 POJO/数组同款）：避免 qz.newobj 跨界 + BigInt 装箱（构造热路径）。
    // 布局：offset 8 对齐，[off]=clsId(i32)，字段槽由 ctor 写。
    M.globalGet(0); M.i32Const(7); M.i32Add(); M.i32Const(-8); M.i32And();   // off=(bump+7)&~7
    M.localSet(te.a);
    emitBumpSet(M, () => { M.localGet(te.a); M.i32Const(this._instSize()); M.i32Add(); });   // bump = off+size（越界 trap）
    M.localGet(te.a);
    M.i32Const(c.id); M.i32Store(2, 0);                     // [0]=clsId
    M.localGet(te.a); M.i32Const(this._instSize()); M.i32Store(2, 4);   // [4]=size（供宿主物化）
    M.localGet(te.a); this._emitFillUndef(this._instSize());   // 槽 = undefined（未赋值字段）
    M.localGet(te.a); M.i64ExtendI32U(); M.i64ConstBits(0, 0x7ffe0000); M.i64Or();   // 实例句柄 = 0x7FFE|offset（专用 tag，与 POJO 0x7FF9 区分，供 instanceof）
    M.localSet(te.v);                                       // self 句柄（受保护）
    M.localGet(te.v);
    for (let i = 0; i < 4; i++) M.localGet([te.w, te.x, te.y, te.z][i]);
    M.call(ctorName(cname));                                // 写 __cls、字段、执行体
    this._emitErrCheck(false);                              // 构造器 void：检查 __err 但不留值
    M.localGet(te.v);                                       // 表达式值 = 实例
    this._expLeave();
};
/* 解构赋值（赋值式）：left = ArrayLiteralExpression / ObjectLiteralExpression，值在 local rhsLocal。
 * 覆盖绑定解构的全部形状：嵌套模式、默认值（= 仅 undefined 触发）、数组 rest（slice）、
 * 对象 rest（object_rest + 静态键排除）、计算键名；目标可为标识符 / 成员访问 / 嵌套模式。 */
Emitter.prototype._emitDestructuringAssign = function (left, rhsLocal) {
    const M = this.m;
    if (ts.isArrayLiteralExpression(left)) {
        {   // 非 wasm 数组/字符串 → 迭代协议收集（同绑定解构，否则可迭代源按下标读得 undefined）
            M.localGet(rhsLocal); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffbn); M.i64Eq();
            M.localGet(rhsLocal); M.i64Const(48n); M.i64ShrU(); M.i64Const(0x7ffan); M.i64Eq();
            M.i32Or(); M.i32Eqz();
            M.ifBlock("void");
            M.localGet(rhsLocal); M.call("qz.iter_array"); M.localSet(rhsLocal);
            M.end();
        }
        let i = 0;
        for (const el of left.elements) {
            if (ts.isOmittedExpression(el)) { i++; continue; }
            if (ts.isSpreadElement(el)) {                     // [...rest] → arr.slice(i)
                M.localGet(rhsLocal); M.i32Const(this._strId("slice"));
                M.i64ConstBits(...f64Bits(i)); this._emitUndefined(); this._emitUndefined(); this._emitUndefined();
                this._emitUndefined();                        // ovf
                M.call("qz.method_call");
                this._emitAssignTargetFromStack(el.expression);
                i++; continue;
            }
            let target = el, dflt = null;
            if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                target = el.left; dflt = el.right;
            }
            this._emitElemOf(rhsLocal, ts.factory.createNumericLiteral(i));
            if (dflt) this._emitDefaultIfUndef(dflt);
            this._emitAssignTargetFromStack(target);
            i++;
        }
        return;
    }
    const props = left.properties;
    const hasRest = props.some(p => ts.isSpreadAssignment(p));
    const restExcl = [];
    if (hasRest) {
        for (const p of props) {
            if (ts.isSpreadAssignment(p)) continue;
            const nm = ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) ? p.name : null;
            const k = nm && (ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNumericLiteral(nm)) ? nm.text : null;
            if (k === null) throw new Error("[tagged] {...rest} 与计算属性名解构混用暂不支持");
            restExcl.push(k);
        }
    }
    for (const p of props) {
        if (ts.isSpreadAssignment(p)) {                       // {...rest} → 宿主 object_rest
            if (restExcl.length > 8) throw new Error("[tagged] 对象 rest 解构最多排除 8 个键");
            M.localGet(rhsLocal);
            for (let k = 0; k < 8; k++) M.i32Const(k < restExcl.length ? this._strId(restExcl[k]) : -1);
            M.call("qz.object_rest");
            this._emitAssignTargetFromStack(p.expression);
            continue;
        }
        let target, dflt = null, key = null, keyExpr = null;
        if (ts.isShorthandPropertyAssignment(p)) {
            target = p.name;
            key = p.name.text;                              // 简写：键名 = 变量名
            dflt = p.objectAssignmentInitializer || null;
        } else if (ts.isPropertyAssignment(p)) {
            target = p.initializer;
            if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                dflt = target.right; target = target.left;
            }
            if (ts.isComputedPropertyName(p.name)) keyExpr = p.name.expression;
            else if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name)) key = p.name.text;
            else throw new Error("[tagged] 解构赋值不支持的属性名形式: " + ts.SyntaxKind[p.name.kind]);
        } else throw new Error("[tagged] 解构赋值不支持的对象成员: " + ts.SyntaxKind[p.kind]);
        if (keyExpr !== null) this._emitElemOf(rhsLocal, keyExpr);
        else this._emitPropReadFromLocal(rhsLocal, key);
        if (dflt) this._emitDefaultIfUndef(dflt);
        this._emitAssignTargetFromStack(target);
    }
};
// 栈顶值 → 赋值目标（标识符/属性/元素/嵌套模式）；写入后丢弃 store 保留值（结果 = 整个 RHS）。
Emitter.prototype._emitAssignTargetFromStack = function (target) {
    const M = this.m;
    while (ts.isParenthesizedExpression(target)) target = target.expression;
    if (ts.isIdentifier(target)) { this._emitVarStore(target.text, this.scratchB); M.drop(); return; }
    if (ts.isPropertyAccessExpression(target)) { this._emitStoreProp(target); M.drop(); return; }
    if (ts.isElementAccessExpression(target)) { this._emitStoreElem(target); M.drop(); return; }
    if (ts.isArrayLiteralExpression(target) || ts.isObjectLiteralExpression(target)) {
        const t = this._expEnter();
        M.localSet(t.v);
        this._emitDestructuringAssign(target, t.v);
        this._expLeave();
        return;
    }
    throw new Error("[tagged] 解构赋值目标不支持: " + ts.SyntaxKind[target.kind]);
};
// super(...)：在构造器内，self=local0。调父 ctor 后回写本类字段默认值（JS 派生字段初始化序）。
Emitter.prototype._emitSuperCall = function (c, args) {
    const M = this.m;
    if (!c.parent) throw new Error("[tagged] " + c.name + " 无父类，super() 非法");
    if (args.length > 4) throw new Error("[tagged] super 最多 4 参");
    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
        M.localSet(this.cloArgs[i]);
    }
    M.localGet(0);
    for (let i = 0; i < 4; i++) M.localGet(this.cloArgs[i]);
    M.call(ctorName(c.parent));
    this._emitFieldDefaults(c);                             // 子类字段默认值在 super 之后
};
// 合成派生 ctor：local1..4 = 补齐后的参数槽，原样转发给父 ctor。
/* 同 _emitClassCaptureEnv，但把 env 索引作为 i64 留在栈上（供 class_expr_value 带着走）。*/
Emitter.prototype._emitClassCaptureEnvValue = function (c) {
    const M = this.m;
    if (!(c.captured && c.captured.length)) { this._emitUndefined(); return; }
    const envT = this._expEnter();
    M.i32Const(-1); M.call("qz.env_new"); M.localSet(envT.v);
    for (const n0 of c.captured) {
        if (!(this._isCapturable(n0) || (this.moduleGlobals && this.moduleGlobals.get(n0) !== undefined))) continue;
        const idNode = ts.factory.createIdentifier(n0);
        idNode.pos = c.id; idNode.end = c.id;
        M.localGet(envT.v); M.i32WrapI64(); M.i32Const(this._strId(n0));   // env_def 首参 = env 索引(i32)
        this.emitTaggedExpr(idNode);
        M.call("qz.env_def");
    }
    M.localGet(envT.v);
    M.i64Const(1n); M.i64Add();            // +1：0 被保留为「无捕获」哨兵（env 索引从 0 起）
    this._expLeave();
};
/* 类方法捕获：创建点(外围作用域活动)复制其值到类 env，存 statics @@qzEnv
 * （总是存 → 方法侧索引一定合法）。声明式类与类表达式共用。*/
Emitter.prototype._emitClassCaptureEnv = function (c) {
    const M = this.m;
    if (!(c.captured && c.captured.length)) return;
    const envT = this._expEnter();
    /* __parent = 父类 env（沿继承链）：class_env_parent_get 查 classMeta[clsId].parent
     * （动态父经 class_value_dyn 就地改写）。env 句柄 +1 编码，wrap 后减 1 还原 idx
     * （0=无父 env → -1 = 无 parent）。*/
    M.i32Const(c.id); M.i32Const(this._strId("@@qzEnv")); M.call("qz.class_env_parent_get");
    M.i32WrapI64(); M.i32Const(1); M.i32Sub();
    M.call("qz.env_new"); M.localSet(envT.v);
    for (const n0 of c.captured) {
        if (!(this._isCapturable(n0) || (this.moduleGlobals && this.moduleGlobals.get(n0) !== undefined))) continue;
        const idNode = ts.factory.createIdentifier(n0);
        idNode.pos = c.id; idNode.end = c.id;
        M.localGet(envT.v); M.i32WrapI64(); M.i32Const(this._strId(n0));   // env_def 首参 = handles 索引(i32)
        this.emitTaggedExpr(idNode);
        M.call("qz.env_def");
    }
    /* 键用 clsId（不是类名）：class_env_get 也按实例运行时 clsId 查，两边一致。*/
    M.i32Const(c.id); M.i32Const(this._strId("@@qzEnv")); M.localGet(envT.v); M.i64Const(1n); M.i64Add(); M.call("qz.class_env_set");
    this._expLeave();
};
Emitter.prototype._emitClassValue = function (c) {        // 类对象句柄：动态父 → class_value_dyn(id, 父表达式)；否则 class_value(id)
    const M = this.m;
    const dynN = this._dynParentExpr(c);
    if (dynN) {
        /* 动态父：先 class_value_dyn 就地改写 classMeta[clsId].parent（供后续
         * class_env_parent_get 沿链查父 env），再 _emitClassCaptureEnv 建子 env
         * 链接父 env。class_value_dyn 幂等（classHandles 缓存），句柄留栈。*/
        M.i32Const(c.id); this.emitTaggedExpr(dynN); M.call("qz.class_value_dyn");
        this._emitClassCaptureEnv(c);
        return;
    }
    this._emitClassCaptureEnv(c);
    M.i32Const(c.id); M.call("qz.class_value");
};
Emitter.prototype._dynParentExpr = function (c) {          // 动态父：extends 非「已知类名/内建」→ 返回父表达式（否则 null）
    if (!c || !c.dynParentNode) return null;
    const n = c.dynParentNode;
    if (ts.isIdentifier(n) && (this.classes.has(this._className(n.text)) || BUILTIN_GLOBALS.has(n.text) || EMITTER_BUILTIN_CTORS.has(n.text))) return null;
    return n;
};
Emitter.prototype._emitSuperCallForward = function (c) {
    const M = this.m;
    if (this._dynParentExpr(c)) {                           // 动态父（mixin）：宿主按运行时父链转发 ctor
        M.i32Const(c.id);
        for (let i = 0; i <= 4; i++) M.localGet(i);
        M.call("qz.super_ctor");
        this._emitFieldDefaults(c);
        return;
    }
    if (c.parent && !this.classes.has(c.parent)) {           // 内建父（Error 族…）：无 wasm ctor 可调，同显式 super() 写法
        M.localGet(0); M.i32WrapI64(); M.localGet(1);
        M.i64Store(3, this._fieldIndex("message"));
        M.localGet(0); M.i32WrapI64(); this._emitStrLitHandle(c.parent);
        M.i64Store(3, this._fieldIndex("name"));
        this._emitFieldDefaults(c);
        return;
    }
    M.localGet(0);
    for (let i = 1; i <= 4; i++) M.localGet(i);
    M.call(ctorName(c.parent));
    this._emitFieldDefaults(c);
};
// 内建全局调用/常量：nameId + n(实际参数个数) + a0..a3（缺省 undefined）→ qz.builtin → i64。
Emitter.prototype._emitBuiltinCall = function (name, args) {
    const M = this.m;
    M.i32Const(this._strId(name));
    M.i32Const(args.length);
    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
    }
    {   // ovf：实参 3..（>4 实参的内建，如 Math.max(a,b,c,d,e)）；未超出时为空数组（宿主按 arity 截断）
        const ovfA = args.length > 3 ? args.slice(3) : [];
        if (ovfA.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] " + name + " 的溢出实参与展开混用暂不支持");
        const lit = ts.factory.createArrayLiteralExpression(ovfA);
        lit.pos = args.length ? args[0].pos : 0; lit.end = args.length ? args[args.length - 1].end : 0;
        this.emitTaggedExpr(lit);
    }
    M.call("qz.builtin");
    this._emitErrCheck();          // 内建可能抛（JSON 循环引用/解析失败/类型错）→ 转入本函数 catch（try 内）
};
// 动态方法分派：method_call(recv, mid, a0..a3) → i64（qz 侧按 recv 类型派发：字符串→str_method；
// 类实例（内存[0]=__cls）→ classMeta 沿继承链调 wasm 导出方法）。未知类型/无方法 → 宿主抛错。
// 方法直调实参：self + 前 4 槽（不足补 undefined）；形参 >4 → 追加 ovf 数组（含实参 3，与闭包 ABI 同款）；
// rest 收尾形参（索引 <4）→ 尾部实参打包为数组落在该槽。
Emitter.prototype._emitMethodArgs = function (params, args) {
    const M = this.m;
    const n = params ? params.length : 0;
    const restIdx = (n && params[n - 1] && params[n - 1].dotDotDotToken) ? n - 1 : -1;
    if (restIdx >= 4) throw new Error("[tagged] rest 形参在索引 ≥4 的方法未支持");
    for (let i = 0; i < 4; i++) {
        if (i === restIdx) {
            const tail = args.slice(i);
            if (tail.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] rest 与展开实参混用暂不支持");
            const lit0 = ts.factory.createArrayLiteralExpression(tail);
            lit0.pos = args.length ? args[0].pos : 0; lit0.end = args.length ? args[args.length - 1].end : 0;
            this.emitTaggedExpr(lit0);
        } else if (i < args.length) this.emitTaggedExpr(args[i]);
        else this._emitUndefined();
    }
    if (n > 4) {
        const ovfA = args.slice(3);
        if (ovfA.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 方法调用的溢出实参与展开混用暂不支持");
        const lit = ts.factory.createArrayLiteralExpression(ovfA);
        lit.pos = args.length ? args[0].pos : 0; lit.end = args.length ? args[args.length - 1].end : 0;
        this.emitTaggedExpr(lit);
    }
};
Emitter.prototype._emitDynMethod = function (rx, method, args) {
    const M = this.m;
    if (/^#[^#]+$/.test(method)) {                      // 私有方法：类名限定（PrivateIdentifier.text 自带 #）
        const cnP = ts.isIdentifier(rx) ? this._className(rx.text) : this._curClass;
        if (cnP) method = "#" + cnP + "#" + method;
    }
    // 静态方法 C.m(...)：类名不是变量 → 沿继承链找 static 方法 owner，直调 __sm_<Owner>$<m>
    // （self 传 undefined 占位；静态方法体不用 this）。
    if (this._isClassName(rx)) {                                  // 显式类名（含 as/括号/静态方法内 this）→ 静态方法直调
        const cnS = this._classOfExpr(rx);
        let owner = cnS;
        while (owner && !(this.classes.get(owner).staticMethods || []).some(s => s.name === method)) owner = this.classes.get(owner).parent;
        if (!owner) {
            // 静态**字段**持函数：`static create = (p) => …`（zod v3 types.ts 全部 create 都是这种）。
            // 此时类对象上的 create 是闭包值 → 取属性后走值调用（qz.call_value 分派）。
            let fowner = cnS;
            while (fowner && !(this.classes.get(fowner).staticFields || []).some(f => f.name === method)) fowner = this.classes.get(fowner).parent;
            const sf = fowner && (this.classes.get(fowner).staticFields || []).find(f => f.name === method);
            // init 可以是箭头/函数表达式**或任意表达式**（`static create = createZodEnum` 直接引用函数名）
            if (sf && sf.init) {
                this._emitStaticsGuard(cnS);
                const pacc = ts.factory.createPropertyAccessExpression(rx, ts.factory.createIdentifier(method));
                pacc.pos = rx.pos; pacc.end = rx.end;
                this._emitValueCall(pacc, args, rx);
                return;
            }
            throw new Error(`[tagged] 静态方法 ${cnS}.${method}() 未定义`);
        }
        this._emitStaticsGuard(cnS);
        this._emitClassValue(this.classes.get(cnS));   // self = 接收者类（JS：B.describe() 内 this = B，含继承自 A 的方法）
        this._emitMethodArgs(((this.classes.get(owner).staticMethods || []).find(s => s.name === method) || {}).node ? (this.classes.get(owner).staticMethods || []).find(s => s.name === method).node.parameters : null, args);
        M.call(staticMethName(owner, method));
        this._emitErrCheck();   // 被调内 throw（跨函数 __err）→ 调用点转异常路径（此前静默吞掉）
        return;
    }
    const cls = this._staticRecvClass(rx);
    if (cls) {
        const owner = this._methodOwner(cls, method);
        const meta = owner && this._classMethodMeta(owner, method);
        // 仅直调有返回值、非 setter 的普通方法；void/setter 语义与动态路径不同（动态返回 i64），退回。
        const voidRet = meta && !!meta.node.type && meta.node.type.kind === ts.SyntaxKind.VoidKeyword;
        if (owner && meta && !meta.accessor && !voidRet) {   // getter/setter 走动态路径（getter 需先取值再调用）
            // 纯值栈：self + 4 参按形参序压栈（实参可为嵌套调用，天然按深度隔离，无需暂存槽）。
            this.emitTaggedExpr(rx);                                // self
            this._emitMethodArgs(meta.node.parameters, args);
            M.call(methName(owner, method));
            this._emitErrCheck();   // 同上：直调路径的跨函数 throw
            return;
        }
    }
    {   // 类 getter 作被调目标：x.p() ≡ (取值 x.p)()（如 get m(){ return () => … }）
        if (this._hasAccessor(method, "get")) {   // 全局 getter 名集合（rx 静态可判时更精确，见 _classOfExpr）
            const pacc = ts.factory.createPropertyAccessExpression(rx, ts.factory.createIdentifier(method));
            pacc.pos = rx.pos; pacc.end = rx.end;
            this._emitValueCall(pacc, args, rx);
            return;
        }
    }
    // 动态：压 recv + mid + 4 参入值栈（实参可为嵌套调用，无暂存槽覆盖问题）。
    this.emitTaggedExpr(rx);
    M.i32Const(this._strId(((method === "reduce" || method === "reduceRight") && args.length >= 2) ? method + "$i" : method));   // 显式提供初值（含 undefined）→ $i 变体

    for (let i = 0; i < 4; i++) {
        if (i < args.length) this.emitTaggedExpr(args[i]); else this._emitUndefined();
    }
    {   // ovf：实参 4..（被调形参 >4 时由宿主按其 arity 解包；否则忽略）
        const ovfA = args.slice(3);   // 与闭包 ABI 同款：ex[0] = 实参 3（已在 a3）
        if (ovfA.some(a2 => ts.isSpreadElement(a2))) throw new Error("[tagged] 方法调用的溢出实参与展开混用暂不支持");
        const lit = ts.factory.createArrayLiteralExpression(ovfA);
        lit.pos = args.length ? args[0].pos : 0; lit.end = args.length ? args[args.length - 1].end : 0;
        this.emitTaggedExpr(lit);
    }
    M.call("qz.method_call");
    this._emitErrCheck();          // 宿主方法可能抛出（如空数组 reduce）→ 转入本函数 catch
};
Emitter.prototype.emitTaggedBinary = function (e) {
    const op = e.operatorToken.kind;
    // 未实现的二元运算符：先于操作数求值报错（否则右操作数如类名 A 会先崩「未定义捕获变量: A」）
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
        // a instanceof C：C 须为用户类（内建类不支持）→ qz.instanceof_op(a, clsId) → tagged bool
        let right = e.right;
        while (right && (ts.isParenthesizedExpression(right) || ts.isAsExpression(right) || ts.isNonNullExpression(right)
            || ts.isTypeAssertionExpression(right) || ts.isSatisfiesExpression(right))) right = right.expression;   // d instanceof (Animal as any)
        if (ts.isIdentifier(right) && /^(Array|Object|String|Number|Boolean|Function|Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|RegExp|Date|Map|Set|Promise|WeakMap|WeakSet|Proxy|File|Blob|URL|URLSearchParams|ArrayBuffer|SharedArrayBuffer|DataView|Uint8Array|Int8Array|Uint16Array|Int16Array|Uint32Array|Int32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array|FormData|AbortController|AbortSignal|ReadableStream|WritableStream|TransformStream)$/.test(right.text)
            && !this.classes.has(this._className(right.text))) {
            // 内建类：宿主按 tag/物化判定（Array/Object/String/Number/Boolean/Function…）
            this.emitTaggedExpr(e.left);
            this.m.i32Const(this._strId(right.text));
            this.m.call("qz.instanceof_builtin");
            this.emitBoxBool();
            return;
        }
        {   // 动态右值（类表达式变量 / mixin 结果 / 内建值）：运行时宿主判定（用户类 → 运行时父链；内建 → 按名回退）
            const dynR = !this.classes.has(this._className(right.text))   // 已知类名 → 静态路径（模块级类亦会登记为 moduleGlobals，勿误判）
                && (ts.isPropertyAccessExpression(right)
                    || ts.isCallExpression(right)
                    || (ts.isIdentifier(right) && (this._local(right.text) !== undefined || this.capMap.has(right.text)
                        || (this.moduleGlobals && this.moduleGlobals.get(right.text) !== undefined)
                        || (this.fnNames && this.fnNames.has(right.text) && !this.classes.has(this._className(right.text))))));   // 顶层函数值（function 作类族）
            if (dynR) {
                const M2 = this.m, t2 = this._expEnter();
                this.emitTaggedExpr(e.left); M2.localSet(t2.v);
                this.emitTaggedExpr(right); M2.localSet(t2.w);
                M2.localGet(t2.v); M2.localGet(t2.w);
                M2.call("qz.instanceof_dyn");
                this._expLeave();
                return;
            }
        }
        if (!ts.isIdentifier(right) || !this.classes.has(this._className(right.text))) {
            throw new Error(right && BUILTIN_GLOBALS.has(right.text)
                ? `[tagged] 内建类 ${right.text} 的 instanceof 未实现`
                : "[tagged] instanceof 右操作数须为用户类");
        }
        this.emitTaggedExpr(e.left);
        this.m.i32Const(this.classes.get(this._className(right.text)).id);
        this.m.call("qz.instanceof_op");
        return;
    }
    if (op === ts.SyntaxKind.InKeyword) {
        if (ts.isPrivateIdentifier(e.left)) {   // 私有名 in o → 品牌检查：非对象 → TypeError；否则 o 是否为声明该私有名的类的实例
            if (!this._curClassObj) throw new Error("[tagged] #名字 in o 仅在类体内可用");
            this.emitTaggedExpr(e.right); this.m.i32Const(this._curClassObj.id); this.m.call("qz.brand_check");
            this._emitErrCheck();
            return;
        }
        // k in o → qz.in_op（宿主语义；POJO/实例由 toJS 物化）
        this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this.m.call("qz.in_op"); return;
    }
    if (op === ts.SyntaxKind.CommaToken) { this.emitTaggedExpr(e.left); this.m.drop(); this.emitTaggedExpr(e.right); return; }
    if (op === ts.SyntaxKind.FirstAssignment) {
        // 解构赋值 [a,b] = rhs / ({x} = rhs)：RHS 求值一次 → 逐目标读取 + 写入（结果 = RHS）
        if (ts.isArrayLiteralExpression(e.left) || ts.isObjectLiteralExpression(e.left)) {
            const M = this.m, t = this._expEnter();
            this.emitTaggedExpr(e.right); M.localSet(t.x);
            this._emitDestructuringAssign(e.left, t.x);
            M.localGet(t.x);                      // 赋值表达式结果 = RHS
            this._expLeave();
            return;
        }
        if (ts.isPropertyAccessExpression(e.left)) {
            if (e.left.name.text === "length") { this.emitTaggedExpr(e.right); this._emitStoreLength(e.left); return; }
            if (!ts.isSuperKeyword(e.left.expression) && this._hasSideEffects(e.left.expression) && this._hasSideEffects(e.right))
                throw new Error("[tagged] 属性赋值 o.f = v 中 o 带副作用且 RHS 亦带副作用：求值顺序未实现（JS 先 obj 后 v）");   // RHS 无副作用时可安全按现有顺序
            this.emitTaggedExpr(e.right); this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            const M = this.m;
            if (this._hasSideEffects(e.left.expression) || this._hasSideEffects(e.left.argumentExpression)) {
                const t1 = this._expEnter(), t2 = this._expEnter();          // 分层槽：与 _emitStoreElem 内部的临时槽互不重叠
                this.emitTaggedExpr(e.left.expression); M.localSet(t1.x);     // JS 顺序：obj → key → v
                this.emitTaggedExpr(e.left.argumentExpression); M.localSet(t2.x);
                this.emitTaggedExpr(e.right);
                this._emitStoreElem(e.left, t1.x, t2.x);
                this._expLeave(); this._expLeave();
                return;
            }
            this.emitTaggedExpr(e.right); this._emitStoreElem(e.left); return;
        }
        this.emitTaggedExpr(e.right);
        this._emitVarStore(e.left.text, this.scratchB); return;   // 含闭包捕获
    }
    const COMPOUND = {
        [ts.SyntaxKind.PlusEqualsToken]: ts.SyntaxKind.PlusToken,
        [ts.SyntaxKind.MinusEqualsToken]: ts.SyntaxKind.MinusToken,
        [ts.SyntaxKind.AsteriskEqualsToken]: ts.SyntaxKind.AsteriskToken,
        [ts.SyntaxKind.SlashEqualsToken]: ts.SyntaxKind.SlashToken,
        [ts.SyntaxKind.PercentEqualsToken]: ts.SyntaxKind.PercentToken,
        [ts.SyntaxKind.LessThanLessThanEqualsToken]: ts.SyntaxKind.LessThanLessThanToken,
        [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanToken,
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken]: ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        [ts.SyntaxKind.AmpersandEqualsToken]: ts.SyntaxKind.AmpersandToken,
        [ts.SyntaxKind.BarEqualsToken]: ts.SyntaxKind.BarToken,
        [ts.SyntaxKind.CaretEqualsToken]: ts.SyntaxKind.CaretToken,
        [ts.SyntaxKind.AsteriskAsteriskEqualsToken]: ts.SyntaxKind.AsteriskAsteriskToken,
    };
    if (COMPOUND[op] !== undefined) {
        if (ts.isPropertyAccessExpression(e.left)) {
            this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this._emitBinOp(COMPOUND[op]);
            this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right); this._emitBinOp(COMPOUND[op]);
            if (this._hasSideEffects(e.left.expression) || this._hasSideEffects(e.left.argumentExpression))
                throw new Error("[tagged] 元素复合赋值 o[带副作用] op= v 的求值顺序未实现");
            this._emitStoreElem(e.left); return;
        }
        if (COMPOUND[op] === ts.SyntaxKind.PlusToken) this._concatInPlace = this._concatSafe(e.left);
        this._emitVarGet(e.left.text); this.emitTaggedExpr(e.right);
        this._emitBinOp(COMPOUND[op]);
        this._emitVarStore(e.left.text, this.scratchB); return;
    }
    if (op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        // a ||= b → a = a || b（值语义短路，与 emitShortCircuit 一致）；a &&= b → a = a && b
        // 支持字段/索引目标（与 ??= 同款：接收者读+写各求值一次，无副作用表达式安全）
        const isAnd2 = op === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
        if (ts.isPropertyAccessExpression(e.left)) {
            if (e.left.name.text === "length") { this.emitShortCircuit(isAnd2, e.left, e.right); this._emitStoreLength(e.left); return; }
            if (this._hasSideEffects(e.left.expression))
                throw new Error("[tagged] 属性逻辑赋值 o.f ||=/&&= v 中 o 带副作用：求值顺序未实现");
            this.emitShortCircuit(isAnd2, e.left, e.right); this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            if (this._hasSideEffects(e.left.expression) || this._hasSideEffects(e.left.argumentExpression))
                throw new Error("[tagged] 元素逻辑赋值 o[带副作用] ||=/&&= v 的求值顺序未实现");
            this.emitShortCircuit(isAnd2, e.left, e.right); this._emitStoreElem(e.left); return;
        }
        this.emitShortCircuit(isAnd2, e.left, e.right);
        this._emitVarStore(e.left.text, this.scratchB); return;
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        this.emitShortCircuit(op === ts.SyntaxKind.AmpersandAmpersandToken, e.left, e.right);
        return;
    }
    // ?? / ??=：真短路 + 值语义（JS 精确）。a ?? b = nullish(a) ? b : a。
    if (op === ts.SyntaxKind.QuestionQuestionToken) {
        this.emitNullish(e.left, e.right);
        return;
    }
    if (op === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        // a ??= b ≡ a = a ?? b（同样支持字段/索引；接收者读+写各求值一次，无副作用表达式安全）
        if (ts.isPropertyAccessExpression(e.left)) {
            if (e.left.name.text === "length") { this.emitNullish(e.left, e.right); this._emitStoreLength(e.left); return; }
            this.emitNullish(e.left, e.right); this._emitStoreProp(e.left); return;
        }
        if (ts.isElementAccessExpression(e.left)) {
            if (this._hasSideEffects(e.left.expression) || this._hasSideEffects(e.left.argumentExpression))
                throw new Error("[tagged] 元素空值合并赋值 o[带副作用] ??= v 的求值顺序未实现");
            this.emitNullish(e.left, e.right); this._emitStoreElem(e.left); return;
        }
        this.emitNullish(e.left, e.right);
        this._emitVarStore(e.left.text, this.scratchB); return;
    }
    // 拼接左操作数来历 → 是否允许原地追加（_emitConcat 内部读 _concatInPlace）
    if (op === ts.SyntaxKind.PlusToken) this._concatInPlace = this._concatSafe(e.left);
    this.emitTaggedExpr(e.left); this.emitTaggedExpr(e.right);
    this._emitBinOp(op);
};
// 短路逻辑（值语义，真短路）：结果留 tagged i64。
//  && : truthy(a) ? b : a；|| : truthy(a) ? a : b
Emitter.prototype.emitShortCircuit = function (isAnd, left, right) {
    const M = this.m;
    M.block("i64"); this.depth++;                    // block (result i64)
    this.emitTaggedExpr(left);                       // [a]
    M.localSet(this.scratch);                        // []
    M.localGet(this.scratch);                        // [a]（跳转时作块结果）
    M.localGet(this.scratch); M.call("qz.truthy");   // [a, i32 ]
    if (isAnd) M.i32Eqz();                           // && : falsy(a) → 1
    M.brIf(0);                                       // 条件真 → 跳出块，[a] 为结果
    M.drop();                                        // 落下路径丢弃 a → []
    this.emitTaggedExpr(right);                      // 真短路：仅此路径求值 right
    this.depth--; M.end();
};
// 空值合并（??，真短路 + 值语义）：a ?? b = nullish(a) ? b : a。
// nullish 判定走宿主 qz.is_nullish（a == null || a == undefined）：null 在宿主侧是独立
// handles[idx] 句柄（bitsOf 不归一），wasm 内无法仅按 TAG|0 比对 —— 宿主 toJS 精确判。
Emitter.prototype.emitNullish = function (left, right) {
    const M = this.m;
    M.block("i64"); this.depth++;                    // block (result i64)
    this.emitTaggedExpr(left);                       // [a]
    M.localSet(this.scratch);                        // []
    M.localGet(this.scratch);                        // [a]（非空时作块结果）
    M.localGet(this.scratch); M.call("qz.is_nullish");  // [a, isNullish(i32)]
    M.i32Eqz();                                      // [a, !isNullish]
    M.brIf(0);                                       // 非 nullish → 跳出，[a] 为结果
    M.drop();                                        // nullish → 丢弃 a
    this.emitTaggedExpr(right);                      // 真短路：仅此路径求值 right
    this.depth--; M.end();
};
// 操作数已在栈上 [a, b]；按 op 发射运算。
// 双 BigInt（0x7FF8 句柄）前置路由 → qz.bigint_binop(opId, a, b)（宿主 handles 查值运算）；
// 否则按原数字/句柄 guard 发射。==/!= 对两 BigInt 与 ===/!== 同义（JS），共用 opId 5/6。
Emitter.prototype.BIGOP = null;   // 惰性建表（ts 运行时依赖）
Emitter.prototype._emitBinOp = function (op) {
    const M = this.m;
    if (!Emitter.prototype.BIGOP) {
        const K = ts.SyntaxKind;
        Emitter.prototype.BIGOP = {
            [K.PlusToken]: 0, [K.MinusToken]: 1, [K.AsteriskToken]: 2, [K.SlashToken]: 3, [K.PercentToken]: 4,
            [K.EqualsEqualsEqualsToken]: 5, [K.ExclamationEqualsEqualsToken]: 6,
            [K.EqualsEqualsToken]: 5, [K.ExclamationEqualsToken]: 6,
            [K.LessThanToken]: 7, [K.LessThanEqualsToken]: 8, [K.GreaterThanToken]: 9, [K.GreaterThanEqualsToken]: 10,
            [K.AmpersandToken]: 12, [K.BarToken]: 13, [K.CaretToken]: 14,
            [K.LessThanLessThanToken]: 15, [K.GreaterThanGreaterThanToken]: 16, [K.AsteriskAsteriskToken]: 17,
        };
    }
    const bigId = Emitter.prototype.BIGOP[op];
    if (bigId !== undefined) {
        if (op === ts.SyntaxKind.PlusToken) {
            // + 三路：双 BIG → binop(0)；涉及 BIG → 宿主 qz.add（JS 语义："x"+10n 拼接 / 10n+1 TypeError）；纯字符串/数字 → 原 _emitConcat
            M.localSet(this.scratchB); M.localSet(this.scratchA);
            this._emitIsBig(this.scratchA); this._emitIsBig(this.scratchB); M.i32Or();
            M.ifBlock("i64");
            this._emitIsBig(this.scratchA); this._emitIsBig(this.scratchB); M.i32And();
            M.ifBlock("i64");
            M.i32Const(bigId); M.localGet(this.scratchA); M.localGet(this.scratchB);
            M.call("qz.bigint_binop");
            M.else_();
            M.localGet(this.scratchA); M.localGet(this.scratchB); M.call("qz.add");
            M.end();
            M.else_();
            M.localGet(this.scratchA); M.localGet(this.scratchB);
            this._emitBinOpPlain(op);
            M.end();
            return;
        }
        M.localSet(this.scratchB); M.localSet(this.scratchA);
        this._emitIsBig(this.scratchA); this._emitIsBig(this.scratchB); M.i32And();
        M.ifBlock("i64");
        M.i32Const(bigId); M.localGet(this.scratchA); M.localGet(this.scratchB);
        M.call("qz.bigint_binop");
        M.else_();
        M.localGet(this.scratchA); M.localGet(this.scratchB);   // 非双 BIG → 原 guard 路径（BIG 混合经 _emitIsHandle → 宿主 JS 语义）
        this._emitBinOpPlain(op);
        M.end();
        return;
    }
    this._emitBinOpPlain(op);
};
// 原生运算发射（双 BIG 路由剥离后的原始路径；操作数 [a, b] 在栈上）。
Emitter.prototype._emitBinOpPlain = function (op) {
    const G = (qz, f64op, cmp) => () => this.emitGuardedOp(qz, f64op, cmp);
    const GUARD = {
        [ts.SyntaxKind.PlusToken]: () => this._emitConcat(),   // 任一操作数 0x7FFA → wasm 内拼接，否则数值（inPlace 由调用点设置）
        [ts.SyntaxKind.MinusToken]: G("qz.sub", this.m.f64Sub),
        [ts.SyntaxKind.AsteriskToken]: G("qz.mul", this.m.f64Mul),
        [ts.SyntaxKind.SlashToken]: G("qz.div", this.m.f64Div),
        [ts.SyntaxKind.PercentToken]: () => this.emitTaggedRem(),   // f64 无原生 rem → a - trunc(a/b)*b
        [ts.SyntaxKind.LessThanToken]: G("qz.lt", this.m.f64Lt, true),
        [ts.SyntaxKind.GreaterThanToken]: G("qz.gt", this.m.f64Gt, true),
        [ts.SyntaxKind.LessThanEqualsToken]: G("qz.le", this.m.f64Le, true),
        [ts.SyntaxKind.GreaterThanEqualsToken]: G("qz.ge", this.m.f64Ge, true),
        [ts.SyntaxKind.EqualsEqualsToken]: G("qz.eq", this.m.f64Eq, true),
        [ts.SyntaxKind.EqualsEqualsEqualsToken]: G("qz.seq", this.m.f64Eq, true),
        [ts.SyntaxKind.ExclamationEqualsToken]: G("qz.ne", this.m.f64Ne, true),
        [ts.SyntaxKind.ExclamationEqualsEqualsToken]: G("qz.sne", this.m.f64Ne, true),
        [ts.SyntaxKind.AmpersandToken]: () => this.emitGuardedBit("qz.band", this.m.i32And, false),
        [ts.SyntaxKind.BarToken]: () => this.emitGuardedBit("qz.bor", this.m.i32Or, false),
        [ts.SyntaxKind.CaretToken]: () => this.emitGuardedBit("qz.bxor", this.m.i32Xor, false),
        [ts.SyntaxKind.LessThanLessThanToken]: () => this.emitGuardedBit("qz.shl", this.m.i32Shl, false),
        [ts.SyntaxKind.GreaterThanGreaterThanToken]: () => this.emitGuardedBit("qz.shr", this.m.i32ShrS, false),
        [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken]: () => this.emitGuardedBit("qz.ushr", this.m.i32ShrU, true),
    };
    if (GUARD[op]) { GUARD[op](); return; }
    const map = {
        [ts.SyntaxKind.PlusToken]: "qz.add", [ts.SyntaxKind.MinusToken]: "qz.sub",
        [ts.SyntaxKind.AsteriskToken]: "qz.mul", [ts.SyntaxKind.SlashToken]: "qz.div",
        [ts.SyntaxKind.PercentToken]: "qz.rem",
        [ts.SyntaxKind.AsteriskAsteriskToken]: "qz.pow",   // ** 无原生 f64.pow → 总走宿主
    };
    if (map[op]) { this.m.call(map[op]); return; }
    throw new Error("[tagged] 不支持的运算符: " + ts.SyntaxKind[op]);
};
Emitter.prototype._taggedOpFor = function (binKind) {
    const m = { Add: "qz.add", Subtract: "qz.sub", Asterisk: "qz.mul", Slash: "qz.div", Percent: "qz.rem" };
    return m[binKind] || "qz.add";
};

