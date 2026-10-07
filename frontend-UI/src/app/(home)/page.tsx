"use client";

import Image from "next/image";
import { BrandWordmark } from "@/components/brand/Logo";
import Link from "next/link";
import { StructuredData } from "@/components/StructuredData";
import { SupportLink } from "@/components/SupportLink";
import { Button, Card } from "@/components/ui";
import { FlickeringGrid } from "@/components/ui/FlickeringGrid";
import { ShimmerButton } from "@/components/ui/ShimmerButton";
import { WordRotate } from "@/components/ui/WordRotate";
import {
  Layers,
  Heart,
  ArrowUpDown,
  Check,
  Lock,
  Shield,
  Radio,
  UserMinus,
  ThumbsDown,
  Download,
  HeartPulse,
  Link as LinkIcon,
  Music,
  Settings,
  LogIn,
  ArrowRight,
} from "lucide-react";

// FAQ data — trimmed teaser for the landing page. The full list (including
// the rest of the rename questions) lives on /faq, which is also the only
// page that emits FAQPage JSON-LD for this content.
const faqs = [
  {
    question: "Is Track Toolkit the same as SC Toolkit?",
    answer:
      "Yes — same product, same tools, same account and data. We just had to change the name.",
    linkHref: "/faq/#rebrand",
    linkLabel: "Read the rebrand FAQ",
  },
  {
    question: "Is Track Toolkit free to use?",
    answer: "Yes, Track Toolkit is completely free to use. We provide powerful playlist management and social tools at no cost to help you organize your SoundCloud music."
  },
  {
    question: "Do I need a SoundCloud Go+ or Pro subscription?",
    answer: "No! Track Toolkit works with all SoundCloud accounts, including free ones. You do not need a paid subscription to use any of our features."
  },
  {
    question: "How secure is my SoundCloud account?",
    answer: "Your account security is our top priority. We use official SoundCloud OAuth authentication, which means we never see or store your password. We only request the minimum permissions needed to manage your playlists, and all tokens are encrypted at rest with AES-256-GCM."
  },
  {
    question: "Can I merge playlists with more than 500 tracks?",
    answer: "Yes! When merging playlists that exceed 500 tracks, Track Toolkit automatically splits them into multiple playlists (e.g., Part 1/3, Part 2/3, Part 3/3) so you don't lose a single track."
  }
];

// Features data — rendered in the features grid and used for SEO copy
const features = [
  {
    icon: Layers,
    title: "Combine Playlists",
    href: "/combine",
    badge: "Most Popular",
    description: "Merge multiple playlists into one, remove duplicates automatically, and split past the 500-track limit without losing a song."
  },
  {
    icon: Heart,
    title: "Likes → Playlist",
    href: "/likes-to-playlist",
    badge: undefined,
    description: "Turn years of liked tracks into organized, export-ready playlists with custom names."
  },
  {
    icon: ArrowUpDown,
    title: "Playlist Modifier",
    href: "/playlist-modifier",
    badge: undefined,
    description: "Reorder tracks, remove unwanted songs, and sort by title, artist, date, duration, or BPM."
  },
  {
    icon: Download,
    title: "Downloads",
    href: "/downloads",
    badge: undefined,
    description: "Find and download tracks where the artist enabled downloads or added a purchase link."
  },
  {
    icon: Radio,
    title: "Activity to Playlist",
    href: "/activity-to-playlist",
    badge: undefined,
    description: "Save recently posted tracks from artists you follow before they get buried in your feed."
  },
  {
    icon: UserMinus,
    title: "Following Manager",
    href: "/following-manager",
    badge: undefined,
    description: "See who doesn't follow you back and bulk unfollow to clean up your social graph."
  },
  {
    icon: ThumbsDown,
    title: "Like Manager",
    href: "/like-manager",
    badge: undefined,
    description: "Browse, search, and bulk unlike tracks. Clean up thousands of stale likes in minutes."
  },
  {
    icon: HeartPulse,
    title: "Playlist Health Check",
    href: "/playlist-health-check",
    badge: undefined,
    description: "Scan playlists for blocked, deleted, or unstreamable tracks — and remove them in one pass."
  },
  {
    icon: LinkIcon,
    title: "Link Resolver",
    href: "/link-resolver",
    badge: undefined,
    description: "Paste any SoundCloud URL and get instant structured metadata for tracks, playlists, and profiles."
  }
];

