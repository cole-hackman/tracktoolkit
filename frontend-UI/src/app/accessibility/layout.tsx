import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/accessibility/",
  title: "Accessibility Statement · Track Toolkit",
  description:
    "Track Toolkit's commitment to WCAG 2.1 AA accessibility, current known limitations, and how to report an accessibility barrier.",
});

export default function AccessibilityLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
