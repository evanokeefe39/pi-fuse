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
 * Fans out to multiple models (Groq, Cerebras, DeepSeek, OpenRouter) in
 * parallel, collects their responses, and synthesizes the best answer via
 * a judge model. All inside Pi's process — no external server needed.
 *
 * Presets are defined in a bundled config.default.json. Users can override
 * presets by creating ~/.pi/agent/skills/fuse/config.json (shared with the
 * fuse CLI/server skill). Pi credentials from ~/.pi/agent/auth.json and
 * ~/.pi/agent/models.json are used for provider access.
 *
 * Install: pi install git:github.com/evanokeefe39/pi-fuse
 *     Or:  pi install /path/to/pi-fuse
 */

import { readFileSync, existsSync } from "node:fs";
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
// import.meta.url works because Pi loads extensions via jiti/ts
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const BUNDLED_CONFIG = join(PACKAGE_ROOT, "config.default.json");

// ── User override path (shared with fuse CLI/server skill) ────────────────
const HOME = homedir();
const USER_CONFIG = join(HOME, ".pi/agent/skills/fuse/config.json");
const AUTH_PATH = join(HOME, ".pi/agent/auth.json");
const MODELS_PATH = join(HOME, ".pi/agent/models.json");

// ── Types ──────────────────────────────────────────────────────────────────

interface FuseConfig {
  default_preset: string;
  presets: Record<string, { panel: string[]; judge: string }>;
}

interface ProviderDef {
  baseUrl: string;
  apiKey: string;
}

interface ResolvedEndpoint {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
}

interface AuthEntry {
  key: string;
  type?: string;
}

interface ModelsFile {
  providers: Record<string, {
    baseUrl: string;
    apiKey: string;
    api?: string;
    models?: { id: string; name: string }[];
  }>;
}

// ── File helpers ──────────────────────────────────────────────────────────

function tryLoad<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

// ── Validated loaders for auth and models ────────────────────────────────

function loadAuth(): Record<string, AuthEntry> {
  try {
    const raw = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") {
      console.error("[pi-fuse] auth.json: not a valid JSON object");
      return {};
    }
    for (const [provider, val] of Object.entries(raw)) {
      if (!val || typeof val !== "object") {
        console.error(`[pi-fuse] auth.json: "${provider}" is not an object — skipping`);
        continue;
      }
      const entry = val as Record<string, unknown>;
      if (typeof entry.key !== "string" || !entry.key) {
        console.error(`[pi-fuse] auth.json: "${provider}" missing or empty "key" field — skipping`);
        continue;
      }
    }
    return raw as Record<string, AuthEntry>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error("[pi-fuse] auth.json: invalid JSON — returning empty config");
    } else {
      console.error("[pi-fuse] auth.json: unexpected error:", (err as Error)?.message ?? err);
    }
    return {};
  }
}

function loadModels(): ModelsFile {
  try {
    const raw = JSON.parse(readFileSync(MODELS_PATH, "utf-8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") {
      console.error("[pi-fuse] models.json: not a valid JSON object");
      return { providers: {} };
    }
    const providers = (raw as any).providers;
    if (!providers || typeof providers !== "object") {
      console.error("[pi-fuse] models.json: missing or invalid 'providers' key");
      return { providers: {} };
    }
    for (const [name, def] of Object.entries(providers)) {
      if (!def || typeof def !== "object") {
        console.error(`[pi-fuse] models.json: provider "${name}" is not an object — skipping`);
        continue;
      }
      const d = def as Record<string, unknown>;
      if (typeof d.baseUrl !== "string" || !d.baseUrl) {
        console.error(`[pi-fuse] models.json: provider "${name}" missing or invalid 'baseUrl' — skipping`);
        continue;
      }
      if (typeof d.apiKey !== "string" || !d.apiKey) {
        console.error(`[pi-fuse] models.json: provider "${name}" missing or invalid 'apiKey' — skipping`);
        continue;
      }
    }
    return raw as unknown as ModelsFile;
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error("[pi-fuse] models.json: invalid JSON — returning empty config");
    } else {
      console.error("[pi-fuse] models.json: unexpected error:", (err as Error)?.message ?? err);
    }
    return { providers: {} };
  }
}

// ── Preset validation ─────────────────────────────────────────────────────

function validatePresets(config: FuseConfig): FuseConfig {
  for (const [name, preset] of Object.entries(config.presets)) {
    if (!Array.isArray(preset.panel) || preset.panel.length === 0) {
      console.error(`[pi-fuse] Preset "${name}" has invalid or empty 'panel' — removing`);
      delete config.presets[name];
      continue;
    }
    if (typeof preset.judge !== "string" || !preset.judge) {
      console.error(`[pi-fuse] Preset "${name}" has invalid or empty 'judge' — removing`);
      delete config.presets[name];
      continue;
    }
    for (const [i, ref] of preset.panel.entries()) {
      if (typeof ref !== "string" || !ref.includes(":")) {
        console.error(`[pi-fuse] Preset "${name}" panel[${i}]: "${ref}" missing 'provider:model' format — removing preset`);
        delete config.presets[name];
        break;
      }
    }
  }
  return config;
}

