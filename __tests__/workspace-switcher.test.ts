import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  cookieStore: { get: vi.fn(), set: vi.fn() },
  cookiesUnavailable: false,
  userId: vi.fn(),
  workspaceMember: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  workspace: { create: vi.fn(), update: vi.fn() },
  workspaceInvitation: { findMany: vi.fn() },
}));

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (state.cookiesUnavailable) {
      throw new Error("`cookies` was called outside a request scope");
    }
    return state.cookieStore;
  },
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: state.userId }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    workspaceMember: state.workspaceMember,
    workspace: state.workspace,
    workspaceInvitation: state.workspaceInvitation,
    user: { findUnique: vi.fn() },
  },
}));

import {
  ACTIVE_WORKSPACE_COOKIE,
  getPrimaryWorkspace,
  getWorkspaceMembership,
} from "../lib/workspace";
import { getCurrentWorkspaceContext } from "../lib/workspace-access";
import {
  GET as listWorkspaces,
  POST as createWorkspace,
} from "../app/api/workspaces/route";
import { POST as switchWorkspace } from "../app/api/workspaces/active/route";
import { PATCH as renameWorkspace } from "../app/api/workspace/route";

const ORIGIN = "https://example.test";

const workspaceA = { id: "ws_oldest", name: "Davi Reis" };
const workspaceB = { id: "ws_dada", name: "Dada" };
const foreignWorkspace = { id: "ws_foreign", name: "Someone else" };

// user_1 belongs to two workspaces; ws_foreign belongs to user_2 only, and
// user_3 is a plain member of the oldest one.
const memberships: Array<{
  userId: string;
  workspace: { id: string; name: string };
  role: "OWNER" | "ADMIN" | "MEMBER";
}> = [
  { userId: "user_1", workspace: workspaceA, role: "OWNER" },
  { userId: "user_1", workspace: workspaceB, role: "ADMIN" },
  { userId: "user_2", workspace: foreignWorkspace, role: "OWNER" },
  { userId: "user_3", workspace: workspaceA, role: "MEMBER" },
];

function useCookie(value: string | undefined) {
  state.cookieStore.get.mockImplementation((name: string) =>
    name === ACTIVE_WORKSPACE_COOKIE && value !== undefined ? { name, value } : undefined
  );
}

function request(path: string, method: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", ORIGIN);
  state.cookiesUnavailable = false;
  useCookie(undefined);
  state.userId.mockResolvedValue("user_1");
  state.workspaceInvitation.findMany.mockResolvedValue([]);

  state.workspaceMember.findUnique.mockImplementation(
    async ({ where }: { where: { workspaceId_userId: { workspaceId: string; userId: string } } }) => {
      const { workspaceId, userId } = where.workspaceId_userId;
      const match = memberships.find(
        (membership) => membership.userId === userId && membership.workspace.id === workspaceId
      );
      return match ? { role: match.role, workspace: match.workspace } : null;
    }
  );
  state.workspaceMember.findFirst.mockImplementation(
    async ({ where }: { where: { userId: string } }) => {
      const match = memberships.find((membership) => membership.userId === where.userId);
      return match
        ? { role: match.role, workspaceId: match.workspace.id, workspace: match.workspace }
        : null;
    }
  );
  state.workspaceMember.findMany.mockImplementation(
    async ({ where }: { where: { userId: string } }) =>
      memberships
        .filter((membership) => membership.userId === where.userId)
        .map(({ role, workspace }) => ({ role, workspace }))
  );
  state.workspace.create.mockImplementation(
    async ({ data }: { data: { name: string; ownerId: string } }) => ({
      id: "ws_new",
      name: data.name,
      ownerId: data.ownerId,
    })
  );
  state.workspace.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { name: string } }) => ({
      id: where.id,
      name: data.name,
    })
  );
});

