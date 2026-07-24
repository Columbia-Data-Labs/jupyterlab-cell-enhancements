import { IDisposable } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Cell, ICellModel } from '@jupyterlab/cells';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';

import {
  DomRegion,
  IDomAnchorSpec,
  findRange,
  paintHighlights,
  regionRoot,
  resolveDomAnchor
} from './domanchors';
import {
  IAnchorRange,
  anchorCoords,
  applyAnchors,
  editorViewFor,
  reanchor,
  readAnchors
} from './anchors';
import { requestContextSave } from './autosave';

/**
 * Metadata key holding a cell's comments, as an array of {@link IComment}.
 *
 * Comments with an `anchor` are attached to a span of text inside the cell;
 * those without are notes on the cell as a whole. Both kinds coexist.
 */
export const COMMENTS_METADATA_KEY = 'cell_comments';

/**
 * Pre-0.4 key holding a single whole-cell comment. Read for backwards
 * compatibility and migrated to {@link COMMENTS_METADATA_KEY} on first write, so
 * merely opening an old notebook doesn't rewrite it.
 */
export const LEGACY_COMMENT_KEY = 'cell_comment';

export interface ICommentAnchor {
  from: number;
  to: number;
  quote: string;
  /**
   * Where the quote lives. Absent means the cell's source (CodeMirror, with
   * durable range mapping); 'markdown'/'output' anchor into rendered DOM by
   * quoted text instead.
   */
  region?: DomRegion;
  outputIndex?: number;
}

export interface IComment {
  id: string;
  author: string;
  text: string;
  open: boolean;
  dx: number;
  dy: number;
  /** Explicit card size in px, set when the user drags the resize handle. */
  w?: number;
  h?: number;
  /**
   * Only set when the author deliberately picked a colour. Otherwise the colour
   * (and the initials) are derived from `author`, so they cannot go stale.
   */
  color?: string;
  colorExplicit?: boolean;
  /** @deprecated Pre-0.4 field; ignored in favour of deriving from `author`. */
  initials?: string;
  anchor?: ICommentAnchor;
  outdated?: boolean;
  /** Archived: hidden unless the "show resolved" setting is on. */
  resolved?: boolean;
}

/**
 * Who is writing a comment. Resolved from JupyterLab's own user identity (the
 * same source its collaborative avatars use), with a settings override.
 */
export interface IAuthorIdentity {
  name: string;
  color: string;
  /** True when the colour was deliberately chosen rather than derived. */
  colorExplicit: boolean;
  /** True when the user has explicitly chosen a name rather than inheriting one. */
  explicit: boolean;
}

/**
 * How comments reach the current author. `get` resolves the identity to stamp on
 * a comment; `edit` opens the name prompt (wired to the note header, toolbar
 * button and command palette).
 */
export interface IAuthorApi {
  get(): IAuthorIdentity;
  edit(): void;
  editColor(): void;
}

/** Runtime options the notes layer reads from settings. */
export interface INoteOptions {
  /** Whether resolved (archived) notes are still displayed. */
  showResolved(): boolean;
}

/** A comment is visible when it's open and either unresolved or being shown. */
function isVisible(c: IComment, showResolved: boolean): boolean {
  return c.open && (!c.resolved || showResolved);
}

/**
 * Convert OKLCH to an sRGB hex string.
 *
 * OKLCH is perceptually uniform: holding L (lightness) and C (chroma) fixed
 * while sweeping H (hue) yields colours that look equally bright and equally
 * vivid. That is what lets us generate arbitrary hues without some coming out
 * washed out or too dark for white text.
 */
function oklchToHex(L: number, C: number, hueDeg: number): string {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const sc = s_ * s_ * s_;

  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sc,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sc,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sc
  ];
  const channel = (u: number): string => {
    const g = u <= 0.0031308 ? 12.92 * u : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
    const v = Math.round(Math.max(0, Math.min(1, g)) * 255);
    return v.toString(16).padStart(2, '0');
  };
  return `#${channel(lin[0])}${channel(lin[1])}${channel(lin[2])}`;
}

/** FNV-1a: cheap, and spreads similar strings far apart. */
function hash32(value: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * A stable colour for an author name, drawn from the full hue circle.
 *
 * Derived rather than stored, so it can never drift out of sync with the author
 * it represents, and everyone opening the notebook sees the same colour for the
 * same person. Lightness and chroma stay within a narrow band so every possible
 * result keeps enough contrast for the avatar's text.
 */
export function colorForName(name: string): string {
  const key = name.trim().toLowerCase();
  if (!key) {
    return '#6b7280';
  }
  const h = hash32(key);
  const hue = (h % 36000) / 100; // 0.01-degree resolution around the circle
  const chroma = 0.13 + ((h >>> 14) % 7) * 0.011;
  const lightness = 0.55 + ((h >>> 22) % 6) * 0.016;
  return oklchToHex(lightness, chroma, hue);
}

/**
 * Black or white, whichever contrasts better with `hex` (WCAG relative
 * luminance). Needed now that avatar colours span the whole spectrum — white
 * text is unreadable on a bright yellow.
 */
export function textColorFor(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) {
    return '#ffffff';
  }
  const n = parseInt(match[1], 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const luminance =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  const onWhite = 1.05 / (luminance + 0.05);
  const onBlack = (luminance + 0.05) / 0.05;
  return onWhite >= onBlack ? '#ffffff' : '#1a1a1a';
}

/** Avatar initials for a name: "Robert Pettis" -> "RP", "Robert" -> "R". */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return '';
  }
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  return (
    parts[0].charAt(0) + parts[parts.length - 1].charAt(0)
  ).toUpperCase();
}

