from pathlib import Path
import json
from PIL import ImageFont

root = Path(__file__).parent
manifest = json.loads((root.parents[1] / 'review/p1-revision-manifest.json').read_text(encoding='utf-8'))
report = []
def check(role, text, font, size, width):
    path = 'C:/Windows/Fonts/consola.ttf' if font == 'Consolas' else 'C:/Windows/Fonts/msyh.ttc'
    f = ImageFont.truetype(path, size, index=0)
    measured = round(f.getlength(text), 2)
    report.append(dict(role=role, text=text, font=font, sizePx=size, widthPx=measured, availablePx=width, fits=measured <= width))
for d in manifest['tasks']:
    check('完整编号标题', d['id'], 'Consolas', 20, 1176)
    clipped = d['id'] if len(d['id']) <= 43 else d['id'][:31] + '…' + d['id'][-11:]
    check('列表编号', clipped, 'Consolas', 13, 400)
    check('附加标记', d['marks'], 'Microsoft YaHei', 13, 194)
    check('处理人', d['owner'], 'Microsoft YaHei', 14, 290)
    check('下一步', d['next'], 'Microsoft YaHei', 13, 290)
    check('费用', d['cost'], 'Consolas', 13, 144)
    check('更新时间', d['date'], 'Microsoft YaHei', 13, 100)
for d in manifest['candidates']:
    clipped = d['id'] if len(d['id']) <= 31 else d['id'][:19] + '…' + d['id'][-11:]
    check('候选列表中间省略', clipped, 'Consolas', 13, 248)
    check('候选抽屉完整编号', d['id'], 'Consolas', 13, 344)
    check('历史完整候选与角色', '协调者 · ' + d['id'] + ' · 高', 'Microsoft YaHei', 13, 624)
(root / 'font-width-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'checks': len(report), 'allFit': all(r['fits'] for r in report), 'failed': [r for r in report if not r['fits']]}, ensure_ascii=False))
