"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtAbsolute, fmtInt } from "../format";
import { Empty, ErrorNotice, Mini, Panel, RowSkeleton, TableShell, TONE_SOFT, tdClass, thClass, type Tone } from "../primitives";
import { useExperimentReadout, useFlags } from "../queries";
import type { ExperimentArm, ExperimentReadout, ExperimentStatus, FlagConfig, ProportionTest, RolloutGate } from "../types";

/**
 * Flags and experiment readouts. Read-only: a flag is changed in App Service
 * settings, never from here (server/lib/flags.js).
 *
 * Takes no period. A flag is a current setting, and an experiment is read
 * over its own cohort and its own 7-day windows, not over "the last 30 days".
 */

const numClass = cn(tdClass, "whitespace-nowrap text-right font-mono tabular-nums");
const numHead = cn(thClass, "text-right");

/** 0.4 → "40.0%". One decimal: a readout is compared to a pre-registered effect. */
function fmtRate(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** A difference between two rates, in percentage points, signed. */
function fmtPoints(value: number): string {
  const points = value * 100;
  return `${points > 0 ? "+" : ""}${points.toFixed(1)} pts`;
}

function fmtP(value: number): string {
  if (value < 0.0001) return "< 0.0001";
  return value.toFixed(4);
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded px-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.08em]", TONE_SOFT[tone])}>
      {children}
    </span>
  );
}

const STATUS_META: Record<ExperimentStatus, { label: string; tone: Tone; meaning: string }> = {
  "not-started": { label: "Not started", tone: "muted", meaning: "Nobody is enrolled and enrolment is not open." },
  enrolling: { label: "Enrolling", tone: "info", meaning: "New accounts are being enrolled. These numbers are interim: no decision is made from them." },
  maturing: { label: "Maturing", tone: "warn", meaning: "Enrolment has closed. Some enrolled accounts are still inside their window, so the rates are not final." },
  final: { label: "Final", tone: "ok", meaning: "Enrolment has closed and every window has. This is the one look the pre-registration allows." },
};

const GATE_META: Record<RolloutGate["status"], { label: string; tone: Tone }> = {
  ok: { label: "Under threshold", tone: "ok" },
  halt: { label: "Halt", tone: "danger" },
  "insufficient-data": { label: "Too few operations", tone: "muted" },
};

function rolloutLabel(flag: FlagConfig): string {
  if (flag.killed) return "killed";
  const source = flag.percentSource === "setting" ? "setting" : flag.percentSource === "invalid" ? "setting refused" : "default";
  return `${flag.percent}% · ${source}`;
}

function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1.5">
      {problems.map((problem) => (
        <li key={problem} className="flex items-start gap-2 rounded-md bg-chart-4/14 px-2.5 py-1.5 font-mono text-[11px] leading-snug text-warning-text">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">{problem}</span>
        </li>
      ))}
    </ul>
  );
}

function GateCell({ gate }: { gate: RolloutGate | null | undefined }) {
  if (!gate) return <span className="text-muted-foreground">—</span>;
  const meta = GATE_META[gate.status];
  return (
    <div className="flex flex-col gap-1">
      <Pill tone={meta.tone}>{meta.label}</Pill>
      <span className="font-mono text-[11px] text-muted-foreground">
        {fmtInt(gate.errors)} of {fmtInt(gate.operations)} failed in {gate.windowHours}h
        {gate.errorRatePct != null ? ` (${gate.errorRatePct.toFixed(1)}%)` : ""} · halt over {gate.maxErrorRatePct}% with {gate.minOperations}+
      </span>
    </div>
  );
}

