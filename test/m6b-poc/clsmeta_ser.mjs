// classMeta → guest 内存序列化（供 C 侧 __set_clsmeta 读）。
// 格式见 src/qzvm/guest_entry.c qz_clsmeta 注释：
//   [count:i32][clsId0_itemOff:i32]×count  索引表
//   项数据紧密排列：
//     [clsId:i32][parent:i32(-1)][instSize:i32][ctorSlot:i32(-1)]
//     [nMethods:i32][nStatics:i32][nAccessors:i32]
//     methods  × nMethods  : [nameStrId:i32][slot:i32][n:i32][rest:i8][pad×3]
//     statics  × nStatics  : [nameStrId:i32][slot:i32][n:i32]
//     accessors× nAccessors: [nameStrId:i32][getSlot:i32][setSlot:i32]
// nameStrId 必须与 emitter 的 strings 表对齐（emitter 已为每个方法名分配 strId）。
export function serializeClassMeta(L, mem, classMeta) {
  if (!classMeta || !classMeta.length) return 0;
  // 第一遍：算每项字节数
  const items = classMeta.map(c => {
    const methods = Object.values(c.methods);
    const statics = Object.values(c.staticMethods);
    const accessors = Object.entries(c.getters).map(([name, g]) => ({
      nameStrId: g.nameStrId, getSlot: g.slot, setSlot: (c.setters[name] || {}).slot ?? -1
    }));
    const hdr = 28;
    const methodsBytes = methods.length * 16;
    const staticsBytes = statics.length * 12;
    const accessorsBytes = accessors.length * 12;
    return { c, methods, statics, accessors, bytes: hdr + methodsBytes + staticsBytes + accessorsBytes };
  });
  const idxSize = 4 + items.length * 4;
  let total = idxSize + items.reduce((a, b) => a + b.bytes, 0);
  const base = L.alloc(total + 16);
  const v = new DataView(mem.buffer);
  v.setUint32(base, items.length, true);
  let cur = base + idxSize;
  items.forEach((it, i) => {
    v.setUint32(base + 4 + i * 4, cur, true);
    const c = it.c;
    v.setUint32(cur, c.id, true);
    v.setInt32(cur + 4, c.parent == null ? -1 : c.parent, true);
    // offset 8 = 实例字节数（C 侧 new_dynamic 据此分配内存并按内联布局写头）。
    // 原为「类名 strId」占位，从未使用——C 侧不需要类名（资质由 clsId 定位）。
    v.setInt32(cur + 8, c.size || 0, true);
    v.setInt32(cur + 12, c.ctorSlot == null ? -1 : c.ctorSlot, true);
    v.setUint32(cur + 16, it.methods.length, true);
    v.setUint32(cur + 20, it.statics.length, true);
    v.setUint32(cur + 24, it.accessors.length, true);
    let q = cur + 28;
    for (const m of it.methods) {
      v.setUint32(q, m.nameStrId, true);
      v.setInt32(q + 4, m.slot, true);
      v.setInt32(q + 8, m.n, true);
      v.setInt8(q + 12, m.rest ? 1 : 0);
      q += 16;
    }
    for (const sm of it.statics) {
      v.setUint32(q, sm.nameStrId, true);
      v.setInt32(q + 4, sm.slot, true);
      v.setInt32(q + 8, sm.n, true);
      q += 12;
    }
    for (const ac of it.accessors) {
      v.setUint32(q, ac.nameStrId, true);
      v.setInt32(q + 4, ac.getSlot ?? -1, true);
      v.setInt32(q + 8, ac.setSlot ?? -1, true);
      q += 12;
    }
    cur += it.bytes;
  });
  L.__set_clsmeta(base);
  return base;
}

// 全局字段表序列化：emitter 的 fieldMap 是全局的（偏移恒为 (idx+1)*8），
// 故只需按索引顺序注入名字，C 侧即可定位任意类实例的字段。
// 布局：[count:i32][strOff:i32][len:i32]×count，字符串本体紧随其后。
export function serializeFields(L, mem, fields) {
  if (!fields || !fields.length) return 0;
  const blob = fields.map(n => Buffer.from(n, 'utf8'));
  const tbl = 4 + blob.length * 8;
  const total = tbl + blob.reduce((a, b) => a + b.length, 0);
  const base = L.alloc(total + 16);
  const v = new DataView(mem.buffer);
  v.setUint32(base, blob.length, true);
  let cur = base + tbl;
  blob.forEach((b, i) => {
    v.setUint32(base + 4 + i * 8, cur, true);
    v.setUint32(base + 8 + i * 8, b.length, true);
    new Uint8Array(mem.buffer, cur, b.length).set(b);
    cur += b.length;
  });
  L.__set_fields(base);
  return base;
}

// lambda synthThis 表：告知 C 侧哪些蹦床表槽收 receiver（`this` 形参）。
// 布局：[slotBase:i32][count:i32] 后跟 count 个 (slot:i32, synth:i32)。
export function serializeLamSynth(L, mem, lamMeta, trampSlots) {
  if (!lamMeta || !trampSlots) return 0;
  const rows = [];
  for (const [fname, slot] of trampSlots) {
    const base = fname.replace(/\$t$/, '');
    const meta = Object.values(lamMeta).find(m => m && m.name === base);
    if (meta && meta.synthThis) rows.push([slot, 1]);
  }
  if (!rows.length) return 0;
  const base = L.alloc(8 + rows.length * 8 + 16);
  const v = new DataView(mem.buffer);
  v.setInt32(base, 0, true);
  v.setInt32(base + 4, rows.length, true);
  rows.forEach(([s, y], i) => {
    v.setInt32(base + 8 + i * 8, s, true);
    v.setInt32(base + 12 + i * 8, y, true);
  });
  L.__set_lamsynth(base, rows.length);
  return base;
}
