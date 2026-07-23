import { JupyterFrontEnd } from '@jupyterlab/application';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { Cell } from '@jupyterlab/cells';

import { focusIcon } from './icons';

export const CommandIDs = {
  toggleFocus: 'cell-enhancements:toggle-focus'
};

const FOCUS_PANEL_CLASS = 'cee-focus-mode';
const FOCUSED_CELL_CLASS = 'cee-focused-cell';

/**
 * Inline style properties we set on the focused cell while it is pinned, so we
 * can clear exactly those on exit without disturbing anything else.
 */
const PINNED_STYLE_PROPS = [
  'position',
  'top',
  'left',
  'width',
  'height',
  'zIndex',
  'overflow',
  'margin',
  'maxWidth',
  'background'
];

/**
 * Per-panel teardown for the resize/scroll listeners that keep the pinned cell
 * aligned with the notebook area.
 */
const reposition = new WeakMap<NotebookPanel, () => void>();

/**
 * Returns the cell currently focused in the given panel, if any.
 */
function focusedCell(panel: NotebookPanel): Cell | null {
  for (const cell of panel.content.widgets) {
    if (cell.hasClass(FOCUSED_CELL_CLASS)) {
      return cell;
    }
  }
  return null;
}

/**
 * Position the pinned cell so it covers the notebook's content area. Using a
 * fixed overlay keeps the cell out of the (virtualized) notebook scroll flow
 * entirely, which avoids the windowed renderer reserving space for hidden
 * cells or repainting them as the user scrolls.
 */
function placeCell(panel: NotebookPanel, cell: Cell): void {
  const target = panel.content.node.getBoundingClientRect();
  const s = cell.node.style;
  s.position = 'fixed';
  s.zIndex = '100';
  s.overflow = 'auto';
  s.margin = '0';
  s.maxWidth = 'none';
  s.background = 'var(--jp-layout-color0)';
  s.width = `${target.width}px`;
  s.height = `${target.height}px`;
  // A `position: fixed` element is positioned relative to the nearest ancestor
  // that establishes a containing block (e.g. one with `transform` or
  // `contain`), which the notebook does have — not necessarily the viewport.
  // Probe where top/left = 0 actually lands, then offset to the target rect.
  s.top = '0px';
  s.left = '0px';
  const probe = cell.node.getBoundingClientRect();
  s.top = `${target.top - probe.top}px`;
  s.left = `${target.left - probe.left}px`;
}

/**
 * Remove focus mode from a panel, restoring the normal notebook view.
 */
function exitFocus(panel: NotebookPanel): void {
  if (!panel.hasClass(FOCUS_PANEL_CLASS)) {
    return;
  }
  const teardown = reposition.get(panel);
  if (teardown) {
    teardown();
    reposition.delete(panel);
  }
  const focused = focusedCell(panel);
  if (focused) {
    PINNED_STYLE_PROPS.forEach(p => focused.node.style.removeProperty(p));
  }
  panel.removeClass(FOCUS_PANEL_CLASS);
  for (const cell of panel.content.widgets) {
    cell.removeClass(FOCUSED_CELL_CLASS);
  }
}

/**
 * Put a single cell into focus mode within its notebook panel.
 */
function enterFocus(panel: NotebookPanel, cell: Cell): void {
  // If another cell was focused, restore it first.
  exitFocus(panel);

  for (const c of panel.content.widgets) {
    c.toggleClass(FOCUSED_CELL_CLASS, c === cell);
  }
  panel.addClass(FOCUS_PANEL_CLASS);

  const update = (): void => placeCell(panel, cell);
  update();
  // Re-run once layout has settled (toolbars/scrollbars can shift the rect).
  requestAnimationFrame(update);

  // Keep the overlay aligned if the window or surrounding layout changes.
  window.addEventListener('resize', update);
  const observer = new ResizeObserver(update);
  observer.observe(panel.node);
  reposition.set(panel, () => {
    window.removeEventListener('resize', update);
    observer.disconnect();
  });
}

/**
 * Wire up the focus-mode command and its Escape-to-exit behaviour.
 */
export function activateFocusMode(
  app: JupyterFrontEnd,
  tracker: INotebookTracker
): void {
  app.commands.addCommand(CommandIDs.toggleFocus, {
    label: 'Toggle Cell Focus Mode',
    caption: 'Expand this cell to fill the notebook (focus mode)',
    icon: focusIcon,
    isEnabled: () => !!tracker.currentWidget && !!tracker.activeCell,
    isToggled: () => {
      const panel = tracker.currentWidget;
      if (!panel) {
        return false;
      }
      return panel.hasClass(FOCUS_PANEL_CLASS);
    },
    execute: () => {
      const panel = tracker.currentWidget;
      const active = tracker.activeCell;
      if (!panel || !active) {
        return;
      }
      const current = focusedCell(panel);
      if (panel.hasClass(FOCUS_PANEL_CLASS) && current === active) {
        // Toggling on the already-focused cell exits focus mode.
        exitFocus(panel);
      } else {
        enterFocus(panel, active);
      }
    }
  });

  // Exit focus mode with Escape, mirroring the Databricks behaviour.
  document.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      const panel = tracker.currentWidget;
      if (panel && panel.hasClass(FOCUS_PANEL_CLASS)) {
        exitFocus(panel);
        event.stopPropagation();
        event.preventDefault();
      }
    },
    true
  );

  // Clean up state if the active notebook changes while focused.
  tracker.currentChanged.connect((_, panel) => {
    tracker.forEach(p => {
      if (p !== panel) {
        exitFocus(p);
      }
    });
  });
}
