import type { AskResult, PendingAsk } from '../../core/ask-types.js';

const ASK_SELECT_ACTION = 'ask_select';
const RATING_KEYS = ['1', '2', '3', '4', '5'] as const;

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
    return [
      rating ? `**${'★'.repeat(Number(rating))}**` : '',
      '感谢你的反馈',
    ].filter(Boolean).join('\n\n');
  }
  if (result.kind === 'timedOut') {
    return '<text_tag color="mm_muted">本次满意度调查已过期</text_tag>';
  }
  return '<text_tag color="mm_muted">本次满意度调查未能完成</text_tag>';
}

function recapContainer(prompt: string): Record<string, unknown> {
  return {
    tag: 'interactive_container',
    width: 'fill',
    padding: '16px 20px',
    background_style: 'grey',
    has_border: true,
    border_color: 'grey-200',
    corner_radius: '8px',
    elements: [
      {
        tag: 'markdown',
        content: '**Recap · 本轮回顾**',
        text_size: 'normal',
      },
      {
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: `你提出 · ${prompt || '未记录'}`,
          text_color: 'grey',
          text_size: 'normal',
        },
      },
    ],
  };
}

function ratingPrompt(): Record<string, unknown> {
  return {
    tag: 'interactive_container',
    width: 'fill',
    padding: '8px 12px',
    background_style: 'blue-50',
    has_border: false,
    corner_radius: '8px',
    elements: [{
      tag: 'markdown',
      content: '**请选择一个最符合你感受的评分**',
      text_size: 'normal',
    }],
  };
}

function ratingColumns(ask: PendingAsk): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: RATING_KEYS.map((key) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [{
        tag: 'interactive_container',
        width: 'fill',
        padding: '8px 0',
        background_style: 'grey-50',
        has_border: true,
        border_color: 'grey-200',
        corner_radius: '8px',
        behaviors: [{
          type: 'callback',
          value: {
            action: ASK_SELECT_ACTION,
            ask_id: ask.askId,
            nonce: ask.nonce,
            key,
          },
        }],
        elements: [{
          tag: 'markdown',
          content: `**${key} ★**`,
          text_align: 'center',
          text_size: 'normal',
        }],
      }],
    })),
  };
}

function ratingScaleLabels(): Record<string, unknown> {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: '很不满意',
            text_color: 'grey',
            text_size: 'normal',
          },
        }],
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: '非常满意',
            text_color: 'grey',
            text_align: 'right',
            text_size: 'normal',
          },
        }],
      },
    ],
  };
}

function terminalContainer(result: AskResult, rating: string | undefined): Record<string, unknown> {
  return {
    tag: 'interactive_container',
    width: 'fill',
    padding: '12px',
    background_style: 'grey',
    has_border: true,
    border_color: 'grey-200',
    corner_radius: '8px',
    elements: [{
      tag: 'markdown',
      content: terminalCopy(result, rating),
      text_align: 'center',
      text_size: 'normal',
    }],
  };
}

/** Specialized Card 2.0 renderer for the delayed feedback survey. It is kept
 * independent from ask-card to avoid a card-renderer import cycle. */
export function buildFeedbackSurveyCard(ask: PendingAsk, result?: AskResult): string {
  const prompt = escapeMarkdownText(plainText(ask.metadata?.recapPrompt));
  const rating = ratingFromResult(result);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: '**本次回答，帮到你了吗？**',
      text_align: 'left',
      text_size: 'heading',
    },
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: '你的反馈会帮助我们持续改进回答质量',
        text_color: 'grey',
        text_size: 'normal',
      },
    },
    recapContainer(prompt),
  ];

  if (result) {
    elements.push(terminalContainer(result, rating));
  } else {
    elements.push(ratingPrompt(), ratingColumns(ask), ratingScaleLabels());
  }

  elements.push({
    tag: 'div',
    text: {
      tag: 'plain_text',
      content: '仅本轮提问者可评价 · 24 小时内有效',
      text_color: 'grey',
      text_align: 'center',
      text_size: 'normal',
    },
  });

  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      direction: 'vertical',
      padding: '20px',
      elements,
    },
  });
}
