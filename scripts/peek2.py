import json
with open(r'D:\OCS\OCS斯摩棱斯克素材\斯摩棱斯克工程数据库\units.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# 轴心armor的arm字段值
from collections import Counter
arms = Counter()
for it in data['items']:
    if it.get('side') == 'axis':
        arms[it.get('arm','')] += 1
print('轴心arm分布:', dict(arms))

# 轴心valued条目样例
print('\n===== 轴心valued样例 =====')
cnt = 0
for it in data['items']:
    if it.get('side') == 'axis' and it.get('fill_stage') == 'valued' and it.get('printed_values'):
        pv = it['printed_values']
        fv = pv.get('front', {})
        bv = pv.get('back', {})
        print(f"  {it['unit_id']}: arm={it['arm']} A={fv.get('A','?')}/{bv.get('A','?')} AR={fv.get('AR','?')}/{bv.get('AR','?')} MA={fv.get('MA','?')}/{bv.get('MA','?')}")
        cnt += 1
        if cnt >= 15:
            break
