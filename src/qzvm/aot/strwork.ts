// 字符串拼接（guard 回退 qz.add 跨界）—— 真正的动态 I/O
function strWork(n: any): any {
  let s = "0";
  for (let i = 0; i < n; i++) s = s + i;
  return s;
}
// 复合赋值拼接（s += x）等价于 s = s + x
function strWorkEq(n: any): any {
  let s = "0";
  for (let i = 0; i < n; i++) s += i;
  return s;
}
// 字符串方法：slice/upper/indexOf/charAt/replace/repeat（经 qz.str_method 回退）
function strMethods(): any {
  let s = "Hello, World";
  let a = s.slice(0, 5);
  let b = s.toUpperCase();
  let c = s.indexOf("World");
  let d = s.charAt(1);
  let e = s.replace("World", "qz");
  let f = "ab".repeat(3);
  return a + "|" + b + "|" + c + "|" + d + "|" + e + "|" + f;
}
