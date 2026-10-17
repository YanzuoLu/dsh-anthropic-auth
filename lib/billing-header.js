// The `x-anthropic-billing-header` system block identifies the request as
// Claude Code usage. The recipe must match what Anthropic's backend expects.
import { createHash } from 'node:crypto'

const BILLING_HEADER_SALT = '59cf53e54c78'
const BILLING_HEADER_POSITIONS = [4, 7, 20]
const CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'

/** Prefix every billing header carries, used to detect an already-billed request. */
export const BILLING_HEADER_MARKER = 'x-anthropic-billing-header:'

/**
 * Text of the first user message, which seeds the billing hash; `''` when
 * there is none.
 * @param {Array<{ role?: string, content?: unknown }>} messages
 * @returns {string}
 */
export function getFirstUserText(messages) {
  const first = messages.find((message) => message.role === 'user')
  if (!first) return ''
  if (typeof first.content === 'string') return first.content
  if (!Array.isArray(first.content)) return ''
  const block = first.content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string')
  return block?.text ?? ''
}

/**
 * The billing header value for a request, or `undefined` with no text to hash.
 * @param {string} messageText - the first user message text.
 * @param {string} claudeCodeVersion - bare `X.Y.Z`.
 * @returns {string | undefined}
 */
export function buildBillingHeaderValue(messageText, claudeCodeVersion) {
  if (!messageText) return undefined
  const cch = createHash('sha256').update(messageText).digest('hex').slice(0, 5)
  const sampled = BILLING_HEADER_POSITIONS.map((index) => messageText[index] || '0').join('')
  const suffix = createHash('sha256')
    .update(`${BILLING_HEADER_SALT}${sampled}${claudeCodeVersion}`)
    .digest('hex')
    .slice(0, 3)
  return [
    BILLING_HEADER_MARKER,
    `cc_version=${claudeCodeVersion}.${suffix};`,
    `cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`,
    `cch=${cch};`,
  ].join(' ')
}