const SVGNS = 'http://www.w3.org/2000/svg';
const ANCHOR_GAP = 20;
const NOTE_WIDTH = 288;
/** Minimum card size, mirroring the CSS min-width/min-height. */
const MIN_NOTE_WIDTH = 200;
const MIN_NOTE_HEIGHT = 90;
/** How far in from the bottom-right corner counts as a resize-handle press. */
const RESIZE_ZONE = 18;

const MARKER_WIDGET_CLASS = 'cee-comment-widget';
const MARKER_CLASS = 'cee-comment-marker';
const HAS_COMMENT_CLASS = 'cee-has-comment';
const OPEN_CLASS = 'cee-comment-open';
const CELL_CLASS = 'cee-cell-commentable';
const MARKER_PROP = '__ceeCommentMarker';

let idCounter = 0;

/** Minimal structural view of a rendermime renderer; see comment in 0.3.0. */
interface IRenderedWidget {
  readonly node: HTMLElement;
  renderModel(model: unknown): Promise<void>;
  dispose(): void;
}

export function newCommentId(): string {
  idCounter += 1;
  return `cee-${Date.now().toString(36)}-${idCounter}`;
}

function coerce(value: unknown, index: number): IComment | null {
  if (typeof value === 'string') {
    return value.trim()
      ? {
          id: `legacy-${index}`,
          author: '',
          text: value,
          open: false,
          dx: 0,
          dy: 0
        }
      : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Partial<IComment>;
  const anchor =
    v.anchor &&
    typeof v.anchor.from === 'number' &&
    typeof v.anchor.to === 'number'
      ? {
          from: v.anchor.from,
          to: v.anchor.to,
          quote: typeof v.anchor.quote === 'string' ? v.anchor.quote : '',
          region:
            v.anchor.region === 'markdown' || v.anchor.region === 'output'
              ? v.anchor.region
              : undefined,
          outputIndex:
            typeof v.anchor.outputIndex === 'number'
              ? v.anchor.outputIndex
              : undefined
        }
      : undefined;
  return {
    id: typeof v.id === 'string' && v.id ? v.id : `legacy-${index}`,
    author: typeof v.author === 'string' ? v.author : '',
    text: typeof v.text === 'string' ? v.text : '',
    open: v.open === true,
    dx: typeof v.dx === 'number' ? v.dx : 0,
    dy: typeof v.dy === 'number' ? v.dy : 0,
    w: typeof v.w === 'number' ? v.w : undefined,
    h: typeof v.h === 'number' ? v.h : undefined,
    color: typeof v.color === 'string' ? v.color : undefined,
    colorExplicit: v.colorExplicit === true,
    anchor,
    outdated: v.outdated === true,
    resolved: v.resolved === true
  };
}

/** All comments on a cell, transparently including the pre-0.4 single-comment shape. */
export function readComments(model: ICellModel): IComment[] {
  const raw = model.getMetadata(COMMENTS_METADATA_KEY);
  if (Array.isArray(raw)) {
    return raw.map(coerce).filter((c): c is IComment => c !== null);
  }
  const legacy = coerce(model.getMetadata(LEGACY_COMMENT_KEY), 0);
  return legacy ? [legacy] : [];
}

export function writeComments(model: ICellModel, comments: IComment[]): void {
  const keep = comments.filter(c => c.text.trim() || c.open);
  if (keep.length) {
    model.setMetadata(COMMENTS_METADATA_KEY, keep as any);
  } else if (model.getMetadata(COMMENTS_METADATA_KEY) !== undefined) {
    model.deleteMetadata(COMMENTS_METADATA_KEY);
  }
  // Retire the legacy key once we've taken ownership of the cell's comments.
  if (model.getMetadata(LEGACY_COMMENT_KEY) !== undefined) {
    model.deleteMetadata(LEGACY_COMMENT_KEY);
  }
}

export function updateComment(
  model: ICellModel,
  id: string,
  patch: Partial<IComment>
): void {
  const list = readComments(model);
  const index = list.findIndex(c => c.id === id);
  if (index === -1) {
    return;
  }
  list[index] = { ...list[index], ...patch };
  writeComments(model, list);
}

function hasText(c: IComment | undefined): boolean {
  return !!c && c.text.trim().length > 0;
}

/* ===================================================================== *
 *  Overlay                                                              *
 * ===================================================================== */

class NoteOverlay {
  static get(): NoteOverlay {
    if (!NoteOverlay._instance) {
      NoteOverlay._instance = new NoteOverlay();
    }
    return NoteOverlay._instance;
  }

  private constructor() {
    this.node = document.createElement('div');
    this.node.className = 'cee-note-overlay';
    this._svg = document.createElementNS(SVGNS, 'svg');
    this._svg.setAttribute('class', 'cee-note-lines');
    this.node.appendChild(this._svg);
    document.body.appendChild(this.node);
  }

  readonly node: HTMLDivElement;

  add(note: FloatingNote): void {
    this._notes.add(note);
    this.node.appendChild(note.node);
    this._svg.appendChild(note.line);
    this._svg.appendChild(note.dot);
    this._ensureLoop();
  }

  remove(note: FloatingNote): void {
    this._notes.delete(note);
    note.node.remove();
    note.line.remove();
    note.dot.remove();
  }

  private _ensureLoop(): void {
    if (this._frame) {
      return;
    }
    const tick = (): void => {
      for (const note of this._notes) {
        note.reposition();
      }
      this._frame = this._notes.size ? requestAnimationFrame(tick) : 0;
    };
    this._frame = requestAnimationFrame(tick);
  }

  private static _instance: NoteOverlay | null = null;
  private _svg: SVGSVGElement;
  private _notes = new Set<FloatingNote>();
  private _frame = 0;
}

/* ===================================================================== *
 *  FloatingNote                                                         *
 * ===================================================================== */

class FloatingNote {
  constructor(
    cell: Cell,
    commentId: string,
    viewport: HTMLElement,
    rendermime: IRenderMimeRegistry,
    authors: IAuthorApi
  ) {
    this._cell = cell;
    this._id = commentId;
    this._model = cell.model;
    this._viewport = viewport;
    this._rendermime = rendermime;
    this._authors = authors;

    this.node = document.createElement('div');
    this.node.className = 'cee-floating-note';

    this._header = document.createElement('div');
    this._header.className = 'cee-note-header';
    this._avatar = document.createElement('span');
    this._avatar.className = 'cee-note-avatar';
    this._avatar.title = 'Double-click to change your colour';
    this._avatar.addEventListener('dblclick', this._onAvatarClick);
    this._authorEl = document.createElement('span');
    this._authorEl.className = 'cee-note-author';
    this._authorEl.addEventListener('dblclick', this._onAuthorClick);
    const spacer = document.createElement('span');
    spacer.className = 'cee-note-spacer';
    this._resolveBtn = this._makeButton('✓', 'Resolve', () => this._toggleResolved());
    this._editBtn = this._makeButton('✎', 'Edit', () => this._beginEdit());
    this._closeBtn = this._makeButton('✕', 'Close', () =>
      this._write({ open: false })
    );
    this._header.appendChild(this._avatar);
    this._header.appendChild(this._authorEl);
    this._header.appendChild(spacer);
    this._header.appendChild(this._resolveBtn);
    this._header.appendChild(this._editBtn);
    this._header.appendChild(this._closeBtn);

    this._quoteEl = document.createElement('div');
    this._quoteEl.className = 'cee-note-quote';

    this._body = document.createElement('div');
    this._body.className = 'cee-note-body';

    this.node.appendChild(this._header);
    this.node.appendChild(this._quoteEl);
    this.node.appendChild(this._body);

    this.line = document.createElementNS(SVGNS, 'line');
    this.line.setAttribute('class', 'cee-note-line');
    this.dot = document.createElementNS(SVGNS, 'circle');
    this.dot.setAttribute('class', 'cee-note-dot');
    this.dot.setAttribute('r', '3.5');

    this._header.addEventListener('mousedown', this._onDragStart);
    // Native CSS `resize: both` draws the corner grip and does the actual
    // resizing; this listener only watches so we can keep the note anchored and
    // persist the final size.
    this.node.addEventListener('mousedown', this._onResizeStart);
    this._model.metadataChanged.connect(this._onMetadataChanged, this);

    this._applyStoredSize();
    this._setAuthor(this._comment());
    if (!hasText(this._comment())) {
      this._beginEdit();
    }
  }

  readonly node: HTMLDivElement;
  readonly line: SVGLineElement;
  readonly dot: SVGCircleElement;

  get commentId(): string {
    return this._id;
  }

  get cellModel(): ICellModel {
    return this._model;
  }

  render(): void {
    this._resolveDomRange();
    this._render();
  }

  /** The live Range for a DOM-anchored comment, if it currently resolves. */
  get domRange(): Range | null {
    return this._domRange;
  }

  private _resolveDomRange(): void {
    const anchor = this._comment()?.anchor;
    this._domRange =
      anchor?.region
        ? resolveDomAnchor(this._cell, anchor as IDomAnchorSpec)
        : null;
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._model.metadataChanged.disconnect(this._onMetadataChanged, this);
    this._header.removeEventListener('mousedown', this._onDragStart);
    this.node.removeEventListener('mousedown', this._onResizeStart);
    this._authorEl.removeEventListener('dblclick', this._onAuthorClick);
    this._avatar.removeEventListener('dblclick', this._onAvatarClick);
    document.removeEventListener('mousemove', this._onDragMove);
    document.removeEventListener('mouseup', this._onDragEnd);
    document.removeEventListener('mousemove', this._onResizeMove);
    document.removeEventListener('mouseup', this._onResizeEnd);
    this._renderer?.dispose();
  }

  reposition(): void {
    if (this._disposed) {
      return;
    }
    const cellRect = this._cell.node.getBoundingClientRect();
    const view = this._viewport.getBoundingClientRect();
    const comment = this._comment();

    // Anchored comments point at their text; whole-cell notes at the cell's
    // right edge, mid-height.
    let anchorX = cellRect.right - 4;
    let anchorY = cellRect.top + cellRect.height / 2;
    let anchorVisible = cellRect.width > 0 && cellRect.height > 0;

    if (comment?.anchor && !comment.outdated) {
      if (comment.anchor.region) {
        let rect = this._domRange?.getBoundingClientRect();
        // A re-render replaces the text nodes and detaches our Range, which
        // shows up as a zero-size rect. Re-find it rather than vanishing.
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          if (this._staleFrames++ > 10) {
            this._staleFrames = 0;
            this._resolveDomRange();
            rect = this._domRange?.getBoundingClientRect();
          }
        } else {
          this._staleFrames = 0;
        }
        if (rect && (rect.width > 0 || rect.height > 0)) {
          anchorX = rect.right;
          anchorY = rect.top + rect.height / 2;
        } else {
          anchorVisible = false;
        }
      } else {
        const editor = editorViewFor(this._cell);
        const coords = editor ? anchorCoords(editor, comment.anchor) : null;
        if (coords) {
          anchorX = coords.x;
          anchorY = coords.y;
        } else {
          anchorVisible = false;
        }
      }
    }

    const onscreen =
      anchorVisible &&
      cellRect.bottom > view.top &&
      cellRect.top < view.bottom &&
      anchorY > view.top - 40 &&
      anchorY < view.bottom + 40;

    if (!onscreen) {
      this.node.style.display = 'none';
      this.line.style.display = 'none';
      this.dot.style.display = 'none';
      return;
    }
    this.node.style.display = '';
    this.line.style.display = '';
    this.dot.style.display = '';

    const live = this._dragging || this._resizing;
    const dx = live ? this._dx : comment?.dx ?? 0;
    const dy = live ? this._dy : comment?.dy ?? 0;

    const width = this.node.offsetWidth || NOTE_WIDTH;
    const height = this.node.offsetHeight || 140;
    let x = cellRect.right + ANCHOR_GAP + dx;
    let y = anchorY - height / 2 + dy;
    x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    y = Math.max(view.top + 4, Math.min(y, view.bottom - 40));
    this.node.style.transform = `translate(${x}px, ${y}px)`;

    this.line.setAttribute('x1', String(anchorX));
    this.line.setAttribute('y1', String(anchorY));
    this.line.setAttribute('x2', String(x));
    this.line.setAttribute('y2', String(y + height / 2));
    this.dot.setAttribute('cx', String(anchorX));
    this.dot.setAttribute('cy', String(anchorY));
  }

  private _comment(): IComment | undefined {
    return readComments(this._model).find(c => c.id === this._id);
  }

  private _write(patch: Partial<IComment>): void {
    updateComment(this._model, this._id, patch);
  }

  private _render(): void {
    if (this._editing) {
      return;
    }
    const c = this._comment();
    this._setAuthor(c);
    this.node.classList.toggle('cee-note-is-outdated', c?.outdated === true);
    const resolved = c?.resolved === true;
    this.node.classList.toggle('cee-note-is-resolved', resolved);
    this._resolveBtn.textContent = resolved ? '↺' : '✓';
    this._resolveBtn.title = resolved ? 'Reopen' : 'Resolve';

    // Show the quoted text for anchored comments; it's the only remaining
    // reference once a comment has gone outdated.
    const quote = c?.anchor?.quote ?? '';
    if (quote) {
      this._quoteEl.style.display = '';
      this._quoteEl.textContent = quote;
      this._quoteEl.title = c?.outdated
        ? 'The commented text no longer appears in this cell'
        : quote;
    } else {
      this._quoteEl.style.display = 'none';
    }

    this._renderBody(c?.text ?? '');
  }

  /**
   * Show the comment author's name, initials and colour. Initials/colour come
   * from the identity captured when the comment was written, so a note keeps its
   * original author's appearance for everyone who opens the notebook.
   */
  private _setAuthor(comment: IComment | undefined): void {
    const author = comment?.author ?? '';
    this._authorEl.textContent = author || 'Note';
    // Derived, never read back from storage — that is what kept stale "AM"
    // initials and colours on notes after a rename.
    const initials = initialsFor(author);
    this._avatar.textContent = initials || '📝';
    this._avatar.classList.toggle('cee-note-avatar-empty', !initials);
    const background =
      comment?.colorExplicit && comment.color
        ? comment.color
        : colorForName(author);
    this._avatar.style.background = background;
    this._avatar.style.color = textColorFor(background);

    // While the user is still on an inherited (anonymous) name, present the
    // header as an invitation to set a real one.
    const unset = !this._authors.get().explicit;
    this._authorEl.classList.toggle('cee-note-author-unset', unset);
    this._authorEl.title = unset
      ? 'Double-click to set your name'
      : 'Double-click to change your name';
  }

  /** Archive a note (or bring it back when resolved notes are being shown). */
  private _toggleResolved(): void {
    const resolved = this._comment()?.resolved === true;
    this._write({ resolved: !resolved });
  }

  // Double-click, not single: the header is also the drag handle, so a single
  // click here would fire constantly by accident.
  private _onAuthorClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this._authors.edit();
  };

  private _onAvatarClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this._authors.editColor();
  };

  private _renderBody(text: string): void {
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
    this._body.textContent = '';
    if (!text.trim()) {
      this._body.classList.add('cee-note-empty');
      this._body.textContent = 'Empty note — click ✎ to edit';
      return;
    }
    this._body.classList.remove('cee-note-empty');
    const model = this._rendermime.createModel({
      data: { 'text/markdown': text },
      trusted: true
    });
    const renderer = this._rendermime.createRenderer('text/markdown');
    this._renderer = renderer;
    Widget.attach(renderer as unknown as Widget, this._body);
    renderer.renderModel(model).catch(() => {
      /* leave the body empty on render failure */
    });
  }

  private _beginEdit(): void {
    if (this._editing) {
      return;
    }
    this._editing = true;
    this.node.classList.add('cee-note-editing');
    this._body.textContent = '';

    const textarea = document.createElement('textarea');
    textarea.className = 'cee-note-editor';
    textarea.value = this._comment()?.text ?? '';
    textarea.placeholder = 'Markdown — supports **bold**, lists, and $LaTeX$…';
    textarea.rows = 5;

    const actions = document.createElement('div');
    actions.className = 'cee-note-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cee-note-delete';
    del.textContent = 'Delete';
    const spacer = document.createElement('span');
    spacer.className = 'cee-note-spacer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cee-note-cancel';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'cee-note-save';
    save.textContent = 'Save';
    actions.appendChild(del);
    actions.appendChild(spacer);
    actions.appendChild(cancel);
    actions.appendChild(save);

    const hint = document.createElement('div');
    hint.className = 'cee-note-hint';
    hint.textContent = 'Ctrl+Enter to save · Esc to cancel';

    this._body.appendChild(textarea);
    this._body.appendChild(hint);
    this._body.appendChild(actions);

    const finish = (save: boolean): void => {
      if (!this._editing) {
        return;
      }
      this._editing = false;
      this.node.classList.remove('cee-note-editing');
      if (save) {
        const existing = this._comment();
        const identity = this._authors.get();
        this._write({
          text: textarea.value,
          author: existing?.author || identity.name,
          open: true
        });
      }
      this._render();
      if (!save && !hasText(this._comment())) {
        this._write({ open: false });
      }
    };

    textarea.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
      event.stopPropagation();
    });
    del.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault();
      this._editing = false;
      this.node.classList.remove('cee-note-editing');
      this._remove();
    });
    cancel.addEventListener('click', event => {
      event.preventDefault();
      finish(false);
    });
    save.addEventListener('click', event => {
      event.preventDefault();
      finish(true);
    });

    // The note may not be in the document yet (the manager attaches it right
    // after construction), and focusing a detached element silently does
    // nothing — which would send the user's keystrokes to the notebook instead.
    window.setTimeout(() => {
      if (this._editing && textarea.isConnected) {
        textarea.focus();
        textarea.select();
      }
    }, 0);
  }

  private _remove(): void {
    const list = readComments(this._model).filter(c => c.id !== this._id);
    writeComments(this._model, list);
  }

  private _onDragStart = (event: MouseEvent): void => {
    if ((event.target as HTMLElement).closest('button')) {
      return;
    }
    event.preventDefault();
    const c = this._comment();
    this._dragging = true;
    this._startX = event.clientX;
    this._startY = event.clientY;
    this._dx = c?.dx ?? 0;
    this._dy = c?.dy ?? 0;
    this.node.classList.add('cee-note-dragging');
    document.addEventListener('mousemove', this._onDragMove);
    document.addEventListener('mouseup', this._onDragEnd);
  };

  private _onDragMove = (event: MouseEvent): void => {
    if (!this._dragging) {
      return;
    }
    const c = this._comment();
    this._dx = (c?.dx ?? 0) + (event.clientX - this._startX);
    this._dy = (c?.dy ?? 0) + (event.clientY - this._startY);
  };

  private _onDragEnd = (): void => {
    if (!this._dragging) {
      return;
    }
    this._dragging = false;
    this.node.classList.remove('cee-note-dragging');
    document.removeEventListener('mousemove', this._onDragMove);
    document.removeEventListener('mouseup', this._onDragEnd);
    this._write({ dx: this._dx, dy: this._dy });
  };

  /** Set the card to its stored size, if any, on construction or reload. */
  private _applyStoredSize(): void {
    const c = this._comment();
    if (c?.w && c.w >= MIN_NOTE_WIDTH) {
      this.node.style.width = `${c.w}px`;
    }
    if (c?.h && c.h >= MIN_NOTE_HEIGHT) {
      this.node.style.height = `${c.h}px`;
    }
  }

  // The browser resizes the card natively; we watch only so the note stays
  // pinned to its anchor while it grows, and so the final size is saved.
  private _onResizeStart = (event: MouseEvent): void => {
    if (this._dragging || (event.target as HTMLElement).closest('button')) {
      return;
    }
    const rect = this.node.getBoundingClientRect();
    const inCorner =
      event.clientX >= rect.right - RESIZE_ZONE &&
      event.clientY >= rect.bottom - RESIZE_ZONE;
    if (!inCorner) {
      return;
    }
    // Deliberately no preventDefault: that would cancel the native resize.
    const c = this._comment();
    this._resizing = true;
    this._dx = c?.dx ?? 0;
    this._dy = c?.dy ?? 0;
    this._lastH = this.node.offsetHeight;
    document.addEventListener('mousemove', this._onResizeMove);
    document.addEventListener('mouseup', this._onResizeEnd);
  };

  private _onResizeMove = (): void => {
    if (!this._resizing) {
      return;
    }
    // The card grows down and right from its top-left; reposition() otherwise
    // recentres vertically on the anchor, which would make the note creep up as
    // it gets taller. Feed half the height gain back into dy to hold the top
    // edge steady. (Width doesn't enter the vertical placement, so no x fixup.)
    const h = this.node.offsetHeight;
    this._dy += (h - this._lastH) / 2;
    this._lastH = h;
  };

  private _onResizeEnd = (): void => {
    if (!this._resizing) {
      return;
    }
    this._resizing = false;
    document.removeEventListener('mousemove', this._onResizeMove);
    document.removeEventListener('mouseup', this._onResizeEnd);
    this._write({
      w: Math.round(this.node.offsetWidth),
      h: Math.round(this.node.offsetHeight),
      dx: this._dx,
      dy: this._dy
    });
  };

  private _onMetadataChanged(_: ICellModel, change: { key: string }): void {
    if (change.key !== COMMENTS_METADATA_KEY) {
      return;
    }
    if (this._editing || this._dragging || this._resizing) {
      // A full re-render would discard unsaved text or fight the drag/resize,
      // but the header is independent of all three — so an author rename still
      // lands here.
      this._setAuthor(this._comment());
      return;
    }
    this.render();
  }

  private _makeButton(
    glyph: string,
    title: string,
    onClick: () => void
  ): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cee-note-btn';
    btn.title = title;
    btn.textContent = glyph;
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  private _cell: Cell;
  private _id: string;
  private _model: ICellModel;
  private _viewport: HTMLElement;
  private _rendermime: IRenderMimeRegistry;
  private _authors: IAuthorApi;
  private _header: HTMLDivElement;
  private _avatar: HTMLSpanElement;
  private _authorEl: HTMLSpanElement;
  private _resolveBtn: HTMLButtonElement;
  private _editBtn: HTMLButtonElement;
  private _closeBtn: HTMLButtonElement;
  private _quoteEl: HTMLDivElement;
  private _body: HTMLDivElement;
  private _renderer: IRenderedWidget | null = null;
  private _editing = false;
  private _dragging = false;
  private _resizing = false;
  private _lastH = 0;
  private _startX = 0;
  private _startY = 0;
  private _dx = 0;
  private _dy = 0;
  private _domRange: Range | null = null;
  private _staleFrames = 0;
  private _disposed = false;
}

