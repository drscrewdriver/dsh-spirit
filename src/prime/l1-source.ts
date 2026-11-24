/**
 * 上游记忆库（L1 蒸馏层）**唯一**只读消费面（v0.8.18，边界经用户明确授权变更）。
 *
 * 背景：`spirit_memory` 只读自己主动写进去的两本账 + 日记；而这一周真正发生的事多数落在
 * 上游蒸馏层 L1（work_fact / work_task / work_method / work_artifact / tool_experience …），
 * 只有上游的 memory_search 看得到——用户实报 recall 这周 0 条、生涯召回声断。
 *
 * 边界（写死在这里，别处不许再碰）：
 * 1. 只读：readOnly 打开上游库，绝不写、不建表、不加锁；
 * 2. 表不在就空：上游未装/改版 ⇒ []（不报错、不假装有数据）；
 * 3. 只此一处：路径与 schema 字样只允许出现在本文件（门禁 task_7.3 收口）；
 * 4. 路径可配：默认 `~/.dsh/memory/memory.db`，`SPIRIT_DISTILL_DB` 可覆盖（测试/换机）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 上游记忆库默认路径。 */
export const PRIME_MEMORY_DB = '~/.dsh/memory/memory.db';

/** 一条上游 L1 记录（只读投影）。 */
export interface L1RecordRow {
  id: string;
  /** L1 类型：work_fact / work_task / work_method / work_artifact / tool_experience … */
  type: string;
  /** family：work（工作）/ chat（聊天面） */
  family: string;
  content: string;
  tsMs: number;
  /** 工作区（v0.8.24：L1→本体重建用）。 */
  workspaceId?: string;
  /** 仓库名/owner（v0.8.24：实体串联用）。 */
  repoKey?: string;
  /** 上游会话 id（v0.8.25：按会话组织流程档）。 */
  sessionId: string;
  /**
   * 重要度原值（v0.10，上游 0-100 的 priority）。
   *
   * 这是「温度」的来源之一：上游已经替我们判过哪些事更重要，重算一遍只会得到第二个真源。
   * 缺列/坏值 ⇒ undefined（不拿 0 冒充"不重要"）。
   */
  priority?: number;
  /** 持久性档（上游单字符：`t` 临时 / `p` … / `s` … / `o` …；空串 = 未标注）。 */
  persistence?: string;
  /** 失效时刻（ISO；非空 = 上游已判这条不再成立，编年要标"曾经的看法"而不是删掉）。 */
  validTo?: string;
}

/**
 * 上游「温度」读面（v0.10）：一条 L1 记录在它自己库里的重要度/持久性/失效。
 *
 * 为什么单独开一个只读投影而不是塞进 `L1RecordRow` 的既有消费者：
 * 交付重建（l1-ingest）只关心正文，温度只有编年关心；两者混在一张宽行里，
 * 会让"重建"这条热路径多读三列、也让温度一旦改口径就波及交付。
 */
export interface L1WarmthRow {
  id: string;
  type: string;
  family: string;
  content: string;
  tsMs: number;
  priority: number | undefined;
  persistence: string;
  validTo: string;
  workspaceId: string;
  /** 真会话 id（与 `L1RecordRow.sessionId` 同口径）。 */
  sessionId: string;
}

/** 解析实际库路径（env 覆盖优先）。 */
export function primeMemoryDbPath(): string {
  const override = process.env['SPIRIT_DISTILL_DB'];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return path.join(os.homedir(), '.dsh', 'memory', 'memory.db');
}

function openReadOnly(dbPath: string): DatabaseSync | undefined {
  try {
    if (!fs.existsSync(dbPath)) return undefined;
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return undefined;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 列存在性检测（上游 schema 跨版本差异：老库可能没有 session_id）。 */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    return rows.some((row) => String(row['name'] ?? '') === column);
  } catch {
    return false;
  }
}

function toRow(raw: Record<string, unknown>): L1RecordRow {
  const iso = String(raw['stamp'] ?? '');
  const parsed = iso === '' ? NaN : Date.parse(iso);
  return {
    id: String(raw['record_id'] ?? ''),
    type: String(raw['type'] ?? ''),
    family: String(raw['family'] ?? ''),
    content: String(raw['content'] ?? ''),
    tsMs: Number.isFinite(parsed) ? parsed : 0,
    workspaceId: String(raw['workspace_id'] ?? ''),
    repoKey: String(raw['repo_key_name'] ?? ''),
    sessionId: sessionIdOf(raw),
  };
}

/**
 * 会话 id 的真实位置（v0.8.25 实证）：上游 `session_id` 列恒为 `default`，
 * 真会话在 `metadata_json.dsh_source_anchors[].sessionId`。锚点优先，列值兜底。
 */
