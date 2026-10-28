#!/usr/bin/env node
/* emitter.js — tsc AST → wasm 发射器（入口）。
 *
 * 实现已拆到 ./emit/ 下，本文件只做转发，保持既有 `require("./emitter.js")` 调用面不变：
 *   emit/consts.js      qz.* 契约面、名字编码、内建全局集、源码文本工具（叶子）
 *   emit/layout.js      堆/字符串/数组布局常量与内存辅助发射（≤ consts）
 *   emit/emitter.js     Emitter 核心：AST → wasm 指令（≤ layout）
 *   emit/tagged-core.js tagged 公共方法（属性名折叠/arena 释放），副作用挂 prototype（≤ layout, emitter）
 *   emit/tagged.js      tagged 模式发射：动态值语句/表达式（≤ 以上全部）
 * 依赖单向无环；`tagged-core.js`/`tagged.js` 均以副作用挂 prototype，故 compile-ts.js 顶部 require tagged.js。
 *
 * 值模型（双模式）：
 *   num 快路径（参数全 number 注解）：值 = 裸 f64 local，算术走原生 wasm 指令（零跨界）。
 *   tagged 动态路径（含 unknown/对象/字符串）：值 = i64，经 qz.* import。
 *     f64 NaN-box：数值=原始 f64 位型，句柄=高16位0x7FF9|低32 offset；字段 8 字节。
 *     与宿主字长无关（wasm f64 恒 double），32/64 位设备共用，见 PORTABILITY_32BIT.md。
 */
"use strict";
const fs = require("fs");
const { compileTS } = require("./emit/compile-ts.js");
const { Emitter } = require("./emit/emitter.js");

module.exports = { compileTS, Emitter };

if (require.main === module) {
    const input = process.argv[2];
    const out = process.argv[3] || "/tmp/out.wasm";
    const r = compileTS(input, out, {});
    console.log("wrote", out, fs.statSync(out).size, "bytes; imports:", r.module.imports.length, "funcs:", r.module.funcs.length, "strings:", r.strings.length);
}
