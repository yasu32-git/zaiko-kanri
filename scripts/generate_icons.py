#!/usr/bin/env python3
"""PWA用アイコンPNGを生成する（外部ライブラリ不要）。

app/icons/icon-{180,192,512}.png を出力する。
緑の角丸背景に、白いカゴ（買い物かご）のシルエットを描く。
"""
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "app" / "icons"

BG = (47, 111, 78)      # --accent
FG = (255, 255, 255)


def rounded_rect(x, y, size, radius):
    """(x, y) が角丸正方形の内側かどうか。"""
    if not (0 <= x < size and 0 <= y < size):
        return False
    cx = min(max(x, radius), size - 1 - radius)
    cy = min(max(y, radius), size - 1 - radius)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= radius * radius


def basket(x, y, s):
    """買い物かごのシルエット（0..1 に正規化した座標で判定）。"""
    u, v = x / s, y / s

    # 取っ手: 半円のリング
    hx, hy, r = 0.5, 0.42, 0.17
    d = ((u - hx) ** 2 + (v - hy) ** 2) ** 0.5
    if v < hy and 0.125 < d < r:
        return True

    # 本体: 上底が広い台形
    top, bottom = 0.42, 0.78
    if top <= v <= bottom:
        t = (v - top) / (bottom - top)
        half = 0.34 - 0.09 * t
        if abs(u - 0.5) <= half:
            # 縦のスリットを2本入れてカゴらしく
            for slit in (0.5 - 0.13 + 0.03 * t, 0.5 + 0.13 - 0.03 * t):
                if abs(u - slit) < 0.022 and top + 0.06 < v < bottom - 0.04:
                    return False
            return True
    return False


def render(size):
    radius = int(size * 0.22)
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter type 0
        for x in range(size):
            if not rounded_rect(x, y, size, radius):
                row += bytes((0, 0, 0, 0))
            elif basket(x, y, size):
                row += bytes(FG) + b"\xff"
            else:
                row += bytes(BG) + b"\xff"
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size):
    raw = render(size)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    print(f"{path.name}: {len(png):,} bytes")


if __name__ == "__main__":
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for s in (180, 192, 512):
        write_png(OUT_DIR / f"icon-{s}.png", s)
