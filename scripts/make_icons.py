#!/usr/bin/env python3
"""生成 PWA 图标（Pillow）。"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT, exist_ok=True)

FONTS = [
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf",
    "/System/Library/Fonts/Supplemental/Charter.ttc",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]

C1 = (79, 110, 247)     # indigo
C2 = (124, 58, 237)     # violet
C3 = (32, 201, 151)     # teal accent


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def grad(size):
    """对角线渐变背景"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x / size * 0.45 + y / size * 0.55)
            px[x, y] = lerp(C1, C2, t)
    return img


def rounded_mask(size, radius_ratio=0.225):
    m = Image.new("L", (size * 4, size * 4), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=int(size * 4 * radius_ratio), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def find_font(px):
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, px)
            except Exception:
                continue
    return ImageFont.load_default()


def draw_glyph(img, size, inset_ratio):
    """在中间画 'A' + 小圆点"""
    d = ImageDraw.Draw(img)
    box = size * (1 - inset_ratio * 2)
    font = find_font(int(box * 1.02))

    text = "A"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1] - size * 0.035
    d.text((x, y), text, font=font, fill=(255, 255, 255, 255))

    # 右上角小圆点，像「已收录」的标记
    r = size * 0.055
    cx = size * 0.755
    cy = size * 0.245
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=C3 + (255,))

    # 底部一条细下划线
    lw = tw * 0.92
    ly = y + bbox[1] + th + size * 0.055
    d.rounded_rectangle([(size - lw) / 2, ly, (size + lw) / 2, ly + size * 0.028],
                        radius=size * 0.014, fill=(255, 255, 255, 210))
    return img


def make(size, rounded=True, inset=0.20):
    base = grad(size).convert("RGBA")
    draw_glyph(base, size, inset)
    if rounded:
        base.putalpha(rounded_mask(size))
    return base


def save(img, name):
    p = os.path.join(OUT, name)
    img.save(p, "PNG", optimize=True)
    print("  ", name, img.size, f"{os.path.getsize(p)/1024:.1f} KB")


print("生成图标 →", OUT)
save(make(192), "icon-192.png")
save(make(512), "icon-512.png")
save(make(1024), "icon-1024.png")
save(make(512, rounded=False, inset=0.28), "icon-maskable-512.png")
save(make(180), "apple-touch-icon.png")            # iOS 自己会加圆角
save(Image.open(os.path.join(OUT, "apple-touch-icon.png")).resize((32, 32), Image.LANCZOS),
     "favicon-32.png")

# 供 iOS 启动画面用的纯色底（可选）
print("完成")
