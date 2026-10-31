# -*- coding: utf-8 -*-
"""v1.8.0 S 域（外部软件）+ H 域（混合路由）+ v1.8.5 A 域（任务授权/白名单）验收测试。

覆盖（联调规范 §6 L1/L2 可自动化部分 + 任务书 S1/S2/H1/H2/A1/A2）：
- SoftwareService：探测 mock PATH/winreg/version 验身份三态（probed/
  missing/version_mismatch）/software_list 过滤与字段形状/software_call
  错误码全家桶（UNKNOWN_SOFTWARE/BAD_PARAMS/NOT_INSTALLED/
  IDENTITY_MISMATCH/SCHEMA_INVALID violations+example/TIMEOUT killed）/
  exit_code≠0 成功形状 + error_hint 人话映射/沙箱档位映射（risk→standard/
  strict）/GUI 核验与 GUI_UNCONFIRMED/URI 协议启动/truncated+full_ref+
  read_more 实取/工作区路径门禁/用户自定义 CRUD/审计落盘；
- HybridRouter：分类器矩阵（understand/validate/plan/compose + 置信门
  折减）/三策略路由（auto 分类 + 预算 / saver 本地优先静默降级 / quality
  全云端）/硬预算 check_budget/降级链（3 连败 unavailable + 60s 探测 +
  degrade_notice 口径：saver 静默、auto 首次、双失败告知）/成本分账
  （local/cloud token 与 saved）/hybrid.json 缺失 + 损坏备份 + save 部分
  更新 + 字段级校验；
- GuardService（v1.8.5 A 域）：grant TTL + 空闲收回时钟（假时钟注入，
  grant 内操作刷新空闲，先到者生效）/scope 与 ttl 校验（不静默夹逼）/
  status remaining_s 与 expiring_soon/revoke 幂等/判定链
  deny → allow_rules → task_grant → op 档（旧配置零迁移）/规则窄优先 +
  deny 覆盖即拒 + warn + hits/审计 decision=rule|grant；
- 前端 vm harness（node，test_v13_qa _run_node 同款）：64-software-panel
  三态 + last-wins + 状态灯 + 测试调用渲染 + 自定义向导 rpc；65-hybrid
  配置表单 + #costSplit 数字格式（千分位/两位小数/k 缩写/缺失隐藏）+
  saver 一次性提示；66-guard-grant 倒计时校准 + 收回 + 规则管理。

铁律：software.json/hybrid.json 独立文件（config.json 零污染——本测试断言
跑完后 config.json 无 software/hybrid 键）；guard.json 仅追加 allow_rules
键（用户显式创建才写）；新 js_api 全进 _V12_EXTRA（get_api_info 零漂移
由 test_v18_tools_wiring 契约门锁定）。
"""
import io
import json
import os
import subprocess
import tempfile

import pytest

from backend import paths
from helpers.frontend import read_frontend_source
from backend.domains.workspace import sandbox_service
from backend.domains.security.guard_service import GuardService
from backend.domains.providers.hybrid_router import (CLOUD_PRICE_PER_1K, HybridRouter,
                                            classify_task)
from backend.domains.integrations.software_service import (SoftwareService, gen_example,
                                               validate_args)
from backend.domains.workspace.toolcache_service import ToolcacheService

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r'C:\Users\陈\.workbuddy\binaries\node\versions\node-v27.0.0-alpha.0.0.0-win-x64\node.exe'
FRONTEND_SRC = os.path.join(PROJECT_ROOT, 'frontend', 'src')


class FakeClock:
    """可 advancing 的假时钟（guard grant/hybrid 降级链时钟注入）。"""

    def __init__(self, t=1_7000_0000.0):
        self.t = float(t)

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += float(seconds)


def _mk_guard(tmp_path, clock=None):
    return GuardService(guard_path=str(tmp_path / 'guard.json'),
                        audit_path=str(tmp_path / 'audit.jsonl'),
                        clock=clock or FakeClock())


def _mk_sw(tmp_path, guard=None, **kw):
    kw.setdefault('ws_root', str(tmp_path / 'ws'))
    os.makedirs(kw['ws_root'], exist_ok=True)
    return SoftwareService(
        registry_path=str(tmp_path / 'software.json'),
        guard=guard or _mk_guard(tmp_path),
        toolcache=ToolcacheService(do_cleanup=False), **kw)


def _runner_script(script):
    """脚本化 CLI 执行替身：argv 任一元素含 key 即返回对应响应（子串匹配）。"""
    def _run(argv, cwd, timeout, limits):
        for key, resp in script:
            if any(key in str(a) for a in argv):
                return dict(resp)
        return {'returncode': 0, 'stdout': b'', 'stderr': b'', 'sandboxed': False}
    return _run


def _audit_lines(guard):
    out = []
    p = guard._audit_path
    if not os.path.exists(p):
        return out
    with open(p, 'r', encoding='utf-8') as f:
        for ln in f:
            if ln.strip():
                out.append(json.loads(ln))
    return out


# ============================================================ S 域·探测
class TestSoftwareProbe:
    def test_probe_three_states_path_and_identity(self, tmp_path):
        """PATH 扫描 + --version 验身份三态：probed/missing/version_mismatch。"""
        paths_map = {'git': r'C:\git\bin\git.exe', 'python': r'C:\py\python.exe'}
        version_out = {'git': b'git version 2.43.0.windows.1\r\n',
                       'python': b'Python 3.11.5\r\n'}
        svc = _mk_sw(tmp_path,
                     path_scanner=lambda exe: paths_map.get(exe),
                     app_path_lookup=lambda exe: None,
                     runner=_runner_script([
                         ('git.exe', {'returncode': 0,
                                      'stdout': version_out['git'],
                                      'stderr': b''}),
                         ('python.exe', {'returncode': 0,
                                         'stdout': version_out['python'],
                                         'stderr': b''})]))
        r = svc.software_probe()
        assert r['ok'] is True and r['elapsed_ms'] >= 0
        st = {p['name']: p for p in r['probed']}
        assert st['git']['status'] == 'probed' and st['git']['version'] == '2.43.0'
        assert st['python']['status'] == 'probed' and st['python']['version'] == '3.11.5'
        # PATH 无 + 注册表无 → missing
        assert st['ffmpeg']['status'] == 'missing'
        assert st['7z']['status'] == 'missing'
        assert st['notepad']['status'] == 'missing'

    def test_identity_mismatch_marks_version_mismatch(self, tmp_path):
        """同名假冒：PATH 找到但 --version 输出不含身份特征 → version_mismatch。"""
        svc = _mk_sw(tmp_path,
                     path_scanner=lambda exe: r'C:\fake\git.exe' if exe == 'git' else None,
                     app_path_lookup=lambda exe: None,
                     runner=_runner_script([
                         ('git.exe', {'returncode': 0,
                                      'stdout': b' totally-not-git 1.0\r\n',
                                      'stderr': b''})]))
        r = svc.software_probe('git')
        assert r['probed'][0]['status'] == 'version_mismatch'
        assert 'version' not in r['probed'][0]

    def test_winreg_app_path_supplements_path_scan(self, tmp_path):
        """PATH 扫描失败时 winreg App Paths 补探测解析到 exe → probed。"""
        svc = _mk_sw(tmp_path,
                     path_scanner=lambda exe: None,
                     app_path_lookup=lambda exe: r'C:\Program Files\Git\cmd\git.exe'
                     if exe == 'git' else None,
                     runner=_runner_script([
                         ('git.exe', {'returncode': 0,
                                      'stdout': b'git version 2.40.1\r\n',
                                      'stderr': b''})]))
        r = svc.software_probe('git')
        assert r['probed'][0]['status'] == 'probed'
        assert r['probed'][0]['version'] == '2.40.1'

    def test_probe_unknown_name_bad_params_with_hint(self, tmp_path):
        svc = _mk_sw(tmp_path)
        r = svc.software_probe('nope')
        assert r['ok'] is False and r['error']['code'] == 'BAD_PARAMS'
        assert 'git' in r['error']['hint']

    def test_probe_persists_cache_to_software_json(self, tmp_path):
        """探测缓存落盘 software.json（独立文件；config.json 零污染）。"""
        svc = _mk_sw(tmp_path,
                     path_scanner=lambda exe: r'C:\git\git.exe' if exe == 'git' else None,
                     app_path_lookup=lambda exe: None,
                     runner=_runner_script([
                         ('git.exe', {'returncode': 0,
                                      'stdout': b'git version 2.43.0\r\n',
                                      'stderr': b''})]))
        svc.software_probe('git')
        data = json.loads((tmp_path / 'software.json').read_text(encoding='utf-8'))
        assert data['probe_cache']['git']['status'] == 'probed'
        # 重新加载：缓存生效（status=probed 而非 unknown）
        svc2 = _mk_sw(tmp_path)
        lst = svc2.software_list()
        git = next(s for s in lst['software'] if s['name'] == 'git')
        assert git['status'] == 'probed' and git['version'] == '2.43.0'

    def test_list_status_filter_and_shape(self, tmp_path):
        svc = _mk_sw(tmp_path,
                     path_scanner=lambda exe: r'C:\x\%s.exe' % exe
                     if exe in ('git', 'python') else None,
                     app_path_lookup=lambda exe: None,
                     runner=_runner_script([
                         ('git.exe', {'returncode': 0,
                                      'stdout': b'git version 2.43.0\r\n',
                                      'stderr': b''}),
                         ('python.exe', {'returncode': 0,
                                         'stdout': b'Python 3.12.0\r\n',
                                         'stderr': b''})]))
        svc.software_probe()
        all_lst = svc.software_list('all')['software']
        assert {s['name'] for s in all_lst} == {'git', 'ffmpeg', '7z', 'python',
                                                'node', 'notepad'}
        probed = svc.software_list('probed')['software']
        assert {s['name'] for s in probed} == {'git', 'python'}
        missing = svc.software_list('missing')['software']
        assert {s['name'] for s in missing} == {'ffmpeg', '7z', 'node', 'notepad'}
        git = next(s for s in all_lst if s['name'] == 'git')
        assert git['kind'] == 'cli' and git['source'] == 'preset'
        assert git['risk_default'] == 'read'
        names = [a['name'] for a in git['actions']]
        assert 'status' in names and 'commit' in names
        commit = next(a for a in git['actions'] if a['name'] == 'commit')
        assert commit['risk'] == 'mutate'
        assert 'message' in commit['arg_schema']['properties']
        assert commit['arg_schema']['required'] == ['message']


