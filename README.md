# jupyterlab-cell-enhancements

Enhancements for JupyterLab 4 notebook cells:

- **Cell titles** — give any cell an editable title shown above the input. Titles
  are stored in the cell's metadata (`cell_title`) so they travel with the
  notebook. Hover a cell and click *"Add a cell title…"*, or click an existing
  title to rename it. Press **Enter** to save, **Esc** to cancel.
- **Focus mode** — a corner-brackets button in the cell toolbar expands a single
  cell to fill the notebook, hiding everything else. Toggle the button again or
  press **Esc** to exit. Keyboard shortcut: **Ctrl/Cmd + Shift + Enter** while the
  notebook is focused.
- **Floating notes** — attach a note to any cell. Click the marker in a cell's
  top-right corner to open a floating card, anchored to the cell and connected by
  a leader line. Notes:
  - render **Markdown and LaTeX** (via JupyterLab's own renderer), so `**bold**`,
    lists, code, links and `$x^2$` math all work;
  - float above everything, including the sidebars, and follow their cell as you
    scroll — hiding automatically once the cell scrolls out of view;
  - are **draggable**; drag the header to reposition and the note stays glued to
    its cell at the new offset;
  - persist in cell metadata (`cell_comment`), including text, author, open/closed
    state and position, and are saved automatically shortly after any change.

  Set your display name under **Settings → Cell Enhancements → Comment author**.

## Requirements

- JupyterLab >= 4.0.0

## Install

```bash
pip install jupyterlab-cell-enhancements
```

## Uninstall

```bash
pip uninstall jupyterlab-cell-enhancements
```

## Development install

```bash
# Clone, then from the repo root:
pip install -e .
jupyter labextension develop . --overwrite
jlpm build
```

Rebuild after source changes with `jlpm build`, or run `jlpm watch` in one
terminal and `jupyter lab` in another.

## Building on a network / mapped drive (important)

This project's canonical location is on a mapped network drive (`Z:`), which
Node resolves to a UNC path (`\\server\share\...`). webpack's resolver cannot
handle UNC absolute paths, so **`jlpm build:prod` / `python -m build` must be run
from a copy of the repo on a local disk** (e.g. `C:\...`). Editing and version
control can stay on `Z:`; only the build/package step needs local disk. Copy the
resulting `dist/*.whl` (and `jupyterlab_cell_enhancements/labextension/`) back if
you want them alongside the source.

### license-webpack-plugin patch

webpack >= 5.107 changed the `ProvideSharedModule` identifier separator from
`=` to `|`, which crashes `license-webpack-plugin@4.0.2` during the production
build. A Yarn patch in `.yarn/patches/` fixes this (wired via the `resolutions`
field in `package.json`); it is applied automatically on `jlpm install`.
