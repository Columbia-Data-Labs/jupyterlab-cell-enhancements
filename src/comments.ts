import { IDisposable } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Cell, ICellModel } from '@jupyterlab/cells';
import type { IRenderMimeRegistry } from '@jupyterlab/rendermime';

/**
 * Metadata key under which a cell's comment is stored. Kept distinct from any
 * nbformat-reserved key so we never clobber existing notebook metadata.
 *
 * The stored value is an {@link IComment}: markdown `text` (which may contain
 * `$…$` LaTeX), an `author`, an `open` flag (is the floating note showing), and
 * a `dx`/`dy` drag offset from the note's default anchor beside the cell.
 */
export const COMMENT_METADATA_KEY = 'cell_comment';

interface IComment {
  author: string;
  text: string;
  open: boolean;
  dx: number;
  dy: number;
}

const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * Minimal structural view of a rendermime renderer. Typing it structurally (as
 * opposed to importing IRenderMime.IRenderer) sidesteps cross-package type
 * identity clashes when @lumino/widgets / rendermime-interfaces get duplicated
 * in node_modules; at runtime JupyterLab shares single singletons of both.
 */
interface IRenderedWidget {
  readonly node: HTMLElement;
  renderModel(model: unknown): Promise<void>;
  dispose(): void;
}

/** Horizontal gap between the cell's right edge and the note's default anchor. */
const ANCHOR_GAP = 20;
/** Fallback note width (px) used before the element has laid out. */
const NOTE_WIDTH = 260;

const MARKER_WIDGET_CLASS = 'cee-comment-widget';
const MARKER_CLASS = 'cee-comment-marker';
const HAS_COMMENT_CLASS = 'cee-has-comment';
const OPEN_CLASS = 'cee-comment-open';
const CELL_CLASS = 'cee-cell-commentable';
const MARKER_PROP = '__ceeCommentMarker';

/**
 * Normalises whatever is stored in metadata into a full {@link IComment}, or
 * null when there is nothing stored. Tolerates a bare string (legacy/hand-edited
 * notebooks) and fills in missing fields with defaults.
 */
function parseComment(value: unknown): IComment | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    return { author: '', text: value, open: false, dx: 0, dy: 0 };
  }
  if (typeof value === 'object') {
    const v = value as Partial<IComment>;
    return {
      author: typeof v.author === 'string' ? v.author : '',
      text: typeof v.text === 'string' ? v.text : '',
      open: v.open === true,
      dx: typeof v.dx === 'number' ? v.dx : 0,
      dy: typeof v.dy === 'number' ? v.dy : 0
    };
  }
  return null;
}

/** True when the cell has a comment worth showing a solid marker for. */
function hasText(c: IComment | null): boolean {
  return !!c && c.text.trim().length > 0;
}

/* ===================================================================== *
 *  Overlay — a single body-level layer that hosts every floating note.  *
 * ===================================================================== */

/**
 * A viewport-fixed overlay appended to `document.body`. Because it lives outside
 * the notebook's scrolling/clipping context, notes it hosts can float over the
 * sidebars and everything else. A single requestAnimationFrame loop repositions
 * all live notes so they track their cells as the notebook scrolls.
 */
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
 *  FloatingNote — one draggable, markdown-rendered sticky note.         *
 * ===================================================================== */

