import { Widget } from '@lumino/widgets';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ISettingRegistry } from '@jupyterlab/settingregistry';

/**
 * Cell chrome customisation: rounded/shadowed input boxes, and colours for the
 * cell background, the active-cell bar and the execution prompt.
 *
 * Everything is applied as CSS custom properties on <body>, guarded by a data
 * attribute per property, so an unset option leaves JupyterLab's own styling
 * completely untouched rather than overriding it with a default.
 */

interface IRgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string): IRgba {
  const text = (value || '').trim();
  const rgba = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(
    text
  );
  if (rgba) {
    return {
      r: +rgba[1],
      g: +rgba[2],
      b: +rgba[3],
      a: rgba[4] === undefined ? 1 : parseFloat(rgba[4])
    };
  }
  const hex = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
      a: hex[2] ? parseInt(hex[2], 16) / 255 : 1
    };
  }
  return { r: 128, g: 128, b: 128, a: 1 };
}

function toHex({ r, g, b }: IRgba): string {
  const h = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function toCss({ r, g, b, a }: IRgba): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${Number(
    a.toFixed(3)
  )})`;
}

/**
 * A colour picker with an opacity slider.
 *
 * `<input type="color">` cannot express alpha, which the cell background needs
 * — a translucent background lets the notebook's own surface show through.
 */
class ColorAlphaBody extends Widget implements Dialog.IBodyWidget<string> {
  constructor(current: string, allowAlpha: boolean) {
    super();
    this.addClass('cee-color-dialog');
    const rgba = parseColor(current);

    const colorRow = document.createElement('label');
    colorRow.className = 'cee-color-row';
    this._color = document.createElement('input');
    this._color.type = 'color';
    this._color.value = toHex(rgba);
    const colorCaption = document.createElement('span');
    colorCaption.textContent = 'Colour';
    colorRow.appendChild(this._color);
    colorRow.appendChild(colorCaption);
    this.node.appendChild(colorRow);

    if (allowAlpha) {
      const alphaRow = document.createElement('label');
      alphaRow.className = 'cee-color-row';
      this._alpha = document.createElement('input');
      this._alpha.type = 'range';
      this._alpha.min = '0';
      this._alpha.max = '100';
      this._alpha.value = String(Math.round((current ? rgba.a : 1) * 100));
      const alphaCaption = document.createElement('span');
      alphaCaption.textContent = 'Opacity';
      this._alphaValue = document.createElement('span');
      this._alphaValue.className = 'cee-alpha-value';
      alphaRow.appendChild(alphaCaption);
      alphaRow.appendChild(this._alpha);
      alphaRow.appendChild(this._alphaValue);
      this.node.appendChild(alphaRow);
    }

    this._preview = document.createElement('div');
    this._preview.className = 'cee-color-preview';
    this._preview.textContent = 'Preview';
    this.node.appendChild(this._preview);

    const defaultRow = document.createElement('label');
    defaultRow.className = 'cee-color-row';
    this._default = document.createElement('input');
    this._default.type = 'checkbox';
    this._default.checked = !current;
    const defaultCaption = document.createElement('span');
    defaultCaption.textContent = "Use JupyterLab's default";
    defaultRow.appendChild(this._default);
    defaultRow.appendChild(defaultCaption);
    this.node.appendChild(defaultRow);

    const sync = (): void => {
      this._default.checked = false;
      this._update();
    };
    this._color.addEventListener('input', sync);
    this._alpha?.addEventListener('input', sync);
    this._default.addEventListener('change', () => this._update());
    this._update();
  }

  getValue(): string {
    if (this._default.checked) {
      return '';
    }
    const rgba = parseColor(this._color.value);
    rgba.a = this._alpha ? Number(this._alpha.value) / 100 : 1;
    return toCss(rgba);
  }

  private _update(): void {
    const value = this.getValue();
    if (this._alphaValue && this._alpha) {
      this._alphaValue.textContent = `${this._alpha.value}%`;
    }
    this._preview.style.background = value || 'transparent';
    this._preview.style.opacity = this._default.checked ? '0.4' : '1';
  }

  private _color: HTMLInputElement;
  private _alpha?: HTMLInputElement;
  private _alphaValue?: HTMLSpanElement;
  private _preview: HTMLDivElement;
  private _default: HTMLInputElement;
}

/** A customisable appearance property. */
export interface IAppearanceOption {
  key: string;
  title: string;
  label: string;
  cssVar: string;
  attribute: string;
  allowAlpha: boolean;
}

export const APPEARANCE_OPTIONS: ReadonlyArray<IAppearanceOption> = [
  {
    key: 'cellBackground',
    title: 'Cell background',
    label: 'Cell Background Colour…',
    cssVar: '--cee-cell-bg',
    attribute: 'data-cee-cell-bg',
    allowAlpha: true
  },
  {
    key: 'cellAccentColor',
    title: 'Active cell bar',
    label: 'Active Cell Bar Colour…',
    cssVar: '--cee-accent',
    attribute: 'data-cee-accent',
    allowAlpha: true
  },
  {
    key: 'promptColor',
    title: 'Execution prompt',
    label: 'Execution Prompt Colour…',
    cssVar: '--cee-prompt',
    attribute: 'data-cee-prompt',
    allowAlpha: false
  }
];

export class AppearanceService {
  attachSettings(settings: ISettingRegistry.ISettings): void {
    this._settings = settings;
    const read = (): void => this.apply();
    read();
    settings.changed.connect(read);
  }

  get rounded(): boolean {
    return this._settings?.get('cellRounded').composite === true;
  }

  valueOf(option: IAppearanceOption): string {
    const value = this._settings?.get(option.key).composite;
    return typeof value === 'string' ? value : '';
  }

  /** Push current settings into <body> as CSS custom properties. */
  apply(): void {
    const body = document.body;
    body.classList.toggle('cee-cell-rounded', this.rounded);
    for (const option of APPEARANCE_OPTIONS) {
      const value = this.valueOf(option);
      if (value) {
        body.style.setProperty(option.cssVar, value);
        body.setAttribute(option.attribute, '');
      } else {
        body.style.removeProperty(option.cssVar);
        body.removeAttribute(option.attribute);
      }
    }
  }

  toggleRounded(): void {
    void this._settings
      ?.set('cellRounded', !this.rounded)
      .catch(reason => console.warn('Could not update cellRounded.', reason));
  }

  async promptFor(option: IAppearanceOption): Promise<void> {
    const body = new ColorAlphaBody(this.valueOf(option), option.allowAlpha);
    const result = await showDialog({
      title: option.title,
      body,
      buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Apply' })]
    });
    if (!result.button.accept) {
      return;
    }
    await this._settings
      ?.set(option.key, result.value ?? '')
      .catch(reason => console.warn(`Could not update ${option.key}.`, reason));
  }

  private _settings: ISettingRegistry.ISettings | null = null;
}
