# -*- coding: utf-8 -*-
"""查询units.json结构"""
import json

with open(r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

if isinstance(data, dict):
    print('顶层key:', list(data.keys())[:10])
    items = data.get('items', data.get('units', []))
elif isinstance(data, list):
    items = data
else:
    items = []

print(f'总条目: {len(items)}')

# 看有images的第一个
for it in items[:20]:
    if 'images' in it and it['images'].get('front'):
        print('\n=== 样例条目 ===')
        print(json.dumps(it, ensure_ascii=False, indent=2)[:600])
        break

# 找轴心步兵师
print('\n=== 轴心步兵师样例 ===')
cnt = 0
for it in items:
    uid = it.get('unit_id', '')
    if 'infdiv' in uid.lower() and it.get('side') == 'axis':
        img = it.get('images', {})
        print(f"  {uid}: front={img.get('front','')}")
        cnt += 1
        if cnt >= 5:
            break

# 统计fill_stage
import collections
stages = collections.Counter(it.get('fill_stage', 'unknown') for it in items)
print(f'\nfill_stage分布: {dict(stages)}')

# 统计有printed_values的
has_pv = sum(1 for it in items if it.get('printed_values'))
print(f'有printed_values的: {has_pv}/{len(items)}')