class FloatingNote {
  constructor(
    cell: Cell,
    viewport: HTMLElement,
    rendermime: IRenderMimeRegistry,
    getAuthor: () => string
  ) {
    this._cell = cell;
    this._model = cell.model;
    this._viewport = viewport;
    this._rendermime = rendermime;
    this._getAuthor = getAuthor;

    this.node = document.createElement('div');
    this.node.className = 'cee-floating-note';

    this._header = document.createElement('div');
    this._header.className = 'cee-note-header';
    this._avatar = document.createElement('span');
    this._avatar.className = 'cee-note-avatar';
    this._authorEl = document.createElement('span');
    this._authorEl.className = 'cee-note-author';
    const spacer = document.createElement('span');
    spacer.className = 'cee-note-spacer';
    this._editBtn = this._makeButton('✎', 'Edit', () => this._beginEdit());
    this._closeBtn = this._makeButton('✕', 'Close', () => this._setOpen(false));
    this._header.appendChild(this._avatar);
    this._header.appendChild(this._authorEl);
    this._header.appendChild(spacer);
    this._header.appendChild(this._editBtn);
    this._header.appendChild(this._closeBtn);

    this._body = document.createElement('div');
    this._body.className = 'cee-note-body';

    this.node.appendChild(this._header);
    this.node.appendChild(this._body);

    this.line = document.createElementNS(SVGNS, 'line');
    this.line.setAttribute('class', 'cee-note-line');
    this.dot = document.createElementNS(SVGNS, 'circle');
    this.dot.setAttribute('class', 'cee-note-dot');
    this.dot.setAttribute('r', '3.5');

    this._header.addEventListener('mousedown', this._onDragStart);
    this._model.metadataChanged.connect(this._onMetadataChanged, this);

    // Author is safe to show immediately; the markdown body waits for render(),
    // which the manager calls once the note is attached to the DOM.
    this._setAuthor(this._comment()?.author || '');
    if (!hasText(this._comment())) {
      // A freshly-opened, empty note goes straight into edit mode.
      this._beginEdit();
    }
  }

  readonly node: HTMLDivElement;
  readonly line: SVGLineElement;
  readonly dot: SVGCircleElement;

  /** Render (or re-render) the markdown body. Must be called while attached. */
  render(): void {
    this._render();
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._model.metadataChanged.disconnect(this._onMetadataChanged, this);
    this._header.removeEventListener('mousedown', this._onDragStart);
    document.removeEventListener('mousemove', this._onDragMove);
    document.removeEventListener('mouseup', this._onDragEnd);
    this._renderer?.dispose();
  }

  /** Recompute on-screen placement. Called every animation frame. */
  reposition(): void {
    if (this._disposed) {
      return;
    }
    const rect = this._cell.node.getBoundingClientRect();
    const view = this._viewport.getBoundingClientRect();
    const onscreen =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > view.top &&
      rect.top < view.bottom;

    if (!onscreen) {
      this.node.style.display = 'none';
      this.line.style.display = 'none';
      this.dot.style.display = 'none';
      return;
    }
    this.node.style.display = '';
    this.line.style.display = '';
    this.dot.style.display = '';

    const c = this._comment();
    const dx = this._dragging ? this._dx : c?.dx ?? 0;
    const dy = this._dragging ? this._dy : c?.dy ?? 0;

    const width = this.node.offsetWidth || NOTE_WIDTH;
    const height = this.node.offsetHeight || 140;
    // Anchor at the cell's vertical centre, and centre the note against it.
    const anchorY = rect.top + rect.height / 2;
    let x = rect.right + ANCHOR_GAP + dx;
    let y = anchorY - height / 2 + dy;
    // Keep the note within the window and roughly within the notebook viewport.
    x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    y = Math.max(view.top + 4, Math.min(y, view.bottom - 40));
    this.node.style.transform = `translate(${x}px, ${y}px)`;

    // Leader line: from the cell's right edge at mid-height (so it never crosses
    // the cell's content) to the note's left edge, centre-to-centre.
    const ax = rect.right - 4;
    const ay = anchorY;
    const bx = x;
    const by = y + height / 2;
    this.line.setAttribute('x1', String(ax));
    this.line.setAttribute('y1', String(ay));
    this.line.setAttribute('x2', String(bx));
    this.line.setAttribute('y2', String(by));
    this.dot.setAttribute('cx', String(ax));
    this.dot.setAttribute('cy', String(ay));
  }

  private _comment(): IComment | null {
    return parseComment(this._model.getMetadata(COMMENT_METADATA_KEY));
  }

  private _write(patch: Partial<IComment>): void {
    const base = this._comment() ?? {
      author: '',
      text: '',
      open: true,
      dx: 0,
      dy: 0
    };
    const next = { ...base, ...patch };
    if (!next.open && !next.text.trim()) {
      this._model.deleteMetadata(COMMENT_METADATA_KEY);
    } else {
      this._model.setMetadata(COMMENT_METADATA_KEY, next);
    }
  }

