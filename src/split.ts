import { IDisposable } from '@lumino/disposable';
import { PanelLayout, Widget } from '@lumino/widgets';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Cell, ICellModel } from '@jupyterlab/cells';

import { requestContextSave } from './autosave';

/**
 * Side-by-side input/output for a single cell.
 *
 * The layout itself is pure CSS, driven by a class on the cell node and a
 * `--cee-split-ratio` custom property. This module owns the state: which cells
 * are split, how wide their input pane is, and keeping both in cell metadata so
 * the arrangement travels with the .ipynb.
 */

/** Whether this cell shows input and output side by side. Boolean. */
export const SPLIT_METADATA_KEY = 'cell_split';

/** Fraction of the cell width given to the input pane. Number in [0.2, 0.8]. */
export const SPLIT_RATIO_METADATA_KEY = 'cell_split_ratio';

export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

const SPLIT_CLASS = 'cee-cell-split';
const GUTTER_CLASS = 'cee-split-gutter';
const GRIP_CLASS = 'cee-split-grip';
const DRAGGING_CLASS = 'cee-split-dragging';
const OUTPUT_WRAPPER_CLASS = 'jp-Cell-outputWrapper';
const RATIO_VAR = '--cee-split-ratio';

/** Marker stored on a Cell so we only attach one gutter per widget. */
const GUTTER_PROP = '__ceeSplitGutter';

/** Defaults for cells that carry no explicit metadata of their own. */
export interface ISplitOptions {
  defaultOn(): boolean;
  defaultRatio(): number;
}

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

/** Only code cells have a separate output area to put beside their input. */
export function canSplit(model: ICellModel): boolean {
  return model.type === 'code';
}

/**
 * Whether a cell is split. Cells with no `cell_split` metadata inherit the
 * global default, so flipping the setting moves every untouched cell with it.
 */
export function isSplitOn(model: ICellModel, options: ISplitOptions): boolean {
  const value = model.getMetadata(SPLIT_METADATA_KEY);
  if (typeof value === 'boolean') {
    return value;
  }
  return options.defaultOn();
}

export function ratioOf(model: ICellModel, options: ISplitOptions): number {
  const value = model.getMetadata(SPLIT_RATIO_METADATA_KEY);
  return clampRatio(
    typeof value === 'number' ? value : options.defaultRatio()
  );
}

/**
 * Write a value to cell metadata only when it differs from the current default,
 * so notebooks don't accumulate a redundant key on every cell the user touches.
 */
function store(
  model: ICellModel,
  key: string,
  value: boolean | number,
  fallback: boolean | number
): void {
  if (value === fallback) {
    model.deleteMetadata(key);
  } else {
    model.setMetadata(key, value);
  }
}

export function setSplitOn(
  model: ICellModel,
  on: boolean,
  options: ISplitOptions
): void {
  store(model, SPLIT_METADATA_KEY, on, options.defaultOn());
}

export function setRatio(
  model: ICellModel,
  ratio: number,
  options: ISplitOptions
): void {
  store(
    model,
    SPLIT_RATIO_METADATA_KEY,
    Number(clampRatio(ratio).toFixed(3)),
    Number(clampRatio(options.defaultRatio()).toFixed(3))
  );
}

/* ===================================================================== *
 *  Gutter                                                               *
 * ===================================================================== */

interface IGutterHandlers {
  /** Called continuously while dragging (commit false) and on release. */
  change(ratio: number, commit: boolean): void;
  /** Double-click: drop the per-cell override and fall back to the default. */
  reset(): void;
}

/**
 * The draggable divider between the two panes.
 *
 * While dragging we write the ratio straight onto the cell's inline style so
 * the panes track the pointer at frame rate, and only persist to metadata on
 * release — a metadata write per mousemove would thrash the notebook model.
 */
class SplitGutter extends Widget {
  constructor(cell: Cell, handlers: IGutterHandlers) {
    super();
    this.addClass(GUTTER_CLASS);
    this._cell = cell;
    this._handlers = handlers;
    this.node.setAttribute('role', 'separator');
    this.node.setAttribute('aria-orientation', 'vertical');
    this.node.setAttribute('aria-label', 'Resize the input and output panes');
    this.node.tabIndex = 0;
    this.node.title = 'Drag to resize · double-click to reset';

    const grip = document.createElement('div');
    grip.className = GRIP_CLASS;
    this.node.appendChild(grip);

    this.node.addEventListener('mousedown', this._onMouseDown);
    this.node.addEventListener('dblclick', this._onDoubleClick);
    this.node.addEventListener('keydown', this._onKeyDown);
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._endDrag();
    this.node.removeEventListener('mousedown', this._onMouseDown);
    this.node.removeEventListener('dblclick', this._onDoubleClick);
    this.node.removeEventListener('keydown', this._onKeyDown);
    super.dispose();
  }

