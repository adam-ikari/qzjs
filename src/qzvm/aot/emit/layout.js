/* layout.js — 堆/字符串/数组布局常量与内存辅助发射
 * emitter.js 拆分件；模块图见 ../emitter.js 顶部注释。 */
"use strict";
const ts = require("typescript");

// ---------- 主流程 ----------
// ---------- 字符串（wasm 内表示，零跨界）----------
// 句柄 = i64 高16位 0x7FFA | 低32位 = 字符串结构偏移（结构 [len:i32][utf8 bytes]）。
// 字面量驻留 data 段（STR_BASE 起）；动态拼接走 bump 堆（global0 从 STR_BUMP 起）。
// 数字→字符串用固定 scratch 区（SCRATCH 起）。
const STR_TAG_HI = 0x7ffa;                       // 字符串句柄高 16 位标记
const ARR_TAG_HI = 0x7ffb;                       // 数组句柄高 16 位标记（布局 [len:i32][pad:i32][elem:i64×N]，元素 +8 起）。
                                                 // 不可用 0x7FF8：那是 canonical quiet NaN（宿主 box(NaN) 恰产此位型），
                                                 // 与 f64 算术结果相撞 → 任何 NaN 会被误判为数组句柄。
/* 引用计数块头（每个 bump 分配前置 16 字节，位于数据区之前）：
 *   [hdr+0] = rc     : i32 引用计数。0 = 空闲块，可被后续分配复用。
 *   [hdr+4] = size   : i32 覆盖「头 + 数据」的总字节数（回收时按此推进到下一块）。
 *   [hdr+8] = kind   : i32 块种类（K_* 常量），决定 rc_dec 如何遍历子引用。
 *   [hdr+12]= nslots : i32 数据区内可含句柄的槽数（macrotask 统一递归用）。
 * 分配仍返回数据区偏移（hdr+16），故所有既有字段偏移 [0]/[4]/[8]… 语义不变。 */
const RC_HDR = 16;
/* 块种类：决定 rm/rc_dec 递归时如何解释数据区。宿主侧按同值解释（见 qzvm.js）。 */
const K_PLAIN = 0;        // 无子引用（字符串、num 数组、闭包环境等）
const K_POJO  = 1;        // 对象字面量/实例：槽 [4, size) 每 8 字节一个句柄
const K_ARR   = 2;        // 数组头：[0]=len [4]=cap [8]=dataOff；子引用在 dataOff 起每个 i64
const SCRATCH = 16;                              // numstr 临时区（48 字节，够 20 位 + 负号 + len）
const STR_BASE = 128;                            // 独立档字面量段基址（紧跟 scratch，跳过 [0,128)）
const STR_BUMP = 128;                            // 无字面量时的 arena 起点（= STR_BASE；有字面量时后移）
/* in-module 合并形态布局（与 libqzvm 共享 memory）。
 * 依据：libqzvm wasi-libc 堆自 __heap_base(≈698KB) 向上增长，实测 5 万对象后堆顶
 * 7.19MiB；取 12MiB 为界留余量。emitter arena 全在其上，字面量段再上抬 8MiB。*/
const INMOD_HOST_LIMIT = 12 << 20;               // libqzvm 段上界（12 MiB）：emitter bump 起点
const INMOD_STR_BUMP   = INMOD_HOST_LIMIT;       // in-module bump 堆起始
const INMOD_TABLE_CAP = 514;      // libqzvm 导出表容量（cmake 链接生成，见 --export-table）
const INMOD_TABLE_RESERVE = 4096; // 产物蹦床可用槽数（闭包 + 类方法）
const INMOD_STR_BASE   = 20 << 20;               // in-module 字面量段基址（20 MiB，libqzvm 段 12MiB + arena 8MiB）
const INMOD_PAGES      = 1024;                   // 64 MiB（字面量段 [20MiB, 64MiB)）

/* 独立档内存布局（opts.memMiB = 线性内存初始大小，MiB，默认 40，最小 8）。
 * in-module 的 memory 由 libqzvm 导入，大小归 src/qzvm/CMakeLists.txt 的
 * --initial-memory 管，不经此处。
 *
 * 布局（关键：arena 必须在**高地址**才能按需 grow）：
 *   scratch [16,64) / 字面量段 [128, litEnd) / bump arena [arenaBase, ceil)
 * arenaBase = align8(litEnd)（字面量段用量是编译期常量，第一趟发射后即知）；
 * arena 上界不进编译期常量，存 global，越过时 memory.grow 抬高，
 * 直到 memory 达到 maxPages —— arena 不再是硬天花板。 */
