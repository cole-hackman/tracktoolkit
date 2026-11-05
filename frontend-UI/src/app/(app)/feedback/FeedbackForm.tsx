"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ActionBar, Button, Card, Field, InlineAlert, Input, Panel, Select } from "@/components/ui";
import { SupportLink } from "@/components/SupportLink";
import { apiFetchJson, isApiError } from "@/lib/api";
import { NAV_LINKS, toolLabelForPath } from "@/lib/nav";
import { cn } from "@/lib/utils";

/* ── Shapes shared with the backend (server/routes/feedback.js) ── */

type FeedbackType = "bug" | "feature" | "other";

const TYPE_OPTIONS: { value: FeedbackType; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature request" },
  { value: "other", label: "Something else" },
];

const TYPE_LABELS: Record<string, string> = {
  bug: "Bug",
  feature: "Feature request",
  other: "Something else",
};

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  seen: "Seen",
  done: "Done",
  spam: "Spam",
};

const MESSAGE_MIN = 10;
const MESSAGE_MAX = 2000;

/**
 * Same shape the server's `page` validator accepts. Anything else in `?from=`
 * is dropped rather than sent, so a hand-edited URL cannot make the form fail
 * validation on a field the user never sees.
 */
const APP_ROUTE_RE = /^\/[a-z0-9\-/]{0,199}$/;

