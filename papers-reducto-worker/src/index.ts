import {
  Worker,
  type CapabilityContext,
  type WebhookEvent,
} from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import Reducto from "reductoai";
import type { Client } from "@notionhq/client";

const PAPERS_DATA_SOURCE_ID = requiredEnv("PAPERS_DATA_SOURCE_ID");
const RESEARCH_DATA_SOURCE_ID = requiredEnv("RESEARCH_DATA_SOURCE_ID");

const PROPS = {
  title: "Title",
  pdf: "PDF",
  extractionStatus: "Extraction Status",
  markdownPage: "Markdown Page",
  processedAt: "Processed At",
  reductoJobId: "Reducto Job ID",
  authors: "Authors",
  publicationYear: "Publication Year",
  topics: "Topics",
  abstract: "Abstract",
  summary: "Summary",
  keyConcepts: "Key Concepts",
  claims: "Claims",
  methods: "Methods",
  datasets: "Datasets",
  limitations: "Limitations",
  openQuestions: "Open Questions",
  profileStatus: "Profile Status",
  url: "URL",
} as const;

const STATUS = {
  notStarted: "Not Started",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
} as const;

const RESEARCH_PROPS = {
  title: "Title",
  prompt: "Prompt",
  status: "Status",
  reviewRequested: "Review Requested",
  agentSummary: "Agent Summary",
  openQuestions: "Open Questions",
  nextSteps: "Next Steps",
  proposalPage: "Proposal Page",
  relatedPapers: "Related Papers",
  reviewedAt: "Reviewed At",
  reviewError: "Review Error",
} as const;

const RESEARCH_STATUS = {
  notStarted: "Not started",
  reviewing: "In progress",
  done: "Done",
} as const;

const MAX_BATCH_LIMIT = 10;
const MAX_MARKDOWN_CHARS_PER_WRITE = 70_000;
const RICH_TEXT_LIMIT = 1_900;
const MAX_LIBRARY_PAPERS = 100;
const SEARCH_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "and",
  "are",
  "also",
  "between",
  "but",
  "can",
  "could",
  "does",
  "did",
  "for",
  "from",
  "given",
  "had",
  "has",
  "have",
  "into",
  "more",
  "not",
  "our",
  "over",
  "paper",
  "papers",
  "research",
  "should",
  "than",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "those",
  "through",
  "toward",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
  "work",
  "would",
]);

const worker = new Worker();
(worker as Worker & { default?: Worker }).default = worker;
export default worker;

type NotionClient = Client;

type PageLike = {
  object?: string;
  id: string;
  url?: string;
  parent?: {
    type?: string;
    data_source_id?: string;
    database_id?: string;
    page_id?: string;
  };
  properties?: Record<string, unknown>;
};

type ProcessOptions = {
  force: boolean;
  dryRun: boolean;
  asyncPreferred: boolean;
};

type ProcessResult = {
  pageId: string;
  title: string;
  status: "queued" | "completed" | "skipped" | "failed";
  reason?: string;
  pdfUrl?: string;
  markdownUrl?: string;
  reductoJobId?: string;
  markdownPages?: number;
  chunks?: number;
};

type ParseArtifacts = {
  jobId: string;
  markdown: string;
  chunks: number;
  duration?: number;
  studioLink?: string;
};

type FullParseResult = {
  type: "full";
  chunks: Array<{ content?: string }>;
};

type PaperMetadata = {
  title: string | null;
  authors: string | null;
  publicationYear: number | null;
  topics: string[];
};

type PaperProfile = {
  abstract: string | null;
  summary: string | null;
  keyConcepts: string[];
  claims: string[];
  methods: string[];
  datasets: string[];
  limitations: string[];
  openQuestions: string[];
};

type PaperRecord = Omit<PaperMetadata, "title"> &
  PaperProfile & {
    id: string;
    title: string;
    notionUrl: string;
    markdownUrl: string | null;
    sourceUrl: string | null;
  };

type ScoredPaper = PaperRecord & {
  score: number;
  matchedTerms: string[];
};

type ResearchReviewResult = {
  pageId: string;
  title: string;
  status: "completed" | "skipped" | "failed";
  reason?: string;
  proposalUrl?: string;
  paperCount?: number;
};

type PdfPropertyKind = "url" | "files";

worker.webhook("paperChanged", {
  title: "Notion Library Changed",
  description:
    "Single Notion connection webhook target. Routes paper rows to PDF extraction and research idea rows to proposal review.",
  execute: async (events, context) => {
    for (const event of events) {
      await handlePaperWebhook(event, context);
    }
  },
});

worker.webhook("researchIdeaChanged", {
  title: "Research Idea Changed",
  description:
    "Optional direct webhook target for the Research Database. Use paperChanged for a single Notion connection webhook URL.",
  execute: async (events, context) => {
    for (const event of events) {
      await handleResearchIdeaWebhook(event, context);
    }
  },
});

worker.tool("processPendingPapers", {
  title: "Process Pending Papers",
  description:
    "Processes pending Papers database rows that have a PDF URL and are not yet extracted.",
  schema: j.object({
    limit: j
      .integer()
      .describe(`Maximum number of rows to process, capped at ${MAX_BATCH_LIMIT}.`),
    includeFailed: j
      .boolean()
      .describe("Also retry rows currently marked Failed."),
    dryRun: j
      .boolean()
      .describe("Return the rows that would be processed without calling Reducto."),
  }),
  execute: async ({ limit, includeFailed, dryRun }, context) => {
    const pages = await queryPendingPaperPages(
      context.notion,
      clampLimit(limit),
      includeFailed,
    );
    const results: ProcessResult[] = [];

    for (const page of pages) {
      results.push(
        await processPaperPage(context.notion, page, {
          force: false,
          dryRun,
          asyncPreferred: true,
        }),
      );
    }

    return {
      processed: results.filter((result) => result.status === "completed").length,
      queued: results.filter((result) => result.status === "queued").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "failed").length,
      results,
    };
  },
});

worker.tool("processPaperById", {
  title: "Process Paper By Page ID",
  description:
    "Processes one Papers database row by Notion page ID, optionally forcing a rerun.",
  schema: j.object({
    pageId: j.string().describe("The Notion page ID of the paper row to process."),
    force: j
      .boolean()
      .describe("Process even if the row is already Processing or Completed."),
    dryRun: j
      .boolean()
      .describe("Inspect the row without calling Reducto or writing to Notion."),
  }),
  execute: async ({ pageId, force, dryRun }, context) => {
    const page = (await context.notion.pages.retrieve({ page_id: pageId })) as PageLike;
    return processPaperPage(context.notion, page, {
      force,
      dryRun,
      asyncPreferred: true,
    });
  },
});

worker.tool("writeMarkdownFromReductoJob", {
  title: "Write Markdown From Reducto Job",
  description:
    "Uses an existing completed Reducto parse job to update one paper row without submitting a new Reducto job.",
  schema: j.object({
    pageId: j.string().describe("The Notion page ID of the paper row to update."),
    jobId: j.string().describe("The completed Reducto parse job ID to read."),
  }),
  execute: async ({ pageId, jobId }, context) => {
    const page = (await context.notion.pages.retrieve({ page_id: pageId })) as PageLike;
    const job = await new Reducto().job.get(jobId);

    if (job.status !== "Completed" || !job.result || !("result" in job.result)) {
      throw new Error(`Reducto job ${jobId} is ${job.status}, not a completed parse result`);
    }

    const title = getPageTitle(page) || "Untitled paper";
    const pdfUrl = getPdfUrlProperty(page, PROPS.pdf) ?? getUrlProperty(page, PROPS.url) ?? "";
    const parsed = await parseArtifactsFromResponse(job.result);
    return finishPaperExtraction(context.notion, page, title, pdfUrl, parsed);
  },
});

worker.tool("draftResearchProposal", {
  title: "Draft Research Proposal",
  description:
    "Finds relevant papers from the enriched Papers database and drafts a proposal-style research brief for a Notion Custom Agent.",
  schema: j.object({
    idea: j.string().describe("The research idea, hypothesis, or direction to evaluate."),
    maxPapers: j
      .integer()
      .describe("Maximum number of matching papers to cite. Use 5 unless the user asks for more."),
    parentPageId: j
      .string()
      .nullable()
      .describe("Optional Notion page ID where the brief should be created. Use null to only return markdown."),
  }),
  execute: async ({ idea, maxPapers, parentPageId }, context) => {
    const scoredPapers = await findRelevantPapers(
      context.notion,
      idea,
      clampResearchLimit(maxPapers),
    );
    const markdown = buildResearchProposalBrief(idea, scoredPapers);
    const createdPage = parentPageId
      ? await createResearchProposalPage(context.notion, parentPageId, idea, markdown)
      : null;

    return {
      idea,
      paperCount: scoredPapers.length,
      papers: scoredPapers.map((paper) => ({
        id: paper.id,
        title: paper.title,
        authors: paper.authors,
        publicationYear: paper.publicationYear,
        score: paper.score,
        matchedTerms: paper.matchedTerms,
        markdownUrl: paper.markdownUrl,
        notionUrl: paper.notionUrl,
      })),
      createdPageUrl: createdPage?.url ?? null,
      markdown,
    };
  },
});

