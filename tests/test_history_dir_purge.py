# -*- coding: utf-8 -*-
"""历史自选存放 + 真删回归（2026-10-21 用户需求）。

覆盖：history.json 独立配置（config.json 零污染）/ 目录校验（存在/可写/系统
目录拒/symlink 归一）/ 切换生效读写 / migrate 搬旧数据 / session_purge 四类
痕迹（sessions+ws+plans+checkpoints）/ js_api 隐身 / 契约零污染。
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


def _mk_dir(home, name='my-hist'):
    d = os.path.join(home, name)
    os.makedirs(d, exist_ok=True)
    return d


class TestHistoryDir:
    def test_default_empty(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().history_dir_get())
        assert r['dir'] == '' and r['sessions_file'].endswith('sessions.json')

    def test_get_uses_single_history_snapshot(self, fresh_home, monkeypatch):
        from backend.api import Api
        from backend import paths
        api = Api()
        api.history_dir_set(_mk_dir(os.environ['HOME'], 'single-snapshot'))
        real_open = open
        reads = []

        def counting_open(file, *args, **kwargs):
            if os.path.abspath(str(file)) == os.path.abspath(paths.HISTORY_FILE):
                reads.append(file)
            return real_open(file, *args, **kwargs)

        monkeypatch.setattr('builtins.open', counting_open)
        result = json.loads(api.history_dir_get())
        assert len(reads) == 1
        assert result['sessions_file'] == os.path.join(result['dir'], 'sessions.json')

    def test_set_and_effect(self, fresh_home):
        from backend.api import Api
        api = Api()
        d = _mk_dir(os.environ['HOME'])
        r = json.loads(api.history_dir_set(d))
        assert r['ok'] and r['dir'] == os.path.realpath(d)
        r2 = json.loads(api.history_dir_get())
        assert r2['dir'] == os.path.realpath(d)
        assert r2['sessions_file'].startswith(os.path.realpath(d))
        # 读写走新目录
        api.save_sessions('[{"id":"s1","title":"t","messages":[]}]')
        assert os.path.exists(os.path.join(d, 'sessions.json'))
        assert json.loads(api.get_sessions())[0]['id'] == 's1'

    def test_nonexistent_dir_rejected(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().history_dir_set('Z://no-such-dir-xyz'))
        assert 'error' in r

    def test_system_dir_rejected(self, fresh_home):
        from backend.api import Api
        for bad in ('C://Windows', 'C://Program Files', 'C://Program Files (x86)'):
            r = json.loads(Api().history_dir_set(bad))
            assert 'error' in r, bad

    def test_restore_default(self, fresh_home):
        from backend.api import Api
        api = Api()
        d = _mk_dir(os.environ['HOME'])
        api.history_dir_set(d)
        r = json.loads(api.history_dir_set(''))
        assert r['ok'] and r['dir'] == ''
        assert json.loads(api.history_dir_get())['dir'] == ''

    def test_migrate_copies_old(self, fresh_home):
        from backend.api import Api
        from backend import paths
        api = Api()
        # 预置默认位置有旧数据
        with open(paths.SESSIONS_PATH, 'w', encoding='utf-8') as f:
            f.write('[{"id":"old1","title":"旧","messages":[]}]')
        d = _mk_dir(os.environ['HOME'], 'mig')
        r = json.loads(api.history_dir_set(d, True))
        assert r['ok'] and r['migrated'] is True
        assert os.path.exists(os.path.join(d, 'sessions.json'))
        assert json.loads(api.get_sessions())[0]['id'] == 'old1'

    def test_migrate_no_overwrite(self, fresh_home):
        from backend.api import Api
        api = Api()
        d = _mk_dir(os.environ['HOME'], 'mig2')
        with open(os.path.join(d, 'sessions.json'), 'w', encoding='utf-8') as f:
            f.write('[{"id":"new1","title":"新","messages":[]}]')
        from backend import paths
        with open(paths.SESSIONS_PATH, 'w', encoding='utf-8') as f:
            f.write('[{"id":"old1","title":"旧","messages":[]}]')
        r = json.loads(api.history_dir_set(d, True))
        assert r['ok'] and r['migrated'] is False   # 已存在不覆盖
        assert json.loads(api.get_sessions())[0]['id'] == 'new1'

    def test_config_json_untouched(self, fresh_home):
        """铁律：history.json 独立文件，config.json 零新增键。"""
        from backend.api import Api
        from backend import paths
        api = Api()
        before = set()
        if os.path.exists(paths.CONFIG_PATH):
            before = set(json.load(open(paths.CONFIG_PATH, encoding='utf-8')).keys())
        d = _mk_dir(os.environ['HOME'])
        api.history_dir_set(d)
        after = set()
        if os.path.exists(paths.CONFIG_PATH):
            after = set(json.load(open(paths.CONFIG_PATH, encoding='utf-8')).keys())
        assert before == after
        assert os.path.exists(paths.HISTORY_FILE)

    def test_invalid_history_json_fallback(self, fresh_home):
        from backend.api import Api
        from backend import paths
        os.makedirs(os.path.dirname(paths.HISTORY_FILE), exist_ok=True)
        with open(paths.HISTORY_FILE, 'w', encoding='utf-8') as f:
            f.write('{bad json')
        r = json.loads(Api().history_dir_get())
        assert r['dir'] == ''       # 损坏回落默认，不炸


class TestSessionPurge:
    def _seed_plan(self, tid):
        from backend.domains.planning import plan_service as ps
        os.makedirs(ps._plans_dir(), exist_ok=True)
        with open(ps._task_path(tid), 'w', encoding='utf-8') as f:
            json.dump({'task_id': tid, 'title': 't', 'steps': [],
                       'status': 'planning'}, f)
        ck = ps._ckpt_path(tid)
        os.makedirs(ck, exist_ok=True)
        with open(os.path.join(ck, 'f.txt'), 'w') as f:
            f.write('x')

    def test_purge_all_traces(self, fresh_home):
        from backend.api import Api
        from backend import paths
        api = Api()
        self._seed_plan('tk1')
        # sessions + ws 预置
        api.save_sessions('[{"id":"s1","title":"t","messages":[]}]')
        with open(paths.SESSION_WS_FILE, 'w', encoding='utf-8') as f:
            json.dump({'s1': 'D:////ws'}, f)
        r = json.loads(api.session_purge('s1', '["tk1"]'))
        assert r['ok']
        rm = r['removed']
        assert rm['sessions'] == 1 and rm['ws'] == 1
        assert rm['plans'] == 1 and rm['checkpoints'] == 1
        # 文件层面验证真没了
        assert json.loads(api.get_sessions()) == []
        assert 's1' not in json.load(open(paths.SESSION_WS_FILE, encoding='utf-8'))
        from backend.domains.planning import plan_service as ps
        assert not os.path.exists(ps._task_path('tk1'))
        assert not os.path.exists(ps._ckpt_path('tk1'))

    def test_purge_no_task_ids_ok(self, fresh_home):
        from backend.api import Api
        api = Api()
        api.save_sessions('[{"id":"s2","title":"t","messages":[]}]')
        r = json.loads(api.session_purge('s2', '[]'))
        assert r['ok'] and r['removed']['sessions'] == 1

    def test_purge_unknown_sid_noop(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().session_purge('nope', '[]'))
        assert r['ok'] and r['removed']['sessions'] == 0


class TestJsApiSurface:
    def test_stealth(self):
        from backend.api import _V12_EXTRA
        for m in ('history_dir_get', 'history_dir_set', 'session_purge'):
            assert m in _V12_EXTRA

    def test_pick_folder_not_double_registered(self):
        """pick_folder 是 legacy 契约方法（工作区目录选择）——不在 _V12_EXTRA。"""
        from backend.api import _V12_EXTRA
        assert 'pick_folder' not in _V12_EXTRA

    def test_contract_clean(self, fresh_home):
        from backend.api import Api
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from conftest import legacy
        a = json.loads(legacy.Api().get_api_info())
        b = json.loads(Api().get_api_info())
        assert a['methods'] == b['methods']


class TestExportSave:
    """导出改保存对话框 + 后端写盘（2026-10-21 P1：blob a.click() 在 WebView2
    里弹模态下载 UI 阻塞消息循环——导出后界面卡死只能重开）。

    安全约束（P1 二期）：save_export_file 仅接受 pick_save_path 对话框登记过的
    路径（进程内一次性集合）——测试经假对话框窗口走真实登记流。
    """

    def test_save_export_file_ok(self, fresh_home):
        from backend.api import Api
        api = Api()
        p = os.path.join(os.environ['HOME'], 'chat.md')

        class _FakeSaveDialog:
            def create_file_dialog(self, dialog_type, directory='', save_filename=''):
                return [p]

        api._runtime.win = _FakeSaveDialog()      # 模拟对话框选中路径
        picked = json.loads(api.pick_save_path('chat.md'))
        assert picked['ok'] and picked['path'] == p
        r = json.loads(api.save_export_file(p, '# 导出\n内容行'))
        assert r['ok'] and r['bytes'] > 0
        assert '# 导出' in open(p, encoding='utf-8').read()

    def test_unregistered_path_rejected(self, fresh_home):
        """安全约束：未经导出对话框登记的路径一律拒绝（防任意路径写）。"""
        from backend.api import Api
        p = os.path.join(os.environ['HOME'], 'chat.md')
        r = json.loads(Api().save_export_file(p, 'x'))
        assert 'error' in r and not os.path.exists(p)

    def test_empty_path_rejected(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().save_export_file('', 'x'))
        assert 'error' in r

    def test_bad_parent_rejected(self, fresh_home):
        from backend.api import Api
        for bad in ('Z://no-dir-xyz//a.md', 'Z:\\no-dir-xyz\\a.md'):
            r = json.loads(Api().save_export_file(bad, 'x'))
            assert 'error' in r

    def test_oversize_rejected(self, fresh_home):
        from backend.api import Api
        p = os.path.join(os.environ['HOME'], 'big.md')
        r = json.loads(Api().save_export_file(p, 'x' * (9 * 1024 * 1024)))
        assert 'error' in r and not os.path.exists(p)

    def test_pick_save_path_no_window(self, fresh_home):
        from backend.api import Api
        r = json.loads(Api().pick_save_path('a.md'))
        assert 'error' in r        # 无窗口 → err（前端 toast 回落）

    def test_stealth_and_contract(self, fresh_home):
        from backend.api import Api, _V12_EXTRA
        assert 'pick_save_path' in _V12_EXTRA and 'save_export_file' in _V12_EXTRA
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from conftest import legacy
        a = json.loads(legacy.Api().get_api_info())
        b = json.loads(Api().get_api_info())
        assert a['methods'] == b['methods']
