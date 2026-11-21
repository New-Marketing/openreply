export const GITHUB_URL = "https://github.com/diwenne/openreply";
export const SETUP_DOCS_URL = `${GITHUB_URL}/blob/main/docs/setup.md`;
export const ZERNIO_DOCS_URL = `${GITHUB_URL}/blob/main/docs/zernio.md`;
export const SUPPORT_URL = "https://buymeacoffee.com/diwen";

export async function getGitHubStars(): Promise<number | null> {
  try {
    const res = await fetch("https://api.github.com/repos/diwenne/openreply", {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { stargazers_count?: number };
    return typeof data.stargazers_count === "number"
      ? data.stargazers_count
      : null;
  } catch {
    return null;
  }
}

export interface Contributor {
  login: string;
  url: string;
  avatar: string;
  contributions: number;
}

export async function getGitHubContributors(): Promise<Contributor[] | null> {
  try {
    const res = await fetch(
      "https://api.github.com/repos/diwenne/openreply/contributors?per_page=100",
      {
        headers: { Accept: "application/vnd.github+json" },
        next: { revalidate: 3600 },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      login?: string;
      html_url?: string;
      avatar_url?: string;
      contributions?: number;
      type?: string;
    }>;
    if (!Array.isArray(data)) return null;
    return data
      .filter((item) => item.type === "User" && item.login)
      .map((item) => ({
        login: item.login as string,
        url: item.html_url ?? `https://github.com/${item.login}`,
        avatar: `${item.avatar_url ?? ""}${item.avatar_url?.includes("?") ? "&" : "?"}s=160`,
        contributions: item.contributions ?? 0,
      }));
  } catch {
    return null;
  }
}
