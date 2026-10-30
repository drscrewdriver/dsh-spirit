/**
 * 浏览器半的文案（v0.1 = 中英两语）。
 *
 * ⚠️ **这是对"9 语"标准的显式偏离**，写在这里而不是藏在代码里：本插件 v0.1 的界面
 * 只有一个 pill、一个只读分节和几个按钮，先把形态跑通再摊开 9 份人工校对。
 * 语言键结构照 9 语规范设计（zh 键集为真理源，其余语言 `Record<keyof typeof zh, string>`
 * 编译期对齐），**加第 3 种语言时不需要改组件**。
 *
 * 死文案（键定义了但没人引用）= 漏渲染信号，由 tests/client-copy.test.ts 机械核对。
 */

export const zh = {
  'pill.labelOn': '情绪·开',
  'pill.labelBypass': '情绪·旁路',
  'pill.labelOff': '情绪·关',
  'pill.title': '角色的体验记录是否注入本会话',
  'pill.menuOn': '注入回忆卡',
  'pill.menuBypass': '只记录，不注入（对照）',
  'pill.menuOff': '本会话不参与',
  'section.label': '手记',
  'panel.title': '角色体验手记',
  'panel.hint': '这里记录的是角色自己经历了什么，不是客观事实清单。',
  'panel.mood': '当前状态',
  'panel.noData': '这个会话还没有记录',
  'panel.entries': '条目数',
  'panel.injected': '注入轮次',
  'panel.bypassed': '旁路轮次',
  'panel.confirmedHint': '（生效确认口径：注入后在会话日志里看到同一行才算生效）',
  'panel.recent': '最近的记录',
  'panel.turn': '轮次',
  'panel.lane': '来源',
  'panel.laneLive': '实时',
  'panel.laneDrsc': '历史',
  'panel.drsc': '历史检索',
  'panel.drscOk': '可用',
  'panel.drscSkipped': '未启用（不影响实时记录）',
  'panel.drscWarn': '不可达（只走自家条目）',
  'panel.drscFail': '异常',
  'panel.degraded': '存储不可用：只保留本轮内存态',
  'panel.loadFailed': '读取失败',
  'panel.retry': '重试',
  'panel.notFact': '非事实记录',
  'panel.exportMd': '导出为 markdown',
  'panel.exportJsonl': '导出为 JSONL',
  'panel.exported': '已导出',
  'panel.exportDry': '导出为干跑（未写文件）',
  'panel.exportFailed': '导出失败',
} as const;

export type CopyKey = keyof typeof zh;

export const en: Record<CopyKey, string> = {
  'pill.labelOn': 'Mood · on',
  'pill.labelBypass': 'Mood · record-only',
  'pill.labelOff': 'Mood · off',
  'pill.title': 'Whether the character\'s experience card is injected into this session',
  'pill.menuOn': 'Inject recall card',
  'pill.menuBypass': 'Record only, no injection (control)',
  'pill.menuOff': 'Opt this session out',
  'section.label': 'Journal',
  'panel.title': 'Character experience journal',
  'panel.hint': 'These are what the character lived through, not a list of objective facts.',
  'panel.mood': 'Current state',
  'panel.noData': 'Nothing recorded for this session yet',
  'panel.entries': 'Entries',
  'panel.injected': 'Injected turns',
  'panel.bypassed': 'Bypassed turns',
  'panel.confirmedHint': ' (confirmed = the same row was seen in the session log)',
  'panel.recent': 'Recent entries',
  'panel.turn': 'Turn',
  'panel.lane': 'Source',
  'panel.laneLive': 'live',
  'panel.laneDrsc': 'history',
  'panel.drsc': 'History lane',
  'panel.drscOk': 'available',
  'panel.drscSkipped': 'disabled (live lane unaffected)',
  'panel.drscWarn': 'unreachable (own entries only)',
  'panel.drscFail': 'error',
  'panel.degraded': 'Storage unavailable: in-session memory only',
  'panel.loadFailed': 'Load failed',
  'panel.retry': 'Retry',
  'panel.notFact': 'not a fact record',
  'panel.exportMd': 'Export as markdown',
  'panel.exportJsonl': 'Export as JSONL',
  'panel.exported': 'Exported',
  'panel.exportDry': 'Dry run (no file written)',
  'panel.exportFailed': 'Export failed',
};

export const DICTS: Record<'zh' | 'en', Record<CopyKey, string>> = { zh, en };

/** 取词：未知语言退 zh（宿主语言切换早于本包字典时的正常形状）。 */
export function copyOf(lang: string | undefined): Record<CopyKey, string> {
  return lang !== undefined && lang.startsWith('en') ? en : zh;
}

export const COPY_KEYS: readonly CopyKey[] = Object.keys(zh) as CopyKey[];
