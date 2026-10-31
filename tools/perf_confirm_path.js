'use strict';

/* Harbor 确认路径性能基准（2026-10-30）
 *
 * 目的：为「每次确认状态响应缓慢」提供可复现证据（不是猜测）。
 * 测量项全部是点击「允许」后、下一个宏任务之前会同步占用的主线程工作：
 *   1. persist_serialize —— saveSessions 的 JSON 双遍历（replacer 深克隆 + 二次 stringify）
 *   2. persist_localstorage —— localStorage.setItem 的等量字节写入（WebView2 为同步磁盘写，
 *      Node 侧用 Buffer.byteLength 记录载荷规模 + 以一次性字符串写模拟同步成本）
 *   3. aggregate_all_sessions —— updateTokenStat 的全会话 concat + calcUsage 扫描
 *   4. sidebar_groups_html —— _sessionGroupsHtml 的三根重渲染（renderSessionList 内）
 *
 * 限制（必须与结论一同引用）：
 *   - Node VM 只测 JS 序列化/扫描成本，不含 WebView2 的 DOM layout/paint 与真实磁盘 IO。
 *   - localStorage 写入成本以载荷字节数记录，Node 侧仅近似；真实成本需真机 CDP 复测。
 *   - 不作为「真机通过」依据。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/manifest.json'), 'utf8'));

function readModule(suffix) {
  const matches = manifest.scripts.filter(entry => entry.path.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`manifest module missing or ambiguous: ${suffix}`);
  return fs.readFileSync(path.join(root, matches[0].path), 'utf8');
}

function extract(source, start, end) {
  const from = source.indexOf(start);
  if (from < 0) throw new Error('source marker missing: ' + start);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error('source marker missing: ' + end);
  return source.slice(from, to);
}

const storeSource = readModule('frontend/src/sessions/store.js');
const tokensSource = readModule('frontend/src/analytics/tokens.js');
const sessionsSource = readModule('frontend/src/sessions/controller.js');

const SESSIONS = Number(process.env.HARBOR_CONFIRM_SESSIONS || 60);
const MESSAGES = Number(process.env.HARBOR_CONFIRM_MESSAGES || 160);
const MESSAGE_CHARS = Number(process.env.HARBOR_CONFIRM_CHARS || 1200);
const RUNS = Number(process.env.HARBOR_CONFIRM_RUNS || 5);

function buildSessions() {
  const out = [];
  for (let i = 0; i < SESSIONS; i++) {
    const messages = [];
    for (let j = 0; j < MESSAGES; j++) {
      const role = j % 3 === 0 ? 'user' : (j % 3 === 1 ? 'assistant' : 'tool');
      const msg = {
        role,
        content: ('会话' + i + ' 消息' + j + ' ').repeat(Math.ceil(MESSAGE_CHARS / 12)).slice(0, MESSAGE_CHARS),
      };
      if (role === 'assistant') {
        msg.usage = {
          model: 'glm-4.5-flash',
          prompt_tokens: 2000 + (j % 7) * 300,
          completion_tokens: 300 + (j % 5) * 40,
          total_tokens: 2400 + (j % 7) * 300,
          prompt_tokens_details: { cached_tokens: (j % 4) * 120 },
        };
      }
      messages.push(msg);
    }
    out.push({
      id: 's_perf_' + i,
      title: '性能基准会话 ' + i,
      createdAt: Date.now() - i * 3600_000,
      updatedAt: Date.now() - i * 60_000,
      messages,
    });
  }
  return out;
}

const data = buildSessions();

// ---- 1/2：saveSessions 的序列化与写入成本 ----
const sandbox = {
  JSON, Date, Math, Number, String, Object, Array, Promise, Set, Map, Error,
  console, setTimeout, clearTimeout,
  localStorage: {
    _store: null,
    _bytes: 0,
    setItem(k, v) { this._store = v; this._bytes = Buffer.byteLength(v, 'utf8'); },
    getItem() { return this._store; },
  },
  window: { pywebview: null },
  callApi: async () => '',
  toast: () => {},
  sessions: data,
  SAVE_THROTTLE_MS: 300,
  _saveChain: Promise.resolve(),
  _saveLastRun: 0,
  _saveTrailer: null,
};
sandbox.AppState = undefined;
sandbox._sessionStateRead = () => sandbox.sessions;
sandbox._sessionStateWrite = v => { sandbox.sessions = v; };
vm.createContext(sandbox);

// 用真实 saveSessions 源码（去掉节流门控，直接测单次全量落盘成本）
const saveSrc = extract(storeSource, 'async function saveSessions()', 'function getCurrentSession()');
vm.runInContext(saveSrc.replace('async function saveSessions()', 'async function saveSessionsRaw()'), sandbox);

// 真实实现抽取：2026-10-30 修复后 store.js 改为「单次 stringify + 镜像投影 +
// 未变更签名短路」。旧实现（深克隆 + 二次 stringify）已不存在，若仍在旧代码上
// 运行则回退到旧测量口径，保证基准可复现 before/after。
const newStore = storeSource.includes('_sessionsPersistReplacer');
let makeSlim;
let makeMirror = null;
let signaturesOf = null;
let signaturesEqual = null;
if (newStore) {
  vm.runInContext(extract(storeSource, 'function _sessionsPersistReplacer', 'async function saveSessions()'), sandbox);
  vm.runInContext(extract(storeSource, 'function _sessionSaveSignature', 'function _sessionsPersistReplacer'), sandbox);
  sandbox.LOCAL_MIRROR_MAX_SESSIONS = 24;
  sandbox.LOCAL_MIRROR_MAX_CHARS = 2000;
  makeSlim = src => JSON.parse(JSON.stringify(src));
  makeMirror = src => sandbox._sessionsMirrorProjection(src);
  signaturesOf = src => sandbox._sessionSignatures(src);
  signaturesEqual = (a, b) => sandbox._allSignaturesEqual(a, b);
} else {
  const replacerSrc = extract(storeSource, 'const slim = JSON.parse(JSON.stringify(currentSessions', 'const data = JSON.stringify(slim);');
  const replacerBody = replacerSrc.replace('const slim = JSON.parse(JSON.stringify(currentSessions, ', 'return JSON.parse(JSON.stringify(src, ');
  makeSlim = vm.runInContext('(function(src){' + replacerBody.replace(/\)\);\s*$/, '));') + '})', sandbox);
}

function timeIt(fn, runs) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { samples: samples.map(v => +v.toFixed(2)), median: +samples[Math.floor(samples.length / 2)].toFixed(2) };
}

let payloadBytes = 0;
let mirrorBytes = 0;
const persist = timeIt(() => {
  const json = newStore
    ? JSON.stringify(sandbox.sessions, sandbox._sessionsPersistReplacer)
    : JSON.stringify(makeSlim(sandbox.sessions));
  payloadBytes = Buffer.byteLength(json, 'utf8');
  // 修复后：localStorage 只写压缩镜像（后端仍收全量）；修复前：镜像=全量
  const mirror = newStore ? makeMirror(sandbox.sessions) : json;
  mirrorBytes = Buffer.byteLength(mirror, 'utf8');
  sandbox.localStorage.setItem('glm_sessions', mirror);
}, RUNS);

// 未变更短路成本（修复后特有）：重复状态刷新应接近零成本
const noop = newStore ? timeIt(() => {
  const sigs = signaturesOf(sandbox.sessions);
  signaturesEqual(sigs, signaturesOf(sandbox.sessions));
}, RUNS) : null;

// ---- 3：全会话聚合（updateTokenStat） ----
vm.runInContext(extract(tokensSource, 'function calcUsage(messages)', 'function accumulateUsage'), sandbox);
sandbox.providerPriceFor = () => ({ in: 0.8, out: 2.8, cache: 0.23 });
const aggregate = timeIt(() => {
  const all = [];
  let allMsgs = [];
  sandbox.sessions.forEach(s => { allMsgs = allMsgs.concat(s.messages); });
  all.push(allMsgs.length);
  sandbox.calcUsage(allMsgs);
}, RUNS);

// ---- 4：侧栏分组 HTML（renderSessionList 的两根 + 中央历史） ----
const groupsSrc = extract(sessionsSource, 'function _newChatGroupsData()', 'function toggleTaskGroup()');
const daysSrc = extract(sessionsSource, 'function _dayGroup(ts)', 'function formatTime(ts)');
const fmtSrc = extract(sessionsSource, 'function formatTime(ts)', 'function ensureSession()');
sandbox.projects = [];
sandbox._taskGroupCollapsed = false;
sandbox._collapsedProjects = new Set();
sandbox.escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
sandbox._shortDir = p => String(p || '');
sandbox.getCurrentSession = () => sandbox.sessions[0];
sandbox.saveSessions = () => {};
sandbox.renderSessionList = () => {};
sandbox._dayGroup = vm.runInContext(daysSrc + '\n_dayGroup;', sandbox);
sandbox.formatTime = vm.runInContext(fmtSrc + '\nformatTime;', sandbox);
sandbox.currentSessionId = 's_perf_0';
sandbox.sessionGroupsHtml = vm.runInContext(groupsSrc + '\n_sessionGroupsHtml;', sandbox);
const sidebar = timeIt(() => { sandbox.sessionGroupsHtml({ showActions: true }); }, RUNS);

// ---- 5：一次完整 renderSessionList（三根 + token 统计），确认后的常见触发 ----
const renderFull = timeIt(() => {
  sandbox.sessionGroupsHtml({ showActions: true });
  sandbox.sessionGroupsHtml({ showActions: true });
  sandbox.sessionGroupsHtml({ showActions: false });
  let allMsgs = [];
  sandbox.sessions.forEach(s => { allMsgs = allMsgs.concat(s.messages); });
  sandbox.calcUsage(allMsgs);
}, RUNS);

const totalMessages = SESSIONS * MESSAGES;
process.stdout.write(JSON.stringify({
  schema: 1,
  scope: 'confirm-path-sync-main-thread',
  dataset: { sessions: SESSIONS, messages_per_session: MESSAGES, message_chars: MESSAGE_CHARS, total_messages: totalMessages, runs: RUNS },
  metrics: {
    implementation: newStore ? 'after-2026-10-30-single-pass+mirror+signature' : 'before-deep-clone',
    persist_serialize_plus_write: {
      unit: 'ms', ...persist,
      payload_bytes: payloadBytes, payload_mb: +(payloadBytes / 1048576).toFixed(2),
      mirror_bytes: mirrorBytes, mirror_mb: +(mirrorBytes / 1048576).toFixed(2),
    },
    noop_save_short_circuit: noop ? { unit: 'ms', ...noop } : null,
    aggregate_all_sessions: { unit: 'ms', ...aggregate },
    sidebar_groups_html: { unit: 'ms', ...sidebar },
    render_session_list_full: { unit: 'ms', ...renderFull },
  },
  budget: { note: '单次确认处理的同步主线程预算按 100ms 计（超过即用户可感知卡顿）', threshold_ms: 100 },
  limitations: [
    '只测 JS 序列化/扫描，不含 WebView2 DOM layout/paint 与真实磁盘 IO。',
    'localStorage 载荷按字节记录，真实写入延迟需真机 CDP 复测。',
    '不作为真机通过依据。',
  ],
}, null, 2) + '\n');
