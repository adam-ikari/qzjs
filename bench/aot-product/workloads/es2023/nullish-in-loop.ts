export function work(n: number): number {
  let s: number = 0;
  for (let i: number = 0; i < n; i = i + 1) {
    let a: number = i % 1000;
    a ??= 0;
    s = (s + a * a + ((i * 3) % 13)) % 1000003;
  }
  const tag = "v1";
  return s + tag.length;
}
