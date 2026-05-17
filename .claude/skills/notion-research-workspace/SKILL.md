---
name: notion-research-workspace
description: "Use when Codex needs to operate Christian's Notion research system: add papers to the Papers database, add or review research ideas in the Research Database, trigger/inspect the papers-reducto-worker, explain the webhook/tool architecture, or help agents use the Notion workspace as shared research memory."
---

# Notion Research Workspace

## System Map

Use this workspace as both a human UI and an agent tool surface.

- Repo: `/Users/christian/dev/my-notion/papers-reducto-worker`
- Worker: `papers-reducto-worker`
- Runtime IDs are not stored in this public skill. Read them from private env/config:
  - `PAPERS_DATA_SOURCE_ID`
  - `RESEARCH_DATA_SOURCE_ID`
  - worker identity from `ntn workers get` or `workers.json` if present locally

The single Notion connection webhook should point at the worker's `paperChanged` URL. Do not create separate Notion subscriptions per database unless Notion supports that in the future. `paperChanged` dispatches by page parent:

- `Papers` row -> PDF extraction and profile enrichment.
- `Research Database` row -> research proposal review.

Reducto separately calls `reductoParseComplete` when async PDF parsing finishes.

## Worker Capabilities

List live capabilities before debugging:

```sh
cd /Users/christian/dev/my-notion/papers-reducto-worker
ntn workers capabilities list
ntn workers webhooks list
ntn workers sync status --json --no-watch
```

Expected capabilities:

- Webhooks: `paperChanged`, `reductoParseComplete`, optional `researchIdeaChanged`.
- Tools: `processPendingPapers`, `processPaperById`, `writeMarkdownFromReductoJob`, `draftResearchProposal`, `reviewResearchIdeaById`, `processReadyResearchIdeas`.
- Sync status should be `[]`; this system is webhook/tool driven, not sync driven.

Do not print full worker webhook URLs in final answers unless the user explicitly asks. They contain secret path tokens.

## Notion CLI And SDK

Prefer the `ntn` CLI for direct workspace operations from an agent. It uses the configured Notion auth and keeps requests reproducible.

Common CLI patterns:

```sh
# Inspect public API docs/spec for an endpoint.
ntn api -X POST --docs v1/data_sources/DATA_SOURCE_ID/query
ntn api -X PATCH --spec v1/pages/PAGE_ID

# Retrieve database/data source/page objects.
ntn api -X GET v1/databases/DATABASE_ID
ntn api -X GET v1/data_sources/DATA_SOURCE_ID
ntn api -X GET v1/pages/PAGE_ID

# Query a data source.
ntn api -X POST v1/data_sources/DATA_SOURCE_ID/query -d '{"page_size":10,"result_type":"page"}'

# Create/update pages.
ntn api -X POST v1/pages -d "$payload"
ntn api -X PATCH v1/pages/PAGE_ID -d "$payload"

# Execute deployed worker tools.
ntn workers exec processReadyResearchIdeas -d '{"limit":1,"dryRun":false}'
```

Use `jq -nc` to build JSON payloads; it avoids quoting mistakes with Notion property names containing spaces. Use `:=` only for typed inline `ntn api` arguments; with `-d`, pass normal JSON.

Before direct page creation commands, load private IDs into the shell:

```sh
export PAPERS_DATA_SOURCE_ID=...
export RESEARCH_DATA_SOURCE_ID=...
```

Inside worker code, use the Notion SDK client from the capability context:

```ts
const page = await context.notion.pages.retrieve({ page_id: pageId });
await context.notion.pages.update({ page_id: pageId, properties });
const rows = await context.notion.dataSources.query({
  data_source_id: PAPERS_DATA_SOURCE_ID,
  result_type: "page",
});
await context.notion.pages.create({
  parent: { data_source_id: RESEARCH_DATA_SOURCE_ID },
  properties,
});
await context.notion.pages.updateMarkdown({
  page_id: markdownPageId,
  type: "replace_content",
  replace_content: { new_str: markdown, allow_deleting_content: true },
});
```

For deployed webhooks and other non-agent-triggered capabilities, `context.notion` needs the worker env `NOTION_API_TOKEN`; tools invoked by Custom Agents may be pre-authenticated, but this project still sets the token explicitly for reliability.

## Add A Paper

Use this when the user asks to save/add/track a paper. Prefer a stable public PDF URL, such as an arXiv PDF URL. If the user gives an abstract page, derive the PDF URL when obvious.

