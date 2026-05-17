import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// The Experiments database is a plain (non-managed) Notion database created
// once via `npx tsx scripts/setup-database.ts`. Tools read its data source ID
// from EXPERIMENTS_DATA_SOURCE_ID at runtime.

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var ${name}`);
	return v;
}

// Tool 1: logExperiment

worker.tool("logExperiment", {
	title: "Log new experiment",
	description:
		"Create a new experiment entry. Use this when the user says they're starting a new experiment, trial, run, or test. Captures the hypothesis and sets up a structured notes page.",
	schema: j.object({
		name: j
			.string()
			.describe("Short descriptive name, e.g. 'GPT-4o vs Claude on summarization'"),
		hypothesis: j.string().describe("What the user expects to learn or prove"),
		tags: j
			.array(j.string())
			.describe("Topic tags like 'llm', 'finetuning', 'ablation'")
			.nullable(),
		method: j
			.string()
			.describe("Brief description of how the experiment will be run")
			.nullable(),
	}),
	execute: async ({ name, hypothesis, tags, method }, { notion }) => {
		const dataSourceId = requireEnv("EXPERIMENTS_DATA_SOURCE_ID");
		const expId = `EXP-${Date.now().toString(36)}`;
		const today = new Date().toISOString().slice(0, 10);

		const properties: Record<string, unknown> = {
			Name: { title: [{ text: { content: name } }] },
			"Experiment ID": { rich_text: [{ text: { content: expId } }] },
			Status: { select: { name: "Planned" } },
			Hypothesis: { rich_text: [{ text: { content: hypothesis } }] },
			"Start Date": { date: { start: today } },
		};
		if (tags && tags.length > 0) {
			properties.Tags = { multi_select: tags.map((t) => ({ name: t })) };
		}

		const page = (await notion.pages.create({
			parent: { data_source_id: dataSourceId },
			properties: properties as never,
			markdown: buildExperimentTemplate({ hypothesis, method }),
		} as never)) as { id: string; url?: string };

		return { experimentId: expId, pageId: page.id, url: page.url ?? null };
	},
});

function buildExperimentTemplate({
	hypothesis,
	method,
}: {
	hypothesis: string;
	method?: string | null;
}) {
	return [
		`## Hypothesis`,
		``,
		hypothesis,
		``,
		`## Method`,
		``,
		method ?? `_To be filled in._`,
		``,
		`## Observations`,
		``,
		`_Log notes here as the experiment runs._`,
		``,
		`## Results`,
		``,
		`_Final outcome and learnings._`,
		``,
		`## Artifacts`,
		``,
		`- _Links to runs, dashboards, code commits_`,
	].join("\n");
}

// Tool 2: updateExperiment

worker.tool("updateExperiment", {
	title: "Update experiment",
	description:
		"Change an experiment's status, add observations, or record results. Append-only: observations are added to the existing notes, not overwritten.",
	schema: j.object({
		experimentId: j.string().describe("The EXP-xxx identifier"),
		status: j
			.enum("Planned", "Running", "Complete", "Failed", "Abandoned")
			.describe("New status for the experiment")
			.nullable(),
		observation: j
			.string()
			.describe("New note to append to the Observations section")
			.nullable(),
		resultSummary: j
			.string()
			.describe("Final result summary (sets the Result Summary property)")
			.nullable(),
	}),
	execute: async (
		{ experimentId, status, observation, resultSummary },
		{ notion },
	) => {
		const dataSourceId = requireEnv("EXPERIMENTS_DATA_SOURCE_ID");

		const query = (await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: {
				property: "Experiment ID",
				rich_text: { equals: experimentId },
			},
		} as never)) as { results: Array<{ id: string }> };

		if (query.results.length === 0) {
			return {
				updated: false,
				experimentId,
				error: `No experiment found with ID ${experimentId}`,
			};
		}
		const pageId = query.results[0].id;

		const propUpdates: Record<string, unknown> = {};
		if (status) propUpdates.Status = { select: { name: status } };
		if (resultSummary) {
			propUpdates["Result Summary"] = {
				rich_text: [{ text: { content: resultSummary } }],
			};
		}
		if (Object.keys(propUpdates).length > 0) {
			await notion.pages.update({
				page_id: pageId,
				properties: propUpdates as never,
			} as never);
		}

		if (observation) {
			const timestamp = new Date()
				.toISOString()
				.slice(0, 16)
				.replace("T", " ");
			// Insert right after the Observations heading. Newest first, which
			// also avoids fighting the placeholder line that lives below.
			await notion.pages.updateMarkdown({
				page_id: pageId,
				type: "insert_content",
				insert_content: {
					content: `- **${timestamp}** — ${observation}`,
					after: "## Observations",
				},
			});
		}

		return { updated: true, experimentId, error: null };
	},
});

// Tool 3: listExperiments