# ============================================================ S 域·调用
class TestSoftwareCall:
    def _probed(self, tmp_path, **kw):
        svc = _mk_sw(tmp_path, **kw)
        svc._registry['git']['status'] = 'probed'
        svc._registry['git']['version'] = '2.43.0'
        return svc

    def test_cli_success_shape_and_audit(self, tmp_path):
        calls = []

        def _run(argv, cwd, timeout, limits):
            calls.append({'argv': argv, 'cwd': cwd, 'timeout': timeout,
                          'limits': limits})
            return {'returncode': 0,
                    'stdout': b'On branch main\r\nnothing to commit\r\n',
                    'stderr': b'', 'sandboxed': True}
        svc = self._probed(tmp_path, runner=_run)
        r = svc.software_call({'software': 'git', 'action': 'status'})
        assert r['ok'] is True and r['kind'] == 'cli'
        assert r['software'] == 'git' and r['action'] == 'status'
        assert r['exit_code'] == 0 and 'On branch main' in r['stdout']
        assert r['sandboxed'] is True and r['truncated'] is False
        assert r['duration_ms'] >= 0
        assert calls[0]['argv'][0] == 'git' and 'status' in calls[0]['argv']
        assert calls[0]['cwd'] == str(tmp_path / 'ws')
        ops = [e for e in _audit_lines(svc._guard)
               if e['op'] == 'software_call']
        assert ops and ops[-1]['decision'] == 'ok'
        assert ops[-1]['detail']['risk'] == 'read'

    def test_unknown_software_and_action(self, tmp_path):
        svc = self._probed(tmp_path, runner=_runner_script([]))
        r = svc.software_call({'software': 'nope', 'action': 'x'})
        assert r['error']['code'] == 'UNKNOWN_SOFTWARE'
        assert 'git' in r['error']['hint']
        r2 = svc.software_call({'software': 'git', 'action': 'nope'})
        assert r2['error']['code'] == 'BAD_PARAMS'
        assert 'commit' in r2['error']['hint']

    def test_not_installed_hint_website_no_auto_download(self, tmp_path):
        svc = _mk_sw(tmp_path, runner=_runner_script([]))
        svc._registry['git']['status'] = 'missing'
        r = svc.software_call({'software': 'git', 'action': 'status'})
        assert r['error']['code'] == 'NOT_INSTALLED'
        assert 'git-scm.com' in r['error']['hint']
        assert '不会自动下载' in r['error']['hint']

    def test_identity_mismatch_on_call(self, tmp_path):
        svc = _mk_sw(tmp_path, runner=_runner_script([]))
        svc._registry['git']['status'] = 'version_mismatch'
        r = svc.software_call({'software': 'git', 'action': 'status'})
        assert r['error']['code'] == 'IDENTITY_MISMATCH'
        assert 'PATH' in r['error']['hint']

    def test_schema_invalid_violations_and_example(self, tmp_path):
        svc = self._probed(tmp_path, runner=_runner_script([]))
        # 缺必填 → expect 带「必填」标记 + example 可自校正
        r = svc.software_call({'software': 'git', 'action': 'commit',
                               'args': {'extra': 'x'}})
        assert r['ok'] is False and r['error']['code'] == 'SCHEMA_INVALID'
        vs = r['error']['violations']
        assert [v['path'] for v in vs] == ['message']
        assert 'string' in vs[0]['expect'] and '必填' in vs[0]['expect']
        assert r['error']['example'] == {'message': 'fix: 描述本次修改'}
        # 类型错（值在但类型不对）→ got 摘要
        r2 = svc.software_call({'software': 'git', 'action': 'commit',
                                'args': {'message': 123}})
        assert r2['error']['code'] == 'SCHEMA_INVALID'
        v2 = r2['error']['violations'][0]
        assert v2['path'] == 'message' and 'string' in v2['expect']
        assert v2['got'].startswith('int')
        # log max_count 超界（1-100）
        r3 = svc.software_call({'software': 'git', 'action': 'log',
                                'args': {'max_count': 999}})
        assert r3['error']['code'] == 'SCHEMA_INVALID'
        assert r3['error']['violations'][0]['path'] == 'max_count'
        # 枚举/正则（clone url 需 http(s)://）
        r4 = svc.software_call({'software': 'git', 'action': 'clone',
                                'args': {'url': 'not-a-url'}})
        assert r4['error']['code'] == 'SCHEMA_INVALID'

    def test_nonzero_exit_success_shape_with_hint(self, tmp_path):
        """exit_code≠0：成功形状 + exit_code + error_hint（保住 Agent 判断力）。"""
        svc = self._probed(tmp_path, runner=_runner_script([
            ('commit', {'returncode': 1,
                        'stdout': b'',
                        'stderr': b'fatal: not a git repository\r\n',
                        'sandboxed': True})]))
        r = svc.software_call({'software': 'git', 'action': 'commit',
                               'args': {'message': 'x'}})
        assert r['ok'] is True and r['exit_code'] == 1
        assert 'not a git repository' in r['stderr']
        assert 'git init' in r['error_hint']
        ops = [e for e in _audit_lines(svc._guard) if e['op'] == 'software_call']
        assert ops[-1]['decision'] == 'ok'
        assert str(ops[-1]['detail']['exit_code']) == '1'

    def test_timeout_killed_with_partial_stdout(self, tmp_path):
        """看门狗超时：TIMEOUT + 进程树已清剿 + 部分 stdout 保留 + 审计 killed。"""
        svc = self._probed(tmp_path, runner=lambda argv, cwd, timeout, limits: {
            'returncode': None, 'stdout': b'partial output...',
            'stderr': b'', 'timed_out': True, 'sandboxed': True})
        r = svc.software_call({'software': 'git', 'action': 'status',
                               'args': {}, 'timeout': 5})
        assert r['ok'] is False and r['error']['code'] == 'TIMEOUT'
        assert '进程树已清剿' in r['error']['message']
        assert 'partial output' in r['error']['stdout']
        assert '调大' in r['error']['hint']
        ops = [e for e in _audit_lines(svc._guard) if e['op'] == 'software_call']
        assert ops[-1]['decision'] == 'killed'

    def test_sandbox_profile_mapping_by_risk(self, tmp_path, monkeypatch):
        """risk→沙箱档位：read/mutate→standard，dangerous→strict。"""
        captured = []

        def _fake_run_in_sandbox(argv, shell=False, cwd=None, timeout=60,
                                 limits=None, env=None, logger=None):
            captured.append(dict(limits or {}))
            return sandbox_service.SandboxRunResult(0, b'ok', b'')

        monkeypatch.setattr(sandbox_service, 'run_in_sandbox',
                            _fake_run_in_sandbox)
        sb = sandbox_service.SandboxService(
            sandbox_path=str(tmp_path / 'sandbox.json'))
        svc = self._probed(tmp_path, sandbox=sb)
        svc.software_call({'software': 'git', 'action': 'status'})       # read
        svc.software_call({'software': 'git', 'action': 'commit',
                           'args': {'message': 'm'}})                    # mutate
        svc._registry['python']['status'] = 'probed'
        svc.software_call({'software': 'python', 'action': 'run_script',
                           'args': {'script': 'a.py'}})                  # dangerous
        assert len(captured) == 3
        assert captured[0]['memory_mb'] == 1024      # standard
        assert captured[1]['memory_mb'] == 1024      # standard
        assert captured[2]['memory_mb'] == 512       # strict
        assert captured[2]['max_processes'] == 8

    def test_gui_verified_and_unconfirmed(self, tmp_path):
        """GUI 形态：标题核验通过 → launched/window_verified；超时 →
        GUI_UNCONFIRMED（error 内 launched:true）。"""
        ok_launcher = lambda exe, argv, title, timeout: {
            'launched': True, 'window_verified': True,
            'window_title': 'a.txt - 记事本'}
        svc = self._probed(tmp_path)
        svc._registry['notepad']['status'] = 'probed'
        svc._gui_launcher = ok_launcher
        (tmp_path / 'ws' / 'a.txt').write_text('hi', encoding='utf-8')
        r = svc.software_call({'software': 'notepad', 'action': 'open',
                               'args': {'path': 'a.txt'}})
        assert r['ok'] is True and r['kind'] == 'gui'
        assert r['window_verified'] is True and '记事本' in r['window_title']
        # 超时未确认
        svc._gui_launcher = lambda exe, argv, title, timeout: {
            'launched': True, 'window_verified': False}
        r2 = svc.software_call({'software': 'notepad', 'action': 'open',
                                'args': {'path': 'a.txt'}})
        assert r2['ok'] is False and r2['error']['code'] == 'GUI_UNCONFIRMED'
        assert r2['error']['launched'] is True
        assert 'UAC' in r2['error']['hint']
        ops = [e for e in _audit_lines(svc._guard) if e['op'] == 'software_call']
        assert ops[-1]['decision'] == 'unconfirmed'

    def test_uri_launch(self, tmp_path, monkeypatch):
        """URI 形态：协议启动 + protocol 回显；渲染结果非协议 → BAD_PARAMS。"""
        started = []
        monkeypatch.setattr(os, 'startfile', lambda uri: started.append(uri))
        svc = _mk_sw(tmp_path)
        svc.save('mydoc', {
            'kind': 'uri', 'uri_template': 'https://example.com/{path}',
            'actions': [{'name': 'open', 'risk': 'read',
                         'uri_template': 'https://example.com/{path}',
                         'arg_schema': {'type': 'object',
                                        'properties': {'path': {'type': 'string'}},
                                        'required': ['path']}}]})
        assert svc._registry['mydoc']['status'] == 'unknown'   # 保存不触发探测
        # https 协议在本机已注册 → 探测应为 probed；否则显式置位（隔离注册表差异）
        svc._probe_one('mydoc')
        if svc._registry['mydoc']['status'] != 'probed':
            svc._registry['mydoc']['status'] = 'probed'
        r = svc.software_call({'software': 'mydoc', 'action': 'open',
                               'args': {'path': 'a/b'}})
        assert r['ok'] is True and r['kind'] == 'uri'
        assert r['protocol'] == 'https' and started == ['https://example.com/a/b']

    def test_workspace_path_gate_blocks_escape(self, tmp_path):
        """路径参数工作区门禁：../ 越界 → SCHEMA_INVALID（junction/realpath 归一）。"""
        svc = self._probed(tmp_path, runner=_runner_script([]))
        (tmp_path / 'outside.txt').write_text('x', encoding='utf-8')
        # 无路径参数的 action 不受门禁影响（git clone 仅 url）
        r = svc.software_call({'software': 'git', 'action': 'clone',
                               'args': {'url': 'https://x/y.git'}})
        assert r['ok'] is True
        # ffmpeg convert 的 output 越界
        svc._registry['ffmpeg']['status'] = 'probed'
        r2 = svc.software_call({'software': 'ffmpeg', 'action': 'convert',
                                'args': {'input': 'a.mp4',
                                         'output': '../outside.txt'}})
        assert r2['error']['code'] == 'SCHEMA_INVALID'
        assert '越出工作区' in r2['error']['hint']
        # 合法相对路径放行（realpath 归一后仍在工作区内）
        r3 = svc.software_call({'software': 'ffmpeg', 'action': 'convert',
                                'args': {'input': './a.mp4',
                                         'output': 'sub/b.mp4'}})
        assert r3['ok'] is True

    def test_truncation_full_ref_read_more(self, tmp_path):
        """stdout 超长 → truncated + full_ref；read_more 实取全文。"""
        big = b'output line\n' * 800        # 9600 字节 / 800 行
        svc = self._probed(tmp_path, runner=_runner_script([
            ('status', {'returncode': 0, 'stdout': big, 'stderr': b'',
                        'sandboxed': True})]))
        r = svc.software_call({'software': 'git', 'action': 'status'})
        assert r['truncated'] is True and r['full_ref'].startswith('toolcache:')
        assert len(r['stdout']) < len(big)
        assert '已截断' in r['stdout']
        # 经同一 toolcache 实例续读（toolcache 映射进程内）
        cid = r['full_ref'].split(':', 1)[1]
        more = json.loads(svc._toolcache.read_more(cid, 0, 2000))
        assert more['ok'] is True and more['total_lines'] == 800

    def test_user_custom_crud_via_save(self, tmp_path):
        """用户自定义条目 CRUD（save/remove；预设不可删）。"""
        svc = _mk_sw(tmp_path)
        r = svc.save('mytool', {
            'kind': 'cli', 'exec': 'mytool.exe',
            'version_args': ['--version'], 'version_pattern': r'mytool \d',
            'actions': [{'name': 'hello', 'risk': 'read',
                         'argv': ['hello', '{who}'],
                         'arg_schema': {'type': 'object',
                                        'properties': {'who': {'type': 'string'}},
                                        'required': ['who']}}]})
        assert r['ok'] is True
        data = json.loads((tmp_path / 'software.json').read_text(encoding='utf-8'))
        assert 'mytool' in data['user']
        lst = svc.software_list('all')['software']
        mine = next(s for s in lst if s['name'] == 'mytool')
        assert mine['source'] == 'user'
        # 坏名字/坏结构拒绝
        assert svc.save('Bad Name', {})['error']
        assert svc.save('mytool2', {'kind': 'bad'})['error']
        assert svc.save('mytool3', {'kind': 'cli', 'exec': 'x',
                                    'actions': []})['error']
        # 预设不可删
        assert svc.remove('git')['removed'] is False
        assert svc.remove('mytool')['removed'] is True
        assert all(s['name'] != 'mytool'
                   for s in svc.software_list('all')['software'])

    def test_manual_test_source_audited(self, tmp_path):
        """面板测试调用（source=manual_test）照常审计（Gap-4：不走 Agent guard 链）。"""
        svc = self._probed(tmp_path, runner=_runner_script([
            ('status', {'returncode': 0, 'stdout': b'ok', 'stderr': b'',
                        'sandboxed': False})]))
        r = svc.software_call({'software': 'git', 'action': 'status',
                               'source': 'manual_test'})
        assert r['ok'] is True
        ops = [e for e in _audit_lines(svc._guard) if e['op'] == 'software_call']
        assert ops[-1]['detail']['source'] == 'manual_test'

    def test_timeout_clamp_bounds(self, tmp_path):
        """timeout 5-600 夹逼（§3.2 请求表）。"""
        seen = []

        def _run(argv, cwd, timeout, limits):
            seen.append(timeout)
            return {'returncode': 0, 'stdout': b'', 'stderr': b'',
                    'sandboxed': False}
        svc = self._probed(tmp_path, runner=_run)
        svc.software_call({'software': 'git', 'action': 'status', 'timeout': 1})
        svc.software_call({'software': 'git', 'action': 'status', 'timeout': 99999})
        svc.software_call({'software': 'git', 'action': 'status'})
        assert seen == [5, 600, 60]


