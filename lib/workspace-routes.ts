import { ApiError } from "@/lib/integrations/http";

/**
 * Error body for the workspace session routes. Same `{ success, error }` shape
 * the dashboard already reads from /api/workspace/members.
 */
export function workspaceRouteError(error: unknown): Response {
  const status = error instanceof ApiError ? error.status : 500;
  if (status === 500) {
    console.error(
      "[Workspace] Unexpected error:",
      error instanceof Error ? error.message : "unknown"
    );
  }
  return Response.json(
    {
      success: false,
      error: status === 500 ? "Internal error" : (error as Error).message,
    },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
