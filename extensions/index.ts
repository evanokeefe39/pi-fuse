/**
 * pi-fuse — Custom Pi Provider for Multi-Model Fusion
 *
 * Inspired by OpenRouter's Fusion strategy:
 * - Product page: https://openrouter.ai/fusion
 * - Benchmark results: https://openrouter.ai/blog/announcements/fusion-beats-frontier/
 *   "Surpassing Frontier Performance with Fusion" — A panel of budget models,
 *   fused through OpenRouter, outscored GPT-5.5 and Claude Opus 4.8 on 100
 *   complex research tasks (June 2026).
 *
 * Fans out to multiple models (DeepSeek, Groq, OpenRouter, etc.) in parallel,
 * collects their responses, and synthesizes the best answer via a judge model.
 * All inside Pi's process — no external server needed.
 *
 * Presets are defined in a bundled config.default.json. Users can override
 * presets by creating ~/.pi/agent/skills/fuse/config.json (shared with the
 * fuse CLI/server skill). Pi credentials from ~/.pi/agent/auth.json and
 * ~/.pi/agent/models.json are used for provider access.
 *
 * Install: pi install git:github.com/evanokeefe39/pi-fuse
 *     Or:  pi install /path/to/pi-fuse
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  ThinkingContent,
  Api,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// ── Resolve package root for bundled config ───────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const BUNDLED_CONFIG = join(PACKAGE_ROOT, "config.default.json");

// ── User override path (shared with fuse CLI/server skill) ────────────────
const HOME = homedir();
const USER_CONFIG = join(HOME, ".pi/agent/extensions/fuse.json");
const OLD_USER_CONFIG = join(HOME, ".pi/agent/skills/fuse/config.json");
const AUTH_PATH = join(HOME, ".pi/agent/auth.json");
const MODELS_PATH = join(HOME, ".pi/agent/models.json");

// ── Types ──────────────────────────────────────────────────────────────────

interface FuseConfig {
  default_preset: string;
  presets: Record<string, { panel: string[]; judge: string }>;
}

interface ResolvedEndpoint {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  maxInput?: number;
}

interface AuthEntry {
  key: string;
}

interface ModelsFile {
  providers: Record<string, {
    baseUrl: string;
    apiKey: string;
    models?: { id: string; name: string; contextWindow?: number; maxInput?: number }[];
  }>;
}

// ── File helpers ──────────────────────────────────────────────────────────

function tryLoad<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; }
  catch { return null; }
}

function loadAuth(): Record<string, AuthEntry> {
  try {
    const raw = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as Record<string, AuthEntry>;
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

function loadModels(): ModelsFile {
  try {
    const raw = JSON.parse(readFileSync(MODELS_PATH, "utf-8")) as ModelsFile;
    return raw?.providers ? raw : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

// ── Simple preset validation ──────────────────────────────────────────────
// ponytail: only checks format — malformed configs crash with their own error

function loadConfig(): FuseConfig {
  const bundled = tryLoad<FuseConfig>(BUNDLED_CONFIG);
  if (!bundled) {
    console.error("[pi-fuse] Missing bundled config.default.json — package may be corrupted");
    return { default_preset: "spread", presets: {} };
  }
  if (existsSync(OLD_USER_CONFIG) && !existsSync(USER_CONFIG)) {
    // Migrate from old path to new path
    try {
      const oldCfg = readFileSync(OLD_USER_CONFIG, "utf-8");
      mkdirSync(join(USER_CONFIG, ".."), { recursive: true });
      writeFileSync(USER_CONFIG, oldCfg, "utf-8");
      console.error("[pi-fuse] Migrated config from", OLD_USER_CONFIG, "to", USER_CONFIG);
    } catch {}
  }
  if (!existsSync(USER_CONFIG)) {
    // First run — copy bundled defaults so user has something to edit
    try {
      mkdirSync(join(USER_CONFIG, ".."), { recursive: true });
      writeFileSync(USER_CONFIG, JSON.stringify(bundled, null, 2), "utf-8");
      console.error("[pi-fuse] Created user config at", USER_CONFIG);
    } catch {}
  }
  const user = tryLoad<FuseConfig>(USER_CONFIG);
  if (user) {
    return {
      default_preset: user.default_preset || bundled.default_preset,
      presets: { ...bundled.presets, ...user.presets },
    };
  }
  return bundled;
}

// ── Token estimation / context truncation ─────────────────────────────────
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function truncateMessages(
  msgs: { role: string; content: string }[],
  maxTokens: number
): { messages: { role: string; content: string }[] } {
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  if (!lastUser) return { messages: msgs.slice(-1) };

  let budget = Math.max(256, maxTokens - 512);
  const reversed = [...msgs].reverse();
  const collected: { role: string; content: string }[] = [];

  for (const m of reversed) {
    if (m.role === "system") continue;
    const t = estimateTokens(m.content);
    if (t <= budget) { collected.push(m); budget -= t; }
    else if (m === lastUser || collected.length === 0) {
      collected.push({ ...m, content: m.content.slice(0, Math.max(50, Math.floor(budget * 3.5))) });
      break;
    }
  }

  return { messages: collected.reverse() };
}

// ── Circuit breaker ─────────────────────────────────────────────────────────
// After 3 consecutive failed prompts for a provider, skip for 30s.
// recordFailure only fires after all 429 retries are exhausted, so
// transient rate limits that recover never trip this.

const circuitState = new Map<string, { failures: number; openedAt: number }>();

function recordFailure(provider: string) {
  let s = circuitState.get(provider);
  if (!s) { s = { failures: 0, openedAt: 0 }; circuitState.set(provider, s); }
  s.failures++;
  if (s.failures >= 3) { s.openedAt = Date.now(); console.error(`[pi-fuse] Circuit open for ${provider}`); }
}

function isCircuitOpen(provider: string): boolean {
  const s = circuitState.get(provider);
  if (!s || s.openedAt === 0) return false;
  if (Date.now() - s.openedAt > 30000) { s.failures = 0; s.openedAt = 0; return false; }
  return true;
}

// ── Extension entry point ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const fuseConfig = loadConfig();
  const PRESET_NAMES = Object.keys(fuseConfig.presets);

  if (PRESET_NAMES.length === 0) {
    console.error("[pi-fuse] No presets defined — skipping provider registration");
    return;
  }

  let authCache: Record<string, AuthEntry> = loadAuth();
  let modelsCache: ModelsFile = loadModels();

  // ── Resolve "provider:model" → endpoint with live config ──────────────
  function resolveModel(ref: string): ResolvedEndpoint {
    const colon = ref.indexOf(":");
    if (colon === -1) throw new Error(`Need provider:model, got "${ref}"`);
    const provider = ref.slice(0, colon);
    const model = ref.slice(colon + 1);
    const provDef = modelsCache.providers?.[provider];
    if (!provDef)
      throw new Error(`Unknown provider "${provider}". Valid: ${Object.keys(modelsCache.providers || {}).join(", ")}`);
    const apiKey =
      authCache[provider]?.key ||
      process.env[provDef.apiKey.replace(/^\$/, "")] ||
      provDef.apiKey;
    if (!apiKey)
      throw new Error(`No API key for "${provider}". Add to auth.json as {"${provider}":{"key":"sk-..."}} or set ${provDef.apiKey.replace(/^\$/, "")} env var.`);
    const modDef = (provDef as any).models?.find((m: any) => m.id === model);
    return {
      provider, model, baseUrl: provDef.baseUrl, apiKey,
      contextWindow: modDef?.contextWindow ?? undefined,
      maxInput: modDef?.maxInput ?? undefined,
    };
  }

  function refreshConfigs() {
    const fresh = loadAuth();
    if (Object.keys(fresh).length > 0) authCache = fresh;
    const freshModels = loadModels();
    if (Object.keys(freshModels.providers).length > 0) modelsCache = freshModels;
  }

  // ── Call one panel model (non-streaming, with 429 retry) ──────────────
  async function callPanelModel(
    entry: ResolvedEndpoint,
    messages: { role: string; content: string }[],
    signal?: AbortSignal,
    attempt = 1
  ): Promise<{ content: string }> {
    const controller = new AbortController();
    const mergedSignal = signal ?? controller.signal;
    const timeout = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(`${entry.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${entry.apiKey}`,
        },
        body: JSON.stringify({
          model: entry.model,
          messages,
          temperature: 0.7,
          max_tokens: 4096,
          stream: false,
        }),
        signal: mergedSignal,
      });

      if (res.status === 429 && attempt < 3) {
        const backoff = Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 5000);
        await new Promise((r) => setTimeout(r, backoff));
        return callPanelModel(entry, messages, signal, attempt + 1);
      }

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`${entry.provider}:${entry.model} (${res.status}) ${err.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
      };

      return { content: data.choices?.[0]?.message?.content ?? "[no output]" };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Stream from judge model ──────────────────────────────────────────
  async function streamJudge(
    entry: ResolvedEndpoint,
    messages: { role: string; content: string }[],
    signal: AbortSignal | undefined,
    output: AssistantMessage,
    stream: AssistantMessageEventStream
  ): Promise<void> {
    const res = await fetch(`${entry.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${entry.apiKey}`,
      },
      body: JSON.stringify({
        model: entry.model,
        messages,
        temperature: 0.7,
        max_tokens: 4096,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`${entry.provider}:${entry.model} (${res.status}) ${err.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body for judge stream");

    const decoder = new TextDecoder();
    let buffer = "";

    output.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex: 1, partial: output });

    let judgeInputTokens = 0;
    let judgeOutputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") break;

        try {
          const chunk = JSON.parse(payload) as {
            choices?: { delta: { content?: string }; finish_reason?: string | null }[];
            usage?: { prompt_tokens: number; completion_tokens: number };
          };

          if (chunk.usage) {
            judgeInputTokens = chunk.usage.prompt_tokens;
            judgeOutputTokens = chunk.usage.completion_tokens;
          }

          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            const block = output.content[1];
            if (block.type === "text") block.text += delta;
            stream.push({ type: "text_delta", contentIndex: 1, delta, partial: output });
          }
        } catch {
          if (trimmed.length < 200) console.debug("[pi-fuse] SSE parse skip:", trimmed.slice(0, 100));
        }
      }
    }

    output.usage.input = judgeInputTokens;
    output.usage.output = judgeOutputTokens;
    output.usage.totalTokens = judgeInputTokens + judgeOutputTokens;
    output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

    stream.push({ type: "text_end", contentIndex: 1, content: output.content[1]?.text ?? "", partial: output });
  }

  // ── Error stream for non-fuse models ──────────────────────────────────
  function createErrorStream(errorMessage: string): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: FUSE_API,
      provider: "fuse",
      model: "fuse-unknown",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error",
      errorMessage,
      timestamp: Date.now(),
    };
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
    return stream;
  }

  // ── Main fusion stream factory ────────────────────────────────────────
  function createFuseStream(
    presetName: string,
    context: Context,
    options: SimpleStreamOptions | undefined
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const signal = options?.signal;

    (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: FUSE_API,
        provider: "fuse",
        model: `fuse-${presetName}`,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      try {
        refreshConfigs();

        const preset = fuseConfig.presets[presetName];
        if (!preset) throw new Error(`Unknown fuse preset "${presetName}"`);
        const panelEntries = preset.panel.map(resolveModel);
        const judgeEntry = resolveModel(preset.judge);

        if (isCircuitOpen(judgeEntry.provider)) {
          throw new Error(`Judge circuit open for "${judgeEntry.provider}" — cooling down`);
        }

        // ── Thinking block for live progress ────────────────────────
        const presetLabel = presetName.charAt(0).toUpperCase() + presetName.slice(1);
        const thinkingHeader = `Fuse ${presetLabel} — ${panelEntries.length} panel + judge\n\n`;
        output.content.push({ type: "thinking", thinking: thinkingHeader } as ThinkingContent);
        stream.push({ type: "start", partial: output });
        stream.push({ type: "thinking_start", contentIndex: 0, partial: output });

        function thinkPush(text: string) {
          const block = output.content[0];
          if (block.type === "thinking") block.thinking += text;
          stream.push({ type: "thinking_delta", contentIndex: 0, delta: text, partial: output });
        }

        thinkPush(`  ⏳ Fanning out to ${panelEntries.length} models...\n`);

        // Convert Pi context to simple {role, content} format for panel models
        const contextMessages: { role: string; content: string }[] = [];

        if (context.systemPrompt) {
          contextMessages.push({ role: "system", content: context.systemPrompt });
        }

        for (const msg of context.messages ?? []) {
          if (!("role" in msg) || !("content" in msg)) continue;
          const role = (msg as { role: string }).role;
          const content = (msg as { content: unknown }).content;

          // Panel models only accept standard roles: system, user, assistant, tool
          if (!["system", "user", "assistant", "tool"].includes(role)) continue;
          if (role === "tool") continue;

          let text = "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content))
            text = content.filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join("\n");

          if (text) contextMessages.push({ role, content: text });
        }

        if (contextMessages.length === 0) contextMessages.push({ role: "user", content: "..." });

        // ── Fan-out to panel models ────────────────────────────────
        const panelResults = await Promise.all(
          panelEntries.map(async (entry, idx) => {
            if (idx > 0) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 250) + 50));
            const shortName = entry.model.split("/").pop()!;
            if (isCircuitOpen(entry.provider)) {
              thinkPush(`  ⊘ ${entry.provider}:${shortName} — circuit open\n`);
              return { label: `${entry.provider}:${entry.model}`, content: null, error: 'circuit open' };
            }
            const t0 = performance.now();
            try {
              const ctxWindow = entry.contextWindow ?? 128000;
              const budget = entry.maxInput != null ? Math.min(entry.maxInput, ctxWindow - 4096) : ctxWindow - 4096;
              const { messages: panelMsgs } = truncateMessages(contextMessages, budget);
              const result = await callPanelModel(entry, panelMsgs, signal);
              const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
              thinkPush(`  ✓ ${entry.provider}:${shortName} ${elapsed}s\n`);
              return { label: `${entry.provider}:${entry.model}`, content: result.content };
            } catch (err) {
              recordFailure(entry.provider);
              const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
              const errMsg = (err as Error).message.slice(0, 80);
              thinkPush(`  ✗ ${entry.provider}:${shortName} ${elapsed}s — ${errMsg}\n`);
              return { label: `${entry.provider}:${entry.model}`, content: null, error: (err as Error).message };
            }
          })
        );

        const succeeded = panelResults.filter((r) => r.content !== null);
        if (succeeded.length === 0) {
          const errors = panelResults.map((r) => r.error).filter(Boolean).join("; ");
          throw new Error(`All panel models failed: ${errors}`);
        }

        // ── Build judge prompt ────────────────────────────────────────
        const originalQ = contextMessages.findLast((m) => m.role === "user")?.content ?? "";
        const sections = succeeded.map((r, i) => `--- Model ${i + 1} (${r.label}) ---\n\n${r.content}`);

        const judgeShortName = judgeEntry.model.split("/").pop()!;
        thinkPush(`\n→ Synthesizing with ${judgeEntry.provider}:${judgeShortName}...\n\n`);
        const thinkingBlock = output.content[0];
        if (thinkingBlock.type === "thinking") {
          stream.push({ type: "thinking_end", contentIndex: 0, content: thinkingBlock.thinking, partial: output });
        }

        const judgeMessages = [
          {
            role: "system" as const,
            content: [
              "You are a fusion judge. Synthesize the best answer from multiple model responses.",
              "Identify: 1) Consensus — points all models agree on",
              "2) Contradictions — points where models disagree",
              "3) Unique insights — valuable points only one model made",
              "4) Blind spots — important angles none covered",
              "Then produce the best final answer that synthesizes the strongest elements.",
            ].join("\n"),
          },
          {
            role: "user" as const,
            content: `Original question:\n${originalQ}\n\nPanel responses:\n${sections.join("\n\n")}\n\nFused final answer:`,
          },
        ];

        // ── Stream judge response ─────────────────────────────────────
        await streamJudge(judgeEntry, judgeMessages, signal, output, stream);

        stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
        stream.end();
      } catch (err) {
        console.error(`[pi-fuse] Fusion error:`, (err as Error)?.message ?? err);
        output.stopReason = "error";
        output.errorMessage = (err as Error).message;
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
      }
    })();

    return stream;
  }

  // ── Build model list from presets ─────────────────────────────────────
  // contextWindow is the minimum of all panel + judge models, since
  // each panel model's input gets truncated to its own limit.
  function getCtx(ref: string): number {
    const [prov, ...rest] = ref.split(":");
    const modelId = rest.join(":");
    const mod = (modelsCache.providers?.[prov] as any)?.models?.find((m: any) => m.id === modelId);
    return mod?.contextWindow ?? 128000;
  }
  const models = PRESET_NAMES.map((name) => {
    const p = fuseConfig.presets[name];
    const ctx = Math.min(...[...p.panel, p.judge].map(getCtx));
    return {
      id: `fuse-${name}`,
      name: `Fuse ${name.charAt(0).toUpperCase() + name.slice(1)}`,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: ctx,
      maxTokens: 4096,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    };
  });

  const FUSE_API = "fuse" as Api;

  // ── Register the provider ─────────────────────────────────────────────
  pi.registerProvider("fuse", {
    name: "Fuse Fusion",
    baseUrl: "http://localhost:8160",
    apiKey: "__fuse_provider__",
    api: FUSE_API,
    models,

    streamSimple: (model: Model<typeof FUSE_API>, context: Context, options?: SimpleStreamOptions) => {
      if (!model.id.startsWith("fuse-") || !fuseConfig.presets[model.id.slice(5)]) {
        return createErrorStream(`fuse: "${model.id}" is not a registered fuse preset`);
      }
      return createFuseStream(model.id.replace(/^fuse-/, ""), context, options);
    },
  });

  // ── Show preset config in status bar when fuse model is selected ──
  function shortModelName(ref: string): string {
    const model = ref.slice(ref.indexOf(":") + 1);
    const short = model.split("/").pop() || model;
    return short.replace(/:free$/, "");
  }
  pi.on("model_select", async (event, ctx) => {
    if (event.previousModel?.id.startsWith("fuse-")) {
      ctx.ui.setStatus("fuse", undefined);
    }
    if (!event.model.id.startsWith("fuse-")) return;
    const presetName = event.model.id.replace(/^fuse-/, "");
    const preset = fuseConfig.presets[presetName];
    if (!preset) return;
    const panel = preset.panel.map((r) => shortModelName(r)).join(" · ");
    const judge = shortModelName(preset.judge);
    ctx.ui.setStatus("fuse", `FUSE: ⚖️ ${judge}  👥 ${panel}`);
  });

  console.error(`[pi-fuse] Registered ${models.length} fuse model(s): ${models.map((m) => m.id).join(", ")}`);
}
