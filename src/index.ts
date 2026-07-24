import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IDisposable, DisposableDelegate } from '@lumino/disposable';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import {
  INotebookTracker,
  NotebookPanel,
  INotebookModel
} from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ICommandPalette } from '@jupyterlab/apputils';
import { userIcon } from '@jupyterlab/ui-components';
import { Menu } from '@lumino/widgets';

import { Cell } from '@jupyterlab/cells';

import { splitIcon } from './icons';
import { CellTitleManager } from './titles';
import {
  CellSplitManager,
  ISplitOptions,
  canSplit,
  isSplitOn,
  setSplitOn
} from './split';
import {
  CellCommentManager,
  IAuthorApi,
  INoteOptions,
  newCommentId,
  readComments,
  writeComments
} from './comments';
import { AuthorService } from './identity';
import { APPEARANCE_OPTIONS, AppearanceService } from './appearance';
import { editorViewFor } from './anchors';
import { domSelectionIn } from './domanchors';
import { activateFocusMode } from './focus';

interface ISelectedTarget {
  cell: Cell;
  anchor: {
    from: number;
    to: number;
    quote: string;
    region?: 'markdown' | 'output';
    outputIndex?: number;
  };
}

/**
 * What the user has selected, from any of the three commentable surfaces: the
 * cell's editor, its rendered markdown, or one of its outputs.
 *
 * The rendered-DOM check comes first, and the order matters: an editor keeps its
 * last selection even after the user selects text elsewhere, so checking the
 * editor first would attribute an output selection to the source. CodeMirror
 * uses the real DOM selection while focused, and that selection is never inside
 * an output or rendered-markdown node, so this ordering is unambiguous.
 */
function selectionOf(tracker: INotebookTracker): ISelectedTarget | null {
  const cell = tracker.activeCell;
  if (!cell) {
    return null;
  }
  const dom = domSelectionIn(cell);
  if (dom) {
    return {
      cell,
      anchor: {
        from: 0,
        to: 0,
        quote: dom.quote,
        region: dom.region,
        outputIndex: dom.outputIndex
      }
    };
  }
  const view = editorViewFor(cell);
  const range = view?.state.selection.main;
  if (view && range && !range.empty) {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    return {
      cell,
      anchor: { from, to, quote: view.state.doc.sliceString(from, to) }
    };
  }
  return null;
}

/**
 * A notebook widget extension that gives each notebook a CellTitleManager.
 */
class TitlesExtension
  implements DocumentRegistry.IWidgetExtension<NotebookPanel, INotebookModel>
{
  createNew(panel: NotebookPanel): IDisposable {
    const manager = new CellTitleManager(panel);
    return new DisposableDelegate(() => manager.dispose());
  }
}

/**
 * A notebook widget extension that gives each notebook a CellCommentManager.
 * The comment author is read lazily from settings so edits to the preference
 * take effect without reopening notebooks.
 */
class CommentsExtension
  implements DocumentRegistry.IWidgetExtension<NotebookPanel, INotebookModel>
{
  constructor(
    authors: IAuthorApi,
    rendermime: IRenderMimeRegistry,
    options: INoteOptions
  ) {
    this._authors = authors;
    this._rendermime = rendermime;
    this._options = options;
  }

  createNew(panel: NotebookPanel): IDisposable {
    const manager = new CellCommentManager(
      panel,
      this._authors,
      this._rendermime,
      this._options
    );
    this._managers.add(manager);
    return new DisposableDelegate(() => {
      this._managers.delete(manager);
      manager.dispose();
    });
  }

  /** Re-evaluate every open notebook, e.g. when "show resolved" is toggled. */
  refreshAll(): void {
    for (const manager of this._managers) {
      manager.refresh();
    }
  }

  private _authors: IAuthorApi;
  private _rendermime: IRenderMimeRegistry;
  private _options: INoteOptions;
  private _managers = new Set<CellCommentManager>();
}

/**
 * A notebook widget extension that gives each notebook a CellSplitManager, so
 * cells can show their input beside their output.
 */
