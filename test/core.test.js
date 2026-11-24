import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DRIFT_MARK,
  createStrikeBook,
  driftInjection,
  extractTurnContext,
  judgePrompt,
  limitNotice,
  normalizeVerdict,
  turnKeyOf,
} from '../lib/core.js'

const ev = (type, seq, data = {}) => ({ type, seq, time: seq, data })
const userMsg = (seq, text) =>
  ev('user/message', seq, { message: { role: 'user', content: [{ type: 'text', text }] } })
const assistantMsg = (seq, blocks) =>
  ev('assistant/message', seq, { message: { role: 'assistant', content: blocks } })

test('取本轮用户问题与最后一条带文本的助手回复,忽略推理与工具调用', () => {
  const events = [
    userMsg(1, '帮我写一个门禁插件'),
    ev('turn/start', 2),
    assistantMsg(3, [{ type: 'reasoning', text: '思考中' }, { type: 'tool-call', name: 'read' }]),
    assistantMsg(4, [
      { type: 'reasoning', text: '继续想' },
      { type: 'text', text: '已经写好并测试通过' },
    ]),
    ev('turn/end', 5),
  ]
  const turn = extractTurnContext(events)
  assert.equal(turn.userText, '帮我写一个门禁插件')
  assert.equal(turn.assistantText, '已经写好并测试通过')
  assert.equal(turn.turnKey, turnKeyOf('帮我写一个门禁插件'))
})

test('忽略上一轮注入的 drift-gate 提醒,不把它当用户问题', () => {
  const events = [
    userMsg(1, '帮我写一个门禁插件'),
    ev('turn/start', 2),
    assistantMsg(3, [{ type: 'text', text: '第一版' }]),
    userMsg(4, DRIFT_MARK + ' 检测到本轮交付可能偏离用户需求。'),
    ev('turn/start', 5),
    assistantMsg(6, [{ type: 'text', text: '第二版' }]),
  ]
  const turn = extractTurnContext(events)
  assert.equal(turn.userText, '帮我写一个门禁插件')
  assert.equal(turn.assistantText, '第二版')
})

test('没有 turn/start 的老日志取最后一条问答', () => {
  const events = [
    userMsg(1, '旧问题'),
    assistantMsg(2, [{ type: 'text', text: '旧回答' }]),
    userMsg(3, '新问题'),
    assistantMsg(4, [{ type: 'text', text: '新回答' }]),
  ]
  const turn = extractTurnContext(events)
  assert.equal(turn.userText, '新问题')
  assert.equal(turn.assistantText, '新回答')
})

test('缺用户问题或缺助手文本时返回 null', () => {
  assert.equal(extractTurnContext([]), null)
  assert.equal(extractTurnContext([assistantMsg(1, [{ type: 'text', text: '只有回答' }])]), null)
  assert.equal(
    extractTurnContext([userMsg(1, '只有问题'), ev('turn/start', 2)]),
    null,
  )
  assert.equal(
    extractTurnContext([
      userMsg(1, '只有问题'),
      ev('turn/start', 2),
      assistantMsg(3, [{ type: 'reasoning', text: '纯思考没有可见文本' }]),
    ]),
    null,
  )
})

test('normalizeVerdict 只接受 drift,理由为空或未知形态一律回落 pass', () => {
  assert.deepEqual(normalizeVerdict({ verdict: 'drift', reason: '答非所问' }), {
    verdict: 'drift',
    reason: '答非所问',
  })
  assert.equal(normalizeVerdict({ verdict: 'drift', reason: '   ' }).verdict, 'pass')
  assert.equal(normalizeVerdict({ verdict: 'PASS' }).verdict, 'pass')
  assert.equal(normalizeVerdict({ verdict: 'drift' }).verdict, 'pass')
  assert.equal(normalizeVerdict(null).verdict, 'pass')
  assert.equal(normalizeVerdict('drift').verdict, 'pass')
})

test('判定提示只含两段文本,并各自截断', () => {
  const prompt = judgePrompt({ userText: 'used'.repeat(2000), assistantText: 'asis'.repeat(3000) })
  assert.ok(!prompt.includes('tool/call'))
  assert.ok(prompt.includes('用户需求'))
  assert.ok(prompt.includes('交付回答'))
  assert.ok(prompt.length < 7000)
})

test('打回次数按用户问题累计,达到上限后不再打回', () => {
  const book = createStrikeBook()
  const agent = {}
  const other = {}
  const key = 'k'
  assert.equal(book.count(agent, key), 0)
  assert.equal(book.reached(agent, key, 2), false)
  book.add(agent, key)
  assert.equal(book.count(agent, key), 1)
  book.add(agent, key)
  assert.equal(book.reached(agent, key, 2), true)
  assert.equal(book.count(other, key), 0, '计数按 agent 隔离')
})

test('注入文本带固定标记,便于下一轮过滤', () => {
  assert.ok(driftInjection('答非所问', '原问题').startsWith(DRIFT_MARK))
  assert.ok(limitNotice().startsWith(DRIFT_MARK))
  assert.ok(driftInjection('x'.repeat(500), 'y'.repeat(500)).length < 800)
})
