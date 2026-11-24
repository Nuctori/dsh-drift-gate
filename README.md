# dsh-drift-gate

极简需求漂移门禁。每轮收尾前，用一个**只读**子代理只干一件事：判断这一轮的最终可见回答**是否明确偏离**了用户这一轮的需求。偏离 → 把原因注入回去并 steer 主 agent 继续改；没偏离 → 静默放行。

它不判断代码好不好、不要求测试、不查覆盖率、不读工作区文件。

## 机制

只看两段文本，其余一律忽略：

| 取什么 | 从哪取 |
|---|---|
| 用户需求 | 最后一个 `turn/start` 之前最近的一条 `user/message` |
| 交付回答 | 该边界之后最后一条**含可见文本块**的 `assistant/message`（`reasoning` 与 `tool-call` 块丢弃） |

- 触发点：`agent/turn-stopping`（回合收尾前），不阻断收尾。
- 判定者：`ctx.get('subagents').start('spawn', …)`，`outputSchema` 强制返回 `{verdict:'pass'|'drift', reason}`。
- 打回：`agent.inject(原因)` + `agent.steer(提示)`；同一用户问题默认最多打回 2 次，之后注入一行「已达上限，本轮放行」。
- 失败即放行：子代理缺失、超时、未完成、返回非法 → 一律 `pass`，绝不把正常回合搞挂。
- 自我过滤：注入文本以 `[drift-gate]` 开头，下一轮定位用户问题时会跳过它。

## 安装

```sh
dsh plugin --profile <name> add D:\projects\dsh-drift-gate
```

装完重启该 profile 的宿主（桌面端 / web），插件行随 profile 激活。

验证已加载：

```sh
dsh --profile <name> --dump-config | findstr drift-gate
```

## 配置

在 profile patch 里覆盖本行 config：

```yaml
- insert:
    - id: drift-gate
      name: 'dsh-drift-gate'
      config:
        maxStrikes: 2
        timeoutMs: 45000
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `provider` | `'spawn'` | 判定子代理的 provider |
| `agentPreset` | `undefined` | 仅宿主使用 `startActivation` 时需要 |
| `maxStrikes` | `2` | 同一用户问题最多打回次数 |
| `timeoutMs` | `45000` | 判定超时，超时按 pass |
| `minAnswerChars` | `12` | 更短的回答不判 |

## 测试

```sh
node --test
```

15 个用例覆盖：问答抽取（忽略 reasoning/tool-call）、自我提醒过滤、无 `turn/start` 老日志、偏离注入、pass 静默、连续打回上限、子代理缺失/失败/超时降级、开关关闭。

## 限制

- 判定是语义判断，不是形式验证；提示词刻意偏保守（不确定就 pass）。
- `agent/turn-stopping` 是建议性边界，不保证能阻止回合提交；这里的「打回」是让主 agent 继续工作，不是硬拦截。
- 只读判定者不携带工具过滤；提示词明确禁止使用工具，若宿主仍允许它调工具，可能产生额外调用。