function sessionIdOf(raw: Record<string, unknown>): string {
  const meta = String(raw['metadata_json'] ?? '');
  if (meta !== '') {
    try {
      const parsed: unknown = JSON.parse(meta);
      const anchors = (parsed as { dsh_source_anchors?: unknown }).dsh_source_anchors;
      if (Array.isArray(anchors)) {
        for (const anchor of anchors) {
          const id = (anchor as { sessionId?: unknown }).sessionId;
          if (typeof id === 'string' && id.trim() !== '' && id.trim() !== 'default') return id.trim();
        }
      }
    } catch {
      /* 坏 JSON ⇒ 回落列值 */
    }
  }
  const column = String(raw['session_id'] ?? '').trim();
  return column === 'default' ? '' : column;
}

/** 上游实体投影（v0.8.18）：graph_nodes 的名/别名 + 记录里的仓库/工作区键。 */
export interface L1EntityRow {
  name: string;
  aliases: string[];
  repoKey: string;
  workspaceId: string;
}

/**
 * 读上游实体线索（只读、缺表缺列 ⇒ []）。
 * graph_nodes 结构不稳定，按行防御式取 name/aliases；另扫记录里的 repo/workspace 键。
 */
export function loadL1Entities(dbPath?: string): L1EntityRow[] {
  const path = dbPath ?? primeMemoryDbPath();
  const db = openReadOnly(path);
  if (db === undefined) return [];
  const out: L1EntityRow[] = [];
  const seen = new Set<string>();
  const push = (name: string, aliases: string[], repoKey: string, workspaceId: string): void => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    const key = `${trimmed}\u0000${repoKey}\u0000${workspaceId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: trimmed, aliases: aliases.filter((item) => item.trim() !== ''), repoKey, workspaceId });
  };
  try {
    const nodes = db.prepare(`SELECT * FROM graph_nodes LIMIT 500`).all() as Array<Record<string, unknown>>;
    for (const node of nodes) {
      const name = String(node['name'] ?? node['label'] ?? '');
      let aliases: string[] = [];
      for (const column of ['aliases_json', 'aliases']) {
        const raw = node[column];
        if (typeof raw === 'string' && raw.trim() !== '') {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) aliases = parsed.map((item) => String(item));
          } catch {
            aliases = raw.split(/[,，;；]/u).map((item) => item.trim()).filter((item) => item !== '');
          }
          break;
        }
        if (Array.isArray(raw)) { aliases = raw.map((item) => String(item)); break; }
      }
      push(name, aliases, '', '');
    }
  } catch {
    /* graph_nodes 不存在/结构不同：跳过 */
  }
  try {
    const rows = db.prepare(
      `SELECT DISTINCT repo_key_name, repo_key_owner, workspace_id FROM l1_records
       WHERE repo_key_name <> '' OR workspace_id <> '' LIMIT 500`,
    ).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const owner = String(row['repo_key_owner'] ?? '');
      const repo = String(row['repo_key_name'] ?? '');
      push(repo !== '' ? repo : owner, owner !== '' && owner !== repo ? [owner] : [], repo, String(row['workspace_id'] ?? ''));
    }
  } catch {
    /* l1_records 结构不同：跳过 */
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
  return out;
}

/**
 * 读上游「带温度」的 L1 行（v0.10：编年的另一路供给）。
 *
 * 与 `searchL1Records` 的分工：那个面按关键词/会话找**内容**（重建、摘要用），
 * 这个面按时间窗找**经历**，且必须带上 priority / persistence / valid_to 三列——
 * 否则编年只能给出"一条条冷记录"，也就是这次重定位要治的病。
 *
 * 三列都按"缺列/坏值 ⇒ 缺省"处理：上游改版少一列时，编年只是变淡，不报错。
 *
 * @param opts.days - 回看天数（默认 30；0 = 全史）
 * @param opts.limit - 条数上限（默认 400，封顶 2000）
 * @param opts.family - 只要某个 family（`chat` 用来取"关于这个人"的那批）
 * @param opts.dbPath - 覆盖库路径（测试/换机）
 */
export function searchL1WarmRows(opts: {
  days?: number;
  limit?: number;
  family?: string;
  dbPath?: string;
} = {}): L1WarmthRow[] {
  const dbPath = opts.dbPath ?? primeMemoryDbPath();
  const db = openReadOnly(dbPath);
  if (db === undefined) return [];
  const days = Number.isFinite(opts.days) ? Math.max(0, Math.floor(opts.days as number)) : 30;
  const cap = Math.max(1, Math.min(2000, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 400)));
  const conds: string[] = [];
  const params: unknown[] = [];
  const family = (opts.family ?? '').trim();
  if (family !== '' && hasColumn(db, 'l1_records', 'family')) {
    conds.push('family = ?');
    params.push(family);
  }
  if (days > 0) {
    conds.push(`COALESCE(NULLIF(timestamp_start, ''), created_time) >= ?`);
    params.push(new Date(Date.now() - days * 86_400_000).toISOString());
  }
  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
  const col = (name: string): string => (hasColumn(db, 'l1_records', name) ? name : `'' AS ${name}`);
  const priorityCol = hasColumn(db, 'l1_records', 'priority') ? 'priority' : `NULL AS priority`;
  try {
    const rows = db
      .prepare(
        `SELECT record_id, type, ${col('family')}, content,
                ${priorityCol}, ${col('persistence')}, ${col('valid_to')},
                ${col('workspace_id')}, ${col('session_id')}, ${col('metadata_json')},
                COALESCE(NULLIF(timestamp_start, ''), created_time) AS stamp
         FROM l1_records${where}
         ORDER BY stamp DESC LIMIT ?`,
      )
      .all(...([...params, cap] as never[])) as Array<Record<string, unknown>>;
    return rows
      .map((raw) => {
        const iso = String(raw['stamp'] ?? '');
        const tsMs = iso === '' ? NaN : Date.parse(iso);
        const prio = Number(raw['priority']);
        return {
          id: String(raw['record_id'] ?? ''),
          type: String(raw['type'] ?? ''),
          family: String(raw['family'] ?? ''),
          content: String(raw['content'] ?? ''),
          tsMs: Number.isFinite(tsMs) ? tsMs : 0,
          // 0 是上游的合法值但语义上等于"没标注"，一律当缺省——不拿 0 冒充"不重要"
          priority: Number.isFinite(prio) && prio > 0 ? prio : undefined,
          persistence: String(raw['persistence'] ?? ''),
          validTo: String(raw['valid_to'] ?? ''),
          workspaceId: String(raw['workspace_id'] ?? ''),
          sessionId: sessionIdOf(raw),
        } satisfies L1WarmthRow;
      })
      .filter((row) => row.id !== '' && row.content !== '' && row.tsMs > 0);
  } catch {
    // 表不在/结构变了：如实空（不假装有数据）
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
}

/**
 * 上游 L1 的全量类型目录（v0.10：编年按"温度"分档时要先知道有哪些 type）。
 * 缺表 ⇒ []。只回 name + count，不带任何正文。
 */
export function loadL1TypeCounts(dbPath?: string): Array<{ type: string; count: number }> {
  const db = openReadOnly(dbPath ?? primeMemoryDbPath());
  if (db === undefined) return [];
  try {
    const rows = db.prepare(`SELECT type, COUNT(*) AS n FROM l1_records GROUP BY type ORDER BY n DESC`).all() as Array<Record<string, unknown>>;
    return rows
      .map((row) => ({ type: String(row['type'] ?? ''), count: Number(row['n'] ?? 0) }))
      .filter((row) => row.type !== '' && row.count > 0);
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* 已关 */ }
  }
}

/**
 * 搜上游 L1 记录（文本包含 + 时间窗）。
 *
 * @param opts.q - 关键词（LIKE 字面量；省略 = 不限文本）
 * @param opts.days - 回看天数（默认 7；0 = 全史）
 * @param opts.limit - 条数上限（默认 20，封顶 2000——重建/摘要按会话分页需要大上限）
 * @param opts.sessionId - 只取某会话（v0.8.25：会话级组织）
 * @param opts.dbPath - 覆盖库路径（测试用）
 */
export function searchL1Records(opts: {
  q?: string;
  days?: number;
  limit?: number;
  sessionId?: string;
  dbPath?: string;
} = {}): L1RecordRow[] {
  const dbPath = opts.dbPath ?? primeMemoryDbPath();
  const db = openReadOnly(dbPath);
  if (db === undefined) return [];
  const keyword = (opts.q ?? '').trim();
  const days = Number.isFinite(opts.days) ? Math.floor(opts.days as number) : 7;
  const cap = Math.max(1, Math.min(2000, Math.floor(Number.isFinite(opts.limit) ? (opts.limit as number) : 20)));
  const conds: string[] = [];
  const params: unknown[] = [];
  if (keyword !== '') {
    conds.push(`content LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(keyword)}%`);
  }
  const sessionId = (opts.sessionId ?? '').trim();
  const hasSession = hasColumn(db, 'l1_records', 'session_id');
  const hasMeta = hasColumn(db, 'l1_records', 'metadata_json');
  if (sessionId !== '') {
    // 列值不可作会话真相（恒为 default）；带 sessionId 过滤时按元数据锚点兜底。
    if (!hasSession && !hasMeta) {
      try { db.close(); } catch { /* 已关 */ }
      return [];
    }
  }
  if (days > 0) {
    // ISO 字符串可直接字典序比较（上游存的就是 ISO）
    conds.push(`COALESCE(NULLIF(timestamp_start, ''), created_time) >= ?`);
    params.push(new Date(Date.now() - days * 86_400_000).toISOString());
  }
  const where = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
  try {
    const rows = db
      .prepare(
        `SELECT record_id, type, family, content, ${hasSession ? 'session_id' : `'' AS session_id`},
                ${hasMeta ? 'metadata_json' : `'' AS metadata_json`},
                workspace_id, repo_key_name,
                COALESCE(NULLIF(timestamp_start, ''), created_time) AS stamp
         FROM l1_records${where}
         ORDER BY stamp DESC LIMIT ?`,
      )
      .all(...([...params, cap] as never[])) as Array<Record<string, unknown>>;
    return rows
      .map(toRow)
      .filter((row) => row.id !== '' && row.content !== '' && (sessionId === '' || row.sessionId === sessionId));
  } catch {
    // 表不在/结构变了：如实空（不假装有数据）
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
}
