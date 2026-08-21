// The line plot demo: the model, a reproduction of the S3analyse chart, and a reproduction of the
// product's "Line Chart Settings" window driving it.
//
// The settings UI is deliberately a replica of that dialog — tree of nodes on the left, grouped
// editors on the right — rather than a web-shaped control panel. A generic sidebar beside a
// faithful chart would advertise a product that does not exist. Measured from
// wwwroot/img/help/linechartsettings-legend.png; node names and control labels are taken from
// Source/GraphEditorControlsWPF/Editors/.

import { loadModel } from './model.js';
import * as chart from './chart.js';

const AVAILABLE = [
    { classType: 'Field', member: 'FIELD', name: 'FOPR', on: true },
    { classType: 'Field', member: 'FIELD', name: 'FWPR', on: true },
    { classType: 'Field', member: 'FIELD', name: 'FLPR', on: false },
    { classType: 'Wells', member: 'Prod_1', name: 'WOPR', on: true },
    { classType: 'Wells', member: 'Prod_2', name: 'WOPR', on: false },
    { classType: 'Wells', member: 'Prod_3', name: 'WOPR', on: true },
    { classType: 'Wells', member: 'Prod_4', name: 'WOPR', on: false },
    { classType: 'Wells', member: 'Prod_5', name: 'WOPR', on: true },
    { classType: 'Wells', member: 'Prod_6', name: 'WOPR', on: false }
];

// One palette for every colour picker in the demo — Source/Utility/ColourChart.cs verbatim —
// rather than a bespoke list per control. The popup itself (built below) always draws on the
// dialog's own white chrome, never the site's theme, so literal hex is used directly here; the
// chart keeps resolving through chart.seriesToken()'s CSS var + fallback, which is what needs to
// survive a stale-cache scenario, not this popup.
const PALETTE_HEX = ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#00ffff',
    '#800000', '#008000', '#000080', '#800080', '#008080', '#808080'];

// Recent colours, shared across every picker on the page — matching the product, where "Recent
// Color Palette" is one shared strip rather than per-control. Capped at 8 slots, newest first.
const RECENT_LIMIT = 8;
let recentColours = [];

function pushRecent(hex) {
    recentColours = [hex, ...recentColours.filter(c => c !== hex)].slice(0, RECENT_LIMIT);
}

function trimDecimal(v) {
    return String(+Number(v).toFixed(4)).replace(/\.0+$/, '');
}

// Positions the custom fill/thumb elements from a value — the one place that turns "45 out of
// -90..90" into a percentage, called both when a slider row is first built and on every sync.
function positionSliderThumb(track, min, max, value) {
    const pct = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) * 100 : 0;
    const fill = track.querySelector('.s3-slider-fill');
    const thumb = track.querySelector('.s3-slider-thumb');
    if (fill) fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';
}

// A control's displayed colour may be a plain hex or a `var(--token, #hex)` string (from
// chart.seriesToken); either way this recovers the literal hex, which is what a swatch-equality
// check needs — comparing "#0000ff" against "var(--s3-series-4, #0000ff)" would never match.
function literalHex(cssColour) {
    if (!cssColour) return null;
    // chart.seriesToken() returns "var(--s3-series-N, #hex)" — the hex sits before a closing
    // paren, not at the end of the string, so this must NOT anchor to end-of-string.
    const fallback = /#[0-9a-fA-F]{6}/.exec(cssColour);
    return (fallback ? fallback[0] : cssColour).toLowerCase();
}

/* ------------------------------------------------------------------- state ------------------- */

function selectedCurve(state) {
    return state.curves.find(c => String(c.key) === String(state.selectedCurve)) || null;
}

function read(state, path) {
    if (path.startsWith('curve.')) {
        const curve = selectedCurve(state);
        return curve ? curve[path.slice(6)] : '';
    }
    const [group, key] = path.split('.');
    return state[group][key];
}

function write(state, path, value) {
    if (path.startsWith('curve.')) {
        const curve = selectedCurve(state);
        if (curve) curve[path.slice(6)] = value;
        return;
    }
    const [group, key] = path.split('.');
    state[group][key] = value;

    // A single-row (Horizontal) legend can only sit at the top or bottom of the plot; Centre and
    // Stretch only make sense for a stacked (Vertical) legend, which keeps all four. Clamp rather
    // than merely hide the invalid options, so the model is never left holding a value with no
    // matching control on screen.
    if (path === 'legend.orientation' && value === 'Horizontal'
        && !['Top', 'Bottom'].includes(state.legend.vertical)) {
        state.legend.vertical = 'Top';
    }
}

// ColourChart is applied by the line's index in the chart, so colours run consecutively from black
// and a curve that has never been plotted must not consume a slot.
function assignColour(state, curve) {
    if (curve.colourIndex === null) curve.colourIndex = state.nextColour++;
}

function buildCurves(model, config) {
    const pool = config.available || AVAILABLE;
    const multipleMembers = new Set(pool.map(p => p.member)).size > 1;

    return pool.map((spec, index) => {
        const vector = model.vector(spec.classType, spec.member, spec.name);
        return {
            key: index,
            classType: spec.classType,
            member: spec.member,
            name: spec.name,
            label: multipleMembers && spec.classType === 'Wells'
                ? `${spec.member} ${spec.name}`
                : spec.name,
            fullTitle: `${model.caseName} ${spec.classType.toUpperCase()} ${spec.member} ${spec.name}`,
            units: vector.units,
            values: vector.values,
            times: vector.times,
            visible: spec.on,
            colourIndex: null,
            plotType: 'Line',
            lineStyle: 'Solid',
            lineWidth: 1,
            markerType: 'None',
            markerSize: 6,
            // Null means "follow the line colour", which is how a new series starts in the product.
            markerColourIndex: null
        };
    });
}

