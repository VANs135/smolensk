# -*- coding: utf-8 -*-
"""查看OCR结果里source字段的实际格式"""
import json, os

for label, path in [
    ('轴心步兵师', r'D:\OCS\smolensk\scripts\ocr_out\ocr_axis_inf.json'),
    ('苏军步兵师', r'D:\OCS\smolensk\scripts\ocr_out\ocr_sov_inf.json'),
    ('轴心通用', r'D:\OCS\smolensk\scripts\ocr_out\axis_ground_ocr.json'),
]:
    if not os.path.exists(path):
        print(f'{label}: 文件不存在')
        continue
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # 统计source分布
    from collections import Counter
    sources = Counter()
    for rec in data['records']:
        src = rec.get('source', '')
        sources[src] += 1
    
    print(f'\n===== {label} ({data["count"]}张) =====')
    for src, cnt in sources.most_common(10):
        print(f'  [{cnt}] {src}')
