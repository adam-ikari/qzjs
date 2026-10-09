/**
 * qzjs Polyfill - localStorage / sessionStorage (Web Storage, Storage interface)
 *
 * 双形态（M-P4 §10.2 单所有者代理）：
 *
 *   A. 所有者（主RT runtime，pal.workerId 不存在）——同进程语义不变：
 *      - localStorage 持久化文件：pal.localStoragePath() — env
 *        QZ_LOCALSTORAGE_FILE, else ~/.qzjs/localstorage.json (HOME unset →
 *        .qzjs-localstorage.json in cwd)；sessionStorage 为纯内存区，生命周期
 *        = 本 runtime 会话（qzjs 无页面），不落盘、不触碰 localStorage 文件
 *      - localStorage loaded synchronously at setup (pal.fsReadSync; missing/
 *        corrupt → empty)；sessionStorage 从空开始
 *      - every setItem/removeItem/clear writes back atomically (pal.fsWriteSync:
 *        temp file + rename) —— localStorage 仅；sessionStorage 不持久化
 *      - quota: 5 MiB (key + value UTF-16 code units) → DOMException
 *        'QuotaExceededError'（两域同 QUOTA）
 *      - 额外注册 __qz_storage_dispatch__：处理 PROCESS worker 经
 *        kind=STORAGE 信封路由来的 store 操作（payload = structured clone
 *        {op,key,value?,storageDomain}），按 storageDomain 路由到
 *        localStorage/sessionStorage 独立区执行后经 __qz_worker_post__
 *        (source, replyBytes, kind=4) 回发结果。
 *
 *   B. PROCESS worker（pal.workerId 存在 且 pal.workerBackend()==='process'）
 *      ——同步代理：每个 getItem/setItem/removeItem/clear/key/length 经
 *      pal.storageSync（C 层同步 RPC：发 kind=STORAGE 信封 → 阻塞等待主RT
 *      回复，期间不派发任何 JS）路由到所有者执行，API 语义（同步、异常
 *      形状）与同进程完全一致。所有者死亡 → fd EOF → storageSync 抛错 →
 *      worker 按 §9.4 连锁自杀。
 *      两域同走此代理：storageDomain 区分路由目标（'localStorage' /
 *      'sessionStorage'）。
 *
 * THREAD worker（pal.workerId 存在 且 backend==='thread'）不挂 localStorage
 * （Web Storage 保守默认：worker 无 DOM 场景；THREAD 基线零改动）。
 *
 * 与 qzjs.storage（async in-memory extension API）共存。
 */

/* 组装 Storage 接口实例（方法/访问器不可枚举）并挂到 globalThis[name]
 * （缺省 'localStorage'；'sessionStorage' 挂 sessionStorage 全局）。 */
function buildStorageObject(impl, name) {
  var storage = {};
  Object.defineProperties(storage, {
    length: { get: impl.length, enumerable: false, configurable: true },
    key: { value: impl.key, writable: true, enumerable: false, configurable: true },
    getItem: { value: impl.getItem, writable: true, enumerable: false, configurable: true },
    setItem: { value: impl.setItem, writable: true, enumerable: false, configurable: true },
    removeItem: { value: impl.removeItem, writable: true, enumerable: false, configurable: true },
    clear: { value: impl.clear, writable: true, enumerable: false, configurable: true },
  });
  mountGlobal(name || 'localStorage', storage);
  return storage;
}

function mountGlobal(name, storage) {
  try {
    Object.defineProperty(globalThis, name, {
      value: storage, writable: false, enumerable: true, configurable: true,
    });
  } catch (e) {
    /* 已存在且不可重新定义：保持现状（与旧实现一致） */
  }
}