function recompute(state) {
    const visible = state.curves.filter(c => c.visible);
    for (const curve of visible) assignColour(state, curve);

    let min = Infinity, max = -Infinity;
    for (const c of visible) {
        for (let i = 0; i < c.values.length; i++) {
            const v = c.values[i];
            if (!Number.isFinite(v)) continue;
            if (state.yAxis.log && v <= 0) continue;
            if (v < min) min = v;
            if (v > max) max = v;
        }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }

    // Kept separately from the effective min/max so the Range Values "Auto" spinners have a real
    // number to seed from — leaving Auto starts at what auto-fit is currently showing, not zero.
    const autoMin = state.yAxis.log ? Math.max(min * 0.8, 1e-6) : 0;
    const autoMax = max * 1.05 || 1;
    const autoStepRaw = (autoMax - autoMin) / 6;
    const autoInterval = autoStepRaw > 0 ? Math.pow(10, Math.floor(Math.log10(autoStepRaw))) : 1;

    state.yAxis.autoMin = autoMin;
    state.yAxis.autoMax = autoMax;
    state.yAxis.autoInterval = autoInterval;
    state.yAxis.autoMinorInterval = autoInterval / 2;

    state.yAxis.min = state.yAxis.minimumOverride ?? autoMin;
    state.yAxis.max = state.yAxis.maximumOverride ?? autoMax;

    // xAxis.min/max are set once in mount() from the model's real span, then only ever changed
    // by the visitor (date pickers or the revert button) — never reset here on every redraw,
    // or the Range Values date fields would snap back the instant anything else changed.

    state.title = chart.commonWords(visible.map(c => c.fullTitle)) || 'Line Chart';

    const units = [...new Set(visible.map(c => c.units))];
    const names = [...new Set(visible.map(c => c.name))];
    const autoYTitle = (names.length === 1 ? names[0] + ' ' : '')
        + (units.length === 1 && units[0] ? `(${units[0]})` : '');
    state.yAxis.title = state.yAxis.titleOverride || autoYTitle;
    state.xAxis.title = state.xAxis.titleOverride || '';

    state.tabLabel = (visible.length === 1 ? visible[0].label : state.caseName) + ' - Line Chart';

    if (!selectedCurve(state) || !selectedCurve(state).visible) {
        const first = visible[0];
        state.selectedCurve = first ? first.key : null;
        if (state.selectedNode.startsWith('curve:') && first) state.selectedNode = 'curve:' + first.key;
    }
}

/* ------------------------------------------------------------------- panels ------------------- */

