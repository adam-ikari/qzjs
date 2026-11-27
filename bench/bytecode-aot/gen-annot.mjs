#!/usr/bin/env node
// TS AST → 字节码 side table 标注（自动，无手工注解）。
// 输出 JSON：每个函数的纯数值循环/类型信息，由 annotate.c 注入函数字节码对象。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('../../src/qzvm/aot/node_modules/typescript');
const { verifyPure } = require('../../src/qzvm/aot/emit/pure-hoist.js');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = process.env.OUT || '/tmp/tsdirect';
fs.mkdirSync(OUT, { recursive: true });

const dir = path.join(ROOT, 'bench', 'aot-product', 'workloads', 'es2023');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();

const annotOf = (file) => {
  const src = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^export /gm, '');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2020, true);
  const fn = sf.statements.find((n) => ts.isFunctionDeclaration(n) && n.name && n.name.text === 'work');
  if (!fn || !fn.body) return null;
  // 纯度判据只作用于循环体：setup/tail 里的 new/class/ES2023 语法仍由解释器执行，不参与拆分。
  const loop0 = fn.body.statements.find((n) => ts.isForStatement(n));
  const fakeFn = { body: loop0 || fn.body, parameters: fn.parameters,
                   type: fn.type, modifiers: fn.modifiers, asteriskToken: fn.asteriskToken };
  const pure = verifyPure(fakeFn, new Set(), new Set(), new Set(['s', 'i', 'a']));
  const params = {}, locals = {};
  for (const p of fn.parameters || [])
    if (ts.isIdentifier(p.name)) params[p.name.text] = p.type && p.type.kind === ts.SyntaxKind.NumberKeyword ? 'number' : 'other';
  const collect = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name))
      locals[n.name.text] = n.type && n.type.kind === ts.SyntaxKind.NumberKeyword ? 'number' : 'other';
    ts.forEachChild(n, collect);
  };
  collect(fn.body);
  const loop = fn.body.statements.find((n) => ts.isForStatement(n));
  // Optional chaining introduces object/nullish short-circuit state that the
  // numeric fragment cannot represent. `??=` compiles to numeric-check + branch
  // opcodes and is accepted here; unsupported right-hand sides still fail closed
  // in mapOpcodes.
  let suspendInLoop = false;
  if (loop) {
    const walk = (n) => {
      if (ts.isPropertyAccessExpression(n) && n.questionDotToken) suspendInLoop = true;
      ts.forEachChild(n, walk);
    };
    walk(loop);
  }
  return {
    work: {
      pure,
      params,
      locals,
      loop: loop ? { startLine: sf.getLineAndCharacterOfPosition(loop.getStart(sf)).line + 1,
                     endLine: sf.getLineAndCharacterOfPosition(loop.end).line + 1 } : null,
      esOperatorInLoop: suspendInLoop,
    },
  };
};

for (const file of files) {
  const name = path.basename(file, '.ts');
  const a = annotOf(file);
  if (!a) { console.log(`${name}: NO FUNCTION`); continue; }
  const text = JSON.stringify(a);
  fs.writeFileSync(path.join(OUT, `${name}.annot`), text);
  console.log(`${name}: pure=${a.work.pure} esOpInLoop=${a.work.esOperatorInLoop} annot=${text.length}B`);
}
