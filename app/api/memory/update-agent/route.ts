import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/http";
import { updateTextFile } from "@/lib/github";
import { getAgentPath, validateUpdateAgentInput } from "@/lib/memory";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = validateUpdateAgentInput(await request.json());
    const filePath = getAgentPath(body.agent);

    const result = await updateTextFile({
      path: filePath,
      message: `update agent memory: ${body.agent}`,
      computeContent: async () => body.content,
    });

    return NextResponse.json({
      path: filePath,
      committed: result.committed,
      sha: result.sha,
      created: result.created,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
