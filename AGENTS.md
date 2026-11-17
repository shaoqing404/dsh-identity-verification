# 开发入口

先读 README.md、docs/validation.md、docs/specs/session-protection.md。当前只验证系统身份自检，下一阶段会话保护仍为计划。

- 所有实验状态放在 `.lab/`，不读取或迁移日常 DSH 的 profile、会话和凭据。
- 按 README 运行相关 Node 回归，提交前执行 `git diff --check`。
- 不把合成通过、一次本人认证、全部实机验收或可发布当作同一状态。
- 原生安全设置、调用来源、一次性绑定和终止语义是既有约束。
- Python 如有需要使用 uv，不改系统 Python。
