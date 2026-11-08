# -*- coding: utf-8 -*-
"""配置存储服务：config.json / sessions.json / memory.json + 全局工作区。

legacy Api L252-305 / L227-250 / L804-824 原样搬迁；
修复：config.json 读-改-写竞态（save_config/_save_workspace 统一加锁）；
修复：静默吞错改为记录日志后按 legacy 语义降级。
"""
import datetime
import json
import os
import threading

from ... import paths
from ...errors import err, ok
from ...fio import atomic_write_json, atomic_write_text
from ...logging_setup import get_logger


class ConfigService:
    def __init__(self):
        self._log = get_logger()
        self._lock = threading.RLock()
        self.cwd = self._load_workspace()

    # ---- 全局工作区（legacy L227-250）----
    def set_cwd(self, path):
        """修复 建议⑧（二轮）：全局工作区改走的统一入口——锁内赋值+落盘
        （原 set_ws_dir 在锁外直接改 config.cwd 且不持久化，重启即丢）。"""
        with self._lock:
            self.cwd = os.path.abspath(str(path))
            self._save_workspace()
        return self.cwd

    def _load_workspace(self):
        try:
            if os.path.exists(paths.CONFIG_PATH):
                with open(paths.CONFIG_PATH, 'r', encoding='utf-8') as f:
                    cfg = json.load(f)
                ws = cfg.get('workspace')
                if ws and os.path.isdir(ws):
                    return ws
        except Exception as e:
            self._log.warning('工作区配置加载失败，使用默认目录: %r', e)
        desktop = os.path.join(os.path.expanduser('~'), 'Desktop')
        if not os.path.exists(desktop):
            desktop = os.path.expanduser('~')
        ws = os.path.join(desktop, 'GLM-Workspace')
        try:
            os.makedirs(ws, exist_ok=True)
        except Exception as e:
            self._log.warning('默认工作区创建失败: %r', e)
        return ws

    def _save_workspace(self):
        try:
            with self._lock:
                cfg = {}
                if os.path.exists(paths.CONFIG_PATH):
                    try:
                        with open(paths.CONFIG_PATH, 'r', encoding='utf-8') as f:
                            cfg = json.load(f)
                    except Exception:
                        cfg = {}
                cfg['workspace'] = self.cwd
                atomic_write_json(paths.CONFIG_PATH, cfg)   # 修复 S8：原子写
        except Exception as e:
            self._log.warning('工作区配置保存失败: %r', e)

    # ---- config.json（legacy L253-277）----
    def get_config(self):
        try:
            if os.path.exists(paths.CONFIG_PATH):
                with open(paths.CONFIG_PATH, 'r', encoding='utf-8') as f:
                    return f.read()
        except Exception as e:
            self._log.warning('配置读取失败: %r', e)
        return '{}'

    def save_config(self, config_json):
        try:
            with self._lock:
                cfg = {}
                if os.path.exists(paths.CONFIG_PATH):
                    try:
                        with open(paths.CONFIG_PATH, 'r', encoding='utf-8') as f:
                            cfg = json.load(f)
                    except Exception:
                        cfg = {}
                # 修复 建议⑥（二轮）：入参不是合法 JSON 时显式报错（原静默忽略仍返回 ok:true）
                try:
                    incoming = json.loads(config_json)
                except Exception as e:
                    return err('配置 JSON 解析失败，未写入: %s' % e)
                # 修复 建议⑩（二轮）：合法 JSON 但不是对象也显式报错（原静默 ok:true，
                # 用户以为保存成功实际什么都没改）
                if not isinstance(incoming, dict):
                    return err('配置必须是 JSON 对象（{...}），未写入')
                cfg.update(incoming)
                atomic_write_json(paths.CONFIG_PATH, cfg)   # 修复 S8：原子写
            return '{"ok":true}'
        except Exception as e:
            return err(e)

    # ---- sessions.json（legacy L279-295）----
    # v1.8.0 历史自选存放（2026-10-21）：sessions.json 位置由 history.json 的
    # dir 决定（空=默认 ~/.glm-chat/sessions.json）。history.json 独立文件——
    # config.json 零污染铁律。路径经 _sessions_dir() 归一（每次读配置，切换
    # 目录即时生效，无需重启）。
    def _history_cfg(self):
        """读 history.json → {'dir': 绝对路径或''}（损坏/缺失 → 默认空）。"""
        try:
            if os.path.exists(paths.HISTORY_FILE):
                with open(paths.HISTORY_FILE, encoding='utf-8') as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    return {'dir': str(d.get('dir') or '').strip()}
        except Exception as e:
            self._log.warning('history.json 读取失败: %r', e)
        return {'dir': ''}

    def _sessions_path_from(self, history_dir):
        """从单份 history 快照推导 sessions 路径，不重复读取 history.json。"""
        if history_dir and os.path.isdir(history_dir):
            return os.path.join(history_dir, 'sessions.json')
        if history_dir:
            self._log.warning('历史目录失效，回落默认 sessions.json: %s', history_dir)
        return paths.SESSIONS_PATH

    def sessions_path(self):
        """当前 sessions.json 绝对路径（自选目录优先；目录失效回落默认）。

        修复 W4：整段持 self._lock（RLock）——history.json 读-判-用与
        调用方后续的读/写之间不再有竞态窗口；目录失效时落 warning
        （原静默回落，用户换了移动盘/目录被删后无迹可查）。
        """
        with self._lock:
            return self._sessions_path_from(self._history_cfg()['dir'])

    def get_sessions(self):
        try:
            with self._lock:
                p = self.sessions_path()
                if os.path.exists(p):
                    with open(p, 'r', encoding='utf-8') as f:
                        return f.read()
        except Exception as e:
            self._log.warning('会话列表读取失败: %r', e)
        return '[]'

    def save_sessions(self, data):
        try:
            # 修复 W4：解析-校验-取路径-写入整段持锁（原 sessions_path() 在锁外，
            # 与 history_dir_set 切换目录存在读旧路径写新内容的竞态）
            with self._lock:
                # 修复 S8：写入前先校验是合法 JSON（前端传入串损坏时不再把 sessions.json 写坏）
                parsed = json.loads(data) if isinstance(data, str) else data
                if not isinstance(parsed, list):
                    return err('sessions 必须是 JSON 数组，未写入')
                p = self.sessions_path()
                os.makedirs(os.path.dirname(p), exist_ok=True)
                atomic_write_text(p,
                                  data if isinstance(data, str) else json.dumps(data, ensure_ascii=False))
            return '{"ok":true}'
        except Exception as e:
            return err(e)

    def session_purge(self, sid, task_ids_json='[]'):
        """真删一条会话的全部痕迹（2026-10-21 用户需求：删掉就是真删掉）。

        删：sessions.json 条目（后端保底）+ session_ws 绑定 + 关联的 plan
        json + 关联的 checkpoint 目录。task_ids 由前端传入（s.plan.task_id
        ——plan 与 sid 的关联在前端会话对象，后端不冗余存）。
        返回 {ok, removed: {sessions, ws, plans, checkpoints}}。
        """
        sid = str(sid or '')
        removed = {'sessions': 0, 'ws': 0, 'plans': 0, 'checkpoints': 0}
        # R37 修复（K5）：错误如实上报——原子步骤失败仅 warning 仍返回 ok:True，
        # 用户被告知「删干净」而磁盘残留 plan/checkpoint。errors 仅在非空时附加
        # （空场景返回 shape 与旧契约逐字节一致）。
        errors = []
        # R33：与 Electron/server 端共用的删除墓碑。两端共用 ~/.glm-chat，
        # Python 版删 sessions.json、Electron 版删 DB；任一端删除后，另一端
        # 启动时的 legacy 增量导入都必须跳过该 id，避免「删了又出现」。
        # R37 修复（N10）：墓碑读-改-写全程持锁（原无锁，并发 purge 互覆丢墓碑）。
        try:
            with self._lock:
                tomb_path = os.path.join(paths.CONFIG_DIR, 'deleted_session_ids.json')
                tomb = []
                if os.path.exists(tomb_path):
                    with open(tomb_path, encoding='utf-8') as f:
                        tomb = json.load(f)
                    if not isinstance(tomb, list):
                        tomb = []
                if sid and sid not in tomb:
                    tomb.append(sid)
                    atomic_write_text(tomb_path, json.dumps(tomb, ensure_ascii=False))
        except Exception as e:
            errors.append('墓碑写入失败: %s' % e)
            self._log.warning('purge 墓碑写入失败: %r', e)
        try:
            tasks = json.loads(task_ids_json or '[]')
            if not isinstance(tasks, list):
                tasks = []
                errors.append('task_ids 不是数组，关联计划/检查点未删除')
        except Exception:
            tasks = []
            errors.append('task_ids 非法 JSON，关联计划/检查点未删除')
        # ① sessions.json 条目（保底——前端通常已 filter 过）
        # 复核修正：读-改-写全程持 self._lock（save_sessions 同口径）——原
        # 无锁，并发 purge+保存互覆丢会话条目
        try:
            with self._lock:
                p = self.sessions_path()
                if os.path.exists(p):
                    with open(p, encoding='utf-8') as f:
                        arr = json.load(f)
                    if isinstance(arr, list):
                        keep = [s for s in arr if str(s.get('id') or '') != sid]
                        if len(keep) != len(arr):
                            atomic_write_text(p, json.dumps(keep, ensure_ascii=False))
                            removed['sessions'] = len(arr) - len(keep)
        except Exception as e:
            errors.append('sessions 条目删除失败: %s' % e)
            self._log.warning('purge sessions 失败: %r', e)
        # ② session_ws 绑定（直接删 session_ws.json 里的条目——workspace_service
        # 的 delete_session_ws 要 runtime 单例，此处保底路径直接操作文件）
        try:
            if os.path.exists(paths.SESSION_WS_FILE):
                with open(paths.SESSION_WS_FILE, encoding='utf-8') as f:
                    ws_map = json.load(f)
                if isinstance(ws_map, dict) and sid in ws_map:
                    del ws_map[sid]
                    atomic_write_text(paths.SESSION_WS_FILE,
                                      json.dumps(ws_map, ensure_ascii=False))
                    removed['ws'] = 1
        except Exception as e:
            self._log.debug('purge ws 失败（可忽略）: %r', e)
        # ③④ 关联持久化由 PlanningRepository 统一拥有，配置域不再拼另一域路径。
        from ..planning.repository import purge_associated
        associated = purge_associated(tasks, logger=self._log)
        removed['plans'] = associated['plans']
        removed['checkpoints'] = associated['checkpoints']
        result = {'ok': True, 'sid': sid, 'removed': removed}
        if errors:
            result['errors'] = errors   # 仅非空时附加（旧契约 shape 保持不变）
        return result

    # ---- 历史存放目录（history.json；独立文件，config.json 零污染）----
    @staticmethod
    def _sensitive_dirs():
        """系统敏感目录名单（修复 W6：按系统根动态生成）。

        原硬编码 'c:\\windows' 等前缀——Windows 装在非 C 盘（D:\\Windows）时
        名单整体失效。改为：sys_root = SYSTEMROOT（缺失回落 C:\\Windows），
        取其盘符替换 'c:' 前缀；另无论盘符拒绝 sys_root 本身。
        """
        sys_root = (os.environ.get('SYSTEMROOT') or 'C:\\Windows') \
            .replace('/', '\\').rstrip('\\') or 'C:\\Windows'
        drive = os.path.splitdrive(sys_root)[0].lower() or 'c:'
        names = ('windows', 'program files', 'program files (x86)',
                 'programdata', '$recycle.bin', 'system volume information')
        return [drive + '\\' + n for n in names] + [sys_root.lower()]

    def history_dir_get(self):
        """当前历史存放目录（'' = 默认 ~/.glm-chat/）；单次调用共享一份快照。"""
        with self._lock:
            history_dir = self._history_cfg()['dir']
            return {'ok': True, 'dir': history_dir,
                    'default_dir': paths.CONFIG_DIR,
                    'sessions_file': self._sessions_path_from(history_dir)}

    def history_dir_set(self, dir_path, migrate=False):
        """设置历史存放目录（空串=恢复默认）。

        校验：目录必须已存在且可写；禁系统敏感目录（Windows/Program Files 等，
        W6 起按系统根动态生成）；realpath 归一（防 symlink/junction 绕过与
        重复登记）。migrate=True：把**当前生效的** sessions.json 搬到新目录
        （W9：源取 sessions_path() 当时值，非恒定默认路径；已存在则跳过，
        不覆盖）。返回 {ok, dir, migrated, migrated_from} 或 {error: 人话}。

        修复 W4：整段持 self._lock（RLock）——校验-迁移-落 history.json
        与并发 get/save_sessions 不再交错。
        """
        with self._lock:
            d = str(dir_path or '').strip()
            if not d:
                # 恢复默认
                self._save_history_cfg('')
                return {'ok': True, 'dir': '', 'migrated': False, 'migrated_from': ''}
            norm = os.path.realpath(os.path.abspath(os.path.expanduser(d)))
            if not os.path.isdir(norm):
                return {'error': '目录不存在：%s（请先创建）' % d}
            if not os.access(norm, os.W_OK):
                return {'error': '目录不可写：%s' % norm}
            low = norm.lower().rstrip('\\/')
            for s in self._sensitive_dirs():
                if low == s or low.startswith(s + '\\'):
                    return {'error': '不能使用系统目录：%s' % norm}
            migrated = False
            migrated_from = ''
            # 修复 W9：迁移源取当前生效 sessions.json（自选目录已切换过的
            # 场景下旧数据在那，不在恒定默认路径）
            src = self.sessions_path()
            if migrate and os.path.isfile(src) and \
                    os.path.realpath(os.path.dirname(src)) != norm:
                dst = os.path.join(norm, 'sessions.json')
                if not os.path.exists(dst):
                    try:
                        import shutil
                        shutil.copy2(src, dst)
                        migrated = True
                        migrated_from = src
                        # R37 修复（N17）：迁移后源文件改名退位——原 copy2 不删源，
                        # 旧 sessions.json 残留原目录；再切回默认目录时旧数据（含
                        # 已 purge 会话）整批复活。
                        try:
                            os.replace(src, src + '.migrated.bak')
                        except Exception as e2:
                            self._log.warning('迁移后源文件退位失败（残留可复活）: %r', e2)
                    except Exception as e:
                        return {'error': '迁移失败: %s' % e}
            self._save_history_cfg(norm)
            return {'ok': True, 'dir': norm, 'migrated': migrated,
                    'migrated_from': migrated_from}

    def _save_history_cfg(self, dir_abs):
        """history.json 原子写（dir 绝对路径；''=默认）。"""
        try:
            atomic_write_text(paths.HISTORY_FILE,
                              json.dumps({'dir': dir_abs}, ensure_ascii=False))
            return True
        except Exception as e:
            self._log.warning('history.json 写入失败: %r', e)
            return False

    # ---- memory.json（legacy L804-824 → W11 结构化三类 2026-10-21）----
    def _memory(self):
        """MemoryService 懒单例（结构化三类/检索/注入）。"""
        if getattr(self, '_mem_svc', None) is None:
            from .memory_service import MemoryService
            self._mem_svc = MemoryService(paths.MEMORY_PATH, self._log)
        return self._mem_svc

    def get_memory(self):
        """读取（结构化输出：每条带 kind；旧数据懒迁移不落盘）。"""
        try:
            return json.dumps(self._memory().list(), ensure_ascii=False)
        except Exception as e:
            self._log.warning('记忆读取失败: %r', e)
        return '[]'

    def memory_retrieve(self, query, limit=5):
        """W11：关键词检索（bigram 重叠 + rule 加成 + 时间衰减）。"""
        try:
            items = self._memory().retrieve(str(query or ''), int(limit or 5))
            return {'ok': True, 'items': items}
        except Exception as e:
            return {'error': str(e)}

    def append_memory(self, entry_json):
        """W11 结构化追加：自动分类（fact/preference/rule）+ rule/preference
        文本去重 + 上限淘汰最旧 fact（指令类不淘汰）。旧签名（JSON 串/对象/
        裸字符串）全兼容；返回 {ok, kind, total}。"""
        try:
            with self._lock:
                e = entry_json
                if isinstance(e, str):
                    try:
                        e = json.loads(e)
                    except Exception:
                        e = {'text': e}      # 裸字符串兜底（非 JSON）
                if not isinstance(e, dict):
                    e = {'text': '' if e is None else str(e)}
                r = self._memory().append(e)
                if 'error' in r:
                    return err(r['error'])
                return json.dumps(r, ensure_ascii=False)
        except Exception as e:
            return err(e)

    def delete_memory(self, index):
        """实现 v1.8.0 W11：删除 memory.json 数组第 index 条（0 起；原子写）。

        双轨收敛（本轮）：删除动作转调 MemoryService.delete（与 append_memory
        同一数据通道）——原此处自持一套 pop/write，kind 懒迁移口径与上限
        淘汰各走一套，删完视图可能与 append 不一致。
        边界校验不静默夹逼：bool/None/float 等非整数形态与越界下标一律
        {'error': {'code': 'BAD_PARAMS', ...}}（数字字符串按 int 解析）；
        结构异常（建议17：直接读文件判型，绕过 get_memory→list 归一）与
        越界均保持人话 shape；MemoryService 侧异常同样防御性映射。
        成功返回 {'ok': True, 'index': idx, 'remaining': N}。"""
        try:
            idx = self._coerce_index(index)
        except (TypeError, ValueError) as e:
            return {'error': {'code': 'BAD_PARAMS', 'message': str(e),
                              'hint': '传入要删除的记忆序号（从 0 开始）'}}
        try:
            with self._lock:
                # 修复 建议17：直接读文件判型（绕过 get_memory→list 归一）——
                # memory.json 损坏（非数组/JSON 解析失败）时原实现被归一成
                # 空列表、报「序号越界：共 0 条」，用户无从知道是文件坏了
                try:
                    with open(paths.MEMORY_PATH, encoding='utf-8') as f:
                        raw = json.load(f)
                except FileNotFoundError:
                    raw = []
                except Exception as e:
                    return {'error': {'code': 'BAD_PARAMS',
                                      'message': '记忆文件结构异常（%s），暂不能删除' % e,
                                      'hint': '可手工编辑 memory.json 修复'}}
                if not isinstance(raw, list):
                    return {'error': {'code': 'BAD_PARAMS',
                                      'message': '记忆文件结构异常（不是数组），暂不能删除',
                                      'hint': '可手工编辑 memory.json 修复'}}
                if idx < 0 or idx >= len(raw):
                    return {'error': {'code': 'BAD_PARAMS',
                                      'message': '序号越界：当前共 %d 条记忆' % len(raw),
                                      'hint': '刷新列表后重试；序号从 0 开始'}}
                # 删除动作本体转调 MemoryService.delete（弹栈 + 原子写；
                # 上面的越界/结构异常已适配人话，此处防御性映射残余错误）
                r = self._memory().delete(idx)
                if 'error' in r:
                    return {'error': {'code': 'BAD_PARAMS', 'message': r['error'],
                                      'hint': '刷新列表后重试；序号从 0 开始'}}
                return {'ok': True, 'index': idx, 'remaining': r['remaining']}
        except Exception as e:
            self._log.warning('记忆删除失败: %r', e)
            return {'error': {'code': 'INTERNAL', 'message': str(e)}}

    @staticmethod
    def _coerce_index(index):
        """下标归一：bool 是 int 子类须显式排除；float 一律拒绝（不静默截断）；
        字符串按 int 解析（解析失败给人话，不漏 Python 内部异常串）。"""
        if index is None or isinstance(index, bool):
            raise ValueError('序号需要是整数')
        if isinstance(index, int):
            return index
        if isinstance(index, str):
            s = index.strip()
            try:
                return int(s)
            except ValueError:
                raise ValueError('序号需要是整数（收到 %r）' % s[:32])
        raise ValueError('序号需要是整数')
