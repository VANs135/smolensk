# -*- coding: utf-8 -*-
"""合并所有剩余OCR结果 → units.json（苏联HQ + 坦克师 + 之前已有的）"""
import json, collections, os

UNITS_JSON = r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json'

OCR_FILES = [
    ('axis_inf', r'D:\OCS\smolensk\scripts\ocr_out\ocr_axis_inf.json'),
    ('sov_inf', r'D:\OCS\smolensk\scripts\ocr_out\ocr_sov_inf.json'),
    ('axis_ground', r'D:\OCS\smolensk\scripts\ocr_out\axis_ground_ocr.json'),
    ('sov_hq', r'D:\OCS\smolensk\scripts\ocr_out\ocr_sov_hq.json'),
]

with open(UNITS_JSON, 'r', encoding='utf-8') as f:
    units_data = json.load(f)
items = units_data['items']

# 加载所有OCR结果
ocr_by_file = {}
for label, path in OCR_FILES:
    if not os.path.exists(path):
        continue
    with open(path, 'r', encoding='utf-8') as f:
        ocr_data = json.load(f)
    top_source = ocr_data.get('source', label)
    for rec in ocr_data['records']:
        if 'source' not in rec or not rec['source']:
            rec['source'] = top_source
        fname = rec['file']
        if fname not in ocr_by_file:
            ocr_by_file[fname] = rec
    print(f'  {label}: {ocr_data["count"]}张 (source={top_source})')

# ========== 匹配入库 ==========
matched = 0
for it in items:
    front_name = it.get('images', {}).get('front')
    back_name = it.get('images', {}).get('back')
    
    front_rec = ocr_by_file.get(front_name) if front_name else None
    back_rec = ocr_by_file.get(back_name) if back_name else None
    
    if not front_rec and not back_rec:
        continue
    
    matched += 1
    
    # 检查是否是HQ专用OCR（有delivery字段）
    is_hq = front_rec and 'delivery' in front_rec.get('fields', {})
    
    pv = {'front': None, 'back': None, 'source': 'ocr', 'verified_by': 'auto'}
    
    for face, rec in [('front', front_rec), ('back', back_rec)]:
        if not rec:
            continue
        f = rec['fields']
        if 'delivery' in f:
            # HQ格式
            pv[face] = {
                'A': f.get('A', {}).get('value'),
                'AR': f.get('AR', {}).get('value'),
                'delivery': f.get('delivery', {}).get('value'),
                'MA': f.get('MA', {}).get('value'),
                'ma_color': 'white',
                'special': 'no_A' if not f.get('A', {}).get('value') else None,
            }
        else:
            # 标准格式
            pv[face] = {
                'A': f.get('A', {}).get('value'),
                'AR': f.get('AR', {}).get('value'),
                'MA': f.get('MA', {}).get('value'),
                'ma_color': rec.get('ma_color', 'white'),
            }
    
    it['printed_values'] = pv
    ocr_rec = front_rec or back_rec or {}
    it['review'] = ocr_rec.get('review', [])
    
    # fill_stage
    all_ok = True
    for fv in (pv['front'], pv['back']):
        if not fv:
            continue
        # HQ只需要delivery和MA
        if fv.get('delivery') is not None:
            if not fv.get('delivery'):
                all_ok = False
            if not fv.get('MA'):
                all_ok = False
        else:
            for field in ('A', 'AR', 'MA'):
                if not fv.get(field):
                    all_ok = False
    
    if all_ok and not it['review']:
        it['fill_stage'] = 'valued'
    elif all_ok:
        it['fill_stage'] = 'valued_with_review'
    else:
        it['fill_stage'] = 'partial_ocr'

print(f'\n匹配: {matched}')

# 保存
with open(UNITS_JSON, 'w', encoding='utf-8') as f:
    json.dump(units_data, f, ensure_ascii=False, indent=2)

stages = collections.Counter(it.get('fill_stage', 'unknown') for it in items)
print(f'\nfill_stage分布:')
for s, c in sorted(stages.items(), key=lambda x: x[1], reverse=True):
    print(f'  {s}: {c}')

# 苏联HQ入库验证
print(f'\n===== 苏联HQ入库 =====')
for it in items:
    if it.get('side') == 'soviet' and it.get('arm') == 'hq' and it.get('printed_values'):
        pv = it['printed_values']
        fv = pv.get('front') or {}
        bv = pv.get('back') or {}
        print(f"  {it['unit_id']}: delivery={fv.get('delivery','?')}/{bv.get('delivery','?')} MA={fv.get('MA','?')}/{bv.get('MA','?')} [{it['fill_stage']}]")
