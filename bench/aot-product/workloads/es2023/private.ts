class C { #k: number = 7; get k(): number { return this.#k; } }
export function work(n: number): number {
  const c = new C();
  let s: number = 0;
  for (let i: number = 0; i < n; i = i + 1) {
    const a: number = i % 1000;
    s = (s + a * a + ((i * 3) % 13)) % 1000003;
  }
  const tag = "v1";
  return s + tag.length + c.k;
}
