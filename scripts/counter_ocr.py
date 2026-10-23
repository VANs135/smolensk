# -*- coding: utf-8 -*-
"""轴心算子 OCR 管线 v4（自建）
关键修正：字段按「字色」分派 —— 白字=A、黑字=AR、红字(黄框内)=MA，不再靠字号/位置猜。
先用目录名自带真值的批次验证（独立炮兵 18-1-3 / 26-3-2 / 30-1-3、机械化反坦克 2-3-8 / 2-4-8 / 3-3-6 / 3-5-10）。
"""
import os, sys, json, collections
import numpy as np
import cv2
from rapidocr import RapidOCR

BASE = r'd:\OCS\OCS斯摩棱斯克素材\图片素材库'
engine = RapidOCR()
FIX = {'I': '1', 'l': '1', 'i': '1', '|': '1', 'S': '5', 's': '5', 'O': '0', 'o': '0',
       'B': '8', 'Z': '2', 'z': '2', 'g': '9', 'q': '9', 'D': '0'}


def imread_u(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)


def base_of(img):
    ring = np.concatenate([img[2:4, :, :].reshape(-1, 3), img[-4:-2, :, :].reshape(-1, 3)])
    t = tuple(int(v) for v in collections.Counter(map(tuple, ring.astype(int))).most_common(1)[0][0])
    b, g, r = t
    if r < 70 and g < 70 and b < 70:
        return 'ss'
    if r > 150 and g > 140 and b > 140:
        return 'heer'
    if r > 155 and 105 < g < 175 and b < 130:
        return 'sov_regular'
    return f'other({r},{g},{b})'


def field_boxes(img, base):
    """按字色找白/黑/红三组字形，返回各字段 bbox"""
    b, g, r = img[:, :, 0].astype(int), img[:, :, 1].astype(int), img[:, :, 2].astype(int)
    v = np.maximum(np.maximum(b, g), r)
    sat = v - np.minimum(np.minimum(b, g), r)
    red = (r > 110) & (g < 95) & (b < 95) & (r - g > 40)
    if base == 'ss':
        white = (v > 155) & (sat < 90)
    else:
        white = (v > 235) & (sat < 60)
    dark = (v < 105) & ~red
    band = np.zeros(img.shape[:2], bool)
    band[31:, :] = True
    group = {}
    comps = {}
    for nm, m0 in (('A', white), ('AR', dark), ('MA', red)):
        m = (m0 & band).astype(np.uint8)
        m[:, :2] = 0; m[:, -2:] = 0
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
        n, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
        gs = []
        for i in range(1, n):
            x, y, w, h, a = st[i]
            if a < 10 or h < 10 or h > 30 or w > 30:
                continue
            gs.append((int(x), int(y), int(w), int(h), float(cen[i][0])))
        comps[nm] = gs
    # A 字的黑描边会落进 AR(黑字) 组：剔除与 A 白芯 bbox 相交的黑连通域
    gsA = comps['A']
    if gsA:
        ax0 = min(t[0] for t in gsA) - 2; ax1 = max(t[0] + t[2] for t in gsA) + 2
        ay0 = min(t[1] for t in gsA) - 2; ay1 = max(t[1] + t[3] for t in gsA) + 2
        keep = []
        for t in comps['AR']:
            x, y, w, h, _ = t
            if x < ax1 and x + w > ax0 and y < ay1 and y + h > ay0:
                continue
            keep.append(t)
        comps['AR'] = keep
    for nm in ('A', 'AR', 'MA'):
        gs = comps[nm]
        if gs:
            group[nm] = {'x0': min(t[0] for t in gs), 'y0': min(t[1] for t in gs),
                         'x1': max(t[0] + t[2] for t in gs), 'y1': max(t[1] + t[3] for t in gs),
                         'n': len(gs)}
    return group


def ocr_box(img, box, pad=2):
    H, W = img.shape[:2]
    x0, x1 = max(0, box['x0'] - pad), min(W, box['x1'] + pad)
    y0, y1 = max(0, box['y0'] - pad), min(H, box['y1'] + pad)
    sub = img[y0:y1, x0:x1]
    if sub.size == 0:
        return '', 0.0
    gm = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
    _, bw = cv2.threshold(gm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    best, bs = '', 0.0
    for src in (255 - bw, bw):
        for sc in (12, 18):
            big = cv2.resize(src, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
            big = cv2.copyMakeBorder(big, 24, 24, 24, 24, cv2.BORDER_CONSTANT, value=255)
            out = engine(big)
            if out is None or not out.txts:
                continue
            for t, s in zip(out.txts, out.scores):
                t2 = ''.join(c for c in (FIX.get(ch, ch) for ch in t) if c.isdigit())
                if t2 and s > bs:
                    best, bs = t2, float(s)
    return best, bs


def run(img):
    base = base_of(img)
    gb = field_boxes(img, base)
    out = {'base': base}
    for nm in ('A', 'AR', 'MA'):
        bx = gb.get(nm)
        v, s = ocr_box(img, bx) if bx else ('', 0.0)
        out[nm] = {'box': bx, 'value': v or None, 'score': round(s, 3)}
    return out


# ---- 用目录名真值验证 ----
LABELED = [
    (r'轴心单位\独立炮兵\18-1-3', (18, 1, 3)),
    (r'轴心单位\独立炮兵\26-3-2', (26, 3, 2)),
    (r'轴心单位\独立炮兵\30-1-3', (30, 1, 3)),
    (r'轴心单位\独立装甲\可重建\机械化反坦克\2-3-8', (2, 3, 8)),
    (r'轴心单位\独立装甲\可重建\机械化反坦克\2-4-8', (2, 4, 8)),
    (r'轴心单位\独立装甲\可重建\机械化反坦克\3-3-6', (3, 3, 6)),
    (r'轴心单位\独立装甲\可重建\机械化反坦克\3-5-10', (3, 5, 10)),
]
hitA = hitAR = hitMA = tot = 0
for rel, (ga, gar, gma) in LABELED:
    root = os.path.join(BASE, rel)
    fs = sorted(f for f in os.listdir(root) if f.lower().endswith('.png'))
    ab = arb = mab = 0
    for f in fs:
        r = run(imread_u(os.path.join(root, f)))
        a = r['A']['value']; ar = r['AR']['value']; ma = r['MA']['value']
        if a == str(ga): ab += 1
        if ar == str(gar): arb += 1
        if ma == str(gma): mab += 1
    tot += len(fs); hitA += ab; hitAR += arb; hitMA += mab
    print(f'{rel.split(chr(92))[-1]:<8} 真值 {ga}-{gar}-{gma}   {len(fs)} 张  A {ab}/{len(fs)}  AR {arb}/{len(fs)}  MA {mab}/{len(fs)}')
print(f'\n合计 {tot} 张：A {hitA} ({100*hitA/tot:.0f}%)  AR {hitAR} ({100*hitAR/tot:.0f}%)  MA {hitMA} ({100*hitMA/tot:.0f}%)')
