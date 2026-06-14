# pi-fuse — Multi-Model Fusion for Pi

## Constraints

- `main` protected — squash merge only, branches auto-delete
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`
- Land changes via `gh pr create` + `gh pr merge --squash`, never direct push
- Branch naming: `feat/`, `fix/`, `refactor/`, `chore/`, `docs/` prefixes

## Quick Start (development)

```bash
# Install from local checkout
pi install /path/to/pi-fuse

# Or install from GitHub
pi install git:github.com/evanokeefe39/pi-fuse
```

## Structure

| Path | Purpose |
|------|---------|
| `extensions/index.ts` | Core provider extension (~470 lines) |
| `config.default.json` | Bundled default presets (works out of the box) |
| `package.json` | Pi package manifest |

User presets override bundled ones via `~/.pi/agent/skills/fuse/config.json`.

## Architecture

The extension registers a custom Pi provider via `pi.registerProvider()` with a `streamSimple` implementation. On every request:
1. Refresh credentials from `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`
2. Fan out to panel models in parallel via `Promise.all()`
3. Collect responses, build a judge prompt
4. Stream judge response token-by-token

No external server, no daemons, no ports.
