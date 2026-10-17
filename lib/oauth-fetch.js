// The transport seam. dsh-llm-pi-ai offers no payload or fetch hook, and the
// Anthropic SDK pi-ai drives reads the global `fetch` for every client it
// builds, so the plugin wraps that global. Only an Anthropic Messages request
// authorized by an OAuth token (`Bearer sk-ant-oat…`) is changed; everything
// else, API-key traffic included, passes through untouched. This covers every
// caller on the route: main turns, compaction, titles, and subagents.
import { buildBillingHeaderValue, getFirstUserText } from './billing-header.js'
import {
  createLearnedClaudeCodeFloor,
  hasClaudeCodeVersionOverride,
  higherVersion,
  readClaudeCliVersion,
  resolveClaudeCodeVersion,
} from './claude-code-version.js'
import { describeShaping, isAnthropicMessagesPayload, shapeAnthropicOAuthPayload, toolUseNames } from './request-shaping.js'
import { describeRecoveryHint, readClaudeCodeVersionRejection } from './version-rejection.js'

const OAUTH_BEARER_PREFIX = 'Bearer sk-ant-oat'
const MESSAGES_PATH = /\/v1\/messages$/

/**
 * @typedef {object} OAuthFetchOptions
 * @property {typeof fetch} baseFetch - the fetch every request is dispatched through.
 * @property {() => Promise<string>} claudeCliUserAgent - the `claude-cli/X.Y.Z` user agent pi-ai sends on OAuth requests.
 * @property {(scope: string, data: object) => void} debug - debug sink; called only when debugging is on.
 * @property {() => 'off' | 'all' | 'tool-use'} debugMode - the current debug mode.
 */

/**
 * Build the OAuth-shaping fetch.
 *
 * dsh attributes every provider request with its own `user-agent`, which
 * replaces the `claude-cli/X.Y.Z` pi-ai sets for Claude OAuth. The wrapper
 * restores pi-ai's value, so the request carries the same user agent it
 * carries under Pi.
 *
 * The billing header is built at the bundled pin raised to the user agent's
 * version and to any floor Anthropic has named; an explicit override is sent
 * verbatim. A `claude_code_version_too_old` rejection is retried once at the
 * named floor; an unrecovered one gets a hint appended to its message. Only a
 * 400 is read, and only through a clone, so the streaming path is untouched.
 * @param {OAuthFetchOptions} options
 * @returns {typeof fetch}
 */
export function createOAuthFetch({ baseFetch, claudeCliUserAgent, debug, debugMode }) {
  const learnedFloor = createLearnedClaudeCodeFloor()

  function targetVersion(userAgent) {
    const pinned = resolveClaudeCodeVersion()
    if (hasClaudeCodeVersionOverride()) return pinned
    return learnedFloor.applyTo(higherVersion(pinned, readClaudeCliVersion(userAgent)))
  }

  /** `body` with its billing header moved between versions, or `undefined` when it cannot be verified. */
  function rebuildBody(body, firstUserText, fromVersion, toVersion) {
    const fromHeader = buildBillingHeaderValue(firstUserText, fromVersion)
    const toHeader = buildBillingHeaderValue(firstUserText, toVersion)
    if (!fromHeader || !toHeader || !body.includes(fromHeader)) return undefined
    return body.replace(fromHeader, toHeader)
  }

  /**
   * Whether a rejection can be retried at the named floor, and if not, why.
   * A named floor is learned even when this request cannot be retried; an
   * explicit override is neither retried nor learned.
   */
  function planRecovery(rejection, body, firstUserText, sentVersion) {
    const required = rejection.requiredVersion
    if (hasClaudeCodeVersionOverride()) {
      return hint({ kind: 'override', overrideVersion: resolveClaudeCodeVersion(), requiredVersion: required })
    }
    if (!required) return hint({ kind: 'set-override', requiredVersion: undefined })
    learnedFloor.learn(required)
    const rebuilt = rebuildBody(body, firstUserText, sentVersion, required)
    if (rebuilt === undefined) return hint({ kind: 'set-override', requiredVersion: required })
    if (higherVersion(sentVersion, required) === sentVersion) return hint({ kind: 'upgrade-dsh', sentVersion })
    return { kind: 'retry', body: rebuilt, requiredVersion: required }
  }

  return async function anthropicOAuthFetch(input, init) {
    const payload = oauthMessagesPayload(input, init)
    if (payload === undefined) return baseFetch(input, init)

    const headers = new Headers(init.headers)
    if (readClaudeCliVersion(headers.get('user-agent')) === undefined) {
      headers.set('user-agent', await claudeCliUserAgent())
    }
    headers.delete('content-length')

    const version = targetVersion(headers.get('user-agent'))
    const shaped = shapeAnthropicOAuthPayload(payload, version)
    const mode = debugMode()
    if (mode === 'all' || (mode === 'tool-use' && toolUseNames(payload.messages).length > 0)) {
      debug('before-provider-request', { ...describeShaping(payload, shaped), claudeCodeVersion: version })
    }

    const sentInit = { ...init, headers, body: JSON.stringify(shaped) }
    const response = await baseFetch(input, sentInit)
    const rejection = await readVersionRejection(response)
    if (!rejection) return response

    const firstUserText = getFirstUserText(payload.messages)
    const recovery = planRecovery(rejection, sentInit.body, firstUserText, version)
    if (recovery.kind === 'hint') return hintedResponse(response, rejection, recovery.reason)

    if (mode !== 'off') {
      debug('claude-code-version-recovery', { sentVersion: version, requiredVersion: recovery.requiredVersion })
    }
    await response.body?.cancel()
    const retried = await baseFetch(input, { ...sentInit, body: recovery.body })
    const retryRejection = await readVersionRejection(retried)
    if (!retryRejection) return retried

    // One retry only: a second rejection is explained, never chased.
    const second = planRecovery(retryRejection, recovery.body, firstUserText, recovery.requiredVersion)
    return hintedResponse(
      retried,
      retryRejection,
      second.kind === 'hint' ? second.reason : { kind: 'set-override', requiredVersion: second.requiredVersion },
    )
  }
}

/**
 * The parsed body of an OAuth Anthropic Messages request, else `undefined`.
 * @param {Parameters<typeof fetch>[0]} input
 * @param {RequestInit | undefined} init
 */
function oauthMessagesPayload(input, init) {
  if (init?.method?.toUpperCase() !== 'POST' || typeof init.body !== 'string') return undefined
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (!MESSAGES_PATH.test(url.pathname)) return undefined
  if (!new Headers(init.headers).get('authorization')?.startsWith(OAUTH_BEARER_PREFIX)) return undefined
  let payload
  try {
    payload = JSON.parse(init.body)
  } catch {
    return undefined
  }
  return isAnthropicMessagesPayload(payload) ? payload : undefined
}

function hint(reason) {
  return { kind: 'hint', reason }
}

async function readVersionRejection(response) {
  if (response.status !== 400) return undefined
  return readClaudeCodeVersionRejection(await response.clone().text())
}

/**
 * The rejection with the hint appended to `error.message`. Status and
 * headers are kept, so the SDK raises the same error with the same
 * `request-id`; length and encoding no longer describe the new body.
 */
async function hintedResponse(response, rejection, reason) {
  await response.body?.cancel()
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(rejection.withHint(describeRecoveryHint(reason)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
