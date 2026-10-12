// 类：继承 + super() + 字段默认值 + 方法动态分派 + 遮蔽字段
class Animal {
    name: string;
    legs: number = 4;
    constructor(n: string) { this.name = n; }
    speak(): string { return this.name; }
    greet(): string { return "hi " + this.speak(); }
    add(a: number, b: number): number { return a + b; }
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
