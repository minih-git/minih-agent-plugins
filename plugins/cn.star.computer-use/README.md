# Computer Use

PI-Desktop 的 Windows 桌面控制插件，附带 Office 知识和应用操作技能。

## 安装

导入 `dist/cn.star.computer-use-0.4.0.piplug`，彻底退出 PI（含托盘）后重新打开。

桌面控制需要本机 cua-driver。打开 **Computer Use: Open Panel** 检查状态；未安装时可在面板确认安装。

原生辅助功能优先使用可用的 PowerShell 7（`pwsh.exe`），未安装或版本探测失败时回退 Windows 自带的 PowerShell 5.1，无需额外安装。插件从 PATH 和标准安装目录查找 7，首次执行前做有时限的只读版本探测并缓存选择；安装或移除 PowerShell 后重启 PI 可重新探测。按键、焦点检测、读值、图像处理、提示条与驱动安装使用同一选择逻辑。业务操作失败不会切换运行时重放。

## Office 能力

| 层 | 内容 |
|---|---|
| `office-workflows` | Excel 公式与数据类型、Word 样式与章节、PPT 大纲与布局、结构和视觉验收 |
| `office-desktop` | Excel / Word / PowerPoint 及 WPS 的界面操作流程；先定位、后输入、再核验 |

Agent 按任务加载技能：用 `office-workflows` 规划和验收内容，用 `office-desktop` 操作 Office/WPS 界面。知识技能可独立使用；桌面操作需要本机安装相应应用。

## 桌面操作

先观察窗口，再操作；输入已发送不等于任务完成。优先名称控件和键盘导航，结果不明时先核验，不盲目重试。物理 Esc 或面板停止可中断桌面控制。

内置拒绝密码管理器、终端、锁屏、Windows 安全中心、PI-Desktop、ChatGPT 和 Codex。

## Office 回归修复

- 新鲜快照中带有效 token 的明确控件可独立操作，避免因整树不完整而拒绝保存面板和菜单；取消确认仍要求完整证据。
- Office 原生按键和粘贴保留所属弹窗焦点；直接输入不自动选中其他搜索框。
- UIA 超时时可仅补采一次截图，保留原操作结果及树错误，不重放输入。
- 修复 Windows PowerShell 中文 `read_value` 参数编码，补充 `Shift+End` 等选区键和 `Ctrl+Shift+S`。
- Office 技能补充弹窗发现、保存重开和 PowerPoint 缩略图/文本焦点区分。
- 查询过滤和动作后独立采集的新快照可继续操作本次展示的控件，减少无必要的 `stale_tree`；旧索引不会自动重试。
- 标准保存框的精确读取补充同进程、可验证归属的对话框根；跨根去重并保持完整搜索、唯一匹配与密码保护。
- 通过普通 C# 调用入口初始化 .NET UIA 标准控件代理，修复 PowerShell 动态调用导致文件名 Edit 被识别为 Pane、精确读取持续 `no_match` 的问题；保留原有名称、角色和唯一性校验。
- 原生激活只尝试一次，再短时检查实际前台归属；窗口关闭后的前台验证通过独立窗口列表报告，不把未发送或未知发送改成成功。
- 动作后的 UIA 空树或抓取失败会补做独立完整窗口列表验证；cua-driver 0.28.2 的全量枚举实测可能超过 2 秒，因此验证预算为 5 秒。确认原目标消失时报告 `target_window_closed`；无法确认时通过 `window_verification.status=inconclusive` 和 `reason` 区分超时、列表问题或目标仍存在。保留原始发送状态，不把窗口关闭当成保存成功。
- 修复 `perform_secondary_action` 将 `Select` 等动作误映射为 `Invoke`。当前驱动只支持明确的 Invoke、SetValue 和定向滚动映射；Select、Toggle、Expand、Collapse、ScrollIntoView、SetFocus 及未知动作返回 `unsupported_secondary_action / not_sent`，不再误打开文件。选择文件请使用经过核验的键盘导航或截图定位的单击。
- Delete/Backspace 及其 Ctrl/Shift 组合不再自动寻找并聚焦编辑框，避免 Explorer 已选中文件时把焦点抢到地址栏；保留当前焦点与单次发送语义。文件选中状态不等于键盘焦点，清理优先使用新鲜观察中的“删除”命令。

## 测试与打包

```powershell
# 从插件目录运行；PI_SCRATCH_DIR 应指向本次会话的临时目录
$env:TEMP = $env:PI_SCRATCH_DIR
$env:TMP = $env:PI_SCRATCH_DIR
$env:TMPDIR = $env:PI_SCRATCH_DIR
node --test --test-reporter=tap tests/*.test.js
```

Windows 上的回归覆盖本机 5.1 和已安装的 7，包括脚本/C# 编译、UTF-8、模拟输入边界和实际图像裁剪。真实标准保存框读值测试需显式设置 `$env:COMPUTER_USE_NATIVE_DIALOG_TEST = '1'` 后运行 `node --test tests/value-standard-dialog.test.js`；它只读取自己的测试对话框，不发送输入或保存文档。

用 PI-Desktop 的 `PluginCheck` / `PluginPack` 检查和打包 `pi-computer-use`，不要手工压缩 zip。

## 协议与来源

插件 MPL-2.0。cua-driver 为 MIT，运行库不捆绑。Office 技能提炼自 GenOffice 社区项目（Apache-2.0）的公开技能和工作流并为本插件改写，来源及范围见 `THIRD_PARTY_NOTICES.md`。
