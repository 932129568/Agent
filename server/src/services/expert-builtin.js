/**
 * 内置专家包导入器（P0-1c E1：backend/domains/expert/builtin_importer.py 同构移植）。
 *
 * 流程：发现（backend/experts_builtin/ 排序目录 × METADATA_PATHS 探测）→
 * 消毒（skills 缺省发现 / team displayName+profession / 字段白名单）→
 * 转换（plugin.json 重序列化 + settings + agents/skills frontmatter 归一 +
 * references/templates/scripts 原样复制）→ 复用 experts.js 既有严格导入路径
 * （source.builtin 标记；AGENT_LIMIT_INTERSECTED 等 warnings 由校验自然产出）。
 *
 * 幂等：模块级 once 标志（Python _BUILTIN_EXPERTS_READY 同构）；单包失败
 * warning 继续，registry 初始化不崩溃。
 *
 * 打包（P0-4 交接）：目录可用 HARBOR_BUILTIN_EXPERTS_DIR 覆盖（生产入口不设置；
 * 缺省 = server/../backend/experts_builtin）。转换字节与 Python 逐字节一致
 * （jsonio indent=2 + \n；frontmatter 归一算法同构）→ 快照 digest 双侧相同。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(HERE, '..', '..')
const DEFAULT_BUILTIN_DIR = path.resolve(SERVER_ROOT, '..', 'backend', 'experts_builtin')

const METADATA_PATHS = ['.codebuddy-plugin/plugin.json', '.workbuddy-plugin/plugin.json', 'plugin.json']
const SETTINGS_PATHS = ['.codebuddy-plugin/settings.json', '.workbuddy-plugin/settings.json', 'settings.json']
const METADATA_FIELDS = new Set(['name', 'version', 'description', 'author', 'expertType', 'agentName',
  'teamInfo', 'agents', 'skills', 'displayName', 'profession', 'displayDescription', 'categoryId',
  'tags', 'quickPrompts', 'defaultInitPrompt', 'members', 'settings', 'limits',
  'icon', 'avatar', 'homepage', 'license', 'repository', 'preview', 'resources'])
const AGENT_FRONTMATTER_FIELDS = new Set(['name', 'description', 'displayName', 'profession', 'maxTurns'])
const SKILL_FRONTMATTER_FIELDS = new Set(['name', 'description'])
const SECRET_NAMES = new Set(['.env', 'credentials.json', 'secrets.json', 'id_rsa', 'id_dsa'])
const SECRET_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.kdbx']
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml'])
const MAX_FILE_BYTES = 1024 * 1024

/* ---------------- WorkBuddy 受限 frontmatter 解析/序列化（逐字节同构） ---------------- */

