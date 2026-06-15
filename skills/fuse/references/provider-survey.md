# Provider & Model Survey

**Date:** 2026-06-14
**Method:** Direct API calls to each provider's `/v1/chat/completions` endpoint
**Auth keys from:** `~/.pi/agent/auth.json`

## Results

### ✅ Groq — Fast, reliable, generous free tier

| Model | Status | Notes |
|-------|--------|-------|
| `llama-3.3-70b-versatile` | ✅ 200 | Best free judge — fast, high quality |
| `llama-3.1-8b-instant` | ✅ 200 | Blazing fast panel model (< 0.3s) |
| `qwen/qwen3-32b` | ✅ 200 | Good mid-size panel model |
| `gemma2-9b-it` | ❌ 400 | Model no longer available |
| `llama-4-scout-17b-16e-instruct` | ❌ 404 | Model not found |

**Rate limits (free tier):** 30 req/min (70B), 6000 req/min (8B) — very generous.
**Best use:** Judge (70B) and fast panel (8B). Primary workhorse.

---

### ✅ DeepSeek — Cheap paid, reliable

| Model | Status | Notes |
|-------|--------|-------|
| `deepseek-chat` | ✅ 200 | V3 — good all-rounder, ~$0.14/M out |
| `deepseek-reasoner` | ✅ 200 | R1 — strong reasoning, ~$0.55/M out |

**Rate limits:** Generous. Pay-per-token.
**Best use:** Reasoning-heavy panel, budget presets.

---

### ⚠️ OpenRouter — Rate-limited free tier, paid works

**Free models (26 available, 50 req/day limit):**
| Model | Status | Notes |
|-------|--------|-------|
| `google/gemma-4-31b-it:free` | ✅ 200 | Was under limit — good panel model |
| `nvidia/nemotron-3-super-120b-a12b:free` | ✅ 200 | Was under limit — large model |
| `meta-llama/llama-3.3-70b-instruct:free` | ⏳ 429 | Rate-limited but available |
| `nousresearch/hermes-3-llama-3.1-405b:free` | ⏳ 429 | Rate-limited but available |
| `qwen/qwen3-coder:free` | ⏳ 429 | Rate-limited but available |
| `qwen/qwen3-next-80b-a3b-instruct:free` | ⏳ 429 | Rate-limited but available |
| `deepseek/deepseek-r1:free` | ❌ 400 | Changed or discontinued |
| `openai/gpt-oss-120b:free` | ⏳ tested paid variant | Available as :free |
| `openai/gpt-oss-20b:free` | ⏳ tested paid variant | Available as :free |
| `cognitivecomputations/dolphin-mistral-24b-venice-edition:free` | untested | Available |
| `poolside/laguna-xs.2:free` | untested | Available |
| `poolside/laguna-m.1:free` | untested | Available |

**Paid models (hits 1000 req/day budget):**
| Model | Status | Notes |
|-------|--------|-------|
| `openai/gpt-oss-120b` | ✅ 200 | Works, costs tokens |
| `openrouter/deepseek/deepseek-v4-pro` | ✅ 200 | Works |
| `openrouter/deepseek/deepseek-v4-flash` | ✅ 200 | Works |
| `cohere/command-r7b-12-2024` | ✅ 200 | Works, cheap |
| `minimax/minimax-m2.7` | ✅ 200 | Works |
| `mistralai/mistral-small-latest` | ❌ 400 | Wrong slug |
| `nvidia/llama-3.1-nvidia-70b` | ❌ 400 | Wrong slug |

**Best use:** Free models for diversity when under rate limit. Paid models as fallback.
**429 handling:** Models return 429 when free tier exhausted. Retry after 1s or use paid variant.

---

### ❌ Cerebras — Currently broken

| Model | Status |
|-------|--------|
| `llama-3.3-70b` | ❌ 404 — removed |
| `llama3.1-8b` | ❌ 404 — removed |
| `qwen-3-32b` | ❌ 404 — removed |
| `zai-glm-4.7` | Untested — only remaining model |
| `gpt-oss-120b` | Untested — only remaining model |

**Status:** Cerebras appears to have removed most models. Only 2 remain (`zai-glm-4.7`, `gpt-oss-120b`). Remove from `config.json` presets until confirmed working.

---

## Recommended Presets After Survey

### Primary (always works, fast)
```
fast:       panel=[groq:llama-3.1-8b-instant, groq:qwen/qwen3-32b]
            judge=groq:llama-3.3-70b-versatile
            → 100% available, $0, ~1-2s
```

### Quality (all reliable providers)
```
quality:    panel=[groq:llama-3.3-70b-versatile, deepseek:deepseek-chat]
            judge=groq:llama-3.3-70b-versatile
            → Diverse architectures (Meta Llama + DeepSeek), <$0.001/call
```

### Deep (when OR rate limit isn't exhausted)
```
deep:       panel=[groq:llama-3.3-70b-versatile, openrouter:google/gemma-4-31b-it:free]
            judge=groq:llama-3.3-70b-versatile
            → 2 providers, free, stays under rate limits
```

### Budget (paid but cheap)
```
budget:     panel=[deepseek:deepseek-chat, openrouter:cohere/command-r7b-12-2024]
            judge=deepseek:deepseek-chat
            → All paid, no rate limits, ~$0.0003/call
```

## What to Remove

- **Cerebras** — all models 404. Remove from all presets.
- **OpenRouter: `deepseek/deepseek-r1:free`** — 400. Slug changed or discontinued.
- **OpenRouter free models** — keep but as secondary/fallback, since 50 req/day limit is easily hit.
