#!/usr/bin/env bash
# accept.sh <annotator|verifier> <NN>: check the latest dispatched run of a batch and log accepted or rejected.
set -u
R=${COHORT_ROOT:?set COHORT_ROOT to the private cohort directory}
CODE=$(cd "$(dirname "$0")" && pwd)
RV=${REVIEW_DIR:-review}
role=$1; batch=$2; ws=$([ "$role" = annotator ] && echo ws-a || echo ws-b)
entry=$(jq -c --arg r "$role" --arg b "$batch" 'select(.role==$r and .batch==$b and (.status|not))' $R/$RV/batch-log.jsonl | tail -1)
agent=$(jq -r .agent <<<"$entry"); dispatched=$(jq -r .dispatched_at <<<"$entry"); returned=$(date -u +%FT%TZ)
report=$(node $CODE/check-batch.mjs $R/$RV/$ws "$batch" "$dispatched" "$returned"); code=$?
result=$([ $code -eq 0 ] && echo accepted || echo rejected)
jq -nc --arg b "$batch" --arg r "$role" --arg w "$ws" --arg a "$agent" --arg d "$dispatched" --arg t "$returned" --arg s "$result" \
  '{batch:$b,role:$r,workspace:$w,agent:$a,dispatched_at:$d,returned_at:$t,status:$s}' >> $R/$RV/batch-log.jsonl
jq -c '{batch, records, missing:(.missing|length), problems, actions}' <<<"$report"; echo "$role $batch $result"
