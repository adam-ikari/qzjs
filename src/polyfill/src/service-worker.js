/**
 * qzjs polyfill: Service Worker — SW-1/2/3（注册 / 生命周期 / 消息 + fetch 拦截）
 *
 * SW 脚本跑在独立 worker 线程（复用 Worker）。主线程状态机由 worker 侧
 * 控制消息驱动（协议见 worker-boot.js）：
 *   register → new Worker(url)（同步 spawn + 脚本顶层 eval）
 *     → {__qz_sw__:'enter'} → {__qz_sw_lifecycle__:'install'} → installing
 *   ← {__sw_event__,phase:'install_done'} → installed →（零等待）activating
 *     → {__qz_sw_lifecycle__:'activate'}
 *   ← {__sw_event__,phase:'activate_done'} → activated → controller + controllerchange
 *   带 error 的 *_done / worker 'error' 事件 → redundant。
 * 与浏览器差异（设计已拍板）：全局唯一注册；scope 接受但忽略；
 * install 完成即自动 skipWaiting + 激活；register() 在 install 成功即 resolve。
 *
 * SW-3 更新机制：register()/update() 每次同步读脚本（pal.fsReadSync）做字节
 * 对比——最新槽位（installing > waiting > active）字节未变 → 跳过安装直接
 * resolve 现有 registration；字节变化 → 走 install（在途 installing 若字节
 * 与 active 相同即回滚场景 → 先取消在途安装再沿用 active）。多版本切换：
 * controller/active 在 activate_done 才切（此前旧 SW 保持 controller 继续
 * 拦截 fetch，无控制真空），activate 完成才 kill 旧 SW。
 */