export function setupLocalStorage(pal) {
  var isWorker = typeof pal.workerId === 'function';
  var backend;
  try { backend = pal.workerBackend(); } catch (e) { backend = 'thread'; }
  /* THREAD worker：不挂（基线）。接住 localStoragePath/workerBackend 抛错的
   * 非标准环境（如 service worker 线程）与现状一致：静默跳过。 */
  if (isWorker && backend !== 'process') return;
  var QUOTA = 5 * 1024 * 1024;   /* Web Storage default, in code units */
  if (typeof globalThis.localStorage !== 'undefined') return;

  /* ================= PROCESS worker：同步代理（M-P4 §10.2） =================
   * 每个操作序列化为 {op,key,value?,storageDomain}（structured clone 字节，
   * 复用现有序列化，不给 storage 另设 fb 表）→ pal.storageSync 同步往返主RT
   * 所有者 → 结果/异常按原语义返回。storageDomain 缺省 'localStorage'
   * （§4.1 payload 契约字段，兼容单域 owner）；sessionStorage 请求带
   * 'sessionStorage'，owner 按域路由到独立区。 */
  if (isWorker) {
    function request(op, key, value, storageDomain) {
      var req = __qz_serialize__({ op: op, key: key, value: value,
                                     storageDomain: storageDomain || 'localStorage' });
      var rep = pal.storageSync(req);   /* Uint8Array；所有者死亡 → 抛 InternalError */
      var r = __qz_deserialize__(rep);
      if (r && r.e) {
        var name = String(r.e.name || 'Error');
        var msg = String(r.e.message != null ? r.e.message : r.e);
        var ex;
        try { ex = new DOMException(msg, name); }
        catch (err) { ex = new Error(msg); ex.name = name; }
        throw ex;
      }
      return r ? r.v : undefined;
    }
    /* 本地预检（同步语义不变）：单次写入 key+value 即超配额 → 所有者必拒，
     * 直接抛 QuotaExceededError，避免超大 payload 跨进程 RPC 白传。
     * 按 code units 计（与所有者 total 口径一致）；不按序列化字节预拒——
     * 序列化字节（UTF-8）≠ code units，按字节会误拒所有者可接受的写入
     * （多字节字符值），破坏同步 API 语义一致性。两域共用（QUOTA 相同）。 */
    function quotaExceeded(key) {
      var msg = "Failed to execute 'setItem' on 'Storage': setting the value of '" +
                key + "' exceeded the quota.";
      var ex;
      try { ex = new DOMException(msg, 'QuotaExceededError'); }
      catch (err) { ex = new Error(msg); ex.name = 'QuotaExceededError'; }
      throw ex;
    }
    /* 域代理实现工厂：localStorage / sessionStorage 各绑一个 request domain。 */
    function proxyImpl(domain) {
      return {
        length: function () { return request('length', undefined, undefined, domain); },
        key: function (i) { return request('key', i >>> 0, undefined, domain); },
        getItem: function (k) { return request('get', String(k), undefined, domain); },
        setItem: function (k, v) {
          k = String(k);
          v = String(v);
          if (k.length + v.length > QUOTA) quotaExceeded(k);
          request('set', k, v, domain);
        },
        removeItem: function (k) { request('remove', String(k), undefined, domain); },
        clear: function () { request('clear', undefined, undefined, domain); },
      };
    }
    buildStorageObject(proxyImpl('localStorage'), 'localStorage');
    buildStorageObject(proxyImpl('sessionStorage'), 'sessionStorage');
    return;
  }

  /* ================= 所有者（主RT）：Storage 实现（双域） ================= */
  var path;
  try {
    path = pal.localStoragePath();
  } catch (e) {
    return;
  }

  /* createArea(persistPath)：构造独立 Storage 区——map/keys/total 每区闭包，
   * 域间完全隔离。persistPath 字符串 → 文件持久化（localStorage，原子写回，
   * 行为不变）；persistPath null → 纯内存，生命周期 = 本 runtime 会话
   * （sessionStorage：qzjs 无页面，会话即主RT 进程生命周期，不落盘、不触碰
   * localStorage 持久文件）。 */
  function createArea(persistPath) {
    /* Storage area. map: null prototype so keys like '__proto__' can't pollute;
     * keys: insertion order (spec key(n) order; updating an existing key does
     * not reorder); total: sum of key.length + value.length (quota accounting). */
    var map = Object.create(null);
    var keys = [];
    var total = 0;

  function has(key) {
    return Object.prototype.hasOwnProperty.call(map, key);
  }

  function load() {
    if (persistPath === null) return;   /* sessionStorage：内存区无载入 */
    var raw, obj, ks, i;
    try { raw = pal.fsReadSync(persistPath); } catch (e) { return; }  /* missing → empty */
    try { obj = JSON.parse(raw); } catch (e) { return; }       /* corrupt → empty */
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    ks = Object.keys(obj);
    for (i = 0; i < ks.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(obj, ks[i])) continue;
      map[ks[i]] = String(obj[ks[i]]);
      keys.push(ks[i]);
      total += ks[i].length + map[ks[i]].length;
    }
  }

  function persist() {
    if (persistPath === null) return;   /* sessionStorage：不落盘 */
    pal.fsWriteSync(persistPath, JSON.stringify(map));
  }

  function getItem(key) {
    key = String(key);
    return has(key) ? map[key] : null;
  }

  function setItem(key, value) {
    key = String(key);
    value = String(value);
    var existed = has(key);
    var oldValue = existed ? map[key] : null;
    var add = existed ? (value.length - oldValue.length) : (key.length + value.length);
    if (total + add > QUOTA) {
      throw new DOMException(
        "Failed to execute 'setItem' on 'Storage': setting the value of '" +
        key + "' exceeded the quota.",
        'QuotaExceededError');
    }
    if (!existed) keys.push(key);
    map[key] = value;
    total += add;
    try {
      persist();
    } catch (e) {
      /* 落盘失败：回滚内存态，保持与持久化文件一致 */
      if (existed) {
        map[key] = oldValue;
      } else {
        delete map[key];
        keys.pop();
      }
      total -= add;
      throw e;
    }
  }

  function removeItem(key) {
    key = String(key);
    if (!has(key)) return;
    var oldValue = map[key];
    var idx = keys.indexOf(key);
    if (idx >= 0) keys.splice(idx, 1);
    total -= key.length + oldValue.length;
    delete map[key];
    try {
      persist();
    } catch (e) {
      if (idx >= 0) keys.splice(idx, 0, key);
      map[key] = oldValue;
      total += key.length + oldValue.length;
      throw e;
    }
  }

  function clear() {
    var oldMap = map, oldKeys = keys, oldTotal = total;
    map = Object.create(null);
    keys = [];
    total = 0;
    try {
      persist();
    } catch (e) {
      map = oldMap;
      keys = oldKeys;
      total = oldTotal;
      throw e;
    }
  }

  function key(index) {
    index = index >>> 0;   /* WebIDL unsigned long */
    return index < keys.length ? keys[index] : null;
  }

  load();
  return {
    getItem: getItem,
    setItem: setItem,
    removeItem: removeItem,
    clear: clear,
    key: key,
    length: function () { return keys.length; },
  };
}