// Groups and labels follow the product's editors: AxisRangeValuesControl, GraphGridLinesControl,
// LegendSettingsEditor and LineSettingsEditor.
function panelFor(state) {
    const node = state.selectedNode;

    if (node === 'legend') {
        return { heading: 'Legend', groups: [
            { controls: [{ kind: 'check', label: 'Visible', path: 'legend.show' }] },
            { group: 'Position', controls: [
                { kind: 'select', label: 'Orientation:', path: 'legend.orientation',
                  options: ['Horizontal', 'Vertical'], enabled: () => state.legend.show },
                { kind: 'select', label: 'Position Relative to Axes :', path: 'legend.inOut',
                  options: ['Inside', 'Outside'], enabled: () => state.legend.show },
                { kind: 'select', label: 'Horizontal Position:', path: 'legend.horizontal',
                  options: chart.LEGEND_HORIZONTAL, enabled: () => state.legend.show },
                { kind: 'select', label: 'Vertical Position:', path: 'legend.vertical',
                  options: () => state.legend.orientation === 'Horizontal'
                      ? ['Top', 'Bottom']
                      : chart.LEGEND_VERTICAL,
                  enabled: () => state.legend.show }
            ] },
            { group: 'Background and Border Style', controls: [
                { kind: 'colour', label: 'Background Colour:', path: 'legend.backgroundColour',
                  colour: () => chart.resolveColour(state.legend.backgroundColour) || '#fffbf0' },
                { kind: 'colour', label: 'Border Colour:', path: 'legend.borderColour',
                  colour: () => chart.resolveColour(state.legend.borderColour) || '#000000' },
                { kind: 'number', label: 'Border Thickness:', path: 'legend.borderThickness',
                  min: 0, max: 5, step: 1, enabled: () => state.legend.show }
            ] }
        ] };
    }

    if (node === 'yaxis') {
        return { heading: 'Y Axis 1', groups: [
            { group: 'Axis Title', controls: [
                { kind: 'text', label: 'Title:', path: 'yAxis.titleOverride',
                  revert: { label: 'Revert title to the automatic one',
                    resets: [['yAxis.titleOverride', '']] } },
                { kind: 'font', label: 'Font:' }
            ] },
            { group: 'Axis Line', controls: [
                { kind: 'number', label: 'Thickness:', path: 'yAxis.lineThickness',
                  min: 0.5, max: 6, step: 0.5, decimals: 1 },
                { kind: 'colour', label: 'Colour:', path: 'yAxis.lineColour',
                  colour: () => chart.resolveColour(state.yAxis.lineColour) || '#808080' },
                { kind: 'select', label: 'Location:', path: 'yAxis.location',
                  options: chart.AXIS_LOCATIONS_Y }
            ] },
            { group: 'Axis Labels', controls: [
                { kind: 'check-slider', checkLabel: 'Visible', checkPath: 'yAxis.labelsVisible',
                  sliderLabel: 'Angle', path: 'yAxis.labelAngle', min: -90, max: 90, step: 1,
                  enabled: () => state.yAxis.labelsVisible },
                { kind: 'select', label: 'Format:', path: 'yAxis.labelFormat',
                  options: chart.LABEL_FORMATS, enabled: () => state.yAxis.labelsVisible },
                { kind: 'font', label: 'Font:' },
                { kind: 'select', label: 'Location:', path: 'yAxis.labelLocation',
                  options: chart.LABEL_LOCATIONS, enabled: () => state.yAxis.labelsVisible }
            ] },
            { group: 'Range Values', controls: [
                { kind: 'auto-number', label: 'Minimum:', path: 'yAxis.minimumOverride', step: 1,
                  autoValue: () => state.yAxis.autoMin, enabled: () => !state.yAxis.log },
                { kind: 'auto-number', label: 'Maximum:', path: 'yAxis.maximumOverride', step: 1,
                  autoValue: () => state.yAxis.autoMax, enabled: () => !state.yAxis.log },
                { kind: 'auto-number', label: 'Interval:', path: 'yAxis.intervalOverride', step: 1,
                  autoValue: () => state.yAxis.autoInterval, enabled: () => !state.yAxis.log },
                { kind: 'auto-number', label: 'Minor Interval:', path: 'yAxis.minorIntervalOverride',
                  step: 0.5, autoValue: () => state.yAxis.autoMinorInterval,
                  enabled: () => !state.yAxis.log && state.yAxis.minorGridLines },
                { kind: 'check', label: 'Invert Axis', path: 'yAxis.inverted' },
                { kind: 'check', label: 'Log', path: 'yAxis.log' },
                { kind: 'revert', label: 'Revert range values to Auto', resets: [
                    ['yAxis.minimumOverride', null], ['yAxis.maximumOverride', null],
                    ['yAxis.intervalOverride', null], ['yAxis.minorIntervalOverride', null],
                    ['yAxis.inverted', false], ['yAxis.log', false]
                ] }
            ] }
        ] };
    }

    if (node === 'xaxis') {
        return { heading: 'X Axis 1', groups: [
            { group: 'Axis Title', controls: [
                { kind: 'text', label: 'Title:', path: 'xAxis.titleOverride',
                  revert: { label: 'Clear the axis title',
                    resets: [['xAxis.titleOverride', '']] } },
                { kind: 'font', label: 'Font:' }
            ] },
            { group: 'Axis Line', controls: [
                { kind: 'number', label: 'Thickness:', path: 'xAxis.lineThickness',
                  min: 0.5, max: 6, step: 0.5, decimals: 1 },
                { kind: 'colour', label: 'Colour:', path: 'xAxis.lineColour',
                  colour: () => chart.resolveColour(state.xAxis.lineColour) || '#808080' },
                { kind: 'select', label: 'Location:', path: 'xAxis.location',
                  options: chart.AXIS_LOCATIONS_X }
            ] },
            { group: 'Axis Labels', controls: [
                { kind: 'check-slider', checkLabel: 'Visible', checkPath: 'xAxis.labelsVisible',
                  sliderLabel: 'Angle', path: 'xAxis.labelAngle', min: -90, max: 90, step: 1,
                  enabled: () => state.xAxis.labelsVisible },
                { kind: 'select', label: 'Format:', path: 'xAxis.labelFormat',
                  options: chart.LABEL_FORMATS_TIME, enabled: () => state.xAxis.labelsVisible },
                { kind: 'select', label: 'Date Format:', path: 'xAxis.fixedDateFormat',
                  options: chart.FIXED_DATE_FORMATS,
                  enabled: () => state.xAxis.labelsVisible && state.xAxis.labelFormat === 'Fixed Date' },
                { kind: 'font', label: 'Font:' },
                { kind: 'select', label: 'Location:', path: 'xAxis.labelLocation',
                  options: chart.LABEL_LOCATIONS, enabled: () => state.xAxis.labelsVisible }
            ] },
            { group: 'Range Values', controls: [
                { kind: 'date', label: 'Start Date:', path: 'xAxis.min',
                  min: () => new Date(state.dataMin).toISOString().slice(0, 10),
                  max: () => new Date(state.dataMax).toISOString().slice(0, 10) },
                { kind: 'date', label: 'End Date:', path: 'xAxis.max',
                  min: () => new Date(state.dataMin).toISOString().slice(0, 10),
                  max: () => new Date(state.dataMax).toISOString().slice(0, 10) },
                { kind: 'check', label: 'Use Date Interval', path: 'xAxis.useDateInterval' },
                { kind: 'number', label: 'Interval:', path: 'xAxis.dateInterval',
                  min: 1, max: 50, step: 1, decimals: 0,
                  enabled: () => state.xAxis.useDateInterval },
                { kind: 'select', label: 'Interval Unit:', path: 'xAxis.dateIntervalUnit',
                  options: chart.DATE_INTERVAL_UNITS, enabled: () => state.xAxis.useDateInterval },
                { kind: 'revert', label: 'Revert range values to the full history', resets: [
                    ['xAxis.min', state.dataMin], ['xAxis.max', state.dataMax],
                    ['xAxis.useDateInterval', false], ['xAxis.dateInterval', 1],
                    ['xAxis.dateIntervalUnit', 'Years']
                ] }
            ] }
        ] };
    }

    if (node.startsWith('curve:')) {
        const curve = selectedCurve(state);
        return { heading: curve ? curve.label : 'Data Series', groups: [
            { group: 'Line Format', controls: [
                { kind: 'colour', label: 'Colour:', path: 'curve.colourIndex',
                  colour: () => curve ? (chart.resolveColour(curve.colourIndex) || chart.seriesToken(0)) : 'transparent' },
                { kind: 'select', label: 'Plot Type:', path: 'curve.plotType',
                  options: chart.LINE_PLOT_TYPES },
                { kind: 'select', label: 'Style:', path: 'curve.lineStyle',
                  options: chart.LINE_STYLES,
                  enabled: () => curve && curve.plotType !== 'Scatter' },
                { kind: 'number', label: 'Width:', path: 'curve.lineWidth',
                  min: 0.5, max: 10, step: 0.5, decimals: 1,
                  enabled: () => curve && curve.plotType !== 'Scatter' }
            ] },
            { group: 'Marker Format', controls: [
                { kind: 'colour', label: 'Colour:', path: 'curve.markerColourIndex',
                  colour: () => curve
                      ? (chart.resolveColour(curve.markerColourIndex) || chart.resolveColour(curve.colourIndex) || chart.seriesToken(0))
                      : 'transparent' },
                { kind: 'select', label: 'Symbol:', path: 'curve.markerType',
                  options: chart.MARKER_TYPES },
                { kind: 'number', label: 'Size:', path: 'curve.markerSize',
                  min: 1, max: 16, step: 1, decimals: 1,
                  enabled: () => curve && (curve.markerType !== 'None' || curve.plotType === 'Scatter') }
            ] }
        ] };
    }

    // 'chart', 'axes' and 'series' are unclickable headings (see buildTree), so this fallback is
    // only ever reached before a selection is made.
    return { heading: 'Chart Settings', groups: [
        { group: 'General', controls: [
            { kind: 'static', label: 'Case:', value: () => state.caseName },
            { kind: 'static', label: 'Title:', value: () => state.title },
            { kind: 'static', label: 'Series plotted:',
              value: () => String(state.curves.filter(c => c.visible).length) }
        ] }
    ] };
}

/* -------------------------------------------------------------------- build ------------------- */

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

