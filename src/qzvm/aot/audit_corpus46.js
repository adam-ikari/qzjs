// 差分审计语料（第四十六批）：被调函数读 `arguments` 时，调用点实参**只求值一次**。
// 本轮修的静默错值：顶层函数直调点在「发射 4 个值槽」之后，又用同一批实参节点重发一遍
// 全量实参数面（`createArrayLiteralExpression(e.arguments)`）⇒ 带副作用的实参执行两次
// （`f(bump())` 里 bump 跑两遍）。类方法的 provider 已改为「先建数组、槽位再从数组回读」，
// 本批把同一形态用到顶层函数（含 rest 收尾形参：rest 段由数组 slice 出**新数组**，
// 与 arguments 不同句柄——JS 里二者也是两个数组对象）。
// 追加（2026-11-08）：展开实参调用现在也写 __args（全量数组本来就在手上），并给函数入口
// 补上「消费即清 + 0 哨兵 trap」——此前无 provider 的调用会读到上一个 callee 的残留数组
// （`f(9); f(...[1,2])` 得 1 而非 2，静默错值）。导出入口由宿主直接调用属无 provider 形态，
// 现按 loud 登记。非 rest 展开改按形参表拆包直调（qz.call_named 在 in-module 档查不到产物
// 函数 → 静默 0）；num 被调缺参运行期 trap；静态方法展开同改直调。
module.exports = [
  { name: "fn-args-eval-once", fn: "run", ts: `
let n = 0;
function bump() { n++; return 5; }
function f(x: number, y: number) { return arguments.length + ":" + x + ":" + y; }
export function run() { const v = f(bump(), 2); return v + "/n=" + n; }`, args: [] },
  { name: "fn-args-eval-once-nested", fn: "run", ts: `
let log = "";
function s(x: string) { log += x; return x; }
function g(a: string, b: string) { return String(arguments.length) + a + b; }
export function run() { const v = g(s("p"), s("q")); return v + "|" + log; }`, args: [] },
  { name: "fn-args-eval-once-assign-arg", fn: "run", ts: `
function f(a: number, b: number) { return arguments.length + ":" + a + ":" + b; }
export function run() { let t = 0; const v = f(t = 1, t + 1); return v + "/t=" + t; }`, args: [] },
  { name: "fn-args-rest-tail", fn: "run", ts: `
let n = 0;
function bump() { n++; return 5; }
function f(a: number, ...r: number[]) { return arguments.length + ":" + a + ":" + r.join(",") + ":" + (arguments === r as any); }
export function run() { const v = f(bump(), 6, 7); return v + "/n=" + n; }`, args: [] },
  { name: "fn-args-rest-empty", fn: "run", ts: `
let n = 0;
function bump() { n++; return 5; }
function f(a: number, ...r: number[]) { return arguments.length + ":" + a + "/" + r.length; }
export function run() { const v = f(bump()); return v + "/n=" + n; }`, args: [] },
  { name: "fn-args-beyond-formals-eval-once", fn: "run", ts: `
let n = 0;
function bump(k: number) { n += k; return k; }
function f(a: number) { return arguments.length + ":" + String(arguments[1]) + ":" + a; }
export function run() { const v = f(bump(1), bump(10)); return v + "/n=" + n; }`, args: [] },
  { name: "fn-args-unchanged-without-arguments", fn: "run", ts: `
let n = 0;
function bump() { n++; return 5; }
function f(a: number) { return a * 2; }
export function run() { return f(bump()) + "/n=" + n; }`, args: [] },
  // 展开实参：全量数组就是 arguments，调用点直接写 __args（不再落到无 provider 的路径）。
  { name: "fn-args-spread", fn: "run", ts: `
function f(a: number) { return arguments.length + ":" + String(arguments[1]) + ":" + a; }
export function run() { const first = f(...[1, 2]); const second = f(9); return first + ":" + second; }`, args: [] },
  // 残留形态：先直调（写 __args）再展开调用。修前展开调用读到上一次的 [9] → "1:1"（静默错值）。
  { name: "fn-args-spread-stale-order", fn: "run", ts: `
function f(a: number) { return arguments.length + ":" + String(arguments[1]) + ":" + a; }
export function run() { const second = f(9); const first = f(...[1, 2]); return first + ":" + second; }`, args: [] },
  { name: "fn-args-spread-rest", fn: "run", ts: `
function f(a: number, ...r: number[]) { return arguments.length + ":" + a + ":" + r.join(","); }
export function run() { return f(...[1, 2, 3]); }`, args: [] },
  // 无静态直调点（宿主直接调导出函数）→ 入口哨兵 loud，绝不静默读残留。
  { name: "fn-args-host-direct", fn: "run", ts: `
export function run() { return arguments.length; }`, args: [], unsupported: "导出入口由宿主直接调用，无静态直调点可写 __args" },
  // 展开实参到 num 被调（f64 ABI）：调用者 tagged → 槽位从数组回读后按位重解释。
  { name: "fn-spread-num", fn: "run", ts: `
function f(a: number, b: number) { return a * 10 + b; }
export function run() { return f(...[1, 2]); }`, args: [] },
  // 缺参：f64 ABI 表示不了 undefined（非展开路径编译期拒绝；这里运行期 trap，不静默给 0/NaN）。
  { name: "fn-spread-num-missing", fn: "run", ts: `
function f(a: number, b: number) { return a * 10 + b; }
export function run() { return f(...[1]); }`, args: [] },
  { name: "fn-spread-num-extra", fn: "run", ts: `
function f(a: number, b: number) { return a * 10 + b; }
export function run() { return f(...[1, 2, 3]); }`, args: [] },
  // 静态方法展开：self 单独发射、槽位从同一数组回读后直调（rest 段 slice 成新数组）。
  { name: "static-method-spread", fn: "run", ts: `
class S { static m(a: number, b: number) { return a * 100 + b; } }
export function run() { return S.m(...[3, 4]); }`, args: [] },
  { name: "static-method-rest-spread", fn: "run", ts: `
class S { static m(a: number, ...r: number[]) { return a * 1000 + r.length * 10 + r[0]; } }
export function run() { return S.m(...[3, 4, 5]); }`, args: [] },
  // 直调后必须做 __err 检查：被调 throw 会设 __err 正常返回，调用点不查就会带着错值继续
  // （修前：异常穿出整个 try/catch，AOT 抛 boom、V8 返回 2）。
  { name: "fn-spread-throw", fn: "run", ts: `
function f(a: number) { if (a > 1) throw new Error("boom"); return a; }
export function run() { let n = 0; try { f(...[2]); n = 1; } catch (e) { n = 2; } return n; }`, args: [] },
  { name: "static-spread-throw", fn: "run", ts: `
class S { static m(a: number) { if (a > 1) throw new Error("boom"); return a; } }
export function run() { let n = 0; try { S.m(...[2]); n = 1; } catch (e) { n = 2; } return n; }`, args: [] },
];
