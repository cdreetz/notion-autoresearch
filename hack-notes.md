# Notion Hackathon Notes

## Master Plan

- papers database automate extraction
- enrich paper extraction with useful things like claims, methods, datasets, code, open questions
- research db to track ideas, status, related papers from paper db, proposal links
- track and update research memory
- research agent can make directional proposals
- end goal: agent acts on proposals, launching its own exploration on set directions

## Papers Database

- 1 worker
- 1 webhook subscription
- 2 webhook urls
  - paperChanged
  - reductoParseComplete
- 3 tools
  - processPendingPapers
  - processPaperById
  - writeMarkdownFromReductoJob
  - draftResearchProposal
  - reviewResearchIdeaById
  - processReadyResearchIdeas

- flow
  - upload a pdf file to the database
  - notion sends page.created, page.properties_updated, or data_source.content_updated to paperChanged
  - paperChanged checks if there has been an update and processes rows where PDF is filled and Extraction Status is Not Started
  - starts reducto job to parse the PDF, both Reducto Parse for markdown and Reducto Extract for structured fields
  - when reducto finishes it calls the workers reductoParseComplete webhook
  - worker fetches results from reducto, and writes content to a new notion markdown page
  - updates paper database row with the new markdown page url
  - on completion the worker also updates the row metadata for Title, Authors, Publication Year, Topics, Processed At
    - these items are extracted by simple heuristics (first markdown title, following items are authors, keyword matching topics)
    - should be updated to structured output extraction

## Research Database

- flow
  - create new row and add title and prompt, and select Review Requested
  - notion sends row change to paperChanged
  - worker sees page is Research Database
  - worker searches enriched Paper db rows
  - worker creates a proposal page for the research row
  - writes agent summary, open questions, next steps, related papers, proposal page
  - unchecks Review Requested
