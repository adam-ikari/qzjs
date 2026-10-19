// classMeta → guest 内存序列化（供 C 侧 __set_clsmeta 读）。
// 格式见 src/qzvm/guest_entry.c qz_clsmeta 注释：
//   [count:i32][clsId0_itemOff:i32]×count  索引表
//   项数据紧密排列：
//     [clsId:i32][parent:i32(-1)][nameStrId:i32][ctorSlot:i32(-1)]
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
    v.setInt32(cur + 8, -1, true);              // 类名 strId（暂不用，-1 占位）
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
