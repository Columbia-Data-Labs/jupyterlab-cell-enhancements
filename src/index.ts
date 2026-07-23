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

import { CellTitleManager } from './titles';
import { CellCommentManager } from './comments';
import { activateFocusMode } from './focus';

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
  constructor(getAuthor: () => string) {
    this._getAuthor = getAuthor;
  }

  createNew(panel: NotebookPanel): IDisposable {
    const manager = new CellCommentManager(panel, this._getAuthor);
    return new DisposableDelegate(() => manager.dispose());
  }

  private _getAuthor: () => string;
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-cell-enhancements:plugin',
  description:
    'Databricks-style cell titles and a focus mode for JupyterLab notebooks.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    settingRegistry: ISettingRegistry | null
  ) => {
    // Feature 1: editable, metadata-backed cell titles.
    app.docRegistry.addWidgetExtension('Notebook', new TitlesExtension());

    // Feature 2: per-cell focus mode (command + Escape handling). The toolbar
    // button itself is contributed declaratively via schema/plugin.json.
    activateFocusMode(app, tracker);

    // Feature 3: Excel-style, metadata-backed cell comments. The author name is
    // read from settings each time a new comment is created.
    let commentAuthor = '';
    app.docRegistry.addWidgetExtension(
      'Notebook',
      new CommentsExtension(() => commentAuthor)
    );

    if (settingRegistry) {
      settingRegistry
        .load(plugin.id)
        .then(settings => {
          const readAuthor = (): void => {
            const value = settings.get('commentAuthor').composite;
            commentAuthor = typeof value === 'string' ? value : '';
          };
          readAuthor();
          settings.changed.connect(readAuthor);
        })
        .catch(reason =>
          console.warn('Failed to load cell-enhancements settings.', reason)
        );
    }

    console.log('JupyterLab extension jupyterlab-cell-enhancements is active.');
  }
};

export default plugin;
