#!/usr/bin/env python
"""班底字标转曲（outline）生成器 —— 把「班底 / BANDI」从字体渲染变成矢量路径。

为什么要有转曲版：
  · 字库渲染依赖字体文件（思源黑体/雅黑/Noto Sans SC），换机、缺字、印厂拼版
    都可能被换成别的字形；转曲后字形是几何曲线，到哪都一样。
  · 商标注册、印刷、对外物料必须转曲（字体授权只覆盖"用字体排版"，不覆盖"字体文件分发"）。

用法：
    python design/logo/make-wordmark.py

输出（design/logo/）：
    bandi-wordmark-zh.svg        横排「班底」转曲（1em = 100 单位，紧贴墨迹边界）
    bandi-wordmark-stacked.svg   竖排组合：班底 + BANDI（与左栏 rail 顶部字标同构）

字形来源：Noto Sans SC（OFL 授权，可商用）Variable，实例化到 wght=700。
⚠️ 改字（换字体/字重/字距）必须重跑本脚本 —— 转曲后不能再"改字"。
"""
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.misc.transform import Transform
from pathlib import Path

FONT = "C:/Windows/Fonts/NotoSansSC-VF.ttf"
WEIGHT = 700          # 中文标准字字重（品牌规范：黑体重字重）
EM = 100.0            # 输出坐标系：1em = 100 单位
TRACK_ZH = -1.0       # 中文字距 -1%（品牌规范）
TRACK_EN = 0.16       # 西文字距 0.16em（品牌规范）
EN_RATIO = 0.30       # BANDI 字号 = 中文字号的 30%
OUT = Path(__file__).resolve().parent


def load_font():
    f = TTFont(FONT, fontNumber=0)
    inst = instantiateVariableFont(f, {"wght": WEIGHT}, inplace=False)
    return inst.getBestCmap(), inst.getGlyphSet(), inst["head"].unitsPerEm


def outline(text, *, em, track, fonts, dx=0.0, dy=0.0):
    """把一串字符画成路径（dx/dy 在绘制时直接烘焙进坐标，不做字符串后处理）。"""
    cmap, gs, upem = fonts
    k = em / upem
    x = 0.0
    paths, boxes = [], []
    for i, ch in enumerate(text):
        if ch == " ":
            x += em * 0.3 + track
            continue
        gn = cmap.get(ord(ch))
        if gn is None:
            raise SystemExit(f"字体里没有这个字：{ch!r}")
        glyph = gs[gn]
        t = Transform(k, 0, 0, -k, x + dx, dy)
        pen = SVGPathPen(gs)
        glyph.draw(TransformPen(pen, t))
        bpen = BoundsPen(gs)
        glyph.draw(TransformPen(bpen, t))
        paths.append(pen.getCommands())
        if bpen.bounds:
            boxes.append(bpen.bounds)
        x += glyph.width * k + (track if i < len(text) - 1 else 0)
    return paths, union(boxes), x


def union(boxes):
    if not boxes:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def svg(width, height, paths, label):
    body = "\n".join(f'    <path d="{d}"/>' for d in paths)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n(width)} {n(height)}" '
            f'role="img" aria-label="{label}">\n'
            f'  <!-- 班底字标 · 已转曲（Noto Sans SC wght={WEIGHT}，1em={n(EM)} 单位）。\n'
            f'       文字全部变成矢量路径：不再依赖字体文件，印刷/商标/跨设备字形一致。\n'
            f'       改字请改并重跑 design/logo/make-wordmark.py，不要手改路径。 -->\n'
            f'  <g fill="currentColor">\n{body}\n  </g>\n</svg>\n')


def n(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def main():
    fonts = load_font()

    # ── 1. 横排「班底」：先量后画，墨迹边界贴边 ──────────────────
    _, b, _ = outline("班底", em=EM, track=TRACK_ZH, fonts=fonts)
    zh_paths, _, _ = outline("班底", em=EM, track=TRACK_ZH, fonts=fonts, dx=-b[0], dy=-b[1])
    zw, zh_h = b[2] - b[0], b[3] - b[1]
    (OUT / "bandi-wordmark-zh.svg").write_text(
        svg(zw, zh_h, zh_paths, "班底"), encoding="utf-8")
    print(f"  svg  bandi-wordmark-zh.svg       {n(zw)}×{n(zh_h)}  （2 字，{len(zh_paths)} 条路径）")

    # ── 2. 竖排组合：班底 + BANDI ────────────────────────────────
    en_size = EM * EN_RATIO
    en_paths0, eb, _ = outline("BANDI", em=en_size, track=en_size * TRACK_EN, fonts=fonts)
    en_w = eb[2] - eb[0]
    gap = EM * 0.20
    total_w = max(zw, en_w)
    zh_x = (total_w - zw) / 2.0
    en_x = (total_w - en_w) / 2.0 - eb[0]
    en_y = zh_h + gap - eb[1]

    zh2, _, _ = outline("班底", em=EM, track=TRACK_ZH, fonts=fonts, dx=zh_x - b[0], dy=-b[1])
    en2, _, _ = outline("BANDI", em=en_size, track=en_size * TRACK_EN, fonts=fonts,
                        dx=en_x, dy=en_y)
    total_h = zh_h + gap + (eb[3] - eb[1])
    (OUT / "bandi-wordmark-stacked.svg").write_text(
        svg(total_w, total_h, zh2 + en2, "班底 BANDI"), encoding="utf-8")
    print(f"  svg  bandi-wordmark-stacked.svg  {n(total_w)}×{n(total_h)}  （班底 + BANDI，"
          f"{len(zh2) + len(en2)} 条路径）")
    print("done")


if __name__ == "__main__":
    main()
