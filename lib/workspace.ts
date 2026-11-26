import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { Workspace, WorkspaceRole } from "@/app/generated/prisma/client";

/**
 * The workspace a signed-in user is working in. One user can belong to several
 * workspaces (an agency keeps one per client profile), and this cookie remembers
 * which one the dashboard and the session API routes act on.
 *
 * The value is only a preference: every read checks it against the user's
 * WorkspaceMember rows, so a stale or forged id falls back to the oldest
 * membership. Service keys (API/MCP) are bound to their own workspace and never
 * read this cookie.
 */
export const ACTIVE_WORKSPACE_COOKIE = "or_workspace";

export const ACTIVE_WORKSPACE_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax",
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
} as const;

// Workspace ids are cuids. Anything else cannot match a membership, so it is
// not worth a database round trip.
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const workspaceNameSchema = z.string().trim().min(1).max(60);

export type WorkspaceSummary = {
  id: string;
  name: string;
  role: WorkspaceRole;
};

/**
 * The preferred workspace id from the request cookie. Returns null outside a
 * request (worker, scripts, tests) instead of throwing.
 */
export async function readActiveWorkspaceId(): Promise<string | null> {
  try {
    const value = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
    return value && WORKSPACE_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Only callable from a Route Handler or Server Function. */
export async function setActiveWorkspaceCookie(workspaceId: string): Promise<void> {
  (await cookies()).set(
    ACTIVE_WORKSPACE_COOKIE,
    workspaceId,
    ACTIVE_WORKSPACE_COOKIE_OPTIONS
  );
}

function normalizeInviteEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function acceptPendingInvitationsForUser(
  userId: string,
  email?: string | null
): Promise<void> {
  if (!email) return;

  const normalizedEmail = normalizeInviteEmail(email);
  const now = new Date();
  const invitations = await prisma.workspaceInvitation.findMany({
    where: {
      email: normalizedEmail,
      status: "PENDING",
      expiresAt: { gt: now },
    },
  });

  for (const invitation of invitations) {
    await prisma.$transaction([
      prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
        create: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
        },
        update: {
          role: invitation.role,
        },
      }),
      prisma.workspaceInvitation.update({
        where: { id: invitation.id },
        data: {
          status: "ACCEPTED",
          acceptedAt: now,
        },
      }),
    ]);
  }
}

/**
 * The active workspace for a user: the one named by the cookie when the user is
 * a member of it, otherwise the oldest membership.
 */
export async function getWorkspaceMembership(userId: string): Promise<{
  workspace: Workspace;
  role: WorkspaceRole;
} | null> {
  const preferredWorkspaceId = await readActiveWorkspaceId();
  if (preferredWorkspaceId) {
    const preferred = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: preferredWorkspaceId, userId },
      },
      include: { workspace: true },
    });
    if (preferred) {
      return { workspace: preferred.workspace, role: preferred.role };
    }
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: { userId },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) return null;

  return {
    workspace: membership.workspace,
    role: membership.role,
  };
}

export async function ensureWorkspaceForUser(
  userId: string,
  email?: string | null
): Promise<Workspace> {
  await acceptPendingInvitationsForUser(userId, email);

  const existingMembership = await getWorkspaceMembership(userId);
  if (existingMembership) {
    return existingMembership.workspace;
  }

  const workspaceName = email ? `${email.split("@")[0]}'s workspace` : "My workspace";

  return createWorkspaceForUser(userId, workspaceName);
}

export async function getPrimaryWorkspace(userId: string): Promise<Workspace | null> {
  const membership = await getWorkspaceMembership(userId);
  return membership?.workspace ?? null;
}

/** Every workspace the user belongs to, oldest membership first. */
export async function listWorkspacesForUser(
  userId: string
): Promise<WorkspaceSummary[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      workspace: { select: { id: true, name: true } },
    },
  });

  return memberships.map((membership) => ({
    id: membership.workspace.id,
    name: membership.workspace.name,
    role: membership.role,
  }));
}

/** Creates a workspace owned by the user, who becomes its OWNER member. */
export function createWorkspaceForUser(
  userId: string,
  name: string
): Promise<Workspace> {
  return prisma.workspace.create({
    data: {
      name,
      ownerId: userId,
      members: {
        create: {
          userId,
          role: "OWNER",
        },
      },
    },
  });
}