/* ===================================================================== *
 *  Marker                                                               *
 * ===================================================================== */

class CellCommentMarker extends Widget {
  constructor(model: ICellModel, authors: IAuthorApi, options: INoteOptions) {
    super();
    this._model = model;
    this._authors = authors;
    this._options = options;
    this.addClass(MARKER_WIDGET_CLASS);

    this._marker = document.createElement('div');
    this._marker.className = MARKER_CLASS;
    this._marker.setAttribute('role', 'button');
    this._marker.setAttribute('aria-label', 'Toggle cell note');
    this._marker.addEventListener('click', this._onClick);
    this.node.appendChild(this._marker);

    model.metadataChanged.connect(this._onMetadataChanged, this);
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._model.metadataChanged.disconnect(this._onMetadataChanged, this);
    this._marker.removeEventListener('click', this._onClick);
    super.dispose();
  }

  private _render(): void {
    const list = readComments(this._model).filter(
      c => !c.resolved || this._options.showResolved()
    );
    this.toggleClass(
      HAS_COMMENT_CLASS,
      list.some(c => c.text.trim())
    );
    this.toggleClass(
      OPEN_CLASS,
      list.some(c => c.open)
    );
  }

  private _onMetadataChanged(_: ICellModel, change: { key: string }): void {
    if (
      change.key === COMMENTS_METADATA_KEY ||
      change.key === LEGACY_COMMENT_KEY
    ) {
      this._render();
    }
  }

