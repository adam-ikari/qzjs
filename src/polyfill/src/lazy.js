/**
 * qzjs polyfill: lazy installation primitives
 *
 * 惰性注册机制（设计文档 §3.1/§3.2）：installLazy 在 globalThis 上定义
 * configurable+enumerable 的 getter。首次访问时单元 ensure 先 `delete` 该属性
 * （清掉 accessor 位，让原 setup 内部的 `globalThis.x = v` 在严格模式下正常落
 * 数据属性），再跑原有 setupXxx 原样执行；此后属性稳定为数据属性，descriptor
 * 与 eager 安装结果逐位一致。JS 消费者无法观察到 lazy 与 eager 的差异。
 *
 * 关键设计点：
 *   - getter 不负责 delete 自身——由单元 ensure 统一清整个单元的 accessor 面。
 *     否则多名单元（fetch/streams/caches…）里"第二名的二次访问"会把 setup
 *     产出的数据属性误删（见 §3.1 单位多面）。
 *   - setter 语义对齐 eager 赋值：strict 模式下对"无 setter accessor"赋值会抛
 *     TypeError，eager 的 data property 赋值则不抛。setter 先 ensure() 把单元
 *     物化为数据属性，再落值——monkey-patch（`globalThis.fetch = custom`）行为
 *     与 eager 一致；对 non-writable 属性（localStorage）赋值照样抛 TypeError，
 *     也与 eager 一致。
 *   - ensure 的 done 标志在 setup 前置位：级联 setup 中途重入同单元 getter 时
 *     直接短路，不二次 setup、不死循环。
 *
 * 单元（lazyUnit）：一组全局名 + 一组宿主对象子属性（[[obj, prop], …]）共享
 * 同一 ensure 与 done 标志。首次触发先把整个单元的 accessor 面清掉（含未触发
 * 的兄弟名），再跑 setup，保证 setup 内对兄弟名的赋值直接落数据属性。
 */

/* lazyUnit 的 ensure：首次调用清整单元 accessor 面并跑 setup；重复调用短路
 * （done 前置位：级联 setup 中途重入同单元 getter 直接短路，不二次 setup、
 * 不死循环）。setup 抛异常时恢复本单元全部 accessor 面并复位 done——失败
 * 可见（异常向触发方传播）且可重试，对齐 eager 的"启动期失败可诊断"，不
 * 留下静默半物化（面已删、done 恒真、后续访问恒 undefined）。 */

/* 顶层全局惰性 getter。 */
export function installLazy(name, ensure) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    get() {
      ensure();
      return globalThis[name];
    },
    set(v) {
      ensure();
      globalThis[name] = v;
    },
  });
}

/* 宿主对象子属性惰性 getter（qzjs.fs / navigator.serviceWorker / crypto.subtle）。 */
export function installLazyProp(obj, prop, ensure) {
  Object.defineProperty(obj, prop, {
    configurable: true,
    enumerable: true,
    get() {
      ensure();
      return obj[prop];
    },
    set(v) {
      ensure();
      obj[prop] = v;
    },
  });
}

/* 单元注册器：globalNames 顶层全局 + props [[obj, prop], ...] 子属性共享 ensure。
 * 首次触发：清掉整单元 accessor 面 → setup 原样执行。返回 ensure 供其他单元
 * 级联（如 fetch→streams/blob、worker→message-channel）。
 * 不变式：setup 必须自含——内部经闭包引用自身产物（本地 class/函数先定义、
 * 尾部统一赋 globalThis），不得在 setup 中途读本单元的全局名/子属性（此时
 * 面已删、done 已置位，读到 undefined）。既有 17 个 setup 均满足此形态。 */
export function lazyUnit(globalNames, props, setup) {
  var done = false;
  /* install：为整单元（globalNames + props）注册 accessor 面。setup 中途
   * 部分物化的数据属性一律 configurable:true（各 setup 的赋值/defineProperty
   * 保持可配置），可被覆盖回 accessor；异常恢复即依赖此点。 */
  function install() {
    for (var k = 0; k < globalNames.length; k++) installLazy(globalNames[k], ensure);
    for (var m = 0; m < props.length; m++) installLazyProp(props[m][0], props[m][1], ensure);
  }
  function ensure() {
    if (done) return;
    done = true;
    for (var i = 0; i < globalNames.length; i++) delete globalThis[globalNames[i]];
    for (var j = 0; j < props.length; j++) delete props[j][0][props[j][1]];
    try {
      setup();
    } catch (e) {
      install();
      done = false;
      throw e;
    }
  }
  install();
  return ensure;
}
