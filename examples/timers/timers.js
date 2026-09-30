/* qzjs example: timers and async — 定时器与异步驱动
 *
 * 演示 qzjs 的事件循环驱动 JS 异步：setTimeout / setInterval / Promise
 * 在 qzjs 内部线程的 libuv 循环上推进（宿主不驱动）。
 *
 * 运行：
 *   ./build/qzjs examples/timers/timers.js
 */
(async () => {
  var t0 = performance.now();

  // 1) setTimeout + await（Promise 包裹）
  await new Promise(r => setTimeout(r, 50));
  console.log('setTimeout 50ms 后:', (performance.now() - t0).toFixed(0) + 'ms');

  // 2) setInterval：计 3 次后清除
  var n = 0;
  await new Promise((resolve) => {
    var id = setInterval(() => {
      n++;
      console.log('  interval tick', n);
      if (n >= 3) { clearInterval(id); resolve(); }
    }, 30);
  });

  // 3) 并发 Promise.all
  var [a, b] = await Promise.all([
    new Promise(r => setTimeout(() => r('A'), 20)),
    new Promise(r => setTimeout(() => r('B'), 40)),
  ]);
  console.log('Promise.all:', a, b);

  // 4) 微任务
  await Promise.resolve();
  console.log('微任务完成');
  console.log('总计:', (performance.now() - t0).toFixed(0) + 'ms');
})();
