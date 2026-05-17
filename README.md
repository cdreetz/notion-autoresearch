# my-notion

Notion Workers hackathon project — a research system built on top of Notion as shared memory for both humans and agents.

## Layout

- `papers-reducto-worker/` — the main worker. Parses PDFs from the `Papers` database with Reducto, writes markdown child pages back to Notion, enriches rows with structured metadata, and exposes a research-proposal tool. See its [README](papers-reducto-worker/README.md) for capabilities and setup.
- `.claude/skills/notion-research-workspace/` — Claude skill describing how agents operate the workspace (add papers, add research ideas, trigger/inspect the worker).
- `hack-notes.md` — rough working notes.
- `CLAUDE.md` — project-scoped instructions for Claude Code.

## Architecture

The system is **webhook + tool driven**, not sync driven.

- A single Notion connection webhook points at the worker's `paperChanged` URL.
- `paperChanged` dispatches by page parent: `Papers` rows → PDF extraction; `Research Database` rows → proposal review.
- Reducto calls `reductoParseComplete` when async PDF parsing finishes.
- Agent tools (`processPendingPapers`, `draftResearchProposal`, `reviewResearchIdeaById`, etc.) can be invoked manually or by Custom Agents.

## Using the workspace from an agent

See `.claude/skills/notion-research-workspace/SKILL.md` for the full agent playbook: adding papers, adding research ideas, on-demand proposals, reprocessing rows, and debugging.
