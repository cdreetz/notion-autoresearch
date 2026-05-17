# live-table-app

Notion Worker + external research service that fills a Notion database live as background research completes. The agent creates rows with `Searching...` placeholders and returns immediately; cells flip to real values within ~30 seconds as Claude finishes each entity.

## Architecture

```
User → Custom Agent → tool: createEnrichedTable
                          │
                          ├── creates N rows in "Research Results" DB (Status: Searching)
                          ├── returns to agent immediately
                          └── POST /run → research-service
                                              │
                                              ├── runs N Claude+web_search jobs in parallel
                                              └── for each job: POST signed payload back to
                                                  worker webhook → notion.pages.update()
```

## One-time setup

### 1. Install deps

```bash
cd live-table-app && npm install
cd research-service && npm install
```

### 2. Notion integration

1. Create an internal integration at <https://www.notion.so/profile/integrations/internal>
2. Copy the token (`ntn_...`)
3. Give the integration access to the page where the "Research Results" database will live (just give it workspace access for the hackathon)

### 3. Generate the shared HMAC secret

```bash
openssl rand -hex 32
```

Put the same value in both `.env` files (and later push to deployed envs).

### 4. First deploy of the worker

From the `live-table-app` directory:

```bash
ntn login   # if not already logged in
ntn workers env set NOTION_API_TOKEN=ntn_xxx
ntn workers env set RESEARCH_SHARED_SECRET=<generated-secret>
ntn workers env set RESEARCH_SERVICE_URL=https://placeholder.example.com
ntn workers env set SELF_WEBHOOK_URL=https://placeholder.example.com
ntn workers deploy
```

This creates the managed "Research Results" database in your Notion workspace and registers the webhook URL.

### 5. Resolve the data source ID

The Notion API writes to **data sources**, not databases. Get the data source ID:

```bash
# Find the database ID — open "Research Results" in Notion, copy from URL,
# or use ntn workers capabilities list to find it.
ntn datasources resolve <database-id>
```

Set it:

```bash
ntn workers env set NOTION_DATA_SOURCE_ID=<data-source-id>
```

### 6. Get the webhook URL

```bash
ntn workers webhooks list
```

Copy the `onResearchResult` URL and set it:

```bash
ntn workers env set SELF_WEBHOOK_URL=<webhook-url>
```

### 7. Deploy the research service

For the hackathon, anywhere with public HTTPS works. Easiest options:

- **ngrok (fastest, dev only):**
  ```bash
  cd research-service
  echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
  echo "RESEARCH_SHARED_SECRET=<same-as-worker>" >> .env
  npm run dev          # starts on :8787
  ngrok http 8787      # in another shell, copy the https URL
  ```
- **Render / Railway / Fly:** push, set `ANTHROPIC_API_KEY` and `RESEARCH_SHARED_SECRET`, deploy.

Once you have the public URL:

```bash
cd ../  # back to live-table-app
ntn workers env set RESEARCH_SERVICE_URL=https://your-research-service.example.com
ntn workers deploy   # re-deploy so the env change takes effect
```

## Testing locally

The worker tool can be run locally against the deployed environment:

```bash
ntn workers exec createEnrichedTable -d '{
  "entities": ["OpenAI", "Anthropic", "Mistral"],
  "fieldDescriptions": ["CEO name", "employee count", "HQ city"]
}'
```

Watch the "Research Results" database in Notion — rows should appear with `Searching...`, then flip to real values as the research service posts back.

## Debugging

```bash
ntn workers runs list                                # recent runs
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
ntn workers capabilities list                        # check that tool and webhook are enabled
```

If the rows never flip from `Searching...`:

- Check `ntn workers runs logs` for the latest `onResearchResult` invocation — most likely an HMAC signature mismatch (secrets don't match between sides) or an `NOTION_DATA_SOURCE_ID` issue.
- Check the research service logs for Claude API errors.
- Hit the research-service `/run` endpoint directly with curl to confirm it's reachable from the worker.

## Files

- `src/index.ts` — Notion Worker (`createEnrichedTable` tool, `onResearchResult` webhook, managed "Research Results" database)
- `research-service/src/index.ts` — Hono server that runs Claude + web search per job and posts signed callbacks
- `.env.example` — required env vars for the worker
- `research-service/.env.example` — required env vars for the service

## Deviations from the original spec

- `worker.database("enriched", ...)` is declared, but the Notion data source ID is not exposed at runtime via the `DatabaseHandle`. The tool reads `NOTION_DATA_SOURCE_ID` from env, set manually after the first deploy.
- `Schema.lastEditedTime()` doesn't exist in the SDK; Notion tracks `last_edited_time` on every page automatically, so it's omitted.
- `Schema.select(options)` takes an array, not `{ options: [...] }`.
- Page parent uses `data_source_id` (the current Notion API form), not `database_id`.
