# -*- coding: utf-8 -*-
"""Harbor 安装向导（pywebview GUI，四步：欢迎 → 目录 → 进度 → 完成）。

技术选型（2026-10-19 实测决策）：本机 venv Python 无 tkinter（3.13 系列均缺），
而为系统 Py3.15 单独建 PyInstaller 工具链会引入第二构建链——故安装器复用
**产品自身的 pywebview + 单文件 HTML** 栈（Harbor.exe 已证明该栈 frozen 可用），
界面语言与产品一致；WebView2 缺失时降级原生 MessageBox 指引（见 main.py）。

设计口径（外部调研 [外]）：步序清晰、决策点少（目录 + 快捷方式）、
每用户默认安装位无 UAC、完成页提供「立即运行」。
"""
import json
import os
import threading

import webview

from installer_core import (APP_NAME, app_version, check_target, default_install_dir,
                            free_space_mb, install, is_app_running, payload_path)

_WIZARD_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><style>
:root{--accent:#2563eb;--ink:#1a2332;--sub:#5b6b7f;--line:#e3e9f0;--bg:#f6f8fb;--card:#fff}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);
 color:var(--ink);height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{background:var(--card);border-bottom:1px solid var(--line);padding:14px 24px;
 display:flex;align-items:baseline;gap:12px}
header b{font-size:15px}.ver{color:var(--sub);font-size:12px}
main{flex:1;padding:26px 32px;overflow-y:auto}
h1{font-size:19px;margin-bottom:6px}.desc{color:var(--sub);font-size:13px;line-height:1.7}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
 padding:14px 16px;margin-top:14px;font-size:13px;line-height:1.9}
.card .t{font-weight:600;margin-bottom:4px}
.dirrow{display:flex;gap:8px;margin-top:12px}
.dirrow input{flex:1;border:1px solid var(--line);border-radius:8px;padding:9px 12px;
 font-size:13px;font-family:inherit}
button{border:none;border-radius:8px;padding:9px 18px;font-size:13px;cursor:pointer;
 font-family:inherit}