// Tree glyphs, drawn to match the product's node icons closely enough that the tree reads as the
// same control: a chart tile for Chart Settings and Data Series, the legend capsule, the blue XY
// for Axes, per-axis marks, and a grey bullet for a plotted vector.
const ICONS = {
    chart: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
        + '<rect x="1" y="1" width="14" height="14" fill="#fff" stroke="#7a7a7a"/>'
        + '<path d="M2.5 11.5 6 7l3 3 4.5-6" fill="none" stroke="#e08a2e" stroke-width="1.4"/>'
        + '<path d="M2.5 13.5 6 10l3 2 4.5-4" fill="none" stroke="#2a78d6" stroke-width="1.4"/></svg>',
    legend: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
        + '<rect x="1.5" y="5.5" width="13" height="5" rx="2.5" fill="#fff" stroke="#5a5a5a"/></svg>',
    axes: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
        + '<text x="8" y="12" text-anchor="middle" font-size="10" font-weight="700"'
        + ' font-family="Segoe UI, sans-serif" fill="#2a56b8">XY</text></svg>',
    xaxis: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
        + '<path d="M2 12h12M4 12v-3M8 12v-3M12 12v-3" stroke="#5a5a5a" fill="none"/>'
        + '<text x="4" y="7" font-size="7" font-family="Segoe UI, sans-serif" fill="#000">X</text></svg>',
    yaxis: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
        + '<path d="M4 2v12M4 4h3M4 8h3M4 12h3" stroke="#5a5a5a" fill="none"/>'
        + '<text x="8" y="8" font-size="7" font-family="Segoe UI, sans-serif" fill="#000">Y</text></svg>',
    series: '<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">'
        + '<circle cx="8" cy="8" r="4" fill="#808080"/></svg>'
};

function buildTree(state, container) {
    container.textContent = '';

    // 'chart', 'axes' and 'series' are headings in the real dialog, not pages — selecting them
    // shows nothing. They render as plain, unclickable labels (label: true) with the same icon
    // and expander glyph as the product, but no button semantics, no hover state and no
    // aria-current. Only Legend, an individual axis, or an individual series is a real node.
    const node = (id, label, options) => {
        const settings = options || {};
        const tag = settings.label ? 'span' : 'button';
        const el = element(tag, 's3-node');
        if (tag === 'button') {
            el.type = 'button';
            el.dataset.node = id;
            el.setAttribute('aria-current', String(state.selectedNode === id));
        } else {
            el.classList.add('s3-node-heading');
        }

        const expander = element('span', 's3-expander');
        if (settings.parent) expander.innerHTML =
            '<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">'
            + '<path d="M0 0v8l8-8z" fill="#4a4a4a" transform="rotate(45 4 4)"/></svg>';
        el.appendChild(expander);

        const icon = element('span', 's3-icon');
        if (settings.icon) icon.innerHTML = ICONS[settings.icon];
        el.appendChild(icon);

        el.appendChild(element('span', 's3-node-label', label));
        if (settings.extra) el.appendChild(settings.extra);
        return el;
    };

    const root = element('ul');
    const rootItem = element('li');
    rootItem.appendChild(node('chart', 'Chart Settings', { parent: true, icon: 'chart', label: true }));

    const children = element('ul');

    const legendItem = element('li');
    legendItem.appendChild(node('legend', 'Legend', { icon: 'legend' }));
    children.appendChild(legendItem);

    const axesItem = element('li');
    axesItem.appendChild(node('axes', 'Axes', { parent: true, icon: 'axes', label: true }));
    const axisList = element('ul');
    for (const [id, label, icon] of [['xaxis', 'X Axis 1', 'xaxis'], ['yaxis', 'Y Axis 1', 'yaxis']]) {
        const li = element('li');
        li.appendChild(node(id, label, { icon }));
        axisList.appendChild(li);
    }
    axesItem.appendChild(axisList);
    children.appendChild(axesItem);

    const seriesItem = element('li');
    seriesItem.appendChild(node('series', 'Data Series', { parent: true, icon: 'chart', label: true }));
    const seriesList = element('ul');
    for (const curve of state.curves.filter(c => c.visible)) {
        const li = element('li');
        const remove = element('button', 's3-node-remove', '✕');
        remove.type = 'button';
        remove.dataset.remove = String(curve.key);
        remove.title = `Remove ${curve.label}`;
        remove.setAttribute('aria-label', `Remove ${curve.label}`);
        li.appendChild(node('curve:' + curve.key, curve.label, { icon: 'series', extra: remove }));
        seriesList.appendChild(li);
    }
    seriesItem.appendChild(seriesList);
    children.appendChild(seriesItem);

    rootItem.appendChild(children);
    root.appendChild(rootItem);
    container.appendChild(root);
}

