/* ================= 搜索面板（v1.8.0 B 域 U1，实现 v1.8.0 B2） =================
 * #searchPanel + .sp-*（纯新增 DOM，UI 契约只增不改——check_contract 验）：
 * 结果列表 / 原文预览 / 缓存来源标注 / 人工接管区 / 阶段 pill + 进度。
 * 契约口径（联调规范 §2/§3.1 + ux-flows 流程 1/2/3）：
 * - 三态状态机 idle/pending/success/error + 请求序号 last-wins
 *   （searchReqSeq，同 36-connect connectIdentifySeq 先例；pending 期间新
 *   触发 → seq+1 覆盖，旧请求返回后 seq!==searchReqSeq 静默丢弃）；
 * - ≥3s 可见等待：browser_search 在途期间 1s 轮询 search_status（§2.4 方案
 *   A：面板打开起、关闭/终态停；phase → 阶段 pill 文案轮换，P2 最短展示
 *   400ms 由 CSS 过渡承担）；
 * - CAPTCHA 接管（流程 2）：CAPTCHA_REQUIRED → 接管区（「请完成验证」+
 *   继续/放弃，面板不可关闭）→ browser_takeover continue 成功载荷渲染 /
 *   abort → CAPTCHA_ABORTED 人话；
 * - typeof 守卫（§2.5 vm 沙箱可测）：模块顶层不直接引用 window/document/
 *   localStorage，一律函数体内守卫或注入；callApi 统一经 spCallApi 四步
 *   （入口守卫 → 序号登记 → 竞速调用 → 序号校验）。
 * 挂载：110-boot.js loadAll 内 try{ searchPanelInit(); }catch（功能分级
 * 开关「浏览器搜索」默认开——spFeatureEnabled，localStorage 持久化）。
 * C 域批次：25-tool-exec.js executeToolRaw 新分支将调 searchPanelRunSearch
 * 驱动 Agent 工具循环的进度与结果渲染（本批只提供面板侧能力）。
 */
const SP_POLL_INTERVAL_MS = 1000;      // search_status 轮询间隔（§2.4）
const SP_STATUS_TIMEOUT_MS = 15000;    // 纯内存状态读，快失败（§2.1 表）
const SP_SEARCH_TIMEOUT_MS = 90000;    // browser_search（extract=full 时前端可传 150000）
const SP_TAKEOVER_TIMEOUT_MS = 90000;  // browser_takeover（§2.1 表）
const SP_STATS_TIMEOUT_MS = 15000;     // search_cache_stats
// 接管 TTL 与到期预警（与 backend search_service.TAKEOVER_TTL_SECONDS=600 逐字一致；
// 面板轮询已带 takeover.elapsed_s，到期前 60s toast 一次零额外成本）
const SP_TAKEOVER_TTL_S = 600;
const SP_TAKEOVER_WARN_LEAD_S = 60;
// 后端 phase → 阶段文案（§2.3 四件套映射表；motion-spec §2.1 为动效真相源）
const SP_PHASE_TEXT = {
  understanding: '正在理解检索意图…',
  cache_check: '正在检查缓存…',
  window_loading: '正在打开搜索引擎…',
  urllib_fallback: '已切换轻量抓取（降级）…',
  extracting: '正在提取搜索结果…',
  filtering: '正在整理结果…',
  deep_extract: '正在读取正文…',
  validating: '正在校验结果…',
  reformulate: '正在改写检索式重试…',
  captcha: '需要人工验证',
  done: '搜索完成',
  failed: '搜索失败'
};
// 功能分级开关键（设置可单独关搜索；默认开——架构 §5 行为兼容）
const SP_FEATURE_KEY = 'glm_feat_search_v18';

let searchReqSeq = 0;          // last-wins 请求序号（每次触发递增，旧请求失效）
let searchPanelState = 'idle'; // idle|pending|success|error|captcha
let searchPollTimer = null;    // 1s 轮询定时器句柄
let searchTakeoverId = null;   // 当前接管会话（captcha 态非空）
let searchLastPayload = null;  // 最近一次成功载荷（原文预览/重渲染用）
let spStatsSeq = 0;            // 脚注统计 last-wins（同 searchReqSeq 先例）
let spTakeoverWarned = false;  // 当前接管会话是否已做过 TTL 到期预警（每会话一次）
