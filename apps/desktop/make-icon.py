#!/usr/bin/env python3
"""生成桌面版图标：任务栏、窗口、exe、安装包都用这一份。

**为什么要一个脚本**：图标以前是 `v1.0.0` 时代一次性做出来的（写死的「本软件」的「本」），
产品改叫「班底」之后，任务栏上那个字就对不上了。换成同一个字的图，
是"改一下字"这种事 —— 得有唯一入口，不能靠谁手里那张图。

**为什么用 Python**：把一个汉字画进位图需要**字体光栅化**（Pillow）。
Node 那边手写 PNG/ICO 容易，但把字形轮廓栅格化不是几百行的事。
Pillow 是平台自带的（见 `load_workspace_dependencies`），所以这是最省依赖的一条路。

跑法：
    python apps/desktop/make-icon.py            # 出「班」
    python apps/desktop/make-icon.py --glyph 本  # 换字
    python apps/desktop/make-icon.py --preview   # 额外出一张 32px 预览（看小尺寸糊不糊）

风格是**从旧图标里量出来的**（底色、字色、字形大小），换字之后看着还是同一套东西。

**⚠️ 字体授权**：这里光栅化的是系统字体（微软雅黑 / PingFang / Noto）里的字形。
把某个字形做成产品 logo 归字体的许可管，**换字或换字体之后请自行确认授权**。
仓库里入库的是生成结果 `icons/`；这个脚本只是"唯一的生成入口"。
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
RADIUS = 96                        # 圆角半径（跟旧图标一致）
# 风格值：**冻在这里**，量自 v1.0.0 那个图标。
#
# 为什么不每次去"读当前图标"来推：那样基准就是自己的上一次输出，
# 每跑一次会漂一两像素，脚本不幂等（第一版真这么写的，跑第二遍墨迹就从 253 掉到 251）。
# 想看这些数从哪来，用 `--sample <某张旧图标.png>` 现量一次。
BG = (32, 34, 40, 255)
FG = (110, 168, 254, 255)
TARGET_INK_H = 256                 # 旧图标里那个字的墨迹高度（512 画布上）
# 旧图标不在时用上面这几个兜底
BG_FALLBACK = BG
FG_FALLBACK = FG

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
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


def sample_old(path):
    """从一张**指定的**图标里量出底色、字色，以及那个字的墨迹高度。

    只在 `--sample` 时用：它回答"上面那几个常量是怎么来的"，不参与日常生成
    （否则基准就是自己的上一次输出，跑几次就漂几次）。
    """
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    px = im.load()

    bg = px[w // 2, 12]                      # 顶部中间：一定是底色
    counts = {}
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            c = px[x, y]
            if abs(c[0] - bg[0]) + abs(c[1] - bg[1]) + abs(c[2] - bg[2]) < 60:
                continue
            counts[c] = counts.get(c, 0) + 1
    fg = max(counts, key=counts.get) if counts else FG

    box = None
    for y in range(h):
        for x in range(w):
            c = px[x, y]
            if abs(c[0] - fg[0]) + abs(c[1] - fg[1]) + abs(c[2] - fg[2]) < 90:
                box = (x, y, x, y) if box is None else (min(box[0], x), min(box[1], y), max(box[2], x), max(box[3], y))
    ink_h = (box[3] - box[1] + 1) if box else None
    return bg, fg, ink_h


def render_glyph(ch, font):
    """把一个字画在透明层上，返回 (图层, 墨迹框) —— 便于按**墨迹**而不是按 em 框居中。"""
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text((SIZE // 2, SIZE // 2), ch, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return layer, layer.getchannel("A").getbbox()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--glyph", default="班", help="图标上那个字（默认「班」）")
    ap.add_argument("--preview", action="store_true", help="额外出 16/32/64 预览，看小尺寸糊不糊")
    ap.add_argument("--sample", help="从这张旧图标现量风格值（只为了让上面的常量可追溯，不参与生成）")
    args = ap.parse_args()

    if args.sample:
        bg, fg, ink = sample_old(args.sample)
        print(f"sampled bg={bg[:3]} fg={fg[:3]} ink_h={ink}px  <- 抄进上面的常量")
        return 0

    bg, fg, target = BG, FG, TARGET_INK_H
    print(f"style bg={bg[:3]} fg={fg[:3]} target_ink_h={target}px")

    # 字号：让新字的墨迹高度对上目标 —— 换字之后视觉重量不变
    best = None
    for size in range(120, 340, 2):
        layer, box = render_glyph(args.glyph, pick_font(size))
        if not box:
            continue
        ink_h = box[3] - box[1] + 1
        diff = abs(ink_h - target)
        if best is None or diff < best[0]:
            best = (diff, size, ink_h, box, layer)
    if best is None:
        raise SystemExit(f"渲染不出「{args.glyph}」这个字（字体里没有？）")
    _, fsize, ink_h, box, layer = best
    print(f"font={fsize}px -> ink_h={ink_h}px (target {target}px)")

    # 底：圆角方块（满幅）
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(out).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=bg)

    # 字：按**墨迹中心**贴到画布中心，而不是按 em 框 —— 否则不同字会看着偏
    ink = Image.new("RGBA", layer.size, fg)
    ink.putalpha(layer.getchannel("A"))
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    out.alpha_composite(ink, (int(SIZE / 2 - cx), int(SIZE / 2 - cy)))

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
