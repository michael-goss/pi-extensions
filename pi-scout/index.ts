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
}

const extensionDir = __dirname;
const promptsDir = path.join(extensionDir, "prompts");

function readPrompt(fileName: string, fallback: string): string {
  try {
    return fs.readFileSync(path.join(promptsDir, fileName), "utf8").trim();
  } catch {
    return fallback.trim();
  }
}

function readGuidelines(fileName: string, fallback: string[]): string[] {
  const text = readPrompt(fileName, fallback.join("\n"));
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

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

function makePrompt(task: string, goal?: string, scope?: string[]): string {
  const template = readPrompt(
    "scout-task-template.md",
    "Problem description:\n{{task}}\n\nGoal to reach:\n{{goal}}\n\n{{scope}}",
  );
  const scopeText = scope?.length ? `Suggested scope:\n${scope.map((s) => `- ${s}`).join("\n")}` : "";
  return template
    .replaceAll("{{task}}", task)
    .replaceAll("{{goal}}", goal || "Find the minimum local code context needed for the parent agent to act safely.")
    .replaceAll("{{scope}}", scopeText);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_scout",
    label: "Pi Scout",
    description: readPrompt(
      "tool-description.md",
      "Launch a fresh-context, read-only scout subagent for local codebase reconnaissance.",
    ),
    promptSnippet: readPrompt(
      "tool-snippet.md",
      "Launch a fresh-context read-only scout subagent and return compact findings.",
    ),
    promptGuidelines: readGuidelines("tool-guidelines.md", [
      "Use pi_scout before broad/open-ended codebase exploration.",
      "When calling pi_scout, provide a concrete problem description, goal, and any known scope.",
    ]),
    parameters: Type.Object({
      task: Type.String({ description: "Problem description and specific reconnaissance request for the scout." }),
      goal: Type.Optional(Type.String({ description: "Concrete goal the scout should reach before returning." })),
      scope: Type.Optional(Type.Array(Type.String(), { description: "Optional paths, modules, symbols, or areas to prioritize." })),
      outputDir: Type.Optional(Type.String({ description: "Override artifact directory. Relative paths resolve against cwd." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const settings = loadSettings(ctx.cwd);
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
        systemPromptOverride: () => readPrompt(
          "scout-system.md",
          "You are pi-scout, a read-only codebase reconnaissance subagent. Return compact, evidence-backed handoff context only.",
        ),
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
        }
      });

      try {
        if (signal?.aborted) throw new Error("pi_scout aborted before start");
        const abort = () => void session.abort();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          await session.prompt(makePrompt(params.task, params.goal, params.scope), { source: "extension" });
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      } finally {
        unsubscribe();
        session.dispose();
      }

      const artifact = assistantText.trim() || "# Scout Findings\n\nScout completed without text output.";
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

  pi.on("before_agent_start", async (event) => {
    const injection = readPrompt(
      "parent-turn-injection.md",
      "## Pi Scout context hygiene\nUse `pi_scout` before broad/open-ended local codebase exploration.",
    );
    return { systemPrompt: `${event.systemPrompt}\n\n${injection}` };
  });
}
