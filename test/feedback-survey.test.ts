import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FeedbackSurveyManager,
  getFeedbackSurveyOutboundDelivery,
  normalizeFeedbackSurveyConfig,
  sanitizeFeedbackRecap,
} from '../src/services/feedback-survey.js';

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'botmux-feedback-survey-'));
  tempDirs.push(dataDir);
  return dataDir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('normalizeFeedbackSurveyConfig', () => {
  it('is inert unless explicitly enabled and normalizes valid settings', () => {
    expect(normalizeFeedbackSurveyConfig({
      enabled: 'true',
      idleDelayMs: -1,
      askTtlMs: 0,
      larkBase: { appToken: ' ', tableId: ' table ', identity: 'unexpected' },
    })).toEqual({
      enabled: false,
      idleDelayMs: 10 * 60_000,
      askTtlMs: 24 * 60 * 60_000,
      grayOpenIds: [],
      recipients: [],
      larkBase: undefined,
    });

    expect(normalizeFeedbackSurveyConfig({
      enabled: true,
      idleDelayMs: 60_000,
      askTtlMs: 86_400_000,
      grayOpenIds: [' ou_allowed ', 'ou_allowed', '', 'not-an-open-id'],
      larkBase: { appToken: ' app ', tableId: ' table ', identity: 'user' },
    })).toEqual({
      enabled: true,
      idleDelayMs: 60_000,
      askTtlMs: 86_400_000,
      grayOpenIds: ['ou_allowed'],
      recipients: [{ openId: 'ou_allowed', idleDelayMs: 60_000 }],
      larkBase: { appToken: 'app', tableId: 'table', identity: 'user' },
    });
  });

  it('uses explicit recipients as the authoritative gray list and normalizes each delay', () => {
    expect(normalizeFeedbackSurveyConfig({
      enabled: true,
      idleDelayMs: 60_000,
      grayOpenIds: ['ou_legacy'],
      recipients: [
        { openId: ' ou_fast ', idleDelayMs: 30_000 },
        { openId: 'ou_fast', idleDelayMs: 120_000 },
        { openId: 'ou_slow', idleDelayMs: 300_000 },
        { openId: 'ou_invalid_delay', idleDelayMs: 0 },
        { openId: 'not-an-open-id', idleDelayMs: 60_000 },
      ],
    })).toMatchObject({
      grayOpenIds: ['ou_fast', 'ou_slow'],
      recipients: [
        { openId: 'ou_fast', idleDelayMs: 30_000 },
        { openId: 'ou_slow', idleDelayMs: 300_000 },
      ],
    });

    expect(normalizeFeedbackSurveyConfig({
      enabled: true,
      grayOpenIds: ['ou_legacy'],
      recipients: [],
    })).toMatchObject({
      grayOpenIds: [],
      recipients: [],
    });
  });

  it('normalizes a positive default delay without enabling a fallback for invalid values', () => {
    expect(normalizeFeedbackSurveyConfig({
      enabled: true,
      recipients: [{ openId: 'ou_fast', idleDelayMs: 60_000 }],
      defaultIdleDelayMs: 900_000,
    })).toMatchObject({
      recipients: [{ openId: 'ou_fast', idleDelayMs: 60_000 }],
      defaultIdleDelayMs: 900_000,
    });

    expect(normalizeFeedbackSurveyConfig({
      enabled: true,
      defaultIdleDelayMs: 0,
    }).defaultIdleDelayMs).toBeUndefined();
  });
});

