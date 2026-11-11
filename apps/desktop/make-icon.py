#!/usr/bin/env python3
"""生成班底的**全部**图标：桌面（窗口/任务栏/exe/安装包）、Web（PWA/favicon）、
移动壳（tauri 资源 + Windows Store 资产）、安卓 mipmap。

**为什么要有这个脚本**：图标必须只有一个生成入口，不能靠谁手里那张图
（v1.0.0 时代吃过亏：图标是一次性做的，产品改名后没人改得动它）。

**这一版是什么（2026-11-10 第四次定稿，换代）**：「分玉」—— 整圆被一道竖直切口
分成两片，右片下沉错位。取《说文》「班，分瑞玉也，从珏从刀」：把一块玉分开、
人手各执其一，正是「派活」的汉字原型。圆 = 一件完整的活/一个完整班底；
缝 = 随时可插手的切口；错位 = 成员处在不同进度。详见 design/logo/bandi-brand.md。
（前一版「简笔画全身牛」已整代退场，几何在 git 历史里。）

**几何以 100 单位坐标系为准**（与 design/logo/bandi-icon-*.svg 完全一致，改形状两处一起改）：
    圆：r=40，圆心 (50,44)
    缝：弦在 x=50±gap，半缝 gap 全版 3 / 小版 6
    错位：右片沿 +y 偏移，全版 12 / 小版 16
    两片 = 圆被弦切开后的弓形（圆弧 + 直弦闭合的多边形）

**小尺寸不是缩放，是重绘**（<64px）：缝 3→6、错位 12→16、整体放大 1.07，
且去第二色只留米白（16px 下玉青与米白分不出，形状比配色重要）。

跑法：
    python apps/desktop/make-icon.py             # 生成全部目标
    python apps/desktop/make-icon.py --preview    # 额外出预览条（看小尺寸糊不糊）
    python apps/desktop/make-icon.py --only web   # 只出某一类：desktop|web|mobile|android
"""
import argparse
import io
import math
import os
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]          # 仓库根
DESKTOP_ICONS = ROOT / "apps/desktop/icons"
WEB_ICONS = ROOT / "apps/web/icons"
MOBILE_ICONS = ROOT / "apps/mobile-native/icons"
ANDROID_RES = ROOT / "apps/mobile-native/app/src/main/res"
BUILD_RS = ROOT / "apps/desktop/build.rs"

# 标准色（与 design/logo/bandi-brand.md 一致，改色两处一起改）
INK = "#12161A"          # 墨 · 主色
PAPER = "#F7F7F4"        # 浅底
BONE = "#F2F1ED"         # 深底上的亮片
JADE = "#2F7E74"         # 玉青 · 标准色（浅底用）
JADE_LIGHT = "#5FB3A3"   # 浅玉（深底用；深底上玉青会闷）

SS = 4                   # 超采样倍数

# ── 分玉几何（100 单位坐标系）────────────────────────────────────────────
R = 40.0
CX, CY = 50.0, 44.0
# 三档光学参数：缝太细会在抗锯齿里糊成实心圆，小尺寸必须重绘而不是缩放
GAP_FULL, OFF_FULL = 3.0, 12.0    # ≥128px：缝 6 宽 / 错位 12（100 单位）
GAP_OPT, OFF_OPT = 6.0, 16.0      # 33~127px：缝 12 / 错位 16
GAP_TINY, OFF_TINY = 9.0, 22.0    # ≤32px：缝 18 / 错位 22（16px 上仍有 ~2px 缝）
MARK_W = 86.0                     # 两片合起来的外接宽（= 2R + 缝两侧留量）
RATIO = 0.546                     # 图标内 mark 宽度占画布比（512 上约 280）
RATIO_GLYPH = 0.560               # 安卓自适应前景层（安全区 66/108，留够）

SCHEMES = {
    "dark": (BONE, JADE_LIGHT),
    "light": (INK, JADE),
    "mono": (BONE, BONE),
    "mono-ink": (INK, INK),
}


