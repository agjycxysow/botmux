import { describe, expect, it } from 'vitest';

import {
  extractDeliveredBotmuxCommandContent,
  extractLogisticsCodexAnswer,
  extractLogisticsCodexUserText,
} from '../src/services/logistics-codex-answer.js';

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

function user(at: string, text: string): string {
  return line(at, 'response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  });
}

function call(at: string, id: string, command: string): string {
  return line(at, 'response_item', {
    type: 'function_call',
    name: 'exec_command',
    call_id: id,
    arguments: JSON.stringify({ cmd: command }),
  });
}

function output(at: string, id: string, messageId: string): string {
  return line(at, 'response_item', {
    type: 'function_call_output',
    call_id: id,
    output: `Process exited with code 0\nFinal output:\n{"success":true,"messageId":"${messageId}"}`,
  });
}

function complete(at: string, text: string): string {
  return line(at, 'event_msg', {
    type: 'task_complete',
    turn_id: `turn-${at}`,
    last_agent_message: text,
  });
}

describe('logistics Codex answer recovery', () => {
  it('extracts the successful botmux send body bound to the Lark message id', () => {
    const jsonl = [
      user('2026-08-20T00:00:00.000Z', '<user_message>\n机器内存有压力吗\n</user_message>'),
      call(
        '2026-08-20T00:00:01.000Z',
        'call-1',
        "botmux send --response-kind final --no-mention <<'EOF'\n总内存 251 GiB，目前可用约 240 GiB，20 GiB 占用不会形成明显压力。\nEOF",
      ),
      output('2026-08-20T00:00:02.000Z', 'call-1', 'om_answer'),
      complete('2026-08-20T00:00:03.000Z', 'BOTMUX_NOTHING_TO_SEND'),
    ].join('\n');
    expect(extractLogisticsCodexAnswer(jsonl, {
      markerMessageId: 'om_answer',
      expectedUserText: '机器内存有压力吗',
      expectedAnswerAtMs: Date.parse('2026-08-20T00:00:02.000Z'),
    })).toEqual({
      content: '总内存 251 GiB，目前可用约 240 GiB，20 GiB 占用不会形成明显压力。',
      source: 'codex_botmux_send',
      occurredAt: Date.parse('2026-08-20T00:00:02.000Z'),
    });
  });

  it('uses a uniquely matched assistant final when no explicit send was recorded', () => {
    const jsonl = [
      user('2026-08-20T00:00:00.000Z', '<user_message>\n如何处理重复发货\n</user_message>'),
      complete('2026-08-20T00:00:05.000Z', '先核对订单状态，再按幂等键重试。'),
    ].join('\n');
    expect(extractLogisticsCodexAnswer(jsonl, {
      expectedUserText: '如何处理重复发货',
      expectedAnswerAtMs: Date.parse('2026-08-20T00:00:06.000Z'),
    })).toEqual({
      content: '先核对订单状态，再按幂等键重试。',
      source: 'codex_assistant_final',
      occurredAt: Date.parse('2026-08-20T00:00:05.000Z'),
    });
  });

  it('time-binds a successful send when the historical marker file is absent', () => {
    const jsonl = [
      user('2026-08-20T00:00:00.000Z', '<user_message>\n如何处理重复发货\n</user_message>'),
      call(
        '2026-08-20T00:00:04.000Z',
        'call-1',
        "botmux send --no-mention <<'EOF'\n先核对订单状态，再按幂等键重试。\nEOF",
      ),
      line('2026-08-20T00:00:05.000Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'Process exited with code 0\nFinal output omitted from retained rollout',
      }),
      complete('2026-08-20T00:00:06.000Z', 'BOTMUX_NOTHING_TO_SEND'),
    ].join('\n');
    expect(extractLogisticsCodexAnswer(jsonl, {
      expectedUserText: '如何处理重复发货',
      expectedAnswerAtMs: Date.parse('2026-08-20T00:00:05.500Z'),
    })).toEqual({
      content: '先核对订单状态，再按幂等键重试。',
      source: 'codex_botmux_send_time_match',
      occurredAt: Date.parse('2026-08-20T00:00:05.500Z'),
    });
  });

  it('fails closed when successful sends are too close to time-disambiguate', () => {
    const jsonl = [
      user('2026-08-20T00:00:00.000Z', '<user_message>\n如何处理重复发货\n</user_message>'),
      call(
        '2026-08-20T00:00:04.000Z',
        'call-1',
        "botmux send --no-mention <<'EOF'\n候选回答一。\nEOF",
      ),
      output('2026-08-20T00:00:04.100Z', 'call-1', 'om_answer_1'),
      call(
        '2026-08-20T00:00:04.800Z',
        'call-2',
        "botmux send --no-mention <<'EOF'\n候选回答二。\nEOF",
      ),
      output('2026-08-20T00:00:04.900Z', 'call-2', 'om_answer_2'),
      complete('2026-08-20T00:00:05.000Z', 'BOTMUX_NOTHING_TO_SEND'),
    ].join('\n');
    expect(extractLogisticsCodexAnswer(jsonl, {
      expectedUserText: '如何处理重复发货',
      expectedAnswerAtMs: Date.parse('2026-08-20T00:00:04.100Z'),
    })).toBeUndefined();
  });

  it('ignores the sentinel and unrelated tool output', () => {
    const jsonl = [
      user('2026-08-20T00:00:00.000Z', '<user_message>\n问题\n</user_message>'),
      line('2026-08-20T00:00:01.000Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'unrelated',
        output: 'secret terminal log',
      }),
      complete('2026-08-20T00:00:02.000Z', 'BOTMUX_NOTHING_TO_SEND'),
    ].join('\n');
    expect(extractLogisticsCodexAnswer(jsonl, {
      expectedUserText: '问题',
      expectedAnswerAtMs: Date.parse('2026-08-20T00:00:02.000Z'),
    })).toBeUndefined();
  });

  it('selects the matching latest turn instead of an older answer', () => {
    const jsonl = [
      user('2026-08-20T00:00:00.000Z', '<user_message>\n第一问\n</user_message>'),
      complete('2026-08-20T00:00:02.000Z', '第一答'),
      user('2026-08-20T01:00:00.000Z', '<user_message>\n第二问\n</user_message>'),
      complete('2026-08-20T01:00:03.000Z', '第二答'),
    ].join('\n');
    expect(extractLogisticsCodexAnswer(jsonl, {
      expectedUserText: '第二问',
      expectedAnswerAtMs: Date.parse('2026-08-20T01:00:04.000Z'),
    })?.content).toBe('第二答');
  });

  it('fails closed when repeated matching turns cannot be time-disambiguated', () => {
    const jsonl = [
      user('2026-08-20T00:00:00.000Z', '<user_message>\n重复问题\n</user_message>'),
      complete('2026-08-20T00:00:01.000Z', '旧回答'),
      user('2026-08-20T00:00:02.000Z', '<user_message>\n重复问题\n</user_message>'),
      complete('2026-08-20T00:00:03.000Z', '新回答'),
    ].join('\n');
    expect(extractLogisticsCodexAnswer(jsonl, {
      expectedUserText: '重复问题',
    })).toBeUndefined();
  });

  it('does not treat commands that merely mention botmux send as delivered content', () => {
    const jsonl = [
      user('2026-08-20T00:00:00.000Z', '<user_message>\n问题\n</user_message>'),
      call('2026-08-20T00:00:01.000Z', 'call-1', 'rg -n "botmux send" src'),
      output('2026-08-20T00:00:02.000Z', 'call-1', 'om_answer'),
      complete('2026-08-20T00:00:03.000Z', 'BOTMUX_NOTHING_TO_SEND'),
    ].join('\n');
    expect(extractLogisticsCodexAnswer(jsonl, {
      markerMessageId: 'om_answer',
      expectedUserText: '问题',
    })).toBeUndefined();
  });

  it('supports safe inline quoted content and rejects dynamic shell expansion', () => {
    expect(extractDeliveredBotmuxCommandContent(
      "botmux send --response-kind final --no-mention '最终回答'",
    )).toBe('最终回答');
    expect(extractDeliveredBotmuxCommandContent(
      'botmux send --response-kind final --no-mention "$SECRET"',
    )).toBeUndefined();
  });

  it('unwraps only the real user_message block', () => {
    expect(extractLogisticsCodexUserText(
      '<session_id>sid</session_id>\n<user_message>\n真实问题\n</user_message>',
    )).toBe('真实问题');
  });
});