describe('FeedbackSurveyManager', () => {
  it('cancels an unsent survey when the same session receives a new user turn', async () => {
    vi.useFakeTimers();
    const dataDir = await makeDataDir();
    const registerAsk = vi.fn();
    const manager = new FeedbackSurveyManager({
      dataDir,
      larkAppId: 'cli_feedback',
      config: {
        enabled: true,
        idleDelayMs: 60_000,
        askTtlMs: 86_400_000,
        grayOpenIds: ['ou_initiator'],
      },
      registerAsk,
      getMessage: vi.fn(),
    });

    manager.noteUserActivity({
      sessionId: 'session-1',
      turnId: 'turn-1',
      senderOpenId: 'ou_initiator',
    });
    manager.scheduleForTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      respondentOpenId: 'ou_initiator',
      title: 'first question',
    });

    manager.noteUserActivity({
      sessionId: 'session-1',
      turnId: 'turn-2',
      senderOpenId: 'ou_initiator',
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(registerAsk).not.toHaveBeenCalled();
    expect(manager.listRecords()).toMatchObject([{
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'cancelled',
      failureReason: 'continued_by_user',
    }]);
    manager.stop();
  });

  it('only schedules surveys for an allowlisted initiator', async () => {
    vi.useFakeTimers();
    const dataDir = await makeDataDir();
    const registerAsk = vi.fn();
    const manager = new FeedbackSurveyManager({
      dataDir,
      larkAppId: 'cli_feedback',
      config: {
        enabled: true,
        idleDelayMs: 60_000,
        askTtlMs: 86_400_000,
        grayOpenIds: ['ou_allowed'],
      },
      registerAsk,
      getMessage: vi.fn(),
    });

    manager.noteUserActivity({
      sessionId: 'session-not-gray',
      turnId: 'turn-not-gray',
      senderOpenId: 'ou_not_gray',
    });
    manager.scheduleForTurn({
      sessionId: 'session-not-gray',
      turnId: 'turn-not-gray',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'not gray',
    });

    manager.noteUserActivity({
      sessionId: 'session-gray',
      turnId: 'turn-gray',
      senderOpenId: 'ou_allowed',
    });
    manager.scheduleForTurn({
      sessionId: 'session-gray',
      turnId: 'turn-gray',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 'gray',
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(registerAsk).toHaveBeenCalledTimes(1);
    expect(registerAsk.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-gray',
      expectedResponderOpenIds: ['ou_allowed'],
    });
    expect(manager.listRecords()).toMatchObject([{
      sessionId: 'session-gray',
      respondentOpenId: 'ou_allowed',
    }]);
    manager.stop();
  });

  it('schedules each configured recipient with that recipient delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const dataDir = await makeDataDir();
    const registerAsk = vi.fn(() => ({
      askId: 'ask-1',
      result: new Promise(() => {}),
    }));
    const manager = new FeedbackSurveyManager({
      dataDir,
      larkAppId: 'cli_feedback',
      config: {
        enabled: true,
        recipients: [
          { openId: 'ou_fast', idleDelayMs: 1_000 },
          { openId: 'ou_slow', idleDelayMs: 5_000 },
        ],
      },
      registerAsk,
      getMessage: vi.fn(async () => ({ chatId: 'oc_chat', content: '' })),
    });

    manager.noteUserActivity({
      sessionId: 'session-fast',
      turnId: 'turn-fast',
      senderOpenId: 'ou_fast',
    });
    manager.scheduleForTurn({
      sessionId: 'session-fast',
      turnId: 'turn-fast',
      chatId: 'oc_chat',
      rootMessageId: 'om_root_fast',
    });
    manager.noteUserActivity({
      sessionId: 'session-slow',
      turnId: 'turn-slow',
      senderOpenId: 'ou_slow',
    });
    manager.scheduleForTurn({
      sessionId: 'session-slow',
      turnId: 'turn-slow',
      chatId: 'oc_chat',
      rootMessageId: 'om_root_slow',
    });

    expect(manager.listRecords()).toMatchObject([
      { respondentOpenId: 'ou_fast', dueAt: Date.now() + 1_000 },
      { respondentOpenId: 'ou_slow', dueAt: Date.now() + 5_000 },
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(registerAsk).toHaveBeenCalledTimes(1);
    expect(registerAsk.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-fast',
      expectedResponderOpenIds: ['ou_fast'],
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(registerAsk).toHaveBeenCalledTimes(2);
    expect(registerAsk.mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'session-slow',
      expectedResponderOpenIds: ['ou_slow'],
    });
    manager.stop();
  });

  it('uses the default delay for an unlisted user while preserving an explicit recipient delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T12:00:00Z'));
    const dataDir = await makeDataDir();
    const registerAsk = vi.fn(() => ({
      askId: 'ask-1',
      result: new Promise(() => {}),
    }));
    const manager = new FeedbackSurveyManager({
      dataDir,
      larkAppId: 'cli_feedback',
      config: {
        enabled: true,
        recipients: [{ openId: 'ou_fast', idleDelayMs: 1_000 }],
        defaultIdleDelayMs: 5_000,
      },
      registerAsk,
      getMessage: vi.fn(async () => ({ chatId: 'oc_chat', content: '' })),
    });

    manager.noteUserActivity({
      sessionId: 'session-fast',
      turnId: 'turn-fast',
      senderOpenId: 'ou_fast',
    });
    manager.scheduleForTurn({
      sessionId: 'session-fast',
      turnId: 'turn-fast',
      chatId: 'oc_chat',
      rootMessageId: 'om_root_fast',
    });
    manager.noteUserActivity({
      sessionId: 'session-default',
      turnId: 'turn-default',
      senderOpenId: 'ou_default',
    });
    manager.scheduleForTurn({
      sessionId: 'session-default',
      turnId: 'turn-default',
      chatId: 'oc_chat',
      rootMessageId: 'om_root_default',
    });

    expect(manager.listRecords()).toMatchObject([
      { respondentOpenId: 'ou_fast', dueAt: Date.now() + 1_000 },
      { respondentOpenId: 'ou_default', dueAt: Date.now() + 5_000 },
    ]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(registerAsk).toHaveBeenCalledTimes(1);
    expect(registerAsk.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-fast',
      expectedResponderOpenIds: ['ou_fast'],
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(registerAsk).toHaveBeenCalledTimes(2);
    expect(registerAsk.mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'session-default',
      expectedResponderOpenIds: ['ou_default'],
    });
    manager.stop();
  });

  it('re-arms a scheduled turn without losing the already-visible answer message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00Z'));
    const dataDir = await makeDataDir();
    const result = Promise.resolve({
      kind: 'timedOut' as const,
      selected: null,
      by: null,
      comment: null,
      timedOut: true,
    });
    const registerAsk = vi.fn(() => ({ askId: 'ask-1', result }));
    const manager = new FeedbackSurveyManager({
      dataDir,
      larkAppId: 'cli_feedback',
      config: {
        enabled: true,
        idleDelayMs: 60_000,
        askTtlMs: 86_400_000,
        grayOpenIds: ['ou_initiator'],
      },
      registerAsk,
      getMessage: vi.fn(async (messageId: string) => ({
        chatId: 'oc_chat',
        content: messageId === 'om_answer'
          ? '最终可见回答'
          : '原始问题',
      })),
    });

    manager.noteUserActivity({
      sessionId: 'session-1',
      turnId: 'om_turn',
      senderOpenId: 'ou_initiator',
    });
    manager.scheduleForTurn({
      sessionId: 'session-1',
      turnId: 'om_turn',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      answerMessageId: 'om_answer',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    manager.scheduleForTurn({
      sessionId: 'session-1',
      turnId: 'om_turn',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(registerAsk).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(registerAsk).toHaveBeenCalledTimes(1);
    expect(registerAsk.mock.calls[0]?.[0]?.metadata).toMatchObject({
      recapAnswer: '最终可见回答',
    });
    manager.stop();
  });

  it('restores a scheduled survey after restart and dispatches one recap card', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T12:00:00Z'));
    const dataDir = await makeDataDir();
    const first = new FeedbackSurveyManager({
      dataDir,
      larkAppId: 'cli_feedback',
      config: {
        enabled: true,
        idleDelayMs: 60_000,
        askTtlMs: 86_400_000,
        grayOpenIds: ['ou_initiator'],
      },
      registerAsk: vi.fn(),
      getMessage: vi.fn(),
    });
    first.scheduleForTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      respondentOpenId: 'ou_initiator',
      title: 'fallback title',
      answerMessageId: 'om_answer',
    });
    first.stop();

    const result = Promise.resolve({
      kind: 'answered' as const,
      answers: [['5']],
      by: 'ou_initiator',
      comment: null,
      timedOut: false,
    });
    const registerAsk = vi.fn(() => ({ askId: 'ask-1', result }));
    const second = new FeedbackSurveyManager({
      dataDir,
      larkAppId: 'cli_feedback',
      config: {
        enabled: true,
        idleDelayMs: 60_000,
        askTtlMs: 86_400_000,
        grayOpenIds: ['ou_initiator'],
      },
      registerAsk,
      getMessage: vi.fn(async (_messageId: string) => ({
        chatId: 'oc_chat',
        content: 'answer with `code` and https://example.com/path',
      })),
    });

    second.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(registerAsk).toHaveBeenCalledTimes(1);
    expect(registerAsk.mock.calls[0]?.[0]).toMatchObject({
      expectedResponderOpenIds: ['ou_initiator'],
      allowCustomReply: false,
      metadata: {
        recapPrompt: 'fallback title',
        recapAnswer: 'answer with [代码片段] and',
      },
    });
    second.stop();
  });
});

