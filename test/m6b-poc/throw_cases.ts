// 可捕获异常用例：C 侧原语（reduce 空数组）抛出的 TypeError 必须能被 catch 捕获，
// 且 emitter 的 take_err 轮询不得覆盖用户 throw 写入的 __err。
export function reduceEmpty(): any {
  let msg = "no-throw";
  const a: any[] = [];
  try { a.reduce((s: any, x: any) => s + x); } catch (e: any) { msg = e.name + ":" + e.message; }
  return msg;
}

export function userThrow(): any {
  let msg = "no-throw";
  try { throw new TypeError("user-err"); } catch (e: any) { msg = e.name + ":" + e.message; }
  return msg;
}

export function reduceNonEmpty(): any {
  const a: any[] = [1, 2, 3];
  let msg = "no-throw";
  try { msg = String(a.reduce((s: any, x: any) => s + x)); } catch (e: any) { msg = "threw"; }
  return msg;
}

export function noThrow(): any {
  const a: any[] = [1, 2];
  let n = 0;
  try { n = a.reduce((s: any, x: any) => s + x, 0); } catch (e: any) { return "threw"; }
  return n === 3 ? "ok" : "bad:" + n;
}
