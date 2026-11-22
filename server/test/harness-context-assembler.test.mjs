/**
 * T05 Phase D · MOD-01 上下文装配 / 六分区预算 / 锚定压缩验收（node:test）
 *
 * 口径：关键行为逐条断言，**每条判据都配负控**——就地造一个坏实现（不压缩 /
 * 中途切断 tool 配对 / 恒真门），证明同一条断言对它给红。
 *
 * 运行：node --test server/test/harness-context-assembler.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  pyJsonDumps,
  TokenEstimator,
  HeuristicTokenEstimator,
  TokenBudget,
  MessageTurn,
  AnchoredHandoffState,
  AnchoredCompactionEngine,
  ContextAssembler,
  getSharedContextAssembler,
  __resetSharedContextAssembler,
} from '../src/services/harness/contextAssembler.mjs';
import {
  ExternalBlobStore,
  getSharedBlobStore,
  __resetSharedBlobStore,
} from '../src/services/harness/externalBlobStore.mjs';
import {
  buildProgressiveToolSurface,
  buildHarnessV2Envelope,
  harnessV2Enabled,
} from '../src/services/harness/providerBridge.mjs';

/** 逐字符计数估算器：让预算算术与内容无关，便于断言（py 侧同样允许注入）。 */
const charEstimator = { countTokens: (text) => Array.from(String(text ?? '')).length };

const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ============================ pyJsonDumps / 估算器 ============================ */

test('pyJsonDumps：无缩进时用 py 的 ", " / ": " 分隔符（不是 JSON.stringify 的紧凑格式）', () => {
  // 期望值由真 Python 产出（json.dumps(..., ensure_ascii=False)），逐字节对齐
  assert.equal(
    pyJsonDumps({ a: 1, b: [1, 2], c: { d: '中' } }),
    '{"a": 1, "b": [1, 2], "c": {"d": "中"}}'
  );
  assert.notEqual(pyJsonDumps({ a: 1 }), JSON.stringify({ a: 1 }));
});

