# -*- coding: utf-8 -*-
"""MCP 服务器配置服务（v1.3 R2）：~/.glm-chat/mcp_servers.json 唯一读写者。

结构（Claude 兼容 + 扩展键，架构 §3.1）：
{
  "mcpServers": {
    "<name>": {
      "command": "...", "args": [...], "env": {"K": "v" | {"__enc__": "dpapi:..."}},   # stdio
      "url": "https://...", "headers": {"K": "v" | {"__enc__": "..."}},               # http
      "enabled": false,                       # 扩展键：opt-in 启用
      "tierOverrides": {"tool": "always|session|off"}   # 扩展键：用户逐工具档位覆盖
    }
  }
}

口径：
- env 值 / header 值落盘前经 mcp_dpapi 加密（标记 {"__enc__": "dpapi:..."}）；读取时解密，
  失败按明文兜底 + 告警列表（面板提示重新填写）。
- command/args/url/键名/服务器名明文（可读、可手改、Claude 导入不受影响）。
- import_claude：同名冲突跳过并报告；type=="sse" 条目 skipped「不受支持」。
- precheck_command：expandvars + shutil.which（Windows 自动走 PATHEXT），缺运行时给安装指引。
- 不碰 config.json（契约红线）：一切状态只进本文件 / 进程内存 / audit_log.jsonl。
"""
import copy
import json
import os
import re
import shlex
import shutil
import threading

from .... import paths
from ....fio import atomic_write_json
from ....logging_setup import get_logger
from . import mcp_dpapi

VALID_TIERS = ('always', 'session', 'off')
_URL_RE = re.compile(r'^https?://', re.IGNORECASE)


def _default_data():
    return {'mcpServers': {}}


def _encrypt_field(mapping):
    """字段级加密 env/headers 值：Windows → {'__enc__': 'dpapi:...'}；
    非 Windows / 异常 → 明文容忍（按普通字符串落盘，下次保存时再尝试加密）；
    已是加密标记的值原样透传（不重复加密）。
    返回 (out, plain_keys)：plain_keys 为加密失败/不可用而以明文落盘的键（面板可见提示用，W21）。"""
    out, plain_keys = {}, []
    for k, v in (mapping or {}).items():
        # 修复 N3（四轮）：落盘加密结构（{'__enc__': 'dpapi:...'}，文件格式文档允许的形态）
        # 原被 str() 成 Python repr 再重新加密——原密文永久丢失（DPAPI 真机实证）。
        # 密文标记 dict 原样透传（试解密验证）；env 路径与 headers 同口径。
        if isinstance(v, dict) and isinstance(v.get('__enc__'), str):
            _ev = v['__enc__']
            dec = mcp_dpapi.decrypt_value(_ev)
            if dec and not dec.startswith(mcp_dpapi.ENC_PREFIX):
                out[k] = {'__enc__': _ev}
                continue
            v = _ev   # 解密验证失败：按明文串重新加密（不丢原值语义）
        v = str(v if v is not None else '')
        if v.startswith(mcp_dpapi.ENC_PREFIX):
            # 修复 建议⑰（二轮）：合法明文值可能恰好以 'dpapi:' 开头——原无条件当
            # 已加密标记透传，读取时解密失败被置空下发，用户密钥静默丢失。
            # 现试解密验证：真能解出非标记串 → 才是密文标记；否则按明文重新加密。
            dec = mcp_dpapi.decrypt_value(v)
            if dec and not dec.startswith(mcp_dpapi.ENC_PREFIX):
                out[k] = {'__enc__': v}
                continue
        enc = mcp_dpapi.encrypt_value(v)
        out[k] = {'__enc__': enc} if enc.startswith(mcp_dpapi.ENC_PREFIX) else enc
        if not enc.startswith(mcp_dpapi.ENC_PREFIX) and v:
            plain_keys.append(str(k))
    return out, plain_keys


