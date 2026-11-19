/**
 * 本地路径与运行态（与 legacy backend/paths.py 对齐）。
 *
 * 注意「config.json 零污染」纪律在 Node 侧同样成立：运行态（cwd / 会话工作区 /
 * 当前 sid）一律写独立 runtime.json，不并入用户的 config.json。
 *
 * R69 P0-③ 第一阶段：本文件是 JSDoc 类型契约试点，为有网后启用
 * TypeScript `checkJs` 铺路。当前环境无 tsc，故只提供类型注解，不宣称静态类型检查。
 * @module paths
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** @type {string} 配置根目录；HARBOR_CONFIG_DIR 可覆盖以便测试隔离 */
export const CONFIG_DIR = process.env.HARBOR_CONFIG_DIR || path.join(os.homedir(), '.glm-chat')

/** @type {string} 用户配置主文件；运行态数据不得写入此文件 */
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/** @type {string} 运行态独立文件（config.json 零污染纪律） */
export const RUNTIME_PATH = path.join(CONFIG_DIR, 'harbor-node-runtime.json')

/**
 * 确保目录存在（recursive，重复调用幂等）。
 * @param {string} dir - 目标目录路径
 * @returns {void}
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * 读取 UTF-8 文本；文件不存在时返回兜底值，其它 I/O 错误照常抛出。
 * @param {string} file - 文件路径
 * @param {string} [fallback=''] - 文件不存在时的返回值
 * @returns {string} 文件内容或兜底值
 */
export function readTextIfExists(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

/**
 * R70 / I19：readJsonIfExists 的非预期 I/O 异常留痕缓冲（有界）。
 * 零行为变更：函数仍返回 fallback、不抛异常；这里只把「静默吞掉」变成
 * 结构化可观测记录，供 node --test 与诊断读取。
 * @type {{code: string, path: string}[]}
 */
export const readJsonWarnings = []

/** 缓冲上限：长跑场景下不无限增长（有界纪律）。 @type {number} */
const MAX_READ_WARNINGS = 32

/**
 * 记录一条非 ENOENT / 非 SyntaxError 的读取异常（含 code/path）。
 * @param {unknown} error - 捕获的异常
 * @param {string} file - 目标文件路径
 * @returns {void}
 */
function pushReadJsonWarning(error, file) {
  const code = (error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string') ? error.code : 'UNKNOWN'
  readJsonWarnings.push({ code, path: file })
  if (readJsonWarnings.length > MAX_READ_WARNINGS) {
    readJsonWarnings.splice(0, readJsonWarnings.length - MAX_READ_WARNINGS)
  }
}

/**
 * 读取并解析 JSON；文件缺失或解析失败时返回兜底值。
 *
 * R70 / I19（裁决 3：零行为变更替代方案）：保留 `return fallback`，不抛异常、
 * 不改调用方语义；但把非 ENOENT / 非 SyntaxError 的异常写入有界结构化
 * `readJsonWarnings`（含 code/path），不静默吞掉。ENOENT 与损坏 JSON 属
 * 预期情形，不记 warning（避免正常路径产生噪声）。
 *
 * @param {string} file - 文件路径
 * @param {*} [fallback] - 兜底值
 * @returns {*} 解析结果或兜底值
 * @throws {never} 本函数不抛异常；意外 I/O 异常改由 `readJsonWarnings` 留痕
 */
export function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (!(error instanceof SyntaxError) &&
        !(error && typeof error === 'object' && error.code === 'ENOENT')) {
      pushReadJsonWarning(error, file)
    }
    return fallback
  }
}

/** 原子写：tmp + rename，崩溃不留半截 JSON（与 legacy atomic_write_json 同口径）。
 * R37 修复（S2-8）：对齐 Python fio.py 持久化强度——写后 fsync（掉电不留半截）、
 * rename 遇 EBUSY/EPERM/EACCES（杀毒/索引器短暂占用目标）快速重试 5 次、
 * 最终失败清理 tmp 再抛（不留垃圾文件）。
 * @param {string} file - 目标文件绝对路径
 * @param {*} value - 可被 JSON.stringify 序列化的值
 * @returns {void}
 * @throws {Error} 写入失败或 rename 重试 5 次仍失败时抛出
 */
export function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  const text = JSON.stringify(value, null, 2)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, text, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file)
      return
    } catch (error) {
      if (attempt >= 4 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
        try { fs.rmSync(tmp, { force: true }) } catch { /* 尽力清理 */ }
        throw error
      }
    }
  }
}
