// 快路径（纯 number）：fib 递归 + 循环
function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
function numWork(iters: number): number {
  let s = 0;
  for (let i = 0; i < iters; i++) s = s + fib(20 + (i % 5));
  return s;
}
// tagged（对象 I/O）：创建对象 + 属性访问 + 数值累加
function objWork(n: any): any {
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = { id: i, sq: i * i, tag: "r" };
    total = total + r.id + r.sq;
  }
  return total;
}
// tagged 数值精度：累加超 32 位（f64 rep 精确；旧 i32 31 位模型会溢出）
function bigAcc(n: unknown): unknown {
  let total = 0;
  for (let i = 0; i < n; i++) total = total + 1000000000;
  return total;
}

// tagged 数组方法：push/pop/length/索引
function arrWork(n: any): any {
  let a = [1, 2];
  for (let i = 0; i < n; i++) a.push(i);
  const last = a.pop();
  let s = 0;
  for (let i = 0; i < a.length; i++) s = s + a[i];
  return s + last;
}

// try/catch/finally + throw（同函数结构化跳转）
function tryWork(): any {
  let out = 0;
  try {
    for (let i = 0; i < 10; i++) {
      if (i === 3) throw "stop";
      out = out + i;
    }
  } catch (e) {
    out = out + e.length;
  } finally {
    out = out + 1000;
  }
  return out;
}

// 数组方法：宿主派发（arrRead/doArrMethod），含回调（map/filter/reduce 经 closure_call）
function arrMethods(): any {
  const a = [3, 1, 2];
  const joined = a.join("-");               // "3-1-2" len=5（不改 a）
  const idx = a.indexOf(1);                 // 1
  const sl = a.slice(1).length;             // 2（不改 a）
  const rev = a.reverse()[0];               // a→[2,1,3]，rev=2
  const mapped = a.map((x: any) => x * 2)[0];       // 2*2=4
  const acc = [1, 2, 3].reduce((s: any, x: any) => s + x, 0);  // 6
  const filtered = [1, 2, 3].filter((x: any) => x > 1).length; // 2
  const sp = "a,b,c".split(",").length;     // 3
  return joined.length + idx + sl + rev + mapped + acc + filtered + sp;  // 5+1+2+2+4+6+2+3 = 25
}

// push/pop/length 后接方法，验证句柄别名不失效
function arrAlias(): any {
  const a = [1, 2];
  const b = a;
  a.push(3);
  b.reverse();
  return a[0] * 100 + b.length;             // b=a 同句柄：[3,2,1] → 3*100+3 = 303
}

// split → 索引访问（此前 split 返回 JS 句柄，wasm 侧索引读垃圾）
function splitIndex(): any {
  const parts = "x|y|z".split("|");
  return parts[2] + parts.length;           // "z" + 3 → "z3"
}

// null/undefined/true/false 字面量（此前 tagged 路径直接抛「不支持的表达式」）
function literals(): any {
  let n = null;
  let u = undefined;
  return (n === null ? 1 : 0) + (u === undefined ? 1 : 0) + (!n ? 1 : 0)
       + (true ? 1 : 0) + (false ? 0 : 1);   // 1+1+1+1+1 = 5
}

// 数组 .length= 赋值：截断 / 扩容补 undefined / 读回
function arrLengthSet(): any {
  const a = [1, 2, 3];
  a.length = 1;                              // 截断 → [1]
  const t = a.length;                        // 1
  a.length = 3;                              // 扩容 → [1,undefined,undefined]
  const isUndef = a[2] === undefined ? 1 : 0;// 1
  const j = [1, 2].map((x: any) => x).length;// 2
  return t * 100 + isUndef * 10 + j;         // 100 + 10 + 2 = 112
}

// 回归：数字→十进制含负号。numstr 原用无符号 div/rem，负数产出垃圾（-42 → 18446744073709551574）。
function negNumStr(): any {
  let s = "";
  s = s + (-42);
  s = s + "|" + (-7);
  s = s + "|" + 5000000000;
  return s;                                  // "-42|-7|5000000000"
}
