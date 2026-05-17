/**
 * One-shot setup: creates the Experiments database under a parent page,
 * then prints the database ID and data source ID.
 *
 * Usage:
 *   NOTION_API_TOKEN=ntn_... PARENT_PAGE_ID=<page-id> npx tsx scripts/setup-database.ts
 *
 * Or with .env:
 *   PARENT_PAGE_ID=<page-id> npx tsx scripts/setup-database.ts
 *
 * The parent page must already be shared with the internal integration whose
 * token is in NOTION_API_TOKEN. Add EXPERIMENTS_DATA_SOURCE_ID to .env after
 * running this.
 */
import { Client } from "@notionhq/client";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
	loadDotEnv();

	const token = process.env.NOTION_API_TOKEN;
	const parentPageId = process.env.PARENT_PAGE_ID;
	if (!token) {
		console.error("Missing NOTION_API_TOKEN");
		process.exit(1);
	}
	if (!parentPageId) {
		console.error("Missing PARENT_PAGE_ID (the Notion page to create the DB under)");
		process.exit(1);
	}

	const notion = new Client({ auth: token });

	const db = await notion.databases.create({
		parent: { type: "page_id", page_id: parentPageId },
		title: [{ type: "text", text: { content: "Experiments" } }],
		initial_data_source: {
			properties: {
				Name: { title: {} },
				"Experiment ID": { rich_text: {} },
				Status: {
					select: {
						options: [
							{ name: "Planned", color: "gray" },
							{ name: "Running", color: "yellow" },
							{ name: "Complete", color: "green" },
							{ name: "Failed", color: "red" },
							{ name: "Abandoned", color: "default" },
						],
					},
				},
				Hypothesis: { rich_text: {} },
				Tags: { multi_select: { options: [] } },
				"Start Date": { date: {} },
				"Result Summary": { rich_text: {} },
			},
		},
	} as never);

	const dataSources = (db as unknown as { data_sources: Array<{ id: string; name: string }> })
		.data_sources;

	console.log("");
	console.log("Created Experiments database:");
	console.log(`  database_id:        ${(db as { id: string }).id}`);
	if (dataSources && dataSources.length > 0) {
		for (const ds of dataSources) {
			console.log(`  data_source_id:     ${ds.id}  (${ds.name})`);
		}
		console.log("");
		console.log("Add this to .env:");
		console.log(`  EXPERIMENTS_DATA_SOURCE_ID=${dataSources[0].id}`);
	} else {
		console.log("  (no data sources returned — run `ntn datasources resolve <database-id>` manually)");
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

function loadDotEnv() {
	const envPath = resolve(process.cwd(), ".env");
	if (!existsSync(envPath)) return;
	const text = readFileSync(envPath, "utf8");
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		const [, k, rawV] = m;
		if (process.env[k]) continue;
		const v = rawV.replace(/^['"]|['"]$/g, "");
		process.env[k] = v;
	}
}
