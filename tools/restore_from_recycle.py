# -*- coding: utf-8 -*-
"""从 Windows 回收站按 $I 元数据恢复文件到原始路径。

回收站机制：删除的文件被改名为 $R<随机串>，原始路径只存在同后缀的
$I<随机串> 里。$I 结构（Vista+）：
    0-7   header (8 bytes, 01 00...)
    8-15  原始文件大小 (int64)
    16-23 删除时间 (FILETIME)
    24-27 路径长度（字符数，含结尾 NUL）(int32)
    28-   原始路径 (UTF-16LE, len*2 bytes)

只恢复路径匹配指定过滤器的条目，逐字节校验大小；绝不覆盖现存非空文件。
"""
from __future__ import annotations

import shutil
import struct
import sys
from pathlib import Path

RECYCLE = Path(r"C:\$Recycle.Bin\S-1-5-21-217150617-3634825547-2181273362-1001")


def parse_i(path: Path):
    """解析 $I 文件，返回 (原始路径, 原始大小) 或 None。"""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if len(data) < 28:
        return None
    size = struct.unpack_from("<q", data, 8)[0]
    plen = struct.unpack_from("<i", data, 24)[0]
    if plen <= 0 or 28 + plen * 2 > len(data):
        return None
    raw = data[28 : 28 + (plen - 1) * 2]
    try:
        orig = raw.decode("utf-16-le")
    except UnicodeDecodeError:
        return None
    return orig, size


def main(argv):
    patterns = argv or ["outputs\\"]
    dry = "--dry" in patterns
    patterns = [p for p in patterns if not p.startswith("--")]

    want = []
    for i_file in RECYCLE.glob("$I*"):
        parsed = parse_i(i_file)
        if not parsed:
            continue
        orig, size = parsed
        if not any(p.lower() in orig.lower() for p in patterns):
            continue
        r_body = RECYCLE / ("$R" + i_file.name[2:])
        if not r_body.exists():
            continue
        # 目录条目（删除时留下的空壳）跳过：真正的内容在各自独立的 $R 条目里
        if r_body.is_dir():
            continue
        want.append((orig, size, r_body))

    print(f"matched {len(want)} entries for {patterns}", flush=True)

    ok = skip = fail = 0
    fails = []
    for orig, size, r_body in want:
        dst = Path(orig)
        try:
            if dst.exists():
                cur = dst.stat().st_size
                if cur == r_body.stat().st_size:
                    skip += 1
                    continue
                if cur == 0:
                    # 空壳（此前失败留下的），覆盖
                    dst.unlink()
                else:
                    fails.append(f"NONEMPTY-DIFF {orig} cur={cur}")
                    fail += 1
                    continue
            if dry:
                ok += 1
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(r_body, dst)
            if dst.stat().st_size == r_body.stat().st_size:
                ok += 1
            else:
                fails.append(f"SIZE-MISMATCH {orig}")
                fail += 1
        except Exception as exc:  # noqa: BLE001
            fails.append(f"ERR {orig} :: {exc}")
            fail += 1

    print(f"copied={ok} skipped={skip} failed={fail}", flush=True)
    for line in fails[:15]:
        print("  " + line, flush=True)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))