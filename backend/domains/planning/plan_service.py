# -*- coding: utf-8 -*-
"""Harbor v1.8.0 M3 · 计划执行与检查点（plan_service）。

架构依据：deliverables/dev-plan/v18-architecture-and-interfaces-2026-10-20.md §3.5
（v1.9.0 预留位落地）；设计依据：design/v18/ux-flows.md 流程 8/10 + prototype.html
（plan-/clr-/ckpt- 九域类名与动效已由前端 67-plan-card.js 实现）。

职责（本期最小可用集）：
- 计划：create / get / update（步骤状态机 pending→doing→done/blocked/skipped）
  · 落盘 ~/.glm-chat/plans/<task_id>.json（与 config.json 隔离，契约红线）
- 检查点：create（git 仓库记 HEAD 锚点 + 非 git 快照涉及文件，上限
  200MB/500 文件，超限降级仅记清单）→ rollback（清单二次确认后的恢复）
- 澄清：问题清单/答案收集（clarify_collect，纯数据结构，无 IO）

判定顺序与 guard 的关系：本 service 不碰护栏——计划执行时的越界由
guard_service 五层判定链拦截（架构 §2.3），检查点只管「恢复磁盘」。
"""

import json
import os
import re
import shutil
import subprocess
import time

from ... import paths
from ...fio import atomic_write_json
from .repository import checkpoint_path, checkpoints_dir, plans_dir, task_path

# 检查点上限（ux-flows 流程 10 与自主调研 §6 同口径）
CKPT_MAX_BYTES = 200 * 1024 * 1024
CKPT_MAX_FILES = 500

STEP_STATUSES = ('pending', 'doing', 'done', 'blocked', 'skipped')
PLAN_STATUSES = ('planning', 'approved', 'running', 'done', 'blocked')

# task_id 安全校验（修复：路径穿越根因——'..'/'a/b'/'C:\\x' 等形态曾可
# 借 _task_path/_ckpt_path 的字符串拼接逃出 plans//checkpoints/ 目录）
_TID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
_TID_ERR = 'task_id 非法（仅限字母数字 _ -，≤64）'


def _safe_tid(task_id):
    """task_id → 安全 tid（strip 后匹配 ^[A-Za-z0-9_-]{1,64}$）。

    非法（含路径分隔符/点号/超长/空）→ raise ValueError(_TID_ERR)，
    由各入口转成 {'ok': False, 'error': ...}（check_tool 风格），异常
    不得穿透 js_api。
    """
    tid = str(task_id or '').strip()
    if not _TID_RE.match(tid):
        raise ValueError(_TID_ERR)
    return tid


def _plans_dir():
    return plans_dir()


def _ckpts_dir():
    return checkpoints_dir()


def _task_path(task_id):
    return task_path(task_id)


def _ckpt_path(task_id):
    return checkpoint_path(task_id)


def _new_task_id():
    return 'task_%d' % int(time.time() * 1000)


def _ms_tag():
    """毫秒级时间戳标签（.rollback-bak 备份名防互覆用，A4）。"""
    return time.strftime('%Y%m%d_%H%M%S') + '.%03d' % int((time.time() % 1) * 1000)


CKPT_KEEP = 3   # 方案 §6.5：默认保留最近 3 份，旧的随新 checkpoint 创建清理


def _prune_old_checkpoints():
    """快照模式轮换：checkpoints/ 下按 manifest created_at 排序，保留最近
    CKPT_KEEP 份，更旧的整目录删除。git 锚点模式的 manifest 无快照成本
    （git 自身即历史）——但仍占 manifest 条目，一并纳入轮换计数。"""
    d = _ckpts_dir()
    if not os.path.isdir(d):
        return []
    entries = []
    for name in os.listdir(d):
        mf = os.path.join(d, name, 'manifest.json')
        if not os.path.isfile(mf):
            continue
        try:
            with open(mf, 'r', encoding='utf-8') as f:
                created = json.load(f).get('created_at', '')
        except (OSError, ValueError):
            created = ''
        entries.append((created, name))
    entries.sort(reverse=True)
    removed = []
    for _, name in entries[CKPT_KEEP:]:
        try:
            shutil.rmtree(os.path.join(d, name))
            removed.append(name)
        except OSError:
            pass
    return removed


def _now():
    """毫秒级时间戳（同秒多计划排序稳定；ISO 格式便于阅读）。"""
    return time.strftime('%Y-%m-%dT%H:%M:%S') + '.%03d' % int((time.time() % 1) * 1000)


def _git_head(ws_dir):
    """工作区是 git 仓库 → 返回当前 HEAD sha；否则 None。"""
    try:
        r = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ws_dir, capture_output=True,
                           timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if r.returncode == 0:
            return r.stdout.decode('utf-8', 'replace').strip()
    except Exception:
        pass
    return None


