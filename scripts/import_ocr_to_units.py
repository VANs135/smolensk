# -*- coding: utf-8 -*-
"""OCR结果清洗+批次众数校验+双面规律校验+写入units.json v2

修复：record里没有source字段 → 用OCR JSON顶层source补全
批次分组细化到子目录级别（轴心单位\\步兵师 而不是 轴心单位）
"""
import json, collections, os, sys

UNITS_JSON = r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json'
CORRECTIONS_JSON = r'D:\OCS\smolensk\scripts\ocr_out\corrections.json'

OCR_FILES = [
    ('axis_inf', r'D:\OCS\smolensk\scripts\ocr_out\ocr_axis_inf.json'),
    ('sov_inf', r'D:\OCS\smolensk\scripts\ocr_out\ocr_sov_inf.json'),
    ('axis_ground', r'D:\OCS\smolensk\scripts\ocr_out\axis_ground_ocr.json'),
]

# 加载units.json
with open(UNITS_JSON, 'r', encoding='utf-8') as f:
    units_data = json.load(f)
items = units_data['items']
print(f'加载units.json: {len(items)}条')

# 加载所有OCR结果，补全每条record的source
ocr_by_file = {}
for label, path in OCR_FILES:
    if not os.path.exists(path):
        print(f'  跳过不存在的: {path}')
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
        else:
            if not rec.get('review') and ocr_by_file[fname].get('review'):
                ocr_by_file[fname] = rec
    print(f'  {label}: {ocr_data["count"]}条 (top_source={top_source}) -> 累计 {len(ocr_by_file)}')

# ========== 批次分组 ==========
# 用完整source路径做批次key（子目录级别）
def batch_key(rec):
    src = rec.get('source', '')
    return src if src else 'unknown'

batches = collections.defaultdict(list)
for fname, rec in ocr_by_file.items():
    batches[batch_key(rec)].append(rec)

print(f'\n===== 批次分布 =====')
for bk, recs in sorted(batches.items()):
    faces = collections.Counter(r['face'] for r in recs)
    print(f'  [{len(recs):3d}] {bk}  front={faces.get("front",0)} back={faces.get("back",0)}')

# ========== 批次众数 ==========
batch_modes = {}
for bk, recs in batches.items():
    for face in ('front', 'back'):
        face_recs = [r for r in recs if r['face'] == face]
        for field in ('A', 'AR', 'MA'):
            vals = [r['fields'][field]['value'] for r in face_recs if r['fields'][field]['value']]
            if vals:
                mode_val = collections.Counter(vals).most_common(1)[0]
                batch_modes[(bk, face, field)] = mode_val

print(f'\n===== 批次众数表（>=3张的）=====')
for (bk, face, field), (val, cnt) in sorted(batch_modes.items()):
    if cnt >= 3:
        print(f'  {bk:30s} {face:5s} {field:3s}: mode={val} ({cnt}张)')

# ========== 匹配+入库 ==========
corrections = []
matched = 0
updated = 0

# 先还原printed_values和fill_stage（之前的错误写入）
for it in items:
    it['printed_values'] = None
    it['review'] = []
    it['fill_stage'] = 'classified'

