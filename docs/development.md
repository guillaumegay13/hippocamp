# Development

[← Back to README](../README.md)

## Commands

```bash
npm run mcp
npm run mcp:help
npm run mcp:smoke
npm run dream
npm run dream:railway
npm run eval:lagoon
npm run eval:qa
npm run eval:retrieval
npm run install:codex
npm run install:claude
npm run install:grok
npm run upgrade:codex
npm run upgrade:claude
npm run upgrade:grok
```

## Releases

Pull requests and pushes to `main` run syntax and MCP smoke checks in GitHub Actions.

To publish a package version:

1. Update the version in `package.json` and `package-lock.json`, then merge it to `main`.
2. Publish a GitHub Release whose tag is `v<version>`.
3. The `Publish Package` workflow verifies the tag, runs the MCP checks, and publishes to npm through trusted publishing.

The npm package must trust the GitHub Actions workflow `publish.yml` in `guillaumegay13/hippocamp`. This uses short-lived OIDC credentials instead of an npm token.
