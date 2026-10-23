import json
with open(r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
items = data['items']

print('===== 轴心HQ条目 =====')
for it in items:
    if it.get('side')=='axis' and it.get('arm')=='hq':
        img = it['images']
        print(f"  {it['unit_id']}: front={img['front']}")

print()
print('===== 轴心炮兵条目 =====')
for it in items:
    if it.get('side')=='axis' and it.get('arm')=='artillery':
        img = it['images']
        print(f"  {it['unit_id']}: front={img['front']}")

print()
print('===== 苏联HQ条目 =====')
for it in items:
    if it.get('side')=='soviet' and it.get('arm')=='hq':
        img = it['images']
        print(f"  {it['unit_id']}: front={img['front']}")

print()
print('===== 苏联装甲坦克条目 =====')
for it in items:
    if it.get('side')=='soviet' and ('armor' in it.get('arm','')):
        img = it['images']
        print(f"  {it['unit_id']}: arm={it['arm']} front={img['front']}")
