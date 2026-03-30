---
name: msgvault-api
description: Search and query msgvault email archive via REST API. Use when asked to "search emails", "find emails from", "emails with subject", "emails with attachments", "query msgvault", "get email stats", "list email accounts", or working with the msgvault local email archive server. Supports full-text search with operators (from, to, subject, label, date ranges, attachments), message retrieval, and archive statistics.
---

# msgvault API

Interface with a local [msgvault](https://github.com/wesm/msgvault) email archive server via its REST API. All data stays local — the API queries the same SQLite database and attachment store as the CLI and TUI.

## Step 1: Check Server Configuration

Before making API calls, verify you have access to the msgvault server:
- Server URL: `https://msgvault.inglehart.io`
- API key (if configured)

**Finding your API key:**
The API key is stored in `~/.msgvault/config.toml` under the `[remote]` section:
```bash
grep api_key ~/.msgvault/config.toml
```

Authentication methods (when `api_key` is set):
| Method | Header Format |
|--------|---------------|
| Bearer token | `Authorization: Bearer <key>` |
| API key | `X-API-Key: <key>` |
| Plain auth | `Authorization: <key>` |

## Step 2: Health Check

Verify server connectivity (no auth required):

```bash
curl https://msgvault.inglehart.io/health
```

Expected response: `{"status": "ok"}`

## Step 3: Execute API Operations

Use the appropriate endpoint for your task:

### Get Archive Statistics
```bash
curl -H "Authorization: Bearer <api_key>" \
  https://msgvault.inglehart.io/api/v1/stats
```

Returns: `total_messages`, `total_threads`, `total_accounts`, `total_labels`, `total_attachments`, `database_size_bytes`

### List Messages
```bash
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/messages?page=1&page_size=20"
```

### Get Message Details
```bash
curl -H "Authorization: Bearer <api_key>" \
  https://msgvault.inglehart.io/api/v1/messages/<id>
```

Returns full message including `body` and `attachments` array.

### Search Messages
```bash
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/search?q=<query>&page=1&page_size=20"
```

**Search query syntax:**

Bare words and `"quoted phrases"` perform full-text search across message subjects and bodies.

| Operator | Description | Example |
|----------|-------------|---------|
| `from:` | Sender address | `from:alice@example.com` |
| `to:` | Recipient address | `to:bob@example.com` |
| `cc:` | CC recipient | `cc:team@example.com` |
| `bcc:` | BCC recipient | `bcc:admin@example.com` |
| `subject:` | Subject text | `subject:meeting` |
| `label:` | Gmail label | `label:INBOX`, `label:SENT` |
| `has:attachment` | Has attachments | `has:attachment` |
| `before:` | Before date | `before:2024-06-01` |
| `after:` | After date | `after:2024-01-01` |
| `older_than:` | Relative date | `older_than:7d`, `older_than:2w`, `older_than:1m`, `older_than:1y` |
| `newer_than:` | Relative date | `newer_than:30d` |
| `larger:` | Minimum size | `larger:5M`, `larger:100K` |
| `smaller:` | Maximum size | `smaller:1M` |

**Search examples:**

```bash
# Search by sender
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/search?q=from:alice@example.com"

# Subject search
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/search?q=subject:meeting"

# Date range
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/search?q=after:2024-01-01%20before:2024-06-01"

# Messages with attachments
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/search?q=has:attachment"

# By label
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/search?q=label:INBOX"

# Combined filters (URL-encode spaces as %20)
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/search?q=from:boss@company.com%20has:attachment%20after:2024-01-01"

# Full-text search
curl -H "Authorization: Bearer <api_key>" \
  "https://msgvault.inglehart.io/api/v1/search?q=quarterly%20report"
```

Note: The full-text search index (FTS5) is populated automatically during sync.

### List Accounts
```bash
curl -H "Authorization: Bearer <api_key>" \
  https://msgvault.inglehart.io/api/v1/accounts
```

Returns accounts with `email`, `display_name`, `last_sync_at`, `next_sync_at`, `schedule`, `enabled`.

## Response Formats

### Message Object (list/search)
```json
{
  "id": 12345,
  "subject": "Subject line",
  "from": "sender@example.com",
  "to": ["recipient@example.com"],
  "sent_at": "2024-10-15T09:30:00Z",
  "snippet": "Preview text...",
  "labels": ["INBOX", "IMPORTANT"],
  "has_attachments": true,
  "size_bytes": 52480
}
```

### Paginated Response
```json
{
  "total": 142857,
  "page": 1,
  "page_size": 20,
  "messages": [...]
}
```

## Rate Limits

The API enforces 10 requests/second per client IP with a burst of 20. HTTP 429 with `Retry-After` header when exceeded.

## Error Handling

Common status codes:
| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request |
| 401 | Unauthorized (invalid/missing API key) |
| 429 | Rate limited |

## Security Notes

- Server binds to `127.0.0.1` by default (local only)
- API key required when binding to non-loopback addresses
- Never expose without authentication on untrusted networks
