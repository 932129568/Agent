# -*- coding: utf-8 -*-
"""从本机 WorkBuddy 市场缓存采集「全量专家 / 专家团 / 各分区技能 / 连接器」，
生成 Harbor 前端内置目录模块 frontend/src/shell/hub-catalog.js。

数据来源（全部离线、只读本机缓存）：
  - app/cache/experts/manifest.json            专家市场全量清单（448 条，15 分类）
  - builtin-expert-recommendations/curated-experts.json  官方热门推荐（60 条，带 priority）
  - .skill-list-cache.json                    已安装/内置技能（65 条）
  - codebuddy-plugins-official marketplace.json  官方插件市场（206 条）
  - cb_teams_marketplace marketplace.json       协作与团队市场（29 条）
  - workbuddy-builtin/skills                    官方内置技能（23 条）
  - workbuddy-connector-plugins-official       官方连接器（17 条）
  - experts/plugins/*/plugin.json              用户已下载的专家包（补充真实 persona）

产物是纯静态 JS 数据 + 查询函数，Harbor 运行时不依赖本机 WorkBuddy、不联网、
不新增 js_api、不改 config.json。选中条目后由 hubCatalogPrompt() 生成一次性
角色/工作流指令注入下一次发送的系统提示。

用法（本机、项目根目录）： python tools/build_hub_catalog.py
"""
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WB = Path.home() / '.workbuddy'
APP_RES = Path(r'F:\workbuddy\resources\app.asar.unpacked\resources')
OUT = ROOT / 'frontend' / 'src' / 'shell' / 'hub-catalog.js'
PERSONA_CACHE = ROOT / 'outputs' / 'hub-catalog-cache' / 'experts'


def zh(value):
    """取中文字段；兼容 {zh,en} 字典、纯字符串与缺省。"""
    if isinstance(value, dict):
        return str(value.get('zh') or value.get('en') or '')
    return str(value or '')


def clip(text, size):
    return str(text or '').replace('\r', ' ').replace('\n', ' ')[:size]


def condense_markdown(raw, cap):
    """把真实人格/SKILL 原文裁剪为可注入的指令：保留身份段与核心准则，
    丢弃 frontmatter 外壳、示例代码块与冗长模板，在段落边界收尾。"""
    text = str(raw or '').replace('\r\n', '\n')
    lines = text.split('\n')
    # 去掉 YAML frontmatter，但把其中的 name/description 变成一行标题
    header = ''
    if lines and lines[0].strip() == '---':
        end = next((i for i in range(1, min(len(lines), 30)) if lines[i].strip() == '---'), 0)
        if end:
            for line in lines[1:end]:
                if re.match(r'^(name|description):\s*\S', line):
                    header = line.strip()
                    break
            lines = lines[end + 1:]
    out, total, in_code = [], 0, False
    for line in lines:
        if line.strip().startswith('```'):
            in_code = not in_code
            continue
        if in_code:
            continue
        if total + len(line) > cap:
            break
        out.append(line.rstrip())
        total += len(line) + 1
    body = '\n'.join(out).strip()
    # 在最后一个完整段落/标题处收尾，避免半句话
    if total >= cap and body:
        cut = max(body.rfind('\n\n'), body.rfind('\n#'), body.rfind('\n- '))
        if cut > cap * 0.5:
            body = body[:cut].strip()
    prefix = ('【角色档案】' + header + '\n') if header else ''
    return (prefix + body).strip()


def ensure_directive(item):
    """保证每一项的指令都足以改变模型行为：原文过短（只有 frontmatter 的
    SKILL.md 等）时补齐角色定位、适用场景与可执行的工作准则。"""
    base = str(item.get('directive') or '').strip()
    if len(base) >= 180:
        return base
    name = item.get('name') or ''
    desc = item.get('desc') or ''
    tags = item.get('tags') or []
    extra = '内置目录条目「%s」。\n专业定位：%s\n' % (
        name, desc or '该领域的专业角色/工作流。')
    if tags:
        extra += '适用场景 / 专长：' + '、'.join(tags) + '。\n'
    if item.get('alias') and item['alias'] != name:
        extra += '角色名：' + item['alias'] + '。\n'
    if item.get('init'):
        extra += '默认开场：' + item['init'] + '\n'
    extra += ('执行要求：先确认目标与约束，按该角色/技能的专业方法分步骤推进，'
              '给出可验证的结论与产物；涉及不确定信息时明确标注假设与风险，'
              '不得退化为通用助手口吻。')
    return (base + '\n' + extra).strip() if base else extra.strip()


