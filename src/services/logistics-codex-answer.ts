import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';

import type { Session } from '../types.js';
import { stripTrailingOaiMemoryCitation } from './bridge-fallback-gate.js';
import { codexHistoryPath } from './codex-paths.js';
import {
  findCodexRolloutBySessionId,
  findCodexSessionIdByBotmuxSessionId,
} from './codex-transcript.js';
import { sanitizeLogisticsMessageText } from './logistics-session-capture.js';

const ROLLOUT_TAIL_MAX_BYTES = 64 * 1024 * 1024;
const HISTORY_INDEX_MAX_BYTES = 64 * 1024 * 1024;
const ANSWER_TIME_WINDOW_MS = 30 * 60_000;
const SEND_TIME_WINDOW_MS = 2 * 60_000;
const SEND_TIME_AMBIGUITY_MS = 1_000;
let historySessionIndex: Map<string, string> | undefined;

export interface LogisticsCodexAnswerLookup {
  markerMessageId?: string;
  expectedUserText?: string;
  expectedAnswerAtMs?: number;
}

export interface LogisticsCodexRecoveredAnswer {
  content: string;
  source:
    | 'codex_botmux_send'
    | 'codex_botmux_send_time_match'
    | 'codex_assistant_final';
  occurredAt?: number;
}

interface CodexTurn {
  userText: string;
  finalText?: string;
  completedAt?: number;
}

interface PendingCommand {
  command: string;
  content?: string;
  occurredAt?: number;
  zeroExit?: boolean;
}

function eventTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inputTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => (
    block
      && typeof block === 'object'
      && (block as { type?: unknown }).type === 'input_text'
      && typeof (block as { text?: unknown }).text === 'string'
      ? [(block as { text: string }).text]
      : []
  )).join('');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function extractLogisticsCodexUserText(value: string): string {
  const wrapped = value.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/)?.[1];
  return decodeXml(wrapped ?? value)
    .replace(/<botmux_reminder>[\s\S]*?<\/botmux_reminder>/g, '')
    .replace(/<mentions>[\s\S]*?<\/mentions>/g, '')
    .replace(/<sender\b[\s\S]*?<\/sender>/g, '')
    .replace(/<sender\b[\s\S]*?\/>/g, '')
    .replace(/<session_id>[\s\S]*?<\/session_id>/g, '')
    .replace(/<\/?user_message>/g, '')
    .replace(/^\s*\[用户引用了消息[^\n]*\]\s*$/gm, '')
    .replace(/^\s*\[来自[^\n]*@mention[^\n]*\]\s*$/gm, '')
    .trim();
}

function normalizedComparableText(value: string): string {
  return sanitizeLogisticsMessageText(extractLogisticsCodexUserText(value))
    .replace(/\s+/g, ' ')
    .trim();
}

function userTextMatches(actual: string, expected: string): boolean {
  const left = normalizedComparableText(actual);
  const right = normalizedComparableText(expected);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return shorter.length >= 20
    && shorter.length / longer.length >= 0.7
    && longer.includes(shorter);
}

function visibleAnswer(value: string): string | undefined {
  const content = stripTrailingOaiMemoryCitation(value).trim();
  if (!content || content === 'BOTMUX_NOTHING_TO_SEND') return undefined;
  if (/^\[图片\]请升级至最新版本客户端，以查看内容$/i.test(content)) return undefined;
  return content;
}

function invocationIndexes(command: string): number[] {
  const indexes: number[] = [];
  const pattern = /(?:^|[;\n&|]\s*)(?:[A-Za-z0-9_./-]+\/)?botmux\s+(?:send|reply)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    const within = match[0].search(/(?:[A-Za-z0-9_./-]+\/)?botmux\s+(?:send|reply)\b/);
    indexes.push(match.index + within);
  }
  return indexes;
}

