/**
 * 独立配置规格层（P0-1c T04 CF1-CF4）：规格 = 纯数据（defaults + 逐字段校验器），
 * 读写 = jsonstore.readConfigNormalized / mergeConfigValidated 两个通用函数。
 *
 * 对齐 Python 四个配置服务的「defaults 归一 + 保存校验 + 归一化整写」语义：
 *   - hybrid（hybrid_router.py:40-46/307-395）：缺失读取顺带落盘默认（首启零配置）；
 *     保存为部分更新（未知键忽略、显式 null 跳过、非法值 → error+field）；
 *   - model_prefs（model_prefs_service.py:25-109）：缺键取当前值；落盘带 version:1；
 *     ctx_k 收敛到前端支持的最近低档；
 *   - reader（search_reader.py:30-68/87-102）：budget_s/schema_mode/max_input_chars
 *     越界一律拒绝（禁静默夹逼——前端设置项要能报错）；
 *   - sandbox（sandbox_service.py:86-103/726-766）：宽松合并（仅收合法字段，
 *     其余静默忽略——与 hybrid/reader 的拒绝语义相反，Python 源码如此）。
 *
 * 设计纪律（design §6 T04 风险条）：禁止按配置名写四个 service 类——本文件
 * 只出规格数据与纯校验函数，IO 与响应组装分别在 jsonstore.js / registry.js。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR } from '../paths.js'

/** model_prefs 损坏文件的 .bad 备份（Python ModelPrefsService._bad_backup 同口径）。
 * jsonstore 的 readConfigNormalized 在损坏时把文件改名为 .corrupt-<epoch> 并回落
 * 默认；Python 另留一份 .bad 备份供排查。jsonstore.js 不在本轮可改范围，故在
 * model_prefs 规格的 file 读取钩子里补一份**拷贝式** .bad 备份（不改动 jsonstore
 * 既有损坏处理流），仅在文件确为损坏 JSON/非对象时落盘，正常读取零副作用。 */
function _modelPrefsBadBackupIfCorrupt(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    let corrupt = false
    try {
      const data = JSON.parse(raw)
      if (!data || typeof data !== 'object' || Array.isArray(data)) corrupt = true
    } catch { corrupt = true }
    if (corrupt) fs.copyFileSync(file, file + '.bad')
  } catch { /* 文件缺失/不可读 → 无需备份 */ }
}

/** Python %r 语义（str 单引号 / bool 首大写 / null → None；数字原样）。 */
export const pyRepr = value => {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (value === null || value === undefined) return 'None'
  return String(value)
}

/** hybrid_router._is_int_like：bool 排除；int/float 且整数值（5.0 ✓ / 5.5 ✗）。 */
export const isIntLike = value => {
  if (typeof value === 'boolean' || !Number.isFinite(value)) return false
  if (typeof value !== 'number') return false
  return Math.trunc(value) === value
}

/** hybrid_router._is_float_like：bool 排除；int/float 均可。 */
export const isFloatLike = value => typeof value === 'number' && Number.isFinite(value)

const STRATEGIES = ['auto', 'saver', 'quality']
const THINKING_VALUES = ['auto', 'off', 'low', 'medium', 'high']
const CTX_K_VALUES = [0, 32, 128, 256, 300, 1024]
const CTX_K_MAX = 2048
const SCHEMA_MODES = ['auto', 'json_object', 'prompt']
const COMMAND_CLASSES = ['run_command', 'run_powershell', 'run_admin_command']
const PROFILES = ['off', 'standard', 'strict']
const UI_LEVELS = ['none', 'basic', 'strict']

/** model_prefs._ctx_k_clamp：任意合法窗口值收敛到前端支持的最近低档。 */
export const ctxKClamp = value => CTX_K_VALUES.filter(v => v <= value).reduce((a, b) => Math.max(a, b), 0)

