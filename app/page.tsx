import Image from "next/image";

const endpoints = [
  ["GET", "/api/health", "Basic service health and GitHub configuration state."],
  ["GET", "/api/memory/file?path=.hippocamp/shared/context.md", "Read a Markdown memory file from GitHub."],
  ["PUT", "/api/memory/file", "Create or overwrite a Markdown file under .hippocamp/."],
  ["GET", "/api/memory/list?path=.hippocamp", "List files or folders under the memory tree."],
  ["GET", "/api/memory/search?q=builder", "Naive substring search across Markdown memory files."],
  ["POST", "/api/memory/append-event", "Append an event to the current UTC daily log."],
  ["POST", "/api/memory/update-agent", "Create or replace one agent working-memory file."],
] as const;

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <div className="hero-top">
          <div className="hero-copy">
            <p className="eyebrow">hippocamp v1</p>
            <h1>Git-backed memory for agents.</h1>
            <p className="lede">
              This service stores shared agent memory as plain Markdown in a GitHub repository.
              It keeps the model intentionally small: append-only daily events, isolated
              per-agent working files, and shared Markdown files.
            </p>
          </div>

          <figure className="mascot-card">
            <div className="mascot-glow" />
            <Image
              src="/brand/hippocamp-mascot.png"
              alt="Hippocamp mascot"
              width={320}
              height={320}
              priority
              className="mascot-image"
            />
            <figcaption>Hippocamp, the repo mascot.</figcaption>
          </figure>
        </div>

        <div className="grid">
          <article className="card">
            <h2>Storage model</h2>
            <p>
              <code>.hippocamp/events/</code>, <code>.hippocamp/agents/</code>, and{" "}
              <code>.hippocamp/shared/</code> are the built-in primitives in V1.
            </p>
          </article>
          <article className="card">
            <h2>Why this exists</h2>
            <p>
              The goal is inspectable shared memory for AI agents, not a database, notes
              app, or vector system.
            </p>
          </article>
          <article className="card">
            <h2>Write strategy</h2>
            <ul>
              <li>Events append only.</li>
              <li>Each agent owns its own file.</li>
              <li>Shared files are explicit Markdown writes.</li>
            </ul>
          </article>
        </div>

        <ul className="endpoint-list">
          {endpoints.map(([method, path, description]) => (
            <li key={path}>
              <span className="endpoint">
                <span className="pill">{method}</span>
                <code>{path}</code>
              </span>
              <span>{description}</span>
            </li>
          ))}
        </ul>

        <p className="footer">
          Configure <code>GITHUB_TOKEN</code>, <code>GITHUB_OWNER</code>,{" "}
          <code>GITHUB_REPO</code>, and <code>GITHUB_BRANCH</code>, then deploy on Vercel.
        </p>
      </section>
    </main>
  );
}
