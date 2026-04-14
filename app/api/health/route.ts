import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const configured = Boolean(
    process.env.GITHUB_TOKEN &&
      process.env.GITHUB_OWNER &&
      process.env.GITHUB_REPO &&
      process.env.GITHUB_BRANCH,
  );

  return NextResponse.json({
    ok: true,
    service: "shared-memory",
    githubConfigured: configured,
  });
}
