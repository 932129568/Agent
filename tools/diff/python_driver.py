# -*- coding: utf-8 -*-
"""差分 harness · Python 侧驱动（每 fixture 一个全新解释器子进程）。

调用约定（编排器 run-diff.mjs spawn）：
    python python_driver.py <fixture.json> --result <result-py.json>
    python python_driver.py --list-methods     # 覆盖率口径：公开 + _V12_EXTRA 方法集

职责（设计 §5.2）：
1. 建临时 ROOT/HOME + 种子工作区 + 按 fixture.mocks 装 fakes（共享 mock 表）；
2. import backend.api.Api（未武装环境 guard 放行——AGENTS.md 实证）；
3. 逐 call `getattr(api, method)(*args, **kwargs)`（pywebview callApi 生产语义）；
4. 工作区树快照 + probeConfigFiles 内容；
5. 只产 raw 结果（不做任何归一），写 result JSON；
6. 关停容器后台线程后强制退出（防非守护线程悬挂编排器）。

退出码契约：0 正常；3 驱动自身崩溃。
红线遵守：不 import pytest、不改 conftest、不写任何真实路径（HOME 已重定向）。
"""
import argparse
import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(_HERE))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import fakes  # noqa: E402  （本模块无 backend 依赖；HOME 重定向在其后发生）


