const { compileTS } = require('/home/gem/project/qzjs/src/qzvm/aot/emitter.js');
const r = compileTS('/home/gem/project/qzjs/test/m6b-poc/concat.ts', '/home/gem/project/qzjs/test/m6b-poc/concat_inmod.wasm', { needMathFloor: true, inModuleLink: true });
console.log('imports:', r.module.imports.map(i => i.module + '.' + (i.field || (i.memory ? 'memory(min'+i.memory.min+')' : '?'))).join(', '));
