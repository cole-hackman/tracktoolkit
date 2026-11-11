"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Download, LogOut, Trash2 } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  Field,
  InlineAlert,
  Input,
  PageContainer,
  PageHeader,
  Panel,
  useAnnounce,
} from "@/components/ui";
import { SupportLink } from "@/components/SupportLink";
import { useAuth } from "@/contexts/AuthContext";
import { apiFetch } from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

/**
 * What the retention job in `server/lib/retention.js` actually enforces —
 * `CACHE_TTL_DAYS` (7), `DISCONNECTED_GRACE_DAYS` (6), `INACTIVE_MONTHS` (24),
 * `GROWTH_RETENTION_DAYS` (365) and `FEEDBACK_RETENTION_DAYS` (730). Operation
 * logs have no age limit: they go with the account. If those change, this
 * table is wrong.
 */
const RETENTION: { what: string; keptFor: string }[] = [
  { what: "Account & tokens", keptFor: "While you stay connected" },
  { what: "Operation history", keptFor: "While your account exists" },
  { what: "Library cache", keptFor: "7 days" },
  { what: "Growth history", keptFor: "12 months" },
  { what: "Feedback", keptFor: "24 months" },
  {
    what: "Inactive accounts",
    keptFor: "Deleted after 24 months without a sign-in",
  },
];

/**
 * Everything a person can do about their own data, on one page: see it, take
 * it with them, hand the SoundCloud grant back, or delete the account
 * outright. The destructive pair are both behind a `ConfirmDialog`, and the
 * delete one additionally behind typing DELETE — the server checks the same
 * word, so the dialog is a mirror of the API's own guard rather than the only
 * thing standing between a stray click and the row.
 */