function buildPanel(state, container) {
    container.textContent = '';
    const spec = panelFor(state);

    const outer = element('fieldset', 's3-group');
    outer.appendChild(element('legend', null, spec.heading));

    for (const group of spec.groups) {
        const host = group.group ? element('fieldset', 's3-group') : outer;
        if (group.group) host.appendChild(element('legend', null, group.group));

        for (const control of group.controls) {
            const row = element('label', 's3-row');
            row.dataset.kind = control.kind;
            const caption = element('span', null, control.label);

            if (control.kind === 'check') {
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.dataset.path = control.path;
                row.appendChild(input);
                row.appendChild(caption);
            } else if (control.kind === 'select') {
                const input = document.createElement('select');
                input.dataset.path = control.path;
                const options = typeof control.options === 'function' ? control.options() : control.options;
                input.dataset.optionsSignature = JSON.stringify(options);
                for (const option of options) {
                    const opt = document.createElement('option');
                    opt.value = option;
                    opt.textContent = option;
                    input.appendChild(opt);
                }
                row.appendChild(caption);
                row.appendChild(input);
            } else if (control.kind === 'number') {
                const spin = element('div', 's3-spin');
                const input = document.createElement('input');
                input.type = 'number';
                input.min = control.min;
                input.max = control.max;
                input.step = control.step;
                input.dataset.path = control.path;
                const arrows = element('div', 's3-spin-arrows');
                for (const [dir, glyph] of [['up', '▲'], ['down', '▼']]) {
                    const button = element('button', null, glyph);
                    button.type = 'button';
                    button.tabIndex = -1;
                    button.dataset.spin = dir;
                    button.dataset.for = control.path;
                    button.setAttribute('aria-hidden', 'true');
                    arrows.appendChild(button);
                }
                spin.appendChild(input);
                spin.appendChild(arrows);
                row.appendChild(caption);
                row.appendChild(spin);
            } else if (control.kind === 'colour') {
                const button = element('button', 's3-colour');
                button.type = 'button';
                const swatch = element('span', 's3-colour-swatch');
                swatch.style.background = typeof control.colour === 'function' ? control.colour() : control.colour;
                button.appendChild(swatch);
                button.appendChild(element('span', 's3-colour-arrow', '▼'));
                if (control.path) {
                    button.dataset.palette = control.path;
                    button.setAttribute('aria-label', `${control.label} choose colour`);
                } else {
                    button.disabled = true;
                }
                row.style.position = 'relative';
                row.appendChild(caption);
                row.appendChild(button);
            } else if (control.kind === 'static') {
                row.appendChild(caption);
                row.appendChild(element('span', null, control.value()));
            } else if (control.kind === 'text') {
                const input = document.createElement('input');
                input.type = 'text';
                input.dataset.path = control.path;
                row.appendChild(caption);
                row.appendChild(input);
                // The revert sits directly beside the field it reverts, matching the product —
                // not detached at the bottom of the group, which read as an unexplained control.
                if (control.revert) {
                    const button = element('button', 's3-revert-button', '↺');
                    button.type = 'button';
                    button.dataset.revert = control.revert.label;
                    button.title = control.revert.label;
                    button.setAttribute('aria-label', control.revert.label);
                    row.appendChild(button);
                }
            } else if (control.kind === 'font') {
                // Font family/size never made it in: doing it honestly means a working font
                // picker wired to the chart's actual text, and that's out of scope here rather
                // than a button that opens nothing. Disabled and explained, not hidden.
                const button = element('button', 's3-button', 'Select…');
                button.type = 'button';
                button.disabled = true;
                button.title = 'Font selection is not implemented in this demo.';
                row.appendChild(caption);
                row.appendChild(button);
                row.appendChild(element('span', 's3-font-preview', 'Preview'));
            } else if (control.kind === 'check-slider') {
                // "Visible", the slider and its spinner sit on ONE row in the product — not the
                // checkbox on its own row above, which is what the first build got wrong.
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.dataset.path = control.checkPath;
                row.appendChild(check);
                row.appendChild(element('span', null, control.checkLabel));

                // The slider column shrinks to fit — a bare <input type=range> refuses to shrink
                // below its default intrinsic width without min-width:0, which is what was
                // pushing the spinner outside the dialog in an earlier version.
                const block = element('div', 's3-slider-block');

                // Visual track: a plain line + a positioned thumb, built entirely from elements
                // this file controls rather than relied on to render via ::-webkit-slider-* /
                // ::-moz-range-* — see the CSS comment for why native styling wasn't reliable.
                // Tick marks are children of `track`, not `block`, because only `track` carries
                // the position:relative that anchors them — the earlier version appended ticks
                // to `block` instead, so they rendered at the document's origin, not the control.
                const track = element('div', 's3-slider-track');
                const line = element('div', 's3-slider-line');
                const fill = element('div', 's3-slider-fill');
                const thumb = element('div', 's3-slider-thumb');

                const span = control.max - control.min;
                const tickStep = [1, 2, 5, 10, 15, 30, 45, 90].find(s => span / s <= 14) || 90;
                const tickCount = Math.round(span / tickStep) + 1;
                const ticks = element('div', 's3-slider-ticks');
                for (let i = 0; i < tickCount; i++) ticks.appendChild(document.createElement('span'));

                const range = document.createElement('input');
                range.type = 'range';
                range.min = control.min;
                range.max = control.max;
                range.step = control.step || 1;
                range.dataset.path = control.path;
                range.dataset.sliderVisual = 'true';

                track.appendChild(ticks);
                track.appendChild(line);
                track.appendChild(fill);
                track.appendChild(thumb);
                track.appendChild(range);
                positionSliderThumb(track, control.min, control.max, read(state, control.path));
                block.appendChild(track);
                block.appendChild(element('span', 's3-slider-caption', control.sliderLabel));
                row.appendChild(block);

                const spin = element('div', 's3-spin');
                const number = document.createElement('input');
                number.type = 'number';
                number.min = control.min;
                number.max = control.max;
                number.step = control.step || 1;
                number.dataset.sliderMirror = control.path;
                const arrows = element('div', 's3-spin-arrows');
                for (const [dir, glyph] of [['up', '▲'], ['down', '▼']]) {
                    const button = element('button', null, glyph);
                    button.type = 'button';
                    button.tabIndex = -1;
                    button.dataset.spin = dir;
                    button.dataset.for = control.path;
                    button.setAttribute('aria-hidden', 'true');
                    arrows.appendChild(button);
                }
                spin.appendChild(number);
                spin.appendChild(arrows);
                row.appendChild(spin);
            } else if (control.kind === 'date') {
                const input = document.createElement('input');
                input.type = 'date';
                input.dataset.pathDate = control.path;
                if (control.min !== undefined) input.min = typeof control.min === 'function' ? control.min() : control.min;
                if (control.max !== undefined) input.max = typeof control.max === 'function' ? control.max() : control.max;
                row.appendChild(caption);
                row.appendChild(input);
            } else if (control.kind === 'auto-number') {
                const spin = element('div', 's3-spin');
                const input = document.createElement('input');
                input.type = 'text';
                input.dataset.pathAuto = control.path;
                input.dataset.autoStep = control.step;
                const arrows = element('div', 's3-spin-arrows');
                for (const [dir, glyph] of [['up', '▲'], ['down', '▼']]) {
                    const button = element('button', null, glyph);
                    button.type = 'button';
                    button.tabIndex = -1;
                    button.dataset.spinAuto = dir;
                    button.dataset.for = control.path;
                    button.setAttribute('aria-hidden', 'true');
                    arrows.appendChild(button);
                }
                spin.appendChild(input);
                spin.appendChild(arrows);
                row.appendChild(caption);
                row.appendChild(spin);
            } else if (control.kind === 'revert') {
                const button = element('button', 's3-revert-button', '↺');
                button.type = 'button';
                button.dataset.revert = control.label;
                button.title = control.label;
                button.setAttribute('aria-label', control.label);
                row.className = 's3-row s3-row-revert';
                row.appendChild(button);
            }

            host.appendChild(row);
        }

        if (group.group) outer.appendChild(host);
    }

    container.appendChild(outer);
    syncPanel(state, container);
}

