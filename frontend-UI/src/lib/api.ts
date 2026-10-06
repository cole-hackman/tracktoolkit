/**
 * Authenticated fetch wrapper with global 401 interceptor.
 *
 * Every authenticated API call in the app should go through `apiFetch`
 * instead of raw `fetch`. When *any* response comes back 401 the wrapper
 * clears the stale session cookie, resets the in-memory auth state, and
 * redirects the user to /login so they can re-authenticate.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

/** Callback set by AuthProvider so the interceptor can clear React state */
let onSessionExpired: (() => void) | null = null;

/**
 * Register a callback that the 401 interceptor will invoke.
 * Called once from AuthProvider on mount.
 */
export function registerSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

/** Avoid redirect storms — only allow one redirect at a time */
let isRedirecting = false;

function handleExpiredSession() {
  if (isRedirecting) return;
  isRedirecting = true;

  // Clear the session cookie from the browser
  document.cookie = "session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";

  // Reset React auth state if handler is registered
  onSessionExpired?.();

  // Redirect to login
  window.location.href = "/login";
}

/**
 * Drop-in replacement for `fetch()` that:
 *  1. Prepends API_BASE automatically
 *  2. Sends credentials: "include" by default
 *  3. Intercepts 401 responses → clears session + redirects to /login
 *
 * Usage:
 *   import { apiFetch } from "@/lib/api";
 *   const res = await apiFetch("/api/playlists");
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...init?.headers,
    },
  });

  if (response.status === 401) {
    handleExpiredSession();
  }

  return response;
}

/** One entry of the backend's `{ error, details }` validation payload. */
export interface ApiErrorDetail {
  field: string;
  message: string;
}

/**
 * What `apiFetchJson` throws on a non-2xx response.
 *
 * Still a plain `Error` with the server's message, so every existing
 * `catch (e) { e.message }` call site behaves exactly as before — `status`
 * and `details` are additions for callers that need to tell 409 from 429
 * from a field-level 400 rather than just showing the text.
 */
export interface ApiError extends Error {
  status: number;
  details?: ApiErrorDetail[];
}

/** Narrows an unknown `catch` binding to an {@link ApiError}. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof Error && typeof (error as ApiError).status === "number";
}

/** The server's `{ error }` string when the body has one, else `fallback`. */
function errorMessageFromBody(data: unknown, fallback: string): string {
  const error = (data as { error?: unknown } | null | undefined)?.error;
  return typeof error === "string" && error.trim() !== "" ? error : fallback;
}

/**
 * The text to show for a non-OK response: the server's own `error` string
 * (the 409 refusals on playlist writes carry a reason a user can act on),
 * or `fallback` when the body is not JSON or has no `error`. Consumes the
 * response body.
 */
export async function readApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const data = await response.json().catch(() => null);
  return errorMessageFromBody(data, fallback);
}

export async function apiFetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await apiFetch(path, init);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = errorMessageFromBody(
      data,
      `Request failed with status ${response.status}`,
    );
    const error = new Error(message) as ApiError;
    error.status = response.status;
    if (Array.isArray(data?.details)) {
      error.details = data.details.filter(
        (d: unknown): d is ApiErrorDetail =>
          !!d && typeof (d as ApiErrorDetail).field === "string",
      );
    }
    throw error;
  }

  return data as T;
}
