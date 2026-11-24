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
  const subagents = {
    start: async () => {
      if (failStart) throw new Error('judge exploded')
      return {
        result: Promise.resolve({ stopReason, structured }),
        dispose: async () => {},
      }
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, handler) {
      handlers[name] = handler
    },
    get(name) {
      return name === 'subagents' ? subagents : undefined
    },
  }
  return { ctx, handlers }
}

const fire = (handlers, agent) => handlers['agent/turn-stopping']({ agent })

test('明确偏离时注入原因并 steer 主 agent', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: { verdict: 'drift', reason: '答非所问' } })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].startsWith(DRIFT_MARK))
  assert.ok(agent.injected[0].includes('答非所问'))
  assert.equal(agent.steered.length, 1)
})

test('未偏离时不注入任何东西', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: { verdict: 'pass', reason: '正常履约' } })
  apply(ctx)
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
  assert.equal(agent.steered.length, 0)
})

test('同一问题反复偏离:两次后达上限并放行', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: { verdict: 'drift', reason: '答非所问' } })
  apply(ctx, { maxStrikes: 2 })
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 1)
  assert.ok(agent.injected[0].includes('偏离原因'))
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 2)
  assert.ok(agent.injected[1].includes('达到上限'))
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 2, '达上限后不再注入')
})

test('没有 subagents seam 时放行且不抛错', async () => {
  const agent = makeAgent(TURN)
  const handlers = {}
  const ctx = {
    logger: { info() {}, warn() {} },
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
})

test('判定器启动失败或未完成时放行', async () => {
  for (const options of [{ failStart: true }, { structured: { verdict: 'drift', reason: 'x' }, stopReason: 'aborted' }]) {
    const agent = makeAgent(TURN)
    const { ctx, handlers } = makeCtx(options)
    apply(ctx)
    await fire(handlers, agent)
    assert.equal(agent.injected.length, 0)
  }
})

test('回答过短或缺少用户问题时完全跳过', async () => {
  const short = makeAgent([
    userMsg(1, '你好'),
    ev('turn/start', 2),
    assistantMsg(3, '好的'),
  ])
  const { ctx, handlers } = makeCtx({ structured: { verdict: 'drift', reason: 'x' } })
  apply(ctx)
  await fire(handlers, short)
  assert.equal(short.injected.length, 0)

  const empty = makeAgent([])
  await fire(handlers, empty)
  assert.equal(empty.injected.length, 0)
})

test('关闭开关后完全不介入', async () => {
  const agent = makeAgent(TURN)
  const { ctx, handlers } = makeCtx({ structured: { verdict: 'drift', reason: 'x' } })
  apply(ctx, { enabled: false })
  await fire(handlers, agent)
  assert.equal(agent.injected.length, 0)
})
