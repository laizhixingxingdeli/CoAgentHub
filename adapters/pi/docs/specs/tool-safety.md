# 托管会话工具安全底线

`src/extension.ts` 的 `tool_call` 对 bash/powershell 共用危险 git 拦截，协调者与执行者同样适用。拦截明显的 git push、commit、merge、rebase、cherry-pick、checkout/switch 分支切换（含新建分支）、reset --hard、branch -d/-D、stash drop/clear。提交按工作项由平台做检查点，拦截说明明确告知这一点。

checkout -- <paths> 的明确路径还原形式可放行；裸 checkout 目标存在文件/分支歧义，保守拦截。此能力沿用明显命令正则策略，不是完整 shell sandbox，不解析别名或动态 shell 拼接。

不新增文件读取限制或一般命令白名单。删除/改名专用工具不属于此能力实现。

关键测试位于 `src/extension.spec.ts`：用 stubPi 与 recordingClient 调用 executor 的 bash git commit，断言 block 与平台检查点说明；不调用真实模型或平台。
