"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Accessibility,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Gauge,
  HelpCircle,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  ScrollText,
  Shield,
  Sun,
  UserCog,
} from "lucide-react";
import { BrandMark, BrandWordmark } from "@/components/brand/Logo";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";
import { NAV, isGroup, type NavGroup, type NavLink } from "@/lib/nav";
import { Dialog } from "@/components/ui/Dialog";
import { AnimatedShinyText } from "@/components/ui/AnimatedShinyText";
import { IconButton } from "@/components/ui/IconButton";
import { LiveRegion } from "@/components/ui/LiveRegion";

/* ── Navigation structure ──
   `NAV`, its types and `isGroup` live in `@/lib/nav` so pages that only need
   the tool list (the feedback form resolving `?from=` to a tool name) can
   read it without importing this component. */

/** The drawer's `<nav>`, so the hamburger can point `aria-controls` at it. */
const MOBILE_NAV_ID = "mobile-nav";

const FOOTER_ITEMS: NavLink[] = [
  { href: "/about", label: "About", icon: FileText },
  { href: "/faq", label: "FAQ", icon: HelpCircle },
  { href: "/feedback", label: "Send feedback", icon: MessageSquare },
  { href: "/account", label: "Account", icon: UserCog },
  { href: "/privacy", label: "Privacy", icon: Shield },
  { href: "/terms", label: "Terms", icon: ScrollText },
  { href: "/accessibility", label: "Accessibility", icon: Accessibility },
];

/**
 * The admin console link. Only rendered for accounts on ADMIN_IDS (the server
 * reports `isAdmin` on /api/auth/me). The page itself gates again and
 * `adminAuth` is the real boundary, so this is a shortcut, not a guard.
 *
 * It is a `NavLink` like every other row, so it renders through `NavRow` and
 * inherits the rail: keyboard reachable, `aria-current="page"` when active,
 * 44px in the drawer.
 */
const ADMIN_ITEM: NavLink = { href: "/admin", label: "Admin console", icon: Gauge };

/**
 * `/dashboard/` is how the static export addresses the route and `/dashboard`
 * is how `NAV` writes it, so an exact match is not enough on its own.
 */
function isActivePath(pathname: string | null, href: string): boolean {
  return pathname === href || !!pathname?.startsWith(href + "/");
}

/* ── One nav row ──
   The label span is always rendered and only becomes `sr-only` in the
   collapsed sidebar. Keeping the element mounted is what lets the collapsed
   rail expand on keyboard focus without the focused link disappearing
   underneath the user, and it means every row has an accessible name in
   both states. */

function NavRow({
  item,
  active,
  collapsed,
  isMobile,
  onNavigate,
  indented = false,
  iconSize = "w-[18px] h-[18px]",
}: {
  item: NavLink;
  active: boolean;
  collapsed: boolean;
  isMobile: boolean;
  onNavigate?: () => void;
  indented?: boolean;
  iconSize?: string;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex items-center gap-3 overflow-hidden rounded-lg transition-colors duration-150 text-[13px] font-medium",
        indented ? "pl-5 pr-3" : "px-3",
        // The drawer is the only place these rows are touched rather than
        // clicked, so the 44px floor applies there and nowhere else.
        isMobile ? "min-h-11 py-2.5" : "py-2",
        collapsed && "justify-center",
        active ? "bg-primary/10 text-primary-text" : "text-muted-foreground",
      )}
    >
      {/* Slide-in hover bg */}
      {!active && (
        <span className="absolute inset-0 translate-x-[-100%] group-hover:translate-x-0 rounded-lg bg-black/[0.04] dark:bg-white/[0.04] transition-transform duration-200" />
      )}
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-primary rounded-r-full" />
      )}
      <Icon
        className={cn(
          "relative z-10 shrink-0",
          iconSize,
          active
            ? "text-primary-text"
            : "group-hover:text-foreground dark:group-hover:text-white transition-colors",
        )}
      />
      <span className={cn("relative z-10 truncate", collapsed && "sr-only")}>
        {item.label}
      </span>
    </Link>
  );
}

/* ── Collapsible sidebar group ── */

