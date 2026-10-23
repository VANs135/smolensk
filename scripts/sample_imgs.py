# -*- coding: utf-8 -*-
"""裁出HQ和苏联坦克师样例图，分析版式差异"""
import cv2, os, numpy as np

def imread_u(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)

SAVEDIR = r'D:\OCS\smolensk\scripts\ocr_out\samples'
os.makedirs(SAVEDIR, exist_ok=True)

# ====== 轴心HQ样例 ======
print('===== 轴心HQ样例 =====')
samples = [
    (r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\轴心单位\HQ\8-0', 'BD2 S2 R01 C06.png', '8-0_HQ_front'),
    (r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\轴心单位\HQ\8-0', 'BD2 S2 R01 C06B.png', '8-0_HQ_back'),
    (r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\轴心单位\HQ\10-0', 'BD2 S2 R01 C01.png', '10-0_HQ_front'),
    (r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\轴心单位\HQ\10-0', 'BD2 S2 R01 C01B.png', '10-0_HQ_back'),
]
for d, f, label in samples:
    img = imread_u(os.path.join(d, f))
    out = os.path.join(SAVEDIR, f'{label}.png')
    cv2.imwrite(out, img)
    # 打印底部区域的像素值分布
    bottom = img[36:64, :, :]
    print(f'\n{label} ({img.shape[1]}x{img.shape[0]}):')
    # 采样底部中间区域看数值位置
    for y in [42, 48, 54, 60]:
        row = img[y, 6:64, :]
        # 统计这行有多少暗像素
        dark = sum(1 for px in row if all(px < 80))
        bright = sum(1 for px in row if all(px > 180))
        print(f'  y={y}: dark={dark} bright={bright}')

# ====== 苏联HQ样例 ======
print('\n===== 苏联HQ样例 =====')
sov_hq_dir = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\苏联单位\HQ'
for i, f in enumerate(sorted(os.listdir(sov_hq_dir))[:6]):
    if not f.endswith('.png'): continue
    img = imread_u(os.path.join(sov_hq_dir, f))
    out = os.path.join(SAVEDIR, f'sov_hq_{f.replace(" ","_")}')
    cv2.imwrite(out, img)
    face = 'back' if 'B.png' in f else 'front'
    bottom = img[36:64, :, :]
    dark = sum(1 for px in bottom.reshape(-1,3) if all(px < 80))
    bright = sum(1 for px in bottom.reshape(-1,3) if all(px > 180))
    print(f'  sov_hq_{i}({face}): dark={dark} bright={bright}')

# ====== 苏联坦克师样例 ======
print('\n===== 苏联坦克师样例 =====')
sov_tk_dir = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\苏联单位\坦克师'
for i, f in enumerate(sorted(os.listdir(sov_tk_dir))[:4]):
    if not f.endswith('.png'): continue
    img = imread_u(os.path.join(sov_tk_dir, f))
    out = os.path.join(SAVEDIR, f'sov_tk_{f.replace(" ","_")}')
    cv2.imwrite(out, img)
    face = 'back' if 'B.png' in f else 'front'
    bottom = img[36:64, :, :]
    dark = sum(1 for px in bottom.reshape(-1,3) if all(px < 80))
    bright = sum(1 for px in bottom.reshape(-1,3) if all(px > 180))
    # 看底部区域的颜色
    sub = img[38:62, 6:64, :].reshape(-1,3).astype(int)
    avg_b, avg_g, avg_r = sub.mean(axis=0)
    print(f'  sov_tk_{i}({face}): avg_color=({avg_r:.0f},{avg_g:.0f},{avg_b:.0f}) dark={dark} bright={bright}')

# ====== 对比: 苏军步兵师样例(已知版式) ======
print('\n===== 苏军步兵师样例(已知版式) =====')
sov_inf_dir = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\苏联单位\步兵师\2RE'
for i, f in enumerate(sorted(os.listdir(sov_inf_dir))[:2]):
    if not f.endswith('.png'): continue
    img = imread_u(os.path.join(sov_inf_dir, f))
    out = os.path.join(SAVEDIR, f'sov_inf_ref_{f.replace(" ","_")}')
    cv2.imwrite(out, img)
    sub = img[38:62, 6:64, :].reshape(-1,3).astype(int)
    avg_b, avg_g, avg_r = sub.mean(axis=0)
    print(f'  sov_inf_ref_{i}: avg_color=({avg_r:.0f},{avg_g:.0f},{avg_b:.0f})')

# ====== 对比: 轴心坦克师样例 ======
print('\n===== 轴心坦克师样例(已知版式) =====')
ax_pz_dir = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\轴心单位\编队单位\17PZ'
for i, f in enumerate(sorted(os.listdir(ax_pz_dir))[:2]):
    if not f.endswith('.png'): continue
    img = imread_u(os.path.join(ax_pz_dir, f))
    out = os.path.join(SAVEDIR, f'ax_pz_ref_{f.replace(" ","_")}')
    cv2.imwrite(out, img)

print('\n样例已保存到:', SAVEDIR)