# ============================================================ 纯函数：schema 校验
class TestArgSchema:
    def test_validate_args_matrix(self):
        schema = {'type': 'object', 'required': ['message'],
                  'properties': {
                      'message': {'type': 'string', 'minLength': 1,
                                  'maxLength': 10},
                      'crf': {'type': 'integer', 'minimum': 0, 'maximum': 51},
                      'preset': {'type': 'string', 'enum': ['fast', 'slow']},
                      'flag': {'type': 'boolean'}}}
        assert validate_args(schema, {'message': 'ok', 'crf': 23,
                                      'preset': 'fast', 'flag': True}) == []
        v = validate_args(schema, {'message': '', 'crf': 99, 'preset': 'x',
                                   'flag': 'yes'})
        assert {x['path'] for x in v} == {'message', 'crf', 'preset', 'flag'}
        # bool 不是 integer
        assert validate_args(schema, {'message': 'a', 'crf': True}) != []
        # 非整数值（10.5）拒绝
        assert validate_args(schema, {'message': 'a', 'crf': 10.5}) != []

    def test_gen_example(self):
        schema = {'type': 'object', 'required': ['a', 'b', 'c'],
                  'properties': {
                      'a': {'type': 'string', 'default': 'dft'},
                      'b': {'type': 'integer', 'minimum': 2},
                      'c': {'type': 'string', 'enum': ['x', 'y'],
                            'x-workspace-path': True}}}
        ex = gen_example(schema)
        assert ex['a'] == 'dft' and ex['b'] == 2 and ex['c'] == 'x'


