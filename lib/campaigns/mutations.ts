import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  buildInitialCampaignLinks,
  syncCampaignLinks,
} from "@/lib/campaigns/links";
import { generateReportShareSlug } from "@/lib/reports/share";

/**
 * Campaign create, update and delete, shared by the dashboard routes
 * (app/api/automations) and the service-key API (lib/integrations). Both call
 * these functions, so a campaign is validated and stored the same way no
 * matter where the request came from. Callers handle authentication and
 * roles; every function here is scoped to the workspace it is given.
 */

// The fields a new campaign accepts. Kept apart from the rules below so the
// API can describe the same fields as a JSON schema.
// Most posts one campaign can listen on.
export const MAX_CAMPAIGN_POSTS = 10;

const campaignPost = z.object({
  postId: z.string().min(1),
  postUrl: z.string().url().optional().nullable(),
});

// The posts a "specific posts" campaign listens on. `postId` / `postUrl` still
// work for a single post; `posts` takes precedence when both are sent.
const campaignPosts = z.array(campaignPost).max(MAX_CAMPAIGN_POSTS);

export const createCampaignFields = z.object({
  name: z.string().min(1).max(100),
  goal: z.string().min(1).max(120).optional().nullable(),
  instagramAccountId: z.string().min(1).optional().nullable(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  posts: campaignPosts.optional(),
  pendingNextReel: z.boolean().optional().default(false),
  matchAnyPost: z.boolean().optional().default(false),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
  matchAnyWord: z.boolean().optional().default(false),
  dmTriggerEnabled: z.boolean().optional().default(false),
  // Off makes a public-reply-only campaign: no DM is sent, so dmMessage may
  // be left out, and a public reply is required instead.
  dmEnabled: z.boolean().optional().default(true),
  dmMessage: z.string().max(1000).optional().default(""),
  openingDmEnabled: z.boolean().optional().default(false),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional().default(false),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional().default(false),
  followUpMessage: z.string().max(1000).optional().nullable(),
  // Minutes to wait before the follow-up. Capped at 24h so it stays inside
  // Instagram's messaging window.
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
  publicReplyEnabled: z.boolean().optional().default(false),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z
    .array(z.string().max(1000))
    .max(10)
    .optional()
    .default([]),
  // Empty string means "no tracked link"; a URL sets one.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Optional second tracked link, rendered as a second DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
  isActive: z.boolean().optional().default(true),
  wholeWordMatch: z.boolean().optional().default(true),
});

export const createCampaignSchema = createCampaignFields
  // A campaign must target a specific post, any post, or the next reel.
  .refine(
    (d) =>
      d.matchAnyPost ||
      d.pendingNextReel ||
      normalizePosts(d.posts, d.postId, d.postUrl).length > 0,
    { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
  )
  // A DM campaign needs its message; a public-only one needs a public reply.
  .refine((d) => !d.dmEnabled || Boolean(d.dmMessage.trim()), {
    message: "Add the DM message",
    path: ["dmMessage"],
  })
  .refine(
    (d) =>
      d.dmEnabled ||
      (d.publicReplyEnabled &&
        publicReplyListOf(d.publicReplyMessages, d.publicReplyMessage).length > 0),
    {
      message: "A campaign without a DM needs a public reply",
      path: ["publicReplyMessages"],
    }
  )
  // And it must match either specific words or any word.
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  );

export const updateCampaignSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  goal: z.string().min(1).max(120).optional().nullable(),
  instagramAccountId: z.string().min(1).optional(),
  postId: z.string().min(1).optional().nullable(),
  postUrl: z.string().url().optional().nullable(),
  posts: campaignPosts.optional(),
  pendingNextReel: z.boolean().optional(),
  matchAnyPost: z.boolean().optional(),
  keywords: z.array(z.string().min(1).max(50)).max(10).optional(),
  matchAnyWord: z.boolean().optional(),
  dmTriggerEnabled: z.boolean().optional(),
  dmEnabled: z.boolean().optional(),
  dmMessage: z.string().max(1000).optional(),
  openingDmEnabled: z.boolean().optional(),
  openingDmMessage: z.string().max(1000).optional().nullable(),
  openingDmButtonLabel: z.string().max(64).optional().nullable(),
  linkButtonLabel: z.string().max(20).optional().nullable(),
  requireFollow: z.boolean().optional(),
  followPromptMessage: z.string().max(1000).optional().nullable(),
  followPromptButtonLabel: z.string().max(20).optional().nullable(),
  followUpEnabled: z.boolean().optional(),
  followUpMessage: z.string().max(1000).optional().nullable(),
  followUpDelayMinutes: z.number().int().min(0).max(1440).optional(),
  publicReplyEnabled: z.boolean().optional(),
  publicReplyMessage: z.string().max(1000).optional().nullable(),
  publicReplyMessages: z.array(z.string().max(1000)).max(10).optional(),
  isActive: z.boolean().optional(),
  wholeWordMatch: z.boolean().optional(),
  reportShareEnabled: z.boolean().optional(),
  // Empty string clears the tracked link; a URL updates/creates it; undefined
  // leaves it unchanged.
  trackedDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  // Same semantics for the optional second tracked link / DM button.
  secondaryDestinationUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable(),
  secondaryButtonLabel: z.string().max(20).optional().nullable(),
});

