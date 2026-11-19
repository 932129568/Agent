/**
 * 后端桥（规范 §6）：**唯一** callApi 出口。
 *
 * 组件 / hook / feature 一律通过本文件的具名函数调用后端，
 * 禁止直接 fetch、禁止在 UI 层拼 jsapi 方法名。
 * js_api 契约逐字节冻结：本层不新增方法，只做调用与归一化。
 */
import { normalizeError, HarborError } from './errors.js'
import { sessionId } from '../platform/env.js'

async function invoke(method, params = [], options = {}) {
  const bridge = globalThis.HarborBridge
  if (!bridge || typeof bridge.callApi !== 'function') {
    throw new HarborError('BRIDGE_UNAVAILABLE', '前端桥未就绪', { retryable: true })
  }
  let payload
  try {
    payload = await bridge.callApi(method, params, {
      sid: options.sid || sessionId(),
      signal: options.signal,
    })
  } catch (error) {
    throw normalizeError(error, 'RPC_FAILED')
  }
  if (payload && payload.ok === false) throw normalizeError(payload, 'API_ERROR')
  return payload
}

export const getConfig = (options) => invoke('get_config', [], options)
export const buildTools = (params, options) => invoke('build_tools', params, options)
export const getSessions = (options) => invoke('get_sessions', [], options)
export const saveSessions = (params, options) => invoke('save_sessions', params, options)
export const groupFilesWrite = (params, options) => invoke('group_files_write', params, options)
export const groupFilesRead = (params, options) => invoke('group_files_read', params, options)
export const groupFilesConfigGet = (params, options) => invoke('group_files_config_get', params, options)
export const groupFilesConfigSet = (params, options) => invoke('group_files_config_set', params, options)

/** 新增方法须先在 backend/api.py 的 _V12_EXTRA 登记（隐身），再在此处补具名函数。 */
export { invoke }
