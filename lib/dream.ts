import { AGENTS_ROOT, EVENTS_ROOT, SHARED_CONTEXT_PATH, createDefaultSharedContext, parseEventEntries } from "@/lib/memory";
import { getFile, listDirectory } from "@/lib/github";
import { NotFoundError } from "@/lib/errors";
import type { DreamResult, DreamSummary, ParsedEventEntry } from "@/lib/types";

const MAX_RECENT_EVENTS = 20;
const MAX_AGENT_FILES = 10;

function unique(values: string[]) {
  return [...new Set(values)];
}

function toBulletSection(title: string, items: string[]) {
  const normalizedItems = unique(items.filter(Boolean)).slice(0, 8);

  if (!normalizedItems.length) {
    return `## ${title}\n\n- None yet.\n`;
  }

  return `## ${title}\n\n${normalizedItems.map((item) => `- ${item}`).join("\n")}\n`;
}

async function listEventFilesDescending() {
  const items = await listDirectory(EVENTS_ROOT);

  return items
    .filter((item) => item.type === "file" && item.name.endsWith(".md"))
    .sort((left, right) => right.name.localeCompare(left.name));
}

async function listAgentFiles() {
  const items = await listDirectory(AGENTS_ROOT);

  return items
    .filter((item) => item.type === "file" && item.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_AGENT_FILES);
}

async function loadRecentEvents(): Promise<{ entries: ParsedEventEntry[]; sourceFiles: string[] }> {
  try {
    const eventFiles = await listEventFilesDescending();
    const entries: ParsedEventEntry[] = [];
    const sourceFiles: string[] = [];

    for (const file of eventFiles) {
      if (entries.length >= MAX_RECENT_EVENTS) {
        break;
      }

      const eventFile = await getFile(file.path);
      sourceFiles.push(eventFile.path);
      const parsedEntries = parseEventEntries(eventFile.content, eventFile.path);
      parsedEntries.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
      entries.push(...parsedEntries);
    }

    entries.sort((left, right) => right.timestamp.localeCompare(left.timestamp));

    return {
      entries: entries.slice(0, MAX_RECENT_EVENTS),
      sourceFiles,
    };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return { entries: [], sourceFiles: [] };
    }

    throw error;
  }
}

async function loadAgentSnapshots() {
  try {
    const agentFiles = await listAgentFiles();
    return Promise.all(agentFiles.map((item) => getFile(item.path)));
  } catch (error) {
    if (error instanceof NotFoundError) {
      return [];
    }

    throw error;
  }
}

function summarizeEvents(entries: ParsedEventEntry[], agentFiles: { name: string; content: string }[]): DreamSummary {
  const currentState = entries
    .slice(0, 5)
    .map((entry) => `${entry.agent} on ${entry.project ?? "unknown project"}: ${entry.whatChanged}`);

  const keyFacts = [
    entries.length ? `${entries.length} recent event entries were reviewed.` : "No event history exists yet.",
    ...unique(entries.map((entry) => entry.project).filter(Boolean) as string[]).map(
      (project) => `Tracked project: ${project}`,
    ),
    ...unique(entries.map((entry) => entry.agent)).map((agent) => `Active agent: ${agent}`),
    ...agentFiles.map((agentFile) => `Working memory present: ${agentFile.name}`),
  ];

  const recentDecisions = entries
    .filter((entry) => entry.why && entry.impact)
    .slice(0, 5)
    .map((entry) => `${entry.type} by ${entry.agent}: ${entry.why} Impact: ${entry.impact}`);

  const openThreads = entries
    .map((entry) => entry.next)
    .filter((value): value is string => Boolean(value && value !== "-"))
    .slice(0, 6);

  return {
    currentState,
    keyFacts,
    recentDecisions,
    openThreads,
  };
}

function renderSharedContext(summary: DreamSummary) {
  const sections = [
    "# Shared Context\n",
    toBulletSection("Current State", summary.currentState),
    toBulletSection("Key Facts", summary.keyFacts),
    toBulletSection("Recent Decisions", summary.recentDecisions),
    toBulletSection("Open Threads", summary.openThreads),
  ];

  return `${sections.join("\n").trim()}\n`;
}

export async function buildDreamContext(): Promise<DreamResult> {
  const [{ entries, sourceFiles }, agentFiles] = await Promise.all([loadRecentEvents(), loadAgentSnapshots()]);
  const summary = summarizeEvents(entries, agentFiles);

  return {
    content: entries.length || agentFiles.length ? renderSharedContext(summary) : createDefaultSharedContext(),
    summary,
    eventCount: entries.length,
    sourceFiles: unique([...sourceFiles, ...agentFiles.map((file) => file.path)]),
  };
}

export { SHARED_CONTEXT_PATH };
