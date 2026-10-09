# 安全策略

CoAgentHub 是**本机开发工具**：HTTP 接口没有鉴权，只监听 127.0.0.1，执行者不在沙箱里。模型能做什么、不能做什么，已知的限制，见 [docs/security.md](docs/security.md)。

## 报告漏洞

请使用 GitHub 的 **Private vulnerability reporting**（仓库的 Security 页 → “Report a vulnerability”）私下报告。如果该功能没有开启，可以开一个 issue 说明“有一个安全问题想私下沟通”，**不要在 issue 里贴出利用细节**。

重点关心的类型：子进程环境过滤被绕过（密钥泄漏给 agent）、脱敏漏掉常见凭据形状、工具层约束（只读白名单、执行者权限）被绕过、状态文件或接口被诱导写出工作目录之外。

已经明确写在文档里的限制（无鉴权、无沙箱、标价花费不是账单）不算漏洞，但欢迎讨论改进。
