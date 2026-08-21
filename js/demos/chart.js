// A reproduction of the S3analyse line chart, drawn as SVG.
//
// The goal is fidelity, not a nice-looking web chart: the site exists to promote S3analyse, so a
// visitor should see the product's own chart, not something inspired by it. Measured against
// wwwroot/img/help/lineplotexample.png and lineplot-wopr.png — white plot area, centred grey
// title, a full-width cream legend box above the plot, rotated grey axis titles carrying units in
// brackets, scientific tick labels in muted brown, no gridlines until asked for, and a thin black
// first series.
//
// It deliberately does NOT follow the site's light/dark toggle. Every colour comes from the
// theme-invariant --s3-* tokens in site.css. See docs/ADR-002-interactive-demos.md.

const NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------- product enumerations ----------------- */

// Source/ChartsMVPVM/Settings/LinePlotType.cs
export const LINE_PLOT_TYPES = ['Line', 'Scatter', 'Line & Scatter'];

// Source/ChartsMVPVM/Settings/LineStyle.cs, with the product's own dash arrays.
export const LINE_STYLES = ['Solid', 'Dash', 'Dot', 'Dash Dot', 'Dash Dot Dot'];
export const DASH_ARRAYS = {
    'Solid': '',
    'Dash': '4 4',
    'Dot': '2 2',
    'Dash Dot': '4 2 2 2',
    'Dash Dot Dot': '4 2 2 2 2 2'
};

// Source/ChartsMVPVM/Settings/MarkerTypeProxy.cs
export const MARKER_TYPES = ['None', 'Circle', 'Triangle', 'Pyramid', 'Square', 'Diamond',
    'Pentagon', 'Hexagon', 'Tetragram', 'Pentagram', 'Hexagram'];

// Source/ChartsMVPVM/Settings/LabelFormat.cs — numeric axes get one set, time axes another.
export const LABEL_FORMATS = ['Normal', 'Abbreviate', 'Scientific Notation'];
export const LABEL_FORMATS_TIME = ['Dynamic Date', 'Fixed Date'];

export const AXIS_LOCATIONS_X = ['Bottom', 'Top'];
export const AXIS_LOCATIONS_Y = ['Left', 'Right'];
export const LABEL_LOCATIONS = ['Outside', 'Inside'];
export const DATE_INTERVAL_UNITS = ['Days', 'Months', 'Years'];

export const LEGEND_HORIZONTAL = ['Left', 'Centre', 'Stretch', 'Right'];
export const LEGEND_VERTICAL = ['Top', 'Centre', 'Stretch', 'Bottom'];

// Source/Utility/ColourChart.cs — applied by insertion index, modulo 12.
export const PALETTE_LENGTH = 12;

// The literal values are repeated here only as var() fallbacks. site.css remains the source of
// truth; without a fallback, an unresolved token leaves SVG stroke at its default of "none" and
// fill at black, so a stale stylesheet would silently produce an empty or solid-black chart.
const PALETTE_FALLBACK = ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#00ffff',
    '#800000', '#008000', '#000080', '#800080', '#008080', '#808080'];

export function seriesToken(index) {
    const slot = index % PALETTE_LENGTH;
    return `var(--s3-series-${slot + 1}, ${PALETTE_FALLBACK[slot]})`;
}

/**
 * A colour field may hold a ColourChart index (number), a literal hex string picked via the
 * settings window's "Advanced" option, or be unset. This is the one place that turns any of
 * those into something an SVG attribute accepts, so every render call agrees on the rule.
 * Returns null when unset, leaving the fallback to the caller.
 */
export function resolveColour(value) {
    if (typeof value === 'number') return seriesToken(value);
    if (typeof value === 'string' && value) return value;
    return null;
}

/* ------------------------------------------------------------------ elements ------------------ */

function el(name, attrs, text) {
    const node = document.createElementNS(NS, name);
    for (const key in attrs) {
        if (attrs[key] !== null && attrs[key] !== undefined && attrs[key] !== '') {
            node.setAttribute(key, String(attrs[key]));
        }
    }
    if (text !== undefined) node.textContent = text;
    return node;
}

/* -------------------------------------------------------------------- scales ------------------ */

function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    const scaled = raw / magnitude;
    const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    return step * magnitude;
}

