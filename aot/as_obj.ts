// AS 对象负载 bench：N 次循环 new_object + set a/b + get a
// 对象操作走 @external qz.* → wasm2c wrap（quickjs 实现）
@external("qz", "new_object") declare function new_object(): i32;
@external("qz", "new_number") declare function new_number(n: i32): i32;
@external("qz", "set_prop")   declare function set_prop(o: i32, k: i32, v: i32): void;
@external("qz", "get_prop")   declare function get_prop(o: i32, k: i32): i32;
@external("qz", "dump")       declare function dump(v: i32): void;

export function objbench(iters: i32): i32 {
  let last = 0;
  for (let i = 0; i < iters; i++) {
    const o = new_object();
    set_prop(o, 0, new_number(i));        // o.a = i
    set_prop(o, 1, new_number(i * 2));    // o.b = i*2
    last = get_prop(o, 0);                // get a (tagged，只存不算)
  }
  return last;
}

dump(objbench(10000));
