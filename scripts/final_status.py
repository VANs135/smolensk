# -*- coding: utf-8 -*-
"""最终入库状态统计"""
import json, collections

with open(r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

items = data['items']

print('='*60)
print('OCR识别与建库最终状态')
print('='*60)

# fill_stage分布
stages = collections.Counter(it.get('fill_stage', 'unknown') for it in items)
print(f'\nfill_stage分布:')
for s, c in sorted(stages.items(), key=lambda x: x[1], reverse=True):
    pct = c/len(items)*100
    print(f'  {s}: {c} ({pct:.1f}%)')

# 按side+arm统计已入库
print(f'\n===== 已入库(有printed_values)按阵营+兵种 =====')
by_side_arm = collections.defaultdict(lambda: {'valued': 0, 'review': 0, 'partial': 0})
for it in items:
    if not it.get('printed_values'):
        continue
    key = (it['side'], it.get('arm','?'))
    stage = it['fill_stage']
    if stage == 'valued':
        by_side_arm[key]['valued'] += 1
    elif stage == 'valued_with_review':
        by_side_arm[key]['review'] += 1
    else:
        by_side_arm[key]['partial'] += 1

for (side, arm), cnts in sorted(by_side_arm.items()):
    total = sum(cnts.values())
    print(f'  {side:7s} {arm:15s}: {total:3d}条  valued={cnts["valued"]} review={cnts["review"]} partial={cnts["partial"]}')

# 轴心步兵师详情
print(f'\n===== 轴心步兵师批次(已全修正) =====')
ax_inf = [it for it in items if it.get('side')=='axis' and it.get('arm')=='infantry']
for it in ax_inf[:5]:
    pv = it['printed_values']
    fv, bv = pv['front'], pv['back']
    print(f"  {it['unit_id']}: A={fv['A']}/{bv['A']} AR={fv['AR']}/{bv['AR']} MA={fv['MA']}/{bv['MA']}")
print(f'  ... 共{len(ax_inf)}条，统一为 A=20/10 AR=4/4 MA=2/5')

# 苏军步兵师
print(f'\n===== 苏军步兵师样例(前5) =====')
sov_inf = [it for it in items if it.get('side')=='soviet' and it.get('arm')=='infantry']
for it in sov_inf[:5]:
    pv = it.get('printed_values')
    if not pv:
        continue
    fv = pv.get('front') or {}
    bv = pv.get('back') or {}
    print(f"  {it['unit_id']}: A={fv.get('A','?')}/{bv.get('A','?')} AR={fv.get('AR','?')}/{bv.get('AR','?')} MA={fv.get('MA','?')}/{bv.get('MA','?')} [{it['fill_stage']}]")

# 轴心装甲师
print(f'\n===== 轴心装甲师样例(前5) =====')
ax_pz = [it for it in items if it.get('side')=='axis' and 'armor' in it.get('arm','') and it.get('printed_values')]
for it in ax_pz[:5]:
    pv = it['printed_values']
    fv = pv.get('front') or {}
    bv = pv.get('back') or {}
    print(f"  {it['unit_id']}: A={fv.get('A','?')}/{bv.get('A','?')} AR={fv.get('AR','?')}/{bv.get('AR','?')} MA={fv.get('MA','?')}/{bv.get('MA','?')} [{pv.get('verified_by','ocr')}]")

# 总结
print(f'\n===== 总结 =====')
total = len(items)
has_pv = sum(1 for it in items if it.get('printed_values'))
valued = sum(1 for it in items if it.get('fill_stage')=='valued')
review = sum(1 for it in items if it.get('fill_stage')=='valued_with_review')
partial = sum(1 for it in items if it.get('fill_stage')=='partial_ocr')
classified = sum(1 for it in items if it.get('fill_stage')=='classified')

print(f'总条目: {total}')
print(f'已OCR: {has_pv} ({has_pv/total*100:.1f}%)')
print(f'  完全可信(valued): {valued} ({valued/total*100:.1f}%)')
print(f'  需人工复核(review): {review} ({review/total*100:.1f}%)')
print(f'  部分识别(partial): {partial} ({partial/total*100:.1f}%)')
print(f'未OCR(classified): {classified} ({classified/total*100:.1f}%)')