  /**
   * Toggles the cell-level note. Anchored comments are left alone — they're
   * opened from their highlight, not the corner marker.
   */
  private _onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const list = readComments(this._model);
    const cellNote = list.find(
      c => !c.anchor && (!c.resolved || this._options.showResolved())
    );
    if (!cellNote) {
      const identity = this._authors.get();
      list.push({
        id: newCommentId(),
        author: identity.name,
        color: identity.colorExplicit ? identity.color : undefined,
        colorExplicit: identity.colorExplicit || undefined,
        text: '',
        open: true,
        dx: 0,
        dy: 0
      });
      writeComments(this._model, list);
      return;
    }
    if (cellNote.open && !cellNote.text.trim()) {
      writeComments(
        this._model,
        list.filter(c => c.id !== cellNote.id)
      );
      return;
    }
    cellNote.open = !cellNote.open;
    writeComments(this._model, list);
  };

  private _model: ICellModel;
  private _authors: IAuthorApi;
  private _options: INoteOptions;
  private _marker: HTMLDivElement;
}

/* ===================================================================== *
 *  Manager                                                              *
 * ===================================================================== */

export class CellCommentManager implements IDisposable {
  constructor(
    panel: NotebookPanel,
    authors: IAuthorApi,
    rendermime: IRenderMimeRegistry,
    options: INoteOptions
  ) {
    this._panel = panel;
    this._authors = authors;
    this._rendermime = rendermime;
    this._options = options;
    panel.content.modelChanged.connect(this._onModelChanged, this);
    this._onModelChanged();
    void panel.revealed.then(() => this._updateAll());
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    if (this._syncTimer) {
      window.clearTimeout(this._syncTimer);
      this._syncTimer = 0;
    }
    for (const note of this._notes.values()) {
      NoteOverlay.get().remove(note);
      note.dispose();
    }
    this._notes.clear();
    for (const model of this._tracked) {
      model.metadataChanged.disconnect(this._onCellMetadata, this);
      model.contentChanged.disconnect(this._onCellContent, this);
    }
    this._tracked.clear();
    const model = this._panel.content.model;
    if (model) {
      model.cells.changed.disconnect(this._updateAll, this);
    }
    this._panel.content.modelChanged.disconnect(this._onModelChanged, this);
  }

