import { IDisposable } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Cell, ICellModel } from '@jupyterlab/cells';

/**
 * Metadata key under which a cell's comment is stored. Kept distinct from any
 * nbformat-reserved key so we never clobber existing notebook metadata. The
 * value is an { author, text } object; a bare string is also accepted for
 * forward/backward compatibility.
 */
export const COMMENT_METADATA_KEY = 'cell_comment';

interface IComment {
  author: string;
  text: string;
}

const WIDGET_CLASS = 'cee-comment-widget';
const MARKER_CLASS = 'cee-comment-marker';
const NOTE_CLASS = 'cee-comment-note';
const AUTHOR_CLASS = 'cee-comment-author';
const TEXT_CLASS = 'cee-comment-text';
const EDITOR_CLASS = 'cee-comment-editor';
const HAS_COMMENT_CLASS = 'cee-has-comment';
const CELL_CLASS = 'cee-cell-commentable';
const PLACEHOLDER_TEXT = 'Add a comment…';

/**
 * Marker stored on a Cell so we only attach one comment widget per cell.
 */
const WIDGET_PROP = '__ceeCommentWidget';

/**
 * Normalises whatever is stored in metadata into an {@link IComment}, or null
 * when there is no comment. Tolerates the legacy/plain-string shape so hand-
 * edited notebooks and older versions still render.
 */
function parseComment(value: unknown): IComment | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? { author: '', text } : null;
  }
  if (value && typeof value === 'object') {
    const v = value as Partial<IComment>;
    const text = typeof v.text === 'string' ? v.text : '';
    const author = typeof v.author === 'string' ? v.author : '';
    return text.trim() ? { author, text } : null;
  }
  return null;
}

/**
 * An Excel-style comment anchored to a whole cell: a small corner marker plus a
 * floating note revealed on hover. Reads from and writes to the cell model's
 * metadata so comments persist with the notebook.
 */
class CellCommentWidget extends Widget {
  constructor(model: ICellModel, getAuthor: () => string) {
    super();
    this._model = model;
    this._getAuthor = getAuthor;
    this.addClass(WIDGET_CLASS);

    this._marker = document.createElement('div');
    this._marker.className = MARKER_CLASS;
    this._marker.setAttribute('role', 'button');
    this._marker.setAttribute('aria-label', 'Cell comment');
    this._marker.addEventListener('click', this._onMarkerClick);
    this.node.appendChild(this._marker);

    this._note = document.createElement('div');
    this._note.className = NOTE_CLASS;
    this._author = document.createElement('div');
    this._author.className = AUTHOR_CLASS;
    this._text = document.createElement('div');
    this._text.className = TEXT_CLASS;
    this._note.appendChild(this._author);
    this._note.appendChild(this._text);
    this.node.appendChild(this._note);

    model.metadataChanged.connect(this._onMetadataChanged, this);
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._model.metadataChanged.disconnect(this._onMetadataChanged, this);
    this._marker.removeEventListener('click', this._onMarkerClick);
    super.dispose();
  }

  private _comment(): IComment | null {
    return parseComment(this._model.getMetadata(COMMENT_METADATA_KEY));
  }

  private _render(): void {
    if (this._editing) {
      return;
    }
    const comment = this._comment();
    if (comment) {
      this.addClass(HAS_COMMENT_CLASS);
      this._author.textContent = comment.author || 'Comment';
      this._author.style.display = comment.author ? '' : 'none';
      this._text.textContent = comment.text;
    } else {
      this.removeClass(HAS_COMMENT_CLASS);
      this._author.textContent = '';
      this._text.textContent = '';
    }
  }

  private _onMetadataChanged(_: ICellModel, change: { key: string }): void {
    if (change.key === COMMENT_METADATA_KEY) {
      this._render();
    }
  }

  private _onMarkerClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this._beginEdit();
  };

  private _beginEdit(): void {
    if (this._editing) {
      return;
    }
    this._editing = true;
    this.addClass(HAS_COMMENT_CLASS);
    this._note.style.display = 'none';

    const editor = document.createElement('div');
    editor.className = EDITOR_CLASS;

    const textarea = document.createElement('textarea');
    textarea.value = this._comment()?.text ?? '';
    textarea.placeholder = PLACEHOLDER_TEXT;
    textarea.rows = 3;

    const actions = document.createElement('div');
    const hint = document.createElement('span');
    hint.className = 'cee-comment-hint';
    hint.textContent = 'Ctrl+Enter to save · Esc to cancel';
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Delete';
    del.className = 'cee-comment-delete';
    actions.className = 'cee-comment-actions';
    actions.appendChild(hint);
    actions.appendChild(del);

    editor.appendChild(textarea);
    editor.appendChild(actions);

    const commit = (save: boolean): void => {
      if (!this._editing) {
        return;
      }
      this._editing = false;
      if (save) {
        const next = textarea.value.trim();
        if (next) {
          const existing = this._comment();
          this._model.setMetadata(COMMENT_METADATA_KEY, {
            author: existing?.author || this._getAuthor(),
            text: next
          });
        } else {
          this._model.deleteMetadata(COMMENT_METADATA_KEY);
        }
      }
      if (editor.parentNode) {
        editor.parentNode.removeChild(editor);
      }
      this._note.style.display = '';
      this._render();
    };

    textarea.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        commit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        commit(false);
      }
      event.stopPropagation();
    });
    textarea.addEventListener('blur', () => commit(true));
    del.addEventListener('mousedown', (event: MouseEvent) => {
      // mousedown fires before the textarea's blur, so clear first then commit
      // empty, which deletes the metadata.
      event.preventDefault();
      textarea.value = '';
      commit(true);
    });

    this.node.appendChild(editor);
    textarea.focus();
    textarea.select();
  }

  private _model: ICellModel;
  private _getAuthor: () => string;
  private _marker: HTMLDivElement;
  private _note: HTMLDivElement;
  private _author: HTMLDivElement;
  private _text: HTMLDivElement;
  private _editing = false;
}

/**
 * Attaches and maintains a comment widget for every cell in a notebook panel.
 */
export class CellCommentManager implements IDisposable {
  constructor(panel: NotebookPanel, getAuthor: () => string) {
    this._panel = panel;
    this._getAuthor = getAuthor;
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
    for (const cell of this._panel.content.widgets) {
      this._ensureWidget(cell);
    }
  }

  private _ensureWidget(cell: Cell): void {
    const decorated = cell as Cell & { [WIDGET_PROP]?: CellCommentWidget };
    if (decorated[WIDGET_PROP] && !decorated[WIDGET_PROP]!.isDisposed) {
      return;
    }
    // The marker is absolutely positioned in the cell's top-right corner, so the
    // cell itself must establish a positioning context.
    cell.addClass(CELL_CLASS);
    const widget = new CellCommentWidget(cell.model, this._getAuthor);
    decorated[WIDGET_PROP] = widget;
    (cell.layout as any).addWidget(widget);
  }

  private _panel: NotebookPanel;
  private _getAuthor: () => string;
  private _isDisposed = false;
}
