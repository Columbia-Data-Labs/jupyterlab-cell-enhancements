import { JupyterFrontEnd } from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { Dialog, InputDialog, showDialog } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { Widget } from '@lumino/widgets';

import {
  IAuthorApi,
  IAuthorIdentity,
  colorForName,
  readComments,
  writeComments
} from './comments';

/**
 * Dialog body for picking any colour. Returns '' when the user opts back into
 * the automatic, name-derived colour.
 */
class ColorPickerBody extends Widget implements Dialog.IBodyWidget<string> {
  constructor(current: string, auto: string, isAuto: boolean) {
    super();
    this.addClass('cee-color-dialog');

    const row = document.createElement('label');
    row.className = 'cee-color-row';
    this._input = document.createElement('input');
    this._input.type = 'color';
    this._input.value = current;
    const caption = document.createElement('span');
    caption.textContent = 'Pick any colour';
    row.appendChild(this._input);
    row.appendChild(caption);

    const autoRow = document.createElement('label');
    autoRow.className = 'cee-color-row';
    this._auto = document.createElement('input');
    this._auto.type = 'checkbox';
    this._auto.checked = isAuto;
    const autoCaption = document.createElement('span');
    autoCaption.textContent = 'Use the colour generated from my name';
    const swatch = document.createElement('span');
    swatch.className = 'cee-color-swatch';
    swatch.style.background = auto;
    autoRow.appendChild(this._auto);
    autoRow.appendChild(autoCaption);
    autoRow.appendChild(swatch);

    this._auto.addEventListener('change', () => {
      this._input.disabled = this._auto.checked;
    });
    this._input.disabled = isAuto;
    this._input.addEventListener('input', () => {
      this._auto.checked = false;
      this._input.disabled = false;
    });

    this.node.appendChild(row);
    this.node.appendChild(autoRow);
  }

  getValue(): string {
    return this._auto.checked ? '' : this._input.value;
  }

  private _input: HTMLInputElement;
  private _auto: HTMLInputElement;
}

const AUTHOR_SETTING = 'commentAuthor';
const COLOR_SETTING = 'commentColor';

/**
 * Resolves who is writing a comment and owns every path for changing that name.
 *
 * By default the author comes from JupyterLab's own user identity — the same
 * source its collaborative avatars use — so attribution works without any setup.
 * On a plain local server that identity is an auto-generated name like
 * "Anonymous Megaclite", which is why we surface prompts to replace it.
 */
export class AuthorService implements IAuthorApi {
  constructor(app: JupyterFrontEnd, tracker: INotebookTracker) {
    this._app = app;
    this._tracker = tracker;
  }

  /** Called once settings have loaded, so the override can be read and written. */
  attachSettings(settings: ISettingRegistry.ISettings): void {
    this._settings = settings;
    const read = (): void => {
      const previousName = this.get().name;
      const value = settings.get(AUTHOR_SETTING).composite;
      const nextOverride = typeof value === 'string' ? value.trim() : '';
      const nameChanged = this._initialised && nextOverride !== this._override;
      this._override = nextOverride;
      const color = settings.get(COLOR_SETTING).composite;
      this._colorOverride = typeof color === 'string' ? color.trim() : '';
      // Editing the name in Settings should carry existing notes along, just as
      // the prompt does — otherwise they keep the old name (and its colour).
      if (nameChanged) {
        void this._offerRename(previousName, this.get().name);
      }
      this._initialised = true;
    };
    read();
    settings.changed.connect(read);
  }

  get(): IAuthorIdentity {
    const identity = this._app.serviceManager.user?.identity;
    const auto = identity?.display_name || identity?.name || '';
    const name = this._override || auto;
    return {
      name,
      // An explicit choice wins; otherwise derive from the name so distinct
      // authors get distinct, stable colours for everyone viewing the notebook.
      color: this._colorOverride || colorForName(name),
      colorExplicit: !!this._colorOverride,
      explicit: !!this._override
    };
  }

  /** The identity a brand-new comment should carry. */
  identityForNewComment(): IAuthorIdentity {
    // Nudge first-time users once, right when attribution starts to matter.
    void this._maybePromptFirstUse();
    return this.get();
  }

  /** Open the name prompt (toolbar button, palette, or the note header). */
  edit(): void {
    void this.promptForName();
  }

  /** Open the colour picker (the note avatar, or the palette command). */
  editColor(): void {
    void this.promptForColor();
  }

