import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface PiScoutSettings {
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  outputDir?: string;
  outputFilePrefix?: string;
  tools?: string[];
  maxToolCalls?: number;
}

const SCOUT_SYSTEM_PROMPT = `You are pi_scout, a read-only codebase reconnaissance subagent launched by a parent coding agent.
Your job is reconnaissance, not implementation, analysis ownership, or final-answer writing. Find the minimum local code context the parent agent needs to act safely. Use targeted search and selective reads to produce a compact, evidence-backed handoff for the parent to reason over.
You may inspect files and run non-destructive read-only commands. Do not edit files, create files, install dependencies, start long-running services, or make product/design decisions. Prefer read, grep, find, and ls over bash; use bash only for safe inspection commands when the dedicated tools are insufficient.
Return concise findings with exact file paths and line ranges for code claims. If the task is too broad, deliberately stop after mapping the most relevant seams and recommend follow-up scout slices. If evidence is incomplete, say so explicitly.`;

const SCOUT_TASK_TEMPLATE = `Problem description:
{{task}}

Goal to reach:
{{goal}}

{{scope}}

Reconnaissance rules:
- You are a scout, not the lead agent: do not try to fully solve the user request; gather evidence and identify seams so the parent can decide.
- Treat this as one bounded slice. Prefer stopping early with useful next-scout recommendations over exhaustive exploration.
- Hard budget: at most {{maxToolCalls}} tool calls. If you are near the budget, stop and summarize what is known/unknown.
- Start with targeted grep/find/ls to map the area before reading files.
- Read only the most relevant files or line ranges; avoid whole-file dumps unless necessary.
- Follow references far enough to explain the relevant architecture, data flow, or failure path.
- Cite exact file paths and line ranges for every substantive code claim.
- Keep the handoff compact; optimize for what the parent agent should know next.
- Do not edit files. Do not run destructive commands. Use bash only for non-interactive read-only inspection.

Output exactly this Markdown structure:
# Scout Findings

## Files Inspected
- \`path\` lines X-Y — why it matters

## Key Findings
- Concise evidence-backed findings with file/line citations.

## Architecture / Flow
How the relevant pieces connect. Mention important entry points, call chains, data flow, or state transitions.

## Start Here
The first file/symbol the parent should inspect next and why. Include suggested follow-up scout slices if more exploration is needed.

## Risks and Open Questions
Anything uncertain, contradictory, missing from evidence, or requiring user/product decision.`;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function loadSettings(cwd: string): PiScoutSettings {
  const global = readJson(path.join(getAgentDir(), "settings.json"))?.piScout ?? {};
  const project = readJson(path.join(cwd, ".pi", "settings.json"))?.piScout ?? {};
  return { ...global, ...project };
}

function resolvePath(cwd: string, p?: string): string {
  const value = p || path.join(os.tmpdir(), "pi-scout-runs");
  if (value.startsWith("~")) return path.join(os.homedir(), value.slice(1));
  return path.isAbsolute(value) ? value : path.join(cwd, value);
}

function safeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "scout";
}


