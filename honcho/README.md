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

## Setup

1. **Generate the environment file:**
   ```bash
   just honcho-env
   ```
   This creates `honcho/.env` configured for your current environment (work or home).
   
   The configuration automatically selects:
   - **Work:** Stripe LiteLLM proxy with Gemini/Claude models
   - **Home:** Direct API keys (requires `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` in your environment)
   
   To verify which environment will be used:
   ```bash
   chezmoi data | grep environment
   ```

2. **Start the services:**
   ```bash
   cd honcho
   docker compose up -d
   ```

3. **Initialize the database (first time only):**
   ```bash
   docker compose exec api python -m scripts.provision_db
   ```
   This creates all necessary database tables and indexes.

4. **Verify it's running:**
   ```bash
   curl http://localhost:8100/docs
   ```
   You should see the Honcho API documentation (FastAPI Swagger UI).

## LLM Configuration

The `.env` file is automatically generated from templates based on your environment (work/home). The configuration is managed in `.chezmoitemplates/honcho/`.

### Work Environment (Stripe)

Uses the LiteLLM proxy with these models:
- **minimal/low:** `gemini-3-flash`
- **medium:** `claude-4.5-haiku`
- **high/max:** `claude-sonnet-4.5`

Configuration:
```env
LLM_OPENAI_COMPATIBLE_BASE_URL=http://litellm.qa.corp.stripe.com.certproxy.localhost:7891/v1
LLM_OPENAI_COMPATIBLE_API_KEY=use_case=development&team=privy-eng-access-team
```

### Home Environment

Uses direct API keys from your environment variables:
```env
LLM_ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
LLM_OPENAI_API_KEY=$OPENAI_API_KEY
LLM_GEMINI_API_KEY=$GEMINI_API_KEY
```

Honcho's default dialectic levels:
- **minimal/low:** `google/gemini-2.5-flash-lite`
- **medium/high/max:** `anthropic/claude-haiku-4-5`

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