worker.tool("reviewResearchIdeaById", {
  title: "Review Research Idea By Page ID",
  description:
    "Reviews one Research Database row, creates a proposal page, and updates the row with agent output.",
  schema: j.object({
    pageId: j.string().describe("The Notion page ID of the Research Database row."),
    force: j
      .boolean()
      .describe("Review even if Review Requested is not checked or the row is already Done."),
    dryRun: j
      .boolean()
      .describe("Return what would happen without creating pages or updating Notion."),
  }),
  execute: async ({ pageId, force, dryRun }, context) => {
    const page = (await context.notion.pages.retrieve({ page_id: pageId })) as PageLike;
    return reviewResearchIdeaPage(context.notion, page, { force, dryRun });
  },
});

worker.tool("processReadyResearchIdeas", {
  title: "Process Ready Research Ideas",
  description:
    "Processes Research Database rows where Review Requested is checked.",
  schema: j.object({
    limit: j
      .integer()
      .describe(`Maximum number of rows to process, capped at ${MAX_BATCH_LIMIT}.`),
    dryRun: j
      .boolean()
      .describe("Return the rows that would be reviewed without creating pages or updating Notion."),
  }),
  execute: async ({ limit, dryRun }, context) => {
    const pages = await queryReadyResearchIdeaPages(context.notion, clampLimit(limit));
    const results: ResearchReviewResult[] = [];

    for (const page of pages) {
      results.push(
        await reviewResearchIdeaPage(context.notion, page, {
          force: false,
          dryRun,
        }),
      );
    }

    return {
      completed: results.filter((result) => result.status === "completed").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "failed").length,
      results,
    };
  },
});

worker.webhook("reductoParseComplete", {
  title: "Reducto Parse Complete",
  description:
    "Receives Reducto async parse callbacks, retrieves the parse result, and writes markdown to Notion.",
  execute: async (events, context) => {
    for (const event of events) {
      await handleReductoWebhook(event, context);
    }
  },
});

async function handlePaperWebhook(
  event: WebhookEvent,
  context: CapabilityContext,
): Promise<void> {
  const verificationToken = findString(event.body, ["verification_token"]);
  if (verificationToken) {
    console.log(`Webhook verification token: ${verificationToken}`);
    return;
  }

  const pageId = findNotionPageId(event.body);
  if (pageId) {
    const page = (await context.notion.pages.retrieve({ page_id: pageId })) as PageLike;
    if (isResearchIdeaPage(page)) {
      const result = await reviewResearchIdeaPage(context.notion, page, {
        force: false,
        dryRun: false,
      });
      console.log(JSON.stringify(result));
      return;
    }

    const result = await processPaperPage(context.notion, page, {
      force: false,
      dryRun: false,
      asyncPreferred: true,
    });
    console.log(JSON.stringify(result));
    return;
  }

  const dataSourceId = findNotionDataSourceId(event.body);
  const pages = isResearchDataSourceId(dataSourceId)
    ? await queryReadyResearchIdeaPages(context.notion, 1)
    : await queryPendingPaperPages(context.notion, 1, false);

  if (pages.length === 0) {
    console.log("Notion webhook received, but no page ID or actionable row was found.");
    return;
  }

  for (const page of pages) {
    if (isResearchIdeaPage(page)) {
      const result = await reviewResearchIdeaPage(context.notion, page, {
        force: false,
        dryRun: false,
      });
      console.log(JSON.stringify(result));
      continue;
    }

    const result = await processPaperPage(context.notion, page, {
      force: false,
      dryRun: false,
      asyncPreferred: true,
    });
    console.log(JSON.stringify(result));
  }
}

async function handleResearchIdeaWebhook(
  event: WebhookEvent,
  context: CapabilityContext,
): Promise<void> {
  const verificationToken = findString(event.body, ["verification_token"]);
  if (verificationToken) {
    console.log(`Webhook verification token: ${verificationToken}`);
    return;
  }

  const pageId = findNotionPageId(event.body);
  const pages = pageId
    ? [((await context.notion.pages.retrieve({ page_id: pageId })) as PageLike)]
    : await queryReadyResearchIdeaPages(context.notion, 1);

  if (pages.length === 0) {
    console.log("Research webhook received, but no page ID or ready idea was found.");
    return;
  }

  for (const page of pages) {
    if (!isResearchIdeaPage(page)) {
      console.log(`Research webhook ignored non-research page ${page.id}.`);
      continue;
    }
    const result = await reviewResearchIdeaPage(context.notion, page, {
      force: false,
      dryRun: false,
    });
    console.log(JSON.stringify(result));
  }
}

async function processPaperPage(
  notion: NotionClient,
  page: PageLike,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const title = getPageTitle(page) || "Untitled paper";
  const pdfUrl = getPdfUrlProperty(page, PROPS.pdf);
  const status = getStatusProperty(page, PROPS.extractionStatus);

  if (!pdfUrl) {
    return skipped(page, title, "Missing PDF file or URL");
  }

  if (!options.force && status === STATUS.completed) {
    return skipped(page, title, "Already completed", pdfUrl);
  }

  if (!options.force && status === STATUS.processing) {
    return skipped(page, title, "Already processing", pdfUrl);
  }

  if (!options.force && status === STATUS.failed) {
    return skipped(page, title, "Currently failed; run with force or includeFailed", pdfUrl);
  }

  if (options.dryRun) {
    return {
      pageId: page.id,
      title,
      status: "skipped",
      reason: "Dry run",
      pdfUrl,
    };
  }

  await updatePaperProperties(notion, page.id, {
    [PROPS.extractionStatus]: statusProperty(STATUS.processing),
  });

  try {
    if (options.asyncPreferred && process.env.REDUCTO_WEBHOOK_URL) {
      const queued = await queueReductoParseJob(page, title, pdfUrl);
      await updatePaperProperties(notion, page.id, {
        [PROPS.reductoJobId]: richTextProperty(queued.jobId),
      });
      return {
        pageId: page.id,
        title,
        status: "queued",
        pdfUrl,
        reductoJobId: queued.jobId,
      };
    }

    const parsed = await parsePdfWithReducto(pdfUrl);
    return await finishPaperExtraction(notion, page, title, pdfUrl, parsed);
  } catch (error) {
    await markPaperFailed(notion, page.id);
    return {
      pageId: page.id,
      title,
      status: "failed",
      reason: errorMessage(error),
      pdfUrl,
    };
  }
}

async function handleReductoWebhook(
  event: WebhookEvent,
  context: CapabilityContext,
): Promise<void> {
  const body = event.body;
  const jobId = findString(body, ["job_id", "jobId", "id"]);

  if (!jobId) {
    console.log("Reducto webhook ignored: no job ID present.");
    return;
  }

  const pageId = findMetadataPageId(body);
  const page = pageId
    ? ((await context.notion.pages.retrieve({ page_id: pageId })) as PageLike)
    : await findPaperPageByReductoJobId(context.notion, jobId);

  if (!page) {
    console.log(`Reducto webhook ignored: no Notion paper found for job ${jobId}.`);
    return;
  }

  const job = await new Reducto().job.get(jobId);
  if (job.status !== "Completed") {
    if (job.status === "Failed") {
      await markPaperFailed(context.notion, page.id);
    }
    console.log(`Reducto job ${jobId} status is ${job.status}; no markdown written.`);
    return;
  }

  if (!job.result || !("result" in job.result)) {
    await markPaperFailed(context.notion, page.id);
    console.log(`Reducto job ${jobId} completed without a parse result.`);
    return;
  }

  const title = getPageTitle(page) || "Untitled paper";
  const pdfUrl = getPdfUrlProperty(page, PROPS.pdf) ?? "";
  const parsed = await parseArtifactsFromResponse(job.result);
  await finishPaperExtraction(context.notion, page, title, pdfUrl, parsed);
}