def _safe_join(ws_dir, rel):
    """把计划声明的相对路径归一到工作区内（防 .. / junction 越界，S5 同款）。"""
    base = os.path.realpath(ws_dir)
    full = os.path.realpath(os.path.join(base, str(rel)))
    if full != base and not full.startswith(base + os.sep):
        return None
    return full


class PlanService(object):

    def __init__(self, checkpoint=None):
        # Container 可注入唯一检查点实例；独立领域使用仍保持原默认构造。
        from .checkpoint_service import CheckpointService
        self._checkpoint = checkpoint or CheckpointService()

    # ---------------- 计划 ----------------
    def create(self, title, steps, task_id=None, eta_seconds=None, scope=None):
        """steps: [{'text': str, 'risk': 'l0'|'l2'|'', 'tools': [...]?,
        'eta_seconds': int?}]；返回 {ok, task_id, plan}。

        v1.9.0 M2.3 Intent Preview 尾参（design §A3.5；kwarg 纯增——旧三方
        调用零改）：
        - steps 项保留 ``tools``（plan-generate.md 已输出、此前被丢弃——
          前端工具徽标数据源）与可选的 ``eta_seconds``；
        - plan 纯增键 ``eta_seconds``（显式值或启发式 len(steps)*40——计划卡
          plan-eta 徽标「≈3 步 · 2 分钟」口径）、``risk_max``
          （dangerous>mutate>read>'' 取最高——plan-riskbar 风险色条）、
          ``scope``（{'modifies': [...], 'no_access': [...]} 原样存——边界
          声明双栏；禁路径逃逸校验由调用方负责）。
        """
        try:
            tid = _safe_tid(task_id) if task_id else _new_task_id()
        except ValueError:
            return {'ok': False, 'error': _TID_ERR}
        norm = []
        for i, s in enumerate(steps or []):
            if isinstance(s, str):
                s = {'text': s}
            item = {
                'text': str(s.get('text') or ('步骤 %d' % (i + 1)))[:200],
                'risk': str(s.get('risk') or '')[:4],
                'status': 'pending',
            }
            # v1.9.0：tools（plan-generate 输出保留）+ eta_seconds（可选）纯增
            tools = s.get('tools')
            if isinstance(tools, list) and tools:
                item['tools'] = [str(t)[:40] for t in tools][:8]
            step_eta = s.get('eta_seconds')
            if isinstance(step_eta, int) and not isinstance(step_eta, bool) \
                    and step_eta > 0:
                item['eta_seconds'] = min(step_eta, 86400)
            norm.append(item)
        if not norm:
            return {'ok': False, 'error': '计划至少需要 1 个步骤'}
        # 风险口径：plan-generate 实际输出 l0（最高危）/l2（普通）/''——
        # read/mutate/dangerous 映射兜底（前向兼容其他来源）
        _RISK_ORDER = {'l0': 3, 'dangerous': 3, 'l2': 2, 'mutate': 2,
                       'read': 1, 'l1': 1, '': 0}
        risk_max = max((str(s.get('risk') or '') for s in norm),
                       key=lambda r: _RISK_ORDER.get(r, 0), default='')
        eta = eta_seconds if (isinstance(eta_seconds, int)
                              and not isinstance(eta_seconds, bool)
                              and eta_seconds > 0) else len(norm) * 40
        plan = {
            'task_id': tid,
            'title': str(title or '任务计划')[:120],
            'status': 'planning',
            'steps': norm,
            'created_at': _now(),
            'updated_at': _now(),
            # v1.9.0 M2.3：Intent Preview 纯增键（前端 66-plan.js 数据源）
            'eta_seconds': min(int(eta), 86400),
            'risk_max': risk_max,
            'scope': {'modifies': [], 'no_access': []},
        }
        if isinstance(scope, dict):
            plan['scope'] = {
                'modifies': [str(x)[:200] for x in (scope.get('modifies') or [])][:20],
                'no_access': [str(x)[:200] for x in (scope.get('no_access') or [])][:20]}
        os.makedirs(_plans_dir(), exist_ok=True)
        try:
            # 修复 A3：原子写（tmp+fsync+replace），崩溃不留半截 JSON
            atomic_write_json(_task_path(tid), plan, indent=1)
        except OSError as e:
            return {'ok': False, 'error': '计划落盘失败: %s' % e}
        return {'ok': True, 'task_id': tid, 'plan': plan}

    def get(self, task_id):
        try:
            p = _task_path(task_id)
        except ValueError:
            return {'ok': False, 'error': _TID_ERR}
        if not os.path.exists(p):
            return {'ok': False, 'error': '计划不存在: %s' % task_id}
        try:
            with open(p, 'r', encoding='utf-8') as f:
                plan = json.load(f)
        except (OSError, ValueError) as e:
            return {'ok': False, 'error': '计划读取失败: %s' % e}
        # 修复 A3：损坏文件（非对象 / steps 非数组）显式报错——
        # 不把脏数据透给 update 与前端状态机
        if not (isinstance(plan, dict) and isinstance(plan.get('steps'), list)):
            return {'ok': False, 'error': '计划文件损坏'}
        return {'ok': True, 'plan': plan}

    def update(self, task_id, status=None, step_index=None, step_status=None):
        """改计划状态或某步骤状态；返回 {ok, plan}。"""
        g = self.get(task_id)
        if not g.get('ok'):
            return g
        plan = g['plan']
        if status is not None:
            st = str(status)
            # 修复 A3：非法 status 显式报错（原静默忽略仍返回 ok，
            # 调用方以为批准/推进成功）
            if st not in PLAN_STATUSES:
                return {'ok': False, 'error': 'status 非法（合法值: %s）'
                        % '/'.join(PLAN_STATUSES)}
            plan['status'] = st
            # v1.9.0 M2.3：批准态转 approved_at（本地口径与 updated_at 一致；
            # 审计五维 plan 维度 + 计划卡批准动效链的时间锚）
            if st == 'approved' and not plan.get('approved_at'):
                plan['approved_at'] = _now()
        if step_index is not None and step_status is not None:
            try:
                idx = int(step_index)
            except (TypeError, ValueError):
                return {'ok': False, 'error': 'step_index 必须是整数'}
            if 0 <= idx < len(plan['steps']):
                ss = str(step_status)
                # 修复 A3：非法 step_status 显式报错（原静默忽略）
                if ss not in STEP_STATUSES:
                    return {'ok': False, 'error': 'step_status 非法（合法值: %s）'
                            % '/'.join(STEP_STATUSES)}
                plan['steps'][idx]['status'] = ss
            else:
                return {'ok': False, 'error': 'step_index 越界'}
        plan['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        try:
            # 修复 A3：原子写（tmp+fsync+replace）
            atomic_write_json(_task_path(task_id), plan, indent=1)
        except OSError as e:
            return {'ok': False, 'error': '计划保存失败: %s' % e}
        return {'ok': True, 'plan': plan}

    def list(self, limit=20):
        d = _plans_dir()
        if not os.path.isdir(d):
            return {'ok': True, 'plans': []}
        items = []
        for name in os.listdir(d):
            if not name.endswith('.json'):
                continue
            try:
                with open(os.path.join(d, name), 'r', encoding='utf-8') as f:
                    pl = json.load(f)
                items.append({'task_id': pl.get('task_id'), 'title': pl.get('title'),
                              'status': pl.get('status'), 'created_at': pl.get('created_at')})
            except (OSError, ValueError):
                continue
        items.sort(key=lambda x: x.get('created_at') or '', reverse=True)
        return {'ok': True, 'plans': items[:int(limit)]}

    # ---------------- 检查点（v1.9.0 M2.7：委托 CheckpointService 六军规）----------------
    def checkpoint_create(self, task_id, files, ws_dir=None, label='', mode=''):
        """委托 CheckpointService.create（六军规；行为等价+升级）。"""
        return self._checkpoint.create(task_id, files, ws_dir=ws_dir,
                                       label=label, mode=mode)

    def checkpoint_rollback(self, task_id, ws_dir=None, confirm=False):
        """委托 CheckpointService.rollback（⑤ 确认后端化：confirm 必真）。"""
        return self._checkpoint.rollback(task_id, ws_dir=ws_dir, confirm=confirm)

    def checkpoint_list(self, task_id=''):
        """委托 CheckpointService.list（无参=全部；传 tid=该任务清单）。"""
        return self._checkpoint.list(task_id)

    # ---------------- 澄清（纯数据结构） ----------------
    def clarify_collect(self, questions, answers):
        """answers: {q_index: option_index}；缺项用默认值。返回 {ok, resolved:[{q, answer}]}。"""
        resolved = []
        ans = answers if isinstance(answers, dict) else {}
        for i, q in enumerate(questions or []):
            if isinstance(q, str):
                q = {'q': q}
            opts = q.get('options') or []
            try:
                pick = int(ans.get(str(i), ans.get(i, q.get('default', 0))))
            except (TypeError, ValueError):
                pick = int(q.get('default', 0) or 0)
            if not (0 <= pick < len(opts)):
                # 越界回退到该题默认值（默认值本身也越界才落 0）
                pick = int(q.get('default', 0) or 0)
                if not (0 <= pick < len(opts)):
                    pick = 0
            resolved.append({'q': q.get('q') or q.get('question') or '',
                             'answer': opts[pick] if opts else ''})
        return {'ok': True, 'resolved': resolved}
