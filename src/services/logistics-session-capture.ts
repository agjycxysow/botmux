import { createHash } from 'node:crypto';

export interface LogisticsSessionMessage {
  messageId: string;
  senderType?: string;
  content: string;
  createTime?: string;
}

export interface LogisticsSessionSnapshot {
  transcript: string;
  transcriptHash: string;
  captureState: 'complete' | 'partial';
  reviewReason?: string;
  messageCount: number;
  messages?: LogisticsSnapshotMessage[];
}

export interface LogisticsSnapshotMessage {
  role: 'user' | 'assistant';
  content: string;
  messageId?: string;
  createdAt?: number;
}

export interface BuildLogisticsSessionSnapshotInput {
  turnId: string;
  answerMessageId?: string;
  rootMessageId?: string | null;
  sessionStartedAt?: string;
  messages: ReadonlyArray<LogisticsSessionMessage>;
  maxTranscriptChars?: number;
}

const DEFAULT_MAX_TRANSCRIPT_CHARS = 12_000;

function roleForMessage(senderType: string | undefined): string {
  return senderType === 'user' ? '用户' : senderType === 'app' ? '助手' : '消息';
}

function snapshotRole(senderType: string | undefined): LogisticsSnapshotMessage['role'] | undefined {
  if (senderType === 'user') return 'user';
  if (senderType === 'app') return 'assistant';
  return undefined;
}

export function sanitizeLogisticsSessionText(value: string, maxChars = DEFAULT_MAX_TRANSCRIPT_CHARS): string {
  const normalized = value
    .replace(/\bou_[A-Za-z0-9_]+\b/g, '[成员]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号]')
    .replace(/\b\d{8,}\b/g, '[编号]')
    .replace(/(?:https?|ftp):\/\/\S+/gi, '[链接]')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(normalized);
  return chars.length > maxChars
    ? `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`
    : normalized;
}

export function buildLogisticsSessionSnapshot(
  input: BuildLogisticsSessionSnapshotInput,
): LogisticsSessionSnapshot {
  const maxTranscriptChars = input.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT_CHARS;
  const turnIndex = input.messages.findIndex(message => message.messageId === input.turnId);
  const answerIndex = input.answerMessageId
    ? input.messages.findIndex(message => message.messageId === input.answerMessageId)
    : -1;
  const rootIndex = input.rootMessageId
    ? input.messages.findIndex(message => message.messageId === input.rootMessageId)
    : -1;
  const sessionStartedAt = Date.parse(input.sessionStartedAt ?? '');
  const rootCreatedAt = rootIndex >= 0 ? Number(input.messages[rootIndex]?.createTime) : NaN;
  const rootBelongsToSession = rootIndex >= 0
    && (!Number.isFinite(sessionStartedAt)
      || !Number.isFinite(rootCreatedAt)
      || rootCreatedAt >= sessionStartedAt - 120_000);
  const sessionStartIndex = Number.isFinite(sessionStartedAt)
    ? input.messages.findIndex(message => {
      const createdAt = Number(message.createTime);
      return Number.isFinite(createdAt) && createdAt >= sessionStartedAt;
    })
    : -1;
  const start = rootBelongsToSession
    ? rootIndex
    : sessionStartIndex >= 0
    ? sessionStartIndex
    : rootIndex >= 0
      ? rootIndex
      : turnIndex >= 0
        ? turnIndex
        : answerIndex >= 0
          ? Math.max(0, answerIndex - 1)
          : Math.max(0, input.messages.length - 2);
  const end = answerIndex >= start ? answerIndex : input.messages.length - 1;
  const selected = input.messages.slice(start, end + 1);
  const messages = selected.flatMap(message => {
    const role = snapshotRole(message.senderType);
    const content = sanitizeLogisticsSessionText(message.content, 2_000);
    if (!role || !content) return [];
    const createdAt = Number(message.createTime);
    return [{
      role,
      content,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    } satisfies LogisticsSnapshotMessage];
  });
  const transcript = sanitizeLogisticsSessionText(
    messages.map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`).join('\n'),
    maxTranscriptChars,
  );
  const explicitTurnWindow = !input.rootMessageId
    && turnIndex >= 0
    && answerIndex >= turnIndex;
  const captureState = turnIndex >= 0
    && (answerIndex < 0 || answerIndex >= turnIndex)
    && (rootBelongsToSession || sessionStartIndex >= 0 || explicitTurnWindow)
    ? 'complete'
    : 'partial';
  const reviewReason = captureState === 'partial'
    ? '未完整定位本轮起止消息，已保留可识别片段'
    : undefined;

  const transcriptHash = createHash('sha256')
    .update(JSON.stringify(messages.map(({ role, content }) => ({ content, role }))))
    .digest('hex');
  return {
    transcript,
    transcriptHash,
    captureState,
    ...(reviewReason ? { reviewReason } : {}),
    messageCount: messages.length,
    messages,
  };
}