function linearTicks(min, max, target, stepOverride) {
    if (!(max > min)) return [min];
    const step = stepOverride > 0 ? stepOverride : niceStep(max - min, target);
    const first = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = first; v <= max + step * 1e-6; v += step) ticks.push(+v.toPrecision(12));
    return ticks;
}

function logTicks(min, max) {
    const lo = Math.floor(Math.log10(min));
    const hi = Math.ceil(Math.log10(max));
    const ticks = [];
    for (let e = lo; e <= hi; e++) {
        const v = Math.pow(10, e);
        if (v >= min && v <= max) ticks.push(v);
    }
    return ticks.length >= 2 ? ticks : linearTicks(min, max, 5);
}

// Year boundaries, at whatever spacing keeps the labels from colliding. Used for "Dynamic Date",
// the product's default — ticks land on calendar years regardless of the data's own step.
function yearTicks(minMs, maxMs, maxLabels) {
    const first = new Date(minMs).getUTCFullYear();
    const last = new Date(maxMs).getUTCFullYear();
    const span = Math.max(1, last - first);
    const steps = [1, 2, 5, 10, 20, 50];
    const step = steps.find(s => span / s <= maxLabels) || 100;
    const ticks = [];
    for (let y = Math.ceil(first / step) * step; y <= last; y += step) {
        const t = Date.UTC(y, 0, 1);
        if (t >= minMs && t <= maxMs) ticks.push({ value: t, label: String(y) });
    }
    return ticks;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Explicit spacing for "Use Date Interval" — the visitor names the step directly rather than
// leaving it to yearTicks' auto-selection.
function explicitDateTicks(minMs, maxMs, interval, unit) {
    const step = Math.max(1, Math.round(interval) || 1);
    const start = new Date(minMs);
    const ticks = [];
    let y = start.getUTCFullYear(), m = start.getUTCMonth(), d = start.getUTCDate();

    // Align the first tick to a clean boundary for the chosen unit, so "every 2 years" starts on
    // an even year rather than wherever the data happens to begin.
    if (unit === 'Years') { y = Math.ceil(y / step) * step; m = 0; d = 1; }
    else if (unit === 'Months') { d = 1; }

    let t = Date.UTC(y, m, d);
    if (t < minMs) {
        if (unit === 'Years') t = Date.UTC(y + step, 0, 1);
        else if (unit === 'Months') t = Date.UTC(y, m + step, 1);
        else t += step * 86400000;
    }

    let guard = 0;
    while (t <= maxMs && guard++ < 500) {
        ticks.push({ value: t, label: formatDateTick(t, 'Dynamic Date', null) });
        const dt = new Date(t);
        if (unit === 'Years') t = Date.UTC(dt.getUTCFullYear() + step, 0, 1);
        else if (unit === 'Months') t = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + step, 1);
        else t += step * 86400000;
    }
    return ticks;
}

// Source/ChartsMVPVM/Settings/FixedDateFormat.cs names a preset; this covers a representative
// few rather than all twelve, which is enough to show the setting doing something real.
export const FIXED_DATE_FORMATS = ['dd MMM yyyy', 'MMM yyyy', 'MM/yyyy', 'yyyy'];

export function formatDateTick(ms, labelFormat, fixedFormat) {
    const d = new Date(ms);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = MONTH_ABBR[d.getUTCMonth()];
    const monthNum = String(d.getUTCMonth() + 1).padStart(2, '0');
    const year = d.getUTCFullYear();

    if (labelFormat !== 'Fixed Date') return String(year);

    switch (fixedFormat) {
        case 'MMM yyyy': return `${month} ${year}`;
        case 'MM/yyyy': return `${monthNum}/${year}`;
        case 'yyyy': return String(year);
        default: return `${day} ${month} ${year}`;
    }
}

/* ------------------------------------------------------------- tick formatting ---------------- */

const SUPERSCRIPTS = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³',
    '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

function superscript(n) {
    return String(n).split('').map(c => SUPERSCRIPTS[c] || c).join('');
}

function trimNumber(v, places) {
    return String(+v.toFixed(places)).replace(/\.0+$/, '');
}

