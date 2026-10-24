import ForceGraph3D from "./vendor/3d-force-graph.mjs";
import ForceGraph2D from "./vendor/force-graph.mjs";
import { FIXTURE_GRAPH, FIXTURE_NOTES } from "./fixture.js";

/**
 * Bilingual UI strings (en & zh-CN), selected by navigator.language prefix
 * with manual toggle in the header.
 */
const STRINGS = {
  "zh-CN": {
    title: "知识宇宙",
    fixtureBadge: "演示数据 · FIXTURE",
    searchPlaceholder: "搜索笔记标题或路径 (按 / 聚焦)…",
    searchNoMatch: "未找到匹配的笔记节点",
    healthBtn: "健康度",
    filtersBtn: "筛选",
    legendBtn: "图例",
    zoomFitTitle: "居中适配全图",
    langSwitchLabel: "EN",
    focusActivePrefix: "二跳聚焦：",
    filtersHeading: "星图筛选",
    resetBtn: "重置",
    filterClassLabel: "本体类别",
    filterProjectLabel: "所属星系 (项目)",
    filterStabilityLabel: "稳定性",
    allClasses: "全部类别",
    allProjects: "全部项目星系",
    noProjectHalo: "无所属项目 (外环光晕)",
    allStabilities: "全部稳定性",
    toggleStale: "仅显示待复核 (Stale)",
    toggleEvents: "事件卫星 (Moons)",
    toggleNavigation: "导航节点 (MOC/Index)",
    toggleWeakLinks: "正文弱引用 (Wikilinks)",
    toggleGhosts: "未解析幽灵节点 (Ghosts)",
    toggleArchived: "归档星尘 (Archived)",
    toggleMemory: "记忆卫星 (Memory)",
    memoryUnavailableTip: "记忆卫星不可用 ({status}) — 0.3.0 启用 memory.read 后开放",
    memoryOkTip: "切换显示个人记忆卫星 ({count})",
    legendHeading: "天体与关系图例",
    legendPredicatesTitle: "类型化关系谓词",
    legendHealthTitle: "健康度模式 (半径 = log2 字符数)",
    healthHeading: "本体健康诊断表",
    healthRegionAria: "知识库本体健康问题列表",
    healthFilterAll: "全部严重度",
    healthFilterRed: "未知词表 (UNKNOWN_*)",
    healthFilterAmber: "本体违规 (VIOLATION / LEGACY)",
    healthFilterMuted: "体积 / 孤立 / 过期 (OVERSIZE / ORPHAN / STALE)",
    thPath: "笔记路径 / 标题",
    thClass: "类别",
    thChars: "字符数",
    thIssues: "问题代码",
    healthEmpty: "当前筛选条件下无本体健康问题",
    timelapsePlay: "演化",
    timelapsePause: "暂停",
    timelapseLabel: "时间演化 (按创建日期)",
    timelapseAll: "全部时间 ({count} 节点)",
    timelapseCutoff: "截至 {date} ({count} 节点)",
    drawerCopyLink: "复制 Obsidian 链接",
    drawerFocusSubgraph: "聚焦二跳星系",
    drawerExitFocus: "退出聚焦模式",
    drawerPromoteMemory: "固化为笔记 (P4)",
    secProps: "元数据属性",
    secIssues: "本体校验问题",
    secRelations: "类型化关系 (按谓词分组)",
    secBacklinks: "反向链接 (Backlinks)",
    secOutline: "笔记大纲 (Outline)",
    secPreview: "正文预览",
    truncatedBadge: "已截断 (≤8,000 字符)",
    redactedBadge: "已脱敏 (REDACTED)",
    staleBadge: "待复核 (STALE)",
    propClass: "本体类别",
    propFamily: "本体族",
    propStatus: "状态",
    propStability: "稳定性",
    propCreated: "创建日期",
    propUpdated: "更新日期",
    propVerified: "复核日期",
    propChars: "字符规模",
    propDegree: "连接度",
    propProject: "所属项目",
    propSha: "SHA-256",
    emptyIssues: "无本体校验问题",
    emptyRelations: "无显式类型化关系",
    emptyBacklinks: "无反向链接",
    emptyOutline: "无标题大纲",
    loadingPreview: "正在加载笔记详情…",
    ghostPreviewNote: "该节点为未解析的幽灵引用（目标文件尚未创建），共有 {count} 篇笔记引用了此名称。",
    memoryPreviewNote: "个人长期记忆条目（P4 预览钩子）。可在 0.3.0 中通过固化通道转为正式笔记。",
    toastCopied: "已复制 Obsidian 链接：{link}",
    toastCopyFailed: "复制链接失败：{reason}",
    toastFocusEntered: "已进入「{title}」二跳聚焦模式 (按 Esc 退出)",
    toastFocusExited: "已退出聚焦模式",
    toastPromoteInfo: "记忆固化通道将在 v0.3.0 (memory.read) 开放",
    bridgeTimeoutError: "宿主桥接调用超时 (30s)，已自动切换至内置演示数据集。",
    bridgeCallError: "宿主桥接调用失败 ({reason})，已切换至内置演示数据集。",
    drawerBridgeError: "读取笔记详情失败：{reason}",
    retryBtn: "重试连接",
    dismissBtn: "忽略",
    countsFormat: "{visNodes}/{totalNodes} 节点 · {visLinks} 关系",
    hoverUpdated: "更新: {date}",
    hoverVerified: "复核: {date}",
    settingsBtn: "检索设置",
    settingsBtnTitle: "检索设置",
    settingsHeading: "检索设置",
    settingsCloseAria: "关闭检索设置",
    settingsUnsaved: "未保存更改",
    settingsFixtureNotice: "当前为演示模式（未连接宿主桥接）。检索设置需要宿主桥接支持，表单控件已禁用。",
    settingsEnabledLabel: "启用向量检索 (Vector On/Off)",
    settingsProviderLabel: "服务提供方 (Provider)",
    settingsProviderOllama: "本地 Ollama (ollama)",
    settingsProviderOpenai: "OpenAI 兼容接口 (openai-compatible)",
    settingsBaseUrlLabel: "接口地址 (Base URL)",
    settingsBaseUrlPlaceholder: "http://127.0.0.1:11434",
    settingsBaseUrlHint: "非本地回环地址需开启远程发送并使用 https:",
    settingsModelLabel: "向量模型 (Model)",
    settingsModelPlaceholder: "nomic-embed-text",
    settingsApiKeyEnvLabel: "密钥环境变量名 (API Key Env)",
    settingsApiKeyEnvPlaceholder: "如 OPENAI_API_KEY（密钥留在环境/shell rc 中，绝不存储密钥本身）",
    settingsApiKeyEnvHint: "匹配 ^[A-Z_][A-Z0-9_]{0,63}$ 或留空；仅填变量名",
    settingsExcludeLabel: "排除目录 (Exclude Folders)",
    settingsExcludePlaceholder: "逗号分隔，如 private, archive/drafts",
    settingsExcludeHint: "知识库相对目录前缀，逗号分隔，不含 ..",
    settingsAllowRemoteLabel: "允许远程端点 (allowRemote)",
    settingsRemoteWarning: "开启后，脱敏后的笔记分段会发送到该地址。凭据会被移除；主机名、IP 地址和名称不会。",
    settingsKeyStatusLabel: "密钥状态",
    settingsKeyFound: "已就绪 (found)",
    settingsKeyMissing: "未找到 (missing)",
    settingsKeyNotRequired: "无需密钥 (not-required)",
    settingsIndexLabel: "索引统计",
    settingsIndexNotBuilt: "未构建 (not built)",
    settingsIndexFormat: "{identity} · {dims} 维 · {chunks} 段 · {builtAt}",
    settingsEstimateLabel: "发送估算",
    settingsEstimateFormat: "{chunks} 段 / {characters} 字符",
    settingsTestBtn: "测试连接 (1 次请求)",
    settingsSaveBtn: "保存",
    settingsConfirmSendBtn: "确认发送（约 {chunks} 段 / {characters} 字符）",
    settingsTestOk: "连接正常 · {dims} 维 · {latencyMs} ms",
    toastSettingsSaved: "已保存检索设置",
    classes: {
      project: "项目恒星 (project)",
      topic: "主题行星 (topic)",
      environment: "环境空间站 (environment)",
      organization: "组织星云 (organization)",
      technology: "技术小行星 (technology)",
      reference: "参考行星 (reference)",
      convention: "规范白矮星 (convention)",
      procedure: "流程彗星 (procedure)",
      decision: "决策卫星 (decision)",
      release: "发布卫星 (release)",
      incident: "事故脉冲星 (incident)",
      record: "记录卫星 (record)",
      navigation: "导航信标 (nav)",
      moc: "星图目录 (moc)",
      index: "总索引 (index)",
      daily: "日报 (daily)",
      weekly: "周报 (weekly)",
      inbox: "收件箱 (inbox)",
      memory: "记忆微光 (memory)",
      ghost: "幽灵节点 (ghost)",
      archived: "归档星尘 (archived)",
      unknown: "未知类别 (unknown)",
    },
    predicates: {
      project: "project (归属项目)",
      depends_on: "depends_on (依赖)",
      deployed_to: "deployed_to (部署于)",
      uses: "uses (使用技术)",
      for: "for (服务组织)",
      affects: "affects (影响实体)",
      resolved_by: "resolved_by (解决于)",
      supersedes: "supersedes (替代)",
      wikilink: "wikilink (弱引用)",
      ghost: "unresolved (未解析)",
    },
    healthLegend: {
      red: "UNKNOWN_* (未知类型/状态/目标)",
      amber: "VIOLATION / LEGACY (关系或格式违规)",
      muted: "OVERSIZE / ORPHAN / STALE (治理项)",
      ok: "健康节点 (无问题)",
    },
  },
  en: {
    title: "Knowledge Universe",
    fixtureBadge: "FIXTURE",
    searchPlaceholder: "Search note title or path (press / to focus)…",
    searchNoMatch: "No matching notes found",
    healthBtn: "Health",
    filtersBtn: "Filters",
    legendBtn: "Legend",
    zoomFitTitle: "Zoom to fit",
    langSwitchLabel: "中文",
    focusActivePrefix: "2-Hop Focus: ",
    filtersHeading: "Universe Filters",
    resetBtn: "Reset",
    filterClassLabel: "Ontology Class",
    filterProjectLabel: "Project Galaxy",
    filterStabilityLabel: "Stability",
    allClasses: "All classes",
    allProjects: "All project galaxies",
    noProjectHalo: "No project (shared halo)",
    allStabilities: "All stabilities",
    toggleStale: "Stale only",
    toggleEvents: "Event moons",
    toggleNavigation: "Navigation notes (MOC/Index)",
    toggleWeakLinks: "Weak links (Wikilinks)",
    toggleGhosts: "Unresolved ghosts",
    toggleArchived: "Archived dust",
    toggleMemory: "Memory satellites",
    memoryUnavailableTip: "Memory satellites unavailable ({status}) — enabled in v0.3.0 with memory.read",
    memoryOkTip: "Toggle learned memory satellites ({count})",
    legendHeading: "Celestial & Link Legend",
    legendPredicatesTitle: "Typed Link Predicates",
    legendHealthTitle: "Health Mode (radius = log2 chars)",
    healthHeading: "Ontology Health Issues",
    healthRegionAria: "Vault ontology health issues table",
    healthFilterAll: "All severities",
    healthFilterRed: "Unknown vocabulary (UNKNOWN_*)",
    healthFilterAmber: "Violations (VIOLATION / LEGACY)",
    healthFilterMuted: "Hygiene (OVERSIZE / ORPHAN / STALE)",
    thPath: "Note Path / Title",
    thClass: "Class",
    thChars: "Chars",
    thIssues: "Issue Codes",
    healthEmpty: "No ontology health issues match the current filter",
    timelapsePlay: "Play",
    timelapsePause: "Pause",
    timelapseLabel: "Time-lapse (by created date)",
    timelapseAll: "All dates ({count} nodes)",
    timelapseCutoff: "Up to {date} ({count} nodes)",
    drawerCopyLink: "Copy Obsidian link",
    drawerFocusSubgraph: "Focus 2-hop subgraph",
    drawerExitFocus: "Exit focus mode",
    drawerPromoteMemory: "Promote to note (P4)",
    secProps: "Properties",
    secIssues: "Ontology Issues",
    secRelations: "Typed Relations (by predicate)",
    secBacklinks: "Backlinks",
    secOutline: "Note Outline",
    secPreview: "Body Preview",
    truncatedBadge: "Truncated (≤8,000 chars)",
    redactedBadge: "REDACTED",
    staleBadge: "STALE",
    propClass: "Class",
    propFamily: "Family",
    propStatus: "Status",
    propStability: "Stability",
    propCreated: "Created",
    propUpdated: "Updated",
    propVerified: "Verified",
    propChars: "Characters",
    propDegree: "Degree",
    propProject: "Project",
    propSha: "SHA-256",
    emptyIssues: "No ontology issues",
    emptyRelations: "No typed relations",
    emptyBacklinks: "No incoming backlinks",
    emptyOutline: "No headings found",
    loadingPreview: "Loading note details…",
    ghostPreviewNote: "Unresolved ghost target (note file does not exist yet). Referenced by {count} note(s).",
    memoryPreviewNote: "Learned memory satellite (P4 hook). Promotion to vault note arrives in v0.3.0.",
    toastCopied: "Copied Obsidian link: {link}",
    toastCopyFailed: "Failed to copy link: {reason}",
    toastFocusEntered: "Focused 2-hop subgraph around \"{title}\" (Esc to exit)",
    toastFocusExited: "Exited focus mode",
    toastPromoteInfo: "Memory promotion channels open in v0.3.0 (memory.read)",
    bridgeTimeoutError: "Host bridge timed out after 30s. Switched to standalone fixture dataset.",
    bridgeCallError: "Host bridge unavailable ({reason}). Showing standalone fixture dataset.",
    drawerBridgeError: "Failed to load note details: {reason}",
    retryBtn: "Retry",
    dismissBtn: "Dismiss",
    countsFormat: "{visNodes}/{totalNodes} nodes · {visLinks} links",
    hoverUpdated: "Updated: {date}",
    hoverVerified: "Verified: {date}",
    settingsBtn: "Retrieval",
    settingsBtnTitle: "Retrieval settings",
    settingsHeading: "Retrieval Settings",
    settingsCloseAria: "Close retrieval settings",
    settingsUnsaved: "Unsaved changes",
    settingsFixtureNotice: "Standalone fixture mode (host bridge missing). Retrieval settings require the host bridge; controls are disabled.",
    settingsEnabledLabel: "Enable vector retrieval (on/off)",
    settingsProviderLabel: "Provider",
    settingsProviderOllama: "Local Ollama (ollama)",
    settingsProviderOpenai: "OpenAI-compatible endpoint (openai-compatible)",
    settingsBaseUrlLabel: "Base URL",
    settingsBaseUrlPlaceholder: "http://127.0.0.1:11434",
    settingsBaseUrlHint: "Non-loopback URLs require allowRemote: true and https:",
    settingsModelLabel: "Model",
    settingsModelPlaceholder: "nomic-embed-text",
    settingsApiKeyEnvLabel: "API key env-var name",
    settingsApiKeyEnvPlaceholder: "e.g. OPENAI_API_KEY (key stays in env/shell rc and is never stored)",
    settingsApiKeyEnvHint: "Matches ^[A-Z_][A-Z0-9_]{0,63}$ or empty; never enter the secret key",
    settingsExcludeLabel: "Exclude folders",
    settingsExcludePlaceholder: "Comma-separated, e.g. private, archive/drafts",
    settingsExcludeHint: "Vault-relative folder prefixes, comma-separated, without ..",
    settingsAllowRemoteLabel: "Allow remote endpoint (allowRemote)",
    settingsRemoteWarning: "Redacted note sections will be sent to this address. Credentials are removed; hosts, IP addresses, and names are not.",
    settingsKeyStatusLabel: "Key status",
    settingsKeyFound: "found",
    settingsKeyMissing: "missing",
    settingsKeyNotRequired: "not-required",
    settingsIndexLabel: "Index statistics",
    settingsIndexNotBuilt: "not built",
    settingsIndexFormat: "{identity} · {dims} dims · {chunks} chunks · {builtAt}",
    settingsEstimateLabel: "Send estimate",
    settingsEstimateFormat: "{chunks} segments / {characters} characters",
    settingsTestBtn: "Test connection (1 request)",
    settingsSaveBtn: "Save",
    settingsConfirmSendBtn: "Confirm sending (about {chunks} segments / {characters} characters)",
    settingsTestOk: "OK · {dims} dims · {latencyMs} ms",
    toastSettingsSaved: "Retrieval settings saved",
    classes: {
      project: "Project Star (project)",
      topic: "Topic Planet (topic)",
      environment: "Space Station (environment)",
      organization: "Nebula Blob (organization)",
      technology: "Asteroid (technology)",
      reference: "Reference Planet (reference)",
      convention: "White Dwarf (convention)",
      procedure: "Comet (procedure)",
      decision: "Decision Moon (decision)",
      release: "Release Moon (release)",
      incident: "Incident Moon (incident)",
      record: "Record Moon (record)",
      navigation: "Navigation Marker (nav)",
      moc: "MOC (moc)",
      index: "Index (index)",
      daily: "Daily Note (daily)",
      weekly: "Weekly Note (weekly)",
      inbox: "Inbox Note (inbox)",
      memory: "Memory Glint (memory)",
      ghost: "Ghost Node (ghost)",
      archived: "Archived Dust (archived)",
      unknown: "Unknown (unknown)",
    },
    predicates: {
      project: "project",
      depends_on: "depends_on",
      deployed_to: "deployed_to",
      uses: "uses",
      for: "for",
      affects: "affects",
      resolved_by: "resolved_by",
      supersedes: "supersedes",
      wikilink: "wikilink (weak)",
      ghost: "unresolved ghost",
    },
    healthLegend: {
      red: "UNKNOWN_* (unknown type/status/target)",
      amber: "VIOLATION / LEGACY (rule or schema violation)",
      muted: "OVERSIZE / ORPHAN / STALE (hygiene)",
      ok: "Healthy node (0 issues)",
    },
  },
};

