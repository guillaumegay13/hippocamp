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
const GLOBAL_MEMORY_DIR = ".hippocamp";

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
  return path.join(getGlobalRepoRoot(), GLOBAL_MEMORY_DIR);
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

function slugifyProjectName(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "project";
}

function getProjectSlug(projectRoot) {
  const resolvedProjectRoot = getProjectRoot(projectRoot);
  const gitRoot = findGitRootSync(resolvedProjectRoot);
  return slugifyProjectName(path.basename(gitRoot || resolvedProjectRoot));
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

  const repoRelativePaths = paths.map((item) =>
    path.relative(repoRoot, assertPathInScope(scopeRoot, item)).split(path.sep).join(path.posix.sep) || ".",
  );

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
  projectRoot,
  sync = true,
  title,
  date = new Date().toISOString().slice(0, 10),
  timestamp = new Date().toISOString(),
}) {
  const body = requireNonEmptyString(content, "content");
  const heading = title ? `## ${timestamp} — ${title.trim()}` : `## ${timestamp}`;
  const eventBlock = `${heading}\n\n${body.trim()}\n`;
  const relativePath = `events/${date}.md`;
  const target = resolveScopedPath(scope, relativePath, projectRoot);
  const existing = await readFileIfExists(target.absolutePath);
  const nextContent = existing?.trim()
    ? `${existing.trimEnd()}\n\n${eventBlock.trimEnd()}\n`
    : `# Events — ${date}\n\n${eventBlock.trimEnd()}\n`;

  await ensureParentDirectory(target.absolutePath);
  await fs.writeFile(target.absolutePath, nextContent, "utf8");

  const syncResult = sync
    ? await syncMemory({
        scope,
        projectRoot,
        paths: [target.absolutePath],
        message: `hippocamp: append ${scope} event ${date}`,
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
    timestamp,
    title: title?.trim() || null,
    sync: syncResult,
  };
}

async function searchMemory({ query, scope = "both", projectRoot, maxResults = 10 }) {
  const normalizedQuery = requireNonEmptyString(query, "query");
  const clampedMaxResults = Math.max(1, Math.min(Number(maxResults) || 10, 20));
  const scopes = scope === "both" ? ["global", "project"] : [scope];
  const results = [];
  let scannedFiles = 0;

  for (const itemScope of scopes) {
    const root = getScopeRoot(itemScope, projectRoot);
    const markdownFiles = await walkMarkdownFiles(root);
    const scopedFiles =
      itemScope === "global"
        ? markdownFiles.filter((relativePath) => !relativePath.startsWith("projects/"))
        : markdownFiles;

    for (const relativePath of scopedFiles) {
      scannedFiles += 1;

      if (results.length >= clampedMaxResults) {
        break;
      }

      const absolutePath = path.join(root, relativePath);
      const content = await fs.readFile(absolutePath, "utf8");
      const snippet = createSearchSnippet(content, normalizedQuery);

      if (!snippet) {
        continue;
      }

      results.push({
        scope: itemScope,
        path: relativePath,
        snippet,
      });
    }

    if (results.length >= clampedMaxResults) {
      break;
    }
  }

  return {
    query: normalizedQuery,
    scannedFiles,
    results,
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
  wakeUp,
};
