/**
 * LIGHTWELL V4 · MOD-01c: External Blob Store（外部大对象落盘存储器）
 *
 * 设计原则（守的是什么）：
 *   1. 【注意力窗口纪律】工具输出（网页正文、长文件、命令回显）动辄上万字符，
 *      整段塞进上下文会挤掉真正需要推理的部分，模型注意力被"数据"稀释。
 *      超过 inlineCharLimit 的输出整段落盘，上下文里只留「头部预览 + 尾部预览 +
 *      检索键」，把"引用"与"内容"分开。
 *   2. 【可回溯】落盘不是丢弃：blob_uri 是稳定键（工具名 + 内容摘要），
 *      后续可用关键字回查同一份原文，模型不需要重新执行副作用很大的工具。
 *   3. 【零第三方依赖】sha256 用 node:crypto，落盘用 node:fs，不引入任何包。
 *
 * py 源：harness/context_assembler.py:189-230 `class ExternalBlobStore`。
 * 按计划书要求单独成模块（py 源里它与 ContextAssembler 同文件），由
 * contextAssembler.mjs import 使用。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 按 **码点** 计长度 / 切片，与 py 的 `len(str)` / `str[a:b]` 同口径。
 *
 * 为什么不直接用 `String.prototype.length`：JS 的 length 是 UTF-16 码元数，
 * 一个 emoji（U+1F600）在 py 里算 1 个字符、在 JS 里算 2 个。用 length 会让
 * 「1800 字符阈值」对含增补平面字符的输出提前触发落盘，且 head/tail 预览会
 * 切在代理对中间（产生半个字符）。py 对应位置：`len(raw_output)`、
 * `raw_output[:600]`、`raw_output[-300:]`（:201/209/210）。
 * @param {string} text
 * @returns {string[]} 码点数组
 */
function toCodePoints(text) {
  return Array.from(String(text ?? ''));
}

/** py `len(str)` 等价：码点数。 */
function charLen(text) {
  return toCodePoints(text).length;
}

/**
 * py `str.removeprefix('blob://')` 等价（py 3.9+；:221）。
 * @param {string} value
 * @param {string} prefix
 */
function removePrefix(value, prefix) {
  const s = String(value ?? '');
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/**
 * py `str.splitlines()` 的主要分隔符集合。
 *
 * py 的 splitlines 认 \n \r \r\n \v \f \x1c \x1d \x1e \x85 \u2028 \u2029；
 * 这里按同等集合切分（不是只认 \r?\n），否则含 \u2028 的文本行匹配会与 py 不一致。
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return String(text ?? '').split(/\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/);
}

export class ExternalBlobStore {
  /**
   * @param {string} [storageDir='.lightwell_blobs'] 落盘目录（相对路径按进程 cwd 解析，同 py）
   * @param {number} [inlineCharLimit=1800] 内联上限（字符数，超出即落盘）
   */
  constructor(storageDir = '.lightwell_blobs', inlineCharLimit = 1800) {
    /** 落盘根目录（绝对路径） */
    this.storageDir = path.resolve(String(storageDir));
    /** 内联字符上限 */
    this.inlineCharLimit = inlineCharLimit;
    // py:197 `mkdir(parents=True, exist_ok=True)` —— mkdirSync recursive 即等价
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  /**
   * 超过阈值则落盘，返回「摘要 + 检索键」；未超过则原样返回（零拷贝语义）。
   * py:200-218 `offload_if_oversized`。
   * @param {string} toolName
   * @param {string} rawOutput
   * @returns {string}
   */
  offloadIfOversized(toolName, rawOutput) {
    const raw = String(rawOutput ?? '');
    if (charLen(raw) <= this.inlineCharLimit) {
      return raw;
    }

    // py:204 `hashlib.sha256(raw.encode('utf-8')).hexdigest()[:16]`
    const digest = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
    const blobKey = `${toolName}_${digest}`;
    const blobPath = path.join(this.storageDir, `${blobKey}.txt`);
    fs.writeFileSync(blobPath, raw, { encoding: 'utf8' });

    // py:209-210：头部 600 字符 / 尾部 300 字符预览，换行压成空格（单行摘要）
    const points = toCodePoints(raw);
    const headPreview = points.slice(0, 600).join('').replace(/\n/g, ' ');
    const tailPreview = points.slice(Math.max(0, points.length - 300)).join('').replace(/\n/g, ' ');

    return (
      '[EXTERNAL_BLOB_OFFLOADED]\n' +
      `blob_uri: blob://${blobKey}\n` +
      `original_chars: ${points.length}\n` +
      `head_preview: ${headPreview} ...\n` +
      `tail_preview: ... ${tailPreview}\n` +
      'hint: 如需检索完整内容中的特定字段，请使用检索原语工具按关键字查询该 blob_uri。'
    );
  }

  /**
   * 按 blob_uri（可带关键字）回查落盘原文。
   * py:220-230 `read_blob`。
   * @param {string} blobUri `blob://<tool>_<digest>`
   * @param {string|null} [keyword=null] 关键字（大小写不敏感的行过滤）
   * @param {number} [maxChars=2000] 返回上限（字符数，按码点截断）
   * @returns {string}
   */
  readBlob(blobUri, keyword = null, maxChars = 2000) {
    const blobKey = removePrefix(blobUri, 'blob://');
    const blobPath = path.join(this.storageDir, `${blobKey}.txt`);
    if (!fs.existsSync(blobPath)) {
      return `[BLOB_NOT_FOUND] ${blobUri}`;
    }
    const fullText = fs.readFileSync(blobPath, { encoding: 'utf8' });
    const points = toCodePoints(fullText);
    if (!keyword) {
      return points.slice(0, maxChars).join('');
    }
    const needle = String(keyword).toLowerCase();
    const matchedLines = splitLines(fullText).filter((line) => line.toLowerCase().includes(needle));
    const joined = matchedLines.join('\n');
    if (!joined) {
      return `[NO_MATCH_FOR_KEYWORD] keyword=${keyword}`;
    }
    return toCodePoints(joined).slice(0, maxChars).join('');
  }
}

/** 进程级单例（默认目录 .lightwell_blobs，内联上限 1800） */
let _sharedBlobStore = null;

/**
 * 共享 ExternalBlobStore（默认 1800 字符阈值）。
 * @returns {ExternalBlobStore}
 */
export function getSharedBlobStore() {
  if (!_sharedBlobStore) {
    _sharedBlobStore = new ExternalBlobStore();
  }
  return _sharedBlobStore;
}

/** 仅供测试/诊断：重建单例（指向临时目录，避免污染仓库） */
export function __resetSharedBlobStore() {
  _sharedBlobStore = null;
}
