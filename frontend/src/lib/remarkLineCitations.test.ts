import { createElement } from 'react';
import type { Root, Paragraph, Text, Link, PhrasingContent } from 'mdast';
import { render } from '@testing-library/react';
import { remarkLineCitations } from './remarkLineCitations';
import { MarkdownReview } from '../components/result/MarkdownReview';

/** Build a one-paragraph Root holding a single text node — the shape react-markdown hands the plugin. */
function paragraph(value: string): Root {
  return {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  };
}

/** Run the plugin transformer over a tree in place and return the (mutated) paragraph children. */
function transform(tree: Root): PhrasingContent[] {
  remarkLineCitations()(tree);
  return (tree.children[0] as Paragraph).children;
}

describe('remarkLineCitations (mdast transform — spec §5.5)', () => {
  it('rewrites a single L42 citation to a #L42 link node, preserving the citation text', () => {
    const kids = transform(paragraph('See L42 here'));
    // text("See ") + link(#L42, "L42") + text(" here")
    expect(kids).toHaveLength(3);
    expect(kids[0]).toEqual({ type: 'text', value: 'See ' });
    const link = kids[1] as Link;
    expect(link.type).toBe('link');
    expect(link.url).toBe('#L42');
    expect((link.children[0] as Text).value).toBe('L42');
    expect(kids[2]).toEqual({ type: 'text', value: ' here' });
  });

  it('rewrites a hyphen range to a full inclusive #L12-15 anchor (both ends preserved)', () => {
    const kids = transform(paragraph('lines 12-15'));
    const link = kids[0] as Link;
    expect(link.url).toBe('#L12-15');
    expect((link.children[0] as Text).value).toBe('lines 12-15');
  });

  it('rewrites an en-dash range the same way (`lines 3–4` → #L3-4)', () => {
    const kids = transform(paragraph('lines 3–4'));
    const link = kids[0] as Link;
    expect(link.url).toBe('#L3-4');
    expect((link.children[0] as Text).value).toBe('lines 3–4');
  });

  it('rewrites a Japanese 行目 single and range to #L anchors', () => {
    const single = transform(paragraph('42行目')) as [Link];
    expect(single[0].url).toBe('#L42');
    expect((single[0].children[0] as Text).value).toBe('42行目');

    const range = transform(paragraph('12-15行目')) as [Link];
    expect(range[0].url).toBe('#L12-15');
    expect((range[0].children[0] as Text).value).toBe('12-15行目');
  });

  it('preserves the text between and around multiple citations in one node', () => {
    const kids = transform(paragraph('A L7 B lines 2-3 C'));
    // text("A ") link("L7") text(" B ") link("lines 2-3") text(" C")
    expect(kids.map((n) => n.type)).toEqual(['text', 'link', 'text', 'link', 'text']);
    expect((kids[0] as Text).value).toBe('A ');
    expect((kids[1] as Link).url).toBe('#L7');
    expect((kids[2] as Text).value).toBe(' B ');
    expect((kids[3] as Link).url).toBe('#L2-3');
    expect((kids[4] as Text).value).toBe(' C');
  });

  it('handles a node with ~70k citations without a splice-spread RangeError (§9b)', () => {
    // `splice(index, 1, ...replacement)` spreads every replacement node as a call ARGUMENT, hitting
    // V8's ~65k-argument limit and throwing RangeError on a degenerate model output. The rebuild
    // uses array-literal spread instead, which has no such cap. 70k citations forces >65k nodes.
    const COUNT = 70_000;
    const value = Array.from({ length: COUNT }, () => 'L42').join(' ');
    let kids!: PhrasingContent[];
    expect(() => {
      kids = transform(paragraph(value));
    }).not.toThrow();
    // COUNT links + (COUNT - 1) single-space text separators between them.
    expect(kids).toHaveLength(COUNT * 2 - 1);
    expect((kids[0] as Link).url).toBe('#L42');
    expect((kids[kids.length - 1] as Link).url).toBe('#L42');
  });

  it('leaves a node with no citation untouched (no link nodes inserted)', () => {
    const kids = transform(paragraph('no citation here, just prose'));
    expect(kids).toEqual([{ type: 'text', value: 'no citation here, just prose' }]);
  });

  it('does not rewrite an L/line marker embedded in an identifier (shared boundary grammar)', () => {
    const kids = transform(paragraph('level42 html5 call42()'));
    expect(kids.every((n) => n.type === 'text')).toBe(true);
  });

  it('emits a #fragment href that survives rehype-sanitize in the full render pipeline', () => {
    // The plugin runs upstream of rehype-sanitize in MarkdownReview; a `#L…` fragment href passes
    // the default sanitize schema unchanged, so the citation reaches the renderer as a clickable
    // element (here a button, since onCitationClick is provided) rather than being stripped.
    // JSX would force a .tsx file; this test must live in remarkLineCitations.test.ts.
    const { container } = render(
      createElement(MarkdownReview, {
        content: 'Problem at L42 in the loop.',
        onCitationClick: () => {},
      }),
    );
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('L42');
  });

  it('survives sanitize as a plain anchor with the #L href when no click handler is wired', () => {
    const { container } = render(
      createElement(MarkdownReview, { content: 'Problem at lines 12-15.' }),
    );
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('#L12-15');
  });
});