describe('sanitizeFeedbackRecap', () => {
  it('removes markdown noise and limits Unicode text without leaking mentions', () => {
    expect(sanitizeFeedbackRecap(
      '<at user_id="ou_secret">name</at> [doc](https://example.com/doc) ```ts\nconst x = 1;\n```',
      160,
    )).toBe('@成员 doc [代码片段]');
  });
});

describe('getFeedbackSurveyOutboundDelivery', () => {
  it('uses botmux send reply ids and supports an origin-turn fallback for legacy hook payloads', () => {
    expect(getFeedbackSurveyOutboundDelivery('outbound.reply', {
      source: 'botmux_send',
      sessionId: 'session-1',
      turnId: 'turn-1',
      feedbackEligible: true,
      msgType: 'interactive',
      replyId: 'om_answer',
    })).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
      answerMessageId: 'om_answer',
    });

    expect(getFeedbackSurveyOutboundDelivery('outbound.send', {
      source: 'botmux_send',
      sessionId: 'session-1',
      feedbackEligible: true,
      msgType: 'text',
      messageId: 'om_answer',
    }, 'turn-from-origin')).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-from-origin',
      answerMessageId: 'om_answer',
    });
  });

  it('ignores ineligible, non-final-shape, and unrelated outbound hook payloads', () => {
    const valid = {
      source: 'botmux_send',
      sessionId: 'session-1',
      turnId: 'turn-1',
      msgType: 'text',
      messageId: 'om_answer',
    };
    expect(getFeedbackSurveyOutboundDelivery('outbound.send', {
      ...valid,
      feedbackEligible: false,
    })).toBeUndefined();
    expect(getFeedbackSurveyOutboundDelivery('outbound.send', {
      ...valid,
      source: 'other',
    })).toBeUndefined();
    expect(getFeedbackSurveyOutboundDelivery('outbound.send', {
      ...valid,
      msgType: 'image',
    })).toBeUndefined();
  });
});