  /** Re-evaluate every note, e.g. after the "show resolved" setting changes. */
  refresh(): void {
    this._updateAll();
  }

  private _onModelChanged(): void {
    const model = this._panel.content.model;
    if (model) {
      model.cells.changed.connect(this._updateAll, this);
    }
    this._updateAll();
  }

  private _updateAll(): void {
    if (this._isDisposed) {
      return;
    }
    const liveIds = new Set<string>();
    for (const cell of this._panel.content.widgets) {
      this._ensureCell(cell);
      this._applyAnchors(cell);
      const showResolved = this._options.showResolved();
      for (const c of readComments(cell.model)) {
        if (isVisible(c, showResolved)) {
          liveIds.add(c.id);
        }
      }
      this._syncNotes(cell);
    }
    for (const [id, note] of this._notes) {
      if (!liveIds.has(id)) {
        NoteOverlay.get().remove(note);
        note.dispose();
        this._notes.delete(id);
      }
    }
    this._paintDomHighlights();
  }

  private _ensureCell(cell: Cell): void {
    const decorated = cell as Cell & { [MARKER_PROP]?: CellCommentMarker };
    if (!decorated[MARKER_PROP] || decorated[MARKER_PROP]!.isDisposed) {
      cell.addClass(CELL_CLASS);
      const marker = new CellCommentMarker(
        cell.model,
        this._authors,
        this._options
      );
      decorated[MARKER_PROP] = marker;
      (cell.layout as any).addWidget(marker);
    }
    if (!this._tracked.has(cell.model)) {
      this._tracked.add(cell.model);
      cell.model.metadataChanged.connect(this._onCellMetadata, this);
      cell.model.contentChanged.connect(this._onCellContent, this);
    }
  }