function memLayout(opts) {
    const mib = (opts && opts.memMiB) || 40;
    if (!(mib >= 8)) throw new RangeError(`memMiB 至少 8（初值下限），收到 ${mib}`);
    const pages = Math.ceil(mib * 16);
    // 上限 = 32 位地址空间能表达的最大页数（65536 页 = 4 GiB）。
    // 不再是「初始 ×N」——数组按几何扩容时旧块不回收，峰值 ≈ 终值×2，
    // 给死上限会在峰值处误杀；到 4 GiB 才是物理极限。
    const maxPages = 65536;
    return { pages, maxPages };
}

// 字符串 helper 函数（每模块一份，emitter call 调用）

// 推进 bump 堆：emitDelta 把增量(i32)压栈；新值经 qzs_ckmem 守卫（越界 trap）后写回 global0。
function emitBumpGrow(m, emitDelta) {
    m.globalGet(0); emitDelta(); m.i32Add(); m.call("qzs_ckmem"); m.globalSet(0);
}
/* 分配 emitTotal 字节：bump 经守卫增长后回退，栈顶留「数据区 offset」(i32)。
 * 每次分配前置 RC_HDR 字节块头：[rc][size][kind][nslots]（见 K_* 与 RC_HDR 注释）。
 * 返回数据区偏移（hdr+RC_HDR），故所有既有字段偏移 [0]/[4]/[8]… 语义不变。
 * hdr 由 `bump - total` 重算（emitTotal 是常量/localGet，无分配、可重复求值），
 * 因此不需要临时 local 或全局 scratch。
 * kind/nslots 由调用方在本函数返回后自行落定（多数块无子引用，默认下为 0）。 */