async function queueReductoParseJob(
  page: PageLike,
  title: string,
  pdfUrl: string,
): Promise<{ jobId: string }> {
  const webhookUrl = process.env.REDUCTO_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("REDUCTO_WEBHOOK_URL is not configured");
  }

  const submission = await new Reducto().parse.runJob({
    input: pdfUrl,
    async: {
      metadata: {
        notionPageId: page.id,
        title,
      },
      webhook: {
        mode: "direct",
        url: webhookUrl,
      },
    },
      ...reductoParseOptions(),
  });

  return { jobId: submission.job_id };
}

async function parsePdfWithReducto(pdfUrl: string): Promise<ParseArtifacts> {
  const response = await new Reducto().parse.run({
    input: pdfUrl,
    ...reductoParseOptions(),
  });

  return parseArtifactsFromResponse(response);
}

function reductoParseOptions() {
  return {
    formatting: {
      add_page_markers: true,
      merge_tables: true,
      table_output_format: "md" as const,
    },
    retrieval: {
      chunking: {
        chunk_mode: "section" as const,
      },
    },
    enhance: {
      intelligent_ordering: true,
      summarize_figures: true,
    },
    settings: {
      extraction_mode: "hybrid" as const,
      timeout: 300,
    },
  };
}

async function parseArtifactsFromResponse(response: unknown): Promise<ParseArtifacts> {
  if (!isRecord(response)) {
    throw new Error("Reducto returned an invalid parse response");
  }

  if (!("result" in response)) {
    const asyncJobId = asString(response.job_id);
    throw new Error(
      asyncJobId
        ? `Reducto returned async job ${asyncJobId} without a parse result`
        : "Reducto did not return a parse result",
    );
  }

  const result = response.result;
  const fullResult = await materializeFullResult(result);
  const markdown = fullResult.chunks
    .map((chunk) => chunk.content?.trim())
    .filter((content): content is string => Boolean(content))
    .join("\n\n");

  if (!markdown.trim()) {
    throw new Error("Reducto returned no markdown content");
  }

  return {
    jobId: asString(response.job_id) ?? "",
    markdown,
    chunks: fullResult.chunks.length,
    duration: asNumber(response.duration),
    studioLink: asString(response.studio_link),
  };
}

async function materializeFullResult(result: unknown): Promise<FullParseResult> {
  if (isFullResult(result)) {
    return result;
  }

  if (isRecord(result) && result.type === "url" && typeof result.url === "string") {
    const response = await fetch(result.url);
    if (!response.ok) {
      throw new Error(`Could not download Reducto URL result: ${response.status}`);
    }

    const json = (await response.json()) as unknown;
    if (isFullResult(json)) {
      return json;
    }
    if (isRecord(json) && isFullResult(json.result)) {
      return json.result;
    }
  }

  throw new Error("Reducto response did not contain full parse chunks");
}

async function finishPaperExtraction(
  notion: NotionClient,
  page: PageLike,
  fallbackTitle: string,
  pdfUrl: string,
  parsed: ParseArtifacts,
): Promise<ProcessResult> {
  const existingTitle = getPageTitle(page);
  const metadata = inferPaperMetadata(page, parsed.markdown, fallbackTitle);
  const title = existingTitle ?? metadata.title ?? fallbackTitle;
  const markdown = buildPaperMarkdown(page, title, pdfUrl, parsed);
  const write = await writeMarkdownPage(
    notion,
    page.id,
    title,
    markdown,
    getUrlProperty(page, PROPS.markdownPage),
  );

  const properties: Record<string, unknown> = {
    [PROPS.extractionStatus]: statusProperty(STATUS.completed),
    [PROPS.markdownPage]: urlProperty(write.url),
    [PROPS.processedAt]: dateProperty(new Date()),
    [PROPS.reductoJobId]: richTextProperty(parsed.jobId),
  };

  if (!existingTitle && title !== "Untitled paper") {
    properties[PROPS.title] = titleProperty(title);
  }

  if (!getRichTextProperty(page, PROPS.authors) && metadata.authors) {
    properties[PROPS.authors] = richTextProperty(metadata.authors);
  }

  if (!getNumberProperty(page, PROPS.publicationYear) && metadata.publicationYear) {
    properties[PROPS.publicationYear] = numberProperty(metadata.publicationYear);
  }

  if (getMultiSelectProperty(page, PROPS.topics).length === 0 && metadata.topics.length > 0) {
    properties[PROPS.topics] = multiSelectProperty(metadata.topics);
  }

  if (!getUrlProperty(page, PROPS.url) && isStableExternalUrl(pdfUrl)) {
    properties[PROPS.url] = urlProperty(pdfUrl);
  }

  await addProfileProperties(properties, page, parsed);
  await updatePaperProperties(notion, page.id, properties);

  return {
    pageId: page.id,
    title,
    status: "completed",
    pdfUrl,
    markdownUrl: write.url,
    reductoJobId: parsed.jobId,
    markdownPages: write.pageCount,
    chunks: parsed.chunks,
  };
}

async function writeMarkdownPage(
  notion: NotionClient,
  parentPageId: string,
  paperTitle: string,
  markdown: string,
  existingMarkdownUrl: string | null,
): Promise<{ url: string; pageCount: number }> {
  const chunks = splitMarkdown(markdown, MAX_MARKDOWN_CHARS_PER_WRITE);
  const existingPageId = pageIdFromNotionUrl(existingMarkdownUrl);

  if (existingPageId) {
    await notion.pages.update({
      page_id: existingPageId,
      properties: {
        title: titleProperty(`${paperTitle} - Markdown`),
      } as NonNullable<Parameters<NotionClient["pages"]["update"]>[0]["properties"]>,
    });
    await notion.pages.updateMarkdown({
      page_id: existingPageId,
      type: "replace_content",
      replace_content: {
        new_str: chunks[0],
        allow_deleting_content: true,
      },
    });

    for (const chunk of chunks.slice(1)) {
      await notion.pages.updateMarkdown({
        page_id: existingPageId,
        type: "insert_content",
        insert_content: {
          content: `\n\n${chunk}`,
        },
      });
    }

    return { url: notionUrlFromPageId(existingPageId), pageCount: 1 };
  }

  const page = (await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: {
      title: titleProperty(`${paperTitle} - Markdown`),
    },
    markdown: chunks[0],
  })) as PageLike;

  for (const chunk of chunks.slice(1)) {
    await notion.pages.updateMarkdown({
      page_id: page.id,
      type: "insert_content",
      insert_content: {
        content: `\n\n${chunk}`,
      },
    });
  }

  return { url: page.url ?? notionUrlFromPageId(page.id), pageCount: 1 };
}

async function addProfileProperties(
  properties: Record<string, unknown>,
  page: PageLike,
  parsed: ParseArtifacts,
): Promise<void> {
  if (!parsed.jobId) {
    properties[PROPS.profileStatus] = statusProperty(STATUS.notStarted);
    return;
  }

  try {
    const profile = await extractPaperProfile(parsed.jobId);

    if (!getRichTextProperty(page, PROPS.abstract) && profile.abstract) {
      properties[PROPS.abstract] = richTextProperty(profile.abstract);
    }
    if (!getRichTextProperty(page, PROPS.summary) && profile.summary) {
      properties[PROPS.summary] = richTextProperty(profile.summary);
    }
    if (
      getMultiSelectProperty(page, PROPS.keyConcepts).length === 0 &&
      profile.keyConcepts.length > 0
    ) {
      properties[PROPS.keyConcepts] = multiSelectProperty(profile.keyConcepts.slice(0, 10));
    }
    if (!getRichTextProperty(page, PROPS.claims) && profile.claims.length > 0) {
      properties[PROPS.claims] = richTextProperty(formatBullets(profile.claims));
    }
    if (!getRichTextProperty(page, PROPS.methods) && profile.methods.length > 0) {
      properties[PROPS.methods] = richTextProperty(formatBullets(profile.methods));
    }
    if (!getRichTextProperty(page, PROPS.datasets) && profile.datasets.length > 0) {
      properties[PROPS.datasets] = richTextProperty(formatBullets(profile.datasets));
    }
    if (!getRichTextProperty(page, PROPS.limitations) && profile.limitations.length > 0) {
      properties[PROPS.limitations] = richTextProperty(formatBullets(profile.limitations));
    }
    if (!getRichTextProperty(page, PROPS.openQuestions) && profile.openQuestions.length > 0) {
      properties[PROPS.openQuestions] = richTextProperty(formatBullets(profile.openQuestions));
    }

    properties[PROPS.profileStatus] = statusProperty(STATUS.completed);
  } catch (error) {
    console.log(`Profile extraction failed: ${errorMessage(error)}`);
    properties[PROPS.profileStatus] = statusProperty(STATUS.failed);
  }
}

