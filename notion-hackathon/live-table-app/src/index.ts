import { Worker, WebhookVerificationError } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import * as Schema from "@notionhq/workers/schema";
import crypto from "node:crypto";

const worker = new Worker();
export default worker;

worker.database("enriched", {
	type: "managed",
	initialTitle: "Research Results",
	primaryKeyProperty: "Row ID",
	schema: {
		properties: {
			Name: Schema.title(),
			"Row ID": Schema.richText(),
			Status: Schema.select([
				{ name: "Searching", color: "yellow" },
				{ name: "Done", color: "green" },
				{ name: "Failed", color: "red" },
			]),
			Field1: Schema.richText(),
			Field2: Schema.richText(),
			Field3: Schema.richText(),
		},
	},
});

function rt(content: string) {
	return { rich_text: [{ text: { content } }] };
}

worker.tool("createEnrichedTable", {
	title: "Create Enriched Research Table",
	description:
		"Create rows in the Research Results database, one per entity, and trigger background research to fill in fields. Returns immediately; rows populate live as research completes.",
	schema: j.object({
		entities: j
			.array(j.string())
			.describe(
				"Names or identifiers of the things to research, e.g. ['OpenAI', 'Anthropic', 'Mistral'].",
			),
		fieldDescriptions: j
			.array(j.string())
			.describe(
				"Up to 3 things to look up about each entity, e.g. ['CEO name', 'employee count', 'last funding round']. Will be mapped to Field1, Field2, Field3 columns in order.",
			),
	}),
	execute: async ({ entities, fieldDescriptions }, { notion }) => {
		const dataSourceId = process.env.DATA_SOURCE_ID;
		if (!dataSourceId) {
			throw new Error(
				"DATA_SOURCE_ID is not set. After first deploy, find the managed database's data source ID and run `ntn workers env set DATA_SOURCE_ID=<id>`.",
			);
		}
		const serviceUrl = process.env.RESEARCH_SERVICE_URL;
		const webhookUrl = process.env.SELF_WEBHOOK_URL;
		const sharedSecret = process.env.RESEARCH_SHARED_SECRET;
		if (!serviceUrl || !webhookUrl || !sharedSecret) {
			throw new Error(
				"Missing one of RESEARCH_SERVICE_URL, SELF_WEBHOOK_URL, RESEARCH_SHARED_SECRET.",
			);
		}

		const padded = [
			fieldDescriptions[0] ?? "",
			fieldDescriptions[1] ?? "",
			fieldDescriptions[2] ?? "",
		];

		const jobs: Array<{
			rowId: string;
			pageId: string;
			entity: string;
			fieldDescriptions: string[];
		}> = [];

		for (const entity of entities) {
			const rowId = crypto.randomUUID();
			const page = await notion.pages.create({
				parent: { data_source_id: dataSourceId },
				properties: {
					Name: { title: [{ text: { content: entity } }] },
					"Row ID": rt(rowId),
					Status: { select: { name: "Searching" } },
					Field1: rt("Searching..."),
					Field2: rt("Searching..."),
					Field3: rt("Searching..."),
				},
			});
			jobs.push({ rowId, pageId: page.id, entity, fieldDescriptions: padded });
		}

		// Await the dispatch so the request actually leaves before the handler
		// returns. The service responds immediately with { accepted: N } and
		// does the real research work in its own background.
		try {
			const res = await fetch(`${serviceUrl}/run`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jobs, webhookUrl, sharedSecret }),
			});
			if (!res.ok) {
				console.error(
					`Research service /run returned ${res.status}: ${await res.text()}`,
				);
			} else {
				console.log(`Dispatched ${jobs.length} jobs to research service`);
			}
		} catch (err) {
			console.error("Failed to dispatch research:", err);
		}

		return {
			message: `Created ${entities.length} rows. Results will fill in over the next ~30 seconds.`,
			rowCount: entities.length,
		};
	},
});

function verifyHmac(rawBody: string, headers: Record<string, string>): void {
	const secret = process.env.RESEARCH_SHARED_SECRET;
	if (!secret) {
		throw new WebhookVerificationError("RESEARCH_SHARED_SECRET missing");
	}
	const sig = headers["x-research-signature"];
	if (!sig) throw new WebhookVerificationError("missing signature");
	const expected = crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex");
	if (sig.length !== expected.length) {
		throw new WebhookVerificationError("bad signature");
	}
	if (
		!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
	) {
		throw new WebhookVerificationError("bad signature");
	}
}

type ResultPayload = {
	pageId: string;
	fields?: { Field1?: string; Field2?: string; Field3?: string };
	error?: string;
};

worker.webhook("onResearchResult", {
	title: "Research result callback",
	description:
		"Receives completed research from the external service and updates the corresponding row.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			verifyHmac(event.rawBody, event.headers);
			const { pageId, fields, error } = event.body as ResultPayload;

			if (error) {
				await notion.pages.update({
					page_id: pageId,
					properties: { Status: { select: { name: "Failed" } } },
				});
				continue;
			}

			const properties: Record<string, unknown> = {
				Status: { select: { name: "Done" } },
			};
			if (fields?.Field1) properties.Field1 = rt(fields.Field1);
			if (fields?.Field2) properties.Field2 = rt(fields.Field2);
			if (fields?.Field3) properties.Field3 = rt(fields.Field3);

			await notion.pages.update({
				page_id: pageId,
				properties: properties as Parameters<
					typeof notion.pages.update
				>[0]["properties"],
			});
		}
	},
});