function heredocBody(command: string, start: number): string | undefined {
  const lineEnd = command.indexOf('\n', start);
  if (lineEnd < 0) return undefined;
  const header = command.slice(start, lineEnd);
  const operator = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(header);
  if (!operator) return undefined;
  const delimiter = operator[1] ?? operator[2] ?? operator[3];
  if (!delimiter) return undefined;
  const quoted = operator[1] !== undefined || operator[2] !== undefined;
  const bodyStart = lineEnd + 1;
  let cursor = bodyStart;
  while (cursor <= command.length) {
    const next = command.indexOf('\n', cursor);
    const end = next < 0 ? command.length : next;
    const line = command.slice(cursor, end);
    if (line.replace(/^\t+/, '').trimEnd() === delimiter) {
      const bodyEnd = cursor > bodyStart ? cursor - 1 : cursor;
      const body = command.slice(bodyStart, bodyEnd);
      if (!quoted && /[$`\\]/.test(body)) return undefined;
      return visibleAnswer(body);
    }
    if (next < 0) break;
    cursor = next + 1;
  }
  return undefined;
}

function shellWords(command: string, start: number): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let active = false;
  let quote: "'" | '"' | undefined;
  for (let index = start; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      active = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      } else if (char === '\\') {
        const next = command[index + 1];
        if (next === undefined) return undefined;
        word += next;
        index += 1;
      } else {
        if (char === '$' || char === '`') return undefined;
        word += char;
      }
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
      continue;
    }
    if (char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return undefined;
      word += next;
      active = true;
      index += 1;
      continue;
    }
    if (char === '$' || char === '`') return undefined;
    if (char === '\n' || char === ';' || char === '&' || char === '|') {
      if (active) words.push(word);
      break;
    }
    if (/\s/.test(char)) {
      if (active) {
        words.push(word);
        word = '';
        active = false;
      }
      continue;
    }
    word += char;
    active = true;
  }
  if (quote) return undefined;
  if (active) words.push(word);
  return words;
}

const SEND_BOOLEAN_FLAGS = new Set([
  '--card',
  '--text',
  '--top-level',
  '--no-quote',
  '--mention-back',
  '--no-mention',
  '--anyway',
  '--voice',
  '--attention',
  '--slash',
  '--no-markdown',
]);

function inlineBody(command: string, start: number): string | undefined {
  const words = shellWords(command, start);
  if (!words || words.length < 3 || words[0] !== 'botmux') return undefined;
  if (words[1] !== 'send' && words[1] !== 'reply') return undefined;
  const args = words.slice(2);
  if (args.some(arg => (
    arg === '--content-file'
    || arg.startsWith('--content-file=')
    || arg === '--card-file'
    || arg.startsWith('--card-file=')
    || arg === '--card-json'
    || arg.startsWith('--card-json=')
  ))) return undefined;
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith('--')) {
      const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
      if (!arg.includes('=') && !SEND_BOOLEAN_FLAGS.has(flag)) index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return visibleAnswer(positionals.join(' '));
}

export function extractDeliveredBotmuxCommandContent(command: string): string | undefined {
  for (const start of invocationIndexes(command)) {
    const content = heredocBody(command, start) ?? inlineBody(command, start);
    if (content) return content;
  }
  return undefined;
}

function outputConfirmsMessage(output: unknown, messageId: string): boolean {
  if (typeof output !== 'string' || !messageId) return false;
  return /"success"\s*:\s*true/.test(output) && output.includes(JSON.stringify(messageId));
}

function outputSucceeded(output: unknown): boolean {
  return typeof output === 'string'
    && /Process exited with code 0|exit code:?\s*0/i.test(output);
}

function selectTimedSend(
  commands: PendingCommand[],
  expectedAnswerAtMs: number | undefined,
): LogisticsCodexRecoveredAnswer | undefined {
  if (expectedAnswerAtMs === undefined) return undefined;
  const ranked = commands
    .filter(command => (
      command.content
      && command.zeroExit
      && command.occurredAt !== undefined
    ))
    .map(command => ({
      command,
      distance: Math.abs(command.occurredAt! - expectedAnswerAtMs),
    }))
    .filter(candidate => candidate.distance <= SEND_TIME_WINDOW_MS)
    .sort((left, right) => left.distance - right.distance);
  if (ranked.length === 0) return undefined;
  if (ranked.length > 1
    && ranked[1]!.distance - ranked[0]!.distance <= SEND_TIME_AMBIGUITY_MS) {
    return undefined;
  }
  return {
    content: ranked[0]!.command.content!,
    source: 'codex_botmux_send_time_match',
    occurredAt: expectedAnswerAtMs,
  };
}

function selectAssistantFinal(
  turns: CodexTurn[],
  lookup: LogisticsCodexAnswerLookup,
): LogisticsCodexRecoveredAnswer | undefined {
  if (!lookup.expectedUserText) return undefined;
  const candidates = turns.flatMap(turn => {
    const content = turn.finalText ? visibleAnswer(turn.finalText) : undefined;
    if (!content || !userTextMatches(turn.userText, lookup.expectedUserText!)) return [];
    if (lookup.expectedAnswerAtMs !== undefined
      && turn.completedAt !== undefined
      && Math.abs(turn.completedAt - lookup.expectedAnswerAtMs) > ANSWER_TIME_WINDOW_MS) {
      return [];
    }
    return [{
      content,
      source: 'codex_assistant_final' as const,
      ...(turn.completedAt !== undefined ? { occurredAt: turn.completedAt } : {}),
    }];
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length < 2 || lookup.expectedAnswerAtMs === undefined) return undefined;
  const ranked = candidates
    .filter(candidate => candidate.occurredAt !== undefined)
    .sort((left, right) => (
      Math.abs(left.occurredAt! - lookup.expectedAnswerAtMs!)
      - Math.abs(right.occurredAt! - lookup.expectedAnswerAtMs!)
    ));
  if (ranked.length === 0) return undefined;
  if (ranked.length > 1) {
    const firstDistance = Math.abs(ranked[0]!.occurredAt! - lookup.expectedAnswerAtMs);
    const secondDistance = Math.abs(ranked[1]!.occurredAt! - lookup.expectedAnswerAtMs);
    if (firstDistance === secondDistance) return undefined;
  }
  return ranked[0];
}

export function extractLogisticsCodexAnswer(
  jsonl: string,
  lookup: LogisticsCodexAnswerLookup,
): LogisticsCodexRecoveredAnswer | undefined {
  const turns: CodexTurn[] = [];
  const pending = new Map<string, PendingCommand>();
  const sendCommands: PendingCommand[] = [];
  const delivered: LogisticsCodexRecoveredAnswer[] = [];
  let currentTurn: CodexTurn | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry?.payload;
    if (!payload || typeof payload !== 'object') continue;
    const occurredAt = eventTime(entry.timestamp);
    if (entry.type === 'response_item'
      && payload.type === 'message'
      && payload.role === 'user') {
      const userText = inputTextBlocks(payload.content);
      if (!userText) continue;
      currentTurn = { userText };
      turns.push(currentTurn);
      continue;
    }
    if (entry.type === 'response_item'
      && payload.type === 'function_call'
      && payload.name === 'exec_command'
      && typeof payload.call_id === 'string'
      && typeof payload.arguments === 'string') {
      try {
        const args = JSON.parse(payload.arguments) as { cmd?: unknown };
        if (typeof args.cmd === 'string') {
          const content = extractDeliveredBotmuxCommandContent(args.cmd);
          const command: PendingCommand = {
            command: args.cmd,
            ...(content ? { content } : {}),
            ...(occurredAt !== undefined ? { occurredAt } : {}),
          };
          pending.set(payload.call_id, command);
          if (command.content) sendCommands.push(command);
        }
      } catch { /* malformed tool arguments */ }
      continue;
    }
    if (entry.type === 'response_item'
      && payload.type === 'function_call_output'
      && typeof payload.call_id === 'string') {
      const call = pending.get(payload.call_id);
      pending.delete(payload.call_id);
      if (call && outputSucceeded(payload.output)) call.zeroExit = true;
      if (!call || !lookup.markerMessageId
        || !outputConfirmsMessage(payload.output, lookup.markerMessageId)) continue;
      const content = call.content;
      if (content) {
        const answerAt = lookup.expectedAnswerAtMs ?? occurredAt ?? call.occurredAt;
        delivered.push({
          content,
          source: 'codex_botmux_send',
          ...(answerAt !== undefined ? { occurredAt: answerAt } : {}),
        });
      }
      continue;
    }
    if (entry.type === 'event_msg'
      && payload.type === 'task_complete'
      && typeof payload.turn_id === 'string'
      && currentTurn) {
      currentTurn.finalText = typeof payload.last_agent_message === 'string'
        ? payload.last_agent_message
        : '';
      currentTurn.completedAt = occurredAt;
      currentTurn = undefined;
    }
  }
  if (delivered.length > 0) return delivered.at(-1);
  const timedSend = selectTimedSend(sendCommands, lookup.expectedAnswerAtMs);
  if (timedSend) return timedSend;
  return selectAssistantFinal(turns, lookup);
}

function readRolloutTail(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - ROLLOUT_TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(size - start);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function fullHistorySessionIndex(): Map<string, string> {
  if (historySessionIndex) return historySessionIndex;
  const index = new Map<string, string>();
  historySessionIndex = index;
  const path = codexHistoryPath();
  if (!existsSync(path)) return index;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - HISTORY_INDEX_MAX_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    for (const line of text.split('\n')) {
      if (!line.includes('<session_id>')) continue;
      try {
        const entry = JSON.parse(line) as { session_id?: unknown; text?: unknown };
        if (typeof entry.session_id !== 'string' || typeof entry.text !== 'string') continue;
        const botmuxSessionId = entry.text.match(
          /<session_id>\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*<\/session_id>/i,
        )?.[1];
        if (botmuxSessionId) index.set(botmuxSessionId, entry.session_id);
      } catch {
        continue;
      }
    }
  } catch {
    return index;
  }
  return index;
}

export function resolveLogisticsCodexAnswer(
  session: Session,
  lookup: LogisticsCodexAnswerLookup,
): LogisticsCodexRecoveredAnswer | undefined {
  if (session.cliId !== 'codex') return undefined;
  const cliSessionId = session.cliSessionId
    ?? fullHistorySessionIndex().get(session.sessionId)
    ?? findCodexSessionIdByBotmuxSessionId(session.sessionId);
  if (!cliSessionId) return undefined;
  const path = findCodexRolloutBySessionId(cliSessionId);
  if (!path) return undefined;
  const jsonl = readRolloutTail(path);
  return jsonl === undefined ? undefined : extractLogisticsCodexAnswer(jsonl, lookup);
}
