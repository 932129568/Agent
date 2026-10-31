/**
 * 独立 JSON 配置文件的统一读写（guard/sandbox/hybrid/model_prefs/reader/webdav 等）。
 *
 * 纪律沿用 legacy：**每类配置一个独立文件，config.json 零污染**；
 * 读取失败/缺文件返回 '{}'（调用方按默认配置工作），写入为浅合并 + 原子写。
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
