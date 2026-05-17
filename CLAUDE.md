# Claude Project Instructions

This project contains a Notion Workers hackathon system. Project-scoped Claude skills live in `.claude/skills/`.

Use `.claude/skills/notion-research-workspace/SKILL.md` when working with the active research system:

- Adding papers to the `Papers` database.
- Adding research ideas to the `Research Database`.
- Triggering or debugging `papers-reducto-worker`.
- Explaining the webhook/tool architecture.
- Using the Notion CLI or SDK against this workspace.

Important: the active research system is webhook/tool driven. Do not add a sync capability unless the user explicitly asks for a separate sync feature. The single Notion connection webhook URL should be the worker's `paperChanged` endpoint, which dispatches both `Papers` and `Research Database` events.
