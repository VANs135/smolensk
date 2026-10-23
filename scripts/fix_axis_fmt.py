# -*- coding: utf-8 -*-
"""轴心编队/独立装甲批次分析 → 强制修正入库"""
import json, collections, os

UNITS_JSON = r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json'
OCR_FILE = r'D:\OCS\smolensk\scripts\ocr_out\axis_ground_ocr.json'

with open(UNITS_JSON, 'r', encoding='utf-8') as f:
    units_data = json.load(f)
items = units_data['items']

with open(OCR_FILE, 'r', encoding='utf-8') as f:
    ocr_data = json.load(f)

# 按source分组统计A/AR/MA分布
batches = collections.defaultdict(lambda: {'front': {'A': [], 'AR': [], 'MA': []}, 'back': {'A': [], 'AR': [], 'MA': []}})

for rec in ocr_data['records']:
    src = rec.get('source', 'unknown')
    face = rec['face']
    for field in ('A', 'AR', 'MA'):
        val = rec['fields'][field]['value']
        if val:
            batches[src][face][field].append(val)

print('===== 轴心批次数值分布 =====')
for src in sorted(batches.keys()):
    d = batches[src]
    cnt = sum(len(d[f][x]) for f in ('front','back') for x in ('A','AR','MA'))
    if cnt < 6:
        continue
    print(f'\n  [{src}]')
    for face in ('front', 'back'):
        parts = []
        for field in ('A', 'AR', 'MA'):
            vals = d[face][field]
            if vals:
                mode, n = collections.Counter(vals).most_common(1)[0]
                parts.append(f'{field}={mode}({n}/{len(vals)})')
        if parts:
            print(f'    {face}: {", ".join(parts)}')

# ========== 轴心编队装甲师强制修正 ==========
# 典型装甲师版式：front AR=5, MA=8 / back AR=5, MA=16
# 典型装甲师A值可能被误识别，用众数修正
AX_PZ_CORRECT = {
    'front': {'A': '7', 'AR': '5', 'MA': '8'},
    'back':  {'A': '2', 'AR': '5', 'MA': '16'},
}

fixes = 0
for it in items:
    side = it.get('side')
    arm = it.get('arm', '')
    pv = it.get('printed_values')
    if side != 'axis' or not pv:
        continue
    
    # 装甲师(armor含pz)、装甲大队(AG)、机械化
    need_fix = ('armor' in arm or 'cavalry' in arm) and arm not in ('supply',)
    # 排除步兵师和HQ、炮兵
    if it.get('arm') in ('infantry', 'hq', 'artillery', 'supply', 'transport'):
        continue
    
    flags = []
    
    for face, correct in AX_PZ_CORRECT.items():
        fv = pv.get(face)
        if not fv:
            continue
        for field in ('AR', 'MA'):
            ocr_val = fv.get(field)
            if ocr_val and ocr_val != correct[field]:
                fv[field] = correct[field]
                flags.append(f'[{face}.{field}] {ocr_val}→{correct[field]}')
    
    if flags:
        fixes += 1
        pv['verified_by'] = 'batch_mode_corrected'
        it['printed_values'] = pv
        it['review'] = flags
        it['fill_stage'] = 'valued'

print(f'\n轴心编队/装甲强制修正: {fixes} 条')

# ========== 独立装甲修正 ==========
AX_AG_CORRECT = {  # AG装甲大队
    'front': {'A': '7', 'AR': '5', 'MA': '8'},
    'back':  {'A': '2', 'AR': '5', 'MA': '16'},
}
# 机械化反坦克营
AX_MEK_CORRECT = {
    'front': {'A': '2', 'AR': '3', 'MA': '6'},
    'back':  {'A': '2', 'AR': '3', 'MA': '14'},
}

# 保存
with open(UNITS_JSON, 'w', encoding='utf-8') as f:
    json.dump(units_data, f, ensure_ascii=False, indent=2)

stages = collections.Counter(it.get('fill_stage', 'unknown') for it in items)
print(f'\nfill_stage分布:')
for s, c in sorted(stages.items(), key=lambda x: x[1], reverse=True):
    print(f'  {s}: {c}')

# 看轴心装甲师结果
print(f'\n===== 轴心装甲师入库预览（前15条）=====')
cnt = 0
for it in items:
    if it.get('side') == 'axis' and it.get('arm') == 'armor' and it.get('printed_values'):
        pv = it['printed_values']
        fv = pv.get('front', {})
        bv = pv.get('back', {})
        print(f"  {it['unit_id']}: A={fv.get('A','?')}/{bv.get('A','?')} AR={fv.get('AR','?')}/{bv.get('AR','?')} MA={fv.get('MA','?')}/{bv.get('MA','?')} [{pv.get('verified_by','?')}]")
        cnt += 1
        if cnt >= 15:
            break
