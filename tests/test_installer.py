# -*- coding: utf-8 -*-
"""安装器测试（v1.7.0）：核心逻辑无头验证 + 端到端静默安装/卸载。

覆盖：默认目录/版本读取、目标体检（系统目录告警/不可写拒绝）、
安装全流程（载荷复制+sha 校验+快捷方式+注册表+清单）、
卸载（默认保留数据/--purge 清数据）、静默 CLI 参数解析、
已构建 setup exe 的端到端（存在则跑，跳过不报错）。
"""
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'installer'))

import installer_core as core   # noqa: E402

pytestmark = pytest.mark.skipif(not hasattr(core.ctypes, 'windll'),
                                reason='安装器仅支持 Windows')

_REG_TEST_ROOT = r'Software\Harbor-Installer-Test'


@pytest.fixture
def reg_cleanup():
    yield
    core.unregister_uninstall(test_root=_REG_TEST_ROOT)


# ---------------- 版本与默认路径 ----------------
class TestVersionAndDefaults:
    def test_version_reads_version_file(self):
        with open(os.path.join(ROOT, 'VERSION'), encoding='utf-8') as f:
            assert core.app_version() == f.read().strip()

    def test_default_dir_under_localappdata(self):
        d = core.default_install_dir()
        assert d.lower().startswith(os.environ.get('LOCALAPPDATA', '').lower())
        assert d.endswith('Harbor')

    def test_paths_shape(self):
        assert core.UNINSTALLER_NAME == 'Uninstall.exe'
        assert core.start_menu_dir().endswith('Programs')
        assert core.desktop_dir().endswith('Desktop')


# ---------------- 目标体检 ----------------
class TestCheckTarget:
    def test_user_dir_ok(self, tmp_path):
        ok, warn, need_admin = core.check_target(str(tmp_path / 'app'))
        assert ok is True
        assert warn is None
        assert need_admin is False

    def test_program_files_flagged(self):
        # 标准用户下 Program Files 不可写（ok=False）或可写但告警——两种都合法，
        # 关键是 need_admin 判定与 warn 提示必须成立。
        ok, warn, need_admin = core.check_target(r'C:\Program Files\Harbor')
        assert need_admin is True
        assert warn
        assert ok is False or '自动更新' in warn

    def test_unwritable_dir_rejected(self):
        ok, warn, _ = core.check_target('Z:\\nonexistent-drive-xyz\\harbor')
        assert ok is False
        assert warn


class TestInstallerBridge:
    def test_check_dir_uses_nearest_existing_selected_parent(self, tmp_path, monkeypatch):
        """未创建的多级目标按所选路径向上锚定，不退回 C 盘。"""
        import installer_gui as gui
        selected = tmp_path / 'missing' / 'nested' / 'Harbor'
        anchors = []
        monkeypatch.setattr(gui, 'check_target', lambda path: (True, None, False))
        monkeypatch.setattr(gui, 'free_space_mb',
                            lambda path: anchors.append(path) or 1234)
        result = json.loads(gui.InstallerBridge().check_dir(str(selected)))
        assert result['free_mb'] == 1234
        assert anchors == [str(tmp_path)]


