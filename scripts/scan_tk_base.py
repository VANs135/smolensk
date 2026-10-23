# -*- coding: utf-8 -*-
"""快速扫描坦克师底色分布，决定OCR策略"""
import os, collections, numpy as np, cv2

def imread_u(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)

BASE = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库'
ROOTS = [
    os.path.join(BASE, r'苏联单位\坦克师'),
    os.path.join(BASE, r'苏联单位\独立装甲'),
]

def sov_base(img):
    sub = img[38:62, 6:64, :].reshape(-1, 3).astype(int)
    sub = sub[(sub[:, 0] < 235) | (sub[:, 1] < 235) | (sub[:, 2] < 235)]
    if len(sub) < 50:
        return 'unknown', (0,0,0)
    b, g, r = [int(v) for v in collections.Counter(map(tuple, sub)).most_common(1)[0][0]]
    
    if r > 170 and 60 < g < 140 and b < 90 and r - g > 50:
        return 'guards', (r,g,b)
    if r > 190 and g < 110 and b < 110:
        return 'nkvd', (r,g,b)
    if r > 190 and g > 180 and 100 < b < 190:
        return 'air', (r,g,b)
    if r > 155 and 100 < g < 180 and b < 135:
        return 'regular', (r,g,b)
    return f'other', (r,g,b)

for root in ROOTS:
    if not os.path.exists(root):
        continue
    print(f'\n===== {os.path.basename(root)} =====')
    cnts = collections.Counter()
    samples = collections.defaultdict(list)
    for dp, dn, fn in os.walk(root):
        for f in sorted(x for x in fn if x.lower().endswith('.png')):
            img = imread_u(os.path.join(dp, f))
            base, rgb = sov_base(img)
            cnts[base] += 1
            if len(samples[base]) < 3:
                samples[base].append((f, rgb))
    print(f'底色分布: {dict(cnts)}')
    for base, fns in samples.items():
        for fn, rgb in fns:
            print(f'  {base}({rgb}): {fn}')
