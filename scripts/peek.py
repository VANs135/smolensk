import json
for label, path in [
    ('轴心步兵师', r'D:\OCS\smolensk\scripts\ocr_out\ocr_axis_inf.json'),
    ('苏军步兵师', r'D:\OCS\smolensk\scripts\ocr_out\ocr_sov_inf.json'),
]:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    rec = data['records'][0]
    print(label, '顶层source:', data.get('source', '无'))
    print('  records[0] keys:', list(rec.keys()))
    print('  records[0].source:', rec.get('source', '无'))
    print('  records[0].file:', rec.get('file', '无'))
    print()
