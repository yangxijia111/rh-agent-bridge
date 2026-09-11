#!/usr/bin/env bash
# Demo A：纯参数修改（08_MASTER_BUILD_PROMPT §最终必须展示）
#
# 流程：fetch workflow → find prompt node → set prompt → set seed
#       → run by nodeInfoList → wait outputs
# 整个过程不调用 browser fallback。
#
# 用法：
#   RUNNINGHUB_API_KEY=<key> ./examples/demo-a-param-only.sh <WORKFLOW_ID> [PROMPT] [SEED]
set -euo pipefail
cd "$(dirname "$0")/.."

WORKFLOW_ID="${1:?用法: demo-a-param-only.sh <WORKFLOW_ID> [PROMPT] [SEED]}"
PROMPT="${2:-studio product photography}"
SEED="${3:-42}"
RH="npm run --silent dev --"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== 1. doctor（环境体检）=="
$RH --json doctor --no-probe-native

echo "== 2. fetch workflow =="
$RH --json workflow fetch "$WORKFLOW_ID" --out "$TMP/workflow.api.json" >/dev/null

echo "== 3. find prompt node（CLIPTextEncode）=="
PROMPT_NODE=$($RH --json workflow inspect "$TMP/workflow.api.json" --query CLIPTextEncode \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.nodes[0].id)})")
echo "prompt node = $PROMPT_NODE"

echo "== 4. set prompt =="
$RH --json workflow set-input "$TMP/workflow.api.json" \
  --node "$PROMPT_NODE" --field text --value "$PROMPT" \
  --out "$TMP/modified.json" >/dev/null

echo "== 5. set seed（在 KSampler 上）=="
SAMPLER_NODE=$($RH --json workflow inspect "$TMP/workflow.api.json" --query KSampler \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.nodes[0]?j.nodes[0].id:'')})")
if [ -n "$SAMPLER_NODE" ]; then
  $RH --json workflow set-input "$TMP/modified.json" \
    --node "$SAMPLER_NODE" --field seed --value "$SEED" \
    --out "$TMP/modified2.json" >/dev/null
  mv "$TMP/modified2.json" "$TMP/modified.json"
fi

echo "== 6. run by nodeInfoList（CLI 自动 diff：仅参数变化 → nodeInfoList 模式）=="
RUN_JSON=$($RH --json workflow run --workflow-id "$WORKFLOW_ID" --file "$TMP/modified.json")
echo "$RUN_JSON"
TASK_ID=$(echo "$RUN_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.taskId)})")

echo "== 7. wait outputs =="
$RH --json task wait "$TASK_ID" --timeout-ms 600000

echo "== Demo A 完成（全程未使用 browser fallback）=="
