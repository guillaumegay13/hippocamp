#!/usr/bin/env node

const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const memory = require("./hippocamp-memory.cjs");

const DEFAULT_DATA = ".context/locomo/locomo10.json";
const DEFAULT_CACHE = ".context/locomo-results.jsonl";
const DEFAULT_STORES = ".context/locomo-stores";
const DEFAULT_SYSTEMS = "bm25,hippocamp";
const SYSTEMS = ["full", "bm25", "hippocamp"];
const MODELS = ["gpt-4o-mini", "gpt-6-luna", "claude-opus-5-5"];
const JUDGE = "gpt-4o-mini";
const DATA_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

// LoCoMo category ids; 5 (adversarial) is left out, as in Mem0's and MemoryTax's evaluations.
const CATEGORIES = { 4: "single-hop", 1: "multi-hop", 2: "temporal", 3: "open-domain" };

// List prices in $ per million tokens. The judge is excluded from cost, as in MemoryTax.
const PRICES = {
  "gpt-4o-mini": { input: 0.15, cached: 0.075, output: 0.6 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "claude-opus-5-5": { input: 4, cached: 0.2, output: 20 },
};

// Answer and judge prompts are verbatim from MemoryTax (arXiv 2610.29823) Appendix C,
// which copies Mem0's 2025 answer template and LLM-as-judge rubric.
const ANSWER_SYSTEM =
  "You are a helpful assistant that can answer questions based on the provided context. If the question involves timing, use the conversation date for reference. Provide the shortest possible answer. Use words directly from the conversation when possible. Avoid using subjects in your answer.";
const ANSWER_USER = "# Question:\n{}\n# Context:\n{}\n# Short answer:";
const JUDGE_PROMPT = `Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
(1) a question (posed by one user to another user),
(2) a 'gold' (ground truth) answer,
(3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: {}
Gold answer: {}
Generated answer: {}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".`;

// Hippocamp's store is written the way an agent writes it: the cell's model reads each
// session once and calls append_event, with the MCP tool's own description and schema.
const WRITE_SYSTEM =
  "You keep long-term memory with Hippocamp. After each conversation session, save what is worth remembering later with append_event: one event per distinct topic, with a short title, 1-8 concise keywords, and content in plain sentences that say who did what and when. Anchor relative times to the session date. Skip small talk. Reply with a short note when you are done.";
const APPEND_EVENT_TOOL = {
  name: "append_event",
  description:
    "Append a dated event entry under events/YYYY-MM-DD.md and update the sibling keyword index. Requires a title and 1-8 short keywords for recall. Automatically stamps Agent/Session provenance when available. Store references to GitHub artifacts instead of copying their content.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      keywords: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
      content: { type: "string" },
    },
    required: ["title", "keywords", "content"],
    additionalProperties: false,
  },
};

function printHelp() {
  console.log(`Hippocamp LoCoMo eval

LoCoMo conv-26 answer accuracy with the MemoryTax protocol (arXiv 2610.29823):
152 questions (adversarial left out), the same model writes the store and answers,
and GPT-4o-mini judges with Mem0's rubric. Cost is list price without the judge.

Systems:
  full        the whole conversation
  bm25        top 8 turns, +-2 neighbour turns in the same session
  hippocamp   the model writes each session with append_event; searchMemory top K per question

Usage:
  node --env-file=.env scripts/eval-locomo.cjs --model MODEL [options]

Options:
  --model MODEL    ${MODELS.join(", ")}
  --systems LIST   Comma-separated systems. Default: ${DEFAULT_SYSTEMS}
  --top-k N        searchMemory maxResults for hippocamp. Default: 10
  --limit N        Evaluate N questions spread evenly across the set. Default: all 152
  --data PATH      LoCoMo JSON. Default: ${DEFAULT_DATA}
  --cache PATH     JSONL results cache; reruns only pay for missing calls. Default: ${DEFAULT_CACHE}
  --stores PATH    Folder for built Hippocamp stores, one per model. Default: ${DEFAULT_STORES}
  --concurrency N  Parallel answer and judge calls. Default: 6
  --dry-run        Print jobs and prompt token estimates; never calls a model or builds a store
  --help           Show this help

Environment:
  OPENAI_API_KEY      GPT models and the judge
  ANTHROPIC_API_KEY   Claude models

Download the data once:
  mkdir -p .context/locomo
  curl -L -o ${DEFAULT_DATA} ${DATA_URL}
`);
}

function parsePositiveInteger(value, name) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return number;
}