function emitBumpAlloc(m, emitTotal, fl) {
    fl = fl === undefined ? m.freeGlobals : fl;      // 调用点无需重复传（m.freeGlobals 由 emitAll 绑定）
    const total = () => { emitTotal(); m.i32Const(RC_HDR); m.i32Add(); };   // 头 + 数据
    const hdr = () => { m.globalGet(0); total(); m.i32Sub(); };             // 块头偏移
    /* 先试空闲链：rc 归零的块已由 qzs_rc_dec 或宿主 GC 清扫挂上（链节点复用块头 [hdr+0] 存 next）。
     * 只复用**首个 size 足够**的块，不切分剩余空间——切分要再写一个块头，
     * 对当前负载（同尺寸对象反复分配）收益为零。
     * 状态全放全局（freeCur/freeHit），因为本函数在任意表达式求值中间被调，
     * 不能安全新增 wasm 局部变量。fl=undefined（无空闲链）时直接走 bump。 */
    if (fl !== undefined) {
        m.i32Const(0); m.globalSet(fl.hit);                        // 每次分配前清零命中槽
        m.globalGet(fl.list); m.globalSet(fl.cur);                 // cur = 链头
        m.block("void"); m.loop("void");
          m.globalGet(fl.cur); m.i32Eqz(); m.brIf(1);              // 空链 → 出
          /* 顺序关键：先压 cur 再 i32Load（地址=cur，得块旧 size），最后求请求大小 total。
           * 原先把 total() 排在 i32Load 之前 → load 把 total 这个**大小**当地址读 memory[total+4]，
           * 拿到的垃圾与请求大小比较，会匹配到错误节点并把块头 size 写成垃圾
           * （实测复用后 hdr=184 size=2147155968，块链直接断）。 */
          m.globalGet(fl.cur); m.i32Load(2, 4); total(); m.i32GeU();
          m.ifBlock("void");
            m.globalGet(fl.cur); m.i32Load(2, 0); m.globalSet(fl.list);   // 链头 = cur.next
            m.globalGet(fl.cur); m.i32Const(1); m.i32Store(2, 0);         // rc = 1（覆盖链 next 指针）
            m.globalGet(fl.cur); total(); m.i32Store(2, 4);               // size = total
            /* kind/nslots **必须清零**：空闲链节点的 [hdr+8]/[hdr+12] 仍是上一个占用者的值。
             * 不清会留下幽灵引用——实测复用 {id,name,tags} 的块后，GC 按旧 kind=K_ARR/nslots=2
             * 去遍历已被覆盖的数据区，把垃圾指针当根 → 整轮 freed=0（对象永不回收）。
             * 调用方随后会按需自行落定真正的 kind/nslots。 */
            m.globalGet(fl.cur); m.i32Const(0); m.i32Store(2, 8);
            m.globalGet(fl.cur); m.i32Const(0); m.i32Store(2, 12);
            m.globalGet(fl.cur); m.i32Const(RC_HDR); m.i32Add(); m.globalSet(fl.hit);  // 数据区偏移
            m.br(2);                                                      // 跳出 loop+block
          m.end();
          m.globalGet(fl.cur); m.i32Load(2, 0); m.globalSet(fl.cur);      // cur = cur.next
          m.br(0);
        m.end(); m.end();
    }
    if (fl === undefined) {                            // 无空闲链（未绑定全局）→ 纯 bump 路径
      emitBumpGrow(m, total);
      hdr(); m.i32Const(1); m.i32Store(2, 0);
      hdr(); total(); m.i32Store(2, 4);
      hdr(); m.i32Const(0); m.i32Store(2, 8);
      hdr(); m.i32Const(0); m.i32Store(2, 12);
      hdr(); m.i32Const(RC_HDR); m.i32Add();           // → 数据区偏移
      return;
    }
    m.globalGet(fl.hit); m.i32Eqz();
    m.ifBlock("void");
      emitBumpGrow(m, total);
      hdr(); m.i32Const(1); m.i32Store(2, 0);          // [hdr+0]  = rc = 1（新建即被调用方持有）
      hdr(); total(); m.i32Store(2, 4);                // [hdr+4]  = size
      hdr(); m.i32Const(0); m.i32Store(2, 8);          // [hdr+8]  = kind（默认无子引用）
      hdr(); m.i32Const(0); m.i32Store(2, 12);         // [hdr+12] = nslots
      hdr(); m.i32Const(RC_HDR); m.i32Add(); m.globalSet(fl.hit);   // 新块数据区偏移
    m.end();
    m.globalGet(fl.hit);                               // → 数据区偏移（i32）
}
// 直接落定 bump 新值：emitNewVal 压栈得 newBump(i32)，经 qzs_ckmem 守卫后写回 global0。
function emitBumpSet(m, emitNewVal) {
    emitNewVal(); m.call("qzs_ckmem"); m.globalSet(0);
}
// 基础内存 helper（qzs_ckmem / qzs_memcpy）：num 数组扩容与字符串路径共用，
// 故无条件发射（--interp 全退时无字符串 helper，num 数组仍需此二者）。
function emitMemHelpers(m, strBase, arenaCeilGlobal, maxPages, freeListGlobal) {
    // qzs_ckmem(newBump:i32) -> i32：bump 越界守卫 + 自动扩容。
    // 布局：字面量段固定在低地址 [.., strBase)，arena 在 [strBase, ceil) 向上长。
    // arena 上界存在 global（arenaCeilGlobal）里，越界时 memory.grow 抬高上界，
    // 直到 memory 达到 maxPages；仍不够才 qz.oom（宿主抛 RangeError，可 catch）。
    // 这样 arena 不再是编译期硬上限，而是随需增长到 wasm 内存上限。
    m.declareFunc("qzs_ckmem", ["i32"], ["i32"]);
    m.startBody("qzs_ckmem", ["i32"], []);
    if (arenaCeilGlobal === undefined) {          // 退路：无扩容（in-module 档，内存由 C 侧管）
        m.localGet(0); m.i32Const(strBase); m.i32GtU();
        m.ifBlock("void"); m.call("qz.oom"); m.unreachable(); m.end();
    } else {
        m.localGet(0); m.globalGet(arenaCeilGlobal); m.i32GtU();
        m.ifBlock("void");
        // 每次 grow 32 页（2 MiB）直到够用或达上限
        m.block("void"); m.loop("void");
        m.i32Const(maxPages); m.memorySize(); m.i32GtU();   // 还有增长空间?
        m.i32Eqz(); m.brIf(1);                              // 到顶 → 退出循环
        m.i32Const(32); m.memoryGrow(); m.drop();            // grow 32 页
        m.memorySize(); m.i32Const(16); m.i32Shl(); m.globalSet(arenaCeilGlobal);   // ceil = pages*64KiB
        m.globalGet(arenaCeilGlobal); m.localGet(0); m.i32GeU(); m.brIf(1);          // 够用 → 退出
        m.br(0);
        m.end(); m.end();
        m.localGet(0); m.globalGet(arenaCeilGlobal); m.i32GtU();
        m.ifBlock("void"); m.call("qz.oom"); m.unreachable(); m.end();
        m.end();
    }
    m.localGet(0);
    m.endBody();
    // qzs_memcpy(dest, src, n)：先 8 字节块（i64.load/store，wasm 允许非对齐），尾字节。
    // 逐字节版对每次 append 的小 n 太慢（真实上下文 ~178ns/byte）。
    m.declareFunc("qzs_memcpy", ["i32", "i32", "i32"], []);
    m.startBody("qzs_memcpy", ["i32", "i32", "i32"]);
    m.localGet(0); m.localSet(5);                        // dest → 5
    m.localGet(1); m.localSet(4);                        // src → 4
    m.localGet(2); m.localSet(3);                        // n → 3
    // 8 字节块
    m.block("void"); m.loop("void");
    m.localGet(3); m.i32Const(8); m.i32LtU(); m.brIf(1);
    m.localGet(5); m.localGet(4); m.i64Load(0, 0); m.i64Store(0, 0);
    m.localGet(5); m.i32Const(8); m.i32Add(); m.localSet(5);
    m.localGet(4); m.i32Const(8); m.i32Add(); m.localSet(4);
    m.localGet(3); m.i32Const(8); m.i32Sub(); m.localSet(3);
    m.br(0); m.end(); m.end();
    // 尾字节
    m.block("void"); m.loop("void");
    m.localGet(3); m.i32Eqz(); m.brIf(1);
    m.localGet(5); m.localGet(4); m.i32Load8U(0, 0); m.i32Store8(0, 0);
    m.localGet(5); m.i32Const(1); m.i32Add(); m.localSet(5);
    m.localGet(4); m.i32Const(1); m.i32Add(); m.localSet(4);
    m.localGet(3); m.i32Const(1); m.i32Sub(); m.localSet(3);
    m.br(0); m.end(); m.end();
    m.endBody();
    // ── 引用计数（确定性回收）────────────────────────────────────────────
    // qzs_rc_inc(off:i32)：数据区 off → 块头 = off-RC_HDR，rc+1。
    m.declareFunc("qzs_rc_inc", ["i32"], []);
    m.startBody("qzs_rc_inc", []);
    m.localGet(0); m.i32Const(RC_HDR); m.i32Sub();                   // hdr（写地址）
    m.localGet(0); m.i32Const(RC_HDR); m.i32Sub(); m.i32Load(2, 0); m.i32Const(1); m.i32Add(); m.i32Store(2, 0);
    m.endBody();
    /* qzs_rc_dec(off:i32)：rc-1；归零则级联回收并挂空闲链。
     * 空闲链：块头 [hdr+0] 复用为 next（rc=0 已无意义），链头 = freeList 全局。
     * locals: 1=hdr 2=size 3=kind 4=p 5=end 6=tmp 7=child(i64) */
    m.declareFunc("qzs_rc_dec", ["i32"], []);
    m.startBody("qzs_rc_dec", ["i32", "i32", "i32", "i32", "i32", "i32", "i64"]);
    m.localGet(0); m.i32Const(RC_HDR); m.i32Sub(); m.localSet(1);        // hdr
    m.localGet(1); m.localGet(1); m.i32Load(2, 0); m.i32Const(1); m.i32Sub(); m.i32Store(2, 0);
    m.localGet(1); m.i32Load(2, 0); m.i32Eqz(); m.ifBlock("void");
    m.localGet(1); m.i32Load(2, 8); m.localSet(3);                       // kind
    m.localGet(1); m.i32Load(2, 4); m.localSet(2);                       // size（含头）
    // 子槽区间：p..end。ARR → [dataOff, dataOff+len*8)；POJO → [off+8, hdr+size)；其余空。
    m.localGet(3); m.i32Const(K_ARR); m.i32Eq(); m.ifBlock("void");
    m.localGet(0); m.i32Load(2, 8); m.localSet(4);                       // p = dataOff
    m.localGet(4); m.localGet(0); m.i32Load(2, 0); m.i32Const(8); m.i32Mul(); m.i32Add(); m.localSet(5);
    m.else_();
    m.localGet(3); m.i32Const(K_POJO); m.i32Eq(); m.ifBlock("void");
    m.localGet(0); m.i32Const(8); m.i32Add(); m.localSet(4);             // p = off + 8（跳过 clsId/size）
    m.localGet(1); m.localGet(2); m.i32Add(); m.localSet(5);             // end = hdr + size
    m.else_();
    m.i32Const(0); m.localSet(4); m.localGet(4); m.localSet(5);          // 空区间
    m.end(); m.end();
    m.block("void"); m.loop("void");
    m.localGet(4); m.localGet(5); m.i32GeU(); m.brIf(1);
    m.localGet(4); m.i64Load(3, 0); m.localSet(7);                       // child
    // 仅堆句柄（0x7FF9/0x7FFE/0x7FFA/0x7FFB）且落在 arena 内才递归；f64 位型与字面量跳过。
    m.localGet(7); m.i64Const(32n); m.i64ShrU(); m.i64Const(0x7ff9n); m.i64Eq();
    m.localGet(7); m.i64Const(32n); m.i64ShrU(); m.i64Const(0x7ffen); m.i64Eq(); m.i32Or();
    m.localGet(7); m.i64Const(32n); m.i64ShrU(); m.i64Const(0x7ffan); m.i64Eq(); m.i32Or();
    m.localGet(7); m.i64Const(32n); m.i64ShrU(); m.i64Const(0x7ffbn); m.i64Eq(); m.i32Or();
    m.ifBlock("void");
    m.localGet(7); m.i32WrapI64(); m.i32Const(strBase); m.i32GeU();
    m.ifBlock("void");
    m.localGet(7); m.i32WrapI64(); m.call("qzs_rc_dec");
    m.end(); m.end();
    m.localGet(4); m.i32Const(8); m.i32Add(); m.localSet(4);
    m.br(0);
    m.end(); m.end();
    m.localGet(1); m.globalGet(freeListGlobal); m.i32Store(2, 0);        // hdr[0] = 链头
    m.localGet(1); m.globalSet(freeListGlobal);                          // 链头 = hdr
    m.end();
    m.endBody();
}
function emitStringHelpers(m) {
    // qzs_numstr(dest:i32, n:i64) -> i32（写 [dest]=len:i32, digits@dest+4；返回 dest）
    // locals: 2=pos(i32), 3=count(i32), 4=neg(i32), 5=mag32(i32), 6=nn64(i64)
    // 小值(≤0xFFFFFFFF)走 i32 除法（硬件），大值回退 i64（软件 libcall，慢）。
    m.declareFunc("qzs_numstr", ["i32", "i64"], ["i32"]);
    m.startBody("qzs_numstr", ["i32", "i32", "i32", "i32", "i64"]);
    // 符号：neg=0；若 n<0 则 neg=1、n=-n
    m.i32Const(0); m.localSet(4);
    m.localGet(1); m.i64Const(0n); m.i64LtS();
    m.ifBlock("void");
      m.i32Const(1); m.localSet(4);
      m.i64Const(0n); m.localGet(1); m.i64Sub(); m.localSet(1);
    m.end();
    m.localGet(1); m.i64Const(0xffff_ffffn); m.i64LeU();
    m.ifBlock("void");
      // ---- i32 路径（硬件 div/rem）----
      m.localGet(1); m.i32WrapI64(); m.localSet(5);          // mag32
      m.i32Const(0); m.localSet(3);                          // count=0
      m.block("void"); m.loop("void");
        m.localGet(3); m.i32Const(1); m.i32Add(); m.localSet(3);
        m.localGet(5); m.i32Const(10); m.i32DivU(); m.localSet(5);
        m.localGet(5); m.i32Eqz(); m.brIf(1);
        m.br(0); m.end(); m.end();
      m.localGet(4); m.ifBlock("void");
        m.localGet(3); m.i32Const(1); m.i32Add(); m.localSet(3);   // 负号占 1 位
      m.end();
      m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add(); m.localSet(2);  // pos
      m.localGet(1); m.i32WrapI64(); m.localSet(5);          // refill mag32
      m.block("void"); m.loop("void");
        m.localGet(2); m.i32Const(1); m.i32Sub(); m.localSet(2);
        m.localGet(2); m.localGet(5); m.i32Const(10); m.i32RemU(); m.i32Const(0x30); m.i32Add(); m.i32Store8(0, 0);
        m.localGet(5); m.i32Const(10); m.i32DivU(); m.localSet(5);
        m.localGet(5); m.i32Eqz(); m.brIf(1);
        m.br(0); m.end(); m.end();
    m.else_();
      // ---- i64 路径 ----
      m.localGet(1); m.localSet(6);                          // nn64 = |n|
      m.i32Const(0); m.localSet(3);
      m.block("void"); m.loop("void");
        m.localGet(3); m.i32Const(1); m.i32Add(); m.localSet(3);
        m.localGet(6); m.i64Const(10n); m.i64DivU(); m.localSet(6);
        m.localGet(6); m.i64Eqz(); m.brIf(1);
        m.br(0); m.end(); m.end();
      m.localGet(4); m.ifBlock("void");
        m.localGet(3); m.i32Const(1); m.i32Add(); m.localSet(3);
      m.end();
      m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add(); m.localSet(2);
      m.localGet(1); m.localSet(6);
      m.block("void"); m.loop("void");
        m.localGet(2); m.i32Const(1); m.i32Sub(); m.localSet(2);
        m.localGet(2); m.localGet(6); m.i64Const(10n); m.i64RemU(); m.i32WrapI64(); m.i32Const(0x30); m.i32Add(); m.i32Store8(0, 0);
        m.localGet(6); m.i64Const(10n); m.i64DivU(); m.localSet(6);
        m.localGet(6); m.i64Eqz(); m.brIf(1);
        m.br(0); m.end(); m.end();
    m.end();
    // 负号
    m.localGet(4); m.ifBlock("void");
      m.localGet(2); m.i32Const(1); m.i32Sub(); m.localSet(2);
      m.localGet(2); m.i32Const(0x2d); m.i32Store8(0, 0);
    m.end();
    m.localGet(0); m.localGet(3); m.i32Store(0, 0);       // [dest]=len
    m.localGet(0);
    m.endBody();

    // qzs_append(buf, src, addLen) -> i32（top-of-bump 原地追加，否则新建拷贝）
    m.declareFunc("qzs_append", ["i32", "i32", "i32"], ["i32"]);
    m.startBody("qzs_append", ["i32", "i32", "i32", "i32", "i32"]);
    m.localGet(0); m.i32Load(2, 0); m.localSet(3);       // oldLen
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add();
    m.globalGet(0); m.i32Eq();                            // top?
    m.ifBlock("i32");
    emitBumpGrow(m, () => m.localGet(2));                 // bump+=addLen（越界 trap）
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add();  // dest
    m.localGet(1); m.localGet(2); m.call("qzs_memcpy");
    m.localGet(0); m.localGet(3); m.localGet(2); m.i32Add(); m.i32Store(2, 0);
    m.localGet(0);
    m.else_();
    m.globalGet(0); m.localSet(4);                        // newBuf
    emitBumpGrow(m, () => { m.i32Const(4); m.localGet(3); m.i32Add(); m.localGet(2); m.i32Add(); });   // bump+=4+oldLen+addLen
    m.localGet(4); m.localGet(3); m.localGet(2); m.i32Add(); m.i32Store(2, 0);
    m.localGet(4); m.i32Const(4); m.i32Add(); m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(3); m.call("qzs_memcpy");
    m.localGet(4); m.i32Const(4); m.i32Add(); m.localGet(3); m.i32Add(); m.localGet(1); m.localGet(2); m.call("qzs_memcpy");
    m.localGet(4);
    m.end();
    m.endBody();

    // qzs_utf16len(off) -> i32：UTF-8 字符串（[byteLen:i32][utf8]）→ UTF-16 码元数。
    // JS String.length 是 UTF-16 code units：ASCII/2字节/3字节首字节各 +1，4字节首字节额外 +1（代理对 2 码元），
    // 续字节(0x80-0xBF) +0。此前 .length 直接返回 UTF-8 字节数 → "你好".length=6（应 2）、"😀".length=4（应 2）。
    m.declareFunc("qzs_utf16len", ["i32"], ["i32"]);
    m.startBody("qzs_utf16len", ["i32", "i32", "i32", "i32", "i32"]);   // locals: 1=len 2=i 3=cnt 4=b
    m.localGet(0); m.i32Load(2, 0); m.localSet(1);               // byteLen
    m.i32Const(0); m.localSet(2);                                // i = 0
    m.i32Const(0); m.localSet(3);                                // cnt = 0
    m.block("void"); m.loop("void");
    m.localGet(2); m.localGet(1); m.i32GeU(); m.brIf(1);         // i >= len → 结束
    m.localGet(0); m.i32Const(4); m.i32Add(); m.localGet(2); m.i32Add(); m.i32Load8U(0, 0); m.localSet(4);   // b
    m.localGet(4); m.i32Const(0x80); m.i32LtU();                 // b < 0x80
    m.localGet(4); m.i32Const(0xc0); m.i32GeU();                 // b >= 0xC0（首字节）
    m.i32Or();
    m.localGet(4); m.i32Const(0xf0); m.i32GeU();                 // 4 字节首 → +1（代理对第二码元）
    m.i32Add();
    m.localGet(3); m.i32Add(); m.localSet(3);                    // cnt += inc
    m.localGet(2); m.i32Const(1); m.i32Add(); m.localSet(2);     // i++
    m.br(0);
    m.end(); m.end();
    m.localGet(3);
    m.endBody();
}

