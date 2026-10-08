import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/privacy/",
  title: "Privacy Policy · Track Toolkit",
  description:
    "How Track Toolkit collects, stores, and protects your SoundCloud account data, including token encryption and data retention.",
});

export default function PrivacyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