function syncPanel(state, container) {
    const spec = panelFor(state);
    const controls = spec.groups.flatMap(g => g.controls);

    for (const control of controls) {
        if (!control.path) continue;

        // Colour swatches are a <button data-palette>, not a [data-path] input, and their colour
        // was previously only ever painted once at build time — never repainted after a pick.
        // That was the reported bug: choosing a colour updated the model but not the button.
        if (control.kind === 'colour') {
            const swatch = container.querySelector(`[data-palette="${control.path}"] .s3-colour-swatch`);
            if (swatch) swatch.style.background = typeof control.colour === 'function'
                ? control.colour() : control.colour;
            continue;
        }

        // A native date input, kept out of the generic [data-path] lookup because its DOM value
        // is a "YYYY-MM-DD" string while the model holds a millisecond timestamp.
        if (control.kind === 'date') {
            const input = container.querySelector(`[data-path-date="${control.path}"]`);
            if (!input) continue;
            const enabled = control.enabled ? Boolean(control.enabled()) : true;
            input.disabled = !enabled;
            input.closest('.s3-row').classList.toggle('is-disabled', !enabled);
            const ms = read(state, control.path);
            if (Number.isFinite(ms)) input.value = new Date(ms).toISOString().slice(0, 10);
            continue;
        }

        // "Auto" is a sentinel, not a number — this control shows the literal word until the
        // visitor's first nudge replaces it with a real value.
        if (control.kind === 'auto-number') {
            const input = container.querySelector(`[data-path-auto="${control.path}"]`);
            if (!input) continue;
            const enabled = control.enabled ? Boolean(control.enabled()) : true;
            input.disabled = !enabled;
            input.closest('.s3-spin')?.classList.toggle('is-disabled', !enabled);
            const value = read(state, control.path);
            input.value = value === null || value === undefined ? 'Auto' : trimDecimal(value);
            continue;
        }

        // The "Visible" checkbox shares this control with the slider it gates, but under its
        // own path — always kept in sync and always enabled, regardless of the slider's state.
        if (control.kind === 'check-slider') {
            const check = container.querySelector(`[data-path="${control.checkPath}"]`);
            if (check) check.checked = Boolean(read(state, control.checkPath));
        }

        const input = container.querySelector(`[data-path="${control.path}"]`);
        if (!input) continue;

        const enabled = control.enabled ? Boolean(control.enabled()) : true;
        input.disabled = !enabled;
        input.closest('.s3-row').classList.toggle('is-disabled', !enabled);
        input.closest('.s3-spin')?.classList.toggle('is-disabled', !enabled);

        // The angle slider's linked number spinner shares the range input's path but a different
        // attribute, so it isn't caught by the [data-path] lookup above either. The custom
        // fill/thumb elements need the same repositioning, since they're plain divs the browser
        // never updates on its own — only the invisible native input moves by itself.
        if (control.kind === 'slider' || control.kind === 'check-slider') {
            const mirror = container.querySelector(`[data-slider-mirror="${control.path}"]`);
            if (mirror) {
                mirror.value = read(state, control.path);
                mirror.disabled = !enabled;
                mirror.closest('.s3-spin')?.classList.toggle('is-disabled', !enabled);
            }

            const track = container.querySelector(`[data-slider-visual][data-path="${control.path}"]`)?.closest('.s3-slider-track');
            if (track) positionSliderThumb(track, control.min, control.max, read(state, control.path));
        }

        // A select's option set can itself depend on other settings (Vertical Position on
        // Orientation) — rebuild it in place, without a full panel rebuild, when it changes.
        if (input.tagName === 'SELECT' && typeof control.options === 'function') {
            const options = control.options();
            const signature = JSON.stringify(options);
            if (input.dataset.optionsSignature !== signature) {
                input.dataset.optionsSignature = signature;
                input.textContent = '';
                for (const option of options) {
                    const opt = document.createElement('option');
                    opt.value = option;
                    opt.textContent = option;
                    input.appendChild(opt);
                }
            }
        }

        const value = read(state, control.path);
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else if (control.decimals !== undefined) input.value = Number(value).toFixed(control.decimals);
        else input.value = value;
    }
}

/* --------------------------------------------------------------------- mount ------------------ */