def _piece(gap: float, off: float, side: int, n: int = 300):
    """圆被竖直弦切下的一片（弓形），返回多边形顶点（含错位）。

    side=-1 取左片：弦在 x=CX-gap，φ 从 π-acos(gap/R) 递增到 π+acos(gap/R)，经过 π
    side=+1 取右片：弦在 x=CX+gap，φ 从 -acos(gap/R) 递增到 +acos(gap/R)，经过 0
    （弦端点必须满足 cos φ = ±gap/R —— 2026-11-10 修正：旧版左右弦位写反，
      两片在中缝重叠 gap*2，缝永远被盖死。）
    """
    a = math.acos(max(-1.0, min(1.0, gap / R)))
    p0, p1 = (math.pi - a, math.pi + a) if side < 0 else (-a, a)
    pts = []
    for i in range(n + 1):
        phi = p0 + (p1 - p0) * i / n
        pts.append((CX + R * math.cos(phi), CY + R * math.sin(phi) + off))
    return pts


def _glyph(img: Image.Image, canvas: int, *, tiny: bool = False,
           small: bool = False, style: str = "dark", ratio: float = RATIO) -> None:
    d = ImageDraw.Draw(img)
    k = canvas * ratio / MARK_W * (1.15 if tiny else 1.07 if small else 1.0)
    if tiny:
        gap, off = GAP_TINY, OFF_TINY
    elif small:
        gap, off = GAP_OPT, OFF_OPT
    else:
        gap, off = GAP_FULL, OFF_FULL
    # 错位让内容重心下移（约 off/2），整体回抬保证光学居中
    cy_mark = CY + off / 2.0 - 0.2
    ox = oy = canvas / 2.0

    def xf(p):
        return (ox + (p[0] - CX) * k, oy + (p[1] - cy_mark) * k)

    left, right = SCHEMES[style]
    d.polygon([xf(p) for p in _piece(gap, 0.0, -1)], fill=left)
    d.polygon([xf(p) for p in _piece(gap, off, +1)], fill=right)


def render(size: int, *, square: bool = False, bleed: bool = False,
           glyph_only: bool = False, theme: str = "dark") -> Image.Image:
    """出一张 size×size 图标。

    square     True=直角底（交给系统自己裁，如 iOS 主屏）；默认圆角方块（rx≈21.5%）
    bleed      True=圆形底（安卓 ic_launcher_round）
    glyph_only True=透明底只画图形（安卓自适应图标前景层，恒用小版+单色）
    theme      dark=墨底反白（默认，app 图标主用）/ light=浅底全色
    """
    tiny = size <= 32 or glyph_only
    small = tiny or size < 128
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    style = theme
    if glyph_only:
        style = "mono"
    # 2026-11-10 20:54：取消 ≤32px 强制单色——弦位修正后 16px 每片约 7px 宽，
    # 骨白/浅玉两色可辨，标题栏/任务栏小图标与主图标配色统一（用户要求）。

    if not glyph_only:
        bg = INK if theme == "dark" else PAPER
        if bleed:
            d.ellipse([0, 0, s - 1, s - 1], fill=bg)
        elif square:
            d.rectangle([0, 0, s - 1, s - 1], fill=bg)
        else:
            d.rounded_rectangle([0, 0, s - 1, s - 1], radius=round(s * 110 / 512), fill=bg)

    _glyph(img, s, tiny=tiny, small=small, style=style,
           ratio=RATIO_GLYPH if glyph_only else RATIO)
    return img.resize((size, size), Image.LANCZOS)


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"  png  {path.relative_to(ROOT)}  {img.width}x{img.height}")


def save_ico(path: Path, sizes=(16, 24, 32, 48, 64, 128, 256)) -> None:
    """手拼 ICO：每个尺寸**单独重绘**再打包（PNG-in-ICO）。

    交给 Pillow 从大图缩，16px 那张会是糊的 —— 小尺寸要走小版几何。
    """
    entries, datas, offset = b"", [], 6 + 16 * len(sizes)
    for n in sizes:
        buf = io.BytesIO()
        render(n).save(buf, "PNG")
        data = buf.getvalue()
        datas.append(data)
        entries += struct.pack("<BBBBHHII", n % 256, n % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<HHH", 0, 1, len(sizes)) + entries + b"".join(datas))
    print(f"  ico  {path.relative_to(ROOT)}  {list(sizes)}")


def save_icns(path: Path, sizes=((b"icp4", 16), (b"icp5", 32), (b"icp6", 64),
                                 (b"ic07", 128), (b"ic08", 256), (b"ic09", 512))) -> None:
    """自己拼 icns 容器：头 + 若干 (4字节类型, 4字节长度, PNG) —— Pillow 只会读不会写。"""
    body = b""
    for tag, n in sizes:
        buf = io.BytesIO()
        render(n).save(buf, "PNG")
        data = buf.getvalue()
        body += tag + struct.pack(">I", len(data) + 8) + data
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)
    print(f"  icns {path.relative_to(ROOT)}  {[n for _, n in sizes]}")


