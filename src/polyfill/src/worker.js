/**
 * qzjs polyfill: Web Worker (parent side)
 *
 * W3C-style Worker class backed by a real execution backend (worker_backend):
 *
 *   THREAD  — each worker is its own qz_t with its own thread/loop/JSRuntime
 *             (execution model A), spawned via pal.spawnWorker (C-side slot).
 *   PROCESS — spawn 分层化: JS 层把通用进程原语（pal.processSpawn 等，C 只给
 *             "启动任意可执行文件 + 信封字节通道"）封装成 Worker 语义。写临时
 *             脚本 → processSpawn(qzjs-rt) → processOnMessage/processPost/
 *             processTerminate。对外接口（new Worker/postMessage/onmessage/
 *             terminate）与 THREAD 后端完全一致。
 *
 *   - new Worker(url)           — load script synchronously (file:// only in v1,
 *                                 via pal.fsReadSync), spawn worker, returns
 *                                 instance keyed by worker id.
 *   - w.postMessage(value)      — structured-clone bytes → per-backend send
 *                                 (pal.workerPost / pal.processPost).
 *   - w.terminate()             — per-backend stop (pal.workerTerminate /
 *                                 pal.processTerminate).
 *   - w.onmessage               — fires with MessageEvent whose data is
 *                                 deserialized from the worker's bytes.
 *   - w.onerror                 — fires when the worker script throws at the
 *                                 top level; the event's data is
 *                                 {type:'error', error:<message>}.
 *
 * Inbound routing: __qz_dispatch__(data, source). source 0 = host (delegates
 * to host-messaging's handler verbatim); source > 0 = THREAD worker id. PROCESS
 * worker inbound arrives via pal.processOnMessage callback directly (per-handle,
 * no source label) and funnels into the same deliverToWorker dispatch.
 * __qz_worker_post__(workerId, bytes) is the unified parent→worker byte
 * channel (both backends) that message-channel.js uses for MessagePort routing.
 *
 * Depends on: MessageEvent (message-channel.js), __qz_serialize__ /
 * __qz_deserialize__ (structured-clone.js), host-messaging.js (invoked after
 * it in index.js so the host handler can be captured for delegation).
 */

