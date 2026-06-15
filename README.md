<div align="center">
  <img src="docs/fuse-banner.svg" alt="pi-fuse" width="600">
  <br><br>
  <h1>pi-fuse</h1>
  <p><strong>Multi-model fusion as a native Pi provider.</strong></p>
  <p>
    <a href="#quick-start">Quick Start</a> •
    <a href="#presets">Presets</a> •
    <a href="#how-it-works">How It Works</a> •
    <a href="#custom-presets">Custom Presets</a> •
    <a href="#configuration">Configuration</a> •
    <a href="#why-fuse">Why Fuse</a> •
    <a href="#faq">FAQ</a>
  </p>
  <br>
</div>

Register **fusion presets** as native Pi models. No external server — this extension registers a custom provider directly into Pi's model registry. Fuse models appear alongside Claude and GPT in `/model` and `Ctrl+P`.

Fan out a prompt to multiple models in parallel (Groq, DeepSeek, OpenRouter, NVIDIA), collect their responses, and synthesize the best answer with a judge model. **Better quality than any single model, at lower cost.**

Live thinking blocks show each panel model's progress in real time — no more spinner.

---

## Quick Start

```bash
# Option A: From GitHub
pi install git:github.com/evanokeefe39/pi-fuse

# Option B: From local checkout
pi install /path/to/pi-fuse

# Start a session and pick "Fuse Fast" or "Fuse Deep" from Ctrl+P /model
pi
```

That's it. The extension ships with sensible default presets — no manual config needed.

> **Prerequisites:** The extension reuses your existing Pi credentials from `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`. If you've used Pi with Groq, DeepSeek, or OpenRouter, you're ready to go.

## Presets

| Preset | Panel | Judge | Typical Time |
|--------|-------|-------|-------------|
| `fuse-fast` | DeepSeek V4 Flash + Groq 8B | DeepSeek V4 Flash | ~1–2s |
| `fuse-deep` | DeepSeek Reasoner + DeepSeek V4 Flash + Groq 70B | DeepSeek Reasoner | ~3–8s |

Only two presets, both using reliable providers. No flaky free tiers.

## How It Works

```
You ──► Pi Ctrl+P → "Fuse Deep" ──► fuse-provider (streamSimple)
         │
         │  ┌─ Thinking block (live progress) ─────────────┐
         │  │  ⏳ Fanning out to 3 models...                │
         │  │  ✓ deepseek-v4-flash 1.2s                     │
         │  │  ✓ deepseek-reasoner 2.8s                     │
         │  │  ✓ groq-llama-3.3-70b 3.1s                   │
         │  │  → Synthesizing judge response...             │
         │  └──────────────────────────────────────────────┘
         │
         ├── Panel[0] (DeepSeek V4 Flash) ──┐
         ├── Panel[1] (DeepSeek Reasoner) ──┤──► Judge (DeepSeek Reasoner) ──► Streamed answer
         └── Panel[2] (Groq Llama 70B) ─────┘
```

1. You select any `fuse-*` model via `/model` or `Ctrl+P`
2. Every message is fanned out to the panel of models **in parallel**
3. A **judge model** synthesizes the best answer from all panel responses
4. The judge's response streams back token-by-token — same UX as any other provider

### Key design

- **No external server** — runs entirely inside Pi's process as a `streamSimple` provider. No ports, daemons, or PID files.
- **Native streaming** — the judge's response streams token-by-token through Pi's standard SSE pipeline.
- **Graceful degradation** — if a panel model times out or hits a rate limit, the others still contribute.
- **Live credential refresh** — re-reads `auth.json` and `models.json` on each fusion, so API key changes take effect immediately without `/reload`.

### Architecture

```
pi-fuse/
├── package.json              # Pi package manifest
├── config.default.json       # Bundled preset defaults (works out of the box)
└── extensions/
    └── index.ts              # The provider (~470 lines, fully self-contained)
```

User overrides go to `~/.pi/agent/skills/fuse/config.json` (shared with the [fuse CLI/server skill](https://github.com/evanokeefe39/pi-fuse)).

## Custom Presets

Override or extend the bundled presets by creating `~/.pi/agent/skills/fuse/config.json`:

```json
{
  "default_preset": "research",
  "presets": {
    "research": {
      "panel": [
        "groq:llama-3.3-70b-versatile",
        "cerebras:llama-3.3-70b",
        "openrouter:qwen/qwen3-coder:free"
      ],
      "judge": "groq:llama-3.3-70b-versatile"
    }
  }
}
```

User presets merge with the bundled defaults — your keys override the built-in ones.

## Why Fuse

| Approach | Latency | Quality | Cost | Complexity |
|----------|---------|---------|------|-----------|
| Single model (Claude Sonnet) | ~5–10s | Good | $3/M tokens | Zero |
| Single model (DeepSeek Chat) | ~3–8s | Decent | $0.14/M | Zero |
| **Fuse (spread)** | **~2–4s** | **Excellent** | **<$0.01/fusion** | **Zero (with this extension)** |

Fusion consistently beats any single model on:
- **Accuracy** — cross-verification catches hallucinations
- **Coverage** — different models have different blind spots
- **Reasoning** — the judge picks the best reasoning chain
- **Cost** — using free-tier models costs nothing

*Inspired by [OpenRouter's Fusion](https://openrouter.ai/fusion). [Benchmark results](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) show a panel of budget models outscored GPT-5.5 and Claude Opus 4.8 on 100 complex research tasks.*

## Use Cases

| Use fuse | Use a single model |
|----------|-------------------|
| Research & analysis | Quick code edits |
| Fact-checking | Simple refactors |
| Design decisions | File operations |
| Debugging complex bugs | Routine bash commands |
| Brainstorming | Small changes |

## FAQ

**Does this need a config file?** No. The extension ships with built-in presets. You only need a config if you want custom presets.

**Can I use fuse models with `--print` mode?** Yes: `pi --model fuse/fuse-spread -p "What is the capital of France?"`

**What if a provider is down?** That panel model fails silently. As long as at least one panel model responds, the fusion continues. If all fail, you get an error.

**How do I add a new provider (e.g., Cerebras)?** Add it to `~/.pi/agent/models.json` and set the API key in `~/.pi/agent/auth.json`. Then reference it in your custom config as `cerebras:model-name`.

**Does fuse work with Pi's tools?** Fuse models are text-only — panel models don't receive tool definitions. Best for research, analysis, and open-ended questions. For tool-heavy tasks, switch back to a standard model.

**What's the difference from the fuse CLI/server?** The existing [fuse CLI](https://github.com/evanokeefe39/pi-fuse) (`bun run ~/.pi/agent/skills/fuse/fuse.ts`) and standalone server remain functional. This package adds a Pi-native entry point — the same fusion engine, accessible from `/model` and `Ctrl+P`.

## License

MIT
