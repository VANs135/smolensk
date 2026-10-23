# -*- coding: utf-8 -*-
"""像素级版式分析 - 对比各类型单位底部数值区"""
import cv2, os, numpy as np

def imread_u(p):
    return cv2.imdecode(np.fromfile(p, dtype=np.uint8), cv2.IMREAD_COLOR)

def analyze_bottom(img, label):
    """分析底部数值区"""
    h, w = img.shape[:2]
    bottom = img[34:66, :, :]  # y=34-66 是数值区
    
    print(f'\n{"="*50}')
    print(f'{label} ({w}x{h})')
    print(f'{"="*50}')
    
    # 1. 整体底色
    sub = img[38:62, 6:64, :].reshape(-1,3).astype(int)
    avg_b, avg_g, avg_r = sub.mean(axis=0)
    print(f'底色平均RGB: ({avg_r:.0f}, {avg_g:.0f}, {avg_b:.0f})')
    
    # 2. 找所有连通域（可能的数字）
    gray = cv2.cvtColor(bottom, cv2.COLOR_BGR2GRAY)
    
    # 暗字（黑字AR、A的黑描边）
    _, dark_mask = cv2.threshold(gray, 80, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(dark_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    print(f'暗字连通域(阈值80): {len(contours)}个')
    for i, c in enumerate(contours[:10]):
        x, y, bw, bh = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        print(f'  暗域{i}: x={x+6} y={y+34} w={bw} h={bh} area={area:.0f} aspect={bw/max(bh,1):.1f}')
    
    # 亮字（白字A、MA）
    _, bright_mask = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
    contours2, _ = cv2.findContours(bright_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    print(f'亮字连通域(阈值200): {len(contours2)}个')
    for i, c in enumerate(contours2[:10]):
        x, y, bw, bh = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        print(f'  亮域{i}: x={x+6} y={y+34} w={bw} h={bh} area={area:.0f} aspect={bw/max(bh,1):.1f}')

# ====== 轴心HQ ======
base = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\轴心单位\HQ\10-0'
for f in sorted(os.listdir(base))[:2]:
    if f.endswith('.png'):
        img = imread_u(os.path.join(base, f))
        face = 'back' if 'B' in f else 'front'
        analyze_bottom(img, f'轴心HQ 10-0 {face} ({f})')

# ====== 苏联HQ ======
base = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\苏联单位\HQ'
for f in sorted(os.listdir(base))[:3]:
    if f.endswith('.png'):
        img = imread_u(os.path.join(base, f))
        face = 'back' if 'B' in f else 'front'
        analyze_bottom(img, f'苏联HQ {face} ({f})')

# ====== 苏联坦克师 ======
base = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\苏联单位\坦克师'
for f in sorted(os.listdir(base))[:3]:
    if f.endswith('.png'):
        img = imread_u(os.path.join(base, f))
        face = 'back' if 'B' in f else 'front'
        analyze_bottom(img, f'苏联坦克师 {face} ({f})')

# ====== 参考: 苏军步兵师 ======
base = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\苏联单位\步兵师\2RE'
for f in sorted(os.listdir(base))[:2]:
    if f.endswith('.png'):
        img = imread_u(os.path.join(base, f))
        face = 'back' if 'B' in f else 'front'
        analyze_bottom(img, f'苏军步兵师 {face} ({f})')