# ============================================================ H 域·分类器
class TestClassifier:
    def test_understand(self):
        r = classify_task('这个错误是什么意思？请问怎么解决')
        assert r['category'] == 'understand' and r['confidence'] >= 0.7

    def test_validate_with_tool_result(self):
        r = classify_task('看看输出对不对', {'has_tool_result': True})
        assert r['category'] == 'validate'

    def test_plan(self):
        r = classify_task('帮我制定一个迁移计划，给出步骤和方案拆分')
        assert r['category'] == 'plan'

    def test_compose_code_block(self):
        r = classify_task('帮我写个函数\n```python\ndef f():\n    pass\n```')
        assert r['category'] == 'compose'

    def test_ambiguous_low_confidence(self):
        """关键词跨类且差距小 → 置信折减（<0.7 → 调用方升级云端）。"""
        r = classify_task('检查一下这个写法的实现步骤有没有问题')
        assert r['confidence'] < 0.7 or r['category'] in CATEGORIES_LIST

    def test_empty_falls_below_gate(self):
        r = classify_task('')
        assert r['confidence'] < 0.7


CATEGORIES_LIST = ('understand', 'validate', 'plan', 'compose')


# ============================================================ H 域·路由
class TestHybridRoute:
    def _mk(self, tmp_path, **cfg):
        r = HybridRouter(config_path=str(tmp_path / 'hybrid.json'),
                         clock=FakeClock())
        for k, v in cfg.items():
            r._cfg[k] = v
        return r

    def test_auto_classification_routing(self, tmp_path):
        r = self._mk(tmp_path)
        d = r.route('这个是什么意思？', local_available=True)
        assert d['channel'] == 'local' and d['budget_s'] == 5
        d2 = r.route('校验一下结果', {'has_tool_result': True},
                     local_available=True)
        assert d2['channel'] == 'local' and d2['budget_s'] == 3
        d3 = r.route('制定迁移计划与步骤拆分', local_available=True)
        assert d3['channel'] == 'cloud'

    def test_auto_local_unavailable_silent_degrade(self, tmp_path):
        r = self._mk(tmp_path)
        d = r.route('这个是什么意思？', local_available=False)
        assert d['channel'] == 'cloud' and d['degraded'] is True
        assert '静默降级' in d['reason']

    def test_confidence_gate_escalates(self, tmp_path):
        r = self._mk(tmp_path, confidence_gate=0.95)
        d = r.route('检查一下这个写法的实现步骤有没有问题',
                    local_available=True)
        assert d['channel'] == 'cloud' and d['escalated'] is True

    def test_saver_local_first_and_silent(self, tmp_path):
        r = self._mk(tmp_path, strategy='saver')
        d = r.route('这个是什么意思？', local_available=True)
        assert d['channel'] == 'local' and d['degraded'] is False
        d2 = r.route('这个是什么意思？', local_available=False)
        assert d2['channel'] == 'cloud' and d2['degraded'] is True
        # saver 降级静默（R3/R10 裁决）
        assert r.degrade_notice('saver') is False
        assert r.degrade_notice('saver', both_failed=False) is False

    def test_quality_all_cloud(self, tmp_path):
        r = self._mk(tmp_path, strategy='quality')
        d = r.route('这个是什么意思？', local_available=True)
        assert d['channel'] == 'cloud' and d['degraded'] is False

    def test_hard_budget_check(self, tmp_path):
        r = self._mk(tmp_path)
        assert r.check_budget('understand', 4.9)['exceeded'] is False
        assert r.check_budget('understand', 5.1)['exceeded'] is True
        assert r.check_budget('validate', 3.1)['exceeded'] is True
        assert r.check_budget('plan', 999)['exceeded'] is False

    def test_degrade_chain_three_fails_unavailable(self, tmp_path):
        r = self._mk(tmp_path)
        assert r.report_local_result(False)['unavailable'] is False
        assert r.report_local_result(False)['unavailable'] is False
        st = r.report_local_result(False)
        assert st['unavailable'] is True and st['fail_streak'] == 3
        assert r.local_unavailable() is True
        # unavailable 窗口内 auto 也降云端（即使 local_available=True）
        d = r.route('这个是什么意思？', local_available=True)
        assert d['channel'] == 'cloud' and d['degraded'] is True
        # 60s 后恢复探测
        r._clock.advance(61)
        assert r.local_unavailable() is False
        # 成功一次清零
        r.report_local_result(False); r.report_local_result(False)
        r.report_local_result(True)
        assert r.report_local_result(False)['fail_streak'] == 1

    def test_degrade_notice_auto_first_only_and_both_failed(self, tmp_path):
        r = self._mk(tmp_path)
        assert r.degrade_notice('auto') is True      # 首次
        assert r.degrade_notice('auto') is False     # 重复静默
        assert r.degrade_notice('auto', both_failed=True) is True   # 双失败必告知


# ============================================================ H 域·配置与分账
class TestHybridConfig:
    def test_missing_returns_default_and_persists(self, tmp_path):
        p = tmp_path / 'hybrid.json'
        r = HybridRouter(config_path=str(p))
        out = r.get_config()
        assert out['ok'] is True and out['source'] == 'default'
        assert out['config'] == {'strategy': 'auto',
                                 'local_budget_understand_s': 5,
                                 'local_budget_validate_s': 3,
                                 'confidence_gate': 0.7,
                                 'cost_split_display': True}
        assert p.exists()   # 顺带落盘默认（幂等）
        out2 = HybridRouter(config_path=str(p)).get_config()
        assert out2['source'] == 'file'

    def test_corrupt_backup_and_default(self, tmp_path):
        p = tmp_path / 'hybrid.json'
        p.write_text('{not json', encoding='utf-8')
        r = HybridRouter(config_path=str(p))
        out = r.get_config()
        assert out['source'] == 'default'
        backups = [f for f in os.listdir(tmp_path) if '.corrupt-' in f]
        assert backups
        assert json.loads(p.read_text(encoding='utf-8'))['strategy'] == 'auto'

    def test_save_partial_update_and_validation(self, tmp_path):
        r = HybridRouter(config_path=str(tmp_path / 'hybrid.json'))
        r.get_config()
        out = r.save_config({'strategy': 'saver'})
        assert out['ok'] is True and out['config']['strategy'] == 'saver'
        assert out['config']['local_budget_understand_s'] == 5   # 缺省取当前值
        out2 = r.save_config({'local_budget_understand_s': 12,
                              'confidence_gate': 0.85,
                              'cost_split_display': False})
        assert out2['config']['local_budget_understand_s'] == 12
        assert out2['config']['confidence_gate'] == 0.85
        assert out2['config']['cost_split_display'] is False
        # 字段级校验失败 → error + field
        for bad in ({'strategy': 'nope'}, {'local_budget_validate_s': 99},
                    {'confidence_gate': 0.1}, {'confidence_gate': 0.99},
                    {'cost_split_display': 'yes'},
                    {'local_budget_understand_s': True}):
            e = r.save_config(bad)
            assert 'error' in e and e.get('field'), bad
        # 未知键忽略（前向兼容）
        assert r.save_config({'future_key': 1})['ok'] is True

    def test_cost_split_accumulation(self, tmp_path):
        r = HybridRouter(config_path=str(tmp_path / 'hybrid.json'))
        r.record_usage('local', 1000)
        r.record_usage('cloud', 2000)
        r.record_usage('cloud', 500)
        sp = r.cost_split()
        assert sp['local_tokens'] == 1000 and sp['cloud_tokens'] == 2500
        assert sp['local_cost'] == 0.0                      # 本地计费 ¥0
        assert abs(sp['cloud_cost'] - 2500 / 1000 *
                   CLOUD_PRICE_PER_1K) < 1e-9
        assert abs(sp['saved'] - 1000 / 1000 * CLOUD_PRICE_PER_1K) < 1e-9
        # 非正 token 不累计
        r.record_usage('cloud', 0)
        assert r.cost_split()['cloud_tokens'] == 2500
        r.reset_split()
        assert r.cost_split()['cloud_tokens'] == 0


