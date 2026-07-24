import { LabIcon } from '@jupyterlab/ui-components';

/**
 * A "fullscreen / focus" icon drawn as four corner brackets, matching the
 * affordance used by Databricks notebooks for focus mode.
 */
export const focusIcon = new LabIcon({
  name: 'cell-enhancements:focus',
  svgstr: `
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
  <g class="jp-icon3" fill="#616161">
    <path d="M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM5 14v5h5v2H3v-7h2zm14 0h2v7h-7v-2h5v-5z"/>
  </g>
</svg>
`
});

/**
 * Two panes side by side, for the input/output split toggle.
 */
export const splitIcon = new LabIcon({
  name: 'cell-enhancements:split',
  svgstr: `
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
  <g class="jp-icon3" fill="#616161">
    <path d="M3 4h8v16H3V4zm2 2v12h4V6H5zm8-2h8v16h-8V4zm2 2v12h4V6h-4z"/>
  </g>
</svg>
`
});
