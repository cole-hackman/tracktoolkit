"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button, Panel } from "@/components/ui";
import { NAV_LINKS, type NavLink } from "@/lib/nav";

/**
 * The "guided" arm of the activation experiment
 * (docs/experiments/2026-11-activation-guided-first-run.md): a panel at the
 * top of the dashboard that narrows the tool grid to three first jobs and
 * says, for each, the three things the person will do on the next page.
 *
 * It is shown to a new account that has not completed a write, and goes away
 * once they have. The dashboard below it is unchanged, so nothing is taken
 * away from someone who knows what they came for.
 *
 * The three jobs are the playlist-creating tools in dashboard order
 * (`TOOL_RANKING`). All three make a NEW playlist by default, which is what
 * lets the panel promise that nothing already in the library is changed.
 * A tool that deletes (the Like, Following and Repost managers) does not
 * belong here.
 *
 * Each step names a control by the label it has on the tool page. If a label
 * changes there, change it here; e2e/first-run.spec.ts opens each page and
 * looks for them.
 */

interface FirstRunJob {
  href: string;
  title: string;
  steps: [string, string, string];
}

export const FIRST_RUN_JOBS: readonly FirstRunJob[] = [
  {
    href: "/combine",
    title: "Combine playlists into one",
    steps: [
      "Tick two or more of your playlists.",
      "Type a name under New Playlist Name.",
      "Press Merge Playlists. Duplicates are removed.",
    ],
  },
  {
    href: "/likes-to-playlist",
    title: "Save your likes as a playlist",
    steps: [
      "Tick the liked tracks you want, or select all.",
      "Type a name under Playlist name.",
      "Press Create Playlist.",
    ],
  },
  {
    href: "/playlist-cloner",
    title: "Copy someone else's playlist",
    steps: [
      "Paste the link to a SoundCloud playlist.",
      "Name the copy, or keep its name.",
      "Press Clone Playlist.",
    ],
  },
];

/** The tool behind a job, from the one list of tools, so a rename cannot drift. */
function toolFor(href: string): NavLink {
  const link = NAV_LINKS.find((candidate) => candidate.href === href);
  if (!link) throw new Error(`First-run job points at ${href}, which is not in NAV`);
  return link;
}

const JOBS = FIRST_RUN_JOBS.map((job) => ({ ...job, tool: toolFor(job.href) }));

export function FirstRunGuide({ onHide }: { onHide: () => void }) {
  return (
    <Panel
      title="Start here"
      actions={
        <Button variant="ghost" size="sm" onClick={onHide} nowrap>
          Hide this
        </Button>
      }
    >
      {/* In the body, not Panel's `description`: a description this long takes
          the whole heading row and pushes "Hide this" onto a line of its own. */}
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">
        New to Track Toolkit? Pick one of these to make your first playlist. Each one creates a new
        playlist; the playlists and likes you already have stay as they are.
      </p>
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {JOBS.map(({ href, title, steps, tool }) => (
          <li
            key={href}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-background p-4"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <tool.icon aria-hidden="true" className="h-5 w-5" />
              </span>
              <h3 className="min-w-0 text-base font-bold text-foreground">{title}</h3>
            </div>
            <ol className="flex-1 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
              {steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <Link
              href={href}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-center text-sm font-semibold text-primary-foreground shadow-elevation-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Open {tool.label}
              <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