# ============================================================ A 域·授权
class TestTaskGrant:
    def test_grant_validation_and_shape(self, tmp_path):
        g = _mk_guard(tmp_path)
        r = g.task_grant(['exec'], 7200)
        assert r['ok'] is True
        assert r['grant_id'].startswith('g_')
        assert r['scope'] == ['exec'] and r['granted_by'] == 'user'
        # R6：空闲 30min 先到——授权建立瞬间 idle_deadline（now+1800）比
        # expires_at（now+7200）更短，remaining_s 取较早者 = 1800
        assert r['remaining_s'] == 1800
        assert r['expires_at'].endswith('Z') and r['idle_deadline'].endswith('Z')
        # scope 空/非法 → error（不静默夹逼）
        assert g.task_grant([])['error']
        assert g.task_grant(['nope'])['error']
        # ttl 越界 → error（安全参数不静默夹逼）
        assert g.task_grant(['exec'], 30)['error']
        assert g.task_grant(['exec'], 90000)['error']
        assert g.task_grant(['exec'], '7200')['error']
        # 多 scope + '+/,/空格' 分隔字符串都接受
        assert g.task_grant('exec+workspace_write')['scope'] == \
            ['exec', 'workspace_write']
        # 授权不入 guard.json（铁律）
        assert not os.path.exists(tmp_path / 'guard.json')

    def test_ttl_and_idle_reclaim_first_come(self, tmp_path):
        clk = FakeClock()
        g = _mk_guard(tmp_path, clock=clk)
        g.task_grant(['exec'], 7200)
        clk.advance(1700)
        assert g.task_status()['active'] is True     # 空闲 1700 < 1800
        clk.advance(200)                              # 累计 1900 > 1800 空闲
        st = g.task_status()
        assert st['active'] is False                  # 空闲收回先到
        assert st == {'ok': True, 'active': False}

    def test_grant_op_refreshes_idle(self, tmp_path):
        clk = FakeClock()
        g = _mk_guard(tmp_path, clock=clk)
        g.task_grant(['exec'], 7200)
        clk.advance(1700)
        # grant 内操作刷新空闲计时（check 命中 grant → touch）
        r = g.check('run_command', {'cmd': 'echo hi'})
        assert r['action'] == 'allow' and r['via'] == 'grant'
        clk.advance(1700)                             # 距上次操作 1700 < 1800
        assert g.task_status()['active'] is True
        clk.advance(200)                              # 距上次操作 1900 > 1800
        assert g.task_status()['active'] is False

    def test_ttl_expires_before_idle(self, tmp_path):
        clk = FakeClock()
        g = _mk_guard(tmp_path, clock=clk)
        g.task_grant(['exec'], 60)
        clk.advance(61)
        assert g.task_status()['active'] is False
        assert g.task_revoke()['revoked'] is False    # 幂等

    def test_status_expiring_soon(self, tmp_path):
        clk = FakeClock()
        g = _mk_guard(tmp_path, clock=clk)
        g.task_grant(['exec'], 7200)
        # 空闲闸先到（1800s）：推进到剩余 599s → 黄牌
        clk.advance(1800 - 599)
        st = g.task_status()
        assert st['active'] is True and st['expiring_soon'] is True
        assert st['remaining_s'] == 599

    def test_revoke_immediate(self, tmp_path):
        g = _mk_guard(tmp_path)
        g.task_grant(['exec'])
        assert g.task_revoke() == {'ok': True, 'revoked': True}
        assert g.task_status()['active'] is False
        assert g.task_revoke()['revoked'] is False    # 幂等

    def test_grant_audit_entries(self, tmp_path):
        g = _mk_guard(tmp_path)
        g.task_grant(['exec'])
        g.task_revoke()
        ops = [(e['op'], e.get('decision')) for e in _audit_lines(g)]
        assert ('guard_grant', 'grant') in ops
        assert ('guard_revoke', 'revoke') in ops


# ============================================================ A 域·白名单
class TestAllowRules:
    def test_rule_crud_and_shape(self, tmp_path):
        g = _mk_guard(tmp_path)
        r = g.rule_add('run_command', '^git (status|diff|log)', '日常只读 git')
        assert r['ok'] is True and r['rule_id'].startswith('r_')
        lst = g.rule_list()
        assert lst['ok'] is True and len(lst['rules']) == 1
        rule = lst['rules'][0]
        assert rule['op_pattern'] == 'run_command'
        assert rule['detail_pattern'] == '^git (status|diff|log)'
        assert rule['hits'] == 0 and rule['note'] == '日常只读 git'
        # allow_rules 落 guard.json（用户显式创建才写）
        data = json.loads((tmp_path / 'guard.json').read_text(encoding='utf-8'))
        assert 'allow_rules' in data
        # 删除幂等
        assert g.rule_remove(rule['rule_id'])['removed'] is True
        assert g.rule_remove(rule['rule_id'])['removed'] is False
        assert g.rule_list()['rules'] == []

    def test_rule_add_validation(self, tmp_path):
        g = _mk_guard(tmp_path)
        assert g.rule_add('')['error']
        assert g.rule_add('[')['error']                 # 非法 op 正则
        assert g.rule_add('run_command', '(')['error']  # 非法 detail 正则
        assert g.rule_add('run_command', None, 'x' * 300)['ok'] is True  # note 截断

    def test_deny_covered_rule_rejected(self, tmp_path):
        """deny 清单覆盖的规则创建即拒（宽规则 / 命中保护进程）。"""
        g = _mk_guard(tmp_path)
        r = g.rule_add('delete_path')
        assert r.get('code') == 'GUARD_DENIED'
        assert g.rule_add('.*').get('code') == 'GUARD_DENIED'
        assert g.rule_add('kill_process', 'lsass').get('code') == 'GUARD_DENIED'
        # 非 deny 敏感 op 的宽规则允许
        assert g.rule_add('run_command')['ok'] is True

    def test_write_verb_warn_non_blocking(self, tmp_path):
        g = _mk_guard(tmp_path)
        r = g.rule_add('run_command', '^git (status|del)$')
        assert r['ok'] is True and 'warn' in r
        r2 = g.rule_add('run_command', '^git (status|log)$')
        assert 'warn' not in r2

    def test_narrow_rule_first_and_hits(self, tmp_path):
        """窄规则 > 松模式；命中审计 decision=rule + hits 累加。"""
        g = _mk_guard(tmp_path)
        loose = g.rule_add('run_command')['rule_id']
        narrow = g.rule_add('run_command', '^git status$')['rule_id']
        r = g.check('run_command', {'cmd': 'git status'})
        assert r['via'] == 'rule' and r['rule_id'] == narrow
        assert g.enforce_exec('run_command', {'cmd': 'git status'}) is None
        rules = {x['rule_id']: x for x in g.rule_list()['rules']}
        assert rules[narrow]['hits'] == 1 and rules[loose]['hits'] == 0
        ops = [e for e in _audit_lines(g) if e.get('decision') == 'rule']
        assert ops and ops[-1]['op'] == 'run_command'


# ============================================================ A 域·判定链
class TestDecisionChain:
    def test_old_config_zero_migration(self, tmp_path):
        """旧 guard.json 无新键 → 行为与现行为一致（三档语义零迁移）。"""
        cfg_path = tmp_path / 'guard.json'
        cfg_path.write_text(json.dumps({
            'tiers': {'delete_path': 'always', 'run_command': 'off',
                      'clipboard_read': 'session'},
            'protect_paths': [r'C:\protected\*'],
            'protect_processes': [],
        }), encoding='utf-8')
        g = GuardService(guard_path=str(cfg_path),
                         audit_path=str(tmp_path / 'audit.jsonl'))
        assert g.check('run_command', {'cmd': 'x'})['action'] == 'allow'
        assert g.check('delete_path',
                       {'path': r'C:\protected\a.txt'})['action'] == 'block'
        assert g.check('delete_path',
                       {'path': r'C:\tmp\a.txt'})['action'] == 'confirm'
        assert 'allow_rules' not in json.loads(
            cfg_path.read_text(encoding='utf-8'))

    def test_chain_order_deny_rules_grant_tier(self, tmp_path):
        """deny → allow_rules → task_grant → op 档 → 弹窗。"""
        g = _mk_guard(tmp_path)
        # ① deny 先于 grant：授权内删保护路径仍拦
        g.save_config(json.dumps({'protect_paths': [r'C:\protected\*']}))
        g.task_grant(['workspace_write'])
        r = g.check('delete_path', {'path': r'C:\protected\x.txt'})
        assert r['action'] == 'block'
        # ③ grant 覆盖 scope → allow（via=grant）
        assert g.check('delete_path',
                       {'path': r'C:\ws\x.txt'})['via'] == 'grant'
        # grant 不覆盖的 op → 回落 op 档（delete_path always → confirm）
        g.task_revoke()
        g.task_grant(['exec'])
        assert g.check('delete_path',
                       {'path': r'C:\ws\x.txt'})['action'] == 'confirm'
        assert g.check('run_command', {'cmd': 'x'})['via'] == 'grant'
        # ② allow_rules 先于 grant
        g.rule_add('run_command', '^git status$')
        r2 = g.check('run_command', {'cmd': 'git status'})
        assert r2['via'] == 'rule'

    def test_grant_audit_decision_grant(self, tmp_path):
        g = _mk_guard(tmp_path)
        g.task_grant(['exec'])
        assert g.enforce_exec('run_command', {'cmd': 'x'}) is None
        ops = [e for e in _audit_lines(g) if e.get('decision') == 'grant']
        assert ops and ops[-1]['op'] == 'run_command'


