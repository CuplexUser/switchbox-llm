import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PROVIDER_LABELS, type ConversationDetail, type Message, type Pane } from '../../shared/types.ts';
import { formatCost, formatMs, formatTokens } from './format.ts';
import { turnsOf } from './turns.ts';

function statsLine(message: Message): string {
  return [
    message.ttftMs !== null ? `${formatMs(message.ttftMs)} to first token` : null,
    message.tokensIn !== null || message.tokensOut !== null ? `${formatTokens(message.tokensIn) ?? '–'} in, ${formatTokens(message.tokensOut) ?? '–'} out` : null,
    formatCost(message.cost),
  ]
    .filter(Boolean)
    .join(', ');
}

function paneLabel(pane: Pane): string {
  return `${pane.model} (${PROVIDER_LABELS[pane.provider]})`;
}

export function toMarkdown(conversation: ConversationDetail, messagesByPane: Record<string, Message[]>): string {
  const lines = [`# ${conversation.title}`, '', `Exported from Switchbox on ${new Date().toLocaleString()}.`, ''];
  lines.push(`Models: ${conversation.panes.map(paneLabel).join(', ')}`, '');
  for (const [index, turn] of turnsOf(conversation, messagesByPane).entries()) {
    lines.push('---', '', `## ${index + 1}. You`, '', turn.prompt?.content ?? '', '');
    for (const attachment of turn.prompt?.attachments ?? []) lines.push(`- Attached: ${attachment.name}`);
    for (const { pane, message } of turn.replies) {
      lines.push(`### ${paneLabel(pane)}${message?.preferred ? ' ★ best reply' : ''}`, '');
      if (!message) lines.push('_No reply._', '');
      else {
        if (message.content) lines.push(message.content, '');
        if (message.error) lines.push(`> Error: ${message.error}`, '');
        const sources = message.activity?.sources ?? [];
        if (sources.length) lines.push('Sources:', ...sources.map((source) => `- [${source.title}](${source.url})`), '');
        const stats = statsLine(message);
        if (stats) lines.push(`_${stats}_`, '');
      }
    }
  }
  return lines.join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function markdownHtml(text: string): string {
  // No raw HTML plugin, so model output can't inject markup into the page.
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text));
}

/** A self-contained page with each exchange's replies side by side. */
export function toHtml(conversation: ConversationDetail, messagesByPane: Record<string, Message[]>): string {
  const columns = conversation.panes.length;
  const turns = turnsOf(conversation, messagesByPane)
    .map((turn, index) => {
      const replies = turn.replies
        .map(({ pane, message }) => {
          const body = !message
            ? '<p class="muted">No reply.</p>'
            : [
                message.content ? markdownHtml(message.content) : '',
                message.error ? `<p class="error">Error: ${escapeHtml(message.error)}</p>` : '',
                (message.activity?.sources ?? []).length
                  ? `<details><summary>Sources</summary><ol>${(message.activity?.sources ?? [])
                      .filter((source) => /^https?:\/\//i.test(source.url))
                      .map((source) => `<li><a href="${escapeHtml(source.url)}" rel="noreferrer">${escapeHtml(source.title)}</a></li>`)
                      .join('')}</ol></details>`
                  : '',
                statsLine(message) ? `<p class="muted">${escapeHtml(statsLine(message))}</p>` : '',
              ].join('');
          return `<section class="reply${message?.preferred ? ' best' : ''}"><h3>${escapeHtml(paneLabel(pane))}${message?.preferred ? ' <span class="badge">Best reply</span>' : ''}</h3>${body}</section>`;
        })
        .join('');
      const files = (turn.prompt?.attachments ?? []).map((file) => `<li>${escapeHtml(file.name)}</li>`).join('');
      return `<article><div class="prompt"><span class="label">${index + 1}. You</span>${markdownHtml(turn.prompt?.content ?? '')}${files ? `<ul class="files">${files}</ul>` : ''}</div><div class="replies">${replies}</div></article>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(conversation.title)}</title>
<style>
  :root { color-scheme: light dark; --text: #1d2130; --muted: #6b7080; --border: #dfe1e8; --sunken: #f4f5f8; --accent: #3d5afe; }
  @media (prefers-color-scheme: dark) { :root { --text: #e6e8ef; --muted: #9aa0b0; --border: #2e3240; --sunken: #1b1e27; --accent: #8c9eff; } body { background: #12141b; } }
  body { margin: 0; font: 15px/1.6 system-ui, sans-serif; color: var(--text); }
  main { max-width: ${Math.max(760, columns * 460)}px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 0.85rem; }
  article { border-top: 1px solid var(--border); padding: 20px 0; }
  .prompt { background: var(--sunken); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; }
  .label { font-weight: 600; font-size: 0.8rem; color: var(--muted); }
  .replies { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
  .reply { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; min-width: 0; overflow-wrap: anywhere; }
  .reply.best { border-color: var(--accent); }
  .reply h3 { font-size: 0.85rem; margin: 0 0 8px; }
  .badge { font-size: 0.7rem; color: var(--accent); border: 1px solid var(--accent); border-radius: 8px; padding: 0 6px; margin-left: 4px; }
  pre { background: var(--sunken); padding: 10px; border-radius: 8px; overflow-x: auto; }
  code { font-family: ui-monospace, monospace; font-size: 0.85em; }
  table { border-collapse: collapse; } th, td { border: 1px solid var(--border); padding: 4px 8px; }
  .error { color: #d32f2f; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(conversation.title)}</h1>
<p class="muted">${escapeHtml(conversation.panes.map(paneLabel).join(' · '))}. Exported from Switchbox on ${escapeHtml(new Date().toLocaleString())}.</p>
${turns}
</main>
</body>
</html>
`;
}
