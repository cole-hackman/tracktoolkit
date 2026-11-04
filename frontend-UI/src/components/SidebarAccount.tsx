"use client";

import { LogOut, Moon, Sun } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";
import { AnimatedShinyText } from "@/components/ui/AnimatedShinyText";
import { IconButton } from "@/components/ui/IconButton";

/* ── Account block ──
   Profile, theme toggle, log out and the support button. It sits above the nav
   rather than inside it: it is not navigation, and at the top it is reachable
   without scrolling the list. Account deletion lives on /account — it is a
   destructive, rarely wanted action and does not belong in the chrome. */

const SUPPORT_URL = "https://www.buymeacoffee.com/hackman";

export function SidebarAccount({
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
        <span className="flex items-center gap-0.5 shrink-0">
          <IconButton label={themeLabel} size="sm" onClick={toggleTheme}>
            <ThemeIcon className="w-4 h-4" />
          </IconButton>
          <IconButton label="Log out" size="sm" onClick={logout}>
            <LogOut className="w-4 h-4" />
          </IconButton>
        </span>
      </div>

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
