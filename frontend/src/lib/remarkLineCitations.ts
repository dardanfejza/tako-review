import { visit } from 'unist-util-visit';
import type { Root, Text, Link, PhrasingContent } from 'mdast';
import { citationPattern } from './lineNumber';

/**
 * remark plugin (FE §2.2/§5.5): rewrite line citations the model emits into link nodes so the
 * renderer can turn them into clickable anchors back to the editor.
 *   - single: `L42` / `42行目`          → `#L42`
 *   - range:  `lines 12-15` / `12-15行目` → `#L12-15` (full inclusive range — both ends preserved)
 * The grammar is shared with `lineNumber.ts` (single source of truth). Sanitizer-safe: a `#fragment`
 * href passes rehype-sanitize's default schema unchanged.
 */
export function remarkLineCitations() {
  return (tree: Root): void => {
    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || index === undefined) return;
      const value = node.value;
      const re = citationPattern();
      if (!re.test(value)) return;

      re.lastIndex = 0;
      const replacement: PhrasingContent[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(value)) !== null) {
        if (m.index > last) replacement.push({ type: 'text', value: value.slice(last, m.index) });
        const start = m[1] ?? m[3]; // single line, or the start of a range
        const end = m[2] ?? m[4]; // range end, if any
        const link: Link = {
          type: 'link',
          url: end ? `#L${start}-${end}` : `#L${start}`,
          children: [{ type: 'text', value: m[0] }],
        };
        replacement.push(link);
        last = m.index + m[0].length;
      }
      if (last < value.length) replacement.push({ type: 'text', value: value.slice(last) });

      // Rebuild via array-literal spread rather than `splice(index, 1, ...replacement)`: spreading
      // `replacement` as splice ARGUMENTS hits V8's ~65k-argument limit (RangeError) on a degenerate
      // node with ~55k+ citations. Array-literal spread is not subject to the argument-count limit.
      parent.children = [
        ...parent.children.slice(0, index),
        ...replacement,
        ...parent.children.slice(index + 1),
      ];
      return index + replacement.length; // resume after the inserted nodes
    });
  };
}
