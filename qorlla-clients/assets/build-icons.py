"""Builds every app icon from assets/qorlla-logo-source.png (the supplied Qorlla logo: a blue rounded tile on white, no transparency).
   python assets/build-icons.py     (needs Pillow + numpy)
Outputs:
  apps/desktop/build/icon.ico   Windows: 16-256 px, transparent corners (electron-builder picks build/icon.ico up)
  apps/desktop/build/icon.png   512 px, transparent corners (window/taskbar icon, Linux, mac source)
  apps/mobile/assets/icon.png            iOS + Android legacy: 1024 px, full-bleed, NO alpha (iOS applies its own rounded mask)
  apps/mobile/assets/adaptive-foreground.png   Android adaptive icon: the tile inside the 66% safe zone on a transparent canvas
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
root = Path(__file__).resolve().parent.parent
src = Image.open(root / 'assets' / 'qorlla-logo-source.png').convert('RGB')

# 1. cut the tile out of the white background: flood the white from the four corners, then soften the edge
w, h = src.size; work = src.copy()
for xy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
    ImageDraw.floodfill(work, xy, (255, 0, 255), thresh=28)
bg = (np.asarray(work) == [255, 0, 255]).all(axis=2)
alpha = Image.fromarray(np.where(bg, 0, 255).astype('uint8')).filter(ImageFilter.GaussianBlur(1.2))
tile = src.convert('RGBA'); tile.putalpha(alpha.point(lambda v: 0 if v < 40 else (255 if v > 215 else v)))
tile = tile.crop(tile.getchannel('A').point(lambda v: 255 if v > 128 else 0).getbbox())
side = max(tile.size); sq = Image.new('RGBA', (side, side), (0, 0, 0, 0)); sq.paste(tile, ((side - tile.width) // 2, (side - tile.height) // 2), tile)

def fit(img, size): return img.resize((size, size), Image.LANCZOS)

# 2. Windows / desktop
(d := root / 'apps' / 'desktop' / 'build').mkdir(parents=True, exist_ok=True)
fit(sq, 256).save(d / 'icon.ico', sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)]); fit(sq, 512).save(d / 'icon.png')

# 3. iOS / Android legacy: full-bleed, opaque. The tile's own rounded corners are filled with the tile's edge blue so no white shows once the OS applies its mask.
edge = tuple(int(c) for c in np.asarray(sq.convert('RGB'))[side // 2, int(side * 0.03)])
# zoom in so the tile's rim runs to the canvas edge (the OS applies its own rounded mask, which hides what is left of the corners) and the pale glow under the tile is cropped away
z0, z1 = int(side * 0.06), int(side * 0.905); full = Image.new('RGB', (1024, 1024), edge); big = sq.crop((z0 + int(side * 0.0), z0, z1 + int(side * 0.0), z1)).resize((1024, 1024), Image.LANCZOS); full.paste(big, (0, 0), big)
(m := root / 'apps' / 'mobile' / 'assets').mkdir(parents=True, exist_ok=True); full.save(m / 'icon.png')

# 4. Android adaptive: launchers mask to circle/squircle and only the central 66% is guaranteed visible
fg = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0)); inner = fit(sq, 640); fg.paste(inner, (192, 192), inner); fg.save(m / 'adaptive-foreground.png')
print('adaptive/background colour:', '#%02x%02x%02x' % edge)
