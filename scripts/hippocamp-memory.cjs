const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const DEFAULT_GLOBAL_FILES = [
  "identity.md",
  "how_i_work.md",
  "preferences.md",
  "open_loops.md",
];

const DEFAULT_PROJECT_FILES = [
  "project.md",
  "current_state.md",
  "open_threads.md",
];

const EVENT_INDEX_VERSION = 1;
const EVENT_SEARCH_THRESHOLD = 20;
const PROCESS_SESSION_ID = `mcp-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

const AGENT_NAME_ALIASES = {
  claude: "claude",
  "claude-code": "claude",
  "claude code": "claude",
  anthropic: "claude",
  codex: "codex",
  "openai-codex": "codex",
  cursor: "cursor",
  "cursor-ide": "cursor",
  windsurf: "windsurf",
  grok: "grok",
  "grok-build": "grok",
  vscode: "vscode",
  "visual-studio-code": "vscode",
};

function expandHomePath(value) {
  if (!value) {
    return value;
  }

  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function getGlobalRepoRoot() {
  return path.resolve(expandHomePath(process.env.HIPPOCAMP_GLOBAL_ROOT || "~/.lagoon"));
}

function getGlobalRoot() {
  return getGlobalRepoRoot();
}

function getProjectRoot(projectRoot) {
  return path.resolve(expandHomePath(projectRoot || process.env.HIPPOCAMP_PROJECT_ROOT || process.cwd()));
}

function findGitRootSync(startPath) {
  let current = path.resolve(startPath);

  while (true) {
    if (fsSync.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function findRepositoryRootSync(startPath) {
  const gitRoot = findGitRootSync(startPath);

  if (!gitRoot) {
    return null;
  }

  const gitFile = path.join(gitRoot, ".git");

  if (!fsSync.statSync(gitFile).isFile()) {
    return gitRoot;
  }

  const match = fsSync.readFileSync(gitFile, "utf8").trim().match(/^gitdir:\s*(.+)$/i);

  if (!match) {
    return gitRoot;
  }

  const gitDir = path.resolve(gitRoot, match[1]);
  const commonDirFile = path.join(gitDir, "commondir");

  if (!fsSync.existsSync(commonDirFile)) {
    return gitRoot;
  }

  const commonDir = path.resolve(gitDir, fsSync.readFileSync(commonDirFile, "utf8").trim());
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : gitRoot;
}

function slugifyProjectName(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "project";
}

function getProjectSlug(projectRoot) {
  const resolvedProjectRoot = getProjectRoot(projectRoot);
  const repositoryRoot = findRepositoryRootSync(resolvedProjectRoot);
  return slugifyProjectName(path.basename(repositoryRoot || resolvedProjectRoot));
}

function getScopeRoot(scope, projectRoot) {
  if (scope === "global") {
    return getGlobalRoot();
  }

  if (scope === "project") {
    return path.join(getGlobalRoot(), "projects", getProjectSlug(projectRoot));
  }

  throw new Error(`Unsupported scope: ${scope}`);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }

  return value.trim();
}

function normalizeRelativePath(value) {
  const candidate = requireNonEmptyString(value, "path");
  const normalized = path.posix.normalize(candidate.replace(/^\/+/, ""));

  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("path must be a safe relative path.");
  }

  if (normalized.split("/").includes(".git")) {
    throw new Error("path must not target git internals.");
  }

  return normalized;
}

function resolveScopedPath(scope, relativePath, projectRoot) {
  const root = getScopeRoot(scope, projectRoot);
  const normalizedPath = normalizeRelativePath(relativePath);
  const absolutePath = path.resolve(root, normalizedPath);
  const allowedPrefix = `${root}${path.sep}`;

  if (absolutePath !== root && !absolutePath.startsWith(allowedPrefix)) {
    throw new Error("path escapes the memory root.");
  }

  return {
    root,
    path: normalizedPath,
    absolutePath,
  };
}

function assertPathInScope(scopeRoot, targetPath) {
  const absolutePath = path.resolve(targetPath);
  const allowedPrefix = `${scopeRoot}${path.sep}`;

  if (absolutePath !== scopeRoot && !absolutePath.startsWith(allowedPrefix)) {
    throw new Error("path escapes the memory root.");
  }

  return absolutePath;
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function statIfExists(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function ensureTrailingNewline(content) {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeSearchText(value) {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function normalizeCue(value) {
  return tokenizeSearchText(value).join("-");
}

function normalizeCueList(cues) {
  const values = Array.isArray(cues) ? cues : [];
  return [...new Set(values.map(normalizeCue).filter(Boolean))];
}

function splitInlineCueValues(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasCuesSection(content) {
  return content.split(/\r?\n/).some((line) => /^Cues:\s*/i.test(line.trim()));
}

function formatCuesSection(cues) {
  const normalizedCues = normalizeCueList(cues);

  if (!normalizedCues.length) {
    return "";
  }

  return ["Cues:", ...normalizedCues.map((cue) => `- ${cue}`)].join("\n");
}

function normalizeAgentName(value) {
  const raw = String(value || "").trim().toLowerCase();

  if (!raw) {
    return null;
  }

  const withoutVersion = raw.replace(/\/.*$/, "").replace(/\s+v?\d+(\.\d+)*$/i, "").trim();
  const compact = withoutVersion.replace(/_/g, "-");

  if (AGENT_NAME_ALIASES[compact]) {
    return AGENT_NAME_ALIASES[compact];
  }

  if (AGENT_NAME_ALIASES[withoutVersion]) {
    return AGENT_NAME_ALIASES[withoutVersion];
  }

  const firstToken = compact.split(/[\s/]+/).filter(Boolean)[0];

  if (firstToken && AGENT_NAME_ALIASES[firstToken]) {
    return AGENT_NAME_ALIASES[firstToken];
  }

  const slug = normalizeCue(compact);

  return slug || null;
}

function detectAgentFromEnvironment() {
  if (process.env.CLAUDE_CODE || process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return "claude";
  }

  if (process.env.CODEX_HOME || process.env.CODEX_CI || process.env.OPENAI_CODEX) {
    return "codex";
  }

  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT || process.env.CURSOR_SESSION_ID) {
    return "cursor";
  }

  if (process.env.GROK_HOME || process.env.GROK_BUILD || process.env.XAI_GROK) {
    return "grok";
  }

  return null;
}

function resolveWriteAttribution({ agent, session, clientName } = {}) {
  const resolvedAgent =
    normalizeAgentName(agent) ||
    normalizeAgentName(process.env.HIPPOCAMP_AGENT) ||
    normalizeAgentName(clientName) ||
    detectAgentFromEnvironment();

  const envSession = String(process.env.HIPPOCAMP_SESSION || "").trim();
  const resolvedSession = String(session || "").trim() || envSession || PROCESS_SESSION_ID;

  return {
    agent: resolvedAgent || null,
    session: resolvedSession || null,
  };
}

function formatAttributionSection({ agent, session } = {}) {
  const lines = [];

  if (agent) {
    lines.push(`Agent: ${agent}`);
  }

  if (session) {
    lines.push(`Session: ${session}`);
  }

  return lines.join("\n");
}

function extractAttributionFromEventLines(lines) {
  let agent = null;
  let session = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (agent || session) {
        break;
      }

      continue;
    }

    const agentMatch = trimmed.match(/^Agent:\s*(.+)$/i);

    if (agentMatch) {
      agent = normalizeAgentName(agentMatch[1]) || agentMatch[1].trim();
      continue;
    }

    const sessionMatch = trimmed.match(/^Session:\s*(.+)$/i);

    if (sessionMatch) {
      session = sessionMatch[1].trim();
      continue;
    }

    // Provenance lines sit at the top of the body; stop at cues or free text.
    break;
  }

  return {
    agent: agent || null,
    session: session || null,
  };
}

async function ensureParentDirectory(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function runGit(args, cwd) {
  try {
    const result = await execFileAsync("git", args, { cwd });
    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.trim() || "",
      stderr: error.stderr?.trim() || error.message,
      code: error.code,
    };
  }
}

async function getGitRepoRoot(startPath) {
  const result = await runGit(["rev-parse", "--show-toplevel"], startPath);

  if (!result.ok || !result.stdout) {
    return null;
  }

  return result.stdout;
}

async function syncMemory({ scope, projectRoot, paths, message }) {
  const repoCandidate = getGlobalRepoRoot();
  const repoRoot = await getGitRepoRoot(repoCandidate);
  const scopeRoot = getScopeRoot(scope, projectRoot);

  if (!repoRoot) {
    return {
      attempted: false,
      skipped: true,
      reason: "not_git_repo",
      repoRoot: repoCandidate,
    };
  }

  const repoRelativePaths = paths.map((item) => {
    const relativePath =
      path.relative(repoRoot, assertPathInScope(scopeRoot, item)).split(path.sep).join(path.posix.sep) || ".";

    if (relativePath === ".") {
      throw new Error("path must point to a memory file or directory inside the Lagoon root.");
    }

    if (relativePath.split("/").includes(".git")) {
      throw new Error("path must not target git internals.");
    }

    return relativePath;
  });

  const addResult = await runGit(["add", "--", ...repoRelativePaths], repoRoot);

  if (!addResult.ok) {
    throw new Error(addResult.stderr || "git add failed.");
  }

  const diffResult = await runGit(["diff", "--cached", "--name-only", "--", ...repoRelativePaths], repoRoot);

  if (!diffResult.ok) {
    throw new Error(diffResult.stderr || "git diff failed.");
  }

  if (!diffResult.stdout) {
    return {
      attempted: true,
      skipped: true,
      reason: "no_changes_to_commit",
      repoRoot,
    };
  }

  const commitResult = await runGit(["commit", "-m", message, "--", ...repoRelativePaths], repoRoot);

  if (!commitResult.ok) {
    throw new Error(commitResult.stderr || "git commit failed.");
  }

  const upstreamResult = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoRoot);

  if (!upstreamResult.ok) {
    return {
      attempted: true,
      committed: true,
      pushed: false,
      reason: "no_upstream",
      repoRoot,
      commitSummary: commitResult.stdout,
    };
  }

  let pushResult = await runGit(["push"], repoRoot);

  if (!pushResult.ok) {
    const pullResult = await runGit(["pull", "--rebase", "--autostash"], repoRoot);

    if (!pullResult.ok) {
      return {
        attempted: true,
        committed: true,
        pushed: false,
        reason: "pull_rebase_failed",
        repoRoot,
        commitSummary: commitResult.stdout,
        pushError: pushResult.stderr,
        pullError: pullResult.stderr,
      };
    }

    pushResult = await runGit(["push"], repoRoot);

    if (!pushResult.ok) {
      return {
        attempted: true,
        committed: true,
        pushed: false,
        reason: "push_failed",
        repoRoot,
        commitSummary: commitResult.stdout,
        pushError: pushResult.stderr,
      };
    }
  }

  return {
    attempted: true,
    committed: true,
    pushed: true,
    repoRoot,
    commitSummary: commitResult.stdout,
    pushSummary: pushResult.stdout || pushResult.stderr,
  };
}

async function getDefaultSyncPaths(scope, projectRoot) {
  const scopeRoot = getScopeRoot(scope, projectRoot);
  const defaultNames =
    scope === "project" ? [...DEFAULT_PROJECT_FILES, "events"] : [...DEFAULT_GLOBAL_FILES, "events", "projects"];
  const paths = [];

  for (const name of defaultNames) {
    const targetPath = path.join(scopeRoot, name);

    if (await statIfExists(targetPath)) {
      paths.push(targetPath);
    }
  }

  return paths;
}

async function listDirectoryEntries(scope, relativePath, projectRoot) {
  const root = getScopeRoot(scope, projectRoot);
  const targetPath =
    relativePath && relativePath !== "."
      ? resolveScopedPath(scope, relativePath, projectRoot).absolutePath
      : root;

  const directoryStats = await statIfExists(targetPath);

  if (!directoryStats) {
    return [];
  }

  if (!directoryStats.isDirectory()) {
    throw new Error("path must point to a directory.");
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const relativeBase =
    targetPath === root ? "" : path.relative(root, targetPath).split(path.sep).join(path.posix.sep);

  return entries
    .filter((entry) => entry.name !== ".git")
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      path: relativeBase ? path.posix.join(relativeBase, entry.name) : entry.name,
      type: entry.isDirectory() ? "dir" : "file",
    }));
}

async function walkMarkdownFiles(rootPath, currentPath = "") {
  const absolutePath = currentPath ? path.join(rootPath, currentPath) : rootPath;
  const stats = await statIfExists(absolutePath);

  if (!stats || !stats.isDirectory()) {
    return [];
  }

  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const results = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".git") {
      continue;
    }

    const entryPath = currentPath ? path.posix.join(currentPath, entry.name) : entry.name;

    if (entry.isDirectory()) {
      results.push(...(await walkMarkdownFiles(rootPath, entryPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(entryPath);
    }
  }

  return results;
}

function parseEventHeading(line) {
  const heading = line.replace(/^##\s+/, "").trim();
  const match = heading.match(/^(\S+)(?:\s+[—-]\s+(.+))?$/);

  if (!match) {
    return {
      id: normalizeCue(heading) || heading,
      heading,
    };
  }

  return {
    id: match[1],
    heading: match[2]?.trim() || heading,
  };
}

function extractCuesFromEventLines(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(/^Cues:\s*(.*)$/i);

    if (!match) {
      continue;
    }

    const cues = splitInlineCueValues(match[1]);

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const bullet = line.match(/^\s*-\s+(.+?)\s*$/);

      if (bullet) {
        cues.push(bullet[1]);
        continue;
      }

      if (!line.trim()) {
        continue;
      }

      break;
    }

    return normalizeCueList(cues);
  }

  return [];
}

function parseEventBlocks(content) {
  const lines = content.split(/\r?\n/);
  const headingIndexes = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      headingIndexes.push(index);
    }
  }

  return headingIndexes.map((startIndex, index) => {
    const endIndex = headingIndexes[index + 1] ?? lines.length;
    const blockLines = lines.slice(startIndex, endIndex);
    const heading = parseEventHeading(blockLines[0]);
    const bodyLines = blockLines.slice(1);
    const attribution = extractAttributionFromEventLines(bodyLines);

    return {
      id: heading.id,
      heading: heading.heading,
      agent: attribution.agent,
      session: attribution.session,
      cues: extractCuesFromEventLines(bodyLines),
      content: blockLines.join("\n").trim(),
      body: bodyLines.join("\n").trim(),
      startLine: startIndex + 1,
    };
  });
}

function buildEventIndex(markdownContent, markdownPath) {
  return {
    version: EVENT_INDEX_VERSION,
    path: path.posix.basename(markdownPath),
    events: parseEventBlocks(markdownContent).map((event) => {
      const entry = {
        id: event.id,
        heading: event.heading,
        cues: event.cues,
      };

      if (event.agent) {
        entry.agent = event.agent;
      }

      if (event.session) {
        entry.session = event.session;
      }

      return entry;
    }),
  };
}

async function writeEventIndex(markdownPath, markdownRelativePath) {
  const content = (await readFileIfExists(markdownPath)) || "";
  const indexPath = markdownPath.replace(/\.md$/, ".index.json");
  const index = buildEventIndex(content, markdownRelativePath);

  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  return indexPath;
}

function createQueryInfo(query) {
  const original = requireNonEmptyString(query, "query");
  const tokens = tokenizeSearchText(original);

  return {
    original,
    normalized: tokens.join(" "),
    cue: tokens.join("-"),
    tokens,
  };
}

function stripPlural(value) {
  return value.length > 3 && value.endsWith("s") ? value.slice(0, -1) : value;
}

function editDistance(left, right) {
  if (left === right) {
    return 0;
  }

  if (!left.length) {
    return right.length;
  }

  if (!right.length) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const insertion = current[rightIndex] + 1;
      const deletion = previous[rightIndex + 1] + 1;
      const substitution = previous[rightIndex] + (left[leftIndex] === right[rightIndex] ? 0 : 1);
      current.push(Math.min(insertion, deletion, substitution));
    }

    previous = current;
  }

  return previous[right.length];
}

function tokenSimilarity(left, right) {
  if (!left || !right) {
    return 0;
  }

  const normalizedLeft = stripPlural(left);
  const normalizedRight = stripPlural(right);

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  if (
    (normalizedLeft.length >= 4 && normalizedRight.includes(normalizedLeft)) ||
    (normalizedRight.length >= 4 && normalizedLeft.includes(normalizedRight))
  ) {
    return 0.9;
  }

  const maxLength = Math.max(normalizedLeft.length, normalizedRight.length);

  if (maxLength < 4) {
    return 0;
  }

  return 1 - editDistance(normalizedLeft, normalizedRight) / maxLength;
}

function scoreSearchValues(queryInfo, values) {
  const normalizedValues = values
    .map((value) => normalizeSearchText(value))
    .filter(Boolean);

  if (!queryInfo.tokens.length || !normalizedValues.length) {
    return 0;
  }

  const phraseScore = normalizedValues.reduce((bestScore, value) => {
    if (value === queryInfo.normalized || value.replace(/\s+/g, "-") === queryInfo.cue) {
      return Math.max(bestScore, 1);
    }

    if (queryInfo.normalized && value.includes(queryInfo.normalized)) {
      return Math.max(bestScore, 0.92);
    }

    if (queryInfo.normalized && queryInfo.normalized.includes(value)) {
      return Math.max(bestScore, 0.82);
    }

    return bestScore;
  }, 0);

  const valueTokens = [...new Set(normalizedValues.flatMap((value) => value.split(/\s+/)))];
  let exactMatches = 0;
  let fuzzyMatches = 0;

  for (const queryToken of queryInfo.tokens) {
    const bestTokenScore = valueTokens.reduce(
      (bestScore, valueToken) => Math.max(bestScore, tokenSimilarity(queryToken, valueToken)),
      0,
    );

    if (bestTokenScore >= 1) {
      exactMatches += 1;
    }

    if (bestTokenScore >= 0.72) {
      fuzzyMatches += 1;
    }
  }

  const exactScore = (exactMatches / queryInfo.tokens.length) * 0.86;
  const fuzzyScore = (fuzzyMatches / queryInfo.tokens.length) * 0.7;

  return Math.max(phraseScore, exactScore, fuzzyScore);
}

function createFallbackSnippet(content) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

function createSearchSnippet(content, query) {
  const haystack = content.toLowerCase();
  const needle = query.toLowerCase();
  const index = haystack.indexOf(needle);

  if (index < 0) {
    return null;
  }

  const radius = 80;
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  const snippet = content
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();

  return `${prefix}${snippet}${suffix}`;
}

async function readMemoryFile({ scope, path: relativePath, projectRoot }) {
  const target = resolveScopedPath(scope, relativePath, projectRoot);
  const content = await readFileIfExists(target.absolutePath);

  return {
    scope,
    root: target.root,
    path: target.path,
    found: content !== null,
    content,
  };
}

async function writeMemoryFile({ scope, path: relativePath, content, projectRoot, sync = true }) {
  const target = resolveScopedPath(scope, relativePath, projectRoot);
  const nextContent = ensureTrailingNewline(requireNonEmptyString(content, "content"));

  await ensureParentDirectory(target.absolutePath);
  await fs.writeFile(target.absolutePath, nextContent, "utf8");

  const syncResult = sync
    ? await syncMemory({
        scope,
        projectRoot,
        paths: [target.absolutePath],
        message: `hippocamp: update ${scope} memory ${target.path}`,
      })
    : {
        attempted: false,
        skipped: true,
        reason: "sync_disabled",
      };

  return {
    scope,
    root: target.root,
    path: target.path,
    absolutePath: target.absolutePath,
    bytes: Buffer.byteLength(nextContent, "utf8"),
    sync: syncResult,
  };
}

async function appendEvent({
  scope = "project",
  content,
  cues,
  projectRoot,
  sync = true,
  title,
  date = new Date().toISOString().slice(0, 10),
  timestamp = new Date().toISOString(),
  agent,
  session,
  clientName,
}) {
  const body = requireNonEmptyString(content, "content");
  const attribution = resolveWriteAttribution({ agent, session, clientName });
  const normalizedCues = normalizeCueList(cues);
  const cuedBody =
    normalizedCues.length && !hasCuesSection(body)
      ? `${formatCuesSection(normalizedCues)}\n\n${body.trim()}`
      : body.trim();
  const attributionSection = formatAttributionSection(attribution);
  const eventBody = attributionSection ? `${attributionSection}\n\n${cuedBody}` : cuedBody;
  const heading = title ? `## ${timestamp} — ${title.trim()}` : `## ${timestamp}`;
  const eventBlock = `${heading}\n\n${eventBody}\n`;
  const relativePath = `events/${date}.md`;
  const target = resolveScopedPath(scope, relativePath, projectRoot);
  const existing = await readFileIfExists(target.absolutePath);
  const nextContent = existing?.trim()
    ? `${existing.trimEnd()}\n\n${eventBlock.trimEnd()}\n`
    : `# Events — ${date}\n\n${eventBlock.trimEnd()}\n`;

  await ensureParentDirectory(target.absolutePath);
  await fs.writeFile(target.absolutePath, nextContent, "utf8");
  const indexPath = await writeEventIndex(target.absolutePath, target.path);

  const syncResult = sync
    ? await syncMemory({
        scope,
        projectRoot,
        paths: [target.absolutePath, indexPath],
        message: `hippocamp: append ${scope} event ${date}`,
      })
    : {
        attempted: false,
        skipped: true,
        reason: "sync_disabled",
      };

  const parsed = parseEventBlocks(eventBlock)[0];

  return {
    scope,
    root: target.root,
    path: target.path,
    timestamp,
    title: title?.trim() || null,
    agent: parsed?.agent || attribution.agent,
    session: parsed?.session || attribution.session,
    cues: parsed?.cues || [],
    indexPath,
    sync: syncResult,
  };
}

