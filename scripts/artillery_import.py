# -*- coding: utf-8 -*-
"""轴心炮兵入库脚本 v2 - 修复映射匹配"""
import json, os, collections

UNITS_JSON = r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json'
AX_ART_ROOT = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\轴心单位\独立炮兵'

with open(UNITS_JSON, 'r', encoding='utf-8') as f:
    units_data = json.load(f)
items = units_data['items']

# ========== 1. 扫描炮兵目录 ==========
art_front = {}  # front文件名 -> {bomb, AR, MA}
art_back = {}   # back文件名 -> {bomb, AR, MA}
print('===== 扫描轴心炮兵目录 =====')

for dirname in sorted(os.listdir(AX_ART_ROOT)):
    dirpath = os.path.join(AX_ART_ROOT, dirname)
    if not os.path.isdir(dirpath):
        continue
    
    parts = dirname.split('-')
    if len(parts) != 3:
        continue
    
    try:
        bomb, ar, ma = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError:
        continue
    
    files = [f for f in os.listdir(dirpath) if f.endswith('.png')]
    
    for fname in files:
        if fname.strip().endswith('B.png'):
            art_back[fname] = {'bomb': str(bomb), 'AR': str(ar), 'MA': str(ma)}
        else:
            art_front[fname] = {'bomb': str(bomb), 'AR': str(ar), 'MA': str(ma)}
    
    print(f'  {dirname}: bomb={bomb} AR={ar} MA={ma} -> {len(files)}张 (front={len([f for f in files if not f.endswith("B.png")])}, back={len([f for f in files if f.endswith("B.png")])})')

print(f'\nfront文件映射: {len(art_front)}')
for k, v in sorted(art_front.items()):
    print(f'  {k}: {v}')
print(f'\nback文件映射: {len(art_back)}')
for k, v in sorted(art_back.items()):
    print(f'  {k}: {v}')

# ========== 2. 匹配units.json炮兵条目 ==========
matched = 0
print(f'\n===== 匹配units.json条目 =====')

for it in items:
    if it.get('side') != 'axis' or it.get('arm') != 'artillery':
        continue
    
    img = it.get('images', {})
    front_name = img.get('front')
    back_name = img.get('back')
    
    front_data = art_front.get(front_name)
    back_data = art_back.get(back_name)
    
    # 也可能正面用front映射、背面也用front映射（背面名字不一定带B）
    if not back_data and back_name:
        back_data = art_front.get(back_name)
    
    if not front_data and not back_data:
        print(f'  未匹配: {it["unit_id"]} front={front_name} back={back_name}')
        continue
    
    matched += 1
    
    pv = {'front': None, 'back': None, 'source': 'artillery_dirname', 'batch': '', 'verified_by': 'dirname_parsed'}
    
    if front_data:
        pv['front'] = {
            'bomb': front_data['bomb'],
            'A': None,
            'AR': front_data['AR'],
            'MA': front_data['MA'],
            'range': None,
            'ma_color': 'white',
        }
    if back_data:
        pv['back'] = {
            'bomb': back_data['bomb'],
            'A': None,
            'AR': back_data['AR'],
            'MA': back_data['MA'],
            'range': None,
            'ma_color': 'white',
        }
    
    it['printed_values'] = pv
    it['fill_stage'] = 'valued'
    it['review'] = []
    
    fv = pv['front'] or {}
    bv = pv['back'] or {}
    print(f"  ✓ {it['unit_id']}: bomb={fv.get('bomb','-')}/{bv.get('bomb','-')} AR={fv.get('AR','-')}/{bv.get('AR','-')} MA={fv.get('MA','-')}/{bv.get('MA','-')}")

print(f'\n轴心炮兵入库: {matched} 条')

# 保存
with open(UNITS_JSON, 'w', encoding='utf-8') as f:
    json.dump(units_data, f, ensure_ascii=False, indent=2)

stages = collections.Counter(it.get('fill_stage', 'unknown') for it in items)
print(f'\nfill_stage分布:')
for s, c in sorted(stages.items(), key=lambda x: x[1], reverse=True):
    print(f'  {s}: {c}')
