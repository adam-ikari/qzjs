// 重载签名（无实现体）不得进入方法表 —— glue/AOT 路径专用语料。
//
// 背景：类方法收集曾不过滤 `mem.body`，重载签名（`write(fn: F): void;`）被当成方法，
// emitAll 取 `mth.node.body` 得 undefined → 编译期崩溃
// "Cannot read properties of undefined (reading 'index')" / "'kind'"。
// 重载在 TS 里只是类型信息，运行时只有实现体（最后那个同名带 body 的声明）存在。
//
// 用 glue_audit.js 跑（走真实 build.js → glue → qzjs/AOT 链路）。
// 不用 audit_diff.js：其 pure-wasm 路径在「类字段为数组字面量」时有独立的既有崩溃，
// 会掩盖本语料要验证的重载语义。
module.exports = [
  { name: "method-overload-sigs", fn: "f", ts: `export function f(): any {
    const d = new Doc();
    d.write("line one");
    d.write((doc: any) => { doc.write("from fn"); });
    return d.content.join("|");
  }
  class Doc {
    content: string[] = [];
    write(fn: (d: any) => void): void;
    write(line: string): void;
    write(arg: any): void {
      if (typeof arg === "function") { arg(this); return; }
      this.content.push(arg);
    }
  }` },
  { name: "method-overload-many", fn: "f", ts: `export function f(): any {
    const c = new C();
    return c.m(1, 2) + "|" + c.m("x") + "|" + c.m();
  }
  class C {
    m(a: number, b: number): number;
    m(s: string): string;
    m(): string;
    m(a?: any, b?: any): any {
      if (typeof a === "number") return a + b;
      if (typeof a === "string") return a;
      return "none";
    }
  }` },
  { name: "ctor-overload-sig", fn: "f", ts: `export function f(): any {
    return new D(5).v;
  }
  class D {
    v: number;
    constructor(n: number);
    constructor(n: number) { this.v = n; }
  }` },
  { name: "accessor-overload-sig", fn: "f", ts: `export function f(): any {
    const a = new E();
    a.x = 3;
    return String(a.x);
  }
  class E {
    private _x = 0;
    get x(): number;
    get x(): number { return this._x; }
    set x(v: number);
    set x(v: number) { this._x = v; }
  }` },
];