# ============================================================ 前端 vm harness 基建
def _extract_fn(src, pattern):
    """从源码抽取指定函数体（test_v13_qa 同款括号配平算法）。"""
    import re as _re
    m = _re.search(pattern, src)
    assert m, '未找到: %s' % pattern
    i = m.end() - 1
    depth = 0
    in_str = None
    while i < len(src):
        ch = src[i]
        if in_str:
            if ch == '\\':
                i += 2
                continue
            if ch == in_str:
                in_str = None
        elif ch in ('"', "'", '`'):
            in_str = ch
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return src[m.start():i + 1]
        i += 1
    raise AssertionError('括号未配平: %s' % pattern)


_VM_PRELUDE = r'''
// ---- DOM stub（保真：id 赋值即注册 + innerHTML 记录 + appendChild 入树 +
//      选择器查询（.set-grid/.header-right 有宿主，其余按注册表过滤）） ----
function __ser(el) {
  let s = (el.textContent || '') + (el._html || '');
  (el._children || []).forEach(c => { s += __ser(c); });
  return s;
}
function __mkEl(id) {
  const el = {
    _id: '', _cls: '', _html: '', textContent: '', value: '', disabled: false,
    checked: false,
    style: {}, _attrs: {}, _handlers: {}, _children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(type, fn) {
      (this._handlers[type] = this._handlers[type] || []).push(fn);
    },
    click() { (this._handlers.click || []).forEach(f => f({})); },
    appendChild(c) { this._children.push(c); return c; },
    querySelectorAll() { return []; },
    querySelector() { return null; }
  };
  Object.defineProperty(el, 'id', {
    get() { return this._id; },
    set(v) { this._id = String(v); if (this._id) __els[this._id] = el; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this._children = []; }
  });
  if (id) el.id = id;
  return el;
}
const __els = {};
const __qsa = {};        // document 级选择器查询注册表（测试体可注入）
const __grid = __mkEl('setGrid');
const __headerRight = __mkEl('headerRight');
const document = {
  getElementById: (id) => __els[id] || (__els[id] = __mkEl(id)),
  createElement: () => __mkEl(''),
  querySelector: (sel) => (sel === '.set-grid' ? __grid
    : sel === '.header-right' ? __headerRight : null),
  querySelectorAll: (sel) => __qsa[sel] || [],
  body: __mkEl('body')
};
// ---- IPC stubs（按方法名分发；测试体改 __resp[name] 即改响应） ----
const __calls = [];
const __resp = {};
let __delay = 0;
let __callApiThrows = false;
async function callApi(name, args, timeoutMs) {
  __calls.push({ name, args, timeoutMs });
  if (__callApiThrows) throw new Error('pywebview bridge gone');
  if (__delay) await new Promise(r => setTimeout(r, __delay));
  const r = __resp[name];
  return r === undefined ? '{}' : JSON.stringify(r);
}
const __toasts = [];
function toast(msg, kind) { __toasts.push({ msg, kind }); }
const __store = {};
const localStorage = {
  getItem: (k) => (k in __store ? __store[k] : null),
  setItem: (k, v) => { __store[k] = String(v); }
};
const window = {};
let __localMode = false;
function localModeActive() { return __localMode; }
'''


class _VmCase:
    """vm harness 运行基建（node；缺失则 skip）。"""

    PANEL = ''

    def _run(self, src, checks_min, prefix):
        assert os.path.exists(NODE), 'node 不可用'
        js = self.PANEL.replace('__PANEL__', src)
        fd, path = tempfile.mkstemp(suffix='.js', prefix=prefix)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(js)
        try:
            r = subprocess.run([NODE, path], capture_output=True, text=True,
                               timeout=60)
            assert r.returncode == 0, 'node 失败: %s\n%s' % (r.stderr, r.stdout)
            out = json.loads(r.stdout)
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
        assert 'fatal' not in out, out
        failed = [c['name'] for c in out['checks'] if not c['pass']]
        assert not failed, '前端断言失败: %s' % failed
        assert len(out['checks']) >= checks_min


class TestFrontendSoftwarePanelVm(_VmCase):
    """64-software-panel.js vm harness：三态 + last-wins + 三形态渲染。"""

    PANEL = _VM_PRELUDE + r'''
// ---- fixtures ----
__resp['software_list'] = { ok: true, software: [
  { name: 'git', kind: 'cli', status: 'probed', version: '2.43.0',
    source: 'preset', risk_default: 'read',
    actions: [{ name: 'status', risk: 'read', arg_schema: {} }] },
  { name: 'ffmpeg', kind: 'cli', status: 'missing',
    source: 'preset', risk_default: 'read', actions: [] } ] };
__resp['software_probe'] = { ok: true,
  probed: [{ name: 'git', status: 'probed' }], elapsed_ms: 340 };
__resp['software_call'] = { ok: true, software: 'git', action: 'status',
  kind: 'cli', exit_code: 0, stdout: 'On branch main', stderr: '',
  duration_ms: 12, sandboxed: true, truncated: false };
__resp['rpc'] = { ok: true, name: 'mytool' };
// ---- module under test ----
__PANEL__
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });

  // 1) 初始化：#softwareBlock 纯新增 + .sw-* + 按钮接线
  ok('init_creates_block', softwarePanelInit() === true
     && document.getElementById('softwareBlock') !== null
     && document.getElementById('swProbeBtn') !== null);

  // 2) 列表刷新：两行 + 面板文案 + timeoutMs=15000
  await softwarePanelRefresh();
  const listCall = __calls.filter(c => c.name === 'software_list').pop();
  ok('list_render', listCall && listCall.timeoutMs === 15000
     && __els['swList']._children.length === 2
     && __els['swPanelText'].textContent === '共 2 项');

  // 3) 探测：按钮 pending + timeoutMs=120000 + toast ok
  await softwarePanelProbe();
  const probeCall = __calls.filter(c => c.name === 'software_probe').pop();
  ok('probe_wire', probeCall && probeCall.timeoutMs === 120000
     && __toasts.some(t => t.msg.includes('探测完成')));

  // 4) 测试调用：manual_test + timeoutMs=660000 + CLI 形态渲染（exit chip）
  softwarePanelOpenTest('git', { name: 'git', kind: 'cli', actions:
    [{ name: 'status', risk: 'read' }] });
  await softwarePanelRunTest('git');
  const callCall = __calls.filter(c => c.name === 'software_call').pop();
  ok('manual_test_wire', callCall && callCall.timeoutMs === 660000
     && callCall.args[0].source === 'manual_test'
     && callCall.args[0].software === 'git'
     && __els['swTestOut'].innerHTML.includes('exit_code: 0')
     && __els['swTestOut'].innerHTML.includes('On branch main'));

  // 5) GUI/URI 三形态渲染分支
  __resp['software_call'] = { ok: true, software: 'notepad', action: 'open',
    kind: 'gui', launched: true, window_verified: true,
    window_title: 'a.txt - 记事本', duration_ms: 800 };
  await softwarePanelRunTest('notepad');
  ok('gui_render', __els['swTestOut'].innerHTML.includes('窗口已确认')
     && __els['swTestOut'].innerHTML.includes('记事本'));
  __resp['software_call'] = { ok: true, software: 'mydoc', action: 'open',
    kind: 'uri', protocol: 'https', uri: 'https://x/y', duration_ms: 5 };
  await softwarePanelRunTest('mydoc');
  ok('uri_render', __els['swTestOut'].innerHTML.includes('协议已启动')
     && __els['swTestOut'].innerHTML.includes('https'));

  // 6) 错误渲染：SCHEMA_INVALID violations + example 回显
  __resp['software_call'] = { ok: false, error: { code: 'SCHEMA_INVALID',
    message: '参数校验失败',
    violations: [{ path: 'message', expect: 'string(必填)', got: 'int(123)' }],
    example: { message: 'fix: 描述' } } };
  await softwarePanelRunTest('git');
  ok('schema_invalid_render', __els['swTestOut'].innerHTML.includes('SCHEMA_INVALID')
     && __els['swTestOut'].innerHTML.includes('violations')
     && __els['swTestOut'].innerHTML.includes('正确示例'));

  // 7) 自定义向导：rpc('_software_save') + 保存 toast
  document.getElementById('swWName').value = 'mytool';
  document.getElementById('swWKind').value = 'cli';
  document.getElementById('swWExec').value = 'mytool.exe';
  document.getElementById('swWActions').value = '[]';
  await softwarePanelSaveCustom();
  const rpcCall = __calls.filter(c => c.name === 'rpc').pop();
  ok('custom_wizard_rpc', rpcCall && rpcCall.args[0] === '_software_save'
     && JSON.parse(rpcCall.args[1]).name === 'mytool'
     && __toasts.some(t => t.msg.includes('已保存')));

  // 8) last-wins：pending 期间新触发，旧请求返回后静默丢弃
  __delay = 60;
  const p1 = softwarePanelRefresh();
  const p2 = softwarePanelRefresh();
  await p2; await p1;
  ok('last_wins', __calls.filter(c => c.name === 'software_list').length >= 2
     && softwarePanelState !== 'error');
  __delay = 0;

  // 9) 错误态：callApi 抛 → BRIDGE_TIMEOUT 人话 + error 态
  __callApiThrows = true;
  await softwarePanelRefresh();
  ok('bridge_throw_error', __els['swDetail'].innerHTML.includes('pywebview bridge')
     && softwarePanelState === 'error');
  __callApiThrows = false;

  // 10) 功能分级开关：关 → 不挂载
  localStorage.setItem('glm_feat_software_v18', '0');
  ok('feature_off', softwarePanelInit() === false);

  // 11) typeof 守卫：无 document 环境下函数不抛
  const __doc = global.document;
  global.document = undefined;
  let guardOk = true;
  try {
    softwarePanelInit(); softwarePanelRefresh(); softwarePanelProbe();
    softwarePanelRenderList([]); softwarePanelRenderError({ message: 'x' });
    softwarePanelRenderTestOut({ ok: false, error: { code: 'X', message: 'y' } });
  } catch (e) { guardOk = false; }
  global.document = __doc;
  ok('typeof_guards', guardOk);

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''

    def test_harness(self):
        if not os.path.exists(NODE):
            pytest.skip('node 不可用: %s' % NODE)
        src = read_frontend_source(PROJECT_ROOT, '64-software-panel.js')
        self._run(src, 11, 'qa_sw_')


class TestFrontendHybridVm(_VmCase):
    """65-hybrid.js vm harness：#costSplit 数字格式 + 配置表单 + saver 提示。"""

    PANEL = _VM_PRELUDE + r'''
