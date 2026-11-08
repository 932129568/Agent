# -*- coding: utf-8 -*-
"""安装器一键构建（v1.7.0；2026-10-24 复核批补载荷 sha256 嵌入）。

用法：
  python installer/build_setup.py            # 全量：应用 exe → 卸载器 → 安装器
  python installer/build_setup.py --app-only # 仅构建应用 Harbor.exe（等价 Harbor.spec）

产物（dist/）：
  Harbor.exe                    应用本体（onefile）
  Harbor-Uninstall.exe          卸载器（小，安装时随包进安装目录）
  Harbor-Setup-<version>.exe    安装器（内嵌上面两个 + 载荷 sha256 清单，双击即向导）

每个构建步骤的 PyInstaller 参数均为内联字面量列表（无动态拼装）。
"""
import hashlib
import os
import subprocess
import sys
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALLER_DIR = os.path.dirname(os.path.abspath(__file__))
# 允许候选构建写入隔离目录，避免覆盖仓库根 dist/build；默认行为不变。
DIST = os.path.abspath(os.environ.get('HARBOR_DIST') or os.path.join(ROOT, 'dist'))
BUILD_ROOT = os.path.abspath(os.environ.get('HARBOR_BUILD_ROOT')
                             or os.path.join(ROOT, 'build'))
PY = sys.executable
CHECK_DEPS = os.path.join(ROOT, 'tools', 'check_build_dependencies.py')


def _check(r):
    if r.returncode != 0:
        print('命令失败：exit %d' % r.returncode)
        sys.exit(r.returncode)


def check_build_dependencies():
    """Fail before PyInstaller if pywebview or another frozen dependency is absent.

    R41：剥离继承的 PYTHONPATH——用隔离 venv 构建时，外层开发 shell 的
    PYTHONPATH（共享 envs/default）会让检查读到漂移版本产生假性 mismatch。
    检查对象是「本解释器自己的解析面」。"""
    print('+ 检查Windows冻结构建依赖')
    env = {k: v for k, v in os.environ.items() if k != 'PYTHONPATH'}
    r = subprocess.run([sys.executable, CHECK_DEPS], cwd=ROOT, env=env)
    _check(r)


def version():
    with open(os.path.join(ROOT, 'VERSION'), encoding='utf-8') as f:
        return f.read().strip()


def build_app():
    check_build_dependencies()
    if not os.path.exists(os.path.join(ROOT, 'harbor.html')):
        print('未找到 harbor.html，请先 node frontend/build.js')
        sys.exit(1)
    print('+ PyInstaller Harbor.spec')
    r = subprocess.run([sys.executable, '-m', 'PyInstaller',
                        'Harbor.spec', '--noconfirm', '--clean',
                        '--distpath', DIST,
                        '--workpath', os.path.join(BUILD_ROOT, 'Harbor')],
                       cwd=ROOT)
    _check(r)


def build_uninstaller():
    env = dict(os.environ, HARBOR_BUILD='uninstaller')
    print('+ PyInstaller installer/Harbor-Setup.spec (uninstaller)')
    r = subprocess.run([sys.executable, '-m', 'PyInstaller',
                        os.path.join('installer', 'Harbor-Setup.spec'),
                        '--noconfirm', '--clean',
                        '--distpath', DIST,
                        '--workpath', os.path.join(BUILD_ROOT, 'uninstaller')],
                       cwd=ROOT, env=env)
    _check(r)


def build_setup():
    # 载荷完整性强校验：构建期把 Harbor.exe 的 sha256 写入清单文件并随 datas
    # 嵌入安装器（installer_core.install() 落地前对拍——同尺寸损坏载荷不再照装）
    payload = Path(DIST) / 'Harbor.exe'
    if not payload.is_file():
        print('异常：找不到应用载荷 %s' % payload)
        sys.exit(1)
    _h = hashlib.sha256()
    with open(payload, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            _h.update(chunk)
    sha_file = Path(BUILD_ROOT) / 'setup_payload.sha256'
    sha_file.parent.mkdir(parents=True, exist_ok=True)
    sha_file.write_text(_h.hexdigest(), encoding='utf-8')
    env = dict(os.environ, HARBOR_BUILD='setup',
               HARBOR_PAYLOAD=str(payload),
               HARBOR_UNINSTALLER=os.path.join(DIST, 'Harbor-Uninstall.exe'),
               HARBOR_PAYLOAD_SHA256_FILE=str(sha_file))
    print('+ PyInstaller installer/Harbor-Setup.spec (setup)')
    r = subprocess.run([sys.executable, '-m', 'PyInstaller',
                        os.path.join('installer', 'Harbor-Setup.spec'),
                        '--noconfirm', '--clean',
                        '--distpath', DIST,
                        '--workpath', os.path.join(BUILD_ROOT, 'setup')],
                       cwd=ROOT, env=env)
    _check(r)


def main():
    # 构建版本护栏：依赖为 cp313 编译版（_cffi_backend.cp313/pywin32-313 DLL），
    # 必须用 vendor Python 3.13 构建——3.15 下编译扩展全部不可加载，产物启动
    # 即崩（2026-10-24 真机实证）。测试可跑 3.15（纯 Python 路径），构建不行。
    if sys.version_info[:2] != (3, 13) and \
            not os.environ.get('HARBOR_BUILD_ALLOW_PY'):
        print('异常：构建必须使用 vendor Python 3.13（当前 %s.%s）。' % sys.version_info[:2])
        print('  用法：C:/Users/陈/.workbuddy/binaries/python/versions/current/python.exe '
              'installer/build_setup.py')
        print('  （确要覆盖：设 HARBOR_BUILD_ALLOW_PY=1）')
        sys.exit(1)
    v = version()
    print('Harbor 安装器构建 · VERSION=%s' % v)
    if '--app-only' in sys.argv:
        build_app()
        print('完成：dist/Harbor.exe')
        return
    build_app()
    build_uninstaller()
    build_setup()
    ok = (os.path.exists(os.path.join(DIST, 'Harbor-Setup-%s.exe' % v))
          and os.path.exists(os.path.join(DIST, 'Harbor-Uninstall.exe')))
    print('完成：' if ok else '异常：',
          'dist/Harbor-Setup-%s.exe（双击安装）' % v)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
