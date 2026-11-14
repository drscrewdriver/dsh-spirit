/**
 * tui-command.ts — `/spirit`：本体记忆的 dsh-tui 终端面（宿主斜杠命令）。
 *
 * 背景：dsh-tui 不加载插件 client 半边（星海 3D 面板 / pill 全部不执行），也调不到
 * 插件 RPC。于是「记忆里到底有什么」在终端里完全不可见。命令面只读投影：
 *   status  = 库是否打开、条目数、最近会话的注入计数
 *   recent  = 最近 N 条体验（experience 表，按 ts_ms 倒序）
 *   recall  = 关键词命中（LIKE，text/gist 双列）
 *
 * 契约（.agents/plans/dsh-tui-faces/spec.md §3）：单行 <=100、总行 <=40、无 ANSI、--json 单行。
 */

import type { Context } from '@deepseek-ai/cordis'

export type CommandKind = 'success' | 'error'
export interface CommandResult { kind: CommandKind; text: string }

export interface SpiritRow {
  ts_ms?: number
  lane?: string
  trigger?: string
  text?: string
}

export interface SpiritStatus {
  db: boolean
  entries: number
  ledger: number
  latest: { agentId: string; sessionId: string } | null
  session: Record<string, unknown> | null
  error?: string
}

export interface SpiritEntityRow {
  id?: string
  kind?: string
  name?: string
  importance?: number
  last_seen_ms?: number
}

export interface SpiritTxnRow {
  ts_ms?: number
  summary?: string
  card_line?: string
  source_trust?: string
}

export interface SpiritCommandDeps {
  status(): SpiritStatus
  recent(limit: number): SpiritRow[]
  recall(query: string, limit: number): SpiritRow[]
  /** 本体实体搜索（name LIKE）。 */
  entity(query: string, limit: number): SpiritEntityRow[]
  /** 最近事务/交付（txn_entry）。 */
  txn(limit: number): SpiritTxnRow[]
  /** 回响投影摘要（分段计数 + 最近步数）。 */
  echo(): { total: number; segments: Array<[string, number]>; steps: number; sessionId?: string }
}

const MAX_LINES = 40
const MAX_WIDTH = 100

export function clip(text: string, width = MAX_WIDTH): string {
  const value = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+$/, '')
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

export function renderLines(lines: string[], limit = MAX_LINES): string {
  const clipped = lines.map((line) => clip(line))
  if (clipped.length <= limit) return clipped.join('\n')
  const kept = clipped.slice(0, limit - 1)
  return [...kept, `… 还有 ${clipped.length - kept.length} 行，加 --all 查看`].join('\n')
}

const ok = (lines: string[]): CommandResult => ({ kind: 'success', text: renderLines(lines) })
const fail = (reason: string, next?: string): CommandResult =>
  ({ kind: 'error', text: renderLines([reason, ...(next ? [`  ${next}`] : [])]) })

function parse(rawInput: string): { argv: string[]; json: boolean; all: boolean; limit: number } {
  const argv: string[] = []
  let json = false
  let all = false
  let limit = 8
  for (const token of String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)) {
    if (token === '--json') json = true
    else if (token === '--all') all = true
    else if (/^--n=\d+$/.test(token)) limit = Math.min(40, Math.max(1, Number(token.slice(4))))
    else if (!token.startsWith('--')) argv.push(token)
  }
  return { argv, json, all, limit: all ? 40 : limit }
}

const HELP = [
  'spirit — 本体记忆（experience / ledger / 注入计数）的只读终端面',
  '  /spirit              库状态与最近会话的注入计数',
  '  /spirit recent        最近 8 条体验（--n=20 调数量，--all 取 40）',
  '  /spirit recall <q>    text/gist 关键词命中',
  '  /spirit entity <q>    本体实体（name LIKE）',
  '  /spirit txn           最近交付/事务（txn_entry）',
  '  /spirit echo          回响投影摘要（分段计数）',
  '  flags                --json 单行 JSON',
]

function day(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
}

function rowLine(row: SpiritRow): string {
  const trigger = clip(row.trigger || row.lane || '—', 12).padEnd(12)
  // 行宽预算（≤80 列）：2 缩进 + 16 时间 + 2 + 12 trigger + 2 + 44 正文
  return `  ${day(row.ts_ms)}  ${trigger}  ${clip(row.text || '', 44)}`
}