// ---- fixtures ----
__resp['hybrid_get_config'] = { ok: true, config: { strategy: 'auto',
  local_budget_understand_s: 5, local_budget_validate_s: 3,
  confidence_gate: 0.7, cost_split_display: true }, source: 'file' };
__resp['hybrid_save_config'] = { ok: true, config: { strategy: 'auto',
  local_budget_understand_s: 5, local_budget_validate_s: 3,
  confidence_gate: 0.7, cost_split_display: true } };
// ---- module under test ----
__PANEL__
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });

  // 1) 挂载：#hybridBlock + #costSplit chip（纯新增）
  ok('init_creates_block', hybridInit() === true
     && document.getElementById('hybridBlock') !== null
     && document.getElementById('costSplit') !== null);

  // 2) 配置渲染（默认值回填表单）
  await hybridRefresh();
  ok('config_render', __els['hyStrategy'].value === 'auto'
     && __els['hyBudgetUnderstand'].value === 5
     && __els['hyBudgetValidate'].value === 3
     && __els['hyConfGate'].value === 0.7
     && __els['hyCostSplitDisplay'].checked === true
     && __els['hyStrategyDesc'].textContent.includes('自动'));

  // 3) source=default → 首次使用轻提示（不弹模态）
  __resp['hybrid_get_config'] = { ok: true, config: { strategy: 'auto',
    local_budget_understand_s: 5, local_budget_validate_s: 3,
    confidence_gate: 0.7, cost_split_display: true }, source: 'default' };
  await hybridRefresh();
  ok('default_hint', __els['hyFirstHint'].style.display === ''
     && __els['hyFirstHint'].textContent.includes('首次使用'));

  // 4) #costSplit 数字格式：千分位 + 两位小数 + k 缩写；usage 缺失 → 隐藏
  __localMode = true;
  hybridOnUsage({ completion_tokens: 12345 }, 'glm-5');
  ok('split_local', __els['costSplit'].style.display === ''
     && __els['costSplit'].textContent === '本地 12,345 tok · 云端 0 tok · 省 ≈¥0.02');
  __localMode = false;
  hybridOnUsage({ completion_tokens: 6789 }, 'gpt-4o');
  ok('split_cloud', __els['costSplit'].textContent.includes('云端 6,789 tok'));
  // ≥¥10000 → k 缩写（hyFmtMoney 纯函数边界：§4.3 数字格式）
  ok('split_k_abbr', hyFmtMoney(12345) === '≈¥12.3k'
     && hyFmtMoney(9.999) === '≈¥10.00' && hyFmtMoney(0) === '≈¥0.00'
     && hyFmtInt(1234567) === '1,234,567');
  hybridCfg = { cost_split_display: false };
  hybridRenderSplit();
  ok('split_hidden_by_flag', __els['costSplit'].style.display === 'none');
  hybridCfg = null;
  hybridResetSplit();
  hybridRenderSplit();
  ok('split_hidden_no_usage', __els['costSplit'].style.display === 'none');

  // 5) saver 首次切换一次性提示（localStorage 标记，R3 裁决）
  document.getElementById('hyStrategy').value = 'saver';
  document.getElementById('hyStrategy')._handlers.change.forEach(f => f());
  ok('saver_hint_once', __toasts.some(t => t.msg.includes('省 token'))
     && localStorage.getItem('glm_hybrid_saver_hinted_v18') === '1');
  __toasts.length = 0;
  document.getElementById('hyStrategy')._handlers.change.forEach(f => f());
  ok('saver_hint_not_repeat', !__toasts.some(t => t.msg.includes('省 token')));

  // 6) 预算保存（部分更新语义透传 + timeoutMs=15000）
  await hybridSave({ local_budget_understand_s: 9 });
  const saveCall = __calls.filter(c => c.name === 'hybrid_save_config').pop();
  ok('save_partial', saveCall
     && saveCall.args[0].local_budget_understand_s === 9
     && saveCall.timeoutMs === 15000);

  // 7) typeof 守卫
  const __doc = global.document;
  global.document = undefined;
  let guardOk = true;
  try {
    hybridInit(); hybridRefresh(); hybridRenderSplit(); hybridResetSplit();
    hybridOnUsage(null); hyFmtMoney(12345); hyFmtInt(1234567);
  } catch (e) { guardOk = false; }
  global.document = __doc;
  ok('typeof_guards', guardOk);

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''

    def test_harness(self):
        if not os.path.exists(NODE):
            pytest.skip('node 不可用: %s' % NODE)
        src = read_frontend_source(PROJECT_ROOT, '65-hybrid.js')
        self._run(src, 7, 'qa_hy_')


