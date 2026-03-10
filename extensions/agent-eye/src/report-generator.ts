// Agent Eye — Report Generator
// Writes diagnostic reports to ~/soundchain/reports/ as JSON + Markdown + JPEG
// Zero booleans. All state uses typed string enums with explicit equality checks.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiagnoseReport } from "./diagnose.js";
import { BUG_SEVERITY } from "./store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPORTS_DIR = join(homedir(), "soundchain", "reports");

// ---------------------------------------------------------------------------
// Ensure directory
// ---------------------------------------------------------------------------

function ensureReportsDir(): void {
  mkdirSync(REPORTS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ReportPaths = {
  jsonPath: string;
  mdPath: string;
  screenshotPath: string | null;
  dir: string;
};

export function writeReport(report: DiagnoseReport): ReportPaths {
  ensureReportsDir();

  const base = `eye-diag-${report.startedAt}`;
  const jsonPath = join(REPORTS_DIR, `${base}.json`);
  const mdPath = join(REPORTS_DIR, `${base}.md`);
  let screenshotPath: string | null = null;

  // Write screenshot
  if (report.screenshotBuffer !== null) {
    screenshotPath = join(REPORTS_DIR, `${base}.jpg`);
    writeFileSync(screenshotPath, report.screenshotBuffer);
  }

  // Write JSON (exclude raw buffer)
  const jsonPayload = {
    id: report.id,
    url: report.url,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    status: report.status,
    overallSeverity: report.overallSeverity,
    bugs: report.bugs,
    consoleMessages: report.consoleMessages,
    networkFailures: report.networkFailures,
    domSnapshot: report.domSnapshot,
    screenshotPath,
    actionTimeline: report.actionTimeline,
    summary: report.summary,
  };
  writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf-8");

  // Write Markdown
  const md = generateMarkdown(report, screenshotPath);
  writeFileSync(mdPath, md, "utf-8");

  return { jsonPath, mdPath, screenshotPath, dir: REPORTS_DIR };
}

// ---------------------------------------------------------------------------
// Markdown generator
// ---------------------------------------------------------------------------

function generateMarkdown(report: DiagnoseReport, screenshotPath: string | null): string {
  const lines: string[] = [];
  const ts = new Date(report.startedAt).toISOString();
  const duration = report.completedAt - report.startedAt;

  lines.push("# Agent EYE Diagnostic Report");
  lines.push("");
  lines.push(`**URL:** ${report.url}`);
  lines.push(`**Date:** ${ts}`);
  lines.push(`**Duration:** ${duration}ms`);
  lines.push(`**Status:** ${report.status}`);
  lines.push(`**Overall Severity:** ${report.overallSeverity}`);
  lines.push(`**Report ID:** ${report.id}`);
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push(report.summary);
  lines.push("");

  // Severity breakdown
  const severityCounts: Record<string, number> = {
    [BUG_SEVERITY.CRITICAL]: 0,
    [BUG_SEVERITY.ERROR]: 0,
    [BUG_SEVERITY.WARNING]: 0,
    [BUG_SEVERITY.INFO]: 0,
  };
  for (const bug of report.bugs) {
    severityCounts[bug.severity] = (severityCounts[bug.severity] ?? 0) + 1;
  }
  lines.push("### Severity Breakdown");
  lines.push("");
  lines.push(`- CRITICAL: ${severityCounts[BUG_SEVERITY.CRITICAL]}`);
  lines.push(`- ERROR: ${severityCounts[BUG_SEVERITY.ERROR]}`);
  lines.push(`- WARNING: ${severityCounts[BUG_SEVERITY.WARNING]}`);
  lines.push(`- INFO: ${severityCounts[BUG_SEVERITY.INFO]}`);
  lines.push("");

  // Bugs table
  if (report.bugs.length > 0) {
    lines.push(`## Bugs Found (${report.bugs.length})`);
    lines.push("");
    lines.push("| # | Severity | Trigger | Message |");
    lines.push("|---|----------|---------|---------|");
    for (let i = 0; i < report.bugs.length; i++) {
      const bug = report.bugs[i]!;
      const msg = bug.message.length > 100 ? bug.message.slice(0, 100) + "..." : bug.message;
      lines.push(`| ${i + 1} | ${bug.severity} | ${bug.trigger} | ${escapeMarkdown(msg)} |`);
    }
    lines.push("");

    // Bug details
    for (const bug of report.bugs) {
      lines.push(`### Bug: ${bug.id}`);
      lines.push("");
      lines.push(`- **Severity:** ${bug.severity}`);
      lines.push(`- **Trigger:** ${bug.trigger}`);
      lines.push(`- **URL:** ${bug.url}`);
      lines.push(`- **Message:** ${escapeMarkdown(bug.message)}`);
      if (bug.filename)
        lines.push(`- **File:** ${bug.filename}:${bug.line ?? "?"}:${bug.col ?? "?"}`);
      if (bug.status !== undefined) lines.push(`- **HTTP Status:** ${bug.status}`);
      if (bug.method) lines.push(`- **HTTP Method:** ${bug.method}`);
      if (bug.stack) {
        lines.push("");
        lines.push("```");
        lines.push(bug.stack);
        lines.push("```");
      }
      lines.push("");
    }
  } else {
    lines.push("## Bugs Found (0)");
    lines.push("");
    lines.push("No bugs detected during scan.");
    lines.push("");
  }

  // Console messages
  if (report.consoleMessages.length > 0) {
    lines.push(`## Console Messages (${report.consoleMessages.length})`);
    lines.push("");
    lines.push("| Type | Timestamp | Message |");
    lines.push("|------|-----------|---------|");
    for (const msg of report.consoleMessages.slice(0, 50)) {
      const text = msg.text.length > 120 ? msg.text.slice(0, 120) + "..." : msg.text;
      lines.push(`| ${msg.type} | ${msg.timestamp} | ${escapeMarkdown(text)} |`);
    }
    if (report.consoleMessages.length > 50) {
      lines.push(`| ... | ... | ${report.consoleMessages.length - 50} more messages truncated |`);
    }
    lines.push("");
  }

  // Network failures
  if (report.networkFailures.length > 0) {
    lines.push(`## Network Failures (${report.networkFailures.length})`);
    lines.push("");
    lines.push("| Method | URL | Status | Error |");
    lines.push("|--------|-----|--------|-------|");
    for (const nf of report.networkFailures.slice(0, 50)) {
      const shortUrl = nf.url.length > 80 ? nf.url.slice(0, 80) + "..." : nf.url;
      lines.push(
        `| ${nf.method} | ${escapeMarkdown(shortUrl)} | ${nf.status ?? "-"} | ${escapeMarkdown(nf.failureText ?? "-")} |`,
      );
    }
    if (report.networkFailures.length > 50) {
      lines.push(`| ... | ... | ... | ${report.networkFailures.length - 50} more truncated |`);
    }
    lines.push("");
  }

  // Action timeline
  if (report.actionTimeline.length > 0) {
    lines.push("## Scan Timeline");
    lines.push("");
    lines.push("| Step | Duration | Status |");
    lines.push("|------|----------|--------|");
    for (const entry of report.actionTimeline) {
      const failed = entry.step.endsWith("_failed") ? "FAILED" : "OK";
      lines.push(`| ${entry.step} | ${entry.durationMs}ms | ${failed} |`);
    }
    lines.push("");
  }

  // DOM snapshot (truncated)
  if (report.domSnapshot) {
    lines.push("## DOM Snapshot");
    lines.push("");
    const truncated =
      report.domSnapshot.length > 5000
        ? report.domSnapshot.slice(0, 5000) + "\n\n... (truncated, see full JSON report)"
        : report.domSnapshot;
    lines.push("```");
    lines.push(truncated);
    lines.push("```");
    lines.push("");
  }

  // Screenshot reference
  if (screenshotPath) {
    lines.push("## Screenshot");
    lines.push("");
    lines.push(`Saved to: \`${screenshotPath}\``);
    lines.push("");
  }

  // Footer
  lines.push("---");
  lines.push(`*Generated by Agent EYE v2026.2.18 — SoundChain Diagnostics*`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeMarkdown(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
