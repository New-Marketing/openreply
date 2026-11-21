import type { Metadata } from "next";
import { ArrowUpRightIcon } from "@/components/site/icons";
import {
  GITHUB_URL,
  getGitHubContributors,
} from "@/components/site/github";
import { SitePage } from "@/components/site/shell";

export const metadata: Metadata = {
  title: "Contributors - OpenReply",
  description:
    "The people who have contributed code to OpenReply, the free and open source Instagram comment-to-DM tool.",
};

function plural(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? "contribution" : "contributions"}`;
}

export default async function ContributorsPage() {
  const contributors = await getGitHubContributors();
  const top = contributors?.slice(0, 3) ?? [];
  const total = contributors?.reduce((sum, c) => sum + c.contributions, 0) ?? 0;

  return (
    <SitePage active="contributors">
      <section className="wrap page-center">
        <h1 className="heading-1">Contributors</h1>
        <p className="page-center-sub body-3">
          The people who have contributed code to OpenReply, the free and open
          source Instagram comment-to-DM tool.
        </p>

        {contributors && contributors.length > 0 ? (
          <>
            <p className="contrib-stats body-5">
              <span>
                <b>{contributors.length}</b>{" "}
                {contributors.length === 1 ? "contributor" : "contributors"}
              </span>
              <span>
                <b>{total.toLocaleString()}</b>{" "}
                {total === 1 ? "contribution" : "contributions"}
              </span>
            </p>

            <h2 className="heading-5 contrib-heading">Top contributors</h2>
            <ul className="contrib-top">
              {top.map((person) => (
                <li key={person.login}>
                  <a className="contrib-card" href={person.url}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={person.avatar}
                      alt=""
                      width={80}
                      height={80}
                      loading="lazy"
                    />
                    <strong className="title-2">{person.login}</strong>
                    <span className="body-6 muted">
                      {plural(person.contributions)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>

            <h2 className="heading-5 contrib-heading">All contributors</h2>
            <ul className="contrib-grid">
              {contributors.map((person) => (
                <li key={person.login}>
                  <a className="contrib-row" href={person.url}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={person.avatar}
                      alt=""
                      width={40}
                      height={40}
                      loading="lazy"
                    />
                    <span>
                      <strong className="title-4">{person.login}</strong>
                      <span className="caption-5 muted">
                        {plural(person.contributions)}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="contrib-empty body-3 muted">
            The contributor list could not be loaded right now. You can see
            everyone on{" "}
            <a className="link-strong" href={`${GITHUB_URL}/graphs/contributors`}>
              GitHub
            </a>
            .
          </p>
        )}

        <p className="contrib-cta body-3 muted">
          Want to help?{" "}
          <a
            className="link-strong"
            href={`${GITHUB_URL}/blob/main/CONTRIBUTING.md`}
          >
            Read the contributing guide <ArrowUpRightIcon />
          </a>
        </p>
      </section>
    </SitePage>
  );
}
