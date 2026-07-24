import { StateField, StateEffect } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { Cell } from '@jupyterlab/cells';

/**
 * A text range inside a cell that a comment is attached to. `from`/`to` are
 * character offsets into the cell's source; `id` ties the range back to its
 * comment.
 */
export interface IAnchorRange {
  id: string;
  from: number;
  to: number;
  outdated?: boolean;
}

/** Effect that replaces every anchor decoration in an editor. */
export const setAnchors = StateEffect.define<IAnchorRange[]>();

const ANCHOR_ATTR = 'data-cee-anchor';

function markFor(range: IAnchorRange): Decoration {
  return Decoration.mark({
    class: range.outdated
      ? 'cee-anchor-highlight cee-anchor-outdated'
      : 'cee-anchor-highlight',
    attributes: { [ANCHOR_ATTR]: range.id }
  });
}

function build(ranges: IAnchorRange[], docLength: number): DecorationSet {
  const valid = ranges
    .filter(r => r.from < r.to && r.from >= 0 && r.to <= docLength)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  return Decoration.set(
    valid.map(r => markFor(r).range(r.from, r.to)),
    true
  );
}

/**
 * Holds the anchor highlights for one editor.
 *
 * The `deco.map(tr.changes)` call is what makes anchors durable: CodeMirror
 * rewrites every range through each document change, so a highlight stays glued
 * to its text as the user edits above or inside it.
 */
export const anchorField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setAnchors)) {
        deco = build(effect.value, tr.state.doc.length);
      }
    }
    return deco;
  },
  provide: field => EditorView.decorations.from(field)
});

/**
 * The raw CodeMirror view behind a cell, or null when the cell has no editor
 * (e.g. a rendered markdown cell, or a cell the windowed renderer has dropped).
 */
export function editorViewFor(cell: Cell): EditorView | null {
  const editor = cell.editor as unknown as { editor?: EditorView } | null;
  const view = editor?.editor;
  return view && typeof view.coordsAtPos === 'function' ? view : null;
}

/** Push a cell's anchor ranges into its editor, installing the field on first use. */
export function applyAnchors(view: EditorView, ranges: IAnchorRange[]): void {
  const effects: StateEffect<unknown>[] = [];
  if (!view.state.field(anchorField, false)) {
    effects.push(StateEffect.appendConfig.of([anchorField]));
  }
  effects.push(setAnchors.of(ranges));
  view.dispatch({ effects });
}

/**
 * Read anchor ranges back out of an editor. Offsets here reflect every edit the
 * user has made since the ranges were applied, so they are the source of truth
 * for persisting updated positions.
 */
export function readAnchors(view: EditorView): IAnchorRange[] {
  const field = view.state.field(anchorField, false);
  if (!field) {
    return [];
  }
  const out: IAnchorRange[] = [];
  const iter = field.iter();
  while (iter.value) {
    const id = iter.value.spec?.attributes?.[ANCHOR_ATTR];
    if (typeof id === 'string') {
      out.push({ id, from: iter.from, to: iter.to });
    }
    iter.next();
  }
  return out;
}

/**
 * Viewport coordinates of an anchor's end, used to place the note and draw its
 * leader line. Null when the range isn't currently laid out.
 */
export function anchorCoords(
  view: EditorView,
  range: { from: number; to: number }
): { x: number; y: number } | null {
  try {
    const end = view.coordsAtPos(Math.min(range.to, view.state.doc.length));
    if (!end) {
      return null;
    }
    return { x: end.right, y: (end.top + end.bottom) / 2 };
  } catch {
    return null;
  }
}

/**
 * Re-attach a saved anchor to the current text. Offsets alone are unreliable
 * across reloads (the file may have been edited elsewhere), so we verify against
 * the quoted text and, failing an exact hit, snap to the nearest identical
 * occurrence. Returns null when the quote is gone entirely — the caller then
 * marks the comment outdated rather than pointing it at the wrong code.
 */
export function reanchor(
  source: string,
  anchor: { from: number; to: number; quote: string }
): { from: number; to: number } | null {
  const quote = anchor.quote;
  if (!quote) {
    return null;
  }
  if (source.slice(anchor.from, anchor.to) === quote) {
    return { from: anchor.from, to: anchor.to };
  }
  let best = -1;
  let index = source.indexOf(quote);
  while (index !== -1) {
    if (best === -1 || Math.abs(index - anchor.from) < Math.abs(best - anchor.from)) {
      best = index;
    }
    index = source.indexOf(quote, index + 1);
  }
  return best === -1 ? null : { from: best, to: best + quote.length };
}