var lsArea = createArea(path);       /* localStorage：文件持久化（行为不变） */
var ssArea = createArea(null);       /* sessionStorage：纯内存（runtime 会话） */

  /* M-P4 §10.2（所有者侧）：处理 PROCESS worker 的 storage 请求帧。C 层只
   * 透传信封（qz_storage_dispatch），op 编排在这里——按 storageDomain 路由
   * 到对应区（'sessionStorage' → ssArea，其余 → lsArea），对区 map/persist
   * 执行，异常（配额/落盘）原样封装成 {e:{name,message}} 回发，代理侧据此
   * 重建 DOMException，同步 API 语义跨进程保持一致。 */
  globalThis.__qz_storage_dispatch__ = function (bytes, source, corr) {
    var o;
    try { o = __qz_deserialize__(bytes); } catch (err) { return; }
    if (!o || typeof o !== 'object') return;
    var area = (o.storageDomain === 'sessionStorage') ? ssArea : lsArea;
    var reply;
    try {
      switch (o.op) {
        case 'get':    reply = { v: area.getItem(o.key) }; break;
        case 'set':    area.setItem(o.key, o.value); reply = { v: null }; break;
        case 'remove': area.removeItem(o.key); reply = { v: null }; break;
        case 'clear':  area.clear(); reply = { v: null }; break;
        case 'key':    reply = { v: area.key(o.key) }; break;
        case 'length': reply = { v: area.length() }; break;
        default:       reply = { e: { name: 'Error',
                                      message: 'unknown storage op: ' + o.op } };
      }
    } catch (err) {
      reply = { e: { name: (err && err.name) || 'Error',
                     message: (err && err.message != null)
                                ? String(err.message) : String(err) } };
    }
    var rep;
    try { rep = __qz_serialize__(reply); } catch (err) { return; }
    if (typeof globalThis.__qz_worker_post__ === 'function')
      globalThis.__qz_worker_post__(source, rep, 4, corr);  /* kind=STORAGE */
  };

  /* Storage 接口实例：方法/访问器均不可枚举（Object.keys(x) 为空）。 */
  buildStorageObject(lsArea, 'localStorage');
  buildStorageObject(ssArea, 'sessionStorage');
}
