# -*- coding: utf-8 -*-
"""checkpoint_service：检查点六军规（v1.9.0 M2.7，design §B-T05）。

自 plan_service 原样迁入（迁移=行为等价铁律：test_plan_service 零改=证明），
按 R39 六军规升级：
  ① 差异恢复——git 锚点模式**禁 reset --hard**（原实现会丢弃用户全部工作区
     改动）：改 `git checkout <sha> -- <manifest 声明文件>`，只恢复声明文件，
     用户其他改动零触碰（_checkpoint_rollback_git_diff）；
  ② 绝不删未备份——快照恢复前先把当前版备份为 .rollback-bak（毫秒时间戳防
     互覆，重复回滚不冲掉上次备份）；
  ③ 自有影子仓库——git 场景用户仓库自身即影子（HEAD 锚点）；非 git 场景
     ~/.glm-chat/checkpoints/<tid>/ 快照目录即影子（上限 200MB/500 文件）；
  ④ shell 前后快照——api.run_command/run_powershell 执行前自动建锚点检查点
     （_auto_before_shell），失败可回滚（api 层挂点，见 api.py）；
  ⑤ 确认后端化——rollback 需显式 confirm=True（前端三态对话框「清单→确认」
     的后端闸门；默认拒，防误触）；
  ⑥ 恢复后校验——rollback 后逐文件重算 sha256 与创建时记录对拍，输出
     verified/failed（前端校验态「已恢复至检查点 #N」的数据源）。

存储：~/.glm-chat/checkpoints/<tid>/manifest.json（权威）+ checkpoints.json
投影（前端面板数据源：items[] 含 badges/size_mb/file_count——损坏可重建）。
保留 CKPT_KEEP=3 份，超限随创建清理。
"""
import hashlib
import json
import os
import shutil
import subprocess
import time

from ... import paths
from ...logging_setup import get_logger
from ...fio import atomic_write_json

CKPT_MAX_BYTES = 200 * 1024 * 1024
CKPT_MAX_FILES = 500
CKPT_KEEP = 3                    # 方案 §6.5：默认保留最近 3 份，旧的随新创建清理
_TID_RE_LEN = 64                 # task_id 安全长度（防路径逃逸）


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%S')


def _ms_tag():
    return time.strftime('%Y%m%d%H%M%S') + '_%03d' % int((time.time() % 1) * 1000)


def _safe_tid(task_id):
    tid = str(task_id or '')
    if not tid or len(tid) > _TID_RE_LEN or any(c in tid for c in '/\\..'):
        raise ValueError('task_id 非法')
    return tid


_TID_ERR = {'code': 'BAD_PARAMS', 'message': 'task_id 非法（防路径逃逸）'}


def _plans_dir():
    return os.path.join(paths.CONFIG_DIR, 'plans')


def _ckpts_dir():
    # 口径与 plan_service 旧实现一致（CONFIG_DIR/checkpoints——用户既有
    # 检查点数据兼容，禁迁路径）
    return os.path.join(paths.CONFIG_DIR, 'checkpoints')


def _ckpt_path(task_id):
    return os.path.join(_ckpts_dir(), _safe_tid(task_id))


def _checkpoints_projection_path():
    return paths.CHECKPOINTS_FILE


def _prune_old_checkpoints():
    """按 created_at 排序保留最近 CKPT_KEEP 份，更旧的整目录删除。

    返回被清理的 task_id 列表（warnings 数据源）。
    """
    d = _ckpts_dir()
    try:
        entries = []
        for name in os.listdir(d):
            mf = os.path.join(d, name, 'manifest.json')
            try:
                with open(mf, encoding='utf-8') as f:
                    created = (json.load(f) or {}).get('created_at') or ''
            except (OSError, ValueError):
                created = ''
            entries.append((created, name))
        entries.sort(key=lambda x: x[0] or '', reverse=True)
    except OSError:
        return []
    pruned = []
    for _, name in entries[CKPT_KEEP:]:
        try:
            shutil.rmtree(os.path.join(d, name))
            pruned.append(name)
        except OSError:
            continue
    return pruned


def _git_head(ws_dir):
    """git 仓库 → HEAD sha；非 git/不可用 → ''。"""
    try:
        r = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ws_dir,
                           capture_output=True, timeout=15,
                           creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if r.returncode == 0:
            return r.stdout.decode('utf-8', 'replace').strip()
    except Exception:
        pass
    return ''


def _safe_join(ws_dir, rel):
    """路径逃逸防护：rel 必须落在 ws_dir 内（防 '../' 越界）。"""
    rel = str(rel or '')
    if not rel or os.path.isabs(rel):
        return None
    full = os.path.realpath(os.path.join(ws_dir, rel))
    ws_real = os.path.realpath(ws_dir)
    if full != ws_real and not full.startswith(ws_real + os.sep):
        return None
    return full


