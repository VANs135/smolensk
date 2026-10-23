# -*- coding: utf-8 -*-
"""轴心国 地面单位 OCR 识别 —— 标准版式通用脚本
覆盖目录：步兵师、独立单位、独立装甲、编队单位、运输队（排除HQ/炮兵/空军/标记）
版式：左下=白字A(1-2位) / 中=黑小字AR(限高<=16px) / 右下=白字或红字黄框MA(1-2位)
底色：轴心专用判定（heer/ss/lw/hun/rum）
"""
import os, sys, json, collections, glob
import numpy as np
import cv2
from rapidocr import RapidOCR

BASE = r'd:\OCS\OCS斯摩棱斯克素材\图片素材库'
OUT_DIR = r'd:\OCS\smolensk\scripts\ocr_out'
os.makedirs(OUT_DIR, exist_ok=True)

# 扫描的根目录列表（地面标准版式）
GROUND_ROOTS = [
    '轴心单位\\步兵师',
    '轴心单位\\独立单位',
    '轴心单位\\独立装甲',
    '轴心单位\\编队单位',
    '轴心单位\\编队标记',
    '轴心单位\\运输队',
]

# 排除的子目录关键词
SKIP_KEYWORDS = ['空军', '标记', 'HQ', '炮兵', '补员']
FORCE_INCLUDE = ['编队标记']  # 即使含SKIP_KEYWORDS也强制包含

engine = RapidOCR()
FIX = {'I': '1', 'l': '1', 'i': '1', '|': '1', 'S': '5', 's': '5', 'O': '0', 'o': '0',
       'B': '8', 'Z': '2', 'z': '2', 'g': '9', 'q': '9', 'D': '0'}


def imread_u(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)


def axis_base(img):
    """轴心专用底色判定（顺序：先暗→再彩→最后灰）"""
    sub = img[40:62, 4:66, :].reshape(-1, 3).astype(int)
    sub = sub[(sub[:, 0] < 240) | (sub[:, 1] < 240) | (sub[:, 2] < 240)]
    if len(sub) < 50:
        return 'unknown'
    b, g, r = [int(v) for v in collections.Counter(map(tuple, sub)).most_common(1)[0][0]]
    if r < 60 and g < 60 and b < 60:
        return 'ss'
    if b > 200 and g > 190 and r < 200:
        return 'lw'
    if r < 140 and b > 150:
        return 'hun'
    if b < 70 and g > 120:
        return 'rum'
    if r > 150 and g > 150:
        return 'heer'
    return f'other({r},{g},{b})'


def ink_groups(img, base):
    """按字色分组连通域"""
    b, g, r = img[:, :, 0].astype(int), img[:, :, 1].astype(int), img[:, :, 2].astype(int)
    v = np.maximum(np.maximum(b, g), r)
    sat = v - np.minimum(np.minimum(b, g), r)
    red = (r > 110) & (g < 95) & (b < 95) & (r - g > 40)
    if base == 'ss':
        white = (v > 150) & (sat < 90)
    else:
        white = (v > 235) & (sat < 60)
    dark = (v < 105) & ~red
    band = np.zeros(img.shape[:2], bool)
    band[36:, :] = True
    out = {}
    for nm, m0 in (('W', white), ('K', dark), ('R', red)):
        m = (m0 & band).astype(np.uint8)
        m[:, :2] = 0; m[:, -2:] = 0
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
    if not gs:
        return None
    return {'x0': min(g['x0'] for g in gs), 'x1': max(g['x1'] for g in gs),
            'y0': min(g['y0'] for g in gs), 'y1': max(g['y1'] for g in gs), 'n': len(gs)}


def should_skip(rel_path):
    """检查是否应跳过该目录"""
    for kw in SKIP_KEYWORDS:
        if kw in rel_path:
            for fi in FORCE_INCLUDE:
                if fi in rel_path:
                    return False  # 强制包含
            return True
    return False


