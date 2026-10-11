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
