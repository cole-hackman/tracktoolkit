"use client";

import type { ReactNode } from "react";
import { Panel } from "@/components/ui";

interface ExportSectionProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  description: string;
  children: ReactNode;
}

export function ExportSection({
  icon,
  title,
  subtitle,
  description,
  children,
}: ExportSectionProps) {
  return (
    <Panel
      title={
        <span className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"
          >
            {icon}
          </span>
          {title}
        </span>
      }
      description={subtitle || undefined}
    >
      {description ? (
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {children}
    </Panel>
  );
}
