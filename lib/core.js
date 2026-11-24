/**
 * dsh-drift-gate — pure logic.
 *
 * The gate reads the session log, takes exactly two pieces of text (the user's
 * request for this turn and the assistant's final visible answer), and asks a
 * read-only judge one question: did the delivery clearly drift from the
 * request? Everything here is deterministic and side-effect free so the
 * decision can be unit tested without a harness.
 *
 * @module dsh-drift-gate/core
 */

/** Marker prefixed to every injected drift-gate message, so the next turn can
 * ignore its own reminder when locating the user's request. */
export const DRIFT_MARK = '[drift-gate]'

const DEFAULT_MAX_USER_CHARS = 2000
const DEFAULT_MAX_ASSISTANT_CHARS = 4000
const MAX_REASON_CHARS = 200
const MAX_QUOTE_CHARS = 200

/** Drift below this confidence is treated as pass (宁可漏判也不误伤). */
export const DEFAULT_MIN_CONFIDENCE = 0.8

/** The structured verdict the judge must satisfy. */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason', 'confidence'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'drift'] },
    reason: { type: 'string', maxLength: MAX_REASON_CHARS },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}

/**
 * Read the session's event log through whichever face this host exposes.
 * @param {unknown} session - the host Session.
 * @returns {Array<object>} the event array (empty when unreadable).
 */
export function sessionEvents(session) {
  if (session === null || session === undefined || typeof session !== 'object') return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  if (Array.isArray(session.events)) return session.events
  return []
}

/**
 * Concatenate the text blocks of one message payload.
 * @param {unknown} payload - the event's `data` (or a message).
 * @param {{ visibleOnly?: boolean }} [options] - visibleOnly keeps only
 *   `type: 'text'` blocks, which is what the user actually sees.
 * @returns {string}
 */
export function textOf(payload, options = {}) {
  if (payload === null || typeof payload !== 'object') return ''
  const message = payload.message ?? payload
  const content = message?.content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (typeof block.text !== 'string') continue
      if (options.visibleOnly === true) {
        if (block.type === 'text') parts.push(block.text)
      } else if (block.type === 'text' || block.type === undefined) {
        parts.push(block.text)
      }
    }
    return parts.join('\n').trim()
  }
  const direct = message?.text ?? payload.text
  if (typeof direct === 'string') return direct.trim()
  if (typeof content === 'string') return content.trim()
  return ''
}

/**
 * Normalize a user request into a stable strike key.
 * @param {string} userText
 * @returns {string}
 */
export function turnKeyOf(userText) {
  const normalized = String(userText).replace(/\s+/g, ' ').trim()
  return normalized.slice(0, 80) + '#' + normalized.length
}

/**
 * Extract this turn's (user request, final visible answer) pair.
 *
 * The request is the last `user/message` before the latest `turn/start`;
 * messages carrying {@link DRIFT_MARK} are our own reminders and are skipped.
 * The answer is the last `assistant/message` after that boundary that actually
 * contains visible text — reasoning and tool-call blocks are ignored.
 *
 * @param {Array<object>} events
 * @returns {{userText: string, assistantText: string, turnKey: string} | null}
 */
export function extractTurnContext(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  let turnStartIndex = -1
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') {
      turnStartIndex = i
      break
    }
  }
  const beforeEnd = turnStartIndex >= 0 ? turnStartIndex : events.length
  let userText = ''
  for (let i = beforeEnd - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const text = textOf(event.data)
    if (text.length === 0) continue
    if (text.startsWith(DRIFT_MARK)) continue
    userText = text
    break
  }
  let assistantText = ''
  const answerStart = turnStartIndex >= 0 ? turnStartIndex + 1 : 0
  for (let i = events.length - 1; i >= answerStart; i -= 1) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const text = textOf(event.data, { visibleOnly: true })
    if (text.length === 0) continue
    assistantText = text
    break
  }
  if (userText.length === 0 || assistantText.length === 0) return null
  return { userText, assistantText, turnKey: turnKeyOf(userText) }
}

