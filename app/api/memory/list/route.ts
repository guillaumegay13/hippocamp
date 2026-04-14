import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { listDirectory } from "@/lib/github";
import { normalizeMemoryPath } from "@/lib/memory";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const directoryPath = normalizeMemoryPath(url.searchParams.get("path"), "memory");
    const items = await listDirectory(directoryPath);

    return NextResponse.json({
      path: directoryPath,
      items,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
