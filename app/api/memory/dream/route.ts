import { NextResponse } from "next/server";
import { buildDreamContext, SHARED_CONTEXT_PATH } from "@/lib/dream";
import { toErrorResponse } from "@/lib/http";
import { updateTextFile } from "@/lib/github";

export const runtime = "nodejs";

export async function POST() {
  try {
    const dream = await buildDreamContext();
    const result = await updateTextFile({
      path: SHARED_CONTEXT_PATH,
      message: "dream: refresh shared context",
      computeContent: async () => dream.content,
    });

    return NextResponse.json({
      path: SHARED_CONTEXT_PATH,
      committed: result.committed,
      sha: result.sha,
      created: result.created,
      eventCount: dream.eventCount,
      sourceFiles: dream.sourceFiles,
      summary: dream.summary,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