export type CampaignResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; details?: unknown };

type CampaignPostInput = z.infer<typeof campaignPost>;

/**
 * The posts a campaign listens on, in order, without duplicates. `posts` wins;
 * otherwise a lone `postId` becomes a one-post list.
 */
export function normalizePosts(
  posts: CampaignPostInput[] | undefined,
  postId?: string | null,
  postUrl?: string | null
): { postId: string; postUrl: string | null }[] {
  const source =
    posts !== undefined ? posts : postId ? [{ postId, postUrl }] : [];
  const seen = new Set<string>();
  const list: { postId: string; postUrl: string | null }[] = [];
  for (const post of source) {
    const id = post.postId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push({ postId: id, postUrl: post.postUrl ?? null });
  }
  return list.slice(0, MAX_CAMPAIGN_POSTS);
}

function publicReplyListOf(
  messages: string[] | undefined,
  single: string | null | undefined
): string[] {
  return (messages && messages.length > 0 ? messages : single ? [single] : [])
    .map((m) => m.trim())
    .filter(Boolean);
}

function postRows(list: { postId: string; postUrl: string | null }[]) {
  return list.map((post, position) => ({ ...post, position }));
}

function invalidField(field: string, message: string) {
  return {
    ok: false as const,
    status: 400,
    error: "Invalid input",
    details: { formErrors: [], fieldErrors: { [field]: [message] } },
  };
}

function invalid(error: z.ZodError) {
  return {
    ok: false as const,
    status: 400,
    error: "Invalid input",
    details: z.flattenError(error),
  };
}

const notFound = { ok: false as const, status: 404, error: "Campaign not found" };