def _write_result(result_path, payload):
    directory = os.path.dirname(os.path.abspath(result_path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    with open(result_path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())


def _run_one(api, call, p):
    args = fakes.substitute(list(call.get('args') or []), p)
    kwargs = fakes.substitute(dict(call.get('kwargs') or {}), p)
    method = str(call.get('method') or '')
    entry = {'id': str(call.get('id') or ''), 'method': method}
    try:
        raw = getattr(api, method)(*args, **kwargs)
        entry['raw'] = raw if isinstance(raw, str) else json.dumps(
            raw, ensure_ascii=False, default=str)
    except Exception as e:  # 未捕获异常也是行为面
        entry['exception'] = '%s: %s' % (type(e).__name__, e)
    return entry


def _run_calls(api, fixture, p):
    """setup.callsBefore（同样被比对）+ 主 calls，按序执行。"""
    entries = []
    for call in (fixture.get('setup') or {}).get('callsBefore') or []:
        entries.append(_run_one(api, call, p))
    for call in fixture.get('calls') or []:
        entries.append(_run_one(api, call, p))
    return entries


def _list_methods():
    """覆盖率口径：Api 实例全部公开方法（含 _V12_EXTRA 隐身方法）。

    同样走临时 HOME（Api() 装配会写 experts/logs 等，真实 ~/.glm-chat 零污染）。
    """
    root = tempfile.mkdtemp(prefix='glm-diff-py-methods-')
    api = None
    try:
        fakes.setup_home(root, {'setup': {}})
        from backend.api import Api
        api = Api()
        methods = sorted(n for n in dir(api)
                         if not n.startswith('_') and callable(getattr(api, n)))
        sys.stdout.write(json.dumps({'methods': methods}))
        return 0
    finally:
        if api is not None:
            try:
                api._shutdown()
            except Exception:
                pass
        fakes.cleanup(root)


def _start_hang_listener(port):
    """挂起监听器（fixture setup.listenPorts）：accept 但永不响应——
    「端口有服务但无 HTTP 应答」的确定性探测场景（双侧同超时分类）。"""
    import socket as sk
    import threading

    def _serve():
        try:
            srv = sk.socket(sk.AF_INET, sk.SOCK_STREAM)
            srv.setsockopt(sk.SOL_SOCKET, sk.SO_REUSEADDR, 1)
            srv.bind(('127.0.0.1', port))
            srv.listen(8)
            while True:
                conn, _ = srv.accept()
                # 不读写不关闭：连接挂起直到对端超时
                try:
                    conn.settimeout(60)
                except Exception:
                    pass
        except Exception:
            pass

    threading.Thread(target=_serve, daemon=True).start()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('fixture', nargs='?', default=None)
    parser.add_argument('--result', default=None)
    parser.add_argument('--list-methods', action='store_true')
    args = parser.parse_args()

    if args.list_methods:
        return _list_methods()

    if not args.fixture or not args.result:
        sys.stderr.write('usage: python_driver.py <fixture.json> --result <out.json>\n')
        return 3

    with open(args.fixture, encoding='utf-8') as f:
        fixture = json.load(f)

    root = tempfile.mkdtemp(prefix='%s-p-' % os.environ.get(
        'HARBOR_DIFF_TEMP_TAG', 'glm-diff-py'))
    api = None
    try:
        p = fakes.setup_home(root, fixture)
        # P0-1c T02：清除会话继承的代理 env（http_proxy/https_proxy 等）——Python
        # urllib 尊重代理 env 而 Node fetch（undici）默认直连，代理介入使双侧
        # 网络现实不对称（探测错误分类分叉的共因）。差分环境必须直连。
        for key in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
                    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'):
            os.environ.pop(key, None)
        # admin 提权通道的 tempfile.mkstemp（bat/out/exit 三件套）收进临时根：
        # 双侧临时根内、随根清理（主理人批准的红线口径）
        _tmpdir = os.path.join(root, 'tmp')
        os.makedirs(_tmpdir, exist_ok=True)
        tempfile.tempdir = _tmpdir
        # fixture env 字段（方案 §6 修复T02）：按侧注入进程环境（admin approve/deny
        # 的 GLM_TEST_MSGBOX 等），先于 fakes 安装生效
        for key, value in (fixture.get('env') or {}).get('python', {}).items():
            os.environ[str(key)] = str(value)
        # listenPorts 挂起监听器（T02 c13）：TCP accept 但不响应——使「端口有服务
        # 但无 HTTP 应答」的双侧探测确定性超时（规避本机 RST 延迟 ~2.06s 对 Python
        # 阻塞 connect 的 2s 探测分类边界抖动）
        for port in (fixture.get('setup') or {}).get('listenPorts') or []:
            _start_hang_listener(int(port))
        mocks = list(fixture.get('mocks') or [])
        # webview/PIL 在 import 前装：backend 模块运行期 import 时从 sys.modules 取
        fakes.install_fake_webview()
        fakes.install_fake_pil()

        # backend 必须在 HOME/USERPROFILE 重定向之后 import（paths.py import 期取 expanduser）
        from backend.api import Api
        api = Api()

        # subprocess/windll 桩在 Api() 之后装：cmd_service/software_service 在
        # import 期捕获 _STDLIB_RUN = subprocess.run，桩必须在其后替换（与
        # conftest「测试期打桩」语义一致，stub 判定路径才会生效）
        if 'subprocess' in mocks:
            fakes.install_subprocess_mock()
        if 'windll' in mocks:
            fakes.install_fake_windll()
        if 'dialog' in mocks:
            # 对话框路径与生产窗口等价（不经 _set_window：不 arm 护栏，保持未武装语义）
            api._runtime.win = fakes._FakeDiffWindow()
        if 'subprocess' in mocks:
            fakes.patch_software_seams(api)

        # 与 Node 侧 process.chdir(ws) 对等：cwd 相关回退口径一致
        os.chdir(p['ws'])

        result = {
            'side': 'python',
            'fixture': str(fixture.get('id') or ''),
            'meta': {'root': p['root'], 'ws': p['ws'], 'cfg': p['cfg'],
                     'picked': p['picked']},
            'calls': _run_calls(api, fixture, p),
            'sideEffects': fakes.snapshot(root, fixture),
        }
        _write_result(args.result, result)
        return 0
    except Exception as e:
        sys.stderr.write('python_driver crash: %s: %s\n' % (type(e).__name__, e))
        return 3
    finally:
        if api is not None:
            try:
                api._shutdown()
            except Exception:
                pass
        fakes.cleanup(root)


if __name__ == '__main__':
    code = main()
    sys.stdout.flush()
    sys.stderr.flush()
    # 后台线程（本地代理/搜索回收器等）不得悬挂编排器：结果已 fsync，强制退出
    os._exit(code)
