# Changelog

## 0.1.3 — 2026-10-21

接上宿主新增的 `pi.browser.openInPanel`（Desktop ADR 0335）：「打开页面」现在能真正把页面放进工作面板的浏览视图，不再依赖浏览面板是否正被显示。

- 优先调用 `openInPanel({ path })`：由宿主校验路径、渲染器决定用哪个会话开标签；调用被拒时按原因码提示。
- 旧宿主没有该方法时自动回退到 `navigate`，再退系统浏览器——三段落空都能工作。
- 新增 1 项测试覆盖「有 openInPanel 时不走 navigate」；合计 31 项通过。

## 0.1.2 — 2026-10-21

改对「页面在哪、回复怎么收尾」：作者原先以为内置浏览器只能靠插件权限打开，实际宿主把**回复里的链接**当作另一条通道——指向项目或会话临时目录内 `.html` 的链接由工作面板自己打开，不需要任何权限。

- 技能默认改为写入 `$PI_SCRATCH_DIR/answers/<topic>.html`，回复末尾给带标题的普通链接，点开即在应用内置浏览器；要长期留存才写库目录并用卡片收尾。
- 面板新增第三个目录来源：会话临时目录（`<dataDir>/scratch/<session>/answers`），按真实存在页面的会话列出，行上标「会话临时目录」，可打开、复制路径、删除。
- 数据目录由 `pi.plugin.getDataPath()` 反推，数据目录被搬迁的安装也能找到 scratch 存储。
- 新增 2 项测试（scratch 目录发现、合并列举与标记）；合计 30 项通过。

## 0.1.1 — 2026-10-21
## 0.1.1 — 2026-10-21

修掉「打开页面」总是落到系统浏览器、却给出一句没核实过的原因：卡片原本文案写死「应用内浏览面板没打开」，而真实原因可能是面板不是当前标签页、属于其他会话、权限未授予或加载失败。

- `onRendererCall("openPage")` 现在把宿主返回的原因码一起带回（`UNAVAILABLE` / `OTHER_SESSION` / `PERMISSION_DENIED` / `NO_API` / `LOAD_FAILED` / `UNKNOWN`），卡片按码给一句对应提示，不再猜。
- 新增测试锁住这条规则，并修掉测试之间共享「权限被拒」标志导致偶发失败的问题（受影响的用例改为加载全新模块）。
- 行为不变：仍是先试内置浏览面板，被拒后退回系统默认浏览器。

## 0.1.0 — 2026-10-21

把上游技能 `answer-me-with-html`（v0.5.6，MIT，commit `e00b254`）移植成
Minih-Agent-Desktop 插件：技能与内置 `am` CLI 原样打包，新增宿主说明、回复卡片、
面板、两个命令和一个设置项。

- 技能：`contributes.skills` 提供 `answer-me-with-html`，Agent 按需加载；内置
  `scripts/am.mjs`（单文件、无需安装依赖，仅需 Node 20+），由 Agent 通过 Bash 调用。
- 回复卡片（`renderer` 插槽，`minih.answer-me-with-html:page` 围栏）：回复末尾由
  插件在对话里画一张卡片，显示页面标题、所在位置（页面库 / 临时目录 / 其他位置）、
  体积与时间，两个按钮分别「打开页面」（交给系统默认程序）与「复制路径」；只显示
  文件名，完整路径放在 tooltip。状态：读取中 / 打不开（附原因，且此时不出按钮，
  不留死按钮）/ 围栏里没有路径时只给提示。插件未安装时同一段围栏退回代码块，路径
  依然可读。做成卡片而不是内嵌页面，是因为宿主渲染器 CSP 为 `default-src 'self'`
  且无 `frame-src`，项目外的页面无法作为 iframe 嵌入回复。
- 不再要求写裸 `file://` 链接：本宿主里点击指向工作区外文件的链接只会弹出
  「在文件管理器中显示 / 复制绝对路径」，比一个按钮更差。