/** Visual encoding palette per ontology class and predicate. */
const CLASS_COLORS = {
  project: "#ffd166",
  topic: "#6ea8fe",
  environment: "#67e8f9",
  organization: "#e879f9",
  technology: "#94a3b8",
  reference: "#f9a8d4",
  convention: "#f8fafc",
  procedure: "#a5f3fc",
  decision: "#c4b5fd",
  release: "#86efac",
  incident: "#fdba74",
  record: "#64748b",
  moc: "#475569",
  index: "#475569",
  daily: "#475569",
  weekly: "#475569",
  inbox: "#475569",
  navigation: "#475569",
  memory: "#fbbf24",
  me: "#fde68a",
  ghost: "#94a3b8",
  unknown: "#f87171",
};

const MEMORY_KIND_COLORS = {
  preference: "#fbbf24", // amber
  feedback: "#fb7185",   // coral
  fact: "#2dd4bf",       // teal
  reference: "#c084fc",  // lavender
};

const PREDICATE_COLORS = {
  project: "#ffd166",
  depends_on: "#60a5fa",
  deployed_to: "#22d3ee",
  uses: "#a78bfa",
  for: "#e879f9",
  affects: "#fb923c",
  resolved_by: "#4ade80",
  supersedes: "#f472b6",
  related: "#94a3b8",
  wikilink: "#94a3b8",
  ghost: "#64748b",
};

const HEALTH_COLORS = {
  red: "#f87171",
  amber: "#fbbf24",
  muted: "#64748b",
  ok: "#1e293b",
};

const LEGEND_CLASSES_ORDER = [
  "project",
  "topic",
  "environment",
  "organization",
  "technology",
  "reference",
  "convention",
  "procedure",
  "decision",
  "release",
  "incident",
  "record",
  "navigation",
  "memory",
  "ghost",
  "archived",
];

const LEGEND_PREDICATES_ORDER = [
  "project",
  "depends_on",
  "deployed_to",
  "uses",
  "for",
  "affects",
  "resolved_by",
  "supersedes",
  "wikilink",
];

const BRIDGE_TIMEOUT_MS = 30_000;

/** Application state */
const appState = {
  lang: String(navigator.language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en",
  fixtureMode: false,
  mode: "3d", // "3d" | "2d"
  healthMode: false,
  reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
  pageHidden: document.hidden,
  rawPayload: null,
  sharedGraphData: { nodes: [], links: [] },
  nodeById: new Map(),
  neighborsByNode: new Map(),
  linksByNode: new Map(),
  projectNodes: [],
  minCreatedMs: 0,
  maxCreatedMs: 0,
  timelapseRatio: 1, // 0..1 (1 = all dates)
  timelapsePlaying: false,
  timelapseRaf: null,
  filters: {
    cls: "all",
    project: "all",
    stability: "all",
    staleOnly: false,
    showEvents: true,
    showNavigation: false,
    showWeakLinks: true,
    showGhosts: false,
    showArchived: false,
    showMemory: false,
    healthSeverity: "all",
  },
  hoveredNode: null,
  hoverSet: new Set(),
  selectedNode: null,
  focusNode: null,
  focusSet: null, // Set of 2-hop node IDs when focusMode is active
  searchMatches: [],
  searchActiveIndex: 0,
  pointerX: window.innerWidth / 2,
  pointerY: window.innerHeight / 2,
  lastClickNodeId: null,
  lastClickTime: 0,
  lastBgClickTime: 0,
  graph3d: null,
  graph2d: null,
  three: null,
  visibleNodeSet: new Set(),
  visibleLinkSet: new Set(),
  toastTimer: null,
  settingsPanel: {
    open: false,
    bridgeAvailable: false,
    busy: false,
    savedSettings: null,
    baselineSnapshot: null,
    apiKeyStatus: "not-required",
    index: null,
    estimate: null,
    confirmingRemote: false,
    feedbackText: "",
    feedbackIsError: false,
    feedbackTestResult: null,
  },
};

function t(key, vars = {}) {
  const dict = STRINGS[appState.lang] || STRINGS.en;
  let str = dict[key] ?? STRINGS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(`{${k}}`, String(v));
  }
  return str;
}

function tClass(cls) {
  const dict = STRINGS[appState.lang]?.classes || STRINGS.en.classes;
  return dict[cls] || cls;
}

