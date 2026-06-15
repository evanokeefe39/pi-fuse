# Provider & Model Survey

**Date:** 2026-06-15
**Method:** Direct API calls to each provider's `/v1/chat/completions` endpoint
**Auth keys from:** `~/.pi/agent/auth.json`
**Test prompt:** "Reply with exactly one word: hello"
**Timeout:** 20s per model

---

## Summary

| Result | Count |
|--------|-------|
| ✅ Working | 13 |
| ⏳ Rate-limited | 1 |
| ❌ Failed | 6 |
| **Total** | **20** |


### nvidia — All working

| Model | Status | HTTP | Latency | Notes |
|-------|--------|------|---------|-------|
| `meta/llama-4-maverick-17b-128e-instruct` | ✅ | 200 | 0.6s | hello |
| `meta/llama-3.1-70b-instruct` | ✅ | 200 | 5.4s | hello |
| `meta/llama-3.1-8b-instruct` | ✅ | 200 | 0.8s | Hello. |

### deepseek — All working

| Model | Status | HTTP | Latency | Notes |
|-------|--------|------|---------|-------|
| `deepseek-chat` | ✅ | 200 | 0.7s | hello |
| `deepseek-reasoner` | ✅ | 200 | 0.7s |  |
| `deepseek-v4-flash` | ✅ | 200 | 0.8s |  |
| `deepseek-v4-pro` | ✅ | 200 | 0.8s |  |

### cerebras — 0/3 working

| Model | Status | HTTP | Latency | Notes |
|-------|--------|------|---------|-------|
| `llama-3.3-70b` | ❌ | 404 | 2.8s | {"message":"Model llama-3.3-70b does not exist or you do not have access to it.","type":"not_found_e |
| `llama3.1-8b` | ❌ | 404 | 2.5s | {"message":"Model llama3.1-8b does not exist or you do not have access to it.","type":"not_found_err |
| `qwen-3-32b` | ❌ | 404 | 2.4s | {"message":"Model qwen-3-32b does not exist or you do not have access to it.","type":"not_found_erro |

### minimax — All working

| Model | Status | HTTP | Latency | Notes |
|-------|--------|------|---------|-------|
| `MiniMax-M2.7` | ✅ | 200 | 1.9s | <think>The user says: "Reply with exactly one word: hello".  |
| `MiniMax-M2.5` | ✅ | 200 | 0.9s | <think>The user says: "Reply with exactly one word: hello".  |

### openrouter — 0/3 working

| Model | Status | HTTP | Latency | Notes |
|-------|--------|------|---------|-------|
| `qwen/qwen3-coder:free` | ⏳ | 429 | 1.1s | {"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"qwen/qwen3-coder:free is |
| `deepseek/deepseek-r1:free` | ❌ | 404 | 0.6s | {"error":{"message":"This model is unavailable for free. The paid version is available now - use thi |
| `meta-llama/llama-4-maverick:free` | ❌ | 404 | 0.4s | {"error":{"message":"This model is unavailable for free. The paid version is available now - use thi |

### mistral — All working

| Model | Status | HTTP | Latency | Notes |
|-------|--------|------|---------|-------|
| `codestral-latest` | ✅ | 200 | 0.6s | hello |
| `mistral-small-latest` | ✅ | 200 | 0.7s | Hi |

### groq — 2/3 working

| Model | Status | HTTP | Latency | Notes |
|-------|--------|------|---------|-------|
| `llama-3.3-70b-versatile` | ✅ | 200 | 0.7s | hello |
| `llama-3.1-8b-instant` | ✅ | 200 | 0.3s | Hello |
| `gemma2-9b-it` | ❌ | 400 | 0.4s | {"error":{"message":"The model `gemma2-9b-it` has been decommissioned and is no longer supported. Pl |