  /** Kept in sync by the manager so keyboard nudges start from the right place. */
  set ratio(value: number) {
    this._ratio = value;
  }

  private _onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) {
      return;
    }
    // Swallow the event: the notebook would otherwise treat it as a click on
    // the cell and start a selection drag.
    event.preventDefault();
    event.stopPropagation();

    const node = this._cell.node;
    const box = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const width = box.width - padLeft - padRight;
    if (width <= 0) {
      return;
    }
    this._track = { left: box.left + padLeft, width };
    document.body.classList.add(DRAGGING_CLASS);
    window.addEventListener('mousemove', this._onMouseMove, true);
    window.addEventListener('mouseup', this._onMouseUp, true);
  };

  private _onMouseMove = (event: MouseEvent): void => {
    if (!this._track) {
      return;
    }
    event.preventDefault();
    const ratio = clampRatio(
      (event.clientX - this._track.left) / this._track.width
    );
    this._pending = ratio;
    this._handlers.change(ratio, false);
  };

  private _onMouseUp = (event: MouseEvent): void => {
    if (!this._track) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this._endDrag();
    if (this._pending !== null) {
      this._handlers.change(this._pending, true);
      this._pending = null;
    }
  };

  private _endDrag(): void {
    if (!this._track) {
      return;
    }
    this._track = null;
    document.body.classList.remove(DRAGGING_CLASS);
    window.removeEventListener('mousemove', this._onMouseMove, true);
    window.removeEventListener('mouseup', this._onMouseUp, true);
  }

  private _onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this._handlers.reset();
  };

  private _onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 0.05 : 0.02;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') {
      next = this._ratio - step;
    } else if (event.key === 'ArrowRight') {
      next = this._ratio + step;
    } else if (event.key === 'Home') {
      next = 0.5;
    }
    if (next === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this._handlers.change(clampRatio(next), true);
  };

  private _cell: Cell;
  private _handlers: IGutterHandlers;
  private _ratio = 0.5;
  private _pending: number | null = null;
  private _track: { left: number; width: number } | null = null;
}

/* ===================================================================== *
 *  Ratio dialog                                                         *
 * ===================================================================== */

/** A slider for the default input-pane width, shown as a percentage. */
class RatioBody extends Widget implements Dialog.IBodyWidget<number> {
  constructor(current: number) {
    super();
    this.addClass('cee-ratio-dialog');

    const row = document.createElement('label');
    row.className = 'cee-color-row';
    const caption = document.createElement('span');
    caption.textContent = 'Input';
    this._range = document.createElement('input');
    this._range.type = 'range';
    this._range.min = String(Math.round(MIN_RATIO * 100));
    this._range.max = String(Math.round(MAX_RATIO * 100));
    this._range.value = String(Math.round(clampRatio(current) * 100));
    this._value = document.createElement('span');
    this._value.className = 'cee-alpha-value';
    row.appendChild(caption);
    row.appendChild(this._range);
    row.appendChild(this._value);
    this.node.appendChild(row);

    this._preview = document.createElement('div');
    this._preview.className = 'cee-ratio-preview';
    const input = document.createElement('div');
    input.className = 'cee-ratio-pane';
    input.textContent = 'In';
    const output = document.createElement('div');
    output.className = 'cee-ratio-pane';
    output.textContent = 'Out';
    this._preview.appendChild(input);
    this._preview.appendChild(output);
    this.node.appendChild(this._preview);
    this._inputPane = input;
    this._outputPane = output;

    this._range.addEventListener('input', () => this._update());
    this._update();
  }

  getValue(): number {
    return clampRatio(Number(this._range.value) / 100);
  }

  private _update(): void {
    const ratio = this.getValue();
    this._value.textContent = `${Math.round(ratio * 100)}%`;
    this._inputPane.style.flexGrow = String(ratio);
    this._outputPane.style.flexGrow = String(1 - ratio);
  }

  private _range: HTMLInputElement;
  private _value: HTMLSpanElement;
  private _preview: HTMLDivElement;
  private _inputPane: HTMLDivElement;
  private _outputPane: HTMLDivElement;
}

