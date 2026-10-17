// Shaping of one Anthropic Messages OAuth payload: the dsh identity line is
// replaced with a neutral prompt and the billing block is prepended. Every
// other section, message, and block is sent as dsh built it; assistant turns
// are never touched, so signed thinking stays next to what it was signed on.
import { BILLING_HEADER_MARKER, buildBillingHeaderValue, getFirstUserText } from './billing-header.js'

/** The `harness:identity` section `dsh-system-prompt` renders first. */
export const DSH_IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'

/** Neutral prompt that replaces {@link DSH_IDENTITY}. */
export const MINIMAL_ANTHROPIC_OAUTH_PROMPT = [
  'You are an expert coding assistant.',
  'Be concise and helpful.',
  "Use the available tools to answer the user's request.",
  'Show file paths clearly when working with files.',
].join('\n')

/** Separator `dsh-system-prompt` renders between sections. */
const SECTION_SEPARATOR = '\n\n'

/**
 * Whether a parsed body is an Anthropic Messages request.
 * @param {unknown} payload
 * @returns {payload is { model: string, messages: object[], stream: boolean, system?: unknown, tools?: unknown }}
 */
export function isAnthropicMessagesPayload(payload) {
  return isRecord(payload)
    && typeof payload.model === 'string'
    && Array.isArray(payload.messages)
    && typeof payload.stream === 'boolean'
}

/**
 * Replace a leading dsh identity section with the neutral prompt.
 * @param {string} text - one system block's text.
 * @returns {string}
 */
export function replaceIdentity(text) {
  if (text === DSH_IDENTITY) return MINIMAL_ANTHROPIC_OAUTH_PROMPT
  if (text.startsWith(DSH_IDENTITY + SECTION_SEPARATOR)) {
    return MINIMAL_ANTHROPIC_OAUTH_PROMPT + text.slice(DSH_IDENTITY.length)
  }
  return text
}

/**
 * Shape a payload for an Anthropic OAuth request.
 * @param {{ messages: object[], system?: unknown }} payload - an Anthropic Messages payload.
 * @param {string} claudeCodeVersion - the version the billing header reports.
 * @returns {object} the shaped payload; the input is not mutated.
 */
export function shapeAnthropicOAuthPayload(payload, claudeCodeVersion) {
  const billingHeader = buildBillingHeaderValue(getFirstUserText(payload.messages), claudeCodeVersion)
  if (payload.system == null && billingHeader === undefined) return payload
  const system = normalizeSystemBlocks(payload.system)
    .map((block) => (block?.type === 'text' && typeof block.text === 'string'
      ? { ...block, text: replaceIdentity(block.text) }
      : block))
  const billed = billingHeader === undefined || system.some((block) => (
    typeof block?.text === 'string' && block.text.includes(BILLING_HEADER_MARKER)
  ))
    ? system
    : [{ type: 'text', text: billingHeader }, ...system]
  return { ...payload, system: billed }
}

/**
 * Debug summary of a shaped request: counts and names only, never text.
 * @param {{ model: string, messages: object[], system?: unknown, tools?: unknown }} before
 * @param {{ system?: unknown }} after
 */
export function describeShaping(before, after) {
  return {
    model: before.model,
    systemBlockCountBefore: Array.isArray(before.system) ? before.system.length : 0,
    systemBlockCountAfter: Array.isArray(after.system) ? after.system.length : 0,
    assistantMessages: before.messages.filter((message) => message.role === 'assistant').length,
    systemMessages: before.messages.filter((message) => message.role === 'system').length,
    toolDefinitions: Array.isArray(before.tools)
      ? before.tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === 'string' ? [tool.name] : []))
      : [],
    toolUseNames: toolUseNames(before.messages),
  }
}

/**
 * Tool names the conversation history has called.
 * @param {object[]} messages
 * @returns {string[]}
 */
export function toolUseNames(messages) {
  return messages.flatMap((message) => (Array.isArray(message.content)
    ? message.content.flatMap((block) => (block?.type === 'tool_use' && typeof block.name === 'string' ? [block.name] : []))
    : []))
}

/** Anthropic accepts `system` as a string, a block array, or nothing. */
function normalizeSystemBlocks(system) {
  if (Array.isArray(system)) return system.map(normalizeSystemBlock)
  return system == null ? [] : [normalizeSystemBlock(system)]
}

function normalizeSystemBlock(block) {
  if (typeof block === 'string') return { type: 'text', text: block }
  return block
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