# ---------------- 安装 ----------------
class TestInstall:
    def _fake_payload(self, tmp_path, monkeypatch):
        payload = tmp_path / 'Harbor.exe'
        payload.write_bytes(b'FAKE-HARBOR-EXE' * 1000)
        monkeypatch.setattr(core, 'payload_path', lambda: str(payload))
        monkeypatch.setattr(core, 'uninstaller_payload_path',
                            lambda: str(tmp_path / 'no-uninstaller.exe'))
        return payload

    def test_install_full_flow(self, tmp_path, monkeypatch, reg_cleanup):
        self._fake_payload(tmp_path, monkeypatch)
        monkeypatch.setattr(core, '_UNINSTALL_KEY', _REG_TEST_ROOT)   # 注册表隔离
        target = tmp_path / 'install'
        res = core.install(str(target), desktop_shortcut=False, start_menu=True,
                           uninstaller_src=None)
        assert res['ok'] is True, res
        exe = target / 'Harbor.exe'
        assert exe.exists() and exe.stat().st_size == (tmp_path / 'Harbor.exe').stat().st_size
        # 安装清单 + sha
        manifest = json.loads((target / 'install.json').read_text(encoding='utf-8'))
        assert manifest['version'] == core.app_version()
        assert len(manifest['sha256']) == 64
        # 注册表（测试根键）
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _REG_TEST_ROOT) as k:
            assert winreg.QueryValueEx(k, 'InstallLocation')[0] == str(target)
        # 开始菜单快捷方式真实创建
        assert os.path.exists(os.path.join(core.start_menu_dir(), 'Harbor.lnk'))

    def test_install_registry_uses_test_root(self, tmp_path, monkeypatch, reg_cleanup):
        """注册表默认写真实 HKCU；单测经 test_root 隔离（fixture 负责清理）。"""
        self._fake_payload(tmp_path, monkeypatch)
        monkeypatch.setattr(core, '_UNINSTALL_KEY', _REG_TEST_ROOT)
        res = core.install(str(tmp_path / 'i2'), desktop_shortcut=False, start_menu=False)
        assert res['ok'] is True
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _REG_TEST_ROOT) as k:
            assert 'Harbor' in winreg.QueryValueEx(k, 'DisplayName')[0]

    def test_install_missing_payload_fails(self, tmp_path, monkeypatch):
        monkeypatch.setattr(core, 'payload_path', lambda: str(tmp_path / 'nope.exe'))
        res = core.install(str(tmp_path / 'i3'))

    def test_install_payload_sha_mismatch_blocked(self, tmp_path, monkeypatch, reg_cleanup):
        """复核批修正回归：构建期嵌入的载荷 sha256 与落地字节不符 → 拒装
        （同尺寸损坏载荷不再照装）；开发态（无嵌入文件）跳过强校验。"""
        # 开发态：embedded_payload_sha256() 返回 '' → 不拦
        assert core.embedded_payload_sha256() == ''
        # 伪造 frozen 环境：_MEIPASS/payload/ 放载荷 + 错误 sha256 清单
        meipass = tmp_path / 'meipass'
        (meipass / 'payload').mkdir(parents=True)
        payload = meipass / 'payload' / 'Harbor.exe'
        payload.write_bytes(b'FAKE-HARBOR-EXE' * 1000)
        (meipass / 'payload' / 'payload.sha256').write_text('0' * 64, encoding='utf-8')
        monkeypatch.setattr(sys, 'frozen', True, raising=False)
        monkeypatch.setattr(sys, '_MEIPASS', str(meipass), raising=False)
        monkeypatch.setattr(core, 'uninstaller_payload_path',
                            lambda: str(tmp_path / 'no-uninstaller.exe'))
        monkeypatch.setattr(core, '_UNINSTALL_KEY', _REG_TEST_ROOT)
        target = tmp_path / 'install'
        res = core.install(str(target), desktop_shortcut=False, start_menu=False)
        assert res['ok'] is False, res
        assert '完整性' in res['error'], res
        assert not (target / 'Harbor.exe').exists()      # 旧版未毁/未落地

    def test_install_payload_sha_match_passes(self, tmp_path, monkeypatch, reg_cleanup):
        """sha256 匹配（正常构建产物）→ 安装成功，校验不误伤。"""
        import hashlib
        meipass = tmp_path / 'meipass'
        (meipass / 'payload').mkdir(parents=True)
        payload = meipass / 'payload' / 'Harbor.exe'
        payload.write_bytes(b'FAKE-HARBOR-EXE' * 1000)
        (meipass / 'payload' / 'payload.sha256').write_text(
            hashlib.sha256(payload.read_bytes()).hexdigest(), encoding='utf-8')
        monkeypatch.setattr(sys, 'frozen', True, raising=False)
        monkeypatch.setattr(sys, '_MEIPASS', str(meipass), raising=False)
        monkeypatch.setattr(core, 'uninstaller_payload_path',
                            lambda: str(tmp_path / 'no-uninstaller.exe'))
        monkeypatch.setattr(core, '_UNINSTALL_KEY', _REG_TEST_ROOT)
        res = core.install(str(tmp_path / 'install'), desktop_shortcut=False,
                           start_menu=False)
        assert res['ok'] is True, res

    def test_install_missing_payload_fails(self, tmp_path, monkeypatch):
        monkeypatch.setattr(core, 'payload_path', lambda: str(tmp_path / 'nope.exe'))
        res = core.install(str(tmp_path / 'i3'))
        assert res['ok'] is False
        assert '载荷' in res['error']