export function setupServiceWorker(pal) {
  var self = globalThis;

  var currentRegistration = null;
  var controller = null;
  var readyResolve = null;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

  /* ---- SW-1：fetch 拦截状态 ----
   * fetchSeq/pendingFetches：主线程 fetch() 被 SW 接管的在途表。
   * entry.resolve/reject = fetch promise 的 settle 钩子；onFallback(bytes)
   * = SW 回退/超时/SW 终止时续走网络（bytes 复用，流式 body 不可重读）；
   * onSettle = 成功响应后移除 abort 监听（回退路径保持监听交回网络）。 */
  var fetchSeq = 0;
  var pendingFetches = new Map();

  /* dispatchEvent + onX 属性（EventTarget 类不调 onX，这里统一补） */
  function fire(target, event) {
    target.dispatchEvent(event);
    var h = target['on' + event.type];
    if (typeof h === 'function') h.call(target, event);
  }
  /* SW-3：同步读 SW 脚本源码（pal.fsReadSync，与 worker.js loadScript 同路径）。
   * 每次 register/update 都重读当前文件内容做字节对比。 */
  function loadSWScript(url) {
    if (typeof url !== 'string' || url.indexOf('file://') !== 0) {
      throw new Error('serviceWorker.register: only file:// script URLs are supported in SW-3');
    }
    return pal.fsReadSync(url.slice('file://'.length));
  }

  /* ---- ServiceWorker ---- */
  class ServiceWorker extends EventTarget {
    constructor(url, scriptBytes) {
      super();
      this._url = url;
      this._state = 'parsed';
      this._worker = null;    /* worker.js 的真 Worker 实例 */
      this._settled = false;  /* activated / redundant 即终态 */
      this._onok = null;      /* register() resolve/reject 钩子 */
      this._onfail = null;
      /* SW-3：脚本字节（无传入时同步读取），作为同 URL 更新的字节对比基准 */
      this._scriptBytes = (scriptBytes !== undefined) ? scriptBytes : loadSWScript(url);
    }
    get state() { return this._state; }
    get scriptURL() { return this._url; }
    postMessage(data, transfer) {
      if (!this._worker) throw new TypeError('ServiceWorker.postMessage: worker is not running');
      this._worker.postMessage(data, transfer);
    }
    _setState(state) {
      if (this._state === state) return;
      this._state = state;
      if (state === 'activated' || state === 'redundant') this._settled = true;
      var ev = new Event('statechange');
      ev.state = state;
      fire(this, ev);
    }
    _kill() {
      if (!this._worker) return;
      var w = this._worker;
      this._worker = null;
      try { w.terminate(); } catch (err) { /* 已终止 */ }
    }
  }

  /* ---- ServiceWorkerRegistration ---- */
  class ServiceWorkerRegistration extends EventTarget {
    constructor(url, scope) {
      super();
      this._url = url;
      this._scope = scope;
      this._installing = null;
      this._waiting = null;
      this._active = null;
    }
    get installing() { return this._installing; }
    get waiting() { return this._waiting; }
    get active() { return this._active; }
    get scope() { return this._scope; }
    /* SW-3：update() = 同 URL 重跑 register 的字节对比流程（相同跳过/不同 install） */
    update() { return container.register(this._url, { scope: this._scope }); }
    unregister() {
      var slots = [this._installing, this._waiting, this._active];
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (!s) continue;
        s._kill();
        if (s._state !== 'redundant') s._setState('redundant');
      }
      this._installing = this._waiting = this._active = null;
      if (controller && controller._state === 'redundant') {
        controller = null;
        fire(container, new Event('controllerchange'));
      }
      if (currentRegistration === this) currentRegistration = null;
      return Promise.resolve(true);
    }
  }

  /* ---- 状态机 ---- */
  function failSW(sw, registration, reason) {
    if (sw._settled) return;
    sw._kill();
    if (registration._installing === sw) registration._installing = null;
    if (registration._waiting === sw) registration._waiting = null;
    if (registration._active === sw) registration._active = null;
    sw._setState('redundant');
    var f = sw._onfail;
    sw._onok = sw._onfail = null;
    if (f) f(reason instanceof Error ? reason : new Error(String(reason)));
    /* SW 挂了：在途被拦截 fetch 全部回退网络（设计 §7.2 预期行为）。
     * SW-3：仅当挂掉的就是当前 controller 才 flush——新 SW install/activate
     * 失败时旧 SW 仍是 controller，在途 fetch 仍由旧 SW 应答，flush 会与之竞态。 */
    if (sw === controller) flushPendingFetches();
  }

  /* SW 终止/替换时把所有在途 fetch 回退网络（计时器一并清掉） */
  function flushPendingFetches() {
    if (!pendingFetches.size) return;
    var entries = Array.from(pendingFetches.values());
    pendingFetches.clear();
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].timer) clearTimeout(entries[i].timer);
      entries[i].onFallback(entries[i].bytes);
    }
  }

  /* install 完成 → 零等待激活。SW-3：controller/active 切换延到 activate_done
   * 才做——新 SW install/activating 期间旧 SW 保持 controller 继续拦截
   * （无控制真空），activate 完成才替换并 kill 旧 SW。 */
  function activateSW(sw, registration) {
    /* C2：activating worker 留在 _waiting 槽（不清空）——重叠更新才能
     * supersede 它；旧 controller 快照延到 activate_done 按当时真实
     * controller 重算（见 handleControl）。 */
    sw._setState('activating');
    try {
      sw._worker.postMessage({ __qz_sw_lifecycle__: 'activate' });
    } catch (err) {
      failSW(sw, registration, err);
    }
  }

  function handleControl(sw, registration, d) {
    /* fetch 回话与生命周期无关，先处理：activated 的 controller 是终态，
     * 不能被下面的终态守卫挡掉。 */
    if (d.phase === 'fetch_response' || d.phase === 'fetch_fallback') {
      var entry = pendingFetches.get(d.fetchId);
      if (!entry) return;
      pendingFetches.delete(d.fetchId);
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      if (d.phase === 'fetch_response' && d.response) {
        /* SW 回话：Response 重建（body 为对端 structuredClone 的 Uint8Array）。
         * onSettle 移除 abort 监听（promise 已 settle，不再需要）。 */
        var res = new Response(d.response.body != null ? d.response.body : null, {
          status: d.response.status || 200,
          statusText: d.response.statusText || '',
          headers: d.response.headers,
        });
        res._url = entry.url;
        if (entry.onSettle) entry.onSettle();
        entry.resolve(res);
      } else {
        /* SW 回退（无监听器/respondWith reject/serialize 失败）：
         * abort 监听保持（交回网络路径），续走网络。 */
        entry.onFallback(entry.bytes);
      }
      return;
    }
    /* C2：终态守卫——被 supersede/kill 的 SW 的迟到 install_done/activate_done
     * （terminate 前已投递到主线程队列）不得复活它。 */
    if (sw._settled) return;
    var failed = typeof d.error === 'string' && d.error !== '';
    if (d.phase === 'install_done') {
      if (failed) { failSW(sw, registration, new Error('install failed: ' + d.error)); return; }
      registration._installing = null;
      registration._waiting = sw;
      sw._setState('installed');
      var ok = sw._onok;
      sw._onok = null;
      if (ok) ok(registration);
      activateSW(sw, registration);
    } else if (d.phase === 'activate_done') {
      if (failed) { failSW(sw, registration, new Error('activate failed: ' + d.error)); return; }
      sw._setState('activated');
      /* SW-3：activate 完成 → 新 SW 成为 controller/active（旧 SW 自此被替换）。
       * C2：previous 按 activate_done 时刻的真实 controller 重算（非 activateSW
       * 快照），重叠激活时不会杀错旧 SW；activating worker 从 _waiting 槽摘除。 */
      registration._active = sw;
      if (registration._waiting === sw) registration._waiting = null;
      var previous = (controller !== sw) ? controller : null;
      controller = sw;
      if (previous && previous !== sw) {
        previous._kill();
        previous._setState('redundant');
        /* 旧 SW 已终止：其未回话的在途 fetch 全部回退网络（新 SW 不认旧 id） */
        flushPendingFetches();
      }
      fire(container, new Event('controllerchange'));
      if (readyResolve) {
        var r = readyResolve;
        readyResolve = null;
        r(registration);
      }
    }
    /* phase === 'skipWaiting'：qzjs 本就零等待，忽略 */
  }

  /* ---- navigator.serviceWorker ---- */
  var container = new EventTarget();

  Object.defineProperty(container, 'controller', {
    get: function () {
      return controller && controller._state === 'activated' ? controller : null;
    },
    configurable: true, enumerable: true,
  });
  Object.defineProperty(container, 'ready', {
    get: function () { return readyPromise; },
    configurable: true, enumerable: true,
  });
  Object.defineProperty(container, 'oncontrollerchange', {
    get: function () { return this._oncc || null; },
    set: function (fn) { this._oncc = fn; },
    configurable: true, enumerable: true,
  });

  /* ---- SW-1：fetch.js 网络路径前的拦截入口 ----
   * 返回 true = 已派发 FetchEvent 到 SW 线程（fetch promise 由回话消息驱动）；
   * 返回 false = 无 activated 控制器，fetch.js 直接走网络。
   * 30s 超时回退（设计 §5 SW-1，与浏览器一致）。 */
  container.__qz_sw_intercept__ = function (request, bytes, resolve, reject, onFallback, onSettle) {
    var sw = controller;
    if (!sw || sw._state !== 'activated' || !sw._worker) return false;
    var fetchId = ++fetchSeq;
    var headers = {};
    request.headers.forEach(function (value, name) { headers[name] = value; });
    var entry = {
      resolve: resolve,
      onFallback: onFallback,
      onSettle: onSettle,
      bytes: bytes,
      url: request.url,
      timer: null,
    };
    pendingFetches.set(fetchId, entry);
    entry.timer = setTimeout(function () {
      if (!pendingFetches.has(fetchId)) return;
      pendingFetches.delete(fetchId);
      entry.timer = null;
      onFallback(bytes);
    }, 30000);
    try {
      sw._worker.postMessage({
        __qz_sw_fetch__: {
          fetchId: fetchId,
          request: { url: request.url, method: request.method, headers: headers, body: bytes || null },
        },
      });
    } catch (err) {
      if (entry.timer) clearTimeout(entry.timer);
      pendingFetches.delete(fetchId);
      return false;
    }
    return true;
  };

  container.register = function (url, options) {
    var scope = (options && options.scope != null) ? String(options.scope) : '/';

    var registration = (currentRegistration && currentRegistration._url === url)
      ? currentRegistration
      : new ServiceWorkerRegistration(url, scope);
    registration._scope = scope;

    /* SW-3：每次 register/update 同步读脚本（与 new Worker 同一文件），
     * 与已记录字节对比。读失败 → reject（与 new Worker 加载失败语义一致）。 */
    var bytes;
    try {
      bytes = loadSWScript(url);
    } catch (err) {
      return Promise.reject(err);
    }

    /* SW-3：同 URL 字节对比。取最新槽位优先（installing > waiting > active）。 */
    var current = registration._installing || registration._waiting || registration._active;
    if (current) {
      /* I2：并发同 URL register/update——在途/等待 worker 字节与本次一致 →
       * 不杀不重装，直接 resolve 同一 registration（首个调用方不受影响）。 */
      if (current._scriptBytes === bytes) {
        currentRegistration = registration;
        return Promise.resolve(registration);
      }
      /* C1：回滚窗口——在途 installing 字节 ≠ 新字节，但 active 已持有新字节
       * （文件回写成旧版本）→ 取消在途安装、沿用 active，否则回滚被吞。 */
      if (current === registration._installing && registration._active &&
          registration._active._scriptBytes === bytes) {
        failSW(registration._installing, registration, new Error('superseded'));
        currentRegistration = registration;
        return Promise.resolve(registration);
      }
    }

    var sw = new ServiceWorker(url, bytes);
    var promise = new Promise(function (resolve, reject) {
      sw._onok = resolve;
      sw._onfail = reject;
    });

    /* 同一 registration 上未完成的前一次安装尝试直接作废 */
    if (registration._installing) failSW(registration._installing, registration, new Error('superseded'));
    if (registration._waiting) failSW(registration._waiting, registration, new Error('superseded'));
    registration._installing = sw;
    currentRegistration = registration;

    var worker;
    try {
      /* 同步：spawn worker 线程 + 跑完 SW 脚本顶层（install listener 就位） */
      worker = new self.Worker(url);
    } catch (err) {
      /* I1：统一走 failSW——它清 _installing 槽、置 redundant、调 sw._onfail
       * 让构造 promise reject（手写状态行会漏 _onfail → 悬空未 settle promise）。 */
      failSW(sw, registration, err);
      return promise;
    }
    sw._worker = worker;

    worker.addEventListener('message', function (ev) {
      if (ev.data && typeof ev.data === 'object' && ev.data.__sw_event__ === true) {
        handleControl(sw, registration, ev.data);
      } else {
        fire(sw, new MessageEvent('message', { data: ev.data }));
      }
    });
    /* worker.js 把 C 侧 {type:'error'} 转成 ErrorEvent('error') */
    worker.addEventListener('error', function (ev) {
      failSW(sw, registration, new Error(ev && ev.message ? ev.message : 'service worker script error'));
    });

    sw._setState('installing');
    try {
      /* 1) 进入 SW 模式  2) 派发 install（见 worker-boot.js） */
      worker.postMessage({ __qz_sw__: 'enter', url: url, scope: scope });
      worker.postMessage({ __qz_sw_lifecycle__: 'install' });
    } catch (err) {
      failSW(sw, registration, err);
    }
    return promise;
  };

  container.getRegistration = function () {
    return Promise.resolve(currentRegistration || null);
  };
  container.getRegistrations = function () {
    return Promise.resolve(currentRegistration ? [currentRegistration] : []);
  };

  if (!self.navigator) self.navigator = {};
  self.navigator.serviceWorker = container;
}
