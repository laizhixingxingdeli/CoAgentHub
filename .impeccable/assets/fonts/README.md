# 字体交付与回退复核

`NotoSerifSC-fixed-names-medium.woff2` 为 Noto Serif SC Medium 的固定页名子集，大小 6436 字节，包含任务总览、模型资源及设计说明用固定名称。来源为 Google Fonts 仓库的 `ofl/notoserifsc/NotoSerifSC[wght].ttf`，许可证原文见 `OFL.txt`。

实施时将子集和 `fonts.css` 随前端同源分发；只有固定页名使用衬线，字体加载失败退回微软雅黑或无衬线。动态任务内容使用无衬线，编号与数据使用 `IBM Plex Mono, Consolas, monospace`。当前是设计交付资产，尚未接入生产静态服务或修改 `src/`。

`prepare_fonts.py` 使用 fontTools 固定 wght=500 后取子集，并通过 Pillow 读取本机 `C:/Windows/Fonts/msyh.ttc` 与 `consola.ttf` 测量关键文字。字宽结果见 `font-width-check.json`；这是实际本机字宽检查，不代表完成全浏览器或移动端排版验收。微软雅黑与 Consolas 只用于本机检查，没有复制或再分发。

Figma 可用字体没有微软雅黑或 Consolas，画板使用命名的 Noto Sans SC 与 IBM Plex Mono 样式；生产回退差异以字宽检查和后续浏览器验证为准，不能声称 Figma 已使用本机回退字体渲染。