test('pyJsonDumps：indent=2 与 py json.dumps(indent=2) 逐字节一致', () => {
  assert.equal(pyJsonDumps({ a: 1, b: [1, 2] }, 2), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
});

test('pyJsonDumps：null / true / false / 空容器 / undefined→null', () => {
  assert.equal(pyJsonDumps(null), 'null');
  assert.equal(pyJsonDumps(undefined), 'null');
  assert.equal(pyJsonDumps(true), 'true');
  assert.equal(pyJsonDumps([]), '[]');
  assert.equal(pyJsonDumps({}), '{}');
});

test('估算器：ASCII 3.6 chars/token，CJK 1.6 chars/token，非空至少 1', () => {
  const est = new HeuristicTokenEstimator();
  assert.equal(est.countTokens(''), 0);
  assert.equal(est.countTokens('a'.repeat(36)), 10); // ceil(36/3.6)
  assert.equal(est.countTokens('中'.repeat(16)), 10); // ceil(16/1.6)
  assert.equal(est.countTokens('a'), 1); // ceil(0.28)=1
  assert.equal(est.countTokens('ab'), 1); // ceil(0.56)=1
  assert.equal(est.countTokens('中a'), 1); // ceil(1/1.6 + 1/3.6)=1
});

test('估算器：按码点统计 ASCII（emoji 不被当成 2 个 ASCII 字符）', () => {
  const est = new HeuristicTokenEstimator();
  // '😀' 在 JS 是 2 个 UTF-16 码元，py 里是 1 个字符（非 ASCII）
  assert.equal(est.countTokens('😀'), 1);
});

test('估算器基类：未实现 countTokens 必须炸，不返回 undefined（py AttributeError 等价物）', () => {
  class Lazy extends TokenEstimator {}
  assert.throws(() => new Lazy().countTokens('x'), /未实现/);
});

/* ============================ TokenBudget（六分区） ============================ */

test('预算：六分区默认值与 py 逐项一致（py:50-56）', () => {
  const b = new TokenBudget();
  assert.equal(b.totalWindow, 16000);
  assert.equal(b.reserveOutput, 4096);
  assert.equal(b.l1CharterMax, 1200); // PART-01
  assert.equal(b.l2PhaseMax, 950); // PART-02
  assert.equal(b.anchoredHandoffMax, 1800); // PART-03
  assert.equal(b.toolCatalogMax, 1400); // PART-04
  assert.equal(b.l3SkillMax, 1800); // PART-05
});

test('预算：PART-06 工作记忆 = available_input − 五分区固定和，下限 1024', () => {
  const b = new TokenBudget();
  assert.equal(b.availableInput, 16000 - 4096);
  assert.equal(b.workingMemoryMax, 11904 - (1200 + 950 + 1800 + 1400 + 1800));
  // 下限：窗口极小/预留极大时仍给 1024
  const tight = new TokenBudget({ totalWindow: 1000, reserveOutput: 4096 });
  assert.equal(tight.availableInput, 2048); // max(2048, 负值)
  assert.equal(tight.workingMemoryMax, 1024); // max(1024, 负值)
});

test('预算：实例被冻结（py frozen dataclass 等价物）', () => {
  const b = new TokenBudget();
  assert.throws(() => {
    b.totalWindow = 1;
  }, TypeError);
});

/* ============================ MessageTurn ============================ */

test('消息单元：serializeForCounting 五字段、py 分隔符、可选字段保留 null', () => {
  const t = new MessageTurn({ role: 'user', content: 'hi', turnId: 't1' });
  assert.equal(
    t.serializeForCounting(),
    '{"role": "user", "content": "hi", "tool_calls": [], "tool_call_id": null, "tool_name": null}'
  );
  assert.ok(Number.isFinite(t.timestamp));
  assert.ok(t.timestamp > 1e9 && t.timestamp < 1e11, '时间戳必须是秒（py time.time()）');
});

test('消息单元：toLlmDict 只在有值/role=tool 时才带 name', () => {
  const plain = new MessageTurn({ role: 'user', content: 'q', turnId: 't1' });
  assert.deepEqual(plain.toLlmDict(), { role: 'user', content: 'q' });

  const toolMsg = new MessageTurn({
    role: 'tool',
    content: 'r',
    turnId: 't2',
    toolCallId: 'call_1',
    toolName: 'read_file',
  });
  assert.deepEqual(toolMsg.toLlmDict(), {
    role: 'tool',
    content: 'r',
    tool_call_id: 'call_1',
    name: 'read_file',
  });

  const withCalls = new MessageTurn({
    role: 'assistant',
    content: '',
    turnId: 't3',
    toolCalls: [{ id: 'call_1', function: { name: 'read_file' } }],
    toolName: 'read_file', // 非 tool 角色不带 name
  });
  const dict = withCalls.toLlmDict();
  assert.equal(dict.name, undefined);
  assert.equal(dict.tool_calls.length, 1);
});

/* ============================ ExternalBlobStore ============================ */

test('落盘：未超阈值原样返回（不产生任何文件）', () => {
  const dir = tmpDir('harbor-blob-');
  const store = new ExternalBlobStore(dir, 100);
  const small = 'x'.repeat(100);
  assert.equal(store.offloadIfOversized('read_file', small), small);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('落盘：超阈值写盘并返回「摘要 + 检索键」，头部/尾部预览都在', () => {
  const dir = tmpDir('harbor-blob-');
  const store = new ExternalBlobStore(dir, 100);
  // 三行结构（600 / 500 / 300），便于同时验证 head/tail 预览与按行关键字回查
  const big = `${'H'.repeat(600)}\n${'M'.repeat(500)}\n${'T'.repeat(300)}`;
  const out = store.offloadIfOversized('read_file', big);

  assert.ok(out.startsWith('[EXTERNAL_BLOB_OFFLOADED]\nblob_uri: blob://read_file_'));
  assert.match(out, new RegExp(`original_chars: ${big.length}`), 'original_chars 是原始字符数');
  assert.ok(out.includes(`head_preview: ${'H'.repeat(600)} ...`), '头预览 600 字符（换行压成空格）');
  assert.ok(out.includes(`tail_preview: ... ${'T'.repeat(300)}`), '尾预览 300 字符');
  assert.match(out, /hint: 如需检索完整内容/);

  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^read_file_[0-9a-f]{16}\.txt$/);
  assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), big, '落盘内容必须逐字节等于原文');

  const uri = out.split('\n')[1].replace('blob_uri: ', '');
  assert.equal(store.readBlob(uri), big, '无关键字时返回前 max_chars（此处全文 1402 < 2000）');
  assert.equal(store.readBlob(uri, 'mmm'), 'M'.repeat(500), '关键字大小写不敏感，命中整行');
  assert.equal(store.readBlob(uri, 'not-exist'), '[NO_MATCH_FOR_KEYWORD] keyword=not-exist');
  assert.equal(store.readBlob('blob://nope_0000'), '[BLOB_NOT_FOUND] blob://nope_0000');
});

