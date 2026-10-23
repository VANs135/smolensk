# -*- coding: utf-8 -*-
"""查更多units条目样例，确认图片名"""
import json

with open(r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

items = data['items']

# 按side和arm分组看样例
for side in ['axis', 'soviet']:
    print(f'\n===== {side} =====')
    for arm in ['infantry', 'armor', 'hq', 'artillery', 'cavalry', 'recon']:
        matches = [it for it in items if it.get('side') == side and arm in it.get('arm', '').lower()]
        if matches:
            print(f'\n  {arm} ({len(matches)}条):')
            for it in matches[:3]:
                img = it.get('images', {})
                print(f"    {it.get('unit_id','')}: front={img.get('front','')}")

# 搜索轴心步兵师（可能叫infantry或infantry_division或inf-div）
print('\n===== 轴心地面单位样例 =====')
for it in items:
    if it.get('side') == 'axis' and it.get('arm') in ('infantry', 'armor', 'hq'):
        img = it.get('images', {})
        if img.get('front') and img['front'].startswith(('BD2', 'S', 'S2', 'S3', 'S4', 'S5', 'S6')):
            print(f"  {it['unit_id']}: front={img['front']}")
            break

# 找有BD2开头的
print('\n===== 有BD2/S头图片的条目 =====')
cnt = 0
for it in items:
    img = it.get('images', {})
    f = img.get('front', '')
    if f and f.startswith(('BD2', 'S ', 'S2', 'S3', 'S4', 'S5')):
        print(f"  side={it.get('side'):<7} arm={it.get('arm'):<12} front={f}")
        cnt += 1
        if cnt >= 10:
            break
