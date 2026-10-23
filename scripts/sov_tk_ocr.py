# -*- coding: utf-8 -*-
"""苏军 坦克师 + 独立装甲 快速OCR v2（修复MA红色组 + 跳过不存在文件）"""
import os, json, collections
import numpy as np
import cv2
from rapidocr import RapidOCR

BASE = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库'
OUT = r'D:\OCS\smolensk\scripts\ocr_out\ocr_sov_tk.json'

SCAN_ROOTS = [
    os.path.join(BASE, r'苏联单位\坦克师'),
    os.path.join(BASE, r'苏联单位\独立装甲'),
]

engine = RapidOCR()
FIX = {'I': '1', 'l': '1', 'i': '1', '|': '1', 'S': '5', 's': '5', 'O': '0', 'o': '0',
       'B': '8', 'Z': '2', 'z': '2', 'g': '9', 'q': '9', 'D': '0'}


def sov_base(img):
    sub = img[38:62, 6:64, :].reshape(-1, 3).astype(int)
    sub = sub[(sub[:, 0] < 235) | (sub[:, 1] < 235) | (sub[:, 2] < 235)]
    if len(sub) < 50:
        return 'unknown'
    b, g, r = [int(v) for v in collections.Counter(map(tuple, sub)).most_common(1)[0][0]]
    if r > 155 and 100 < g < 180 and b < 135:
        return 'regular'
    return f'other'


def imread_u(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)


def ink_groups(img):
    b, g, r = img[:, :, 0].astype(int), img[:, :, 1].astype(int), img[:, :, 2].astype(int)
    v = np.maximum(np.maximum(b, g), r)
    sat = v - np.minimum(np.minimum(b, g), r)
    red = (r > 110) & (g < 95) & (b < 95) & (r - g > 40)
    white = (v > 235) & (sat < 60)
    dark = (v < 105) & ~red
    band = np.zeros(img.shape[:2], bool)
    band[36:, :] = True
    out = {}
    for nm, m0 in (('W', white), ('K', dark), ('R', red)):
        m = (m0 & band).astype(np.uint8)
        m[:, :5] = 0; m[:, 65:] = 0
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
        n, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
        gs = []
        for i in range(1, n):
            x, y, w, h, a = st[i]
            if a < 8 or h < 8 or h > 30 or w > 34:
                continue
            gs.append({'x0': int(x), 'x1': int(x + w), 'y0': int(y), 'y1': int(y + h),
                       'w': int(w), 'h': int(h), 'cx': float(cen[i][0]), 'tag': nm})
        out[nm] = sorted(gs, key=lambda d: d['cx'])
    return out


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
            res = engine(big)
            if res is None or not res.txts:
                continue
            for t, s in zip(res.txts, res.scores):
                t2 = ''.join(c for c in (FIX.get(ch, ch) for ch in t) if c.isdigit())
                if t2 and s > bs:
                    best, bs = t2, float(s)
    return best, bs


def merge(gs):
    return {'x0': min(g['x0'] for g in gs), 'x1': max(g['x1'] for g in gs),
            'y0': min(g['y0'] for g in gs), 'y1': max(g['y1'] for g in gs)}


# ========== 扫描 ==========
files = []
for root in SCAN_ROOTS:
    if not os.path.exists(root):
        continue
    for dp, dn, fn in os.walk(root):
        for f in sorted(x for x in fn if x.lower().endswith('.png')):
            p = os.path.join(dp, f)
            if os.path.exists(p):
                files.append((os.path.basename(os.path.dirname(dp)), p))

print(f'共 {len(files)} 张文件待处理')

records = []
for i, (folder, p) in enumerate(files):
    try:
        img = imread_u(p)
    except Exception as e:
        print(f'  跳过: {p} ({e})')
        continue
    
    base = sov_base(img)
    G = ink_groups(img)
    
    # 按色组分派：A=W白字, AR=K黑字(高<=16), MA=W白字+R红字
    ar_c = [g for g in G['K'] if g['h'] <= 16 and 26 <= g['cx'] <= 46]
    ar = min(ar_c, key=lambda g: abs(g['cx'] - 36)) if ar_c else None
    axe = ar['cx'] if ar else 40
    A = [g for g in G['W'] if g['cx'] < axe - 2] if ar else [g for g in G['W'] if g['cx'] < 34]
    MA = [g for g in (G['W'] + G['R']) if g['cx'] > axe + 2]
    
    fname = os.path.basename(p)
    rec = {'file': fname, 're_folder': folder,
           'face': 'back' if fname[:-4].endswith('B') else 'front', 'base': base, 'fields': {}}
    for nm, gs in (('A', A), ('AR', [ar] if ar else []), ('MA', MA)):
        bx = merge(gs) if gs else None
        v, s = ocr_box(img, bx) if bx else ('', 0.0)
        rec['fields'][nm] = {'box': bx, 'value': v or None, 'score': round(s, 3)}
    flags = [f'{k}空' for k in ('A', 'AR', 'MA') if not rec['fields'][k]['value']]
    if rec['fields']['AR']['value'] and len(rec['fields']['AR']['value']) != 1:
        flags.append('AR非单位数')
    rec['review'] = flags
    records.append(rec)
    
    if (i+1) % 15 == 0:
        print(f'  进度: {i+1}/{len(files)}')

json.dump({'count': len(records), 'source': '苏联坦克师+独立装甲', 'records': records},
          open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

ok = sum(1 for r in records if not r['review'])
print(f'\n完全合格 {ok}/{len(records)} = {100.0*ok/max(1,len(records)):.1f}%')
print('底色分布:', dict(collections.Counter(r['base'] for r in records)))
print('问题:', dict(collections.Counter(x for r in records for x in r['review'])))
print('\n前15条:')
for r in records[:15]:
    d = r['fields']
    print(f"  {r['file'][:-4]:<22} {r['base']:<8} A={str(d['A']['value']):<4} AR={str(d['AR']['value']):<3} MA={str(d['MA']['value']):<4} "
          f"{'|'+','.join(r['review']) if r['review'] else ''}")
