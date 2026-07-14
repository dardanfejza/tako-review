import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { useMemo } from 'react';
import { remarkLineCitations } from '../../lib/remarkLineCitations';
import type { LineRange } from '../../lib/lineNumber';
import styles from './MarkdownReview.module.css';

export interface MarkdownReviewProps {
  content: string;
  /** Called with the cited inclusive line range when a citation anchor is clicked (spec §5.5). */
  onCitationClick?: (range: LineRange) => void;
}

/**
 * The central XSS guard (FE §11): react-markdown builds a React element tree (NO innerHTML sink
 * at all) + remark-gfm + rehype-sanitize (runs on every render, strips raw HTML). Citation
 * anchors (`#L42`, `#L12-15`) become buttons wired to onCitationClick with the full inclusive
 * range; all other links are plain anchors.
 */
/** Remove blank lines between GFM table rows so small-model output doesn't break table parsing. */
function fixTableBlankLines(md: string): string {
  return md.replace(/(\|[^\n]*\n)\n+(?=\|)/g, '$1');
}

export function MarkdownReview({ content, onCitationClick }: MarkdownReviewProps) {
  const normalized = useMemo(() => fixTableBlankLines(content), [content]);
  const components = useMemo<Components>(
    () => ({
      a({ href, children }) {
        const match = href?.match(/^#L(\d+)(?:-(\d+))?$/);
        if (match && onCitationClick) {
          // Normalize like parseCitations (lineNumber.ts): a reversed range (`#L15-12`) must
          // still select 12→15, not scroll backwards.
          const a = Number(match[1]);
          const b = match[2] ? Number(match[2]) : a;
          const from = Math.min(a, b);
          const to = Math.max(a, b);
          return (
            <button type="button" className={styles.citation} onClick={() => onCitationClick({ from, to })}>
              {children}
            </button>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
    }),
    [onCitationClick],
  );

  return (
    <div className={styles.markdownReview}>
      <Markdown
        remarkPlugins={[remarkGfm, remarkLineCitations]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {normalized}
      </Markdown>
    </div>
  );
}