// num 数组扩容：qz_numarr_grow(base:i32, len:i32) -> i32(新 base)。
// 布局 [cap:i32][pad:i32][f64 data...]，cap 存 base-8。
// cap==0 → newCap=4；否则 newCap=cap*2。从 bump 堆分配 newCap*8+8，拷贝旧 len*8 字节，写新 cap。
function emitNumArrHelpers(m) {
    m.declareFunc("qz_numarr_grow", ["i32", "i32"], ["i32"]);
    m.startBody("qz_numarr_grow", ["i32", "i32", "i32", "i32", "i32", "i32"]);
    // 0=base 1=len 2=cap 3=newCap 4=total 5=newBase
    m.localGet(0); m.i32Const(8); m.i32Sub(); m.i32Load(2, 0); m.localSet(2);   // cap = [base-8]
    m.localGet(2); m.i32Eqz(); m.ifBlock("i32");
        m.i32Const(4);
    m.else_();
        m.localGet(2); m.i32Const(1); m.i32Shl();
    m.end();
    m.localSet(3);                                                              // newCap
    m.localGet(3); m.i32Const(3); m.i32Shl(); m.i32Const(8); m.i32Add();
    m.localSet(4);                                                              // total = newCap*8+8
    emitBumpAlloc(m, () => m.localGet(4));                                      // headerOff on stack
    m.i32Const(8); m.i32Add(); m.localSet(5);                                  // newBase = headerOff+8
    m.localGet(5); m.i32Const(8); m.i32Sub(); m.localGet(3); m.i32Store(2, 0); // [newBase-8]=newCap
    m.localGet(5); m.localGet(0); m.localGet(1); m.i32Const(3); m.i32Shl();
    m.call("qzs_memcpy");                                                       // memcpy(newBase, base, len*8)
    m.localGet(5);
    m.endBody();
}

