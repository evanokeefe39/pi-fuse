---
name: fuse
description: >
  Multi-model Fusion — run multiple LLMs in parallel across different
  providers (Groq, Cerebras, DeepSeek, OpenRouter), then synthesize with
  a judge. Beats any single model at lower cost. Saves your 1000 req/day
  by spreading across free tiers. Use for deep research, analysis,
  fact-checking, or any task where quality > speed.
---

# Fuse — Multi-Provider Model Fusion

Inspired by [OpenRouter's Fusion](https://openrouter.ai/fusion) (June 2026): fan out to models across
**Groq, Cerebras, DeepSeek, OpenRouter, NVIDIA, Mistral** in parallel,
then synthesize with a judge.

[Benchmark results](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) show a panel of budget models
fused through OpenRouter **outscored GPT-5.5 and Claude Opus 4.8** on 100 complex research tasks. Your API keys and provider configs come
from `~/.pi/agent/auth.json` and `~/.pi/agent/models.json` — zero
duplication.

## Usage

Fuse models appear as native Pi models — no server, no CLI, no daemon.

```bash
# Install (one-time)
pi install git:github.com/evanokeefe39/pi-fuse

# Then in any Pi session:
#   Ctrl+P → "Fuse Spread"          (or any fuse-* preset)
#   /model fuse-spread               (same thing via command)
#   pi --model fuse/fuse-spread -p "question"   (print mode)
```

Custom presets go in `~/.pi/agent/skills/fuse/config.json` and are picked up
on next fusion call (no restart needed).

## Presets

Configured in `~/.pi/agent/skills/fuse/config.json`:

| Preset | Panel | Judge | Total Time |
|--------|-------|-------|------------|
| `fast` | Groq 8B + Groq Qwen3 32B | Groq 70B | ~1-2s |
| `spread` | Groq 8B + Cerebras 70B + OR Qwen | Groq 70B | ~2-4s |
| `deep` | Groq 70B + OR 70B + OR 405B | Groq 70B | ~3-6s |
| `quality` | Groq 70B + Cerebras 70B + DeepSeek | Groq 70B | ~3-6s |
| `reason` | DeepSeek R1 + Groq 70B + OR R1 | Groq 70B | ~5-15s |
| `budget` | DeepSeek Chat + cheap OR models | DeepSeek Chat | ~3-5s |

All free-tier presets use providers' free rate limits. Budget uses
paid models (~$0.0001/fusion) when free limits are exhausted.

## Why Multi-Provider

| Provider | Free Tier | Strengths |
|----------|-----------|-----------|
| **Groq** | 30 req/min (70B), 6000/min (8B) | Fastest inference |
| **Cerebras** | Free | Fast 70B |
| **DeepSeek** | Paid ($0.14/M) | High quality, reasoning |
| **OpenRouter** | 50 req/day free | Most model diversity |

Spreading across providers means no single rate limit gets burned
and model diversity improves fusion quality.

## Config

`~/.pi/agent/skills/fuse/config.json`:
```json
{
  "default_preset": "spread",
  "presets": {
    "my-custom": {
      "panel": ["groq:llama-3.3-70b-versatile", "openrouter:qwen/qwen3-coder:free"],
      "judge": "groq:llama-3.3-70b-versatile"
    }
  }
}
```

Model references are `provider:model` where provider matches a
key in `~/.pi/agent/models.json` under `providers`. API keys
come from `~/.pi/agent/auth.json`.

## How It Works

```
Pi Ctrl+P → fuse-spread ──► Panel[0] (Groq) ──┐
                            ├──► Panel[1] (DeepSeek) ──┤──► Judge (Groq) ──► Streamed answer
                            └──► Panel[2] (Gemma) ─────┘
```

Panel calls are parallel. If one provider fails, the others still
respond. The judge handles partial panels gracefully.