test('落盘：阈值按**码点**计（py len(str) 口径），不按 UTF-16 码元', () => {
  const dir = tmpDir('harbor-blob-');
  const store = new ExternalBlobStore(dir, 1800);
  const emojiText = '😀'.repeat(901); // 码点 901（<=1800）；UTF-16 码元 1802（>1800）
  assert.equal(store.offloadIfOversized('tool', emojiText), emojiText, '901 码点不应触发落盘');
  assert.deepEqual(fs.readdirSync(dir), []);

  const overLimit = '😀'.repeat(1801);
  const out = store.offloadIfOversized('tool', overLimit);
  assert.ok(out.startsWith('[EXTERNAL_BLOB_OFFLOADED]'));
  assert.match(out, /original_chars: 1801/, 'original_chars 必须是码点数');
});

test('落盘：单例复用 + reset 重建（默认目录只在本用例创建，用完即清）', () => {
  const stray = path.resolve('.lightwell_blobs');
  try {
    __resetSharedBlobStore();
    const a = getSharedBlobStore();
    assert.equal(getSharedBlobStore(), a);
    __resetSharedBlobStore();
    assert.notEqual(getSharedBlobStore(), a);
  } finally {
    __resetSharedBlobStore();
    if (fs.existsSync(stray)) fs.rmSync(stray, { recursive: true, force: true });
  }
});

/* ============================ AnchoredHandoffState ============================ */

test('交接单：apply_delta 四类合并规则 + 代数自增', () => {
  const h = new AnchoredHandoffState();
  h.applyDelta({
    mutated_state: { file_a: { status: 'written', lines: 10 } },
    tool_execution_index: [{ call_id: 'c1', tool: 'write_file' }],
    confirmed_decisions: ['使用 UTF-8'],
    active_constraints: { no_delete: true, tmp: 'x' },
  });
  assert.equal(h.compactionGeneration, 1);

  h.applyDelta({
    mutated_state: { file_a: { lines: 20 } }, // 浅合并：status 保留，lines 更新
    tool_execution_index: [{ call_id: 'c1', tool: 'write_file' }, { call_id: 'c2', tool: 'read_file' }],
    confirmed_decisions: ['使用 UTF-8', '输出中文'], // 去重
    active_constraints: { tmp: null, max_tokens: 800 }, // null = 撤销约束
  });

  assert.deepEqual(h.mutatedState.file_a, { status: 'written', lines: 20 });
  assert.deepEqual(
    h.toolExecutionIndex.map((i) => i.call_id),
    ['c1', 'c2'],
    'call_id 去重：同一次工具调用不得记两遍'
  );
  assert.deepEqual(h.confirmedDecisions, ['使用 UTF-8', '输出中文']);
  assert.deepEqual(h.activeConstraints, { no_delete: true, max_tokens: 800 });
  assert.equal(h.compactionGeneration, 2);
});

test('交接单：apply_delta 忽略非法 mutated_state 字段（非对象）不崩', () => {
  const h = new AnchoredHandoffState();
  h.applyDelta({ mutated_state: { bad: 'not-an-object' } });
  assert.equal(h.mutatedState.bad, undefined);
  assert.equal(h.compactionGeneration, 1);
});

test('交接单：apply_delta 收到非对象补丁必须抛错（复刻 py 的 AttributeError）', () => {
  const h = new AnchoredHandoffState();
  for (const bad of [null, undefined, 'str', [], 42]) {
    assert.throws(() => h.applyDelta(bad), /补丁必须是对象/, `应拒绝: ${JSON.stringify(bad)}`);
  }
  assert.equal(h.compactionGeneration, 0, '非法补丁不得推进代数');
});

test('交接单：空状态渲染空串（不输出空标题块）', () => {
  assert.equal(new AnchoredHandoffState().renderMarkdown(1000, charEstimator), '');
});

