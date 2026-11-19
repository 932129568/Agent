/**
 * 工具循环与护栏（规范 §6）。
 * B3 迁移时把 legacy 的 executeTool / guardCheckTool / agentGuardCheck /
 * mcpGuardCheck 行为钉整体搬到这里；当前是**接口骨架**，只定义契约不实现细节。
 */
import { HarborError } from './errors.js'
import { invoke } from './bridge.js'

const GUARD_KINDS = new Set(['file', 'command', 'browser', 'software', 'mcp'])

/** 统一护栏档位判定：返回结果必须带 ok / 需要的确认档（off/session/always）。 */
export function guardKindOf(toolName) {
  if (typeof toolName !== 'string' || !toolName) return 'file'
  if (toolName.startsWith('mcp__')) return 'mcp'
  if (toolName.startsWith('browser_')) return 'browser'
  if (toolName.startsWith('software_')) return 'software'
  if (toolName === 'run_command' || toolName === 'run_powershell') return 'command'
  return 'file'
}

/**
 * 工具执行入口：所有工具调用经此收口，便于统一熔断、审计与接管。
 * 迁移必须保住：同错误连续 2 轮提示 / ≥4 轮硬停；AbortSignal 传播。
 */
export function createToolExecutor({ guard, confirm, onProgress } = {}) {
  return {
    async execute(toolName, params, context = {}) {
      const kind = guardKindOf(toolName)
      if (!GUARD_KINDS.has(kind)) throw new HarborError('BAD_TOOL_KIND', '未知工具类别: ' + kind)
      if (guard && typeof guard.check === 'function') {
        const verdict = await guard.check(kind, toolName, params, context)
        if (verdict && verdict.confirm === 'always' && typeof confirm === 'function') {
          const granted = await confirm({ toolName, params, reason: verdict.reason })
          if (!granted) throw new HarborError('USER_DENIED', '用户拒绝了该工具调用')
        }
      }
      if (typeof onProgress === 'function') onProgress({ toolName, phase: 'start' })
      try {
        const result = await invoke(toolName, params, { sid: context.sid, signal: context.signal })
        if (typeof onProgress === 'function') onProgress({ toolName, phase: 'done' })
        return result
      } catch (error) {
        if (typeof onProgress === 'function') onProgress({ toolName, phase: 'error', error })
        throw error
      }
    },
  }
}