def collect_files():
    """收集所有标准版式图片"""
    all_files = []
    for root in GROUND_ROOTS:
        full_root = os.path.join(BASE, root)
        for dp, dn, fn in os.walk(full_root):
            if should_skip(os.path.relpath(dp, BASE)):
                continue
            for f in sorted(x for x in fn if x.lower().endswith('.png')):
                all_files.append((root, dp, f))
    return all_files


def process_image(root_label, dir_path, filename):
    """处理单张图片"""
    full_path = os.path.join(dir_path, filename)
    img = imread_u(full_path)
    if img is None or img.shape[:2] != (70, 70):
        return None
    
    base = axis_base(img)
    G = ink_groups(img, base)
    
    # AR: 黑小字（限高<=16px，位置中部）
    ar_pool = G['K'] if base != 'ss' else G['W']
    ar_candidates = [g for g in ar_pool if g['h'] <= 16 and 26 <= g['cx'] <= 46]
    ar = min(ar_candidates, key=lambda g: abs(g['cx'] - 36)) if ar_candidates else None
    axe = ar['cx'] if ar else 40
    
    # A: 白字，在AR左侧
    A_pool = G['W']
    A = [g for g in A_pool if g['cx'] < axe - 2] if ar else [g for g in A_pool if g['cx'] < 34]
    
    # MA: 白字或红字，在AR右侧
    MA_pool = G['W'] + G['R']
    MA = [g for g in MA_pool if g['cx'] > axe + 2]
    
    rec = {
        'file': filename,
        'face': 'back' if filename[:-4].endswith('B') else 'front',
        'base': base,
        'fields': {},
        'source': os.path.relpath(dir_path, BASE),
    }
    
    # OCR各字段
    for nm, gs in (('A', A), ('AR', [ar] if ar else []), ('MA', MA)):
        bx = merge(gs) if gs else None
        v, s = ocr_box(img, bx) if bx else ('', 0.0)
        rec['fields'][nm] = {
            'box': bx,
            'value': v or None,
            'score': round(s, 3),
        }
    
    # MA颜色判定
    if G['R']:
        rec['ma_color'] = 'red'
    elif base == 'ss':
        rec['ma_color'] = 'white'
    else:
        rec['ma_color'] = 'white'
    
    # 生成review标记
    flags = []
    for k in ('A', 'AR', 'MA'):
        if not rec['fields'][k]['value']:
            flags.append(f'{k}空')
    if rec['fields']['AR']['value'] and len(rec['fields']['AR']['value']) != 1:
        flags.append('AR非单位数')
    if base not in ('heer', 'ss', 'lw'):
        flags.append(f'底色异常({base})')
    rec['review'] = flags
    
    return rec


def main():
    files = collect_files()
    print(f'轴心地面标准版式: 共 {len(files)} 张图')
    
    records = []
    batch_info = collections.Counter()
    
    for i, (root, dp, f) in enumerate(files):
        if i % 50 == 0 and i > 0:
            print(f'  进度: {i}/{len(files)} ({100*i/len(files):.0f}%)')
        rec = process_image(root, dp, f)
        if rec:
            records.append(rec)
            batch_info[rec['source'].split('\\')[0]] += 1
    
    # 输出统计
    ok = sum(1 for r in records if not r['review'])
    print(f'\n完成: {len(records)} 张, 完全合格 {ok}/{len(records)} = {100.0*ok/max(1,len(records)):.1f}%')
    
    c = collections.Counter()
    for r in records:
        for x in r['review']:
            c[x] += 1
    print(f'问题统计: {dict(c)}')
    print(f'底色分布: {dict(collections.Counter(r["base"] for r in records))}')
    print(f'来源分布: {dict(batch_info)}')
    
    # 保存JSON
    out_file = os.path.join(OUT_DIR, 'axis_ground_ocr.json')
    json.dump({
        'count': len(records),
        'engine': 'rapidocr',
        'timestamp': '2026-09-11',
        'records': records,
    }, open(out_file, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'\n输出: {out_file}')


if __name__ == '__main__':
    main()
