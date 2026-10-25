---
name: CoAgentHub — 工程校样
description: 任务与资源的 Figma 桌面设计规范；生产前端尚未同步
colors:
  paper: "#F5F3ED"
  white: "#FFFFFF"
  ink: "#222B35"
  muted: "#58616A"
  line: "#D6D5CE"
  accent: "#275D74"
  running: "#2457B2"
  select: "#E6ECEE"
  green: "#35654B"
  green-bg: "#E7EEE7"
  amber: "#8B5429"
  amber-bg: "#F0E6D7"
  red: "#A24138"
  red-bg: "#F4E5E1"
  nav: "#ECEAE2"
  disabled: "#B7B9B5"
typography:
  Page:
    fontFamily: "Noto Serif SC"
    fontSize: "32px"
    fontWeight: 500
    lineHeight: "44px"
  Section:
    fontFamily: "Noto Sans SC"
    fontSize: "18px"
    fontWeight: 500
    lineHeight: "28px"
  Record:
    fontFamily: "Noto Sans SC"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: "24px"
  Body:
    fontFamily: "Noto Sans SC"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  Emphasis:
    fontFamily: "Noto Sans SC"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "22px"
  Meta:
    fontFamily: "Noto Sans SC"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  Data:
    fontFamily: "IBM Plex Mono"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "20px"
  Identifier:
    fontFamily: "IBM Plex Mono"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: "28px"
rounded:
  control: "5px"
  output: "8px"
  region: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
  section: "44px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.white}"
    rounded: "{rounded.control}"
    typography: "{typography.Emphasis}"
  button-primary-hover:
    backgroundColor: "{colors.ink}"
  button-primary-disabled:
    backgroundColor: "{colors.nav}"
    textColor: "{colors.muted}"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    typography: "{typography.Body}"
---

# Design System: CoAgentHub — 工程校样

## Overview

**Creative North Star: "工程校样"**

用连续记录、明确的字体层级和对齐字段表达工程工作的可核对性。任务与资源是仅有的两个一级入口；状态、处理人、恢复方式和下一步分别表达，颜色不代替文字。

本规范记录已批准方向的 Figma 桌面设计与导航原型；生产 `src/web/` 尚未修改，接口、实时数据、真实保存及剪贴板均未接入。本轮数据与画板以 `.impeccable/review/p1-revision-manifest.json` 为索引，结构审计与逐项检查分别为 `p1-structural-audit.json`、`p1-spec-checklist.md`；页面策略和样本范围见 `.impeccable/surfaces/console.md`。结构检查数值只绑定其检查快照，不沿用为后续修订的最终验收。

**Key Characteristics:**

- 暖白纸面、墨色正文、细线分区与克制的交互强调。
- 长编号、原始 intent 和未知值保留真实的数据形状。
- 运行、人工处理、自动恢复与选择状态有不同的表达。
- 正文、辅助信息和数据均使用命名文字样式，字号不低于 13px。

## Colors

前置令牌是本方向的颜色依据。accent 用于交互与当前选择；running 蓝仅用于实际运行的圆点与文字，二者不得混用。主状态虽为“执行中”但正在等待人工处理时，保留“执行中”文字并使用琥珀色；自动恢复使用灰色时钟，已完成使用绿色，失败与中止使用红色。选中列表项使用浅蓝底与 2px 左侧线，页签使用下划线；这些选择标记不表示成功或失败。

**The 状态双编码 Rule.** 主状态、附加标记、处理人和下一步均配明确文字；图形、颜色只协助扫描，不隐去事实。

## Typography

页面文案保持克制：删除重复的角色职责介绍、设计示例声明、非实时注释及费用符号图例；保留字段内的估算、主控未计、未知等实际数据标记。没有独立决策价值的说明不在各页反复出现。任务事实信息带随之收紧至 40px，仅放实际字段；任务页签与其下方内容上移 24px，释放给输出的空间保留。最新截图为 `.impeccable/review/trim-*.png`。

Figma 使用上述八种命名文字样式：Page、Section、Record、Body、Emphasis、Meta、Data、Identifier，文本下限为 13px。Page 仅用于“任务总览”“模型资源”等固定页名；动态任务以完整编号作为身份标题，使用 Identifier，intent 使用 Body，不能将工作项短名当作 Mission 标题。

**The 字体分工 Rule.** 固定页名可用衬线，动态任务内容使用无衬线，编号、时间与计量使用等宽字体。

