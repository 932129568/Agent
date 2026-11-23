// R101 T05 · Harness V2 代理层接线用例
//
// 守三件事：
//   ① 默认关闭时 **逐字节透传**（不能被 JSON 重序列化悄悄改掉格式/顺序）
//   ② 开启时确实装配（messages 被替换、mcp 工具从 tools 里摘出）
//   ③ 任何异常路径都**不阻断转发**（退回原始 body）
// 第 ③ 条用「装配器必抛」的负控来证明：若把 try/catch 去掉，该用例必红。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rewriteChatBodyWithHarnessV2,
  harnessV2Enabled,
} from '../src/services/harness/providerBridge.mjs';

const ON = { HARBOR_HARNESS_V2: '1' };
const OFF = {};

function chatBody(extra = {}) {
  return JSON.stringify({
    model: 'test-model',
    stream: true,
    messages: [
      { role: 'system', content: '你是 Harbor 助手，遵守最小权限原则。' },
      { role: 'user', content: '把 /tmp/a.txt 的内容读出来' },
    ],
    // 必须含 ALWAYS_ACTIVE_READONLY_NAMES 里的硬性常驻项（read_more 缺失会 fail-closed），
    // 否则 buildProgressiveToolSurface 直接抛 V4H_GHOST_ALWAYS_ACTIVE_TOOLS。
    tools: [
      { type: 'function', function: { name: 'read_more', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'list_dir', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'mcp__files__stat', parameters: { type: 'object' } } },
    ],
    ...extra,
  });
}

test('开关只认 1：true/yes 一律视为关闭', () => {
  assert.equal(harnessV2Enabled({ HARBOR_HARNESS_V2: '1' }), true);
  assert.equal(harnessV2Enabled({ HARBOR_HARNESS_V2: 'true' }), false);
  assert.equal(harnessV2Enabled({ HARBOR_HARNESS_V2: 'yes' }), false);
  assert.equal(harnessV2Enabled({}), false);
});

test('关闭时逐字节透传（不做任何 JSON 重序列化）', () => {
  // 刻意用非标准间隔与键序：若被 parse+stringify 过一遍，字节必然变化
  const raw = '{"messages":[{"role":"user","content":"x"}],   "model":"m","stream":false}';
  const r = rewriteChatBodyWithHarnessV2(raw, { env: OFF });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(r.body, raw, '关闭时 body 必须原样返回');
});

test('开启时装配：messages 被替换、mcp 工具摘出 tools', () => {
  const r = rewriteChatBodyWithHarnessV2(chatBody(), { env: ON });
  assert.equal(r.applied, true, 'reason=' + r.reason);
  const out = JSON.parse(r.body);
  assert.ok(Array.isArray(out.messages) && out.messages.length >= 1);
  assert.ok(out.messages.some((m) => m.role === 'system'), '装配结果必须含 system 段');
  // l1 charter 的内容必须进得去（不是被丢掉）
  assert.ok(r.body.includes('最小权限原则'), 'L1 正文丢失');
  // mcp 工具必须从 tools 里摘出（渐进式工具面的口径）
  assert.ok(Array.isArray(out.tools), 'tools 应存在');
  assert.ok(!out.tools.some((t) => String(t?.function?.name || '').startsWith('mcp__')),
    'mcp__ 工具不应留在 tools 里');
});

test('开启时显式登记三个无来源字段（不许假装完整）', () => {
  const r = rewriteChatBodyWithHarnessV2(chatBody(), { env: ON });
  assert.equal(r.applied, true);
  assert.deepEqual(r.dropped.filter((x) => /^(l2|l3|handoff)/.test(x)).sort(),
    ['handoff:no-source', 'l2:no-source', 'l3:no-source']);
  assert.ok(r.dropped.every((x) => x !== 'l1:no-system-message'), '本次有 system 段，不该报 l1 缺失');
});

test('无 system 段时登记 l1:no-system-message', () => {
  // 保留完整 tools（否则会先撞常驻工具 fail-closed，测不到 l1 这一条）
  const base = JSON.parse(chatBody());
  const raw = JSON.stringify({ ...base, messages: [{ role: 'user', content: 'hi' }] });
  const r = rewriteChatBodyWithHarnessV2(raw, { env: ON });
  assert.equal(r.applied, true, 'reason=' + r.reason);
  assert.ok(r.dropped.includes('l1:no-system-message'));
});

test('非 JSON / 非对象 / 无 messages 一律退回原 body', () => {
  for (const [raw, reason] of [
    ['not json at all', 'not-json'],
    ['[]', 'not-object'],
    ['{"model":"m"}', 'no-messages'],
    ['{"messages":[]}', 'no-messages'],
    ['', 'empty'],
  ]) {
    const r = rewriteChatBodyWithHarnessV2(raw, { env: ON });
    assert.equal(r.applied, false, raw + ' 不该被装配');
    assert.equal(r.reason, reason, raw + ' -> ' + r.reason);
    assert.equal(r.body, raw, '失败路径必须原样返回 body');
  }
});

test('负控：装配器抛错时必须退回原 body（不许把异常抛给转发层）', () => {
  const raw = chatBody();
  const boom = { assemble() { throw new Error('assembler exploded'); } };
  const r = rewriteChatBodyWithHarnessV2(raw, { env: ON, assembler: boom });
  assert.equal(r.applied, false);
  assert.match(r.reason, /^assemble-threw:/);
  assert.equal(r.body, raw, '装配失败必须原样透传');
});

test('Buffer 输入也能处理（代理层拿到的是 Buffer）', () => {
  const r = rewriteChatBodyWithHarnessV2(Buffer.from(chatBody(), 'utf8'), { env: ON });
  assert.equal(r.applied, true);
  const out = JSON.parse(r.body);
  assert.ok(out.messages.length >= 1);
});

test('负控：缺 read_more 必须 fail-closed（不许装配出不完整的工具面）', () => {
  const raw = JSON.stringify({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'read_file' } }],
  });
  const r = rewriteChatBodyWithHarnessV2(raw, { env: ON });
  assert.equal(r.applied, false, '缺硬性常驻工具时不该装配成功');
  assert.match(r.reason, /GHOST_ALWAYS_ACTIVE|assemble-threw/);
  assert.equal(r.body, raw);
});
