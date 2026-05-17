# Research & Experiment Tracker

A Notion Worker that turns Notion into a smart lab notebook. One managed `Experiments` database + 5 tools for a Custom Agent: `logExperiment`, `updateExperiment`, `listExperiments`, `findRelatedExperiments`, `researchTopic`.

## Setup

```shell
npm install
npm run check
```

## Deploy

```shell
ntn login
ntn workers deploy --name research-tracker   # first time only
ntn workers deploy                            # subsequent deploys
```

The Experiments database is a **plain** Notion database (not a Workers-managed one), so it has to be created once before the tools work. The setup script does that.

```shell
# 1. Create an internal integration at https://www.notion.so/profile/integrations/internal
#    and copy its token into .env as NOTION_API_TOKEN.

# 2. Pick a Notion page to host the Experiments database under, and share that
#    page with the integration (page → Share → Add connection). Copy the page
#    ID from the URL.

# 3. Run the setup script. It prints the data source ID.
PARENT_PAGE_ID=<page-id> npx tsx scripts/setup-database.ts

# 4. Add EXPERIMENTS_DATA_SOURCE_ID to .env (the script prints the line to copy).

# 5. Push env vars to the deployed worker:
ntn workers env push
```

Required env vars:

| Var | Used by | What it is |
|---|---|---|
| `NOTION_API_TOKEN` | all tools | Internal integration token from https://www.notion.so/profile/integrations/internal. Must have access to the Experiments database and the research-notes parent page. |
| `EXPERIMENTS_DATA_SOURCE_ID` | `logExperiment`, `updateExperiment`, `listExperiments` | Data source ID from `ntn datasources resolve`. |
| `ANTHROPIC_API_KEY` | `researchTopic` | Claude API key. |
| `RESEARCH_NOTES_PARENT_PAGE_ID` | `researchTopic` | A Notion page (must be shared with the integration) under which research notes are created. |

For local testing, put these in `.env`.

## Test locally

```shell
bash test.sh           # log, list, find
bash test.sh update EXP-abc123
bash test.sh research
```

Or one-off:

```shell
ntn workers exec logExperiment --local -d '{"name":"test","hypothesis":"it works"}'
```

## Notes on the spec

A few corrections vs. the original spec:
- **Experiments DB is a plain database, not `worker.database()`.** The Workers SDK only provisions managed databases when a sync references them, and treats them as read-only from the worker's perspective. The spec writes to the DB from tools, so a plain Notion database (created once via `scripts/setup-database.ts`) is the right shape. Tools read `EXPERIMENTS_DATA_SOURCE_ID` from env at runtime.
- `notion.databases.query` is now `notion.dataSources.query` with `data_source_id`.
- `Schema.select(...)` / `Schema.multiSelect(...)` would have taken a `SelectOption[]` directly, not `{ options: [...] }` (no longer relevant since we dropped Schema).
- `listExperiments` sorts by the built-in `last_edited_time` timestamp (there's no `Schema.lastEditedTime()`).

The `updateExperiment` tool uses `insert_content` with `after: "## Observations...## Results"` to target the Observations section. If that ellipsis selection turns out to be flaky in practice, fall back to `update_content` with `old_str` matching a sentinel line in the template.
