import path from "node:path";
import { ValidationError } from "@/lib/errors";
import { getFile, listDirectory } from "@/lib/github";
import type {
  AppendEventInput,
  SearchResult,
  UpdateAgentInput,
  UpsertMemoryFileInput,
} from "@/lib/types";

export const MEMORY_ROOT = ".hippocamp";
export const EVENTS_ROOT = `${MEMORY_ROOT}/events`;
export const AGENTS_ROOT = `${MEMORY_ROOT}/agents`;
export const SHARED_ROOT = `${MEMORY_ROOT}/shared`;

const MAX_SEARCH_RESULTS = 20;

function assertNonEmptyString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${field} is required.`);
  }

  return value.trim();
}

export function sanitizeAgentName(value: unknown) {
  const agent = assertNonEmptyString(value, "agent");

  if (!/^[a-zA-Z0-9._-]+$/.test(agent)) {
    throw new ValidationError("agent must contain only letters, numbers, dots, underscores, or hyphens.");
  }

  return agent;
}

export function normalizeMemoryPath(rawPath: string | null | undefined, fallback = MEMORY_ROOT) {
  const candidate = rawPath?.trim() ? rawPath : fallback;
  const cleaned = candidate.replace(/^\/+/, "");
  const normalized = path.posix.normalize(cleaned);

  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ValidationError(`path must be a safe relative path under ${MEMORY_ROOT}/.`);
  }

  if (normalized !== MEMORY_ROOT && !normalized.startsWith(`${MEMORY_ROOT}/`)) {
    throw new ValidationError(`path must stay under ${MEMORY_ROOT}/.`);
  }

  return normalized;
}

export function validateAppendEventInput(input: unknown): AppendEventInput {
  if (!input || typeof input !== "object") {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const body = input as Record<string, unknown>;

  return {
    agent: sanitizeAgentName(body.agent),
    type: assertNonEmptyString(body.type, "type"),
    project: typeof body.project === "string" && body.project.trim() ? body.project.trim() : undefined,
    commit: typeof body.commit === "string" && body.commit.trim() ? body.commit.trim() : undefined,
    whatChanged: assertNonEmptyString(body.whatChanged, "whatChanged"),
    why: typeof body.why === "string" && body.why.trim() ? body.why.trim() : undefined,
    impact: typeof body.impact === "string" && body.impact.trim() ? body.impact.trim() : undefined,
    next: typeof body.next === "string" && body.next.trim() ? body.next.trim() : undefined,
  };
}

export function validateUpdateAgentInput(input: unknown): UpdateAgentInput {
  if (!input || typeof input !== "object") {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const body = input as Record<string, unknown>;
  const content = assertNonEmptyString(body.content, "content");

  return {
    agent: sanitizeAgentName(body.agent),
    content: content.endsWith("\n") ? content : `${content}\n`,
  };
}

export function validateUpsertMemoryFileInput(input: unknown): UpsertMemoryFileInput {
  if (!input || typeof input !== "object") {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const body = input as Record<string, unknown>;
  const filePath = assertNonEmptyString(body.path, "path");
  const content = assertNonEmptyString(body.content, "content");

  return {
    path: normalizeMemoryPath(filePath),
    content: content.endsWith("\n") ? content : `${content}\n`,
  };
}

export function getDailyEventPath(date: string) {
  return `${EVENTS_ROOT}/${date}.md`;
}

export function getAgentPath(agent: string) {
  return `${AGENTS_ROOT}/${agent}.md`;
}

export function createDefaultAgentFile(agent: string) {
  return `# Agent: ${agent}

## Current Focus

## Recent Activity

## Open Questions

## Next Actions
`;
}

export function formatEventEntry(input: AppendEventInput & { timestamp: string }) {
  const lines = [
    `## ${input.timestamp} — ${input.type}`,
    `Agent: ${input.agent}`,
  ];

  if (input.project) {
    lines.push(`Project: ${input.project}`);
  }

  if (input.commit) {
    lines.push(`Commit: ${input.commit}`);
  }

  lines.push(
    "",
    "What changed:",
    input.whatChanged,
    "",
    "Why:",
    input.why ?? "-",
    "",
    "Impact:",
    input.impact ?? "-",
    "",
    "Next:",
    input.next ?? "-",
  );

  return `${lines.join("\n").trim()}\n`;
}

export function appendEventDocument(currentContent: string | null, date: string, entry: string) {
  if (!currentContent || !currentContent.trim()) {
    return `# Events — ${date}\n\n${entry.trim()}\n`;
  }

  return `${currentContent.trimEnd()}\n\n${entry.trim()}\n`;
}

function normalizeSnippetWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function createSearchSnippet(content: string, query: string) {
  const haystack = content.toLowerCase();
  const needle = query.toLowerCase();
  const index = haystack.indexOf(needle);

  if (index < 0) {
    return null;
  }

  const radius = 90;
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";

  return `${prefix}${normalizeSnippetWhitespace(content.slice(start, end))}${suffix}`;
}

export async function collectMarkdownFiles(rootPath = MEMORY_ROOT): Promise<string[]> {
  const items = await listDirectory(rootPath);
  const files = await Promise.all(
    items.map(async (item) => {
      if (item.type === "dir") {
        return collectMarkdownFiles(item.path);
      }

      return item.path.endsWith(".md") ? [item.path] : [];
    }),
  );

  return files.flat().sort();
}

export async function searchMemory(query: string): Promise<{ results: SearchResult[]; scannedFiles: number }> {
  const trimmedQuery = assertNonEmptyString(query, "q");
  const markdownFiles = await collectMarkdownFiles();
  const results: SearchResult[] = [];

  for (const filePath of markdownFiles) {
    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }

    const file = await getFile(filePath);
    const snippet = createSearchSnippet(file.content, trimmedQuery);

    if (snippet) {
      results.push({
        path: file.path,
        snippet,
      });
    }
  }

  return {
    results,
    scannedFiles: markdownFiles.length,
  };
}
