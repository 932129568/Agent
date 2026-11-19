/**
 * 配置读写：与 legacy config_service.get_config / save_config 同形。
 *
 *   get_config()   → config.json 原文（缺文件返回 '{}'）
 *   save_config()  → 浅合并（cfg.update(incoming)）+ 原子写；
 *                    非法 JSON / 非对象显式报错，不静默返回 ok。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_PATH, atomicWriteJson, readTextIfExists } from '../paths.js'

export function getConfig() {
  return readTextIfExists(CONFIG_PATH, '{}')
}

export function saveConfig(configJson) {
  let incoming
  try {
    incoming = JSON.parse(String(configJson))
  } catch (error) {
    return JSON.stringify({ error: `配置 JSON 解析失败，未写入: ${error.message}` })
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return JSON.stringify({ error: '配置必须是 JSON 对象（{...}），未写入' })
  }

  let current = {}
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
    }
  } catch (error) {
    current = {}
  }

  atomicWriteJson(CONFIG_PATH, { ...current, ...incoming })
  return '{"ok":true}'
}

export function configDirOf(file) {
  return path.dirname(file)
}