// The product's default reads as 1.4x10⁴ / 2x10³ with a bare 0, which is what the help
// screenshots show. Abbreviate and Normal are the other two LabelFormat options.
export function formatValue(v, format) {
    if (!Number.isFinite(v)) return '';
    if (v === 0) return '0';

    if (format === 'Normal') {
        return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-GB') : trimNumber(v, 3);
    }

    if (format === 'Abbreviate') {
        const abs = Math.abs(v);
        if (abs >= 1e9) return trimNumber(v / 1e9, 2) + 'B';
        if (abs >= 1e6) return trimNumber(v / 1e6, 2) + 'M';
        if (abs >= 1e3) return trimNumber(v / 1e3, 2) + 'k';
        return trimNumber(v, 3);
    }

    const exponent = Math.floor(Math.log10(Math.abs(v)));
    if (exponent >= -1 && exponent <= 2) return trimNumber(v, 2);
    const mantissa = v / Math.pow(10, exponent);
    return trimNumber(mantissa, 2) + '×10' + superscript(exponent);
}

/* -------------------------------------------------------------------- markers ----------------- */

function polygonPoints(cx, cy, radius, sides, rotation) {
    const pts = [];
    for (let i = 0; i < sides; i++) {
        const a = rotation + (i * 2 * Math.PI) / sides;
        pts.push(`${(cx + radius * Math.sin(a)).toFixed(2)},${(cy - radius * Math.cos(a)).toFixed(2)}`);
    }
    return pts.join(' ');
}

function starPoints(cx, cy, radius, points) {
    const inner = radius * (points === 4 ? 0.38 : 0.45);
    const pts = [];
    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? radius : inner;
        const a = (i * Math.PI) / points;
        pts.push(`${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`);
    }
    return pts.join(' ');
}

function marker(type, cx, cy, size, colour) {
    const r = size / 2;
    const fill = { fill: colour, stroke: 'none' };

    switch (type) {
        case 'Circle': return el('circle', { cx, cy, r, ...fill });
        case 'Square': return el('rect', { x: cx - r, y: cy - r, width: size, height: size, ...fill });
        case 'Triangle': return el('polygon', { points: polygonPoints(cx, cy, r, 3, 0), ...fill });
        case 'Pyramid': return el('polygon', { points: polygonPoints(cx, cy, r, 3, Math.PI), ...fill });
        case 'Diamond': return el('polygon', { points: polygonPoints(cx, cy, r, 4, 0), ...fill });
        case 'Pentagon': return el('polygon', { points: polygonPoints(cx, cy, r, 5, 0), ...fill });
        case 'Hexagon': return el('polygon', { points: polygonPoints(cx, cy, r, 6, 0), ...fill });
        case 'Tetragram': return el('polygon', { points: starPoints(cx, cy, r, 4), ...fill });
        case 'Pentagram': return el('polygon', { points: starPoints(cx, cy, r, 5), ...fill });
        case 'Hexagram': return el('polygon', { points: starPoints(cx, cy, r, 6), ...fill });
        default: return null;
    }
}

/* ------------------------------------------------------------------- titles ------------------- */

// Port of ChartsMVPVM/Factories/AxisTitleFactory.cs: the title is the words common to every
// curve's full name, in the order they appear in the first. With one curve that is simply its
// name, which is why the help screenshot reads "DEFINITIVO WELLS B1 WOPR".
export function commonWords(titles) {
    if (titles.length === 0) return '';
    const sets = titles.slice(1).map(t => new Set(t.split(/\s+/)));
    return titles[0].split(/\s+/).filter(w => sets.every(s => s.has(w))).join(' ');
}

/* -------------------------------------------------------------------- render ------------------ */

// Fixed on both sides regardless of which edge an axis is actually drawn on (Location can put
// either axis on the opposite side) — simpler and more robust than resizing the plot rect
// depending on the current setting, at the cost of some unused whitespace on the inactive side.
const MARGIN = { top: 34, right: 74, bottom: 34, left: 74 };
const LEGEND_ROW = 19;

function project(axis, value, lo, hi) {
    const t = axis.log
        ? (Math.log10(value) - Math.log10(axis.min)) / (Math.log10(axis.max) - Math.log10(axis.min))
        : (value - axis.min) / (axis.max - axis.min);
    const clamped = axis.inverted ? 1 - t : t;
    return lo + clamped * (hi - lo);
}

