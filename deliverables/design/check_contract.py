# -*- coding: utf-8 -*-
"""Validate frozen Harbor DOM, JavaScript, API and merged-CSS contracts."""
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MANIFEST = os.path.join(ROOT, 'frontend', 'manifest.json')
OUT = os.path.join(ROOT, 'harbor.html')

DOM_IDS = """apiKey attachPreview brandModel chatContainer continueNewBtn effPath effTag
emptyState enableSearch headerTitle liveTokenStat maxTokens modelSelect reasoningEffort
saverLevel searchEngine searchEngineWrap sendBtn sessionBudget sessionList settingsPanel
shotQuality sidebar streamBar systemPrompt tempVal temperature themeBtn tokenStat
toolMode topP topPVal userInput wsBody wsEffPath wsEffTag wsEnabled wsInd wsSel wsUnbindBtn""".split()
DYNAMIC_IDS = ['ctxMenu']
ONCLICK_FNS = """newSession exportChat openBilling onFolderEnabled onIndToggle onWsSelect
browseWs unbindSession toggleSidebar toggleTheme toggleSettings sendMessage
continueInNewSession""".split()
API_METHODS = """set_current_sid set_session_ws append_memory clear_caches set_ws_dir get_memory
append_worklog write_file take_screenshot set_ws_enabled set_clipboard search_replace
save_workspace_file save_sessions save_config run_powershell run_command run_admin_command
read_more read_file pick_folder open_url open_billing open_app move_path make_dir
list_processes list_dir kill_process get_ws_state get_worklog get_sessions get_file_info
get_effective_ws get_config get_clipboard get_api_info delete_session_ws delete_path
copy_path build_tools build_system_prompt append_file""".split()
CSS_CLASSES = """message user assistant avatar content error md-body typing-dots tool-call-item
tool-spinner toolchip tc-head tc-label tc-meta usage-info msg-images msg-file copy-btn
code-copy code-lang cs cs-trigger cs-label cs-arrow cs-menu cs-opt cs-src
ctx-menu ctx-menu-item sys-tip attach-item attach-preview session-item session-title
session-time session-del sidebar-empty empty-state empty-icon""".split()
REQUIRED_VARS = """--bg --sidebar-bg --main-bg --header-bg --card-bg --border --text --text-2
--primary --primary-hover --user-bubble --ai-bubble --hover --active --chip-bg
--ok --warn --err --shadow-sm --shadow-md --shadow-lg""".split()


def read(pathname):
    with open(pathname, 'r', encoding='utf-8') as source:
        return source.read()


def load_sources():
    """Read the template plus every manifest script/style in declared order."""
    manifest = json.loads(read(MANIFEST))
    if manifest.get('schemaVersion') != 1:
        raise ValueError('frontend manifest schemaVersion must be 1')
    template_path = os.path.join(ROOT, *manifest['template'].split('/'))
    scripts = [read(os.path.join(ROOT, *entry['path'].split('/')))
               for entry in manifest['scripts']]
    styles = [read(os.path.join(ROOT, *relative.split('/')))
              for relative in manifest['styles']]
    return manifest, read(template_path), '\n'.join(scripts), '\n'.join(styles)


def main():
    fails = []
    try:
        manifest, tpl, src_all, css_all = load_sources()
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print('FATAL: 无法读取 frontend manifest 契约源: %s' % error)
        return 1

    missing = [i for i in DOM_IDS if not re.search(r'id\s*=\s*["\']%s["\']' % re.escape(i), tpl)]
    print('[DOM id] %d/%d' % (len(DOM_IDS) - len(missing), len(DOM_IDS)))
    if missing:
        fails.append('缺少 DOM id: ' + ', '.join(missing))

    missing = [f for f in ONCLICK_FNS if not re.search(r'function\s+%s\s*\(' % re.escape(f), src_all)]
    print('[onclick 处理函数] %d/%d' % (len(ONCLICK_FNS) - len(missing), len(ONCLICK_FNS)))
    if missing:
        fails.append('缺少函数定义: ' + ', '.join(missing))

    called = set(re.findall(r"callApi\(\s*'([a-z_]+)'", src_all))
    missing = [m for m in API_METHODS if m not in called]
    print('[callApi 后端方法] %d/%d' % (len(API_METHODS) - len(missing), len(API_METHODS)))
    if missing:
        fails.append('未再被调用: ' + ', '.join(missing))

    missing = [c for c in CSS_CLASSES if ('.' + c) not in css_all]
    print('[CSS 类] %d/%d' % (len(CSS_CLASSES) - len(missing), len(CSS_CLASSES)))
    if missing:
        fails.append('样式缺失类: ' + ', '.join(missing))

    missing = [v for v in REQUIRED_VARS if (v + ':') not in css_all]
    print('[CSS 变量] %d/%d' % (len(REQUIRED_VARS) - len(missing), len(REQUIRED_VARS)))
    if missing:
        fails.append('变量缺失: ' + ', '.join(missing))

    refs = sorted(set(re.findall(r'src\s*=\s*["\'](libs/[^"\']+)["\']', tpl)))
    bad = [r for r in refs if not os.path.isfile(os.path.join(ROOT, r.replace('/', os.sep)))]
    print('[本地依赖库] %d 个引用，%d 个缺失' % (len(refs), len(bad)))
    for ref in refs:
        print('    %s %s' % ('OK  ' if ref not in bad else 'MISS', ref))
    if bad:
        fails.append('依赖库缺失: ' + ', '.join(bad))

    if os.path.isfile(OUT):
        print('[构建产物] harbor.html 存在 (%d 字节)' % os.path.getsize(OUT))
    else:
        fails.append('构建产物 harbor.html 不存在，请运行 node frontend/build.js')

    print('\n' + ('=' * 56))
    if fails:
        print('结果: FAIL (%d 项)' % len(fails))
        for failure in fails:
            print('  ✗ ' + failure)
        return 1
    print('结果: PASS — 五大契约全部保住（manifest: %d JS / %d CSS）' %
          (len(manifest['scripts']), len(manifest['styles'])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
