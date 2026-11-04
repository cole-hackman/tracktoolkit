import type { Metadata, Viewport } from "next";
import { AppGroupLayout } from "./AppGroupLayout";

// The authenticated tool routes carry a signed-in user's session state and
// have nothing to offer a search index; keep them out of it.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

// `cover` is what makes `env(safe-area-inset-*)` non-zero, which the tab bar
// needs to clear the iPhone home indicator. Scoped here because only this
// group has a shell that reserves those insets; the public pages keep the
// browser's own.
export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function AppLayoutRoot({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppGroupLayout>{children}</AppGroupLayout>;
}
