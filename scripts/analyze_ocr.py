# -*- coding: utf-8 -*-
"""分析轴心OCR结果，定位问题"""
import json, collections, sys

with open(r'D:\OCS\smolensk\scripts\ocr_out\axis_ground_ocr.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# 按具体子目录分组
by_dir = collections.defaultdict(list)
for r in data['records']:
    by_dir[r['source']].append(r)

print("=== 轴心OCR 各子目录分析 ===")
for d, recs in sorted(by_dir.items()):
    ok = sum(1 for r in recs if not r['review'])
    c = collections.Counter()
    for r in recs:
        for x in r['review']:
            c[x] += 1
    pct = round(100*ok/len(recs))
    print(f"\n{d}: {len(recs)}张, 合格{ok}({pct}%)")
    if c:
        print(f"  问题: {dict(c)}")

# 步兵师详细分析（20-4-3正面 / 10-4-5背面）
print("\n\n=== 轴心步兵师 详情 ===")
inf = [r for r in data['records'] if '步兵师' in r['source']]
front = [r for r in inf if r['face'] == 'front']
back = [r for r in inf if r['face'] == 'back']

print(f"正面({len(front)}张):")
for r in front[:5]:
    d = r['fields']
    print(f"  {r['file'][:-4]:<22} A={str(d['A']['value']):<4} AR={str(d['AR']['value']):<3} MA={str(d['MA']['value']):<4} score A={d['A']['score']:.2f} AR={d['AR']['score']:.2f} MA={d['MA']['score']:.2f}  review={r['review']}")

print(f"背面({len(back)}张):")
for r in back[:5]:
    d = r['fields']
    print(f"  {r['file'][:-5]:<22} A={str(d['A']['value']):<4} AR={str(d['AR']['value']):<3} MA={str(d['MA']['value']):<4} score A={d['A']['score']:.2f} AR={d['AR']['score']:.2f} MA={d['MA']['score']:.2f}  review={r['review']}")

# 统计步兵师的识别值分布
print("\n步兵师正面A值分布:", collections.Counter(r['fields']['A']['value'] for r in front))
print("步兵师正面AR值分布:", collections.Counter(r['fields']['AR']['value'] for r in front))
print("步兵师正面MA值分布:", collections.Counter(r['fields']['MA']['value'] for r in front))
print("步兵师背面A值分布:", collections.Counter(r['fields']['A']['value'] for r in back))
print("步兵师背面MA值分布:", collections.Counter(r['fields']['MA']['value'] for r in back))

# 看看AR空的图片，是不是AR太小被跳过了
print("\n=== AR空 样本 ===")
ar_empty = [r for r in data['records'] if 'AR空' in r['review']]
for r in ar_empty[:5]:
    print(f"  {r['file'][:-4]:<22} face={r['face']} base={r['base']} source={r['source']}")
    print(f"    fields: {json.dumps(r['fields'], default=str)}")
