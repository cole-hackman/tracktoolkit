"use client";

import { BrandWordmark } from "@/components/brand/Logo";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Card, LoadingSpinner, Button } from "@/components/ui";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { SupportLink } from "@/components/SupportLink";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "";

export default function LoginPage() {
  const { isAuthenticated, loading, login, apiUnreachable, retryAuth } = useAuth();
  const router = useRouter();
  const [prewarming, setPrewarming] = useState(false);

  useEffect(() => {
    if (!loading && isAuthenticated) {
      router.push("/dashboard");
    }
  }, [isAuthenticated, loading, router]);

  // Pre-warm API before redirecting to reduce cold-start hiccups
  const prewarmAndLogin = async () => {
    if (apiUnreachable || prewarming) return;
    setPrewarming(true);
    try {
      await Promise.race([
        fetch(`${API_BASE}/health`, { credentials: "include" }),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    } catch {
      // Ignore errors
    }
    try {
      // one retry if it was asleep
      await Promise.race([
        fetch(`${API_BASE}/health`, { credentials: "include" }),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    } catch {
      // Ignore errors
    }
    try {
      login();
    } finally {
      setPrewarming(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100dvh-var(--announcement-h))] flex-col bg-background text-foreground">
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10 focus:outline-none sm:px-6 lg:max-w-6xl lg:px-8"
      >
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(380px,420px)] lg:gap-16 xl:gap-20">
          <section className="flex flex-col items-start">
            <Link href="/" aria-label="Track Toolkit home" className="-ml-1 rounded-lg">
              <BrandWordmark title="" className="h-8 w-auto text-foreground" />
            </Link>

            <h1 className="mt-8 text-balance font-display text-[1.75rem] font-semibold leading-tight sm:text-4xl lg:mt-10 lg:text-[2.75rem] xl:text-5xl">
              Connect once.
              <br />
              <span className="text-gradient">Control every playlist.</span>
            </h1>

            <p className="mt-4 max-w-lg text-balance text-base leading-relaxed text-muted-foreground lg:mt-6 lg:text-lg">
              Merge playlists, clean up likes, and keep your library show-ready.
            </p>
          </section>

          <section aria-labelledby="sign-in-heading" className="w-full">
            <Card className="p-6 shadow-elevation-1 sm:p-8">
              <h2 id="sign-in-heading" className="text-xl font-semibold text-foreground">
                Connect your account
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                We&apos;ll open the official SoundCloud approval screen. Your
                password is never stored by Track Toolkit.
              </p>

              {apiUnreachable && (
                <InlineAlert variant="warning" title="Backend not reachable" className="mt-6">
                  <p>
                    Start the backend with <code>npm run dev:server</code> and
                    ensure <code>.env</code> is set.
                  </p>
                  <Button nowrap variant="ghost" className="mt-2 -ml-2 h-9 px-2" onClick={retryAuth}>
                    Retry connection
                  </Button>
                </InlineAlert>
              )}

              <Button
                type="button"
                onClick={prewarmAndLogin}
                disabled={apiUnreachable || prewarming}
                className="mt-8 h-12 w-full rounded-lg px-6 text-base"
              >
                {prewarming ? (
                  <span className="inline-flex items-center gap-2">
                    <LoadingSpinner size="sm" className="text-primary-foreground" />
                    Warming up…
                  </span>
                ) : (
                  <span className="whitespace-nowrap">Continue with SoundCloud</span>
                )}
              </Button>

              <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
                By connecting, you agree to our{" "}
                <Link href="/privacy" className="font-medium text-primary-text hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </Card>
          </section>
        </div>
      </main>

      {/* Outside the card so nothing sits beside the button, but still on the
          page: someone who cannot sign in is who needs Contact. */}
      <footer className="flex justify-center gap-2 px-4 pb-4 text-xs text-muted-foreground">
        <Link href="/terms" className="inline-flex min-h-11 items-center px-2 transition-colors hover:text-primary-text">
          Terms
        </Link>
        <SupportLink className="inline-flex min-h-11 items-center px-2 transition-colors hover:text-primary-text">
          Contact
        </SupportLink>
      </footer>
    </div>
  );
}