  async promptForColor(): Promise<void> {
    const current = this.get();
    const auto = colorForName(current.name);
    const body = new ColorPickerBody(
      current.color || auto,
      auto,
      !this._colorOverride
    );
    const result = await showDialog({
      title: 'Comment colour',
      body,
      buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Apply' })]
    });
    if (!result.button.accept) {
      return;
    }
    // '' means "go back to the automatic, name-derived colour".
    const chosen = (result.value ?? '').trim();
    if (chosen === this._colorOverride) {
      return;
    }
    this._colorOverride = chosen;
    await this._settings?.set(COLOR_SETTING, chosen).catch(reason => {
      console.warn('Could not save the comment colour.', reason);
    });
    await this._offerRecolour(current.name, chosen || auto, !chosen);
  }

  /** Offer to restyle the author's existing notes with the new colour. */
  private async _offerRecolour(
    author: string,
    color: string,
    automatic = false
  ): Promise<void> {
    const targets = this._commentsBy(author);
    if (!targets) {
      return;
    }
    const result = await showDialog({
      title: 'Update existing notes?',
      body: `Also apply this colour to your ${targets} existing note${
        targets === 1 ? '' : 's'
      }?`,
      buttons: [
        Dialog.cancelButton({ label: 'Leave them' }),
        Dialog.okButton({ label: 'Update' })
      ]
    });
    if (!result.button.accept) {
      return;
    }
    this._tracker.forEach(panel => {
      for (const cell of panel.content.widgets) {
        const list = readComments(cell.model);
        let changed = false;
        for (const comment of list) {
          if (comment.author === author) {
            // An automatic colour is stored as "no colour", so it keeps
            // tracking the name rather than freezing today's value.
            comment.color = automatic ? undefined : color;
            comment.colorExplicit = automatic ? undefined : true;
            changed = true;
          }
        }
        if (changed) {
          writeComments(cell.model, list);
        }
      }
    });
  }

  async promptForName(): Promise<void> {
    const before = this.get();
    const result = await InputDialog.getText({
      title: 'Comment author name',
      label: 'Shown on notes you write.',
      text: this._override,
      placeholder: before.name || 'Your name'
    });
    if (!result.button.accept) {
      return;
    }
    const next = (result.value ?? '').trim();
    if (!next || next === this._override) {
      return;
    }
    this._override = next;
    await this._settings?.set(AUTHOR_SETTING, next).catch(reason => {
      console.warn('Could not save the comment author name.', reason);
    });
    await this._offerRename(before.name, next);
  }

  /**
   * Once a real name is set, existing notes still carry whatever name they were
   * written under. Offer to bring them along rather than stranding a user's
   * first few notes under a random anonymous name.
   */
  private async _offerRename(previous: string, next: string): Promise<void> {
    if (!previous || previous === next) {
      return;
    }
    const targets = this._commentsBy(previous);
    if (!targets) {
      return;
    }
    const result = await showDialog({
      title: 'Update existing notes?',
      body: `${targets} existing note${targets === 1 ? '' : 's'} ${
        targets === 1 ? 'is' : 'are'
      } attributed to "${previous}". Rename ${
        targets === 1 ? 'it' : 'them'
      } to "${next}"?`,
      buttons: [
        Dialog.cancelButton({ label: 'Leave them' }),
        Dialog.okButton({ label: 'Rename' })
      ]
    });
    if (!result.button.accept) {
      return;
    }
    this._renameAuthor(previous, next);
  }

  /** How many comments in open notebooks are attributed to `author`. */
  private _commentsBy(author: string): number {
    let count = 0;
    this._tracker.forEach(panel => {
      for (const cell of panel.content.widgets) {
        count += readComments(cell.model).filter(
          c => c.author === author
        ).length;
      }
    });
    return count;
  }

  private _renameAuthor(previous: string, next: string): void {
    this._tracker.forEach(panel => {
      for (const cell of panel.content.widgets) {
        const list = readComments(cell.model);
        let changed = false;
        for (const comment of list) {
          if (comment.author === previous) {
            comment.author = next;
            // Clear presentation baked in by older versions so the avatar
            // re-derives from the new name instead of keeping stale initials.
            comment.initials = undefined;
            if (!comment.colorExplicit) {
              comment.color = undefined;
            }
            changed = true;
          }
        }
        if (changed) {
          writeComments(cell.model, list);
        }
      }
    });
  }

  private async _maybePromptFirstUse(): Promise<void> {
    if (this._prompted || this._override) {
      return;
    }
    this._prompted = true;
    // Let the comment finish being created before interrupting.
    window.setTimeout(() => void this.promptForName(), 400);
  }

  private _app: JupyterFrontEnd;
  private _tracker: INotebookTracker;
  private _settings: ISettingRegistry.ISettings | null = null;
  private _override = '';
  private _colorOverride = '';
  private _prompted = false;
  private _initialised = false;
}
