import type { AskResult, PendingAsk } from '../../core/ask-types.js';

const ASK_SELECT_ACTION = 'ask_select';

function plainText(value: string | undefined): string {
  return (value ?? '')
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s+[^<>]*)?\s*\/?>/gi, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ratingFromResult(result: AskResult | undefined): string | undefined {
  if (result?.kind !== 'answered') return undefined;
  const rating = result.answers[0]?.[0];
  return rating && /^[1-5]$/.test(rating) ? rating : undefined;
}

function terminalCopy(result: AskResult, rating: string | undefined): string {
  if (result.kind === 'answered') {
    return rating
      ? `感谢你的评价：${'⭐'.repeat(Number(rating))}`
      : '感谢你的评价';
  }
  if (result.kind === 'timedOut') return '本次满意度调查已过期';
  return '本次满意度调查未能完成';
}

/** Specialized Card 2.0 renderer for the delayed feedback survey. It is kept
 * independent from ask-card to avoid a card-renderer import cycle. */
export function buildFeedbackSurveyCard(ask: PendingAsk, result?: AskResult): string {
  const prompt = escapeMarkdownText(plainText(ask.metadata?.recapPrompt));
  const answer = escapeMarkdownText(plainText(ask.metadata?.recapAnswer));
  const rating = ratingFromResult(result);
  const isTerminal = result !== undefined;
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: '**Recap · 本轮回顾**',
      text_align: 'left',
      text_size: 'notation',
    },
    {
      tag: 'markdown',
      content: [
        prompt ? `你提出 · ${prompt}` : '',
        answer ? `Botmux 回复 · ${answer}` : '',
      ].filter(Boolean).join('\n'),
      text_align: 'left',
      text_size: 'normal',
    },
    {
      tag: 'markdown',
      content: '请用 1 到 5 星评价这次回答。',
      text_align: 'left',
      text_size: 'normal',
    },
  ];

  if (isTerminal) {
    elements.push({
      tag: 'markdown',
      content: terminalCopy(result, rating),
      text_align: 'left',
      text_size: 'normal',
    });
  } else {
    const options = ask.questions[0]?.options ?? [];
    elements.push({
      tag: 'action',
      actions: options.map((option) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: option.label },
        type: 'default',
        value: {
          action: ASK_SELECT_ACTION,
          ask_id: ask.askId,
          nonce: ask.nonce,
          key: option.key,
        },
      })),
    });
  }

  elements.push({
    tag: 'markdown',
    content: '仅本轮提问者可评价 · 24 小时内有效',
    text_align: 'left',
    text_size: 'notation',
  });

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: isTerminal
        ? (result?.kind === 'answered' ? 'green' : 'grey')
        : 'blue',
      title: { tag: 'plain_text', content: isTerminal ? '满意度调查已结束' : '本次回答，帮到你了吗？' },
      subtitle: { tag: 'plain_text', content: '你的反馈将用于持续改善回答质量' },
    },
    body: {
      direction: 'vertical',
      elements,
    },
  });
}
