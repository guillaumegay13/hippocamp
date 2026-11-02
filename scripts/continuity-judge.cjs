// Judges for the continuity benchmark. The task judge is blind to which arm ran; a separate call
// explains each miss from the memory the session started with.
const path = require("node:path");

const CAUSES = ["never-stored", "stale-memory", "wrong-scope", "not-recalled", "ignored", "asked-not-acted"];

function cap(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n[... truncated ${text.length - limit + 40} chars]`;
}

function checklistText(session, facts) {
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));

  return session.checklist
    .map((item) => {
      const statement = factsById.get(item.fact)?.statement || item.fact;
      return `- ${item.id}: ${item.check} (${item.leak ? `must NOT carry over from another project: ${statement}` : `fact: ${statement}`})`;
    })
    .join("\n");
}

function parseJudgeReply(text) {
  const match = String(text).match(/\{[\s\S]*\}/);

  try {
    return match ? JSON.parse(match[0]).items || [] : [];
  } catch {
    return [];
  }
}

// Memory tools and Markdown reads keep a slice of their result, so attribution can tell not-recalled from ignored.
function transcriptDigest(toolCalls, finalText) {
  const final = `\nFINAL ANSWER:\n${cap(finalText, 8000)}`;
  const lines = toolCalls.map(({ name, input, result }) => {
    const line = `${name}: ${JSON.stringify(input ?? {}).slice(0, 200)}`;
    const shown = result && (name.startsWith("mcp__") || String(input?.file_path || "").endsWith(".md"));
    return shown ? `${line}\n  -> ${result.slice(0, 1500).replace(/\n/g, "\n     ")}` : line;
  });

  return `${cap(lines.join("\n"), 40000 - final.length)}${final}`;
}

// Removes everything that names the arm or the product: memory tool names, sandbox paths, arm ids.
function blindText(text, { paths }) {
  const places = [
    [paths.lagoon, "<memory>"],
    [path.join(paths.configDir, "projects"), "<memory>"],
    ...Object.values(paths.repos).map((repo) => [repo, "<repo>"]),
    [paths.configDir, "<home>/config"],
    [paths.home, "<home>"],
    [paths.root, "<sandbox>"],
  ];

  return places
    .reduce((out, [from, to]) => out.split(from).join(to), String(text).replace(/mcp__hippocamp__\w+/g, "memory_tool"))
    .replace(/cc-(none|native|hippocamp|memory)/g, "arm")
    .replace(/hippocamp|lagoon|\.claude\/projects/gi, "memory");
}

// The digest with nothing that names the arm: memory tools become memory_tool and sandbox paths are rewritten.
function blindDigest(toolCalls, finalText, { adapter, paths }) {
  const calls = toolCalls.map((call) => ({
    ...call,
    name: adapter.isMemoryCall(call, paths) && call.name.startsWith("mcp__") ? "memory_tool" : call.name,
    input: JSON.parse(blindText(JSON.stringify(call.input ?? {}), { paths })),
    result: call.result === undefined ? undefined : blindText(call.result, { paths }),
  }));

  return transcriptDigest(calls, blindText(finalText, { paths }));
}

const TASK_PROMPT = `You grade one session of a coding agent that works on a project across many independent sessions.
Earlier sessions established facts the agent was never reminded of in this session. Decide, for each checklist item,
whether the agent's work in this session respects the fact.

# Session request
{request}

# Checklist (item id, check, underlying fact)
{checklist}

# Diff of this session
{diff}

# Tool calls and final answer of this session
{digest}

For each item return:
- "pass": true when the work respects the fact; false when it contradicts it; "n/a" when the session never touched that area, so the item says nothing either way.
- "evidence": one short sentence naming the diff line, tool call or answer text that decided it, so a person can check the verdict.

Reply with JSON only: {"items":[{"id":"...","pass":true,"evidence":"..."}]}`;

async function judgeProbe({ session, facts, diff, digest, judgeModel, complete }) {
  const prompt = TASK_PROMPT.replace("{request}", () => session.turns.join("\n\n"))
    .replace("{checklist}", () => checklistText(session, facts))
    .replace("{diff}", () => diff || "(no changes)")
    .replace("{digest}", () => digest || "(none)");
  const response = await complete(judgeModel, { messages: [{ role: "user", content: prompt }], json: true });
  const replies = new Map(parseJudgeReply(response.text).map((item) => [item.id, item]));

  return session.checklist.map((item) => {
    const reply = replies.get(item.id);

    if (reply?.pass === "n/a") {
      return { item: item.id, pass: null, evidence: reply.evidence || "" };
    }

    if (!reply || typeof reply.pass !== "boolean") {
      return { item: item.id, pass: false, evidence: "", cause: "judge-missing" };
    }

    return { item: item.id, pass: reply.pass, evidence: reply.evidence || "" };
  });
}

const ATTRIBUTION_PROMPT = `A coding agent failed some checks in one session of a multi-session project. For each failed check, say why,
using the memory that existed when the session started and what the session did.

# Failed checks (item id, check, underlying fact)
{misses}

# Memory when the session started (repo notes and the memory system, every scope)
{snapshot}

# Tool calls and final answer of this session
{digest}

For each item return:
- "cause": one of
  "never-stored" (the fact is in no memory above),
  "stale-memory" (memory holds an older or contradicting version of the fact),
  "wrong-scope" (the fact is stored, but in a scope this session does not load, such as another project),
  "not-recalled" (it is stored in a loaded scope but the session never saw it),
  "ignored" (the session saw it and acted against it),
  "asked-not-acted" (the agent asked the user instead of doing what the check requires).
- "source": where the session's relevant knowledge came from: "code", "repo-note", "memory", "prompt" or "none".

Reply with JSON only: {"items":[{"id":"...","cause":"...","source":"..."}]}`;

async function attributeMisses({ session, facts, misses, snapshot, digest, judgeModel, complete }) {
  const missed = { ...session, checklist: session.checklist.filter((item) => misses.includes(item.id)) };
  const prompt = ATTRIBUTION_PROMPT.replace("{misses}", () => checklistText(missed, facts))
    .replace("{snapshot}", () => snapshot || "(empty)")
    .replace("{digest}", () => digest || "(none)");
  const response = await complete(judgeModel, { messages: [{ role: "user", content: prompt }], json: true });
  const replies = new Map(parseJudgeReply(response.text).map((item) => [item.id, item]));

  return misses.map((item) => {
    const reply = replies.get(item);
    return { item, cause: CAUSES.includes(reply?.cause) ? reply.cause : "unknown", source: reply?.source || "none" };
  });
}

const LABELS = ["fact-current", "fact-stale", "useful-other", "noise", "duplicate"];

// coverage: live (not superseded) facts stored in their current version. precision: entries worth keeping.
function memoryQuality(labels, facts) {
  const live = facts.filter((fact) => !fact.supersededBy);
  const covered = new Set(labels.filter((entry) => entry.label === "fact-current").map((entry) => entry.fact));
  const count = (label) => labels.filter((entry) => entry.label === label).length;

  return {
    entries: labels.length,
    coverage: live.length ? live.filter((fact) => covered.has(fact.id)).length / live.length : 0,
    precision: labels.length ? (count("fact-current") + count("useful-other")) / labels.length : null,
    stale: count("fact-stale"),
    noise: count("noise"),
    duplicates: count("duplicate"),
  };
}

const MEMORY_PROMPT = `You audit what a coding agent's memory system stored over a multi-session project.
Below are the project's facts (some later replaced by others) and every memory entry, anonymized as m1, m2, ...

# Facts (id, statement, replaced by)
{facts}

# Memory entries
{entries}

Label every entry:
- "fact-current": states a fact above in its current version (give its id in "fact");
- "fact-stale": states a replaced fact, or an old version, without saying it was replaced (give the old fact's id);
- "useful-other": not a listed fact, but something a later session would reasonably need;
- "noise": nothing a later decision depends on (routine work logs, restated code, chatter);
- "duplicate": repeats an earlier entry's content.

Reply with JSON only: {"items":[{"id":"m1","label":"...","fact":"..."}]}`;

async function judgeMemory({ facts, entries, judgeModel, complete }) {
  const factList = facts.map((fact) => `- ${fact.id}: ${fact.statement}${fact.supersededBy ? ` (replaced by ${fact.supersededBy})` : ""}`).join("\n");
  const entryList = entries.map((entry, index) => `=== m${index + 1} ===\n${cap(entry.text, 8000)}`).join("\n");
  const prompt = MEMORY_PROMPT.replace("{facts}", () => factList).replace("{entries}", () => cap(entryList, 120000));
  const response = await complete(judgeModel, { messages: [{ role: "user", content: prompt }], json: true });
  const replies = new Map(parseJudgeReply(response.text).map((item) => [item.id, item]));
  const labels = entries.map((entry, index) => {
    const reply = replies.get(`m${index + 1}`);
    return { id: `m${index + 1}`, file: entry.file, label: LABELS.includes(reply?.label) ? reply.label : "unlabeled", fact: reply?.fact || null };
  });

  // Reported, never silent: entries cut for length, and entries the judge left unlabeled.
  const truncated = entries.filter((entry) => entry.text.length > 8000).length;
  return { labels, quality: memoryQuality(labels, facts), truncated, unlabeled: labels.filter((entry) => entry.label === "unlabeled").length, prompt, reply: response.text };
}

module.exports = { CAUSES, judgeMemory, memoryQuality, attributeMisses, blindDigest, blindText, judgeProbe, parseJudgeReply, transcriptDigest };