Create a `Papers` row with:

- `Title`: known title or a reasonable placeholder.
- `PDF`: Files & media property with an external PDF URL.
- `URL`: source page if known.
- `Extraction Status`: `Not Started`.

Example:

```sh
cd /Users/christian/dev/my-notion/papers-reducto-worker
payload=$(jq -nc '{
  parent:{data_source_id:env.PAPERS_DATA_SOURCE_ID},
  properties:{
    Title:{title:[{type:"text",text:{content:"Paper title"}}]},
    PDF:{files:[{name:"paper.pdf",type:"external",external:{url:"https://arxiv.org/pdf/0000.00000"}}]},
    URL:{url:"https://arxiv.org/abs/0000.00000"},
    "Extraction Status":{status:{name:"Not Started"}}
  }
}')
ntn api -X POST v1/pages -d "$payload"
```

The Notion webhook should trigger extraction automatically. If it does not, run:

```sh
ntn workers exec processPendingPapers -d '{"limit":1,"includeFailed":false,"dryRun":false}'
```

Check a paper row:

```sh
ntn api -X GET v1/pages/PAGE_ID |
  jq '{title:(.properties.Title.title|map(.plain_text)|join("")), extraction:.properties["Extraction Status"].status.name, profile:.properties["Profile Status"].status.name, markdown:.properties["Markdown Page"].url, error:.properties["Review Error"]?}'
```

## Add A Research Idea

Use this when the user says they are curious/interested in a direction or asks for a proposal grounded in their paper library.

Create a `Research Database` row with:

- `Title`: short research direction.
- `Prompt`: user context, questions, hypotheses, or constraints.
- `Review Requested`: checked.
- `Status`: `Not started`.

Example:

```sh
cd /Users/christian/dev/my-notion/papers-reducto-worker
payload=$(jq -nc '{
  parent:{data_source_id:env.RESEARCH_DATA_SOURCE_ID},
  properties:{
    Title:{title:[{type:"text",text:{content:"Multimodal RL for long-horizon visual agents"}}]},
    Prompt:{rich_text:[{type:"text",text:{content:"I am curious about visual perception, planning, tool use, and RL in multimodal agents."}}]},
    "Review Requested":{checkbox:true},
    Status:{status:{name:"Not started"}}
  }
}')
ntn api -X POST v1/pages -d "$payload"
```

The webhook should process it automatically. If it does not, run:

```sh
ntn workers exec processReadyResearchIdeas -d '{"limit":1,"dryRun":false}'
```

The worker updates:

- `Agent Summary`
- `Open Questions`
- `Next Steps`
- `Related Papers`
- `Proposal Page`
- `Reviewed At`
- `Status = Done`
- `Review Requested = unchecked`

## On-Demand Proposal Tool

When the user wants a proposal without creating a Research Database row, call:

```sh
ntn workers exec draftResearchProposal -d '{"idea":"research idea here","maxPapers":5,"parentPageId":null}'
```

If the user wants the proposal written into Notion under a specific page, set `parentPageId` to that page ID.

## Review Or Reprocess Existing Rows

Paper:

```sh
ntn workers exec processPaperById -d '{"pageId":"PAGE_ID","force":true,"dryRun":false}'
```

Research idea:

```sh
ntn workers exec reviewResearchIdeaById -d '{"pageId":"PAGE_ID","force":true,"dryRun":false}'
```

Backfill markdown/profile from an existing completed Reducto parse job:

```sh
ntn workers exec writeMarkdownFromReductoJob -d '{"pageId":"PAGE_ID","jobId":"REDUCTO_JOB_ID"}'
```

## Debugging Rules

- First check row fields in Notion, then worker runs.
- `Review Requested` must be checked to intentionally trigger a research review.
- `Extraction Status` must be `Not Started` for normal paper extraction.
- The Notion connector must have access to both databases.
- Worker env should include `NOTION_API_TOKEN`, `REDUCTO_API_KEY`, `REDUCTO_WEBHOOK_URL`, and `RESEARCH_DATA_SOURCE_ID`.
- Do not add syncs. The active architecture is webhook events plus manual/agent tools.
- If Notion only allows one connection webhook URL, use `paperChanged`; it routes both databases.
- If a webhook accepts a request with HTTP 202 but the row does not update immediately, wait briefly and inspect `ntn workers runs list` and `ntn workers runs logs RUN_ID`.