export function setupWorker(pal) {
  var self = globalThis;
  var workers = new Map();   /* worker id -> Worker 实例（THREAD id 1-16，
                                PROCESS id >= 1000，两后端不冲突） */


  /* §8.2 本 runtime 的 path 链（C 侧 pal.selfPath；根 runtime = []）。用于
   * 端点身份（port 代理的 owner/peerThread）与 worker 死亡清表。 */
  var selfPath = (typeof pal.selfPath === 'function') ? pal.selfPath() : [];
  function childPath(id) {
    var p = selfPath.slice();
    if (typeof id === 'number') p.push(id);
    return p;
  }
  // Synchronous script load. v1: file:// only.
  function loadScript(url) {
    if (typeof url !== 'string' || url.indexOf('file://') !== 0) {
      throw new Error('Worker: only file:// URLs are supported in v1');
    }
    return pal.fsReadSync(url.slice('file://'.length));
  }

  /* ── PROCESS 后端封装（spawn 分层化, Phase C）──
   * 源码经管道传给子进程（--script-stdin + opts.source）→ processSpawn →
   * processOnMessage/processPost/processTerminate。worker id 从 1000 起，
   * 避开 C 线程后端槽位 1-16。不再写 /tmp 临时脚本文件：源码全程只在内存
   * 与 socketpair 里流动，无明文落盘、无 unlink/泄漏、无命名冲突、不受
   * argv 长度限制。 */
  var procWorkerSeq = 1000;
  function ProcessWorker(code) {
    var id = ++procWorkerSeq;
    /* §8.2：本节点的完整 path = 父 path ++ [本地槽位 id]，经 --path 传给子
     * （进程号按直接父本地分配，跨层会撞号——只有 path 链能消歧路由）。 */
    var pathArg = selfPath.concat([id]).join(',');
    var argv = ['qzjs-rt', '--qzjs-worker', '--parent-fd', '3',
                '--worker-id', String(id), '--path', pathArg,
                '--script-stdin'];
    var handle = pal.processSpawn(null, argv,
                   { role: 0, id: id, handshake: true, source: code });
    this._id = id;
    this._handle = handle;
    this._dead = false;
    this._closing = false;   /* M-P4 §9.3：worker 自 close 的 closing 通知 */
  }
  ProcessWorker.prototype.post = function (bytes, kind, corr) {
    if (this._dead) return false;
    return pal.processPost(this._handle, bytes, kind, corr);
  };
  ProcessWorker.prototype.terminate = function () {
    if (this._dead) return;
    this._dead = true;
    pal.processTerminate(this._handle);
  };
  /* Liveness ping（父 → sub worker，仅显式调用）：检测 sub worker 事件循
   * 环是否阻塞。返回 0=通畅 / 1=超时（sub worker loop 阻塞）/ -1=通道死。 */
  ProcessWorker.prototype.ping = function (timeoutMs) {
    if (this._dead) return -1;
    return pal.processPing(this._handle, timeoutMs === undefined ? 1000 : timeoutMs);
  };

  function Worker(url) {
    var code = loadScript(url);
    var isProc = pal.workerBackend() === 'process';
    this._onmsg = null;
    this._onerror = null;
    this._onmsgErr = null;
    this._listeners = new Map();      /* type -> [{callback, once}] (EventTarget 支持) */
    var w = this;
    if (isProc) {
      this._proc = new ProcessWorker(code);
      this._id = this._proc._id;
      this._send = function (bytes, kind, corr) { return w._proc.post(bytes, kind, corr); };
      this._terminate = function () { w._proc.terminate(); };
      /* 入站：processOnMessage 直收（(bytes, kind)；kind=1 = PORT_TRANSFER 帧）。
       * EOF (bytes === null) → 标死 + 清端点路由表（对端 port 收 error，后续
       * post 静默丢弃），post/terminate 幂等安全。
       * kind=4（STORAGE，M-P4 §10.2）→ 本 worker 的 localStorage 请求（同步
       * RPC 的 request 半边）→ 交所有者处理器（local-storage.js 注册的
       * __qz_storage_dispatch__），不进应用消息流。
       * kind=3（CONTROL）→ 协议面，不进应用消息流；worker 自 close 的
       * closing 通知在这里消费（随后 EOF 不再当作崩溃，§9.3）。 */
      pal.processOnMessage(this._proc._handle, function (bytes, kind, corr) {
        if (bytes === null) {
          /* §9.3 崩溃检测：peer EOF。正常终止不触发 onerror——
           *   · 显式 terminate：ProcessWorker.terminate() 先置 _dead 再杀进程；
           *   · worker 自 close()：进程后端先发 CONTROL closing 再退出（_closing）；
           * 其余 EOF（kill -9 / 段错误）= 崩溃 → 主RT 侧 dispatch error 事件。 */
          var crashed = !w._proc._dead && !w._proc._closing;
          w._proc._dead = true;
          /* §8.2 端点死亡清表（path 链身份：本 worker 的子端点）。 */
          if (globalThis.__qz_endpoint_dead__)
            globalThis.__qz_endpoint_dead__(childPath(w._proc._id));
          if (crashed) w._deliverError('Worker process exited unexpectedly');
          return;
        }
        if (kind === 3) {
          /* payload 是 ArrayBuffer（C 侧 JS_NewArrayBufferCopy）——按字节扫
           * "closing" 判定自关（避免 Uint8Array 假设）。 */
          var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
          var txt = '';
          for (var i = 0; i < u8.length; i++) txt += String.fromCharCode(u8[i]);
          if (txt.indexOf('closing') >= 0) w._proc._closing = true;
          return;
        }
        if (kind === 4) {
          /* §10.2 单所有者代理：owner（根 runtime）就地执行；非根 runtime 是
           * 中继节点（N-P4）——把子树的请求上行给父，owner 的回复沿父通道
           * 回来时由 C 侧按 corr 配对下投（并发关联 id，见 ipc_envelope.h）。 */
          if (typeof globalThis.__qz_storage_dispatch__ === 'function')
            globalThis.__qz_storage_dispatch__(bytes, w._proc._id, corr);
          else if (typeof pal.storageRelay === 'function')
            pal.storageRelay(bytes, w._proc._id, corr);
          return;
        }
        var ww = workers.get(w._proc._id);
        if (ww) deliverToWorker(ww, bytes, kind);
      });
    } else {
      var id = pal.spawnWorker(code);   /* 同步阻塞直到 worker ready；失败抛 Error */
      this._id = id;
      this._send = function (bytes, kind) { return pal.workerPost(w._id, bytes, kind); };
      this._terminate = function () { pal.workerTerminate(w._id); };
    }
    workers.set(this._id, this);
    Object.defineProperty(this, 'onmessage', {
      get: function () { return w._onmsg; },
      set: function (fn) { w._onmsg = fn; },
      configurable: true,
    });
    Object.defineProperty(this, 'onerror', {
      get: function () { return w._onerror; },
      set: function (fn) { w._onerror = fn; },
      configurable: true,
    });
    Object.defineProperty(this, 'onmessageerror', {
      get: function () { return w._onmsgErr; },
      set: function (fn) { w._onmsgErr = fn; },
      configurable: true,
    });
  }

  Worker.prototype.addEventListener = function (type, callback, options) {
    if (typeof type !== 'string') return;
    if (typeof callback !== 'function' &&
        !(callback && typeof callback.handleEvent === 'function')) return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    var list = this._listeners.get(type);
    for (var i = 0; i < list.length; i++) {
      if (list[i].callback === callback) return;
    }
    list.push({ callback: callback, once: !!(options && options.once) });
  };

  Worker.prototype.removeEventListener = function (type, callback) {
    if (typeof type !== 'string') return;
    var list = this._listeners.get(type);
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i].callback === callback) { list.splice(i, 1); return; }
    }
  };

  Worker.prototype.dispatchEvent = function (event) {
    var type = event && event.type;
    if (typeof type !== 'string') return false;
    var handlers = [];
    var list = this._listeners.get(type);
    if (list) handlers = handlers.concat(list.slice());
    if (type === 'message' && typeof this._onmsg === 'function') handlers.push(this._onmsg);
    if (type === 'error' && typeof this._onerror === 'function') handlers.push(this._onerror);
    if (type === 'messageerror' && typeof this._onmsgErr === 'function') handlers.push(this._onmsgErr);
    for (var i = 0; i < handlers.length; i++) {
      var entry = handlers[i];
      try {
        /* entry 两种形态：裸函数（onmessage 等内建 handler）或
         * {callback, once}（addEventListener 存的对象，callback 可为
         * 函数或带 handleEvent 的对象） */
        var target = typeof entry === 'function' ? entry : entry.callback;
        var cb = typeof target === 'function'
          ? target
          : (target && typeof target.handleEvent === 'function' ? target.handleEvent : undefined);
        if (typeof cb === 'function') cb.call(this, event);
      } catch (err) {
        if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
        else if (globalThis.console) console.error('Error in worker event listener:', err);
      }
      if (entry && entry.once && list) {
        var idx = list.indexOf(entry);
        if (idx >= 0) list.splice(idx, 1);
      }
    }
    return true;
  };

  /* C 侧 worker 错误通知（wire format {type:'error', error:<msg>}）→
   * ErrorEvent('error')，并保留 e.data 兼容历史 onerror 契约。 */
  Worker.prototype._deliverError = function (msg) {
    var ev;
    try {
      ev = new ErrorEvent('error', { message: String(msg), error: new Error(String(msg)), cancelable: true });
    } catch (err) {
      try { ev = new Event('error'); } catch (e2) { ev = { type: 'error' }; }
      ev.message = String(msg);
    }
    ev.data = { type: 'error', error: String(msg) };
    this.dispatchEvent(ev);
  };

  Worker.prototype.postMessage = function (value, transfer) {
    /* 拆出 transfer 列表里的 MessagePort（其余 ArrayBuffer 照常序列化），
     * 编码成 PORT_TRANSFER 帧（op=2）：16B 头 + SC({__qz_ports, __qz_payload})。
     * 转移语义：原 port 标记 detached；留在父侧的对端 port 的 _peerThread 指向
     * worker（消息将来按该端点投递）。ref 带 owner——跨进程下各进程本地 id 会
     * 重合，接收方按 (owner,id) 登记代理（§8.2）。 */
    var ports = [];
    var abTransfer;
    if (transfer && transfer.length) {
      abTransfer = [];
      for (var i = 0; i < transfer.length; i++) {
        var t = transfer[i];
        if (typeof MessagePort !== 'undefined' && t instanceof MessagePort) {
          /* ref.peerThread = 被转移 port 的对端当前所在端点（从接收方视角）。
           * 对端留在本 runtime（'local'）→ 从接收方看即本发送方端点 = selfPath；
           * 已在别处（path）→ 原样保持。 */
          ports.push({ id: t._id, peerId: t._peerId, owner: t._owner,
                       peerThread: (t._peerThread === 'local'
                                      ? selfPath.slice() : t._peerThread) });
          t._detached = true;   /* 原 port 已转移，不再可用 */
          /* §8.2 路由表：该 port 已从本 runtime 移到子 worker（对端可能仍按
           * 旧端点发来 → 本 runtime 命中本地但 port 已 detached 时按表改指）。 */
          if (globalThis.__qz_port_moved__)
            globalThis.__qz_port_moved__(t._owner, t._id, childPath(this._id));
          var peer = globalThis.__qz_lookup_port__(t._peerId, t._owner);
          if (peer) peer._peerThread = childPath(this._id);  /* 对端现在在子 worker */
        } else {
          abTransfer.push(t);
        }
      }
      if (!abTransfer.length) abTransfer = undefined;
    }
    var dataBytes = __qz_serialize__(value, abTransfer);
    if (ports.length) {
      var wrapped = __qz_serialize__(
        { __qz_ports: ports, __qz_payload: dataBytes });
      this._send(globalThis.__qz_port_xfer_frame__(wrapped), 1);
    } else {
      this._send(dataBytes);
    }
  };

  Worker.prototype.terminate = function () {
    this._terminate();
    workers.delete(this._id);
    /* 显式终止也要清端点路由表（进程后端另有 EOF 路径；此处覆盖 THREAD 与
     * 进程后端正常终止，两次调用幂等）。 */
    if (globalThis.__qz_endpoint_dead__)
      globalThis.__qz_endpoint_dead__(childPath(this._id));
  };

  /* Liveness ping（父 → sub worker，仅显式调用）：检测 sub worker 事件循环
   * 是否阻塞。PROCESS 后端经 pal.processPing；THREAD 后端恒 0（同进程 loop，
   * 无独立事件循环可测——线程忙即主线程忙，语义不适配，按通畅处理）。返回
   * 0=通畅 / 1=超时（sub worker loop 阻塞）/ -1=通道死。 */
  Worker.prototype.ping = function (timeoutMs) {
    if (this._proc && typeof this._proc.ping === 'function')
      return this._proc.ping(timeoutMs);
    return 0;   /* THREAD 后端：无独立事件循环，恒通畅 */
  };

  /* 判断是否为 C 侧 worker 错误通知：{type:'error', error:<string>}。
   * 要求 error 为字符串以尽量排除用户消息误路由；彻底区分需 C 侧 wire marker
   * （见报告）。 */
  function isWorkerError(d) {
    return d && typeof d === 'object' &&
           d.type === 'error' && typeof d.error === 'string';
  }

  /* 公共入站派发：克隆字节 → 反序列化 → MessageEvent/port 路由/error 通知。
   * THREAD 的 __qz_dispatch__ 与 PROCESS 的 processOnMessage 回调共用。
   * kind=1（PORT_TRANSFER）先按帧头分流：op=1 是 port 消息（投递或按 dest
   * 端点接力），op=2 是 port 转移列表（解包重建代理后派发 MessageEvent）。 */
  function deliverToWorker(w, dataBytes, kind) {
    var d;
    if (kind === 1 && globalThis.__qz_port_frame_op__) {
      var op = globalThis.__qz_port_frame_op__(dataBytes);
      if (op === 1) {
        globalThis.__qz_route_port_message__(dataBytes);
        return;   /* port 消息属于某个 port，不派发到 Worker.onmessage */
      }
      if (op !== 2) return;   /* 未知 op：协议不认识，丢弃 */
      dataBytes = globalThis.__qz_port_frame_body__(dataBytes);  /* 剥路由头 */
    }
    try { d = __qz_deserialize__(dataBytes); }
    catch (err) {
      /* 反序列化失败：按规范触发 worker 的 messageerror 事件 */
      var errEv;
      try { errEv = new MessageEvent('messageerror'); }
      catch (e2) { errEv = new Event('messageerror'); }
      w.dispatchEvent(errEv);
      return;
    }
    /* 带 MessagePort 转移的 worker 消息：解包 ports + payload */
    if (d && typeof d === 'object' && d.__qz_ports) {
      var ports = [];
      try {
        for (var i = 0; i < d.__qz_ports.length; i++) {
          ports.push(globalThis.__qz_port_from_ref__(d.__qz_ports[i]));
        }
      } catch (err) { reportError(err); return; }
      var inner;
      try { inner = __qz_deserialize__(d.__qz_payload); }
      catch (err) { reportError(err); return; }
      if (isWorkerError(inner)) { w._deliverError(inner.error); return; }
      var ev2;
      try { ev2 = new MessageEvent('message', { data: inner, ports: ports }); }
      catch (err) { reportError(err); return; }
      w.dispatchEvent(ev2);
      return;
    }
    if (isWorkerError(d)) { w._deliverError(d.error); return; }
    var e;
    try {
      e = new MessageEvent('message', { data: d });
    } catch (err) {
      reportError(err);
      return;
    }
    w.dispatchEvent(e);
  }

  globalThis.Worker = Worker;

  /* 统一父→worker 字节通道（THREAD: pal.workerPost；PROCESS: processPost）。
   * message-channel.js 用它路由 MessagePort 跨线程消息。worker 存在即视为
   * 投递成功（THREAD 的 workerPost 返回 undefined；PROCESS 的 processPost
   * 对已死句柄返回 false 也在此静默，与 THREAD 语义对齐）。corr = STORAGE
   * 中继关联 id（owner 回复回显，缺省 undefined → 0）。 */
  globalThis.__qz_worker_post__ = function (workerId, bytes, kind, corr) {
    var w = workers.get(workerId);
    if (!w) return false;
    w._send(bytes, kind, corr);
    return true;
  };

  // Route inbound messages: source 0 = host JSON, > 0 = THREAD worker bytes.
  // (PROCESS worker inbound bypasses this — processOnMessage callback.)
  var hostDispatch = self.__qz_dispatch__;
  globalThis.__qz_dispatch__ = function (data, source, kind) {
    if (source === 0) {
      /* 嵌套 spawn：本 worker 也加载了 Worker polyfill → 用重载 dispatch；父
       * 消息（含 PORT_TRANSFER 帧）必须把 kind 原样递给 boot shim 分流，否则
       * port 帧被当普通消息反序列化（整帧带路由头 → null/garbage）。 */
      hostDispatch(data, source, kind);
      return;
    }
    var w = workers.get(source);
    if (!w) return;
    deliverToWorker(w, data, kind);
  };
}