function summarizeToolArgs(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";

  const pick = (...keys: string[]) => keys
    .map((key) => args[key])
    .find((value) => typeof value === "string" && value.trim().length > 0);

  let summary = "";
  if (toolName === "read") summary = pick("path", "file") || "";
  else if (toolName === "grep") {
    const pattern = pick("pattern") || "";
    const target = pick("path", "glob") || "";
    summary = [pattern && `pattern=${JSON.stringify(pattern)}`, target].filter(Boolean).join(" ");
  } else if (toolName === "find") {
    const pattern = pick("pattern") || "";
    const target = pick("path") || "";
    summary = [pattern && `pattern=${JSON.stringify(pattern)}`, target].filter(Boolean).join(" ");
  } else if (toolName === "ls") summary = pick("path") || ".";
  else if (toolName === "bash") summary = pick("command") || "";
  else summary = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`)
    .join(" ");

  summary = summary.replace(/\s+/g, " ").trim();
  return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

function makePrompt(task: string, goal?: string, scope?: string[], maxToolCalls = 50): string {
  const scopeText = scope?.length ? `Suggested scope:\n${scope.map((s) => `- ${s}`).join("\n")}` : "";
  return SCOUT_TASK_TEMPLATE
    .replaceAll("{{task}}", task)
    .replaceAll("{{goal}}", goal || "Find the minimum local code context needed for the parent agent to act safely.")
    .replaceAll("{{scope}}", scopeText)
    .replaceAll("{{maxToolCalls}}", String(maxToolCalls));
}

export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_scout",
    label: "Pi Scout",
    description:
      "Perform bounded, read-only codebase reconnaissance in a separate fresh-context agent session. Use for exploration/evidence gathering before the parent agent reasons or decides. Prefer multiple narrow scout calls over one broad catch-all. Returns a compact handoff, not a final answer.",
    promptSnippet:
      "Delegate a bounded reconnaissance slice to a read-only scout; parent remains responsible for synthesis and decisions.",
    promptGuidelines: [
      "Use pi_scout for bounded reconnaissance slices: mapping an unfamiliar area, tracing a specific cross-file flow, comparing implementations, or collecting evidence before parent reasoning.",
      "For broad user questions, split exploration into multiple focused pi_scout calls as needed; do not delegate the whole problem/decision to one scout.",
      "Use pi_scout when you expect to need repository-wide search, more than three file reads, or context that should be summarized before the parent agent acts.",
      "Do not manually grep/read many files in the parent session before using pi_scout; delegate reconnaissance early, then continue from the scout artifact.",
      "Do not use pi_scout for a single known file, a narrow symbol lookup, or a quick directory listing where read/grep/find/ls is sufficient.",
      "When calling pi_scout, include a specific task, a concrete goal, and any known scope paths, modules, symbols, or files.",
      "Wait for the pi_scout result, then the parent agent must inspect/synthesize/decide; do not simply relay the scout report as the final answer.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Problem description and specific reconnaissance request for the scout." }),
      goal: Type.Optional(Type.String({ description: "Concrete goal the scout should reach before returning." })),
      scope: Type.Optional(Type.Array(Type.String(), { description: "Optional paths, modules, symbols, or areas to prioritize." })),
      outputDir: Type.Optional(Type.String({ description: "Override artifact directory. Relative paths resolve against cwd." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const settings = loadSettings(ctx.cwd);
      const maxToolCalls = settings.maxToolCalls ?? 50;
      const outputDir = resolvePath(ctx.cwd, params.outputDir || settings.outputDir);
      fs.mkdirSync(outputDir, { recursive: true });
      const fileName = `${settings.outputFilePrefix || "scout"}-${Date.now()}-${safeSlug(params.task)}.md`;
      const outputPath = path.join(outputDir, fileName);

      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const model = settings.model
        ? modelRegistry.find(settings.model.split("/")[0], settings.model.split("/").slice(1).join("/"))
        : undefined;

      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        systemPromptOverride: () => SCOUT_SYSTEM_PROMPT,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: ctx.cwd,
        model,
        thinkingLevel: settings.thinking || "low",
        tools: settings.tools || ["read", "grep", "find", "ls", "bash"],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(ctx.cwd),
        authStorage,
        modelRegistry,
      });

      let assistantText = "";
      const toolTimeline: string[] = [];
      let budgetAbort = false;
      const emitToolTimeline = () => {
        if (!onUpdate || toolTimeline.length === 0) return;
        onUpdate({
          content: [{ type: "text", text: `Scout tool activity:\n${toolTimeline.join("\n")}` }],
          details: { outputPath, toolTimeline },
        });
      };
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          assistantText += event.assistantMessageEvent.delta;
        }
        if (event.type === "tool_execution_start") {
          const n = toolTimeline.length + 1;
          const summary = summarizeToolArgs(event.toolName, event.args);
          toolTimeline.push(`${n}. ${event.toolName}${summary ? ` — ${summary}` : ""}`);
          emitToolTimeline();
          if (n >= maxToolCalls && !budgetAbort) {
            budgetAbort = true;
            session.abort();
          }
        }
      });

      try {
        if (signal?.aborted) throw new Error("pi_scout aborted before start");
        const abort = () => void session.abort();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          await session.prompt(makePrompt(params.task, params.goal, params.scope, maxToolCalls), { source: "extension" });
        } catch (error) {
          if (!budgetAbort) throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      } finally {
        unsubscribe();
        session.dispose();
      }

      const budgetNote = budgetAbort
        ? `\n\n> Scout stopped after reaching the configured maxToolCalls budget (${maxToolCalls}). Treat findings as partial and launch a narrower follow-up scout if needed.`
        : "";
      const artifact = (assistantText.trim() || "# Scout Findings\n\nScout completed without text output.") + budgetNote;
      fs.writeFileSync(outputPath, artifact + "\n", "utf8");

      return {
        content: [
          {
            type: "text",
            text: `pi_scout completed. Artifact: ${outputPath}\n\n${artifact}`,
          },
        ],
        details: { outputPath, bytes: Buffer.byteLength(artifact, "utf8") },
      };
    },
  });
}