def do_desktop() -> None:
    print("[desktop]")
    save_png(render(512), DESKTOP_ICONS / "icon.png")
    save_ico(DESKTOP_ICONS / "icon.ico")


def do_web() -> None:
    print("[web]")
    save_png(render(512), WEB_ICONS / "icon-512.png")
    save_png(render(192), WEB_ICONS / "icon-192.png")
    save_png(render(180, square=True), WEB_ICONS / "icon-180.png")     # iOS 主屏自己裁圆角
    save_png(render(32), WEB_ICONS / "favicon-32.png")
    save_png(render(16), WEB_ICONS / "favicon-16.png")


def do_mobile() -> None:
    print("[mobile]")
    for n in (32, 64, 128):
        save_png(render(n), MOBILE_ICONS / f"{n}x{n}.png")
    save_png(render(256), MOBILE_ICONS / "128x128@2x.png")
    save_png(render(512), MOBILE_ICONS / "icon.png")
    save_ico(MOBILE_ICONS / "icon.ico")
    save_icns(MOBILE_ICONS / "icon.icns")
    # Windows Store 资产（bundler 用不到，但别留旧标在里面）
    for n in (30, 44, 71, 89, 107, 142, 150, 284, 310):
        save_png(render(n), MOBILE_ICONS / f"Square{n}x{n}Logo.png")
    save_png(render(50), MOBILE_ICONS / "StoreLogo.png")


def do_android() -> None:
    print("[android]")
    # 密度 → 启动图标边长（48dp 基准）；前景层画布 108dp = 2.25 倍
    for name, n in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96),
                    ("xxhdpi", 144), ("xxxhdpi", 192)):
        d = ANDROID_RES / f"mipmap-{name}"
        save_png(render(n), d / "ic_launcher.png")
        save_png(render(n, bleed=True), d / "ic_launcher_round.png")
        save_png(render(round(n * 2.25), glyph_only=True), d / "ic_launcher_foreground.png")


def preview() -> None:
    """把关键尺寸并排拼一张，肉眼检查小尺寸糊不糊；附深底实景一行。"""
    sizes = [256, 128, 64, 48, 32, 24, 16]
    pad, gap = 16, 16
    top = pad * 2 + max(sizes)
    w = pad * 2 + sum(sizes) + gap * (len(sizes) - 1)
    h = top + 90
    sheet = Image.new("RGBA", (w, h), (233, 230, 223, 255))
    x = pad
    for n in sizes:
        sheet.alpha_composite(render(n), (x, pad + (max(sizes) - n) // 2))
        x += n + gap
    darkbar = Image.new("RGBA", (w, 90), (24, 24, 24, 255))
    sheet.alpha_composite(darkbar, (0, top))
    x = pad
    for n in (16, 32, 48, 64):
        sheet.alpha_composite(render(n), (x, top + (90 - n) // 2))
        x += n + 28
    out = ROOT / "tmp/logo-test/icon-preview.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(out, "PNG")
    print(f"  preview {out.relative_to(ROOT)}  ({' / '.join(map(str, sizes))})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true", help="额外出预览条")
    ap.add_argument("--only", choices=["desktop", "web", "mobile", "android"])
    a = ap.parse_args()
    jobs = {"desktop": do_desktop, "web": do_web, "mobile": do_mobile, "android": do_android}
    for name, fn in jobs.items():
        if a.only and name != a.only:
            continue
        fn()
    if a.preview:
        print("[preview]")
        preview()
    # 顶一下 build.rs 的 mtime：它的 rerun-if-changed 不盯 icon.ico，
    # 只换图标文件 cargo 不会重跑 build 脚本，exe 里还是旧图标（2026-10-15 实测）
    if (not a.only or a.only in ("desktop", "mobile")) and BUILD_RS.exists():
        os.utime(BUILD_RS, None)
        print(f"  touch {BUILD_RS.relative_to(ROOT)}（强制 build 脚本重跑）")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
