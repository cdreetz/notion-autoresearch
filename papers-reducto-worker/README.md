# Papers Reducto Worker

Notion Worker that parses PDFs from the `Papers` database with Reducto, writes a searchable markdown child page back to Notion, enriches the row with structured paper metadata, and exposes a research-proposal tool for Notion Custom Agents. The `PDF` property can be either a URL property or a `Files & media` property.

## Capabilities

- `paperChanged`: single Notion connection webhook target. Routes Papers rows to PDF extraction and Research Database rows to proposal review.
- `processPendingPapers`: manual batch tool for pending rows.
- `processPaperById`: manual single-page tool.
- `writeMarkdownFromReductoJob`: rewrite a row from an existing completed Reducto job without parsing again.
- `draftResearchProposal`: agent tool that searches enriched paper profiles and returns a grounded proposal brief.
- `researchIdeaChanged`: optional direct webhook target for the Research Database. Usually not needed if the connection only supports one webhook URL.
- `reviewResearchIdeaById`: manual single-idea review tool.
- `processReadyResearchIdeas`: manual batch tool for requested research reviews.
- `reductoParseComplete`: webhook endpoint for Reducto async parse callbacks.

## Required Worker Secrets

```sh
ntn workers env set REDUCTO_API_KEY=...
ntn workers env set NOTION_API_TOKEN=...
```

`NOTION_API_TOKEN` should be the Notion connector/internal integration token that was added to the `Papers` database. It needs permission to read the database and create/update pages.

For async Reducto jobs, deploy once, copy the `reductoParseComplete` URL, and store it as another worker secret:

```sh
ntn workers deploy
ntn workers webhooks list
ntn workers env set REDUCTO_WEBHOOK_URL=https://www.notion.so/webhooks/...
```

If `REDUCTO_WEBHOOK_URL` is not set, the worker falls back to synchronous Reducto parsing.

## Automatic Ingestion

Use a Notion connection webhook subscription and point it at the `paperChanged` URL from `ntn workers webhooks list`. This one URL handles both the `Papers` database and the `Research Database`.

Subscribe to:

- `page.created`
- `page.properties_updated`
- `data_source.content_updated`

The handler processes the changed page when Notion sends a page entity. For data source/database events, it scans for one pending row where `PDF` is not empty and `Extraction Status` is `Not Started`.

The Reducto parse job uses the `reductoParseComplete` webhook as its callback. When Reducto finishes, the worker writes all markdown into one child page and updates the row with title, authors, publication year, topics, abstract, summary, key concepts, claims, methods, datasets, limitations, and open questions.

## Research Database Interface

Use the `Research Database` as the day-to-day interface:

1. Add a new row with a research idea in `Title`.
2. Add context, notes, or a question in `Prompt`.
3. Check `Review Requested`.

The worker sets `Status` to `In progress`, searches enriched paper profiles, creates or updates a proposal page under the idea row, then updates:

- `Agent Summary`
- `Open Questions`
- `Next Steps`
- `Related Papers`
- `Proposal Page`
- `Reviewed At`
- `Status` = `Done`

To make this automatic, use the same Notion connection webhook subscription as paper ingestion. The connection should have access to both databases, and the webhook URL should be `paperChanged`. Subscribe to `page.created`, `page.properties_updated`, and `data_source.content_updated`.

## Research Agent Tool

`draftResearchProposal` is meant for a Notion Custom Agent. Give it:

- `idea`: the proposed research direction.
- `maxPapers`: number of related papers to cite, usually `5`.
- `parentPageId`: a Notion page ID if you want the brief written as a page, or `null` to only return markdown.

Example:

```sh
ntn workers exec draftResearchProposal -d '{"idea":"multimodal agents that use visual perception for long-horizon tool use","maxPapers":5,"parentPageId":null}'
```

The tool scores papers from the structured row fields, not by reparsing PDFs. It returns matching papers, the extracted evidence it used, gaps to target, a first work plan, and references to the markdown pages.

## Local Test

```sh
ntn workers env pull
ntn workers exec processPendingPapers --local -d '{"limit":1,"includeFailed":false,"dryRun":true}'
ntn workers exec processPaperById --local -d '{"pageId":"...","force":false,"dryRun":true}'
ntn workers exec draftResearchProposal --local -d '{"idea":"...","maxPapers":5,"parentPageId":null}'
ntn workers exec processReadyResearchIdeas --local -d '{"limit":1,"dryRun":true}'
```

## Deploy

```sh
npm install
npm run build
ntn workers deploy --local-build
```
