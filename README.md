# dsh-anthropic-auth

Claude subscription (OAuth) compatibility for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). It adapts the Anthropic Messages requests dsh sends with a Claude sign-in. dsh's own pi-ai integration still owns sign-in, token refresh, the model catalog, and the wire protocol.

On every Anthropic Messages request authorized by an OAuth token (`Bearer sk-ant-oat…`), the plugin:

- prepends the Claude Code `x-anthropic-billing-header` system block, unless the request already has one;
- replaces dsh's identity line (`You are an AI agent powered by DeepSeek Harness.`) with a short neutral prompt, leaving every other prompt section as dsh built it;
- sends pi-ai's own `user-agent: claude-cli/X.Y.Z` where dsh's attribution header replaced it, so the request carries the same user agent it carries under pi. The value is read from the installed pi-ai, not copied;
- reports the bundled Claude Code version raised to the user agent's version, and recovers once from a `claude_code_version_too_old` rejection by retrying at the version Anthropic names. Later requests go out at that version directly.

API-key requests and every other provider are untouched. Assistant turns, thinking blocks, tools, and mid-conversation system messages pass through unchanged. The plugin wraps the global `fetch`, so main turns, compaction, session titles, and subagents are all covered.

## Credit

Ported from [pi-anthropic-auth](https://github.com/gotgenes/pi-anthropic-auth) 3.4.3 by Christopher D. Lasher (MIT), a pi extension. The billing header recipe, Claude Code version pin, version recovery, rejection hints, and debug logging follow its `billing-header.ts`, `claude-code-version.ts`, `billing-version-sync.ts`, `version-rejection.ts`, and `debug.ts`. See [LICENSE](LICENSE).

## Install

```sh
dsh plugin --profile web add github:YanzuoLu/dsh-anthropic-auth
```

The bundle patch mounts the plugin. No configuration is needed. It needs dsh 0.2.0-rc.2 or newer with `@earendil-works/pi-ai` 0.87 from the dsh installation, and a Claude sign-in on the `anthropic` route.

## Environment

| Variable | Effect |
|---|---|
| `DSH_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION` | Bare `X.Y.Z` sent verbatim as the billing-header version. It is never raised or retried. Unset it to let the plugin recover automatically. |
| `DSH_ANTHROPIC_AUTH_DEBUG` | `all` (or `1`) logs a per-request summary and version recoveries to stderr. `tool-use` limits the summary to requests whose history contains tool calls. Logs carry counts and tool names, never prompt text. |

## Troubleshooting

A `claude_code_version_too_old` error that survives the automatic retry ends with a `[dsh-anthropic-auth]` hint. Set `DSH_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION` to the version it names, or to the current release (`npm view @anthropic-ai/claude-code dist-tags`). When the hint says the billing header already met the floor, the rejection may come from the claude-cli version of the pi-ai bundled with dsh. Try upgrading dsh.
