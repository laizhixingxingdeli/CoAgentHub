from pathlib import Path
import sys, json
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'font-tools'))
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset
from PIL import ImageFont

root = Path(__file__).parent
font = TTFont(root / 'NotoSerifSC-source.ttf')
font = instantiateVariableFont(font, {'wght': 500}, inplace=False)
options = subset.Options()
options.flavor = 'woff2'
options.recalc_bounds = True
subsetter = subset.Subsetter(options=options)
subsetter.populate(text='任务总览模型资源交付与验证组件数据状态 0123456789')
subsetter.subset(font)
font.flavor = 'woff2'
font.save(root / 'NotoSerifSC-fixed-names-medium.woff2')

yahei = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 13, index=0)
consolas = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 13)
full_id = 'MiRing-Notification-Correlation-Recovery-20261014'
short_id = full_id[:31] + '…' + full_id[-11:]
samples = [
    ('任务编号完整', full_id, consolas, 400),
    ('任务编号中间省略', short_id, consolas, 400),
    ('处理人', '检视者 · 不会自动恢复', yahei, 290),
    ('下次重试', '平台 · 14:36 自动重试', yahei, 290),
    ('候选身份', 'L1 · candidate-B · 中', yahei, 240),
    ('日期', '10-24 18:02', yahei, 140),
    ('额度', '剩 65% · 11-01 重置', yahei, 184),
]
report = [{'role': role, 'text': text, 'font': 'Consolas' if f is consolas else 'Microsoft YaHei', 'sizePx': 13, 'widthPx': round(f.getlength(text), 2), 'availablePx': width, 'fits': f.getlength(text) <= width} for role, text, f, width in samples]
(root / 'font-width-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'subsetBytes': (root / 'NotoSerifSC-fixed-names-medium.woff2').stat().st_size, 'widthChecks': report}, ensure_ascii=False))
