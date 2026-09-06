import { describe, expect, it } from 'vitest';

import {
  fallbackLogisticsTagging,
  normalizeLogisticsSessionMasterConfig,
  stableLogisticsSessionMasterKey,
} from '../src/services/logistics-session-master.js';

describe('logistics session master', () => {
  it('uses one master key per chat/session rather than creating one row per survey', () => {
    expect(stableLogisticsSessionMasterKey('cli_a', 'session-1', 'turn-1', 'oc_1'))
      .toBe(stableLogisticsSessionMasterKey('cli_a', 'session-1', 'turn-2', 'oc_1'));
    expect(stableLogisticsSessionMasterKey('cli_a', 'session-1', 'turn-1', 'oc_1'))
      .not.toBe(stableLogisticsSessionMasterKey('cli_a', 'session-1', 'turn-1', 'oc_2'));
  });

  it('uses a single overall confidence and keeps the fallback review-safe', () => {
    expect(fallbackLogisticsTagging('missing')).toMatchObject({
      businessCategory: 'LB99',
      problemType: 'LP99',
      resolutionStatus: 'unknown',
      overallConfidence: 'low',
      needsReview: true,
    });
  });

  it('enables SQLite without requiring a Base binding', () => {
    expect(normalizeLogisticsSessionMasterConfig({ enabled: true })).toMatchObject({
      enabled: true,
      sqlite: { enabled: true },
      modelTask: { enabled: false },
    });
    expect(normalizeLogisticsSessionMasterConfig({
      enabled: true,
      sqlite: { enabled: false },
    }).enabled).toBe(false);
  });
});
