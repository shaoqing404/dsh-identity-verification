# 原生实验组件

当前发布是源码实验，尚无一条从干净 Mac 自动准备到可用原生插件的安装命令。普通安装只提供合成演示。请不要将下述组件说明当作生产安装教程。

## 已有源码

| 文件 | 作用 |
| --- | --- |
| `native/build.sh` | 在新 `.lab/m3/native/build.*` 目录构建独立的通用 helper，使用本机 ad-hoc 签名 |
| `scripts/native-auth-preload.cjs` | 仅在 dsh-app 主框架暴露有限原生接口 |
| `scripts/native-source-guard.mjs` | 窗口、主框架、文档代次、来源和 Renderer 设置检查 |
| `scripts/native-auth-adapter.mjs` | 展示固定用途、核验 helper 与回执、撤销在途请求 |
| `scripts/native-host-launch.mjs` | 为实验 Host 增加继承的私有通道并限制 Host 文件范围 |
| `scripts/derive-native-shell.mjs` | 在实验副本中派生一处 spawn 导入，不修改已安装的 App |
| `scripts/lab-native.sh` | 仅启动已准备好的独立目录，清空继承环境并设置独立 profile 与用户数据 |

## 尚需准备的本机环境

实验验证使用用户自行从官方取得并核验的 DSH `0.2.2-rc.3` 和 Electron `44.7.0`。运行时、提取的上游文件、profile、helper 摘要清单和所有运行数据留在 `.lab/`，均不随源码分发。脚本使用的固定实验路径列在 `scripts/lab-native.sh` 中。

仍需完善从下载校验、只向新目录提取、profile 初始化、复制适配文件、生成 helper 清单到安装 bundle 的可复现准备工具，并在干净 Mac 完成安装、卸载和回退。上述交付完成前，不建议在日常 Desktop 内手工接入这些文件，也不将源码公开称作原生分发验收通过。

## 不弹窗的 helper 验证

在 macOS 安装 Xcode Command Line Tools 后，从仓库根运行：

```sh
sh native/build.sh
# 将构建输出的绝对可执行路径传给测试脚本。
sh native/test.sh '/absolute/path/to/DSH Touch ID.app/Contents/MacOS/DSHTouchIDAuth'
```

测试只运行参数/错误/期限逻辑与 `--check`，不会发起真实身份验证。真实系统面板由本人确认并完成。当前用途固定为无副作用的 `demo_verify`。