export const CONFIG_SPECS = {
  /* CF1：hybrid（混合路由）——严格校验 + 部分更新 + 缺失落盘默认 */
  hybrid: {
    file: 'hybrid.json',
    persistOnMissing: true,
    partialUpdate: true,
    rootError: '配置必须是 JSON 对象',
    defaults: {
      enabled: true,   // R57 G5：混合路由总闸（缺省 True=既有行为不变）
      strategy: 'auto',
      local_budget_understand_s: 5,
      local_budget_validate_s: 3,
      confidence_gate: 0.7,
      cost_split_display: true,
    },
    validate(key, value) {
      if (key === 'enabled') return typeof value === 'boolean'
      if (key === 'strategy') return typeof value === 'string' && STRATEGIES.includes(value)
      if (key === 'local_budget_understand_s' || key === 'local_budget_validate_s') {
        return isIntLike(value) && Number(value) >= 1 && Number(value) <= 30
      }
      if (key === 'confidence_gate') return isFloatLike(value) && Number(value) >= 0.5 && Number(value) <= 0.95
      if (key === 'cost_split_display') return typeof value === 'boolean'
      return false
    },
    /** hybrid_router.save_config:386——'字段 %s 的值 %r 不合法' */
    errorFor(key, value) {
      return `字段 ${key} 的值 ${pyRepr(value)} 不合法`
    },
  },

  /* CF2：model_prefs（推理偏好）——缺键取当前值 + 落盘 version:1 */
  model_prefs: {
    get file() {
      _modelPrefsBadBackupIfCorrupt(path.join(CONFIG_DIR, 'model_prefs.json'))
      return 'model_prefs.json'
    },
    keepCurrentOnMissing: true,
    rootError: '偏好必须是 JSON 对象',
    fileExtra: { version: 1 },
    defaults: { thinking: 'auto', ctx_k: 0, memory_inject: true },
    validate(key, value) {
      if (key === 'thinking') return typeof value === 'string' && THINKING_VALUES.includes(value)
      if (key === 'ctx_k') return isIntLike(value) && Number(value) >= 0 && Number(value) <= CTX_K_MAX
      if (key === 'memory_inject') return typeof value === 'boolean'   // R57 G3
      return false
    },
    /** model_prefs_service.save:91-97 错误文案 */
    errorFor(key) {
      if (key === 'thinking') return `thinking 仅支持 ${THINKING_VALUES.join('/')}`
      if (key === 'ctx_k') return 'ctx_k 必须是整数（KiB）'
      if (key === 'memory_inject') return 'memory_inject 必须是布尔值'
      return '偏好必须是 JSON 对象'
    },
    /** ctx_k 保存时收敛到最近低档（_ctx_k_clamp）。 */
    coerce(key, value) {
      return key === 'ctx_k' ? ctxKClamp(Number(value)) : value
    },
  },

  /* CF3：reader（本地读取器）——越界拒绝禁夹逼 + 全量键替换合并 */
  reader: {
    file: 'reader.json',
    rootError: 'reader 配置必须是 JSON 对象',
    finalize: merged => { merged.version = 1 },
    defaults: {
      version: 1,
      enabled: true,
      base_url: '',
      model: '',
      budget_s: 10,
      max_input_chars: 12000,
      schema_mode: 'auto',
      allow_cloud_fallback: false,
    },
    validate(key, value) {
      if (key === 'budget_s') return isIntLike(value) && Number(value) >= 1 && Number(value) <= 60
      if (key === 'schema_mode') return typeof value === 'string' && SCHEMA_MODES.includes(value)
      if (key === 'max_input_chars') return isIntLike(value) && Number(value) >= 500 && Number(value) <= 60000
      return true
    },
    /** search_reader.validate_reader_config:60-67 错误文案 */
    errorFor(key) {
      if (key === 'budget_s') return 'budget_s 需为 1-60 的整数'
      if (key === 'schema_mode') return `schema_mode 仅支持 ${SCHEMA_MODES.join('/')}`
      if (key === 'max_input_chars') return 'max_input_chars 需为 500-60000 的整数'
      return 'reader 配置必须是 JSON 对象'
    },
  },

  /* CF4：sandbox（Job 沙箱配置）——宽松合并（仅收合法字段，与 Python 同款） */
  sandbox: {
    file: 'sandbox.json',
    lenient: true,
    defaults: {
      enabled: true,
      command_profiles: {
        run_command: 'standard',
        run_powershell: 'standard',
        run_admin_command: 'off',
      },
      limits: {
        standard: { memory_mb: 1024, max_processes: 16, cpu_seconds: 120, ui_restrict: 'basic' },
        strict: { memory_mb: 512, max_processes: 8, cpu_seconds: 60, ui_restrict: 'strict' },
      },
    },
    /** sandbox_service._load/save 合并规则（结构感知，非逐字段谓词）。 */
    merge(current, incoming) {
      const out = JSON.parse(JSON.stringify(current))
      if (typeof incoming.enabled === 'boolean') out.enabled = incoming.enabled
      const cp = incoming.command_profiles
      if (cp && typeof cp === 'object' && !Array.isArray(cp)) {
        for (const key of COMMAND_CLASSES) {
          const tier = cp[key]
          if (PROFILES.includes(tier)) out.command_profiles[key] = tier
        }
      }
      const lim = incoming.limits
      if (lim && typeof lim === 'object' && !Array.isArray(lim)) {
        for (const [profile, plim] of Object.entries(lim)) {
          if (!out.limits[profile] || !plim || typeof plim !== 'object' || Array.isArray(plim)) continue
          for (const field of ['memory_mb', 'max_processes', 'cpu_seconds']) {
            const num = Number(plim[field])
            if (Number.isInteger(num) && num > 0) out.limits[profile][field] = Math.min(num, 100000)
          }
          if (UI_LEVELS.includes(plim.ui_restrict)) out.limits[profile].ui_restrict = plim.ui_restrict
        }
      }
      return out
    },
  },
}

export const THINKING_VALUES_LIST = THINKING_VALUES
export const CTX_K_SUPPORTED = CTX_K_VALUES