# ---------------- 卸载 ----------------
class TestUninstall:
    def test_uninstall_keeps_data_by_default(self, tmp_path, monkeypatch, reg_cleanup):
        monkeypatch.setattr(core, 'is_app_running', lambda: False)
        target = tmp_path / 'inst'
        target.mkdir()
        (target / 'Harbor.exe').write_bytes(b'x')
        res = core.uninstall(str(target), purge_data=False)
        assert res['ok'] is True
        assert not target.exists()
        assert any('保留' in w for w in res['warnings'])

    def test_uninstall_purge_removes_glm_chat(self, tmp_path, monkeypatch):
        monkeypatch.setattr(core, 'is_app_running', lambda: False)
        monkeypatch.setattr(os.path, 'expanduser',
                            lambda p: str(tmp_path) if p == '~' else p)
        target = tmp_path / 'inst2'
        target.mkdir()
        (target / 'Harbor.exe').write_bytes(b'x')
        data = tmp_path / '.glm-chat'
        data.mkdir()
        (data / 'config.json').write_text('{}')
        res = core.uninstall(str(target), purge_data=True)
        assert res['ok'] is True
        assert not target.exists()
        assert not data.exists()

    def test_uninstall_blocked_when_app_running(self, tmp_path, monkeypatch):
        monkeypatch.setattr(core, 'is_app_running', lambda: True)
        res = core.uninstall(str(tmp_path / 'never'))
        assert res['ok'] is False
        assert '正在运行' in res['error']


# ---------------- CLI 静默模式（对已构建 exe 的端到端，存在才跑） ----------------
class TestSilentEndToEnd:
    @pytest.fixture(scope='class')
    @classmethod
    def setup_exe(cls):
        v = core.app_version()
        p = os.path.join(ROOT, 'dist', 'Harbor-Setup-%s.exe' % v)
        return p if os.path.exists(p) else None

    def test_silent_install_uninstall_roundtrip(self, setup_exe, tmp_path):
        if not setup_exe:
            pytest.skip('安装器 exe 未构建（python installer/build_setup.py）')
        target = tmp_path / 'e2e'
        r = subprocess.run([setup_exe, '--silent', '--dir', str(target)],
                           capture_output=True, timeout=180)
        assert r.returncode == 0, r.stdout + r.stderr
        assert (target / 'Harbor.exe').exists()
        assert (target / 'Uninstall.exe').exists()
        assert (target / 'install.json').exists()
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r'Software\Microsoft\Windows\CurrentVersion\Uninstall\Harbor') as k:
            assert winreg.QueryValueEx(k, 'InstallLocation')[0] == str(target)
        assert os.path.exists(os.path.join(core.start_menu_dir(), 'Harbor.lnk'))
        # 静默卸载（默认保留数据）
        r2 = subprocess.run([setup_exe, '--uninstall', '--silent', '--dir', str(target)],
                            capture_output=True, timeout=120)
        assert r2.returncode == 0, r2.stdout + r2.stderr
        assert not (target / 'Harbor.exe').exists()
        try:
            winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                           r'Software\Microsoft\Windows\CurrentVersion\Uninstall\Harbor')
            assert False, '卸载后注册表项应已删除'
        except OSError:
            pass
        assert not os.path.exists(os.path.join(core.start_menu_dir(), 'Harbor.lnk'))
