#!/usr/bin/env python3
"""生成桌面版图标：任务栏、窗口、exe、安装包都用这一份。

**为什么要有这个脚本**：图标必须只有一个生成入口，不能靠谁手里那张图
（v1.0.0 时代吃过亏：图标是一次性做的，产品改名后没人改得动它）。

**现在的标是什么（2026-10-20 定稿）**：「列队」—— 三根圆角柱站成一排、
中间那根领头，底下一道底座。意象就是「班底」两个字：*一班人 + 底*。
纯几何形状，**不再光栅化字体** —— 旧做法（把微软雅黑里的「班」画进位图）
除了小尺寸糊，还有授权悬案：字形的许可归字体管（见 git 历史里那版脚本的警告）。
几何标是我们自己画的，没有这个问题。

**为什么用 Python**：桌面构建链上 Pillow 是现成的；ICO 容器、多尺寸缩放
（LANCZOS）它都顺手。画的是圆角矩形，不需要字体、不需要浏览器。

跑法：
    python apps/desktop/make-icon.py            # 出「列队」标（默认）
    python apps/desktop/make-icon.py --preview  # 额外出 16/32/64 预览（看小尺寸糊不糊）
    python apps/desktop/make-icon.py --glyph 班 # 旧的字标（v1.0.1 及以前），留着备用

矢量母版在 `icons/icon.svg` —— 改形状先改 SVG、再把数值抄进下面的 MARK，
两处必须一致（脚本不解析 SVG，别让它们悄悄分叉）。
"""
import argparse
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ICONS = HERE / "icons"
PNG_OUT = ICONS / "icon.png"      # 512×512，窗口/关于页用
ICO_OUT = ICONS / "icon.ico"      # Windows：exe 嵌入、任务栏、安装包

SIZE = 512
RADIUS = 96                        # 圆角半径，沿用旧图标量出来的值

# ── 「列队」标的几何（2026-10-20 定稿，与 icons/icon.svg 一致）──────────────
# 每项：(x, y, w, h, 圆角半径, 不透明度 0-255)。坐标在 512 画布上。
# 中间那根更高、更实 = 领头的；左右两根半透明 = 班子成员；底下那道 = 「底」。
MARK = [
    (148, 238, 62, 122, 31, 209),   # 左柱（0.82）
    (225, 182, 62, 178, 31, 255),   # 中柱（领头）
    (302, 238, 62, 122, 31, 209),   # 右柱（0.82）
    (132, 372, 248, 22, 11, 128),   # 底座（0.5）
]

# 底色：应用内 logo 同一款品牌蓝（--logo-1 → --logo-2），上浅下深。
# 不用旧图标的深灰底（32,34,40）—— 那是「本」时代的配色，跟界面里认得的蓝对不上。
GRAD_TOP = (0x4B, 0x6C, 0xB7)
GRAD_BOTTOM = (0x2B, 0x4A, 0x8F)

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# ── 旧字标（--glyph）用的常量，原样保留 ─────────────────────────────────
BG = (32, 34, 40, 255)
FG = (110, 168, 254, 255)
TARGET_INK_H = 256
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",      # 微软雅黑
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",    # 黑体
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]


def pick_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    raise SystemExit(
        "找不到可用的中文字体。Windows 上应该有 C:\\Windows\\Fonts\\msyh.ttc；"
        "别的机器请把字体路径加进 FONT_CANDIDATES。"
    )


