# Architecture

This project is a small Next.js service that treats a GitHub repository as the source of truth for shared agent memory.

## High-Level Diagram

```mermaid
flowchart LR
  client["Browser / agent client"]

  subgraph next["Next.js App Router service"]
    page["/"]
    health["GET /api/health"]
    file["GET /api/memory/file"]
    list["GET /api/memory/list"]
    search["GET /api/memory/search"]
    append["POST /api/memory/append-event"]
    update["POST /api/memory/update-agent"]
  end

  subgraph domain["Application logic"]
    config["lib/config.ts<br/>load required GitHub env vars"]
    http["lib/http.ts<br/>shared JSON error responses"]
    memory["lib/memory.ts<br/>validation, safe paths, file shapes, search"]
    github["lib/github.ts<br/>GitHub Contents API client + stale-SHA retry"]
  end

  gh["GitHub REST API<br/>/repos/{owner}/{repo}/contents/*"]

  subgraph repo["Configured GitHub repository"]
    events[".hippocamp/events/YYYY-MM-DD.md"]
    agents[".hippocamp/agents/{agent}.md"]
    shared[".hippocamp/shared/context.md"]
  end

  client --> page
  client --> health
  client --> file
  client --> list
  client --> search
  client --> append
  client --> update

  health --> config

  file --> memory
  list --> memory
  search --> memory
  append --> memory
  update --> memory

  file --> github
  list --> github
  search --> github
  append --> github
  update --> github

  github --> config
  github --> gh
  gh --> events
  gh --> agents
  gh --> shared

  file -. errors .-> http
  list -. errors .-> http
  search -. errors .-> http
  append -. errors .-> http
  update -. errors .-> http
```

## Request Flow: Append Event

```mermaid
sequenceDiagram
  participant Client
  participant Route as POST /api/memory/append-event
  participant Memory as lib/memory.ts
  participant GitHub as lib/github.ts
  participant Repo as GitHub repo

  Client->>Route: JSON body
  Route->>Memory: validateAppendEventInput()
  Route->>Memory: formatEventEntry()
  Route->>GitHub: updateTextFile(path, message, computeContent)
  GitHub->>Repo: GET existing daily file
  GitHub->>Repo: PUT updated Markdown
  Repo-->>GitHub: new SHA
  GitHub-->>Route: committed / created / sha
  Route-->>Client: JSON response
```

## Core Ideas

- The app itself does not store memory locally.
- All durable state lives in one GitHub repository under `.hippocamp/`.
- `lib/memory.ts` enforces the memory model:
  - safe paths under `.hippocamp/`
  - valid agent names
  - event formatting
  - search helpers
- `lib/github.ts` is the only storage integration layer.

## Memory Layout

```text
.hippocamp/
  events/
    YYYY-MM-DD.md
  agents/
    {agent}.md
  shared/
    context.md
```

## Endpoint Responsibilities

- `GET /api/health`
  - returns service status
  - reports whether required GitHub env vars are present
- `GET /api/memory/file`
  - reads one Markdown file from GitHub
- `PUT /api/memory/file`
  - creates or overwrites one Markdown file under `.hippocamp/`
- `GET /api/memory/list`
  - lists files or folders under a safe `.hippocamp/` path
- `GET /api/memory/search`
  - recursively scans Markdown files and returns substring matches
- `POST /api/memory/append-event`
  - appends one formatted event block to the current UTC daily log
- `POST /api/memory/update-agent`
  - creates or overwrites one agent working-memory file

## Operational Constraints

- The service requires:
  - `GITHUB_TOKEN`
  - `GITHUB_OWNER`
  - `GITHUB_REPO`
  - `GITHUB_BRANCH`
- Without those env vars, the app can boot and `/api/health` works, but GitHub-backed memory endpoints fail at runtime.
- Writes go directly to the configured GitHub branch through the contents API.
- If a write hits a stale SHA, the GitHub layer retries once with the latest file state.
