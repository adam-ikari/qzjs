const { compileTS } = require('/home/gem/project/qzjs/src/qzvm/aot/emitter.js');
const r = compileTS('/home/gem/project/qzjs/test/m6b-poc/add.ts', '/home/gem/project/qzjs/test/m6b-poc/add_inmod.wasm', { needMathFloor: true, inModuleLink: true });
console.log('imports:', r.module.imports.map(i => i.module + '.' + (i.field || (i.memory ? 'memory' : '?'))).join(', '));
console.log('wrote', require('fs').statSync('/home/gem/project/qzjs/test/m6b-poc/add_inmod.wasm').size, 'bytes');
