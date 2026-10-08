import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  path: "/faq/",
  title: "FAQ · Track Toolkit (formerly SC Toolkit)",
  description:
    "Answers about the rename from SoundCloud Toolkit to Track Toolkit, your account and data, the tools, and how to get help.",
});

export default function FaqLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
