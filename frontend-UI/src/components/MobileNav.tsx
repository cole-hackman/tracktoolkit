"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import {
  MOBILE_TABS,
  MORE_GROUPS,
  filterNavLinks,
  infoLinks,
  isActivePath,
  type MobileTab,
  type NavGroup,
  type NavLink,
} from "@/lib/nav";
import { SidebarAccount } from "@/components/SidebarAccount";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useAnnounce } from "@/components/ui/useAnnounce";

/* The phone navigation: a five-slot tab bar, always on screen below `lg`, and
   the sheets its group tabs open. The tree comes from `@/lib/nav`, shared with
   the desktop rail. Sheets are `Dialog`s, so they cover the bar while open and
   hand focus back to the tab that opened them. */

const TAB_CLASS =
  "relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 touch-manipulation text-[11px] font-medium leading-none transition-colors";

function tabClass(active: boolean) {
  return cn(TAB_CLASS, active ? "text-primary-text" : "text-muted-foreground");
}

function TabContent({ tab, active }: { tab: MobileTab; active: boolean }) {
  const Icon = tab.icon;
  return (
    <>
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-0 h-[3px] w-8 -translate-x-1/2 rounded-b-full bg-primary"
        />
      )}
      <Icon className="h-5 w-5 shrink-0" />
      <span className="max-w-full truncate px-0.5">{tab.label}</span>
    </>
  );
}

function SheetRow({
  link,
  pathname,
  onNavigate,
}: {
  link: NavLink;
  pathname: string | null;
  onNavigate: () => void;
}) {
  const Icon = link.icon;
  const active = isActivePath(pathname, link.href);
  return (
    <li>
      <Link
        href={link.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium touch-manipulation transition-colors",
          active ? "bg-primary/10 text-primary-text" : "text-foreground",
        )}
      >
        <Icon className={cn("h-[18px] w-[18px] shrink-0", !active && "text-muted-foreground")} />
        <span className="min-w-0 truncate">{link.label}</span>
      </Link>
    </li>
  );
}

function SheetList({
  links,
  pathname,
  onNavigate,
}: {
  links: NavLink[];
  pathname: string | null;
  onNavigate: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {links.map((link) => (
        <SheetRow key={link.href} link={link} pathname={pathname} onNavigate={onNavigate} />
      ))}
    </ul>
  );
}

/**
 * The More sheet: the account block first (it stays at the top of the
 * navigation, on every width), then a filter over every tool, then whatever
 * has no tab. The filter state lives here so closing the sheet clears it:
 * `Dialog` unmounts its children.
 */
function MoreSheet({
  pathname,
  onNavigate,
}: {
  pathname: string | null;
  onNavigate: () => void;
}) {
  const { user } = useAuth();
  const announce = useAnnounce();
  const [query, setQuery] = useState("");

  const filtering = query.trim().length > 0;
  const matches = useMemo(() => filterNavLinks(query, user?.isAdmin), [query, user?.isAdmin]);

  useEffect(() => {
    if (!filtering) return;
    announce(matches.length === 1 ? "1 result" : `${matches.length} results`);
  }, [announce, filtering, matches.length]);

  const sections: NavGroup[] = [
    ...MORE_GROUPS,
    { label: "Info", items: infoLinks(user?.isAdmin) },
  ];

  return (
    <div className="-mx-3 space-y-4">
      {/* The account block carries its own side padding from the rail. */}
      <div className="-mx-2 -mt-3">
        <SidebarAccount collapsed={false} isMobile />
      </div>

      <div className="px-3">
        <Field label="Find a tool" labelHidden>
          {(field) => (
            <Input
              {...field}
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              placeholder="Find a tool"
              className="min-h-11"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
        </Field>
      </div>

      <nav aria-label="All tools">
        {filtering ? (
          matches.length > 0 ? (
            <SheetList links={matches} pathname={pathname} onNavigate={onNavigate} />
          ) : (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              No tools match &ldquo;{query.trim()}&rdquo;.
            </p>
          )
        ) : (
          <div className="space-y-4">
            {sections.map((section) => (
              <div key={section.label}>
                <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </p>
                <SheetList links={section.items} pathname={pathname} onNavigate={onNavigate} />
              </div>
            ))}
          </div>
        )}
      </nav>
    </div>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [openId, setOpenId] = useState<string | null>(null);
  // Chromium does not focus a <button> on a mouse click, so the element the
  // dialog would otherwise restore to is <body>.
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const openTab = MOBILE_TABS.find((tab) => tab.id === openId) ?? null;
  const close = () => setOpenId(null);

  // `Dialog` has no breakpoint of its own: rotating a tablet past `lg` with a
  // sheet open would leave it over the rail with the body scroll-locked.
  useEffect(() => {
    if (!openId) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    if (desktop.matches) {
      setOpenId(null);
      return;
    }
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpenId(null);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, [openId]);

  const more = [...MORE_GROUPS.flatMap((group) => group.items), ...infoLinks(user?.isAdmin)];

  const tabIsActive = (tab: MobileTab) => {
    if (tab.href) return isActivePath(pathname, tab.href);
    const links = tab.group ? tab.group.items : more;
    return links.some((link) => isActivePath(pathname, link.href));
  };

  const open = (tab: MobileTab) => (event: MouseEvent<HTMLButtonElement>) => {
    triggerRef.current = event.currentTarget;
    setOpenId(tab.id);
  };

  return (
    <>
      <nav
        aria-label="Main navigation"
        className="fixed inset-x-0 bottom-0 z-50 flex h-[var(--mobile-nav-h)] border-t border-border bg-card pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:hidden"
      >
        {MOBILE_TABS.map((tab) => {
          const active = tabIsActive(tab);
          return tab.href ? (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={tabClass(active)}
            >
              <TabContent tab={tab} active={active} />
            </Link>
          ) : (
            <button
              key={tab.id}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={openId === tab.id}
              aria-current={active ? "true" : undefined}
              onClick={open(tab)}
              className={tabClass(active)}
            >
              <TabContent tab={tab} active={active} />
            </button>
          );
        })}
      </nav>

      <Dialog
        open={openTab !== null}
        onClose={close}
        title={openTab?.group?.label ?? openTab?.label ?? "Menu"}
        variant="sheet"
        size="sm"
        closeLabel="Close menu"
        returnFocusRef={triggerRef}
      >
        {openTab?.group ? (
          <nav aria-label={openTab.group.label} className="-mx-3">
            <SheetList links={openTab.group.items} pathname={pathname} onNavigate={close} />
          </nav>
        ) : (
          <MoreSheet pathname={pathname} onNavigate={close} />
        )}
      </Dialog>
    </>
  );
}