def fallback_persona(row, item, category_name):
    """CDN 未发布原文的专家：用市场元数据生成完整、可执行的结构化角色指令。"""
    quick = [zh(q) for q in (row.get('quickPrompts') or []) if zh(q)][:3]
    members = [zh(m.get('name') if isinstance(m, dict) else m)
               for m in (row.get('members') or [])][:8]
    tags = item['tags']
    parts = [
        '你是「%s」%s，来自 WorkBuddy 专家市场【%s】。' % (
            item['name'],
            ('（%s）' % item['alias']) if item['alias'] and item['alias'] != item['name'] else '',
            category_name or item['section']),
        '专业定位：' + (item['desc'] or '该领域资深从业者，负责输出专业、可执行的结论。'),
    ]
    if tags:
        parts.append('专长领域：' + '、'.join(tags) + '。')
    pos = zh(row.get('displayPosition')) or zh(row.get('operationalTag'))
    if pos:
        parts.append('岗位定位：' + pos + '。')
    if members:
        parts.append('团队成员：' + '、'.join([m for m in members if m]) + '；以团队主理人视角协调分工后再给结论。')
    if quick:
        parts.append('典型任务：' + ' / '.join(quick) + '。')
    if item['init']:
        parts.append('开场方式：' + item['init'])
    parts.append('请始终以该角色视角回应：先明确目标与约束，给出结构化、可验证的方案，并标注关键风险与下一步。')
    return '\n'.join(parts)


# ---------------------------------------------------------------- 专家市场
CATEGORY_EMOJI = {
    '01-ProductDesign': '🎨', '02-Engineering': '💻', '03-GameSpatial': '🎮',
    '04-DataAI': '🤖', '05-MarketingGrowth': '📈', '06-ContentCreative': '✍️',
    '07-SalesCommerce': '🛒', '08-FinanceInvestment': '💰', '09-OperationsHR': '👥',
    '10-ProjectQuality': '🧪', '11-SecurityCompliance': '⚖️', '12-IndustryConsultant': '🏛️',
    '13-TencentZone': '🐧', '14-GlobalDevelopment': '🌍', '15-BackToSchool': '🎒',
}
GENERIC_EMOJI = {'agent': '🧑‍💼', 'team': '👥', 'skill': '⚡', 'connector': '🔗'}


