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
        className="mx-auto flex w-full max-w-md flex-1 flex-col px-5 pb-2 pt-8 focus:outline-none sm:justify-center sm:px-6 sm:py-10 lg:max-w-6xl lg:px-8"
      >
        {/* On a phone the sign-in drops to the bottom of the screen, where a thumb
            is, instead of floating in the middle. */}
        <div className="flex flex-1 flex-col justify-between gap-8 sm:flex-none sm:justify-center sm:gap-10 lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(380px,420px)] lg:items-center lg:gap-16 xl:gap-20">
          <section className="flex flex-col items-start">
            <Link href="/" aria-label="Track Toolkit home" className="-ml-1 rounded-lg">
              <BrandWordmark title="" className="h-8 w-auto text-foreground" />
            </Link>

            <h1 className="mt-6 text-balance font-display text-[1.75rem] font-semibold leading-tight sm:text-4xl lg:mt-10 lg:text-[2.75rem] xl:text-5xl">
              Connect once.
              <br />
              <span className="text-gradient">Control every playlist.</span>
            </h1>

            <p className="mt-3 max-w-lg text-balance text-base leading-relaxed text-muted-foreground sm:mt-4 lg:mt-6 lg:text-lg">
              Merge playlists, clean up likes, and keep your library show-ready.
            </p>
          </section>

          <section aria-labelledby="sign-in-heading" className="w-full">
            {/* A phone gets a plain column: card chrome would cost 48px of the
                width the button needs. */}
            <Card className="border-0 bg-transparent shadow-none sm:border sm:bg-card sm:p-8 sm:shadow-elevation-1">
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
                className="mt-6 h-14 w-full touch-manipulation rounded-lg px-6 text-base sm:mt-8 sm:h-12"
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

              <p className="mt-3 text-center text-xs leading-5 sm:mt-4 text-muted-foreground">
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
      <footer className="flex justify-center gap-2 px-4 pb-2 text-xs sm:pb-4 text-muted-foreground">
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