固定页名子集与样式位于 `.impeccable/assets/fonts/`，WOFF2 为 6436 字节，附 `fonts.css`、OFL 许可证、README、`measure_fallback.py` 和字宽检查。拟实施时同源分发，当前未接入生产静态服务。Pillow 已实际测量本机微软雅黑与 Consolas 的 92 项关键文本，覆盖任务字段、12 条候选的列表省略编号、抽屉完整编号及历史完整角色编号，均适合给定宽度；Figma 无这两种字体，不能据此声称画板已使用真实回退字体渲染，亦不代表完成全浏览器排版验收。

## Layout

任务总览与资源主画板保留 1440×1120；详情、证据与契约画板为 1440×1240。任务总览为 64px 高的五列记录，依次为编号/intent、主状态/附标、处理人/下一步、费用、更新时间，列宽为 400、194、290、144、100px。列表长编号中间省略，intent 一行截断并提供完整内容入口；详情编号完整，intent 默认两行。详情当前输出功能区高 566px，内部终端高 444px；已发生环节可展开为纵向历史，不将未来流程当作既成记录。其它宽度与移动端未验收。

## Elevation & Depth

工作流上方的任务事实另用 40px 高 nav 信息带归组，保留 16px 水平内缩进，归拢保障、协作、费用、外部会话说明及时间；与页签之间增加横向分隔。任务编号、intent 和当前状态仍为上一级信息。此模式同步到三层、直接主控和待检视详情及其页签变体，截图见 `.impeccable/review/header-grouping.png`。

分区强化：一级导航改用 ink 深墨底与白字，选中项继续使用浅底和 2px 左线；内容画布保持 paper。任务详情页头使用白色信息层，总览与候选表使用有边界的白色数据区域，分组与表头使用 nav 底色。工作流、实时输出和选中环节使用独立标题带与 1px 分隔，保持原有状态色和 64px 行高；不以新增装饰或逐行卡片划分区域。最新导出为 `.impeccable/review/sections-*.png`。

桌面 polish 约定：顶部同步信息与项目下拉垂直居中，并贴齐内容右边界；资源保存条以弹性摘要将按钮组推至右侧内边距。总览分组标题跟随表格的 16px 行内缩进；TimelineStep 的身份信息固定保留两行（40px），使各步骤的结果与时间基线一致，控件与步骤区域不重叠。尚待确认的行数使用 muted，不借用成功色。截图与检查见 `.impeccable/review/polish-*.png` 和 `polish-audit.json`，范围仍为现有桌面 Figma 原型。

整体无阴影，通过纸面、浅灰米色时间线和白色功能区建立层次。完整输出区与选中环节区使用 1px 边界、24px 内边距及约 32px 分区间距；普通记录不逐项套卡片。

## Shapes

控件为轻微圆角，完整功能区使用较大圆角，输出正文区圆角较小。列表选择采用细左线，导航选择采用浅底；页签选择采用下划线，不能用状态标签代替导航。

## Components

已建立 11 个共享组件集，覆盖导航、页签、语义状态、按钮、输入与选择、开关、提示、运行记录及列表单元；长历史使用 TimelineHistoryRow。共享实例复用命名文字样式与语义颜色，不为单个画板另造一套。按钮有默认、悬停、焦点、禁用、加载和失败表达；保存失败时按钮保持可重试样式，错误信息显示在下方，禁用时使用浅底深字。

资源每个角色维护一份草稿与一条保存栏，整角色配置携带 revision 提交；空角色不显示保存栏。候选编辑只改对应角色草稿，不另建逐候选保存边界。profileId 只读，长编号中间省略并可悬停看完整值；endpoint 来自合成目录项，runtime 为 pi，facts 使用键值输入框，另有 enabled 与顺序，不将思考档捏造成候选顶层字段。冲突时禁用保存，重新载入入口只由冲突触发。健康正常时不虚构失败记录，额度自动重置与充值后人工复位分开说明；原型状态跳转不等于真实执行。

## Do's and Don'ts

- **Do** 用同一组命名文字样式和共享组件表达长数据、等待原因与操作状态。
- **Do** 区分主状态与暂停附标、实际执行与历史选择、估算费用与未知费用。
- **Don't** 用工作项短名替代完整 Mission 身份，或用未来固定阶段伪造已发生的执行。
- **Don't** 把示例数量、费用、报告和原型连线表述为在线平台事实或真实接口能力。
