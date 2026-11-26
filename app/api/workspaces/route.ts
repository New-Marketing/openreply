import { z } from "zod";
import { getCurrentUserId } from "@/lib/auth";
import { ApiError, checkOrigin, readJson } from "@/lib/integrations/http";
import {
  createWorkspaceForUser,
  getWorkspaceMembership,
  listWorkspacesForUser,
  setActiveWorkspaceCookie,
  workspaceNameSchema,
} from "@/lib/workspace";
import { workspaceRouteError } from "@/lib/workspace-routes";

const createSchema = z.object({ name: workspaceNameSchema }).strict();

/** The signed-in user's workspaces, with the active one marked. */
export async function GET() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) throw new ApiError("Unauthorized", 401);

    const [workspaces, active] = await Promise.all([
      listWorkspacesForUser(userId),
      getWorkspaceMembership(userId),
    ]);

    return Response.json(
      {
        success: true,
        data: { activeWorkspaceId: active?.workspace.id ?? null, workspaces },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return workspaceRouteError(error);
  }
}

/** Creates a workspace owned by the signed-in user and switches to it. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const userId = await getCurrentUserId();
    if (!userId) throw new ApiError("Unauthorized", 401);

    const input = createSchema.safeParse(await readJson(request));
    if (!input.success) throw new ApiError("Invalid workspace name");

    const workspace = await createWorkspaceForUser(userId, input.data.name);
    await setActiveWorkspaceCookie(workspace.id);

    return Response.json(
      {
        success: true,
        data: { workspace: { id: workspace.id, name: workspace.name, role: "OWNER" } },
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return workspaceRouteError(error);
  }
}
