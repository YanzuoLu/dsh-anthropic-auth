// Anthropic gates newly released models on a minimum Claude Code version and
// rejects OAuth requests below it with `error_code: claude_code_version_too_old`.
// The version the billing header reports is what Anthropic keys on.
//
// Check the current release with `npm view @anthropic-ai/claude-code version`.
// Do not read it from a local `claude --version`: the `stable` dist-tag lags
// `latest`, so a local install is often below the floor new models require.
//
// Known floors: claude-fable-5-1 requires >= 2.1.251; claude-opus-5-5
// requires >= 2.1.280.

/** Claude Code version embedded in the billing header; keep it current. */
export const CLAUDE_CODE_VERSION = '2.1.280'

/** Environment variable that pins the billing-header version verbatim. */
export const CLAUDE_CODE_VERSION_ENV = 'DSH_ANTHROPIC_AUTH_CLAUDE_CODE_VERSION'

const CLAUDE_CODE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/**
 * The bundled version, or the {@link CLAUDE_CODE_VERSION_ENV} override. The
 * override must be a bare `X.Y.Z`: it feeds a salted hash, so a typo throws
 * instead of silently sending the bundled version.
 * @param {NodeJS.ProcessEnv} [environment]
 * @returns {string}
 */
export function resolveClaudeCodeVersion(environment = process.env) {
  const configured = environment[CLAUDE_CODE_VERSION_ENV]?.trim()
  if (!configured) return CLAUDE_CODE_VERSION
  if (!CLAUDE_CODE_VERSION_PATTERN.test(configured)) {
    throw new Error(`${CLAUDE_CODE_VERSION_ENV} must be a bare X.Y.Z version, received ${JSON.stringify(configured)}`)
  }
  return configured
}

/** Whether an explicit override is set; an override is never raised. */
export function hasClaudeCodeVersionOverride(environment = process.env) {
  return Boolean(environment[CLAUDE_CODE_VERSION_ENV]?.trim())
}

const CLAUDE_CLI_USER_AGENT_PATTERN = /(?:^|\s)claude-cli\/(\d+\.\d+\.\d+)(?=\s|$)/

/**
 * The version in a `claude-cli/X.Y.Z` user agent.
 * @param {string | null | undefined} userAgent
 * @returns {string | undefined}
 */
export function readClaudeCliVersion(userAgent) {
  if (!userAgent) return undefined
  return CLAUDE_CLI_USER_AGENT_PATTERN.exec(userAgent)?.[1]
}

/**
 * The numerically higher of two `X.Y.Z` versions. `baseline` wins ties and
 * wins when `candidate` is absent or malformed.
 * @param {string} baseline
 * @param {string | undefined} candidate
 * @returns {string}
 */
export function higherVersion(baseline, candidate) {
  if (!candidate || !CLAUDE_CODE_VERSION_PATTERN.test(candidate)) return baseline
  const baselineParts = baseline.split('.').map(Number)
  const candidateParts = candidate.split('.').map(Number)
  for (let index = 0; index < candidateParts.length; index += 1) {
    const baselinePart = baselineParts[index] ?? 0
    const candidatePart = candidateParts[index]
    if (candidatePart !== baselinePart) return candidatePart > baselinePart ? candidate : baseline
  }
  return baseline
}

/**
 * The highest Claude Code version Anthropic has demanded in this process, so
 * only the first request after a floor rise pays the rejected round trip.
 */
export function createLearnedClaudeCodeFloor() {
  let learned
  return {
    /** @param {string} version */
    learn(version) {
      if (!CLAUDE_CODE_VERSION_PATTERN.test(version)) return
      learned = learned ? higherVersion(learned, version) : version
    },
    /** @param {string} version */
    applyTo(version) {
      return higherVersion(version, learned)
    },
  }
}