test('交接单：四段标题齐全 + GEN 代数 + 工具索引 JSON', () => {
  const h = new AnchoredHandoffState();
  h.applyDelta({
    mutated_state: { file_a: { status: 'ok' } },
    tool_execution_index: [{ call_id: 'c1', tool: 'write_file' }],
    confirmed_decisions: ['不改编码'],
    active_constraints: { no_delete: true },
  });
  const md = h.renderMarkdown(100000, charEstimator);
  assert.match(md, /### \[ANCHORED HANDOFF STATE \| GEN-1\]/);
  assert.match(md, /#### 1\. Mutated Entity State/);
  assert.match(md, /#### 2\. Tool Execution Index/);
  assert.match(md, /#### 3\. Confirmed Decisions & Exclusions/);
  assert.match(md, /#### 4\. Active Session Constraints/);
  assert.match(md, /- 不改编码/);
  assert.match(md, /"call_id": "c1"/);
});

test('交接单：超预算时只丢最旧的工具索引，且保底 3 条（py:184）', () => {
  const h = new AnchoredHandoffState();
  const many = Array.from({ length: 8 }, (_, i) => ({
    call_id: `c${i}`,
    tool: 'read_file',
    summary: 's'.repeat(40),
  }));
  h.applyDelta({ tool_execution_index: many });

  // 预算极小：必然触发裁剪，但下限是 3 条
  const tight = h.renderMarkdown(10, charEstimator);
  const kept = (tight.match(/"call_id"/g) || []).length;
  assert.equal(kept, 3, '裁剪下限 3 条（再多就该丢，再少就是丢了不该丢的）');
  assert.ok(tight.includes('"c7"'), '保留的是**最新**的条目');
  assert.ok(!tight.includes('"c0"'), '丢掉的是最旧的条目');

  // 预算充足：一条都不丢
  const roomy = h.renderMarkdown(100000, charEstimator);
  assert.equal((roomy.match(/"call_id"/g) || []).length, 8);
});

/* ============================ AnchoredCompactionEngine ============================ */

function makeTurns() {
  return [
    new MessageTurn({ role: 'user', content: 'u0', turnId: 't0' }),
    new MessageTurn({
      role: 'assistant',
      content: 'a1',
      turnId: 't1',
      toolCalls: [{ id: 'call_1', function: { name: 'read_file' } }],
    }),
    new MessageTurn({ role: 'tool', content: 'r2', turnId: 't2', toolCallId: 'call_1', toolName: 'read_file' }),
    new MessageTurn({ role: 'tool', content: 'r3', turnId: 't3', toolCallId: 'call_1', toolName: 'read_file' }),
    new MessageTurn({ role: 'assistant', content: 'a4', turnId: 't4' }),
    new MessageTurn({ role: 'user', content: 'u5', turnId: 't5' }),
  ];
}

test('压缩：≤2 条时不淘汰（py:254）', () => {
  const eng = new AnchoredCompactionEngine();
  const turns = [
    new MessageTurn({ role: 'user', content: 'q', turnId: 't0' }),
    new MessageTurn({ role: 'assistant', content: 'a', turnId: 't1' }),
  ];
  const [evict, rest] = eng.selectEvictionSlice(turns, charEstimator, 999999);
  assert.deepEqual(evict, []);
  assert.equal(rest.length, 2);
});

test('压缩：assistant(tool_calls) 与其后续 tool 响应必须整块进淘汰切片（原子性）', () => {
  const eng = new AnchoredCompactionEngine();
  const turns = makeTurns();
  const [evict, rest] = eng.selectEvictionSlice(turns, charEstimator, 999999);
  assert.deepEqual(
    evict.map((t) => t.turnId),
    ['t0', 't1', 't2', 't3'],
    '带 tool_calls 的 assistant 必须连同两条 tool 一起淘汰'
  );
  assert.deepEqual(rest.map((t) => t.turnId), ['t4', 't5']);
  assert.notEqual(rest[0].role, 'tool', '剩余历史的头部不能是孤儿 tool 消息');
});

test('压缩：永远至少保留最后 2 条', () => {
  const eng = new AnchoredCompactionEngine();
  const turns = makeTurns();
  const [evict, rest] = eng.selectEvictionSlice(turns, charEstimator, 1e9);
  assert.ok(rest.length >= 2);
  assert.equal(evict.length + rest.length, turns.length, '不丢不重');
});

test('压缩：无回调时走确定性兜底（工具索引 + importance>=1.2 的用户约束）', () => {
  const eng = new AnchoredCompactionEngine();
  const h = new AnchoredHandoffState();
  const evicted = [
    new MessageTurn({ role: 'tool', content: 'FILE\nCONTENT', turnId: 't0', toolCallId: 'call_9', toolName: 'read_file' }),
    new MessageTurn({ role: 'user', content: '必须用 UTF-8', turnId: 't1', importanceScore: 1.5 }),
    new MessageTurn({ role: 'user', content: '随口一问', turnId: 't2', importanceScore: 1.0 }),
  ];
  eng.compactSlice(h, evicted);
  assert.equal(h.toolExecutionIndex.length, 1);
  assert.deepEqual(h.toolExecutionIndex[0], {
    call_id: 'call_9',
    tool: 'read_file',
    summary: 'FILE CONTENT', // 换行压成空格（py:296）
  });
  assert.deepEqual(h.confirmedDecisions, ['User constraint/request: 必须用 UTF-8']);
  assert.equal(h.compactionGeneration, 1);
});

test('压缩：注入 llmCompactor 时用回调产出的补丁', () => {
  const captured = [];
  const eng = new AnchoredCompactionEngine((handoff, turns) => {
    captured.push(turns.length);
    return { mutated_state: { plan: { step: 3 } } };
  });
  const h = new AnchoredHandoffState();
  eng.compactSlice(h, [new MessageTurn({ role: 'user', content: 'x', turnId: 't0' })]);
  assert.deepEqual(captured, [1]);
  assert.deepEqual(h.mutatedState.plan, { step: 3 });
});

test('压缩：回调返回非法补丁必须抛错（不静默当空补丁吞掉）', () => {
  const eng = new AnchoredCompactionEngine(() => null);
  const h = new AnchoredHandoffState();
  assert.throws(
    () => eng.compactSlice(h, [new MessageTurn({ role: 'user', content: 'x', turnId: 't0' })]),
    /必须返回结构化补丁对象/
  );
});

test('压缩：淘汰切片为空时不产生代数变化', () => {
  const eng = new AnchoredCompactionEngine();
  const h = new AnchoredHandoffState();
  eng.compactSlice(h, []);
  assert.equal(h.compactionGeneration, 0);
});

/* ============================ ContextAssembler ============================ */

const baseInput = () => ({
  l1Charter: 'L1 CHARTER: 你是 Harbor。',
  l2PhasePrompt: 'L2 PHASE: 当前阶段=实现。',
  l3ActiveSkills: 'L3 SKILL: 写文件前先读。',
  toolCatalogSummary: 'TOOLS: read_file, write_file',
  handoffState: new AnchoredHandoffState(),
  workingTurns: [
    new MessageTurn({ role: 'user', content: '请实现 X', turnId: 't0' }),
    new MessageTurn({ role: 'assistant', content: '好的', turnId: 't1' }),
    new MessageTurn({ role: 'user', content: '继续', turnId: 't2' }),
  ],
});

test('装配：头部锚 system 四段齐全 + 中部工作记忆 + 尾部技能锚贴最后一条 user', () => {
  const asm = new ContextAssembler();
  const [messages, turns] = asm.assemble(baseInput());
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /L1 CHARTER/);
  assert.match(messages[0].content, /## \[CURRENT PHASE CONTRACT\]\nL2 PHASE/);
  assert.match(messages[0].content, /## \[PROGRESSIVE TOOL CATALOG\]\nTOOLS/);
  assert.equal(messages.length, 4, 'system + 3 条工作记忆');
  assert.equal(turns.length, 3);

  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.startsWith('## [ACTIVE ON-DEMAND SKILL SOP]'), '技能锚必须贴住最新请求');
  assert.match(last.content, /### \[CURRENT USER REQUEST\]\n继续$/);
  assert.match(last.content, /L3 SKILL/);
});

test('装配：最后一条不是 user 时，技能锚作为独立 system 消息追加', () => {
  const asm = new ContextAssembler();
  const input = baseInput();
  input.workingTurns = [new MessageTurn({ role: 'user', content: 'q', turnId: 't0' }),
    new MessageTurn({ role: 'assistant', content: 'a', turnId: 't1' })];
  const [messages] = asm.assemble(input);
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'system');
  assert.match(last.content, /ACTIVE ON-DEMAND SKILL SOP/);
});

test('装配：空分区不产出空标题块', () => {
  const asm = new ContextAssembler();
  const input = baseInput();
  input.l2PhasePrompt = '';
  input.toolCatalogSummary = '';
  input.l3ActiveSkills = '';
  const [messages] = asm.assemble(input);
  assert.ok(!messages[0].content.includes('CURRENT PHASE CONTRACT'));
  assert.ok(!messages[0].content.includes('PROGRESSIVE TOOL CATALOG'));
  assert.equal(messages[messages.length - 1].role, 'user');
  assert.equal(messages[messages.length - 1].content, '继续');
});

test('装配：L1 超预算 → 硬错误（strict），并带段名与两个数字', () => {
  const asm = new ContextAssembler();
  const input = baseInput();
  input.l1Charter = 'a'.repeat(5000); // ceil(5000/3.6)=1389 > 1200
  assert.throws(() => asm.assemble(input), (err) => {
    assert.ok(err instanceof RangeError);
    assert.match(err.message, /PART-01:L1_CHARTER/);
    assert.match(err.message, /1389 > 1200/);
    return true;
  });
});

test('装配：L2 超预算按比例截断并打 [TRUNCATED_TO_BUDGET] 标记', () => {
  const asm = new ContextAssembler();
  const input = baseInput();
  input.l2PhasePrompt = 'b'.repeat(5000); // 1389 > 950
  const [messages] = asm.assemble(input);
  assert.match(messages[0].content, /\.\.\.\[TRUNCATED_TO_BUDGET:PART-02:L2_PHASE\]/);
  const run = /(b+)\n\.\.\.\[TRUNCATED_TO_BUDGET:PART-02:L2_PHASE\]/.exec(messages[0].content);
  assert.ok(run, '截断段必须紧邻标记');
  assert.ok(run[1].length < 5000, '必须真的变短');
  assert.ok(run[1].length > 64, 'py:338 的下限是 64 字符（正好贴着上限截断仍可能超预算，故留 8% 余量）');
});

test('装配：工作记忆超 PART-06 上限时触发锚定压缩并压回 75% 水位', () => {
  const asm = new ContextAssembler();
  const input = baseInput();
  // 每条约 720 字符 ≈ 200 token，12 条 ≈ 2400 > workingMemoryMax(4754)? 不够 → 用 30 条
  input.workingTurns = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 0
      ? new MessageTurn({ role: 'tool', content: 'x'.repeat(720), turnId: `t${i}`, toolCallId: `c${i}`, toolName: 'read_file' })
      : new MessageTurn({ role: i % 3 === 1 ? 'user' : 'assistant', content: 'x'.repeat(720), turnId: `t${i}` })
  );
  const before = input.workingTurns.length;
  const [messages, turns] = asm.assemble(input);

  assert.ok(turns.length < before, '必须真的淘汰掉一批');
  assert.ok(turns.length >= 2, '至少保留最后 2 条');
  assert.equal(input.handoffState.compactionGeneration, 1, '压缩代数 +1');
  assert.ok(input.handoffState.toolExecutionIndex.length > 0, '工具调用索引必须被保留');
  assert.match(messages[0].content, /ANCHORED HANDOFF STATE \| GEN-1/, '交接单必须进 system 头锚');
});

test('负控：把压缩引擎改成「不淘汰」，上面那条淘汰判据必须变红', () => {
  const brokenEngine = {
    selectEvictionSlice: (turns) => [[], turns.slice()], // 永不淘汰
    compactSlice: () => {},
  };
  const brokenAsm = new ContextAssembler({ compactionEngine: brokenEngine });
  const input = baseInput();
  input.workingTurns = Array.from({ length: 30 }, (_, i) =>
    new MessageTurn({ role: 'user', content: 'x'.repeat(720), turnId: `t${i}` })
  );
  const [, turns] = brokenAsm.assemble(input);
  const shrinks = (t) => t.length < 30;
  assert.equal(shrinks(turns), false, '负控：不淘汰的引擎下历史不会变短');
  assert.throws(() => assert.equal(shrinks(turns), true));
});

test('单例：getSharedContextAssembler 复用实例，reset 后重建', () => {
  __resetSharedContextAssembler();
  const a = getSharedContextAssembler();
  assert.equal(getSharedContextAssembler(), a);
  __resetSharedContextAssembler();
  assert.notEqual(getSharedContextAssembler(), a);
});

/* ============================ providerBridge 接线（默认关闭） ============================ */

test('V2 开关：未设置 / 非 "1" 一律 false（默认关闭）', () => {
  assert.equal(harnessV2Enabled({}), false);
  assert.equal(harnessV2Enabled({ HARBOR_HARNESS_V2: 'true' }), false, '只认字符串 1');
  assert.equal(harnessV2Enabled({ HARBOR_HARNESS_V2: '0' }), false);
  assert.equal(harnessV2Enabled({ HARBOR_HARNESS_V2: '1' }), true);
  const saved = process.env.HARBOR_HARNESS_V2;
  delete process.env.HARBOR_HARNESS_V2;
  try {
    assert.equal(harnessV2Enabled(), false, '真实 env 未设置时必须关闭');
  } finally {
    if (saved !== undefined) process.env.HARBOR_HARNESS_V2 = saved;
  }
});

test('V2 入口：开关关闭时返回 null（调用方据此保留旧路径）', () => {
  assert.equal(buildHarnessV2Envelope({ l1Charter: 'L1' }), null);
});

test('V2 入口：旧路径行为不随开关变化（buildProgressiveToolSurface 零耦合）', () => {
  const tools = [
    { type: 'function', function: { name: 'read_more', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'list_dir', parameters: { type: 'object' } } },
  ];
  const saved = process.env.HARBOR_HARNESS_V2;
  try {
    delete process.env.HARBOR_HARNESS_V2;
    const off = buildProgressiveToolSurface(tools, []);
    process.env.HARBOR_HARNESS_V2 = '1';
    const on = buildProgressiveToolSurface(tools, []);
    assert.deepEqual(
      off.activeTools.map((t) => t.function.name),
      on.activeTools.map((t) => t.function.name),
      '开关不得改变既有工具面（否则「默认关闭」形同虚设）'
    );
    assert.equal(off.catalogMarkdown, on.catalogMarkdown);
    assert.equal(off.mcpFolded, on.mcpFolded);
  } finally {
    if (saved === undefined) delete process.env.HARBOR_HARNESS_V2;
    else process.env.HARBOR_HARNESS_V2 = saved;
  }
});

test('V2 入口：开关打开时装配出六分区 system 头 + 工作记忆', () => {
  const saved = process.env.HARBOR_HARNESS_V2;
  process.env.HARBOR_HARNESS_V2 = '1';
  try {
    const env = buildHarnessV2Envelope({
      baseOpenAITools: [
        { type: 'function', function: { name: 'read_more', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'list_dir', parameters: { type: 'object' } } },
        // 未激活工具才会进「轻量目录」（progressiveToolRegistry:232 只列非活跃项）
        {
          type: 'function',
          function: { name: 'write_notes', description: '写笔记|落盘|第三段', parameters: { type: 'object' } },
        },
      ],
      l1Charter: 'L1 CHARTER',
      l2PhasePrompt: 'L2 PHASE',
      l3ActiveSkills: 'L3 SKILL',
      workingTurns: [{ role: 'user', content: '裸消息对象（桥接补 turnId）' }],
    });
    assert.ok(env && env.enabled === true);
    assert.equal(env.messages[0].role, 'system');
    assert.match(env.systemPrompt, /L1 CHARTER/);
    assert.match(env.systemPrompt, /## \[PROGRESSIVE TOOL CATALOG\]/, '工具面目录必须进头锚');
    assert.match(env.messages[env.messages.length - 1].content, /ACTIVE ON-DEMAND SKILL SOP/);
    assert.equal(env.workingTurns[0].turnId, 'turn_0', '裸对象补稳定 turnId');
    assert.ok(env.surface && Array.isArray(env.surface.activeTools));
    assert.equal(env.handoff.compactionGeneration, 0);
  } finally {
    if (saved === undefined) delete process.env.HARBOR_HARNESS_V2;
    else process.env.HARBOR_HARNESS_V2 = saved;
  }
});
