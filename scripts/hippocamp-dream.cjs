#!/usr/bin/env node

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const memory = require("./hippocamp-memory.cjs");

const CURATED_FILES = ["current_state.md", "open_threads.md"];
const DEFAULT_THRESHOLD_CHARS = 20000;
const DEFAULT_TARGET_CHARS = 15000;
const DEFAULT_MODEL = "auto";
const TARGET_BYTE_TOLERANCE = 0.02;
const DREAM_COMPACTION_MAX_PASSES = 3;
const DREAM_MODEL_MAX_ATTEMPTS = 3;
const DREAM_MODEL_RETRY_DELAY_MS = 2000;
// Manifest returns HTTP 200 with a "[🦚 Manifest <code>] ..." banner as the
// assistant message when the router cannot fulfil a request (model unavailable,
// overloaded, throttled). It is not JSON, so treat it as a retryable failure.
const MANIFEST_BANNER_PATTERN = /^\s*\[\s*🦚/u;
// Manifest surfaces upstream throttling and provider outages as HTTP errors.
// A 429 is returned both for exhausted subscription quota and for a route that
// is briefly cooling down, so retry these rather than failing the whole run.
const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);

function numberFromEnv(name, fallback) {
  const value = process.env[name];

  return value ? Number(value) : fallback;
}

function printHelp() {
  console.log(`Hippocamp Dream

Offline memory compaction for Lagoon curated project files.

Usage:
  hippocamp dream --project SLUG [--dry-run|--write]
  hippocamp dream --all [--dry-run|--write]

Options:
  --project SLUG           Compact one project under projects/<slug>
  --all                    Scan all projects and compact those over the threshold
  --threshold-chars N      Minimum wake-up size to include. Default: HIPPOCAMP_DREAM_THRESHOLD_CHARS or ${DEFAULT_THRESHOLD_CHARS}
  --target-chars N         Target combined size for current_state/open_threads. Default: HIPPOCAMP_DREAM_TARGET_CHARS or ${DEFAULT_TARGET_CHARS}
  --model NAME             Responses API model. Default: HIPPOCAMP_DREAM_MODEL or ${DEFAULT_MODEL}
  --base-url URL           Responses API base URL. Default: MANIFEST_BASE_URL
  --api-key KEY            API key. Default: MANIFEST_API_KEY
  --global-root PATH       Lagoon root. Default: HIPPOCAMP_GLOBAL_ROOT or ~/.lagoon
  --json                   Print machine-readable JSON
  --dry-run                Report candidates without calling AI or writing files. Default
  --write                  Call AI and rewrite only current_state.md/open_threads.md
`);
}