async function extractPaperProfile(parseJobId: string): Promise<PaperProfile> {
  const response = await new Reducto().extract.run({
    input: `jobid://${parseJobId}`,
    instructions: {
      schema: paperProfileSchema(),
      system_prompt: [
        "You extract structured research-paper profiles for a Notion research library.",
        "Be concise and factual. Prefer information explicitly stated in the paper.",
        "For claims, methods, datasets, limitations, and open questions, return short bullet-ready strings.",
        "If a field is not stated, return null for strings or an empty array for lists.",
      ].join(" "),
    },
    settings: {
      citations: { enabled: false },
      optimize_for_latency: true,
    },
  });

  if ("job_id" in response && !("result" in response)) {
    throw new Error(`Reducto extract returned async job ${response.job_id}`);
  }

  return normalizePaperProfile((response as { result?: unknown }).result);
}

function paperProfileSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      abstract: {
        type: ["string", "null"],
        description: "The paper abstract, condensed only if needed.",
      },
      summary: {
        type: ["string", "null"],
        description: "A concise 4-6 sentence summary of the paper and its contribution.",
      },
      key_concepts: {
        type: "array",
        items: { type: "string" },
        description: "Important technical concepts, methods, tasks, and domains.",
      },
      claims: {
        type: "array",
        items: { type: "string" },
        description: "Main claims or findings made by the paper.",
      },
      methods: {
        type: "array",
        items: { type: "string" },
        description: "Methods, models, algorithms, experimental designs, or implementation techniques.",
      },
      datasets: {
        type: "array",
        items: { type: "string" },
        description: "Datasets, benchmarks, tasks, or evaluation suites used or introduced.",
      },
      limitations: {
        type: "array",
        items: { type: "string" },
        description: "Limitations, caveats, weaknesses, or threats to validity.",
      },
      open_questions: {
        type: "array",
        items: { type: "string" },
        description: "Future work or unresolved research questions implied by the paper.",
      },
    },
    required: [
      "abstract",
      "summary",
      "key_concepts",
      "claims",
      "methods",
      "datasets",
      "limitations",
      "open_questions",
    ],
  };
}

function normalizePaperProfile(result: unknown): PaperProfile {
  const raw = Array.isArray(result) ? result[0] : result;
  const profile = isRecord(raw) ? raw : {};

  return {
    abstract: nullableString(profile.abstract),
    summary: nullableString(profile.summary),
    keyConcepts: stringArray(profile.key_concepts),
    claims: stringArray(profile.claims),
    methods: stringArray(profile.methods),
    datasets: stringArray(profile.datasets),
    limitations: stringArray(profile.limitations),
    openQuestions: stringArray(profile.open_questions),
  };
}

function formatBullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

async function queryPendingPaperPages(
  notion: NotionClient,
  limit: number,
  includeFailed: boolean,
): Promise<PageLike[]> {
  const statuses = includeFailed
    ? [STATUS.notStarted, STATUS.failed]
    : [STATUS.notStarted];
  const pages: PageLike[] = [];
  const pdfPropertyKind = await getPdfPropertyKind(notion);
  let cursor: string | undefined;

  while (pages.length < limit) {
    const response = await notion.dataSources.query({
      data_source_id: PAPERS_DATA_SOURCE_ID,
      page_size: Math.min(100, limit - pages.length),
      start_cursor: cursor,
      result_type: "page",
      filter: {
        and: [
          {
            ...pdfNotEmptyFilter(pdfPropertyKind),
          },
          {
            or: [
              ...statuses.map((status) => ({
                property: PROPS.extractionStatus,
                status: { equals: status },
              })),
              {
                property: PROPS.extractionStatus,
                status: { is_empty: true },
              },
            ],
          },
        ],
      } as NonNullable<Parameters<NotionClient["dataSources"]["query"]>[0]["filter"]>,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
    });

    pages.push(...response.results.filter(isPageLike));

    if (!response.has_more || !response.next_cursor) {
      break;
    }
    cursor = response.next_cursor;
  }

  return pages;
}

async function findPaperPageByReductoJobId(
  notion: NotionClient,
  jobId: string,
): Promise<PageLike | null> {
  const response = await notion.dataSources.query({
    data_source_id: PAPERS_DATA_SOURCE_ID,
    page_size: 1,
    result_type: "page",
    filter: {
      property: PROPS.reductoJobId,
      rich_text: { equals: jobId },
    },
  });

  return response.results.find(isPageLike) ?? null;
}

async function queryReadyResearchIdeaPages(
  notion: NotionClient,
  limit: number,
): Promise<PageLike[]> {
  const response = await notion.dataSources.query({
    data_source_id: RESEARCH_DATA_SOURCE_ID,
    page_size: limit,
    result_type: "page",
    filter: {
      property: RESEARCH_PROPS.reviewRequested,
      checkbox: { equals: true },
    } as NonNullable<Parameters<NotionClient["dataSources"]["query"]>[0]["filter"]>,
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
  });

  return response.results.filter(isPageLike);
}

async function reviewResearchIdeaPage(
  notion: NotionClient,
  page: PageLike,
  options: { force: boolean; dryRun: boolean },
): Promise<ResearchReviewResult> {
  const title = getPageTitle(page) ?? "Untitled research idea";
  const prompt = getRichTextProperty(page, RESEARCH_PROPS.prompt);
  const status = getStatusProperty(page, RESEARCH_PROPS.status);
  const requested = getCheckboxProperty(page, RESEARCH_PROPS.reviewRequested);
  const idea = buildResearchIdeaText(title, prompt);

  if (!isResearchIdeaPage(page)) {
    return {
      pageId: page.id,
      title,
      status: "skipped",
      reason: "Not a Research Database row",
    };
  }

  if (!options.force && !requested) {
    return {
      pageId: page.id,
      title,
      status: "skipped",
      reason: "Review Requested is not checked",
    };
  }

  if (!options.force && status === RESEARCH_STATUS.done && !requested) {
    return {
      pageId: page.id,
      title,
      status: "skipped",
      reason: "Already done",
    };
  }

  if (options.dryRun) {
    const papers = await findRelevantPapers(notion, idea, 5);
    return {
      pageId: page.id,
      title,
      status: "skipped",
      reason: "Dry run",
      paperCount: papers.length,
    };
  }

  await updatePaperProperties(notion, page.id, {
    [RESEARCH_PROPS.status]: statusProperty(RESEARCH_STATUS.reviewing),
    [RESEARCH_PROPS.reviewRequested]: checkboxProperty(false),
    [RESEARCH_PROPS.reviewError]: emptyRichTextProperty(),
  });

  try {
    const papers = await findRelevantPapers(notion, idea, 5);
    const markdown = buildResearchProposalBrief(idea, papers);
    const proposalPage = await writeResearchProposalPage(
      notion,
      page.id,
      title,
      markdown,
      getUrlProperty(page, RESEARCH_PROPS.proposalPage),
    );
    const summary = buildResearchIdeaSummary(idea, papers);
    const openQuestions = buildResearchOpenQuestions(papers);
    const nextSteps = buildResearchNextSteps(papers);
    const proposalUrl = proposalPage.url ?? notionUrlFromPageId(proposalPage.id);
    const topPaperUrl = papers[0]?.markdownUrl ?? papers[0]?.notionUrl ?? null;

    await updatePaperProperties(notion, page.id, {
      [RESEARCH_PROPS.status]: statusProperty(RESEARCH_STATUS.done),
      [RESEARCH_PROPS.agentSummary]: richTextProperty(summary),
      [RESEARCH_PROPS.openQuestions]: richTextProperty(openQuestions),
      [RESEARCH_PROPS.nextSteps]: richTextProperty(nextSteps),
      [RESEARCH_PROPS.proposalPage]: urlProperty(proposalUrl),
      ...(topPaperUrl ? { [RESEARCH_PROPS.relatedPapers]: urlProperty(topPaperUrl) } : {}),
      [RESEARCH_PROPS.reviewedAt]: dateProperty(new Date()),
    });

    return {
      pageId: page.id,
      title,
      status: "completed",
      proposalUrl,
      paperCount: papers.length,
    };
  } catch (error) {
    await updatePaperProperties(notion, page.id, {
      [RESEARCH_PROPS.status]: statusProperty(RESEARCH_STATUS.notStarted),
      [RESEARCH_PROPS.reviewError]: richTextProperty(errorMessage(error)),
      [RESEARCH_PROPS.reviewedAt]: dateProperty(new Date()),
    });

    return {
      pageId: page.id,
      title,
      status: "failed",
      reason: errorMessage(error),
    };
  }
}

