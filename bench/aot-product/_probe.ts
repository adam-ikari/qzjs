function t1(): number { const o = { x: 5 }; return o.x; }
function t2(): number { const o: any = {}; o.y = 9; return o.y; }
function t3(): number { const v: any = { name: "ab" }; if (typeof v.name !== "string") return -1; return v.name.length; }
function t4(): number { const s = "a@b"; return s.indexOf("@"); }
function t5(s: string): number { const o = JSON.parse(s); return o.a; }
function t6(s: string): number { const o = JSON.parse(s); return o.id; }
function t7(): number {
  const v: any = { name: "Alice", age: 30, email: "a@b.com" };
  let e = 0;
  if (typeof v.name !== "string") e = e + 1; else if (v.name.length < 2) e = e + 1;
  if (typeof v.age !== "number") e = e + 1; else if (v.age < 0) e = e + 1;
  if (typeof v.email !== "string") e = e + 1; else if (v.email.indexOf("@") < 0) e = e + 1;
  return e;
}
function t8(n: number): number { let t = 0; for (let i = 0; i < n; i++) { t = t + (i % 2); } return t; }
function t9(n: number): number {
  const v: any = { name: "a", age: 1, email: "x@y" };
  let e = 0;
  for (let i = 0; i < n; i++) {
    if (typeof v.name !== "string") e = e + 1; else if (v.name.length < 2) e = e + 1;
    if (typeof v.age !== "number") e = e + 1;
    if (typeof v.email !== "string") e = e + 1; else if (v.email.indexOf("@") < 0) e = e + 1;
  }
  return e;
}
function validateP(v: any): number {
  if (v === null || typeof v !== "object") return -1;
  let errs = 0;
  if (typeof v.name !== "string") errs = errs + 1; else if (v.name.length < 2) errs = errs + 1; else if (v.name.length > 20) errs = errs + 1;
  if (typeof v.age !== "number") errs = errs + 1; else if (v.age < 0) errs = errs + 1; else if (v.age > 150) errs = errs + 1;
  if (typeof v.email !== "string") errs = errs + 1; else if (v.email.indexOf("@") < 0) errs = errs + 1;
  return errs;
}
function t10(n: number): number {
  const good: any = { name: "Alice", age: 30, email: "a@b.com" };
  const bad: any = { name: "", age: 200, email: "nope" };
  let t = 0;
  for (let i = 0; i < n; i++) { if ((i % 2) === 0) t = t + validateP(good); else t = t + validateP(bad); }
  return t;
}