def _file_sha256(path):
    import hashlib
    h = hashlib.sha256()
    try:
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(256 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return ''


class CheckpointService:
    """检查点六军规（design §B-T05；plan_service 委托转发，api 直连本服务）。"""

    def __init__(self, clock=None, log=None):
        self._log = log or get_logger()
        self._clock = clock or time.time

    # ---------------- 创建 ----------------
    def create(self, task_id, files, ws_dir=None, label='', mode=''):
        """对计划声明涉及的文件建检查点（原 plan_service.checkpoint_create 原样迁）。

        git 仓库：记录 HEAD 锚点 + 声明文件 sha256（差异恢复用）。
        非 git：复制文件到 checkpoints/<tid>/（上限 200MB/500）。
        返回 {ok, mode, snapshot_count, git_head, warnings[]}。
        """
        try:
            tid = _safe_tid(task_id)
        except ValueError:
            return {'ok': False, 'error': _TID_ERR}
        ws = os.path.realpath(ws_dir or os.getcwd())
        warnings = []
        # files 兼容 CSV 字符串（前端可能传 'a.py,b.py'——design §B-T05）
        if isinstance(files, str):
            files = [f.strip() for f in files.split(',') if f.strip()]
        head = _git_head(ws)
        manifest = {'task_id': tid, 'ws_dir': ws, 'git_head': head,
                    'created_at': _now(), 'files': [],
                    'label': str(label or '')[:80], 'kind': str(mode or '')}
        snap_dir = _ckpt_path(tid)
        total, count = 0, 0
        for rel in (files or []):
            full = _safe_join(ws, rel)
            if not full:
                warnings.append('越界路径已跳过: %s' % rel)
                continue
            if not os.path.isfile(full):
                if head:
                    # git 锚点也登记“创建时不存在”：回滚时才能把后建同名文件
                    # 恢复为不存在；当前版仍先备份，未声明文件不触碰。
                    manifest['files'].append({'path': rel, 'snapshot': False,
                                              'present': False, 'sha256': None, 'size': 0})
                    warnings.append('创建时不存在（回滚将移除同名后建文件）: %s' % rel)
                else:
                    warnings.append('文件不存在已跳过: %s' % rel)
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if count >= CKPT_MAX_FILES or total + size > CKPT_MAX_BYTES:
                warnings.append('超出检查点上限（%d 文件 / %dMB），后续文件仅记录清单'
                                % (CKPT_MAX_FILES, CKPT_MAX_BYTES // 1048576))
                manifest['files'].append({'path': rel, 'snapshot': False})
                continue
            if not head:   # 非 git 才需要真快照
                try:
                    dst = os.path.join(snap_dir, str(rel).replace('..', '__'))
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.copy2(full, dst)
                    count += 1
                    total += size
                except OSError as e:
                    warnings.append('快照失败 %s: %s' % (rel, e))
                    manifest['files'].append({'path': rel, 'snapshot': False})
                    continue
            # v1.9 ⑥：创建时记录 sha256（恢复后校验数据源）——git 模式记
            # **HEAD 版**哈希（bug 修复：恢复目标=git checkout <head>，记工作区
            # 当前哈希会在「建点时存在未提交改动」场景令恢复后校验恒假失败；
            # 未提交改动不丢——.rollback-bak 兜底回滚前状态）
            sha = None
            if head:
                try:
                    _r = subprocess.run(
                        ['git', 'show', '%s:%s' % (head, rel)],
                        cwd=ws, capture_output=True, timeout=30,
                        creationflags=getattr(subprocess,
                                               'CREATE_NO_WINDOW', 0))
                    if _r.returncode == 0:
                        sha = hashlib.sha256(_r.stdout).hexdigest()
                except Exception:
                    sha = None
            else:
                sha = _file_sha256(full)
            manifest['files'].append({'path': rel, 'snapshot': not head,
                                      'present': True, 'sha256': sha, 'size': size})
        try:
            os.makedirs(snap_dir, exist_ok=True)
            atomic_write_json(os.path.join(snap_dir, 'manifest.json'),
                              manifest, indent=1)
        except OSError as e:
            return {'ok': False, 'error': '检查点清单落盘失败: %s' % e}
        mode = 'git' if head else ('snapshot' if count else 'none')
        pruned = _prune_old_checkpoints()
        if pruned:
            warnings.append('已轮换清理 %d 份旧检查点（保留最近 %d 份）'
                            % (len(pruned), CKPT_KEEP))
        self._project()
        return {'ok': True, 'mode': mode, 'git_head': head,
                'snapshot_count': count, 'pruned': pruned,
                'warnings': warnings}

    def create_auto(self, task_id, ws_dir=None):
        """④ shell 前后快照：命令执行前的自动锚点（files=[]——只记 git HEAD
        锚点，零成本；回滚=差异恢复声明文件外的整锚点语义由 rollback 兜底）。"""
        r = self.create(task_id, [], ws_dir=ws_dir, label='auto-before-shell',
                        mode='auto')
        return r

    # ---------------- 回滚 ----------------
    def rollback(self, task_id, ws_dir=None, confirm=False):
        """回滚到检查点（⑤ 确认后端化：confirm=False 默认拒）。

        git 锚点：① 差异恢复 `git checkout <sha> -- <files>`（禁 reset --hard
        ——不丢用户其他改动）；快照：逐文件恢复（先备份当前版 ②）+⑥ 恢复后
        sha256 校验。返回 {ok, mode, restored[], failed[], verified}。
        """
        if not confirm:
            return {'ok': False, 'error': {
                'code': 'CONFIRM_REQUIRED',
                'message': '回滚需显式确认（前端三态对话框「确认态」后携带 '
                           'confirm=true 调用）——禁误触'}}
        try:
            tid = _safe_tid(task_id)
        except ValueError:
            return {'ok': False, 'error': _TID_ERR}
        snap_dir = _ckpt_path(tid)
        mf_path = os.path.join(snap_dir, 'manifest.json')
        if not os.path.exists(mf_path):
            return {'ok': False,
                    'error': '未找到检查点: %s（可能创建时超限降级为仅记录）' % tid}
        try:
            with open(mf_path, encoding='utf-8') as f:
                manifest = json.load(f)
        except (OSError, ValueError) as e:
            return {'ok': False, 'error': '检查点清单读取失败: %s' % e}
        # 修复（对抗性复审）：ws_dir 缺省回落 manifest 创建时记录的工作区——
        # 前端只传 taskId，回落 getcwd 会把恢复打到应用自身目录。
        ws = os.path.realpath(str(ws_dir or manifest.get('ws_dir') or os.getcwd()))
        head = manifest.get('git_head')
        if head:
            return self._rollback_git_diff(tid, manifest, ws, head)
        return self._rollback_snapshot(manifest, ws, snap_dir)

    def _rollback_git_diff(self, tid, manifest, ws, head):
        """① 差异恢复：只把 manifest 声明文件恢复到 HEAD 版本（禁 reset --hard）。"""
        restored, failed, deleted = [], [], []
        items = [it for it in manifest.get('files', []) if it.get('path')]
        if not items:
            # 锚点检查点（auto-before-shell 无声明文件）：只报告锚点，不动文件
            return {'ok': True, 'mode': 'git', 'restored': [], 'deleted': [],
                    'failed': [], 'verified': True,
                    'note': '锚点检查点（无声明文件），git HEAD=%s' % head[:8]}
        for item in items:
            rel = item['path']
            full = _safe_join(ws, rel)
            if not full:
                failed.append(rel)
                continue
            # ② 先备份当前版。备份失败必须中止该文件恢复，不能在无法
            # 保全用户当前工作时继续 checkout/remove。
            try:
                if os.path.lexists(full):
                    bak = full + '.rollback-bak'
                    if os.path.exists(bak):
                        bak = '%s.rollback-bak.%s' % (full, _ms_tag())
                    shutil.copy2(full, bak)
            except OSError as e:
                failed.append('%s: 回滚前备份失败: %s' % (rel, e))
                continue
            if not item.get('present', True):
                # 创建时不存在的声明文件：后建同名文件回到“不存在”。
                try:
                    if os.path.lexists(full):
                        if not os.path.isfile(full):
                            raise OSError('目标不是普通文件，未移除')
                        os.remove(full)
                        deleted.append(rel)
                except OSError as e:
                    failed.append('%s: 后建文件移除失败: %s' % (rel, e))
                continue
            try:
                r = subprocess.run(['git', 'checkout', head, '--', rel],
                                   cwd=ws, capture_output=True, timeout=60,
                                   creationflags=getattr(
                                       subprocess, 'CREATE_NO_WINDOW', 0))
                if r.returncode == 0:
                    restored.append(rel)
                else:
                    failed.append('%s: %s' % (rel,
                                              r.stderr.decode('utf-8', 'replace')[:120]))
            except Exception as e:
                failed.append('%s: %s' % (rel, e))
        verified = self._verify_restored(manifest, ws, restored)
        return {'ok': not failed, 'mode': 'git', 'restored': restored,
                'deleted': deleted, 'failed': failed, 'verified': verified}

    def _rollback_snapshot(self, manifest, ws, snap_dir):
        """快照逐文件恢复（② 先备份）+⑥ 恢复后校验。"""
        restored, failed = [], []
        for item in manifest.get('files', []):
            if not item.get('snapshot'):
                continue
            src = os.path.join(snap_dir, str(item.get('path')).replace('..', '__'))
            dst = _safe_join(ws, item.get('path'))
            if not dst or not os.path.exists(src):
                failed.append(item.get('path'))
                continue
            try:
                if os.path.exists(dst):
                    bak = dst + '.rollback-bak'
                    if os.path.exists(bak):
                        bak = '%s.rollback-bak.%s' % (dst, _ms_tag())
                    shutil.copy2(dst, bak)   # 先备份当前版
                shutil.copy2(src, dst)
                restored.append(item.get('path'))
            except OSError:
                failed.append(item.get('path'))
        verified = self._verify_restored(manifest, ws, restored)
        # 复核修正：与 git 路径（'ok': not failed）同口径——原「有一个恢复
        # 成功就报 ok」，部分失败被前端当回滚完成
        return {'ok': not failed, 'mode': 'snapshot',
                'restored': restored, 'failed': failed, 'verified': verified}

    def _verify_restored(self, manifest, ws, restored):
        """⑥ 恢复后校验：逐文件重算 sha256 与创建时记录对拍。"""
        by_path = {it.get('path'): it for it in manifest.get('files', [])}
        for rel in restored:
            rec = by_path.get(rel) or {}
            want = rec.get('sha256')
            if not want:
                continue                    # 旧清单无 sha256：跳过不判（前向兼容）
            full = _safe_join(ws, rel)
            if not full or _file_sha256(full) != want:
                return False
        return True

    # ---------------- 清单 ----------------
    def list(self, task_id=''):
        """检查点清单（原 plan_service.checkpoint_list 原样迁+投影扩展）。

        无参 → 全部任务摘要 items[]（checkpoints.json 数据源）；传 task_id →
        该任务「将恢复的文件」清单（M3-D1 原语义）。
        """
        if not task_id:
            return self._list_all()
        try:
            snap_dir = _ckpt_path(task_id)
        except ValueError:
            return {'ok': False, 'error': _TID_ERR}
        mf_path = os.path.join(snap_dir, 'manifest.json')
        if not os.path.exists(mf_path):
            return {'ok': True, 'files': [], 'mode': 'none'}
        try:
            with open(mf_path, encoding='utf-8') as f:
                manifest = json.load(f)
        except (OSError, ValueError):
            return {'ok': True, 'files': [], 'mode': 'none'}
        files = [{'path': it.get('path'), 'snapshot': bool(it.get('snapshot'))}
                 for it in manifest.get('files', [])]
        return {'ok': True, 'files': files,
                'mode': 'git' if manifest.get('git_head') else 'snapshot',
                'git_head': manifest.get('git_head'),
                'ws_dir': manifest.get('ws_dir'),
                'label': manifest.get('label', ''),
                'created_at': manifest.get('created_at', '')}

    def _list_all(self):
        """无参形态：扫 checkpoints/ 全部 manifest 汇总（前端面板数据源）。"""
        base = _ckpts_dir()
        items = []
        try:
            names = sorted(os.listdir(base))
        except OSError:
            names = []
        for tid in names:
            mf_path = os.path.join(base, tid, 'manifest.json')
            if not os.path.exists(mf_path):
                continue
            try:
                with open(mf_path, encoding='utf-8') as f:
                    mf = json.load(f)
            except (OSError, ValueError):
                continue
            files = mf.get('files') or []
            size = 0
            try:
                for fn in os.listdir(os.path.join(base, tid)):
                    fp = os.path.join(base, tid, fn)
                    if os.path.isfile(fp):
                        size += os.path.getsize(fp)
            except OSError:
                pass
            items.append({'id': tid,
                          'mode': 'git' if mf.get('git_head') else 'snapshot',
                          'git_head': mf.get('git_head'),
                          'label': mf.get('label', ''),
                          'created_at': mf.get('created_at'),
                          'file_count': len(files),
                          'size_mb': round(size / 1048576, 2)})
        items.sort(key=lambda x: x.get('created_at') or '', reverse=True)
        return {'ok': True, 'items': items, 'keep': CKPT_KEEP}

    # ---------------- 投影（checkpoints.json）----------------
    def _project(self):
        """checkpoints.json 投影（前端三态对话框数据源；权威在 manifest——
        投影损坏可从 manifest 重建，禁阻断主流程）。"""
        try:
            data = self._list_all()
            atomic_write_json(_checkpoints_projection_path(), data, indent=1)
        except Exception as e:
            self._log.debug('checkpoints.json 投影失败（可重建，不阻断）: %r', e)

    def rebuild_projection(self):
        """投影重建（损坏/滞后时显式调用；返回 items 数）。"""
        self._project()
        data = self._list_all()
        return {'ok': True, 'items': len(data.get('items') or [])}