function FlagsTable({ flags }: { flags: FlagConfig[] }) {
  return (
    <TableShell minWidth={860} label="Flags">
      <thead>
        <tr>
          <th scope="col" className={thClass}>Flag</th>
          <th scope="col" className={thClass}>Kind</th>
          <th scope="col" className={thClass}>Rollout</th>
          <th scope="col" className={thClass}>Start</th>
          <th scope="col" className={thClass}>End</th>
          <th scope="col" className={thClass}>Gate</th>
        </tr>
      </thead>
      <tbody>
        {flags.map((flag) => (
          <tr key={flag.key} className="align-top hover:bg-primary/[0.04]">
            <th scope="row" className={cn(tdClass, "max-w-[320px] text-left font-normal")}>
              <div className="font-mono text-[12px] font-medium text-primary-text">{flag.key}</div>
              <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{flag.description}</div>
            </th>
            <td className={cn(tdClass, "whitespace-nowrap text-foreground/90")}>{flag.kind}</td>
            <td className={cn(tdClass, "whitespace-nowrap")}>
              {flag.killed ? <Pill tone="danger">Killed</Pill> : <span className="font-mono text-foreground">{rolloutLabel(flag)}</span>}
            </td>
            <td className={cn(tdClass, "whitespace-nowrap font-mono text-[11px] text-muted-foreground")}>{flag.kind === "experiment" ? fmtAbsolute(flag.start) : "—"}</td>
            <td className={cn(tdClass, "whitespace-nowrap font-mono text-[11px] text-muted-foreground")}>{flag.kind === "experiment" ? fmtAbsolute(flag.end) : "—"}</td>
            <td className={tdClass}>
              <GateCell gate={flag.gate} />
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

function ArmsTable({ arms }: { arms: ExperimentArm[] }) {
  return (
    <TableShell minWidth={1040} label="Results by arm">
      <thead>
        <tr>
          <th scope="col" className={thClass}>Arm</th>
          <th scope="col" className={numHead}>Enrolled</th>
          <th scope="col" className={numHead} title="Every exposure ever recorded for the arm, including accounts deleted since">Ever enrolled</th>
          <th scope="col" className={numHead} title="Enrolled accounts whose 7-day window has closed">Window complete</th>
          <th scope="col" className={numHead} title="Of those, with at least one successful write inside the window">Activated</th>
          <th scope="col" className={numHead} title="Activated, as a share of accounts whose window has closed">Rate</th>
          <th scope="col" className={numHead} title="Tool operations inside the window, all enrolled accounts">Operations</th>
          <th scope="col" className={numHead}>Error rate</th>
          <th scope="col" className={numHead} title="Enrolled accounts with at least one failed operation">Accounts erroring</th>
          <th scope="col" className={numHead} title="Feedback rows inside the window, spam excluded">Feedback</th>
          <th scope="col" className={numHead} title="Enrolled accounts that sent at least one bug report">Bug reporters</th>
        </tr>
      </thead>
      <tbody>
        {arms.map((arm) => (
          <tr key={arm.variant} className="hover:bg-primary/[0.04]">
            <th scope="row" className={cn(tdClass, "whitespace-nowrap text-left font-mono text-[12px] font-medium text-foreground")}>
              {arm.variant}
              {arm.weight != null && <span className="ml-1.5 font-normal text-muted-foreground">{arm.weight}%</span>}
            </th>
            <td className={numClass}>{fmtInt(arm.enrolled)}</td>
            <td className={numClass}>
              {fmtInt(arm.enrolledEver)}
              {arm.deletedSinceEnrolment ? <span className="ml-1.5 text-muted-foreground">({fmtInt(arm.deletedSinceEnrolment)} deleted)</span> : null}
            </td>
            <td className={numClass}>{fmtInt(arm.windowComplete)}</td>
            <td className={numClass}>{fmtInt(arm.activated)}</td>
            <td className={cn(numClass, "font-semibold text-foreground")}>{fmtRate(arm.activationRate)}</td>
            <td className={numClass}>{fmtInt(arm.operations)}</td>
            <td className={numClass}>
              {fmtRate(arm.operationErrorRate)}
              <span className="ml-1.5 text-muted-foreground">({fmtInt(arm.operationErrors)})</span>
            </td>
            <td className={numClass}>
              {fmtInt(arm.usersWithError)}
              <span className="ml-1.5 text-muted-foreground">({fmtRate(arm.usersWithErrorRate)})</span>
            </td>
            <td className={numClass}>
              {fmtInt(arm.feedbackSubmissions)}
              <span className="ml-1.5 text-muted-foreground">({fmtInt(arm.feedbackUsers)} people)</span>
            </td>
            <td className={numClass}>
              {fmtInt(arm.bugFeedbackUsers)}
              <span className="ml-1.5 text-muted-foreground">({fmtRate(arm.bugFeedbackUsersRate)})</span>
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

function TestLine({ label, test }: { label: string; test: ProportionTest | null }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      {test ? (
        <p className="mt-1 font-mono text-[12px] leading-relaxed text-foreground">
          {fmtRate(test.controlRate)} → {fmtRate(test.treatmentRate)} · {fmtPoints(test.difference)} (95% CI {fmtPoints(test.ci95[0])} to {fmtPoints(test.ci95[1])})
          <br />z = {test.z.toFixed(3)} · two-sided p = {fmtP(test.pValue)}
        </p>
      ) : (
        <p className="mt-1 font-mono text-[12px] text-muted-foreground">No test: an arm is empty, or no account (or every account) counted.</p>
      )}
    </div>
  );
}

function Readout({ readout }: { readout: ExperimentReadout }) {
  const meta = STATUS_META[readout.status];
  const enrolled = readout.variants.reduce((sum, arm) => sum + arm.enrolled, 0);
  const complete = readout.variants.reduce((sum, arm) => sum + arm.windowComplete, 0);
  const srmFailed = !!readout.srm && readout.srm.pValue < 0.001;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3 px-4 sm:px-5">
        <div className="min-w-0 flex-1 basis-64">
          <Pill tone={meta.tone}>{meta.label}</Pill>
          <p className="mt-2 text-[12px] leading-snug text-muted-foreground">{meta.meaning}</p>
          {readout.status !== "final" && readout.readyAt && (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">Every window closes {fmtAbsolute(readout.readyAt)}.</p>
          )}
        </div>
        <Mini label="Enrolled" value={fmtInt(enrolled)} />
        <Mini label={`${readout.windowDays}-day window complete`} value={fmtInt(complete)} />
      </div>

      {/* TableShell bleeds to the panel edge with negative margins, so it
          needs the panel's own padding around it. */}
      <div className="px-4 sm:px-5">
        <ArmsTable arms={readout.variants} />
      </div>

      <div className="grid gap-4 px-4 pb-4 sm:px-5 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Sample ratio</div>
          {readout.srm ? (
            <p className={cn("mt-1 font-mono text-[12px] leading-relaxed", srmFailed ? "text-destructive-text" : "text-foreground")}>
              {readout.srm.observed.map((n) => fmtInt(n)).join(" / ")} against an expected {readout.srm.expected.map((n) => n.toFixed(1)).join(" / ")}
              <br />chi² = {readout.srm.chi2.toFixed(3)} · p = {fmtP(readout.srm.pValue)}
              {srmFailed ? " · MISMATCH: assignment or exposure logging is wrong; do not compare the arms" : ""}
            </p>
          ) : (
            <p className="mt-1 font-mono text-[12px] text-muted-foreground">Nothing to check yet.</p>
          )}
        </div>

        {readout.test || readout.guardrailTests ? (
          <div className="flex min-w-0 flex-col gap-3">
            <TestLine label="Activation, control → treatment" test={readout.test} />
            <TestLine label="Guardrail: accounts with an error" test={readout.guardrailTests?.usersWithError ?? null} />
            <TestLine label="Guardrail: bug reporters" test={readout.guardrailTests?.bugFeedbackUsers ?? null} />
          </div>
        ) : (
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Comparison</div>
            <p className="mt-1 font-mono text-[12px] leading-relaxed text-muted-foreground">
              Withheld until the readout is final. The pre-registered rule is one look, after enrolment has closed and every window has.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ExperimentPanel({ flag, index, enabled }: { flag: FlagConfig; index: number; enabled: boolean }) {
  const readoutQ = useExperimentReadout(flag.key, enabled);
  return (
    <Panel
      index={index}
      title={`Readout · ${flag.key}`}
      hint={flag.doc ? `Pre-registration and the SQL behind every number: ${flag.doc}` : undefined}
      padded={false}
    >
      {readoutQ.isError ? (
        <div className="px-4 pb-4 sm:px-5">
          <ErrorNotice message="Could not load the readout." onRetry={() => readoutQ.refetch()} />
        </div>
      ) : readoutQ.isPending ? (
        <div className="px-4 pb-4 sm:px-5">
          <RowSkeleton rows={3} />
        </div>
      ) : (
        <Readout readout={readoutQ.data} />
      )}
    </Panel>
  );
}

export function ExperimentsView({ enabled }: { enabled: boolean }) {
  const flagsQ = useFlags(enabled);
  const flags = flagsQ.data?.flags ?? [];
  const problems = flags.flatMap((flag) => flag.problems);
  const experiments = flags.filter((flag) => flag.kind === "experiment");

  return (
    <div className="flex flex-col gap-4">
      <div className="admin-reveal rounded-xl border border-border/70 bg-muted/30 px-4 py-3 sm:px-5" style={{ ["--i" as string]: 0 }}>
        <p className="text-[12px] leading-snug text-muted-foreground">
          This view is <span className="font-medium text-foreground">read-only</span>. A flag is changed in App Service settings:{" "}
          <span className="font-mono text-foreground">FLAG_&lt;KEY&gt;_PERCENT</span>,{" "}
          <span className="font-mono text-foreground">_START</span>, <span className="font-mono text-foreground">_END</span>, and{" "}
          <span className="font-mono text-foreground">FLAGS_KILL</span> to turn one off. What is shown is what this server process is running with.
        </p>
      </div>

      <Panel index={1} title="Flags" hint="Every flag in server/lib/flags.js. A rollout flag at 0% is on for admins only." padded={false}>
        <div className="px-4 pb-1 sm:px-5">
          {flagsQ.isError ? (
            <ErrorNotice message="Could not load the flags." onRetry={() => flagsQ.refetch()} className="mb-3" />
          ) : flagsQ.isPending ? (
            <RowSkeleton rows={2} />
          ) : flags.length === 0 ? (
            <Empty className="mb-3">No flags are defined.</Empty>
          ) : (
            <>
              <FlagsTable flags={flags} />
              <div className="pb-3">
                <Problems problems={[...new Set(problems)]} />
              </div>
            </>
          )}
        </div>
      </Panel>

      {experiments.map((flag, i) => (
        <ExperimentPanel key={flag.key} flag={flag} index={i + 2} enabled={enabled} />
      ))}
    </div>
  );
}
