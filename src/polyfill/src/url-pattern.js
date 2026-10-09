/**
 * qzjs polyfill: URLPattern
 *
 * TC55/ECMA-429 requires URLPattern for URL matching.
 *
 * 委托 urlpattern-polyfill（https://github.com/kenchris/urlpattern-polyfill，
 * MIT，零依赖），官方 WHATWG URLPattern 实现。
 *
 * 入口走子路径 'urlpattern-polyfill/urlpattern'（dist/urlpattern.js，纯导出）：
 * 包根 index.js 会把 URLPattern 直接挂到 globalThis，破坏 qzjs 的 lazy 语义，
 * 故不走根入口。
 *
 * 运行时依赖全局 URL/URLSearchParams（canonicalizeHostname 等以
 * `new URL('https://example.com')` 做 base 解析）——qzjs 中 URL 是 lazy getter，
 * 首次访问自动加载，无需额外处理。
 *
 * 行为差异（自研 regex 子集 → 规范实现）：
 *   - 自研实现 ':name?'/'+/*' modifier 支持不完整（如可选段的空段匹配）；官方
 *     实现含完整 modifier 语义，gtest 四用例（:id、:x?、:x+、:x*）全兼容
 *   - 官方解析更严格：非法 pattern 抛 TypeError（自研对部分非法串静默容忍）
 *   - exec() 返回结构同为 {input, groups, protocol...}，named 组一致
 *
 * 体积（minified）：3.1KB → 21.2KB（+18.2KB）。
 */
import { URLPattern } from 'urlpattern-polyfill/urlpattern';

function QZURLPattern(pattern, baseURL) {
  /* 相对字符串 pattern（以 '/' 开头）无 base：官方实现抛 TypeError。qzjs 自研
   * 语义为相对 pattern 匹配任意 host → 转对象形式（组件缺省 = 通配），语义一致。 */
  if (typeof pattern === 'string' && baseURL === undefined &&
      pattern.length > 0 && pattern[0] === '/') {
    return new URLPattern({ pathname: pattern });
  }
  return new URLPattern(pattern, baseURL);
}

export function setupURLPattern() {
  globalThis.URLPattern = QZURLPattern;
}