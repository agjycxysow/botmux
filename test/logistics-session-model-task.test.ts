import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildLogisticsHarnessInput,
  buildLogisticsModelTaskPrompt,
  createLogisticsSessionModelTaskRunner,
  isLogisticsHarnessRecordAnalyzable,
  parseLogisticsModelTaskOutput,
  prepareLogisticsHarnessRecord,
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

  it('bounds oversized Harness inputs and marks deterministic truncation as partial', () => {
    const prepared = prepareLogisticsHarnessRecord({
      ...record,
      captureState: 'complete',
      messages: Array.from({ length: 205 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: index === 0 ? '内容'.repeat(4_500) : `消息 ${index}`,
      })),
    });
    expect(prepared.truncated).toBe(true);
    expect(prepared.record.captureState).toBe('partial');
    expect(prepared.record.messages).toHaveLength(200);
    expect(Array.from(prepared.record.messages![0]!.content)).toHaveLength(4_000);
    expect(prepared.record.messages!.at(-1)?.content).toBe('消息 204');
    expect(prepared.record.transcriptHash).toBe(
      buildLogisticsHarnessInput(prepared.record).transcript_hash,
    );
  });

  it('re-sanitizes historical message facts against Harness privacy patterns', () => {
    const prepared = prepareLogisticsHarnessRecord({
      ...record,
      captureState: 'complete',
      messages: [{
        role: 'user',
        content: '订单_12345678_suffix access_token=credential-value https://example.com/path',
      }],
    });
    expect(prepared.record.messages?.[0]?.content).toBe(
      '订单_[编号]_suffix access_[凭据] [链接]',
    );
  });

  it('requires a user message before treating a frozen record as analyzable', () => {
    expect(isLogisticsHarnessRecordAnalyzable({
      ...record,
      messages: [{ role: 'assistant', content: '机器人发起的消息' }],
    })).toBe(false);
    expect(isLogisticsHarnessRecordAnalyzable({
      ...record,
      messages: [
        { role: 'assistant', content: '上下文' },
        { role: 'user', content: '请帮我定位问题' },
      ],
    })).toBe(true);
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
    const runner = createLogisticsSessionModelTaskRunner({
      cliId: 'codex',
      model: 'gpt-test',
      timeoutMs: 12_345,
    }, exec);
    await expect(runner({ record })).resolves.toMatchObject({ resolutionStatus: 'unknown' });
    const args = exec.mock.calls[0]![1] as string[];
    expect(args).toEqual(expect.arrayContaining([
      '--model', 'gpt-test', '--ephemeral', '--sandbox', 'read-only',
    ]));
    expect(exec.mock.calls[0]![2]).toMatchObject({ timeout: 12_345 });
  });

  it('passes the copied Harness output schema to Codex and validates the result', async () => {
    const harnessRoot = await mkdtemp(join(tmpdir(), 'logistics-harness-'));
    try {
      for (const skill of [
        'logistics-conversation-labeler',
        'logistics-conversation-classifier',
        'logistics-conversation-resolution',
      ]) {
        await mkdir(join(harnessRoot, '.agents', 'skills', skill), { recursive: true });
        await writeFile(join(harnessRoot, '.agents', 'skills', skill, 'SKILL.md'), `# ${skill}\n`);
      }
      const labelerScripts = join(
        harnessRoot,
        '.agents',
        'skills',
        'logistics-conversation-labeler',
        'scripts',
      );
      await mkdir(labelerScripts, { recursive: true });
      await writeFile(join(labelerScripts, 'validate_labeling.py'), 'raise SystemExit(0)\n');
      const contractDir = join(harnessRoot, '00-Harness', 'conversation-labeling');
      await mkdir(contractDir, { recursive: true });
      await writeFile(join(contractDir, 'output-contract.schema.json'), JSON.stringify({
        type: 'object',
        properties: {
          schema_version: { const: '1.0' },
          role: { enum: ['goal', 'domain'] },
        },
      }));

      let structuredSchema: any;
      const exec = vi.fn(async (_file: string, args: string[]) => {
        const schemaPath = args[args.indexOf('--output-schema') + 1]!;
        structuredSchema = JSON.parse(await readFile(schemaPath, 'utf8'));
        const outputPath = args[args.indexOf('--output-last-message') + 1]!;
        await writeFile(outputPath, JSON.stringify({
          schema_version: '1.0',
          harness_revision: 'a'.repeat(64),
          capture_state: 'complete',
          business: {
            id: 'LB02',
            confidence: 'high',
            reason_code: 'primary_domain_fulfillment',
            evidence_anchors: [{ role: 'domain', message_index: 0 }],
          },
          problem_type: {
            id: 'LP03',
            confidence: 'high',
            reason_code: 'code_or_api_trace_requested',
            evidence_anchors: [{ role: 'goal', message_index: 0 }],
          },
          resolution: {
            status: 'resolved',
            confidence: 'high',
            reason_code: 'requested_trace_delivered',
            evidence_anchors: [{ role: 'outcome', message_index: 1 }],
          },
          needs_review: false,
          review_reason: '',
          manual_review: { status: 'pending' },
        }));
        return { stdout: '' };
      });
      const runner = createLogisticsSessionModelTaskRunner({
        cliId: 'codex',
        harnessRoot,
      }, exec);

      await expect(runner({ record })).resolves.toMatchObject({
        businessCategory: 'LB02',
        resolutionStatus: 'resolved',
      });
      const args = exec.mock.calls[0]![1] as string[];
      const schemaPath = args[args.indexOf('--output-schema') + 1]!;
      expect(schemaPath).toContain('botmux-logistics-model-');
      expect(schemaPath.endsWith('structured-output.schema.json')).toBe(true);
      expect(structuredSchema.properties.role.type).toBe('string');
      expect(structuredSchema.properties.schema_version.type).toBe('string');
    } finally {
      await rm(harnessRoot, { recursive: true, force: true });
    }
  });
});