function parseScalar(raw) {
  const value = raw.trim()
  if (!value) throw new Error('empty frontmatter value')
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return parseInt(value, 10)
  if (value.startsWith('"') && value.endsWith('"')) {
    const parsed = JSON.parse(value)
    if (typeof parsed !== 'string') throw new Error('quoted frontmatter value must be a string')
    return parsed
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function parseFrontmatter(text, label) {
  const normalized = text.replace(/\r\n/g, '\n')
  if (normalized.includes('\r')) throw new Error(`${label} contains a bare CR newline`)
  const lines = normalized.split('\n')
  if (!lines.length || lines[0] !== '---') throw new Error(`${label} must start with frontmatter`)
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { end = i; break }
  }
  if (end === -1) throw new Error(`${label} has unclosed frontmatter`)
  const front = lines.slice(1, end)
  const result = {}
  let index = 0
  let mode = null
  let lastScalarKey = null
  while (index < front.length) {
    const line = front[index]
    if (!line.trim() || line.trimStart().startsWith('#')) { index += 1; continue }
    if (line.startsWith(' ')) {
      if (mode === 'scalar' && lastScalarKey !== null) {
        const stripped = line.trim()
        if (stripped) result[lastScalarKey] = `${result[lastScalarKey]} ${stripped}`
        index += 1
        continue
      }
      throw new Error(`${label} has invalid frontmatter indentation at line ${index + 2}`)
    }
    if (!line.includes(':')) throw new Error(`${label} has an invalid frontmatter entry at line ${index + 2}`)
    const colonAt = line.indexOf(':')
    const key = line.slice(0, colonAt).trim()
    if (!key || key in result) throw new Error(`${label} has an invalid or duplicate key: ${key}`)
    const raw = line.slice(colonAt + 1).trim()
    if (raw === '|' || raw === '|-') {
      const block = []
      index += 1
      while (index < front.length) {
        const child = front[index]
        if (child && !child.startsWith('  ')) break
        block.push(child.startsWith('  ') ? child.slice(2) : '')
        index += 1
      }
      result[key] = block.join('\n') + (raw === '|' ? '\n' : '')
      mode = 'block'
      lastScalarKey = null
      continue
    }
    if (raw === '') {
      const block = []
      index += 1
      while (index < front.length && front[index].startsWith('  ')) {
        block.push(front[index].slice(2))
        index += 1
      }
      if (block.length && block.every(item => item.startsWith('- '))) {
        result[key] = block.map(item => parseScalar(item.slice(2)))
      } else if (block.length && block.every(item => item.includes(':')
          && !item.startsWith(' ') && item.slice(item.indexOf(':') + 1).trim())) {
        const mapping = {}
        for (const item of block) {
          const childColon = item.indexOf(':')
          const childKey = item.slice(0, childColon).trim()
          if (!childKey || childKey in mapping) throw new Error(`${label} has invalid or duplicate map key: ${childKey}`)
          mapping[childKey] = parseScalar(item.slice(childColon + 1))
        }
        result[key] = mapping
      } else {
        result[key] = { __raw__: block.join('\n') }
      }
      mode = 'map'
      lastScalarKey = null
      continue
    }
    result[key] = parseScalar(raw)
    mode = 'scalar'
    lastScalarKey = key
    index += 1
  }
  const body = lines.slice(end + 1).join('\n')
  return { fields: result, body: normalized.endsWith('\n') && body ? `${body}\n` : body }
}

function frontmatterScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isInteger(value)) return String(value)
  if (typeof value !== 'string') throw new Error('frontmatter scalar must be string/int/bool')
  return JSON.stringify(value)
}

function serializeFrontmatter(fields, allowed, label) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const childKey of Object.keys(value)) {
        if (childKey !== 'en' && childKey !== 'zh') throw new Error(`${label} ${key} map supports only en/zh`)
      }
      for (const child of Object.values(value)) {
        if (typeof child !== 'string') throw new Error(`${label} ${key} map values must be strings`)
      }
      lines.push(`${key}:`)
      for (const [childKey, child] of Object.entries(value)) {
        lines.push(`  ${childKey}: ${frontmatterScalar(child)}`)
      }
    } else {
      lines.push(`${key}: ${frontmatterScalar(value)}`)
    }
  }
  lines.push('---')
  return `${lines.join('\n')}\n`
}

function normalizeMarkdown(file, allowed, overrides = null) {
  const label = file.replace(/\\/g, '/')
  const text = fs.readFileSync(file, 'utf8')
  const { fields, body } = parseFrontmatter(text, label)
  if (overrides) Object.assign(fields, overrides)
  return serializeFrontmatter(fields, allowed, label) + body
}

/* ---------------- 转换与导入 ---------------- */

