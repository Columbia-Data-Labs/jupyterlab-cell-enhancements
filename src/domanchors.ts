import { Cell } from '@jupyterlab/cells';

/**
 * Comments on rendered markdown and on cell outputs can't use CodeMirror's
 * range mapping — there's no editor, just rendered DOM. They anchor by quoted
 * text instead: we search the region for the quote and build a live DOM Range.
 *
 * That is weaker than the editor anchoring (a re-run cell or an edited markdown
 * source can move or destroy the quote), which is why unresolvable anchors are
 * surfaced as "outdated" rather than silently relocated.
 */
export type DomRegion = 'markdown' | 'output';

export interface IDomAnchorSpec {
  region: DomRegion;
  outputIndex?: number;
  quote: string;
}

const MARKDOWN_SELECTOR = '.jp-MarkdownOutput';
const OUTPUT_SELECTOR = '.jp-OutputArea-output';
const HIGHLIGHT_NAME = 'cee-dom-anchor';

/** The element a DOM anchor lives inside, or null if it isn't rendered. */
export function regionRoot(
  cell: Cell,
  anchor: IDomAnchorSpec
): HTMLElement | null {
  if (anchor.region === 'markdown') {
    return cell.node.querySelector(MARKDOWN_SELECTOR);
  }
  const outputs = cell.node.querySelectorAll<HTMLElement>(OUTPUT_SELECTOR);
  return outputs[anchor.outputIndex ?? 0] ?? null;
}

/**
 * Locate `quote` inside `root` and return a live Range covering it.
 *
 * Returns null when the text isn't present — the caller treats that as an
 * outdated anchor.
 */
export function findRange(root: HTMLElement, quote: string): Range | null {
  if (!quote) {
    return null;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  let node = walker.nextNode() as Text | null;
  while (node) {
    starts.push(text.length);
    nodes.push(node);
    text += node.data;
    node = walker.nextNode() as Text | null;
  }
  const index = text.indexOf(quote);
  if (index === -1) {
    return null;
  }
  const end = index + quote.length;

  const locate = (offset: number): { node: Text; offset: number } | null => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (starts[i] <= offset) {
        return { node: nodes[i], offset: offset - starts[i] };
      }
    }
    return null;
  };
  const from = locate(index);
  const to = locate(end);
  if (!from || !to) {
    return null;
  }
  const range = document.createRange();
  try {
    range.setStart(from.node, Math.min(from.offset, from.node.length));
    range.setEnd(to.node, Math.min(to.offset, to.node.length));
  } catch {
    return null;
  }
  return range;
}

/** Resolve an anchor to a live Range, or null when it can't be found. */
export function resolveDomAnchor(
  cell: Cell,
  anchor: IDomAnchorSpec
): Range | null {
  const root = regionRoot(cell, anchor);
  return root ? findRange(root, anchor.quote) : null;
}

/**
 * Paint DOM anchor highlights using the CSS Custom Highlight API, which styles
 * ranges without mutating the DOM. That matters here: rewriting rendered output
 * or markdown would fight with JupyterLab's own re-rendering.
 */
export function paintHighlights(ranges: Range[]): void {
  const css = CSS as unknown as {
    highlights?: Map<string, unknown> & {
      set(name: string, value: unknown): void;
      delete(name: string): void;
    };
  };
  const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown })
    .Highlight;
  if (!css.highlights || !Ctor) {
    return; // Unsupported browser: notes still work, just without the highlight.
  }
  if (!ranges.length) {
    css.highlights.delete(HIGHLIGHT_NAME);
    return;
  }
  css.highlights.set(HIGHLIGHT_NAME, new Ctor(...ranges));
}

/**
 * Describe the user's current selection when it falls inside a cell's rendered
 * markdown or one of its outputs.
 */
export function domSelectionIn(cell: Cell): IDomAnchorSpec | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    return null;
  }
  const quote = selection.toString();
  if (!quote.trim()) {
    return null;
  }
  const container = selection.getRangeAt(0).commonAncestorContainer;
  const element =
    container.nodeType === Node.ELEMENT_NODE
      ? (container as HTMLElement)
      : container.parentElement;
  if (!element || !cell.node.contains(element)) {
    return null;
  }
  const markdown = element.closest<HTMLElement>(MARKDOWN_SELECTOR);
  if (markdown) {
    return { region: 'markdown', quote };
  }
  const output = element.closest<HTMLElement>(OUTPUT_SELECTOR);
  if (output) {
    const outputs = Array.from(
      cell.node.querySelectorAll<HTMLElement>(OUTPUT_SELECTOR)
    );
    return { region: 'output', outputIndex: outputs.indexOf(output), quote };
  }
  return null;
}