  private _setOpen(open: boolean): void {
    this._write({ open });
  }

  private _render(): void {
    if (this._editing) {
      return;
    }
    const c = this._comment();
    this._setAuthor(c?.author || '');
    this._renderBody(c?.text ?? '');
  }

  private _setAuthor(author: string): void {
    this._authorEl.textContent = author || 'Note';
    const initial = author.trim().charAt(0).toUpperCase();
    this._avatar.textContent = initial || '📝';
    this._avatar.classList.toggle('cee-note-avatar-empty', !initial);
  }

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
    // Attach as a Lumino widget first so the renderer's onAfterAttach runs and
    // MathJax typesets the LaTeX; then render the model into it. The cast bridges
    // a duplicated @lumino/widgets type identity — at runtime JupyterLab shares a
    // single @lumino/widgets singleton, so this is safe.
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
    const hint = document.createElement('span');
    hint.className = 'cee-note-hint';
    hint.textContent = 'Ctrl+Enter save · Esc cancel';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'cee-note-delete';
    del.textContent = 'Delete';
    actions.appendChild(hint);
    actions.appendChild(del);

    this._body.appendChild(textarea);
    this._body.appendChild(actions);

    const finish = (save: boolean): void => {
      if (!this._editing) {
        return;
      }
      this._editing = false;
      this.node.classList.remove('cee-note-editing');
      if (save) {
        const text = textarea.value;
        const author = this._comment()?.author || this._getAuthor();
        this._write({ text, author, open: true });
      }
      this._render();
      // If the note was cancelled while still empty, close it entirely.
      if (!save && !hasText(this._comment())) {
        this._setOpen(false);
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
      textarea.value = '';
      this._editing = false;
      this.node.classList.remove('cee-note-editing');
      this._write({ text: '', open: false });
    });

    textarea.focus();
    textarea.select();
  }

  private _onDragStart = (event: MouseEvent): void => {
    // Ignore drags that begin on the header buttons.
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

  private _onMetadataChanged(_: ICellModel, change: { key: string }): void {
    if (change.key === COMMENT_METADATA_KEY && !this._editing && !this._dragging) {
      this._render();
    }
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
  private _model: ICellModel;
  private _viewport: HTMLElement;
  private _rendermime: IRenderMimeRegistry;
  private _getAuthor: () => string;
  private _header: HTMLDivElement;
  private _avatar: HTMLSpanElement;
  private _authorEl: HTMLSpanElement;
  private _editBtn: HTMLButtonElement;
  private _closeBtn: HTMLButtonElement;
  private _body: HTMLDivElement;
  private _renderer: IRenderedWidget | null = null;
  private _editing = false;
  private _dragging = false;
  private _startX = 0;
  private _startY = 0;
  private _dx = 0;
  private _dy = 0;
  private _disposed = false;
}

/* ===================================================================== *
 *  Marker — the corner indicator on each cell; toggles its note open.   *
 * ===================================================================== */

class CellCommentMarker extends Widget {
  constructor(model: ICellModel) {
    super();
    this._model = model;
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
    const c = parseComment(this._model.getMetadata(COMMENT_METADATA_KEY));
    this.toggleClass(HAS_COMMENT_CLASS, hasText(c));
    this.toggleClass(OPEN_CLASS, !!c && c.open);
  }

  private _onMetadataChanged(_: ICellModel, change: { key: string }): void {
    if (change.key === COMMENT_METADATA_KEY) {
      this._render();
    }
  }

  private _onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const c = parseComment(this._model.getMetadata(COMMENT_METADATA_KEY)) ?? {
      author: '',
      text: '',
      open: false,
      dx: 0,
      dy: 0
    };
    const next = { ...c, open: !c.open };
    if (!next.open && !next.text.trim()) {
      this._model.deleteMetadata(COMMENT_METADATA_KEY);
    } else {
      this._model.setMetadata(COMMENT_METADATA_KEY, next);
    }
  };

  private _model: ICellModel;
  private _marker: HTMLDivElement;
}

