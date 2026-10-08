import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/terms/",
  title: "Terms of Service · Track Toolkit",
  description:
    "The terms that govern using Track Toolkit — eligibility, acceptable use, account deletion, and liability.",
});

export default function TermsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
