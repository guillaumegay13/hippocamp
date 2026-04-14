import { NextResponse } from "next/server";
import { NotFoundError } from "@/lib/errors";
import { toErrorResponse } from "@/lib/http";
import { searchMemory } from "@/lib/memory";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";

    try {
      const { results, scannedFiles } = await searchMemory(query);

      return NextResponse.json({
        query,
        scannedFiles,
        results,
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        return NextResponse.json({
          query,
          scannedFiles: 0,
          results: [],
        });
      }

      throw error;
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
