// Anthropic rejects an OAuth request for a gated model with a 400 whose
// `error.details.error_code` is `claude_code_version_too_old` and whose
// message names the floor: "... version 2.1.280 or newer is required. ...".
// The wording is a convention, so an unparseable floor degrades to a hint.
import { CLAUDE_CODE_VERSION_ENV } from './claude-code-version.js'

const CLAUDE_CODE_VERSION_TOO_OLD = 'claude_code_version_too_old'
const REQUIRED_VERSION_PATTERN = /version (\d+\.\d+\.\d+) or newer is required/
const HINT_PREFIX = '[dsh-anthropic-auth]'
const CURRENT_RELEASE = 'the current Claude Code release (npm view @anthropic-ai/claude-code dist-tags)'

/**
 * @typedef {object} ClaudeCodeVersionRejection
 * @property {string | undefined} requiredVersion - the floor Anthropic named.
 * @property {(hint: string) => string} withHint - the same body with `hint` appended to `error.message`.
 */

/**
 * @typedef {{ kind: 'override', overrideVersion: string, requiredVersion: string | undefined }
 *   | { kind: 'upgrade-dsh', sentVersion: string }
 *   | { kind: 'set-override', requiredVersion: string | undefined }} RecoveryHintReason
 */

/**
 * Parse a response body as a `claude_code_version_too_old` rejection.
 * @param {string} bodyText
 * @returns {ClaudeCodeVersionRejection | undefined}
 */
export function readClaudeCodeVersionRejection(bodyText) {
  const body = parseJsonRecord(bodyText)
  const error = body?.error
  if (!body || !isRecord(error)) return undefined
  if (!isRecord(error.details) || error.details.error_code !== CLAUDE_CODE_VERSION_TOO_OLD) return undefined
  const message = typeof error.message === 'string' ? error.message : ''
  return {
    requiredVersion: REQUIRED_VERSION_PATTERN.exec(message)?.[1],
    withHint(hint) {
      return JSON.stringify({ ...body, error: { ...error, message: message ? `${message} ${hint}` : hint } })
    },
  }
}

/**
 * The user-facing hint appended to an unrecovered rejection.
 * @param {RecoveryHintReason} reason
 * @returns {string}
 */
export function describeRecoveryHint(reason) {
  switch (reason.kind) {
    case 'override':
      return `${HINT_PREFIX} ${CLAUDE_CODE_VERSION_ENV}=${reason.overrideVersion} is sent verbatim; raise it to ${
        reason.requiredVersion ? `${reason.requiredVersion} or newer` : CURRENT_RELEASE
      }, or unset it to let dsh-anthropic-auth recover automatically.`
    case 'upgrade-dsh':
      return `${HINT_PREFIX} The billing header already reported ${reason.sentVersion}; this rejection likely comes from the claude-cli version of the pi-ai bundled with dsh. Upgrade dsh.`
    case 'set-override':
      return `${HINT_PREFIX} Automatic recovery did not succeed; set ${
        reason.requiredVersion
          ? `${CLAUDE_CODE_VERSION_ENV}=${reason.requiredVersion}`
          : `${CLAUDE_CODE_VERSION_ENV} to ${CURRENT_RELEASE}`
      } and retry.`
  }
}

function parseJsonRecord(text) {
  try {
    const parsed = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
