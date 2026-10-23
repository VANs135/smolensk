# -*- coding: utf-8 -*-
"""苏联HQ算子OCR

版式规范（技能）：
- 不印A值
- 底部左 = 投递距离 (delivery)
- 底部右 = MA
- 苏联HQ底色: 橙色(近卫)，数字是**黑字**（无白字！）

像素分析：底色RGB≈(147,109,52)橙色，暗字连通域明显
"""
import os, json, collections
import numpy as np
import cv2
from rapidocr import RapidOCR

BASE = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库'
ROOT = os.path.join(BASE, r'苏联单位\HQ')
OUT = r'D:\OCS\smolensk\scripts\ocr_out\ocr_sov_hq.json'

engine = RapidOCR()
FIX = {'I': '1', 'l': '1', 'i': '1', '|': '1', 'S': '5', 's': '5', 'O': '0', 'o': '0',
       'B': '8', 'Z': '2', 'z': '2', 'g': '9', 'q': '9', 'D': '0'}


def imread_u(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)


def hq_dark_groups(img):
    """提取暗字连通域（黑字在橙色底上）"""
    b, g, r = img[:, :, 0].astype(int), img[:, :, 1].astype(int), img[:, :, 2].astype(int)
    v = np.maximum(np.maximum(b, g), r)
    sat = v - np.minimum(np.minimum(b, g), r)
    
    # 暗字: 亮度低
    dark = v < 95  # 更严格的阈值
    
    # 只看底部区域（y=36-66）
    band = np.zeros(img.shape[:2], bool)
    band[36:, 6:64] = True
    
    m = (dark & band).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
    
    n, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
    gs = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if a < 8 or h < 8 or h > 28 or w > 28:
            continue
        gs.append({'x0': int(x), 'x1': int(x + w), 'y0': int(y), 'y1': int(y + h),
                   'w': int(w), 'h': int(h), 'cx': float(cen[i][0]), 'cy': float(cen[i][1])})
    
    # 按x排序
    gs.sort(key=lambda d: d['cx'])
    return gs


def merge_adjacent(gs, gap=3):
    """合并相邻的连通域（2位数会被拆成两个域）"""
    if not gs:
        return []
    merged = [gs[0]]
    for g in gs[1:]:
        last = merged[-1]
        if g['cx'] - last['x1'] <= gap and abs(g['cy'] - last['cy']) < 8:
            # 合并
            merged[-1] = {
                'x0': min(last['x0'], g['x0']),
                'x1': max(last['x1'], g['x1']),
                'y0': min(last['y0'], g['y0']),
                'y1': max(last['y1'], g['y1']),
                'w': max(last['x1'], g['x1']) - min(last['x0'], g['x0']),
                'h': max(last['y1'], g['y1']) - min(last['y0'], g['y0']),
                'cx': (last['cx'] + g['cx']) / 2,
                'cy': (last['cy'] + g['cy']) / 2,
            }
        else:
            merged.append(g)
    return merged


def ocr_dark(img, box, pad=3):
    """OCR暗字 - 需要反相成白字黑底"""
    H, W = img.shape[:2]
    x0, x1 = max(0, box['x0'] - pad), min(W, box['x1'] + pad)
    y0, y1 = max(0, box['y0'] - pad), min(H, box['y1'] + pad)
    sub = img[y0:y1, x0:x1]
    if sub.size == 0:
        return '', 0.0
    
    # 转灰度，反相让暗字变白
    gm = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
    gm_inv = 255 - gm
    
    # 二值化
    _, bw = cv2.threshold(gm_inv, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    
    best, bs = '', 0.0
    for sc in (14, 20):
        big = cv2.resize(bw, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
        big = cv2.copyMakeBorder(big, 24, 24, 24, 24, cv2.BORDER_CONSTANT, value=255)
        res = engine(big)
        if res is None or not res.txts:
            continue
        for t, s in zip(res.txts, res.scores):
            t2 = ''.join(c for c in (FIX.get(ch, ch) for ch in t) if c.isdigit())
            if t2 and s > bs:
                best, bs = t2, float(s)
    return best, bs


# ========== 扫描 ==========
files = []
for f in sorted(os.listdir(ROOT)):
    if f.endswith('.png'):
        files.append(os.path.join(ROOT, f))

print(f'苏联HQ: {len(files)}张')


def merge_boxes(gs):
    return {
        'x0': min(g['x0'] for g in gs),
        'x1': max(g['x1'] for g in gs),
        'y0': min(g['y0'] for g in gs),
        'y1': max(g['y1'] for g in gs),
    }


records = []
for p in files:
    fname = os.path.basename(p)
    face = 'back' if fname[:-4].endswith('B') else 'front'
    img = imread_u(p)
    
    gs = hq_dark_groups(img)
    gs = merge_adjacent(gs, gap=4)  # 更宽松的合并
    
    # 按x位置分左（delivery）和右（MA）
    # HQ版式: 左=delivery(较大数), 右=MA
    # 按cx<38 vs cx>=38 分
    left = [g for g in gs if g['cx'] < 38]
    right = [g for g in gs if g['cx'] >= 38]
    
    # 如果分不到，按数量分
    if not left and not right and len(gs) >= 2:
        mid = len(gs) // 2
        left, right = gs[:mid], gs[mid:]
    elif not left and len(gs) >= 1:
        # 只有一个，取最大的
        gs.sort(key=lambda g: g['h'], reverse=True)
        left = [gs[0]]
    
    # OCR
    delivery_val, delivery_score = '', 0.0
    ma_val, ma_score = '', 0.0
    
    if left:
        # 合并所有左侧域
        bx = merge_boxes(left)
        delivery_val, delivery_score = ocr_dark(img, bx)
    if right:
        bx = merge_boxes(right)
        ma_val, ma_score = ocr_dark(img, bx)
    
    rec = {
        'file': fname, 'face': face, 'base': 'guards_orange',
        'fields': {
            'delivery': {'value': delivery_val or None, 'score': round(delivery_score, 3)},
            'MA': {'value': ma_val or None, 'score': round(ma_score, 3)},
            'A': {'value': None, 'score': 0.0},  # HQ不印A
            'AR': {'value': None, 'score': 0.0},
        }
    }
    flags = []
    if not delivery_val:
        flags.append('delivery空')
    if not ma_val:
        flags.append('MA空')
    rec['review'] = flags
    records.append(rec)


json.dump({'count': len(records), 'source': '苏联单位\\HQ', 'records': records},
          open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

ok = sum(1 for r in records if not r['review'])
print(f'\n完全合格 {ok}/{len(records)} = {100.0*ok/max(1,len(records)):.1f}%')
print('问题:', dict(collections.Counter(x for r in records for x in r['review'])))

print(f'\n所有结果:')
for r in records:
    d = r['fields']
    print(f"  {r['file'][:-4]:<22} {r['face']:<5} delivery={str(d['delivery']['value']):<5} MA={str(d['MA']['value']):<4} "
          f"{'|'+','.join(r['review']) if r['review'] else ''}")
