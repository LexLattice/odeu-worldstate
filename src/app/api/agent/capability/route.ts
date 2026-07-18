import { NextResponse } from "next/server";

import { getAgentRuntimeCapability } from "@/adapters/codex/live-authority-server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getAgentRuntimeCapability(), {
    headers: { "cache-control": "no-store" },
  });
}
