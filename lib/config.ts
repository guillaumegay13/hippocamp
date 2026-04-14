import { ConfigurationError } from "@/lib/errors";

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  apiBaseUrl: string;
}

function requireEnv(name: keyof NodeJS.ProcessEnv) {
  const value = process.env[name];

  if (!value) {
    throw new ConfigurationError(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getGitHubConfig(): GitHubConfig {
  return {
    token: requireEnv("GITHUB_TOKEN"),
    owner: requireEnv("GITHUB_OWNER"),
    repo: requireEnv("GITHUB_REPO"),
    branch: requireEnv("GITHUB_BRANCH"),
    apiBaseUrl: "https://api.github.com",
  };
}