  /**
   * Push each anchored comment's range into the cell's editor. Ranges already
   * live in the editor win, since CodeMirror has been mapping them through the
   * user's edits; ranges seen for the first time are re-anchored against the
   * current text via their saved quote.
   */
  /**
   * DOM-anchored comments (rendered markdown / outputs) resolve by searching for
   * their quote. Unresolvable ones are flagged outdated rather than relocated.
   */
  private _syncDomAnchors(cell: Cell): void {
    const list = readComments(cell.model);
    const domComments = list.filter(c => c.anchor?.region);
    if (!domComments.length) {
      return;
    }
    let changed = false;
    for (const comment of domComments) {
      const anchor = comment.anchor as IDomAnchorSpec;
      const root = regionRoot(cell, anchor);
      if (!root) {
        // Region isn't rendered right now (e.g. a markdown cell switched to
        // edit mode). That says nothing about whether the quote still exists,
        // so leave the comment's state alone.
        continue;
      }
      const outdated = !findRange(root, anchor.quote);
      if (comment.outdated !== outdated) {
        comment.outdated = outdated;
        changed = true;
      }
    }
    if (changed) {
      writeComments(cell.model, list);
    }
  }

  /** Repaint every DOM anchor highlight for this notebook. */
  private _paintDomHighlights(): void {
    const ranges: Range[] = [];
    for (const note of this._notes.values()) {
      const range = note.domRange;
      if (range) {
        ranges.push(range);
      }
    }
    paintHighlights(ranges);
  }