for idx, it in enumerate(items):
    front_name = it.get('images', {}).get('front')
    back_name = it.get('images', {}).get('back')
    
    front_rec = ocr_by_file.get(front_name) if front_name else None
    back_rec = ocr_by_file.get(back_name) if back_name else None
    
    if not front_rec and not back_rec:
        continue
    
    matched += 1
    
    pv = {'front': None, 'back': None, 'source': 'ocr', 'batch': '', 'verified_by': 'auto'}
    
    def extract_vals(rec):
        if not rec:
            return None
        f = rec['fields']
        return {
            'A': f['A']['value'],
            'AR': f['AR']['value'],
            'MA': f['MA']['value'],
            'ma_color': rec.get('ma_color', 'white'),
        }
    
    pv['front'] = extract_vals(front_rec)
    pv['back'] = extract_vals(back_rec)
    pv['batch'] = batch_key(front_rec or back_rec)
    
    flags = []
    
    # 1. 批次众数校验
    for face, rec in [('front', front_rec), ('back', back_rec)]:
        if not rec:
            continue
        bk = batch_key(rec)
        for field in ('A', 'AR', 'MA'):
            val = rec['fields'][field]['value']
            if val and (bk, face, field) in batch_modes:
                mode_val, cnt = batch_modes[(bk, face, field)]
                if cnt >= 3 and val != mode_val:
                    msg = f'{field}={val} 偏离批次众数 {mode_val}({cnt}张)'
                    if msg not in flags:
                        flags.append(msg)
                        corrections.append({
                            'unit': it.get('unit_id'),
                            'file': rec['file'],
                            'face': face,
                            'field': field,
                            'ocr': val,
                            'suggested': mode_val,
                            'reason': f'批次[{bk}] 众数偏离 ({cnt}张)'
                        })
    
    # 2. 双面规律校验
    if pv['front'] and pv['back']:
        fa, ba = pv['front']['A'], pv['back']['A']
        fma, bma = pv['front']['MA'], pv['back']['MA']
        
        if fa and ba and fa.isdigit() and ba.isdigit():
            if int(fa) <= int(ba):
                msg = f'双面违反: front.A({fa}) <= back.A({ba})'
                if msg not in flags:
                    flags.append(msg)
                    corrections.append({'unit': it.get('unit_id'), 'reason': msg})
        
        if fma and bma and fma.isdigit() and bma.isdigit():
            if int(bma) <= int(fma):
                msg = f'双面违反: back.MA({bma}) <= front.MA({fma})'
                if msg not in flags:
                    flags.append(msg)
                    corrections.append({'unit': it.get('unit_id'), 'reason': msg})
    
    # 3. AR应为1位数字
    for face_vals in (pv['front'], pv['back']):
        if face_vals and face_vals['AR']:
            ar = face_vals['AR']
            if len(ar) != 1 or not ar.isdigit():
                msg = f'AR={ar} 非单位数'
                if msg not in flags:
                    flags.append(msg)
    
    it['printed_values'] = pv
    it['review'] = flags
    
    # fill_stage
    all_ok = True
    for fv in (pv['front'], pv['back']):
        if not fv:
            continue
        for field in ('A', 'AR', 'MA'):
            if not fv[field]:
                all_ok = False
    if all_ok and not flags:
        it['fill_stage'] = 'valued'
    elif all_ok:
        it['fill_stage'] = 'valued_with_review'
    else:
        it['fill_stage'] = 'partial_ocr'
    
    updated += 1

print(f'\n===== 入库结果 =====')
print(f'匹配: {matched}/{len(items)} 条')
print(f'更新: {updated} 条')
stages = collections.Counter(it.get('fill_stage', 'unknown') for it in items)
print(f'fill_stage分布:')
for s, c in sorted(stages.items(), key=lambda x: x[1], reverse=True):
    print(f'  {s}: {c}')

# 只看轴心步兵师和苏军步兵师
print(f'\n===== 轴心步兵师入库状态 =====')
ax_inf = [it for it in items if it.get('side') == 'axis' and it.get('arm') == 'infantry']
for it in ax_inf:
    pv = it.get('printed_values')
    stage = it['fill_stage']
    if pv and pv.get('front'):
        fv = pv['front']
        bv = pv['back']
        print(f"  {it['unit_id']}: A={fv['A']}/{bv['A']} AR={fv['AR']}/{bv['AR']} MA={fv['MA']}/{bv['MA']} [{stage}]")

print(f'\n===== 苏军步兵师入库状态（前10条）=====')
sov_inf = [it for it in items if it.get('side') == 'soviet' and it.get('arm') == 'infantry']
for it in sov_inf[:10]:
    pv = it.get('printed_values')
    stage = it['fill_stage']
    if pv and pv.get('front'):
        fv = pv['front']
        bv = pv['back']
        print(f"  {it['unit_id']}: A={fv['A']}/{bv['A']} AR={fv['AR']}/{bv['AR']} MA={fv['MA']}/{bv['MA']} [{stage}]")

# 保存
with open(UNITS_JSON, 'w', encoding='utf-8') as f:
    json.dump(units_data, f, ensure_ascii=False, indent=2)
print(f'\n写入: {UNITS_JSON}')

with open(CORRECTIONS_JSON, 'w', encoding='utf-8') as f:
    json.dump({'count': len(corrections), 'items': corrections}, f, ensure_ascii=False, indent=2)
print(f'修正表: {CORRECTIONS_JSON} ({len(corrections)}项)')

if corrections:
    print('\n===== 修正项预览 =====')
    for c in corrections[:15]:
        print(f"  {c.get('unit')}: {c.get('reason')}")
