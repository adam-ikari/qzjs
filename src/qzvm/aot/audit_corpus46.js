// 差分审计语料（第四十六批）：被调函数读 `arguments` 时，调用点实参**只求值一次**。
// 本轮修的静默错值：顶层函数直调点在「发射 4 个值槽」之后，又用同一批实参节点重发一遍
// 全量实参数面（`createArrayLiteralExpression(e.arguments)`）⇒ 带副作用的实参执行两次
// （`f(bump())` 里 bump 跑两遍）。类方法的 provider 已改为「先建数组、槽位再从数组回读」，
// 本批把同一形态用到顶层函数（含 rest 收尾形参：rest 段由数组 slice 出**新数组**，
// 与 arguments 不同句柄——JS 里二者也是两个数组对象）。
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
];
