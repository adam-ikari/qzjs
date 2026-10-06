// 供 parent_stays_busy_while_worker_has_pending_async_work 使用：
// 起一个短定时器并 postMessage，让父在定时器到期前观测到 worker 的 busy 位。
postMessage('probe-started');
setTimeout(function () { postMessage('probe-timer-fired'); }, 40);
