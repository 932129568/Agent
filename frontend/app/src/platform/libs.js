/**
 * 预编译 libs 适配（规范 §2/§7）：feature 层禁止直接读 window.marked 等全局。
 * 生产链由 <script src="libs/*.js"> 注入，经此唯一入口暴露。
 */
let cache = null

export function libs() {
  if (cache) return cache
  const g = globalThis
  cache = Object.freeze({
    marked: g.marked || null,
    purify: g.DOMPurify || null,
    highlight: g.hljs || null,
    flate: g.flate || null,
    uiSchema: g.HarborUISchema || null,
  })
  return cache
}

/** 评审/测试时注入桩实现，避免依赖真实浏览器全局。 */
export function setLibsForTest(patch) {
  cache = Object.freeze({ ...(cache || {}), ...(patch || {}) })
  return cache
}

export function resetLibsCache() { cache = null }
