# Note Patterns for Obsidian Project Knowledge

Use these patterns selectively. Do not generate every note type unless the repository justifies it.

## 1. Project overview note

Recommended title:
- `项目 - <repo-name>`

Suggested structure:

```markdown
---
title: 项目 - <repo-name>
type: project
status: active
tags:
  - project
  - <repo-name>
---

# 项目 - <repo-name>

> [!abstract] 一句话总结
> ...

## 项目定位

## 核心功能

## 系统设计

## 数据模型 / 权限模型 / 部署模型

## 已知约束

## 相关笔记
- [[...]]
```

## 2. Knowledge map / MOC

Recommended title:
- `<Repo> - 知识地图`

Suggested structure:

```markdown
---
title: <Repo> - 知识地图
type: moc
status: active
---

# <Repo> - 知识地图

## 总览
- [[项目 - <repo-name>]]

## 专题
- [[<Repo> - 认证与 SSO 设计]]
- [[<Repo> - 前后端架构]]
- [[<Repo> - 部署设计]]
```

## 3. Topic note

Use for a clearly separate concern such as auth, sync, deployment, architecture, or integration.

Suggested structure:

```markdown
---
title: <Repo> - <topic>
type: note
status: active
---

# <Repo> - <topic>

> [!abstract]
> ...

## 这个主题解决什么问题

## 当前设计

## 关键流程

## 优点

## 约束 / 风险

## 相关笔记
- [[...]]
```

## 4. Source-document knowledge note

Use when a single repo document should become reusable knowledge.

Recommended title:
- `资料 - <topic>`

Suggested structure:

```markdown
---
title: 资料 - <topic>
type: reference
status: active
source: <repo-path>
---

# 资料 - <topic>

## 来源

## 解决的问题

## 核心设计

## 实战坑点

## 最小复用清单

## 我的理解
```

## Naming guidance

- Prefer stable names over temporary task names
- Use the repo name in long-lived topic notes
- Use `资料 - ...` for reusable operational/design references
- Keep Chinese naming consistent inside the same vault unless the user prefers English

## Linking guidance

Whenever possible, link the new note set into:
- project overview pages
- technology MOCs
- resource indexes
- deployment pages

A good result is a note that can still be found later even if the original chat is gone.
