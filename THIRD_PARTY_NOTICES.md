# 第三方来源

本仓库提供本项目的插件、实验适配脚本与 Swift helper 源码，不包含 DeepSeek Harness、Electron、Node.js 的发行包或提取后的上游源码。

本项目的 MIT 许可覆盖本项目原创内容，不重新许可截图中的第三方界面、名称和标识；相应权利归各自所有者。

- DeepSeek Harness 的接口、bundle 规范与实验目标来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.3)，上游使用 [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/LICENSE)。本机派生脚本只在用户自行准备的实验目录生成一个 main 导入适配；任何进一步分发应保留上游及依赖要求的声明。
- 实验说明涉及的 [Electron](https://github.com/electron/electron) 使用 MIT 许可证，其发行包还带有其他第三方组件及许可；本项目不分发该运行时。
- Swift helper 调用 Apple 平台提供的 AppKit 与 LocalAuthentication API，开发和运行环境由使用者自行提供。
- 演示截图展示实际 DSH 界面，仅用于说明集成。DeepSeek 名称、Logo 与其他商标归各自所有者，不代表官方合作或背书。