// ── Config loader with layered fallback ──────────────────────────────────

function loadConfig(): FuseConfig {
  // 1. Try bundled defaults first (always present inside the package)
  const bundled = tryLoad<FuseConfig>(BUNDLED_CONFIG);
  if (!bundled) {
    console.error("[pi-fuse] Missing bundled config.default.json — package may be corrupted");
    return { default_preset: "spread", presets: {} };
  }

  // 2. Check for user override
  if (existsSync(USER_CONFIG)) {
    const user = tryLoad<FuseConfig>(USER_CONFIG);
    if (user) {
      // Merge: user presets override bundled ones, default_preset from user wins
      return validatePresets({
        default_preset: user.default_preset || bundled.default_preset,
        presets: { ...bundled.presets, ...user.presets },
      });
    }
    console.error("[pi-fuse] User config at", USER_CONFIG, "is invalid JSON — falling back to defaults");
  }

  return validatePresets(bundled);
}

// ── Jitter helper ──────────────────────────────────────────────────────────

function jitterMs(min = 0, max = 500) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Token estimation / context truncation ─────────────────────────────────
// Rough: ~3.5 chars per token. Over-estimates for code, fine for truncation.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function truncateMessages(
  msgs: { role: string; content: string }[],
  maxTokens: number
): { messages: { role: string; content: string }[]; truncated: { droppedHistory: number; trimmedMessage: boolean } } {
  const result: { droppedHistory: number; trimmedMessage: boolean } = {
    droppedHistory: 0,
    trimmedMessage: false,
  };

  // Panel models only need the question — no system prompt (it's just skill
  // instructions for the main agent, irrelevant to panel models). Keep as
  // many recent messages as fit in the context window.
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  if (!lastUser) return { messages: msgs.slice(-1), truncated: result };

  let tokenBudget = maxTokens - 512; // reserve for JSON overhead + output headroom
  if (tokenBudget <= 0) tokenBudget = 256;

  // Walk backwards from the end, collect messages newest-first
  const reversed = [...msgs].reverse();
  const collected: { role: string; content: string }[] = [];
  let origCount = 0;
  for (const m of reversed) {
    if (m.role === "system") continue;
    origCount++;
    const t = estimateTokens(m.content);
    if (t <= tokenBudget) {
      collected.push(m);
      tokenBudget -= t;
    } else if (m === lastUser || collected.length === 0) {
      // Always include the user message — trim it as last resort
      const trimmed = m.content.slice(0, Math.max(50, Math.floor(tokenBudget * 3.5)));
      collected.push({ ...m, content: trimmed });
      result.trimmedMessage = true;
      break;
    }

  }

  result.droppedHistory = origCount - collected.length;
  // Reverse back to chronological order
  return { messages: collected.reverse(), truncated: result };
}

// ── Circuit breaker ─────────────────────────────────────────────────────────
// Per-provider failure tracking: after N consecutive failures, skip the
// provider for M seconds. Resets on success.

interface CircuitState {
  failures: number;
  openedAt: number; // 0 = circuit closed
}

const CIRCUIT_THRESHOLD = 3;       // Consecutive failures before opening
const CIRCUIT_COOLDOWN_MS = 30_000; // Milliseconds before retrying an open circuit

// Module-level state persists across all fusion calls
const circuitBreakers = new Map<string, CircuitState>();

function recordSuccess(provider: string): void {
  const state = circuitBreakers.get(provider);
  if (state) {
    state.failures = 0;
    state.openedAt = 0;
  }
}

function recordFailure(provider: string): void {
  let state = circuitBreakers.get(provider);
  if (!state) {
    state = { failures: 0, openedAt: 0 };
    circuitBreakers.set(provider, state);
  }
  state.failures++;
  if (state.failures >= CIRCUIT_THRESHOLD) {
    state.openedAt = Date.now();
    console.error(`[pi-fuse] Circuit opened for "${provider}" — ${state.failures} consecutive failures`);
  }
}

function isCircuitOpen(provider: string): boolean {
  const state = circuitBreakers.get(provider);
  if (!state || state.openedAt === 0) return false;
  if (Date.now() - state.openedAt > CIRCUIT_COOLDOWN_MS) {
    // Cooldown expired — close circuit (half-open), allow one request
    state.failures = 0;
    state.openedAt = 0;
    console.error(`[pi-fuse] Circuit closing for "${provider}" — cooldown expired`);
    return false;
  }
  return true;
}