// 检测函数体里的 num 数组变量：const a: number[] = []（空数组初始化），
// 且后续仅用于 push/[i]/[i]=/.length。返回 Set<name>。
function numArrNames(f) {
    const decls = new Set();
    // number[] / boolean[] 都走同一套 f64 连续块（bool 存 0/1，见 emitExpr True/False）。
    const isNumArrType = (t) => t && ts.isArrayTypeNode(t) && t.elementType
        && (t.elementType.kind === ts.SyntaxKind.NumberKeyword || t.elementType.kind === ts.SyntaxKind.BooleanKeyword);
    const isEmptyArr = (e) => ts.isArrayLiteralExpression(e) && e.elements.length === 0;
    const walk1 = (n) => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isNumArrType(n.type) && isEmptyArr(n.initializer))
            decls.add(n.name.text);
        if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
        ts.forEachChild(n, walk1);
    };
    if (f.body) walk1(f.body);
    const ok = new Set();
    for (const name of decls) {
        let safe = true;
        const walk2 = (n) => {
            if (!safe) return;
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) return;
            if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "push"
                && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === name) {
                for (const a of n.arguments) walk2(a); return;   // 只走参数，不走 a.push 接收者
            }
            if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
                walk2(n.argumentExpression); return;   // 只走下标表达式，不走 a 本身
            }
            if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name
                && n.name.text === "length") return;
            if (ts.isBinaryExpression(n) && ts.isElementAccessExpression(n.left)
                && ts.isIdentifier(n.left.expression) && n.left.expression.text === name) {
                // a[i] = v / a[i] op= v：走下标和值，不走 a
                walk2(n.left.argumentExpression); walk2(n.right); return;
            }
            if (ts.isIdentifier(n) && n.text === name && !(n.parent && ts.isVariableDeclaration(n.parent) && n.parent.name === n)) {
                safe = false; return;
            }
            if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
            ts.forEachChild(n, walk2);
        };
        if (f.body) walk2(f.body);
        if (safe) ok.add(name);
    }
    return ok;
}
/* 函数编译模式：参数全 number、返回 number/void、且函数体**只含 num 安全表达式**
 * → "num"（f64 快路径）。任一不安全表达式 → "tagged"。
 * num emitExpr 只支持：Identifier / NumericLiteral / BinaryExpression(算术/逻辑/比较) /
 * CallExpression(到 num 函数) / PrefixUnaryExpression(++/--/!) / PostfixUnaryExpression /
 * ConditionalExpression(三元) / ParenthesizedExpression / 赋值表达式。
 * 其余（对象/数组/字符串字面量、属性/元素访问、模板、new、箭头、类型断言…）num 路径
 * emitExpr 会直接抛 `不支持的表达式` —— 必须在 funcMode 阶段就检出并退到 tagged。
 * 这不是「性能换语义」——是编译器**崩溃预防**：不降级的后果是硬错误而非运行时慢。 */
