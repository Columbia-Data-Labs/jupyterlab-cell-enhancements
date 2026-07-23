import { IDisposable } from '@lumino/disposable';
import { Widget } from '@lumino/widgets';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Cell, ICellModel } from '@jupyterlab/cells';

/**
 * Metadata key under which a cell's title is stored. Kept distinct from any
 * nbformat-reserved key so we never clobber existing notebook metadata.
 */
export const TITLE_METADATA_KEY = 'cell_title';

const HEADER_CLASS = 'cee-title-header';
const DISPLAY_CLASS = 'cee-title-display';
const EMPTY_CLASS = 'cee-title-empty';
const INPUT_CLASS = 'cee-title-input';
const PLACEHOLDER_TEXT = 'Add a cell title…';

/**
 * Marker stored on a Cell so we only attach one title header per widget.
 */
const HEADER_PROP = '__ceeTitleHeader';

/**
 * An editable title shown above a single cell. Reads from and writes to the
 * cell model's metadata so titles persist with the notebook.
 */
class CellTitleHeader extends Widget {
  constructor(model: ICellModel) {
    super();
    this._model = model;
    this.addClass(HEADER_CLASS);

    this._display = document.createElement('div');
    this._display.className = DISPLAY_CLASS;
    this._display.addEventListener('click', this._beginEdit);
    this.node.appendChild(this._display);

    model.metadataChanged.connect(this._onMetadataChanged, this);
    this._render();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._model.metadataChanged.disconnect(this._onMetadataChanged, this);
    this._display.removeEventListener('click', this._beginEdit);
    super.dispose();
  }

  private get _title(): string {
    const value = this._model.getMetadata(TITLE_METADATA_KEY);
    return typeof value === 'string' ? value : '';
  }

  private _render(): void {
    if (this._editing) {
      return;
    }
    const title = this._title;
    if (title) {
      this._display.textContent = title;
      this._display.classList.remove(EMPTY_CLASS);
    } else {
      this._display.textContent = PLACEHOLDER_TEXT;
      this._display.classList.add(EMPTY_CLASS);
    }
  }

  private _onMetadataChanged(
    _: ICellModel,
    change: { key: string }
  ): void {
    if (change.key === TITLE_METADATA_KEY) {
      this._render();
    }
  }

  private _beginEdit = (): void => {
    if (this._editing) {
      return;
    }
    this._editing = true;
    const input = document.createElement('input');
    input.className = INPUT_CLASS;
    input.type = 'text';
    input.value = this._title;
    input.placeholder = PLACEHOLDER_TEXT;

    const commit = (save: boolean): void => {
      if (!this._editing) {
        return;
      }
      this._editing = false;
      if (save) {
        const next = input.value.trim();
        if (next) {
          this._model.setMetadata(TITLE_METADATA_KEY, next);
        } else {
          this._model.deleteMetadata(TITLE_METADATA_KEY);
        }
      }
      if (input.parentNode) {
        input.parentNode.removeChild(input);
      }
      this._display.style.display = '';
      this._render();
    };

    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        commit(false);
      }
      event.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));

    this._display.style.display = 'none';
    this.node.appendChild(input);
    input.focus();
    input.select();
  };

  private _model: ICellModel;
  private _display: HTMLDivElement;
  private _editing = false;
}

/**
 * Attaches and maintains title headers for every cell in a notebook panel.
 */
export class CellTitleManager implements IDisposable {
  constructor(panel: NotebookPanel) {
    this._panel = panel;
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
      this._ensureHeader(cell);
    }
  }

  private _ensureHeader(cell: Cell): void {
    const decorated = cell as Cell & { [HEADER_PROP]?: CellTitleHeader };
    if (decorated[HEADER_PROP] && !decorated[HEADER_PROP]!.isDisposed) {
      return;
    }
    const header = new CellTitleHeader(cell.model);
    decorated[HEADER_PROP] = header;
    // Insert the title as the first child so it renders above the prompt/input.
    (cell.layout as any).insertWidget(0, header);
  }

  private _panel: NotebookPanel;
  private _isDisposed = false;
}
