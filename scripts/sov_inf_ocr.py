# -*- coding: utf-8 -*-
"""苏军 步兵师 算子识别（专用，与轴心脚本不通用）
底色：普通卡其 / 内务部红底 —— 苏军专用判定；注意苏军算子带红色外框，须排除边框列
版式：左下=白字A(1-2位) / 中=黑小字AR(限高<=16) / 右下=白字MA(1-2位)
RE 不识别：直接取目录名（1RE/2RE/3RE/民兵），与军力是两件事
"""
import os, sys, json, collections
import numpy as np
import cv2
from rapidocr import RapidOCR

BASE = r'd:\OCS\OCS斯摩棱斯克素材\图片素材库'
ROOT = os.path.join(BASE, r'苏联单位\步兵师')
OUT = r'c:\Users\KD\.trae-cn\work\6aa23d4763216375af1c86de\ocr_sov_inf.json'
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 0
engine = RapidOCR()
FIX = {'I': '1', 'l': '1', 'i': '1', '|': '1', 'S': '5', 's': '5', 'O': '0', 'o': '0',
       'B': '8', 'Z': '2', 'z': '2', 'g': '9', 'q': '9', 'D': '0'}


def sov_base(img):
    """苏军专用：采样避开红色外框(x<4 / x>64)与中央兵牌"""
    sub = img[38:62, 6:64, :].reshape(-1, 3).astype(int)
    sub = sub[(sub[:, 0] < 235) | (sub[:, 1] < 235) | (sub[:, 2] < 235)]
    if len(sub) < 50:
        return 'unknown'
    b, g, r = [int(v) for v in collections.Counter(map(tuple, sub)).most_common(1)[0][0]]
    if r > 190 and g < 110 and b < 110:
        return 'nkvd'
    if r > 155 and 100 < g < 180 and b < 135:
        return 'regular'
    if r > 190 and g > 180 and 100 < b < 190:
        return 'air'
    return f'other({r},{g},{b})'


def imread_u(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)


def ink_groups(img, base):
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
        m[:, :5] = 0; m[:, 65:] = 0     # 排除苏军红色外框
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
        n, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
        gs = []
        for i in range(1, n):
            x, y, w, h, a = st[i]
            if a < 10 or h < 9 or h > 30 or w > 34:
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
            'y0': min(g['y0'] for g in gs), 'y1': max(g['y1'] for g in gs), 'n': len(gs)}


files = []
for dp, dn, fn in os.walk(ROOT):
    for f in sorted(x for x in fn if x.lower().endswith('.png')):
        rel = os.path.relpath(dp, ROOT)
        re_tag = rel.split('\\')[0]
        files.append((re_tag, os.path.join(dp, f)))
if LIMIT:
    files = files[:LIMIT]
print('苏军步兵师本批:', len(files))

records = []
for re_tag, p in files:
    img = imread_u(p)
    base = sov_base(img)
    G = ink_groups(img, base)
    ar_c = [g for g in (G['W'] if base == 'nkvd' else G['K']) if g['h'] <= 16 and 26 <= g['cx'] <= 46]
    ar = min(ar_c, key=lambda g: abs(g['cx'] - 36)) if ar_c else None
    axe = ar['cx'] if ar else 40
    A = [g for g in G['W'] if g['cx'] < axe - 2] if ar else [g for g in G['W'] if g['cx'] < 34]
    MA = [g for g in (G['W'] + G['R']) if g['cx'] > axe + 2]
    rec = {'file': os.path.basename(p), 're_folder': re_tag,
           'face': 'back' if p[:-4].endswith('B') else 'front', 'base': base, 'fields': {}}
    for nm, gs in (('A', A), ('AR', [ar] if ar else []), ('MA', MA)):
        bx = merge(gs) if gs else None
        v, s = ocr_box(img, bx) if bx else ('', 0.0)
        rec['fields'][nm] = {'box': bx, 'value': v or None, 'score': round(s, 3)}
    flags = [f'{k}空' for k in ('A', 'AR', 'MA') if not rec['fields'][k]['value']]
    if rec['fields']['AR']['value'] and len(rec['fields']['AR']['value']) != 1:
        flags.append('AR非单位数')
    rec['review'] = flags
    records.append(rec)

json.dump({'count': len(records), 'source': '苏联单位\\步兵师', 'records': records},
          open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
ok = sum(1 for r in records if not r['review'])
print(f'完全合格 {ok}/{len(records)} = {100.0*ok/max(1,len(records)):.1f}%')
c = collections.Counter()
for r in records:
    for x in r['review']:
        c[x] += 1
print('问题:', dict(c))
print('底色:', dict(collections.Counter(r['base'] for r in records)))
print('RE 目录分布:', dict(collections.Counter(r['re_folder'] for r in records)))
print('A 值分布:', dict(collections.Counter(r['fields']['A']['value'] for r in records).most_common(12)))
print('AR 值分布:', dict(collections.Counter(r['fields']['AR']['value'] for r in records).most_common(8)))
print('MA 值分布:', dict(collections.Counter(r['fields']['MA']['value'] for r in records).most_common(12)))
for r in records[:20]:
    d = r['fields']
    print(f"  {r['re_folder']}/{r['file'][:-4]:<20} {r['base']:<9} A={str(d['A']['value']):<4} "
          f"AR={str(d['AR']['value']):<3} MA={str(d['MA']['value']):<4} {'|'+','.join(r['review']) if r['review'] else ''}")
