"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/api";

/**
 * The page side of the flag system in `server/lib/flags.js`.
 *
 * The server decides everything. `/api/auth/me` lists the experiments this
 * account could be in (`user.experiments`); for one of those, the page asks
 * `POST /api/experiments/exposure` at the moment it is about to render the
 * part that differs, and renders the arm it is told. That request is also
 * what records the exposure, so it is made from the component that shows the
 * difference and nowhere else.
 *
 * An account that is not listed makes no request at all. That is everyone
 * while a flag is at 0%.
 */

/** The activation experiment; see docs/experiments/. */
export const GUIDED_FIRST_RUN = "guided-first-run";

/** "Hide this" on the first-run panel. Per browser, like the other notices. */
export const FIRST_RUN_HIDDEN_KEY = "track-toolkit-first-run-hidden";

export interface ExposureResult {
  key: string;
  enrolled: boolean;
  variant: string | null;
  /** True once the account has completed a write. */
  activated: boolean;
}

const CONTROL: ExposureResult = { key: "", enrolled: false, variant: null, activated: false };

/** How long the page waits for an arm before it shows control. */
const EXPOSURE_TIMEOUT_MS = 4000;

async function fetchExposure(key: string): Promise<ExposureResult> {
  const response = await apiFetch("/api/experiments/exposure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(EXPOSURE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Exposure request failed (${response.status})`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") throw new Error("Exposure response was not an object");
  const { enrolled, variant, activated } = body as Record<string, unknown>;
  return {
    key,
    enrolled: enrolled === true,
    variant: typeof variant === "string" ? variant : null,
    activated: activated === true,
  };
}

/**
 * The arm this account is in for `key`.
 *
 * `variant` is null (control) until an answer fetched by THIS mount has
 * arrived, and stays null on any failure. So the variant is only ever shown
 * to someone the server has just confirmed is in it, and an answer cached by
 * an earlier visit is never trusted: a user who completes their first write
 * and comes back must not be shown the panel while the page re-asks.
 */
export function useExperiment(key: string): ExposureResult {
  const { user } = useAuth();
  const candidate = !!user?.experiments?.includes(key);

  const query = useQuery({
    queryKey: ["experiment", key, user?.id ?? null],
    queryFn: () => fetchExposure(key),
    enabled: candidate,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!candidate || !query.isFetchedAfterMount || query.isError || !query.data) return CONTROL;
  return query.data.enrolled ? query.data : CONTROL;
}

/** True when a rollout flag from `server/lib/flags.js` is on for this account. */
export function useFlag(key: string): boolean {
  const { user } = useAuth();
  return !!user?.flags?.includes(key);
}
