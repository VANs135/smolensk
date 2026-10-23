# -*- coding: utf-8 -*-
"""轴心HQ批量入库脚本

HQ版式规范（技能）：
- 不印A值（按规则值入库）
- 底部左 = 投递距离 (range/delivery)
- 底部右 = MA（移动力）
- MA印 rr = 铁路移动

目录名格式 = 投递距离-MA:
  8-0  → 投递距离=8, MA=0
  10-0 → 投递距离=10, MA=0

轴心HQ目录：轴心单位\HQ\8-0, 轴心单位\HQ\10-0
"""
import json, os, collections

UNITS_JSON = r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json'
AX_HQ_ROOT = r'D:\OCS\OCS斯摩棱斯克素材\图片素材库\轴心单位\HQ'

with open(UNITS_JSON, 'r', encoding='utf-8') as f:
    units_data = json.load(f)
items = units_data['items']

# ========== 1. 扫描HQ目录，建立 filename -> {range, MA} 映射 ==========
hq_by_file = {}
print('===== 扫描轴心HQ目录 =====')

for dirname in sorted(os.listdir(AX_HQ_ROOT)):
    dirpath = os.path.join(AX_HQ_ROOT, dirname)
    if not os.path.isdir(dirpath):
        continue
    
    parts = dirname.split('-')
    if len(parts) != 2:
        continue
    
    try:
        delivery, ma = int(parts[0]), int(parts[1])
    except ValueError:
        continue
    
    files = [f for f in os.listdir(dirpath) if f.endswith('.png')]
    
    for fname in files:
        hq_by_file[fname] = {
            'delivery': str(delivery),
            'MA': str(ma),
        }
    
    print(f'  {dirname}: delivery={delivery} MA={ma} -> {len(files)}张')

print(f'\n建立映射: {len(hq_by_file)}个文件名')

# ========== 2. 匹配units.json HQ条目 ==========
matched = 0
print(f'\n===== 匹配units.json HQ条目 =====')

for it in items:
    if it.get('side') != 'axis' or it.get('arm') != 'hq':
        continue
    
    img = it.get('images', {})
    front_name = img.get('front')
    back_name = img.get('back')
    
    front_data = hq_by_file.get(front_name)
    back_data = hq_by_file.get(back_name)
    
    if not front_data and not back_data:
        print(f'  未匹配: {it["unit_id"]} front={front_name}')
        continue
    
    matched += 1
    
    pv = {'front': None, 'back': None, 'source': 'hq_dirname', 'batch': '', 'verified_by': 'dirname_parsed'}
    
    for face, data in [('front', front_data), ('back', back_data)]:
        if data:
            pv[face] = {
                'A': None,  # HQ不印A
                'AR': None,
                'delivery': data['delivery'],
                'MA': data['MA'],
                'ma_color': 'white',
                'special': 'no_A',
            }
    
    it['printed_values'] = pv
    it['fill_stage'] = 'valued'
    it['review'] = []
    
    fv = pv['front'] or {}
    bv = pv['back'] or {}
    print(f"  ✓ {it['unit_id']}: delivery={fv.get('delivery','-')}/{bv.get('delivery','-')} MA={fv.get('MA','-')}/{bv.get('MA','-')}")

print(f'\n轴心HQ入库: {matched} 条')

# 保存
with open(UNITS_JSON, 'w', encoding='utf-8') as f:
    json.dump(units_data, f, ensure_ascii=False, indent=2)

stages = collections.Counter(it.get('fill_stage', 'unknown') for it in items)
print(f'\nfill_stage分布:')
for s, c in sorted(stages.items(), key=lambda x: x[1], reverse=True):
    print(f'  {s}: {c}')
