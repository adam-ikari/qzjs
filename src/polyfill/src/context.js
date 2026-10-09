/**
 * qzjs Multi-Context + Soft Suspend/Resume (Task 5)
 *
 * 宿主只见主 context；子 context 由 qzContext.spawn 建立。挂起 = 把目标 ctx
 * 的"用户全局"收集成结构化克隆字节写盘（经 pal.contextSuspend），然后 C 销毁
 * 该 JSContext；恢复 = C 在原槽位重建 JSContext + 重注入 polyfill + 重 eval
 * init 脚本，再经 pal.contextResume 触发 __qz_ctx_restore__ 把状态写回。
 *
 * 关键：只捕获"快照之后新增的"枚举全局键（_pristine 在 setup 全部完成后、
 * 基础设施挂载前拍下），因此引擎内建与 polyfill 注入的 API 天然被排除——它们
 * 在恢复时由引擎/重注入重新建立。非可克隆属性（函数等）记入 skipped 跳过。
 *
 * G4 设计限制（见 suspend-restore-design.md §5.1）：Object.keys 只捕获可枚举
 * 字符串键。非枚举属性（defineProperty enumerable:false）、Symbol 键属性、
 * getter 抛异常的属性不被捕获——恢复后丢失。用户应只用可枚举字符串键全局。
 */

export function setupContext(pal) {
  /* 快照：所有 polyfill setup 完成后、本模块挂载前的枚举全局键集合 */
  var _pristine = Object.create(null);
  var names = Object.keys(globalThis);
  for (var i = 0; i < names.length; i++) _pristine[names[i]] = 1;

  /* 本模块自己的基础设施（快照之后挂载，且挂起时也要排除） */
  var _infra = {
    __qz_ctx_capture__: 1,
    __qz_ctx_restore__: 1,
    qzContext: 1
  };

  globalThis.__qz_ctx_capture__ = function() {
    var props = Object.create(null);
    var skipped = [];
    var keys = Object.keys(globalThis);
    for (var i = 0; i < keys.length; i++) {
      var n = keys[i];
      if (_pristine[n] || _infra[n]) continue;
      var v;
      try { v = globalThis[n]; } catch (e) { continue; }
      try {
        /* F4 审计：props 无原型 + defineProperty 落 own 属性，防 '__proto__' 键
         * 触发原型链 setter。 */
        Object.defineProperty(props, n, { value: __qz_serialize__(v),
          writable: true, enumerable: true, configurable: true });
      } catch (e) {
        skipped.push(n);
      }
    }
    return __qz_serialize__({ props: props, skipped: skipped });
  };

  globalThis.__qz_ctx_restore__ = function(bytes) {
    var rec = __qz_deserialize__(bytes);
    var p = (rec && rec.props) || {};
    var keys = Object.keys(p);
    for (var i = 0; i < keys.length; i++) {
      var n = keys[i];
      if (_infra[n]) continue;
      var v;
      try { v = __qz_deserialize__(p[n]); } catch (e) { continue; }
      try {
        /* F4 审计：defineProperty 落 own 数据属性，防 '__proto__'/'constructor'
         * 键改原型/污染全局。 */
        Object.defineProperty(globalThis, n, { value: v,
          writable: true, enumerable: true, configurable: true });
      } catch (e) {}
    }
    return (rec && rec.skipped) || [];
  };

  globalThis.qzContext = {
    spawn: function(s) { return pal.contextSpawn(String(s)); },
    suspend: function(id, p) { return pal.contextSuspend(Number(id), String(p)); },
    resume: function(id, s, p) { return pal.contextResume(Number(id), String(s), String(p)); },
    destroy: function(id) { return pal.contextDestroy(Number(id)); }
  };
}