function buildResearchIdeaText(title: string, prompt: string | null): string {
  return prompt && normalizeSearchText(prompt) !== normalizeSearchText(title)
    ? `${title}\n\nUser notes: ${prompt}`
    : title;
}

function buildResearchIdeaSummary(idea: string, papers: ScoredPaper[]): string {
  if (papers.length === 0) {
    return `No enriched papers matched this idea yet: ${truncatePlainText(idea, 260)}`;
  }

  const concepts = collectTopConcepts(papers, 4);
  const paperTitles = papers
    .slice(0, 3)
    .map((paper) => paper.title)
    .join("; ");
  const conceptText = concepts.length > 0 ? ` Main concepts: ${concepts.join(", ")}.` : "";
  return `Reviewed ${papers.length} enriched papers. Strongest matches: ${paperTitles}.${conceptText}`;
}

function buildResearchOpenQuestions(papers: ScoredPaper[]): string {
  const gaps = uniqueStrings(
    papers.flatMap((paper) => [...paper.limitations, ...paper.openQuestions]),
  ).slice(0, 5);
  return gaps.length > 0
    ? formatBullets(gaps)
    : "- Add more papers or notes to surface sharper open questions.";
}

function buildResearchNextSteps(papers: ScoredPaper[]): string {
  const topPaper = papers[0];
  const steps = [
    topPaper
      ? `Read the proposal page and verify the claims against ${topPaper.title}.`
      : "Add and extract at least one relevant paper.",
    "Turn the most concrete gap into a testable research hypothesis.",
    "Add follow-up papers that directly support or contradict that hypothesis.",
  ];
  return formatBullets(steps);
}

async function findRelevantPapers(
  notion: NotionClient,
  idea: string,
  limit: number,
): Promise<ScoredPaper[]> {
  const papers = await queryCompletedPaperRecords(notion, MAX_LIBRARY_PAPERS);
  const query = buildResearchQuery(idea);
  const scored = papers
    .map((paper) => scorePaperForIdea(paper, query))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return (b.publicationYear ?? 0) - (a.publicationYear ?? 0);
    });
  const matched = scored.filter((paper) => paper.score > 0);
  return (matched.length > 0 ? matched : scored).slice(0, limit);
}

async function queryCompletedPaperRecords(
  notion: NotionClient,
  limit: number,
): Promise<PaperRecord[]> {
  const pages: PageLike[] = [];
  let cursor: string | undefined;

  while (pages.length < limit) {
    const response = await notion.dataSources.query({
      data_source_id: PAPERS_DATA_SOURCE_ID,
      page_size: Math.min(100, limit - pages.length),
      start_cursor: cursor,
      result_type: "page",
      filter: {
        and: [
          {
            property: PROPS.extractionStatus,
            status: { equals: STATUS.completed },
          },
          {
            property: PROPS.profileStatus,
            status: { equals: STATUS.completed },
          },
          {
            property: PROPS.markdownPage,
            url: { is_not_empty: true },
          },
        ],
      } as NonNullable<Parameters<NotionClient["dataSources"]["query"]>[0]["filter"]>,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });

    pages.push(...response.results.filter(isPageLike));

    if (!response.has_more || !response.next_cursor) {
      break;
    }
    cursor = response.next_cursor;
  }

  return pages.map(paperRecordFromPage);
}

function paperRecordFromPage(page: PageLike): PaperRecord {
  return {
    id: page.id,
    title: getPageTitle(page) ?? "Untitled paper",
    authors: getRichTextProperty(page, PROPS.authors),
    publicationYear: getNumberProperty(page, PROPS.publicationYear),
    topics: getMultiSelectProperty(page, PROPS.topics),
    abstract: getRichTextProperty(page, PROPS.abstract),
    summary: getRichTextProperty(page, PROPS.summary),
    keyConcepts: getMultiSelectProperty(page, PROPS.keyConcepts),
    claims: parseBulletText(getRichTextProperty(page, PROPS.claims)),
    methods: parseBulletText(getRichTextProperty(page, PROPS.methods)),
    datasets: parseBulletText(getRichTextProperty(page, PROPS.datasets)),
    limitations: parseBulletText(getRichTextProperty(page, PROPS.limitations)),
    openQuestions: parseBulletText(getRichTextProperty(page, PROPS.openQuestions)),
    markdownUrl: getUrlProperty(page, PROPS.markdownPage),
    sourceUrl: getUrlProperty(page, PROPS.url),
    notionUrl: page.url ?? notionUrlFromPageId(page.id),
  };
}

function buildResearchQuery(idea: string): { terms: string[]; phrases: string[] } {
  const terms = uniqueStrings(tokenizeSearchText(idea));
  const phrases = new Set<string>();

  for (let index = 0; index < terms.length - 1; index += 1) {
    phrases.add(`${terms[index]} ${terms[index + 1]}`);
  }
  for (let index = 0; index < terms.length - 2; index += 1) {
    phrases.add(`${terms[index]} ${terms[index + 1]} ${terms[index + 2]}`);
  }

  return {
    terms,
    phrases: Array.from(phrases).filter((phrase) => phrase.length >= 8),
  };
}

function scorePaperForIdea(
  paper: PaperRecord,
  query: { terms: string[]; phrases: string[] },
): ScoredPaper {
  const matchedTerms = new Set<string>();
  let score = 0;
  const buckets = [
    {
      text: paper.title,
      weight: 10,
    },
    {
      text: [...paper.topics, ...paper.keyConcepts].join(" "),
      weight: 7,
    },
    {
      text: [paper.abstract, paper.summary].filter(Boolean).join(" "),
      weight: 5,
    },
    {
      text: [...paper.claims, ...paper.methods, ...paper.openQuestions].join(" "),
      weight: 4,
    },
    {
      text: [...paper.datasets, ...paper.limitations, paper.authors].filter(Boolean).join(" "),
      weight: 2,
    },
  ];

  for (const bucket of buckets) {
    const normalized = normalizeSearchText(bucket.text);
    const tokens = new Set(tokenizeSearchText(bucket.text));

    for (const term of query.terms) {
      if (tokens.has(term)) {
        score += bucket.weight;
        matchedTerms.add(term);
      }
    }

    for (const phrase of query.phrases) {
      if (normalized.includes(phrase)) {
        score += bucket.weight * 2;
        matchedTerms.add(phrase);
      }
    }
  }

  return {
    ...paper,
    score,
    matchedTerms: Array.from(matchedTerms).slice(0, 12),
  };
}

function buildResearchProposalBrief(idea: string, papers: ScoredPaper[]): string {
  const generatedAt = new Date().toISOString().slice(0, 10);

  if (papers.length === 0) {
    return [
      `# Research Proposal Brief: ${idea}`,
      "",
      `Generated: ${generatedAt}`,
      "",
      "No completed papers were found in the Papers database yet. Add PDFs and let the extraction worker finish before using this tool for a grounded proposal.",
    ].join("\n");
  }

  const directMatches = papers.some((paper) => paper.score > 0);
  const concepts = collectTopConcepts(papers, 6);
  const claims = uniqueStrings(papers.flatMap((paper) => paper.claims)).slice(0, 6);
  const methods = uniqueStrings(
    papers.flatMap((paper) => [...paper.methods, ...paper.datasets]),
  ).slice(0, 8);
  const gaps = uniqueStrings(
    papers.flatMap((paper) => [...paper.limitations, ...paper.openQuestions]),
  ).slice(0, 6);

  return [
    `# Research Proposal Brief: ${idea}`,
    "",
    `Generated: ${generatedAt}`,
    "",
    directMatches
      ? `The strongest library matches point toward ${formatInlineList(concepts)}.`
      : "No strong keyword match was found; the papers below are recent completed papers to use as a starting point.",
    "",
    "## Relevant Papers",
    ...papers.map(formatScoredPaper),
    "",
    "## What The Library Already Covers",
    formatBulletSection(claims, "No paper-level claims have been extracted yet."),
    "",
    "## Useful Methods And Benchmarks",
    formatBulletSection(methods, "No methods or benchmarks have been extracted yet."),
    "",
    "## Gaps To Target",
    formatBulletSection(gaps, "No explicit limitations or open questions have been extracted yet."),
    "",
    "## Suggested Direction",
    ...suggestResearchDirections(idea, concepts, gaps, methods),
    "",
    "## First Work Plan",
    "1. Read the markdown pages for the highest-scoring papers and confirm whether the extracted claims match the paper text.",
    "2. Build a comparison table across the relevant methods, benchmarks, and limitations above.",
    "3. Turn the best gap into a concrete hypothesis with one evaluation plan and one failure condition.",
    "4. Add any missing reference papers, then rerun this tool so the proposal reflects the expanded library.",
    "",
    "## References",
    ...papers.map(formatReference),
  ].join("\n");
}