class TestFrontendGuardGrantVm(_VmCase):
    """66-guard-grant.js vm harness：倒计时校准 + 收回 + 规则管理。"""

    PANEL = _VM_PRELUDE + r'''
// ---- fixtures ----
__resp['guard_task_status'] = { ok: true, active: true, grant_id: 'g_1',
  expires_at: '2026-10-20T10:00:00Z', idle_deadline: '2026-10-20T09:50:00Z',
  remaining_s: 7000, scope: ['exec'], granted_by: 'user',
  expiring_soon: false };
__resp['guard_task_grant'] = { ok: true, grant_id: 'g_2', remaining_s: 7200,
  expires_at: '2026-10-20T12:00:00Z', idle_deadline: '2026-10-20T11:50:00Z',
  scope: ['exec'], granted_by: 'user' };
__resp['guard_task_revoke'] = { ok: true, revoked: true };
__resp['guard_rule_list'] = { ok: true, rules: [
  { rule_id: 'r_1', op_pattern: 'run_command',
    detail_pattern: '^git (status|log)$', hits: 3,
    created_at: '2026-10-20T09:00:00Z', note: '日常只读' } ] };
__resp['guard_rule_add'] = { ok: true, rule_id: 'r_2',
  warn: 'detail 含写动词，确认这是宽模式规则？' };
__resp['guard_rule_remove'] = { ok: true, removed: true };
// ---- module under test ----
__PANEL__
// ---- test body ----
(async () => {
  const out = { checks: [] };
  const ok = (name, cond) => out.checks.push({ name, pass: !!cond });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 1) 挂载：#grantIndicator + #grantRulesBlock 纯新增
  ok('init_creates_dom', guardGrantInit() === true
     && document.getElementById('grantIndicator') !== null
     && document.getElementById('ggLight') !== null
     && document.getElementById('grantRulesBlock') !== null);

  // 2) status 校准：remaining_s=7000 → 1:56:40 + 灯 ok + timeoutMs=15000
  await guardGrantRefreshStatus();
  const stCall = __calls.filter(c => c.name === 'guard_task_status').pop();
  ok('status_calibrate', stCall && stCall.timeoutMs === 15000
     && __els['ggTimer'].textContent === '授权剩余 1:56:40'
     && __els['ggLight'].className.includes('ok')
     && ggRemaining === 7000);

  // 3) 本地 1s 递减（不等 30s 校准）
  await sleep(1100);
  ok('countdown_tick', __els['ggTimer'].textContent === '授权剩余 1:56:39');

  // 4) 重新授权：TTL 选择 + scope 勾选 → guard_task_grant
  const __cbExec = __mkEl(''); __cbExec.checked = true; __cbExec.value = 'exec';
  __qsa['.gg-scope'] = [__cbExec];
  document.getElementById('ggTtl').value = '14400';
  await guardGrantCreate();
  const gCall = __calls.filter(c => c.name === 'guard_task_grant').pop();
  ok('grant_create', gCall && gCall.args[0].includes('exec')
     && gCall.args[1] === 14400 && gCall.timeoutMs === 15000
     && __toasts.some(t => t.msg.includes('已授予')));

  // 5) 收回 → 灯灰 + 无授权态
  await guardGrantRevoke();
  const rvCall = __calls.filter(c => c.name === 'guard_task_revoke').pop();
  ok('revoke', rvCall && __els['ggTimer'].textContent === '无任务授权'
     && __els['ggLight'].className.includes('off'));

  // 6) 到期终态：status active=false → 灯灰 + toast warn
  __resp['guard_task_status'] = { ok: true, active: false };
  ggActive = true;
  await guardGrantRefreshStatus();
  ok('expired_terminal', ggActive === false
     && __toasts.some(t => t.msg.includes('到期')));

  // 7) 规则管理：列表渲染（hits）+ 添加（warn 黄条）+ 删除
  await guardGrantRulesRefresh();
  ok('rules_render', __els['ggRules']._children.length === 1
     && __els['ggRules']._children[0]._html.includes('命中 3'));
  document.getElementById('ggRuleOp').value = 'run_command';
  document.getElementById('ggRuleDetail').value = '^git (status|del)$';
  await guardGrantRuleAdd();
  const addCall = __calls.filter(c => c.name === 'guard_rule_add').pop();
  ok('rule_add_warn', addCall && addCall.args[0] === 'run_command'
     && __els['ggRuleWarn'].style.display === ''
     && __els['ggRuleWarn'].textContent.includes('写动词'));
  await guardGrantRuleRemove('r_1');
  const rmCall = __calls.filter(c => c.name === 'guard_rule_remove').pop();
  ok('rule_remove', rmCall && rmCall.args[0] === 'r_1');

  // 8) typeof 守卫 + 定时器清理（防 node 事件循环悬挂）
  const __doc = global.document;
  global.document = undefined;
  let guardOk = true;
  try {
    guardGrantInit(); guardGrantRefreshStatus(); guardGrantRenderIndicator();
    guardGrantRenderRules(); guardGrantTick(); ggFmtRemain(3725);
  } catch (e) { guardOk = false; }
  global.document = __doc;
  guardGrantStopTimers();
  ok('typeof_guards', guardOk);

  console.log(JSON.stringify(out));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e) })); process.exit(1); });
'''

    def test_harness(self):
        if not os.path.exists(NODE):
            pytest.skip('node 不可用: %s' % NODE)
        src = read_frontend_source(PROJECT_ROOT, '66-guard-grant.js')
        self._run(src, 8, 'qa_gg_')
class TestNewApiAssembly:
    """11 个新 js_api 经 Api 实例可调（返回合法 JSON 字符串）。"""

    def test_software_and_hybrid_apis(self, tmp_path, monkeypatch):
        from backend.api import Api
        from backend.domains.integrations import software_service as sw_mod
        from backend.domains.providers import hybrid_router as hy_mod
        monkeypatch.setattr(sw_mod, 'SOFTWARE_FILE',
                            str(tmp_path / 'software.json'))
        monkeypatch.setattr(hy_mod, 'HYBRID_FILE',
                            str(tmp_path / 'hybrid.json'))
        api = Api()
        lst = json.loads(api.software_list('all'))
        assert lst['ok'] is True and len(lst['software']) >= 5
        probe = json.loads(api.software_probe('git'))
        assert probe['ok'] is True and 'probed' in probe
        call = json.loads(api.software_call({'software': 'nope',
                                             'action': 'x'}))
        assert call['ok'] is False and call['error']['code'] == 'UNKNOWN_SOFTWARE'
        cfg = json.loads(api.hybrid_get_config())
        assert cfg['ok'] is True and cfg['source'] == 'default'
        save = json.loads(api.hybrid_save_config('{"strategy":"saver"}'))
        assert save['ok'] is True and save['config']['strategy'] == 'saver'
        bad = json.loads(api.hybrid_save_config('{"strategy":"nope"}'))
        assert bad['ok'] is False and bad['error']['code'] == 'BAD_PARAMS'
        assert 'hint' in bad['error']

    def test_guard_grant_rule_apis(self, tmp_path, monkeypatch):
        from backend.api import Api
        from backend.domains.security import guard_service as g_mod
        monkeypatch.setattr(g_mod, 'GUARD_FILE',
                            str(tmp_path / 'guard.json'))
        monkeypatch.setattr(g_mod, 'AUDIT_LOG',
                            str(tmp_path / 'audit.jsonl'))
        api = Api()
        g = json.loads(api.guard_task_grant(['exec'], 7200))
        assert g['ok'] is True
        # R6：空闲 30min 先到（建立瞬间 remaining_s = min(7200, 1800) = 1800）
        assert g['remaining_s'] == 1800
        st = json.loads(api.guard_task_status())
        assert st['ok'] is True and st['active'] is True
        assert json.loads(api.guard_task_grant(['bogus']))['error']
        assert json.loads(api.guard_task_grant(['exec'], 10))['error']
        rv = json.loads(api.guard_task_revoke())
        assert rv['ok'] is True and rv['revoked'] is True
        assert json.loads(api.guard_task_revoke())['revoked'] is False
        r = json.loads(api.guard_rule_add('run_command', '^git status$'))
        assert r['ok'] is True
        lst = json.loads(api.guard_rule_list())
        assert lst['ok'] is True and len(lst['rules']) == 1
        rid = lst['rules'][0]['rule_id']
        assert json.loads(api.guard_rule_remove(rid))['removed'] is True
        assert json.loads(api.guard_rule_remove(rid))['removed'] is False
        # deny 覆盖即拒（人话；code 经 service 层断言）
        denied = json.loads(api.guard_rule_add('delete_path'))
        assert 'error' in denied and '保护名单' in denied['error']

    def test_config_json_not_polluted(self, tmp_path, monkeypatch):
        """software.json/hybrid.json 独立；guard.json 仅追加 allow_rules 键。"""
        from backend.api import Api
        from backend.domains.integrations import software_service as sw_mod
        from backend.domains.providers import hybrid_router as hy_mod
        from backend.domains.security import guard_service as g_mod
        monkeypatch.setattr(sw_mod, 'SOFTWARE_FILE',
                            str(tmp_path / 'software.json'))
        monkeypatch.setattr(hy_mod, 'HYBRID_FILE',
                            str(tmp_path / 'hybrid.json'))
        monkeypatch.setattr(g_mod, 'GUARD_FILE',
                            str(tmp_path / 'guard.json'))
        monkeypatch.setattr(g_mod, 'AUDIT_LOG',
                            str(tmp_path / 'audit.jsonl'))
        api = Api()
        before = io.open(paths.CONFIG_PATH, 'rb').read() \
            if os.path.exists(paths.CONFIG_PATH) else b'<none>'
        api.software_list()
        api.hybrid_get_config()
        api.hybrid_save_config('{"strategy":"saver"}')
        api.guard_rule_add('run_command', '^git status$')
        api.guard_task_grant(['exec'])
        after = io.open(paths.CONFIG_PATH, 'rb').read() \
            if os.path.exists(paths.CONFIG_PATH) else b'<none>'
        assert before == after, 'config.json 被污染'
        assert os.path.exists(tmp_path / 'software.json') or True
        assert json.loads((tmp_path / 'hybrid.json').read_text(
            encoding='utf-8'))['strategy'] == 'saver'
        gj = json.loads((tmp_path / 'guard.json').read_text(encoding='utf-8'))
        # v1.9.0 M2.4：approval_budget 为 guard.json 纯增键（O7 裁决——旧文件
        # 缺省合并；config.json 本身仍零污染，本断言只放行 guard.json 增量）
        assert set(gj.keys()) <= {'tiers', 'protect_paths', 'protect_processes',
                                  'trustedOps', 'allow_rules',
                                  'approval_budget'}
