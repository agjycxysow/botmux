import { describe, expect, it, vi } from 'vitest';

import {
  buildLogisticsHarnessInput,
  buildLogisticsModelTaskPrompt,
  createLogisticsSessionModelTaskRunner,
  parseLogisticsModelTaskOutput,
} from '../src/services/logistics-session-model-task.js';
import type { LogisticsSessionMasterRecord } from '../src/services/logistics-session-master.js';

const record: LogisticsSessionMasterRecord = {
  masterKey: 'oc_chat:session-1',
  larkAppId: 'cli_logistics',
  sessionId: 'session-1',
  turnId: 'turn-1',
  surveyId: 'survey-1',
  settledSurveyIds: [],
  ratingCount: 0,
  chatId: 'oc_chat',
  rootMessageId: 'om_root',
  respondentOpenId: 'ou_user',
  surveyStatus: 'sent',
  dueAt: 1_000,
  ratingState: 'awaiting',
  transcript: '用户：请排查发货页面接口\n助手：已定位',
  taggingState: 'tagging',
  needsReview: false,
  modelAttempts: 1,
  baseSyncAttempts: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
};

describe('logistics session model task', () => {
  it('accepts only the established LB/LP taxonomy and discrete resolution states', () => {
    expect(parseLogisticsModelTaskOutput(JSON.stringify({
      businessCategory: 'LB02',
      problemType: 'LP03',
      resolutionStatus: 'resolved',
      overallConfidence: 'medium',
      needsReview: false,
    }))).toMatchObject({ businessCategory: 'LB02', problemType: 'LP03' });
    expect(() => parseLogisticsModelTaskOutput(JSON.stringify({
      businessCategory: 'LB77',
      problemType: 'LP03',
      resolutionStatus: 'resolved',
      overallConfidence: 'high',
      needsReview: false,
    }))).toThrow('model_task_output_schema_invalid');
    expect(buildLogisticsModelTaskPrompt(record)).not.toContain(record.masterKey);
  });


  it('parses the versioned Harness contract and builds the validator-compatible input hash', () => {
    const harness = parseLogisticsModelTaskOutput(JSON.stringify({
      schema_version: '1.0',
      harness_revision: 'a'.repeat(64),
      capture_state: 'complete',
      business: { id: 'LB02', confidence: 'high', reason_code: 'primary_domain_fulfillment', evidence_anchors: [{ role: 'domain', message_index: 0 }] },
      problem_type: { id: 'LP03', confidence: 'high', reason_code: 'code_or_api_trace_requested', evidence_anchors: [{ role: 'goal', message_index: 0 }] },
      resolution: { status: 'resolved', confidence: 'high', reason_code: 'requested_trace_delivered', evidence_anchors: [{ role: 'goal', message_index: 0 }, { role: 'outcome', message_index: 1 }] },
      needs_review: false,
      review_reason: '',
      manual_review: { status: 'pending' },
    }));
    expect(harness).toMatchObject({
      businessCategory: 'LB02',
      problemType: 'LP03',
      resolutionStatus: 'resolved',
      harnessRevision: 'a'.repeat(64),
      businessReasonCode: 'primary_domain_fulfillment',
      evidenceAnchors: expect.arrayContaining([
        { role: 'domain', messageIndex: 0 },
        { role: 'outcome', messageIndex: 1 },
      ]),
    });
    const input = buildLogisticsHarnessInput({
      ...record,
      captureState: 'complete',
      messages: [{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }],
    });
    expect(input.transcript_hash).toBe('4142dcdf6ead914689172f2589ff054ccf1d8034b12ca59aa2b6557373b35612');
  });
  it('runs the isolated one-shot model task with an ephemeral read-only Codex invocation', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      const outputPath = args[args.indexOf('--output-last-message') + 1]!;
      await import('node:fs/promises').then(({ writeFile }) => writeFile(outputPath, JSON.stringify({
        businessCategory: 'LB02',
        problemType: 'LP03',
        resolutionStatus: 'unknown',
        overallConfidence: 'low',
        needsReview: true,
        reviewReason: '缺少终局证据',
      })));
      return { stdout: '' };
    });
    const runner = createLogisticsSessionModelTaskRunner({ cliId: 'codex', timeoutMs: 12_345 }, exec);
    await expect(runner({ record })).resolves.toMatchObject({ resolutionStatus: 'unknown' });
    const args = exec.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--sandbox', 'read-only']));
    expect(exec.mock.calls[0]![2]).toMatchObject({ timeout: 12_345 });
  });
});