async function createResearchProposalPage(
  notion: NotionClient,
  parentPageId: string,
  idea: string,
  markdown: string,
): Promise<PageLike> {
  return writeResearchProposalPage(notion, parentPageId, idea, markdown, null);
}

async function writeResearchProposalPage(
  notion: NotionClient,
  parentPageId: string,
  idea: string,
  markdown: string,
  existingProposalUrl: string | null,
): Promise<PageLike> {
  const chunks = splitMarkdown(markdown, MAX_MARKDOWN_CHARS_PER_WRITE);
  const existingPageId = pageIdFromNotionUrl(existingProposalUrl);
  const title = `Research Proposal - ${truncatePlainText(idea, 80)}`;

  if (existingPageId) {
    const page = (await notion.pages.update({
      page_id: existingPageId,
      properties: {
        title: titleProperty(title),
      } as NonNullable<Parameters<NotionClient["pages"]["update"]>[0]["properties"]>,
    })) as PageLike;

    await notion.pages.updateMarkdown({
      page_id: existingPageId,
      type: "replace_content",
      replace_content: {
        new_str: chunks[0],
        allow_deleting_content: true,
      },
    });

    for (const chunk of chunks.slice(1)) {
      await notion.pages.updateMarkdown({
        page_id: existingPageId,
        type: "insert_content",
        insert_content: {
          content: `\n\n${chunk}`,
        },
      });
    }

    return {
      ...page,
      id: existingPageId,
      url: page.url ?? notionUrlFromPageId(existingPageId),
    };
  }

  const page = (await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: {
      title: titleProperty(title),
    },
    markdown: chunks[0],
  })) as PageLike;

  for (const chunk of chunks.slice(1)) {
    await notion.pages.updateMarkdown({
      page_id: page.id,
      type: "insert_content",
      insert_content: {
        content: `\n\n${chunk}`,
      },
    });
  }

  return page;
}

function formatScoredPaper(paper: ScoredPaper, index: number): string {
  const title = paper.markdownUrl
    ? `[${paper.title}](${paper.markdownUrl})`
    : `[${paper.title}](${paper.notionUrl})`;
  const authors = paper.authors ? `, ${paper.authors}` : "";
  const year = paper.publicationYear ? ` (${paper.publicationYear})` : "";
  const matched = paper.matchedTerms.length
    ? `Matched terms: ${paper.matchedTerms.join(", ")}.`
    : "No direct keyword match.";
  const summary = paper.summary ?? paper.abstract ?? "No summary extracted yet.";
  const gap = firstOf([...paper.limitations, ...paper.openQuestions]);

  return [
    "",
    `### ${index + 1}. ${title}${year}`,
    authors ? `Authors: ${authors.slice(2)}` : null,
    `Relevance score: ${paper.score}. ${matched}`,
    `Why it matters: ${summary}`,
    gap ? `Gap signal: ${gap}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function formatReference(paper: ScoredPaper): string {
  const title = paper.markdownUrl
    ? `[${paper.title}](${paper.markdownUrl})`
    : `[${paper.title}](${paper.notionUrl})`;
  const authors = paper.authors ? `${paper.authors}. ` : "";
  const year = paper.publicationYear ? `${paper.publicationYear}. ` : "";
  return `- ${authors}${year}${title}`;
}

function suggestResearchDirections(
  idea: string,
  concepts: string[],
  gaps: string[],
  methods: string[],
): string[] {
  const lines = [
    `- Frame the proposal around the user idea: ${idea}`,
    concepts.length > 0
      ? `- Anchor the direction in ${formatInlineList(concepts.slice(0, 4))}; these are the concepts most represented in the matched papers.`
      : null,
    gaps.length > 0
      ? `- Treat the main research opening as: ${gaps[0]}`
      : "- Treat the main research opening as a comparison between the proposed idea and the limitations in the matched papers.",
    methods.length > 0
      ? `- Start with methods or benchmarks already present in the library: ${formatInlineList(methods.slice(0, 4))}.`
      : null,
  ];

  return lines.filter((line): line is string => line !== null);
}

function collectTopConcepts(papers: ScoredPaper[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const paper of papers) {
    for (const concept of [...paper.keyConcepts, ...paper.topics]) {
      const key = concept.trim();
      if (!key) {
        continue;
      }
      counts.set(key, (counts.get(key) ?? 0) + Math.max(1, paper.score));
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([concept]) => concept);
}

function formatBulletSection(items: string[], emptyMessage: string): string {
  if (items.length === 0) {
    return `- ${emptyMessage}`;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

function formatInlineList(items: string[]): string {
  if (items.length === 0) {
    return "the matched papers";
  }
  if (items.length === 1) {
    return items[0];
  }
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function parseBulletText(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !SEARCH_STOP_WORDS.has(term));
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    const key = normalizeSearchText(trimmed);
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function firstOf(values: string[]): string | null {
  return values.find((value) => value.trim()) ?? null;
}

async function getPdfPropertyKind(notion: NotionClient): Promise<PdfPropertyKind> {
  const dataSource = (await notion.dataSources.retrieve({
    data_source_id: PAPERS_DATA_SOURCE_ID,
  })) as { properties?: Record<string, { type?: unknown }> };
  const type = dataSource.properties?.[PROPS.pdf]?.type;

  if (type === "files" || type === "url") {
    return type;
  }

  throw new Error(`PDF property must be URL or Files & media, got ${String(type)}`);
}

function pdfNotEmptyFilter(kind: PdfPropertyKind) {
  if (kind === "files") {
    return {
      property: PROPS.pdf,
      files: { is_not_empty: true },
    };
  }

  return {
    property: PROPS.pdf,
    url: { is_not_empty: true },
  };
}

async function updatePaperProperties(
  notion: NotionClient,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: properties as NonNullable<
      Parameters<NotionClient["pages"]["update"]>[0]["properties"]
    >,
  });
}

async function markPaperFailed(notion: NotionClient, pageId: string): Promise<void> {
  await updatePaperProperties(notion, pageId, {
    [PROPS.extractionStatus]: statusProperty(STATUS.failed),
    [PROPS.processedAt]: dateProperty(new Date()),
  });
}

function buildPaperMarkdown(
  page: PageLike,
  title: string,
  pdfUrl: string,
  parsed: ParseArtifacts,
): string {
  const authors = getRichTextProperty(page, PROPS.authors);
  const publicationYear = getNumberProperty(page, PROPS.publicationYear);
  const sourceUrl = getUrlProperty(page, PROPS.url);
  const pdfDescription = isStableExternalUrl(pdfUrl) ? pdfUrl : "Uploaded to Notion";
  const metadata = [
    `# ${title}`,
    "",
    authors ? `**Authors:** ${authors}` : null,
    publicationYear ? `**Published:** ${publicationYear}` : null,
    sourceUrl ? `**Source URL:** ${sourceUrl}` : null,
    `**PDF:** ${pdfDescription}`,
    parsed.jobId ? `**Reducto job:** ${parsed.jobId}` : null,
    parsed.studioLink ? `**Reducto Studio:** ${parsed.studioLink}` : null,
    parsed.duration ? `**Extraction duration:** ${parsed.duration}s` : null,
    "",
    "---",
    "",
  ].filter((line): line is string => line !== null);

  return `${metadata.join("\n")}${parsed.markdown}`;
}

function inferPaperMetadata(
  page: PageLike,
  markdown: string,
  fallbackTitle: string,
): PaperMetadata {
  const existingTitle = getPageTitle(page);
  const title = inferPaperTitle(existingTitle, markdown) ?? fallbackTitle;
  const text = cleanMarkdownForMetadata(markdown);

  return {
    title: title === "Untitled paper" ? null : title,
    authors: inferAuthors(text, title),
    publicationYear: inferPublicationYear(text, getUrlProperty(page, PROPS.url)),
    topics: inferTopics(`${title}\n${text.slice(0, 20_000)}`),
  };
}

