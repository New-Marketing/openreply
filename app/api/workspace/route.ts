import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { ApiError, checkOrigin, readJson } from "@/lib/integrations/http";
import { workspaceNameSchema } from "@/lib/workspace";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { workspaceRouteError } from "@/lib/workspace-routes";

const renameSchema = z.object({ name: workspaceNameSchema }).strict();

/** Renames the active workspace. Owners and admins only. */
export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const context = await getCurrentWorkspaceContext();
    if (!context) throw new ApiError("Unauthorized", 401);
    if (!canManageWorkspace(context.role)) {
      throw new ApiError("Only owners and admins can rename the workspace", 403);
    }

    const input = renameSchema.safeParse(await readJson(request));
    if (!input.success) throw new ApiError("Invalid workspace name");

    const workspace = await prisma.workspace.update({
      where: { id: context.workspaceId },
      data: { name: input.data.name },
      select: { id: true, name: true },
    });

    return Response.json(
      { success: true, data: { workspace } },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return workspaceRouteError(error);
  }
}
