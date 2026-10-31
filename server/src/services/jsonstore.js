/**
 * 独立 JSON 配置文件的统一读写（guard/sandbox/hybrid/model_prefs/reader/webdav 等）。
 *
 * 纪律沿用 legacy：**每类配置一个独立文件，config.json 零污染**；
 * 读取失败/缺文件返回 '{}'（调用方按默认配置工作），写入为浅合并 + 原子写。
 *
 * P0-1c T04：规格化读写双函数（CF1-CF4）——readConfigNormalized /
 * mergeConfigValidated 消费 config-specs.js 的规格数据，实现 Python 侧
 * 「defaults 归一 + 保存校验 + 归一化整写」语义（规格=数据、读写=函数，
 * 禁止按配置名写 service 类——design §6 T04 风险条）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, atomicWriteJson, readTextIfExists } from '../paths.js'

export function configFile(name) {
  return path.join(CONFIG_DIR, name)
}

export function readConfigText(name) {
  return readTextIfExists(configFile(name), '{}')
}

export function readConfigJson(name, fallback = {}) {
  try {
    const parsed = JSON.parse(readConfigText(name))
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (error) {
    return fallback
  }
}

export function mergeConfig(name, configJson) {
  let incoming
  try {
    incoming = JSON.parse(String(configJson))
  } catch (error) {
    return JSON.stringify({ error: `配置 JSON 解析失败，未写入: ${error.message}` })
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return JSON.stringify({ error: '配置必须是 JSON 对象（{...}），未写入' })
  }
  const current = readConfigJson(name, {})
  atomicWriteJson(configFile(name), { ...current, ...incoming })
  return '{"ok":true}'
}

export function configExists(name) {
  return fs.existsSync(configFile(name))
}

/* ---------------- P0-1c T04：规格化读写（CF1-CF4） ---------------- */

/** 读原始文件：{status: 'missing'|'corrupt'|'ok', data}。 */
function readRaw(name) {
  const file = configFile(name)
  if (!fs.existsSync(file)) return { status: 'missing', data: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'corrupt', data: null }
    return { status: 'ok', data: parsed }
  } catch {
    return { status: 'corrupt', data: null }
  }
}

/**
 * 规格化读取：file → defaults 合并（仅收合法键值；损坏按缺失处理）。
 *
 * 返回 {config, source}——source: 'default'（缺失/损坏）| 'file'。
 * spec.persistOnMissing 时缺失顺带落盘默认（hybrid 首启零配置语义）；
 * 损坏时按 hybrid 口径备份 .corrupt-<epoch> 后回落默认（保留现场供排查）。
 */
export function readConfigNormalized(spec) {
  const raw = readRaw(spec.file)
  const fresh = () => (spec.lenient
    ? JSON.parse(JSON.stringify(spec.defaults))   // 嵌套结构深拷贝（防规格被污染）
    : { ...spec.defaults })
  let source = 'default'
  let config = fresh()
  if (raw.status === 'ok') {
    if (spec.lenient) {
      // sandbox：结构感知宽松合并（_load 同款——仅收合法字段）
      config = spec.merge(config, raw.data)
    } else {
      for (const key of Object.keys(spec.defaults)) {
        const value = raw.data[key]
        if (spec.validate(key, value)) config[key] = value
      }
    }
    source = 'file'
  } else if (raw.status === 'corrupt') {
    try {
      fs.renameSync(configFile(spec.file), `${configFile(spec.file)}.corrupt-${Math.trunc(Date.now() / 1000)}`)
    } catch { /* 备份失败不阻断默认值重建 */ }
  }
  if (raw.status !== 'ok' && spec.persistOnMissing) {
    try { atomicWriteJson(configFile(spec.file), config) } catch { /* 落盘失败按内存默认继续 */ }
  }
  return { config, source }
}

/**
 * 规格化保存：校验 → 合并 → 归一化整写。
 *
 * 语义按 spec 分派（Python 四服务三款方言）：
 *   - partialUpdate（hybrid）：未知键忽略；显式 null 跳过（部分更新语义）；
 *     非法值 → {error, field}（api 层包 BAD_PARAMS+hint）；
 *   - keepCurrentOnMissing（model_prefs）：缺键取当前值；非法值 → {error}；
 *   - 默认（reader）：键全量替换（d ∩ defaults）；version 强制回 1；
 *   - lenient（sandbox）：宽松合并仅收合法字段，无错误路径。
 *
 * 返回 {record}（合并后全量，未落盘键不含 fileExtra）或 {error, field?}。
 */
export function mergeConfigValidated(spec, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { error: spec.rootError || '配置必须是 JSON 对象' }
  }
  // lenient（sandbox）：结构感知宽松合并，无校验错误路径
  if (spec.lenient) {
    const merged = spec.merge(JSON.parse(JSON.stringify(spec.defaults)), incoming)
    try {
      atomicWriteJson(configFile(spec.file), { ...merged, ...(spec.fileExtra || {}) })
    } catch (error) {
      return { error: `配置保存失败: ${error.message}` }
    }
    return { record: merged }
  }
  // 校验先行（拒绝禁夹逼）：partialUpdate 下显式 null 跳过（hybrid）；
  // keepCurrentOnMissing（model_prefs）缺键取当前——显式 null 属「携带非法值」→ 拒绝
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in spec.defaults)) continue
    if (spec.partialUpdate && value === null) continue
    if (value === undefined) continue
    if (!spec.validate(key, value)) return { error: spec.errorFor(key, value), field: key }
  }
  // 合并：partialUpdate/keepCurrentOnMissing 缺键自然取当前（读文件归一），
  // reader 为键全量替换（d ∩ defaults）
  const current = readConfigNormalized(spec).config
  const merged = { ...current }
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in spec.defaults)) continue
    if (spec.partialUpdate && value === null) continue
    if (value === undefined) continue
    merged[key] = spec.coerce ? spec.coerce(key, value) : value
  }
  if (spec.finalize) spec.finalize(merged)
  try {
    atomicWriteJson(configFile(spec.file), { ...merged, ...(spec.fileExtra || {}) })
  } catch (error) {
    return { error: `配置保存失败: ${error.message}` }
  }
  return { record: merged }
}
