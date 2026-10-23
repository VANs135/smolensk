# -*- coding: utf-8 -*-
"""用批次众数强制修正OCR结果 → 写入units.json

轴心步兵师：
  front: A=20, AR=4, MA=2 (29张全20，AR众数4，MA众数2)
  back:  A=10, AR=4, MA=5 (A众数应为10而非0，取有效样本)

苏军步兵师：
  先不强制修正，因为有不同RE类型
"""
import json, collections, os

UNITS_JSON = r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json'
CORRECTIONS_JSON = r'D:\OCS\smolensk\scripts\ocr_out\corrections.json'

with open(UNITS_JSON, 'r', encoding='utf-8') as f:
    units_data = json.load(f)
items = units_data['items']

# ========== 轴心步兵师强制修正 ==========
# 正确值（基于批次分析）
AX_INF_CORRECT = {
    'front': {'A': '20', 'AR': '4', 'MA': '2'},
    'back':  {'A': '10', 'AR': '4', 'MA': '5'},
}

ax_inf_fixed = 0
for it in items:
    if it.get('side') != 'axis' or it.get('arm') != 'infantry':
        continue
    if not it.get('printed_values'):
        continue
    
    pv = it['printed_values']
    flags = []
    
    for face, correct in AX_INF_CORRECT.items():
        fv = pv.get(face)
        if not fv:
            continue
        for field in ('A', 'AR', 'MA'):
            ocr_val = fv.get(field)
            if ocr_val != correct[field]:
                old = ocr_val
                fv[field] = correct[field]
                msg = f'[{face}.{field}] OCR={old} → 众数修正为 {correct[field]}'
                flags.append(msg)
    
    if flags:
        ax_inf_fixed += 1
    
    pv['verified_by'] = 'batch_mode_corrected'
    it['printed_values'] = pv
    it['review'] = flags
    it['fill_stage'] = 'valued'  # 强制修正后认为可信

print(f'轴心步兵师强制修正: {ax_inf_fixed} 条')

# ========== 轴心其他规整批次强制修正 ==========
# 编队装甲师的典型结构: front A=7, AR=5, MA=8 / back A=2, AR=5, MA=16
AX_PZ_CORRECT = {
    'front': {'A': '7', 'AR': '5', 'MA': '8'},
    'back':  {'A': '2', 'AR': '5', 'MA': '16'},
}

pz_fixed = 0
for it in items:
    if it.get('side') != 'axis' or it.get('arm') != 'armor':
        continue
    if not it.get('printed_values'):
        continue
    
    pv = it['printed_values']
    flags = []
    
    for face, correct in AX_PZ_CORRECT.items():
        fv = pv.get(face)
        if not fv:
            continue
        for field in ('A', 'AR', 'MA'):
            ocr_val = fv.get(field)
            # 只有OCR值偏离众数时才修正（只修正明显错误的）
            if field == 'A' and ocr_val and ocr_val not in ('7', '0', '01', '2'):
                fv[field] = correct[field]
                flags.append(f'[{face}.{field}] OCR={ocr_val} → 众数修正 {correct[field]}')
            elif field == 'AR' and ocr_val and ocr_val != correct[field]:
                fv[field] = correct[field]
                flags.append(f'[{face}.{field}] OCR={ocr_val} → 众数修正 {correct[field]}')
            elif field == 'MA' and ocr_val and ocr_val not in ('8', '16'):
                fv[field] = correct[field]
                flags.append(f'[{face}.{field}] OCR={ocr_val} → 众数修正 {correct[field]}')
    
    if flags:
        pz_fixed += 1
    
    it['printed_values'] = pv
    it['review'] = flags
    it['fill_stage'] = 'valued'

print(f'轴心装甲师强制修正: {pz_fixed} 条')

# ========== 苏军步兵师 ==========
# 苏军步兵师有不同RE类型（1RE/2RE/3RE），AR值有差异
# 但front.MA应该=1或2，back.MA应该=3或4（移动模式MA>战斗模式MA）
sov_fixed = 0
for it in items:
    if it.get('side') != 'soviet' or it.get('arm') != 'infantry':
        continue
    if not it.get('printed_values'):
        continue
    
    pv = it['printed_values']
    flags = []
    
    # 双面规律校验并修正
    fv = pv.get('front')
    bv = pv.get('back')
    
    if fv and bv:
        # back.A可能被误识别为大数值（例如把20当成back.A）
        if bv['A'] and bv['A'].isdigit() and int(bv['A']) > 15:
            # back.A不应该这么大，可能是front.A串过来了
            # 看front.A是不是合理
            if fv['A'] and fv['A'].isdigit() and int(fv['A']) >= 10:
                # 交换A值（如果看起来像串了）
                if fv['A'] != bv['A']:
                    flags.append(f'swap A: front={fv["A"]} back={bv["A"]} (back.A过大)')
                    fv['A'], bv['A'] = bv['A'], fv['A']
                    sov_fixed += 1
    
    it['printed_values'] = pv
    it['review'] = flags
    # 苏军暂不强制推进到valued，保留valued_with_review或partial_ocr

print(f'苏军步兵师双面修正: {sov_fixed} 条')

# ========== 最终fill_stage统计 ==========
stages = collections.Counter(it.get('fill_stage', 'unknown') for it in items)
print(f'\n===== fill_stage最终分布 =====')
for s, c in sorted(stages.items(), key=lambda x: x[1], reverse=True):
    print(f'  {s}: {c}')

# 轴心步兵师最终状态
print(f'\n===== 轴心步兵师最终入库 =====')
ax_inf = [it for it in items if it.get('side') == 'axis' and it.get('arm') == 'infantry']
errors = 0
for it in ax_inf:
    pv = it.get('printed_values')
    if not pv:
        print(f"  {it['unit_id']}: 无OCR结果!")
        errors += 1
        continue
    fv = pv.get('front', {})
    bv = pv.get('back', {})
    print(f"  {it['unit_id']}: A={fv.get('A','?')}/{bv.get('A','?')} AR={fv.get('AR','?')}/{bv.get('AR','?')} MA={fv.get('MA','?')}/{bv.get('MA','?')} [{pv.get('verified_by','?')}]")

# 保存
with open(UNITS_JSON, 'w', encoding='utf-8') as f:
    json.dump(units_data, f, ensure_ascii=False, indent=2)
print(f'\n写入: {UNITS_JSON}')

# 轴心步兵师结果预览
print(f'\n===== 轴心步兵师批次真值总结 =====')
print(f'  front: A=20, AR=4, MA=2')
print(f'  back:  A=10, AR=4, MA=5')
print(f'  (移动模式MA=5 > 战斗模式MA=2 ✓ 符合双面规律)')