/** Ask for a split ratio as a percentage; resolves null if cancelled. */
export async function promptForRatio(current: number): Promise<number | null> {
  const body = new RatioBody(current);
  const result = await showDialog({
    title: 'Default input pane width',
    body,
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Apply' })]
  });
  if (!result.button.accept || typeof result.value !== 'number') {
    return null;
  }
  return result.value;
}

/* ===================================================================== *
 *  Manager                                                              *
 * ===================================================================== */

/**
 * Keeps every cell in a notebook panel in sync with its split metadata.
 */
export class CellSplitManager implements IDisposable {
  constructor(panel: NotebookPanel, options: ISplitOptions) {
    this._panel = panel;
    this._options = options;
    panel.content.modelChanged.connect(this._onModelChanged, this);
    panel.content.activeCellChanged.connect(this._updateAll, this);
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
    for (const model of this._tracked) {
      model.metadataChanged.disconnect(this._onCellMetadata, this);
    }
    this._tracked.clear();
    const model = this._panel.content.model;
    if (model) {
      model.cells.changed.disconnect(this._updateAll, this);
    }
    this._panel.content.activeCellChanged.disconnect(this._updateAll, this);
    this._panel.content.modelChanged.disconnect(this._onModelChanged, this);
    for (const cell of this._panel.content.widgets) {
      this._teardown(cell);
    }
  }

  /** Re-evaluate every cell, e.g. after the global default changes. */
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
    for (const cell of this._panel.content.widgets) {
      if (!this._tracked.has(cell.model)) {
        this._tracked.add(cell.model);
        cell.model.metadataChanged.connect(this._onCellMetadata, this);
      }
      this._apply(cell);
    }
  }

  private _onCellMetadata(model: ICellModel, change: { key: string }): void {
    if (
      change.key !== SPLIT_METADATA_KEY &&
      change.key !== SPLIT_RATIO_METADATA_KEY
    ) {
      return;
    }
    const cell = this._cellFor(model);
    if (cell) {
      this._apply(cell);
    }
    this._scheduleSave();
  }

  /** Add or remove the split layout for one cell. */
  private _apply(cell: Cell): void {
    const on = canSplit(cell.model) && isSplitOn(cell.model, this._options);
    cell.toggleClass(SPLIT_CLASS, on);
    if (!on) {
      this._teardown(cell);
      return;
    }
    const ratio = ratioOf(cell.model, this._options);
    cell.node.style.setProperty(RATIO_VAR, ratio.toFixed(3));
    const gutter = this._ensureGutter(cell);
    gutter.ratio = ratio;
  }

  private _teardown(cell: Cell): void {
    const decorated = cell as Cell & { [GUTTER_PROP]?: SplitGutter };
    const gutter = decorated[GUTTER_PROP];
    if (gutter) {
      delete decorated[GUTTER_PROP];
      if (!gutter.isDisposed) {
        gutter.dispose();
      }
    }
    cell.node.style.removeProperty(RATIO_VAR);
  }

  private _ensureGutter(cell: Cell): SplitGutter {
    const decorated = cell as Cell & { [GUTTER_PROP]?: SplitGutter };
    const existing = decorated[GUTTER_PROP];
    if (existing && !existing.isDisposed) {
      return existing;
    }
    const gutter = new SplitGutter(cell, {
      change: (ratio, commit) => {
        cell.node.style.setProperty(RATIO_VAR, ratio.toFixed(3));
        if (commit) {
          setRatio(cell.model, ratio, this._options);
        }
      },
      reset: () => {
        cell.model.deleteMetadata(SPLIT_RATIO_METADATA_KEY);
        this._apply(cell);
      }
    });
    decorated[GUTTER_PROP] = gutter;
    // Sit between the two wrappers so a plain flex row puts it in the middle.
    const layout = cell.layout as PanelLayout;
    const index = layout.widgets.findIndex(w =>
      w.hasClass(OUTPUT_WRAPPER_CLASS)
    );
    if (index < 0) {
      layout.addWidget(gutter);
    } else {
      layout.insertWidget(index, gutter);
    }
    return gutter;
  }

  /**
   * Persist shortly after a change, matching how notes save themselves: the
   * arrangement is a deliberate choice and shouldn't be lost to a closed tab.
   */
  private _scheduleSave(): void {
    if (this._isDisposed) {
      return;
    }
    // Shared with the notes layer so the two never issue overlapping saves.
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
  private _options: ISplitOptions;
  private _isDisposed = false;
  private _tracked = new Set<ICellModel>();
}
