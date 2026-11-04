"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { BrandMark, BrandWordmark } from "@/components/brand/Logo";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import {
  NAV,
  infoLinks,
  isActivePath,
  isGroup,
  type NavGroup,
  type NavLink,
} from "@/lib/nav";
import { MobileNav } from "@/components/MobileNav";
import { SidebarAccount } from "@/components/SidebarAccount";
import { IconButton } from "@/components/ui/IconButton";
import { LiveRegion } from "@/components/ui/LiveRegion";

/* ── Navigation structure ──
   `NAV`, its types and `isGroup` live in `@/lib/nav` so pages that only need
   the tool list (the feedback form resolving `?from=` to a tool name) can
   read it without importing this component. */

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
  indented = false,
  iconSize = "w-[18px] h-[18px]",
}: {
  item: NavLink;
  active: boolean;
  collapsed: boolean;
  indented?: boolean;
  iconSize?: string;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex items-center gap-3 overflow-hidden rounded-lg transition-colors duration-150 text-[13px] font-medium",
        indented ? "pl-5 pr-3" : "px-3",
        "py-2",
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
}: {
  group: NavGroup;
  pathname: string | null;
  collapsed: boolean;
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
  if (collapsed) {
    return (
      <div className="space-y-0.5">
        {group.items.map((item) => (
          <NavRow
            key={item.href}
            item={item}
            active={isActivePath(pathname, item.href)}
            collapsed
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
        className="w-full flex items-center justify-between rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
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

function SidebarNav({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const { user } = useAuth();

  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto py-3">
      <div className="space-y-1 px-2">
        {NAV.map((entry) => {
          if (isGroup(entry)) {
            return (
              <SidebarGroup
                key={entry.label}
                group={entry}
                pathname={pathname}
                collapsed={collapsed}
              />
            );
          }

          // Top-level link (Dashboard)
          return (
            <NavRow
              key={entry.href}
              item={entry}
              active={isActivePath(pathname, entry.href)}
              collapsed={collapsed}
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
        {infoLinks(user?.isAdmin).map((item) => (
          <NavRow
            key={item.href}
            item={item}
            active={isActivePath(pathname, item.href)}
            collapsed={collapsed}
          />
        ))}
      </div>

    </nav>
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
  const asideRef = useRef<HTMLElement>(null);

  // Determine effective collapsed state (expanded while hovered or focused)
  const effectiveCollapsed = sidebarCollapsed && !isHovered && !hasFocusWithin;

  // Persist sidebar state in localStorage
  useEffect(() => {
    const stored = localStorage.getItem("sc-toolkit-sidebar-collapsed");
    if (stored !== null) setSidebarCollapsed(stored === "true");
  }, []);

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem("sc-toolkit-sidebar-collapsed", String(next));
  };

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

      {/* Mobile header. Navigation itself lives in the tab bar below. */}
      <header
        className="lg:hidden fixed left-0 right-0 z-50 bg-white/95 dark:bg-background/95 backdrop-blur-sm border-b border-gray-200/80 dark:border-border h-12 flex items-center justify-center px-[max(1rem,env(safe-area-inset-left))]"
        style={{ top: "var(--announcement-h)" }}
      >
        <Link href="/dashboard" className="flex items-center">
          <BrandWordmark className="h-7 w-auto text-foreground" />
        </Link>
      </header>

      <MobileNav />

      {/* Main content */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 min-w-0 min-h-0 pt-12 pb-[var(--mobile-nav-h)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:pt-0 focus:outline-none"
      >
        {children}
      </main>
    </div>
  );
}
