# Cache keep-warm

Keeps one idle session's provider prompt cache alive, without putting anything
in the conversation.

A long conversation is expensive to resume: the provider re-reads the whole
context, and on a cache miss it also writes it again. Providers keep that cache
for about an hour, and the hit rate decays the whole time. This plugin spends a
little money to keep it: every 50 minutes of silence it asks the app to replay
the session's last real request plus the words `Reply with OK.`, reads the usage
the provider reports, and stops before the model answers.

## What you see

One control on the right of the composer, for the session in front of you:

```
缓存保活 · 下次 15:20 · 今日 $0.09      ← on
缓存保活                                ← off
已停止：缓存未命中                       ← stopped, with the reason
```

Click it to switch the session on or off. The switch is per session, and off by
default.

The request asks for exactly what the last real turn asked for — same model, same
thinking level, same output ceiling, same headers — and only appends "Reply with
OK." A smaller output ceiling would look cheaper and be wrong: on a gateway that
turns an OpenAI-Responses reasoning request into Anthropic thinking, a lower
`max_tokens` changes the thinking budget and breaks the cached prefix the request
exists to refresh.

## When it stops by itself

| limit | default | why |
| --- | --- | --- |
| consecutive requests without a real turn | 4 | a conversation nobody returns to should not be paid for forever |
| spend per session per local day | $1 | the ceiling a user can reason about |
| one request's cache-read share | 50% | below this the prefix was rewritten: the cache is gone, not warm |
| the local day's spend | $1 | a real turn resets the streak, never the day's bill |
| context size | 20k tokens | a small context is cheap to rebuild; refreshing it is waste |

A real turn in the session resets the streak and revives a stopped schedule.

The plugin holds no session-read permission: a session's model is named by the
host's own answer, so choosing "Claude only" costs one request on a session that
turns out to run something else, and nothing after that.

## What the host refuses

The plugin schedules; the app decides. It answers `skipped` with a reason, and
the control shows it:

`尚无真实请求` · `会话正忙` · `模型已更换` · `提示词已变化` · `缓存已过期` ·
`上下文太短` · `协议不支持` · `会话不可用`

## What it costs, and where that is recorded

The request is a real provider request with the same model, thinking level and
headers as a real turn — anything else would write a new cache entry instead of
reading the old one, and the user would pay for both. Its usage is recorded in the
app's own ledger (a table of its own: it belongs to no turn and must never appear
as one), and the plugin keeps a small per-session record of the switch, today's
spend, the streak and the stop reason.

## Settings

| key | default | meaning |
| --- | --- | --- |
| `intervalMinutes` | 50 | silence before a refresh; 30–55 |
| `maxConsecutive` | 4 | requests in a row before stopping |
| `dailyCostLimitUsd` | 1 | per session, per local day |
| `modelScope` | `anthropic` | Claude only, Claude and GPT, or every model |

## Requirements

An app version with session keep-warm (`>=1.2.0`; that API does not exist in
1.1.x, and the control says "app version too old" instead of failing to load),
a provider that caches long prompts (Claude does, for about an hour), and a
session with at least 20k tokens of context.

## Tests

```bash
node --test tests/*.test.mjs
```

`tests/keepwarm.test.mjs` covers the scheduling rules as pure functions,
`tests/scheduler.test.mjs` drives the plugin process against a fake host with
`node:test` mock timers (no test waits for real time), and
`tests/manifest.test.mjs` pins the published decisions.