def collect_experts():
    """专家市场全量：394 专家 + 54 专家团，附带 15 个官方分类与热门优先级。"""
    manifest_path = WB / 'app' / 'cache' / 'experts' / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    categories = [
        {'id': c.get('id'), 'name': zh(c.get('name')), 'desc': clip(zh(c.get('description')), 90)}
        for c in manifest.get('categories', [])
    ]
    cat_name = {c['id']: c['name'] for c in categories}

    curated_path = APP_RES / 'builtin-expert-recommendations' / 'curated-experts.json'
    curated = {}
    if curated_path.is_file():
        data = json.loads(curated_path.read_text(encoding='utf-8'))
        for row in data.get('candidates', []):
            curated[str(row.get('id'))] = int(row.get('priority') or 0)

    # 用户已下载的专家包：补充更完整的 persona / tags / defaultInitPrompt
    local = {}
    base = WB / 'plugins' / 'marketplaces' / 'experts' / 'plugins'
    if base.is_dir():
        for folder in sorted(base.iterdir()):
            pj = folder / '.codebuddy-plugin' / 'plugin.json'
            if pj.is_file():
                local[folder.name.lower()] = json.loads(pj.read_text(encoding='utf-8'))

    experts, teams = [], []
    for row in manifest.get('experts', []):
        eid = str(row.get('id') or '')
        if not eid:
            continue
        is_team = row.get('expertType') == 'team'
        category = str(row.get('categoryId') or '')
        profession = zh(row.get('profession')) or zh(row.get('displayPosition'))
        alias = zh(row.get('displayName')) or profession or eid
        desc = zh(row.get('displayDescription')) or zh(row.get('description'))
        init = zh(row.get('defaultInitPrompt'))
        tags = [zh(t) for t in (row.get('tags') or []) if zh(t)][:4]
        hot = curated.get(eid, 0)
        # 官方推荐表带场景词，作为补充检索词
        if hot and not tags:
            tags = []
        extra = local.get(eid.lower()) or {}
        if extra:
            alias = zh(extra.get('displayName')) or alias
            profession = zh(extra.get('profession')) or profession
            desc = zh(extra.get('displayDescription')) or desc
            init = zh(extra.get('defaultInitPrompt')) or init
            tags = tags or [zh(t) for t in (extra.get('tags') or []) if zh(t)][:4]
        item = {
            'id': eid,
            'name': profession or alias,
            'alias': alias,
            'desc': clip(desc, 150),
            'emoji': CATEGORY_EMOJI.get(category, GENERIC_EMOJI['team' if is_team else 'agent']),
            'section': cat_name.get(category) or ('专家团' if is_team else '专家'),
            'category': category,
            'tags': tags,
            'hot': hot,
            'init': clip(init, 110),
            'kind': 'team' if is_team else 'expert',
        }
        # 真实人格指令：优先使用 CDN 抓到的专家原文（裁剪），否则用市场元数据
        # 生成结构化角色设定。两者都能直接注入系统提示，点击即生效。
        cached = PERSONA_CACHE / (eid + '.md')
        if cached.is_file():
            item['directive'] = condense_markdown(
                cached.read_text(encoding='utf-8', errors='replace'), 2600)
        else:
            item['directive'] = fallback_persona(
                row, item, cat_name.get(category) or item['section'])
        item['directive'] = ensure_directive(item)
        (teams if is_team else experts).append(item)
    return experts, teams, categories, curated


# ---------------------------------------------------------------- 技能市场
SECTION_LABEL = {
    'userSettings': '个人已装 · 热门', 'builtin': '官方内置',
    'connector': '连接器技能', 'plugin': '插件技能',
    'marketplace': '技能市场', 'skillhub': 'SkillHub',
}
SECTION_EMOJI = {
    '个人已装 · 热门': '⭐', '官方内置': '🧩', '连接器技能': '🔌',
    '插件技能': '📦', '技能市场': '🛒', 'SkillHub': '🎯',
    '开发者插件市场': '💻', '协作与团队市场': '🤝',
}


def resolve_skill_md(source):
    """技能包 -> 真实 SKILL.md（根目录优先，其次取第一个嵌套文件）。"""
    if not source:
        return None
    p = Path(source)
    if p.is_file():
        return p
    if not p.is_dir():
        return None
    root = p / 'SKILL.md'
    if root.is_file():
        return root
    found = sorted(p.rglob('SKILL.md'))
    return found[0] if found else None


def add_skill(skills, seen, ident, name, desc, section, tags=None, hot=0, source=None):
    key = str(ident or name).lower()
    if key in seen:
        return
    seen.add(key)
    item = {
        'id': str(ident or name), 'name': clip(name, 60),
        'desc': clip(desc, 160), 'emoji': SECTION_EMOJI.get(section, '⚡'),
        'section': section, 'tags': [str(t) for t in (tags or [])][:3],
        'hot': hot, 'init': '', 'kind': 'skill',
    }
    md = resolve_skill_md(source)
    if md:
        item['directive'] = condense_markdown(
            md.read_text(encoding='utf-8', errors='replace'), 1600)
    if not item.get('directive'):
        item['directive'] = ('启用技能「%s」：%s%s' % (
            item['name'], item['desc'],
            ('\n常见用法：' + '、'.join(item['tags'])) if item['tags'] else ''))
    item['directive'] = ensure_directive(item)
    skills.append(item)


