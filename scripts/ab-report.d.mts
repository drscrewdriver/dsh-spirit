/** A/B 归因报告的声明面（脚本本体是 .mjs，测试与 CLI 共用）。 */

export interface SpiritUsageBlock {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface SessionMeasure {
  sessionId: string;
  turns: number;
  assistantMessages: number;
  assistantChars: number;
  usage: SpiritUsageBlock;
  cacheHitRatio: number | null;
  spirit: {
    cardRows: number;
    cardBytes: number;
    cardRecallHits: number;
    cardRecentLines: number;
    cardToneRows: number;
    avgCardBytes: number | null;
    cardWithoutState: number;
    cardWithoutSignature: number;
  };
  correctionCandidates: number;
  compactionUsages: number;
}

export interface JournalMeasure {
  /** null = 读不到库（缺席/被锁），**不是** 0 条。 */
  entries: number | null;
  byLane?: Record<string, number>;
  reason?: string;
}

export interface AbSessionReport extends SessionMeasure {
  journal: JournalMeasure;
  group: 'injected' | 'bypassed' | 'untouched' | 'unknown';
}

export interface AbGroupAggregate {
  sessions: number;
  turns: number;
  assistantChars: number;
  inputTokens: number;
  cacheReadTokens: number;
  cardRows: number;
  cardBytes: number;
  cardRecallHits: number;
  shapeDriftRows: number;
  journalEntries: number;
  correctionCandidates: number;
  meanInputTokensPerTurn: number;
  meanCacheHitRatio: number | null;
}

export interface AbReport {
  home: string;
  spiritDbPresent: boolean;
  sessions: AbSessionReport[];
  groups: {
    injected: AbGroupAggregate | null;
    bypassed: AbGroupAggregate | null;
    untouched: string[];
    unknown: string[];
  };
  notes: string[];
}

export declare function measureRows(
  sessionId: string,
  rows: readonly Record<string, unknown>[],
): SessionMeasure;

export declare function measureJournal(dbFile: string, sessionId: string): JournalMeasure;

export declare function analyzeHome(homeDir: string): AbReport;
