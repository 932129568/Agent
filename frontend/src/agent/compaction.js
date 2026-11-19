/* ================= A6 自动 compact ================= */

/**
 * 修复 TOK-2（v1.4）：estTokens 采样偏差修复。
 * 原实现只采样前 3000 字符估 ascii 比例后外推全长——中英文混合的长文件
 * （前 3000 字是中文注释、后面全是代码）比例失真，压缩时机误判。
 * 现改为 stride 采样：每 3000 字符采 1000（首段必采），段内按
 * ascii/3.5 + 非ascii/1.8 双比例计 token，再按采样覆盖率线性外推——
 * 对「前 3000 中文 + 后 3 万代码」的构造与全量扫描基准误差 <10%（实测 ~0.1%）。
 * 消息级缓存（historyTokens 每轮重算，WeakMap + 内容指纹防陈旧）。
 */
// R59 M6：estTokens 估算簇下沉 analytics/tokens.js（纯 token 估算逻辑，
// compaction↔compact-command 互绕环的拆解；本模块经声明边单向消费）。
let __lastAutoCompact = 0;
let __lastSkipTip = 0;   // 修复 TOK-1（v1.4）：双条件跳过提示的独立节流（防每轮重弹）
// v1.1.1 省 token：压缩阈值可由用户档位调节（激进省 token / 宽松保上下文）
// 修复 B1（v1.5）：local 模式改「模型 ctx_window × 档位比例」自适应（小窗口模型
// 提前压缩防爆窗）；GLM/自定义端点保持固定三档（v1.3.2 行为不回退）。
const SAVER_LEVELS = { aggressive: 45000, std: 90000, relaxed: 140000 };
const CACHE_HIT_PAUSE = 50;      // 修复 TOK-1（v1.4）：命中率 ≥50% 时暂停压缩的判定线
const CACHE_HIT_RELAX = 1.5;     // 修复 TOK-1（v1.4）：命中率高时阈值放宽倍数（冻结层多扛，前缀缓存多稳几轮）
function autoCompactThreshold() {
  const el = document.getElementById('saverLevel');
  const level = (el && el.value) || 'std';
  // 修复 B1（v1.5）：本地模式阈值 = 窗口 × 比例（localCompactThreshold 同口径，
  // 三级窗口来源：元数据 → 用户手设 → 默认 8k）
  if (typeof localState !== 'undefined' && localState.mode && typeof localCompactThreshold === 'function') {
    return localCompactThreshold();
  }
  return SAVER_LEVELS[level] || 90000;
}
async function maybeAutoCompact(s) {   // 修复 ㊸：传会话对象（原传消息数组，compactHistory 内部 saveSessions 操作的是全局 sessions，传参形态统一）
  const msgs = (s && s.messages) || [];
  const threshold = autoCompactThreshold();
  const tokens = historyTokens(msgs);
  if (tokens < threshold) return false;
  // 修复 TOK-1（v1.4）：压缩触发双条件（缓存优先）——compactNow/archiveOldTasks 是 splice 式
  // 破坏性压缩，触发即摧毁整个前缀的 prompt cache（GLM 缓存价差 5 倍：¥0.16/M vs ¥0.8/M）。
  // 仅当「token 超阈值 且 上轮 cache 命中率 < 50%」才压缩；命中率 ≥50% 时放宽至 1.5× 阈值，
  // 让缓存友好的冻结层（apiFrozen）多扛几轮。自定义端点无缓存计价（__hitRate 恒 0）时
  // 退化为「仅 token 阈值」——行为不回退于 v1.3.2。
  const hitRate = lastCacheHitRate();
  const effective = hitRate >= CACHE_HIT_PAUSE ? Math.round(threshold * CACHE_HIT_RELAX) : threshold;
  if (tokens < effective) {
    if (Date.now() - __lastSkipTip > 60000) {   // 60s 节流：告知用户为什么没压缩（透明化）
      __lastSkipTip = Date.now();
      if (typeof addSysTip === 'function') {
        addSysTip(`历史约 ${Math.round(tokens / 1000)}k tokens 已超档位阈值，但缓存命中率 ${hitRate}% ≥${CACHE_HIT_PAUSE}%——暂不压缩以保住前缀缓存（阈值放宽至 ${Math.round(effective / 1000)}k）`);
      }
    }
    return false;
  }
  if (Date.now() - __lastAutoCompact < 60000) return false;  // 60秒冷却，防每轮重弹
  // 修复 ㊶（三轮）：与上方 skip-tip 的守卫保持一致（模块未加载时不再 ReferenceError）
  if (typeof addSysTip === 'function') addSysTip('历史接近上限,自动压缩中…');
  callApi('append_worklog', ['历史接近上限 自动压缩']).catch(() => {});
  if (typeof compactHistory === 'function') {
    try {
      await compactHistory(s);      // 关键：传真实会话对象（压缩落盘走同一 saveSessions 链路）
      __lastAutoCompact = Date.now();   // 修复 ㊸：冷却戳只在压缩成功后盖（原先盖后压，失败也白吃 60s 冷却）
    }
    catch (e) { console.warn('自动压缩失败:', e); return false; }
  } else {
    return false;   // 修复 建议㉞（二轮）：compactHistory 缺失不得假成功（原无条件 return true，调用方以为已压缩）
  }
  return true;
}

/* ================= v1.8.0 W10：estTokens usage 回校校准 =================
 * 问题：静态系数（ascii/3.5 + 非ascii/1.8）对不同模型/语言比例有系统性偏差，
 * 预估费用与压缩时机判定（后者不用本校准，见下）都会漂。
 * 方案：流末 usage.prompt_tokens 到达时与本地 estTokens(上下文) 比对，
 * EMA（α=0.3）平滑 + 钳制 [0.6, 1.8] + ≥3 样本才持久化（localStorage
 * harbor_est_calib）——防单次异常 usage（如服务端计费口径差异）把系数打偏。
 * **作用域纪律**：校准只作用于展示/预估（estTokensCalibrated → 费用预估），
 * 压缩阈值判定（historyTokens）保持静态口径——压缩是功能逻辑，不能被校准
 * 系数挪动阈值造成误压缩/漏压缩。 */
// R59 M6b：校准族（estTokensCalibrate/estTokensCalibrated）下沉 analytics/tokens.js
// 与估算簇同层（校准只作用于展示/预估；压缩阈值判定保持静态口径不受校准挪动）。