const readJsonFile = (file, label) => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must contain a JSON object`)
  return value
}

/** jsonio._write_json 同构：indent=2 + ensure_ascii=False + 尾随 \n（newline='\n'）。 */
async function writeJsonFile(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
}

function safeRelative(declared, field) {
  const value = String(declared || '').trim()
  if (!value) throw new Error(`${field} must be a non-empty relative path`)
  const raw = value.replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || raw.split('/')[0].includes(':')) {
    throw new Error(`${field} must not be absolute or contain a drive`)
  }
  const parts = raw.split('/').filter(part => part !== '' && part !== '.')
  if (!parts.length || parts.some(part => part === '..')) {
    throw new Error(`${field} must stay inside the builtin package`)
  }
  return parts.join('/')
}

function metadataFile(root) {
  for (const relative of METADATA_PATHS) {
    const candidate = path.join(root, ...relative.split('/'))
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return relative
  }
  throw new Error('builtin package is missing plugin.json')
}

function isSecret(file) {
  const name = path.basename(file).toLowerCase()
  return SECRET_NAMES.has(name) || SECRET_SUFFIXES.some(ext => name.endsWith(ext))
}

function sanitizeMetadata(root, metadata) {
  const sanitized = JSON.parse(JSON.stringify(metadata))
  const packageName = sanitized.name
  if (typeof packageName !== 'string' || !packageName) {
    throw new Error('builtin metadata is missing name')
  }
  if (!sanitized.skills || (Array.isArray(sanitized.skills) && !sanitized.skills.length)) {
    const discovered = []
    const skillsRoot = path.join(root, 'skills')
    if (fs.existsSync(skillsRoot) && fs.statSync(skillsRoot).isDirectory()) {
      for (const entry of fs.readdirSync(skillsRoot).sort()) {
        if (fs.existsSync(path.join(skillsRoot, entry, 'SKILL.md'))) discovered.push(`./skills/${entry}`)
      }
    }
    sanitized.skills = discovered
  } else if (typeof sanitized.skills === 'string') {
    sanitized.skills = [sanitized.skills]
  }
  if (sanitized.expertType === 'team') {
    let display = sanitized.displayName
    if (!display || typeof display !== 'object' || Array.isArray(display)
        || Object.keys(display).some(key => key !== 'en' && key !== 'zh')) {
      display = { en: packageName, zh: packageName }
    }
    sanitized.displayName = JSON.parse(JSON.stringify(display))
    // Harbor team schema requires displayName and profession to match
    sanitized.profession = JSON.parse(JSON.stringify(display))
  }
  const allowed = {}
  for (const [key, value] of Object.entries(sanitized)) {
    if (METADATA_FIELDS.has(key) || key.startsWith('x-harbor-')) allowed[key] = value
  }
  if (!('agents' in allowed)) allowed.agents = './agents/'
  return allowed
}

async function copyAgents(root, destination, metadata) {
  const declared = metadata.agents || './agents/'
  const items = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(items)) throw new Error('builtin agents declaration must be a string or list')
  for (const item of items) {
    const relative = safeRelative(item, 'agents')
    const source = path.join(root, ...relative.split('/'))
    if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      if (!source.endsWith('.md')) throw new Error(`builtin agent must be Markdown: ${relative}`)
      const target = path.join(destination, ...relative.split('/'))
      const normalized = normalizeMarkdown(source, AGENT_FRONTMATTER_FIELDS)
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.copyFile(source, target)
      await fsp.writeFile(target, normalized, { encoding: 'utf8' })
    } else if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
      for (const entry of fs.readdirSync(source).sort()) {
        if (!entry.endsWith('.md')) continue
        const agentRelative = `${relative.replace(/\/$/, '')}/${entry}`
        const agentSource = path.join(root, ...agentRelative.split('/'))
        const agentTarget = path.join(destination, ...agentRelative.split('/'))
        const normalized = normalizeMarkdown(agentSource, AGENT_FRONTMATTER_FIELDS)
        await fsp.mkdir(path.dirname(agentTarget), { recursive: true })
        await fsp.copyFile(agentSource, agentTarget)
        await fsp.writeFile(agentTarget, normalized, { encoding: 'utf8' })
      }
    } else {
      throw new Error(`builtin agent path is missing: ${relative}`)
    }
  }
}

async function copySkill(root, destination, declared) {
  const relative = safeRelative(declared, 'skills')
  const source = path.join(root, ...relative.split('/'))
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`builtin skill directory is missing: ${relative}`)
  }
  const skillSource = path.join(source, 'SKILL.md')
  if (!fs.existsSync(skillSource) || !fs.statSync(skillSource).isFile()) {
    throw new Error(`builtin skill is missing SKILL.md: ${relative}`)
  }
  const skillTarget = path.join(destination, ...relative.split('/'), 'SKILL.md')
  const skillName = relative.replace(/\/$/, '').split('/').pop()
  const normalized = normalizeMarkdown(skillSource, SKILL_FRONTMATTER_FIELDS, { name: skillName })
  await fsp.mkdir(path.dirname(skillTarget), { recursive: true })
  await fsp.copyFile(skillSource, skillTarget)
  await fsp.writeFile(skillTarget, normalized, { encoding: 'utf8' })
  // references/templates/scripts：限尺寸 + 秘密过滤，原样复制（不归一）
  for (const kind of ['references', 'templates', 'scripts']) {
    const resourceRoot = path.join(source, kind)
    if (!fs.existsSync(resourceRoot) || !fs.statSync(resourceRoot).isDirectory()) continue
    for (const base of walkFiles(resourceRoot)) {
      if (!TEXT_EXTENSIONS.has(path.extname(base).toLowerCase())) continue
      if (fs.statSync(base).size > MAX_FILE_BYTES || isSecret(base)) continue
      const resourceRelative = path.relative(root, base).split(path.sep).join('/')
      const target = path.join(destination, ...resourceRelative.split('/'))
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.copyFile(base, target)
    }
  }
}

function walkFiles(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

async function copySettings(root, destination, metadata) {
  for (const relative of SETTINGS_PATHS) {
    const source = path.join(root, ...relative.split('/'))
    if (fs.existsSync(source) && fs.statSync(source).isFile()) {
      const value = readJsonFile(source, relative)
      await writeJsonFile(path.join(destination, ...relative.split('/')), value)
      return relative
    }
  }
  if (metadata.expertType === 'team') {
    const generated = '.codebuddy-plugin/settings.json'
    await writeJsonFile(path.join(destination, ...generated.split('/')), { agent: metadata.agentName })
    return generated
  }
  return null
}

async function convertPackage(root, outputDir, metadata) {
  const realRoot = path.resolve(root)
  const realOut = path.resolve(outputDir)
  const sanitized = sanitizeMetadata(realRoot, metadata)
  await fsp.mkdir(realOut, { recursive: true })
  await writeJsonFile(path.join(realOut, '.codebuddy-plugin', 'plugin.json'), sanitized)
  await copySettings(realRoot, realOut, sanitized)
  await copyAgents(realRoot, realOut, sanitized)
  let skills = sanitized.skills || []
  if (typeof skills === 'string') skills = [skills]
  for (const skill of skills) await copySkill(realRoot, realOut, skill)
  return realOut
}

function discoverPackages(builtinDir) {
  if (!fs.existsSync(builtinDir) || !fs.statSync(builtinDir).isDirectory()) return []
  const packages = []
  for (const name of fs.readdirSync(builtinDir).sort()) {
    const root = path.join(builtinDir, name)
    if (!fs.statSync(root).isDirectory()) continue
    const relative = metadataFile(root)
    const metadata = readJsonFile(path.join(root, ...relative.split('/')), relative)
    packages.push({ name, root, metadata })
  }
  return packages
}

/** import_all 同构：逐包转换 → 严格导入（source.builtin）；失败 warning 继续。 */
export async function importBuiltinExperts(importDirectory) {
  const builtinDir = process.env.HARBOR_BUILTIN_EXPERTS_DIR || DEFAULT_BUILTIN_DIR
  const results = []
  for (const pkg of discoverPackages(builtinDir)) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-builtin-'))
    try {
      const converted = await convertPackage(pkg.root, temporary, pkg.metadata)
      const imported = JSON.parse(await importDirectory(converted, 'builtin'))
      results.push(imported)
    } catch (error) {
      results.push({ ok: false, error: { code: 'BUILTIN_IMPORT_FAILED', message: String(error.message || error) } })
    } finally {
      await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {})
    }
  }
  return {
    ok: results.length > 0 && results.every(item => item && item.ok === true),
    imported: results.filter(item => item && item.ok === true).length,
    packages: results,
  }
}
