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
