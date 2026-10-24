/**
 * Synthetic fixture dataset for Knowledge Universe standalone / fallback mode.
 *
 * Contains 273 synthetic Markdown notes across all ontology classes:
 * - 22 projects
 * - 78 topics, 18 environments, 10 organizations, 24 technologies,
 *   18 references, 12 conventions, 18 procedures
 * - 60 event moons (18 decisions, 20 releases, 12 incidents, 10 records)
 * - 13 navigation notes (4 moc, 3 index, 2 daily, 2 weekly, 2 inbox)
 * Plus ~1,243 weak wikilinks, ~190 typed predicate links, and 38 ghosts.
 * All names and content are generic; no personal data is included.
 */

function createPrng(seed = 0x20261024) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function formatDate(daysBeforeAnchor, anchorMs = Date.parse("2026-10-24T00:00:00Z")) {
  const ms = anchorMs - daysBeforeAnchor * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function pseudoSha256(input) {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  const parts = [];
  for (let i = 0; i < 8; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    parts.push(((h1 >>> 0) ^ (i * 0x9e3779b9 >>> 0)).toString(16).padStart(8, "0"));
  }
  return parts.join("");
}

const PROJECT_GREEK = [
  ["Alpha", "核心网关系统"],
  ["Beta", "统一身份服务"],
  ["Gamma", "边缘推理节点"],
  ["Delta", "知识图谱引擎"],
  ["Epsilon", "实时遥测平台"],
  ["Zeta", "多租户权限中心"],
  ["Eta", "分布式块存储"],
  ["Theta", "异步消息总线"],
  ["Iota", "容器编排调度"],
  ["Kappa", "日志审计归档"],
  ["Lambda", "动态配置中心"],
  ["Mu", "持续交付流水线"],
  ["Nu", "安全基线扫描"],
  ["Xi", "计量计费结算"],
  ["Omicron", "数据湖同步器"],
  ["Pi", "跨平台桌面端"],
  ["Rho", "工作流状态机"],
  ["Sigma", "混合向量检索"],
  ["Tau", "告警收敛引擎"],
  ["Upsilon", "对象存储网关"],
  ["Phi", "离线冷备引擎"],
  ["Chi", "旧版报表服务"],
];

const TOPIC_FACETS = [
  "系统架构",
  "数据模型",
  "服务器资产",
  "部署拓扑",
  "接口契约",
  "缓存策略",
  "可观测性指标",
  "容灾与高可用",
];

const ENV_NAMES = [
  "生产集群 East-1",
  "生产集群 West-2",
  "预发环境 Staging-A",
  "预发环境 Staging-B",
  "灾备中心 DR-North",
  "边缘站点群 Edge-01",
  "边缘站点群 Edge-02",
  "隔离沙箱 Sandbox",
  "内网构建集群 CI-Build",
  "压测环境 Benchmark",
  "客户私有化站点 Site-A",
  "客户私有化站点 Site-B",
  "客户私有化站点 Site-C",
  "离线推理节点 GPU-Pool",
  "核心数据库主集群 DB-Primary",
  "核心数据库只读集群 DB-Replica",
  "对象存储专区 OSS-Zone",
  "归档冷备机房 Cold-Vault",
];

const ORG_NAMES = [
  "基础架构部",
  "云原生平台组",
  "数据智能团队",
  "安全合规委员会",
  "桌面端产品组",
  "企业交付中心",
  "外部合作方 AcmeTech",
  "外部合作方 NovaCloud",
  "硬件供应链组",
  "运维保障团队",
];

const TECH_NAMES = [
  "PostgreSQL",
  "SQLite",
  "Redis Cluster",
  "Kubernetes",
  "Rust Host Core",
  "Node.js Runtime",
  "Electron",
  "Three.js WebGL",
  "Ollama bge-m3",
  "Envoy Proxy",
  "Prometheus",
  "Grafana",
  "OpenTelemetry",
  "gRPC Protocol",
  "NATS JetStream",
  "ClickHouse",
  "MinIO S3",
  "WireGuard",
  "systemd",
  "ESBuild",
  "YAML Parser",
  "BM25F Indexer",
  "TLS 1.3 mTLS",
  "Linux cgroups v2",
];

const REF_NAMES = [
  "HTTP 缓存语义规范",
  "零信任网络访问模型",
  "倒排索引与 BM25F 权重",
  "余弦相似度与归一化向量",
  "倒数排名融合 RRF 算法",
  "分布式锁与租约退避",
  "幂等写入与 CAS 校验",
  "内容脱敏正则基线",
  "语义化版本控制约定",
  "UTF-8 与中日韩分词二元语法",
  "WebGL 透明混合与深度写入",
  "力导向图 Barnes-Hut 近似",
  "结构化日志字段字典",
  "蓝绿发布流量切分策略",
  "数据库连接池容量公式",
  "证书链自动续期机制",
  "无障碍表格键盘导航模式",
  "前端内容安全策略 CSP 基线",
];

const CONV_NAMES = [
  ["08 Standards/知识本体.md", "知识本体"],
  ["08 Standards/知识库规范.md", "知识库规范"],
  ["08 Standards/Conv - 提交信息与变更记录规范.md", "提交信息与变更记录规范"],
  ["08 Standards/Conv - 接口向后兼容守则.md", "接口向后兼容守则"],
  ["08 Standards/Conv - 生产环境只读排查原则.md", "生产环境只读排查原则"],
  ["08 Standards/Conv - 敏感凭据零落盘规范.md", "敏感凭据零落盘规范"],
  ["08 Standards/Conv - 数据库迁移回滚预案.md", "数据库迁移回滚预案"],
  ["08 Standards/Conv - 错误码与可诊断性标准.md", "错误码与可诊断性标准"],
  ["08 Standards/Conv - 自动化测试分层准入.md", "自动化测试分层准入"],
  ["08 Standards/Conv - 笔记生命周期与复核周期.md", "笔记生命周期与复核周期"],
  ["08 Standards/Conv - 架构决策记录 ADR 模板.md", "架构决策记录 ADR 模板"],
  ["08 Standards/Conv - 依赖内联与许可证声明.md", "依赖内联与许可证声明"],
];

const PROC_TITLES = [
  "TLS 证书轮换操作手册",
  "主从数据库切换演练步骤",
  "边缘节点离线恢复手册",
  "向量索引全量重建流程",
  "生产网关限流应急处置",
  "只读模式切换与验证清单",
  "消息积压消费扩容指南",
  "租户数据隔离核查步骤",
  "容器镜像签名校验流程",
  "磁盘水位告警清理手册",
  "金丝雀发布回滚标准流程",
  "跨机房网络抖动排查手册",
  "慢查询定位与索引优化",
  "对象存储分片修复步骤",
  "客户端崩溃日志采集指南",
  "审计日志归档校验流程",
  "配置中心密钥轮转手册",
  "知识库本体批量迁移步骤",
];

const ISSUE_DETAIL_TEMPLATES = {
  UNKNOWN_TYPE: "type \"custom-draft\" is not a class or alias",
  LEGACY_TYPE: "type \"architecture\" maps to \"topic\"",
  UNKNOWN_STATUS: "status \"merged-main-not-deployed\" is not in [active, archived]",
  UNKNOWN_STABILITY: "stability \"verified\" is not in [stable, mixed, volatile, historical]",
  UNKNOWN_PREDICATE_TARGET: "depends_on: [[Ghost - 缺失的认证模块]] does not resolve",
  DOMAIN_VIOLATION: "resolved_by does not apply to class \"topic\"",
  RANGE_VIOLATION: "uses: [[Project - Beta]] is class \"project\", expected [technology]",
  CARDINALITY_VIOLATION: "project allows one link, found 2",
  FRONTMATTER_INVALID: "frontmatter YAML block list indentation is invalid at line 4",
  OVERSIZE: "note exceeds 24000 characters threshold; split dated event logs into event notes",
  ORPHAN: "no backlinks point at this note",
  STALE: "verified 142 days ago, review window is 90",
};

function buildFixtureDataset() {
  const rand = createPrng(0x20261024);
  const nodes = [];
  const links = [];
  const typedEdgeSet = new Set();

  function addTypedLink(source, target, predicate) {
    if (!source || !target || source === target) return;
    const key = `${source}-->${target}`;
    if (typedEdgeSet.has(key)) return;
    typedEdgeSet.add(key);
    links.push({ source, target, predicate });
  }

  function makeDates(maxAgeDays = 680, forceStale = false) {
    const createdAgo = Math.floor(120 + rand() * (maxAgeDays - 120));
    const updatedAgo = forceStale
      ? Math.min(createdAgo, Math.floor(190 + rand() * 320))
      : Math.min(createdAgo, Math.floor(2 + rand() * 180));
    const verifiedAgo = forceStale
      ? Math.min(createdAgo, Math.floor(130 + rand() * 280))
      : Math.min(createdAgo, Math.floor(1 + rand() * 85));
    return {
      created: formatDate(createdAgo),
      updated: formatDate(updatedAgo),
      verified: formatDate(verifiedAgo),
    };
  }

  // 1. 22 Project nodes
  const projectIds = [];
  for (let i = 0; i < PROJECT_GREEK.length; i++) {
    const [code, label] = PROJECT_GREEK[i];
    const archived = i >= 20;
    const folder = archived ? `04 Archive/Project - ${code}` : `01 Projects/Project - ${code}`;
    const id = `${folder}/Project - ${code}.md`;
    projectIds.push(id);
    const stale = i === 5 || i === 13 || i === 19;
    const dates = makeDates(700, stale);
    const oversize = i === 0 || i === 3;
    const chars = oversize ? (i === 0 ? 123629 : 70338) : Math.floor(3200 + rand() * 14000);
    const issues = [];
    if (oversize) issues.push("OVERSIZE");
    if (stale) issues.push("STALE");
    if (i === 11) issues.push("UNKNOWN_STATUS");
    nodes.push({
      id,
      title: `Project - ${code} (${label})`,
      cls: "project",
      family: "entity",
      status: archived ? "archived" : i === 14 ? "paused" : i === 18 ? "done" : "active",
      stability: "mixed",
      ...dates,
      stale,
      archived,
      degree: 0,
      chars,
      issues,
    });
  }

  // 2. 18 Environment nodes
  const envIds = [];
  for (let i = 0; i < ENV_NAMES.length; i++) {
    const name = ENV_NAMES[i];
    const archived = i === 17;
    const id = archived ? `04 Archive/Env - ${name}.md` : `02 Environments/Env - ${name}.md`;
    envIds.push(id);
    const stale = i === 4 || i === 12;
    const dates = makeDates(640, stale);
    const issues = [];
    if (stale) issues.push("STALE");
    if (i === 7) issues.push("UNKNOWN_STABILITY");
    nodes.push({
      id,
      title: `Env - ${name}`,
      cls: "environment",
      family: "entity",
      project: i < 12 ? projectIds[i % projectIds.length] : undefined,
      status: archived ? "archived" : "active",
      stability: i % 2 === 0 ? "stable" : "mixed",
      ...dates,
      stale,
      archived,
      degree: 0,
      chars: Math.floor(1800 + rand() * 6400),
      issues,
    });
  }

  // 3. 10 Organization nodes
  const orgIds = [];
  for (let i = 0; i < ORG_NAMES.length; i++) {
    const name = ORG_NAMES[i];
    const id = `02 Organizations/Org - ${name}.md`;
    orgIds.push(id);
    const dates = makeDates(690, false);
    nodes.push({
      id,
      title: `Org - ${name}`,
      cls: "organization",
      family: "entity",
      status: "active",
      stability: "stable",
      ...dates,
      stale: false,
      archived: false,
      degree: 0,
      chars: Math.floor(1500 + rand() * 4200),
      issues: i === 8 ? ["ORPHAN"] : [],
    });
  }

  // 4. 24 Technology nodes
  const techIds = [];
  for (let i = 0; i < TECH_NAMES.length; i++) {
    const name = TECH_NAMES[i];
    const id = `03 Technologies/Tech - ${name}.md`;
    techIds.push(id);
    const stale = i === 16 || i === 22;
    const dates = makeDates(650, stale);
    const issues = [];
    if (stale) issues.push("STALE");
    if (i === 19) issues.push("LEGACY_TYPE");
    nodes.push({
      id,
      title: `Tech - ${name}`,
      cls: "technology",
      family: "entity",
      status: "active",
      stability: "stable",
      ...dates,
      stale,
      archived: false,
      degree: 0,
      chars: Math.floor(2100 + rand() * 8500),
      issues,
    });
  }

  // 5. 18 Reference nodes
  const refIds = [];
  for (let i = 0; i < REF_NAMES.length; i++) {
    const name = REF_NAMES[i];
    const archived = i === 17;
    const id = archived ? `04 Archive/Ref - ${name}.md` : `03 References/Ref - ${name}.md`;
    refIds.push(id);
    const stale = i === 6 || i === 14;
    const dates = makeDates(620, stale);
    const issues = [];
    if (stale) issues.push("STALE");
    if (i === 10) issues.push("ORPHAN");
    nodes.push({
      id,
      title: `Ref - ${name}`,
      cls: "reference",
      family: "entity",
      status: archived ? "archived" : "active",
      stability: "stable",
      ...dates,
      stale,
      archived,
      degree: 0,
      chars: Math.floor(2400 + rand() * 9800),
      issues,
    });
  }

  // 6. 12 Convention nodes
  const convIds = [];
  for (let i = 0; i < CONV_NAMES.length; i++) {
    const [id, title] = CONV_NAMES[i];
    convIds.push(id);
    const dates = makeDates(600, false);
    nodes.push({
      id,
      title,
      cls: "convention",
      family: "entity",
      status: "active",
      stability: "stable",
      ...dates,
      stale: false,
      archived: false,
      degree: 0,
      chars: Math.floor(2800 + rand() * 7600),
      issues: i === 11 ? ["LEGACY_TYPE"] : [],
    });
  }

  // 7. 78 Topic nodes (distributed across the 22 projects)
  const topicIds = [];
  for (let i = 0; i < 78; i++) {
    const projIdx = i % 22;
    const [code] = PROJECT_GREEK[projIdx];
    const facet = TOPIC_FACETS[Math.floor(i / 22) % TOPIC_FACETS.length];
    const suffix = i >= 66 ? ` (${(i % 3) + 1})` : "";
    const archived = projIdx >= 20 || i === 71 || i === 75;
    const folder = archived ? `04 Archive/Project - ${code}` : `01 Projects/Project - ${code}`;
    const title = `${code} - ${facet}${suffix}`;
    const id = `${folder}/${title}.md`;
    topicIds.push(id);
    const stale = i % 9 === 0;
    const dates = makeDates(600, stale);
    const oversize = i === 2 || i === 15;
    const chars = oversize ? (i === 2 ? 92208 : 57684) : Math.floor(1900 + rand() * 12500);
    const issues = [];
    if (stale) issues.push("STALE");
    if (oversize) issues.push("OVERSIZE");
    if (i === 7) issues.push("UNKNOWN_TYPE");
    if (i === 18) issues.push("LEGACY_TYPE");
    if (i === 25) issues.push("DOMAIN_VIOLATION");
    if (i === 33) issues.push("RANGE_VIOLATION");
    if (i === 41) issues.push("CARDINALITY_VIOLATION");
    if (i === 52) issues.push("UNKNOWN_PREDICATE_TARGET");
    if (i === 63) issues.push("FRONTMATTER_INVALID");
    const projectId = projectIds[projIdx];
    nodes.push({
      id,
      title,
      cls: "topic",
      family: "entity",
      project: projectId,
      status: archived ? "archived" : "active",
      stability: i % 4 === 0 ? "mixed" : i % 7 === 0 ? "volatile" : "stable",
      ...dates,
      stale,
      archived,
      degree: 0,
      chars,
      issues,
    });
    addTypedLink(id, projectId, "project");
  }

  // 8. 18 Procedure nodes
  const procIds = [];
  for (let i = 0; i < PROC_TITLES.length; i++) {
    const projIdx = i % 18;
    const [code] = PROJECT_GREEK[projIdx];
    const projectId = projectIds[projIdx];
    const title = `Proc - ${PROC_TITLES[i]}`;
    const id = `01 Projects/Project - ${code}/${title}.md`;
    procIds.push(id);
    const stale = i === 3 || i === 11 || i === 16;
    const dates = makeDates(540, stale);
    const issues = [];
    if (stale) issues.push("STALE");
    if (i === 5) issues.push("LEGACY_TYPE");
    if (i === 14) issues.push("UNKNOWN_PREDICATE_TARGET");
    nodes.push({
      id,
      title,
      cls: "procedure",
      family: "entity",
      project: projectId,
      status: "active",
      stability: "stable",
      ...dates,
      stale,
      archived: false,
      degree: 0,
      chars: Math.floor(2200 + rand() * 7200),
      issues,
    });
    addTypedLink(id, projectId, "project");
  }

  // 9. 60 Event moons (18 decision, 20 release, 12 incident, 10 record)
  const decisionIds = [];
  const decisionStatuses = ["accepted", "proposed", "superseded", "rejected"];
  for (let i = 0; i < 18; i++) {
    const projIdx = i % 22;
    const [code] = PROJECT_GREEK[projIdx];
    const projectId = projectIds[projIdx];
    const archived = projIdx >= 20 || i === 17;
    const dates = makeDates(580, false);
    const title = `ADR-${String(i + 1).padStart(3, "0")} ${code} 架构与存储决策`;
    const id = `${archived ? "04 Archive" : "05 Events/Decisions"}/${title}.md`;
    decisionIds.push(id);
    const issues = [];
    if (i === 4) issues.push("UNKNOWN_STATUS");
    if (i === 12) issues.push("RANGE_VIOLATION");
    nodes.push({
      id,
      title,
      cls: "decision",
      family: "event",
      project: projectId,
      status: decisionStatuses[i % decisionStatuses.length],
      stability: "historical",
      ...dates,
      stale: false,
      archived,
      degree: 0,
      chars: Math.floor(1600 + rand() * 5400),
      issues,
    });
    addTypedLink(id, projectId, "project");
    addTypedLink(id, topicIds[i % topicIds.length], "affects");
    if (i > 0 && i % 5 === 0) {
      addTypedLink(id, decisionIds[i - 1], "supersedes");
    }
  }

  const releaseIds = [];
  const releaseStatuses = ["succeeded", "succeeded", "planned", "failed", "rolled-back"];
  for (let i = 0; i < 20; i++) {
    const projIdx = i % 22;
    const [code] = PROJECT_GREEK[projIdx];
    const projectId = projectIds[projIdx];
    const archived = projIdx >= 20 || i >= 18;
    const dates = makeDates(500, false);
    const ver = `v1.${Math.floor(i / 4)}.${i % 4}`;
    const title = `Release - ${code} ${ver} 发布记录`;
    const id = `${archived ? "04 Archive" : "05 Events/Releases"}/${title}.md`;
    releaseIds.push(id);
    const issues = [];
    if (i === 6) issues.push("UNKNOWN_STATUS");
    if (i === 15) issues.push("LEGACY_TYPE");
    nodes.push({
      id,
      title,
      cls: "release",
      family: "event",
      project: projectId,
      status: releaseStatuses[i % releaseStatuses.length],
      stability: "historical",
      ...dates,
      stale: false,
      archived,
      degree: 0,
      chars: Math.floor(1400 + rand() * 4800),
      issues,
    });
    addTypedLink(id, projectId, "project");
    addTypedLink(id, envIds[i % envIds.length], "deployed_to");
    addTypedLink(id, topicIds[(i * 3) % topicIds.length], "affects");
  }

  const incidentIds = [];
  const incidentStatuses = ["resolved", "resolved", "mitigated", "open"];
  for (let i = 0; i < 12; i++) {
    const projIdx = (i * 2) % 22;
    const [code] = PROJECT_GREEK[projIdx];
    const projectId = projectIds[projIdx];
    const dates = makeDates(460, i === 9);
    const title = `INC-2026-${String(i + 1).padStart(2, "0")} ${code} 线上延迟与连接池告警`;
    const id = `05 Events/Incidents/${title}.md`;
    incidentIds.push(id);
    const issues = [];
    if (i === 9) issues.push("STALE");
    if (i === 3) issues.push("UNKNOWN_PREDICATE_TARGET");
    nodes.push({
      id,
      title,
      cls: "incident",
      family: "event",
      project: projectId,
      status: incidentStatuses[i % incidentStatuses.length],
      stability: "historical",
      ...dates,
      stale: i === 9,
      archived: false,
      degree: 0,
      chars: Math.floor(2100 + rand() * 6200),
      issues,
    });
    addTypedLink(id, projectId, "project");
    addTypedLink(id, envIds[i % envIds.length], "affects");
    addTypedLink(id, releaseIds[i % releaseIds.length], "resolved_by");
  }

  const recordIds = [];
  for (let i = 0; i < 10; i++) {
    const projIdx = (i * 2 + 1) % 22;
    const [code] = PROJECT_GREEK[projIdx];
    const projectId = projectIds[projIdx];
    const archived = i >= 8;
    const dates = makeDates(520, false);
    const title = `Rec - ${code} 季度容量与安全巡检记录 #${i + 1}`;
    const id = `${archived ? "04 Archive" : "05 Events/Records"}/${title}.md`;
    recordIds.push(id);
    nodes.push({
      id,
      title,
      cls: "record",
      family: "event",
      project: projectId,
      status: i % 4 === 0 ? "open" : "done",
      stability: "historical",
      ...dates,
      stale: false,
      archived,
      degree: 0,
      chars: Math.floor(1500 + rand() * 4400),
      issues: i === 7 ? ["ORPHAN"] : [],
    });
    addTypedLink(id, projectId, "project");
    addTypedLink(id, topicIds[(i * 5) % topicIds.length], "affects");
  }

  // 10. 13 Navigation notes (4 moc, 3 index, 2 daily, 2 weekly, 2 inbox)
  const navSpecs = [
    ["00 Inbox/MOC - 全局项目星图.md", "MOC - 全局项目星图", "moc"],
    ["00 Inbox/MOC - 基础设施与环境索引.md", "MOC - 基础设施与环境索引", "moc"],
    ["00 Inbox/MOC - 核心技术栈导航.md", "MOC - 核心技术栈导航", "moc"],
    ["00 Inbox/MOC - 架构决策与事故汇总.md", "MOC - 架构决策与事故汇总", "moc"],
    ["00 Inbox/Index - 知识库总目录.md", "Index - 知识库总目录", "index"],
    ["00 Inbox/Index - 待办与复核索引.md", "Index - 待办与复核索引", "index"],
    ["00 Inbox/Index - 归档目录索引.md", "Index - 归档目录索引", "index"],
    ["06 Journals/Daily - 2026-10-23.md", "Daily - 2026-10-23", "daily"],
    ["06 Journals/Daily - 2026-10-24.md", "Daily - 2026-10-24", "daily"],
    ["06 Journals/Weekly - 2026-W42.md", "Weekly - 2026-W42", "weekly"],
    ["06 Journals/Weekly - 2026-W43.md", "Weekly - 2026-W43", "weekly"],
    ["00 Inbox/Inbox - 临时检索笔记草稿 A.md", "Inbox - 临时检索笔记草稿 A", "inbox"],
    ["00 Inbox/Inbox - 待整理边缘网关摘录 B.md", "Inbox - 待整理边缘网关摘录 B", "inbox"],
  ];
  const navIds = [];
  for (let i = 0; i < navSpecs.length; i++) {
    const [id, title, cls] = navSpecs[i];
    navIds.push(id);
    const dates = makeDates(180, false);
    nodes.push({
      id,
      title,
      cls,
      family: "navigation",
      status: "active",
      stability: "volatile",
      ...dates,
      stale: false,
      archived: false,
      degree: 0,
      chars: Math.floor(900 + rand() * 3100),
      issues: [],
    });
  }

  // Typed relations among projects, environments, organizations, technologies, conventions
  for (let i = 0; i < projectIds.length; i++) {
    const pid = projectIds[i];
    addTypedLink(pid, envIds[i % envIds.length], "deployed_to");
    addTypedLink(pid, orgIds[i % orgIds.length], "for");
    addTypedLink(pid, techIds[i % techIds.length], "uses");
    addTypedLink(pid, techIds[(i * 3 + 2) % techIds.length], "uses");
    if (i > 0) {
      addTypedLink(pid, projectIds[Math.floor((i - 1) / 2)], "depends_on");
    }
  }
  for (let i = 0; i < envIds.length; i++) {
    addTypedLink(envIds[i], orgIds[i % orgIds.length], "for");
  }
  for (let i = 0; i < topicIds.length; i += 2) {
    addTypedLink(topicIds[i], techIds[i % techIds.length], "uses");
    if (i % 4 === 0) {
      addTypedLink(topicIds[i], envIds[i % envIds.length], "deployed_to");
    }
    if (i % 6 === 0) {
      addTypedLink(topicIds[i], refIds[i % refIds.length], "depends_on");
    }
  }
  for (let i = 2; i < convIds.length; i += 3) {
    addTypedLink(convIds[i], convIds[i - 1], "supersedes");
  }

  // Build ~1,243 weak wikilinks (intra-galaxy + cross-galaxy + navigation hubs)
  const targetWeakLinkCount = 1243;
  const orphanIds = new Set(nodes.filter((n) => n.issues.includes("ORPHAN")).map((n) => n.id));
  const weakEdgeSet = new Set(typedEdgeSet);
  let weakCount = 0;

  function tryAddWeakLink(source, target) {
    if (!source || !target || source === target) return false;
    if (orphanIds.has(target)) return false;
    const key = `${source}-->${target}`;
    if (weakEdgeSet.has(key)) return false;
    weakEdgeSet.add(key);
    links.push({ source, target, predicate: "wikilink" });
    weakCount++;
    return true;
  }

  // First connect topics/procedures/events inside the same project galaxy
  const byProject = new Map();
  for (const node of nodes) {
    const key = node.project || (node.cls === "project" ? node.id : null);
    if (!key) continue;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(node.id);
  }
  for (const [projId, memberIds] of byProject.entries()) {
    for (let i = 0; i < memberIds.length; i++) {
      const a = memberIds[i];
      tryAddWeakLink(projId, a);
      for (let step = 1; step <= 3; step++) {
        const b = memberIds[(i + step) % memberIds.length];
        tryAddWeakLink(a, b);
      }
    }
  }

  // Connect navigation MOCs to projects, environments, technologies, events
  for (const pid of projectIds) tryAddWeakLink(navIds[0], pid);
  for (const eid of envIds) tryAddWeakLink(navIds[1], eid);
  for (const tid of techIds) tryAddWeakLink(navIds[2], tid);
  for (const did of decisionIds) tryAddWeakLink(navIds[3], did);
  for (const iid of incidentIds) tryAddWeakLink(navIds[3], iid);

  // Fill remaining weak links deterministically up to 1,243
  const allIds = nodes.map((n) => n.id);
  const hubPool = [...projectIds, ...techIds, ...refIds, ...convIds, ...envIds, ...topicIds.slice(0, 30)];
  let guard = 0;
  while (weakCount < targetWeakLinkCount && guard < 25000) {
    guard++;
    const src = allIds[Math.floor(rand() * allIds.length)];
    const useHub = rand() < 0.62;
    const dst = useHub
      ? hubPool[Math.floor(rand() * hubPool.length)]
      : allIds[Math.floor(rand() * allIds.length)];
    tryAddWeakLink(src, dst);
  }

  // Compute accurate degree and backlinks from links
  const degreeMap = new Map(nodes.map((n) => [n.id, 0]));
  const backlinksMap = new Map(nodes.map((n) => [n.id, []]));
  const outgoingTypedMap = new Map(nodes.map((n) => [n.id, {}]));

  for (const link of links) {
    degreeMap.set(link.source, (degreeMap.get(link.source) || 0) + 1);
    degreeMap.set(link.target, (degreeMap.get(link.target) || 0) + 1);
    const bl = backlinksMap.get(link.target);
    if (bl && !bl.includes(link.source)) {
      bl.push(link.source);
    }
    if (link.predicate !== "wikilink") {
      const bucket = outgoingTypedMap.get(link.source);
      if (bucket) {
        if (!bucket[link.predicate]) bucket[link.predicate] = [];
        bucket[link.predicate].push(`[[${link.target}]]`);
      }
    }
  }

  for (const node of nodes) {
    node.degree = degreeMap.get(node.id) || 0;
  }

  // 38 Unresolved Ghost targets
  const ghostNames = [
    "Ghost - 待建多活网关限流设计",
    "Ghost - 缺失的认证模块",
    "Ghost - 边缘节点固件升级规范",
    "Ghost - 跨区域专线切流预案",
    "Ghost - 统一审计事件 Schema",
    "Ghost - 向量索引 HNSW 对比评估",
    "Ghost - 零拷贝日志采集代理",
    "Ghost - 容器镜像漏洞豁免清单",
    "Ghost - 租户配额动态熔断策略",
    "Ghost - 异步任务死信队列规范",
    "Ghost - 冷热数据分层归档策略",
    "Ghost - 客户端离线缓存同步协议",
    "Ghost - 生产数据库分库分表路线图",
    "Ghost - 灰度流量染色标头标准",
    "Ghost - 硬件故障自动摘除剧本",
    "Ghost - 敏感配置 KMS 托管方案",
    "Ghost - 混沌工程故障注入清单",
    "Ghost - 指标基数膨胀治理记录",
    "Ghost - 外部 webhook 签名验签规范",
    "Ghost - 多语言词条自动化校验",
    "Ghost - 备份恢复 RTO 季度报告",
    "Ghost - 内部 CA 根证书迁移计划",
    "Ghost - 边缘算力弹性调度算法",
    "Ghost - 慢接口全链路追踪采样",
    "Ghost - 知识库增量快照协议",
    "Ghost - 批处理作业幂等键设计",
    "Ghost - 依赖许可证合规白名单",
    "Ghost - 桌面端插件沙箱通信契约",
    "Ghost - 告警静默窗口审批机制",
    "Ghost - 存储卷快照跨区复制",
    "Ghost - 服务网格 Sidecar 资源配额",
    "Ghost - 实时流计算水位线调优",
    "Ghost - 遗留报表下线通知记录",
    "Ghost - 核心链路压测基线报告",
    "Ghost - 机房断电应急演练复盘",
    "Ghost - 对象存储生命周期策略",
    "Ghost - 结构化错误码映射表",
    "Ghost - 检索重排序权重实验记录",
  ];
  const ghosts = ghostNames.map((id, idx) => {
    const refCount = 1 + (idx % 4);
    const referencedBy = [];
    for (let k = 0; k < refCount; k++) {
      const refNode = nodes[(idx * 7 + k * 13) % nodes.length];
      if (!referencedBy.includes(refNode.id)) {
        referencedBy.push(refNode.id);
      }
    }
    return { id, referencedBy };
  });

  // Build Map-like FIXTURE_NOTES (supports both .get(path) and [path])
  const notesMap = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const typedOut = outgoingTypedMap.get(node.id) || {};
    const metadata = {
      title: node.title,
      type: node.cls,
      ...(node.status ? { status: node.status } : {}),
      ...(node.stability ? { stability: node.stability } : {}),
      ...(node.created ? { created: node.created } : {}),
      ...(node.updated ? { updated: node.updated } : {}),
      ...(node.verified ? { verified: node.verified } : {}),
      review_interval: node.family === "event" ? "none" : "quarterly",
      ...typedOut,
    };
    const issueObjects = node.issues.map((code) => ({
      code,
      detail:
        code === "OVERSIZE"
          ? `${node.chars} characters exceed 24000`
          : ISSUE_DETAIL_TEMPLATES[code] || `${code} detected during ontology check`,
    }));
    const redacted = i === 4 || i === 29;
    const outline = [
      { level: 1, text: node.title, line: 1 },
      { level: 2, text: "背景与核心职责 / Context & Scope", line: 4 },
      { level: 2, text: "架构约束与拓扑关系 / Architecture & Relations", line: 11 },
      { level: 3, text: "运行态验证与复核记录 / Verification & Operations", line: 18 },
    ];
    const relatedSample = (backlinksMap.get(node.id) || []).slice(0, 3).map((p) => `- \`[[${p}]]\``).join("\n");
    const content = [
      `# ${node.title}`,
      "",
      `> 分类: \`${node.cls}\` (${node.family}) · 状态: \`${node.status ?? "active"}\` · 稳定性: \`${node.stability ?? "stable"}\``,
      "",
      "## 背景与核心职责 / Context & Scope",
      `本笔记记录 **${node.title}** 的当前权威事实、边界契约与上下游关联。所有元数据字段均遵循轻量知识本体（ADR 0001 §3），通过受保护的 SHA-256 条件写入与自动备份保持演进安全。${redacted ? " 认证凭据示例 `token=[REDACTED]` 已在读取阶段自动脱敏。" : ""}`,
      "",
      "## 架构约束与拓扑关系 / Architecture & Relations",
      `该节点位于路径 \`${node.id}\`，当前图谱连接度为 **${node.degree}**，文档规模为 **${node.chars.toLocaleString()}** 字符。显式类型化关系（如 \`project\`、\`depends_on\`、\`deployed_to\`、\`uses\`、\`affects\`）声明在 YAML Frontmatter 中，正文中的 \`[[wikilink]]\` 仅作为弱引用辅助扩展。`,
      "",
      "### 运行态验证与复核记录 / Verification & Operations",
      `最近更新于 \`${node.updated ?? "—"}\`，最近复核于 \`${node.verified ?? "—"}\`。`,
      relatedSample ? `\n关联引用节选：\n${relatedSample}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const noteRecord = {
      path: node.id,
      title: node.title,
      metadata,
      outline,
      sha256: pseudoSha256(node.id),
      redacted,
      content,
      truncated: node.chars > 8000,
      issues: issueObjects,
      backlinks: backlinksMap.get(node.id) || [],
    };
    notesMap.set(node.id, noteRecord);
    notesMap[node.id] = noteRecord;
  }

  const graphPayload = {
    generatedAt: "2026-10-24T12:00:00.000Z",
    vaultName: "Knowledge (Fixture)",
    nodes,
    links,
    ghosts,
    memory: { status: "unsupported", count: 0 },
  };

  return { graphPayload, notesMap };
}

const { graphPayload, notesMap } = buildFixtureDataset();

export const FIXTURE_GRAPH = graphPayload;
export const FIXTURE_NOTES = notesMap;
