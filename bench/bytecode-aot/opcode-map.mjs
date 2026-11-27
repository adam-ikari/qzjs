// QuickJS opcode → wasm f64 指令的局部机械映射（实验用，窄子集）。
// 只覆盖 work() 那类纯数值循环；遇到未覆盖 opcode 抛错，由调用方报告适用性边界。

export const uleb = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
export const f64c = (x) => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return [0x44, ...b]; };
export const section = (id, payload) => [id, ...uleb(payload.length), ...payload];
export const vec = (items) => [...uleb(items.length), ...items.flat()];

// qzjs locals: 0=s,1=i,2=a → wasm locals 1,2,3（0 是参数 n）；4/5 供 mod 展开用。
const LOC = { s: 1, i: 2, a: 3 };  // 按变量名映射，不按 QuickJS 局部槽位号
const nu = (s) => parseInt(String(s).replace(/[^0-9-]/g, ''), 10);

export function mapOpcodes(ops) {
  const code = [];
  let mapped = 0, ignored = 0;
  const labels = new Map();
  ops.forEach((entry, index) => {
    if (Number.isInteger(entry[3])) labels.set(entry[3], index);
  });
  const lastPc = labels.size ? Math.max(...labels.keys()) : -1;
  const openBranches = [];

  for (let index = 0; index < ops.length; index++) {
    while (openBranches.length && openBranches[openBranches.length - 1] === index) {
      code.push(0x0b);
      openBranches.pop();
    }
    const [op, arg, name, pc] = ops[index];
    if (op === 'get_loc_check' || op === 'get_loc') {
      const slot = LOC[name]; if (slot === undefined) throw new Error(`UNMAPPED local: ${name}`);
      code.push(0x20, slot); mapped++;
    }
    else if (op === 'get_arg0') { code.push(0x20, 0); mapped++; }
    else if (op === 'push_0' || op === 'push_1' || op === 'push_2' || op === 'push_3') { code.push(...f64c(nu(op.slice(-1)))); mapped++; }
    else if (op.startsWith('push_i')) { code.push(...f64c(nu(arg))); mapped++; }
    else if (op === 'add') { code.push(0xa0); mapped++; }
    else if (op === 'sub') { code.push(0xa1); mapped++; }
    else if (op === 'mul') { code.push(0xa2); mapped++; }
    else if (op === 'mod') {   // wasm MVP 无 f64.rem：a - trunc(a/b)*b（4/5 槽临时）
      code.push(0x21, 0x04, 0x21, 0x05, 0x20, 0x05,
                0x20, 0x05, 0x20, 0x04, 0xa3, 0x9d, 0x20, 0x04, 0xa2, 0xa1); mapped++;
    }
    else if (op === 'lt') { code.push(0x63); mapped++; }
    else if (op === 'is_undefined_or_null') {
      // This fragment only carries f64 values, so nullish values cannot enter it.
      code.push(0x1a, 0x41, 0x00); mapped++;
    }
    else if (op === 'if_false8') {
      const targetPc = nu(arg);
      const targetIndex = labels.get(targetPc);
      if ((Number.isInteger(pc) && targetPc <= pc)
          || (targetIndex !== undefined && targetIndex <= index)) {
        throw new Error(`UNMAPPED backward branch: ${op} ${arg}`);
      }
      if (labels.size && targetPc <= lastPc && targetIndex === undefined) {
        throw new Error(`UNMAPPED branch target: ${op} ${arg}`);
      }
      if (targetIndex !== undefined) {
        // QuickJS falls through when true; wasm `if` has the same shape.
        code.push(0x04, 0x40);
        openBranches.push(targetIndex);
      } else {
        // Leave the surrounding loop block when false.
        code.push(0x45, 0x0d, openBranches.length + 1);
      }
      mapped++;
    }
    else if (op === 'goto8') {
      const targetIndex = labels.get(nu(arg));
      if (targetIndex !== 0) throw new Error(`UNMAPPED goto target: ${op} ${arg}`);
      code.push(0x0c, 0x00); mapped++;
    }
    else if (op.startsWith('put_loc')) {
      const slot = LOC[name]; if (slot === undefined) throw new Error(`UNMAPPED local: ${name}`);
      code.push(0x21, slot); mapped++;
    }
    else if (op === 'dup' || op === 'drop' || op === 'set_loc_uninitialized') { ignored++; }
    else throw new Error(`UNMAPPED opcode: ${op} ${arg}`);
  }
  if (openBranches.length) throw new Error('UNMAPPED branch target outside opcode slice');
  return { code, mapped, ignored };
}