function tPredicate(pred) {
  const dict = STRINGS[appState.lang]?.predicates || STRINGS.en.predicates;
  return dict[pred] || pred;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function hexToRgb(hex) {
  const clean = String(hex || "#94a3b8").replace("#", "");
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function rgbaString(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1).toFixed(3)})`;
}

function classifyIssueCode(code) {
  if (String(code).startsWith("UNKNOWN_")) return "red";
  if (
    code === "DOMAIN_VIOLATION" ||
    code === "RANGE_VIOLATION" ||
    code === "CARDINALITY_VIOLATION" ||
    code === "LEGACY_TYPE" ||
    code === "FRONTMATTER_INVALID"
  ) {
    return "amber";
  }
  return "muted";
}

function classifyNodeSeverity(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return "ok";
  let hasAmber = false;
  for (const code of issues) {
    const sev = classifyIssueCode(code);
    if (sev === "red") return "red";
    if (sev === "amber") hasAmber = true;
  }
  return hasAmber ? "amber" : "muted";
}

/**
 * Invoke host bridge with a 30-second timeout guard.
 */
async function invokeBridge(channel, payload = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
  const bridge = window.pluginBridge;
  if (!bridge || typeof bridge.invoke !== "function") {
    const err = new Error("pluginBridge unavailable");
    err.code = "BRIDGE_MISSING";
    throw err;
  }
  let timerId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      const err = new Error("Bridge call timed out after 30s");
      err.code = "BRIDGE_TIMEOUT";
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([bridge.invoke(channel, payload), timeoutPromise]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

/**
 * Seeded PRNG for deterministic star layers and initial galaxy layout.
 */
function createSeededRandom(seed = 0x5f3759df) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deep-space parallax starfield + per-galaxy radial nebula renderer (#cosmos-bg).
 */
class CosmosBackdrop {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.layers = [];
    this.sprites = [];
    this.nebulaColors = [
      [62, 108, 224],
      [138, 76, 212],
      [42, 165, 198],
      [214, 158, 58],
      [182, 72, 148],
    ];
    this.initSprites();
    this.resize();
  }

  initSprites() {
    const tones = ["#ffffff", "#cfe2ff", "#ffe8a3", "#f5d0fe", "#a5f3fc"];
    this.sprites = tones.map((color) => {
      const c = document.createElement("canvas");
      c.width = 24;
      c.height = 24;
      const g = c.getContext("2d");
      const grad = g.createRadialGradient(12, 12, 0.5, 12, 12, 11);
      grad.addColorStop(0, "#ffffff");
      grad.addColorStop(0.28, color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(12, 12, 11, 0, Math.PI * 2);
      g.fill();
      return c;
    });
  }

  buildStarLayers() {
    const rand = createSeededRandom(0x19a4c8e3);
    const configs = [
      { count: 220, parallax: 0.05, minSize: 2.5, maxSize: 5.5, alpha: 0.42 },
      { count: 130, parallax: 0.14, minSize: 4.0, maxSize: 8.5, alpha: 0.68 },
      { count: 55, parallax: 0.28, minSize: 7.0, maxSize: 13.5, alpha: 0.92 },
    ];
    this.layers = configs.map((cfg) => {
      const stars = [];
      for (let i = 0; i < cfg.count; i++) {
        stars.push({
          u: rand(),
          v: rand(),
          size: cfg.minSize + rand() * (cfg.maxSize - cfg.minSize),
          spriteIdx: Math.floor(rand() * this.sprites.length),
          phase: rand() * Math.PI * 2,
          alpha: cfg.alpha * (0.65 + 0.35 * rand()),
        });
      }
      return { ...cfg, stars };
    });
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buildStarLayers();
  }

  render(nowMs) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // 1. Deep-space near-black blue gradient
    const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.34, 20, w * 0.5, h * 0.5, Math.max(w, h) * 0.85);
    bgGrad.addColorStop(0, "#0b1739");
    bgGrad.addColorStop(0.48, "#050b1d");
    bgGrad.addColorStop(1, "#02040a");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Compute camera parallax offset from active 3D or 2D view
    let offsetX = 0;
    let offsetY = 0;
    if (appState.mode === "3d" && appState.graph3d) {
      const cam = appState.graph3d.camera();
      if (cam) {
        offsetX = cam.position.x * 0.55 + cam.rotation.y * 180;
        offsetY = -cam.position.y * 0.55 + cam.rotation.x * 180;
      }
    } else if (appState.mode === "2d" && appState.graph2d) {
      const center = appState.graph2d.centerAt?.() || { x: 0, y: 0 };
      offsetX = -center.x * 0.8;
      offsetY = -center.y * 0.8;
    }

    // 2. Faint per-galaxy nebulae (radial gradients behind project clusters)
    let idx = 0;
    for (const proj of appState.projectNodes) {
      if (!appState.visibleNodeSet.has(proj.id)) continue;
      if (!Number.isFinite(proj.x) || !Number.isFinite(proj.y)) continue;
      let screenPos = null;
      if (appState.mode === "3d" && appState.graph3d) {
        screenPos = appState.graph3d.graph2ScreenCoords(proj.x, proj.y, proj.z || 0);
      } else if (appState.mode === "2d" && appState.graph2d) {
        screenPos = appState.graph2d.graph2ScreenCoords(proj.x, proj.y);
      }
      if (!screenPos || !Number.isFinite(screenPos.x) || !Number.isFinite(screenPos.y)) continue;
      if (screenPos.x < -220 || screenPos.x > w + 220 || screenPos.y < -220 || screenPos.y > h + 220) continue;

      const rgb = this.nebulaColors[idx % this.nebulaColors.length];
      idx++;
      const radius = 135;
      const nebGrad = ctx.createRadialGradient(screenPos.x, screenPos.y, 4, screenPos.x, screenPos.y, radius);
      nebGrad.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.085)`);
      nebGrad.addColorStop(0.5, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.032)`);
      nebGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = nebGrad;
      ctx.beginPath();
      ctx.arc(screenPos.x, screenPos.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. Three parallax star layers using canvas-generated sprites
    const twinkleTime = appState.reducedMotion ? 0 : nowMs * 0.0014;
    for (const layer of this.layers) {
      const shiftX = offsetX * layer.parallax;
      const shiftY = offsetY * layer.parallax;
      for (const star of layer.stars) {
        const sx = (((star.u * w + shiftX) % w) + w) % w;
        const sy = (((star.v * h + shiftY) % h) + h) % h;
        const twinkle = appState.reducedMotion ? 1 : 0.78 + 0.22 * Math.sin(twinkleTime + star.phase);
        ctx.globalAlpha = star.alpha * twinkle;
        const half = star.size * 0.5;
        ctx.drawImage(this.sprites[star.spriteIdx], sx - half, sy - half, star.size, star.size);
      }
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * Prepare shared graph data structure consumed by both ForceGraph3D and ForceGraph2D.
 */
function prepareSharedGraph(payload) {
  const anchorMs = Date.parse(payload.generatedAt || "") || Date.now();
  const rand = createSeededRandom(0x20261024);

  const nodes = [];
  const links = [];
  const nodeById = new Map();
  const projectNodes = [];

  // Pre-assign galaxy centers for project nodes on a 3D golden spiral sphere/disc
  const rawProjects = (payload.nodes || []).filter((n) => n.cls === "project");
  const projectCenters = new Map();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  rawProjects.forEach((p, idx) => {
    const tNorm = (idx + 0.5) / Math.max(1, rawProjects.length);
    const r = p.archived ? 235 : 75 + Math.sqrt(tNorm) * 115;
    const theta = idx * goldenAngle;
    const zSpread = ((idx % 5) - 2) * 28;
    projectCenters.set(p.id, {
      x: Math.cos(theta) * r,
      y: Math.sin(theta) * r,
      z: zSpread,
    });
  });

  // Transform vault nodes
  for (let i = 0; i < (payload.nodes || []).length; i++) {
    const raw = payload.nodes[i];
    const updatedMs = raw.updated ? Date.parse(`${raw.updated}T00:00:00Z`) : NaN;
    const ageDays = Number.isFinite(updatedMs) ? Math.max(0, (anchorMs - updatedMs) / 86_400_000) : 120;
    const baseGlow = clamp(1 - ageDays / 365, 0.25, 1);
    const glow = raw.stale ? Math.max(0.22, baseGlow * 0.58) : baseGlow;
    const degree = Number.isFinite(raw.degree) ? raw.degree : 0;
    const baseRadius = Math.min(14, 2 + 2.2 * Math.log2(1 + degree));
    const chars = Number.isFinite(raw.chars) ? raw.chars : 0;
    const healthRadius = Math.min(15, Math.max(2.4, 1.6 + 1.15 * Math.log2(1 + Math.max(1, chars) / 250)));
    const createdMs = raw.created ? Date.parse(`${raw.created}T00:00:00Z`) : NaN;
    const severity = classifyNodeSeverity(raw.issues);

    // Initial position near project galaxy center or outer halo
    let initPos;
    if (raw.cls === "project" && projectCenters.has(raw.id)) {
      initPos = { ...projectCenters.get(raw.id) };
    } else if (raw.project && projectCenters.has(raw.project)) {
      const c = projectCenters.get(raw.project);
      const orbitR = raw.family === "event" ? 14 + rand() * 10 : 24 + rand() * 28;
      const ang = rand() * Math.PI * 2;
      const zOff = (rand() - 0.5) * 22;
      initPos = {
        x: c.x + Math.cos(ang) * orbitR,
        y: c.y + Math.sin(ang) * orbitR,
        z: c.z + zOff,
      };
    } else {
      const haloR = raw.archived ? 245 + rand() * 35 : 175 + rand() * 35;
      const ang = (i * goldenAngle) + rand() * 0.25;
      initPos = {
        x: Math.cos(ang) * haloR,
        y: Math.sin(ang) * haloR,
        z: (rand() - 0.5) * 70,
      };
    }

    const enriched = {
      ...raw,
      degree,
      chars,
      issues: Array.isArray(raw.issues) ? raw.issues : [],
      ageDays,
      glow,
      baseRadius,
      healthRadius,
      severity,
      createdMs: Number.isFinite(createdMs) ? createdMs : null,
      orbitAngle: rand() * Math.PI * 2,
      orbitRadius: 15 + (i % 5) * 2.4,
      orbitSpeed: (0.35 + (i % 7) * 0.08) * (i % 2 === 0 ? 1 : -1),
      x: initPos.x,
      y: initPos.y,
      z: initPos.z,
    };
    nodes.push(enriched);
    nodeById.set(enriched.id, enriched);
    if (enriched.cls === "project") {
      projectNodes.push(enriched);
    }
  }

  // Synthesize "Me" center node if user-scope memory satellites exist
  const hasUserMemory = nodes.some((n) => (n.cls === "memory" || n.family === "memory") && !n.project);
  if (hasUserMemory && !nodeById.has("memory:me")) {
    const meNode = {
      id: "memory:me",
      title: "Me",
      cls: "me",
      family: "memory",
      status: "active",
      stability: "stable",
      stale: false,
      archived: false,
      degree: 4,
      chars: 0,
      issues: [],
      ageDays: 0,
      glow: 1,
      baseRadius: 7,
      healthRadius: 5,
      severity: "ok",
      createdMs: null,
      x: 0,
      y: 0,
      z: 0,
    };
    nodes.push(meNode);
    nodeById.set(meNode.id, meNode);
  }

  // Transform ghost nodes (hidden by default until Ghosts toggle is enabled)
  for (let i = 0; i < (payload.ghosts || []).length; i++) {
    const g = payload.ghosts[i];
    const ghostId = `ghost:${g.id}`;
    if (nodeById.has(ghostId)) continue;
    const refs = Array.isArray(g.referencedBy) ? g.referencedBy : [];
    const firstRef = refs.length > 0 ? nodeById.get(refs[0]) : null;
    const ang = i * goldenAngle;
    const ghostNode = {
      id: ghostId,
      ghostTarget: g.id,
      title: g.id,
      cls: "ghost",
      family: "ghost",
      status: "unresolved",
      stability: "volatile",
      stale: false,
      archived: false,
      degree: refs.length,
      chars: 0,
      issues: [],
      referencedBy: refs,
      ageDays: 0,
      glow: 0.55,
      baseRadius: Math.min(8, 2 + 1.6 * Math.log2(1 + refs.length)),
      healthRadius: 3,
      severity: "ok",
      createdMs: null,
      x: firstRef ? firstRef.x + Math.cos(ang) * 28 : Math.cos(ang) * 210,
      y: firstRef ? firstRef.y + Math.sin(ang) * 28 : Math.sin(ang) * 210,
      z: firstRef ? (firstRef.z || 0) + 12 : 0,
    };
    nodes.push(ghostNode);
    nodeById.set(ghostId, ghostNode);

    for (const refPath of refs) {
      if (nodeById.has(refPath)) {
        links.push({
          source: refPath,
          target: ghostId,
          predicate: "ghost",
        });
      }
    }
  }

  // Add graph links
  for (const rawLink of payload.links || []) {
    const srcId = typeof rawLink.source === "object" ? rawLink.source.id : rawLink.source;
    const tgtId = typeof rawLink.target === "object" ? rawLink.target.id : rawLink.target;
    if (!nodeById.has(srcId) || !nodeById.has(tgtId)) continue;
    links.push({
      source: srcId,
      target: tgtId,
      predicate: rawLink.predicate || "wikilink",
    });
  }

  // Build adjacency maps
  const neighborsByNode = new Map();
  const linksByNode = new Map();
  for (const n of nodes) {
    neighborsByNode.set(n.id, new Set());
    linksByNode.set(n.id, []);
  }
  for (const l of links) {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const tId = typeof l.target === "object" ? l.target.id : l.target;
    neighborsByNode.get(s)?.add(tId);
    neighborsByNode.get(tId)?.add(s);
    linksByNode.get(s)?.push(l);
    linksByNode.get(tId)?.push(l);
  }

  // Compute created date range for time-lapse slider
  const validCreated = nodes.map((n) => n.createdMs).filter((ms) => Number.isFinite(ms));
  const minCreatedMs = validCreated.length ? Math.min(...validCreated) : anchorMs - 365 * 86_400_000;
  const maxCreatedMs = validCreated.length ? Math.max(...validCreated) : anchorMs;

  appState.rawPayload = payload;
  appState.sharedGraphData = { nodes, links };
  appState.nodeById = nodeById;
  appState.neighborsByNode = neighborsByNode;
  appState.linksByNode = linksByNode;
  appState.projectNodes = projectNodes.sort((a, b) => a.title.localeCompare(b.title));
  appState.minCreatedMs = minCreatedMs;
  appState.maxCreatedMs = maxCreatedMs;
}

/**
 * Compute node & link visibility sets according to active filters, toggles, and time-lapse.
 */
function recomputeVisibility() {
  const { filters, timelapseRatio, minCreatedMs, maxCreatedMs, sharedGraphData } = appState;
  const cutoffMs =
    timelapseRatio >= 0.999 ? Infinity : minCreatedMs + timelapseRatio * Math.max(1, maxCreatedMs - minCreatedMs);

  const visNodes = new Set();
  for (const node of sharedGraphData.nodes) {
    if (node.cls === "ghost") {
      if (!filters.showGhosts) continue;
      if (filters.staleOnly) continue;
      if (filters.cls !== "all" && filters.cls !== "ghost") continue;
      if (filters.stability !== "all") continue;
      if (filters.project !== "all") {
        const refs = node.referencedBy || [];
        const matchesProj = refs.some((refId) => {
          const rNode = appState.nodeById.get(refId);
          return rNode && (rNode.id === filters.project || rNode.project === filters.project);
        });
        if (!matchesProj) continue;
      }
      visNodes.add(node.id);
      continue;
    }
    if (node.cls === "memory" || node.family === "memory") {
      if (!filters.showMemory) continue;
      if (filters.staleOnly) continue;
      if (filters.cls !== "all" && filters.cls !== "memory") continue;
      visNodes.add(node.id);
      continue;
    }
    if (node.archived && !filters.showArchived) continue;
    if (node.family === "event" && !filters.showEvents) continue;
    if (node.family === "navigation" && !filters.showNavigation && filters.cls !== "navigation" && filters.cls !== node.cls) {
      continue;
    }
    if (filters.cls !== "all") {
      if (filters.cls === "navigation") {
        if (node.family !== "navigation") continue;
      } else if (node.cls !== filters.cls) {
        continue;
      }
    }
    if (filters.project !== "all") {
      if (filters.project === "__none__") {
        if (node.project || node.cls === "project") continue;
      } else if (node.id !== filters.project && node.project !== filters.project) {
        continue;
      }
    }
    if (filters.stability !== "all" && node.stability !== filters.stability) continue;
    if (filters.staleOnly && !node.stale) continue;
    if (cutoffMs < Infinity && node.createdMs !== null && node.createdMs > cutoffMs) continue;

    visNodes.add(node.id);
  }

  const visLinks = new Set();
  for (const link of sharedGraphData.links) {
    const sId = typeof link.source === "object" ? link.source.id : link.source;
    const tId = typeof link.target === "object" ? link.target.id : link.target;
    if (!visNodes.has(sId) || !visNodes.has(tId)) continue;
    if (link.predicate === "wikilink" && !filters.showWeakLinks) continue;
    if (link.predicate === "ghost" && !filters.showGhosts) continue;
    visLinks.add(link);
  }

  appState.visibleNodeSet = visNodes;
  appState.visibleLinkSet = visLinks;
  updateHeaderCounts();
  updateTimelapseReadout();
}

function getLinkEndpoints(link) {
  const s = typeof link.source === "object" ? link.source.id : link.source;
  const tId = typeof link.target === "object" ? link.target.id : link.target;
  return [s, tId];
}

function getNodeBaseHex(node) {
  if (appState.healthMode) {
    return HEALTH_COLORS[node.severity] || HEALTH_COLORS.ok;
  }
  if (node.archived) return "#64748b";
  if (node.cls === "memory" && node.memoryKind && MEMORY_KIND_COLORS[node.memoryKind]) {
    return MEMORY_KIND_COLORS[node.memoryKind];
  }
  return CLASS_COLORS[node.cls] || CLASS_COLORS.unknown;
}

function getNodeRadius(node) {
  if (appState.healthMode) return node.healthRadius || 4;
  return node.baseRadius || 4;
}

/**
 * Compute effective alpha/dim multiplier for a node based on hover, 2-hop focus, staleness, and archive state.
 */
function getNodeVisualAlpha(node) {
  let alpha = appState.healthMode
    ? node.severity === "ok"
      ? 0.25
      : 0.94
    : node.archived
      ? 0.28
      : node.family === "navigation"
        ? 0.36
        : clamp(0.45 + 0.55 * (node.glow ?? 0.8), 0.35, 1);

  if (appState.focusSet && !appState.focusSet.has(node.id)) {
    alpha *= 0.1;
  }
  if (appState.hoveredNode) {
    if (node.id === appState.hoveredNode.id || appState.hoverSet.has(node.id)) {
      alpha = Math.max(alpha, 0.96);
    } else {
      alpha *= 0.16;
    }
  }
  return clamp(alpha, 0.05, 1);
}

function getNodeColorString(node) {
  const hex = getNodeBaseHex(node);
  const alpha = getNodeVisualAlpha(node);
  return rgbaString(hex, alpha);
}

function getLinkColorString(link) {
  const [sId, tId] = getLinkEndpoints(link);
  const isWeak = link.predicate === "wikilink";
  const isGhost = link.predicate === "ghost";
  const baseHex = PREDICATE_COLORS[link.predicate] || "#94a3b8";

  let alpha = isWeak ? 0.06 : isGhost ? 0.22 : 0.68;

  if (appState.healthMode) {
    alpha *= 0.35;
  }
  if (appState.focusSet) {
    if (!appState.focusSet.has(sId) || !appState.focusSet.has(tId)) {
      alpha *= 0.08;
    }
  }
  if (appState.hoveredNode) {
    const hId = appState.hoveredNode.id;
    if (sId === hId || tId === hId) {
      alpha = isWeak ? 0.42 : 0.95;
    } else {
      alpha *= 0.12;
    }
  }
  return rgbaString(baseHex, alpha);
}

function getLinkWidthValue(link) {
  if (link.predicate === "wikilink") return 0.3;
  if (link.predicate === "ghost") return 0.5;
  return 1.2;
}

function shouldShowParticles(link) {
  if (appState.reducedMotion) return false;
  if (appState.sharedGraphData.nodes.length > 2000) return false;
  if (link.predicate === "wikilink" || link.predicate === "ghost") return false;
  if (!appState.visibleLinkSet.has(link)) return false;
  if (appState.focusSet) {
    const [sId, tId] = getLinkEndpoints(link);
    if (!appState.focusSet.has(sId) || !appState.focusSet.has(tId)) return false;
  }
  return true;
}

/**
 * Extract Three.js primitives from ForceGraph3D's scene & skysphere without extra dependencies.
 */
function extractThreePrimitives(fg3d) {
  const scene = fg3d.scene();
  const skysphere = scene.children.find((c) => c.type === "Mesh" && c.geometry?.attributes?.position);
  if (!skysphere) return null;
  const Mesh = skysphere.constructor;
  const SphereGeometry = skysphere.geometry.constructor;
  const MeshBasicMaterial = skysphere.material.constructor;
  const Color = skysphere.material.color.constructor;
  const Vector3 = skysphere.position.constructor;
  const Object3D = Object.getPrototypeOf(scene.constructor);
  const BufferGeometry = Object.getPrototypeOf(SphereGeometry);
  const Float32BufferAttribute = skysphere.geometry.attributes.position.constructor;

  function createRingGeometry(innerR, outerR, segments = 32, dashed = false) {
    const verts = [];
    for (let i = 0; i < segments; i++) {
      if (dashed && i % 2 === 1) continue;
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      verts.push(
        c0 * innerR, s0 * innerR, 0,
        c0 * outerR, s0 * outerR, 0,
        c1 * outerR, s1 * outerR, 0,
        c0 * innerR, s0 * innerR, 0,
        c1 * outerR, s1 * outerR, 0,
        c1 * innerR, s1 * innerR, 0
      );
    }
    const geom = new BufferGeometry();
    geom.setAttribute("position", new Float32BufferAttribute(new Float32Array(verts), 3));
    return geom;
  }

  function createCometTailGeometry(headR, length, segments = 12) {
    const verts = [];
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      verts.push(
        Math.cos(a0) * headR, Math.sin(a0) * headR, 0,
        Math.cos(a1) * headR, Math.sin(a1) * headR, 0,
        0, 0, -length
      );
    }
    const geom = new BufferGeometry();
    geom.setAttribute("position", new Float32BufferAttribute(new Float32Array(verts), 3));
    return geom;
  }

  return {
    Object3D,
    Mesh,
    SphereGeometry,
    BufferGeometry,
    Float32BufferAttribute,
    MeshBasicMaterial,
    Color,
    Vector3,
    createRingGeometry,
    createCometTailGeometry,
  };
}

/**
 * Build custom 3D celestial attachment (coronas, space-station rings, nebula blobs,
 * comet tails, white-dwarf halos, asteroid facets, and stale dashed rings).
 */
function buildNodeThreeAttachment(node) {
  if (!appState.three && appState.graph3d) {
    appState.three = extractThreePrimitives(appState.graph3d);
  }
  const three = appState.three;
  if (!three) return false;
  const { Object3D, Mesh, SphereGeometry, MeshBasicMaterial, Color, createRingGeometry, createCometTailGeometry } = three;
  const group = new Object3D();
  const r = getNodeRadius(node);
  const glow = node.glow ?? 0.8;
  const allowBloom = appState.sharedGraphData.nodes.length <= 2000 && !appState.reducedMotion;
  const mats = [];

  function addMat(params) {
    const m = new MeshBasicMaterial(params);
    mats.push({ mat: m, baseOpacity: params.opacity ?? 1 });
    return m;
  }

  if (node.cls === "project") {
    // Gold star soft multi-shell additive corona
    if (allowBloom) {
      const inner = new Mesh(
        new SphereGeometry(r * 1.32, 16, 16),
        addMat({ color: new Color("#ffe58f"), transparent: true, opacity: 0.36 * glow, blending: 2, depthWrite: false })
      );
      const outer = new Mesh(
        new SphereGeometry(r * 1.85, 14, 14),
        addMat({ color: new Color("#ffd166"), transparent: true, opacity: 0.16 * glow, blending: 2, depthWrite: false })
      );
      group.add(inner);
      group.add(outer);
    }
    const flare = new Mesh(
      createRingGeometry(r * 1.15, r * 1.55, 28, false),
      addMat({ color: new Color("#ffd166"), transparent: true, opacity: 0.25 * glow, side: 2, blending: 2, depthWrite: false })
    );
    flare.rotation.x = Math.PI * 0.38;
    group.add(flare);
  } else if (node.cls === "topic" || node.cls === "reference") {
    // Planet limb-shading atmosphere shell
    const limbHex = node.cls === "topic" ? "#93c5fd" : "#fbcfe8";
    const limb = new Mesh(
      new SphereGeometry(r * 1.18, 14, 14),
      addMat({ color: new Color(limbHex), transparent: true, opacity: 0.22 * glow, side: 1, blending: 2, depthWrite: false })
    );
    group.add(limb);
  } else if (node.cls === "environment") {
    // Cyan space station orbital ring
    const ring = new Mesh(
      createRingGeometry(r * 1.35, r * 1.72, 32, false),
      addMat({ color: new Color("#67e8f9"), transparent: true, opacity: 0.78 * glow, side: 2, blending: 2, depthWrite: false })
    );
    ring.rotation.x = Math.PI * 0.36;
    ring.rotation.y = Math.PI * 0.14;
    group.add(ring);
  } else if (node.cls === "organization") {
    // Magenta multi-lobed soft nebula cloud
    const offsets = [
      [r * 0.4, r * 0.2, 0, 1.25],
      [-r * 0.4, -r * 0.25, r * 0.2, 1.15],
      [0, r * 0.35, -r * 0.3, 1.2],
    ];
    for (const [ox, oy, oz, sc] of offsets) {
      const lobe = new Mesh(
        new SphereGeometry(r * sc, 10, 10),
        addMat({ color: new Color("#e879f9"), transparent: true, opacity: 0.22 * glow, blending: 2, depthWrite: false })
      );
      lobe.position.set(ox, oy, oz);
      group.add(lobe);
    }
  } else if (node.cls === "technology") {
    // Irregular faceted asteroid ridge wireframe
    const ridge = new Mesh(
      new SphereGeometry(r * 1.08, 6, 5),
      addMat({ color: new Color("#cbd5e1"), wireframe: true, transparent: true, opacity: 0.42 * glow })
    );
    group.add(ridge);
  } else if (node.cls === "convention") {
    // White dwarf intense compact glow
    if (allowBloom) {
      const halo = new Mesh(
        new SphereGeometry(r * 1.55, 14, 14),
        addMat({ color: new Color("#e0f2fe"), transparent: true, opacity: 0.42 * glow, blending: 2, depthWrite: false })
      );
      group.add(halo);
    }
  } else if (node.cls === "procedure") {
    // Cyan comet motion tail
    const tail = new Mesh(
      createCometTailGeometry(r * 0.72, r * 3.4, 12),
      addMat({ color: new Color("#67e8f9"), transparent: true, opacity: 0.38 * glow, side: 2, blending: 2, depthWrite: false })
    );
    tail.rotation.y = Math.PI * 0.25;
    tail.rotation.x = Math.PI * 0.12;
    group.add(tail);
  } else if (node.cls === "incident") {
    // Slow pulsing orange-red aura
    const pulseShell = new Mesh(
      new SphereGeometry(r * 1.48, 12, 12),
      addMat({ color: new Color("#fdba74"), transparent: true, opacity: 0.32, blending: 2, depthWrite: false })
    );
    group.userData.pulseMesh = pulseShell;
    group.add(pulseShell);
  } else if (node.cls === "ghost") {
    const wire = new Mesh(
      new SphereGeometry(r * 1.12, 8, 6),
      addMat({ color: new Color("#94a3b8"), wireframe: true, transparent: true, opacity: 0.65 })
    );
    group.add(wire);
  }

  // Stale nodes get a dashed halo ring
  if (node.stale) {
    const staleRing = new Mesh(
      createRingGeometry(r * 1.55, r * 1.78, 24, true),
      addMat({ color: new Color("#fbbf24"), transparent: true, opacity: 0.72, side: 2, depthWrite: false })
    );
    group.add(staleRing);
  }

  group.userData.mats = mats;
  node.__celestialGroup = group;
  return group;
}

function syncThreeAttachmentsVisualState() {
  for (const node of appState.sharedGraphData.nodes) {
    const group = node.__celestialGroup;
    if (!group) continue;
    const visAlpha = getNodeVisualAlpha(node);
    const scaleRatio = appState.healthMode
      ? (node.healthRadius || 4) / Math.max(1, node.baseRadius || 4)
      : 1;
    group.scale.set(scaleRatio, scaleRatio, scaleRatio);
    for (const item of group.userData.mats || []) {
      item.mat.opacity = clamp(item.baseOpacity * visAlpha, 0.02, 1);
    }
  }
}

/**
 * Custom 2D canvas painter for ForceGraph2D matching every 3D body encoding.
 */
function paintNode2D(node, ctx, globalScale) {
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
  const r = getNodeRadius(node);
  const alpha = getNodeVisualAlpha(node);
  const baseHex = getNodeBaseHex(node);
  const allowBloom = appState.sharedGraphData.nodes.length <= 2000 && !appState.reducedMotion;

  ctx.save();
  ctx.translate(node.x, node.y);

  if (appState.healthMode) {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = rgbaString(baseHex, alpha);
    ctx.fill();
    if (node.severity !== "ok") {
      ctx.lineWidth = 1.2 / Math.max(0.5, globalScale);
      ctx.strokeStyle = rgbaString(baseHex, Math.min(1, alpha + 0.2));
      ctx.stroke();
    }
    ctx.restore();
    return;
  }

  if (node.cls === "ghost") {
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = rgbaString("#94a3b8", alpha * 0.85);
    ctx.stroke();
    ctx.restore();
    return;
  }

  if (node.cls === "project") {
    if (allowBloom) {
      const corona = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 2.4);
      corona.addColorStop(0, rgbaString("#fff3c4", alpha * 0.9));
      corona.addColorStop(0.4, rgbaString("#ffd166", alpha * 0.45));
      corona.addColorStop(1, "rgba(255, 209, 102, 0)");
      ctx.fillStyle = corona;
      ctx.beginPath();
      ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = rgbaString("#ffd166", alpha);
    ctx.fill();
  } else if (node.cls === "topic" || node.cls === "reference") {
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    grad.addColorStop(0, rgbaString("#ffffff", alpha * 0.9));
    grad.addColorStop(0.35, rgbaString(baseHex, alpha));
    grad.addColorStop(1, rgbaString(node.cls === "topic" ? "#1e3a8a" : "#831843", alpha));
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  } else if (node.cls === "environment") {
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
    ctx.fillStyle = rgbaString("#67e8f9", alpha);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.65, r * 0.58, -0.35, 0, Math.PI * 2);
    ctx.strokeStyle = rgbaString("#a5f3fc", alpha * 0.9);
    ctx.lineWidth = 1.3;
    ctx.stroke();
  } else if (node.cls === "organization") {
    const neb = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.7);
    neb.addColorStop(0, rgbaString("#f5d0fe", alpha * 0.9));
    neb.addColorStop(0.5, rgbaString("#e879f9", alpha * 0.55));
    neb.addColorStop(1, "rgba(232, 121, 249, 0)");
    ctx.fillStyle = neb;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.7, 0, Math.PI * 2);
    ctx.fill();
  } else if (node.cls === "technology") {
    ctx.beginPath();
    const sides = 6;
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const rad = r * (i % 2 === 0 ? 1.05 : 0.82);
      const px = Math.cos(a) * rad;
      const py = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = rgbaString("#94a3b8", alpha);
    ctx.fill();
    ctx.strokeStyle = rgbaString("#e2e8f0", alpha * 0.7);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  } else if (node.cls === "convention") {
    if (allowBloom) {
      const glow = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.9);
      glow.addColorStop(0, rgbaString("#ffffff", alpha));
      glow.addColorStop(0.45, rgbaString("#bae6fd", alpha * 0.55));
      glow.addColorStop(1, "rgba(248, 250, 252, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.75, 0, Math.PI * 2);
    ctx.fillStyle = rgbaString("#f8fafc", alpha);
    ctx.fill();
  } else if (node.cls === "procedure") {
    // Comet with short motion tail
    const tailGrad = ctx.createLinearGradient(0, 0, -r * 2.8, r * 1.1);
    tailGrad.addColorStop(0, rgbaString("#a5f3fc", alpha * 0.75));
    tailGrad.addColorStop(1, "rgba(103, 232, 249, 0)");
    ctx.fillStyle = tailGrad;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.65);
    ctx.lineTo(-r * 2.8, r * 1.1);
    ctx.lineTo(0, r * 0.65);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
    ctx.fillStyle = rgbaString("#a5f3fc", alpha);
    ctx.fill();
  } else if (node.family === "navigation") {
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
    ctx.strokeStyle = rgbaString("#94a3b8", alpha * 0.7);
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (node.cls === "memory") {
    // 4-point glint star
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rad = i % 2 === 0 ? r * 1.2 : r * 0.38;
      const px = Math.cos(a) * rad;
      const py = Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = rgbaString(baseHex, alpha);
    ctx.fill();
  } else {
    // Event moons (decision, release, incident, record)
    if (node.cls === "incident" && !appState.reducedMotion) {
      const pulse = 1 + 0.28 * Math.sin(performance.now() * 0.004);
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.45 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = rgbaString("#fdba74", alpha * 0.28);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = rgbaString(baseHex, alpha);
    ctx.fill();
  }

  // Stale dashed halo ring
  if (node.stale) {
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.55, 0, Math.PI * 2);
    ctx.setLineDash([2.5, 2.5]);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = rgbaString("#fbbf24", alpha * 0.85);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Custom galaxy clustering & halo D3 force (ADR 0001 §10: strength 0.05 toward project centroid;
 * charge -120 for project stars vs -30 for others; shared outer halo for project-less nodes).
 */
function createGalaxyForce(is3D = true) {
  let nodes = [];
  function force(alpha) {
    const projectPos = new Map();
    for (const n of nodes) {
      if (n.cls === "project") {
        projectPos.set(n.id, n);
      }
    }
    for (const n of nodes) {
      if (n.cls === "project") continue;
      if (n.project && projectPos.has(n.project)) {
        const target = projectPos.get(n.project);
        const k = (n.family === "event" ? 0.085 : 0.05) * alpha;
        n.vx = (n.vx || 0) + ((target.x || 0) - (n.x || 0)) * k;
        n.vy = (n.vy || 0) + ((target.y || 0) - (n.y || 0)) * k;
        if (is3D) {
          n.vz = (n.vz || 0) + ((target.z || 0) - (n.z || 0)) * k;
        }
      } else if (n.cls !== "me") {
        // Shared outer halo for project-less nodes; archived nodes drift further out as dust
        const x = n.x || 1;
        const y = n.y || 1;
        const z = is3D ? n.z || 0 : 0;
        const dist = Math.sqrt(x * x + y * y + z * z) || 1;
        const targetR = n.archived ? 245 : 180;
        const pull = ((targetR - dist) / dist) * 0.03 * alpha;
        n.vx = (n.vx || 0) + x * pull;
        n.vy = (n.vy || 0) + y * pull;
        if (is3D) n.vz = (n.vz || 0) + z * pull * 0.4;
      }
    }
  }
  force.initialize = function (_nodes) {
    nodes = _nodes;
  };
  return force;
}

function configureForces(graphInstance, is3D) {
  const charge = graphInstance.d3Force("charge");
  if (charge && typeof charge.strength === "function") {
    charge.strength((node) => (node.cls === "project" ? -120 : -30));
  }
  const linkForce = graphInstance.d3Force("link");
  if (linkForce) {
    if (typeof linkForce.distance === "function") {
      linkForce.distance((link) => {
        if (link.predicate === "project") return 26;
        if (link.predicate === "wikilink") return 68;
        return 44;
      });
    }
    if (typeof linkForce.strength === "function") {
      linkForce.strength((link) => {
        if (link.predicate === "project") return 0.35;
        if (link.predicate === "wikilink") return 0.025;
        return 0.16;
      });
    }
  }
  graphInstance.d3Force("galaxy", createGalaxyForce(is3D));
}

/**
 * Initialize both 3D and 2D ForceGraph instances sharing appState.sharedGraphData.
 */
function initGraphRenderers() {
  const el3d = document.getElementById("graph-3d");
  const el2d = document.getElementById("graph-2d");

  const fg3d = new ForceGraph3D(el3d, {
    controlType: "orbit",
    rendererConfig: { antialias: true, alpha: true },
  });

  fg3d
    .width(window.innerWidth)
    .height(window.innerHeight)
    .backgroundColor("rgba(0,0,0,0)")
    .showNavInfo(false)
    .nodeLabel(() => "")
    .linkLabel(() => "")
    .nodeRelSize(1)
    .nodeResolution(14)
    .nodeOpacity(1)
    .linkOpacity(1)
    .nodeVisibility((node) => appState.visibleNodeSet.has(node.id))
    .linkVisibility((link) => appState.visibleLinkSet.has(link))
    .nodeVal((node) => Math.pow(getNodeRadius(node), 3))
    .nodeColor((node) => getNodeColorString(node))
    .nodeThreeObjectExtend(true)
    .linkColor((link) => getLinkColorString(link))
    .linkWidth((link) => getLinkWidthValue(link))
    .linkDirectionalParticles((link) => (shouldShowParticles(link) ? 2 : 0))
    .linkDirectionalParticleWidth(1.8)
    .linkDirectionalParticleSpeed(0.006)
    .linkDirectionalParticleColor((link) => PREDICATE_COLORS[link.predicate] || "#ffd166")
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .onBackgroundClick(handleBackgroundClick);

  fg3d.graphData(appState.sharedGraphData);
  configureForces(fg3d, true);
  setTimeout(() => {
    appState.three = extractThreePrimitives(fg3d);
    if (appState.three) {
      fg3d.nodeThreeObject((node) => buildNodeThreeAttachment(node));
    }
  }, 20);

  const fg2d = new ForceGraph2D(el2d);
  fg2d
    .width(window.innerWidth)
    .height(window.innerHeight)
    .backgroundColor("rgba(0,0,0,0)")
    .nodeLabel(() => "")
    .linkLabel(() => "")
    .nodeRelSize(1)
    .nodeVisibility((node) => appState.visibleNodeSet.has(node.id))
    .linkVisibility((link) => appState.visibleLinkSet.has(link))
    .nodeVal((node) => Math.pow(getNodeRadius(node), 2))
    .nodeColor((node) => getNodeColorString(node))
    .nodeCanvasObjectMode(() => "replace")
    .nodeCanvasObject(paintNode2D)
    .linkColor((link) => getLinkColorString(link))
    .linkWidth((link) => getLinkWidthValue(link))
    .linkDirectionalParticles((link) => (shouldShowParticles(link) ? 2 : 0))
    .linkDirectionalParticleWidth(3.2)
    .linkDirectionalParticleSpeed(0.006)
    .linkDirectionalParticleColor((link) => PREDICATE_COLORS[link.predicate] || "#ffd166")
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .onBackgroundClick(handleBackgroundClick);

  fg2d.graphData(appState.sharedGraphData);
  configureForces(fg2d, false);
  // Start with 2D paused since 3D is default
  fg2d.pauseAnimation();

  appState.graph3d = fg3d;
  appState.graph2d = fg2d;
}

function refreshGraphVisuals() {
  if (appState.graph3d) {
    appState.graph3d
      .nodeVisibility((node) => appState.visibleNodeSet.has(node.id))
      .linkVisibility((link) => appState.visibleLinkSet.has(link))
      .nodeVal((node) => Math.pow(getNodeRadius(node), 3))
      .nodeColor((node) => getNodeColorString(node))
      .linkColor((link) => getLinkColorString(link))
      .linkDirectionalParticles((link) => (shouldShowParticles(link) ? 2 : 0));
    syncThreeAttachmentsVisualState();
  }
  if (appState.graph2d) {
    appState.graph2d
      .nodeVisibility((node) => appState.visibleNodeSet.has(node.id))
      .linkVisibility((link) => appState.visibleLinkSet.has(link))
      .nodeVal((node) => Math.pow(getNodeRadius(node), 2))
      .nodeColor((node) => getNodeColorString(node))
      .linkColor((link) => getLinkColorString(link))
      .linkDirectionalParticles((link) => (shouldShowParticles(link) ? 2 : 0));
  }
}

/**
 * Hover interaction: highlight 1-hop neighborhood & show floating card.
 */
function handleNodeHover(node) {
  appState.hoveredNode = node || null;
  appState.hoverSet = node ? appState.neighborsByNode.get(node.id) || new Set() : new Set();
  refreshGraphVisuals();
  renderHoverCard(node);
}

function renderHoverCard(node) {
  const card = document.getElementById("hover-card");
  if (!node) {
    card.classList.add("is-hidden");
    return;
  }
  card.classList.remove("is-hidden");
  const clsEl = document.getElementById("hover-cls");
  clsEl.textContent = node.cls;
  clsEl.style.borderColor = rgbaString(getNodeBaseHex(node), 0.6);

  const statusEl = document.getElementById("hover-status");
  statusEl.textContent = node.status || "—";

  const staleEl = document.getElementById("hover-stale");
  staleEl.classList.toggle("is-hidden", !node.stale);
  staleEl.textContent = t("staleBadge");

  document.getElementById("hover-title").textContent = node.title;
  document.getElementById("hover-path").textContent = node.id;
  document.getElementById("hover-updated").textContent = t("hoverUpdated", { date: node.updated || "—" });
  document.getElementById("hover-verified").textContent = t("hoverVerified", { date: node.verified || "—" });

  positionHoverCard();
}

function positionHoverCard() {
  const card = document.getElementById("hover-card");
  if (card.classList.contains("is-hidden")) return;
  const pad = 16;
  const rect = card.getBoundingClientRect();
  let x = appState.pointerX + 18;
  let y = appState.pointerY + 18;
  if (x + rect.width + pad > window.innerWidth) {
    x = Math.max(pad, appState.pointerX - rect.width - 18);
  }
  if (y + rect.height + pad > window.innerHeight) {
    y = Math.max(pad, appState.pointerY - rect.height - 18);
  }
  card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

/**
 * Click & Double-click interaction:
 * - Single-click: fly camera to node and open note inspector drawer.
 * - Double-click (within 320ms on same node): enter 2-hop focus mode.
 */
function handleNodeClick(node) {
  if (!node) return;
  const now = performance.now();
  const isDouble = appState.lastClickNodeId === node.id && now - appState.lastClickTime < 320;
  appState.lastClickNodeId = node.id;
  appState.lastClickTime = now;

  if (isDouble) {
    enterFocusMode(node);
  }
  focusCameraOnNode(node);
  openNoteDrawer(node);
}

function handleBackgroundClick() {
  const now = performance.now();
  if (now - appState.lastBgClickTime < 320) {
    if (appState.focusSet) {
      exitFocusMode();
    }
  }
  appState.lastBgClickTime = now;
}

function computeTwoHopSet(centerNodeId) {
  const visited = new Set([centerNodeId]);
  let frontier = [centerNodeId];
  for (let hop = 0; hop < 2; hop++) {
    const next = [];
    for (const id of frontier) {
      const neighbors = appState.neighborsByNode.get(id);
      if (!neighbors) continue;
      for (const nb of neighbors) {
        if (!visited.has(nb)) {
          visited.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

function enterFocusMode(node) {
  appState.focusNode = node;
  appState.focusSet = computeTwoHopSet(node.id);
  const pill = document.getElementById("focus-pill");
  const label = document.getElementById("focus-pill-label");
  pill.classList.remove("is-hidden");
  label.textContent = `${t("focusActivePrefix")}${node.title}`;
  updateDrawerFocusButton();
  refreshGraphVisuals();
  showToast(t("toastFocusEntered", { title: node.title }));
}

function exitFocusMode() {
  if (!appState.focusSet) return;
  appState.focusNode = null;
  appState.focusSet = null;
  document.getElementById("focus-pill").classList.add("is-hidden");
  updateDrawerFocusButton();
  refreshGraphVisuals();
  showToast(t("toastFocusExited"));
}

function updateDrawerFocusButton() {
  const btnLabel = document.getElementById("label-focus-subgraph");
  if (!btnLabel) return;
  const isFocusedOnSelected =
    appState.focusNode && appState.selectedNode && appState.focusNode.id === appState.selectedNode.id;
  btnLabel.textContent = isFocusedOnSelected ? t("drawerExitFocus") : t("drawerFocusSubgraph");
}

function focusCameraOnNode(node) {
  if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
  const duration = appState.reducedMotion ? 0 : 750;
  if (appState.mode === "3d" && appState.graph3d) {
    const z = node.z || 0;
    const dist = Math.hypot(node.x, node.y, z) || 1;
    const distance = 78;
    const ratio = 1 + distance / dist;
    appState.graph3d.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: z === 0 ? distance : z * ratio },
      { x: node.x, y: node.y, z },
      duration
    );
  } else if (appState.mode === "2d" && appState.graph2d) {
    appState.graph2d.centerAt(node.x, node.y, duration);
    appState.graph2d.zoom(2.6, duration);
  }
}

/**
 * Right Drawer: load & display note details via kg.note (or FIXTURE_NOTES fallback).
 */
async function openNoteDrawer(node) {
  appState.selectedNode = node;
  const appEl = document.getElementById("universe-app");
  const drawer = document.getElementById("note-drawer");
  drawer.classList.remove("is-hidden");
  appEl.classList.add("drawer-open");

  const clsBadge = document.getElementById("drawer-cls-badge");
  clsBadge.textContent = node.cls;
  clsBadge.style.borderColor = rgbaString(getNodeBaseHex(node), 0.65);

  const statusBadge = document.getElementById("drawer-status-badge");
  statusBadge.textContent = node.status || "—";

  const staleBadge = document.getElementById("drawer-stale-badge");
  staleBadge.classList.toggle("is-hidden", !node.stale);
  staleBadge.textContent = t("staleBadge");

  const redactedBadge = document.getElementById("drawer-redacted-badge");
  redactedBadge.classList.add("is-hidden");

  document.getElementById("drawer-title").textContent = node.title;
  document.getElementById("drawer-path").textContent = node.id;

  const copyBtn = document.getElementById("btn-copy-link");
  copyBtn.disabled = node.cls === "ghost" || node.cls === "memory" || node.cls === "me";

  const promoteBtn = document.getElementById("btn-promote-memory");
  promoteBtn.classList.toggle("is-hidden", node.cls !== "memory");

  updateDrawerFocusButton();

  const errBox = document.getElementById("drawer-error");
  errBox.classList.add("is-hidden");
  errBox.textContent = "";

  // Render relations grouped by predicate from graph links immediately
  renderDrawerRelations(node);

  // Synthetic ghost or memory nodes do not call kg.note
  if (node.cls === "ghost") {
    renderDrawerProperties(node, null);
    renderDrawerIssues([]);
    renderDrawerBacklinks(node.referencedBy || []);
    renderDrawerOutline([]);
    document.getElementById("drawer-truncated-badge").classList.add("is-hidden");
    document.getElementById("drawer-content").textContent = t("ghostPreviewNote", {
      count: (node.referencedBy || []).length,
    });
    return;
  }

  if (node.cls === "memory" || node.cls === "me") {
    renderDrawerProperties(node, null);
    renderDrawerIssues([]);
    renderDrawerBacklinks([]);
    renderDrawerOutline([]);
    document.getElementById("drawer-truncated-badge").classList.add("is-hidden");
    document.getElementById("drawer-content").textContent = t("memoryPreviewNote");
    return;
  }

  document.getElementById("drawer-content").textContent = t("loadingPreview");
  renderDrawerProperties(node, null);

  let noteData = null;
  if (appState.fixtureMode) {
    noteData = FIXTURE_NOTES.get?.(node.id) ?? FIXTURE_NOTES[node.id] ?? null;
  } else {
    try {
      noteData = await invokeBridge("kg.note", { path: node.id }, BRIDGE_TIMEOUT_MS);
    } catch (error) {
      if (appState.selectedNode?.id !== node.id) return;
      errBox.textContent = t("drawerBridgeError", { reason: error?.message || String(error) });
      errBox.classList.remove("is-hidden");
      noteData = FIXTURE_NOTES.get?.(node.id) ?? FIXTURE_NOTES[node.id] ?? null;
    }
  }

  if (appState.selectedNode?.id !== node.id) return;
  renderDrawerProperties(node, noteData);

  if (noteData) {
    redactedBadge.classList.toggle("is-hidden", !noteData.redacted);
    redactedBadge.textContent = t("redactedBadge");
    renderDrawerIssues(noteData.issues || node.issues.map((code) => ({ code, detail: "" })));
    renderDrawerBacklinks(noteData.backlinks || []);
    renderDrawerOutline(noteData.outline || []);
    const truncBadge = document.getElementById("drawer-truncated-badge");
    truncBadge.classList.toggle("is-hidden", !noteData.truncated);
    truncBadge.textContent = t("truncatedBadge");
    document.getElementById("drawer-content").textContent = noteData.content || "";
  } else {
    renderDrawerIssues(node.issues.map((code) => ({ code, detail: "" })));
    renderDrawerBacklinks([]);
    renderDrawerOutline([]);
    document.getElementById("drawer-content").textContent = "";
  }
}

function renderDrawerProperties(node, noteData) {
  const dl = document.getElementById("drawer-props");
  dl.innerHTML = "";
  const sha = noteData?.sha256 ? `${noteData.sha256.slice(0, 14)}…` : "—";
  const projNode = node.project ? appState.nodeById.get(node.project) : null;
  const rows = [
    [t("propClass"), node.cls, false],
    [t("propFamily"), node.family || "—", false],
    [t("propStatus"), node.status || "—", false],
    [t("propStability"), node.stability || "—", false],
    [t("propCreated"), node.created || "—", false],
    [t("propUpdated"), node.updated || "—", false],
    [t("propVerified"), node.verified || "—", false],
    [t("propDegree"), String(node.degree ?? 0), false],
    [t("propChars"), (node.chars ?? 0).toLocaleString(), false],
    [t("propSha"), sha, false, noteData?.sha256 || ""],
    ...(projNode ? [[t("propProject"), projNode.title, true, projNode.id]] : []),
  ];

  for (const [term, desc, fullSpan, tooltip] of rows) {
    const cell = document.createElement("div");
    cell.className = `prop-cell${fullSpan ? " full-span" : ""}`;
    const dt = document.createElement("dt");
    dt.className = "prop-term";
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.className = "prop-desc";
    dd.textContent = desc;
    if (tooltip) dd.title = tooltip;
    cell.append(dt, dd);
    dl.appendChild(cell);
  }
}

function renderDrawerIssues(issues) {
  const wrap = document.getElementById("drawer-issues");
  wrap.innerHTML = "";
  if (!Array.isArray(issues) || issues.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("emptyIssues");
    wrap.appendChild(empty);
    return;
  }
  for (const raw of issues) {
    const code = typeof raw === "string" ? raw : raw.code;
    const detail = typeof raw === "string" ? "" : raw.detail;
    const sev = classifyIssueCode(code);
    const card = document.createElement("div");
    card.className = "issue-card";
    const badge = document.createElement("span");
    badge.className = `issue-pill sev-${sev}`;
    badge.textContent = code;
    card.appendChild(badge);
    if (detail) {
      const det = document.createElement("div");
      det.className = "issue-detail";
      det.textContent = detail;
      card.appendChild(det);
    }
    wrap.appendChild(card);
  }
}

function createNodeNavigationChip(nodeId) {
  const target = appState.nodeById.get(nodeId);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "node-chip";
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.style.background = target ? getNodeBaseHex(target) : "#94a3b8";
  const txt = document.createElement("span");
  txt.className = "node-chip-text";
  txt.textContent = target ? target.title : nodeId;
  btn.title = nodeId;
  btn.append(dot, txt);
  btn.addEventListener("click", () => {
    if (target) {
      focusCameraOnNode(target);
      openNoteDrawer(target);
    }
  });
  return btn;
}

function renderDrawerRelations(node) {
  const container = document.getElementById("drawer-relations");
  container.innerHTML = "";
  const incLinks = appState.linksByNode.get(node.id) || [];
  const grouped = new Map();

  for (const link of incLinks) {
    if (link.predicate === "wikilink") continue;
    const [sId, tId] = getLinkEndpoints(link);
    const otherId = sId === node.id ? tId : sId;
    const dir = sId === node.id ? "→" : "←";
    const key = `${link.predicate} (${dir})`;
    if (!grouped.has(key)) grouped.set(key, { predicate: link.predicate, targets: [] });
    if (!grouped.get(key).targets.includes(otherId)) {
      grouped.get(key).targets.push(otherId);
    }
  }

  if (grouped.size === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("emptyRelations");
    container.appendChild(empty);
    return;
  }

  for (const [label, group] of grouped.entries()) {
    const box = document.createElement("div");
    box.className = "relation-group";
    const head = document.createElement("div");
    head.className = "relation-predicate";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.style.background = PREDICATE_COLORS[group.predicate] || "#94a3b8";
    const text = document.createElement("span");
    text.textContent = label;
    head.append(dot, text);

    const chips = document.createElement("div");
    chips.className = "drawer-chip-list";
    for (const targetId of group.targets) {
      chips.appendChild(createNodeNavigationChip(targetId));
    }
    box.append(head, chips);
    container.appendChild(box);
  }
}

function renderDrawerBacklinks(backlinks) {
  const container = document.getElementById("drawer-backlinks");
  container.innerHTML = "";
  if (!Array.isArray(backlinks) || backlinks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = t("emptyBacklinks");
    container.appendChild(empty);
    return;
  }
  for (const path of backlinks) {
    container.appendChild(createNodeNavigationChip(path));
  }
}

function renderDrawerOutline(outline) {
  const ul = document.getElementById("drawer-outline");
  ul.innerHTML = "";
  if (!Array.isArray(outline) || outline.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-note";
    li.textContent = t("emptyOutline");
    ul.appendChild(li);
    return;
  }
  for (const item of outline) {
    const li = document.createElement("li");
    const lvl = clamp(Number(item.level) || 1, 1, 3);
    li.className = `outline-item lvl-${lvl}`;
    const spanText = document.createElement("span");
    spanText.textContent = item.text;
    const spanLine = document.createElement("span");
    spanLine.className = "outline-line";
    spanLine.textContent = `L${item.line}`;
    li.append(spanText, spanLine);
    ul.appendChild(li);
  }
}

function closeNoteDrawer() {
  appState.selectedNode = null;
  document.getElementById("note-drawer").classList.add("is-hidden");
  document.getElementById("universe-app").classList.remove("drawer-open");
}

async function handleCopyObsidianLink() {
  const node = appState.selectedNode;
  if (!node) return;
  const vaultName = appState.rawPayload?.vaultName || "Knowledge";
  const fallbackLink = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(node.id)}`;

  if (appState.fixtureMode && (!window.pluginBridge || typeof window.pluginBridge.invoke !== "function")) {
    try {
      await navigator.clipboard?.writeText?.(fallbackLink);
    } catch {
      // Clipboard API may be restricted in sandboxed preview; still show synthesized link toast
    }
    showToast(t("toastCopied", { link: fallbackLink }));
    return;
  }

  try {
    const res = await invokeBridge("kg.copyLink", { path: node.id }, BRIDGE_TIMEOUT_MS);
    showToast(t("toastCopied", { link: res?.link || fallbackLink }));
  } catch (error) {
    showToast(t("toastCopyFailed", { reason: error?.message || String(error) }), true);
  }
}