function inferPaperTitle(existingTitle: string | null, markdown: string): string | null {
  if (existingTitle) {
    return existingTitle;
  }

  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (!heading) {
      continue;
    }

    const candidate = collectTitleCandidate(heading[1], lines[index + 1]);
    if (isUsableInferredTitle(candidate)) {
      return candidate;
    }
  }

  const firstText = lines.find((line) => isUsableInferredTitle(cleanTitleLine(line)));
  return firstText ? cleanTitleLine(firstText) : null;
}

function collectTitleCandidate(firstLine: string, nextLine: string | undefined): string {
  const first = cleanTitleLine(firstLine);
  const next = nextLine ? cleanTitleLine(nextLine) : "";

  if (
    next &&
    !next.startsWith("#") &&
    !next.startsWith("**") &&
    !/^(abstract|introduction|references|keywords)\b/i.test(next) &&
    first.length + next.length < 180
  ) {
    return `${first} ${next}`.trim();
  }

  return first;
}

function cleanTitleLine(line: string): string {
  return line
    .replace(/\[\[START OF PAGE \d+\]\]/gi, "")
    .replace(/\[\[END OF PAGE \d+\]\]/gi, "")
    .replace(/\(cont\.\)$/i, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsableInferredTitle(title: string): boolean {
  if (title.length < 8 || title.length > 220) {
    return false;
  }

  return !/^(abstract|introduction|references|contents|keywords)$/i.test(title);
}

function cleanMarkdownForMetadata(markdown: string): string {
  return markdown
    .replace(/\[\[(?:START|END) OF PAGE \d+\]\]/gi, "\n")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\r/g, "");
}

function inferAuthors(markdownText: string, title: string): string | null {
  const lines = markdownText
    .split("\n")
    .map((line) => cleanTitleLine(line.replace(/^#{1,6}\s+/, "")))
    .filter(Boolean);
  const abstractIndex = lines.findIndex((line) => /^abstract\b/i.test(line));
  const frontMatter = lines.slice(0, abstractIndex > 0 ? abstractIndex : 35);
  const normalizedTitle = normalizeForComparison(title);

  for (const line of frontMatter) {
    const explicit = line.match(/^authors?\s*[:\-]\s*(.+)$/i);
    if (explicit && isUsableAuthorLine(explicit[1])) {
      return truncateForRichText(explicit[1]);
    }
  }

  for (const line of frontMatter) {
    if (
      normalizeForComparison(line) === normalizedTitle ||
      normalizeForComparison(line).startsWith(normalizedTitle.slice(0, 50)) ||
      normalizedTitle.startsWith(normalizeForComparison(line))
    ) {
      continue;
    }

    if (isUsableAuthorLine(line)) {
      return truncateForRichText(line);
    }
  }

  const authorBlock = inferAuthorBlock(frontMatter, normalizedTitle);
  if (authorBlock) {
    return truncateForRichText(authorBlock);
  }

  return null;
}

function inferAuthorBlock(lines: string[], normalizedTitle: string): string | null {
  const block: string[] = [];
  let sawTitle = false;

  for (const line of lines) {
    const normalizedLine = normalizeForComparison(line);
    const isTitleLine =
      normalizedLine === normalizedTitle ||
      normalizedLine.startsWith(normalizedTitle.slice(0, 50)) ||
      (normalizedLine.length > 20 && normalizedTitle.startsWith(normalizedLine));

    if (isTitleLine) {
      sawTitle = true;
      block.length = 0;
      continue;
    }

    if (!sawTitle) {
      continue;
    }

    if (/^(abstract|introduction|keywords)\b/i.test(line) || line.startsWith("#")) {
      break;
    }

    if (isPossibleAuthorBlockLine(line)) {
      block.push(line);
      if (block.length >= 4) {
        break;
      }
    } else if (block.length > 0) {
      break;
    }
  }

  return block.length > 0 ? block.join("; ") : null;
}

function isPossibleAuthorBlockLine(line: string): boolean {
  if (line.length < 3 || line.length > 180) {
    return false;
  }
  if (/@|https?:\/\//i.test(line)) {
    return false;
  }
  if (/^\(?for the complete list/i.test(line)) {
    return false;
  }

  return (
    /\bteam\b/i.test(line) ||
    /\b(author|authors)\b/i.test(line) ||
    /\b(university|institute|laboratory|labs|research|college|school)\b/i.test(line) ||
    /&|,|;|·|•/.test(line)
  );
}

function isUsableAuthorLine(line: string): boolean {
  if (line.length < 5 || line.length > 500) {
    return false;
  }
  if (/[{}]|@|https?:\/\//i.test(line)) {
    return false;
  }
  if (
    /^(abstract|introduction|keywords|correspondence|department|university|institute|school|college|laboratory|equal contribution)\b/i.test(
      line,
    )
  ) {
    return false;
  }

  const lower = line.toLowerCase();
  if (/\b(model|benchmark|dataset|paper|method|results|training|evaluation)\b/.test(lower)) {
    return false;
  }

  const hasAuthorSeparator = /,\s*[A-Z]|\band\b|·|•|;/.test(line);
  const likelyNames = line.match(/\b[A-Z][a-z]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-z]+)+\b/g);
  return hasAuthorSeparator || (likelyNames?.length ?? 0) >= 2;
}

function inferPublicationYear(markdownText: string, sourceUrl: string | null): number | null {
  const candidates = `${sourceUrl ?? ""}\n${markdownText.slice(0, 15_000)}`.match(
    /\b(19[5-9]\d|20[0-3]\d)\b/g,
  );
  if (!candidates) {
    return null;
  }

  const currentYear = new Date().getUTCFullYear() + 1;
  const years = candidates
    .map((candidate) => Number(candidate))
    .filter((year) => year >= 1950 && year <= currentYear);
  return years[0] ?? null;
}

function inferTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const scores = new Map<string, number>();
  const rules: Array<[string, RegExp[]]> = [
    [
      "Machine Learning",
      [
        /\bmachine learning\b/,
        /\breinforcement learning\b/,
        /\btraining\b/,
        /\bbenchmark\b/,
        /\bdataset\b/,
        /\bagent(s)?\b/,
      ],
    ],
    [
      "Deep Learning",
      [
        /\bdeep learning\b/,
        /\bneural\b/,
        /\btransformer\b/,
        /\bfoundation model\b/,
        /\blarge language model\b/,
        /\bllm(s)?\b/,
        /\bmultimodal\b/,
      ],
    ],
    [
      "Natural Language Processing",
      [
        /\bnatural language\b/,
        /\bnlp\b/,
        /\blanguage model\b/,
        /\btoken(s|ization)?\b/,
        /\btranslation\b/,
        /\breasoning\b/,
      ],
    ],
    [
      "Computer Vision",
      [
        /\bcomputer vision\b/,
        /\bvision\b/,
        /\bvisual\b/,
        /\bimage(s)?\b/,
        /\bvideo\b/,
        /\bsegmentation\b/,
        /\bdetection\b/,
      ],
    ],
    ["Neuroscience", [/\bneuroscience\b/, /\bneuron(s|al)?\b/, /\bbrain\b/]],
    ["Climate Science", [/\bclimate\b/, /\bweather\b/, /\batmosphere\b/]],
    ["Physics", [/\bphysics\b/, /\bquantum\b/, /\bparticle\b/, /\bcosmology\b/]],
    ["Biology", [/\bbiology\b/, /\bgenomic(s)?\b/, /\bprotein\b/, /\bcell(s)?\b/]],
    ["Chemistry", [/\bchemistry\b/, /\bmolecule(s|cular)?\b/, /\bchemical\b/]],
    ["Mathematics", [/\bmathematics\b/, /\btheorem\b/, /\bproof\b/, /\boptimization\b/]],
  ];

  for (const [topic, patterns] of rules) {
    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        scores.set(topic, (scores.get(topic) ?? 0) + 1);
      }
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([topic]) => topic);
}

function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function splitMarkdown(markdown: string, maxChars: number): string[] {
  if (markdown.length <= maxChars) {
    return [markdown];
  }

  const chunks: string[] = [];
  let remaining = markdown;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n# ", maxChars);
    if (splitAt < maxChars * 0.35) {
      splitAt = remaining.lastIndexOf("\n\n", maxChars);
    }
    if (splitAt < maxChars * 0.35) {
      splitAt = remaining.lastIndexOf("\n", maxChars);
    }
    if (splitAt < maxChars * 0.35) {
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

function getPageTitle(page: PageLike): string | null {
  return getRichTextItemsText(getTypedProperty(page, PROPS.title, "title")?.title);
}

function getUrlProperty(page: PageLike, name: string): string | null {
  const property = getTypedProperty(page, name, "url");
  return typeof property?.url === "string" ? property.url : null;
}

function getPdfUrlProperty(page: PageLike, name: string): string | null {
  return getUrlProperty(page, name) ?? getFilesPropertyUrl(page, name);
}

function getFilesPropertyUrl(page: PageLike, name: string): string | null {
  const property = getTypedProperty(page, name, "files");
  const files = property?.files;
  if (!Array.isArray(files)) {
    return null;
  }

  const urls = files
    .map(fileUrl)
    .filter((url): url is string => Boolean(url));
  return urls.find((url) => url.toLowerCase().includes(".pdf")) ?? urls[0] ?? null;
}

function fileUrl(file: unknown): string | null {
  if (!isRecord(file)) {
    return null;
  }

  if (file.type === "file" && isRecord(file.file) && typeof file.file.url === "string") {
    return file.file.url;
  }

  if (
    file.type === "external" &&
    isRecord(file.external) &&
    typeof file.external.url === "string"
  ) {
    return file.external.url;
  }

  return null;
}

function getStatusProperty(page: PageLike, name: string): string | null {
  const property = getTypedProperty(page, name, "status");
  return isRecord(property?.status) && typeof property.status.name === "string"
    ? property.status.name
    : null;
}

function getRichTextProperty(page: PageLike, name: string): string | null {
  return getRichTextItemsText(getTypedProperty(page, name, "rich_text")?.rich_text);
}

function getNumberProperty(page: PageLike, name: string): number | null {
  const property = getTypedProperty(page, name, "number");
  return typeof property?.number === "number" ? property.number : null;
}

function getMultiSelectProperty(page: PageLike, name: string): string[] {
  const property = getTypedProperty(page, name, "multi_select");
  const selected = property?.multi_select;
  if (!Array.isArray(selected)) {
    return [];
  }

  return selected
    .map((option) =>
      isRecord(option) && typeof option.name === "string" ? option.name : null,
    )
    .filter((option): option is string => Boolean(option));
}

function getCheckboxProperty(page: PageLike, name: string): boolean {
  const property = getTypedProperty(page, name, "checkbox");
  return property?.checkbox === true;
}

function getTypedProperty(
  page: PageLike,
  name: string,
  type: string,
): Record<string, unknown> | null {
  const property = page.properties?.[name];
  if (!isRecord(property) || property.type !== type) {
    return null;
  }
  return property;
}

function getRichTextItemsText(items: unknown): string | null {
  if (!Array.isArray(items)) {
    return null;
  }

  const text = items
    .map((item) =>
      isRecord(item) && typeof item.plain_text === "string" ? item.plain_text : "",
    )
    .join("")
    .trim();
  return text || null;
}

function titleProperty(content: string) {
  return {
    title: [
      {
        type: "text" as const,
        text: { content: truncateForRichText(content) },
      },
    ],
  };
}

function richTextProperty(content: string) {
  return {
    rich_text: [
      {
        type: "text" as const,
        text: { content: truncateForRichText(content) },
      },
    ],
  };
}

function emptyRichTextProperty() {
  return { rich_text: [] };
}

function statusProperty(name: string) {
  return { status: { name } };
}

function checkboxProperty(checked: boolean) {
  return { checkbox: checked };
}

function numberProperty(number: number) {
  return { number };
}

function multiSelectProperty(names: string[]) {
  return {
    multi_select: names.map((name) => ({ name })),
  };
}

function urlProperty(url: string) {
  return { url };
}

function dateProperty(date: Date) {
  return { date: { start: date.toISOString() } };
}

function truncateForRichText(content: string): string {
  return content.length > RICH_TEXT_LIMIT
    ? `${content.slice(0, RICH_TEXT_LIMIT - 3)}...`
    : content;
}

function truncatePlainText(content: string, maxLength: number): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function pageIdFromNotionUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }

  const path = safeUrlPath(url);
  const tail = path.split("/").filter(Boolean).at(-1) ?? url;
  const compactTail = tail.replace(/-/g, "");
  const anchored = compactTail.match(/([0-9a-fA-F]{32})$/);
  if (anchored) {
    return anchored[1];
  }

  const compactUrl = url.replace(/-/g, "");
  const matches = Array.from(compactUrl.matchAll(/[0-9a-fA-F]{32}/g));
  return matches.at(-1)?.[0] ?? null;
}

function safeUrlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

function notionUrlFromPageId(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function isStableExternalUrl(url: string): boolean {
  return !/prod-files-secure\.s3|X-Amz-|amazonaws\.com/i.test(url);
}

function isResearchIdeaPage(page: PageLike): boolean {
  const parentId = page.parent?.data_source_id ?? page.parent?.database_id;
  return isResearchDataSourceId(parentId);
}

function isResearchDataSourceId(id: string | null | undefined): boolean {
  return normalizeNotionId(id) === normalizeNotionId(RESEARCH_DATA_SOURCE_ID);
}

function normalizeNotionId(id: string | null | undefined): string | null {
  return id ? id.replace(/-/g, "").toLowerCase() : null;
}

function findMetadataPageId(body: Record<string, unknown>): string | null {
  const metadata = findRecord(body, ["metadata"]);
  return (
    findString(metadata, ["notionPageId", "pageId", "notion_page_id"]) ??
    findString(body, ["notionPageId", "pageId", "notion_page_id"])
  );
}

function findNotionPageId(body: Record<string, unknown>): string | null {
  return (
    findWebhookEntityPageId(body) ??
    findPageObjectId(body) ??
    findString(body, [
      "notionPageId",
      "notion_page_id",
      "pageId",
      "page_id",
      "pageID",
    ])
  );
}

function findNotionDataSourceId(body: Record<string, unknown>): string | null {
  return findWebhookEntityId(body, ["data_source", "database"]);
}

function findWebhookEntityPageId(body: Record<string, unknown>): string | null {
  return findWebhookEntityId(body, ["page"]);
}

function findWebhookEntityId(
  body: Record<string, unknown>,
  types: string[],
): string | null {
  const entity = body.entity;
  if (
    isRecord(entity) &&
    typeof entity.type === "string" &&
    types.includes(entity.type) &&
    typeof entity.id === "string"
  ) {
    return entity.id;
  }

  const data = body.data;
  if (isRecord(data)) {
    const nestedEntity = data.entity;
    if (
      isRecord(nestedEntity) &&
      typeof nestedEntity.type === "string" &&
      types.includes(nestedEntity.type) &&
      typeof nestedEntity.id === "string"
    ) {
      return nestedEntity.id;
    }
  }

  return null;
}

function findPageObjectId(input: Record<string, unknown>): string | null {
  if (input.object === "page" && typeof input.id === "string") {
    return input.id;
  }

  for (const value of Object.values(input)) {
    if (!isRecord(value)) {
      continue;
    }
    const pageId = findPageObjectId(value);
    if (pageId) {
      return pageId;
    }
  }

  return null;
}

function findRecord(
  input: Record<string, unknown> | null,
  keys: string[],
): Record<string, unknown> | null {
  if (!input) {
    return null;
  }

  for (const key of keys) {
    const value = input[key];
    if (isRecord(value)) {
      return value;
    }
  }

  for (const value of Object.values(input)) {
    if (!isRecord(value)) {
      continue;
    }
    const nested = findRecord(value, keys);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function findString(
  input: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!input) {
    return null;
  }

  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  for (const value of Object.values(input)) {
    if (!isRecord(value)) {
      continue;
    }
    const nested = findString(value, keys);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function isPageLike(value: unknown): value is PageLike {
  return isRecord(value) && value.object === "page" && typeof value.id === "string";
}

function isFullResult(value: unknown): value is FullParseResult {
  return (
    isRecord(value) &&
    value.type === "full" &&
    Array.isArray(value.chunks) &&
    value.chunks.every((chunk) => isRecord(chunk))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => nullableString(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skipped(
  page: PageLike,
  title: string,
  reason: string,
  pdfUrl?: string,
): ProcessResult {
  return {
    pageId: page.id,
    title,
    status: "skipped",
    reason,
    pdfUrl,
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) {
    return 1;
  }
  return Math.min(Math.floor(limit), MAX_BATCH_LIMIT);
}

function clampResearchLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) {
    return 5;
  }
  return Math.min(Math.floor(limit), 12);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
