// pi-ai keeps its Claude Code version module-private and sends it only as the
// `user-agent: claude-cli/X.Y.Z` of a Claude OAuth request. Rather than copy a
// constant that drifts when dsh upgrades pi-ai, ask the installed pi-ai: build
// one OAuth request through its own Anthropic transport with a fetch that
// records the header and fails before anything leaves the process.
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'

const PROBE_MODEL = {
  id: 'claude-haiku-4-5',
  name: 'user-agent probe',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 16,
}

/**
 * The user agent the installed pi-ai sends on a Claude OAuth request.
 * @returns {Promise<string>}
 */
export async function readPiAiClaudeCliUserAgent() {
  let userAgent
  const stream = streamSimple(PROBE_MODEL, { messages: [{ role: 'user', content: 'probe', timestamp: 0 }] }, {
    apiKey: 'sk-ant-oat-probe',
    maxRetries: 0,
    fetch: async (_input, init) => {
      userAgent = new Headers(init?.headers).get('user-agent')
      throw new Error('user-agent probe')
    },
  })
  await stream.result()
  if (!userAgent?.startsWith('claude-cli/')) {
    throw new Error(`dsh-anthropic-auth: pi-ai sent ${JSON.stringify(userAgent)} instead of a claude-cli user agent on OAuth`)
  }
  return userAgent
}