/**
 * Health Mode & Accessible DOM Table.
 */
function toggleHealthMode(forceValue) {
  appState.healthMode = typeof forceValue === "boolean" ? forceValue : !appState.healthMode;
  const btn = document.getElementById("btn-health-mode");
  btn.classList.toggle("is-active", appState.healthMode);
  btn.setAttribute("aria-pressed", String(appState.healthMode));

  const region = document.getElementById("health-region");
  region.classList.toggle("is-hidden", !appState.healthMode);

  const legendHealth = document.getElementById("legend-health-wrap");
  legendHealth.classList.toggle("is-hidden", !appState.healthMode);

  renderHealthTable();
  refreshGraphVisuals();
}

function renderHealthTable() {
  const tbody = document.getElementById("health-tbody");
  const summaryEl = document.getElementById("health-summary-pills");
  const countBadge = document.getElementById("health-count-badge");
  if (!tbody) return;

  const issueNodes = appState.sharedGraphData.nodes.filter(
    (n) => n.cls !== "ghost" && Array.isArray(n.issues) && n.issues.length > 0
  );
  countBadge.textContent = String(issueNodes.length);

  let redCount = 0;
  let amberCount = 0;
  let mutedCount = 0;
  for (const n of issueNodes) {
    if (n.severity === "red") redCount++;
    else if (n.severity === "amber") amberCount++;
    else mutedCount++;
  }

  summaryEl.innerHTML = "";
  const pills = [
    ["sev-red", `UNKNOWN_*: ${redCount}`],
    ["sev-amber", `VIOLATION: ${amberCount}`],
    ["sev-muted", `HYGIENE: ${mutedCount}`],
  ];
  for (const [cls, text] of pills) {
    const span = document.createElement("span");
    span.className = `issue-pill ${cls}`;
    span.textContent = text;
    summaryEl.appendChild(span);
  }

  const filterSev = appState.filters.healthSeverity;
  const filtered = issueNodes
    .filter((n) => filterSev === "all" || n.severity === filterSev)
    .sort((a, b) => {
      const order = { red: 0, amber: 1, muted: 2 };
      const diff = (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
      return diff !== 0 ? diff : b.chars - a.chars;
    });

  tbody.innerHTML = "";
  if (filtered.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "empty-note";
    td.textContent = t("healthEmpty");
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const node of filtered) {
    const tr = document.createElement("tr");
    tr.className = "health-row";
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-label", `${node.title} (${node.cls}): ${node.issues.join(", ")}`);

    const tdPath = document.createElement("td");
    const titleDiv = document.createElement("div");
    titleDiv.className = "health-row-title";
    titleDiv.textContent = node.title;
    const pathDiv = document.createElement("div");
    pathDiv.className = "health-row-path";
    pathDiv.textContent = node.id;
    tdPath.append(titleDiv, pathDiv);

    const tdCls = document.createElement("td");
    const clsSpan = document.createElement("span");
    clsSpan.className = "cls-badge";
    clsSpan.textContent = node.cls;
    tdCls.appendChild(clsSpan);

    const tdChars = document.createElement("td");
    tdChars.className = "health-chars";
    tdChars.textContent = (node.chars || 0).toLocaleString();

    const tdIssues = document.createElement("td");
    const pillWrap = document.createElement("div");
    pillWrap.className = "drawer-chip-list";
    for (const code of node.issues) {
      const pill = document.createElement("span");
      pill.className = `issue-pill sev-${classifyIssueCode(code)}`;
      pill.textContent = code;
      pillWrap.appendChild(pill);
    }
    tdIssues.appendChild(pillWrap);

    const activateRow = () => {
      if (!appState.visibleNodeSet.has(node.id)) {
        // Ensure node is revealed if hidden by archive/navigation toggle
        if (node.archived) {
          appState.filters.showArchived = true;
          document.getElementById("toggle-archived").checked = true;
        }
        if (node.family === "navigation") {
          appState.filters.showNavigation = true;
          document.getElementById("toggle-navigation").checked = true;
        }
        recomputeVisibility();
      }
      focusCameraOnNode(node);
      openNoteDrawer(node);
    };

    tr.addEventListener("click", activateRow);
    tr.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        activateRow();
      }
    });

    tr.append(tdPath, tdCls, tdChars, tdIssues);
    tbody.appendChild(tr);
  }
}

