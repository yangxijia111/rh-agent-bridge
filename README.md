# rh-agent-bridge

[中文](#中文) | [English](#english)

---

## 中文

# rh-agent-bridge

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)
![MCP](https://img.shields.io/badge/MCP-stdio-5E5CE6.svg)
![Tests](https://img.shields.io/badge/tests-165%20passed-brightgreen.svg)

> Agent-neutral 的 RunningHub / ComfyUI 工作流控制层 —— 让编程智能体用「工作流语义」而不是「鼠标坐标」操作 RunningHub。

**rh-agent-bridge** 是一个面向编程智能体（Codex、Zcode 或任何支持 MCP / CLI 的调用方）的本地工具。它向上提供稳定的结构化工具接口，向下对接 RunningHub 官方 OpenAPI 与 Native ComfyUI 接口，只在 API 确实无法表达时才返回结构化的浏览器兜底请求（由宿主智能体执行）。

> **当前状态：P0/MVP + P0.1 Hardening**（v0.1.1）——P0.1 修复了 `/models` 契约、连接类型校验、baseline 快照语义、nodeInfoList 绕过、graph key/id invariant 等安全与正确性问题。

## 项目简介 / Overview

在节点式编辑器（如 ComfyUI）上使用通用浏览器 Agent 时，常见痛点是：节点坐标漂移、连线动作脆弱、页面改版后选择器失效、每次都要重新「看网页」——而其中绝大多数操作其实早已有官方 API。

本项目把 RunningHub 工作流抽象为结构化图（WorkflowGraph），提供 parse / inspect / diff / mutate / validate / serialize 全套纯函数能力，并按官方建议将修改分流：**参数覆盖走 `nodeInfoList`，拓扑变化走完整 `workflow` JSON**。节点目录在运行时从 ComfyUI `/object_info` 动态发现，找不到的节点就是 `NODE_NOT_FOUND`，绝不凭空编造。

## 项目功能 / Features

- **API-first**：优先 RunningHub 官方 OpenAPI（任务创建、输出查询、素材上传、workflow 获取），其次 Native ComfyUI（`/proxy/<key>`），浏览器只是最后兜底
- **结构化图引擎**：API Format JSON ⇄ WorkflowGraph 双向转换；节点查询、不可变 patch（set_input / add_node / remove_node / connect / disconnect）、图 diff、拓扑环检测
- **参数与拓扑分流**：仅参数变化自动生成官方 `nodeInfoList`；拓扑/连接变化自动切换完整 workflow JSON 提交（官方明确不建议用 nodeInfoList 改连接）
- **分层静态校验**：Level 1 结构引用/环检测 → Level 2 基于 `/object_info` 的节点、输入与**连接类型**校验（outputIndex 越界、连接进入 primitive 字段、MODEL→IMAGE 类型不匹配）→ Level 3 模型名校验（优先级：object_info COMBO options → `/models/{folder}` → 字段名 fallback）；服务端 `promptTips` 解析为结构化校验结果
- **Native 能力探测**：运行时 feature-detect `/features`、`/object_info`、`/models`（folder 列表），模型文件按需 `GET /models/{folder}` 懒加载；探测失败自动降级，不影响 OpenAPI 主链路，逐端点明细（endpoint + status）对 Agent 可见
- **安全兜底**：浏览器 fallback 返回结构化目标（语义 goal + 域名 allowlist + 前置快照），由宿主智能体用自己的浏览器能力执行
- **双出口同源**：CLI（`--json` Agent 模式）与 MCP server 共用同一 service 层，13 个工具一一对应
- **日志双层脱敏**：API key 明文、`/proxy/<key>`、Bearer token、signed URL 全部 mask；`create task` / `upload` 默认禁止自动重试（防重复收费）

## 演示 / Demo

> 本项目是命令行 / 协议层工具，暂无图形界面截图。以下为两个可运行 demo 的流程概览（脚本见 `examples/`）：

**Demo A — 纯参数修改（全程无浏览器）**

```text
fetch workflow → 定位 prompt 节点 → set prompt → set seed
→ run by nodeInfoList → wait outputs
```

**Demo B — 拓扑修改**

```text
fetch workflow → probe nodes(/object_info) → node search 确认节点存在
→ add node → connect → validate → run by full workflow JSON → wait outputs
（目标节点不存在时明确返回 NODE_NOT_FOUND，绝不编造节点名）
```

**Demo C — 浏览器兜底（host 模式）**：对 `control_after_generate` 这类 API Format 中不存在的前端字段，patch 自动返回 `requiresBrowser` 结构化请求（含快照路径与回滚后置条件），见 `examples/demo-c-browser-fallback.md`。

运行方式见 [使用方法](#使用方法--usage)。

## 环境要求 / Requirements

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 需原生 `fetch` / `FormData` |
| npm | ≥ 10 | 随 Node 20 附带 |
| RunningHub 账号 | — | 需要有效 API key（[官方文档获取](https://www.runninghub.ai/runninghub-api-doc-en/)）；仅本地纯图操作不需要 |

## 安装与配置 / Installation

```bash
git clone https://github.com/yangxijia111/rh-agent-bridge.git
cd rh-agent-bridge
npm install
npm test        # 165 个测试全部基于 mock，无需真实 key
```

复制 `.env.example` 为 `.env` 并填写（`.env` 已被 `.gitignore` 排除，严禁提交）：

```text
RUNNINGHUB_API_KEY=<必填，RunningHub API key>
RUNNINGHUB_BASE_URL=https://www.runninghub.ai     # 默认值
RUNNINGHUB_WORKFLOW_ID=<可选，默认 workflow id>
RUNNINGHUB_NATIVE_MODE=standard                    # standard(24GB) | plus(48GB)
RH_BROWSER_MODE=host                               # host | cdp(未实现，预留)
RH_CDP_URL=                                        # 仅 cdp 模式使用
RH_LOG_LEVEL=info
```

## 使用方法 / Usage

### CLI（与 MCP 共用同一 service 层）

```bash
alias rh='npm run --silent dev --'

rh doctor                                          # 环境体检（key + native 能力探测）

rh workflow fetch <WORKFLOW_ID> --out workflow.api.json
rh workflow inspect workflow.api.json --query KSampler
rh workflow set-input workflow.api.json \
  --node 6 --field text --value "product photo" --out modified.json
rh workflow patch workflow.api.json \
  --ops '[{"type":"add_node","classType":"ImageUpscaleWithModel"},
          {"type":"connect","fromNode":"8","outputIndex":0,"toNode":"10","input":"image"}]' \
  --out modified.json
rh workflow validate modified.json --no-node-schema
rh workflow diff workflow.api.json modified.json

rh workflow run --workflow-id <ID> --file modified.json   # 自动 diff 选执行模式
rh workflow run --workflow-id <ID> --set 6.text="hi" --set 3.seed=42
rh task outputs <TASK_ID>
rh task wait <TASK_ID> --timeout-ms 600000

rh resource upload ./input.png       # 返回 fileName（相对路径，不是公共 URL）
rh nodes probe                       # /features /object_info /models 探测
rh nodes search "remove background"  # 节点目录搜索

rh browser fallback-request --workflow-id <ID> --goal "..."
```

`workflow run --file` 会先 fetch 远端原版并 diff：仅参数变化 → 转 `nodeInfoList` 提交；拓扑/连接变化 → 完整 `workflow` JSON 提交（并自动保存快照到 `~/.rh-agent/snapshots/`）。

`--json` 为 Agent 模式：stdout 只输出 JSON（错误也结构化 `{"error":{"code","message","retryable"}}`），日志走 stderr。

### MCP

```json
{
  "mcpServers": {
    "rh-agent-bridge": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "cwd": "/absolute/path/to/rh-agent-bridge",
      "env": { "RUNNINGHUB_API_KEY": "<your-key>" }
    }
  }
}
```

暴露 13 个工具（描述均为可决策式写法，便于 Agent 自动选路）：

| 工具 | 用途 | 幂等 |
|---|---|---|
| `rh_doctor` | 配置与 native 能力体检 | ✅ |
| `rh_workflow_fetch` | 获取 API Format → 结构化 graph | ✅ |
| `rh_workflow_inspect` | 节点列表 / 搜索 | ✅ |
| `rh_workflow_diff` | 图 diff | ✅ |
| `rh_workflow_patch` | set_input / add / remove / connect / disconnect | ✅（不落远端） |
| `rh_workflow_validate` | 分层静态校验 | ✅ |
| `rh_workflow_run` | 提交任务（**不自动重试，产生费用**） | ❌ |
| `rh_task_outputs` | 查询输出 / 状态 | ✅ |
| `rh_task_wait` | 轮询到终态（支持 MCP cancellation） | ✅ |
| `rh_resource_upload` | 上传素材（≤30MB） | ❌ |
| `rh_nodes_probe` | native 能力探测 + 节点目录构建 | ✅ |
| `rh_node_search` | 节点目录搜索 | ✅ |
| `rh_browser_fallback_request` | 结构化浏览器兜底请求 | ✅ |

### Demo 脚本（真实账号，消耗算力配额）

```bash
RUNNINGHUB_API_KEY=<key> npm run demo:a -- <WORKFLOW_ID>   # 纯参数，全程无浏览器
RUNNINGHUB_API_KEY=<key> npm run demo:b -- <WORKFLOW_ID>   # 探测→加节点→连线→全量运行
```

## 项目目录结构 / Project Structure

```text
rh-agent-bridge/
├── src/
│   ├── config/            环境配置 · 日志脱敏 · pino logger
│   ├── errors.ts          统一 RhError 错误模型（code + retryable + toJSON）
│   ├── clients/
│   │   ├── runninghub/    官方 OpenAPI client（zod 校验 / 超时 / 受控重试）
│   │   └── comfy/         Native ComfyUI client + capability probe
│   ├── graph/             纯函数图引擎（parse / serialize / inspect / mutate /
│   │                      diff / validate / topology / execution，零网络依赖）
│   ├── catalog/           object_info 适配器 + TTL 缓存 + 节点目录服务
│   ├── browser/           host 模式 BrowserAdapter（语义 goal + 域名 allowlist）
│   ├── services/          Workflow / Task / Resource / BrowserFallback 服务 + 快照存储
│   ├── tools/             13 个工具 + registry（zod 输入 schema）
│   ├── cli/               commander CLI（--json Agent 模式）
│   └── mcp/               MCP stdio server
├── tests/                 165 个测试 + workflow fixtures + API contract fixtures
├── examples/              Demo A/B 脚本 + Demo C 说明
├── .env.example           环境变量模板
└── package.json / tsconfig.json / vitest.config.ts / eslint.config.js
```

## 核心功能说明

### 1. 参数 vs 拓扑的执行分流

修改工作流后，工具计算图 diff 并按官方建议选择提交方式：

```text
仅 primitive 输入变化（prompt / seed / steps / 图片文件名 …）
    → workflowId + nodeInfoList（模板 + 参数覆盖）

新增/删除节点、改连接、class_type 变化、连接值被常量替换
    → workflowId + workflow=<完整 JSON string>（执行前强制保存快照）
```

若 diff 含连接变化仍试图转 `nodeInfoList`，工具抛出 `UNSUPPORTED` 并明确说明原因——这是官方文档明确不建议的路径。

### 2. 分层校验

| 层级 | 内容 | 依赖 |
|---|---|---|
| Level 1 | 引用存在性、自引用、outputIndex、环检测 | 无 |
| Level 2 | 节点类存在性、required 输入、类型/枚举/范围，以及**连接五要素校验**（上游/下游存在、outputIndex 越界、连接进入 primitive 字段 `CONNECTION_NOT_ALLOWED`、类型不匹配 `CONNECTION_TYPE_MISMATCH`；未知 custom datatype 降级 warning 避免误报） | `/object_info`（缺失自动跳过） |
| Level 3 | 模型名校验，优先级：object_info 该字段 COMBO options → `GET /models/{folder}`（checkpoints/loras/vae/upscale_models）→ 字段名 fallback | 上述任一（缺失自动跳过） |
| 服务端 | `promptTips` → 结构化 valid / nodeErrors / outputsToExecute | 任务创建响应 |

### 3. 节点目录与反 hallucinate

节点目录在运行时从 Native ComfyUI `/object_info` 获取（TTL 缓存：object_info 10 分钟 / models folder 5 分钟 / features 30 分钟）。`/models` 按 ComfyUI Server 语义返回 **folder 名称列表**（`["checkpoints", "loras", ...]`），具体模型文件按需 `GET /models/{folder}` 懒加载并独立 TTL 缓存；单个 folder 404 是合法降级，不影响其余能力。查找节点失败会强制刷新一次，仍不存在则返回 `NODE_NOT_FOUND`——工具不会编造任何节点类名。

### 4. 快照语义（baseline / candidate）

- **baseline snapshot** = mutation / run 之前的**远端当前状态**（rollback 依据）。full workflow run 与浏览器兜底前必须保存，且必须来自远端 fetch——Agent 本地修改过的 graph 不可作为 rollback baseline；
- **candidate snapshot** = 即将提交执行的候选状态（full workflow run 时一并保存，便于审计对比）。

### 5. 浏览器兜底（host 模式）

当操作目标属于 API Format 不存在的前端字段（如 `control_after_generate`、分组信息），工具不伪造 API 调用，而是：fetch 远端并保存 **baseline** 快照 → 返回结构化请求（语义 goal、DOM→CDP→vision 策略、RunningHub 域名 allowlist、fetch+diff 后置条件），由 Codex / Zcode 等宿主智能体用自己的浏览器能力执行。

### 6. 安全设计

- API key 只从环境变量读取，`.env` 不入库；日志双层脱敏（字段名规则 + 字符串规则，覆盖 key 明文、`/proxy/<key>`、Bearer、signed URL）
- `create task` 与 `upload` 默认禁止自动重试（防重复收费 / 重复上传）；仅幂等读操作自动重试（≤3 次，408/429/5xx/网络层）
- **nodeInfoList 护栏下沉到 Service boundary**：任何入口（工具 / CLI `--set` / MCP 直接 overrides）携带连接形态值（`["nodeId", index]`）→ `UNSUPPORTED`（要求走 full workflow JSON）；前端-only 字段 → `REQUIRES_BROWSER`
- **graph key/id invariant**：`graph.nodes[key].id === key` 在所有边界（parse / wire / serialize）强校验，不一致直接 `INVALID_WORKFLOW`，绝不静默纠正或覆盖
- `doctor` 语义诚实：`configured=true` 仅表示 key 已配置，`authenticationChecked=false` 表示未做（也未伪称）服务端验证
- 任务轮询遇到未确认业务码时最多连续容忍 2 次，超过即 `TASK_FAILED(UNKNOWN_API_STATE)`，不会无限轮询到 timeout
- 上传返回的 `fileName` 是加载节点相对路径，绝不拼接为公共 URL（官方明确上传接口不是图床）
- baseline 快照强制先于 full workflow run 与浏览器兜底，保存失败即中止

## 构建、运行与部署

```bash
npm run build     # tsc 编译到 dist/（dist/cli/main.js 为 bin 入口）
npm test          # vitest 全量测试（165 个，全部 mock，无需真实 key）
npm run dev       # 开发模式 CLI（tsx 直跑 TS 源码）
npm run mcp       # 启动 MCP stdio server（可直接被 MCP 客户端挂载）
npm run lint      # eslint
npm run demo:a    # Demo A 脚本（需真实 key）
npm run demo:b    # Demo B 脚本（需真实 key）
```

本项目是本地工具 / MCP server，无需服务端部署；作为 npm 依赖或直接 clone 使用均可。

## 开源协议 / License

[MIT](LICENSE) © yangxijia111

## 贡献说明 / Contributing

欢迎 Issue 与 PR。提交前请确保：

```bash
npm run lint && npm test && npm run build   # 三项全部通过
```

约定：

- Graph domain 层（`src/graph/`）保持纯函数、零网络依赖，禁止 import `fetch` / `process.env` / MCP SDK
- CLI 与 MCP 不允许各写一套业务逻辑，新工具先进 `src/tools/registry.ts`，两个出口自动获得
- 涉及 RunningHub 接口的改动，以最新官方文档为准并同步更新测试

## 更新计划 / Roadmap

- [ ] **P1**：`remove_node` cascade、`rh_model_search`（复用 `/models`）、LoRA 上传执行段（signed URL 消费）
- [ ] **M9**：Playwright / CDP 浏览器模式（`RH_BROWSER_MODE=cdp`，带域名 allowlist）
- [ ] **M10**：Recorder —— UI 操作前后 snapshot diff，沉淀可复用 operation recipe
- [ ] 真实账号端到端验证的 CI job（手动触发，需 self-hosted runner 与配额）
- [ ] 发布 npm 包（`npx rh-agent-bridge` 直接可用）

## 致谢 / Acknowledgements

- [RunningHub](https://www.runninghub.ai/) — 官方 OpenAPI 与 Native ComfyUI 代理
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — `/object_info` 等标准路由设计
- [Model Context Protocol](https://modelcontextprotocol.io/) — 工具协议
- [zod](https://zod.dev/) / [commander](https://github.com/tj/commander.js) / [pino](https://getpino.io/) / [vitest](https://vitest.dev/)

---

## English

# rh-agent-bridge

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6.svg)
![MCP](https://img.shields.io/badge/MCP-stdio-5E5CE6.svg)
![Tests](https://img.shields.io/badge/tests-165%20passed-brightgreen.svg)

> An agent-neutral control layer for RunningHub / ComfyUI workflows — lets coding agents operate RunningHub with **workflow semantics** instead of mouse coordinates.

**rh-agent-bridge** is a local tool for coding agents (Codex, Zcode, or any MCP / CLI caller). It exposes a stable set of structured tools on top of the RunningHub official OpenAPI and Native ComfyUI endpoints, and only returns a structured browser-fallback request (executed by the host agent) when an operation genuinely cannot be expressed via API.

> **Current status: P0/MVP + P0.1 Hardening** (v0.1.1) — P0.1 fixed the `/models` contract, connection-type validation, baseline-snapshot semantics, nodeInfoList bypass, graph key/id invariant and other safety/correctness issues.

## Overview

Generic browser agents struggle with node editors like ComfyUI: node coordinates drift, wire-drawing actions are fragile, selectors break on UI updates, and the agent has to "look at the page" again every time — even though the vast majority of those operations already have official APIs.

This project models a RunningHub workflow as a structured graph (WorkflowGraph) with a full pure-function toolkit: parse / inspect / diff / mutate / validate / serialize. Modifications are routed per official guidance: **parameter overrides go through `nodeInfoList`; topology changes go through the full `workflow` JSON**. The node catalog is discovered at runtime from ComfyUI `/object_info`; a missing node class is a `NODE_NOT_FOUND` — the tool never invents one.

## Features

- **API-first**: RunningHub official OpenAPI first (task creation, output polling, resource upload, workflow fetch), then Native ComfyUI (`/proxy/<key>`); the browser is only a last resort
- **Structured graph engine**: bidirectional API Format JSON ⇄ WorkflowGraph; node query, immutable patch (set_input / add_node / remove_node / connect / disconnect), graph diff, cycle detection
- **Parameter vs topology routing**: value-only changes auto-generate an official `nodeInfoList`; topology/connection changes automatically switch to full-workflow JSON submission (official docs advise against changing connections via nodeInfoList)
- **Layered static validation**: Level 1 structural references/cycles → Level 2 node, input and **connection-type** checks against `/object_info` (output-index overflow, connections into primitive fields, MODEL→IMAGE mismatches) → Level 3 model-name checks (priority: object_info COMBO options → `/models/{folder}` → field-name fallback); server-side `promptTips` parsed into a structured result
- **Native capability probe**: runtime feature-detection of `/features`, `/object_info`, `/models` (folder list); model files lazily fetched via `GET /models/{folder}`; graceful degradation never breaks the OpenAPI path, and per-endpoint details (endpoint + status) are exposed to the agent
- **Safe fallback**: browser fallback returns a structured request (semantic goal + domain allowlist + mandatory pre-snapshot) for the host agent to execute with its own browser capabilities
- **One source, two surfaces**: the CLI (`--json` agent mode) and the MCP server share the same service layer with 13 mirrored tools
- **Redacted logging**: API key literals, `/proxy/<key>`, Bearer tokens and signed URLs are always masked; `create task` and `upload` never auto-retry (no double billing)

## Demo

> This is a CLI / protocol-layer tool with no GUI screenshots yet. Below is an overview of the two runnable demos (scripts in `examples/`):

**Demo A — parameter-only (no browser at any point)**

```text
fetch workflow → find prompt node → set prompt → set seed
→ run by nodeInfoList → wait outputs
```

**Demo B — topology change**

```text
fetch workflow → probe nodes (/object_info) → node search confirms existence
→ add node → connect → validate → run by full workflow JSON → wait outputs
(if the target node does not exist, a clear NODE_NOT_FOUND is returned — never an invented class name)
```

**Demo C — browser fallback (host mode)**: for frontend-only fields absent from API Format (e.g. `control_after_generate`), patch automatically returns a `requiresBrowser` structured request (with snapshot path and rollback postconditions) — see `examples/demo-c-browser-fallback.md`.

See [Usage](#usage) for how to run them.

## Requirements

| Dependency | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | requires native `fetch` / `FormData` |
| npm | ≥ 10 | bundled with Node 20 |
| RunningHub account | — | a valid API key ([official docs](https://www.runninghub.ai/runninghub-api-doc-en/)); not needed for local graph-only operations |

## Installation

```bash
git clone https://github.com/yangxijia111/rh-agent-bridge.git
cd rh-agent-bridge
npm install
npm test        # 165 mock-based tests, no real key required
```

Copy `.env.example` to `.env` and fill it in (`.env` is git-ignored — never commit it):

```text
RUNNINGHUB_API_KEY=<required, RunningHub API key>
RUNNINGHUB_BASE_URL=https://www.runninghub.ai     # default
RUNNINGHUB_WORKFLOW_ID=<optional, default workflow id>
RUNNINGHUB_NATIVE_MODE=standard                    # standard(24GB) | plus(48GB)
RH_BROWSER_MODE=host                               # host | cdp(reserved, not implemented)
RH_CDP_URL=                                        # cdp mode only
RH_LOG_LEVEL=info
```

## Usage

### CLI (shares the same service layer with MCP)

```bash
alias rh='npm run --silent dev --'

rh doctor                                          # config & native capability check

rh workflow fetch <WORKFLOW_ID> --out workflow.api.json
rh workflow inspect workflow.api.json --query KSampler
rh workflow set-input workflow.api.json \
  --node 6 --field text --value "product photo" --out modified.json
rh workflow patch workflow.api.json \
  --ops '[{"type":"add_node","classType":"ImageUpscaleWithModel"},
          {"type":"connect","fromNode":"8","outputIndex":0,"toNode":"10","input":"image"}]' \
  --out modified.json
rh workflow validate modified.json --no-node-schema
rh workflow diff workflow.api.json modified.json

rh workflow run --workflow-id <ID> --file modified.json   # auto-selects execution mode via diff
rh workflow run --workflow-id <ID> --set 6.text="hi" --set 3.seed=42
rh task outputs <TASK_ID>
rh task wait <TASK_ID> --timeout-ms 600000

rh resource upload ./input.png       # returns fileName (relative path, not a public URL)
rh nodes probe                       # /features /object_info /models probe
rh nodes search "remove background"  # node catalog search

rh browser fallback-request --workflow-id <ID> --goal "..."
```

`workflow run --file` first fetches the remote original and diffs: value-only changes → submitted as `nodeInfoList`; topology/connection changes → submitted as full `workflow` JSON (with an automatic snapshot to `~/.rh-agent/snapshots/`).

`--json` is agent mode: stdout carries JSON only (errors are structured too: `{"error":{"code","message","retryable"}}`), logs go to stderr.

### MCP

```json
{
  "mcpServers": {
    "rh-agent-bridge": {
      "command": "node",
      "args": ["dist/mcp/server.js"],
      "cwd": "/absolute/path/to/rh-agent-bridge",
      "env": { "RUNNINGHUB_API_KEY": "<your-key>" }
    }
  }
}
```

13 tools are exposed (all with decision-friendly descriptions so agents can self-route):

| Tool | Purpose | Idempotent |
|---|---|---|
| `rh_doctor` | config & native capability check | ✅ |
| `rh_workflow_fetch` | fetch API Format → structured graph | ✅ |
| `rh_workflow_inspect` | node listing / search | ✅ |
| `rh_workflow_diff` | graph diff | ✅ |
| `rh_workflow_patch` | set_input / add / remove / connect / disconnect | ✅ (no remote writes) |
| `rh_workflow_validate` | layered static validation | ✅ |
| `rh_workflow_run` | submit task (**never auto-retried, costs credits**) | ❌ |
| `rh_task_outputs` | query outputs / state | ✅ |
| `rh_task_wait` | poll to terminal state (supports MCP cancellation) | ✅ |
| `rh_resource_upload` | upload assets (≤30MB) | ❌ |
| `rh_nodes_probe` | native probe + node catalog build | ✅ |
| `rh_node_search` | node catalog search | ✅ |
| `rh_browser_fallback_request` | structured browser fallback request | ✅ |

### Demo scripts (real account, consumes GPU credits)

```bash
RUNNINGHUB_API_KEY=<key> npm run demo:a -- <WORKFLOW_ID>   # parameter-only, no browser
RUNNINGHUB_API_KEY=<key> npm run demo:b -- <WORKFLOW_ID>   # probe → add node → connect → full run
```

## Project Structure

```text
rh-agent-bridge/
├── src/
│   ├── config/            env config · log redaction · pino logger
│   ├── errors.ts          unified RhError model (code + retryable + toJSON)
│   ├── clients/
│   │   ├── runninghub/    official OpenAPI client (zod / timeout / controlled retry)
│   │   └── comfy/         Native ComfyUI client + capability probe
│   ├── graph/             pure-function graph engine (parse / serialize / inspect /
│   │                      mutate / diff / validate / topology / execution; no network)
│   ├── catalog/           object_info adapter + TTL cache + node catalog service
│   ├── browser/           host-mode BrowserAdapter (semantic goal + domain allowlist)
│   ├── services/          Workflow / Task / Resource / BrowserFallback services + snapshots
│   ├── tools/             13 tools + registry (zod input schemas)
│   ├── cli/               commander CLI (--json agent mode)
│   └── mcp/               MCP stdio server
├── tests/                 165 tests + workflow fixtures + API contract fixtures
├── examples/              Demo A/B scripts + Demo C guide
├── .env.example           environment template
└── package.json / tsconfig.json / vitest.config.ts / eslint.config.js
```

## Core Design Notes

### 1. Parameter vs topology execution routing

After a modification, the tool computes a graph diff and picks the submission path per official guidance:

```text
only primitive inputs changed (prompt / seed / steps / image filename …)
    → workflowId + nodeInfoList (template + overrides)

nodes added/removed, connections changed, class_type changed, a connection replaced by a constant
    → workflowId + workflow=<full JSON string> (snapshot forced before submission)
```

If a connection change is ever routed to `nodeInfoList`, the tool throws `UNSUPPORTED` with an explicit reason — a path the official docs advise against.

### 2. Layered validation

| Level | Checks | Depends on |
|---|---|---|
| Level 1 | reference existence, self-reference, outputIndex, cycles | none |
| Level 2 | node-class existence, required inputs, type/enum/range, plus **five-point connection validation** (source/target existence, output-index overflow, connections into primitive fields `CONNECTION_NOT_ALLOWED`, type mismatches `CONNECTION_TYPE_MISMATCH`; unknown custom datatypes degrade to warnings to avoid false positives) | `/object_info` (skipped if unavailable) |
| Level 3 | model names, priority: object_info COMBO options for the field → `GET /models/{folder}` (checkpoints/loras/vae/upscale_models) → field-name fallback | any of the above (skipped if unavailable) |
| Server-side | `promptTips` → structured valid / nodeErrors / outputsToExecute | task-creation response |

### 3. Node catalog & anti-hallucination

The node catalog is fetched at runtime from Native ComfyUI `/object_info` (TTL cache: object_info 10 min / models folders 5 min / features 30 min). `/models` follows ComfyUI Server semantics and returns a **list of folder names** (`["checkpoints", "loras", ...]`); actual model files are lazily fetched per folder via `GET /models/{folder}` with independent TTL caching — a missing folder is a legal degradation. A failed node lookup forces one refresh; if the class still does not exist the tool returns `NODE_NOT_FOUND` — it never invents a class name.

### 4. Snapshot semantics (baseline / candidate)

- **baseline snapshot** = the **remote current state** before a mutation/run (the rollback source). Mandatory before full-workflow runs and browser fallbacks, and must come from a remote fetch — a locally modified agent graph is never a valid rollback baseline;
- **candidate snapshot** = the state intended for execution (saved alongside full-workflow runs for audit/diff).

### 5. Browser fallback (host mode)

When an operation targets a frontend-only field absent from API Format (e.g. `control_after_generate`, grouping), the tool does not fake an API call. Instead it fetches the remote workflow, saves the **baseline** snapshot, then returns a structured request (semantic goal, DOM→CDP→vision strategy, RunningHub domain allowlist, fetch+diff postconditions) for the host agent (Codex / Zcode / …) to execute with its own browser capabilities.

### 6. Security design

- The API key is read only from environment variables; `.env` never enters git; logging is double-layer redacted (field-name rules + string rules covering key literals, `/proxy/<key>`, Bearer tokens, signed URLs)
- `create task` and `upload` never auto-retry (no double billing / duplicate uploads); only idempotent reads retry automatically (≤3 times, 408/429/5xx/network)
- **nodeInfoList guardrails enforced at the Service boundary**: any entry point (tool / CLI `--set` / direct MCP overrides) carrying a connection-like value (`["nodeId", index]`) → `UNSUPPORTED` (full workflow JSON required); frontend-only fields → `REQUIRES_BROWSER`
- **graph key/id invariant**: `graph.nodes[key].id === key` is strictly enforced at every boundary (parse / wire / serialize) — mismatches raise `INVALID_WORKFLOW`, never silently corrected or overwritten
- **honest doctor semantics**: `configured=true` only means the key is present; `authenticationChecked=false` means no server-side verification was (or is claimed to have been) performed
- task polling tolerates at most 2 consecutive unrecognized business codes, then fails with `TASK_FAILED(UNKNOWN_API_STATE)` instead of polling until timeout
- The uploaded `fileName` is a relative path for load nodes and is never concatenated into a public URL (the official docs state the upload endpoint is not an image host)
- baseline snapshots are mandatory before full-workflow runs and browser fallbacks; failure aborts the operation

## Build & Run

```bash
npm run build     # tsc → dist/ (dist/cli/main.js is the bin entry)
npm test          # full vitest suite (165 mock-based tests, no real key needed)
npm run dev       # dev-mode CLI (tsx runs TS directly)
npm run mcp       # start the MCP stdio server (mountable by any MCP client)
npm run lint      # eslint
npm run demo:a    # Demo A script (real key required)
npm run demo:b    # Demo B script (real key required)
```

This is a local tool / MCP server — no server deployment needed; use it via clone or as an npm dependency.

## License

[MIT](LICENSE) © yangxijia111

## Contributing

Issues and PRs are welcome. Before submitting, make sure:

```bash
npm run lint && npm test && npm run build   # all three pass
```

Conventions:

- The graph domain layer (`src/graph/`) stays pure and network-free: no `fetch`, no `process.env`, no MCP SDK imports
- The CLI and MCP must not duplicate business logic — new tools go into `src/tools/registry.ts` and both surfaces pick them up automatically
- RunningHub API changes must follow the latest official docs and update the tests accordingly

## Roadmap

- [ ] **P1**: `remove_node` cascade, `rh_model_search` (reusing `/models`), LoRA upload execution step (signed URL consumption)
- [ ] **M9**: Playwright / CDP browser mode (`RH_BROWSER_MODE=cdp`, with domain allowlist)
- [ ] **M10**: Recorder — snapshot diff around UI operations, distilled into reusable operation recipes
- [ ] Opt-in end-to-end CI job with a real account (manual trigger, self-hosted runner with credits)
- [ ] Publish as an npm package (`npx rh-agent-bridge`)

## Acknowledgements

- [RunningHub](https://www.runninghub.ai/) — official OpenAPI & Native ComfyUI proxy
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — standard routes such as `/object_info`
- [Model Context Protocol](https://modelcontextprotocol.io/) — the tool protocol
- [zod](https://zod.dev/) / [commander](https://github.com/tj/commander.js) / [pino](https://getpino.io/) / [vitest](https://vitest.dev/)
