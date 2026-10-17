/**
 * Claude subscription (OAuth) compatibility for DeepSeek Harness (dsh)
 * Anthropic requests.
 *
 * On every Anthropic Messages request that carries an OAuth token, the plugin
 * replaces dsh's `harness:identity` line with a neutral prompt, prepends the
 * Claude Code billing block, sends pi-ai's own `claude-cli` user agent where
 * dsh's attribution header replaced it, and recovers once from a
 * `claude_code_version_too_old` rejection. API-key and non-Anthropic requests
 * are untouched.
 *
 * Ported from pi-anthropic-auth (https://github.com/gotgenes/pi-anthropic-auth, MIT).
 *
 * @module dsh-anthropic-auth
 */
import z from '@deepseek-ai/schemastery'
import { createOAuthFetch } from './lib/oauth-fetch.js'
import { readPiAiClaudeCliUserAgent } from './lib/pi-ai-user-agent.js'

export const name = 'anthropic-auth'

export const Config = z.object({})

/** Environment variable selecting stderr debug logging: `all` (or `1`) or `tool-use`. */
export const DEBUG_ENV = 'DSH_ANTHROPIC_AUTH_DEBUG'

/**
 * @param {string | undefined} value
 * @returns {'off' | 'all' | 'tool-use'}
 */
export function debugModeOf(value) {
  switch (value?.trim().toLowerCase()) {
    case '1': case 'true': case 'yes': case 'on': case 'debug': case 'all':
      return 'all'
    case 'tool': case 'tools': case 'tool-use': case 'tool_use':
      return 'tool-use'
    default:
      return 'off'
  }
}

// Multiple Cordis entries share one wrapper and one learned version floor.
let installation

/**
 * Install the OAuth-shaping fetch for this plugin's lifetime.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => {
    installation ??= installFetch()
    const current = installation
    current.users += 1
    return () => {
      current.users -= 1
      if (current.users > 0) return
      current.dispose()
      installation = undefined
    }
  }, 'anthropic-auth fetch')
}

function installFetch() {
  const original = globalThis.fetch
  let active = true
  let userAgent
  const oauthFetch = createOAuthFetch({
    baseFetch: (input, init) => original(input, init),
    claudeCliUserAgent: () => (userAgent ??= readPiAiClaudeCliUserAgent()),
    // stderr reaches the terminal or service log without a Cordis log exporter.
    debug: (scope, data) => console.error(`[dsh-anthropic-auth][debug] ${scope} ${JSON.stringify(data)}`),
    debugMode: () => debugModeOf(process.env[DEBUG_ENV]),
  })
  const wrapper = (input, init) => (active ? oauthFetch(input, init) : original(input, init))
  globalThis.fetch = wrapper
  return {
    users: 0,
    dispose() {
      active = false
      if (globalThis.fetch === wrapper) globalThis.fetch = original
    },
  }
}
