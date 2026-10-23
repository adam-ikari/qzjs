---
id: url-idl-string-coercion
title: "URL 构造器与 href= 先按 WebIDL 转 USVString"
category: decision
status: active
tags: [url, polyfill, webidl, browser-parity]
created: "2026-10-18T02:48:24"
updated: "2026-10-18T02:48:24"
---

<!-- compiled_truth -->
## URL 构造器与 `href=` 先按 WebIDL 转 USVString

`new URL(url, base)` 的两个参数都经 `USVString` 转换(WebIDL)。所以
`new URL(window.location)` 合法:取 `location.toString()`(即 href);
数字、带 `toString` 的对象同理。不是「必须传字符串」。

qzjs polyfill 的 `src/polyfill/src/url.js` 原先在 `_parse` 里对非字符串直接抛
`TypeError('URL must be a string')`。真实站点暴露:docs.python.org 的
`_static/sphinx_highlight.js` 在 `highlightSearchWords` 写
`new URL(window.location)`,每页一条 warn 且该函数后续整段不跑。

修法:`_parse` 开头 `url = String(url).trim()`;`set href` 也走这里。
base 由构造器的 `new URL(base)` 递归转换。**不是给某个调用点打补丁** ——
转换是构造器的契约。

## 验证

- `PolyfillTest.UrlCoercesNonStringInput`:带 `toString` 的对象 →
  pathname/searchParams 正确;退回旧 `typeof` 检查则测试失败。
- 真实站点:修后 `new URL(window.location)` 不再报错;下一行
  `window.history.replaceState` 才成为新缺口(如实保留,见 tinybrowser
  `docs/real-site-gaps.md`)。


## Timeline

- time: 2026-10-18T02:48:24
  kind: decision
  summary: "Created this page: URL 构造器与 href= 先按 WebIDL 转 USVString"
  source: "2026-10-18 tinybrowser 集成实测"
  affects: [url-idl-string-coercion]

- time: 2026-10-18T02:48:24
  kind: decision
  summary: "URL 参数先 String() 再解析;非字符串不再抛 URL must be a string"
  source: "2026-10-18 tinybrowser 集成实测"
  affects: [url-idl-string-coercion]
