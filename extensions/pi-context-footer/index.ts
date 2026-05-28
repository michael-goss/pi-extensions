import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import fs from "node:fs";
import path from "node:path";

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function isAutoCompactionEnabled(cwd: string): boolean {
  const global = readJson(path.join(getAgentDir(), "settings.json"));
  const project = readJson(path.join(cwd, ".pi", "settings.json"));
  return project?.compaction?.enabled ?? global?.compaction?.enabled ?? true;
}

export default function(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const autoCompactionEnabled = isAutoCompactionEnabled(ctx.cwd);

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsubscribeBranch,
        invalidate() {},
        render(width: number): string[] {
          let input = 0;
          let output = 0;
          let cacheRead = 0;
          let cacheWrite = 0;
          let cost = 0;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const message = entry.message as AssistantMessage;
              input += message.usage.input;
              output += message.usage.output;
              cacheRead += message.usage.cacheRead;
              cacheWrite += message.usage.cacheWrite;
              cost += message.usage.cost.total;
            }
          }

          const parts: string[] = [];
          if (input) parts.push(`↑${formatTokens(input)}`);
          if (output) parts.push(`↓${formatTokens(output)}`);
          if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
          if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);

          const model = ctx.model;
          const usingSubscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
          if (cost || usingSubscription) parts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
          const contextTokens = contextUsage?.tokens ?? null;
          const contextPercent = contextUsage?.percent ?? null;
          const autoIndicator = autoCompactionEnabled ? " (auto)" : "";
          const contextValue = contextTokens === null
            ? `?/${formatTokens(contextWindow)} (?%)`
            : `${formatTokens(contextTokens)}/${formatTokens(contextWindow)} (${contextPercent?.toFixed(1) ?? "?"}%)`;
          const contextColor = (contextPercent ?? 0) > 55 ? "error" : (contextPercent ?? 0) > 40 ? "warning" : "dim";
          parts.push(`${theme.fg(contextColor, contextValue)}${autoIndicator}`);

          const left = parts.join(" ");
          const branch = footerData.getGitBranch();
          const branchText = branch ? ` (${branch})` : "";
          const right = `${model?.id || "no-model"}${branchText}`;

          const leftWidth = visibleWidth(left);
          const rightWidth = visibleWidth(right);
          let statsLine: string;
          if (leftWidth + 2 + rightWidth <= width) {
            statsLine = left + " ".repeat(width - leftWidth - rightWidth) + theme.fg("dim", right);
          } else {
            const availableRight = width - leftWidth - 2;
            statsLine = availableRight > 0
              ? left + "  " + theme.fg("dim", truncateToWidth(right, availableRight, ""))
              : truncateToWidth(left, width, "...");
          }

          const statuses = Array.from(footerData.getExtensionStatuses().entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatusText(text));

          return statuses.length
            ? [statsLine, truncateToWidth(statuses.join(" "), width, theme.fg("dim", "..."))]
            : [statsLine];
        },
      };
    });
  });
}
