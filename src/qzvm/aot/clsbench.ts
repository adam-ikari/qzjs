class Animal { n: number; constructor(x: number){ this.n = x; } val(): number { return this.n; } }
class Dog extends Animal { constructor(x: number){ super(x); } val(): number { return this.n + 1; } twice(): number { return this.val() * 2; } }
// a: 只 new
function aNew(it: number): number { let s=0; for(let i=0;i<it;i++){ const d=new Dog(i); s=s+d.n; } return s; }
// b: new + 1 次同对象方法调用
function b1(it: number): number { let s=0; for(let i=0;i<it;i++){ const d=new Dog(i); s=s+d.val(); } return s; }
// c: new + 2 次方法调用（含内部再调 val）
function c2(it: number): number { let s=0; for(let i=0;i<it;i++){ const d=new Dog(i); s=s+d.twice(); } return s; }