// Testimonials — real quotes only. Leave empty to hide the section entirely.
// To enable: add objects { quote, name, role, avatar? } with genuine user
// feedback. Never populate with invented quotes — it undermines the trust
// signals this page is built around.
interface Testimonial {
  quote: string;
  name: string;
  role: string;
  avatar?: string;
}
const testimonials: Testimonial[] = [];

// Path to a real dashboard screenshot (put the file in /public). Null hides
// the hero product shot until the asset exists. e.g. "/hero-dashboard.png"
const HERO_SHOT: string | null = null;

// Benefits data
const benefits = [
  "Merge multiple playlists with automatic duplicate removal",
  "Turn liked tracks or activity feed into organized playlists",
  "Download tracks with available download or purchase links",
  "Manage your following list — find who doesn't follow back",
  "Bulk operations: unlike tracks, unfollow users, resolve links",
  "Smart playlist health checks for blocked or deleted tracks",
  "Dark and light theme to match your preference",
  "100% free with secure OAuth — your password is never stored"
];

// Steps data from Home.tsx
const steps = [
  {
    step: "1",
    icon: LogIn,
    title: "Connect",
    description: "Sign in securely with your SoundCloud account using OAuth",
  },
  {
    step: "2",
    icon: Settings,
    title: "Organize",
    description:
      "Use 10+ powerful tools to merge, sort, clean, and manage your library",
  },
  {
    step: "3",
    icon: Music,
    title: "Enjoy",
    description: "Export your organized playlists back to SoundCloud instantly",
  },
];