  private _applyAnchors(cell: Cell): void {
    this._syncDomAnchors(cell);
    const view = editorViewFor(cell);
    if (!view) {
      return;
    }
    const comments = readComments(cell.model);
    const anchored = comments.filter(c => c.anchor);
    if (!anchored.length) {
      applyAnchors(view, []);
      return;
    }
    const live = new Map(readAnchors(view).map(r => [r.id, r]));
    const source = view.state.doc.toString();
    const ranges: IAnchorRange[] = [];
    const outdatedChanges: Array<{ id: string; outdated: boolean }> = [];

    for (const c of anchored) {
      const existing = live.get(c.id);
      if (existing) {
        ranges.push({ ...existing, outdated: c.outdated });
        continue;
      }
      const found = reanchor(source, c.anchor!);
      if (found) {
        ranges.push({ id: c.id, from: found.from, to: found.to });
        if (c.outdated) {
          outdatedChanges.push({ id: c.id, outdated: false });
        }
      } else if (!c.outdated) {
        outdatedChanges.push({ id: c.id, outdated: true });
      }
    }
    applyAnchors(view, ranges);

    // Only write when a comment actually flipped state, so this can't loop.
    if (outdatedChanges.length) {
      const list = readComments(cell.model);
      for (const change of outdatedChanges) {
        const target = list.find(c => c.id === change.id);
        if (target) {
          target.outdated = change.outdated;
        }
      }
      writeComments(cell.model, list);
    }
  }

