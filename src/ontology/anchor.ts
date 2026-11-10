/**
 * 评价锚定（Phase B / TB.3）：把一条用户反馈（"干的不错"）钉到它指向的那笔 delivery（txn_entry）。
 *
 * 为什么这是本体层的关键：评价是**关系**，不是孤立事实——"上次夸的那回"只有解析到具体交付才可理解。
 * 锚不到就落 unresolved 悬置池（delivery_id=null），**绝不硬绑**：错锚 = 静默曲解用户意图（把"不喜欢 A"记成"喜欢 A"），
 * 比无锚更糟（面板可人工指认，见 evaluation-list）。
 *
 * 降级链（自上而下，先命中先取）：
 * 1. explicit：用户原句点到某笔 delivery 的 cue/gist ⇒ 高置信。
 * 2. recency：同会话窗口内最近一笔 delivery ⇒ 中置信，随时间间隔衰减。
 * 3. unresolved：都没有 ⇒ delivery_id=null、置信 0。
 * （task 模式随 Phase D 任务线程接入，届时插在 explicit 与 recency 之间。）
 */
import type { AnchorMode, EvalKind } from '../types.js';
import type { TxnStore } from '../store/transaction.js';

export interface FeedbackEvent {
  kind: EvalKind;
  sessionId: string;
  workspaceId: string;
  tsMs: number;
  /** 用户原句——仅用于本地匹配 cue，不入库、不进返回（入库的 user_line 由调用方钳短+脱敏后另给）。 */
  userText: string;
}

export interface AnchorResult {
  deliveryId: string | null;
  anchorMode: AnchorMode;
  anchorConfidence: number;
}

/** 锚定窗口：反馈与它指向的交付通常相邻，缺省 10 分钟。 */
export const ANCHOR_WINDOW_MS = 600_000;

/** 候选池顶：只看最近这么多笔 delivery（不做全表扫）。 */
const CANDIDATE_LIMIT = 20;

export function anchorFeedback(
  txnStore: TxnStore,
  event: FeedbackEvent,
  windowMs: number = ANCHOR_WINDOW_MS,
): AnchorResult {
  // 只认未取代、非回填的活跃 delivery（回填产物未经语境校准，不当锚点）。
  const candidates = txnStore
    .listRecent(CANDIDATE_LIMIT, { sessionId: event.sessionId, excludeBackfill: true })
    .filter((d) => d.tsMs <= event.tsMs);

  // 1. explicit：原句点到某笔 delivery 的 cue 或 gist_key。
  const lower = event.userText.toLowerCase();
  if (lower !== '') {
    for (const d of candidates) {
      const cueHit = d.cues.some((c) => c.cue !== '' && lower.includes(c.cue.toLowerCase()));
      const gistHit = d.gistKey !== undefined && d.gistKey !== '' && lower.includes(d.gistKey.toLowerCase());
      if (cueHit || gistHit) return { deliveryId: d.id, anchorMode: 'explicit', anchorConfidence: 900 };
    }
  }

  // 2. recency：窗口内最近一笔，置信随间隔线性衰减（800→300）。
  const inWindow = candidates.find((d) => event.tsMs - d.tsMs <= windowMs);
  if (inWindow !== undefined) {
    const gap = Math.max(0, event.tsMs - inWindow.tsMs);
    const conf = Math.max(300, 800 - Math.round((gap / windowMs) * 500));
    return { deliveryId: inWindow.id, anchorMode: 'recency', anchorConfidence: conf };
  }

  // 3. unresolved：不猜、不硬绑。
  return { deliveryId: null, anchorMode: 'unresolved', anchorConfidence: 0 };
}
