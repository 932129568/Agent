/** 模板 service：本域所有后端调用的唯一位置，错误统一归一化。 */
import { normalizeError } from '../../services/errors.js'
import { invoke } from '../../services/bridge.js'

export async function loadFeatureData(params, options) {
  try {
    return await invoke('get_config', params, options)
  } catch (error) {
    throw normalizeError(error, 'FEATURE_LOAD_FAILED')
  }
}