def collect_skills():
    skills, seen = [], set()
    # ① 已安装 / 内置技能（含中文描述与示例）
    cache_path = WB / '.skill-list-cache.json'
    if cache_path.is_file():
        for row in json.loads(cache_path.read_text(encoding='utf-8'))['results']:
            name = str(row.get('name') or '')
            section = SECTION_LABEL.get(str(row.get('source') or 'marketplace'), '技能市场')
            add_skill(skills, seen,
                      str(row.get('slug') or row.get('overrideKey') or name.lower()),
                      name, row.get('description_zh') or row.get('description') or '',
                      section, row.get('examples_zh') or [],
                      source=row.get('filePath'))

    # ② 官方插件市场（206）与协作团队市场（29）：marketplace.json 全量清单
    markets = [
        ('开发者插件市场', WB / 'plugins' / 'marketplaces' / 'codebuddy-plugins-official'),
        ('协作与团队市场', WB / 'plugins' / 'marketplaces' / 'cb_teams_marketplace'),
    ]
    for label, base in markets:
        path = base / '.codebuddy-plugin' / 'marketplace.json'
        if not path.is_file():
            continue
        data = json.loads(path.read_text(encoding='utf-8'))
        for row in data.get('plugins', []):
            src = base / str(row.get('source') or '').lstrip('./').lstrip('/')
            add_skill(skills, seen, row.get('name'), row.get('name'),
                      row.get('description') or ('来自「%s」' % label), label,
                      [str(row.get('category') or '')] if row.get('category') else [],
                      source=src if src.is_dir() else (base / 'plugins' / str(row.get('name'))))

    # ③ 官方内置技能目录（SKILL.md frontmatter）
    builtin = APP_RES / 'plugins' / 'workbuddy-builtin' / 'skills'
    if builtin.is_dir():
        for folder in sorted(builtin.iterdir()):
            sk = folder / 'SKILL.md'
            name, desc = folder.name, ''
            if sk.is_file():
                head = sk.read_text(encoding='utf-8', errors='replace')[:900]
                m = re.search(r'^name:\s*(.+)$', head, re.M)
                if m:
                    name = m.group(1).strip().strip('"\'')
                m = re.search(r'^description:\s*(.+)$', head, re.M)
                if m:
                    desc = m.group(1).strip()
            add_skill(skills, seen, folder.name, name,
                      desc or ('来自「官方内置」分区的技能包'), '官方内置',
                      source=folder)
    return skills


def collect_connectors():
    path = (WB / 'plugins' / 'marketplaces' / 'workbuddy-connector-plugins-official'
            / '.codebuddy-plugin' / 'marketplace.json')
    out = []
    if not path.is_file():
        return out
    for row in json.loads(path.read_text(encoding='utf-8')).get('plugins', []):
        out.append({
            'id': str(row.get('name')), 'name': str(row.get('name')),
            'desc': clip(row.get('description') or '', 140),
            'emoji': GENERIC_EMOJI['connector'], 'section': '官方连接器',
            'tags': [], 'hot': 0, 'init': '', 'kind': 'connector',
        })
    return out


