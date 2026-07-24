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
- **Floating notes** — attach a note to a whole cell, or to a specific span of
  text. Notes float above everything (including the sidebars), follow their
  anchor as you scroll, hide once it leaves the viewport, and are draggable —
  dragging sets an offset that stays glued to the anchor.

  Notes render **Markdown and LaTeX** through JupyterLab's own renderer, so
  `**bold**`, lists, code, links and `$x^2$` math all work.
- **Side-by-side input/output** — put a code cell's output beside its input
  instead of below it, per cell, saved in the notebook.

### Adding a note

| Target | How |
| --- | --- |
| The whole cell | Click the marker in the cell's top-right corner |
| A span of code | Select it, then right-click → *Add Comment to Selection* |
| Rendered markdown | Select it, then right-click → *Add Comment to Selection* |
| A cell output | Select it, then right-click → *Add Comment to Selection* |

Anchored notes highlight their text and draw a leader line to the card.

**Code anchors track your edits**: they're held in a CodeMirror `StateField` that
maps every range through each document change, so a highlight stays on its text
as you type around it. Across reloads, anchors are re-verified against the quoted
text and re-found if they've moved.

Markdown and output anchors are matched by quoted text instead, which is weaker —
and note that **outputs are regenerated on every run**, so re-running a cell will
usually orphan its output notes. Anything that can't be re-anchored is kept and
flagged **outdated** (amber, with the original quote struck through) rather than
silently pointing at the wrong place.

### Resolving

Click ✓ on a note to resolve (archive) it. Resolved notes are hidden; enable
**Show resolved notes** to bring them back, each with a ↺ to reopen.

### Identity and colour

Notes are attributed using JupyterLab's own user identity, so they work without
setup. Each author gets a **colour generated from their name** in OKLCH — any hue
on the circle, with lightness and chroma constrained so the avatar text always
keeps sufficient contrast. The same name yields the same colour for everyone
opening the notebook.

Double-click a note's name to change it (you'll be offered the chance to update
existing notes), or its avatar to pick any colour. The **Notes** toolbar button
and the command palette expose the same options.

### Storage

Everything lives in cell metadata under `cell_comments` — text, author, anchor,
position, and resolved state — so notes travel with the notebook and are saved
automatically shortly after any change. Notebooks written by earlier versions
(`cell_comment`) are read transparently and migrated on first write.

## Side-by-side input and output

Split a code cell so its output sits beside its input. Use the split button in
the cell toolbar, right-click the cell, or the command palette.

Drag the divider between the panes to resize them; double-click it to go back to
the default, and it's focusable with **←/→** (hold **Shift** for larger steps).

A few deliberate behaviours:

- The split only engages once the cell **has output**, so an un-run cell keeps
  the full width and then splits by itself when it executes.
- When the notebook gets too narrow for two useful panes, they **wrap back to
  stacked** rather than overflowing.
- Wide output (data frames, long lines) scrolls inside its own pane instead of
  forcing the pane past its share of the width.

State is stored per cell in metadata, so it travels with the notebook:

```json
"metadata": { "cell_split": true, "cell_split_ratio": 0.45 }
```

Cells with no `cell_split` of their own follow the **Side-by-side input/output**
setting, and metadata is written only when a cell differs from that default — so
toggling cells doesn't sprinkle a redundant key across the notebook.

## Cell appearance

Under the **Notes** toolbar button → *Cell Appearance*:

| Option | Effect |
| --- | --- |
| Rounded cell inputs | Rounded corners and a soft shadow on input boxes (on by default) |
| Side-by-side input/output | Split every code cell that has no setting of its own |
| Default input pane width | How much width the input gets in a split cell |
| Cell background colour | Any CSS colour, with an opacity slider |
| Active cell bar colour | The vertical bar beside the selected cell |
| Execution prompt colour | The `[n]:` counters |

Colour options left blank fall through to JupyterLab's own styling rather than
overriding it with a default, so a fresh install looks untouched.

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
