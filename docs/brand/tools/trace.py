"""Trace the supplied Credit360 logo raster into layered SVG (one path per colour layer).
Usage: python trace.py <reference.png> <out_dir>
"""
import sys, os
import numpy as np
from PIL import Image
import potrace

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
SCALE = 4
img = Image.open(SRC).convert('RGB')

CHAR = '#1E1B1E'; GOLD = '#FDB205'; WHITE = '#FBF9F7'

def masks(box):
    c = img.crop(box)
    c = c.resize((c.width * SCALE, c.height * SCALE), Image.LANCZOS)
    a = np.asarray(c).astype(np.int32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    gold = (r - b > 110) & (r > 170) & (g > 90)
    dark = (lum < 120) & ~gold
    light = (lum > 170) & ~gold & (r - b < 40)
    return {'gold': gold, 'dark': dark, 'light': light}, c.size

def trace(mask, x_from=None, x_to=None):
    m = mask.copy()
    if x_from is not None: m[:, : x_from * SCALE] = False
    if x_to is not None: m[:, x_to * SCALE:] = False
    bm = potrace.Bitmap(~m)  # potracer traces False pixels as foreground
    plist = bm.trace(turdsize=40, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY, alphamax=1.1, opticurve=True, opttolerance=0.25)
    f = lambda p: f'{p.x / SCALE:.2f} {p.y / SCALE:.2f}'
    d = []
    for curve in plist:
        d.append(f'M{f(curve.start_point)}')
        for s in curve.segments:
            d.append(f'L{f(s.c)} L{f(s.end_point)}' if s.is_corner else f'C{f(s.c1)} {f(s.c2)} {f(s.end_point)}')
        d.append('Z')
    return ' '.join(d)

def svg(name, w, h, layers, title, bg=None, defs=''):
    body = ''.join(f'<path fill="{fill}" fill-rule="evenodd" d="{d}"/>' for fill, d in layers if d)
    rect = f'<rect width="{w}" height="{h}" rx="{bg[1]}" fill="{bg[0]}"/>' if bg else ''
    s = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img" aria-label="{title}">'
         f'<title>{title}</title>{defs}{rect}{body}</svg>')
    open(os.path.join(OUT, name), 'w').write(s)
    print(name, w, h, len(s))

GRAD = '<defs><linearGradient id="g360" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F6A50B"/><stop offset="1" stop-color="#EC9C05"/></linearGradient></defs>'

# Primary lockup: symbol + "Credit360" + "by AltBank"
box = (92, 192, 1360, 506); m, _ = masks(box); w, h = box[2] - box[0], box[3] - box[1]
sym_right = 478 - box[0]
svg('credit360-primary.svg', w, h, [(CHAR, trace(m['dark'])), (GOLD, trace(m['gold'], x_to=sym_right)), ('url(#g360)', trace(m['gold'], x_from=sym_right))], 'Credit360 by AltBank', defs=GRAD)
# Symbol only (from the primary lockup)
sbox = (92, 192, 469, 506); m, _ = masks(sbox)
svg('credit360-symbol.svg', sbox[2] - sbox[0], sbox[3] - sbox[1], [(CHAR, trace(m['dark'])), (GOLD, trace(m['gold']))], 'Credit360')
# Compact lockup
cbox = (639, 728, 1330, 891); m, _ = masks(cbox); cw = cbox[2] - cbox[0]
csym = 840 - cbox[0]
svg('credit360-compact.svg', cw, cbox[3] - cbox[1], [(CHAR, trace(m['dark'])), (GOLD, trace(m['gold'], x_to=csym)), ('url(#g360)', trace(m['gold'], x_from=csym))], 'Credit360 by AltBank', defs=GRAD)
# App icon: white C + gold orbit/star on a charcoal rounded square
ibox = (136, 698, 420, 982); m, _ = masks(ibox); iw = ibox[2] - ibox[0]
# keep only what lies inside the rounded square (the cream page outside its corners is not part of the icon)
yy, xx = np.mgrid[0:m['light'].shape[0], 0:m['light'].shape[1]]
M = 6 * SCALE  # inset on every side: the anti-aliased page edge is not part of the symbol
R = iw * 0.2 * SCALE - M; lo = M; hi = iw * SCALE - 1 - M
cx = np.clip(xx, lo + R, hi - R); cy = np.clip(yy, lo + R, hi - R)
inside = ((xx - cx) ** 2 + (yy - cy) ** 2 <= R ** 2) & (xx >= lo) & (xx <= hi) & (yy >= lo) & (yy <= hi)
m['light'] = m['light'] & inside
svg('credit360-app-icon.svg', iw, iw, [(WHITE, trace(m['light'])), (GOLD, trace(m['gold']))], 'Credit360', bg=('#211E21', round(iw * 0.2)))

# Dark-background variants: the charcoal C and wordmark become warm white (as in the app icon); gold unchanged.
for n in ['credit360-primary.svg', 'credit360-compact.svg', 'credit360-symbol.svg']:
    t = open(os.path.join(OUT, n)).read().replace(f'fill="{CHAR}"', f'fill="{WHITE}"')
    open(os.path.join(OUT, n.replace('.svg', '-on-dark.svg')), 'w').write(t)
    print(n.replace('.svg', '-on-dark.svg'))
