# 代码度量告警

`src/application/code-metrics.ts` 接收源码路径与文本，近似报告文件超过 400 行、函数超过 40 行、参数超过 4 个、嵌套超过 3 层、复杂度达到 15 及 src 相对依赖环。复杂签名、表达式箭头、读取失败等列为未分析，近似结果需人工核对；不承担语法检查。

`node scripts/code-metrics.ts [--changed <基线>]` 或 `npm run metrics -- --changed <基线>` 默认扫描 src 的 ts/js，改动模式按全图计算环，只报告涉及改动文件的告警。只读源码、不加依赖、退出码始终 0。交卷附件的可选 `codeMetrics` 字段保存告警和未分析列表；附件不可用只说明原因，不影响交卷或合入判定。

验证使用 `test/code-metrics.test.ts` 的函数与依赖环夹具，以及 `test/machine-finalize.test.ts` 的真实临时 Git 仓库交卷，证明告警存在时仍可终审合入。