async function readJsonFileIfExists(filePath) {
  const content = await readFileIfExists(filePath);

  if (content === null) {
    return null;
  }

  return JSON.parse(content);
}

async function listEventFiles(root) {
  const eventsDir = path.join(root, "events");
  const stats = await statIfExists(eventsDir);

  if (!stats || !stats.isDirectory()) {
    return {
      eventsDir,
      indexes: [],
      markdownFiles: [],
    };
  }

  const entries = await fs.readdir(eventsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  return {
    eventsDir,
    indexes: files.filter((name) => name.endsWith(".index.json")),
    markdownFiles: files.filter((name) => name.endsWith(".md")),
  };
}

function scoreEventEntry(queryInfo, event) {
  const cueScore = scoreSearchValues(queryInfo, event.cues || []);
  const headingScore = scoreSearchValues(queryInfo, [event.heading || "", event.id || ""]);
  const score = cueScore * 100 + headingScore * 60;
  const match = cueScore >= headingScore ? "cues" : "heading";

  return {
    score,
    match,
  };
}

async function getEventBlockById(markdownPath, eventId) {
  const content = await readFileIfExists(markdownPath);

  if (content === null) {
    return null;
  }

  return parseEventBlocks(content).find((event) => event.id === eventId) || null;
}

async function searchEventIndexes({ scope, root, queryInfo }) {
  const eventFiles = await listEventFiles(root);
  const indexedMarkdownFiles = new Set();
  const candidates = [];

  for (const indexName of eventFiles.indexes) {
    const indexPath = path.join(eventFiles.eventsDir, indexName);
    let index;

    try {
      index = await readJsonFileIfExists(indexPath);
    } catch {
      index = null;
    }

    const markdownName = typeof index?.path === "string" ? index.path : indexName.replace(/\.index\.json$/, ".md");

    if (!index || !Array.isArray(index.events)) {
      continue;
    }

    indexedMarkdownFiles.add(markdownName);

    for (const event of index.events) {
      const eventScore = scoreEventEntry(queryInfo, event);

      if (eventScore.score < EVENT_SEARCH_THRESHOLD) {
        continue;
      }

      candidates.push({
        scope,
        path: `events/${markdownName}`,
        markdownPath: path.join(eventFiles.eventsDir, markdownName),
        id: event.id,
        heading: event.heading,
        cues: normalizeCueList(event.cues),
        score: Math.round(eventScore.score),
        match: eventScore.match,
      });
    }
  }

  for (const markdownName of eventFiles.markdownFiles) {
    if (indexedMarkdownFiles.has(markdownName)) {
      continue;
    }

    const markdownPath = path.join(eventFiles.eventsDir, markdownName);
    const content = await readFileIfExists(markdownPath);

    if (content === null) {
      continue;
    }

    for (const event of parseEventBlocks(content)) {
      const eventScore = scoreEventEntry(queryInfo, event);

      if (eventScore.score < EVENT_SEARCH_THRESHOLD) {
        continue;
      }

      candidates.push({
        scope,
        path: `events/${markdownName}`,
        markdownPath,
        id: event.id,
        heading: event.heading,
        cues: event.cues,
        score: Math.round(eventScore.score),
        match: eventScore.match,
      });
    }
  }

  const results = [];
  const sortedCandidates = candidates.sort((left, right) => right.score - left.score).slice(0, 60);

  for (const candidate of sortedCandidates) {
    const block = await getEventBlockById(candidate.markdownPath, candidate.id);

    if (!block) {
      continue;
    }

    results.push({
      scope: candidate.scope,
      path: candidate.path,
      id: candidate.id,
      heading: candidate.heading,
      cues: candidate.cues,
      score: candidate.score,
      match: candidate.match,
      snippet: createSearchSnippet(block.content, queryInfo.original) || createFallbackSnippet(block.body),
    });
  }

  return {
    scannedFiles: eventFiles.indexes.length + eventFiles.markdownFiles.length - indexedMarkdownFiles.size,
    results,
  };
}

async function searchMarkdownFiles({ scope, root, queryInfo }) {
  const markdownFiles = await walkMarkdownFiles(root);
  const scopedFiles =
    scope === "global"
      ? markdownFiles.filter((relativePath) => !relativePath.startsWith("projects/"))
      : markdownFiles;
  const results = [];
  let scannedFiles = 0;

  for (const relativePath of scopedFiles) {
    if (relativePath.startsWith("events/")) {
      continue;
    }

    scannedFiles += 1;

    const absolutePath = path.join(root, relativePath);
    const content = await fs.readFile(absolutePath, "utf8");
    const pathScore = scoreSearchValues(queryInfo, [relativePath]);
    const bodyScore = scoreSearchValues(queryInfo, [content]);
    const score = pathScore * 70 + bodyScore * 40;

    if (score < EVENT_SEARCH_THRESHOLD) {
      continue;
    }

    results.push({
      scope,
      path: relativePath,
      score: Math.round(score),
      match: pathScore >= bodyScore ? "path" : "body",
      snippet: createSearchSnippet(content, queryInfo.original) || createFallbackSnippet(content),
    });
  }

  return {
    scannedFiles,
    results,
  };
}

async function searchMemory({ query, scope = "both", projectRoot, maxResults = 10 }) {
  const queryInfo = createQueryInfo(query);
  const clampedMaxResults = Math.max(1, Math.min(Number(maxResults) || 10, 20));
  const scopes = scope === "both" ? ["global", "project"] : [scope];
  const results = [];
  let scannedFiles = 0;

  for (const itemScope of scopes) {
    const root = getScopeRoot(itemScope, projectRoot);
    const eventSearch = await searchEventIndexes({ scope: itemScope, root, queryInfo });
    const markdownSearch = await searchMarkdownFiles({ scope: itemScope, root, queryInfo });

    scannedFiles += eventSearch.scannedFiles + markdownSearch.scannedFiles;
    results.push(...eventSearch.results, ...markdownSearch.results);
  }

  const rankedResults = results.sort((left, right) => right.score - left.score).slice(0, clampedMaxResults);

  return {
    query: queryInfo.original,
    scannedFiles,
    results: rankedResults,
  };
}

async function wakeUp({ projectRoot } = {}) {
  const globalRoot = getScopeRoot("global", projectRoot);
  const resolvedProjectRoot = getProjectRoot(projectRoot);
  const projectSlug = getProjectSlug(projectRoot);
  const projectMemoryRoot = getScopeRoot("project", projectRoot);
  const globalFiles = [];
  const projectFiles = [];
  const missing = [];

  for (const relativePath of DEFAULT_GLOBAL_FILES) {
    const file = await readMemoryFile({ scope: "global", path: relativePath, projectRoot });

    if (!file.found) {
      missing.push(`global:${relativePath}`);
      continue;
    }

    globalFiles.push({
      path: relativePath,
      content: file.content,
    });
  }

  for (const relativePath of DEFAULT_PROJECT_FILES) {
    const file = await readMemoryFile({ scope: "project", path: relativePath, projectRoot });

    if (!file.found) {
      missing.push(`project:${relativePath}`);
      continue;
    }

    projectFiles.push({
      path: relativePath,
      content: file.content,
    });
  }

  const sections = [
    "# Hippocamp Wake-Up",
    "",
    `Global root: ${globalRoot}`,
    `Project root: ${resolvedProjectRoot}`,
    `Project slug: ${projectSlug}`,
    `Project memory root: ${projectMemoryRoot}`,
  ];

  if (globalFiles.length) {
    sections.push("", "## Global Memory");

    for (const file of globalFiles) {
      sections.push("", `### ${file.path}`, "", file.content.trimEnd());
    }
  }

  if (projectFiles.length) {
    sections.push("", "## Project Memory");

    for (const file of projectFiles) {
      sections.push("", `### ${file.path}`, "", file.content.trimEnd());
    }
  }

  if (missing.length) {
    sections.push("", "## Missing Files", "", ...missing.map((item) => `- ${item}`));
  }

  return {
    globalRoot,
    projectRoot: resolvedProjectRoot,
    projectSlug,
    projectMemoryRoot,
    missing,
    globalFiles: globalFiles.map((file) => file.path),
    projectFiles: projectFiles.map((file) => file.path),
    text: `${sections.join("\n").trim()}\n`,
  };
}

module.exports = {
  getGlobalRepoRoot,
  getGlobalRoot,
  getProjectRoot,
  getProjectSlug,
  getScopeRoot,
  readMemoryFile,
  writeMemoryFile,
  appendEvent,
  listDirectoryEntries,
  searchMemory,
  syncMemory,
  getDefaultSyncPaths,
  wakeUp,
  resolveWriteAttribution,
  PROCESS_SESSION_ID,
};
