import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { DRIFT_MARK } from '../lib/core.js'

const ev = (type, seq, data = {}) => ({ type, seq, data })
const userMsg = (seq, text) =>
  ev('user/message', seq, { message: { role: 'user', content: [{ type: 'text', text }] } })
const assistantMsg = (seq, text) =>
  ev('assistant/message', seq, { message: { role: 'assistant', content: [{ type: 'text', text }] } })

const TURN = [
  userMsg(1, '把 D 盘那个插件的红门禁改成按用户问题累计'),
  ev('turn/start', 2),
  assistantMsg(3, '好的,今天天气不错,顺便聊一下别的话题。'),
]

const drift = (confidence = 0.9) => ({ verdict: 'drift', reason: '答非所问', confidence })

function makeAgent(events) {
  return {
    session: { snapshotEvents: () => events },
    injected: [],
    steered: [],
    inject(text) {
      this.injected.push(text)
    },
    steer(text) {
      this.steered.push(text)
    },
  }
}

function makeCtx({ structured, failStart = false, stopReason = 'completed' } = {}) {
  const handlers = {}
  const calls = []
  const warns = []
  const subagents = {
    start: async (provider, request) => {
      calls.push({ provider, request })
      if (failStart) throw new Error('judge exploded')
      return { result: Promise.resolve({ stopReason, structured }), dispose: async () => {} }
    },
  }
  const ctx = {
    logger: { info() {}, warn: (message) => warns.push(String(message)) },
    on(name, handler) {
      handlers[name] = handler
    },
    get(name) {
      return name === 'subagents' ? subagents : undefined
    },
  }
  return { ctx, handlers, calls, warns }
}

const fire = (handlers, agent) => handlers['agent/turn-stopping']({ agent })

test('明确偏离时注入原因并 steer 主 agent', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: drift(0.9) })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].startsWith(DRIFT_MARK))
  assert.ok(agent.injected[0].includes('答非所问'))
  assert.equal(agent.steered.length, 1)
})

test('判定请求强制只读:携带 toolFilter 且默认不允许任何工具', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers, calls } = makeCtx({ structured: { verdict: 'pass', reason: '正常', confidence: 0.9 } })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].request.toolFilter, { allow: [] })
})

test('自定义 allowTools 透传到 toolFilter', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers, calls } = makeCtx({ structured: { verdict: 'pass', reason: '正常', confidence: 0.9 } })
  apply(ctx, { allowTools: ['read'] })
  await fire(handlers, agent)
  assert.deepEqual(calls[0].request.toolFilter, { allow: ['read'] })
})

test('同一 turn 只判定一次,重复触发不再调用判定器', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers, calls } = makeCtx({ structured: { verdict: 'pass', reason: '正常', confidence: 0.9 } })
  apply(ctx)
  await fire(handlers, agent)
  await fire(handlers, agent)
  assert.equal(calls.length, 1)
})

test('新的 turn 重新获得一次判定预算', async () => {
  const events = [...TURN]
  const agent = makeAgent(events)
  const { ctx, handlers, calls } = makeCtx({ structured: { verdict: 'pass', reason: '正常', confidence: 0.9 } })
  apply(ctx)
  await fire(handlers, agent)
  events.push(ev('turn/start', 10), assistantMsg(11, '这是第二轮的完整交付回答内容,已按要求完成'))
  await fire(handlers, agent)
  assert.equal(calls.length, 2)
})

test('未偏离时不注入任何东西', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: { verdict: 'pass', reason: '正常履约', confidence: 0.9 } })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
  assert.equal(agent.steered.length, 0)
})

test('低置信或缺失置信度的 drift 一律放行,并各记一条 warn', async () => {
  for (const structured of [drift(0.5), { verdict: 'drift', reason: '可能是跑题' }]) {
    const agent = makeAgent(TURN)
    const { ctx, handlers, warns } = makeCtx({ structured })
    apply(ctx)
    await fire(handlers, agent)
    assert.equal(agent.injected.length, 0, JSON.stringify(structured))
    assert.equal(warns.length, 1, JSON.stringify(structured))
  }
})

test('非法结构化输出按 pass 放行并记一条 warn', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers, warns } = makeCtx({ structured: { verdict: 'maybe', reason: '?' } })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
  assert.equal(warns.length, 1, '越界裁决要留痕,但不得打回')
})

test('同一问题反复偏离:两次后达上限并放行', async () => {
  const events = [...TURN]
  const agent = makeAgent(events)
  const { ctx, handlers } = makeCtx({ structured: drift(0.9) })
  apply(ctx, { maxStrikes: 2 })
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].includes('偏离原因'))
  events.push(ev('turn/start', 10), assistantMsg(11, '第二次还是跑题的回答内容'))
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 2)
  assert.ok(agent.injected[1].includes('达到上限'))
  events.push(ev('turn/start', 12), assistantMsg(13, '第三次仍然跑题的回答'))
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 2, '达上限后不再注入')
})

test('没有 subagents seam 时放行,并记一条 warn', async () => {
  const agent = makeAgent(TURN)
  const handlers = {}
  const warns = []
  const ctx = {
    logger: { info() {}, warn: (message) => warns.push(String(message)) },
    on(name, handler) {
      handlers[name] = handler
    },
    get() {
      return undefined
    },
  }
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
  assert.equal(warns.length, 1)
})

test('判定器启动失败时放行并记一条 warn', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers, warns } = makeCtx({ failStart: true })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
  assert.equal(warns.length, 1)
})

test('判定未完成时放行且不抛错', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: drift(0.9), stopReason: 'aborted' })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
})

test('steer 可关闭:只注入不强制返工', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: drift(0.9) })
  apply(ctx, { steer: false })
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 1)
  assert.equal(agent.steered.length, 0)
})

test('回答过短或缺少用户问题时完全跳过', async () => {
  const short = makeAgent([
    userMsg(1, '你好'),
    ev('turn/start', 2),
    assistantMsg(3, '好的'),
  ])
  const { ctx, handlers } = makeCtx({ structured: drift(0.9) })
  apply(ctx)
  await fire(handlers, short)
  assert.equal(short.injected.length, 0)

  const empty = makeAgent([])
  await fire(handlers, empty)
  assert.equal(empty.injected.length, 0)
})

test('关闭开关后完全不介入', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: drift(0.9) })
  apply(ctx, { enabled: false })
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
})
