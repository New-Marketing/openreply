/**
 * Campaign rules for the two options added together:
 * - a campaign can listen on several chosen posts (AutomationPost rows), and
 * - a campaign can be public-reply-only (dmEnabled false, no DM).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockSyncCampaignLinks } = vi.hoisted(() => {
  const mockPrisma = {
    automation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    automationPost: { deleteMany: vi.fn(), createMany: vi.fn() },
    workspace: { findUnique: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  };
  return { mockPrisma, mockSyncCampaignLinks: vi.fn() };
});

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/campaigns/links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/campaigns/links")>()),
  syncCampaignLinks: mockSyncCampaignLinks,
}));

import {
  createCampaign,
  normalizePosts,
  updateCampaign,
} from "../lib/campaigns/mutations";

const base = { name: "Trial reels", keywords: ["AI"] };

function createData() {
  return mockPrisma.automation.create.mock.calls[0][0].data;
}

const existing = {
  id: "c1",
  workspaceId: "ws",
  instagramAccountId: "acc",
  matchAnyPost: false,
  pendingNextReel: false,
  dmEnabled: true,
  dmMessage: "Here is your link",
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workspace.findUnique.mockResolvedValue({ id: "ws" });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc" });
  mockPrisma.automation.create.mockImplementation(async ({ data }) => ({ id: "new", ...data }));
  mockPrisma.automation.findFirst.mockResolvedValue(existing);
  mockPrisma.automation.update.mockImplementation(async ({ data }) => ({ ...existing, ...data }));
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockPrisma));
});

describe("normalizePosts", () => {
  it("keeps order and drops duplicates", () => {
    expect(
      normalizePosts([{ postId: "a" }, { postId: "b" }, { postId: "a" }])
    ).toEqual([
      { postId: "a", postUrl: null },
      { postId: "b", postUrl: null },
    ]);
  });

  it("turns a lone postId into a one-post list", () => {
    expect(normalizePosts(undefined, "a", "https://instagram.com/p/a")).toEqual([
      { postId: "a", postUrl: "https://instagram.com/p/a" },
    ]);
  });

  it("prefers posts over postId", () => {
    expect(normalizePosts([{ postId: "b" }], "a")).toEqual([{ postId: "b", postUrl: null }]);
  });
});

describe("createCampaign with several posts", () => {
  it("stores every post in order and mirrors the first on the campaign", async () => {
    const result = await createCampaign("ws", {
      ...base,
      dmMessage: "Link: {link}",
      posts: [
        { postId: "p1", postUrl: "https://instagram.com/p/1" },
        { postId: "p2" },
      ],
    });

    expect(result.ok).toBe(true);
    const data = createData();
    expect(data.postId).toBe("p1");
    expect(data.postUrl).toBe("https://instagram.com/p/1");
    expect(data.posts.create).toEqual([
      { postId: "p1", postUrl: "https://instagram.com/p/1", position: 0 },
      { postId: "p2", postUrl: null, position: 1 },
    ]);
  });

  it("still accepts a single postId", async () => {
    await createCampaign("ws", { ...base, dmMessage: "x", postId: "p1" });
    expect(createData().posts.create).toEqual([
      { postId: "p1", postUrl: null, position: 0 },
    ]);
  });

  it("refuses more than 10 posts", async () => {
    const posts = Array.from({ length: 11 }, (_, i) => ({ postId: `p${i}` }));
    const result = await createCampaign("ws", { ...base, dmMessage: "x", posts });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses a specific-posts campaign without posts", async () => {
    const result = await createCampaign("ws", { ...base, dmMessage: "x", posts: [] });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("stores no posts for an any-post campaign", async () => {
    await createCampaign("ws", {
      ...base,
      dmMessage: "x",
      matchAnyPost: true,
      posts: [{ postId: "p1" }],
    });
    const data = createData();
    expect(data.postId).toBeNull();
    expect(data.posts).toBeUndefined();
  });
});

describe("createCampaign without a DM", () => {
  it("creates a public-reply-only campaign without a DM message", async () => {
    const result = await createCampaign("ws", {
      ...base,
      matchAnyPost: true,
      dmEnabled: false,
      publicReplyEnabled: true,
      publicReplyMessages: ["Your code: AI10"],
      // DM-only options are switched off even if sent.
      openingDmEnabled: true,
      openingDmMessage: "hi",
      openingDmButtonLabel: "go",
      requireFollow: true,
      followUpEnabled: true,
      dmTriggerEnabled: true,
    });

    expect(result.ok).toBe(true);
    const data = createData();
    expect(data).toMatchObject({
      dmEnabled: false,
      dmMessage: "",
      dmTriggerEnabled: false,
      openingDmEnabled: false,
      openingDmMessage: null,
      requireFollow: false,
      followUpEnabled: false,
      publicReplyEnabled: true,
      publicReplyMessages: ["Your code: AI10"],
    });
  });

  it("refuses a campaign with neither a DM nor a public reply", async () => {
    const result = await createCampaign("ws", {
      ...base,
      matchAnyPost: true,
      dmEnabled: false,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mockPrisma.automation.create).not.toHaveBeenCalled();
  });

  it("still requires the DM message when the DM is on", async () => {
    const result = await createCampaign("ws", { ...base, matchAnyPost: true });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

describe("updateCampaign", () => {
  it("replaces the post list and mirrors the first post", async () => {
    const result = await updateCampaign("ws", "c1", {
      posts: [{ postId: "p2" }, { postId: "p3" }],
    });

    expect(result.ok).toBe(true);
    expect(mockPrisma.automation.update.mock.calls[0][0].data).toMatchObject({
      postId: "p2",
      postUrl: null,
    });
    expect(mockPrisma.automationPost.deleteMany).toHaveBeenCalledWith({
      where: { automationId: "c1" },
    });
    expect(mockPrisma.automationPost.createMany).toHaveBeenCalledWith({
      data: [
        { postId: "p2", postUrl: null, position: 0, automationId: "c1" },
        { postId: "p3", postUrl: null, position: 1, automationId: "c1" },
      ],
    });
  });

  it("leaves the posts alone when the save does not touch them", async () => {
    await updateCampaign("ws", "c1", { name: "Renamed" });
    expect(mockPrisma.automationPost.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses to empty the posts of a specific-posts campaign", async () => {
    const result = await updateCampaign("ws", "c1", { posts: [] });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mockPrisma.automation.update).not.toHaveBeenCalled();
  });

  it("turns the DM off and clears the DM-only settings", async () => {
    const result = await updateCampaign("ws", "c1", {
      dmEnabled: false,
      publicReplyEnabled: true,
      publicReplyMessages: ["Code: AI10"],
    });

    expect(result.ok).toBe(true);
    expect(mockPrisma.automation.update.mock.calls[0][0].data).toMatchObject({
      dmEnabled: false,
      dmMessage: "",
      openingDmEnabled: false,
      requireFollow: false,
      followUpEnabled: false,
      dmTriggerEnabled: false,
    });
  });

  it("refuses to turn the DM off without a public reply", async () => {
    const result = await updateCampaign("ws", "c1", { dmEnabled: false });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("refuses to clear the DM message while the DM is on", async () => {
    const result = await updateCampaign("ws", "c1", { dmMessage: "  " });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("pausing a public-only campaign is not blocked by the delivery rules", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...existing,
      dmEnabled: false,
      dmMessage: "",
      publicReplyEnabled: true,
      publicReplyMessages: ["Code"],
    });
    const result = await updateCampaign("ws", "c1", { isActive: false });
    expect(result.ok).toBe(true);
  });
});