export async function mount(figure, config) {
    const model = await loadModel();

    const modelTimes = model.time.monthly;
    const dataMin = modelTimes[0];
    const dataMax = modelTimes[modelTimes.length - 1];

    const state = {
        caseName: model.caseName,
        curves: buildCurves(model, config),
        selectedCurve: 0,
        selectedNode: 'legend',
        nextColour: 0,
        height: Number(figure.dataset.demoHeight) || 430,
        // The model's real span, fixed for the demo's lifetime — Start/End Date can zoom inside
        // this range (and the revert button snaps back to it), but recompute() never touches it.
        dataMin, dataMax,
        xAxis: {
            min: dataMin, max: dataMax, inverted: false, majorGridLines: false,
            titleOverride: '', lineThickness: 1, lineColour: null, location: 'Bottom',
            labelsVisible: true, labelAngle: 0, labelFormat: 'Dynamic Date',
            fixedDateFormat: 'dd MMM yyyy', labelLocation: 'Outside',
            useDateInterval: false, dateInterval: 1, dateIntervalUnit: 'Years'
        },
        yAxis: {
            min: 0, max: 1, log: false, inverted: false,
            majorGridLines: false, minorGridLines: false,
            labelFormat: 'Scientific Notation', title: '', titleOverride: '',
            lineThickness: 1, lineColour: null, location: 'Left',
            labelsVisible: true, labelAngle: 0, labelLocation: 'Outside',
            // null = Auto in every one of these; see the "Range Values" group and autoValue().
            minimumOverride: null, maximumOverride: null,
            intervalOverride: null, minorIntervalOverride: null,
            autoMin: 0, autoMax: 1, autoInterval: 1, autoMinorInterval: 0.5
        },
        legend: {
            show: true, orientation: 'Horizontal', inOut: 'Outside',
            horizontal: 'Stretch', vertical: 'Top', borderThickness: 1,
            // Unset (null) means "use the product's own default cream/black" — see
            // chart.resolveColour(). Only becomes a number (palette index) or a hex string
            // (custom colour) once the visitor actually picks one.
            backgroundColour: null, borderColour: null
        },
        title: '',
        tabLabel: '',
        // Demo-only convenience, not a real product setting — see the checkbox below the chart.
        showTooltip: true
    };
    state.selectedCurve = (state.curves.find(c => c.visible) || state.curves[0]).key;

    const wrap = element('div', 'demo-wrap');

    // A badge, not a groupbox around the whole demo: the chart/dialog below are styled to be
    // indistinguishable from the real product (see the "Try it" hint's own comment further down
    // on why nothing can hint at interactivity from inside them), so the "this is live" signal
    // has to live outside — but as the very first thing on the page, before a visitor scrolls
    // past the chart without noticing the smaller hint text beneath it.
    const badge = element('div', 'demo-badge');
    badge.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
        + '<path d="M5 1.5v7.6L7 7l1.6 3.8 1.8-.8L8.8 6.3l2.7-.3z" fill="currentColor"/></svg> '
        + 'Live Demo Section Below';
    wrap.appendChild(badge);

    const plotHost = element('div', 'demo-plot');
    wrap.appendChild(plotHost);

    const dialog = element('div', 's3-dialog');
    dialog.setAttribute('role', 'group');
    dialog.setAttribute('aria-label', 'Line Chart Settings');

    // No close, undo/redo or help buttons: they belong to the real window, and on a page where the
    // settings are the point of the demo there is nothing for them to do.
    const titleBar = element('div', 's3-dialog-title');
    titleBar.appendChild(element('h3', null, 'Line Chart Settings'));
    dialog.appendChild(titleBar);

    const body = element('div', 's3-dialog-body');
    const tree = element('div', 's3-tree');
    const panel = element('div', 's3-panel');
    body.appendChild(tree);
    body.appendChild(panel);
    dialog.appendChild(body);

    // Site furniture, not part of the emulated window — the same reasoning as the restore bar
    // below. The dialog is styled to be indistinguishable from the real S3analyse window, which
    // is exactly why nothing inside it can hint that it's clickable: a cursor icon or "try me"
    // badge on the window itself would undermine the fidelity that's the point of the demo. The
    // affordance has to live outside it.
    const liveHint = element('p', 'demo-live-hint');
    liveHint.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
        + '<path d="M5 1.5v7.6L7 7l1.6 3.8 1.8-.8L8.8 6.3l2.7-.3z" '
        + 'fill="currentColor"/></svg> '
        + 'Try it — click any setting below to update the chart above.';
    wrap.appendChild(liveHint);

    // Demo-only chrome, same reasoning as the restore bar below: the real product's chart always
    // shows this tooltip on hover with no visible toggle, so a checkbox here would misrepresent
    // the product if placed inside the emulated dialog. Kept outside it, plainly styled as site
    // furniture, purely so a visitor comparing screenshots can turn the hover behaviour off.
    const tooltipToggle = element('label', 'demo-tooltip-toggle');
    const tooltipCheckbox = document.createElement('input');
    tooltipCheckbox.type = 'checkbox';
    tooltipCheckbox.checked = state.showTooltip;
    tooltipToggle.appendChild(tooltipCheckbox);
    tooltipToggle.appendChild(document.createTextNode(' Show tooltip on hover'));
    tooltipCheckbox.addEventListener('change', () => {
        state.showTooltip = tooltipCheckbox.checked;
        draw();
    });
    wrap.appendChild(tooltipToggle);

    wrap.appendChild(dialog);

    // Not part of the emulated window: curves normally arrive from the project tree or Miller
    // columns, which are out of scope for a demo, and there is no page for that in the real
    // dialog. Styled as plain site furniture so it reads as a substitute, not as more of the
    // product — it is what puts a removed series back within reach.
    const restoreBar = element('div', 'demo-restore');
    const restoreLabel = element('span', null, 'Add a removed series:');
    const restoreSelect = document.createElement('select');
    restoreSelect.className = 'demo-restore-select';
    const restoreButton = element('button', 'demo-open', 'Add');
    restoreButton.type = 'button';
    restoreBar.appendChild(restoreLabel);
    restoreBar.appendChild(restoreSelect);
    restoreBar.appendChild(restoreButton);
    wrap.appendChild(restoreBar);

    const syncRestoreBar = () => {
        const hidden = state.curves.filter(c => !c.visible);
        restoreBar.hidden = hidden.length === 0;
        restoreSelect.textContent = '';
        for (const curve of hidden) {
            const opt = document.createElement('option');
            opt.value = String(curve.key);
            opt.textContent = `${curve.member} ${curve.name}`;
            restoreSelect.appendChild(opt);
        }
    };

    restoreButton.addEventListener('click', () => {
        const curve = state.curves.find(c => String(c.key) === restoreSelect.value);
        if (curve) {
            curve.visible = true;
            state.selectedCurve = curve.key;
            state.selectedNode = 'curve:' + curve.key;
        }
        refresh(true);
    });

    let renderedNode = null;

    const draw = () => {
        recompute(state);
        state.description = `${state.title}. `
            + `${state.curves.filter(c => c.visible).length} series plotted.`;
        const handle = chart.render(plotHost, state);
        if (handle) chart.attachTooltip(handle, state);
    };

    const refresh = (structural) => {
        draw();
        if (structural || renderedNode !== state.selectedNode) {
            buildTree(state, tree);
            buildPanel(state, panel);
            renderedNode = state.selectedNode;
        } else {
            syncPanel(state, panel);
        }
        syncRestoreBar();
    };

    const closePalette = () => panel.querySelector('.s3-palette')?.remove();

    const onInput = event => {
        const target = event.target;

        if (target.classList.contains('s3-palette-native')) {
            write(state, target.dataset.for, target.value);
            pushRecent(target.value);
            closePalette();
            refresh(false);
            return;
        }

        if (target.dataset.pathDate) {
            const ms = Date.parse(target.value + 'T00:00:00Z');
            if (Number.isFinite(ms)) {
                const clamped = Math.min(state.dataMax, Math.max(state.dataMin, ms));
                write(state, target.dataset.pathDate, clamped);
                refresh(false);
            }
            return;
        }

        if (target.dataset.sliderMirror) {
            write(state, target.dataset.sliderMirror, Number(target.value));
            refresh(false);
            return;
        }

        if (!target.dataset.path) return;
        const value = target.type === 'checkbox' ? target.checked
            : (target.type === 'number' || target.type === 'range') ? Number(target.value)
                : target.value;
        write(state, target.dataset.path, value);
        refresh(false);
    };

    const onClick = event => {
        const spin = event.target.closest('[data-spin]');
        if (spin) {
            const input = panel.querySelector(`input[data-path="${spin.dataset.for}"]`);
            if (input && !input.disabled) {
                const step = Number(input.step) || 1;
                const next = Number(input.value) + (spin.dataset.spin === 'up' ? step : -step);
                const clamped = Math.min(Number(input.max), Math.max(Number(input.min), next));
                write(state, input.dataset.path, +clamped.toFixed(2));
                refresh(false);
            }
            return;
        }

        const spinAuto = event.target.closest('[data-spin-auto]');
        if (spinAuto) {
            const input = panel.querySelector(`[data-path-auto="${spinAuto.dataset.for}"]`);
            if (input && !input.disabled) {
                const control = panelFor(state).groups.flatMap(g => g.controls)
                    .find(c => c.path === spinAuto.dataset.for);
                const step = Number(input.dataset.autoStep) || 1;
                const current = read(state, spinAuto.dataset.for);
                // Leaving "Auto" starts from what auto-fit is currently showing, not from zero —
                // the point is to nudge away from the computed value, not replace it blindly.
                const base = current === null || current === undefined
                    ? (control?.autoValue ? control.autoValue() : 0)
                    : current;
                const next = base + (spinAuto.dataset.spinAuto === 'up' ? step : -step);
                write(state, spinAuto.dataset.for, +next.toFixed(4));
                refresh(false);
            }
            return;
        }

        const revert = event.target.closest('[data-revert]');
        if (revert) {
            const controls = panelFor(state).groups.flatMap(g => g.controls);
            const spec = controls.find(c => c.kind === 'revert' && c.label === revert.dataset.revert)
                || controls.find(c => c.revert && c.revert.label === revert.dataset.revert)?.revert;
            if (spec) {
                for (const [path, value] of spec.resets) write(state, path, value);
                refresh(true);
            }
            return;
        }

        // The compound colour popup: Current Color preview, Current Color Palette (the twelve
        // ColourChart entries), Recent Color Palette (shared across every picker on the page),
        // and Advanced (a native colour input — the honest stand-in for the product's full
        // RGB/HSL dialog, which a web page cannot reproduce).
        const paletteButton = event.target.closest('[data-palette]');
        if (paletteButton) {
            if (panel.querySelector('.s3-palette')) { closePalette(); return; }

            const control = panelFor(state).groups.flatMap(g => g.controls)
                .find(c => c.path === paletteButton.dataset.palette);
            if (!control) return;

            const currentHex = control.colour();
            const currentLiteral = literalHex(currentHex);
            const picker = element('div', 's3-palette');

            picker.appendChild(element('div', 's3-palette-label', 'Current Color:'));
            const preview = element('div', 's3-palette-preview');
            preview.style.background = currentHex;
            picker.appendChild(preview);

            picker.appendChild(element('div', 's3-palette-label', 'Current Color Palette:'));
            const paletteRow = element('div', 's3-palette-row');
            PALETTE_HEX.forEach((hex, i) => {
                const swatch = document.createElement('button');
                swatch.type = 'button';
                swatch.style.background = hex;
                swatch.dataset.source = 'palette';
                swatch.dataset.index = String(i);
                swatch.title = `Palette index ${i}`;
                swatch.setAttribute('aria-label', swatch.title);
                swatch.setAttribute('aria-current', String(hex === currentLiteral));
                paletteRow.appendChild(swatch);
            });
            picker.appendChild(paletteRow);

            picker.appendChild(element('div', 's3-palette-label', 'Recent Color Palette:'));
            const recentRow = element('div', 's3-palette-row');
            for (let i = 0; i < RECENT_LIMIT; i++) {
                const swatch = document.createElement('button');
                swatch.type = 'button';
                const hex = recentColours[i];
                if (hex) {
                    swatch.style.background = hex;
                    swatch.dataset.source = 'recent';
                    swatch.dataset.hex = hex;
                    swatch.title = hex;
                    swatch.setAttribute('aria-label', `Recent colour ${hex}`);
                } else {
                    swatch.className += ' is-empty';
                    swatch.disabled = true;
                    swatch.setAttribute('aria-hidden', 'true');
                }
                recentRow.appendChild(swatch);
            }
            picker.appendChild(recentRow);

            const advanced = element('button', 's3-button s3-palette-advanced', 'Advanced…');
            advanced.type = 'button';
            advanced.dataset.source = 'advanced';
            picker.appendChild(advanced);

            const native = document.createElement('input');
            native.type = 'color';
            native.className = 's3-palette-native';
            native.tabIndex = -1;
            native.value = /^#[0-9a-f]{6}$/i.test(currentHex) ? currentHex : '#000000';
            native.dataset.for = control.path;
            picker.appendChild(native);

            paletteButton.closest('.s3-row').appendChild(picker);
            picker.style.left = '190px';
            picker.style.top = '26px';
            return;
        }

        const advancedButton = event.target.closest('[data-source="advanced"]');
        if (advancedButton) {
            // The native picker is modal in most browsers, so the popup can stay open behind it —
            // its 'input' handler (below, in onInput) applies the choice and closes everything.
            advancedButton.parentElement.querySelector('.s3-palette-native')?.click();
            return;
        }

        const chosen = event.target.closest('.s3-palette-row [data-source]');
        if (chosen) {
            // Scoped to the popup's own row: querying the panel for the first [data-palette]
            // always found Line Colour, since it comes first in the markup, so picking a Marker
            // Colour swatch was silently overwriting the line's colour instead.
            const owner = chosen.closest('.s3-row').querySelector('[data-palette]');
            if (owner) {
                const value = chosen.dataset.source === 'palette'
                    ? Number(chosen.dataset.index)
                    : chosen.dataset.hex;
                write(state, owner.dataset.palette, value);
                // Recent always stores a plain hex, even for a palette pick (an index), so every
                // entry in the strip is directly comparable and directly reusable.
                pushRecent(literalHex(chart.resolveColour(value)));
            }
            closePalette();
            refresh(false);
            return;
        }

        closePalette();

        const remove = event.target.closest('[data-remove]');
        if (remove) {
            event.preventDefault();
            const curve = state.curves.find(c => String(c.key) === remove.dataset.remove);
            if (curve) curve.visible = false;
            refresh(true);
            return;
        }

        const node = event.target.closest('[data-node]');
        if (node) {
            state.selectedNode = node.dataset.node;
            if (state.selectedNode.startsWith('curve:')) {
                state.selectedCurve = Number(state.selectedNode.slice(6));
            }
            refresh(true);
        }
    };

    dialog.addEventListener('change', onInput);
    dialog.addEventListener('input', onInput);
    dialog.addEventListener('click', onClick);

    const fallback = figure.querySelector('[data-demo-fallback]');
    figure.insertBefore(wrap, figure.firstElementChild);
    if (fallback) fallback.hidden = true;

    refresh(true);

    let frame = 0;
    const onResize = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(draw);
    };
    window.addEventListener('resize', onResize);

    return () => {
        window.removeEventListener('resize', onResize);
        cancelAnimationFrame(frame);
        wrap.remove();
        if (fallback) fallback.hidden = false;
    };
}
