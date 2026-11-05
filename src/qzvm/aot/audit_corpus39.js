// 批 39：BigInt 完整门面（tagged BIG 后端收尾）。
// bigint-basic（批 7）仅字面量+双目+toString；本批覆盖 比较链 / typeof / 进制与超大数 /
// 负数截断 / 除零抛错（两侧均抛即 match）。已知限制：BIG×number 混合算术（JS 应 TypeError）、
//BigInt(...) 构造器走 builtin（未入 BUILTIN_FNS）不在本批。
module.exports = [
  { name: "bigint-binops", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const a = 10n, b = 3n;
    out.push((a + b).toString());          // 13
    out.push((a - b).toString());          // 7
    out.push((a * b).toString());          // 30
    out.push((a / b).toString());          // 3（trunc）
    out.push((a % b).toString());          // 1
    out.push((0xffn + 1n).toString());     // 256（16 进制字面量）
    out.push((1_000n - 1n).toString());    // 999（_ 分隔字面量）
    return out.join("|");
  }` },
  { name: "bigint-neg-trunc", fn: "f", ts: `export function f(): any {
    const out: any = [];
    out.push((-7n / 2n).toString());       // -3（向零截断）
    out.push((-7n % 2n).toString());       // -1
    out.push((7n % -2n).toString());       // 1
    return out.join("|");
  }` },
  { name: "bigint-compare", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const a = 10n, b = 3n;
    out.push(String(a === b)); out.push(String(a !== b));
    out.push(String(a < b)); out.push(String(a <= b));
    out.push(String(a > b)); out.push(String(a >= b));
    out.push(String(a === 10n)); out.push(String(a === a));
    out.push(String(10n == 10n)); out.push(String(10n != 3n));   // 宽松 == 对两 BigInt 与 === 同义
    return out.join("|");
  }` },
  { name: "bigint-typeof", fn: "f", ts: `export function f(): any {
    const x = 42n;
    return typeof x + "|" + typeof 1n + "|" + typeof (x * x);
  }` },
  { name: "bigint-tostring", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const v = 255n;
    out.push(v.toString());                // "255"
    out.push(v.toString(16));              // "ff"
    out.push(v.toString(2));               // 11111111
    out.push("v=" + v.toString());         // 字符串拼接路径
    return out.join("|");
  }` },
  { name: "bigint-huge", fn: "f", ts: `export function f(): any {
    const big = 123456789012345678901234567890n;
    const out: any = [];
    out.push(big.toString());              // 30 位整数（number 表示不了）
    out.push((big * big).toString()[0]);   // 首位 1（溢出 number 精度→ BigInt 全精度）
    out.push(((big / 1000000000000n) % 1000000000n).toString());
    return out.join("|");
  }` },
  { name: "bigint-div-zero", fn: "f", ts: `export function f(): any {
    const a = 10n, z = 0n;
    return "unreachable:" + (a / z).toString();
  }` },
];