/** Deliberately permissive — the server's `isEmail` is the real check. This
 *  only exists to catch the obvious typo before a round trip. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SubmitResult {
  id?: string;
  createdAt?: string;
}

interface MyFeedbackItem {
  id: string;
  type: string;
  page: string | null;
  status: string;
  createdAt: string;
}

interface FieldErrors {
  type?: string;
  message?: string;
  email?: string;
}

function parseType(raw: string | null): FeedbackType | "" {
  return raw === "bug" || raw === "feature" || raw === "other" ? raw : "";
}

function parseFrom(raw: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!APP_ROUTE_RE.test(trimmed)) return "";
  // NAV hrefs carry no trailing slash; the static export's URLs do.
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function FeedbackForm() {
  const searchParams = useSearchParams();

  const [type, setType] = useState<FeedbackType | "">(() => parseType(searchParams.get("type")));
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(() => parseFrom(searchParams.get("from")));
  const [pickingTool, setPickingTool] = useState(false);
  const [email, setEmail] = useState("");

  const [errors, setErrors] = useState<FieldErrors>({});
  const [formAlert, setFormAlert] = useState<React.ReactNode>(null);
  const [alertVariant, setAlertVariant] = useState<"error" | "warning">("error");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const [recent, setRecent] = useState<MyFeedbackItem[]>([]);

  /**
   * Local polite live region. Task 6 adds a shared `useAnnounce` hook; when it
   * lands, this state plus the `<span>` at the bottom of the form collapse
   * into `const announce = useAnnounce()`.
   */
  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((text: string) => setAnnouncement(text), []);

  const firstRadioRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLHeadingElement>(null);

  const typeGroupId = useId();
  const typeErrorId = `${typeGroupId}-error`;
  const counterId = useId();

  const loadRecent = useCallback(async () => {
    try {
      const data = await apiFetchJson<{ items?: MyFeedbackItem[] }>("/api/feedback/mine");
      setRecent(Array.isArray(data?.items) ? data.items : []);
    } catch {
      // Supplementary context, not the point of the page — if it fails the
      // form still works, and an error banner here would only add noise.
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  // Success replaces the form, and "Send another" replaces it back — either
  // way the outgoing element is gone, so focus has to follow explicitly or it
  // lands on <body>. Skip the very first run: that's the initial mount, where
  // `result` is already null and nothing was just reset.
  const skipFocusEffectRef = useRef(true);
  useEffect(() => {
    if (skipFocusEffectRef.current) {
      skipFocusEffectRef.current = false;
      return;
    }
    if (result) {
      confirmationRef.current?.focus();
    } else {
      firstRadioRef.current?.focus();
    }
  }, [result]);

  function validate(): { errors: FieldErrors; focus: HTMLElement | null } {
    const next: FieldErrors = {};
    let focus: HTMLElement | null = null;

    if (!type) {
      next.type = "Pick what this is about.";
      focus = firstRadioRef.current;
    }

    const trimmed = message.trim();
    if (trimmed.length < MESSAGE_MIN) {
      next.message = `Tell us a bit more — at least ${MESSAGE_MIN} characters.`;
      focus = focus ?? messageRef.current;
    } else if (trimmed.length > MESSAGE_MAX) {
      next.message = `That is over ${MESSAGE_MAX} characters. Trim it a little.`;
      focus = focus ?? messageRef.current;
    }

    const trimmedEmail = email.trim();
    if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
      next.email = "Enter a valid email address, or leave it blank.";
      focus = focus ?? emailRef.current;
    }

    return { errors: next, focus };
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // Honeypot, read from the DOM rather than React state: a bot that sets
    // `input.value = "x"` directly (no `input` event) still updates the DOM
    // node, so `FormData` sees it even though React's controlled-input state
    // never would have.
    const website = String(new FormData(event.currentTarget).get("website") ?? "");

    setFormAlert(null);
    const { errors: found, focus } = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      announce("The form has errors. Check the highlighted fields.");
      focus?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const data = await apiFetchJson<SubmitResult>("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          message: message.trim(),
          page: page || undefined,
          email: email.trim() || undefined,
          website,
        }),
      });
      setResult(data ?? {});
      announce("Feedback sent");
      void loadRecent();
    } catch (error) {
      const status = isApiError(error) ? error.status : 0;

      if (status === 400 && isApiError(error) && error.details?.length) {
        const mapped: FieldErrors = {};
        const leftover: string[] = [];
        for (const detail of error.details) {
          if (detail.field === "type") mapped.type = detail.message;
          else if (detail.field === "message") mapped.message = detail.message;
          else if (detail.field === "email") mapped.email = detail.message;
          else leftover.push(detail.message);
        }
        setErrors(mapped);
        setAlertVariant("error");
        setFormAlert(
          leftover.length > 0
            ? leftover.join(" ")
            : "Some of that didn't go through — check the highlighted fields.",
        );
        announce("The form has errors. Check the highlighted fields.");
        if (mapped.type) firstRadioRef.current?.focus();
        else if (mapped.message) messageRef.current?.focus();
        else if (mapped.email) emailRef.current?.focus();
      } else if (status === 409) {
        setAlertVariant("warning");
        setFormAlert("Looks like you already sent this today.");
        announce("Looks like you already sent this today.");
      } else if (status === 429) {
        setAlertVariant("warning");
        setFormAlert(
          <>
            Too many reports in a short time. Try again in an hour, or{" "}
            <SupportLink subject="Track Toolkit feedback">email us</SupportLink>.
          </>,
        );
        announce("Too many reports in a short time.");
      } else {
        setAlertVariant("error");
        setFormAlert(
          <>
            That didn&apos;t send. Check your connection and try again, or{" "}
            <SupportLink subject="Track Toolkit feedback">email us</SupportLink>.
          </>,
        );
        announce("Feedback could not be sent.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSendAnother() {
    setResult(null);
    setType("");
    setMessage("");
    setEmail("");
    setErrors({});
    setFormAlert(null);
    announce("");
  }

  const toolLabel = toolLabelForPath(page) ?? (page || "Other / not sure");
  const knownHrefs = new Set(NAV_LINKS.map((link) => link.href));
  const unlistedPage = page && !knownHrefs.has(page) ? page : null;

  return (
    <div className="space-y-6">
      {result ? (
        <Panel>
          <div role="status">
            <h2
              ref={confirmationRef}
              tabIndex={-1}
              className="text-lg font-semibold text-foreground focus:outline-none focus-visible:outline-none"
            >
              Thanks — got it
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This goes straight into the inbox Cole reads. There is no ticket queue
              behind it, so you may not get a reply — but it is read.
            </p>
            {result.id ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Reference{" "}
                <code className="break-all rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-secondary-foreground">
                  {result.id}
                </code>
              </p>
            ) : null}
            <p className="mt-3 text-sm text-muted-foreground">
              For anything urgent, email{" "}
              <SupportLink subject="Track Toolkit — urgent">
                Cole directly
              </SupportLink>
              .
            </p>
            <ActionBar>
              <Button type="button" onClick={handleSendAnother}>
                Send another
              </Button>
              <Link
                href="/dashboard"
                className="inline-flex h-11 items-center justify-center rounded-lg border border-border/70 bg-secondary px-4 text-sm font-semibold text-secondary-foreground shadow-sm transition hover:border-primary/40 hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                Back to dashboard
              </Link>
            </ActionBar>
          </div>
        </Panel>
      ) : (
        <Panel>
          <form onSubmit={handleSubmit} noValidate className="grid gap-4">
            {formAlert ? (
              <InlineAlert variant={alertVariant}>{formAlert}</InlineAlert>
            ) : null}

            {/* 1 — what is this about */}
            <fieldset className="min-w-0 border-0 p-0">
              <legend id={typeGroupId} className="text-sm font-semibold text-foreground">
                What is this about? <span aria-hidden="true">*</span>
              </legend>
              <div
                role="radiogroup"
                aria-required="true"
                aria-labelledby={typeGroupId}
                className="mt-2 grid gap-2 sm:grid-cols-3"
              >
                {TYPE_OPTIONS.map((option, index) => (
                  <label
                    key={option.value}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border bg-surface px-3 py-2 text-sm transition-colors",
                      "hover:border-primary/40 dark:bg-white/5",
                      type === option.value
                        ? "border-primary ring-1 ring-primary/40"
                        : "border-input",
                      errors.type && "border-destructive",
                    )}
                  >
                    <input
                      ref={index === 0 ? firstRadioRef : undefined}
                      type="radio"
                      name="feedback-type"
                      value={option.value}
                      checked={type === option.value}
                      onChange={() => {
                        setType(option.value);
                        setErrors((prev) => ({ ...prev, type: undefined }));
                      }}
                      // No `aria-invalid`: ARIA does not support it on role
                      // `radio`. The `role="alert"` message below is wired to
                      // every radio through `aria-describedby` instead, which
                      // is what a screen reader reads out on focus.
                      aria-describedby={errors.type ? typeErrorId : undefined}
                      className="h-5 w-5 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 font-medium text-foreground">
                      {option.label}
                    </span>
                  </label>
                ))}
              </div>
              {errors.type ? (
                <p id={typeErrorId} role="alert" className="mt-1.5 text-sm text-destructive-text">
                  {errors.type}
                </p>
              ) : null}
            </fieldset>

            {/* 2 — the message */}
            <div className="grid gap-1.5">
              <Field
                label="What happened, or what would you like?"
                required
                hint="10–2000 characters. Steps to reproduce help a lot."
                error={errors.message}
              >
                {(field) => (
                  <textarea
                    {...field}
                    ref={messageRef}
                    rows={6}
                    maxLength={MESSAGE_MAX}
                    value={message}
                    onChange={(event) => {
                      setMessage(event.target.value);
                      setErrors((prev) => ({ ...prev, message: undefined }));
                    }}
                    aria-describedby={
                      [field["aria-describedby"], counterId].filter(Boolean).join(" ") ||
                      undefined
                    }
                    className={cn(
                      "w-full resize-y rounded-md border bg-surface px-3 py-2 text-base text-foreground shadow-sm sm:text-sm",
                      "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      errors.message
                        ? "border-destructive focus-visible:ring-destructive/40"
                        : "border-input focus-visible:ring-primary/60",
                      "dark:bg-white/5 transition-colors duration-150",
                    )}
                  />
                )}
              </Field>
              <span
                id={counterId}
                aria-live="polite"
                className="justify-self-end text-xs text-muted-foreground-subtle"
              >
                {message.length}/{MESSAGE_MAX}
              </span>
            </div>

            {/* 3 — where were you */}
            <div className="grid gap-2">
              <span className="text-sm font-semibold text-foreground">Where were you?</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-block max-w-full truncate rounded-full border border-border bg-secondary px-3 py-1.5 text-sm text-secondary-foreground">
                  {toolLabel}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  aria-expanded={pickingTool}
                  aria-label="Change tool"
                  onClick={() => setPickingTool((open) => !open)}
                >
                  Change
                </Button>
              </div>
              {pickingTool ? (
                <Select
                  label="Tool"
                  value={page}
                  onChange={(event) => setPage(event.target.value)}
                >
                  <option value="">Other / not sure</option>
                  {unlistedPage ? (
                    <option value={unlistedPage}>{unlistedPage}</option>
                  ) : null}
                  {NAV_LINKS.map((link) => (
                    <option key={link.href} value={link.href}>
                      {link.label}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>

            {/* 4 — optional reply address */}
            <div className="grid gap-1.5">
              <Field
                label="Email (optional)"
                hint="Only used to reply to this report. No newsletters."
                error={errors.email}
              >
                {(field) => (
                  <Input
                    {...field}
                    ref={emailRef}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setErrors((prev) => ({ ...prev, email: undefined }));
                    }}
                  />
                )}
              </Field>
              <p className="text-sm text-muted-foreground">
                Stored with the report and nothing else — see the{" "}
                <Link
                  href="/privacy"
                  className="underline underline-offset-2 transition hover:text-primary-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm"
                >
                  privacy policy
                </Link>
                .
              </p>
            </div>

            {/* 5 — honeypot. Out of the accessibility tree and out of the tab
                order; only automation ever fills it in. Left uncontrolled —
                read straight from the DOM in handleSubmit via FormData — so
                a bot that sets `.value` without dispatching an `input` event
                still gets caught. */}
            <div aria-hidden="true" className="absolute -left-[9999px] h-0 overflow-hidden">
              <label>
                Website
                <input name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>

            {/* 6 — submit */}
            <ActionBar className="mt-2">
              <Button type="submit" size="lg" disabled={submitting}>
                {submitting ? "Sending…" : "Send feedback"}
              </Button>
            </ActionBar>
          </form>
        </Panel>
      )}

      {recent.length > 0 ? (
        <section aria-labelledby="recent-reports-heading">
          <h2
            id="recent-reports-heading"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Your recent reports
          </h2>
          <ul className="mt-3 grid gap-2">
            {recent.map((item) => (
              <li key={item.id}>
                <Card className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm">
                  <span className="font-medium text-foreground">
                    {TYPE_LABELS[item.type] ?? item.type}
                  </span>
                  <span className="text-muted-foreground">
                    {toolLabelForPath(item.page) ?? item.page ?? "Not specified"}
                  </span>
                  <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground">
                    {STATUS_LABELS[item.status] ?? item.status}
                  </span>
                  <span className="text-xs text-muted-foreground-subtle">
                    {formatDate(item.createdAt)}
                  </span>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  );
}

export default FeedbackForm;
