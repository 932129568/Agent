/**
 * 差分报告双产物（设计 §6.5）：
 *   report.json —— 机器可读（家族汇总 + 逐 call 裁决 + 双侧归一摘要 + 覆盖率）
 *   report.md   —— 人类可读（总览 / 家族汇总表 / suspect 明细 / intentional 索引 / 未覆盖清单）
 */
import fs from 'node:fs'
import path from 'node:path'

const countersOf = entries => {
  const counters = { match: 0, intentional: 0, suspect: 0, error: 0, skipped: 0 }
  for (const entry of entries) counters[entry.verdict] = (counters[entry.verdict] || 0) + 1
  return counters
}

export function buildReportJson({ runId, fixtures, startedAt, finishedAt, config, coverage }) {
  const perFixture = fixtures.map(f => ({
    id: f.fixture.id,
    family: f.fixture.family,
    description: f.fixture.description || '',
    mocks: f.fixture.mocks || [],
    error: f.error || null,
    verdicts: f.verdicts,
    counters: countersOf(f.verdicts),
  }))
  const allVerdicts = fixtures.flatMap(f => f.verdicts)
  return {
    runId,
    startedAt,
    finishedAt,
    config,
    summary: {
      fixtures: fixtures.length,
      calls: allVerdicts.length,
      methodsCoveredByFixtures: [...new Set(allVerdicts.map(v => v.method))].sort(),
      ...countersOf(allVerdicts),
    },
    coverage: coverage || null,
    fixtures: perFixture,
  }
}

function mdEscape(text) {
  return String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderMarkdown(report, uncoveredEntries) {
  const s = report.summary
  const lines = []
  lines.push(`# 跨语言差分报告 ${report.runId}`)
  lines.push('')
  lines.push(`- 运行区间：${report.startedAt} → ${report.finishedAt}`)
  lines.push(`- Python 解释器：\`${report.config.pythonBin}\`；Node：\`${report.config.nodeBin}\``)
  lines.push(`- 总览：fixtures **${s.fixtures}** / calls **${s.calls}** / match **${s.match}** / `
    + `intentional **${s.intentional}** / suspect **${s.suspect}** / error **${s.error}** / skipped **${s.skipped}**`)
  lines.push('')

  const families = [...new Set(report.fixtures.map(f => f.family))]
  lines.push('## 家族汇总')
  lines.push('')
  lines.push('| 家族 | fixture | match | intentional | suspect | error | skipped |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const family of families) {
    const rows = report.fixtures.filter(f => f.family === family)
    const c = { match: 0, intentional: 0, suspect: 0, error: 0, skipped: 0 }
    for (const row of rows) for (const [k, v] of Object.entries(row.counters)) c[k] += v
    lines.push(`| ${family} | ${rows.map(r => r.id).join(', ')} | ${c.match} | ${c.intentional} | ${c.suspect} | ${c.error} | ${c.skipped} |`)
  }
  lines.push('')

  const suspects = report.fixtures.flatMap(f => f.verdicts
    .filter(v => v.verdict === 'suspect')
    .map(v => ({ fixture: f.id, family: f.family, ...v })))
  lines.push(`## 疑似缺陷明细（suspect，${suspects.length} 项——只登记不修，交评审）`)
  lines.push('')
  if (!suspects.length) lines.push('（无）')
  for (const item of suspects) {
    lines.push(`### [${item.fixture} / ${item.callId}] ${item.method}${item.note ? ` —— ${mdEscape(item.note)}` : ''}`)
    lines.push(`- diffPath: \`${item.diffPath || '(root)'}\``)
    lines.push(`- Python: \`${mdEscape(item.pySummary)}\``)
    lines.push(`- Node: \`${mdEscape(item.nodeSummary)}\``)
    lines.push('')
  }

  const intentionals = report.fixtures.flatMap(f => f.verdicts
    .filter(v => v.verdict === 'intentional')
    .map(v => ({ fixture: f.id, ...v })))
  lines.push(`## 有意差异索引（intentional，${intentionals.length} 项）`)
  lines.push('')
  lines.push('| 登记号 | fixture / call | method | 签核状态 | 到期 |')
  lines.push('|---|---|---|---|---|')
  for (const item of intentionals) {
    lines.push(`| ${item.deltaId} | ${item.fixture} / ${item.callId} | ${item.method} | `
      + `${item.approval === 'pending' || !item.approval ? '**待签核**' : item.approval} | ${item.expires || '—'} |`)
  }
  lines.push('')

  const errors = report.fixtures.flatMap(f => {
    const out = f.verdicts.filter(v => v.verdict === 'error')
      .map(v => ({ fixture: f.id, error: `${v.callId} ${v.method}: ${v.diffPath}` }))
    if (f.error) out.unshift({ fixture: f.id, error: f.error })
    return out
  })
  if (errors.length) {
    lines.push(`## 基础设施错误（error，${errors.length} 项）`)
    lines.push('')
    for (const item of errors) lines.push(`- ${item.fixture}: \`${mdEscape(item.error)}\``)
    lines.push('')
  }

  lines.push('## 未覆盖登记（uncovered，C 类环境绑定正向路径）')
  lines.push('')
  if (!uncoveredEntries.length) lines.push('（无）')
  for (const entry of uncoveredEntries) {
    lines.push(`- \`${entry.method}\`（${entry.aspect}）：${mdEscape(entry.reason)} —— 跟踪 ${entry.tracking}（${entry.plannedPhase}）`)
  }
  lines.push('')

  if (report.coverage) {
    lines.push('## 覆盖率（静态计算：fixture 方法集 ∪ uncovered 登记）')
    lines.push('')
    lines.push(`- Node 注册表方法：${report.coverage.nodeMethods}`)
    lines.push(`- Python 公开+隐身方法：${report.coverage.pythonMethods}`)
    lines.push(`- fixture 覆盖：${report.coverage.coveredByFixtures} / uncovered 登记：${report.coverage.registeredUncovered}`)
    if (report.coverage.gaps?.length) {
      lines.push(`- **缺口 ${report.coverage.gaps.length} 个**：${report.coverage.gaps.join(', ')}`)
    } else {
      lines.push('- 缺口：0（145 方法全覆盖——门禁口径）')
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('> 本报告为 P0-4 桌面切换前的行为等价性证据。suspect 只登记不修'
    + '（修复属 P0-1b 任务）；intentional 中 `待签核` 条目经 team-lead 签核后生效。')
  return lines.join('\n')
}

export function writeReports(outDir, reportJson, reportMd) {
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(reportJson, null, 2), 'utf8')
  fs.writeFileSync(path.join(outDir, 'report.md'), reportMd, 'utf8')
  return {
    jsonPath: path.join(outDir, 'report.json'),
    mdPath: path.join(outDir, 'report.md'),
  }
}
