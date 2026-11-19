/**
 * R70 / I14：删除后审计产物新鲜度判据（可导入的纯函数，零副作用）。
 *
 * 裁决依据：mtime 比较方向随「谁最后跑门」变化，实测 audit 产物 mtime 恒定
 * 而 normalized/gate-cov/arch-metrics 被并发刷新，差距在 3h54m / 11m54s /
 * 29m37s 间漂移，任何固定容差都会失效；且 touch 反例必须动真实产物，违反
 * 沙箱约束。故统一改走独立 meta 文件的 ISO 8601 `generatedAt`，由本模块提供
 * 纯判据，QA 可直接 import 做单元级反例，无需复制整棵工程树、不污染工作区。
 *
 * 用法：
 *   import { AUDIT_FRESHNESS_TOLERANCE_MS, isAuditFresh }
 *     from './audit-freshness.mjs'
 */

/** 10 分钟容差：CI 上 audit 门与 arch-contract 秒级差；本地「先跑统一入口再验」
 *  也在 10 分钟内。写成具名常量，便于 QA 用更小容差构造陈旧反例。 */
export const AUDIT_FRESHNESS_TOLERANCE_MS = 10 * 60 * 1000

/**
 * 判断 generatedAt 是否新鲜。
 *
 * @param {string} generatedAt ISO 8601 时间戳（来自独立 meta 文件）
 * @param {number} now 当前时间毫秒数（注入以便单元测试，不读系统时钟）
 * @param {number} [toleranceMs=AUDIT_FRESHNESS_TOLERANCE_MS] 容差（毫秒）
 * @returns {boolean} 新鲜返回 true；缺失/不可解析/超出容差一律 false
 */
export function isAuditFresh(generatedAt, now,
  toleranceMs = AUDIT_FRESHNESS_TOLERANCE_MS) {
  if (typeof generatedAt !== 'string' || generatedAt.length === 0) return false
  if (!Number.isFinite(now)) return false
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) return false
  const timestamp = Date.parse(generatedAt)
  if (!Number.isFinite(timestamp)) return false
  const delta = now - timestamp
  // 允许产物比 now 略新（CI 与本地时钟有小偏差），但不得超过容差；
  // 陈旧产物 delta 为大正数，必然超出容差而判陈旧。
  return delta >= -toleranceMs && delta <= toleranceMs
}