function SidebarGroup({
  group,
  pathname,
  collapsed,
  isMobile,
  onNavigate,
}: {
  group: NavGroup;
  pathname: string | null;
  collapsed: boolean;
  isMobile: boolean;
  onNavigate?: () => void;
}) {
  // Auto-open if any child is active
  const hasActive = group.items.some((item) => isActivePath(pathname, item.href));
  const [open, setOpen] = useState(true);
  const listId = useId();

  // Keep in sync when route changes
  useEffect(() => {
    if (hasActive) setOpen(true);
  }, [hasActive]);

  // When collapsed (icon-only sidebar), just show the items' icons
  if (collapsed && !isMobile) {
    return (
      <div className="space-y-0.5">
        {group.items.map((item) => (
          <NavRow
            key={item.href}
            item={item}
            active={isActivePath(pathname, item.href)}
            collapsed
            isMobile={false}
            onNavigate={onNavigate}
            iconSize="w-[18px] h-[18px]"
          />
        ))}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "w-full flex items-center justify-between rounded-lg px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors",
          isMobile ? "min-h-11 py-2" : "py-1.5",
        )}
      >
        <span>{group.label}</span>
        <ChevronDown
          className={cn(
            "w-3 h-3 transition-transform duration-200",
            open ? "" : "-rotate-90",
          )}
        />
      </button>

      {/* Rendered in both states, `hidden` when closed, so `aria-controls`
          always resolves to a real element. */}
      <div id={listId} hidden={!open} className="space-y-0.5">
        {group.items.map((item) => (
          <NavRow
            key={item.href}
            item={item}
            active={isActivePath(pathname, item.href)}
            collapsed={false}
            isMobile={isMobile}
            onNavigate={onNavigate}
            indented
            iconSize="w-[16px] h-[16px]"
          />
        ))}
      </div>
    </div>
  );
}

/* ── Sidebar navigation ──
   A module-level component, not a closure declared inside `AppShell`: a
   nested definition is a new component type on every render, so React
   remounted the whole sidebar (and reset every group's open/closed state)
   whenever the shell re-rendered — which hovering it does. */

function SidebarNav({
  collapsed,
  isMobile = false,
  onNavigate,
  navId,
}: {
  collapsed: boolean;
  isMobile?: boolean;
  onNavigate?: () => void;
  navId?: string;
}) {
  const pathname = usePathname();
  const { user } = useAuth();

  return (
    <nav
      id={navId}
      aria-label={isMobile ? "Main navigation" : "Main"}
      className={cn(
        "flex-1 overflow-y-auto py-3",
        // The drawer's panel already carries the Dialog's own padding; pull
        // the rows back out so a phone keeps the full-width list it had.
        isMobile && "-mx-4",
      )}
    >
      <div className="space-y-1 px-2">
        {NAV.map((entry) => {
          if (isGroup(entry)) {
            return (
              <SidebarGroup
                key={entry.label}
                group={entry}
                pathname={pathname}
                collapsed={collapsed}
                isMobile={isMobile}
                onNavigate={onNavigate}
              />
            );
          }

          // Top-level link (Dashboard)
          return (
            <NavRow
              key={entry.href}
              item={entry}
              active={isActivePath(pathname, entry.href)}
              collapsed={collapsed && !isMobile}
              isMobile={isMobile}
              onNavigate={onNavigate}
            />
          );
        })}
      </div>

      <div className="mx-4 my-3 border-t border-gray-200/80 dark:border-border" />

      <div className="px-2 mb-1">
        <span className="px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Info
        </span>
      </div>
      <div className="space-y-0.5 px-2 mb-3">
        {[...FOOTER_ITEMS, ...(user?.isAdmin ? [ADMIN_ITEM] : [])].map((item) => (
          <NavRow
            key={item.href}
            item={item}
            active={isActivePath(pathname, item.href)}
            collapsed={collapsed && !isMobile}
            isMobile={isMobile}
            onNavigate={onNavigate}
          />
        ))}
      </div>

    </nav>
  );
}

/* ── Account block ──
   Profile, theme toggle, log out and the support button. It sits above the nav
   rather than inside it: it is not navigation, and at the top it is reachable
   without scrolling the list. Account deletion lives on /account — it is a
   destructive, rarely wanted action and does not belong in the chrome. */

const SUPPORT_URL = "https://www.buymeacoffee.com/hackman";