/* ===================================================================== *
 *  Manager — one per notebook; wires markers and floating notes.        *
 * ===================================================================== */

export class CellCommentManager implements IDisposable {
  constructor(
    panel: NotebookPanel,
    getAuthor: () => string,
    rendermime: IRenderMimeRegistry
  ) {
    this._panel = panel;
    this._getAuthor = getAuthor;
    this._rendermime = rendermime;
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
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
      this._saveTimer = 0;
    }
    for (const note of this._notes.values()) {
      NoteOverlay.get().remove(note);
      note.dispose();
    }
    this._notes.clear();
    for (const model of this._tracked) {
      model.metadataChanged.disconnect(this._onCellMetadata, this);
    }
    this._tracked.clear();
    const model = this._panel.content.model;
    if (model) {
      model.cells.changed.disconnect(this._updateAll, this);
    }
    this._panel.content.modelChanged.disconnect(this._onModelChanged, this);
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
    const live = new Set<ICellModel>();
    for (const cell of this._panel.content.widgets) {
      live.add(cell.model);
      this._ensureCell(cell);
      this._syncNote(cell);
    }
    // Drop notes whose cells have been removed from the notebook.
    for (const [model, note] of this._notes) {
      if (!live.has(model)) {
        NoteOverlay.get().remove(note);
        note.dispose();
        this._notes.delete(model);
      }
    }
  }

  private _ensureCell(cell: Cell): void {
    const decorated = cell as Cell & { [MARKER_PROP]?: CellCommentMarker };
    if (decorated[MARKER_PROP] && !decorated[MARKER_PROP]!.isDisposed) {
      return;
    }
    cell.addClass(CELL_CLASS);
    const marker = new CellCommentMarker(cell.model);
    decorated[MARKER_PROP] = marker;
    (cell.layout as any).addWidget(marker);

    if (!this._tracked.has(cell.model)) {
      this._tracked.add(cell.model);
      cell.model.metadataChanged.connect(this._onCellMetadata, this);
    }
  }

  private _onCellMetadata(model: ICellModel, change: { key: string }): void {
    if (change.key !== COMMENT_METADATA_KEY) {
      return;
    }
    const cell = this._cellFor(model);
    if (cell) {
      this._syncNote(cell);
    }
    // Note state (open/closed, position, text) lives in cell metadata. Persist it
    // right away so a note's placement survives closing without an explicit save.
    this._scheduleSave();
  }

  /**
   * Debounced notebook save. Debouncing matters most while dragging, which emits
   * a metadata write on every drop.
   */
  private _scheduleSave(): void {
    if (this._isDisposed) {
      return;
    }
    if (this._saveTimer) {
      window.clearTimeout(this._saveTimer);
    }
    this._saveTimer = window.setTimeout(() => {
      this._saveTimer = 0;
      const context = this._panel.context;
      if (this._isDisposed || !context || context.isDisposed) {
        return;
      }
      void context.save().catch(() => {
        /* a failed autosave shouldn't disrupt editing */
      });
    }, 700);
  }

  /** Create or tear down a cell's floating note to match its `open` flag. */
  private _syncNote(cell: Cell): void {
    const c = parseComment(cell.model.getMetadata(COMMENT_METADATA_KEY));
    const want = !!c && c.open;
    const existing = this._notes.get(cell.model);
    if (want && !existing) {
      const note = new FloatingNote(
        cell,
        this._panel.content.node,
        this._rendermime,
        this._getAuthor
      );
      this._notes.set(cell.model, note);
      NoteOverlay.get().add(note);
      // Render only after the note is in the DOM, so the markdown renderer's
      // attach lifecycle (and thus math typesetting) runs.
      note.render();
    } else if (!want && existing) {
      NoteOverlay.get().remove(existing);
      existing.dispose();
      this._notes.delete(cell.model);
    }
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
  private _getAuthor: () => string;
  private _rendermime: IRenderMimeRegistry;
  private _isDisposed = false;
  private _saveTimer = 0;
  private _notes = new Map<ICellModel, FloatingNote>();
  private _tracked = new Set<ICellModel>();
}