/**
 * Fuzzy Search with `/` shortcut, arrow navigation, and Enter to fly to node.
 */
function scoreFuzzyMatch(query, candidate) {
  if (!candidate) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (c === q) return 120;
  if (c.startsWith(q)) return 95;
  const idx = c.indexOf(q);
  if (idx !== -1) return 75 - Math.min(25, idx * 0.4);

  // Character-order fuzzy subsequence match
  let qi = 0;
  let streak = 0;
  let score = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      qi++;
      streak++;
      score += 2 + streak * 1.5;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : 0;
}

function runFuzzySearch(rawQuery) {
  const query = String(rawQuery || "").trim();
  const listEl = document.getElementById("search-results");
  const inputEl = document.getElementById("search-input");

  if (!query) {
    appState.searchMatches = [];
    appState.searchActiveIndex = 0;
    listEl.classList.add("is-hidden");
    inputEl.setAttribute("aria-expanded", "false");
    return;
  }

  const scored = [];
  for (const node of appState.sharedGraphData.nodes) {
    if (node.cls === "ghost" && !appState.filters.showGhosts) continue;
    const titleScore = scoreFuzzyMatch(query, node.title) * 1.4;
    const pathScore = scoreFuzzyMatch(query, node.id);
    const best = Math.max(titleScore, pathScore);
    if (best > 0) {
      scored.push({ node, score: best + Math.log2(1 + (node.degree || 0)) * 0.8 });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  appState.searchMatches = scored.slice(0, 10).map((s) => s.node);
  appState.searchActiveIndex = 0;
  renderSearchResults();
}

function renderSearchResults() {
  const listEl = document.getElementById("search-results");
  const inputEl = document.getElementById("search-input");
  listEl.innerHTML = "";
  listEl.classList.remove("is-hidden");
  inputEl.setAttribute("aria-expanded", "true");

  if (appState.searchMatches.length === 0) {
    const li = document.createElement("li");
    li.className = "search-item empty-note";
    li.textContent = t("searchNoMatch");
    listEl.appendChild(li);
    return;
  }

  appState.searchMatches.forEach((node, idx) => {
    const li = document.createElement("li");
    li.className = `search-item${idx === appState.searchActiveIndex ? " is-active" : ""}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(idx === appState.searchActiveIndex));

    const main = document.createElement("div");
    main.className = "search-item-main";
    const title = document.createElement("div");
    title.className = "search-item-title";
    title.textContent = node.title;
    const path = document.createElement("div");
    path.className = "search-item-path";
    path.textContent = node.id;
    main.append(title, path);

    const badge = document.createElement("span");
    badge.className = "cls-badge";
    badge.textContent = node.cls;
    badge.style.borderColor = rgbaString(getNodeBaseHex(node), 0.55);

    li.append(main, badge);
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      selectSearchMatch(node);
    });
    listEl.appendChild(li);
  });
}

function selectSearchMatch(node) {
  if (!node) return;
  if (!appState.visibleNodeSet.has(node.id)) {
    if (node.archived) {
      appState.filters.showArchived = true;
      document.getElementById("toggle-archived").checked = true;
    }
    if (node.family === "navigation") {
      appState.filters.showNavigation = true;
      document.getElementById("toggle-navigation").checked = true;
    }
    recomputeVisibility();
  }
  document.getElementById("search-results").classList.add("is-hidden");
  document.getElementById("search-input").setAttribute("aria-expanded", "false");
  focusCameraOnNode(node);
  openNoteDrawer(node);
}

/**
 * Legend canvas swatch drawing.
 */
function drawLegendClassSwatch(canvas, cls) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = 20 * dpr;
  canvas.height = 20 * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 20, 20);

  const mockNode = {
    cls: cls === "archived" ? "topic" : cls,
    family: cls === "navigation" ? "navigation" : "entity",
    archived: cls === "archived",
    stale: false,
    glow: 1,
    baseRadius: 5,
    healthRadius: 5,
    severity: "ok",
    x: 10,
    y: 10,
  };
  const prevHealth = appState.healthMode;
  appState.healthMode = false;
  paintNode2D(mockNode, ctx, 1);
  appState.healthMode = prevHealth;
}

function renderLegend() {
  const clsContainer = document.getElementById("legend-classes");
  clsContainer.innerHTML = "";
  for (const cls of LEGEND_CLASSES_ORDER) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const canvas = document.createElement("canvas");
    canvas.className = "legend-swatch";
    drawLegendClassSwatch(canvas, cls);
    const label = document.createElement("span");
    label.className = "legend-label";
    label.textContent = tClass(cls);
    label.title = tClass(cls);
    item.append(canvas, label);
    clsContainer.appendChild(item);
  }

  const predContainer = document.getElementById("legend-predicates");
  predContainer.innerHTML = "";
  for (const pred of LEGEND_PREDICATES_ORDER) {
    const item = document.createElement("div");
    item.className = "predicate-item";
    const line = document.createElement("span");
    line.className = `predicate-line${pred === "wikilink" ? " is-weak" : ""}`;
    line.style.background =
      pred === "wikilink" ? "rgba(148, 163, 184, 0.35)" : PREDICATE_COLORS[pred] || "#94a3b8";
    const label = document.createElement("span");
    label.className = "legend-label";
    label.textContent = tPredicate(pred);
    label.title = tPredicate(pred);
    item.append(line, label);
    predContainer.appendChild(item);
  }

  const healthContainer = document.getElementById("legend-health");
  healthContainer.innerHTML = "";
  const healthSpec = [
    ["red", HEALTH_COLORS.red],
    ["amber", HEALTH_COLORS.amber],
    ["muted", HEALTH_COLORS.muted],
    ["ok", "#475569"],
  ];
  for (const [key, color] of healthSpec) {
    const item = document.createElement("div");
    item.className = "legend-item";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.style.background = color;
    const label = document.createElement("span");
    label.className = "legend-label";
    const text = STRINGS[appState.lang]?.healthLegend?.[key] || STRINGS.en.healthLegend[key];
    label.textContent = text;
    label.title = text;
    item.append(dot, label);
    healthContainer.appendChild(item);
  }
}

/**
 * Populate filter dropdowns and localize all static UI elements.
 */
function populateFilterSelects() {
  const clsSelect = document.getElementById("filter-class");
  const currentCls = appState.filters.cls;
  clsSelect.innerHTML = "";
  const classes = [
    ["all", t("allClasses")],
    ["project", tClass("project")],
    ["topic", tClass("topic")],
    ["environment", tClass("environment")],
    ["organization", tClass("organization")],
    ["technology", tClass("technology")],
    ["reference", tClass("reference")],
    ["convention", tClass("convention")],
    ["procedure", tClass("procedure")],
    ["decision", tClass("decision")],
    ["release", tClass("release")],
    ["incident", tClass("incident")],
    ["record", tClass("record")],
    ["navigation", tClass("navigation")],
  ];
  for (const [val, label] of classes) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    clsSelect.appendChild(opt);
  }
  clsSelect.value = currentCls;

  const projSelect = document.getElementById("filter-project");
  const currentProj = appState.filters.project;
  projSelect.innerHTML = "";
  const allProjOpt = document.createElement("option");
  allProjOpt.value = "all";
  allProjOpt.textContent = t("allProjects");
  projSelect.appendChild(allProjOpt);

  const noneProjOpt = document.createElement("option");
  noneProjOpt.value = "__none__";
  noneProjOpt.textContent = t("noProjectHalo");
  projSelect.appendChild(noneProjOpt);

  for (const proj of appState.projectNodes) {
    const opt = document.createElement("option");
    opt.value = proj.id;
    opt.textContent = proj.title;
    projSelect.appendChild(opt);
  }
  projSelect.value = currentProj;

  const stabSelect = document.getElementById("filter-stability");
  const currentStab = appState.filters.stability;
  stabSelect.innerHTML = "";
  for (const [val, label] of [
    ["all", t("allStabilities")],
    ["stable", "stable"],
    ["mixed", "mixed"],
    ["volatile", "volatile"],
    ["historical", "historical"],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    stabSelect.appendChild(opt);
  }
  stabSelect.value = currentStab;

  const healthFilterSelect = document.getElementById("health-severity-filter");
  const currentSev = appState.filters.healthSeverity;
  healthFilterSelect.innerHTML = "";
  for (const [val, label] of [
    ["all", t("healthFilterAll")],
    ["red", t("healthFilterRed")],
    ["amber", t("healthFilterAmber")],
    ["muted", t("healthFilterMuted")],
  ]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    healthFilterSelect.appendChild(opt);
  }
  healthFilterSelect.value = currentSev;
}

function updateMemoryToggleState() {
  const mem = appState.rawPayload?.memory || { status: "unsupported", count: 0 };
  const checkbox = document.getElementById("toggle-memory");
  const row = document.getElementById("memory-toggle-row");
  const isOk = mem.status === "ok";
  checkbox.disabled = !isOk;
  row.classList.toggle("is-disabled", !isOk);
  row.title = isOk
    ? t("memoryOkTip", { count: mem.count || 0 })
    : t("memoryUnavailableTip", { status: mem.status || "unsupported" });
}

function applyTranslations() {
  document.documentElement.lang = appState.lang;
  document.getElementById("hud-title").textContent = t("title");
  document.getElementById("fixture-badge").textContent = t("fixtureBadge");
  document.getElementById("search-input").placeholder = t("searchPlaceholder");
  document.getElementById("label-health-btn").textContent = t("healthBtn");
  document.getElementById("label-filters-btn").textContent = t("filtersBtn");
  document.getElementById("label-legend-btn").textContent = t("legendBtn");
  document.getElementById("btn-zoom-fit").title = t("zoomFitTitle");
  document.getElementById("btn-lang").textContent = t("langSwitchLabel");

  document.getElementById("filters-heading").textContent = t("filtersHeading");
  document.getElementById("btn-reset-filters").textContent = t("resetBtn");
  document.getElementById("label-filter-class").textContent = t("filterClassLabel");
  document.getElementById("label-filter-project").textContent = t("filterProjectLabel");
  document.getElementById("label-filter-stability").textContent = t("filterStabilityLabel");

  document.getElementById("label-toggle-stale").textContent = t("toggleStale");
  document.getElementById("label-toggle-events").textContent = t("toggleEvents");
  document.getElementById("label-toggle-navigation").textContent = t("toggleNavigation");
  document.getElementById("label-toggle-weak").textContent = t("toggleWeakLinks");
  document.getElementById("label-toggle-ghosts").textContent = t("toggleGhosts");
  document.getElementById("label-toggle-archived").textContent = t("toggleArchived");
  document.getElementById("label-toggle-memory").textContent = t("toggleMemory");

  document.getElementById("legend-heading").textContent = t("legendHeading");
  document.getElementById("legend-predicates-title").textContent = t("legendPredicatesTitle");
  document.getElementById("legend-health-title").textContent = t("legendHealthTitle");

  const healthRegion = document.getElementById("health-region");
  healthRegion.setAttribute("aria-label", t("healthRegionAria"));
  document.getElementById("health-heading").textContent = t("healthHeading");
  document.getElementById("th-health-path").textContent = t("thPath");
  document.getElementById("th-health-class").textContent = t("thClass");
  document.getElementById("th-health-chars").textContent = t("thChars");
  document.getElementById("th-health-issues").textContent = t("thIssues");

  document.getElementById("timelapse-play-label").textContent = appState.timelapsePlaying
    ? t("timelapsePause")
    : t("timelapsePlay");
  document.getElementById("label-timelapse").textContent = t("timelapseLabel");
  document.getElementById("timelapse-reset").textContent = t("resetBtn");

  document.getElementById("label-copy-link").textContent = t("drawerCopyLink");
  document.getElementById("label-promote-memory").textContent = t("drawerPromoteMemory");
  document.getElementById("sec-props-title").textContent = t("secProps");
  document.getElementById("sec-issues-title").textContent = t("secIssues");
  document.getElementById("sec-relations-title").textContent = t("secRelations");
  document.getElementById("sec-backlinks-title").textContent = t("secBacklinks");
  document.getElementById("sec-outline-title").textContent = t("secOutline");
  document.getElementById("sec-preview-title").textContent = t("secPreview");

  document.getElementById("btn-retry-bridge").textContent = t("retryBtn");
  document.getElementById("btn-dismiss-error").textContent = t("dismissBtn");


  const settingsBtn = document.getElementById("btn-settings");
  settingsBtn.title = t("settingsBtnTitle");
  settingsBtn.setAttribute("aria-label", t("settingsBtnTitle"));
  document.getElementById("label-settings-btn").textContent = t("settingsBtn");
  applySettingsTranslations();
  populateFilterSelects();
  updateMemoryToggleState();
  renderLegend();
  renderHealthTable();
  updateHeaderCounts();
  updateTimelapseReadout();
  updateDrawerFocusButton();
  if (appState.selectedNode) {
    openNoteDrawer(appState.selectedNode);
  }
}

function updateHeaderCounts() {
  const baseTotal = (appState.rawPayload?.nodes || []).length;
  const ghostTotal = appState.filters.showGhosts ? (appState.rawPayload?.ghosts || []).length : 0;
  const totalReal = baseTotal + ghostTotal;
  const visNodes = appState.visibleNodeSet.size;
  const visLinks = appState.visibleLinkSet.size;
  document.getElementById("counts-badge").textContent = t("countsFormat", {
    visNodes,
    totalNodes: totalReal,
    visLinks,
  });
}

function updateTimelapseReadout() {
  const readout = document.getElementById("timelapse-readout");
  const count = appState.visibleNodeSet.size;
  if (appState.timelapseRatio >= 0.999) {
    readout.textContent = t("timelapseAll", { count });
  } else {
    const ms =
      appState.minCreatedMs + appState.timelapseRatio * Math.max(1, appState.maxCreatedMs - appState.minCreatedMs);
    const date = new Date(ms).toISOString().slice(0, 10);
    readout.textContent = t("timelapseCutoff", { date, count });
  }
}

/**
 * Time-lapse playback animation.
 */
function startTimelapsePlayback() {
  if (appState.timelapsePlaying) return;
  if (appState.timelapseRatio >= 0.995) {
    appState.timelapseRatio = 0;
  }
  appState.timelapsePlaying = true;
  document.getElementById("timelapse-play-icon").textContent = "⏸";
  document.getElementById("timelapse-play-label").textContent = t("timelapsePause");

  const slider = document.getElementById("timelapse-slider");
  let lastTs = performance.now();
  const durationMs = 7500;

  function step(now) {
    if (!appState.timelapsePlaying) return;
    const dt = now - lastTs;
    lastTs = now;
    appState.timelapseRatio = Math.min(1, appState.timelapseRatio + dt / durationMs);
    slider.value = String(Math.round(appState.timelapseRatio * 1000));
    recomputeVisibility();
    refreshGraphVisuals();

    if (appState.timelapseRatio >= 1) {
      stopTimelapsePlayback();
      return;
    }
    appState.timelapseRaf = requestAnimationFrame(step);
  }
  appState.timelapseRaf = requestAnimationFrame(step);
}

function stopTimelapsePlayback() {
  appState.timelapsePlaying = false;
  if (appState.timelapseRaf !== null) {
    cancelAnimationFrame(appState.timelapseRaf);
    appState.timelapseRaf = null;
  }
  document.getElementById("timelapse-play-icon").textContent = "▶";
  document.getElementById("timelapse-play-label").textContent = t("timelapsePlay");
}

/**
 * Switch between 3D and 2D modes while sharing the exact same graphData.
 */
function switchDimensionMode(mode) {
  if (mode !== "3d" && mode !== "2d") return;
  appState.mode = mode;
  const el3d = document.getElementById("graph-3d");
  const el2d = document.getElementById("graph-2d");
  const btn3d = document.getElementById("btn-mode-3d");
  const btn2d = document.getElementById("btn-mode-2d");

  const is3d = mode === "3d";
  el3d.classList.toggle("is-hidden", !is3d);
  el2d.classList.toggle("is-hidden", is3d);
  btn3d.classList.toggle("is-active", is3d);
  btn3d.setAttribute("aria-pressed", String(is3d));
  btn2d.classList.toggle("is-active", !is3d);
  btn2d.setAttribute("aria-pressed", String(!is3d));

  if (is3d) {
    appState.graph2d?.pauseAnimation();
    if (!appState.pageHidden) appState.graph3d?.resumeAnimation();
  } else {
    appState.graph3d?.pauseAnimation();
    if (!appState.pageHidden) {
      appState.graph2d?.resumeAnimation();
      appState.graph2d?.zoomToFit(appState.reducedMotion ? 0 : 400, 48, (n) => appState.visibleNodeSet.has(n.id));
    }
  }
  refreshGraphVisuals();
}

function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.remove("is-hidden");
  if (appState.toastTimer) clearTimeout(appState.toastTimer);
  appState.toastTimer = setTimeout(() => {
    toast.classList.add("is-hidden");
  }, 3200);
}

/**
 * Load graph payload from host bridge or fall back to standalone fixture mode.
 */
async function loadUniverseGraph() {
  const banner = document.getElementById("bridge-error-banner");
  const bannerText = document.getElementById("bridge-error-text");
  const fixtureBadge = document.getElementById("fixture-badge");

  let payload = null;
  const hasBridge = Boolean(window.pluginBridge && typeof window.pluginBridge.invoke === "function");

  if (!hasBridge) {
    appState.fixtureMode = true;
    payload = FIXTURE_GRAPH;
    banner.classList.add("is-hidden");
  } else {
    try {
      payload = await invokeBridge("kg.graph", { includeMemory: false }, BRIDGE_TIMEOUT_MS);
      if (!payload || !Array.isArray(payload.nodes)) {
        throw new Error("Invalid graph payload");
      }
      appState.fixtureMode = false;
      banner.classList.add("is-hidden");
    } catch (error) {
      appState.fixtureMode = true;
      payload = FIXTURE_GRAPH;
      bannerText.textContent =
        error?.code === "BRIDGE_TIMEOUT"
          ? t("bridgeTimeoutError")
          : t("bridgeCallError", { reason: error?.message || String(error) });
      banner.classList.remove("is-hidden");
    }
  }

  fixtureBadge.classList.toggle("is-hidden", !appState.fixtureMode);
  document.getElementById("vault-badge").textContent = payload.vaultName || "Knowledge";

  prepareSharedGraph(payload);
  recomputeVisibility();

  if (!appState.graph3d) {
    initGraphRenderers();
  } else {
    appState.graph3d.graphData(appState.sharedGraphData);
    appState.graph2d.graphData(appState.sharedGraphData);
  }

  applyTranslations();
  refreshGraphVisuals();
}

const DEFAULT_EMBEDDING_SETTINGS = {
  enabled: false,
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "nomic-embed-text",
  allowRemote: false,
  apiKeyEnv: "",
  exclude: [],
};

function parseExcludeFolders(rawText) {
  return String(rawText || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeEmbeddingConfig(raw) {
  const src = raw || DEFAULT_EMBEDDING_SETTINGS;
  return {
    enabled: Boolean(src.enabled),
    provider: src.provider === "openai-compatible" ? "openai-compatible" : "ollama",
    baseUrl: String(src.baseUrl ?? DEFAULT_EMBEDDING_SETTINGS.baseUrl).trim(),
    model: String(src.model ?? DEFAULT_EMBEDDING_SETTINGS.model).trim(),
    allowRemote: Boolean(src.allowRemote),
    apiKeyEnv: String(src.apiKeyEnv ?? "").trim(),
    exclude: Array.isArray(src.exclude)
      ? src.exclude.map((item) => String(item).trim()).filter((item) => item.length > 0)
      : [],
  };
}

function areEmbeddingConfigsEqual(a, b) {
  if (!a || !b) return false;
  if (
    a.enabled !== b.enabled ||
    a.provider !== b.provider ||
    a.baseUrl !== b.baseUrl ||
    a.model !== b.model ||
    a.allowRemote !== b.allowRemote ||
    a.apiKeyEnv !== b.apiKeyEnv ||
    a.exclude.length !== b.exclude.length
  ) {
    return false;
  }
  for (let i = 0; i < a.exclude.length; i++) {
    if (a.exclude[i] !== b.exclude[i]) return false;
  }
  return true;
}

function readSettingsFormValues() {
  return {
    enabled: Boolean(document.getElementById("settings-enabled").checked),
    provider:
      document.getElementById("settings-provider").value === "openai-compatible"
        ? "openai-compatible"
        : "ollama",
    baseUrl: document.getElementById("settings-baseurl").value.trim(),
    model: document.getElementById("settings-model").value.trim(),
    allowRemote: Boolean(document.getElementById("settings-allow-remote").checked),
    apiKeyEnv: document.getElementById("settings-apikey-env").value.trim(),
    exclude: parseExcludeFolders(document.getElementById("settings-exclude").value),
  };
}

function writeSettingsFormValues(config) {
  const norm = normalizeEmbeddingConfig(config);
  document.getElementById("settings-enabled").checked = norm.enabled;
  document.getElementById("settings-provider").value = norm.provider;
  document.getElementById("settings-baseurl").value = norm.baseUrl;
  document.getElementById("settings-model").value = norm.model;
  document.getElementById("settings-allow-remote").checked = norm.allowRemote;
  document.getElementById("settings-apikey-env").value = norm.apiKeyEnv;
  document.getElementById("settings-exclude").value = norm.exclude.join(", ");
}

function setSettingsControlsDisabled(disabled) {
  const ids = [
    "settings-enabled",
    "settings-provider",
    "settings-baseurl",
    "settings-model",
    "settings-apikey-env",
    "settings-exclude",
    "settings-allow-remote",
    "btn-settings-test",
    "btn-settings-save",
    "btn-settings-confirm",
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  }
  document.getElementById("settings-enabled-row")?.classList.toggle("is-disabled", disabled);
  document.getElementById("settings-remote-row")?.classList.toggle("is-disabled", disabled);
}

function clearSettingsFeedback() {
  const sp = appState.settingsPanel;
  sp.feedbackText = "";
  sp.feedbackIsError = false;
  sp.feedbackTestResult = null;
  const box = document.getElementById("settings-feedback");
  if (box) {
    box.textContent = "";
    box.classList.add("is-hidden");
    box.classList.remove("is-error", "is-ok");
  }
}

function showSettingsErrorVerbatim(rawMessage) {
  const sp = appState.settingsPanel;
  sp.feedbackText = String(rawMessage || "");
  sp.feedbackIsError = true;
  sp.feedbackTestResult = null;
  const box = document.getElementById("settings-feedback");
  if (!box) return;
  box.textContent = sp.feedbackText;
  box.classList.remove("is-hidden", "is-ok");
  box.classList.add("is-error");
}

function showSettingsTestSuccess(dims, latencyMs) {
  const sp = appState.settingsPanel;
  sp.feedbackTestResult = { dims, latencyMs };
  sp.feedbackIsError = false;
  sp.feedbackText = t("settingsTestOk", {
    dims: dims ?? "—",
    latencyMs: latencyMs ?? "—",
  });
  const box = document.getElementById("settings-feedback");
  if (!box) return;
  box.textContent = sp.feedbackText;
  box.classList.remove("is-hidden", "is-error");
  box.classList.add("is-ok");
}

function renderSettingsDynamicState() {
  const sp = appState.settingsPanel;
  const formValues = readSettingsFormValues();

  // Remote warning visibility
  const remoteWarn = document.getElementById("settings-remote-warning");
  remoteWarn.textContent = t("settingsRemoteWarning");
  remoteWarn.classList.toggle("is-hidden", !formValues.allowRemote);

  // Unsaved changes indicator
  const isDirty =
    sp.bridgeAvailable &&
    sp.baselineSnapshot !== null &&
    !areEmbeddingConfigsEqual(formValues, sp.baselineSnapshot);
  document.getElementById("settings-unsaved-pill").classList.toggle("is-hidden", !isDirty);
  const dirtyDot = document.getElementById("settings-estimate-dirty-dot");
  dirtyDot.classList.toggle("is-hidden", !isDirty);
  dirtyDot.title = t("settingsUnsaved");

  // Read-only key status
  const keyBadge = document.getElementById("settings-key-status");
  keyBadge.classList.remove("status-found", "status-missing", "status-not-required");
  if (sp.apiKeyStatus === "found") {
    keyBadge.classList.add("status-found");
    keyBadge.textContent = t("settingsKeyFound");
  } else if (sp.apiKeyStatus === "missing") {
    keyBadge.classList.add("status-missing");
    keyBadge.textContent = t("settingsKeyMissing");
  } else {
    keyBadge.classList.add("status-not-required");
    keyBadge.textContent = t("settingsKeyNotRequired");
  }

  // Read-only index statistics
  const indexEl = document.getElementById("settings-index-stats");
  if (sp.index && typeof sp.index === "object") {
    indexEl.textContent = t("settingsIndexFormat", {
      identity: sp.index.identity || "—",
      dims: sp.index.dims ?? "—",
      chunks: sp.index.chunks ?? 0,
      builtAt: sp.index.builtAt || "—",
    });
  } else {
    indexEl.textContent = t("settingsIndexNotBuilt");
  }

  // Read-only send estimate (saved state)
  const estEl = document.getElementById("settings-estimate-value");
  if (sp.estimate && typeof sp.estimate === "object") {
    estEl.textContent = t("settingsEstimateFormat", {
      chunks: sp.estimate.chunks ?? 0,
      characters: sp.estimate.characters ?? 0,
    });
  } else {
    estEl.textContent = "—";
  }

  // Second-click confirm button when turning allowRemote ON (saved false -> form true)
  const confirmBtn = document.getElementById("btn-settings-confirm");
  const confirmLabel = document.getElementById("label-settings-confirm");
  const savedRemote = Boolean(sp.savedSettings?.allowRemote);
  if (!formValues.allowRemote || savedRemote) {
    sp.confirmingRemote = false;
  }
  confirmLabel.textContent = t("settingsConfirmSendBtn", {
    chunks: sp.estimate?.chunks ?? 0,
    characters: sp.estimate?.characters ?? 0,
  });
  confirmBtn.classList.toggle("is-hidden", !sp.confirmingRemote);
}

function applySettingsTranslations() {
  const panel = document.getElementById("settings-panel");
  if (!panel) return;
  panel.setAttribute("aria-label", t("settingsHeading"));
  document.getElementById("settings-heading").textContent = t("settingsHeading");
  document.getElementById("settings-close").setAttribute("aria-label", t("settingsCloseAria"));
  document.getElementById("settings-unsaved-label").textContent = t("settingsUnsaved");
  document.getElementById("settings-fixture-notice").textContent = t("settingsFixtureNotice");

  document.getElementById("label-settings-enabled").textContent = t("settingsEnabledLabel");
  document.getElementById("label-settings-provider").textContent = t("settingsProviderLabel");
  document.getElementById("opt-provider-ollama").textContent = t("settingsProviderOllama");
  document.getElementById("opt-provider-openai").textContent = t("settingsProviderOpenai");

  document.getElementById("label-settings-baseurl").textContent = t("settingsBaseUrlLabel");
  document.getElementById("settings-baseurl").placeholder = t("settingsBaseUrlPlaceholder");
  document.getElementById("hint-settings-baseurl").textContent = t("settingsBaseUrlHint");

  document.getElementById("label-settings-model").textContent = t("settingsModelLabel");
  document.getElementById("settings-model").placeholder = t("settingsModelPlaceholder");

  document.getElementById("label-settings-apikey-env").textContent = t("settingsApiKeyEnvLabel");
  document.getElementById("settings-apikey-env").placeholder = t("settingsApiKeyEnvPlaceholder");
  document.getElementById("hint-settings-apikey-env").textContent = t("settingsApiKeyEnvHint");

  document.getElementById("label-settings-exclude").textContent = t("settingsExcludeLabel");
  document.getElementById("settings-exclude").placeholder = t("settingsExcludePlaceholder");
  document.getElementById("hint-settings-exclude").textContent = t("settingsExcludeHint");

  document.getElementById("label-settings-allow-remote").textContent = t("settingsAllowRemoteLabel");
  document.getElementById("label-settings-key-status").textContent = t("settingsKeyStatusLabel");
  document.getElementById("label-settings-index").textContent = t("settingsIndexLabel");
  document.getElementById("label-settings-estimate").textContent = t("settingsEstimateLabel");

  document.getElementById("label-settings-test").textContent = t("settingsTestBtn");
  document.getElementById("label-settings-save").textContent = t("settingsSaveBtn");

  if (appState.settingsPanel.feedbackTestResult) {
    showSettingsTestSuccess(
      appState.settingsPanel.feedbackTestResult.dims,
      appState.settingsPanel.feedbackTestResult.latencyMs
    );
  }
  renderSettingsDynamicState();
}

async function loadSettingsFromBridge(populateForm = true) {
  const sp = appState.settingsPanel;
  const hasBridge = Boolean(window.pluginBridge && typeof window.pluginBridge.invoke === "function");
  sp.bridgeAvailable = hasBridge;

  const fixtureNotice = document.getElementById("settings-fixture-notice");
  fixtureNotice.classList.toggle("is-hidden", hasBridge);

  if (!hasBridge) {
    sp.savedSettings = null;
    sp.baselineSnapshot = normalizeEmbeddingConfig(DEFAULT_EMBEDDING_SETTINGS);
    sp.apiKeyStatus = "not-required";
    sp.index = null;
    sp.estimate = null;
    sp.confirmingRemote = false;
    if (populateForm) {
      writeSettingsFormValues(DEFAULT_EMBEDDING_SETTINGS);
    }
    clearSettingsFeedback();
    setSettingsControlsDisabled(true);
    renderSettingsDynamicState();
    return;
  }

  setSettingsControlsDisabled(true);
  try {
    const res = await invokeBridge("kg.settings.get", {}, BRIDGE_TIMEOUT_MS);
    sp.savedSettings = res?.settings ? normalizeEmbeddingConfig(res.settings) : null;
    sp.baselineSnapshot = normalizeEmbeddingConfig(res?.settings || DEFAULT_EMBEDDING_SETTINGS);
    sp.apiKeyStatus = res?.apiKeyStatus || "not-required";
    sp.index = res?.index || null;
    sp.estimate = res?.estimate || null;
    sp.confirmingRemote = false;

    if (populateForm) {
      writeSettingsFormValues(sp.baselineSnapshot);
    }

    if (res?.settingsError) {
      const code = res.settingsError.code || "";
      const msg = res.settingsError.message || "";
      const errStr = msg
        ? code && !msg.startsWith(code)
          ? `${code} ${msg}`
          : msg
        : code;
      showSettingsErrorVerbatim(errStr);
    } else {
      clearSettingsFeedback();
    }
  } catch (error) {
    showSettingsErrorVerbatim(error?.message || String(error));
  } finally {
    sp.busy = false;
    setSettingsControlsDisabled(!sp.bridgeAvailable);
    renderSettingsDynamicState();
  }
}

function openSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  const btn = document.getElementById("btn-settings");
  appState.settingsPanel.open = true;
  panel.classList.remove("is-hidden");
  btn.classList.add("is-active");
  btn.setAttribute("aria-expanded", "true");
  loadSettingsFromBridge(true);
}

function closeSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  const btn = document.getElementById("btn-settings");
  if (!appState.settingsPanel.open && panel.classList.contains("is-hidden")) return;
  appState.settingsPanel.open = false;
  appState.settingsPanel.confirmingRemote = false;
  panel.classList.add("is-hidden");
  btn.classList.remove("is-active");
  btn.setAttribute("aria-expanded", "false");
  btn.focus();
}

function toggleSettingsPanel() {
  if (appState.settingsPanel.open) {
    closeSettingsPanel();
  } else {
    openSettingsPanel();
  }
}

async function executeSettingsSave() {
  const sp = appState.settingsPanel;
  if (!sp.bridgeAvailable || sp.busy) return;
  const formValues = readSettingsFormValues();
  sp.busy = true;
  setSettingsControlsDisabled(true);
  try {
    await invokeBridge("kg.settings.set", { embedding: formValues }, BRIDGE_TIMEOUT_MS);
    sp.confirmingRemote = false;
    showToast(t("toastSettingsSaved"));
    await loadSettingsFromBridge(true);
  } catch (error) {
    sp.confirmingRemote = false;
    showSettingsErrorVerbatim(error?.message || String(error));
  } finally {
    sp.busy = false;
    setSettingsControlsDisabled(!sp.bridgeAvailable);
    renderSettingsDynamicState();
  }
}

function handleSettingsSaveClick() {
  const sp = appState.settingsPanel;
  if (!sp.bridgeAvailable || sp.busy) return;
  const formValues = readSettingsFormValues();
  const savedRemote = Boolean(sp.savedSettings?.allowRemote);

  if (formValues.allowRemote && !savedRemote) {
    sp.confirmingRemote = true;
    renderSettingsDynamicState();
    document.getElementById("btn-settings-confirm")?.focus();
    return;
  }
  executeSettingsSave();
}

async function handleSettingsTestClick() {
  const sp = appState.settingsPanel;
  if (!sp.bridgeAvailable || sp.busy) return;
  const formValues = readSettingsFormValues();
  sp.busy = true;
  setSettingsControlsDisabled(true);
  try {
    const res = await invokeBridge("kg.settings.test", { embedding: formValues }, BRIDGE_TIMEOUT_MS);
    if (res?.ok) {
      showSettingsTestSuccess(res.dims, res.latencyMs);
    } else {
      const reason = res?.reason ? String(res.reason) : "";
      const msg = res?.message ? String(res.message) : "";
      const verbatim = msg
        ? reason && !msg.startsWith(reason)
          ? `${reason} ${msg}`
          : msg
        : reason || "Test failed";
      showSettingsErrorVerbatim(verbatim);
    }
  } catch (error) {
    showSettingsErrorVerbatim(error?.message || String(error));
  } finally {
    sp.busy = false;
    setSettingsControlsDisabled(!sp.bridgeAvailable);
    renderSettingsDynamicState();
  }
}

/**
 * Wire UI event listeners and ambient loop.
 */
function bindUiEvents(backdrop) {
  window.addEventListener("pointermove", (ev) => {
    appState.pointerX = ev.clientX;
    appState.pointerY = ev.clientY;
    positionHoverCard();
  });

  window.addEventListener("resize", () => {
    backdrop.resize();
    appState.graph3d?.width(window.innerWidth).height(window.innerHeight);
    appState.graph2d?.width(window.innerWidth).height(window.innerHeight);
  });

  document.addEventListener("visibilitychange", () => {
    appState.pageHidden = document.hidden;
    if (document.hidden) {
      appState.graph3d?.pauseAnimation();
      appState.graph2d?.pauseAnimation();
    } else if (appState.mode === "3d") {
      appState.graph3d?.resumeAnimation();
    } else {
      appState.graph2d?.resumeAnimation();
    }
  });

  const motionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  motionQuery?.addEventListener?.("change", (ev) => {
    appState.reducedMotion = ev.matches;
    refreshGraphVisuals();
  });

  // Mode switches & header actions
  document.getElementById("btn-mode-3d").addEventListener("click", () => switchDimensionMode("3d"));
  document.getElementById("btn-mode-2d").addEventListener("click", () => switchDimensionMode("2d"));
  document.getElementById("btn-health-mode").addEventListener("click", () => toggleHealthMode());
  document.getElementById("btn-close-health").addEventListener("click", () => toggleHealthMode(false));

  document.getElementById("btn-toggle-filters").addEventListener("click", (ev) => {
    const panel = document.getElementById("filters-panel");
    const hidden = panel.classList.toggle("is-hidden");
    ev.currentTarget.classList.toggle("is-active", !hidden);
    ev.currentTarget.setAttribute("aria-expanded", String(!hidden));
  });

  document.getElementById("btn-toggle-legend").addEventListener("click", (ev) => {
    const panel = document.getElementById("legend-panel");
    const hidden = panel.classList.toggle("is-hidden");
    ev.currentTarget.classList.toggle("is-active", !hidden);
    ev.currentTarget.setAttribute("aria-expanded", String(!hidden));
  });

  document.getElementById("btn-zoom-fit").addEventListener("click", () => {
    const dur = appState.reducedMotion ? 0 : 600;
    const filterFn = (n) => appState.visibleNodeSet.has(n.id);
    if (appState.mode === "3d") {
      appState.graph3d?.zoomToFit(dur, 48, filterFn);
    } else {
      appState.graph2d?.zoomToFit(dur, 48, filterFn);
    }
  });

  document.getElementById("btn-lang").addEventListener("click", () => {
    appState.lang = appState.lang === "zh-CN" ? "en" : "zh-CN";
    applyTranslations();
  });

  // Retrieval settings panel controls
  document.getElementById("btn-settings").addEventListener("click", toggleSettingsPanel);
  document.getElementById("settings-close").addEventListener("click", closeSettingsPanel);
  document.getElementById("btn-settings-test").addEventListener("click", handleSettingsTestClick);
  document.getElementById("btn-settings-save").addEventListener("click", handleSettingsSaveClick);
  document.getElementById("btn-settings-confirm").addEventListener("click", executeSettingsSave);

  const onSettingsFieldInput = () => {
    appState.settingsPanel.confirmingRemote = false;
    renderSettingsDynamicState();
  };
  for (const fieldId of [
    "settings-enabled",
    "settings-provider",
    "settings-baseurl",
    "settings-model",
    "settings-apikey-env",
    "settings-exclude",
    "settings-allow-remote",
  ]) {
    const el = document.getElementById(fieldId);
    el.addEventListener("input", onSettingsFieldInput);
    el.addEventListener("change", onSettingsFieldInput);
  }

  document.getElementById("btn-exit-focus").addEventListener("click", () => exitFocusMode());
  document.getElementById("btn-retry-bridge").addEventListener("click", () => loadUniverseGraph());
  document.getElementById("btn-dismiss-error").addEventListener("click", () => {
    document.getElementById("bridge-error-banner").classList.add("is-hidden");
  });

  // Filters & toggles
  const applyFilterChange = () => {
    recomputeVisibility();
    refreshGraphVisuals();
  };

  document.getElementById("filter-class").addEventListener("change", (ev) => {
    appState.filters.cls = ev.target.value;
    applyFilterChange();
  });
  document.getElementById("filter-project").addEventListener("change", (ev) => {
    appState.filters.project = ev.target.value;
    applyFilterChange();
  });
  document.getElementById("filter-stability").addEventListener("change", (ev) => {
    appState.filters.stability = ev.target.value;
    applyFilterChange();
  });
  document.getElementById("filter-stale-only").addEventListener("change", (ev) => {
    appState.filters.staleOnly = ev.target.checked;
    applyFilterChange();
  });
  document.getElementById("toggle-events").addEventListener("change", (ev) => {
    appState.filters.showEvents = ev.target.checked;
    applyFilterChange();
  });
  document.getElementById("toggle-navigation").addEventListener("change", (ev) => {
    appState.filters.showNavigation = ev.target.checked;
    applyFilterChange();
  });
  document.getElementById("toggle-weak-links").addEventListener("change", (ev) => {
    appState.filters.showWeakLinks = ev.target.checked;
    applyFilterChange();
  });
  document.getElementById("toggle-ghosts").addEventListener("change", (ev) => {
    appState.filters.showGhosts = ev.target.checked;
    applyFilterChange();
  });
  document.getElementById("toggle-archived").addEventListener("change", (ev) => {
    appState.filters.showArchived = ev.target.checked;
    applyFilterChange();
  });
  document.getElementById("toggle-memory").addEventListener("change", (ev) => {
    appState.filters.showMemory = ev.target.checked;
    applyFilterChange();
  });

  document.getElementById("btn-reset-filters").addEventListener("click", () => {
    appState.filters = {
      cls: "all",
      project: "all",
      stability: "all",
      staleOnly: false,
      showEvents: true,
      showNavigation: false,
      showWeakLinks: true,
      showGhosts: false,
      showArchived: false,
      showMemory: false,
      healthSeverity: "all",
    };
    document.getElementById("filter-class").value = "all";
    document.getElementById("filter-project").value = "all";
    document.getElementById("filter-stability").value = "all";
    document.getElementById("filter-stale-only").checked = false;
    document.getElementById("toggle-events").checked = true;
    document.getElementById("toggle-navigation").checked = false;
    document.getElementById("toggle-weak-links").checked = true;
    document.getElementById("toggle-ghosts").checked = false;
    document.getElementById("toggle-archived").checked = false;
    document.getElementById("toggle-memory").checked = false;
    applyFilterChange();
  });

  document.getElementById("health-severity-filter").addEventListener("change", (ev) => {
    appState.filters.healthSeverity = ev.target.value;
    renderHealthTable();
  });

  // Time-lapse controls
  document.getElementById("timelapse-play").addEventListener("click", () => {
    if (appState.timelapsePlaying) stopTimelapsePlayback();
    else startTimelapsePlayback();
  });
  document.getElementById("timelapse-slider").addEventListener("input", (ev) => {
    stopTimelapsePlayback();
    appState.timelapseRatio = Number(ev.target.value) / 1000;
    recomputeVisibility();
    refreshGraphVisuals();
  });
  document.getElementById("timelapse-reset").addEventListener("click", () => {
    stopTimelapsePlayback();
    appState.timelapseRatio = 1;
    document.getElementById("timelapse-slider").value = "1000";
    recomputeVisibility();
    refreshGraphVisuals();
  });

  // Drawer controls
  document.getElementById("drawer-close").addEventListener("click", closeNoteDrawer);
  document.getElementById("btn-copy-link").addEventListener("click", handleCopyObsidianLink);
  document.getElementById("btn-focus-subgraph").addEventListener("click", () => {
    if (!appState.selectedNode) return;
    if (appState.focusNode && appState.focusNode.id === appState.selectedNode.id) {
      exitFocusMode();
    } else {
      enterFocusMode(appState.selectedNode);
    }
  });
  document.getElementById("btn-promote-memory").addEventListener("click", () => {
    showToast(t("toastPromoteInfo"));
  });

  // Search box & global keyboard shortcuts
  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", (ev) => runFuzzySearch(ev.target.value));
  searchInput.addEventListener("focus", (ev) => {
    if (ev.target.value.trim()) renderSearchResults();
  });
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (appState.searchMatches.length > 0) {
        appState.searchActiveIndex = (appState.searchActiveIndex + 1) % appState.searchMatches.length;
        renderSearchResults();
      }
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (appState.searchMatches.length > 0) {
        appState.searchActiveIndex =
          (appState.searchActiveIndex - 1 + appState.searchMatches.length) % appState.searchMatches.length;
        renderSearchResults();
      }
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const chosen = appState.searchMatches[appState.searchActiveIndex] || appState.searchMatches[0];
      if (chosen) selectSearchMatch(chosen);
    } else if (ev.key === "Escape") {
      ev.stopPropagation();
      document.getElementById("search-results").classList.add("is-hidden");
      searchInput.setAttribute("aria-expanded", "false");
      searchInput.blur();
    }
  });

  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".search-box")) {
      document.getElementById("search-results").classList.add("is-hidden");
      searchInput.setAttribute("aria-expanded", "false");
    }
  });

  window.addEventListener("keydown", (ev) => {
    const tag = document.activeElement?.tagName;
    const inField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    if (ev.key === "/" && !inField) {
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (ev.key === "Escape") {
      if (appState.settingsPanel.open) {
        closeSettingsPanel();
      } else if (appState.focusSet) {
        exitFocusMode();
      } else if (appState.selectedNode) {
        closeNoteDrawer();
      }
    }
  });

  // Ambient animation loop for cosmos backdrop & incident moon pulse
  function animateBackdrop(nowMs) {
    if (!appState.pageHidden) {
      backdrop.render(nowMs);
      if (!appState.reducedMotion && appState.mode === "3d") {
        const pulseScale = 1 + 0.25 * Math.sin(nowMs * 0.0042);
        for (const node of appState.sharedGraphData.nodes) {
          const pulseMesh = node.__celestialGroup?.userData?.pulseMesh;
          if (pulseMesh) {
            pulseMesh.scale.set(pulseScale, pulseScale, pulseScale);
          }
        }
      }
    }
    requestAnimationFrame(animateBackdrop);
  }
  requestAnimationFrame(animateBackdrop);
}

// Bootstrap view
const backdrop = new CosmosBackdrop(document.getElementById("cosmos-bg"));
bindUiEvents(backdrop);
loadUniverseGraph();