export function render(root, state) {
    root.textContent = '';

    const width = Math.max(320, root.clientWidth || 640);
    const height = state.height || 420;

    const svg = el('svg', {
        viewBox: `0 0 ${width} ${height}`,
        width: '100%',
        height,
        role: 'img',
        'font-family': 'Segoe UI, system-ui, sans-serif'
    });
    svg.appendChild(el('title', {}, state.title || 'Line chart'));
    svg.appendChild(el('desc', {}, state.description || ''));

    const visible = state.curves.filter(c => c.visible);

    /* window frame and tab header, as the product draws them */
    svg.appendChild(el('rect', {
        x: 0.5, y: 0.5, width: width - 1, height: height - 1, rx: 3,
        fill: 'var(--s3-window-bg, #f4f8fb)', stroke: 'var(--s3-window-border, #ababab)'
    }));
    svg.appendChild(el('rect', {
        x: 4.5, y: 4.5, width: Math.min(220, width - 60), height: 20,
        fill: 'var(--s3-plot-bg, #ffffff)', stroke: 'var(--s3-window-border, #ababab)'
    }));
    svg.appendChild(el('text', {
        x: 12, y: 19, 'font-size': 11.5, fill: 'var(--s3-tab-fg, #2a8dd4)'
    }, state.tabLabel || 'Line Chart'));

    const inner = { x: 8, y: 30, w: width - 16, h: height - 38 };
    svg.appendChild(el('rect', {
        x: inner.x, y: inner.y, width: inner.w, height: inner.h,
        fill: 'var(--s3-plot-bg, #ffffff)', stroke: 'var(--s3-window-border, #ababab)'
    }));

    let cursor = inner.y + 8;

    if (state.title) {
        cursor += 12;
        svg.appendChild(el('text', {
            x: inner.x + inner.w / 2, y: cursor, 'text-anchor': 'middle',
            'font-size': 13.5, fill: 'var(--s3-title-fg, #808080)'
        }, state.title));
        cursor += 10;
    }

    /* legend — a bordered, pale-cream box, stretched across the plot by default */
    const legend = state.legend;
    let legendGroup = null;
    let legendBox = null;
    if (legend.show && visible.length > 0) {
        // Entries are packed left-to-right with a small fixed gap, exactly as the product draws
        // a single-entry legend hugging the left edge of a Stretch box. Horizontal Position
        // ("Stretch"/"Left"/"Right"/"Centre") controls the BOX's width and placement only — it
        // must never spread the entries themselves across the extra space.
        const ENTRY_GAP = 14;
        const INSET = 10;

        const itemWidths = visible.map(c => 30 + c.label.length * 6.4);
        const stretch = legend.horizontal === 'Stretch';
        const available = inner.w - 24;
        const wrapAt = available - INSET * 2;

        // Wrap into lines by accumulating real item widths against the available width, rather
        // than a uniform pitch derived from the widest entry.
        const lines = [[]];
        let lineWidth = 0;
        visible.forEach((curve, i) => {
            if (legend.orientation === 'Vertical' && i > 0) {
                lines.push([]);
                lineWidth = 0;
            } else if (lineWidth > 0 && lineWidth + ENTRY_GAP + itemWidths[i] > wrapAt) {
                lines.push([]);
                lineWidth = 0;
            }
            lines[lines.length - 1].push(i);
            lineWidth += (lineWidth > 0 ? ENTRY_GAP : 0) + itemWidths[i];
        });

        const lineWidths = lines.map(line =>
            line.reduce((sum, i, n) => sum + itemWidths[i] + (n > 0 ? ENTRY_GAP : 0), 0));
        const contentWidth = Math.max(...lineWidths);

        const boxWidth = stretch ? available : Math.min(available, contentWidth + INSET * 2);
        const boxHeight = lines.length * LEGEND_ROW + 6;

        const boxX = stretch || legend.horizontal === 'Left'
            ? inner.x + 12
            : legend.horizontal === 'Right'
                ? inner.x + inner.w - 12 - boxWidth
                : inner.x + (inner.w - boxWidth) / 2;

        // Drawn into a group and positioned once the plot rectangle is known, so that Inside and
        // Bottom placements can be applied without laying the whole chart out twice.
        legendGroup = el('g', {});
        cursor += 6;
        legendGroup.appendChild(el('rect', {
            x: boxX, y: cursor, width: boxWidth, height: boxHeight,
            fill: resolveColour(legend.backgroundColour) || 'var(--s3-legend-bg, #fffbf0)',
            stroke: resolveColour(legend.borderColour) || 'var(--s3-legend-border, #000000)',
            'stroke-width': legend.borderThickness ?? 1
        }));

        lines.forEach((line, row) => {
            let x = boxX + INSET;
            for (const i of line) {
                const curve = visible[i];
                const lx = x;
                const ly = cursor + 3 + row * LEGEND_ROW + LEGEND_ROW / 2;
                const colour = resolveColour(curve.colourIndex) || seriesToken(0);

                if (curve.plotType !== 'Scatter') {
                    legendGroup.appendChild(el('line', {
                        x1: lx, y1: ly, x2: lx + 20, y2: ly,
                        stroke: colour, 'stroke-width': curve.lineWidth,
                        'stroke-dasharray': DASH_ARRAYS[curve.lineStyle]
                    }));
                }
                if (curve.markerType !== 'None' || curve.plotType === 'Scatter') {
                    const markerColour = resolveColour(curve.markerColourIndex) || colour;
                    const m = marker(curve.markerType === 'None' ? 'Circle' : curve.markerType,
                        lx + 10, ly, curve.markerSize, markerColour);
                    if (m) legendGroup.appendChild(m);
                }
                legendGroup.appendChild(el('text', {
                    x: lx + 26, y: ly + 4, 'font-size': 11.5, fill: 'var(--s3-legend-fg, #201f1e)'
                }, curve.label));

                x += itemWidths[i] + ENTRY_GAP;
            }
        });

        svg.appendChild(legendGroup);
        legendBox = {
            x: boxX, y: cursor, width: boxWidth, height: boxHeight,
            outside: legend.inOut !== 'Inside',
            atBottom: legend.vertical === 'Bottom'
        };

        // Only a legend above the plot pushes the plot down; Inside overlays it, and Bottom
        // reserves space at the other end instead.
        if (legendBox.outside && !legendBox.atBottom) cursor += boxHeight;
    }

    /* plot area */
    const plot = {
        left: inner.x + MARGIN.left,
        right: inner.x + inner.w - MARGIN.right,
        top: cursor + MARGIN.top,
        bottom: inner.y + inner.h - MARGIN.bottom
            - (legendBox && legendBox.outside && legendBox.atBottom ? legendBox.height + 8 : 0)
    };
    if (plot.bottom - plot.top < 40 || plot.right - plot.left < 60) {
        root.appendChild(svg);
        return null;
    }

    if (legendBox) {
        let dx = 0;
        let dy = 0;

        if (legendBox.outside && legendBox.atBottom) {
            dy = (inner.y + inner.h - 6 - legendBox.height) - legendBox.y;
        } else if (!legendBox.outside) {
            const target = legend.vertical === 'Bottom'
                ? plot.bottom - legendBox.height - 4
                : legend.vertical === 'Top'
                    ? plot.top + 4
                    : (plot.top + plot.bottom - legendBox.height) / 2;
            dy = target - legendBox.y;
            // Keep an overlaid legend inside the plot rectangle.
            dx = Math.max(plot.left + 4 - legendBox.x,
                Math.min(0, plot.right - 4 - (legendBox.x + legendBox.width)));
        }

        if (dx || dy) {
            legendGroup.setAttribute('transform', `translate(${dx.toFixed(1)} ${dy.toFixed(1)})`);
        }
    }

    const x = state.xAxis;
    const y = state.yAxis;

    const px = v => project(x, v, plot.left, plot.right);
    const py = v => project(y, v, plot.bottom, plot.top);

    const xTicks = x.useDateInterval
        ? explicitDateTicks(x.min, x.max, x.dateInterval || 1, x.dateIntervalUnit || 'Years')
            .map(t => ({ value: t.value, label: formatDateTick(t.value, x.labelFormat, x.fixedDateFormat) }))
        : yearTicks(x.min, x.max, Math.max(3, Math.floor((plot.right - plot.left) / 62)))
            .map(t => ({ value: t.value, label: formatDateTick(t.value, x.labelFormat, x.fixedDateFormat) }));
    const yValues = y.log ? logTicks(y.min, y.max) : linearTicks(y.min, y.max, 6, y.intervalOverride);

    /* gridlines — off unless asked for, matching the product's default */
    if (y.majorGridLines) {
        for (const v of yValues) {
            svg.appendChild(el('line', {
                x1: plot.left, y1: py(v), x2: plot.right, y2: py(v),
                stroke: 'var(--s3-gridline, #dfdfdf)', 'stroke-width': 1
            }));
        }
    }
    if (x.majorGridLines) {
        for (const t of xTicks) {
            svg.appendChild(el('line', {
                x1: px(t.value), y1: plot.top, x2: px(t.value), y2: plot.bottom,
                stroke: 'var(--s3-gridline, #dfdfdf)', 'stroke-width': 1
            }));
        }
    }
    if (y.minorGridLines && !y.log) {
        const step = (y.minorIntervalOverride > 0 ? y.minorIntervalOverride : (yValues[1] - yValues[0]) / 2);
        for (let v = yValues[0] - step; v <= y.max; v += step) {
            if (v < y.min) continue;
            svg.appendChild(el('line', {
                x1: plot.left, y1: py(v), x2: plot.right, y2: py(v),
                stroke: 'var(--s3-gridline, #dfdfdf)', 'stroke-width': 0.5
            }));
        }
    }

    /* axes: Location decides which edge each axis actually draws on. The plot rectangle itself
       never moves — only which side gets the line, ticks and labels. */
    const yOnRight = y.location === 'Right';
    const xOnTop = x.location === 'Top';

    const yAxisX = yOnRight ? plot.right : plot.left;
    const xAxisY = xOnTop ? plot.top : plot.bottom;

    const yLineColour = resolveColour(y.lineColour) || 'var(--s3-axis-line, #808080)';
    const xLineColour = resolveColour(x.lineColour) || 'var(--s3-axis-line, #808080)';
    const yLineWidth = y.lineThickness || 1;
    const xLineWidth = x.lineThickness || 1;

    svg.appendChild(el('line', {
        x1: yAxisX, y1: plot.top, x2: yAxisX, y2: plot.bottom,
        stroke: yLineColour, 'stroke-width': yLineWidth
    }));
    svg.appendChild(el('line', {
        x1: plot.left, y1: xAxisY, x2: plot.right, y2: xAxisY,
        stroke: xLineColour, 'stroke-width': xLineWidth
    }));

    // "Outside" points ticks/labels away from the plot; "Inside" points them into it. The sign
    // is which way the tick actually points; the label sits a little further along the same line.
    const yOutward = yOnRight ? 1 : -1;
    const ySign = y.labelLocation === 'Inside' ? -yOutward : yOutward;
    const xOutward = xOnTop ? -1 : 1;
    const xSign = x.labelLocation === 'Inside' ? -xOutward : xOutward;

    const yLabelsVisible = y.labelsVisible !== false;
    const xLabelsVisible = x.labelsVisible !== false;
    const yAngle = y.labelAngle || 0;
    const xAngle = x.labelAngle || 0;

    for (const v of yValues) {
        const yy = py(v);
        svg.appendChild(el('line', {
            x1: yAxisX, y1: yy, x2: yAxisX + ySign * 4, y2: yy,
            stroke: yLineColour, 'stroke-width': yLineWidth
        }));
        if (!yLabelsVisible) continue;
        const lx = yAxisX + ySign * 7;
        const ly = yy + 4;
        svg.appendChild(el('text', {
            x: lx, y: ly, 'text-anchor': ySign > 0 ? 'start' : 'end',
            'font-size': 11, fill: 'var(--s3-tick-fg, #808080)',
            transform: yAngle ? `rotate(${-yAngle} ${lx} ${ly})` : null
        }, formatValue(v, y.labelFormat)));
    }

    for (const t of xTicks) {
        const xx = px(t.value);
        svg.appendChild(el('line', {
            x1: xx, y1: xAxisY, x2: xx, y2: xAxisY + xSign * 4,
            stroke: xLineColour, 'stroke-width': xLineWidth
        }));
        if (!xLabelsVisible) continue;
        const lx = xx;
        const ly = xAxisY + xSign * 17;
        svg.appendChild(el('text', {
            x: lx, y: ly, 'text-anchor': 'middle',
            'font-size': 11, fill: 'var(--s3-tick-fg, #808080)',
            transform: xAngle ? `rotate(${-xAngle} ${lx} ${ly})` : null
        }, t.label));
    }

    if (y.title) {
        const titleX = yOnRight ? (inner.x + inner.w - 16) : (inner.x + 16);
        const cy = (plot.top + plot.bottom) / 2;
        svg.appendChild(el('text', {
            x: titleX, y: cy, 'text-anchor': 'middle', 'font-size': 12,
            fill: 'var(--s3-axis-title-fg, #808080)',
            transform: `rotate(-90 ${titleX} ${cy})`
        }, y.title));
    }

    if (x.title) {
        const titleY = xOnTop ? (inner.y + 20) : (inner.y + inner.h - 6);
        svg.appendChild(el('text', {
            x: (plot.left + plot.right) / 2, y: titleY, 'text-anchor': 'middle',
            'font-size': 12, fill: 'var(--s3-axis-title-fg, #808080)'
        }, x.title));
    }

    /* series */
    const clip = 's3clip-' + Math.abs(Math.round(plot.left * 31 + plot.top * 7 + width));
    const defs = el('defs', {});
    const clipPath = el('clipPath', { id: clip });
    clipPath.appendChild(el('rect', {
        x: plot.left, y: plot.top - 2,
        width: plot.right - plot.left, height: plot.bottom - plot.top + 2
    }));
    defs.appendChild(clipPath);
    svg.appendChild(defs);

    const layer = el('g', { 'clip-path': `url(#${clip})` });
    const hits = [];

    for (const curve of visible) {
        const colour = resolveColour(curve.colourIndex) || seriesToken(0);
        const points = [];

        for (let i = 0; i < curve.values.length; i++) {
            const v = curve.values[i];
            const t = curve.times[i];
            // A log axis drops non-positive points rather than clamping them, as the product does.
            // Observed vectors carry deliberate gaps. Either way the line must break, and no
            // non-finite value may reach a path: one blanks the whole path silently.
            if (!Number.isFinite(v) || t < x.min || t > x.max || (y.log && v <= 0)) {
                points.push(null);
                continue;
            }
            const px_ = px(t), py_ = py(v);
            points.push([px_, py_]);
            hits.push({ x: px_, y: py_, time: t, value: v, curve, colour });
        }

        if (curve.plotType !== 'Scatter') {
            let d = '';
            let pen = false;
            for (const p of points) {
                if (!p) { pen = false; continue; }
                d += (pen ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
                pen = true;
            }
            if (d) {
                layer.appendChild(el('path', {
                    d, fill: 'none', stroke: colour,
                    'stroke-width': curve.lineWidth,
                    'stroke-dasharray': DASH_ARRAYS[curve.lineStyle],
                    'stroke-linejoin': 'round', 'stroke-linecap': 'round'
                }));
            }
        }

        const showMarkers = curve.plotType === 'Scatter' || curve.markerType !== 'None';
        if (showMarkers) {
            // Marker colour is a separate setting in the product; unset follows the line colour.
            const markerColour = resolveColour(curve.markerColourIndex) || colour;
            const shape = curve.markerType === 'None' ? 'Circle' : curve.markerType;
            // Thin out markers on dense series so they stay readable, as the product does when a
            // series has far more points than pixels.
            const stride = Math.max(1, Math.round(points.length / ((plot.right - plot.left) / 6)));
            for (let i = 0; i < points.length; i += stride) {
                if (!points[i]) continue;
                const m = marker(shape, points[i][0], points[i][1], curve.markerSize, markerColour);
                if (m) layer.appendChild(m);
            }
        }
    }

    svg.appendChild(layer);
    root.appendChild(svg);

    return { svg, plot, xAxis: x, yAxis: y, px, py, hits };
}

/* --------------------------------------------------------------------- tooltip ----------------- */

// The product's own hover tooltip: a bordered box naming the vector, then Date/Time/Value rows
// (a plain property/value box for a non-time X axis, e.g. a scatter plot — out of scope here,
// this demo family is time-series only), a small marker on the hovered point and a thin leader
// line to the box. Re-attached fresh on every render() call, since the SVG itself is rebuilt from
// scratch each time — nothing here needs to survive across renders.
export function attachTooltip(handle, state) {
    if (!state.showTooltip || handle.hits.length === 0) return;

    const svg = handle.svg;
    const tip = el('g', { display: 'none' });
    svg.appendChild(tip);

    const HIT_RADIUS = 16;

    function nearest(mx, my) {
        let best = null, bestDist = Infinity;
        for (const hit of handle.hits) {
            const dx = hit.x - mx, dy = hit.y - my;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) { bestDist = dist; best = hit; }
        }
        return bestDist <= HIT_RADIUS * HIT_RADIUS ? best : null;
    }

    function toSvgPoint(event) {
        const rect = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        return {
            x: (event.clientX - rect.left) * (vb.width / rect.width),
            y: (event.clientY - rect.top) * (vb.height / rect.height)
        };
    }

    function showAt(hit) {
        tip.textContent = '';
        tip.setAttribute('display', 'inline');

        tip.appendChild(el('circle', {
            cx: hit.x, cy: hit.y, r: 3.5, fill: hit.colour, stroke: '#ffffff', 'stroke-width': 1
        }));

        const days = (hit.time - state.dataMin) / 86400000;
        const d = new Date(hit.time);
        const dateLabel = `${String(d.getUTCDate()).padStart(2, '0')}/`
            + `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
        const valueLabel = Number.isFinite(hit.value)
            ? hit.value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : '';
        const timeLabel = days.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const rows = [['Date', dateLabel], ['Time', timeLabel], [hit.curve.label, valueLabel]];
        const rowHeight = 15;
        const padX = 8, padTop = 20, labelColWidth = 44;
        const textWidth = Math.max(...rows.map(([l, v]) => l.length * 6.2 + v.length * 6.2)) + labelColWidth;
        const boxWidth = Math.max(120, padX * 2 + textWidth);
        const boxHeight = padTop + rows.length * rowHeight + 6;

        // Flip to the left of the point once there is no room to the right, same idea as the
        // product keeping the box on-screen near a point close to the plot's right edge.
        const preferLeft = hit.x + 14 + boxWidth > handle.plot.right;
        const boxX = preferLeft ? hit.x - 14 - boxWidth : hit.x + 14;
        const boxY = Math.max(handle.plot.top, Math.min(hit.y - boxHeight / 2, handle.plot.bottom - boxHeight));

        tip.appendChild(el('line', {
            x1: hit.x, y1: hit.y, x2: preferLeft ? boxX + boxWidth : boxX, y2: boxY + 10,
            stroke: '#9a9a9a', 'stroke-width': 1
        }));
        tip.appendChild(el('rect', {
            x: boxX, y: boxY, width: boxWidth, height: boxHeight, rx: 2,
            fill: 'var(--s3-plot-bg, #ffffff)', stroke: 'var(--s3-window-border, #9a9a9a)'
        }));
        tip.appendChild(el('text', {
            x: boxX + padX, y: boxY + 14, 'font-size': 11.5, 'font-weight': 700,
            fill: 'var(--s3-legend-fg, #201f1e)'
        }, hit.curve.label));

        rows.forEach(([label, value], i) => {
            const rowY = boxY + padTop + i * rowHeight + 10;
            tip.appendChild(el('text', {
                x: boxX + padX, y: rowY, 'font-size': 11, fill: 'var(--s3-tick-fg, #808080)'
            }, label));
            tip.appendChild(el('text', {
                x: boxX + boxWidth - padX, y: rowY, 'text-anchor': 'end',
                'font-size': 11, fill: 'var(--s3-legend-fg, #201f1e)'
            }, value));
        });
    }

    svg.addEventListener('mousemove', event => {
        const p = toSvgPoint(event);
        if (p.x < handle.plot.left || p.x > handle.plot.right || p.y < handle.plot.top || p.y > handle.plot.bottom) {
            tip.setAttribute('display', 'none');
            return;
        }
        const hit = nearest(p.x, p.y);
        if (hit) showAt(hit); else tip.setAttribute('display', 'none');
    });
    svg.addEventListener('mouseleave', () => tip.setAttribute('display', 'none'));
}
