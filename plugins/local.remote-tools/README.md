# Remote SSH Tools — PI-Desktop 插件

为 PI-Desktop 0.15.9 及兼容版本适配 `@oresk/pi-remote-tools@0.2.0`。插件 ID：`local.remote-tools`，版本：`0.1.0`。这是独立开源适配版，不是原作者发布的 Desktop 插件。

## 为什么全局 npm 安装后无法调用

原包声明 `pi.extensions`，Desktop 不会自动导入 CLI 的包注册表。仅导入原包也存在兼容问题：其入口立即调用 `createBashToolDefinition`，Desktop Agent 扩展 shim 没有该 helper。此适配使用官方 `contributes.agentExtensions`，替换该依赖并删除终端 TUI 渲染，保留 SSH 文件操作。来源和改动见 `UPSTREAM.json`。

## 安装

1. 在 Desktop 的插件页面选择「安装本地插件包」，打开由 PluginPack 生成的 `local.remote-tools-0.1.0.piplug`。也可选择「加载开发插件」，选中本目录。
2. 阅读并确认 `agent.extension` 权限，再启用插件并允许当前项目使用。此权限为高风险：代码运行在 Agent sidecar，可调用 Node 和系统 SSH，不受普通插件权限网关的完整约束。
3. 返回 Agent 会话，在下一轮查找或调用 `ssh-read`、`ssh-write`、`ssh-edit`、`ssh-bash`。如果当前会话尚未刷新工具，另开会话重试。
4. 若之前加载过脚手架示例，必须在插件页面重新加载本目录并重新审核新增权限；保存文件不会自动授予 `agent.extension`。不要重复安装同 ID 的开发版和打包版。

模块入口已通过插件目录的 `package.json` 固定为 CommonJS，扩展及兼容模块使用 `.mjs`，不受父目录 `type: module` 干扰。

## SSH 前提

本机需有系统 `ssh`，对应 host alias/用户名配置、已核实的 known_hosts 记录及可无交互使用的密钥或 SSH agent。插件使用已有 SSH 配置，不包含私钥、密码或凭证，也不会修改配置。

连接强制 `BatchMode=yes` 与 `StrictHostKeyChecking=yes`：不弹密码、不自动接受陌生主机指纹。若终端可连接但 Desktop 失败，请核对 Desktop 进程可见的 SSH agent 与密钥配置，不要以关闭主机验证代替排查。首次建立信任应由用户在可信渠道核验主机指纹后完成。

## 四个工具

| 工具 | 必需参数 | 可选参数 |
|---|---|---|
| `ssh-read` | `host`, `path` | `offset`（1 起始）, `limit` |
| `ssh-write` | `host`, `path`, `content` | 无 |
| `ssh-edit` | `host`, `path`, `edits` | 每项可设 `replaceAll` |
| `ssh-bash` | `host`, `command` | `timeout`（1–100 秒，默认 90） |

只读示例（`myserver` 是占位 host，未实际连接）：

```json
{
  "host": "myserver",
  "path": "/etc/os-release",
  "limit": 10
}
```

精准编辑参数：`edits: [{ oldText: "原文本", newText: "新文本" }]`。先用 ssh-read 读取；若远端变化，ssh-edit 会拒绝旧摘要对应的编辑。默认要求唯一匹配；显式 `replaceAll: true` 才替换所有匹配。替换文本中的 `$&` 等保持字面值。

## 行为与限制

- 绝对路径保持远端含义；相对路径和 `~` 以远端 HOME 为基准，不映射到本地工作区。
- 文件内容通过 base64/stdin 传输；写入通过同目录临时文件替换，保留已有文件权限。ssh-write 与 ssh-edit 的结果均不得超过 8 MiB，捕获输出上限 16 MiB。
- 读取超过 1 MiB 的文件时使用行窗口；呈现输出上限约 2000 行/50 KiB。过大的 limit 或超长行若使远端输出超过 16 MiB，会明确报错，而不是无限缓冲。Bash 仅保留最后 50 KiB 输出。
- 文件工具整体超时 90 秒；Bash 整体超时包含主机探测，最多 100 秒，留出 Desktop 调用及清理余量。排队等锁同样响应取消和 deadline，取消的排队写入不会随后补执行。
- 无 bash 的主机回退到 POSIX sh。取消/超时会终止本地 SSH 进程，但不保证远端后台进程终止，或远端 shell 一定执行清理 trap。中断写入可能遗留同目录 .pi-ssh* 临时文件；不会按前缀自动批量删除，以免误删其他写操作的文件。
- 同一路径的写操作在本进程内串行，读取摘要按扩展实例隔离；这不是可排除其他程序并发写入的远端事务。
- 离线测试在 macOS/Node 22 下执行，包含非 POSIX 元数据分支的替身验证；未做真实 csh/tcsh、Windows、真实 SSH 或当前 Desktop 会话端到端验证。极端 close 事件不返回时的 1.2 秒兜底尚未单独模拟。

## 开发与验证

在项目根目录运行：

```sh
npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
npm run check
```

测试要求 `PI_SCRATCH_DIR` 指向可写 scratch 目录，只执行 SSH 替身，不连接真实主机。构建脚本校验上游 SHA-256 后生成 `extension.mjs`，勿手改此文件。运行时的 TypeBox 由 Desktop 官方扩展加载器提供，安装本插件无需 npm 安装依赖。

插件由 PluginScaffold 建立，随后执行 `PluginCheck({ directory: "remote-tools" })` 和 `PluginPack({ directory: "remote-tools" })`。不得用普通压缩 zip/tar 代替 PluginPack。macOS / Node 22 下的源码与解包产物离线测试各 32/32 通过；校验通过不等于宿主已经加载或远程连接成功，未验证的环境与边界见上文。

## 开源与许可

源码仓库：https://github.com/jiege6-66/pi-desktop-remote-tools 。原创 Desktop 适配部分采用 MIT，版权归 `jiege6-66`，完整许可见 `LICENSE`；上游代码保留其来源与许可声明，见 `THIRD_PARTY_NOTICES.md`。插件中心实际审核/上架状态以平台为准，不将本地打包视为已经上架。