// ── Extension entry point ──────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Load config (bundled defaults + optional user override)
  const fuseConfig = loadConfig();
  const PRESET_NAMES = Object.keys(fuseConfig.presets);

  if (PRESET_NAMES.length === 0) {
    console.error("[pi-fuse] No presets defined — skipping provider registration");
    return;
  }

  // Dynamic: re-read auth/models at request time so credential changes
  // are picked up without /reload. The cache is a simple module-level
  // ref that gets refreshed per fusion.
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
      throw new Error(
        `Unknown provider "${provider}". Valid: ${Object.keys(modelsCache.providers || {}).join(", ")}`
      );
    const apiKey =
      authCache[provider]?.key ||
      authCache[provDef.apiKey] ||
      process.env[provDef.apiKey.replace(/^\$/, "")] ||
      provDef.apiKey;
    if (!apiKey)
      throw new Error(`No API key for "${provider}". Add to auth.json as {"${provider}":{"key":"sk-..."}} or set ${provDef.apiKey.replace(/^\$/, "")} env var.`);
    // Look up the model's contextWindow from provider model list
    const modDef = (provDef as any).models?.find((m: any) => m.id === model);
    const contextWindow = modDef?.contextWindow ?? undefined;
    return { provider, model, baseUrl: provDef.baseUrl, apiKey, contextWindow };
  }

  // ── Refresh auth/models from disk ─────────────────────────────────────
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
    attempt = 1,
    onRetry?: (attempt: number) => void
  ): Promise<{ content: string; usage?: { input: number; output: number } }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${entry.apiKey}`,
    };

    const controller = new AbortController();
    const mergedSignal = signal ?? controller.signal;
    const timeout = setTimeout(() => controller.abort(), 45000);

    try {
      const res = await fetch(`${entry.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
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
        onRetry?.(attempt + 1);
        const backoff = Math.min(1000 * 2 ** attempt + jitterMs(0, 500), 5000);
        await new Promise((r) => setTimeout(r, backoff));
        return callPanelModel(entry, messages, signal, attempt + 1, onRetry);
      }

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`${entry.provider}:${entry.model} (${res.status}) ${err.slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      recordSuccess(entry.provider);
      return {
        content: data.choices?.[0]?.message?.content ?? "[no output]",
        usage: data.usage
          ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
          : undefined,
      };
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${entry.apiKey}`,
    };

    const res = await fetch(`${entry.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
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
            if (block.type === "text") {
              block.text += delta;
            }
            stream.push({ type: "text_delta", contentIndex: 1, delta, partial: output });
          }
        } catch {
          // Malformed SSE line — skip. Log truncated line for debugging.
          if (trimmed.length < 200) {
            console.debug("[pi-fuse] SSE parse skip:", trimmed.slice(0, 100));
          }
        }
      }
    }

    output.usage.input = judgeInputTokens;
    output.usage.output = judgeOutputTokens;
    output.usage.totalTokens = judgeInputTokens + judgeOutputTokens;
    // Manually zero cost — panel/judge providers are free-tier or negligible.
    // calculateCost() would need a Model object, not an AssistantMessage.
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
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
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
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      try {
        // Refresh auth/models each fusion so cred changes take effect
        refreshConfigs();

        const preset = fuseConfig.presets[presetName];
        if (!preset) throw new Error(`Unknown fuse preset "${presetName}"`);

        const panelEntries = preset.panel.map(resolveModel);
        const judgeEntry = resolveModel(preset.judge);
        // Circuit breaker: fail fast if judge provider circuit is open
        if (isCircuitOpen(judgeEntry.provider)) {
          throw new Error(
            `Judge circuit open for "${judgeEntry.provider}" — ${CIRCUIT_THRESHOLD} consecutive failures, cooling down for ${CIRCUIT_COOLDOWN_MS / 1000}s`
          );
        }

        // ── Thinking block for live progress ────────────────────────
        const presetLabel = presetName.charAt(0).toUpperCase() + presetName.slice(1);
        const thinkingHeader = `Fuse ${presetLabel} — ${panelEntries.length} panel + judge\n\n`;
        output.content.push({
          type: "thinking",
          thinking: thinkingHeader,
        } as ThinkingContent);
        stream.push({ type: "start", partial: output });
        stream.push({ type: "thinking_start", contentIndex: 0, partial: output });

        function thinkPush(text: string) {
          const block = output.content[0];
          if (block.type === "thinking") {
            block.thinking += text;
          }
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

          const role = (msg as { role: string }).role as string;
          const content = (msg as { content: unknown }).content;

          if (role === "tool" || role === "tool_result") continue;

          if (role === "assistant") {
            if (typeof content === "string") {
              contextMessages.push({ role: "assistant", content });
            }
            continue;
          }

          let text = "";
          if (typeof content === "string") {
            text = content;
          } else if (Array.isArray(content)) {
            text = content
              .map((part: { type?: string; text?: string }) =>
                part.type === "text" ? (part.text ?? "") : ""
              )
              .filter(Boolean)
              .join("\n");
          }

          if (text) {
            contextMessages.push({ role, content: text });
          }
        }

        if (contextMessages.length === 0) {
          contextMessages.push({ role: "user", content: "..." });
        }

        // ── Fan-out to panel models with live status ────────────────
        const panelResults = await Promise.all(
          panelEntries.map(async (entry, idx) => {
            if (idx > 0) await new Promise((r) => setTimeout(r, jitterMs(50, 300)));
            const shortName = entry.model.split("/").pop()!;
            // Circuit breaker: skip if provider has too many consecutive failures
            if (isCircuitOpen(entry.provider)) {
              thinkPush(`  ⊘ ${entry.provider}:${shortName} — circuit open (${CIRCUIT_THRESHOLD}+ failures)\n`);
              return {
                label: `${entry.provider}:${entry.model}`,
                content: null,
                error: `Circuit open for ${entry.provider} — skipping after ${CIRCUIT_THRESHOLD} consecutive failures`,
              };
            }
            const t0 = performance.now();
            try {
              // Truncate context to fit this model's limits
              const ctxWindow = entry.contextWindow ?? 128000;
              const maxInput = ctxWindow - 4096;
              const { messages: panelMsgs, truncated } = truncateMessages(contextMessages, maxInput);
              if (truncated.droppedHistory > 0 || truncated.trimmedMessage) {
                thinkPush(`  ⚠ ${entry.provider}:${shortName} — context trimmed (${truncated.droppedHistory} msgs dropped${truncated.trimmedMessage ? ', msg truncated' : ''})\n`);
              }
              const result = await callPanelModel(
                entry,
                panelMsgs,
                signal,
                1,
                (attempt) => {
                  thinkPush(`  ⟳ ${entry.provider}:${shortName} — Retrying… (${attempt}/3)\n`);
                }
              );
              const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
              thinkPush(`  ✓ ${entry.provider}:${shortName} ${elapsed}s\n`);
              return { label: `${entry.provider}:${entry.model}`, content: result.content };
            } catch (err) {
              recordFailure(entry.provider);
              const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
              const errMsg = (err as Error).message.slice(0, 80);
              thinkPush(`  ✗ ${entry.provider}:${shortName} ${elapsed}s — ${errMsg}\n`);
              return {
                label: `${entry.provider}:${entry.model}`,
                content: null,
                error: (err as Error).message,
              };
            }
          })
        );

        const succeeded = panelResults.filter((r) => r.content !== null);
        if (succeeded.length === 0) throw new Error("All panel models failed");

        const panelInputTokens = succeeded.reduce((sum) => sum + 100, 0);
        const panelOutputTokens = succeeded.reduce(
          (sum, r) => sum + (r.content?.split(" ").length ?? 0) * 1.3,
          0
        );
        output.usage.input += panelInputTokens;
        output.usage.output += panelOutputTokens;

        // ── Build judge prompt ────────────────────────────────────────
        const originalQ = contextMessages.findLast((m) => m.role === "user")?.content ?? "";
        const sections = succeeded.map(
          (r, i) => `--- Model ${i + 1} (${r.label}) ---\n\n${r.content}`
        );

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

        stream.push({
          type: "done",
          reason: output.stopReason as "stop" | "length" | "toolUse",
          message: output,
        });
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
  const models = PRESET_NAMES.map((name) => ({
    id: `fuse-${name}`,
    name: `Fuse ${name.charAt(0).toUpperCase() + name.slice(1)}`,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  }));

  const FUSE_API = "fuse" as Api;

  // ── Register the provider ─────────────────────────────────────────────
  pi.registerProvider("fuse", {
    name: "Fuse Fusion",
    baseUrl: "http://localhost:8160",
    apiKey: "__fuse_provider__",
    api: FUSE_API,
    models,

    streamSimple: (model: Model<typeof FUSE_API>, context: Context, options?: SimpleStreamOptions) => {
      // Defensive: only handle fuse-* model IDs. If Pi misroutes a non-fuse
      // model here, return an immediate error stream instead of crashing.
      if (!model.id.startsWith("fuse-") || !fuseConfig.presets[model.id.slice(5)]) {
        return createErrorStream(`fuse: "${model.id}" is not a registered fuse preset`);
      }
      const presetName = model.id.replace(/^fuse-/, "");
      return createFuseStream(presetName, context, options);
    },
  });

  console.error(
    `[pi-fuse] Registered ${models.length} fuse model(s): ${models.map((m) => m.id).join(", ")}`
  );
}