function SidebarAccount({
  collapsed,
  isMobile = false,
}: {
  collapsed: boolean;
  isMobile?: boolean;
}) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const themeLabel = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  const ThemeIcon = theme === "dark" ? Sun : Moon;

  const avatar = (
    <img
      src={user?.avatar_url || "/brand/icon-192.png"}
      alt={user?.display_name || "User"}
      width={24}
      height={24}
      loading="lazy"
      decoding="async"
      className="w-6 h-6 rounded-full ring-1 ring-primary/20 shrink-0"
    />
  );

  if (collapsed && !isMobile) {
    return (
      <div className="flex flex-col items-center gap-2 py-3 border-b border-gray-200/80 dark:border-border shrink-0">
        {avatar}
        <IconButton label={themeLabel} size="sm" onClick={toggleTheme}>
          <ThemeIcon className="w-4 h-4" />
        </IconButton>
        <IconButton label="Log out" size="sm" onClick={logout}>
          <LogOut className="w-4 h-4" />
        </IconButton>
        <a
          href={SUPPORT_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-black bg-[#fcffff] text-[14px] leading-none text-black shadow-sm transition hover:shadow-md"
          aria-label="Support me on Buy Me a Coffee"
          title="Support Me"
        >
          <span aria-hidden="true">☕</span>
        </a>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-2 px-2 py-3 shrink-0",
        !isMobile && "border-b border-gray-200/80 dark:border-border",
      )}
    >
      <div className="flex items-center gap-3 px-3 py-1">
        {avatar}
        <span className="text-[13px] font-medium text-foreground truncate min-w-0 flex-1">
          {user?.display_name}
        </span>
        {/* On a phone these are 44px targets (touch-44), which would leave the
            display name a sliver — so they get their own row in the drawer. */}
        {!isMobile && (
          <span className="flex items-center gap-0.5 shrink-0">
            <IconButton label={themeLabel} size="sm" onClick={toggleTheme}>
              <ThemeIcon className="w-4 h-4" />
            </IconButton>
            <IconButton label="Log out" size="sm" onClick={logout}>
              <LogOut className="w-4 h-4" />
            </IconButton>
          </span>
        )}
      </div>

      {isMobile && (
        <div className="flex items-center gap-1 px-3">
          <IconButton label={themeLabel} size="sm" onClick={toggleTheme}>
            <ThemeIcon className="w-4 h-4" />
          </IconButton>
          <IconButton label="Log out" size="sm" onClick={logout}>
            <LogOut className="w-4 h-4" />
          </IconButton>
        </div>
      )}

      <div className="px-3">
        <a
          href={SUPPORT_URL}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-black bg-[#fcffff] px-3 py-2 text-[12px] font-semibold text-black shadow-sm transition hover:shadow-md",
            isMobile && "min-h-11",
          )}
        >
          <span className="text-[14px] leading-none" aria-hidden="true">
            ☕
          </span>
          {/* The shimmer is a gradient clipped to the glyphs, so it only shows
              through semi-transparent text. The button is a fixed light surface
              in both themes, so the base is black at 75% (≈8:1 on #fcffff) and
              the sweep is solid black, never white. */}
          <AnimatedShinyText
            className="text-black/75 via-black dark:via-black motion-reduce:animate-none"
            shimmerWidth={60}
          >
            Support Me
          </AnimatedShinyText>
        </a>
      </div>
    </div>
  );
}

