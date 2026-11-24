/**
 * dsh-drift-gate — the plugin row.
 *
 * Hangs on `agent/turn-stopping` only. At the end of each turn it reads the
 * session log, extracts (user request, final visible answer), and asks a
 * read-only subagent whether the answer clearly drifted. On drift it injects
 * the reason and steers the main agent to redo the delivery. Any judge
 * failure degrades to pass: a broken gate never blocks a normal close.
 *
 * @module dsh-drift-gate
 */

import {
  DEFAULT_MIN_CONFIDENCE,
  DRIFT_MARK,
  VERDICT_SCHEMA,
  createStrikeBook,
  createTurnBudget,
  driftInjection,
  extractTurnContext,
  judgePrompt,
  limitNotice,
  normalizeVerdict,
  sessionEvents,
  steerHint,
} from './core.js'

export const name = 'drift-gate'

const DEFAULTS = {
  /** Master switch. */
  enabled: true,
  /** Subagent provider used by the read-only judge. */
  provider: 'spawn',
  /** Agent preset, only needed on hosts that mount `startActivation`. */
  agentPreset: undefined,
  /** How many times one user question may be sent back before releasing. */
  maxStrikes: 2,
  /** Judge time budget. */
  timeoutMs: 45_000,
  /** Answers shorter than this are not judged at all. */
  minAnswerChars: 12,
  /** Confidence floor: a drift verdict below it is treated as pass. */
  minConfidence: 0.8,
  /** Tools the judge may use. Empty means a strictly no-tool, read-only judge. */
  allowTools: [],
  /** Steer the main agent to redo on drift; false keeps the gate inject-only. */
  steer: true,
}

/**
 * @param {object} ctx - the plugin context.
 * @param {object} [config] - the row config (see {@link DEFAULTS}).
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const strikes = createStrikeBook()
  const turnBudget = createTurnBudget()
  const logger = ctx.logger
  const minConfidence =
    Number.isFinite(cfg.minConfidence) && cfg.minConfidence >= 0 && cfg.minConfidence <= 1
      ? cfg.minConfidence
      : DEFAULT_MIN_CONFIDENCE

  async function judge(turn, agent, signal) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined || subagents === null) {
      logger?.warn?.('dsh-drift-gate: judge skipped: the subagents seam is not mounted')
      return { verdict: 'pass', reason: 'no subagents seam' }
    }
    const timeout = AbortSignal.timeout(cfg.timeoutMs)
    const signals = signal === undefined || signal === null ? [timeout] : [signal, timeout]
    const runSignal = AbortSignal.any(signals)
    const request = {
      label: 'drift-gate',
      prompt: [{ type: 'text', text: judgePrompt(turn) }],
      parent: agent,
      signal: runSignal,
      outputSchema: VERDICT_SCHEMA,
      // Enforce read-only: the judge only ever reads the two texts in its prompt.
      toolFilter: { allow: Array.isArray(cfg.allowTools) ? cfg.allowTools : [] },
    }
    let run
    try {
      if (typeof subagents.start === 'function') {
        run = await subagents.start(cfg.provider, request)
      } else if (
        typeof subagents.startActivation === 'function' &&
        cfg.agentPreset !== undefined
      ) {
        run = await subagents.startActivation({
          ...request,
          provider: cfg.provider,
          agentPreset: cfg.agentPreset,
          delivery: 'caller',
        })
      } else {
        logger?.warn?.('dsh-drift-gate: judge skipped: no compatible subagents seam')
        return { verdict: 'pass', reason: 'incompatible seam' }
      }
    } catch (error) {
      logger?.warn?.(`dsh-drift-gate: judge start failed: ${String(error)}`)
      return { verdict: 'pass', reason: 'judge unavailable' }
    }
    try {
      const result = await run.result
      if (result?.stopReason !== 'completed') {
        logger?.warn?.(`dsh-drift-gate: judge did not complete (${String(result?.stopReason)})`)
        return { verdict: 'pass', reason: 'judge not completed' }
      }
      const verdict = normalizeVerdict(result.structured, minConfidence)
      if (verdict.verdict !== 'drift' && verdict.degraded !== undefined) {
        logger?.warn?.(`dsh-drift-gate: judge degraded (${verdict.degraded}); treated as pass`)
      }
      return verdict
    } catch (error) {
      if (runSignal.aborted) {
        logger?.warn?.('dsh-drift-gate: judge aborted or timed out')
      } else {
        logger?.warn?.(`dsh-drift-gate: judge failed: ${String(error)}`)
      }
      return { verdict: 'pass', reason: 'judge failed' }
    } finally {
      try {
        await run.dispose?.()
      } catch {
        // A judge that cannot be disposed must not break the turn.
      }
    }
  }

  function deliver(agent, text) {
    agent.inject(text)
    if (cfg.steer === true && typeof agent.steer === 'function') agent.steer(steerHint())
  }

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (cfg.enabled !== true || agent === undefined || agent === null) return
    try {
      const turn = extractTurnContext(sessionEvents(agent.session))
      if (turn === null) return
      if (turn.assistantText.length < cfg.minAnswerChars) return
      if (turn.assistantText.includes(DRIFT_MARK)) return
      if (strikes.reached(agent, turn.turnKey, cfg.maxStrikes)) return
      if (turnBudget.used(agent, turn.turnId)) return
      turnBudget.mark(agent, turn.turnId)
      const verdict = await judge(turn, agent, signal)
      if (verdict.verdict !== 'drift') return
      strikes.add(agent, turn.turnKey)
      if (strikes.reached(agent, turn.turnKey, cfg.maxStrikes)) {
        logger?.info?.(`dsh-drift-gate: strike limit reached for this request (${cfg.maxStrikes})`)
        deliver(agent, limitNotice())
        return
      }
      logger?.info?.(`dsh-drift-gate: drift sent back: ${verdict.reason}`)
      deliver(agent, driftInjection(verdict.reason, turn.userText))
    } catch (error) {
      logger?.warn?.(`dsh-drift-gate: gate skipped: ${String(error)}`)
    }
  })

  logger?.info?.('dsh-drift-gate: installed (turn-stopping, read-only judge)')
}
