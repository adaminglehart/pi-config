# Honcho — Personal Memory for Pi

Honcho is a self-hosted memory service that gives Pi persistent, cross-session memory. The agent remembers your preferences, project context, and past decisions across all sessions.

## What is Honcho?

[Honcho](https://github.com/plastic-labs/honcho) is an open-source memory layer for AI agents. It uses PostgreSQL with vector embeddings (pgvector) to store conversation history and build a reasoning-based representation of the user. A background worker ("deriver") continuously processes conversations to extract insights and update the user's memory profile.

## Why Use It?

- **Cross-session memory** — Pi remembers your coding style, preferences, and past decisions
- **Cross-project learning** — Insights from one project inform work in others
- **Self-hosted** — Your data stays local, fully under your control

## Architecture

- **PostgreSQL** — Stores conversation history and vector embeddings
- **Honcho API** — Exposes REST API for reading/writing memory
- **Deriver Worker** — Background process that reasons about conversations and updates memory

## Prerequisites

- Docker and Docker Compose
- API keys for your chosen providers (see configuration below)

## Setup

1. **Ensure required API keys are in your environment:**
   
   For **home** environment (OpenRouter + Fireworks):
   ```bash
   export OPENROUTER_API_KEY="sk-or-v1-..."
   export FIREWORKS_API_KEY="fw-..."
   # Optional fallbacks:
   export ANTHROPIC_API_KEY="sk-ant-..."
   export OPENAI_API_KEY="sk-..."
   export GEMINI_API_KEY="..."
   ```
   
   For **work** environment (LiteLLM proxy):
   ```bash
   # No keys needed - uses internal LiteLLM proxy
   ```

2. **Generate the environment file:**
   ```bash
   just honcho-env
   ```
   This creates `honcho/.env` configured for your current environment (work or home).
   
   To verify which environment will be used:
   ```bash
   chezmoi data | grep environment
   ```

3. **Start the services:**
   ```bash
   cd honcho
   docker compose up -d
   ```

4. **Initialize the database (first time only):**
   ```bash
   docker compose exec api python -m scripts.provision_db
   ```
   This creates all necessary database tables and indexes.

5. **Verify it's running:**
   ```bash
   curl http://localhost:8100/docs
   ```
   You should see the Honcho API documentation (FastAPI Swagger UI).

## LLM Configuration

The `.env` file is automatically generated from templates based on your environment (work/home). The configuration is managed in `.chezmoitemplates/honcho/`.

### Work Environment (LiteLLM Proxy)

Uses an internal LiteLLM proxy with these models:
- **minimal/low:** `gemini-3-flash`
- **medium:** `claude-4.5-haiku`
- **high/max:** `claude-sonnet-4-6`

Configuration (set these env vars before running `just honcho-env`):
```bash
export LITELLM_BASE_URL="https://your-litellm-proxy.example.com/v1"
export LITELLM_API_KEY="your-api-key"
```

### Home Environment (OpenRouter + Fireworks)

Uses OpenRouter as the primary provider for Gemini models and Fireworks for the Kimi router.

**Required environment variables:**
- `OPENROUTER_API_KEY` — Primary API key for OpenRouter
- `FIREWORKS_API_KEY` — Secondary key for Fireworks-hosted models

**Model tier configuration:**
- **summary / minimal / low:** `google/gemini-3.1-flash-lite-preview` (OpenRouter)
- **medium:** `google/gemini-3-flash-preview` (OpenRouter)
- **high/max / deriver:** `accounts/fireworks/routers/kimi-k2p5-turbo` (Fireworks)

These model IDs were verified against the live OpenRouter and Fireworks APIs. The older IDs `google/gemini-3-flash-lite-preview`, `google/gemini-3-flash`, and `accounts/fireworks/models/kimi-2.5-turbo` return provider errors and break Honcho chat/derivation.

**Why OpenRouter + Fireworks?**
- **Cost efficiency** — OpenRouter routes Gemini requests through one integration
- **Single API key** — Access Gemini models without wiring separate Google credentials
- **Fireworks speed** — The Kimi router is fast and works for higher-effort derivation

### Customizing Configuration

To modify environment-specific settings, edit the template files:
- `.chezmoitemplates/honcho/env.base` — Shared configuration
- `.chezmoitemplates/honcho/env.work` — Work-specific settings
- `.chezmoitemplates/honcho/env.home` — Home-specific settings

After editing, regenerate `.env`:
```bash
just honcho-env
```

## Port Choices

- **5433** (PostgreSQL) — Avoids conflicts with default postgres on 5432
- **8100** (Honcho API) — Avoids conflicts with common dev servers (3000, 8000, 8080)

## Common Commands

| Command | Purpose |
|---------|---------|
| `docker compose up -d` | Start all services in background |
| `docker compose down` | Stop all services |
| `docker compose logs -f` | View logs (follow mode) |
| `docker compose logs api` | View API server logs only |
| `docker compose logs deriver` | View deriver worker logs only |
| `docker compose restart api` | Restart API server |
| `docker compose ps` | Show running services |

## Troubleshooting

### API not responding

Check if the database is healthy:
```bash
docker compose ps
```

If the database is restarting, check logs:
```bash
docker compose logs database
```

### Deriver not processing

Check deriver logs for errors:
```bash
docker compose logs deriver
```

Ensure your LLM provider is configured correctly in `.env` — the deriver needs working LLM access to reason about conversations.

**Common issue:** If you see "401 Unauthorized" errors, check that your API keys are properly set in the template files and that you've regenerated `.env` with `just honcho-env`.

### Fresh start

To completely wipe the database and start over:
```bash
docker compose down -v  # WARNING: Deletes all data
docker compose up -d
```

## Pi Integration

Once Honcho is running, the Pi extension (`agent/extensions/honcho/`) automatically connects and enables memory. Check Pi's footer for connection status:
- `🧠 Honcho: connected` — Memory is active
- `🧠 Honcho: disconnected` — Extension couldn't reach the API

Use `/honcho:status` in Pi to see connection details, workspace, and session info.
