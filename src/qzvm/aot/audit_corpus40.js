// 批 40：BigInt 门面收尾——混合类型强弱通道、位运算、幂、一元 ~、BigInt() 构造器、宽松 ==。
// 前置：批 39（literals/binops/typeof/toString/前缀负号）。核心机制：BIG 入 _emitIsHandle
// → 混合值经宿主 toJS 还原原生 JS 语义（TypeError 精确抛出），双 BIG 走 wasm 内前置快通道。
module.exports = [
  { name: "bigint-ctor", fn: "f", ts: `export function f(): any {
    const out: any = [];
    out.push(String(BigInt("31")));
    out.push(String(BigInt(9)));
    out.push(String(BigInt(10n)));
    out.push(typeof BigInt(1));
    out.push(String(String(10n)));            // String(10n) = "10"
    return out.join("|");
  }` },
  { name: "bigint-mixed-typeerror", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const a = 10n;
    out.push(a + 1);          // BigInt+number → TypeError（两侧同抛）
    out.push(1 - a);
    out.push(a < 10);
    out.push(10 <= a);
    out.push(+a);             // 一元 + → TypeError
    return out.join("|");
  }` },
  { name: "bigint-eq-mixed", fn: "f", ts: `export function f(): any {
    const out: any = [];
    out.push(String(10n == 10));            // true（number-bigint == 有定义）
    out.push(String(10n == "10"));          // true（string→bigint 值比较）
    out.push(String(10n === 10));           // false（类型不同）
    out.push(String(10n != 11));            // true
    out.push(String(0n == false));          // true
    return out.join("|");
  }` },
  { name: "bigint-string-plus", fn: "f", ts: `export function f(): any {
    const out: any = [];
    const v = 10n;
    out.push("x" + v);                     // 拼接（JS 无类型错）
    out.push(v + "x");
    out.push("" + v);
    out.push([10n, 20n].join(","));        // join 内隐式 ToString
    out.push(\`\${v}!\`);                    // 模板内插值
    return out.join("|");
  }` },
  { name: "bigint-bitwise", fn: "f", ts: `export function f(): any {
    const out: any = [];
    out.push((~5n).toString());            // -6
    out.push((10n & 3n).toString());       // 2
    out.push((10n | 3n).toString());       // 11
    out.push((10n ^ 3n).toString());       // 9
    out.push((1n << 40n).toString());      // 1099511627776（>32 位）
    out.push((16n >> 2n).toString());      // 4
    out.push((9n ** 2n).toString());       // 81
    return out.join("|");
  }` },
  { name: "bigint-ushr-throw", fn: "f", ts: `export function f(): any {
    const a = 10n, b = 3n;
    return (a >>> b).toString();           // BigInt 无 >>> → 两侧 TypeError
  }` },
  { name: "bigint-compound", fn: "f", ts: `export function f(): any {
    const out: any = [];
    let a = 10n; a += 2n;  out.push(a.toString());
    a *= 3n;               out.push(a.toString());
    a <<= 4n;              out.push(a.toString());
    a &= 255n;             out.push(a.toString());
    let b = 2n; b **= 5n;  out.push(b.toString());
    return out.join("|");
  }` },
  { name: "bigint-primitive-eq", fn: "f", ts: `export function f(): any {
    const out: any = [];                    // JS BigInt 原始值语义：不同构造路径同值相等
    out.push(String(BigInt("10") === 10n));
    out.push(String(BigInt(7) + 0n));
    out.push(String(typeof (BigInt("5") % 3n)));
    return out.join("|");
  }` },
];