class SplitExtension
  implements DocumentRegistry.IWidgetExtension<NotebookPanel, INotebookModel>
{
  constructor(options: ISplitOptions) {
    this._options = options;
  }

  createNew(panel: NotebookPanel): IDisposable {
    const manager = new CellSplitManager(panel, this._options);
    this._managers.add(manager);
    return new DisposableDelegate(() => {
      this._managers.delete(manager);
      manager.dispose();
    });
  }

  /** Re-evaluate every open notebook, e.g. when the global default changes. */
  refreshAll(): void {
    for (const manager of this._managers) {
      manager.refresh();
    }
  }

  private _options: ISplitOptions;
  private _managers = new Set<CellSplitManager>();
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-cell-enhancements:plugin',
  description:
    'Cell titles, focus mode, and floating markdown notes for JupyterLab notebooks.',
  autoStart: true,
  requires: [INotebookTracker, IRenderMimeRegistry],
  optional: [ISettingRegistry, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    rendermime: IRenderMimeRegistry,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null
  ) => {
    // Feature 1: editable, metadata-backed cell titles.
    app.docRegistry.addWidgetExtension('Notebook', new TitlesExtension());

    // Feature 2: per-cell focus mode (command + Escape handling). The toolbar
    // button itself is contributed declaratively via schema/plugin.json.
    activateFocusMode(app, tracker);

    // Feature 3: metadata-backed floating notes, either on a whole cell or
    // anchored to a span of text.
    //
    // Author defaults to JupyterLab's own user identity — the same one its
    // collaborative avatars use — so notes are attributed correctly out of the
    // box. AuthorService owns the override and every path for changing it.
    const authors = new AuthorService(app, tracker);
    let settingsRef: ISettingRegistry.ISettings | null = null;
    let showResolved = false;
    let showTitles = true;

    /** Flip a boolean setting; the settings-changed handler applies the effect. */
    const toggleSetting = (key: string, value: boolean): void => {
      void settingsRef?.set(key, value).catch(reason =>
        console.warn(`Could not update ${key}.`, reason)
      );
    };
    const comments = new CommentsExtension(authors, rendermime, {
      showResolved: () => showResolved
    });
    app.docRegistry.addWidgetExtension('Notebook', comments);

    const setAuthorCommand = 'cell-enhancements:set-comment-author';
    app.commands.addCommand(setAuthorCommand, {
      label: 'Set Comment Author Name…',
      caption: 'Choose the name shown on notes you write',
      icon: userIcon,
      execute: () => authors.promptForName()
    });
    const toggleResolvedCommand = 'cell-enhancements:toggle-show-resolved';
    const checkbox = (on: boolean): string => (on ? '☑' : '☐');
    app.commands.addCommand(toggleResolvedCommand, {
      label: () => `${checkbox(showResolved)}  Show Resolved Notes`,
      isToggleable: true,
      isToggled: () => showResolved,
      execute: () => toggleSetting('showResolved', !showResolved)
    });

    const toggleTitlesCommand = 'cell-enhancements:toggle-titles';
    app.commands.addCommand(toggleTitlesCommand, {
      label: () => `${checkbox(showTitles)}  Show Cell Titles`,
      isToggleable: true,
      isToggled: () => showTitles,
      execute: () => toggleSetting('showTitles', !showTitles)
    });

    const setColorCommand = 'cell-enhancements:set-comment-color';
    app.commands.addCommand(setColorCommand, {
      label: 'Set Comment Colour…',
      caption: 'Choose the avatar colour shown on notes you write',
      execute: () => authors.promptForColor()
    });
    // Cell chrome customisation, grouped into its own submenu.
    const appearance = new AppearanceService();

    // Feature 4: side-by-side input/output, per cell and backed by metadata.
    const splitOptions: ISplitOptions = {
      defaultOn: () => appearance.splitDefault,
      defaultRatio: () => appearance.splitRatio
    };
    const splits = new SplitExtension(splitOptions);
    app.docRegistry.addWidgetExtension('Notebook', splits);

    const toggleSplitCommand = 'cell-enhancements:toggle-cell-split';
    const splittableCell = (): Cell | null => {
      const cell = tracker.activeCell;
      return cell && canSplit(cell.model) ? cell : null;
    };
    app.commands.addCommand(toggleSplitCommand, {
      label: 'Side-by-Side Input/Output',
      caption: 'Show this cell’s output beside its input instead of below',
      icon: splitIcon,
      isEnabled: () => !!splittableCell(),
      isToggleable: true,
      isToggled: () => {
        const cell = splittableCell();
        return !!cell && isSplitOn(cell.model, splitOptions);
      },
      execute: () => {
        const cell = splittableCell();
        if (!cell) {
          return;
        }
        const next = !isSplitOn(cell.model, splitOptions);
        setSplitOn(cell.model, next, splitOptions);
      }
    });
    app.contextMenu.addItem({
      command: toggleSplitCommand,
      selector: '.jp-Notebook .jp-CodeCell',
      rank: 13
    });

    const roundedCommand = 'cell-enhancements:toggle-rounded-cells';
    app.commands.addCommand(roundedCommand, {
      label: () => `${checkbox(appearance.rounded)}  Rounded Cell Inputs`,
      isToggleable: true,
      isToggled: () => appearance.rounded,
      execute: () => appearance.toggleRounded()
    });
    const splitDefaultCommand = 'cell-enhancements:toggle-split-default';
    app.commands.addCommand(splitDefaultCommand, {
      label: () =>
        `${checkbox(appearance.splitDefault)}  Side-by-Side Input/Output (All Cells)`,
      caption:
        'Split every code cell that has no side-by-side setting of its own',
      isToggleable: true,
      isToggled: () => appearance.splitDefault,
      execute: () => appearance.toggleSplitDefault()
    });
    const splitRatioCommand = 'cell-enhancements:set-split-ratio';
    app.commands.addCommand(splitRatioCommand, {
      label: 'Default Input Pane Width…',
      caption: 'How much width the input gets in a side-by-side cell',
      execute: () => appearance.promptForSplitRatio()
    });

    const appearanceCommands = [
      roundedCommand,
      splitDefaultCommand,
      splitRatioCommand
    ];
    for (const option of APPEARANCE_OPTIONS) {
      const command = `cell-enhancements:set-${option.key}`;
      app.commands.addCommand(command, {
        label: option.label,
        caption: `Set the ${option.title.toLowerCase()}`,
        execute: () => appearance.promptFor(option)
      });
      appearanceCommands.push(command);
    }

    const appearanceMenu = new Menu({ commands: app.commands });
    appearanceMenu.title.label = 'Cell Appearance';
    for (const command of appearanceCommands) {
      appearanceMenu.addItem({ command });
    }

    // One toolbar button surfacing every setting, so nothing is reachable only
    // from the Settings editor.
    const menu = new Menu({ commands: app.commands });
    menu.addItem({ command: setAuthorCommand });
    menu.addItem({ command: setColorCommand });
    menu.addItem({ type: 'separator' });
    menu.addItem({ command: toggleResolvedCommand });
    menu.addItem({ command: toggleTitlesCommand });
    menu.addItem({ type: 'separator' });
    menu.addItem({ type: 'submenu', submenu: appearanceMenu });

    const notesMenuCommand = 'cell-enhancements:notes-menu';
    app.commands.addCommand(notesMenuCommand, {
      label: 'Notes',
      caption: 'Cell notes: author, colour and display options',
      icon: userIcon,
      execute: () => {
        // Anchor under the toolbar button when we can find it.
        const button = document.querySelector<HTMLElement>(
          `[data-command="${notesMenuCommand}"]`
        );
        const rect = button?.getBoundingClientRect();
        menu.open(rect ? rect.left : 200, rect ? rect.bottom : 60);
      }
    });

    if (palette) {
      for (const command of [
        setAuthorCommand,
        setColorCommand,
        toggleResolvedCommand,
        toggleTitlesCommand,
        toggleSplitCommand,
        ...appearanceCommands
      ]) {
        palette.addItem({ command, category: 'Notebook Cell Enhancements' });
      }
    }

    // "Comment on selection" — reads the live selection out of the active cell's
    // CodeMirror view and stores it as an anchored comment.
    const addTextComment = 'cell-enhancements:comment-on-selection';
    app.commands.addCommand(addTextComment, {
      label: 'Add Comment to Selection',
      isEnabled: () => !!selectionOf(tracker),
      execute: () => {
        const found = selectionOf(tracker);
        if (!found) {
          return;
        }
        const { cell, anchor } = found;
        const identity = authors.identityForNewComment();
        const list = readComments(cell.model);
        list.push({
          id: newCommentId(),
          author: identity.name,
          color: identity.colorExplicit ? identity.color : undefined,
          colorExplicit: identity.colorExplicit || undefined,
          text: '',
          open: true,
          dx: 0,
          dy: 0,
          anchor
        });
        writeComments(cell.model, list);
      }
    });
    // Offered on all three commentable surfaces.
    for (const selector of [
      '.jp-Notebook .jp-Cell .cm-editor',
      '.jp-Notebook .jp-Cell .jp-MarkdownOutput',
      '.jp-Notebook .jp-Cell .jp-OutputArea-output'
    ]) {
      app.contextMenu.addItem({ command: addTextComment, selector, rank: 12 });
    }

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          authors.attachSettings(settings);
          settingsRef = settings;
          appearance.attachSettings(settings);
          const readDisplay = (): void => {
            const resolved = settings.get('showResolved').composite === true;
            if (resolved !== showResolved) {
              showResolved = resolved;
              comments.refreshAll();
            }
            showTitles = settings.get('showTitles').composite !== false;
            document.body.classList.toggle('cee-hide-titles', !showTitles);
            // Cells carrying no split metadata of their own inherit the global
            // default, so re-evaluate every open notebook. Cheap: it walks the
            // cell widgets and toggles a class.
            splits.refreshAll();
          };
          readDisplay();
          settings.changed.connect(readDisplay);
        })
        .catch(reason =>
          console.warn('Failed to load cell-enhancements settings.', reason)
        );
    }

    console.log('JupyterLab extension jupyterlab-cell-enhancements is active.');
  }
};

export default plugin;