function parseArgs(argv) {
  const options = {
    model: null,
    systems: DEFAULT_SYSTEMS.split(","),
    topK: 10,
    limit: null,
    data: DEFAULT_DATA,
    cache: DEFAULT_CACHE,
    stores: DEFAULT_STORES,
    concurrency: 6,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      options.help = true;
    } else if (token === "--model") {
      options.model = argv[++index];

      if (!MODELS.includes(options.model)) {
        throw new Error(`Unknown model: ${options.model}. Use ${MODELS.join(", ")}.`);
      }
    } else if (token === "--systems") {
      options.systems = String(argv[++index] || "").split(",").filter(Boolean);

      for (const system of options.systems) {
        if (!SYSTEMS.includes(system)) {
          throw new Error(`Unknown system: ${system}. Use ${SYSTEMS.join(", ")}.`);
        }
      }
    } else if (token === "--top-k") {
      options.topK = parsePositiveInteger(argv[++index], "--top-k");
    } else if (token === "--limit") {
      options.limit = parsePositiveInteger(argv[++index], "--limit");
    } else if (token === "--data") {
      options.data = argv[++index];
    } else if (token === "--cache") {
      options.cache = argv[++index];
    } else if (token === "--stores") {
      options.stores = argv[++index];
    } else if (token === "--concurrency") {
      options.concurrency = parsePositiveInteger(argv[++index], "--concurrency");
    } else if (token === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!options.help && !options.model) {
    throw new Error("Pass --model.");
  }

  return options;
}

function fill(template, ...values) {
  return values.reduce((text, value) => text.replace("{}", () => String(value)), template);
}

// LoCoMo dates look like "1:56 pm on 8 May, 2023".
function parseSessionDate(value) {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm) on (\d{1,2}) (\w+),? (\d{4})$/i.exec(String(value).trim());

  if (!match) {
    throw new Error(`Unrecognized LoCoMo date: ${value}`);
  }

  const [, hour, minute, half, day, month, year] = match;
  const monthIndex = new Date(`${month} 1, 2000`).getMonth();
  const hours = (Number(hour) % 12) + (half.toLowerCase() === "pm" ? 12 : 0);

  return new Date(Date.UTC(Number(year), monthIndex, Number(day), hours, Number(minute))).toISOString();
}

// Turn text only: MemoryTax gives memory methods no photo captions.
function loadConversation(data, sampleId) {
  const sample = data.find((item) => item.sample_id === sampleId);
  const sessions = [];

  for (let number = 1; sample.conversation[`session_${number}`]; number += 1) {
    const date = sample.conversation[`session_${number}_date_time`];
    const turns = sample.conversation[`session_${number}`].map((turn) => ({
      id: turn.dia_id,
      speaker: turn.speaker,
      text: turn.text,
    }));

    sessions.push({ number, date, timestamp: parseSessionDate(date), turns });
  }

  const questions = sample.qa
    .filter((qa) => CATEGORIES[qa.category])
    .map((qa, index) => ({ id: `${sampleId}-q${index}`, question: qa.question, answer: String(qa.answer), category: CATEGORIES[qa.category] }));

  return { sessions, questions, speakers: [sample.conversation.speaker_a, sample.conversation.speaker_b] };
}

function formatSession(session, turns = session.turns) {
  return `Session ${session.number} (${session.date}):\n${turns.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n")}`;
}