.primary{background:var(--accent);color:#fff}.primary:disabled{background:#a8c0f0;cursor:default}
.ghost{background:#eef2f7;color:var(--ink)}
.space{color:var(--sub);font-size:12px;margin-top:8px}
.warn{background:#fff8e6;border:1px solid #f0dfa8;color:#9a6700;border-radius:8px;
 padding:10px 14px;font-size:12px;margin-top:10px;line-height:1.6;display:none}
label.chk{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px;cursor:pointer}
.bar{height:8px;background:#e8eef6;border-radius:4px;margin-top:18px;overflow:hidden}
.bar>div{height:100%;background:var(--accent);width:0;transition:width .2s}
.step{color:var(--sub);font-size:12px;margin-top:10px}
.ok{color:#15803d;font-size:19px;font-weight:600}
footer{background:var(--card);border-top:1px solid var(--line);padding:12px 24px;
 display:flex;justify-content:flex-end;gap:10px}
.hide{display:none!important}
</style></head><body>
<header><b>⚓ Harbor 安装程序</b><span class="ver" id="ver"></span></header>
<main id="main"></main>
<footer id="foot">
  <button class="ghost" id="back" style="display:none">上一步</button>
  <button class="primary" id="next">下一步</button>
</footer>
<script>
const $=s=>document.querySelector(s);
let state={page:'welcome',dir:'',desktop:true,start:true,result:null};
let api=null;
let timer=null;

// HTML 转义：state.dir（用户输入/浏览返回值）与错误消息都进 innerHTML，
// 未转义会破坏页面结构甚至注入元素（已实证：value="${state.dir}" 注入 <img>）。
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,
 c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

async function call(fn,...a){const s=await api[fn](...a);return (typeof s==='string')?JSON.parse(s):s;}

function footer(nextTxt,showBack){$('#next').textContent=nextTxt;$('#next').disabled=false;
 $('#back').style.display=showBack?'':'none';}

function pageWelcome(){
 state.page='welcome';footer('下一步',false);
 $('#main').innerHTML=`<h1>欢迎安装 Harbor</h1>
 <div class="desc">零依赖单文件桌面 AI 客户端：BYOK 多模型 · 本地模型 · MCP 工具 · 命令沙箱。</div>
 <div class="card"><div class="t">安装特性</div>
 • 每用户安装，<b>无需管理员权限</b>（不弹 UAC）<br>
 • 默认位置：%LOCALAPPDATA%\\Programs\\Harbor（可修改）<br>
 • 开始菜单 + 桌面快捷方式；可经「应用与功能」卸载<br>
 • 安装后自动更新可正常工作</div>
 ${window.__running?'<div class="warn" style="display:block">⚠ 检测到 Harbor 正在运行，请先关闭，否则安装可能失败。</div>':''}`;
}

function pageDir(){
 state.page='dir';footer('安装',true);
 $('#main').innerHTML=`<h1>选择安装位置</h1>
 <div class="dirrow"><input id="d" value="${esc(state.dir)}"><button class="ghost" id="browse">浏览…</button></div>
 <div class="space" id="space"></div>
 <label class="chk"><input type="checkbox" id="sc1" ${state.start?'checked':''}>创建开始菜单快捷方式</label>
 <label class="chk"><input type="checkbox" id="sc2" ${state.desktop?'checked':''}>创建桌面快捷方式</label>
 <div class="warn" id="warn"></div>`;
 $('#browse').onclick=async()=>{const r=await call('pick_dir',state.dir);if(r) {$('#d').value=r;checkDir();}};
 $('#d').oninput=()=>checkDir();
 checkDir();
}
async function checkDir(){
 const p=$('#d').value;state.dir=p;
 try{
  const r=(await call('check_dir',p))||{};
  $('#space').textContent='需要约 '+(r.need_mb||30)+' MB，可用 '+(r.free_mb>=0?r.free_mb:'未知')+' MB';
  $('#warn').style.display=r.warn?'block':'none';$('#warn').textContent=r.warn||'';
  $('#next').disabled=!r.ok;
 }catch(e){
  // 桥调用失败（后端异常/序列化失败）：禁用安装按钮，不放行未校验目录
  $('#space').textContent='';$('#warn').style.display='none';
  $('#next').disabled=true;
 }
}
function pageProgress(){
 if(!state.dir||state.dir==='undefined'){pageDir();return;}
 state.page='progress';footer('安装中…',false);$('#next').disabled=true;
 if(timer){clearInterval(timer);timer=null;}
 $('#main').innerHTML=`<h1>正在安装…</h1><div class="bar"><div id="p"></div></div>
 <div class="step" id="st">准备中</div>`;
 state.start=$('#sc1').checked;state.desktop=$('#sc2').checked;
 // 刷新页面后桥侧 _progress 可能仍是「安装已在进行」：start_install 会被
 // 拒，但轮询会附着到在途安装并展示其真实结果（finish 页以
 // result.install_dir 为准，不再用 state.dir 张冠李戴）。
 call('start_install',state.dir,state.desktop,state.start);
 timer=setInterval(poll,200);
}
async function poll(){
 const r=await call('get_progress');
 $('#p').style.width=(r.total?(r.step/r.total*100):5)+'%';
 $('#st').textContent=r.msg||'';
 if(!r.running){clearInterval(timer);state.result=r.result;
  if(state.result&&state.result.ok===false)pageError(state.result.error||'未知错误');
  else pageFinish();}
}
function pageFinish(){
 state.page='finish';footer('完成',false);
 const r=state.result||{};
 // 以 result.install_dir 为准：安装中刷新页面重走向导时 state.dir 是
 // 新选择，而真实安装目录是桥侧在途安装的 target（已实证张冠李戴）。
 const dir=(r&&typeof r.install_dir==='string'&&r.install_dir)||state.dir;
 let warns='';
 if(r.warnings&&r.warnings.length)
  warns='<div class="warn" style="display:block">'+r.warnings.slice(0,3).map(w=>'• '+esc(w)).join('<br>')+'</div>';
 $('#main').innerHTML=`<div class="ok">✓ 安装完成</div>
 <div class="desc" style="margin-top:8px">Harbor 已安装到：<br>${esc(dir)}</div>${warns}
 <label class="chk"><input type="checkbox" id="run" checked>立即运行 Harbor</label>`;
 $('#next').onclick=async()=>{if($('#run').checked)await call('run_app',dir);await call('close_app');};
}
function pageError(msg){
 state.page='error';footer('重试',true);
 $('#main').innerHTML=`<h1 style="color:#cf222e">✗ 安装失败</h1>
 <div class="desc" style="margin-top:8px">${esc(msg)}</div>
 <div class="desc" style="margin-top:8px">请关闭运行中的 Harbor 后重试；若选择了系统目录，可改回默认每用户目录。</div>`;
}
function onNext(){
 if(state.page==='welcome')pageDir();
 else if(state.page==='dir')pageProgress();
 else if(state.page==='error')pageDir();
}
$('#next').onclick=onNext;
$('#back').onclick=()=>{
 if(state.page==='dir')pageWelcome();
 else if(state.page==='error')pageWelcome();
};

async function init(){
 const d=await call('get_defaults');
 state.dir=d.default_dir;$('#ver').textContent='v'+d.version;
 window.__running=d.running;pageWelcome();
}
let booted=false;
function boot(){
 if(booted)return;
 if(window.pywebview&&window.pywebview.api){
  booted=true;api=window.pywebview.api;$('#next').onclick=onNext;init();
 }else{
  window.addEventListener('pywebviewready',()=>{
   booted=true;api=window.pywebview.api;$('#next').onclick=onNext;init();});
  // 兜底：pywebviewready 永不触发（后端挂起/脚本被阻断）时向导整页冻结
  // 无任何提示（已实证 11s 后 #main 仍空白）。10s 未就绪则给出可操作
  // 提示 + 重试；迟到的 ready 到达时 init() 正常覆盖兜底文案，
  // 并恢复标准按钮派发器（兜底曾把它换成重试处理器）。
  setTimeout(()=>{
   if(booted)return;
   $('#main').innerHTML=`<h1 style="color:#cf222e">✗ 界面初始化超时</h1>
    <div class="desc" style="margin-top:8px">安装向导界面未能在 10 秒内就绪（WebView2 运行时异常或页面脚本被安全软件阻止）。</div>
    <div class="card"><div class="t">您可以</div>
    • 点击下方「重试」再等待一次<br>
    • 关闭后双击安装程序重试<br>
    • 或使用静默安装（无需界面）：<b>Harbor-Setup.exe /S</b></div>`;
   footer('重试',false);
   $('#next').onclick=()=>{booted=false;$('#next').onclick=onNext;boot();};
  },10000);
 }
}
boot();
</script></body></html>"""


class InstallerBridge:
    """pywebview js_api 桥：向导页面 ↔ 安装核心。进度经轮询获取（线程安全）。"""

    def __init__(self):
        self._win = None
        self._progress = {'running': False, 'step': 0, 'total': 1, 'msg': ''}
        self._result = None

    def set_window(self, win):
        self._win = win

    # ---- 页面调用 ----
    def get_defaults(self):
        need = 0
        try:
            need = os.path.getsize(payload_path()) // (1024 * 1024)
        except OSError:
            need = 30
        return json.dumps({'version': app_version(),
                           'default_dir': default_install_dir(),
                           'running': is_app_running(), 'need_mb': need + 10},
                          ensure_ascii=False)

    def check_dir(self, path):
        ok, warn, need_admin = check_target(path)
        # 复核修正：need_mb 与 get_defaults 同口径按载荷实算（原硬编码 40，
        # 大包场景目录页空间提示误导）
        try:
            need = os.path.getsize(payload_path()) // (1024 * 1024) + 10
        except OSError:
            need = 40
        # 按用户选择的卷检测空间；目标尚未创建时向上定位最近已存在父目录。
        # 不能退回 C 盘，否则 D 盘等目标的空间提示与实际安装位置不符。
        space_anchor = os.path.abspath(path) if path else default_install_dir()
        while not os.path.exists(space_anchor):
            parent = os.path.dirname(space_anchor)
            if parent == space_anchor:
                break
            space_anchor = parent
        return json.dumps({'ok': ok, 'warn': warn, 'need_admin': need_admin,
                           'free_mb': free_space_mb(space_anchor),
                           'need_mb': need}, ensure_ascii=False)

    def pick_dir(self, current):
        """弹出原生目录选择（FileDialog 在 UI 线程由 JS 触发不了时经 webview API）。"""
        try:
            if self._win is None:
                return json.dumps(None)
            r = self._win.create_file_dialog(webview.FOLDER_DIALOG,
                                             directory=current or default_install_dir())
            return json.dumps(r[0] if r else None, ensure_ascii=False)
        except Exception:
            return json.dumps(None)

    def start_install(self, target, desktop, start_menu):
        if self._progress['running']:
            return json.dumps({'ok': False, 'error': '安装已在进行'})
        self._progress = {'running': True, 'step': 0, 'total': 5, 'msg': '准备中'}
        self._result = None

        def work():
            def cb(i, total, msg):
                self._progress = {'running': True, 'step': i, 'total': total, 'msg': msg}
            try:
                res = install(target, progress_cb=cb,
                              desktop_shortcut=bool(desktop), start_menu=bool(start_menu))
            except Exception as e:   # 兜底：任何异常都要让 UI 收尾
                res = {'ok': False, 'error': str(e)}
            self._result = res
            self._progress = {'running': False, 'step': 5, 'total': 5,
                              'msg': '完成' if res.get('ok') else '失败', 'result': res}

        threading.Thread(target=work, daemon=True).start()
        return json.dumps({'ok': True})

    def get_progress(self):
        return json.dumps(self._progress, ensure_ascii=False)

    def run_app(self, install_dir):
        try:
            os.startfile(os.path.join(install_dir, 'Harbor.exe'))
        except OSError:
            pass
        return '{"ok":true}'

    def close_app(self):
        if self._win is not None:
            try:
                self._win.destroy()
            except Exception:
                pass
        return '{"ok":true}'


def run_gui():
    bridge = InstallerBridge()
    win = webview.create_window('%s 安装程序 %s' % (APP_NAME, app_version()),
                                html=_WIZARD_HTML, js_api=bridge,
                                width=680, height=540, resizable=False)
    bridge.set_window(win)
    webview.start()
