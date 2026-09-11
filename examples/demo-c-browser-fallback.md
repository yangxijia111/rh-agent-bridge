# Demo C：API 无法完成时的 browser fallback（host 模式）

`control_after_generate` 是官方文档明确的前端-only 字段（API Format 中不存在），
试图通过 API patch 它时，工具**不会伪造一次 API 调用**，而是返回结构化 browser fallback 请求：

```bash
cd rh-agent-bridge

# 1. 先取一份工作流
npm run --silent dev -- --json workflow fetch <WORKFLOW_ID> --out workflow.api.json

# 2. 尝试设置前端-only 字段 → 返回 requiresBrowser（AT-401/402/403 全覆盖）
npm run --silent dev -- --json workflow set-input workflow.api.json \
  --node 3 --field control_after_generate --value fixed
```

输出示例：

```json
{
  "requiresBrowser": true,
  "mode": "host",
  "reason": "FRONTEND_ONLY_FIELD",
  "goal": "Set frontend-only field(s) 3.control_after_generate in the RunningHub workflow editor",
  "strategy": ["DOM", "CDP", "vision"],
  "domainAllowlist": ["runninghub.ai", "www.runninghub.ai"],
  "preconditions": ["workflow snapshot saved at ~/.rh-agent/snapshots/<id>.<ts>.<sha8>.json"],
  "postconditions": [
    "re-run rh_workflow_fetch to read the updated workflow",
    "calculate before/after diff with rh_workflow_diff",
    "abort and restore from snapshot if the change is unexpected"
  ]
}
```

宿主智能体（Codex / Zcode / 其他）按 `goal` 用自身浏览器能力执行；完成后重新
`workflow fetch` 并 `workflow diff` 校验变更（快照已自动保存，可回滚）。

也可以直接显式请求一个 fallback：

```bash
npm run --silent dev -- --json browser fallback-request \
  --workflow-id <WORKFLOW_ID> \
  --goal "在 RunningHub 编辑器中把 KSampler 的 control_after_generate 设为 fixed"
```
