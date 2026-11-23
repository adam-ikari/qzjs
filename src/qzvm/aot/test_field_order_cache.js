#!/usr/bin/env node
"use strict";
/* field_order_lit 的静态字段名表按 sid 解码一次；同一字面量多次分配不得重复 split。 */
const assert = require("assert");
const { makeQzvm } = require("./qzvm.js");

let decodes = 0;
const names = { split(sep) { decodes++; assert.strictEqual(sep, "\u0000"); return ["id", "name"]; } };
const qz = makeQzvm([names]);
const objA = 0x7ff9_0000_0000_0008n;
const objB = 0x7ff9_0000_0000_0010n;

qz.field_order_lit(objA, 0);
qz.field_order_lit(objB, 0);

assert.strictEqual(decodes, 1, `expected one decode for repeated sid, got ${decodes}`);
console.log("field_order_lit caches static field names");