TEMPLATE = """/* Harbor 内置目录 —— WorkBuddy 市场全量「专家 / 专家团 / 各分区技能 / 连接器」。
 * 离线只读采集自本机 WorkBuddy 缓存：app/cache/experts/manifest.json（448 条、15 分类）、
 * builtin-expert-recommendations/curated-experts.json（60 条热门）、.skill-list-cache.json、
 * codebuddy-plugins-official / cb_teams_marketplace / workbuddy-builtin / connectors 市场清单。
 * 运行时不联网、不读取用户目录、不新增 js_api、不改 config.json。
 * 选中条目后由 hubCatalogPrompt() 生成一次性角色/工作流指令，注入下一次发送的系统提示；
 * 这是「内置目录 + 行为指令」，不依赖 WorkBuddy 服务端运行时。
 * 采集版本：%(version)s（刷新：python tools/build_hub_catalog.py）。
 */
const HUB_CATALOG = %(body)s;

/** 目录检索：名称/描述/标签/分区包含匹配；名称命中与官方热门优先，支持限量返回。 */
function hubCatalogSearch(kind, query, limit) {
  const q = String(query || '').trim().toLowerCase();
  const pools = Array.isArray(kind) ? kind : (kind ? [kind] : ['experts', 'teams', 'skills', 'connectors']);
  const out = [];
  pools.forEach(k => (HUB_CATALOG[k] || []).forEach(it => {
    const hay = (it.name + ' ' + it.desc + ' ' + (it.tags || []).join(' ') +
                 ' ' + (it.section || '') + ' ' + (it.alias || '')).toLowerCase();
    if (q && hay.indexOf(q) < 0) return;
    const nameHit = q && String(it.name).toLowerCase().indexOf(q) >= 0;
    const score = (nameHit ? 100 : 0) + (it.hot || 0) / 1000 + (q ? 1 : 0);
    out.push({ item: it, score: score, kind: k });
  }));
  out.sort((a, b) => b.score - a.score);
  const cap = Number(limit) > 0 ? Number(limit) : 0;
  return (cap ? out.slice(0, cap) : out).map(x => x.item);
}

/** 按 kind + id 取条目（供选择态恢复与指令注入）。 */
function hubCatalogById(kind, id) {
  return (HUB_CATALOG[kind] || []).find(it => it.id === id) || null;
}

/** 全部分区（用于「召唤更多」分组展示）。 */
function hubCatalogSections() {
  const s = [];
  Object.keys(HUB_CATALOG).forEach(k => {
    if (!Array.isArray(HUB_CATALOG[k])) return;
    HUB_CATALOG[k].forEach(it => { if (s.indexOf(it.section) < 0) s.push(it.section); });
  });
  return s;
}

/** 生成选中条目的真实角色/工作流指令（发送时注入系统提示，点击即生效）。
 *  优先使用内置的真实人格原文或 SKILL.md 工作流（directive）；无原文者回落到
 *  市场元数据生成的结构化角色设定，保证目录里每一项都能真正改变模型行为。 */
function hubCatalogPrompt(item) {
  if (!item || item.kind === 'connector') return '';
  const label = item.kind === 'team' ? '专家团' : (item.kind === 'expert' ? '专家' : '技能');
  const head = '【Harbor 内置目录 · 已启用「' + item.name + '」（' + label + '）】\\n';
  const body = item.directive || ('启用「' + item.name + '」：' + (item.desc || '') +
    ((item.tags && item.tags.length) ? '\\n常见用法：' + item.tags.join('、') : ''));
  const tail = (item.init && item.kind !== 'skill')
    ? '\\n\\n该角色的开场提问（用户可能据此发问）：' + item.init : '';
  return head + body + tail;
}
"""


def main():
    experts, teams, categories, curated = collect_experts()
    skills = collect_skills()
    connectors = collect_connectors()
    catalog = {
        'version': 'r32-' + time.strftime('%Y%m%d'),
        'source': 'WorkBuddy 本机市场缓存全量（离线内置）',
        'categories': categories,
        'hotIds': [k for k, _ in sorted(curated.items(), key=lambda x: -x[1])],
        'experts': experts, 'teams': teams,
        'skills': skills, 'connectors': connectors,
    }
    body = json.dumps(catalog, ensure_ascii=False, separators=(',', ':'))
    OUT.write_text(TEMPLATE % {'version': catalog['version'], 'body': body}, encoding='utf-8')
    print('生成:', OUT, '%.1f KB' % (OUT.stat().st_size / 1024))
    real = sum(1 for it in experts + teams + skills if it.get('directive'))
    print('专家 %d / 专家团 %d / 技能 %d / 连接器 %d / 分类 %d / 热门 %d / 含真实指令 %d' % (
        len(experts), len(teams), len(skills), len(connectors),
        len(categories), len(curated), real))
    print('技能分区:', sorted({i['section'] for i in skills}))


if __name__ == '__main__':
    main()
