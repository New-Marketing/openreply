import { z } from "zod";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ApiError, checkOrigin, readJson } from "@/lib/integrations/http";
import { setActiveWorkspaceCookie } from "@/lib/workspace";
import { workspaceRouteError } from "@/lib/workspace-routes";

const switchSchema = z.object({ workspaceId: z.string().min(1).max(64) }).strict();

/** Makes one of the signed-in user's workspaces the active one. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const userId = await getCurrentUserId();
    if (!userId) throw new ApiError("Unauthorized", 401);

    const input = switchSchema.safeParse(await readJson(request));
    if (!input.success) throw new ApiError("Invalid workspace");

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: input.data.workspaceId, userId },
      },
      select: { role: true, workspace: { select: { id: true, name: true } } },
    });
    // Same answer for "does not exist" and "not yours": no probing for ids.
    if (!membership) throw new ApiError("Workspace not found", 404);

    await setActiveWorkspaceCookie(membership.workspace.id);

    return Response.json(
      {
        success: true,
        data: {
          workspace: {
            id: membership.workspace.id,
            name: membership.workspace.name,
            role: membership.role,
          },
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return workspaceRouteError(error);
  }
}
