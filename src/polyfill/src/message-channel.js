/**
 * qzjs polyfill: MessageChannel, MessagePort, MessageEvent
 *
 * TC55/ECMA-429 requires MessageChannel for structured communication
 * between execution contexts. MessagePort extends EventTarget.
 *
 * Cross-thread MessagePort transfer (transferable):
 *   - Every port gets a globally-unique id (pal.portCreate, atomically
 *     allocated in C). A MessageChannel holds one entangled pair (id1/id2).
 *   - Same-thread messaging stays a direct JS object reference
 *     (_entangledPort). Cross-thread messaging (after a port is transferred
 *     to a Worker) goes through the existing worker byte channels
 *     (pal.workerPost parent→worker, pal.postMessage worker→parent) wrapped
 *     as {__port_msg: {target: <peerId>, payload: <serialized bytes>}}.
 *   - Every thread keeps a local registry (id → MessagePort). Inbound
 *     dispatch (worker.js / worker boot shim) recognizes {__port_msg} and
 *     routes to the local port.
 *
 * Depends on: EventTarget (must be loaded after event-target.js).
 */

export function setupMessageChannel(pal) {
  if (typeof globalThis.EventTarget !== 'function') {
    throw new Error('MessagePort requires EventTarget to be loaded first');
  }
  if (typeof globalThis.structuredClone !== 'function') {
    throw new Error('MessagePort requires structuredClone to be loaded first');
  }

  /* Local port registry: (owner, id) → MessagePort. Each runtime (JSRuntime)
   * has its own copy of this module, so the Map is per-runtime.
   *
   * M-P3 endpoint identity: a port is identified by (owner, id), owner being
   * the endpoint that created it — 0 = mainRT/root, >0 = the worker id the
   * direct parent assigned at spawn (§8.2 "直接父本地分配": every runtime
   * allocates ids locally, so two isolated processes both hand out 1,2 — only
   * the owner disambiguates). Under THREAD the C allocator is process-global
   * and ids never collide, but the composite key stays unique, so behaviour is
   * unchanged there. */
  var portRegistry = new Map();
  /* True inside a worker runtime: its pal has workerClose but not workerPost. */
  var inWorker = typeof pal.workerClose === 'function';

  /* ── §8.2 端点身份 = path 链（u16 数组，rt 树根起逐级父分配槽位 id）──
   * 根（主RT/宿主 runtime）= []；子 = 父 path ++ [父分配的槽位 id]。C 侧
   * pal.selfPath() 给出本 runtime 的完整链（THREAD worker 退化为 [workerId]，
   * 扁平 PROCESS worker 为 [slot]，嵌套为 [slot, slot, ...]）。 */
  function toPath(v) {
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v.slice();
    return [v | 0];
  }
  var ownerSelf = toPath(typeof pal.selfPath === 'function'
                           ? pal.selfPath()
                           : (inWorker ? pal.workerId() : []));
  /* 本 runtime 的直接父端点 path（根无父 → 自身，作不可达占位）。 */
  function parentPath() {
    return ownerSelf.length ? ownerSelf.slice(0, ownerSelf.length - 1)
                            : ownerSelf.slice();
  }

  function pathEq(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  /* 严格前缀（pref 比 p 短或等长时非真后代） */
  function pathIsPrefix(pref, p) {
    if (!pref || !p || pref.length >= p.length) return false;
    for (var i = 0; i < pref.length; i++) if (pref[i] !== p[i]) return false;
    return true;
  }

  /* §8.2 路由表（LCA 中继的「改指转发」半边）：port 身份 → 该 port 当前所在地
   * 的新端点 path。一个 port 被本 runtime 再转移走（worker 把从父收到的 port
   * 转给子 / 把自有 port 转给父）后，对端仍按旧端点发来 —— 本 runtime 命中
   * 本地却找不到可投递的 port 时，按本表把 dest 改指到新端点再逐跳转发。
   * payload 不解码、字节原样（§7.2）。 */
  var redirects = new Map();
  /* 转移钩子：某 port 从本 runtime 移到 destPath（worker.js / boot shim 调用） */
  globalThis.__qz_port_moved__ = function (owner, id, destPath) {
    redirects.set(portKey(toPath(owner), id), toPath(destPath));
  };
  function pathKey(p) { return p.join(','); }
  function portKey(ownerPath, id) { return pathKey(ownerPath) + ':' + id; }
  function registerPort(p) {
    if (p._id) portRegistry.set(portKey(p._owner, p._id), p);
  }
  function lookupPort(id, owner) {
    return portRegistry.get(portKey(owner === undefined ? ownerSelf : toPath(owner), id));
  }

  /* ── §8.2 port frames ──
   * A PORT_TRANSFER envelope payload is a variable-length LE routing header
   * followed by opaque structured-clone bytes (ipc_envelope.h): op, then the
   * dest path (where the target port currently lives), the key path (the
   * target port's home endpoint) and key_port. Routing compares the dest path
   * with this runtime's own path: equal → deliver locally; dest is a strict
   * descendant → forward down its next element; otherwise → forward up (the
   * LCA relay). The payload stays opaque (§7.2). */
  var OP_PORT_MSG = 1, OP_PORT_XFER = 2, PORT_HDR_MIN = 8;

  function toU8(b) { return b instanceof Uint8Array ? b : new Uint8Array(b); }
  function rdU16(u8, off) { return u8[off] | (u8[off + 1] << 8); }
  function rdU32(u8, off) {
    return (u8[off] | (u8[off + 1] << 8) | (u8[off + 2] << 16) |
            (u8[off + 3] << 24)) >>> 0;
  }
  function wrU16(u8, off, v) { u8[off] = v & 0xff; u8[off + 1] = (v >>> 8) & 0xff; }
  function wrU32(u8, off, v) {
    u8[off] = v & 0xff; u8[off + 1] = (v >>> 8) & 0xff;
    u8[off + 2] = (v >>> 16) & 0xff; u8[off + 3] = (v >>> 24) & 0xff;
  }
  /* 编码：4 字节序言 + u16 path 链 + u32 key_port，后接不透明 SC 字节。 */
  function portFrame(op, destPath, keyPath, keyPort, body) {
    var b = toU8(body);
    var dp = toPath(destPath), kp = toPath(keyPath);
    var hdr = PORT_HDR_MIN + 2 * (dp.length + kp.length);
    var u8 = new Uint8Array(hdr + b.length);
    u8[0] = op & 0xff; u8[1] = dp.length; u8[2] = kp.length; u8[3] = 0;
    var off = 4, i;
    for (i = 0; i < dp.length; i++) { wrU16(u8, off, dp[i]); off += 2; }
    for (i = 0; i < kp.length; i++) { wrU16(u8, off, kp[i]); off += 2; }
    wrU32(u8, off, keyPort >>> 0); off += 4;
    u8.set(b, off);
    return u8;
  }
  /* 解析帧头 → {op, dest, key, keyPort, hdr}；非法/过短返回 null。 */
  function portFrameHeader(bytes) {
    var u8;
    try { u8 = toU8(bytes); } catch (e) { return null; }
    if (u8.length < PORT_HDR_MIN) return null;
    var dl = u8[1], kl = u8[2];
    var hdr = PORT_HDR_MIN + 2 * (dl + kl);
    if (u8.length < hdr) return null;
    var off = 4, dest = [], key = [], i;
    for (i = 0; i < dl; i++) { dest.push(rdU16(u8, off)); off += 2; }
    for (i = 0; i < kl; i++) { key.push(rdU16(u8, off)); off += 2; }
    var keyPort = rdU32(u8, off); off += 4;
    return { op: u8[0], dest: dest, key: key, keyPort: keyPort, hdr: hdr };
  }
  /* 逐跳转发：dest 是本 runtime 的严格后代 → 下投下一元素；否则上转父。
   * 根 runtime 无父，非后代的 dest 丢弃（不可达）。 */
  function forwardFrame(bytes, destPath) {
    if (pathIsPrefix(ownerSelf, destPath)) {
      var next = destPath[ownerSelf.length];
      if (globalThis.__qz_worker_post__)
        globalThis.__qz_worker_post__(next, bytes, 1);
      return true;
    }
    if (inWorker) { pal.postMessage(bytes, 1); return true; }
    return false;
  }


  /* op=2（port 转移列表）帧：投给直连对端通道，头里的 dest/key 不参与路由
   * （接收方按到达的通道确定发送者），全空。worker.js / boot shim 构造转移帧
   * 时用它，避免在别处重复头布局。 */
  function portXferFrame(body) { return portFrame(OP_PORT_XFER, [], [], 0, body); }
  /* 取 PORT_TRANSFER 帧的路由头之后的不透明 SC 字节（op=2 解包用）。 */
  function portFrameBody(bytes) {
    var h = portFrameHeader(bytes);
    return toU8(bytes).subarray(h ? h.hdr : PORT_HDR_MIN);
  }
  /* ================================================================
   * MessageEvent
   * ================================================================ */
  class MessageEvent extends Event {
    constructor(type, options) {
      super(type, options);
      this._data = options?.data ?? null;
      this._origin = options?.origin ?? '';
      this._lastEventId = options?.lastEventId ?? '';
      this._source = options?.source ?? null;
      this._ports = options?.ports ?? [];
    }

    get data() { return this._data; }
    get origin() { return this._origin; }
    get lastEventId() { return this._lastEventId; }
    get source() { return this._source; }
    get ports() { return this._ports; }
  }

  /* ================================================================
   * MessagePort
   * ================================================================ */
  class MessagePort extends EventTarget {
    constructor(id, peerId, owner) {
      super();
      this._id = id;            /* owner 本地分配（pal.portCreate） */
      this._peerId = peerId;    /* 纠缠对端的本地 id（与本 port 同 owner） */
      this._owner = owner === undefined ? ownerSelf : owner;  /* 出生端点；转移不变 */
      this._entangledPort = null;   /* 同 runtime 直接引用 */
      this._peerThread = 'local';   /* 对端当前所在：'local' | 'parent' | workerId(>0) */
      this._detached = false;   /* 已转移/关闭 */
      this._peerGone = false;   /* 对端端点已死亡（§8.2 失败语义） */
      this._started = false;
      this._messageQueue = [];
      this._onmessage = null;
      this._onmessageerror = null;
    }

    get onmessage() { return this._onmessage; }
    set onmessage(fn) {
      if (this._onmessage) {
        this.removeEventListener('message', this._onmessage);
      }
      this._onmessage = fn;
      if (fn) {
        this.addEventListener('message', fn);
      }
      this._start();
    }

    get onmessageerror() { return this._onmessageerror; }
    set onmessageerror(fn) {
      if (this._onmessageerror) {
        this.removeEventListener('messageerror', this._onmessageerror);
      }
      this._onmessageerror = fn;
      if (fn) {
        this.addEventListener('messageerror', fn);
      }
    }

    /* 跨 runtime 发送：SC 消息字节 → PORT_TRANSFER 帧（kind=1）→ 对端端点通道。
     * dest = 对端当前所在端点（§8.2 path 链）；key = (owner path, peerId) 目标
     * port 身份。逐跳转发由 forwardFrame 决定上转/下投（LCA 中继）。对端端点
     * 已死 → 静默丢弃（与 terminate 后 postMessage 静默的规范语义一致）。 */
    _sendRemote(payloadBytes) {
      if (this._peerGone) return;
      var dest = toPath(this._peerThread);
      if (pathEq(dest, ownerSelf)) {
        /* 对端就在本 runtime：直接投递本表内 port（不绕一圈通道）。 */
        var lp = portRegistry.get(portKey(this._owner, this._peerId));
        if (lp) lp._deliverRemote(toU8(payloadBytes));
        return;
      }
      var frame = portFrame(OP_PORT_MSG, dest, this._owner, this._peerId,
                            payloadBytes);
      /* 目标在本 runtime 下游则下投，否则上行（forwardFrame 判方向）。 */
      forwardFrame(frame, dest);
    }

    postMessage(message, transfer) {
      if (this._detached) {
        throw new Error('MessagePort: port is detached');
      }
      if (this._peerThread === 'local') {
        if (!this._entangledPort) return;
        // Structured clone the message data. Clone failure must rethrow to
        // the postMessage caller (WHATWG HTML §message-port-post-steps:
        // "failed to serialize" → throw a "DataCloneError" DOMException).
        // messageerror is only for receive-side deserialization failures.
        var data = globalThis.structuredClone(
          message, transfer ? { transfer: transfer } : undefined);

        var event = new MessageEvent('message', { data: data, ports: [] });

        if (this._entangledPort._started) {
          this._entangledPort.dispatchEvent(event);
        } else {
          this._entangledPort._messageQueue.push(event);
        }
      } else {
        /* 跨线程：序列化消息（含 transfer）→ 包装 → 发送 */
        var bytes = __qz_serialize__(message, transfer);
        this._sendRemote(bytes);
      }
    }

    /* 入站：接收跨线程 port 消息（payload 是序列化字节） */
    _deliverRemote(payloadBytes) {
      var v;
      try { v = __qz_deserialize__(payloadBytes); }
      catch (err) {
        var errEvent = new MessageEvent('messageerror', { data: err });
        this.dispatchEvent(errEvent);
        return;
      }
      var event = new MessageEvent('message', { data: v, ports: [] });
      if (this._started) {
        this.dispatchEvent(event);
      } else {
        this._messageQueue.push(event);
      }
    }

    start() {
      this._start();
    }

    _start() {
      if (this._started) return;
      this._started = true;

      // Flush queued messages
      for (var i = 0; i < this._messageQueue.length; i++) {
        this.dispatchEvent(this._messageQueue[i]);
      }
      this._messageQueue = [];
    }

    close() {
      this._detached = true;
      this._entangledPort = null;
      this._started = false;
      this._messageQueue = [];
      portRegistry.delete(portKey(this._owner, this._id));   /* 摘表：路由不再命中 */
    }
  }

  /* ================================================================
   * MessageChannel
   * ================================================================ */
  class MessageChannel {
    constructor() {
      var ids = pal.portCreate();
      this._port1 = new MessagePort(ids.id1, ids.id2);
      this._port2 = new MessagePort(ids.id2, ids.id1);
      this._port1._entangledPort = this._port2;
      this._port2._entangledPort = this._port1;
      registerPort(this._port1);
      registerPort(this._port2);
    }

    get port1() { return this._port1; }
    get port2() { return this._port2; }
  }
  globalThis.__qz_port_xfer_frame__ = portXferFrame;
  globalThis.__qz_port_frame_body__ = portFrameBody;
  globalThis.MessageChannel = MessageChannel;
  globalThis.MessagePort = MessagePort;
  globalThis.MessageEvent = MessageEvent;

  /* 供 worker.js / boot shim 查询本地 port（transfer 时更新对端端点） */
  globalThis.__qz_lookup_port__ = lookupPort;

  /* ================================================================
   * Cross-process routing helpers (used by worker.js / boot shim dispatch)
   * ================================================================ */
  /* PORT_TRANSFER 帧的 op（0 = 不是 port 帧）。接收侧先看 kind=1 + op 再分流：
   * op=1 走端点路由，op=2 是 port 转移列表。 */
  globalThis.__qz_port_frame_op__ = function (bytes) {
    var u8;
    try { u8 = toU8(bytes); } catch (e) { return 0; }
    if (u8.length < PORT_HDR_MIN) return 0;
    if (u8[0] === OP_PORT_XFER) return OP_PORT_XFER;   /* op 是字节 0，非 u32 */
    var h = portFrameHeader(u8);
    return h ? h.op : 0;
  };

  /* op=1：按帧头 dest path 投递或逐跳转发（§8.2）——
   *   dest == 本 runtime path → 本地投递给 (key path, key_port) 的 port；该
   *     port 已被再转移走 → 按路由表改指转发（LCA 中继）；
   *   dest 是本 path 的严格后代 → 下投下一元素；
   *   否则 → 上转父（父继续按同一规则判；LCA 处方向翻转）。
   * 返回 true 表示已消费。目标端点已死/无此 port → 静默丢弃（不抛）。 */
  globalThis.__qz_route_port_message__ = function (bytes) {
    var h = portFrameHeader(bytes);
    if (!h) return false;
    var u8 = toU8(bytes);
    if (pathEq(h.dest, ownerSelf)) {
      var key = portKey(h.key, h.keyPort);
      var port = portRegistry.get(key);
      if (port && !port._detached) {
        port._deliverRemote(u8.subarray(h.hdr));
        return true;
      }
      /* §8.2 改指转发：本 runtime 曾有该 port（现已被再转移走 / 已摘表），按
       * 路由表把 dest 改指到新端点，重封头（payload 字节原样）后继续逐跳。 */
      var redir = redirects.get(key);
      if (redir) {
        var rf = portFrame(h.op, redir, h.key, h.keyPort, u8.subarray(h.hdr));
        forwardFrame(rf, redir);
      }
      return true;   /* 目标端点已死/无此 port → 静默丢弃（不抛） */
    }
    return forwardFrame(u8, h.dest);
  };

  /* 端点死亡（fd EOF / terminate）→ 清路由表（§8.2 失败语义）：
   *   - 归属该端点的代理 port：本体已随进程消失 → 摘表并置 peerGone；
   *   - 对端在该端点的本地 port：派发 'error' 事件（对端不可达），后续
   *     postMessage 静默丢弃。幂等（重复死亡通知无副作用）。
   * owner 为 §8.2 path 链（数组；数字按单元素 path 归一）。 */
  globalThis.__qz_endpoint_dead__ = function (owner) {
    var op = toPath(owner);
    /* 该端点死亡 → 以它为落点的路由表项失效（改指目标不可达）。 */
    var stale = [];
    redirects.forEach(function (d, k) {
      if (d.length >= op.length && pathEq(d.slice(0, op.length), op))
        stale.push(k);
    });
    for (var si = 0; si < stale.length; si++) redirects.delete(stale[si]);
    var dead = [];
    portRegistry.forEach(function (p, k) {
      if (pathEq(p._owner, op)) dead.push([k, p, 'own']);
      else if (Array.isArray(p._peerThread) && pathEq(p._peerThread, op))
        dead.push([k, p, 'peer']);
    });
    for (var i = 0; i < dead.length; i++) {
      var k = dead[i][0], p = dead[i][1], why = dead[i][2];
      /* 一律只置 _peerGone（postMessage 静默丢弃），**不**置 _detached——后者
       * 会让 postMessage 抛错，而 terminate 后 postMessage 的规范语义是静默。 */
      p._peerGone = true;
      if (why === 'own') {
        p._entangledPort = null;
        portRegistry.delete(k);   /* 摘表：路由不再命中该端点的 port */
      } else {
        var ev;
        try {
          ev = new Event('error');
          ev.message = 'MessagePort: peer endpoint ' + owner + ' is gone';
        } catch (e) { ev = { type: 'error' }; }
        try { p.dispatchEvent(ev); } catch (e2) { /* 监听器异常不影响清理 */ }
      }
    }
  };

  /* 反序列化 MessagePort 引用时由 structured-clone 调用：
   * info = {id, peerId, owner, peerThread} → 返回一个新的可用 MessagePort
   * 代理（转移后原对象已 detached，新引用总是新对象；同一 (owner,id) 的本地
   * 表项被覆盖为新代理）。
   *
   * 纠缠关系重建：若对端（lookupPort(info.peerId, info.owner)）已在本地——
   * 多跳转移把 port 送回它的出生 runtime 时（父→worker→父）——重建同 runtime
   * 纠缠（双方 _peerThread='local' + _entangledPort 互指），此后两 port 直接
   * 本地分发；否则对端在别的端点，按 info.peerThread 走远程路由。 */
  globalThis.__qz_port_from_ref__ = function (info) {
    if (!info || info.id === undefined || info.id === null) {
      throw new DOMException('invalid MessagePort reference', 'DataCloneError');
    }
    var owner = info.owner === undefined ? ownerSelf : toPath(info.owner);
    var p = new MessagePort(info.id, info.peerId, owner);
    p._detached = false;
    var peer = lookupPort(info.peerId, owner);
    if (peer && peer !== p) {
      p._peerThread = 'local';
      p._entangledPort = peer;
      peer._peerThread = 'local';
      peer._entangledPort = p;
    } else {
      /* 对端在别的端点：§8.2 path 链。'local'（对端本应在本 runtime，但表里
       * 没找到）退化为自身 path；兼容旧 wire 的 'parent'/数字标签。 */
      var pt = info.peerThread;
      if (pt === undefined || pt === null || pt === 'local')
        p._peerThread = ownerSelf.slice();
      else if (pt === 'parent')
        p._peerThread = parentPath();
      else
        p._peerThread = toPath(pt);
    }
    registerPort(p);
    return p;
  };
}
