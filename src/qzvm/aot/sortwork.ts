// 排序：两档各自实现同一确定性稳定归并（不委托宿主引擎）——
// 这里覆盖默认排序（ToString code-unit）、comparator 数值序、稳定性、
// toSorted 不改原数组、非可调 comparator 的 TypeError。
function sortDefault(): any {
  const a = [10, 1, 2, "9", "100"];
  a.sort();
  return a.join(",");                       // 数字按字符串比："1,10,100,2,9"
}

function sortStrings(): any {
  const a = ["banana", "Apple", "cherry", "apple"];
  a.sort();
  return a.join(",");                       // code-unit："Apple,apple,banana,cherry"
}

function sortNumCmp(): any {
  const a = [3, 1, 4, 1, 5];
  a.sort((x: any, y: any) => x - y);
  return a.join("");                        // "11345"
}

// comparator 恒返 0 ⇒ 每层归并都取左侧 ⇒ 原序保持（ES2019 强制稳定）
function sortStableZero(): any {
  const a = [7, 3, 9, 1, 8];
  a.sort((x: any, y: any) => 0);
  return a.join("");                        // "73918"
}

// 同键保序：按十位分组，组内维持输入相对顺序
function sortStableKey(): any {
  const a = [21, 11, 22, 12, 23];
  a.sort((x: any, y: any) => (x - x % 10) - (y - y % 10));
  return a.join(",");                       // "11,12,21,22,23"
}

// comparator 返非数值（NaN）→ 规范按 +0 处理 → 稳定 ⇒ 原序不变
function sortCmpNaN(): any {
  const a = [2, 1, 3];
  a.sort((x: any, y: any) => "z");
  return a.join("");                        // "213"
}

function sortCopy(): any {
  const a = [3, 1, 2];
  const b = a.toSorted();
  return b.join("") + "|" + a.join("");     // "123|312"（原数组不改）
}

function sortCopyCmp(): any {
  const a = [3, 1, 2];
  return a.toSorted((x: any, y: any) => y - x).join("");  // "321"
}

// 非可调 comparator：规范要求在重排前 TypeError，消息含该值的展示形式
function sortBadCmp(): any {
  const a = [2, 1];
  try {
    a.sort(123);
    return "nothrow";
  } catch (e) {
    return e.message;
  }
}

// 长度超 4 槽、跨多轮归并的规模（两档比较序列必须逐次一致）
function sortMany(): any {
  const a: any[] = [];
  for (let i = 0; i < 37; i++) a.push((i * 7) % 37);
  a.sort((x: any, y: any) => x - y);
  let bad = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1] > a[i]) bad = bad + 1;
  return a[0] * 1000 + a[36] + bad;         // 0*1000+36+0 = 36
}

// 规范未定：矛盾 comparator（恒 1 / 恒 -1，非严格弱序）。两档必须由同一确定性归并
// 给出**同一个**序（平手取左），与 V8 TimSort 可以不同 —— 跨档一致是硬要求。
function sortContradictory(): any {
  const a = [2, 1];
  a.sort((x: any, y: any) => 1);
  const b = [2, 1];
  b.sort((x: any, y: any) => -1);
  return a.join(",") + "__" + b.join(",");
}

// 同一判据在**宿主承载数组**上也必须成立：new Array(n) 的元素是宿主 JS 数组（0x7FFD），
// 不是 0x7FFB 内存块。C 档 qz_arr_sort_op 对它同样自走归并；宿主档若把 sort 交回内建
// 就会按宿主引擎实现排 → 矛盾 comparator 下两档分序。
function sortHostCarrierContradictory(): any {
  const a: any = new Array(4);
  a[0] = 2; a[1] = 1; a[2] = 4; a[3] = 3;
  a.sort((x: any, y: any) => 1);
  const b: any = new Array(4);
  b[0] = 2; b[1] = 1; b[2] = 4; b[3] = 3;
  b.sort((x: any, y: any) => -1);
  return a.join(",") + "__" + b.join(",");
}

// 比较调用次数同样由算法唯一确定（ES 不规定，V8 少 1 次）：两档计数必须相同。
function sortCmpCount(): any {
  let n = 0;
  const a = [5, 3, 8, 1, 9, 2, 7];
  a.sort((x: any, y: any) => { n = n + 1; return x - y; });
  return a.join(",") + "|" + n;
}

// undefined 元素不参与排序、落尾部；规范把尾部写成 **present-undefined**（CreateDataProperty，
// 长度不变、`k in a` 为 true）。两档必须同值，且这值是 V8 的值（不是实现相关分支）。
function sortUndefTail(): any {
  const a = [3, undefined, 1];
  a.sort();
  const b = [2, undefined, undefined, 1];
  const c = b.toSorted();
  return [a.join(","), a.length, 1 in a, a[2] === undefined,
          b.join(","), b.length, c.join(","), c.length, 2 in c, 3 in c].join("/");
}
