import { getGitHubConfig } from "@/lib/config";
import { AppError, NotFoundError } from "@/lib/errors";
import type { GitHubFile, GitHubListItem, GitHubWriteResult } from "@/lib/types";

interface GitHubContentsFileResponse {
  type: "file";
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
  encoding: "base64";
}

interface GitHubContentsDirectoryResponse {
  type: "dir";
  name: string;
  path: string;
  sha: string;
  size: number;
}

interface GitHubContentsWriteResponse {
  content?: {
    path: string;
    sha: string;
  };
}

type GitHubContentsResponse =
  | GitHubContentsFileResponse
  | GitHubContentsDirectoryResponse
  | GitHubContentsDirectoryResponse[];

function encodePath(path: string) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function parseJson(response: Response) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isConflictResponse(status: number, payload: unknown) {
  if (status === 409) {
    return true;
  }

  if (status !== 422 || typeof payload !== "object" || payload === null) {
    return false;
  }

  const message = "message" in payload && typeof payload.message === "string" ? payload.message : "";
  return message.toLowerCase().includes("sha");
}

async function githubRequest<T>(
  endpoint: string,
  init?: RequestInit,
): Promise<T> {
  const config = getGitHubConfig();
  const response = await fetch(`${config.apiBaseUrl}${endpoint}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "User-Agent": "shared-memory",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });

  if (response.ok) {
    return (await response.json()) as T;
  }

  const payload = await parseJson(response);

  if (isConflictResponse(response.status, payload)) {
    throw new AppError(409, "github_conflict", "GitHub rejected the update due to a stale file SHA.", payload);
  }

  const message =
    typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : `GitHub API request failed with status ${response.status}.`;

  if (response.status === 404) {
    throw new NotFoundError(message);
  }

  throw new AppError(502, "github_api_error", message, payload);
}

async function githubRequestIfExists<T>(endpoint: string, init?: RequestInit): Promise<T | null> {
  try {
    return await githubRequest<T>(endpoint, init);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return null;
    }

    throw error;
  }
}

function decodeBase64(content: string) {
  return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
}

export async function getFile(path: string): Promise<GitHubFile> {
  const config = getGitHubConfig();
  const response = await githubRequest<GitHubContentsResponse>(
    `/repos/${config.owner}/${config.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`,
  );

  if (Array.isArray(response) || response.type !== "file") {
    throw new AppError(400, "invalid_path", `${path} is not a file.`);
  }

  return {
    name: response.name,
    path: response.path,
    sha: response.sha,
    size: response.size,
    content: decodeBase64(response.content),
  };
}

export async function getFileIfExists(path: string): Promise<GitHubFile | null> {
  const config = getGitHubConfig();
  const response = await githubRequestIfExists<GitHubContentsResponse>(
    `/repos/${config.owner}/${config.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`,
  );

  if (!response) {
    return null;
  }

  if (Array.isArray(response) || response.type !== "file") {
    throw new AppError(400, "invalid_path", `${path} is not a file.`);
  }

  return {
    name: response.name,
    path: response.path,
    sha: response.sha,
    size: response.size,
    content: decodeBase64(response.content),
  };
}

export async function listDirectory(path: string): Promise<GitHubListItem[]> {
  const config = getGitHubConfig();
  const response = await githubRequest<GitHubContentsResponse>(
    `/repos/${config.owner}/${config.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`,
  );

  if (!Array.isArray(response)) {
    throw new AppError(400, "invalid_path", `${path} is not a directory.`);
  }

  return response.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type,
    sha: item.sha,
    size: item.size,
  }));
}

async function putFile(params: {
  path: string;
  content: string;
  message: string;
  sha?: string;
}): Promise<GitHubWriteResult> {
  const config = getGitHubConfig();
  const body = {
    message: params.message,
    content: Buffer.from(params.content, "utf8").toString("base64"),
    branch: config.branch,
    ...(params.sha ? { sha: params.sha } : {}),
  };

  const response = await githubRequest<GitHubContentsWriteResponse>(
    `/repos/${config.owner}/${config.repo}/contents/${encodePath(params.path)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  return {
    path: params.path,
    sha: response.content?.sha,
    committed: true,
    created: !params.sha,
  };
}

export async function updateTextFile(params: {
  path: string;
  message: string;
  computeContent: (currentContent: string | null) => string | Promise<string>;
}): Promise<GitHubWriteResult> {
  const attemptWrite = async (attempt: number): Promise<GitHubWriteResult> => {
    const existing = await getFileIfExists(params.path);
    const nextContent = await params.computeContent(existing?.content ?? null);

    if (existing && existing.content === nextContent) {
      return {
        path: params.path,
        sha: existing.sha,
        committed: false,
        created: false,
      };
    }

    try {
      return await putFile({
        path: params.path,
        content: nextContent,
        message: params.message,
        sha: existing?.sha,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "github_conflict" && attempt < 1) {
        return attemptWrite(attempt + 1);
      }

      throw error;
    }
  };

  return attemptWrite(0);
}