function funcMode(f) {
    const rt = f.type;
    const rtOk = !rt || rt.kind === ts.SyntaxKind.NumberKeyword || rt.kind === ts.SyntaxKind.VoidKeyword;
    const allNum = f.parameters.every(p => p.type && p.type.kind === ts.SyntaxKind.NumberKeyword);
    let unsafe = false;
    // Math.* 单参内建 + num 数组（number[] 用 push/[i]/[i]=/.length）→ num 安全。
    const MATH1 = new Set(["sqrt", "abs", "floor", "ceil", "trunc", "round"]);
    const isMath1 = (n) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)
        && n.expression.text === "Math" && MATH1.has(n.name.text);
    const numArrs = numArrNames(f);   // Set<name>：num 数组变量
    const isNumArrPA = (n) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)
        && numArrs.has(n.expression.text) && (n.name.text === "length" || n.name.text === "push");
    const isNumArrEA = (n) => ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression)
        && numArrs.has(n.expression.text);
    const isNumArrEmpty = (n) => ts.isArrayLiteralExpression(n) && n.elements.length === 0;
    // 零参数箭头函数（(): number => { num-safe body }）→ 可内联，不算 unsafe。
    // 限制：body 只含 num 安全表达式；block body 仅末句 return（无提前 return）。
    const isInlineArrow = (n) => {
        if (!ts.isArrowFunction(n) || n.parameters.length !== 0) return false;
        if (!n.type || n.type.kind !== ts.SyntaxKind.NumberKeyword) return false;
        let safe = true, retCount = 0;
        const cb = (bn) => {
            if (!safe || bn === n) { ts.forEachChild(bn, cb); return; }
            if (isMath1(bn)) { ts.forEachChild(bn, cb); return; }
            if (isNumArrPA(bn) || isNumArrEA(bn) || isNumArrEmpty(bn)) { ts.forEachChild(bn, cb); return; }
            if (ts.isReturnStatement(bn)) retCount++;
            if (ts.isArrowFunction(bn) || ts.isFunctionExpression(bn) || ts.isNewExpression(bn)
                || ts.isPropertyAccessExpression(bn) || ts.isElementAccessExpression(bn)
                || ts.isObjectLiteralExpression(bn) || ts.isArrayLiteralExpression(bn)
                || ts.isTemplateExpression(bn) || ts.isSpreadElement(bn) || ts.isTaggedTemplateExpression(bn)
                || ts.isClassExpression(bn) || ts.isAwaitExpression(bn) || ts.isYieldExpression(bn)
                || ts.isStringLiteral(bn) || ts.isNoSubstitutionTemplateLiteral(bn)
                || ts.isTypeOfExpression(bn) || ts.isVoidExpression(bn) || ts.isDeleteExpression(bn)
                || (ts.isBinaryExpression(bn) && bn.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword))
                { safe = false; return; }
            ts.forEachChild(bn, cb);
        };
        cb(n);
        if (ts.isBlock(n.body)) {
            const stmts = n.body.statements;
            if (retCount !== 1 || !stmts.length || !ts.isReturnStatement(stmts[stmts.length - 1])) safe = false;
        } else { if (retCount !== 0) safe = false; }
        return safe;
    };
    const walk = (n) => {
        if (n === f) { ts.forEachChild(n, walk); return; }
        if (isMath1(n)) { ts.forEachChild(n, walk); return; }
        if (isNumArrPA(n) || isNumArrEA(n) || isNumArrEmpty(n)) { ts.forEachChild(n, walk); return; }
        if (isInlineArrow(n)) { ts.forEachChild(n, walk); return; }
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isNewExpression(n)
            || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)
            || ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)
            || ts.isTemplateExpression(n)
            || ts.isSpreadElement(n) || ts.isTaggedTemplateExpression(n)
            || ts.isClassExpression(n) || ts.isAwaitExpression(n) || ts.isYieldExpression(n)
            || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
            || ts.isTypeOfExpression(n) || ts.isVoidExpression(n) || ts.isDeleteExpression(n)
            || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword))
            unsafe = true;   // 注：as / x! / satisfies 为纯类型层构造（emit 恒等擦除），不列入
        ts.forEachChild(n, walk);
    };
    if (f.body) walk(f);
    return (allNum && rtOk && !unsafe && (f.parameters.length > 0 || (rt && rt.kind === ts.SyntaxKind.NumberKeyword))) ? "num" : "tagged";
}


// f64 位型拆分（i64ConstBits 用）：[lo, hi]
const _fbuf = Buffer.alloc(8);
function f64Bits(v) { _fbuf.writeDoubleLE(v); return [_fbuf.readUInt32LE(0), _fbuf.readUInt32LE(4)]; }

module.exports = { f64Bits, STR_TAG_HI, ARR_TAG_HI, RC_HDR, K_PLAIN, K_POJO, K_ARR, SCRATCH, STR_BASE, STR_BUMP, INMOD_HOST_LIMIT, INMOD_STR_BUMP, INMOD_TABLE_CAP, INMOD_TABLE_RESERVE, INMOD_STR_BASE, INMOD_PAGES, memLayout, emitBumpGrow, emitBumpAlloc, emitBumpSet, emitMemHelpers, emitStringHelpers, emitNumArrHelpers, numArrNames, funcMode };
