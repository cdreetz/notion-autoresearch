import { serve } from "@hono/node-server";
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import crypto from "node:crypto";

const anthropic = new Anthropic({
	apiKey: process.env.ANTHROPIC_API_KEY,
});

type Job = {
	rowId: string;
	pageId: string;
	entity: string;
	fieldDescriptions: string[];
};

type Fields = { Field1?: string; Field2?: string; Field3?: string };

const app = new Hono();

app.get("/", (c) => c.text("research-service ok"));

app.post("/run", async (c) => {
	const { jobs, webhookUrl, sharedSecret } = (await c.req.json()) as {
		jobs: Job[];
		webhookUrl: string;
		sharedSecret: string;
	};
	if (!Array.isArray(jobs) || !webhookUrl || !sharedSecret) {
		return c.json({ error: "missing jobs, webhookUrl, or sharedSecret" }, 400);
	}
	console.log(`Accepted ${jobs.length} jobs`);

	for (const job of jobs) {
		runJob(job, webhookUrl, sharedSecret).catch((err) => {
			console.error(`Job ${job.rowId} crashed:`, err);
		});
	}

	return c.json({ accepted: jobs.length });
});

async function runJob(job: Job, webhookUrl: string, sharedSecret: string) {
	try {
		const fields = await researchEntity(job.entity, job.fieldDescriptions);
		await postBack(webhookUrl, sharedSecret, { pageId: job.pageId, fields });
		console.log(`Job ${job.rowId} (${job.entity}) → done`);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Job ${job.rowId} (${job.entity}) failed:`, message);
		await postBack(webhookUrl, sharedSecret, {
			pageId: job.pageId,
			error: message,
		}).catch((e) => console.error("Postback failed:", e));
	}
}

async function researchEntity(
	entity: string,
	fieldDescriptions: string[],
): Promise<Fields> {
	const [d1, d2, d3] = fieldDescriptions;
	const prompt = `Research "${entity}" using web search.

Return ONLY a JSON object with these exact keys, no preamble, no markdown fences:
{
  "Field1": "<${d1 || "n/a"}>",
  "Field2": "<${d2 || "n/a"}>",
  "Field3": "<${d3 || "n/a"}>"
}

Keep each value concise (under ~80 chars). If a field is unknown after searching, use "Unknown".`;

	const result = await anthropic.messages.create({
		model: "claude-opus-4-7",
		max_tokens: 1024,
		tools: [
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 3,
			} as unknown as Anthropic.Tool,
		],
		messages: [{ role: "user", content: prompt }],
	});

	const text =
		result.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim() || "{}";

	const cleaned = text.replace(/```json|```/g, "").trim();
	const firstBrace = cleaned.indexOf("{");
	const lastBrace = cleaned.lastIndexOf("}");
	if (firstBrace < 0 || lastBrace < 0) {
		throw new Error(`No JSON object in model response: ${text.slice(0, 200)}`);
	}
	const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Fields;
	return {
		Field1: parsed.Field1,
		Field2: parsed.Field2,
		Field3: parsed.Field3,
	};
}

async function postBack(
	url: string,
	secret: string,
	body: { pageId: string; fields?: Fields; error?: string },
) {
	const raw = JSON.stringify(body);
	const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-research-signature": sig,
		},
		body: raw,
	});
	if (!res.ok) {
		throw new Error(`Postback ${res.status}: ${await res.text()}`);
	}
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`research-service listening on :${port}`);
