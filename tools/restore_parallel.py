# -*- coding: utf-8 -*-
"""从回收站并行恢复文件（多线程版）。

单独的文件复制被 Defender 实时扫描拖慢到 ~10 文件/分钟。用线程池并发提交
可显著提升吞吐（每个文件仍独立校验大小并保留原始时间戳）。
"""
from __future__ import annotations

import shutil
import struct
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

RECYCLE = Path(r"C:\$Recycle.Bin\S-1-5-21-217150617-3634825547-2181273362-1001")
WORKERS = 16


def parse_i(path: Path):
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
    try:
        orig = data[28 : 28 + (plen - 1) * 2].decode("utf-16-le")
    except UnicodeDecodeError:
        return None
    return orig, size


def collect(patterns):
    want = []
    for i_file in RECYCLE.glob("$I*"):
        parsed = parse_i(i_file)
        if not parsed:
            continue
        orig, size = parsed
        if not any(p.lower() in orig.lower() for p in patterns):
            continue
        r_body = RECYCLE / ("$R" + i_file.name[2:])
        if not r_body.exists() or r_body.is_dir():
            continue
        want.append((orig, size, r_body))
    return want


def restore_one(item):
    orig, size, r_body = item
    dst = Path(orig)
    try:
        if dst.exists():
            cur = dst.stat().st_size
            if cur == r_body.stat().st_size:
                return "skip"
            if cur == 0:
                dst.unlink()
            else:
                return "conflict"
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(r_body, dst)
        if dst.stat().st_size == r_body.stat().st_size:
            return "ok"
        return "size-mismatch"
    except Exception as exc:  # noqa: BLE001
        return f"err:{exc}"


def main(argv):
    dry = "--dry" in argv
    patterns = [a for a in argv if not a.startswith("--")] or ["outputs\\"]
    want = collect(patterns)
    print(f"matched {len(want)} for {patterns}", flush=True)
    if dry:
        pending = [w for w in want if not Path(w[0]).exists()]
        print(f"would copy {len(pending)} (dry)", flush=True)
        return 0

    counts = {}
    errs = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(restore_one, w): w for w in want}
        done = 0
        for fut in as_completed(futures):
            r = fut.result()
            done += 1
            key = r.split(":")[0]
            counts[key] = counts.get(key, 0) + 1
            if key in ("err", "conflict", "size-mismatch") and len(errs) < 12:
                errs.append(f"{r} :: {futures[fut][0]}")
            if done % 200 == 0:
                print(f"  progress {done}/{len(want)}", flush=True)
    print("result:", counts, flush=True)
    for e in errs:
        print("  " + e, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))