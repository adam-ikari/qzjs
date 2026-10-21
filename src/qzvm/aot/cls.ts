// 类：继承 + super() + 字段默认值 + 方法动态分派 + 遮蔽字段
class Animal {
    name: string;
    legs: number = 4;
    constructor(n: string) { this.name = n; }
    speak(): string { return this.name; }
    greet(): string { return "hi " + this.speak(); }
    add(a: number, b: number): number { return a + b; }
    nameLen(): number { return this.name.length; }              // 读 this → 暴露 self 槽被覆盖
    w(a: number, b: number): number { return this.legs * 100 + a * 10 + b; }
}
class Dog extends Animal {
    legs: number = 3;                       // 遮蔽父字段
    constructor(n: string) { super(n); }
    speak(): string { return "woof"; }
    loud(): string { return this.speak() + "!"; }
}
class Puppy extends Dog {
    // 无显式 ctor：合成 ctor 应隐式 super(...) 转发
    tag(): string { return this.name + "/" + this.legs; }
}
function dogRun(): string {
    const d = new Dog("rex");
    return d.greet() + "/" + d.loud();
}
function fieldRun(): number {
    const a = new Animal("x");
    const p = new Puppy("bit");
    return a.legs * 10 + p.legs;            // 4*10 + 3（遮蔽字段父写后子覆写）
}
function argRun(): number {
    const d = new Dog("r");
    return d.add(3, 4);                     // 动态分派 + 多参
}
function fwdRun(): string {
    const p = new Puppy("bit");             // 合成 ctor 转发参数 → 父 ctor 收到 name
    return p.tag();
}

// 回归：类实例真值判断（句柄 tag 与 JS 句柄表同 tag，toJS 会误判 falsy）
function truthyRun(): number {
    const d = new Dog("z");
    if (d) return 5; else return 9;
}
// 回归：逻辑复合赋值使变量动态化 → 静态直调必须作废（Dog.legs=3 vs Animal.legs=4）
function andAssignRun(): number {
    const d = new Dog("d");
    let x: any = new Animal("b");
    x &&= d;
    return x.w(0, 0);                        // 动态→Dog: 3*100=300；误静态→Animal: 400
}
// 回归：嵌套方法调用作实参（固定暂存槽覆盖 self → 接收者取错）
function nestedArgRun(): number {
    const d = new Dog("r");
    const a = new Animal("q");
    return a.w(d.w(1, 2), 0);                // d.w(1,2)=312; a.w(312,0)=4*100+3120=3520
}

// 回归：成员自增/自减（++this.n / this.n--）——原只认标识符操作数 → NaN/undefined
function preFieldInc(): number {
    const d = new Dog("p");
    const before = d.legs;                   // 3
    const a = ++d.legs;                      // 4
    return a * 1000 + d.legs * 10 + before;  // 4*1000 + 4*10 + 3 = 4043
}
function postFieldInc(): number {
    const d = new Dog("q");
    const a = d.legs++;                      // 旧值 3
    return a * 1000 + d.legs;                // 3*1000 + 4 = 3004
}
function preFieldDec(): number {
    const d = new Dog("r");
    const a = --d.legs;                      // 2
    return a * 100 + d.legs;                 // 2*100 + 2 = 202
}
function postFieldDec(): number {
    const d = new Dog("s");
    const a = d.legs--;                      // 旧值 3
    return a * 100 + d.legs;                 // 3*100 + 2 = 302
}
function fieldIncLoop(): number {
    const d = new Dog("t");                  // legs=3
    let s = 0;
    for (let i = 0; i < 5; i++) s += d.legs++;  // 3+4+5+6+7=25 → legs=8
    return s * 100 + d.legs;                 // 2508
}
