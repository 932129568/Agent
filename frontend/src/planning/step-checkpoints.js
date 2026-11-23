/* ================= v3.4 I12 · 步骤级检查点链 =================
 * 目的（施工总册 I12）：任意中间步精准回滚。
 * 前置缺口（之前卡住的原因）：**每步写了哪些文件，运行时没有记录**。
 * 现在补两块：
 *   ① 收集：run-controller 在写类工具成功后调 stepCkptNoteWrite(path)；
 *   ② 结算：planStepStatus(index,'done') 时调 stepCkptFlush(taskId, index)，
 *      把"上一次结算以来"累积的路径作为该步的检查点文件清单。
 *
 * 为什么按"上次结算以来"而不是按步号收集：
 * 写操作发生时，前端并不知道它属于第几步（模型在两次 plan_update 之间可能连写多个文件）。
 * 用"结算时清空"这个边界最稳——它天然把写操作切到相邻两个 done 之间。
 *
 * id 形状：`<taskId>-s<idx>`。服务端 safeCkptTid 允许连字符、上限 64，
 * 超长任务 id 会被截断到 52 字符再拼后缀（保证整串 ≤64）。
 */

const STEP_CKPT_MAX_FILES = 50;   // 单步最多记 50 个路径：再多也不是"一步"能干的事
let _pending = [];                // 自上次结算以来的写入路径（去重、保序）

/** 记一次写操作（幂等：同一路径只留第一次出现的顺序）。 */
function stepCkptNoteWrite(relPath) {
  const p = String(relPath == null ? '' : relPath).trim();
  if (!p) return false;
  if (_pending.indexOf(p) >= 0) return false;
  if (_pending.length >= STEP_CKPT_MAX_FILES) return false;
  _pending.push(p);
  return true;
}

/** 待结算数量（探针/诊断用）。 */
function stepCkptPending() { return _pending.slice(); }

function stepCkptClear() { _pending = []; }

/** 步骤级检查点 id：`<taskId>-s<idx>`，整串 ≤64。 */
function stepCkptId(taskId, idx) {
  const tid = String(taskId == null ? '' : taskId);
  if (!tid) return '';
  const n = Math.max(0, Number(idx) || 0);
  const suffix = '-s' + n;
  const room = 64 - suffix.length;
  return tid.slice(0, Math.max(1, room)) + suffix;
}

/**
 * 结算某一步：把累积的写入路径建成该步的检查点。
 * 没有待结算路径 ⇒ 返回 null（**不建空检查点**——空清单的检查点回滚什么都不做，
 * 那正是我们之前修掉的"假成功"）。
 * @param {(name:string,args:any[],timeout?:number)=>Promise<any>} callApiFn
 */
async function stepCkptFlush(callApiFn, taskId, idx, wsDir) {
  if (typeof callApiFn !== 'function') return null;
  const tid = stepCkptId(taskId, idx);
  if (!tid) return null;
  const files = _pending.slice();
  if (!files.length) return null;
  _pending = [];
  let raw = null;
  try { raw = await callApiFn('checkpoint_create', [tid, files, String(wsDir || '')], 60000); }
  catch (e) { return { ok: false, id: tid, files, error: String(e && e.message || e) }; }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  return { ok: !!(parsed && parsed.ok !== false), id: tid, files, raw: parsed };
}
