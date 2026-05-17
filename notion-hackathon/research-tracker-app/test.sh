#!/usr/bin/env bash
# Exercises each tool capability locally. Requires .env with:
#   NOTION_API_TOKEN
#   EXPERIMENTS_DATA_SOURCE_ID
#   ANTHROPIC_API_KEY            (only for researchTopic)
#   RESEARCH_NOTES_PARENT_PAGE_ID (only for researchTopic)
#
# Run with: bash test.sh
# Or pick a single tool:  bash test.sh log
set -euo pipefail

ONLY="${1:-all}"

run() {
  local cap="$1"
  local payload="$2"
  echo
  echo "=== $cap ==="
  ntn workers exec "$cap" --local -d "$payload"
}

if [[ "$ONLY" == "all" || "$ONLY" == "log" ]]; then
  run logExperiment '{
    "name": "GPT-4o vs Claude on summarization",
    "hypothesis": "Claude produces more faithful summaries than GPT-4o for long docs",
    "tags": ["llm", "summarization"],
    "method": "10 PubMed abstracts, faithfulness scored by GPT-4 judge"
  }'
fi

if [[ "$ONLY" == "all" || "$ONLY" == "list" ]]; then
  run listExperiments '{"limit": 5}'
fi

if [[ "$ONLY" == "all" || "$ONLY" == "find" ]]; then
  run findRelatedExperiments '{"query": "summarization"}'
fi

if [[ "$ONLY" == "update" ]]; then
  # Pass the experimentId printed by logExperiment as the second argument.
  EXP_ID="${2:?usage: bash test.sh update <EXP-id>}"
  run updateExperiment "$(cat <<JSON
{
  "experimentId": "$EXP_ID",
  "status": "Complete",
  "observation": "Small model + few-shot beat the big model by 4 points",
  "resultSummary": "Few-shot prompting matters more than model size on this task"
}
JSON
)"
fi

if [[ "$ONLY" == "research" ]]; then
  run researchTopic '{
    "topic": "Prompt tuning for small language models in 2026",
    "questions": ["What techniques are state-of-the-art?", "What datasets are used?"]
  }'
fi
