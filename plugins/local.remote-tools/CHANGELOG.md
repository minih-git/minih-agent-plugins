# Changelog

## 0.1.0 — 2026-09-28

首次公开的 PI-Desktop 独立适配版本，基于锁定的 `@oresk/pi-remote-tools@0.2.0`；不是上游作者的官方 Desktop 发布。

- 提供 `ssh-read`、`ssh-write`、`ssh-edit`、`ssh-bash` 四个工具，通过 `contributes.agentExtensions` 加载。
- 使用 Desktop 兼容的 Bash helper，去除 CLI/TUI 渲染依赖。
- 有界 SSH 输出、整体超时、取消与写操作排队处理；强制无交互认证和严格主机密钥验证。
- 读取摘要按扩展实例隔离，相对路径以远端 HOME 为基准，编辑替换保留字面值语义。
- 统一大小文件行数、越界错误及续读提示；处理 Bash 输出截断和分块时的 UTF-8 字符边界。
- 原创适配以 MIT 开源，保留上游来源声明；补齐英文、简体中文描述及高风险权限说明。

### 验证与限制

macOS / Node 22 下 32 项离线测试使用受控 SSH 替身通过；不是生产主机或宿主端到端验证。真实 SSH、Windows 和真实 csh/tcsh 未验证。取消本地 SSH 不保证远端后台进程停止；中断写入可能留下临时文件；读取摘要检查不是远端事务或原子文件快照。

### English summary

First public, independent PI-Desktop adapter release. Provides four SSH tools with bounded, cancellable transport; consistent read windows and UTF-8-safe Bash tails; MIT licensing for original adapter contributions; and complete English / Simplified Chinese metadata. Uses existing SSH authentication and strict host-key verification. Offline tests are not a guarantee of host loading, live SSH interoperability, or remote process termination.
