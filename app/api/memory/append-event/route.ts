import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { updateTextFile } from "@/lib/github";
import { appendEventDocument, formatEventEntry, getDailyEventPath, validateAppendEventInput } from "@/lib/memory";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = validateAppendEventInput(await request.json());
    const timestamp = new Date().toISOString();
    const date = timestamp.slice(0, 10);
    const filePath = getDailyEventPath(date);
    const entry = formatEventEntry({ ...body, timestamp });

    const result = await updateTextFile({
      path: filePath,
      message: `append event: ${body.type} by ${body.agent}`,
      computeContent: (currentContent) => appendEventDocument(currentContent, date, entry),
    });

    return NextResponse.json({
      path: filePath,
      timestamp,
      committed: result.committed,
      sha: result.sha,
      created: result.created,
      entry,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
