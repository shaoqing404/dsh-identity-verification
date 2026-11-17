# DSH Touch ID 原生验证实验

这是独立 App bundle 内的 LocalAuthentication helper，身份为 `DSH Touch ID`，使用独立身份和运行数据。它只登记无副作用动作 `demo_verify`；固定的系统提示为「验证身份以继续演示」。

## 构建与无弹窗验证

从仓库根目录运行：

```sh
sh native/build.sh
# 用构建脚本打印的可执行文件绝对路径替换下面的占位符。
sh native/test.sh '/absolute/path/to/DSH Touch ID.app/Contents/MacOS/DSHTouchIDAuth'
```

每次构建生成独立的 `.lab/m3/native/build.*` 目录。构建包含 arm64 和 x86_64 slice，并仅使用本机 ad-hoc 签名；不安装、不修改 DSH。`test.sh` 测试纯参数解析、响应绑定、错误映射、截止时间及重复完成；随后只运行一次 `--check` 和两种必然无效的参数。它不执行认证。不同 CPU、系统版本及真实系统提示仍需分别实测；包含架构 slice 和签名通过不等于兼容性或可发布性验收。

## 命令和响应

可执行文件的 `--check` 独占使用，不接受其他参数：

```sh
'<helper 的绝对路径>' --check
```

结果为单行 JSON，包含 `schemaVersion: 1`、`operation: "check"`、`systemOwner`、`biometricsOnly` 和 `biometryType`。两项策略分别返回 `available` 和 `reason`，各使用新的、禁用交互的上下文，且都只调用 `canEvaluatePolicy`。`biometryType` 是生物识别探测时系统报告的类型；探测为 `none` 不应被扩展解释成硬件结论。可用性是当前瞬间的预检，不是认证结果，也不能保证随后认证成功。

经用户亲自接手并同意出现系统弹窗后，验证命令的格式为：

```sh
'<helper 的绝对路径>' --request-id 'Req-123' --action-id demo_verify \
  --policy system-owner --timeout-ms 30000
```

四个参数均必填、各一次；顺序不限。`request-id` 是 1–128 字节的 ASCII 字母、数字、连字符、下划线、点或冒号。`policy` 只能是 `system-owner` 或 `biometrics-only`；超时必须是 5000–120000 范围内不带前导零的十进制毫秒。未知参数、缺值、重复参数和非法值在创建认证上下文之前拒绝，输出 `operation: "invalid"`、`outcome: "error"` 和稳定的 `reason`，退出码为 2；无效输入不被回显。

合法请求输出单行 JSON：

```json
{"schemaVersion":1,"operation":"authenticate","requestId":"Req-123","actionId":"demo_verify","policy":"system-owner","outcome":"granted","reason":null,"method":"unknown","elapsedMs":1234}
```

`requestId`、`actionId` 和 `policy` 原样回显；`outcome` 为 `granted`、`cancelled`、`unavailable`、`timeout` 或 `error`。只有 `granted` 的退出码为 0，其他认证结果为 1。`method` 固定为 `unknown`：系统验证策略可能由系统选择密码、生物识别或 Apple Watch，helper 不推测具体方式。生物识别策略不提供应用密码后备。错误只输出稳定的 `reason`，不输出系统本地化错误文字、密码或指纹。

每次认证建立全新 `LAContext`，生物识别复用时长设为 0。系统回调和超时都汇入主队列，只处理第一次完成；到期后到达的成功作为超时，结束时使上下文失效。调用方仍需设置独立进程期限和处理进程意外退出；不能把退出码单独当作授权，必须核对 JSON 和三个绑定字段。

这个 CLI 本身不提供可信桌面来源、并发控制、调用者生命周期绑定或一次性消费。任何本机进程都可能调用它；在 Host 补齐这些控制并经过验收前，不接入 DSH 真实受保护操作。真实成功、取消、后备、超时、焦点恢复和其他实机结果均不由本测试证明。
