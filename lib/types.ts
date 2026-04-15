export type GitHubNodeType = "file" | "dir";

export interface GitHubListItem {
  name: string;
  path: string;
  type: GitHubNodeType;
  sha: string;
  size: number;
}

export interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
}

export interface GitHubWriteResult {
  path: string;
  sha?: string;
  committed: boolean;
  created: boolean;
}

export interface AppendEventInput {
  agent: string;
  type: string;
  project?: string;
  commit?: string;
  whatChanged: string;
  why?: string;
  impact?: string;
  next?: string;
}

export interface UpdateAgentInput {
  agent: string;
  content: string;
}

export interface UpsertMemoryFileInput {
  path: string;
  content: string;
}

export interface SearchResult {
  path: string;
  snippet: string;
}