export async function createCampaign(workspaceId: string, body: unknown) {
  const parsed = createCampaignSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  const requestedInstagramAccountId =
    parsed.data.instagramAccountId && parsed.data.instagramAccountId !== "all"
      ? parsed.data.instagramAccountId
      : null;

  const [workspace, instagramAccount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    requestedInstagramAccountId
      ? prisma.instagramAccount.findFirst({
          where: { id: requestedInstagramAccountId, workspaceId },
        })
      : prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { connectedAt: "desc" },
        }),
  ]);

  if (!workspace) {
    return { ok: false as const, status: 404, error: "Workspace not found" };
  }

  if (!instagramAccount) {
    return {
      ok: false as const,
      status: 400,
      error: "Connect Instagram before creating campaigns",
    };
  }

  const linkCreates = buildInitialCampaignLinks({
    workspaceId,
    primaryUrl: parsed.data.trackedDestinationUrl,
    secondaryUrl: parsed.data.secondaryDestinationUrl,
    secondaryLabel: parsed.data.secondaryButtonLabel,
  });

  const { pendingNextReel, matchAnyPost, matchAnyWord, dmEnabled } =
    parsed.data;
  // Without a DM there is no opening DM, follow gate, follow-up or DM trigger.
  const openingDmEnabled = dmEnabled && parsed.data.openingDmEnabled;
  const requireFollow = dmEnabled && parsed.data.requireFollow;
  const followUpEnabled = dmEnabled && parsed.data.followUpEnabled;
  // Posts are only stored for the "specific posts" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const posts = isSpecificPost
    ? normalizePosts(parsed.data.posts, parsed.data.postId, parsed.data.postUrl)
    : [];
  const publicReplyList = publicReplyListOf(
    parsed.data.publicReplyMessages,
    parsed.data.publicReplyMessage
  );

  const automation = await prisma.automation.create({
    data: {
      name: parsed.data.name,
      goal: parsed.data.goal,
      // A next-reel campaign has no post yet; the cron binds it once a reel is
      // posted. The first chosen post is mirrored on the campaign itself.
      postId: posts[0]?.postId ?? null,
      postUrl: posts[0]?.postUrl ?? null,
      ...(posts.length > 0 ? { posts: { create: postRows(posts) } } : {}),
      pendingNextReel,
      matchAnyPost,
      keywords: matchAnyWord ? [] : parsed.data.keywords,
      matchAnyWord,
      dmTriggerEnabled: dmEnabled && parsed.data.dmTriggerEnabled,
      dmEnabled,
      dmMessage: dmEnabled ? parsed.data.dmMessage : "",
      openingDmEnabled,
      openingDmMessage: openingDmEnabled
        ? parsed.data.openingDmMessage || null
        : null,
      openingDmButtonLabel: openingDmEnabled
        ? parsed.data.openingDmButtonLabel || null
        : null,
      linkButtonLabel: parsed.data.linkButtonLabel || null,
      requireFollow,
      followPromptMessage: requireFollow
        ? parsed.data.followPromptMessage || null
        : null,
      followPromptButtonLabel: requireFollow
        ? parsed.data.followPromptButtonLabel || null
        : null,
      followUpEnabled,
      followUpMessage: followUpEnabled
        ? parsed.data.followUpMessage || null
        : null,
      followUpDelayMinutes: followUpEnabled
        ? parsed.data.followUpDelayMinutes
        : 0,
      publicReplyEnabled: parsed.data.publicReplyEnabled,
      publicReplyMessages: parsed.data.publicReplyEnabled
        ? publicReplyList
        : [],
      publicReplyMessage: parsed.data.publicReplyEnabled
        ? publicReplyList[0] ?? parsed.data.publicReplyMessage ?? null
        : null,
      isActive: parsed.data.isActive,
      wholeWordMatch: parsed.data.wholeWordMatch,
      workspaceId,
      instagramAccountId: instagramAccount.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0
        ? { trackedLinks: { create: linkCreates } }
        : {}),
    },
    include: {
      trackedLinks: true,
      posts: { orderBy: { position: "asc" } },
    },
  });

  return { ok: true as const, data: automation };
}