function parseArgs(argv) {
  const options = {
    all: false,
    apiKey: process.env.MANIFEST_API_KEY || process.env.HIPPOCAMP_DREAM_API_KEY || "",
    baseUrl: process.env.MANIFEST_BASE_URL || process.env.HIPPOCAMP_DREAM_BASE_URL || "",
    dryRun: true,
    globalRoot: process.env.HIPPOCAMP_GLOBAL_ROOT || "",
    json: false,
    model: process.env.HIPPOCAMP_DREAM_MODEL || DEFAULT_MODEL,
    project: "",
    targetChars: numberFromEnv("HIPPOCAMP_DREAM_TARGET_CHARS", DEFAULT_TARGET_CHARS),
    thresholdChars: numberFromEnv("HIPPOCAMP_DREAM_THRESHOLD_CHARS", DEFAULT_THRESHOLD_CHARS),
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--all") {
      options.all = true;
      continue;
    }

    if (token === "--api-key") {
      options.apiKey = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (token === "--base-url") {
      options.baseUrl = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (token === "--dry-run") {
      options.dryRun = true;
      options.write = false;
      continue;
    }

    if (token === "--global-root") {
      options.globalRoot = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (token === "--json") {
      options.json = true;
      continue;
    }

    if (token === "--model") {
      options.model = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (token === "--project") {
      options.project = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (token === "--target-chars") {
      options.targetChars = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === "--threshold-chars") {
      options.thresholdChars = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === "--write") {
      options.dryRun = false;
      options.write = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!options.all && !options.project) {
    throw new Error("Provide --project SLUG or --all.");
  }

  if (options.all && options.project) {
    throw new Error("Use either --project or --all, not both.");
  }

  if (!Number.isFinite(options.thresholdChars) || options.thresholdChars < 1) {
    throw new Error("--threshold-chars must be a positive number.");
  }

  if (!Number.isFinite(options.targetChars) || options.targetChars < 1) {
    throw new Error("--target-chars must be a positive number.");
  }

  if (options.globalRoot) {
    process.env.HIPPOCAMP_GLOBAL_ROOT = options.globalRoot;
  }

  return options;
}

function assertSafeProjectSlug(slug) {
  if (!/^[a-z0-9._-]+$/.test(slug) || slug === "." || slug === ".." || slug.includes(".git")) {
    throw new Error(`Unsafe project slug: ${slug}`);
  }

  return slug;
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function statSize(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

async function listProjectSlugs(globalRoot) {
  const projectsRoot = path.join(globalRoot, "projects");
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch((error) => {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^[a-z0-9._-]+$/.test(name))
    .sort((left, right) => left.localeCompare(right));
}

function getSyntheticProjectRoot(slug) {
  return path.join("/tmp", slug);
}

async function getProjectReport(slug) {
  const safeSlug = assertSafeProjectSlug(slug);
  const projectRoot = getSyntheticProjectRoot(safeSlug);
  const projectMemoryRoot = memory.getScopeRoot("project", projectRoot);
  const files = {};

  for (const name of CURATED_FILES) {
    const absolutePath = path.join(projectMemoryRoot, name);
    files[name] = {
      absolutePath,
      bytes: await statSize(absolutePath),
      content: await readFileIfExists(absolutePath),
      path: `projects/${safeSlug}/${name}`,
    };
  }

  const wake = await memory.wakeUp({ projectRoot });

  return {
    files,
    projectMemoryRoot,
    slug: safeSlug,
    wakeUpChars: wake.text.length,
  };
}

function extractOpenThreads(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1]?.trim())
    .filter(Boolean);
}

async function buildThreadEvidence(report, { budgetChars }) {
  const projectRoot = getSyntheticProjectRoot(report.slug);
  const threads = extractOpenThreads(report.files["open_threads.md"].content);
  const items = [];
  let evidenceChars = 0;

  for (const thread of threads) {
    const search = await memory.searchMemory({
      projectRoot,
      query: thread,
      scope: "project",
    });
    const match = search.results.find((item) => item.path.startsWith("events/"));

    if (!match) {
      continue;
    }

    const item = {
      path: match.path,
      heading: match.heading,
      cues: match.cues || [],
      score: match.score,
      snippet: match.snippet,
    };
    const candidate = {
      thread,
      query: thread,
      evidence: [item],
    };
    const candidateChars = Buffer.byteLength(JSON.stringify(candidate), "utf8");

    if (evidenceChars + candidateChars > budgetChars) {
      break;
    }

    items.push(candidate);
    evidenceChars += candidateChars;
  }

  return {
    evidenceBudgetChars: budgetChars,
    evidenceChars,
    openThreadCount: threads.length,
    items,
  };
}

function countEvidenceItems(threadEvidence) {
  return threadEvidence.items.reduce((total, item) => total + item.evidence.length, 0);
}

function createPrompt({ report, targetChars, threadEvidence }) {
  return [
    {
      role: "system",
      content: [
        "You are Hippocamp Dream, an offline memory curator.",
        "Rewrite only the project's curated memory files so future wake_up context stays compact and useful.",
        "Do not add new facts that are not supported by the provided files.",
        "Do not preserve completed historical run logs unless they explain an active state, durable decision, or open follow-up.",
        "Use thread evidence to decide whether open threads are still active, resolved, superseded, or worth promoting into current state.",
        "Remove an open thread only when the current files or evidence clearly show it is closed or obsolete; keep it concise when uncertain.",
        "The evidence pack is capped, so missing evidence never proves that a thread is closed.",
        "The combined output must stay under the requested target size.",
        "Quality bar: every bullet must be useful to a future agent immediately after wake_up.",
        "current_state.md is for durable project state, active constraints, and recent decisions; it is not a backlog or PR inventory.",
        "In current_state.md, use workstream summaries instead of PR lists; include a concrete PR number only for a live blocker, active architecture decision, or release-critical state.",
        "open_threads.md is for next actions and decisions; it is not a mirror of current_state.md.",
        "In open_threads.md, avoid long comma-separated PR lists. Use counts, ranges, or workstream names for merge-ready and monitoring batches; name specific PRs only for next review, blockers, or unusual follow-up.",
        "Do not duplicate the same inventory across both files.",
        "Do not enumerate every historical PR; keep only the most current, actionable, or high-risk items.",
        "Collapse large PR batches into grouped workstreams and name only blockers, exceptions, or representative references.",
        "Treat open_threads.md as an agenda, not an issue tracker.",
        "Group related PR review, merge, monitor, and local-run items by repo or status instead of listing every item separately.",
        "Prefer short bullets. Preserve concrete references when they are still actionable.",
        "Return strict JSON only, with keys current_state_md and open_threads_md.",
        "current_state_md must start with '# Current State'.",
        "open_threads_md must start with '# Open Threads'.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Project: ${report.slug}`,
        `Current wake_up size: ${report.wakeUpChars} chars`,
        `Target combined size for current_state.md and open_threads.md: ${targetChars} chars`,
        "",
        "Rewrite these files from the current content below.",
        "",
        "## current_state.md",
        report.files["current_state.md"].content.trim() || "# Current State",
        "",
        "## open_threads.md",
        report.files["open_threads.md"].content.trim() || "# Open Threads",
        "",
        "## Thread Evidence",
        "Evidence is retrieved from cue-indexed project events. It is intentionally small and may be incomplete.",
        `Evidence budget: ${threadEvidence.evidenceChars}/${threadEvidence.evidenceBudgetChars} chars`,
        JSON.stringify(threadEvidence.items, null, 2),
      ].join("\n"),
    },
  ];
}

function createCompactionRetryPrompt({ output, targetChars }) {
  return [
    {
      role: "system",
      content: [
        "You are Hippocamp Dream, an offline memory curator.",
        "The previous compaction pass was still too large.",
        "Rewrite the complete snapshot again as a shorter, coherent snapshot.",
        "Preserve the goal, important instructions, technical decisions, active state, and open work.",
        "Remove repetition and historical detail before shortening individual facts.",
        "Do not crop text, leave partial bullets, or invent facts.",
        "Return strict JSON only, with keys current_state_md and open_threads_md.",
        "current_state_md must start with '# Current State'.",
        "open_threads_md must start with '# Open Threads'.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Target combined size for current_state.md and open_threads.md: ${targetChars} chars`,
        "",
        "## current_state.md",
        output.currentState,
        "",
        "## open_threads.md",
        output.openThreads,
      ].join("\n"),
    },
  ];
}

function normalizeBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");

  if (!trimmed) {
    throw new Error("Missing Manifest/OpenAI-compatible base URL. Set MANIFEST_BASE_URL or pass --base-url.");
  }

  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function createResponsesInput(messages) {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n");
}

function createDreamTextFormat() {
  return {
    format: {
      type: "json_schema",
      name: "hippocamp_dream",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["current_state_md", "open_threads_md"],
        properties: {
          current_state_md: {
            type: "string",
          },
          open_threads_md: {
            type: "string",
          },
        },
      },
    },
  };
}

function getResponseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string" && content.text.trim()) {
        return content.text;
      }
    }
  }

  return "";
}

function isManifestBanner(content) {
  return MANIFEST_BANNER_PATTERN.test(content);
}

function isRetryableStatus(status) {
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callDreamModel({ apiKey, baseUrl, messages, model }) {
  if (!apiKey) {
    throw new Error("Missing API key. Set MANIFEST_API_KEY or pass --api-key.");
  }

  if (!global.fetch) {
    throw new Error("This command requires Node.js fetch support.");
  }

  let lastBanner = null;
  const endpoint = `${normalizeBaseUrl(baseUrl)}/responses`;

  for (let attempt = 1; attempt <= DREAM_MODEL_MAX_ATTEMPTS; attempt += 1) {
    let response;
    let text;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: createResponsesInput(messages),
          model,
          store: false,
          text: createDreamTextFormat(),
        }),
      });
      text = await response.text();
    } catch (error) {
      if (attempt < DREAM_MODEL_MAX_ATTEMPTS) {
        await delay(DREAM_MODEL_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw new Error(`Dream model request failed after ${DREAM_MODEL_MAX_ATTEMPTS} attempts: ${error.message}`);
    }

    if (!response.ok) {
      if (isRetryableStatus(response.status) && attempt < DREAM_MODEL_MAX_ATTEMPTS) {
        await delay(DREAM_MODEL_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw new Error(`Dream model request failed (${response.status}): ${text}`);
    }

    const payload = JSON.parse(text);
    const content = getResponseText(payload);

    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Dream model response did not include output text.");
    }

    if (isManifestBanner(content)) {
      lastBanner = content.trim();

      if (attempt < DREAM_MODEL_MAX_ATTEMPTS) {
        await delay(DREAM_MODEL_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw new Error(
        `Dream model returned a Manifest router banner instead of JSON after ${DREAM_MODEL_MAX_ATTEMPTS} attempts: ${lastBanner}`,
      );
    }

    return content;
  }

  // Unreachable: the loop either returns content or throws on the final attempt.
  throw new Error(`Dream model returned a Manifest router banner instead of JSON: ${lastBanner}`);
}

function parseDreamJson(content) {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = match ? match[1].trim() : trimmed;
  let parsed;

  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const object = jsonText.match(/\{[\s\S]*\}/)?.[0];

    if (!object) {
      throw error;
    }

    parsed = JSON.parse(object);
  }

  if (typeof parsed.current_state_md !== "string" || typeof parsed.open_threads_md !== "string") {
    throw new Error("Dream response must include current_state_md and open_threads_md strings.");
  }

  return {
    currentState: parsed.current_state_md.trim(),
    openThreads: parsed.open_threads_md.trim(),
  };
}

function getDreamOutputBytes(output) {
  return Buffer.byteLength(`${output.currentState}\n${output.openThreads}\n`, "utf8");
}

function getMaxOutputBytes(targetChars) {
  return Math.ceil(targetChars * (1 + TARGET_BYTE_TOLERANCE));
}

function validateDreamStructure(output) {
  if (!output.currentState.startsWith("# Current State")) {
    throw new Error("Dream current_state_md must start with '# Current State'.");
  }

  if (!output.openThreads.startsWith("# Open Threads")) {
    throw new Error("Dream open_threads_md must start with '# Open Threads'.");
  }
}

async function compactDreamOutput({ apiKey, baseUrl, beforeBytes, model, report, targetChars, threadEvidence }) {
  const maxBytes = getMaxOutputBytes(targetChars);
  let previousBytes = beforeBytes;
  let previousOutput = null;

  for (let pass = 1; pass <= DREAM_COMPACTION_MAX_PASSES; pass += 1) {
    const messages = previousOutput
      ? createCompactionRetryPrompt({ output: previousOutput, targetChars })
      : createPrompt({ report, targetChars, threadEvidence });
    const content = await callDreamModel({ apiKey, baseUrl, messages, model });
    const output = parseDreamJson(content);
    validateDreamStructure(output);

    const afterBytes = getDreamOutputBytes(output);

    if (afterBytes >= previousBytes) {
      throw new Error(
        `Dream compaction pass ${pass} did not reduce the snapshot (${afterBytes} >= ${previousBytes} bytes).`,
      );
    }

    if (afterBytes <= maxBytes) {
      return {
        afterBytes,
        output,
        passes: pass,
      };
    }

    previousBytes = afterBytes;
    previousOutput = output;
  }

  throw new Error(
    `Dream output exceeds --target-chars after ${DREAM_COMPACTION_MAX_PASSES} coherent compaction passes (${previousBytes} > ${maxBytes} bytes).`,
  );
}

async function writeDreamOutput(report, output) {
  await fs.writeFile(report.files["current_state.md"].absolutePath, `${output.currentState}\n`, "utf8");
  await fs.writeFile(report.files["open_threads.md"].absolutePath, `${output.openThreads}\n`, "utf8");
}

function toPublicReport(result) {
  return {
    afterBytes: result.afterBytes,
    afterWakeUpChars: result.afterWakeUpChars,
    beforeBytes: result.beforeBytes,
    changed: result.changed,
    compactionPasses: result.compactionPasses,
    context: {
      evidenceBudgetChars: result.threadEvidence.evidenceBudgetChars,
      evidenceChars: result.threadEvidence.evidenceChars,
      evidenceItems: countEvidenceItems(result.threadEvidence),
      openThreads: result.threadEvidence.openThreadCount,
      threadsWithEvidence: result.threadEvidence.items.length,
    },
    files: {
      "current_state.md": result.report.files["current_state.md"].bytes,
      "open_threads.md": result.report.files["open_threads.md"].bytes,
    },
    project: result.report.slug,
    skipped: result.skipped,
    wakeUpChars: result.report.wakeUpChars,
  };
}

async function dreamProject(slug, options) {
  const report = await getProjectReport(slug);
  const beforeBytes = CURATED_FILES.reduce((total, name) => total + report.files[name].bytes, 0);
  let threadEvidence = {
    evidenceBudgetChars: options.targetChars,
    evidenceChars: 0,
    openThreadCount: extractOpenThreads(report.files["open_threads.md"].content).length,
    items: [],
  };

  if (report.wakeUpChars < options.thresholdChars) {
    return {
      beforeBytes,
      changed: false,
      report,
      skipped: "below_threshold",
      threadEvidence,
    };
  }

  threadEvidence = await buildThreadEvidence(report, { budgetChars: options.targetChars });

  if (!options.write) {
    return {
      beforeBytes,
      changed: false,
      report,
      skipped: "dry_run",
      threadEvidence,
    };
  }

  const compacted = await compactDreamOutput({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    beforeBytes,
    model: options.model,
    report,
    targetChars: options.targetChars,
    threadEvidence,
  });

  await writeDreamOutput(report, compacted.output);

  return {
    afterBytes: compacted.afterBytes,
    afterWakeUpChars: (await memory.wakeUp({ projectRoot: getSyntheticProjectRoot(report.slug) })).text.length,
    beforeBytes,
    changed: true,
    compactionPasses: compacted.passes,
    report,
    skipped: null,
    threadEvidence,
  };
}

function printText(results) {
  for (const item of results) {
    const result = toPublicReport(item);
    const status = result.changed ? "changed" : `skipped:${result.skipped}`;
    console.log(
      [
        result.project,
        status,
        `wake=${result.wakeUpChars}`,
        `before=${result.beforeBytes}`,
        `threads=${result.context.openThreads}`,
        `matchedThreads=${result.context.threadsWithEvidence}`,
        `evidence=${result.context.evidenceItems}`,
        result.compactionPasses ? `passes=${result.compactionPasses}` : null,
        result.afterBytes ? `after=${result.afterBytes}` : null,
        result.afterWakeUpChars ? `afterWake=${result.afterWakeUpChars}` : null,
      ]
        .filter(Boolean)
        .join("\t"),
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const globalRoot = memory.getGlobalRoot();
  const slugs = options.all ? await listProjectSlugs(globalRoot) : [options.project];
  const results = [];

  if (!fsSync.existsSync(globalRoot)) {
    throw new Error(`Lagoon root does not exist: ${globalRoot}`);
  }

  for (const slug of slugs) {
    results.push(await dreamProject(slug, options));
  }

  const payload = {
    changedProjects: results.filter((item) => item.changed).map((item) => item.report.slug),
    dryRun: options.dryRun,
    globalRoot,
    model: options.model,
    results: results.map(toPublicReport),
    thresholdChars: options.thresholdChars,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printText(results);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Hippocamp Dream failed:", error.message);
    process.exit(1);
  });
}

module.exports = {
  callDreamModel,
  compactDreamOutput,
  getDreamOutputBytes,
  isManifestBanner,
  isRetryableStatus,
  parseDreamJson,
};
