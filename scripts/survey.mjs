#!/usr/bin/env node

/**
 * pi-fuse Model Survey
 *
 * Tests every provider/model combo from ~/.pi/agent/models.json
 * plus any models referenced in fuse presets. Outputs a markdown
 * survey table to stdout (or to skills/fuse/references/provider-survey.md
 * if --write is passed).
 *
 * Usage:
 *   node scripts/survey.mjs              # print to stdout
 *   node scripts/survey.mjs --write      # update the reference doc
 *   node scripts/survey.mjs --presets    # only test models used in presets
 *   node scripts/survey.mjs --timeout 15 # 15s per model (default: 20)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Config paths ──────────────────────────────────────────────────────────
const HOME = homedir();
const AUTH_PATH = join(HOME, ".pi/agent/auth.json");
const MODELS_PATH = join(HOME, ".pi/agent/models.json");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const CONFIG_PATH = join(PACKAGE_ROOT, "config.default.json");
const OUTPUT_PATH = join(PACKAGE_ROOT, "skills/fuse/references/provider-survey.md");
const USER_CONFIG_PATH = join(HOME, ".pi/agent/skills/fuse/config.json");

// ── CLI flags ─────────────────────────────────────────────────────────────
const WRITE = process.argv.includes("--write");
const PRESETS_ONLY = process.argv.includes("--presets");
const TIMEOUT_SEC = parseInt(
  process.argv.find((a) => a.startsWith("--timeout"))?.split("=")[1] ?? "20",
  10
);

// ── Load configs ──────────────────────────────────────────────────────────
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`  ⚠ Cannot read ${path}: ${err.message}`);
    return null;
  }
}

const auth = readJson(AUTH_PATH) ?? {};
const modelsFile = readJson(MODELS_PATH) ?? { providers: {} };
const providers = modelsFile.providers ?? {};

// ── Gather models to test ─────────────────────────────────────────────────
let modelEntries = []; // { provider, modelId, baseUrl, apiKey }

for (const [provider, def] of Object.entries(providers)) {
  if (!def || typeof def !== "object") continue;
  const baseUrl = def.baseUrl;
  const apiKey =
    auth[provider]?.key ||
    auth[def.apiKey] ||
    process.env[def.apiKey?.replace(/^\$/, "")] ||
    def.apiKey;
  if (!apiKey) {
    console.error(`  ⚠ No API key for ${provider} — skipping`);
    continue;
  }
  const modelList = def.models ?? [];
  if (modelList.length === 0) {
    console.error(`  ⚠ No models listed for ${provider} — skipping`);
    continue;
  }
  for (const m of modelList) {
    modelEntries.push({ provider, modelId: m.id, baseUrl, apiKey });
  }
}

// Also add models referenced in presets that aren't already covered
const presetModels = new Set();
for (const configPath of [CONFIG_PATH, USER_CONFIG_PATH]) {
  if (!existsSync(configPath)) continue;
  const cfg = readJson(configPath);
  if (!cfg?.presets) continue;
  for (const preset of Object.values(cfg.presets)) {
    for (const ref of preset.panel ?? []) presetModels.add(ref);
    if (preset.judge) presetModels.add(preset.judge);
  }
}

for (const ref of presetModels) {
  const [provider, ...rest] = ref.split(":");
  const modelId = rest.join(":");
  if (!modelId) continue;
  const def = providers[provider];
  if (!def) continue;
  const alreadyQueued = modelEntries.some(
    (e) => e.provider === provider && e.modelId === modelId
  );
  if (alreadyQueued) continue;
  const apiKey =
    auth[provider]?.key ||
    auth[def.apiKey] ||
    process.env[def.apiKey?.replace(/^\$/, "")] ||
    def.apiKey;
  if (!apiKey) continue;
  modelEntries.push({ provider, modelId, baseUrl: def.baseUrl, apiKey });
}

if (PRESETS_ONLY) {
  // Filter to only models referenced in presets
  const presetRefs = new Set(presetModels);
  modelEntries = modelEntries.filter((e) =>
    presetRefs.has(`${e.provider}:${e.modelId}`)
  );
}

// ── Test helpers ──────────────────────────────────────────────────────────
function jitterMs(min = 0, max = 300) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function testModel(entry, index, total) {
  const label = `[${index + 1}/${total}] ${entry.provider}:${entry.modelId}`;
  const t0 = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_SEC * 1000);

  try {
    // Small delay between providers to avoid rate limits
    if (index > 0) await new Promise((r) => setTimeout(r, jitterMs(100, 500)));

    const res = await fetch(`${entry.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${entry.apiKey}`,
      },
      body: JSON.stringify({
        model: entry.modelId,
        messages: [
          { role: "user", content: "Reply with exactly one word: hello" },
        ],
        temperature: 0.1,
        max_tokens: 20,
        stream: false,
      }),
      signal: controller.signal,
    });

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    if (res.ok) {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content ?? "(no content)";
      process.stdout.write(`\r${label} ✅ ${elapsed}s\n`);
      return {
        provider: entry.provider,
        model: entry.modelId,
        status: "✅",
        httpStatus: res.status,
        latency: `${elapsed}s`,
        note: content.slice(0, 60),
      };
    }

    // Try to get error detail
    let detail = "";
    try {
      const errBody = await res.text();
      detail = errBody.slice(0, 100).replace(/\n/g, " ");
    } catch {}
    const symbol = res.status === 429 ? "⏳" : "❌";
    process.stdout.write(`\r${label} ${symbol} ${res.status} ${elapsed}s\n`);
    if (detail) process.stdout.write(`     ${detail}\n`);
    return {
      provider: entry.provider,
      model: entry.modelId,
      status: symbol,
      httpStatus: res.status,
      latency: `${elapsed}s`,
      note: detail || (res.status === 429 ? "Rate limited" : `HTTP ${res.status}`),
    };
  } catch (err) {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const msg = err.name === "AbortError" ? "Timeout" : err.message.slice(0, 80);
    process.stdout.write(`\r${label} ❌ ${elapsed}s — ${msg}\n`);
    return {
      provider: entry.provider,
      model: entry.modelId,
      status: "❌",
      httpStatus: 0,
      latency: `${elapsed}s`,
      note: msg,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Run tests ─────────────────────────────────────────────────────────────
function groupBy(arr, keyFn) {
  const groups = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

async function main() {
  if (modelEntries.length === 0) {
    console.error("No models to test. Check auth.json and models.json.");
    process.exit(1);
  }

  console.error(`\n🧪 Testing ${modelEntries.length} models across ${Object.keys(providers).length} providers`);
  console.error(`   Timeout: ${TIMEOUT_SEC}s per model\n`);

  const results = [];
  for (let i = 0; i < modelEntries.length; i++) {
    const r = await testModel(modelEntries[i], i, modelEntries.length);
    results.push(r);
  }

  console.error("\n✅ Survey complete\n");

  // ── Generate markdown ─────────────────────────────────────────────────
  const byProvider = groupBy(results, (r) => r.provider);
  const providerOrder = Object.keys(providers);

  let md = `# Provider & Model Survey

**Date:** ${new Date().toISOString().slice(0, 10)}
**Method:** Direct API calls to each provider's \`/v1/chat/completions\` endpoint
**Auth keys from:** \`~/.pi/agent/auth.json\`
**Test prompt:** "Reply with exactly one word: hello"
**Timeout:** ${TIMEOUT_SEC}s per model

---

## Summary

`;
  // Summary table
  const allOk = results.filter((r) => r.status === "✅");
  const allRate = results.filter((r) => r.status === "⏳");
  const allFail = results.filter((r) => r.status === "❌");
  md += `| Result | Count |
|--------|-------|
| ✅ Working | ${allOk.length} |
| ⏳ Rate-limited | ${allRate.length} |
| ❌ Failed | ${allFail.length} |
| **Total** | **${results.length}** |

`;

  for (const provider of providerOrder) {
    const group = byProvider[provider];
    if (!group || group.length === 0) continue;

    const working = group.filter((r) => r.status === "✅");
    const failing = group.filter((r) => r.status === "❌");
    const ratelimited = group.filter((r) => r.status === "⏳");
    const summary = working.length === group.length
      ? "All working"
      : `${working.length}/${group.length} working`;

    md += `\n### ${provider} — ${summary}\n\n`;
    md += `| Model | Status | HTTP | Latency | Notes |
|-------|--------|------|---------|-------|\n`;

    for (const r of group) {
      md += `| \`${r.model}\` | ${r.status} | ${r.httpStatus} | ${r.latency} | ${r.note} |\n`;
    }
  }

  // ── Output ──────────────────────────────────────────────────────────────
  if (WRITE) {
    writeFileSync(OUTPUT_PATH, md, "utf-8");
    console.error(`📝 Survey written to ${OUTPUT_PATH}`);
  } else {
    console.log("\n" + md);
  }
}

main().catch((err) => {
  console.error("Survey failed:", err);
  process.exit(1);
});
