#!/usr/bin/env bash
# Demo B：拓扑修改（08_MASTER_BUILD_PROMPT §最终必须展示）
#
# 流程：fetch workflow → probe nodes → add node → connect node
#       → validate → run by full workflow JSON → wait outputs
# 如果目标节点在当前 RunningHub 实例不存在，工具返回 NODE_NOT_FOUND，绝不凭空编节点名。
#
# 用法：
#   RUNNINGHUB_API_KEY=<key> ./examples/demo-b-topology.sh <WORKFLOW_ID>
set -euo pipefail
cd "$(dirname "$0")/.."

WORKFLOW_ID="${1:?用法: demo-b-topology.sh <WORKFLOW_ID>}"
RH="npm run --silent dev --"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 1. fetch workflow =="
$RH --json workflow fetch "$WORKFLOW_ID" --out "$TMP/workflow.api.json" >/dev/null

echo "== 2. probe nodes（Native ComfyUI /object_info）=="
$RH --json nodes probe

echo "== 2b. node search：确认目标节点真实存在（不 hallucinate）=="
# 示例目标：ImageUpscaleWithModel；如果实例没有该节点，这里会明确报告
SEARCH=$($RH --json nodes search "ImageUpscaleWithModel" --limit 3)
echo "$SEARCH"
FOUND=$(echo "$SEARCH" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.matches.some(m=>m.classType==='ImageUpscaleWithModel')?'yes':'no')})")
if [ "$FOUND" != "yes" ]; then
  echo "NODE_NOT_FOUND：当前实例没有 ImageUpscaleWithModel，终止（不凭空编造节点名）" >&2
  exit 2
fi

echo "== 3+4. add node + connect（拓扑 patch）=="
$RH --json workflow patch "$TMP/workflow.api.json" \
  --ops "[
    {\"type\":\"add_node\",\"classType\":\"ImageUpscaleWithModel\",\"title\":\"Upscale (demo)\"},
    {\"type\":\"connect\",\"fromNode\":\"8\",\"outputIndex\":0,\"toNode\":\"10\",\"input\":\"image\"}
  ]" \
  --out "$TMP/modified.json"
# 说明：示例假设 SaveImage 是节点 9、VAEDecode 输出是节点 8；
# 实际运行前请先 inspect 确认目标连接点（可按需修改 fromNode/toNode/input）。

echo "== 5. validate =="
$RH --json workflow validate "$TMP/modified.json" --no-node-schema

echo "== 6. run by full workflow JSON（拓扑变化 → 自动选择 fullWorkflow 模式）=="
RUN_JSON=$($RH --json workflow run --workflow-id "$WORKFLOW_ID" --file "$TMP/modified.json")
echo "$RUN_JSON"
TASK_ID=$(echo "$RUN_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.taskId)})")

echo "== 7. wait outputs =="
$RH --json task wait "$TASK_ID" --timeout-ms 600000

echo "== Demo B 完成（拓扑修改走完整 workflow JSON）=="
