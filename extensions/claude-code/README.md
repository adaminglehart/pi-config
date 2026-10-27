# Local Claude Code extension

Source: https://github.com/earendil-works/pi-claude-code
Commit: `70abb65186592ca788b29b3db22c3160d629c41f`
License: MIT. See `LICENSE`.

This copy replaces the upstream Git package in the primary Pi agent.
Pi loads `index.ts`, which loads the upstream entry point in `src/index.ts`.
Pi supplies the peer dependencies at runtime.

## Local change

`setCacheBreakpoint` removes the message's existing cache markers before it
marks the last content block. This prevents a fifth marker on Fable requests
after a tool result.

Upstream issue: https://github.com/earendil-works/pi-claude-code/issues/10
Upstream proposed fix: https://github.com/earendil-works/pi-claude-code/pull/11

The other upstream source files and tests are unchanged.

## Checks

Run from `~/dev/pi-config`:

```bash
pnpm --dir extensions/claude-code test
pnpm --dir extensions/claude-code run check
just apply
```

The local test file is `tests/cache-breakpoints.test.ts`.

## Return to upstream

First confirm that an upstream version passes the local regression test.
Then restore the upstream package in `config/settings.base.jsonc`, remove
`claude-code` from `pi.jsonc`, remove this local copy, and run `just apply`.

## Runtime

Claude Code must be installed and logged in. The provider uses that login.
The `/claude-code-status` command checks the executable and login.

Optional environment variables:

- `PI_CLAUDE_CODE_COMMAND`: Claude Code executable path or name.
- `PI_CLAUDE_CODE_CONFIG_DIR`: Claude Code configuration directory.

Requests count against the Claude subscription's usage limits. Upstream warns
that Anthropic can change this billing policy. This local copy does not change
authentication or billing behavior.
