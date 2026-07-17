import {
  invalidJsonPlacementResponse,
  placeSource,
} from "@/adapters/manager";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let input: unknown;

  try {
    input = await request.json();
  } catch {
    const result = invalidJsonPlacementResponse();
    return Response.json(result.body, { status: result.status });
  }

  const result = await placeSource(input);
  return Response.json(result.body, { status: result.status });
}
