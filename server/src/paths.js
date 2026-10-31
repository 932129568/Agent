/**
 * 本地路径与运行态（与 legacy backend/paths.py 对齐）。
 *
 * 注意「config.json 零污染」纪律在 Node 侧同样成立：运行态（cwd / 会话工作区 /
 * 当前 sid）一律写独立 runtime.json，不并入用户的 config.json。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CONFIG_DIR = process.env.HARBOR_CONFIG_DIR || path.join(os.homedir(), '.glm-chat')
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')
export const RUNTIME_PATH = path.join(CONFIG_DIR, 'harbor-node-runtime.json')

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function readTextIfExists(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

export function readJsonIfExists(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return fallback
  }
}

/** 原子写：tmp + rename，崩溃不留半截 JSON（与 legacy atomic_write_json 同口径）。 */
export function atomicWriteJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  const text = JSON.stringify(value, null, 2)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}