/* ── Main Shell ── */

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  // Hover and keyboard focus are tracked separately on purpose. With one flag,
  // moving the mouse off the rail while a link inside it had focus would
  // re-collapse the sidebar and unmount the focused element.
  const [hasFocusWithin, setHasFocusWithin] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  // Chromium does not focus a <button> on a mouse click, so the element the
  // dialog would otherwise restore to is <body>. Naming the trigger keeps the
  // drawer's focus return correct however it was opened.
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Determine effective collapsed state (expanded while hovered or focused)
  const effectiveCollapsed = sidebarCollapsed && !isHovered && !hasFocusWithin;

  // Persist sidebar state in localStorage
  useEffect(() => {
    const stored = localStorage.getItem("sc-toolkit-sidebar-collapsed");
    if (stored !== null) setSidebarCollapsed(stored === "true");
  }, []);

  // The drawer is a phone affordance, but `Dialog` has no breakpoint of its
  // own — rotating a tablet past `lg` while it was open left it sitting over
  // the desktop rail with the body still scroll-locked.
  useEffect(() => {
    if (!mobileOpen) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    if (desktop.matches) {
      setMobileOpen(false);
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, [mobileOpen]);

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem("sc-toolkit-sidebar-collapsed", String(next));
  };

  const closeMobile = () => setMobileOpen(false);

  return (
    <div className="min-h-screen flex bg-background">
      {/* The app's only live region — everything `useAnnounce` says lands here.
          It sits outside <main> so a route change never unmounts it
          mid-announcement. */}
      <LiveRegion />

      {/* Desktop sidebar.
          The pointer handlers only peek the collapsed rail open while the
          mouse is over it; the keyboard equivalent is the `onFocusCapture` /
          `onBlurCapture` pair immediately below, and the rail's own
          "Collapse sidebar" control is the explicit, non-hover path for
          everyone. `jsx-a11y/no-noninteractive-element-interactions` cannot
          see that the same state has a keyboard route, so the exemption is
          stated here rather than by leaving the rule at "warn". */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <aside
        ref={asideRef}
        className={cn(
          "hidden lg:flex flex-col sticky top-[var(--announcement-h)] h-[calc(100dvh-var(--announcement-h))] self-start overflow-hidden bg-gradient-to-b from-[#FAFAFA] to-white dark:from-background dark:to-background border-r border-gray-200/80 dark:border-border transition-all duration-200 shrink-0",
          effectiveCollapsed ? "w-[56px]" : "w-56",
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onFocusCapture={(event) => {
          // Keyboard focus only. Chromium (and Firefox off macOS) focuses a
          // <button> on mousedown, so a plain focus check would mean clicking
          // "Collapse sidebar" immediately re-expanded the rail and the
          // control looked dead until you clicked somewhere else.
          //
          // Assigned, never only set: a keyboard-then-mouse sequence — Tab
          // into the rail, then click "Collapse sidebar" — used to leave the
          // flag pinned on, because the blur's `relatedTarget` was still
          // inside the rail so nothing cleared it and the rail stayed open
          // until focus left entirely. A mouse focus inside the rail now
          // clears it, which is the same answer a fresh mouse focus gives.
          const target = event.target as HTMLElement;
          const keyboard =
            typeof target.matches === "function" && target.matches(":focus-visible");
          setHasFocusWithin(keyboard);
        }}
        onBlurCapture={(event) => {
          const next = event.relatedTarget as Node | null;
          if (!next || !asideRef.current?.contains(next)) setHasFocusWithin(false);
        }}
      >
        {/* Top accent bar */}
        <div className="h-[2px] bg-gradient-to-r from-[#FF5500] to-[#FF7733] shrink-0" />

        <div className="flex items-center justify-between h-12 px-3 border-b border-gray-200/80 dark:border-border shrink-0">
          {/* One element in both states, so tabbing into a collapsed rail
              expands it without the focused control being replaced. */}
          <Link href="/dashboard" className="flex items-center min-w-0">
            <BrandMark title="" className="h-7 w-7 shrink-0" />
            {/* The mark is decorative, so this text is the link's accessible
                name in both states — visible when there is room, `sr-only`
                on the collapsed rail. */}
            <span
              className={cn(
                "font-bold text-sm text-foreground truncate",
                effectiveCollapsed ? "sr-only" : "ml-2",
              )}
            >
              Track Toolkit
            </span>
          </Link>
          {!effectiveCollapsed && (
            <IconButton
              label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              size="sm"
              onClick={toggleSidebar}
              className="hidden lg:inline-flex"
            >
              {sidebarCollapsed ? (
                <ChevronRight className="w-3.5 h-3.5" />
              ) : (
                <ChevronLeft className="w-3.5 h-3.5" />
              )}
            </IconButton>
          )}
        </div>

        <SidebarAccount collapsed={effectiveCollapsed} />
        <SidebarNav collapsed={effectiveCollapsed} />
      </aside>

      {/* Mobile header */}
      <header
        className="lg:hidden fixed left-0 right-0 z-50 bg-white/95 dark:bg-background/95 backdrop-blur-sm border-b border-gray-200/80 dark:border-border h-12 flex items-center justify-between px-4"
        style={{ top: "var(--announcement-h)" }}
      >
        <IconButton
          ref={menuButtonRef}
          label="Open menu"
          size="sm"
          aria-expanded={mobileOpen}
          aria-controls={MOBILE_NAV_ID}
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="w-5 h-5" />
        </IconButton>
        <Link href="/dashboard" className="flex items-center">
          <BrandWordmark className="h-7 w-auto text-foreground" />
        </Link>
        {/* Balances the hamburger so the wordmark stays centred; `touch-44`
            keeps it the same width as the button on a coarse pointer. */}
        <div className="touch-44 w-9" aria-hidden="true" />
      </header>

      {/* Mobile drawer. A real dialog: the focus trap, Escape, focus return
          and body scroll lock all come from the shared primitive, and the
          drawer variant offsets itself by the rebrand banner's height. */}
      <Dialog
        open={mobileOpen}
        onClose={closeMobile}
        title="Menu"
        variant="drawer"
        closeLabel="Close menu"
        returnFocusRef={menuButtonRef}
      >
        <SidebarAccount collapsed={false} isMobile />
        <SidebarNav
          isMobile
          collapsed={false}
          onNavigate={closeMobile}
          navId={MOBILE_NAV_ID}
        />
      </Dialog>

      {/* Main content */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 min-w-0 min-h-0 pt-12 lg:pt-0 focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}