/** 纯函数入口。 */
export function runSpiritCommand(rawInput: string, deps: SpiritCommandDeps): CommandResult {
  const { argv, json, limit } = parse(rawInput)
  const sub = (argv[0] ?? 'status').toLowerCase()

  const wrap = (result: CommandResult, data: unknown): CommandResult => {
    if (!json) return result
    const body = result.kind === 'error'
      ? { ok: false, cmd: 'spirit', error: { message: result.text.split('\n')[0] ?? result.text } }
      : { ok: true, cmd: 'spirit', data }
    return { kind: result.kind, text: JSON.stringify(body) }
  }

  if (sub === 'help' || sub === '?') return wrap(ok(HELP), { help: true })

  if (sub === 'status' || sub === 'stats') {
    const status = deps.status()
    const session = status.session ?? {}
    const lines = [
      `spirit — 存储 ${status.db ? 'sqlite 已打开' : '内存降级'}  体验 ${status.entries} 条  账本 ${status.ledger} 条`,
    ]
    if (status.error) lines.push(`  warning    ${clip(status.error, 70)}`)
    if (status.latest === null) {
      lines.push('  latest     尚无会话记录（本机还没跑过注入）')
    } else {
      lines.push(`  latest     ${status.latest.sessionId.slice(-8)}  agent=${clip(status.latest.agentId, 20)}`)
      lines.push(`  counters   injected=${String(session.injectedTurns ?? '—')} bypassed=${String(session.bypassedTurns ?? '—')} off=${String(session.offTurns ?? '—')} confirmed=${String(session.confirmedTurns ?? '—')}`)
      lines.push(`  recall     lastHits=${String(session.lastRecallHits ?? '—')}  cardBytes=${String(session.lastCardBytes ?? '—')}`)
    }
    lines.push('  use        /spirit recent  ·  /spirit recall <关键词>')
    return wrap(ok(lines), status)
  }

  if (sub === 'recent') {
    const rows = deps.recent(limit)
    if (rows.length === 0) return wrap(ok(['spirit recent — 库里还没有体验条目']), { rows: 0 })
    return wrap(ok([`spirit recent — 最近 ${rows.length} 条`, ...rows.map(rowLine)]), { rows })
  }

  if (sub === 'recall') {
    const query = argv.slice(1).join(' ').trim()
    if (query === '') return wrap(fail('spirit recall: 缺少关键词', 'next: /spirit recall <关键词>'), {})
    const rows = deps.recall(query, limit)
    if (rows.length === 0) return wrap(ok([`spirit recall — 无命中："${query}"`]), { query, rows: 0 })
    return wrap(ok([`spirit recall — "${query}" 命中 ${rows.length} 条`, ...rows.map(rowLine)]), { query, rows })
  }

  if (sub === 'entity') {
    const query = argv.slice(1).join(' ').trim()
    if (query === '') return wrap(fail('spirit entity: 缺少关键词', 'next: /spirit entity <名称片段>'), {})
    const rows = deps.entity(query, limit)
    if (rows.length === 0) return wrap(ok([`spirit entity — 无命中："${query}"`]), { query, rows: 0 })
    const lines = [`spirit entity — "${query}" 命中 ${rows.length} 个`]
    for (const row of rows) {
      const importance = typeof row.importance === 'number' ? `w=${row.importance}` : ''
      lines.push(`  ${clip(row.kind ?? '—', 10).padEnd(10)}  ${clip(row.name ?? '', 40).padEnd(40)}  ${importance}`)
    }
    return wrap(ok(lines), { query, rows })
  }

  if (sub === 'txn') {
    const rows = deps.txn(limit)
    if (rows.length === 0) return wrap(ok(['spirit txn — 还没有交付/事务记录']), { rows: 0 })
    const lines = [`spirit txn — 最近 ${rows.length} 条交付`]
    for (const row of rows) {
      lines.push(`  ${day(row.ts_ms)}  ${clip(String(row.source_trust ?? ''), 8).padEnd(8)}  ${clip(row.summary || row.card_line || '', 44)}`)
    }
    return wrap(ok(lines), { rows })
  }

  if (sub === 'echo') {
    const echo = deps.echo()
    if (echo.total === 0 && echo.steps === 0) {
      return wrap(ok(['spirit echo — 还没有回响记录', '  next 回响随注入累积；先在会话里跑一轮']), echo)
    }
    const lines = [
      `spirit echo — 共 ${echo.total} 条  最近轮次 ${echo.steps}${echo.sessionId ? `  session=${echo.sessionId.slice(-8)}` : ''}`,
    ]
    const segments = echo.segments.filter(([, count]) => count > 0)
    if (segments.length > 0) {
      lines.push(`  segments   ${segments.map(([name, count]) => `${name}=${count}`).join('  ')}`)
    } else {
      lines.push('  segments   （无分段计数）')
    }
    return wrap(ok(lines), echo)
  }

  return wrap(fail(`spirit: 未知子命令 "${sub}"`, 'next: /spirit help'), {})
}

/** 注册 `/spirit`：无 commands 服务时静默跳过（老线安全）。 */
export function registerSpiritCommand(ctx: Context, deps: SpiritCommandDeps): void {
  const registry = (ctx as unknown as { commands?: { register(definition: unknown): unknown } }).commands
  if (!registry || typeof registry.register !== 'function') return
  registry.register({
    definitionId: 'dsh-spirit',
    name: 'spirit',
    description: 'Spirit memory console: storage status / recent experiences / keyword recall (read-only)',
    input: { hint: '[status|recent|recall <q>|entity <q>|txn|echo] [--n=20] [--all] [--json]' },
    handler: (invocation: { rawInput?: string }) => runSpiritCommand(invocation?.rawInput ?? '', deps),
  })
}