export default function AccountPage() {
  const { user } = useAuth();
  const announce = useAnnounce();

  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const disconnectTriggerRef = useRef<HTMLButtonElement>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);

  const handleDownload = () => {
    announce("Preparing your download");
    // A navigation rather than a fetch: the server answers with
    // `Content-Disposition: attachment`, so the browser saves the file and
    // the page stays where it is. Nothing to read back here.
    window.location.assign(`${API_BASE}/api/auth/export`);
  };

  const handleDisconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const res = await apiFetch("/api/auth/disconnect", { method: "POST" });
      if (res.ok) {
        // The session cookie is already cleared server-side; a full load drops
        // the in-memory auth state with it.
        window.location.href = "/";
        return;
      }
      setDisconnectError("We could not disconnect your account just now.");
    } catch {
      setDisconnectError("We could not reach the server to disconnect.");
    }
    setDisconnecting(false);
    setDisconnectOpen(false);
  };

  const handleDelete = async () => {
    if (deleteConfirmText !== "DELETE" || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await apiFetch("/api/auth/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      setDeleteError("We could not delete your account just now.");
    } catch {
      setDeleteError("We could not reach the server to delete your account.");
    }
    setDeleting(false);
    setDeleteOpen(false);
  };

  return (
    <PageContainer kind="form">
      <PageHeader
        title="Account"
        description="What Track Toolkit stores about you, and how to take it with you or remove it."
      />

      <div className="space-y-6">
        {/* ── Profile ── */}
        <Panel title="Profile">
          <div className="flex items-center gap-4">
            <img
              src={user?.avatar_url || "/brand/icon-192.png"}
              alt=""
              width={56}
              height={56}
              // Not lazy: it is the first image on the page and above the fold
              // on every viewport, so deferring it only delays the paint.
              decoding="async"
              className="h-14 w-14 shrink-0 rounded-full ring-1 ring-border"
            />
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-foreground">
                {user?.display_name || "—"}
              </p>
              <p className="truncate text-sm text-muted-foreground">
                {user?.username ? `@${user.username}` : ""}
              </p>
              {user?.soundcloudId ? (
                <p className="text-sm text-muted-foreground-subtle">
                  SoundCloud id {user.soundcloudId}
                </p>
              ) : null}
            </div>
          </div>
        </Panel>

        {/* ── Download my data ── */}
        <Panel title="Download my data" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            One file with everything keyed to your account: your account record,
            your operation history, your growth history, your feedback, your
            cached library pages, your indexed library and any library chats,
            and any survey answers you gave. Your SoundCloud tokens are not in
            it — they never leave the server.
          </p>
          <Button
            onClick={handleDownload}
            className="w-full sm:w-auto"
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Download my data
          </Button>
          <p className="text-sm text-muted-foreground-subtle">
            JSON, usually under a few megabytes.
          </p>
        </Panel>

        {/* ── Disconnect ── */}
        <Panel title="Disconnect SoundCloud" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Signs you out and deletes your saved sign-in tokens now. We keep the
            rest for 6 days so you can sign back in and keep your account. After
            that it is deleted. Your SoundCloud account is untouched.
          </p>
          {disconnectError ? (
            <InlineAlert variant="error">
              {disconnectError} Try again, or email{" "}
              <SupportLink subject="Disconnect problem" /> and we will do it for
              you.
            </InlineAlert>
          ) : null}
          <Button
            ref={disconnectTriggerRef}
            variant="outline"
            onClick={() => {
              setDisconnectError(null);
              setDisconnectOpen(true);
            }}
            className="w-full sm:w-auto"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Disconnect
          </Button>
        </Panel>

        {/* ── Delete account ── */}
        <Panel
          className="space-y-4 border-destructive/40"
          title={
            <span className="flex items-center gap-2">
              <AlertTriangle
                className="h-5 w-5 text-destructive-text"
                aria-hidden="true"
              />
              Delete account
            </span>
          }
        >
          <p className="text-sm text-muted-foreground">
            Permanently deletes your Track Toolkit account and everything stored
            with it — your login, connected SoundCloud tokens, operation
            history, growth history and feedback. Public catalog rows about
            tracks are not yours and stay. Your SoundCloud account and playlists
            are not affected. This cannot be undone.
          </p>
          {deleteError ? (
            <InlineAlert variant="error">
              {deleteError} Try again, or email{" "}
              <SupportLink subject="Account deletion problem" /> and we will do
              it for you.
            </InlineAlert>
          ) : null}
          <Button
            ref={deleteTriggerRef}
            variant="destructive"
            onClick={() => {
              setDeleteError(null);
              setDeleteConfirmText("");
              setDeleteOpen(true);
            }}
            className="w-full sm:w-auto"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Delete account
          </Button>
        </Panel>

        {/* ── Retention ── */}
        <Panel title="What we keep and for how long">
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">
              How long Track Toolkit keeps each kind of data
            </caption>
            <thead>
              <tr>
                <th
                  scope="col"
                  className="border-b border-border pb-2 pr-3 font-semibold text-foreground"
                >
                  What
                </th>
                <th
                  scope="col"
                  className="border-b border-border pb-2 font-semibold text-foreground"
                >
                  Kept for
                </th>
              </tr>
            </thead>
            <tbody>
              {RETENTION.map((row) => (
                <tr key={row.what}>
                  <th
                    scope="row"
                    className="border-b border-border/60 py-2 pr-3 align-top font-medium text-foreground"
                  >
                    {row.what}
                  </th>
                  <td className="border-b border-border/60 py-2 align-top text-muted-foreground">
                    {row.keptFor}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-sm">
            <Link
              href="/privacy/"
              className="rounded-sm font-medium text-primary-text underline underline-offset-2 transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Full privacy policy
            </Link>
          </p>
        </Panel>

        <p className="text-sm text-muted-foreground">
          Questions? <SupportLink subject="Account question" />
        </p>
      </div>

      <ConfirmDialog
        open={disconnectOpen}
        title="Disconnect from SoundCloud?"
        description="Your saved sign-in tokens are deleted straight away and you are signed out. We keep the rest for 6 days so you can sign back in and keep your account. After that it is deleted."
        confirmLabel={disconnecting ? "Disconnecting…" : "Disconnect"}
        confirmDisabled={disconnecting}
        onConfirm={handleDisconnect}
        onCancel={() => setDisconnectOpen(false)}
        returnFocusRef={disconnectTriggerRef}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Delete your account?"
        description="This permanently deletes your Track Toolkit account and everything stored with it. Your SoundCloud account and playlists are not affected. This cannot be undone."
        confirmLabel={deleting ? "Deleting…" : "Delete my account"}
        confirmDisabled={deleteConfirmText !== "DELETE" || deleting}
        variant="destructive"
        onConfirm={handleDelete}
        onCancel={() => setDeleteOpen(false)}
        returnFocusRef={deleteTriggerRef}
      >
        <Field label="Type DELETE to confirm">
          {(field) => (
            <Input
              {...field}
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          )}
        </Field>
      </ConfirmDialog>
    </PageContainer>
  );
}