export async function updateCampaign(
  workspaceId: string,
  automationId: string,
  body: unknown
) {
  const parsed = updateCampaignSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) return notFound;

  const {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    posts: postsInput,
    ...automationData
  } = parsed.data;

  // Moving a campaign to another account: it must be one of this workspace's.
  if (
    automationData.instagramAccountId !== undefined &&
    automationData.instagramAccountId !== existing.instagramAccountId
  ) {
    const account = await prisma.instagramAccount.findFirst({
      where: { id: automationData.instagramAccountId, workspaceId },
      select: { id: true },
    });
    if (!account) {
      return {
        ok: false as const,
        status: 404,
        error: "Instagram account not found",
      };
    }
  }

  // Keep dependent fields consistent: any-word clears keywords; a disabled
  // opening DM clears its message and button.
  if (automationData.matchAnyWord === true) automationData.keywords = [];
  if (automationData.openingDmEnabled === false) {
    automationData.openingDmMessage = null;
    automationData.openingDmButtonLabel = null;
  }
  if (automationData.requireFollow === false) {
    automationData.followPromptMessage = null;
    automationData.followPromptButtonLabel = null;
  }
  if (automationData.followUpEnabled === false) {
    automationData.followUpMessage = null;
    automationData.followUpDelayMinutes = 0;
  }
  // Which posts the campaign listens on after this save. `undefined` leaves the
  // stored list alone; an any-post / next-reel campaign carries none.
  let nextPosts: { postId: string; postUrl: string | null }[] | undefined;
  if (automationData.matchAnyPost === true || automationData.pendingNextReel === true) {
    nextPosts = [];
  } else if (postsInput !== undefined || automationData.postId !== undefined) {
    nextPosts = normalizePosts(
      postsInput,
      automationData.postId,
      automationData.postUrl
    );
  }
  if (nextPosts !== undefined) {
    const matchAnyPost = automationData.matchAnyPost ?? existing.matchAnyPost;
    const pendingNextReel =
      automationData.pendingNextReel ?? existing.pendingNextReel;
    if (!matchAnyPost && !pendingNextReel && nextPosts.length === 0) {
      return invalidField("postId", "Choose which post(s) trigger the campaign");
    }
    automationData.postId = nextPosts[0]?.postId ?? null;
    automationData.postUrl = nextPosts[0]?.postUrl ?? null;
  }
  // Keep the public-reply variations list and the legacy single field in sync.
  if (automationData.publicReplyMessages !== undefined) {
    const list = automationData.publicReplyMessages
      .map((m) => m.trim())
      .filter(Boolean);
    automationData.publicReplyMessages = list;
    automationData.publicReplyMessage = list[0] ?? null;
  }
  if (automationData.publicReplyEnabled === false) {
    automationData.publicReplyMessages = [];
    automationData.publicReplyMessage = null;
  }

  // DM on or off, judged on the campaign as it will be after this save. The
  // rules are only checked when this save touches the DM or the public reply,
  // so pausing or renaming a campaign is never blocked by them.
  const dmEnabled = automationData.dmEnabled ?? existing.dmEnabled ?? true;
  const touchesDelivery = [
    automationData.dmEnabled,
    automationData.dmMessage,
    automationData.publicReplyEnabled,
    automationData.publicReplyMessages,
    automationData.publicReplyMessage,
  ].some((value) => value !== undefined);
  if (touchesDelivery && dmEnabled) {
    const dmMessage = automationData.dmMessage ?? existing.dmMessage ?? "";
    if (!dmMessage.trim()) return invalidField("dmMessage", "Add the DM message");
  }
  if (touchesDelivery && !dmEnabled) {
    const publicReplyEnabled =
      automationData.publicReplyEnabled ?? existing.publicReplyEnabled;
    const replies = publicReplyListOf(
      automationData.publicReplyMessages ?? existing.publicReplyMessages,
      automationData.publicReplyMessage !== undefined
        ? automationData.publicReplyMessage
        : existing.publicReplyMessage
    );
    if (!publicReplyEnabled || replies.length === 0) {
      return invalidField(
        "publicReplyMessages",
        "A campaign without a DM needs a public reply"
      );
    }
  }
  if (!dmEnabled) {
    // Nothing is sent by DM, so the DM-only settings stay switched off.
    automationData.dmMessage = "";
    automationData.dmTriggerEnabled = false;
    automationData.openingDmEnabled = false;
    automationData.openingDmMessage = null;
    automationData.openingDmButtonLabel = null;
    automationData.requireFollow = false;
    automationData.followPromptMessage = null;
    automationData.followPromptButtonLabel = null;
    automationData.followUpEnabled = false;
    automationData.followUpMessage = null;
    automationData.followUpDelayMinutes = 0;
  }

  // One transaction, so a save never lands half applied. Updating the campaign
  // first locks its row, which makes a second save of the same campaign wait
  // for this one before it reads the links.
  const updated = await prisma.$transaction(async (tx) => {
    const campaign = await tx.automation.update({
      where: { id: automationId },
      data: automationData,
    });

    if (nextPosts !== undefined) {
      await tx.automationPost.deleteMany({ where: { automationId } });
      if (nextPosts.length > 0) {
        await tx.automationPost.createMany({
          data: postRows(nextPosts).map((row) => ({ ...row, automationId })),
        });
      }
    }

    await syncCampaignLinks(tx, {
      workspaceId,
      automationId,
      primaryUrl: trackedDestinationUrl,
      secondaryUrl: secondaryDestinationUrl,
      secondaryLabel: secondaryButtonLabel,
    });

    return campaign;
  });

  return { ok: true as const, data: updated };
}

export async function deleteCampaign(workspaceId: string, automationId: string) {
  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) return notFound;

  await prisma.automation.delete({ where: { id: automationId } });

  return { ok: true as const, data: { deleted: true } };
}
