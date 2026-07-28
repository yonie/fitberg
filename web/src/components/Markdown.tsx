import type { ReactNode } from 'react';

// A deliberately small markdown renderer for AI output.
//
// The coach prompts ask for headings, bold and lists, so the model returns markdown —
// and rendering that as pre-wrapped plain text shows the reader literal `**asterisks**`
// and `## hashes`.
//
// This handles exactly what the prompts request: headings, bold, italic, inline code,
// bullet and numbered lists, and paragraphs. No links, images, tables or HTML — and no
// dependency, and no `dangerouslySetInnerHTML`, so model output can never inject markup.
// Anything unrecognised falls through as text rather than disappearing.

/** Inline: **bold**, *italic*, `code`. Returns React nodes, never raw HTML. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // One pass, longest markers first so ** is not mistaken for two *.
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;

    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} style={{
          background: 'var(--surface-2)', padding: '0.1em 0.3em',
          borderRadius: 3, fontSize: '0.9em',
        }}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function Markdown({ text }: { text: string }) {
  if (!text) return null;

  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join(' ').trim();
    if (joined) {
      blocks.push(
        <p key={`p-${key++}`} style={{ margin: '0 0 0.75rem' }}>
          {renderInline(joined, `p${key}`)}
        </p>,
      );
    }
    paragraph = [];
  };

  const flushList = () => {
    if (!list || !list.items.length) { list = null; return; }
    const Tag = list.ordered ? 'ol' : 'ul';
    const items = list.items;
    blocks.push(
      <Tag key={`l-${key++}`} style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem' }}>
        {items.map((item, index) => (
          <li key={index} style={{ marginBottom: '0.25rem' }}>
            {renderInline(item, `li${key}-${index}`)}
          </li>
        ))}
      </Tag>,
    );
    list = null;
  };

  const flushAll = () => { flushParagraph(); flushList(); };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (!line.trim()) { flushAll(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      // Headings inside a card should not compete with the card's own title, so even
      // an h1 from the model renders at h4 weight.
      blocks.push(
        <h4 key={`h-${key++}`} style={{
          margin: '0.875rem 0 0.375rem', fontSize: '0.9375rem', fontWeight: 650,
        }}>
          {renderInline(heading[2], `h${key}`)}
        </h4>,
      );
      continue;
    }

    // Models write section headings as a fully bold line rather than with hashes:
    // "**What stands out**" on its own. Treated as a heading, because joining it onto
    // the next sentence produces "What stands out Your fatigue of 21.5 is…".
    const boldHeading = /^\*\*([^*]+)\*\*:?$|^__([^_]+)__:?$/.exec(line.trim());
    if (boldHeading) {
      flushAll();
      blocks.push(
        <h4 key={`h-${key++}`} style={{
          margin: '0.875rem 0 0.375rem', fontSize: '0.9375rem', fontWeight: 650,
        }}>
          {boldHeading[1] ?? boldHeading[2]}
        </h4>,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(numbered[1]);
      continue;
    }

    // A continuation line inside a list item belongs to that item.
    if (list && /^\s+\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushAll();

  return <div style={{ fontSize: '0.9375rem', lineHeight: 1.6 }}>{blocks}</div>;
}