/**
 * Build the judge prompt: the two texts and nothing else.
 * @param {{userText: string, assistantText: string}} turn
 * @param {{maxUserChars?: number, maxAssistantChars?: number}} [limits]
 * @returns {string}
 */
export function judgePrompt(turn, limits = {}) {
  const maxUser = limits.maxUserChars ?? DEFAULT_MAX_USER_CHARS
  const maxAssistant = limits.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS
  return [
    '你是需求漂移判定器。只做一件事:判断下面的「交付回答」是否明确偏离了「用户需求」。',
    '',
    '规则:',
    '- 只依据给定的两段文本判断;不要使用任何工具,不要读文件,不要执行命令。',
    '- 明确偏离 = 答非所问 / 回答了另一个任务 / 忽略了用户的核心要求 / 与用户要求相反。',
    '- 只要不确定、只是不完整、只是不够好 → 判 pass。',
    '- 必须给出 confidence(0 到 1),表示你对「明确偏离」的把握;低于 0.8 会被当作 pass。',
    '- reason 写一句中文,不超过 80 字:用户要求 X,回答给了 Y。pass 时也写一句理由。',
    '',
    '用户需求:',
    truncate(turn.userText, maxUser),
    '',
    '交付回答:',
    truncate(turn.assistantText, maxAssistant),
  ].join('\n')
}

/**
 * Validate the judge's structured output. Anything unexpected — including a
 * drift verdict below the confidence floor or without a confidence at all —
 * degrades to pass.
 * @param {unknown} structured
 * @param {number} [minConfidence]
 * @returns {{verdict: 'pass' | 'drift', reason: string}}
 */
export function normalizeVerdict(structured, minConfidence = DEFAULT_MIN_CONFIDENCE) {
  if (structured === null || typeof structured !== 'object') return { verdict: 'pass', reason: '' }
  const reason = typeof structured.reason === 'string' ? structured.reason.trim() : ''
  const text = truncate(reason, MAX_REASON_CHARS)
  if (structured.verdict === 'pass') return { verdict: 'pass', reason: text }
  if (structured.verdict !== 'drift') return { verdict: 'pass', reason: text, degraded: 'unknown-verdict' }
  if (reason.length === 0) return { verdict: 'pass', reason: '', degraded: 'empty-reason' }
  const confidence = typeof structured.confidence === 'number' ? structured.confidence : Number.NaN
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { verdict: 'pass', reason: text, degraded: 'invalid-confidence' }
  }
  if (confidence < minConfidence) return { verdict: 'pass', reason: text, degraded: 'low-confidence' }
  return { verdict: 'drift', reason: text }
}

/** Per-agent, per-question strike counter. */
export function createStrikeBook() {
  const books = new WeakMap()
  const bookOf = (agent) => {
    let book = books.get(agent)
    if (book === undefined) {
      book = new Map()
      books.set(agent, book)
    }
    return book
  }
  return {
    count: (agent, key) => bookOf(agent).get(key) ?? 0,
    add: (agent, key) => {
      const next = (bookOf(agent).get(key) ?? 0) + 1
      bookOf(agent).set(key, next)
      return next
    },
    reached: (agent, key, limit) => (bookOf(agent).get(key) ?? 0) >= limit,
  }
}

/**
 * The detail injected back into the main agent on drift.
 * @param {string} reason
 * @param {string} userText
 * @returns {string}
 */
export function driftInjection(reason, userText) {
  return [
    DRIFT_MARK + ' 检测到本轮交付可能偏离用户需求。',
    '偏离原因:' + truncate(reason === '' ? '未给出' : reason, MAX_REASON_CHARS),
    '用户原话:' + truncate(userText, MAX_QUOTE_CHARS),
    '请按用户原需求重做;若确认没有偏离,用一句话说明理由即可。',
  ].join('\n')
}

/** The one-line steer hint sent with the injection. */
export function steerHint() {
  return '请按用户原需求重做这一次交付。'
}

/** The notice emitted once the strike limit is reached. */
export function limitNotice() {
  return (
    DRIFT_MARK +
    ' 同一问题已连续打回达到上限,本轮放行。请人工确认交付是否真的对上了用户需求。'
  )
}

function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return value.slice(0, max) + '…'
}
