# Feedback Card Reference Visual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the delayed satisfaction survey as the supplied clean white Card 2.0 reference while preserving the existing five rating callbacks and requester-only policy.

**Architecture:** Keep `feedback-card.ts` as the specialized renderer. Use Card 2.0 containers for the recap and rating prompt, a five-column callback row for ratings, and neutral terminal copy instead of a colored completion panel. Keep survey scheduling, persistence, and authorization unchanged.

**Tech Stack:** TypeScript, Lark Card 2.0 JSON, Vitest.

## Global Constraints

- Do not change callback values: each rating remains `ask_select` with `ask_id`, `nonce`, and `key`.
- Keep the Card 2.0 schema and the existing requester-only and 24-hour behavior.
- Render no colored header and no green terminal block.
- Do not modify existing dirty feedback worktrees.

---

### Task 1: Lock The Reference Layout

**Files:**
- Modify: `test/ask-card.test.ts:206-283`

**Interfaces:**
- Consumes: `buildAskCard(ask)` for a `PendingAsk` whose purpose is `feedback_survey`.
- Produces: a regression assertion for headerless recap, five rating callbacks, endpoint labels, and neutral terminal presentation.

- [ ] **Step 1: Write the failing test**

```ts
expect(card.header).toBeUndefined();
expect(recap.background_style).toBe('grey');
expect(ratingPrompt.background_style).toBe('blue');
expect(ratingRow.columns).toHaveLength(5);
expect(JSON.stringify(terminal)).not.toContain('green');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --project unit test/ask-card.test.ts`
Expected: FAIL because the baseline Card has a colored header, standalone buttons, and no reference-layout containers.

- [ ] **Step 3: Commit**

```bash
git add test/ask-card.test.ts
git commit -m "test(feedback): 固化满意度卡片参考布局"
```

### Task 2: Render The Reference Layout

**Files:**
- Modify: `src/im/lark/feedback-card.ts:1-115`
- Test: `test/ask-card.test.ts:206-283`

**Interfaces:**
- Consumes: `PendingAsk`, optional `AskResult`, and the existing `ask_select` callback payload.
- Produces: `buildFeedbackSurveyCard(ask, result)` Card 2.0 JSON with a headerless white body.

- [ ] **Step 1: Write minimal implementation**

```ts
const RATING_KEYS = ['1', '2', '3', '4', '5'] as const;

const elements = [
  titleMarkdown,
  subtitleMarkdown,
  recapContainer(prompt, answer),
  ratingPrompt(),
  ratingColumns(ask),
  ratingScaleLabels(),
  footerMarkdown,
];
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm exec vitest run --project unit test/ask-card.test.ts`
Expected: PASS with the feedback survey assertions green.

- [ ] **Step 3: Commit**

```bash
git add src/im/lark/feedback-card.ts test/ask-card.test.ts
git commit -m "fix(feedback): 调整满意度卡片视觉层级"
```

### Task 3: Verify And Deploy The Isolated Checkout

**Files:**
- Verify: `src/im/lark/feedback-card.ts`
- Verify: `test/ask-card.test.ts`

- [ ] **Step 1: Run focused feedback tests**

Run: `pnpm exec vitest run --project unit test/ask-card.test.ts test/feedback-survey.test.ts`
Expected: PASS.

- [ ] **Step 2: Build the checkout**

Run: `pnpm build`
Expected: exit code 0.

- [ ] **Step 3: Switch and restart**

Run: `pnpm switch:here && pnpm daemon:restart`
Expected: the global shim and active daemon load this worktree's `dist/cli.js`.
