'use strict';

/* Harbor frontend micro-benchmark: real source, deterministic synthetic data, no dependencies. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { performance, monitorEventLoopDelay } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/manifest.json'), 'utf8'));
function readModule(name) {
  const matches = manifest.scripts.filter(entry => entry.path === name || entry.path.endsWith('/' + name));
  if (matches.length !== 1) throw new Error(`manifest module missing or ambiguous: ${name}`);
  return fs.readFileSync(path.join(root, matches[0].path), 'utf8');
}
const sessionSource = readModule('frontend/src/sessions/search.js');
const markdownSource = readModule('frontend/src/components/markdown.js');
const analyticsSource = readModule('frontend/src/analytics/panel.js');
const tokenSource = readModule('frontend/src/analytics/tokens.js');
const sessionCount = Number(process.env.HARBOR_PERF_SESSIONS || 128);
const messagesPerSession = Number(process.env.HARBOR_PERF_MESSAGES || 64);
const messageChars = Number(process.env.HARBOR_PERF_MESSAGE_CHARS || 600);
const runCount = Number(process.env.HARBOR_PERF_RUNS || 5);
const chunkCount = Number(process.env.HARBOR_PERF_CHUNKS || 2000);
const processStarted = performance.now();
const cpuBefore = process.cpuUsage();
const memoryBefore = process.memoryUsage();
const eventLoopHistogram = monitorEventLoopDelay({ resolution: 1 });
eventLoopHistogram.enable();
const eventLoopSamples = [];
let eventLoopPrevious = performance.now();
const eventLoopTimer = setInterval(() => {
  const current = performance.now();
  eventLoopSamples.push(Math.max(0, current - eventLoopPrevious - 1));
  eventLoopPrevious = current;
}, 1);
eventLoopTimer.unref();

function extract(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`source marker missing: ${start} / ${end}`);
  return source.slice(from, to);
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function nearestRank(samples, percentile) {
  const sorted = samples.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function summarize(samples) {
  const elapsedSeconds = samples.reduce((sum, value) => sum + value, 0) / 1000;
  return {
    unit: 'ms', samples, count: samples.length, median: median(samples),
    p95: nearestRank(samples, 0.95), p99: nearestRank(samples, 0.99),
    min: Math.min(...samples), max: Math.max(...samples),
    tasks_per_s: elapsedSeconds > 0 ? samples.length / elapsedSeconds : null
  };
}

async function main() {
await new Promise(resolve => setImmediate(resolve));
const sessions = [];
const filler = 'Harbor 本地会话性能基准文本。'.repeat(Math.ceil(messageChars / 18)).slice(0, messageChars);
for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex++) {
  const messages = [];
  for (let messageIndex = 0; messageIndex < messagesPerSession; messageIndex++) {
    const message = {
      role: messageIndex % 3 === 0 ? 'user' : messageIndex % 3 === 1 ? 'assistant' : 'tool',
      content: `${sessionIndex}/${messageIndex} ${filler}`
    };
    if (messageIndex % 11 === 0) {
      message.tool_calls = [{ function: { name: 'read_file', arguments: `{"path":"src/${messageIndex}.js"}` } }];
    }
    if (message.role === 'assistant') {
      message.usage = { prompt_tokens: 100 + messageIndex, completion_tokens: 40,
        total_tokens: 140 + messageIndex, prompt_tokens_details: { cached_tokens: 20 },
        model: 'benchmark' };
    }
    if (message.role === 'tool') {
      message.__tool = messageIndex % 2 ? 'read_file' : 'list_dir';
      message.__ms = messageIndex;
      message.content = JSON.stringify(messageIndex % 7 === 0 ? { error: 'synthetic' } :
        messageIndex % 5 === 0 ? { skipped: true } : { output: message.content });
    }
    if (messageIndex % 17 === 0) {
      message.content = [{ type: 'text', text: message.content }, { type: 'image_url' }];
    }
    messages.push(message);
  }
  sessions.push({ id: `s-${sessionIndex}`, title: `会话 ${sessionIndex}`, updatedAt: 1760000000000 + sessionIndex, messages });
}

const searchBox = { innerHTML: '', querySelectorAll() { return []; } };
const rafQueue = [];
const timerQueue = [];
const context = {
  console, sessions,
  document: {
    getElementById(id) { return id === 'sessionSearchResults' ? searchBox : null; },
    createElement() {
      let text = '';
      return {
        set textContent(value) { text = String(value); },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
      };
    }
  },
  requestAnimationFrame(callback) { rafQueue.push(callback); },
  setTimeout(callback) { timerQueue.push(callback); return timerQueue.length; },
  clearTimeout() {},
  formatTime(value) { return String(value); },
  providerPriceFor() { return { in: 1, out: 2, cache: 0.2 }; },
  WeakSet, WeakMap
};
vm.createContext(context);
vm.runInContext(extract(markdownSource, 'function escapeHtml', 'function renderMd'), context);
vm.runInContext(extract(sessionSource, 'function _markSnippet', 'function openSessionSearch'), context);
vm.runInContext(extract(markdownSource, 'const _rafPending', 'function enhanceCodeBlocks'), context);
vm.runInContext(extract(tokenSource, 'const MODEL_PRICE', 'function accumulateUsage'), context);
vm.runInContext(extract(analyticsSource, 'function aggregateSessions', '/* ---- SVG'), context);

await new Promise(resolve => setImmediate(resolve));
const searchSamples = [];
let searchChecksum = 0;
for (let run = 0; run < runCount; run++) {
  const started = performance.now();
  context.runSessionSearch('__definitely_not_present__');
  searchSamples.push(Number((performance.now() - started).toFixed(3)));
  searchChecksum += searchBox.innerHTML.length;
}

await new Promise(resolve => setImmediate(resolve));
const streamSamples = [];
let paintedFrames = 0;
let streamChecksum = 0;
for (let run = 0; run < runCount; run++) {
  const element = { innerHTML: '' };
  let content = '';
  paintedFrames = 0;
  const started = performance.now();
  for (let chunk = 0; chunk < chunkCount; chunk++) {
    content += `分片${chunk}\n`;
    context.scheduleRender(element, () => { paintedFrames++; return content; });
    context.scheduleRender(element, () => { paintedFrames++; return content; });
    const callback = rafQueue.shift();
    if (callback) callback();
    timerQueue.length = 0;
  }
  streamSamples.push(Number((performance.now() - started).toFixed(3)));
  streamChecksum += element.innerHTML.length + paintedFrames;
}

await new Promise(resolve => setImmediate(resolve));
const analyticsSamples = [];
let analyticsChecksum = 0;
const analyticsRounds = 10;
for (let run = 0; run < runCount; run++) {
  const started = performance.now();
  let snapshot;
  for (let round = 0; round < analyticsRounds; round++) {
    if (typeof context.buildAnalyticsSnapshot === 'function') {
      snapshot = context.buildAnalyticsSnapshot();
    } else {
      snapshot = {
        sessionRows: [context.aggregateSessions(), context.aggregateSessions()],
        toolRows: [context.aggregateTools(), context.aggregateTools()]
      };
    }
  }
  analyticsSamples.push(Number((performance.now() - started).toFixed(3)));
  analyticsChecksum += JSON.stringify(snapshot).length;
}

await new Promise(resolve => setImmediate(resolve));
const terminalSamples = [];
const aggregateCounts = { sessions: 0, tools: 0 };
const originalAggregateSessions = context.aggregateSessions;
const originalAggregateTools = context.aggregateTools;
context.aggregateSessions = () => { aggregateCounts.sessions++; return originalAggregateSessions(); };
context.aggregateTools = () => { aggregateCounts.tools++; return originalAggregateTools(); };
if (typeof context.buildAnalyticsSnapshot === 'function') context.buildAnalyticsSnapshot();
else {
  context.aggregateSessions(); context.aggregateSessions();
  context.aggregateTools(); context.aggregateTools();
}
let terminalRenders = 0;
let terminalChecksum = 0;
for (let run = 0; run < runCount; run++) {
  const element = { innerHTML: '' };
  terminalRenders = 0;
  const started = performance.now();
  context.scheduleRender(element, () => { terminalRenders++; return '最终完整内容'; });
  if (typeof context.flushRender === 'function') {
    context.flushRender(element);
  } else {
    element.innerHTML = (() => { terminalRenders++; return '最终完整内容'; })();
  }
  const callback = rafQueue.shift();
  if (callback) callback();
  timerQueue.length = 0;
  terminalSamples.push(Number((performance.now() - started).toFixed(3)));
  terminalChecksum += element.innerHTML.length + terminalRenders;
}

await new Promise(resolve => setImmediate(resolve));
clearInterval(eventLoopTimer);
eventLoopHistogram.disable();
const cpuDelta = process.cpuUsage(cpuBefore);
const memoryAfter = process.memoryUsage();
const processReport = {
  status: 'OK', scope: 'current-node-process',
  before: { user_ms: cpuBefore.user / 1000, kernel_ms: cpuBefore.system / 1000,
    rss_bytes: memoryBefore.rss, heap_used_bytes: memoryBefore.heapUsed },
  after: { user_ms: (cpuBefore.user + cpuDelta.user) / 1000,
    kernel_ms: (cpuBefore.system + cpuDelta.system) / 1000,
    rss_bytes: memoryAfter.rss, heap_used_bytes: memoryAfter.heapUsed },
  delta: { wall_ms: performance.now() - processStarted,
    user_ms: cpuDelta.user / 1000, kernel_ms: cpuDelta.system / 1000,
    rss_bytes: memoryAfter.rss - memoryBefore.rss,
    heap_used_bytes: memoryAfter.heapUsed - memoryBefore.heapUsed }
};
const eventLoopHistogramReport = {
  unit: 'ms', median: eventLoopHistogram.percentile(50),
  p95: eventLoopHistogram.percentile(95), p99: eventLoopHistogram.percentile(99),
  min: eventLoopHistogram.min, max: eventLoopHistogram.max
};

process.stdout.write(JSON.stringify({
  schema: 1,
  scope: 'frontend-node-vm',
  environment: {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus().map(cpu => cpu.model), logical_cores: os.cpus().length,
    total_memory_bytes: os.totalmem(), node: process.version
  },
  dataset: {
    sessions: sessionCount, messages_per_session: messagesPerSession,
    message_chars_before_prefix: messageChars, stream_chunks_per_run: chunkCount,
    schedules_per_chunk: 2, analytics_rounds_per_sample: analyticsRounds
  },
  limitations: [
    'Node VM measures JavaScript scanning/string generation and scheduler work, not WebView2 DOM layout/paint.',
    'Search result click listener binding is excluded by the minimal querySelectorAll stub.',
    'Markdown parsing/highlighting and real SSE network wait are excluded; total stream wall time cannot be inferred.'
  ],
  correctness: {
    search_checksum: searchChecksum,
    stream_checksum: streamChecksum,
    stream_frames_last_run: paintedFrames,
    expected_stream_frames: chunkCount,
    analytics_checksum: analyticsChecksum,
    analytics_aggregate_calls_per_render: aggregateCounts,
    terminal_renders_last_run: terminalRenders,
    terminal_checksum: terminalChecksum
  },
  metrics: {
    session_search_miss: summarize(searchSamples),
    stream_schedule_coalesced: summarize(streamSamples),
    analytics_render_aggregation: summarize(analyticsSamples),
    terminal_render_with_pending: summarize(terminalSamples)
  },
  process: processReport,
  event_loop_delay: summarize(eventLoopSamples),
  event_loop_histogram: eventLoopHistogramReport
}, null, 2));
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
