import { createHash } from 'node:crypto';

export interface LogisticsTopicIdentity {
  botId: string;
  chatId: string;
  rootMessageId: string;
}

export type LogisticsTopicExclusionReason =
  | 'special_session'
  | 'chat_scope'
  | 'non_thread_scope'
  | 'missing_root';

function requiredPart(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`topic_${name}_required`);
  return normalized;
}

export function normalizeLogisticsTopicIdentity(input: LogisticsTopicIdentity): LogisticsTopicIdentity {
  return {
    botId: requiredPart(input.botId, 'bot_id'),
    chatId: requiredPart(input.chatId, 'chat_id'),
    rootMessageId: requiredPart(input.rootMessageId, 'root_message_id'),
  };
}

export function buildLogisticsTopicKey(input: LogisticsTopicIdentity): string {
  const topic = normalizeLogisticsTopicIdentity(input);
  const material = [topic.botId, topic.chatId, topic.rootMessageId].join('\u0000');
  return `topic_${createHash('sha256').update(material).digest('hex')}`;
}

export function buildLogisticsTopicPublicId(sessionKey: string): string {
  const normalized = requiredPart(sessionKey, 'session_key');
  return `topic_${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

export function classifyLogisticsTopic(input: {
  scope?: string | null;
  rootMessageId?: string | null;
  specialSession?: boolean | number | null;
}): LogisticsTopicExclusionReason | undefined {
  if (Boolean(input.specialSession)) return 'special_session';
  if (input.scope === 'chat') return 'chat_scope';
  if (input.scope !== 'thread') return 'non_thread_scope';
  if (!input.rootMessageId?.trim()) return 'missing_root';
  return undefined;
}