def render_glyph(ch, font):
    """把一个字画在透明层上，返回 (图层, 墨迹框) —— 便于按**墨迹**而不是按 em 框居中。"""
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text((SIZE // 2, SIZE // 2), ch, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return layer, layer.getchannel("A").getbbox()


def gradient_bg():
    """上浅下深的品牌蓝渐变，裁成圆角方块。

    为什么不做对角渐变：SVG 母版的渐变方向接近竖直（x2=0.55），竖直近似
    肉眼看不出差别，却省掉一整段旋转插值的代码 —— 不为用不上的精度买单。
    """
    g = Image.linear_gradient("L").resize((SIZE, SIZE))     # 0(顶) → 255(底)
    chan = []
    for t, b in zip(GRAD_TOP, GRAD_BOTTOM):
        lut = [round(t + (b - t) * i / 255) for i in range(256)]
        chan.append(g.point(lut))
    chan.append(Image.new("L", g.size, 255))
    full = Image.merge("RGBA", chan)

    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(full, (0, 0), mask)
    return out


def render_mark():
    """「列队」标：渐变底 + 三柱一底座。数值与 icons/icon.svg 一一对应（见 MARK）。"""
    out = gradient_bg()
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for x, y, w, h, r, a in MARK:
        d.rounded_rectangle([x, y, x + w - 1, y + h - 1], radius=r, fill=(255, 255, 255, a))
    out.alpha_composite(layer)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glyph", metavar="字", help="改出旧的字标（如 --glyph 班）。默认出「列队」几何标")
    ap.add_argument("--preview", action="store_true", help="额外出 16/32/64 预览，看小尺寸糊不糊")
    args = ap.parse_args()

    if args.glyph:
        # 旧字标：深灰底 + 蓝字，v1.0.1 及以前的样式（留着备用，别删 —— 改主意时还能回来）
        layer, box = render_glyph(args.glyph, pick_font(256))
        ink_h = box[3] - box[1] + 1
        # 字号：让墨迹高度对上目标 —— 换字之后视觉重量不变
        best = None
        for size in range(120, 340, 2):
            l, b = render_glyph(args.glyph, pick_font(size))
            if not b:
                continue
            diff = abs((b[3] - b[1] + 1) - TARGET_INK_H)
            if best is None or diff < best[0]:
                best = (diff, size, l, b)
        _, fsize, layer, box = best
        print(f"glyph mode font={fsize}px")
        out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        ImageDraw.Draw(out).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=BG)
        ink = Image.new("RGBA", layer.size, FG)
        ink.putalpha(layer.getchannel("A"))
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        out.alpha_composite(ink, (int(SIZE / 2 - cx), int(SIZE / 2 - cy)))
    else:
        out = render_mark()

    ICONS.mkdir(parents=True, exist_ok=True)
    out.save(PNG_OUT)
    # ICO 多尺寸一起出：Windows 会按 DPI/位置自己挑合适的那个
    out.save(ICO_OUT, sizes=[(s, s) for s in ICO_SIZES])
    print(f"OK {PNG_OUT.name}  {PNG_OUT.stat().st_size // 1024} KB")
    print(f"OK {ICO_OUT.name}  {ICO_OUT.stat().st_size // 1024} KB  sizes={ICO_SIZES}")

    # 把 build.rs 的 mtime 顶一下 —— 这一下是**必需的**，不是讲究。
    #
    # Windows 上 exe 的图标是 `build.rs`（`tauri_build::build()`）那次跑的时候
    # 生成 `resource.rc` 并嵌进去的。而它的 `rerun-if-changed` **不盯 icon.ico**：
    # 只换图标、不动 `build.rs` 与 `tauri.conf.json`，cargo 就认为 build 脚本没变、
    # 不重跑，于是 exe 里**还是旧图标**（2026-10-15 实测：图标文件 23:49 换的，
    # `.rc` 还是 23:42 那份，把嵌入图标抽出来一看仍是「本」）。
    #
    # `build.rs` 自身永远算 build 脚本的输入，碰它一定触发重跑。
    build_rs = HERE / "build.rs"
    if build_rs.exists():
        os.utime(build_rs, None)
        print("touched build.rs (forces the icon to be re-embedded)")

    if args.preview:
        for s in (16, 32, 64):
            p = HERE / f"icon-preview-{s}.png"
            out.resize((s, s), Image.LANCZOS).save(p)
            print(f"   preview {s}px -> {p.name}")
    print("next: cd apps/desktop && npx --yes @tauri-apps/cli@2 build")


if __name__ == "__main__":
    sys.exit(main())