export default function Home() {
  const scrollToFeatures = () => {
    const el = document.getElementById("features");
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  return (
    <>
      <StructuredData />

      <div className="min-h-screen bg-background text-foreground">
        {/* Navigation */}
        <nav
          className="fixed inset-x-0 z-40 flex items-center justify-center pt-4 sm:pt-6"
          style={{ top: "var(--announcement-h)" }}
        >
          <div className="mx-auto flex w-full max-w-6xl px-4 sm:px-6">
            <div className="glass-card flex w-full items-center justify-between rounded-full border px-4 py-2 sm:px-6 sm:py-3">
              <div className="flex items-center gap-2">
                <BrandWordmark className="h-8 w-auto text-foreground sm:h-10" />
              </div>
              <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 text-sm text-muted-foreground md:flex">
                <a href="#features" className="hover:text-foreground transition">
                  Features
                </a>
                <a href="#benefits" className="hover:text-foreground transition">
                  Benefits
                </a>
                <a
                  href="#how-it-works"
                  className="hover:text-foreground transition"
                >
                  How It Works
                </a>
                <a href="#faq" className="hover:text-foreground transition">
                  FAQ
                </a>
              </div>
              <div className="flex items-center">
                <Link
                  href="/login"
                  className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-elevation-1 transition-all hover:shadow-glow-sm hover:-translate-y-0.5 sm:px-6 sm:py-2 sm:text-sm"
                >
                  Get started
                </Link>
              </div>
            </div>
          </div>
        </nav>

        <main id="main-content" tabIndex={-1} className="focus:outline-none">
        {/* Hero Section */}
        <section className="relative overflow-hidden px-4 pb-20 pt-28 sm:px-6 sm:pt-32 md:pb-28 md:pt-40">
          {/* Flickering grid background */}
          <div className="pointer-events-none absolute inset-0 -z-20 opacity-60">
            <FlickeringGrid
              squareSize={4}
              gridGap={6}
              flickerChance={0.15}
              color="rgb(255, 85, 0)"
              maxOpacity={0.12}
              className="h-full w-full"
            />
          </div>
          {/* Existing radial gradient overlay on top */}
          <div className="pointer-events-none absolute inset-x-0 -top-40 -z-10 h-[480px] bg-[radial-gradient(circle_at_top,_rgba(255,85,0,0.18),transparent_55%),radial-gradient(circle_at_bottom,_rgba(37,99,235,0.18),transparent_55%)]" />

          <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center text-center">
            <div className="animate-fade-in-up inline-flex items-center gap-2 rounded-full border border-border/60 bg-surface/70 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
              <span className="h-2 w-2 rounded-full bg-primary" />
              SoundCloud playlist power tools — free forever
            </div>

            <h1 className="mt-6 animate-fade-in-up text-balance font-display text-4xl font-semibold tracking-tight text-foreground sm:text-5xl md:text-6xl lg:text-7xl [animation-delay:80ms]">
              The Ultimate Track{" "}
              <span className="text-gradient font-semibold">Toolkit</span>
            </h1>

            {/* Word rotate — action verbs */}
            <div className="mt-4 flex animate-fade-in-up items-center justify-center gap-2 text-base font-semibold text-muted-foreground sm:text-lg md:text-xl [animation-delay:120ms]">
              <WordRotate
                words={["Merge", "Split", "Clean", "Organize"]}
                className="text-primary-text"
                duration={2200}
              />
              <span className="text-muted-foreground-subtle">your music library.</span>
            </div>

            <p className="mt-5 max-w-2xl animate-fade-in-up text-balance text-sm leading-relaxed text-muted-foreground sm:text-base [animation-delay:160ms]">
              Merge playlists past the 500-track limit, bulk-unlike stale
              favorites, find who doesn&apos;t follow back, and clean out dead
              tracks — all with the official SoundCloud login. No password, no
              subscription.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-4 [animation-delay:220ms]">
              <ShimmerButton
                as="a"
                href="/login"
                shimmerColor="#ffb347"
                background="rgba(255, 85, 0, 1)"
                borderRadius="8px"
                shimmerDuration="2.5s"
                className="shadow-elevation-2 hover:shadow-glow-sm hover:-translate-y-0.5 transition-transform"
              >
                Connect with SoundCloud
              </ShimmerButton>
              <Button
                type="button"
                variant="secondary"
                onClick={scrollToFeatures}
                className="rounded-lg px-6 py-2"
              >
                See what it does
              </Button>
            </div>
          </div>

          {/* Product shot — set HERO_SHOT to a real dashboard screenshot to
              show the app above the fold. Null by default so no broken image
              ships before the asset exists. */}
          {HERO_SHOT && (
            <div className="relative z-10 mx-auto mt-14 max-w-5xl [animation-delay:280ms] animate-fade-in-up">
              <div className="overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-elevation-2">
                <div className="flex items-center gap-1.5 border-b border-border/60 bg-surface/80 px-4 py-2.5">
                  <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
                  <span className="h-2.5 w-2.5 rounded-full bg-chart-4/70" />
                  <span className="h-2.5 w-2.5 rounded-full bg-chart-3/70" />
                  <span className="ml-3 text-[11px] text-muted-foreground">tracktoolkit.com/dashboard</span>
                </div>
                <Image
                  src={HERO_SHOT}
                  alt="Track Toolkit dashboard showing playlist tools and library stats"
                  width={1600}
                  height={1000}
                  className="h-auto w-full"
                  unoptimized
                />
              </div>
            </div>
          )}
        </section>

        {/* Social proof / trust bar */}
        <section className="border-y border-border/60 bg-surface px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <p className="mb-6 text-center text-sm font-semibold uppercase tracking-wider text-muted-foreground sm:text-base">
              Trusted by 3,500+ SoundCloud users
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { icon: Lock, label: "Secure OAuth", description: "Official SoundCloud login" },
                { icon: Shield, label: "No password storage", description: "Tokens encrypted at rest" },
                { icon: Heart, label: "Loved by curators", description: "Playlists without the chaos" },
                { icon: Layers, label: "Playlist safe", description: "Originals stay untouched" },
              ].map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface/80 px-4 py-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <item.icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <span className="block text-xs font-semibold text-foreground">
                      {item.label}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {item.description}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features grid */}
        <section
          id="features"
          className="px-4 py-20 sm:px-6 sm:py-24 lg:py-28"
        >
          <div className="mx-auto max-w-6xl">
            <div className="mx-auto mb-14 max-w-3xl text-center">
              <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
                <span className="block">A console of tools for</span>
                <span className="block text-gradient mt-2">total control</span>
              </h2>
              <p className="mt-4 text-base text-muted-foreground sm:text-lg">
                Built for DJs, producers, curators, and power listeners.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((item) => (
                <Link key={item.href} href={item.href} className="block h-full">
                  <Card
                    interactive
                    className="h-full p-5 transition-all hover:border-primary/60"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <item.icon className="h-5 w-5" />
                      </div>
                      {item.badge && (
                        <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-primary-text">
                          {item.badge}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-3 text-sm font-semibold text-foreground">
                      {item.title}
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {item.description}
                    </p>
                    <span className="mt-3 inline-block text-[11px] font-medium text-primary-text">
                      Open →
                    </span>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        </section>

        {/* Benefits section */}
        <section
          id="benefits"
          className="border-y border-border/60 bg-surface px-4 py-20 sm:px-6 sm:py-24"
        >
          <div className="mx-auto max-w-6xl">
            <h2 className="text-center font-display text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
              Built for the obsessed listeners.
            </h2>
            <p className="mx-auto mt-4 max-w-3xl text-center text-base text-muted-foreground sm:text-lg">
              Whether you&apos;re a DJ, curator, or collector, Track Toolkit
              gives you the levers to keep everything sharp, searchable, and
              show-ready.
            </p>

            <div className="mx-auto mt-12 grid max-w-4xl gap-x-8 gap-y-4 sm:grid-cols-2">
              {benefits.map((benefit) => (
                <div key={benefit} className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Check className="h-3.5 w-3.5" />
                  </div>
                  <p className="min-w-0 text-sm leading-relaxed text-foreground sm:text-base">
                    {benefit}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Testimonials — only renders when real quotes are supplied */}
        {testimonials.length > 0 && (
          <section className="px-4 py-20 sm:px-6 sm:py-24">
            <div className="mx-auto max-w-6xl">
              <h2 className="text-center font-display text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
                What users say
              </h2>
              <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {testimonials.map((t) => (
                  <Card key={t.name} className="flex h-full flex-col p-6">
                    <p className="flex-1 text-sm leading-relaxed text-foreground">
                      &ldquo;{t.quote}&rdquo;
                    </p>
                    <div className="mt-5 flex items-center gap-3">
                      {t.avatar ? (
                        <Image
                          src={t.avatar}
                          alt={t.name}
                          width={40}
                          height={40}
                          className="h-10 w-10 rounded-full object-cover"
                          unoptimized
                        />
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary-text">
                          {t.name.charAt(0)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-foreground">{t.name}</div>
                        <div className="text-xs text-muted-foreground">{t.role}</div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* How it works */}
        <section
          id="how-it-works"
          className="bg-background/80 px-4 py-20 sm:px-6 sm:py-24"
        >
          <div className="mx-auto max-w-5xl">
            <h2 className="text-center font-display text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
              How it works
            </h2>

            <div className="relative mt-12 grid gap-8 rounded-3xl border border-border/70 bg-surface/70 p-8 shadow-elevation-1 sm:grid-cols-3 sm:p-10">
              {steps.map((item, i) => {
                const IconComponent = item.icon;
                return (
                  <div
                    key={item.title}
                    className="relative flex flex-col items-center text-center"
                  >
                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <IconComponent className="h-7 w-7" />
                    </div>
                    {i < steps.length - 1 && (
                      <div className="hidden sm:block absolute top-4 -right-[2.5rem] text-muted-foreground-subtle">
                        <ArrowRight className="h-6 w-6" />
                      </div>
                    )}
                    <h3 className="mt-4 text-lg font-semibold text-foreground">
                      {item.title}
                    </h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* CTA section */}
        <section className="relative border-y border-border/60 bg-surface px-4 py-20 sm:px-6 sm:py-24 overflow-hidden">
          <div className="relative z-10 mx-auto max-w-3xl text-center">
            <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl md:text-5xl">
              Ready to organize your SoundCloud like a studio session?
            </h2>
            <p className="mt-4 text-base text-muted-foreground sm:text-lg">
              Connect once, pick a tool, and let Track Toolkit handle the
              tedious parts — so you can listen, sort, and play.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              <ShimmerButton
                as="a"
                href="/login"
                shimmerColor="#ffb347"
                background="rgba(255, 85, 0, 1)"
                borderRadius="8px"
                shimmerDuration="2.5s"
                className="shadow-elevation-2 hover:shadow-glow-sm hover:-translate-y-0.5 transition-transform px-10 py-3 text-base"
              >
                Connect with SoundCloud
              </ShimmerButton>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section
          id="faq"
          className="bg-background px-4 py-20 sm:px-6 sm:py-24"
        >
          <div className="mx-auto max-w-4xl">
            <h2 className="text-center font-display text-3xl font-semibold tracking-tight sm:text-4xl">
              Frequently asked
            </h2>
            <div className="mt-10 space-y-4">
              {faqs.map((faq) => (
                <details
                  key={faq.question}
                  className="group rounded-xl border border-border/70 bg-surface/80"
                >
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-4 sm:px-6 sm:py-5">
                    <h3 className="pr-4 text-left text-sm font-medium text-foreground sm:text-base">
                      {faq.question}
                    </h3>
                    <span className="text-lg text-muted-foreground transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <div className="px-4 pb-4 pt-0 sm:px-6 sm:pb-5">
                    <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
                      {faq.answer}
                    </p>
                    {faq.linkHref && faq.linkLabel && (
                      <Link
                        href={faq.linkHref}
                        className="mt-2 inline-block text-sm font-medium text-foreground underline underline-offset-2 transition hover:text-primary-text"
                      >
                        {faq.linkLabel}
                      </Link>
                    )}
                  </div>
                </details>
              ))}
            </div>
            <div className="mt-8 text-center">
              <Link
                href="/faq"
                className="text-sm font-medium text-foreground underline underline-offset-2 transition hover:text-primary-text"
              >
                More questions →
              </Link>
            </div>
          </div>
        </section>
        </main>

        {/* Footer */}
        <footer className="border-t border-border/60 bg-background/90 px-4 py-10 sm:px-6">
          <div className="mx-auto max-w-6xl">
            <div className="flex flex-col items-center justify-between gap-4 text-xs text-muted-foreground sm:flex-row sm:text-sm">
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                <Link
                  href="/about"
                  className="hover:text-foreground transition-colors"
                >
                  About
                </Link>
                <span className="hidden sm:inline">•</span>
                <Link
                  href="/faq"
                  className="hover:text-foreground transition-colors"
                >
                  FAQ
                </Link>
                <span className="hidden sm:inline">•</span>
                <Link
                  href="/terms"
                  className="hover:text-foreground transition-colors"
                >
                  Terms
                </Link>
                <span className="hidden sm:inline">•</span>
                <Link
                  href="/privacy"
                  className="hover:text-foreground transition-colors"
                >
                  Privacy
                </Link>
                <span className="hidden sm:inline">•</span>
                <Link
                  href="/accessibility"
                  className="hover:text-foreground transition-colors"
                >
                  Accessibility
                </Link>
                <span className="hidden sm:inline">•</span>
                <SupportLink className="hover:text-foreground transition-colors underline underline-offset-2">
                  Contact
                </SupportLink>
              </div>
              <div className="text-center sm:text-right">
                <p>Track Toolkit is not affiliated with SoundCloud.</p>
                <p className="mt-1">
                  © {new Date().getFullYear()} Track Toolkit. All rights reserved.
                </p>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