describe("active workspace resolution", () => {
  it("uses the workspace named by the cookie when the user is a member", async () => {
    useCookie(workspaceB.id);

    const membership = await getWorkspaceMembership("user_1");

    expect(membership).toEqual({ workspace: workspaceB, role: "ADMIN" });
    expect(state.workspaceMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_userId: { workspaceId: workspaceB.id, userId: "user_1" } },
      })
    );
    expect(state.workspaceMember.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the oldest membership when the cookie names someone else's workspace", async () => {
    useCookie(foreignWorkspace.id);

    const membership = await getWorkspaceMembership("user_1");

    expect(membership).toEqual({ workspace: workspaceA, role: "OWNER" });
    expect(state.workspaceMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user_1" }, orderBy: { createdAt: "asc" } })
    );
  });

  it("falls back to the oldest membership without a cookie", async () => {
    const workspace = await getPrimaryWorkspace("user_1");

    expect(workspace).toEqual(workspaceA);
    expect(state.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("ignores a malformed cookie without querying it", async () => {
    useCookie("../../etc/passwd");

    await expect(getPrimaryWorkspace("user_1")).resolves.toEqual(workspaceA);
    expect(state.workspaceMember.findUnique).not.toHaveBeenCalled();
  });

  it("falls back outside a request, where cookies are unavailable", async () => {
    state.cookiesUnavailable = true;

    await expect(getPrimaryWorkspace("user_1")).resolves.toEqual(workspaceA);
  });

  it("scopes the session workspace context to the active workspace and its role", async () => {
    useCookie(workspaceB.id);

    await expect(getCurrentWorkspaceContext()).resolves.toEqual({
      userId: "user_1",
      workspaceId: workspaceB.id,
      workspace: workspaceB,
      role: "ADMIN",
    });
  });
});

describe("GET /api/workspaces", () => {
  it("lists only the user's workspaces and marks the active one", async () => {
    useCookie(workspaceB.id);

    const res = await listWorkspaces();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      activeWorkspaceId: workspaceB.id,
      workspaces: [
        { id: workspaceA.id, name: workspaceA.name, role: "OWNER" },
        { id: workspaceB.id, name: workspaceB.name, role: "ADMIN" },
      ],
    });
  });

  it("requires a session", async () => {
    state.userId.mockResolvedValue(null);

    expect((await listWorkspaces()).status).toBe(401);
  });
});

describe("POST /api/workspaces", () => {
  it("creates a workspace owned by the user and switches to it", async () => {
    const res = await createWorkspace(
      request("/api/workspaces", "POST", { name: "  Gabriel  " })
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.workspace).toEqual({ id: "ws_new", name: "Gabriel", role: "OWNER" });
    expect(state.workspace.create).toHaveBeenCalledWith({
      data: {
        name: "Gabriel",
        ownerId: "user_1",
        members: { create: { userId: "user_1", role: "OWNER" } },
      },
    });
    expect(state.cookieStore.set).toHaveBeenCalledWith(
      ACTIVE_WORKSPACE_COOKIE,
      "ws_new",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" })
    );
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a name over 60 characters", { name: "x".repeat(61) }],
    ["a missing name", {}],
    ["unknown fields", { name: "Dada", ownerId: "user_2" }],
  ])("rejects %s", async (_label, body) => {
    const res = await createWorkspace(request("/api/workspaces", "POST", body));

    expect(res.status).toBe(400);
    expect(state.workspace.create).not.toHaveBeenCalled();
    expect(state.cookieStore.set).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    const res = await createWorkspace(
      request("/api/workspaces", "POST", { name: "Dada" }, "https://evil.test")
    );

    expect(res.status).toBe(403);
    expect(state.workspace.create).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    state.userId.mockResolvedValue(null);

    const res = await createWorkspace(request("/api/workspaces", "POST", { name: "Dada" }));

    expect(res.status).toBe(401);
    expect(state.workspace.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/workspaces/active", () => {
  it("switches to a workspace the user belongs to", async () => {
    const res = await switchWorkspace(
      request("/api/workspaces/active", "POST", { workspaceId: workspaceB.id })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.workspace).toEqual({ ...workspaceB, role: "ADMIN" });
    expect(state.cookieStore.set).toHaveBeenCalledWith(
      ACTIVE_WORKSPACE_COOKIE,
      workspaceB.id,
      expect.objectContaining({ httpOnly: true })
    );
  });

  it("refuses a workspace the user is not a member of", async () => {
    const res = await switchWorkspace(
      request("/api/workspaces/active", "POST", { workspaceId: foreignWorkspace.id })
    );

    expect(res.status).toBe(404);
    expect(state.cookieStore.set).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests", async () => {
    const res = await switchWorkspace(
      request(
        "/api/workspaces/active",
        "POST",
        { workspaceId: workspaceB.id },
        "https://evil.test"
      )
    );

    expect(res.status).toBe(403);
    expect(state.cookieStore.set).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/workspace", () => {
  it("lets an admin rename the active workspace", async () => {
    useCookie(workspaceB.id);

    const res = await renameWorkspace(
      request("/api/workspace", "PATCH", { name: " Dada Oficial " })
    );

    expect(res.status).toBe(200);
    expect(state.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: workspaceB.id },
        data: { name: "Dada Oficial" },
      })
    );
  });

  it("does not let a member rename the workspace", async () => {
    state.userId.mockResolvedValue("user_3");

    const res = await renameWorkspace(
      request("/api/workspace", "PATCH", { name: "Hijacked" })
    );

    expect(res.status).toBe(403);
    expect(state.workspace.update).not.toHaveBeenCalled();
  });

  it("rejects an invalid name", async () => {
    const res = await renameWorkspace(request("/api/workspace", "PATCH", { name: "" }));

    expect(res.status).toBe(400);
    expect(state.workspace.update).not.toHaveBeenCalled();
  });
});