  /** Persist offsets/quotes that CodeMirror has mapped through recent edits. */
  private _syncAnchorOffsets(cell: Cell): void {
    const view = editorViewFor(cell);
    if (!view) {
      return;
    }
    const live = readAnchors(view);
    if (!live.length) {
      return;
    }
    const source = view.state.doc.toString();
    const list = readComments(cell.model);
    let changed = false;
    for (const range of live) {
      const comment = list.find(c => c.id === range.id);
      if (!comment?.anchor) {
        continue;
      }
      const quote = source.slice(range.from, range.to);
      if (
        comment.anchor.from !== range.from ||
        comment.anchor.to !== range.to ||
        comment.anchor.quote !== quote
      ) {
        comment.anchor = { from: range.from, to: range.to, quote };
        changed = true;
      }
    }
    if (changed) {
      writeComments(cell.model, list);
    }
  }

  private _onCellContent(model: ICellModel): void {
    const cell = this._cellFor(model);
    if (!cell) {
      return;
    }
    if (this._syncTimer) {
      window.clearTimeout(this._syncTimer);
    }
    this._syncTimer = window.setTimeout(() => {
      this._syncTimer = 0;
      if (!this._isDisposed) {
        this._syncAnchorOffsets(cell);
      }
    }, 1200);
  }

  private _onCellMetadata(model: ICellModel, change: { key: string }): void {
    if (
      change.key !== COMMENTS_METADATA_KEY &&
      change.key !== LEGACY_COMMENT_KEY
    ) {
      return;
    }
    const cell = this._cellFor(model);
    if (cell) {
      this._applyAnchors(cell);
      this._syncNotes(cell);
    }
    this._scheduleSave();
  }

  private _syncNotes(cell: Cell): void {
    const comments = readComments(cell.model);
    const showResolved = this._options.showResolved();
    for (const comment of comments) {
      const existing = this._notes.get(comment.id);
      const want = isVisible(comment, showResolved);
      if (want && !existing) {
        const note = new FloatingNote(
          cell,
          comment.id,
          this._panel.content.node,
          this._rendermime,
          this._authors
        );
        this._notes.set(comment.id, note);
        NoteOverlay.get().add(note);
        note.render();
      } else if (!want && existing) {
        NoteOverlay.get().remove(existing);
        existing.dispose();
        this._notes.delete(comment.id);
      }
    }
    // Drop notes whose comments were deleted outright.
    const ids = new Set(comments.map(c => c.id));
    for (const [id, note] of this._notes) {
      if (note.cellModel === cell.model && !ids.has(id)) {
        NoteOverlay.get().remove(note);
        note.dispose();
        this._notes.delete(id);
      }
    }
    this._paintDomHighlights();
  }

  private _scheduleSave(): void {
    if (this._isDisposed) {
      return;
    }
    // Shared coordinator: serialized with every other feature saving this same
    // notebook, so two saves never overlap and race into a phantom conflict.
    requestContextSave(this._panel.context);
  }

  private _cellFor(model: ICellModel): Cell | null {
    for (const cell of this._panel.content.widgets) {
      if (cell.model === model) {
        return cell;
      }
    }
    return null;
  }

  private _panel: NotebookPanel;
  private _authors: IAuthorApi;
  private _rendermime: IRenderMimeRegistry;
  private _options: INoteOptions;
  private _isDisposed = false;
  private _syncTimer = 0;
  private _notes = new Map<string, FloatingNote>();
  private _tracked = new Set<ICellModel>();
}