function tokenize(value) {
  return (
    String(value || "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  );
}

// Okapi BM25, k1 = 1.5, b = 0.75, as in eval-retrieval.cjs.
function bm25Context(question, sessions) {
  const turns = sessions.flatMap((session) => session.turns.map((turn, position) => ({ session, position, turn })));
  const tokenized = turns.map((item) => tokenize(`${item.turn.speaker} ${item.turn.text}`));
  const averageLength = tokenized.reduce((sum, tokens) => sum + tokens.length, 0) / tokenized.length;
  const documentFrequency = new Map();

  for (const tokens of tokenized) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const queryTokens = [...new Set(tokenize(question))];
  const ranked = turns
    .map((item, index) => {
      const frequencies = new Map();
      let score = 0;

      for (const token of tokenized[index]) {
        frequencies.set(token, (frequencies.get(token) || 0) + 1);
      }

      for (const token of queryTokens) {
        const frequency = frequencies.get(token) || 0;

        if (frequency) {
          const matching = documentFrequency.get(token);
          const idf = Math.log(1 + (turns.length - matching + 0.5) / (matching + 0.5));
          score += idf * ((frequency * 2.5) / (frequency + 1.5 * (0.25 + 0.75 * (tokenized[index].length / averageLength))));
        }
      }

      return { item, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  const keep = new Set();

  for (const { item } of ranked) {
    for (let position = item.position - 2; position <= item.position + 2; position += 1) {
      if (position >= 0 && position < item.session.turns.length) {
        keep.add(`${item.session.number}:${position}`);
      }
    }
  }

  return sessions
    .map((session) => ({ session, turns: session.turns.filter((_, position) => keep.has(`${session.number}:${position}`)) }))
    .filter((group) => group.turns.length)
    .map((group) => formatSession(group.session, group.turns))
    .join("\n\n");
}

function costOf(model, usage) {
  const price = PRICES[model];
  return ((usage.input - usage.cached) * price.input + usage.cached * price.cached + usage.output * price.output) / 1e6;
}

function addUsage(total, usage) {
  for (const field of ["input", "cached", "output", "calls"]) {
    total[field] = (total[field] || 0) + (usage[field] || 0);
  }

  return total;
}

async function request(url, headers, body) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
      const text = await response.text();

      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`), { status: response.status });
      }

      return JSON.parse(text);
    } catch (error) {
      const retryable = !error.status || error.status === 429 || error.status >= 500;

      if (!retryable || attempt >= 6) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
}

// One model turn. Messages use a provider-neutral shape; each provider keeps its own
// raw assistant message so tool loops (and Claude's thinking blocks) replay unchanged.
async function complete(model, { system, messages, tools, json = false }) {
  if (model.startsWith("claude-")) {
    const body = {
      model,
      max_tokens: 16000,
      // MemoryTax runs Opus 5.5 at reasoning effort high; thinking is always on for this model.
      output_config: { effort: "high" },
      system,
      messages: messages.map((message) => message.anthropic || { role: message.role, content: message.content }),
    };

    if (tools) {
      body.tools = tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    }

    const response = await request(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body,
    );
    const toolCalls = response.content.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id, name: block.name, input: block.input }));

    return {
      text: response.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim(),
      toolCalls,
      assistant: { anthropic: { role: "assistant", content: response.content } },
      toolResults: (results) => [{ anthropic: { role: "user", content: results.map((result) => ({ type: "tool_result", tool_use_id: result.id, content: result.content })) } }],
      usage: {
        input: response.usage.input_tokens + (response.usage.cache_read_input_tokens || 0) + (response.usage.cache_creation_input_tokens || 0),
        cached: response.usage.cache_read_input_tokens || 0,
        output: response.usage.output_tokens,
        calls: 1,
      },
    };
  }

  // GPT-6 Luna takes function tools with reasoning effort only on the Responses API.
  if (model === "gpt-6-luna") {
    const body = {
      model,
      instructions: system,
      input: messages.flatMap((message) => message.responses || [{ role: message.role, content: message.content }]),
      reasoning: { effort: "high" },
      max_output_tokens: 16000,
      store: false,
      include: ["reasoning.encrypted_content"],
    };

    if (tools) {
      body.tools = tools.map((tool) => ({ type: "function", ...tool }));
    }

    const response = await request("https://api.openai.com/v1/responses", { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body);
    const toolCalls = response.output
      .filter((item) => item.type === "function_call")
      .map((item) => {
        let input = null;

        try {
          input = JSON.parse(item.arguments);
        } catch {
          input = null;
        }

        return { id: item.call_id, name: item.name, input };
      });

    return {
      text: response.output
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content.filter((part) => part.type === "output_text").map((part) => part.text))
        .join("")
        .trim(),
      toolCalls,
      assistant: { responses: response.output },
      toolResults: (results) => [{ responses: results.map((result) => ({ type: "function_call_output", call_id: result.id, output: result.content })) }],
      usage: {
        input: response.usage.input_tokens,
        cached: response.usage.input_tokens_details?.cached_tokens || 0,
        output: response.usage.output_tokens,
        calls: 1,
      },
    };
  }

  const body = {
    model,
    messages: [...(system ? [{ role: "system", content: system }] : []), ...messages.map((message) => message.openai || { role: message.role, content: message.content })],
    temperature: 0,
    max_tokens: json ? 200 : 1000,
  };

  if (json) {
    body.response_format = { type: "json_object" };
  }

  if (tools) {
    body.tools = tools.map((tool) => ({ type: "function", function: tool }));
  }

  const response = await request("https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body);
  const message = response.choices[0].message;
  const toolCalls = (message.tool_calls || []).map((call) => {
    let input = null;

    try {
      input = JSON.parse(call.function.arguments);
    } catch {
      input = null;
    }

    return { id: call.id, name: call.function.name, input };
  });

  return {
    text: String(message.content || "").trim(),
    toolCalls,
    assistant: { openai: message },
    toolResults: (results) => results.map((result) => ({ openai: { role: "tool", tool_call_id: result.id, content: result.content } })),
    usage: {
      input: response.usage.prompt_tokens,
      cached: response.usage.prompt_tokens_details?.cached_tokens || 0,
      output: response.usage.completion_tokens,
      calls: 1,
    },
  };
}

// Writes one store per model into a sandbox Lagoon, session by session, and reuses it on reruns.
async function buildHippocampStore(model, conversation, storeRoot) {
  const manifestPath = path.join(storeRoot, "build.json");

  if (fsSync.existsSync(manifestPath)) {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"));
  }

  await fs.rm(storeRoot, { recursive: true, force: true });
  const usage = {};
  let events = 0;

  for (const session of conversation.sessions) {
    const messages = [
      {
        role: "user",
        content: `Conversation between ${conversation.speakers.join(" and ")}. Session date: ${session.date}.\n\n${formatSession(session)}`,
      },
    ];

    for (let round = 0; round < 8; round += 1) {
      const turn = await complete(model, { system: WRITE_SYSTEM, messages, tools: [APPEND_EVENT_TOOL] });
      addUsage(usage, turn.usage);

      if (!turn.toolCalls.length) {
        break;
      }

      const results = [];

      for (const call of turn.toolCalls) {
        const input = call.input || {};
        const keywords = Array.isArray(input.keywords) ? input.keywords.slice(0, 8) : [];

        if (call.name !== "append_event" || !input.title || !input.content || !keywords.length) {
          results.push({ id: call.id, content: "Error: append_event needs title, 1-8 keywords, and content." });
          continue;
        }

        // The event is stamped when the session happened, as a live agent's write would be.
        const result = await memory.appendEvent({
          scope: "project",
          title: input.title,
          keywords,
          content: input.content,
          projectRoot: storeRoot,
          sync: false,
          date: session.timestamp.slice(0, 10),
          timestamp: session.timestamp,
          agent: model,
        });
        events += 1;
        results.push({ id: call.id, content: `Appended event ${result.timestamp}.` });
      }

      messages.push(turn.assistant, ...turn.toolResults(results));
    }

    console.error(`  built session ${session.number}/${conversation.sessions.length}: ${events} events so far`);
  }

  const build = { model, events, usage, cost: costOf(model, usage) };
  await fs.writeFile(manifestPath, `${JSON.stringify(build, null, 2)}\n`);
  return build;
}

async function hippocampContext(question, storeRoot, topK) {
  const search = await memory.searchMemory({ query: question, scope: "project", projectRoot: storeRoot, maxResults: topK });

  return search.results.map((result) => `${result.heading ? `${result.id} — ${result.heading}` : result.path}\n${result.snippet}`).join("\n\n");
}

function percent(rows) {
  return rows.length ? Math.round((rows.filter((row) => row.correct).length / rows.length) * 100) : 0;
}

async function run(options) {
  if (!fsSync.existsSync(options.data)) {
    throw new Error(`Missing ${options.data}. Run with --help for the download command.`);
  }

  const conversation = loadConversation(JSON.parse(await fs.readFile(options.data, "utf8")), "conv-26");
  const all = conversation.questions;
  const limit = Math.min(options.limit || all.length, all.length);
  const questions = Array.from({ length: limit }, (_, index) => all[Math.floor((index * all.length) / limit)]);
  const storeRoot = path.resolve(options.stores, options.model);
  const promptHash = (prompt) => crypto.createHash("sha1").update(prompt).digest("hex").slice(0, 12);
  const done = new Map();

  // Every store lives in its own sandbox Lagoon, never the user's.
  process.env.HIPPOCAMP_GLOBAL_ROOT = path.join(storeRoot, "lagoon");

  if (fsSync.existsSync(options.cache)) {
    for (const line of (await fs.readFile(options.cache, "utf8")).split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      done.set(`${row.system}|${row.model}|${row.id}|${row.promptHash}`, row);
    }
  }

  let build = null;

  if (options.systems.includes("hippocamp")) {
    if (options.dryRun && !fsSync.existsSync(path.join(storeRoot, "build.json"))) {
      const chars = conversation.sessions.reduce((sum, session) => sum + formatSession(session).length, 0);
      console.error(`hippocamp store for ${options.model} not built; build reads about ${Math.round(chars / 4)} tokens over ${conversation.sessions.length} calls or more`);
    } else {
      if (!options.dryRun) {
        console.error(`Building hippocamp store for ${options.model}`);
      }

      build = await buildHippocampStore(options.model, conversation, storeRoot);
      console.error(`hippocamp store: ${build.events} events, build $${build.cost.toFixed(3)}`);
    }
  }

  const jobs = [];
  const current = new Map();

  for (const system of options.systems) {
    if (system === "hippocamp" && !build) {
      continue;
    }

    for (const item of questions) {
      const context =
        system === "full"
          ? conversation.sessions.map((session) => formatSession(session)).join("\n\n")
          : system === "bm25"
            ? bm25Context(item.question, conversation.sessions)
            : await hippocampContext(item.question, storeRoot, options.topK);
      const prompt = fill(ANSWER_USER, item.question, context);
      const key = `${system}|${options.model}|${item.id}|${promptHash(prompt)}`;

      current.set(`${system}|${item.id}`, key);

      if (!done.has(key)) {
        jobs.push({ system, item, prompt, key });
      }
    }
  }

  console.error(`${questions.length} questions, ${jobs.length} new jobs; model ${options.model}, judge ${JUDGE}`);

  for (const system of options.systems) {
    const chars = jobs.filter((job) => job.system === system).reduce((sum, job) => sum + job.prompt.length, 0);
    console.error(`  ${system}: ${Math.round(chars / 4)} answer prompt tokens (estimate)`);
  }

  if (options.dryRun) {
    return;
  }

  await fs.mkdir(path.dirname(path.resolve(options.cache)), { recursive: true });
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const answer = await complete(options.model, { system: ANSWER_SYSTEM, messages: [{ role: "user", content: job.prompt }] });
      let correct = false;
      let verdict = "";

      // Empty answers count as wrong without a judge call.
      if (answer.text) {
        // Mem0's judge sends the rubric as the only, user, message.
        const judged = await complete(JUDGE, {
          messages: [{ role: "user", content: fill(JUDGE_PROMPT, job.item.question, job.item.answer, answer.text) }],
          json: true,
        });
        verdict = judged.text;

        try {
          correct = String(JSON.parse(verdict).label).toUpperCase() === "CORRECT";
        } catch {
          correct = /\bCORRECT\b/.test(verdict) && !/\bWRONG\b/.test(verdict);
        }
      }

      const row = {
        system: job.system,
        model: options.model,
        id: job.item.id,
        category: job.item.category,
        correct,
        promptHash: job.key.split("|").pop(),
        contextTokens: Math.round(job.prompt.length / 4),
        usage: answer.usage,
        cost: costOf(options.model, answer.usage),
        question: job.item.question,
        gold: job.item.answer,
        answer: answer.text,
        verdict,
      };

      await fs.appendFile(options.cache, `${JSON.stringify(row)}\n`);
      done.set(job.key, row);

      if (++finished % 20 === 0) {
        console.error(`progress ${finished}/${jobs.length}`);
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, worker));

  const categories = Object.values(CATEGORIES);
  console.log(`LoCoMo conv-26, ${questions.length} questions, model ${options.model}, judge ${JUDGE}\n`);
  console.log(`${"system".padEnd(10)} ${categories.map((name) => name.padStart(11)).join(" ")}         all   build $  per q $  context tok`);

  for (const system of options.systems) {
    const rows = questions.map((item) => done.get(current.get(`${system}|${item.id}`))).filter(Boolean);

    if (!rows.length) {
      continue;
    }

    const byCategory = categories.map((name) => `${percent(rows.filter((row) => row.category === name))}`.padStart(11));
    const perQuestion = rows.reduce((sum, row) => sum + row.cost, 0) / rows.length;
    const context = Math.round(rows.reduce((sum, row) => sum + row.contextTokens, 0) / rows.length);
    const buildCost = system === "hippocamp" && build ? build.cost.toFixed(3) : "-";

    console.log(
      `${system.padEnd(10)} ${byCategory.join(" ")} ${`${percent(rows)}`.padStart(11)} ${buildCost.padStart(9)} ${perQuestion.toFixed(5).padStart(8)} ${`${context}`.padStart(12)}  (${rows.length} graded)`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  await run(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { PRICES, complete, costOf };
