import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { getFile, updateTextFile } from "@/lib/github";
import { normalizeMemoryPath, validateUpsertMemoryFileInput } from "@/lib/memory";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const filePath = normalizeMemoryPath(url.searchParams.get("path"));
    const file = await getFile(filePath);

    return NextResponse.json({
      path: file.path,
      name: file.name,
      sha: file.sha,
      size: file.size,
      content: file.content,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = validateUpsertMemoryFileInput(await request.json());
    const result = await updateTextFile({
      path: body.path,
      message: `update memory file: ${body.path}`,
      computeContent: async () => body.content,
    });

    return NextResponse.json({
      path: body.path,
      committed: result.committed,
      sha: result.sha,
      created: result.created,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
