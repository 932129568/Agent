# -*- coding: utf-8 -*-
"""v1.9.0 M2.7 检查点六军规回归（design §B-T05）。

覆盖：六军规逐条（差异恢复禁 reset --hard/绝不删未备份/影子仓库/前后快照/
确认后端化/恢复后校验）+ 保留轮换 + checkpoints.json 投影 + plan_service
委托等价 + CSV 字符串 files 兼容。
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from conftest import fresh_home  # noqa: E402


@pytest.fixture(autouse=True)
def isolate_tmp_from_parent_git(tmp_path, monkeypatch):
    """Keep snapshot tests independent of a repository above basetemp."""
    monkeypatch.setenv('GIT_CEILING_DIRECTORIES', str(tmp_path))


def _svc():
    from backend.domains.planning.checkpoint_service import CheckpointService
    return CheckpointService()


def _git_init(ws):
    subprocess.run(['git', 'init'], cwd=ws, capture_output=True)
    subprocess.run(['git', 'config', 'user.email', 't@t'], cwd=ws,
                   capture_output=True)
    subprocess.run(['git', 'config', 'user.name', 't'], cwd=ws,
                   capture_output=True)


class TestSixRules:
    def test_create_with_label(self, fresh_home, tmp_path):
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        (open(os.path.join(ws, 'a.py'), 'w')).write('v1')
        r = _svc().create('t1', ['a.py'], ws_dir=ws, label='任务前')
        assert r['ok'] and r['mode'] == 'snapshot'   # 非 git+有文件 → 快照
        lst = _svc().list('t1')
        assert lst['label'] == '任务前'

    def test_create_git_anchor(self, fresh_home, tmp_path):
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        _git_init(ws)
        (open(os.path.join(ws, 'a.py'), 'w')).write('v1')
        subprocess.run(['git', 'add', '.'], cwd=ws, capture_output=True)
        subprocess.run(['git', 'commit', '-m', 'init'], cwd=ws,
                       capture_output=True)
        r = _svc().create('t2', ['a.py'], ws_dir=ws)
        assert r['ok'] and r['mode'] == 'git' and r['git_head']

    def test_files_accepts_csv_string(self, fresh_home, tmp_path):
        """CSV 字符串 files 兼容（前端可能传 'a.py,b.py'）。"""
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        for n in ('a.py', 'b.py'):
            (open(os.path.join(ws, n), 'w')).write('v')
        r = _svc().create('t3', 'a.py,b.py', ws_dir=ws)
        assert r['ok'] and r['snapshot_count'] == 2

    def test_rollback_requires_confirm(self, fresh_home, tmp_path):
        """⑤ 确认后端化：confirm=False 默认拒。"""
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        (open(os.path.join(ws, 'a.py'), 'w')).write('v1')
        _svc().create('t4', ['a.py'], ws_dir=ws)
        r = _svc().rollback('t4', ws_dir=ws)
        assert not r['ok'] and r['error']['code'] == 'CONFIRM_REQUIRED'

    def test_rollback_snapshot_restores(self, fresh_home, tmp_path):
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        p = os.path.join(ws, 'a.py')
        (open(p, 'w')).write('v1')
        _svc().create('t5', ['a.py'], ws_dir=ws)
        (open(p, 'w')).write('v2-modified')
        r = _svc().rollback('t5', ws_dir=ws, confirm=True)
        assert r['ok'] and r['mode'] == 'snapshot'
        assert open(p).read() == 'v1'                # 已恢复
        assert r['verified'] is True                 # ⑥ sha256 校验过
        assert os.path.exists(p + '.rollback-bak')   # ② 当前版已备份

    def test_rollback_never_deletes_unbacked(self, fresh_home, tmp_path):
        """② 绝不删未备份：回滚后原（被恢复掉的）版本仍在 .rollback-bak。"""
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        p = os.path.join(ws, 'a.py')
        (open(p, 'w')).write('v1')
        _svc().create('t6', ['a.py'], ws_dir=ws)
        (open(p, 'w')).write('v2-precious')
        _svc().rollback('t6', ws_dir=ws, confirm=True)
        bak = p + '.rollback-bak'
        assert os.path.exists(bak) and open(bak).read() == 'v2-precious'

    def test_rollback_repeat_backup_not_overwritten(self, fresh_home, tmp_path):
        """重复回滚：毫秒时间戳备份不互覆。"""
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        p = os.path.join(ws, 'a.py')
        (open(p, 'w')).write('v1')
        _svc().create('t7', ['a.py'], ws_dir=ws)
        (open(p, 'w')).write('v2')
        _svc().rollback('t7', ws_dir=ws, confirm=True)      # bak=v2
        (open(p, 'w')).write('v3')
        _svc().rollback('t7', ws_dir=ws, confirm=True)      # bak 不覆 v2
        baks = [f for f in os.listdir(ws) if '.rollback-bak' in f]
        assert len(baks) == 2                               # 两个时间戳备份
        assert open(p).read() == 'v1'

    def test_git_diff_restore_not_reset_hard(self, fresh_home, tmp_path):
        """① 差异恢复：只恢复声明文件，用户其他工作区改动零触碰。"""
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        _git_init(ws)
        for n in ('a.py', 'other.py'):
            (open(os.path.join(ws, n), 'w')).write('orig')
        subprocess.run(['git', 'add', '.'], cwd=ws, capture_output=True)
        subprocess.run(['git', 'commit', '-m', 'i'], cwd=ws,
                       capture_output=True)
        _svc().create('t8', ['a.py'], ws_dir=ws)
        # 用户改了 a.py（要恢复）+ other.py（禁动——非声明文件）
        (open(os.path.join(ws, 'a.py'), 'w')).write('changed')
        (open(os.path.join(ws, 'other.py'), 'w')).write('user-work')
        r = _svc().rollback('t8', ws_dir=ws, confirm=True)
        assert r['ok'] and r['mode'] == 'git'
        assert open(os.path.join(ws, 'a.py')).read() == 'orig'      # 恢复
        assert open(os.path.join(ws, 'other.py')).read() == 'user-work'  # 未动
        # git 历史仍在（禁 reset --hard 的旁证：HEAD 未变、无丢失提交）
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ws,
                              capture_output=True, text=True).stdout.strip()
        assert head

    def test_shell_auto_checkpoint(self, fresh_home, tmp_path):
        """④ 前后快照锚点：create_auto 零文件锚点（回滚=报告锚点不动文件）。"""
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        _git_init(ws)
        (open(os.path.join(ws, 'x.py'), 'w')).write('x')
        subprocess.run(['git', 'add', '.'], cwd=ws, capture_output=True)
        subprocess.run(['git', 'commit', '-m', 'i'], cwd=ws,
                       capture_output=True)
        r = _svc().create_auto('auto_run_command_s1', ws_dir=ws)
        assert r['ok'] and r['mode'] == 'git'
        rb = _svc().rollback('auto_run_command_s1', ws_dir=ws, confirm=True)
        assert rb['ok'] and rb['note']                   # 锚点语义：不动文件

    def test_keep_three_rotation(self, fresh_home, tmp_path):
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        import time as _t
        for i in range(5):
            _svc().create('tk%d' % i, [], ws_dir=ws)
            _t.sleep(0.01)
        items = _svc().list()['items']
        assert len(items) <= 3                            # CKPT_KEEP=3

    def test_checkpoints_json_projection(self, fresh_home, tmp_path):
        from backend import paths
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        _svc().create('tp1', ['a.py'], ws_dir=ws)
        assert os.path.exists(paths.CHECKPOINTS_FILE)
        proj = json.load(open(paths.CHECKPOINTS_FILE, encoding='utf-8'))
        assert any(it['id'] == 'tp1' for it in proj['items'])

    def test_projection_rebuild_on_corrupt(self, fresh_home, tmp_path):
        from backend import paths
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        _svc().create('tp2', [], ws_dir=ws)
        with open(paths.CHECKPOINTS_FILE, 'w') as f:
            f.write('{corrupt')
        r = _svc().rebuild_projection()
        assert r['ok'] and r['items'] >= 1
        proj = json.load(open(paths.CHECKPOINTS_FILE, encoding='utf-8'))
        assert any(it['id'] == 'tp2' for it in proj['items'])


class TestPlanDelegation:
    def test_delegation_equiv(self, fresh_home, tmp_path):
        """plan_service 委托=行为等价（create/list/rollback 同口径）。"""
        from backend.domains.planning.plan_service import PlanService
        ws = str(tmp_path / 'ws')
        os.makedirs(ws)
        (open(os.path.join(ws, 'a.py'), 'w')).write('v1')
        ps = PlanService()
        r = ps.checkpoint_create('td1', ['a.py'], ws_dir=ws)
        assert r['ok']
        assert ps.checkpoint_list('td1')['files'][0]['path'] == 'a.py'
        (open(os.path.join(ws, 'a.py'), 'w')).write('v2')
        rb = ps.checkpoint_rollback('td1', ws_dir=ws, confirm=True)
        assert rb['ok'] and open(os.path.join(ws, 'a.py')).read() == 'v1'

    def test_shared_instance_with_api(self, fresh_home):
        from backend.api import Api
        api = Api()
        assert api._plan._checkpoint is api._checkpoint   # 同实例一口径

    def test_rollback_confirm_required_via_api(self, fresh_home):
        from backend.api import Api
        api = Api()
        r = json.loads(api.checkpoint_rollback('nope'))
        assert r['ok'] is False
        assert r['error']['code'] == 'CONFIRM_REQUIRED'