class McpConfigService:
    """mcp_servers.json CRUD + Claude 导入 + 启用预检测。"""

    def __init__(self, path: str = None):
        self._log = get_logger()
        self._path = path or paths.MCP_SERVERS_FILE
        self._lock = threading.RLock()
        self._data = self._load()

    # ---- 文件读写 ----
    def _load(self):
        try:
            with open(self._path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get('mcpServers'), dict):
                return data
            # 修复 ⑫（三轮）：结构异常同样留 .bad 备份（原只有解析异常分支留，
            # 结构异常直接按空配置处理会覆盖丢失——半损坏配置无迹可寻）
            self._log.warning('mcp_servers.json 结构异常，按空配置处理（已留 .bad 备份）')
            try:
                os.replace(self._path, self._path + '.bad')
            except Exception:
                pass
        except FileNotFoundError:
            pass
        except Exception as e:
            self._log.warning('mcp_servers.json 加载失败，按空配置处理: %r', e)
            # 修复 ⑰：配置损坏先留 .bad 备份再按空配置处理（原直接覆盖无备份）
            try:
                os.replace(self._path, self._path + '.bad')
            except Exception:
                pass
        return _default_data()

    def _save(self):
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        atomic_write_json(self._path, self._data, indent=2)   # tmp+fsync+replace

    # ---- 查询 ----
    def list_servers(self) -> list:
        """[{name, transport, enabled}]（无密文，面板列表用；纯内存零 IO）。"""
        out = []
        with self._lock:
            for name, cfg in self._data.get('mcpServers', {}).items():
                if not isinstance(cfg, dict):
                    continue
                out.append({
                    'name': name,
                    'transport': 'http' if cfg.get('url') else 'stdio',
                    'enabled': bool(cfg.get('enabled')),
                    # 修复 F2（v1.4）：透出 callTimeout（None=未配置，读时回落默认 60）
                    'callTimeout': cfg.get('callTimeout'),
                })
                # v1.5.1 预留（S1/S2/S5）：池配置键仅在显式配置时透出
                # （未配置不输出——保持旧输出形状，老面板/测试零影响）
                for pk in ('keep_alive', 'max_concurrency', 'warm_on_enable'):
                    if cfg.get(pk) is not None:
                        out[-1][pk] = cfg.get(pk)
        out.sort(key=lambda s: s['name'])
        return out

    def get_server(self, name) -> dict:
        """解密后的运行视图（env/headers 明文，编辑器回显用；裁决 Q5：与 apiKey 同信任级）。

        注意（W21）：解密失败的键在视图中保持内层标记串（编辑器回显契约，QA 测试锁定），
        真正的安全边界在下发侧——McpService._spawn_client 会把仍以 'dpapi:' 开头的值置 ''，
        密文串永远不会当真实密钥下发子进程/HTTP 头。"""
        with self._lock:
            cfg = self._data.get('mcpServers', {}).get(str(name or ''))
            if not isinstance(cfg, dict):
                return None
            view = copy.deepcopy(cfg)   # 修复 W20：深拷贝（原浅拷贝嵌套 dict 共享引用可绕锁污染）
        view['name'] = str(name)
        env, env_failed = mcp_dpapi.decrypt_mapping(cfg.get('env') or {})
        headers, hdr_failed = mcp_dpapi.decrypt_mapping(cfg.get('headers') or {})
        if env or env_failed:
            view['env'] = env
        if headers or hdr_failed:
            view['headers'] = headers
        view['decrypt_failed'] = env_failed + hdr_failed
        return view

    # ---- 校验与规范化 ----
    @staticmethod
    def _normalize(name, cfg):
        """结构校验 + 规范化。返回 (record, transport, error)。"""
        name = str(name or '').strip()
        if not name:
            return None, None, '服务器名称不能为空'
        if not isinstance(cfg, dict):
            return None, None, '配置必须是 JSON 对象'
        if '/' in name or '\\' in name or name in ('.', '..'):
            return None, None, '服务器名称不能包含路径分隔符'

        url = str(cfg.get('url') or '').strip()
        command = str(cfg.get('command') or '').strip().strip('"')
        record = {}

        if url:
            if not _URL_RE.match(url):
                return None, None, 'HTTP 服务器需要 http:// 或 https:// 开头的 url'
            headers = cfg.get('headers') or {}
            if not isinstance(headers, dict):
                return None, None, 'headers 必须是对象（键值对）'
            record['url'] = url
            # 修复 W12（三轮）：原 `str(v)` 把 DPAPI 字段级加密结构（dict 形态
            # {'enc': ...}）静默损坏为 repr 字符串——加密值原样保留，标量才转字符串
            _hdrs = {}
            for k, v in headers.items():
                if isinstance(v, dict):
                    _hdrs[str(k)] = v
                elif str(v or '').strip() != '':
                    _hdrs[str(k)] = str(v)
            record['headers'] = _hdrs
            transport = 'http'
        elif command:
            args = cfg.get('args')
            if args is None:
                args = []
            if isinstance(args, str):
                # 修复 ⑯：args 字符串用 shlex（posix=False）切分，带空格/引号参数不再被劈开
                try:
                    args = [a.strip('"').strip("'") for a in shlex.split(args, posix=False)]
                except ValueError:
                    args = args.split()
            if not isinstance(args, (list, tuple)):
                return None, None, 'args 必须是字符串数组'
            env = cfg.get('env') or {}
            if not isinstance(env, dict):
                return None, None, 'env 必须是对象（键值对）'
            record['command'] = command
            record['args'] = [str(a) for a in args]
            # 空值 env 条目 = 删除该键（共享知识 11）
            # 修复 N3（四轮）：env 分支与 headers 同口径——DPAPI dict 形态原样保留
            #（原 str(v) 把密文标记损坏成 repr，真机实证不可恢复）
            _env = {}
            for k, v in env.items():
                if isinstance(v, dict):
                    _env[str(k)] = v
                elif str(v or '').strip() != '':
                    _env[str(k)] = str(v)
            record['env'] = _env
            transport = 'stdio'
        else:
            return None, None, 'stdio 服务器需要 command，HTTP 服务器需要 url'

        overrides = cfg.get('tierOverrides') or {}
        if not isinstance(overrides, dict):
            return None, None, 'tierOverrides 必须是对象'
        clean_over = {}
        for tool, tier in overrides.items():
            if tier not in VALID_TIERS:
                return None, None, '档位 %r 非法（仅支持 always/session/off）' % (tier,)
            clean_over[str(tool)] = tier
        record['tierOverrides'] = clean_over
        # 修复 F2（v1.4）：每服务器 callTimeout（秒）——缺省不写（读时回落默认 60）；
        # 越界/非数字人话拒绝（验收：5 或 999 被拒并提示范围）
        if cfg.get('callTimeout') is not None and str(cfg.get('callTimeout')).strip() != '':
            try:
                ct = int(str(cfg.get('callTimeout')).strip())
            except (TypeError, ValueError):
                return None, None, 'callTimeout 必须是 10-300 的整数（秒）'
            if ct < 10 or ct > 300:
                return None, None, 'callTimeout 超出范围（10-300 秒），当前值 %d' % ct
            record['callTimeout'] = ct
        # v1.5.1 预留（S1/S2/S5）：连接池/温启/并发上限可选键——全部可选带默认，
        # Claude 兼容结构忽略未知键，老配置文件零影响（roadmap §5.2）
        from .mcp_pool import parse_pool_config
        pool_record, pool_err = parse_pool_config(
            {k: cfg[k] for k in ('keep_alive', 'max_concurrency', 'warm_on_enable')
             if k in cfg})
        if pool_err:
            return None, None, pool_err
        record.update(pool_record)
        # 批 3b（M2.10 R36）：定期重验纯增键透传——_normalize 是白名单重建，
        # 不透传则 save_server 全量保存会把后台写入的 lastReverifyAt 抹掉
        # （后果=下次扫描全部首验，重验风暴）。未携带不写（缺省语义）。
        if isinstance(cfg.get('lastReverifyAt'), str) and cfg.get('lastReverifyAt'):
            record['lastReverifyAt'] = cfg['lastReverifyAt']
        if isinstance(cfg.get('reverifyEnabled'), bool):
            record['reverifyEnabled'] = cfg['reverifyEnabled']
        return record, transport, None

    # ---- 写操作 ----
    def save_server(self, name: str, cfg: dict, activate: bool = False) -> dict:
        """保存服务器配置。activate=True（enabled false→true）时先 precheck_command，
        失败返回 {error: 人话} 且不落盘 enabled=true。

        修复 S16：cfg 未携带 tierOverrides 时保留既有覆盖（原全量重建静默清空）。"""
        overrides_absent = 'tierOverrides' not in cfg if isinstance(cfg, dict) else False
        record, transport, error = self._normalize(name, cfg)
        if error:
            return {'error': error}

        enabled = bool(cfg.get('enabled'))
        if activate and enabled:
            if transport == 'stdio':
                reason = self.precheck_command(record['command'])
                if reason:
                    return {'error': reason}

        with self._lock:
            servers = self._data.setdefault('mcpServers', {})
            existing = servers.get(str(name).strip()) or {}
            if 'enabled' not in cfg:
                enabled = bool(existing.get('enabled'))
            record['enabled'] = enabled
            if overrides_absent and isinstance(existing.get('tierOverrides'), dict):
                record['tierOverrides'] = existing['tierOverrides']   # 修复 S16：保留既有档位覆盖
            # 实现 v1.6 T12：资源订阅（mcp_servers.json 新可选键 resourceSubs；Claude
            # 兼容结构忽略未知键）——未携带时保留既有订阅，显式携带则校验后入库
            subs = cfg.get('resourceSubs') if isinstance(cfg, dict) else None
            if subs is None and isinstance(existing.get('resourceSubs'), list):
                record['resourceSubs'] = existing['resourceSubs']
            elif isinstance(subs, list):
                record['resourceSubs'] = [str(u)[:500] for u in subs
                                          if isinstance(u, str) and u.strip()][:100]
            # 批 3b（M2.10 R36）：重验键未携带时保留既有（resourceSubs 同款
            # absent-keep——UI 全量保存不感知后台写入值，禁抹）
            if cfg.get('lastReverifyAt') is None \
                    and isinstance(existing.get('lastReverifyAt'), str):
                record['lastReverifyAt'] = existing['lastReverifyAt']
            if cfg.get('reverifyEnabled') is None \
                    and isinstance(existing.get('reverifyEnabled'), bool):
                record['reverifyEnabled'] = existing['reverifyEnabled']
            # 字段级加密：env 值 / header 值（键名明文；非 Windows 明文容忍）
            plain_keys = []
            if 'env' in record:
                record['env'], _pk = _encrypt_field(record['env'])
                plain_keys += _pk
            if 'headers' in record:
                record['headers'], _pk = _encrypt_field(record['headers'])
                plain_keys += _pk
            name_key = str(name).strip()
            had_key = name_key in servers
            old_record = servers.get(name_key)
            servers[name_key] = record
            try:
                self._save()
            except Exception as e:
                # 修复 W5（二轮）：落盘失败回滚内存态（原内存已改、磁盘未变 → 两态分裂）
                if had_key:
                    servers[name_key] = old_record
                else:
                    servers.pop(name_key, None)
                self._log.exception('mcp_servers.json 保存失败')
                return {'error': '配置保存失败: %s' % e}
        result = {'ok': True, 'name': str(name).strip(), 'transport': transport}
        if plain_keys:
            # 修复 W21：加密失败明文落盘的键面板可见（DPAPI 不可用/异常时用户须知）
            result['encrypt_plain'] = plain_keys
        return result

    def delete_server(self, name) -> dict:
        with self._lock:
            servers = self._data.get('mcpServers', {})
            if str(name) not in servers:
                return {'error': '服务器不存在: %s' % name}
            old = servers[str(name)]
            del servers[str(name)]
            try:
                self._save()
            except Exception as e:
                servers[str(name)] = old   # 修复 W5（二轮）：落盘失败回滚内存态（原内存/磁盘分裂）
                self._log.exception('mcp_servers.json 删除失败')
                return {'error': '配置删除失败: %s' % e}
        return {'ok': True}

    def set_reverify_at(self, name, iso_ts: str) -> dict:
        """批 3b（M2.10 R36）：直写 lastReverifyAt 纯增键（后台定期重验专用）。

        不走 save_server 全量重建——那条路会重跑 _normalize + env/headers 二次
        加密 round-trip，且与 UI 并发保存互覆；本方法只动一个键，锁内改内存 +
        原子落盘，失败回滚（W5 同口径）。"""
        with self._lock:
            cfg = self._data.get('mcpServers', {}).get(str(name or ''))
            if not isinstance(cfg, dict):
                return {'error': '服务器不存在: %s' % name}
            old = cfg.get('lastReverifyAt')
            cfg['lastReverifyAt'] = str(iso_ts)
            try:
                self._save()
            except Exception as e:
                if old is None:
                    cfg.pop('lastReverifyAt', None)
                else:
                    cfg['lastReverifyAt'] = old
                self._log.exception('lastReverifyAt 保存失败')
                return {'error': 'lastReverifyAt 保存失败: %s' % e}
        return {'ok': True}

    def set_tool_tier(self, server: str, tool: str, tier: str) -> dict:
        """写 tierOverrides[server][tool] = tier（always/session/off）。"""
        if tier not in VALID_TIERS:
            return {'error': '档位必须是 always/session/off'}
        with self._lock:
            cfg = self._data.get('mcpServers', {}).get(str(server or ''))
            if not isinstance(cfg, dict):
                return {'error': '服务器不存在: %s' % server}
            overrides = cfg.setdefault('tierOverrides', {})
            tool_key = str(tool)
            had_key = tool_key in overrides
            old_tier = overrides.get(tool_key)
            overrides[tool_key] = tier
            try:
                self._save()
            except Exception as e:
                # 修复 W5（二轮）：落盘失败回滚内存态
                if had_key:
                    overrides[tool_key] = old_tier
                else:
                    overrides.pop(tool_key, None)
                self._log.exception('tierOverrides 保存失败')
                return {'error': '档位保存失败: %s' % e}
        return {'ok': True}

    def import_claude(self, config_json: str) -> dict:
        """导入 claude_desktop_config.json：{"mcpServers": {...}}。

        同名冲突跳过并报告；type=="sse" 条目 skipped「不受支持」；其余 enabled=false 入库。
        """
        try:
            data = json.loads(config_json) if isinstance(config_json, str) else config_json
        except Exception as e:
            return {'error': '不是合法 JSON: %s' % e}
        if not isinstance(data, dict) or not isinstance(data.get('mcpServers'), dict):
            return {'error': '未找到 mcpServers 段——请粘贴 claude_desktop_config.json 全文'}

        imported, skipped = [], []
        plain_keys = []   # 修复 建议㉑（二轮）：导入的 plain_keys 不再丢弃（W21 面板提示）
        with self._lock:
            servers = self._data.setdefault('mcpServers', {})
            # 修复 N5（四轮）：导入前快照内存态，落盘失败回滚——原只返回 error 不回滚，
            # 内存已含导入项而磁盘没有（两态分裂：重启丢失 / 幽灵项被后续 _save 持久化）
            import copy as _copy
            _snapshot = _copy.deepcopy(servers)
            for name, entry in data['mcpServers'].items():
                name = str(name)
                if not isinstance(entry, dict):
                    skipped.append({'name': name, 'reason': '条目不是对象，已跳过'})
                    continue
                if str(entry.get('type') or '').lower() == 'sse':
                    skipped.append({'name': name, 'reason': 'SSE 传输不受支持（v1.3 仅支持 stdio 与 Streamable HTTP）'})
                    continue
                if name in servers:
                    skipped.append({'name': name, 'reason': '同名服务器已存在，已跳过（可编辑后覆盖保存）'})
                    continue
                record, transport, error = self._normalize(name, dict(entry, enabled=False))
                if error:
                    skipped.append({'name': name, 'reason': error})
                    continue
                record['enabled'] = False
                if 'env' in record:
                    record['env'], _pk = _encrypt_field(record['env'])
                    plain_keys += _pk
                if 'headers' in record:
                    record['headers'], _pk = _encrypt_field(record['headers'])
                    plain_keys += _pk
                servers[name] = record
                imported.append(name)
            try:
                self._save()
            except Exception as e:
                # 修复 N5（四轮）：落盘失败回滚内存态（与 save_server/delete 同口径）
                self._data['mcpServers'] = _snapshot
                self._log.exception('Claude 配置导入落盘失败')
                return {'error': '导入落盘失败: %s' % e}
        result = {'ok': True, 'imported': imported, 'skipped': skipped,
                  'total': len(imported) + len(skipped)}
        if plain_keys:
            result['encrypt_plain'] = plain_keys   # 修复 建议㉑（二轮）
        return result

    # ---- 环境预检测 ----
    @staticmethod
    def precheck_command(command: str):
        """expandvars + which/PATHEXT 预检测。None=通过；否则返回人话（缺什么 + 安装指引）。"""
        cmd = os.path.expandvars(str(command or '').strip()).strip().strip('"')
        if not cmd:
            return '未填写启动命令'
        # 含路径分隔符 → 直接查文件存在
        if os.sep in cmd or (os.altsep and os.altsep in cmd):
            if os.path.isfile(cmd):
                return None
            return ('未找到命令文件 %s，请确认路径是否正确。' % cmd)
        if shutil.which(cmd):
            return None
        return ('未找到命令 %s。请先安装对应运行时：Node.js（https://nodejs.org ，提供 npx）'
                '或 uv（https://astral.sh/uv ，提供 uvx）后重试。' % cmd)