worker.tool("listExperiments", {
	title: "List experiments",
	description:
		"Query past and current experiments by status, tag, or recency. Use when the user asks what they've been working on, what's running, what they tried last week, etc.",
	schema: j.object({
		status: j
			.enum("Planned", "Running", "Complete", "Failed", "Abandoned")
			.describe("Filter by status")
			.nullable(),
		tag: j.string().describe("Filter by a single tag").nullable(),
		limit: j.number().describe("Max results, default 10").nullable(),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ status, tag, limit }, { notion }) => {
		const dataSourceId = requireEnv("EXPERIMENTS_DATA_SOURCE_ID");

		const filters: unknown[] = [];
		if (status) filters.push({ property: "Status", select: { equals: status } });
		if (tag) filters.push({ property: "Tags", multi_select: { contains: tag } });

		const filter =
			filters.length === 0
				? undefined
				: filters.length === 1
					? filters[0]
					: { and: filters };

		const response = (await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: filter as never,
			sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
			page_size: limit ?? 10,
		} as never)) as { results: PageWithProperties[] };

		return {
			results: response.results.map((p) => ({
				experimentId: textOf(p.properties?.["Experiment ID"]?.rich_text) ?? null,
				name: textOf(p.properties?.Name?.title) ?? null,
				status: p.properties?.Status?.select?.name ?? null,
				hypothesis: textOf(p.properties?.Hypothesis?.rich_text) ?? null,
				tags: (p.properties?.Tags?.multi_select ?? []).map((t) => t.name),
				resultSummary:
					textOf(p.properties?.["Result Summary"]?.rich_text) ?? null,
				url: p.url ?? null,
				lastEdited: p.last_edited_time ?? null,
			})),
		};
	},
});

// Tool 4: findRelatedExperiments

worker.tool("findRelatedExperiments", {
	title: "Find related past experiments",
	description:
		"Search past experiments by keyword in the name, hypothesis, or results. Use when the user is starting something and wants to know if they've tried it before.",
	schema: j.object({
		query: j.string().describe("Keywords or topic to search for"),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ query }, { notion }) => {
		const response = (await notion.search({
			query,
			filter: { property: "object", value: "page" },
			page_size: 5,
		})) as { results: PageWithProperties[] };

		return {
			results: response.results.map((p) => ({
				id: p.id,
				title:
					textOf(p.properties?.Name?.title) ??
					textOf(p.properties?.title?.title) ??
					"(untitled)",
				url: p.url ?? null,
				lastEdited: p.last_edited_time ?? null,
			})),
		};
	},
});

// Tool 5: researchTopic

worker.tool("researchTopic", {
	title: "Research a topic externally",
	description:
		"Do web research on a topic and create a structured note page in Notion with findings and sources. Use when the user wants to learn about something before designing an experiment.",
	schema: j.object({
		topic: j.string().describe("What to research"),
		questions: j
			.array(j.string())
			.describe("Specific questions to answer, if any")
			.nullable(),
	}),
	execute: async ({ topic, questions }, { notion }) => {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			return {
				error: "ANTHROPIC_API_KEY is not set",
				pageId: null,
				url: null,
				topic,
			};
		}
		const parentPageId = process.env.RESEARCH_NOTES_PARENT_PAGE_ID;
		if (!parentPageId) {
			return {
				error: "RESEARCH_NOTES_PARENT_PAGE_ID is not set",
				pageId: null,
				url: null,
				topic,
			};
		}

		const prompt = buildResearchPrompt(topic, questions);
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-opus-4-7",
				max_tokens: 4096,
				tools: [{ type: "web_search_20250305", name: "web_search" }],
				messages: [{ role: "user", content: prompt }],
			}),
		});

		if (!response.ok) {
			const errText = await response.text();
			return {
				error: `Anthropic API error ${response.status}: ${errText.slice(0, 500)}`,
				pageId: null,
				url: null,
				topic,
			};
		}

		const data = (await response.json()) as {
			content: Array<{ type: string; text?: string }>;
		};
		const markdown = data.content
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join("\n\n");

		const page = (await notion.pages.create({
			parent: { page_id: parentPageId },
			markdown: `# Research: ${topic}\n\n${markdown}`,
		} as never)) as { id: string; url?: string };

		return { pageId: page.id, url: page.url ?? null, topic, error: null };
	},
});

function buildResearchPrompt(topic: string, questions: string[] | null): string {
	const qSection =
		questions && questions.length > 0
			? `\n\nFocus on these specific questions:\n${questions
					.map((q, i) => `${i + 1}. ${q}`)
					.join("\n")}`
			: "";
	return `Research the topic "${topic}" using web search.${qSection}

Return a structured markdown document with these sections:
## Summary
A 2-3 sentence overview.

## Key Findings
Bulleted list of the most important things to know.

## Details
Expanded discussion of the findings.

## Sources
List of URLs you used, with brief notes on each.

Use web_search liberally. Cite specific findings to specific sources.`;
}

// -- Helpers --

type RichTextItem = { plain_text?: string; text?: { content?: string } };
type SelectItem = { name: string };
type PageWithProperties = {
	id: string;
	url?: string;
	last_edited_time?: string;
	properties?: Record<
		string,
		{
			title?: RichTextItem[];
			rich_text?: RichTextItem[];
			select?: SelectItem | null;
			multi_select?: SelectItem[];
		}
	>;
};

function textOf(items: RichTextItem[] | undefined): string | undefined {
	if (!items || items.length === 0) return undefined;
	const joined = items
		.map((i) => i.plain_text ?? i.text?.content ?? "")
		.join("")
		.trim();
	return joined || undefined;
}