- `SKILL.md` 加了一节「Host: Minih-Agent-Desktop」（技能目录取 Skill 工具的
  `Location:` 行、本宿主没有斜杠命令、回复以卡片收尾、页面落在哪个目录、什么情况下
  才值得出页面），其余与上游一致。
- 面板：列出 CLI 生成的页面（标题、文件名、时间、体积），可打开、复制路径、删除
  单个页面、清理旧页面；顶部给出数据目录与 pages / videos / 配音缓存的占用。
  破坏性按钮都是两步确认（第一次点=上膛，第二次才执行）。
- 面板与 CLI 认同一批目录：`<AM_HOME 或 ~/.answer-me-with-html>/pages`，以及 CLI
  在数据目录不可写时的兜底目录 `<tmpdir>/answer-me-with-html-<uid>/pages`（仅在它
  存在且为当前用户私有目录时才读取，行上标出「临时目录」）。
- 不提供 always-on：只有当「图比文字更省事」时才出页面（流程 / 架构 / 状态机 /
  生命周期、三维以上对比、多因排查、层级，或用户要求画图），简单结论、单因、
  一行修复保持纯文本。想要每条回答都出页面，把 always-on 规则写进
  `~/.pi/agent/AGENTS.md` 即可（README 里两句话可复制）。
- 打开页面改为先请应用内置浏览面板显示（`pi.browser.navigate`，需 `browser.cdp`），被拒时退回系统默认浏览器，卡片会说明实际落在哪一边。之所以有退路：宿主浏览面板只在自己是当前可见的工作面板标签页、且带活跃会话时才接受导航，而卡片按钮来自 renderer 调用、没有会话——所以内置浏览器这条路在「浏览面板已打开」时生效。权限被拒时只在首次尝试后记住，之后直接走系统浏览器，不重复写被拒的审计记录。
- 命令：`Answer me with HTML: Open panel`、`Answer me with HTML: Open pages folder`；
  设置：`cleanupDays`（默认 30 天，供清理按钮使用）。
- 批量清理调用 CLI 自己的 `am clean`，不重新实现「旧」的判定。
- 未申请文件权限：页面目录在工作区之外，宿主文件网关以工作区为根，到不了那里，
  因此由插件进程自己的 Node fs 读写；插件自己守三条规则——只碰 CLI 的 pages 目录、
  只认其中单个 `.html` 文件名、删除前校验真实路径仍直接位于该目录。卡片带来的路径
  来自回复文本，读写或打开之前按同一套规则校验。无网络访问。
- 离线验证：31 项 `node --test`（命名与列表规则、两个目录的合并与私有性判断、目录
  占用、卡片通道的校验与打开路径、真实 CLI 端到端渲染与清理）通过；卡片在真实
  浏览器里以四种状态渲染并点过按钮；`pi-plugin check` 无错误。

### English summary

Ports the upstream `answer-me-with-html` skill (v0.5.6, MIT, commit `e00b254`)
into a Minih-Agent-Desktop plugin: the skill and its bundled `am` CLI ship
unchanged, plus a host note, a reply card, a page panel, two commands and one
setting. A reply now ends with a card the plugin draws through a renderer slot —
page title, where it lives, size, time, and buttons that open it or copy its path
— instead of a bare `file://` path or URL. An inline iframe is not possible: the
host renderer's CSP is `default-src 'self'` with no `frame-src`. The panel lists,
opens, copies, deletes and cleans the pages the CLI wrote, across both folders the
CLI itself uses (its data directory and, when that was not writable, its private
temporary fallback); bulk cleaning runs the CLI's own `am clean`. There is no
always-on mode: a page is made when a picture carries the answer. The plugin
requests no file permission and touches only those `pages/` folders, one regular
`.html` file at a time, and the card's path is checked the same way before use.
Thirty-one offline tests pass, and the card was rendered and clicked in a real
