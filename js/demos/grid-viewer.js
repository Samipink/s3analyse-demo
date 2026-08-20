// The 3D grid viewer demo: the synthetic grid, coloured by a selected property, reproduced as an
// S3analyse-style 3D view — not the ribbon or project tree around it, per Samantha's direction
// after reviewing the first draft. The fidelity target is the VIEWPORT itself (surface, legend,
// axis frame, caption, black background), the same way chart.js is the fidelity target for the line
// plot; the settings live in a plain "Cell Lines" emulator page beside it, matching the real
// Grid Editors dialog measured from wwwroot/img/help/grid-settings-standard.png.
//
// See docs/ADR-002-interactive-demos.md and the 3D-grid-viewer plan for why this is a genuinely
// new decision rather than a continuation of the line-plot work: a 3D OpenGL render cannot be
// reproduced pixel-identically in WebGL the way a 2D SVG chart can be. Three.js is used rather than
// raw WebGL so the effort goes into the controls, not into reimplementing camera/lighting plumbing
// Three.js already gets right — see the ADR for the full trade-off.

import { loadModel } from './model.js';
// "three" and "three/addons/" are resolved by the import map in Components/App.razor, pinned to
// one version there — not "latest", so a registry update can never silently change this demo.
// OrbitControls itself imports "three" as a bare specifier, which only resolves via that map.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Source/Utility/ColourChart.cs verbatim — duplicated from line-plot.js's own copy rather than
// imported, since the two demos are independent modules and this is a handful of literals, not a
// shared behaviour worth a module boundary yet (see the ADR's "extract from the second real demo,
// not a guess" rule — a colour-picker *engine* would qualify; a constant array does not).
const PALETTE_HEX = ['#000000', '#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#00ffff',
    '#800000', '#008000', '#000080', '#800080', '#008080', '#808080'];

// '<None>' matches the product's own sentinel for "no vector loaded" in the Property dropdown —
// see the correction below on what that means for cell colouring.
const NONE_PROPERTY = '<None>';
const PROPERTIES = [NONE_PROPERTY, 'PRESSURE', 'SWAT', 'SOIL'];

// The structural relief in the deck (a ~30m dome over a ~2300m x 1600m footprint) is real but,
// at true 1:1 scale, about 1% of the horizontal extent — genuinely invisible from any normal
// viewing angle, the same reason real reservoir viewers apply vertical exaggeration by default
// rather than showing true scale (this site's own "Grid visualisation" copy lists it as a
// feature). Fixed for now, not yet a user control — see the Phase 2 backlog. Tick labels on the
// depth axis still report the TRUE metre value (see worldYToTrueDepth), not the exaggerated one —
// only the geometry is stretched, never the numbers.
//
// Deliberately 6, not 8: measured empirically (rendering the scene and reading back actual pixels
// under the axis labels across a wide sweep of camera angles) that at 8x the grid becomes tall
// enough, relative to its own footprint, that no offset margin on the axis rulers (see
// buildAxisFrame) can clear it from a normal viewing angle — the ruler ends up visually "behind"
// the bulk of the exaggerated grid instead of clearly below/outside it. 6x keeps the relief
// clearly visible while leaving the rulers room to actually clear.
const VERTICAL_EXAGGERATION = 6;

function trueDepthToWorldY(trueDepth) { return -trueDepth * VERTICAL_EXAGGERATION; }
function worldYToTrueDepth(y) { return -y / VERTICAL_EXAGGERATION; }

// Rendering-only: each layer drawn at half its real thickness. Deliberately NOT a change to
// model.js's dzByLayer, which also drives pore volume / STOIIP for the line-plot demo's physics —
// this constant only affects the geometry built here, so the two demos can never disagree about
// what the model actually contains, only about how tall this one draws it.
const CELL_HEIGHT_SCALE = 0.5;

// Also rendering-only, for the same reason: trims a few cells off the OUTER rim so the block reads
// as a rounded, slightly irregular reservoir body rather than a crisp rectangular prism, without
// touching grid.active (which well completions and pore volume depend on) at all. A superellipse
// (exponent < the rectangle's implicit infinity) rounds the corners. Deliberately asymmetric, not
// a uniform rounded rectangle (Samantha: "a bit squarer at the back so it doesn't look as
// symmetrical") — the exponent rises with j, so the front (low j) rounds off gently while the
// back (high j) stays close to a hard rectangle.
function withinVisualFootprint(i, j, ni, nj) {
    const x = ((i + 0.5) / ni) * 2 - 1;
    const y = ((j + 0.5) / nj) * 2 - 1;
    const t = (j + 0.5) / nj;
    const p = 3.0 + t * 5.0;
    return Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p) <= 1;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function formatCaptionDate(ms) {
    const d = new Date(ms);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

// Matches S3analyse's "Default" grid colour scheme, derived directly from the reference
// screenshot's legend ticks (400 bara = blue at the top, down through cyan/green/yellow/red to
// 300 bara = magenta at the bottom) rather than eyeballed — the same sampled-from-evidence approach
// used for the line chart's palette and window chrome. t = 1 at the maximum value, 0 at the minimum.
function schemeHue(t) {
    const clamped = Math.min(1, Math.max(0, t));
    // hue(1) = 240 (blue), falling through cyan/green/yellow/red as t drops, down to hue(0) = 300
    // (magenta) — verified against all six legend ticks, not just the two endpoints. An earlier
    // version added where this subtracts, which happened to match at t=1 but sent every other
    // value the wrong way round the wheel (magenta appeared right after blue instead of last).
    return (((300 * clamped - 60) % 360 + 360) % 360) / 360;
}

function cellActive(grid, i, j, k) {
    if (i < 0 || i >= grid.ni || j < 0 || j >= grid.nj || k < 0 || k >= grid.nk) return false;
    return grid.active[grid.index(i, j, k)] === 1;
}

function cellInactive(grid, i, j, k) {
    if (i < 0 || i >= grid.ni || j < 0 || j >= grid.nj || k < 0 || k >= grid.nk) return false;
    return grid.active[grid.index(i, j, k)] === 0;
}

// Height at a grid NODE (corner), not a cell — shared by buildHull (the rendered surface) and the
// cell-selection highlight box, so the highlight can never sit a hair off the mesh it's outlining.
// layerTop/dzByLayer here are the RENDERING (CELL_HEIGHT_SCALE-scaled) versions from
// computeExtents, not grid's own real-thickness ones. See buildHull's header comment for why node
// (not per-cell) heights matter at all.
function nodeWorldY(topDepthOffsetNodes, ni, layerTop, dzByLayer, nodeI, nodeJ, k, bottom) {
    return trueDepthToWorldY(
        layerTop[k] + (bottom ? dzByLayer[k] : 0) + topDepthOffsetNodes[nodeJ * (ni + 1) + nodeI]
    );
}

// Builds the visible "hull" of a set of cells (active, or inactive) as a set of quads — one per
// face that borders an empty/absent/other-kind neighbour, exactly the voxel-mesher technique the
// earlier web search turned up (the Three.js "voxel geometry" lesson). Internal faces between two
// occupied neighbours are never emitted, which is both the cheap approach and the correct one: the
// product does not draw hidden internal cell faces either.
function buildHull(THREE, grid, layerTop, dzByLayer, dx, dy, occupied, colourAt) {
    const positions = [];
    const colours = [];
    const linePositions = [];
    // One entry per emitted TRIANGLE (not per quad — a quad is 2 triangles), so a raycast hit's
    // faceIndex (three.js counts non-indexed triangles, not quads) maps straight to a flat cell
    // index without any further arithmetic. Read on the CPU side only, after a raycast hit — never
    // uploaded as a GPU attribute.
    const cellIndexPerFace = [];
    const colourObj = new THREE.Color();
    const { ni, nj, topDepthOffsetNodes } = grid;

    // Height at a grid NODE (corner), not a cell — this is the fix for cells rendering as visibly
    // disjointed. A per-cell offset lets two neighbouring cells disagree about the height of the
    // corner they're meant to share; every corner here comes from the one shared node value, so
    // two cells that share an edge always compute IDENTICAL coordinates for it, whether that edge
    // is a top face, a side wall, or a bottom face.
    const nodeY = (nodeI, nodeJ, k, bottom) =>
        nodeWorldY(topDepthOffsetNodes, ni, layerTop, dzByLayer, nodeI, nodeJ, k, bottom);

    const emitQuad = (p0, p1, p2, p3, rgb, idx) => {
        positions.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
        for (let n = 0; n < 6; n++) colours.push(rgb[0], rgb[1], rgb[2]);
        cellIndexPerFace.push(idx, idx);
        linePositions.push(...p0, ...p1, ...p1, ...p2, ...p2, ...p3, ...p3, ...p0);
    };

    for (let k = 0; k < grid.nk; k++) {
        for (let j = 0; j < nj; j++) {
            const z0 = j * dy, z1 = (j + 1) * dy;
            for (let i = 0; i < ni; i++) {
                if (!occupied(i, j, k)) continue;
                const idx = grid.index(i, j, k);
                const rgb = colourAt(idx, colourObj);
                const x0 = i * dx, x1 = (i + 1) * dx;

                if (!occupied(i + 1, j, k)) emitQuad(
                    [x1, nodeY(i + 1, j,     k, false), z0], [x1, nodeY(i + 1, j,     k, true), z0],
                    [x1, nodeY(i + 1, j + 1, k, true), z1],  [x1, nodeY(i + 1, j + 1, k, false), z1], rgb, idx);
                if (!occupied(i - 1, j, k)) emitQuad(
                    [x0, nodeY(i, j + 1, k, false), z1], [x0, nodeY(i, j + 1, k, true), z1],
                    [x0, nodeY(i, j,     k, true), z0],  [x0, nodeY(i, j,     k, false), z0], rgb, idx);
                if (!occupied(i, j + 1, k)) emitQuad(
                    [x1, nodeY(i + 1, j + 1, k, false), z1], [x1, nodeY(i + 1, j + 1, k, true), z1],
                    [x0, nodeY(i,     j + 1, k, true), z1],  [x0, nodeY(i,     j + 1, k, false), z1], rgb, idx);
                if (!occupied(i, j - 1, k)) emitQuad(
                    [x0, nodeY(i,     j, k, false), z0], [x0, nodeY(i,     j, k, true), z0],
                    [x1, nodeY(i + 1, j, k, true), z0],  [x1, nodeY(i + 1, j, k, false), z0], rgb, idx);
                if (!occupied(i, j, k - 1)) emitQuad(
                    [x0, nodeY(i,     j,     k, false), z0], [x1, nodeY(i + 1, j,     k, false), z0],
                    [x1, nodeY(i + 1, j + 1, k, false), z1], [x0, nodeY(i,     j + 1, k, false), z1], rgb, idx);
                if (!occupied(i, j, k + 1)) emitQuad(
                    [x0, nodeY(i,     j + 1, k, true), z1], [x1, nodeY(i + 1, j + 1, k, true), z1],
                    [x1, nodeY(i + 1, j,     k, true), z0], [x0, nodeY(i,     j,     k, true), z0], rgb, idx);
            }
        }
    }

    return { positions, colours, linePositions, cellIndexPerFace };
}

// Single source of truth for the grid's world-space extent, used by the mesh builder, the camera
// framing and the axis frame alike — computed once so the three can never quietly disagree.
function computeExtents(grid) {
    const { dx, dy, topDepth, ni, nj, topDepthOffsetNodes } = grid;
    // Rendering-only scale (see CELL_HEIGHT_SCALE) — model.grid.dzByLayer itself, which pore
    // volume / STOIIP depend on, is never touched.
    const dzByLayer = grid.dzByLayer.map(d => d * CELL_HEIGHT_SCALE);
    const layerTop = [];
    let z = topDepth;
    for (let k = 0; k < grid.nk; k++) { layerTop.push(z); z += dzByLayer[k]; }
    const thickness = z - topDepth;

    const width = ni * dx, depth = nj * dy;
    // World Y is -depth (see buildHull), so shallower is numerically larger (less negative) —
    // yTop0/yBotN must be the shallowest/deepest point over the WHOLE structural surface (every
    // node's own offset), or the camera/axis frame get placed to fit a flat slab while the actual
    // (domed) mesh pokes out above or below the frame. Nodes, not cells, since the rendered
    // geometry's corners come from the node array (see buildHull).
    let yTop0 = -Infinity, yBotN = Infinity;
    for (let idx = 0; idx < (ni + 1) * (nj + 1); idx++) {
        const offset = topDepthOffsetNodes[idx];
        const top = trueDepthToWorldY(topDepth + offset);
        const bot = trueDepthToWorldY(topDepth + thickness + offset);
        if (top > yTop0) yTop0 = top;
        if (bot < yBotN) yBotN = bot;
    }
    const height = yTop0 - yBotN;

    return { layerTop, dzByLayer, width, depth, height, yTop0, yBotN };
}

function buildMeshes(THREE, model, state, extents) {
    const grid = model.grid;
    const { dx, dy } = grid;
    const { layerTop, dzByLayer } = extents;

    const group = new THREE.Group();
    const noProperty = state.property === NONE_PROPERTY;

    // Wireframe traces whichever category is actually visible via its OWN checkbox — not a fixed
    // "always the active hull" overlay. Samantha: with Active unticked and Inactive ticked, ticking
    // Wireframe must trace the inactive cells that are actually on screen, not the (invisible)
    // active ones. So each category's hull is built whenever ITS OWN faces or wireframe are wanted,
    // and each gets wireframe in the one shared `wireframeColour`, not a per-category derived tint.
    const addCategory = (occupied, flatColour, showFacesFor, showWireframeFor, propertyColoured, category) => {
        if (!showFacesFor && !showWireframeFor) return;

        let colourAt;
        if (propertyColoured && !noProperty) {
            const property = model.gridProperty(state.property, state.stepIndex);
            const { min, max } = property.range;
            const span = max - min || 1;
            colourAt = (idx, colourObj) => {
                const t = (property.values[idx] - min) / span;
                colourObj.setHSL(schemeHue(t), 1, 0.5);
                return [colourObj.r, colourObj.g, colourObj.b];
            };
        } else {
            const flat = new THREE.Color(flatColour);
            const rgb = [flat.r, flat.g, flat.b];
            colourAt = () => rgb;
        }

        const hull = buildHull(THREE, grid, layerTop, dzByLayer, dx, dy, occupied, colourAt);
        if (!hull.positions.length) return;

        // Unlit on purpose: this surface's colour IS the data (or the flat display colour), read
        // against the legend, so it must never be shaded or darkened by viewing angle — a
        // Lambertian fill looked "disconnected from the legend" because the same value rendered a
        // different colour on a shadowed side face than on a lit top face. The faceted 3D read
        // comes through via the wireframe overlay, not lighting.
        if (showFacesFor) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(hull.positions, 3));
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(hull.colours, 3));
            const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
            const mesh = new THREE.Mesh(geometry, material);
            // Read by pickCell() after a raycast hit — never uploaded to the GPU, just carried
            // alongside the mesh so a faceIndex can be turned back into (i, j, k) and a category.
            mesh.userData.cellIndexPerFace = hull.cellIndexPerFace;
            mesh.userData.category = category;
            group.add(mesh);
        }

        if (showWireframeFor) {
            const wireGeometry = new THREE.BufferGeometry();
            wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(hull.linePositions, 3));
            const wireMaterial = new THREE.LineBasicMaterial({ color: state.wireframeColour });
            group.add(new THREE.LineSegments(wireGeometry, wireMaterial));
        }
    };

    // Corrected per Samantha: "Show Active Cells" / "Show Inactive Cells" colours are the
    // product's FLAT display colours for when no vector is loaded (Property is <None>) — not edge
    // tints. Property-driven per-cell colouring applies only to active cells, and only once a real
    // vector is selected; inactive cells never carry property data, so they're always flat.
    // withinVisualFootprint trims the outer rim purely for this rendering — grid.active (and
    // therefore well completions and pore volume) is untouched, so this can never disagree with
    // what the line-plot demo's physics thinks the model contains.
    addCategory((i, j, k) => cellActive(grid, i, j, k) && withinVisualFootprint(i, j, grid.ni, grid.nj),
        state.activeColour, state.showFaces && state.showActive, state.showWireframe && state.showActive, true,
        'active');
    // The SAME footprint trim must apply here too — Samantha's report ("inactive cells are
    // disjointed from the grid") was because it didn't: trimming active cells near a corner while
    // leaving an inactive cluster at that same corner untrimmed orphaned it, with none of its
    // former active neighbours left to visually connect to.
    addCategory((i, j, k) => cellInactive(grid, i, j, k) && withinVisualFootprint(i, j, grid.ni, grid.nj),
        state.inactiveColour, state.showFaces && state.showInactive, state.showWireframe && state.showInactive, false,
        'inactive');

    return group;
}

// Three free-standing, tick-labelled axis rulers, offset clear of the grid rather than a box
// wrapping it — matching wwwroot/img/help/grid-settings-standard.png, where none of the three axis
// lines actually touch the coloured surface (Samantha's correction after the first draft drew a
// box sitting flush against the mesh) — and meeting at one shared corner, the way a matplotlib- or
// CAD-style 3D axis box does (Samantha's correction after the second draft drew three independent,
// unconnected lines).
//
// The corner they share is chosen EVERY FRAME from the camera's current position: of the box's
// four horizontal corners and two vertical sides, whichever is NEAREST the camera is picked — the
// side facing the viewer, matching how the real product behaves (Samantha: rotate right and the
// far-side ruler swaps to the left "so it is in view", not the reverse; a "far tent apex" attempt
// tried next disjointed the geometry and read worse). Geometry is small (a handful of line
// segments), so it's simplest to just recompute all of it on every corner change rather than track
// deltas.
function buildAxisFrame(THREE, extents) {
    const { width, depth, height, yTop0, yBotN } = extents;
    const centre = new THREE.Vector3(width / 2, (yTop0 + yBotN) / 2, depth / 2);
    const material = new THREE.LineBasicMaterial({ color: 0xcfcfcf });
    const group = new THREE.Group();

    // 0.3, not 0.12: measured empirically (rendering and reading back actual pixels at the tick
    // positions across a wide sweep of camera angles). At 0.12 the rulers landed on mesh pixels at
    // nearly every realistic viewing angle, including the demo's own default camera position — a
    // small margin doesn't buy much screen-space clearance once perspective is involved. Once the
    // corner-selection logic settled (near-side rulers, depth ruler joined to a ruler's far end
    // rather than the shared corner) the hidden-label rate dropped to ~3% even at 0.3, and stayed
    // at ~1.5-3% all the way down through 0.18 to 0.1 — brought in twice since, each time on
    // request, each time re-measured rather than assumed safe.
    const offset = Math.max(width, depth) * 0.1;
    const tickLen = offset * 0.22;
    const fracs = [0.25, 0.5, 0.75];

    // The rulers sit on an outset footprint (padded beyond the grid's own footprint by `offset`
    // on every side), not the grid's true footprint — this is what keeps them clear of the mesh
    // while still letting all three meet at one of the outset box's own corners.
    const xMin = -offset, xMax = width + offset;
    const zMin = -offset, zMax = depth + offset;

    // One LineSegments per ruler (2 vertices) plus 3 tick hash-marks per ruler (2 vertices each) —
    // fixed vertex counts regardless of which corner is current, so positions can be overwritten
    // in place on a corner change rather than disposing/recreating geometry.
    const makeLine = () => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.LineSegments(geometry, material);
        group.add(line);
        return line;
    };

    const xRuler = makeLine(), zRuler = makeLine(), yRuler = makeLine();
    const xTicks = fracs.map(makeLine), zTicks = fracs.map(makeLine), yTicks = fracs.map(makeLine);

    const setLine = (line, from, to) => {
        const arr = line.geometry.attributes.position.array;
        arr[0] = from.x; arr[1] = from.y; arr[2] = from.z;
        arr[3] = to.x; arr[4] = to.y; arr[5] = to.z;
        line.geometry.attributes.position.needsUpdate = true;
    };

    // 3 fracs x 3 axes (X, Z, depth) — flat, indexed as n*3 / n*3+1 / n*3+2 in layout() below.
    const ticks = [];
    for (let n = 0; n < fracs.length * 3; n++) ticks.push({ text: '' });

    let lastKey = null;

    // Called once per frame (see mount()'s render loop). Cheap early-exit when the camera hasn't
    // crossed into a different octant since the last call. Picks the corner NEAREST the camera —
    // see the correction in this function's header comment. The vertical (top/bottom) choice is
    // deliberately the OPPOSITE of the naive "same side as camera" rule used for X/Z: Samantha's
    // correction after seeing it — "when you have the x-axis at the top it should be at the
    // bottom and vice versa" — so nearY picks the far vertical side while nearX/nearZ pick the
    // near horizontal ones.
    const layout = (camera) => {
        const nearX = camera.position.x > centre.x ? xMax : xMin;
        const nearZ = camera.position.z > centre.z ? zMax : zMin;
        const nearY = camera.position.y > centre.y ? yBotN : yTop0;

        // The depth ruler stays JOINED to one of the two horizontal rulers — it just doesn't have
        // to sit at the corner where X and Z meet each other; it can attach at the FAR end of
        // whichever one instead (Samantha, after the real S3analyse screenshots: "it can flip to
        // the left or right, still joined... it does not need to be where those 2 axes join").
        // Picked by which horizontal direction the camera is more side-on to: attach along the X
        // ruler's far end when the camera sits more off to the side in Z, and vice versa — this is
        // also what makes it flip left/right as the camera orbits past the diagonal.
        const otherX = nearX === xMax ? xMin : xMax;
        const otherZ = nearZ === zMax ? zMin : zMax;
        const alongX = Math.abs(camera.position.z - centre.z) > Math.abs(camera.position.x - centre.x);
        const depthX = alongX ? otherX : nearX;
        const depthZ = alongX ? nearZ : otherZ;

        const key = `${nearX}|${nearY}|${nearZ}|${depthX}|${depthZ}`;
        if (key === lastKey) return;
        lastKey = key;

        const yTickDir = nearY === yBotN ? -1 : 1;
        // Outward direction for the depth ruler's own ticks — diagonally away from the grid
        // centre from wherever its attachment point actually ended up.
        const outDir = new THREE.Vector3(depthX < centre.x ? -1 : 1, 0, depthZ < centre.z ? -1 : 1).normalize();

        setLine(xRuler, new THREE.Vector3(xMin, nearY, nearZ), new THREE.Vector3(xMax, nearY, nearZ));
        setLine(zRuler, new THREE.Vector3(nearX, nearY, zMin), new THREE.Vector3(nearX, nearY, zMax));
        setLine(yRuler, new THREE.Vector3(depthX, yBotN, depthZ), new THREE.Vector3(depthX, yTop0, depthZ));

        fracs.forEach((f, n) => {
            const xBase = new THREE.Vector3(xMin + f * (xMax - xMin), nearY, nearZ);
            setLine(xTicks[n], xBase, xBase.clone().addScaledVector(new THREE.Vector3(0, yTickDir, 0), tickLen));
            ticks[n * 3].pos = xBase.clone().addScaledVector(new THREE.Vector3(0, yTickDir, 0), tickLen * 1.8);
            ticks[n * 3].text = (f * width).toFixed(0);

            const zBase = new THREE.Vector3(nearX, nearY, zMin + f * (zMax - zMin));
            setLine(zTicks[n], zBase, zBase.clone().addScaledVector(new THREE.Vector3(0, yTickDir, 0), tickLen));
            ticks[n * 3 + 1].pos = zBase.clone().addScaledVector(new THREE.Vector3(0, yTickDir, 0), tickLen * 1.8);
            ticks[n * 3 + 1].text = (f * depth).toFixed(0);

            const yValue = yBotN + f * (yTop0 - yBotN);
            const yBase = new THREE.Vector3(depthX, yValue, depthZ);
            setLine(yTicks[n], yBase, yBase.clone().addScaledVector(outDir, tickLen));
            ticks[n * 3 + 2].pos = yBase.clone().addScaledVector(outDir, tickLen * 1.8);
            // yBotN/yTop0 are already vertically exaggerated (see VERTICAL_EXAGGERATION) — the
            // label must report the true metre value, not the stretched coordinate.
            ticks[n * 3 + 2].text = worldYToTrueDepth(yValue).toFixed(0);
        });
    };

    // The camera needs to fit the whole RULER frame, not just the grid — and since each ruler now
    // spans the full width/depth/height from a corner NEAR the camera (see layout()'s header
    // comment on why near, not far), its far end reaches further from centre than the grid's own
    // bounding radius accounts for. Half(width)+offset, half(depth)+offset and half(height) is
    // each ruler's actual worst-case reach from centre; hypot of those, not of the grid's raw
    // dimensions, is what the camera distance must clear. Using the grid-only radius left most
    // tick marks projecting outside the frustum entirely — confirmed by reading back their actual
    // screen coordinates, not just eyeballing a screenshot.
    const frameRadius = Math.hypot(width / 2 + offset, depth / 2 + offset, height / 2);

    return {
        group, ticks, layout,
        bounds: { center: centre, radius: frameRadius }
    };
}

// The white outline drawn around whichever cell the tooltip is currently reporting on (hovered or
// pinned — see mount()'s pointer handling). A single fixed-size LineSegments (12 edges = 24
// vertices), built once and repositioned in place via setCell(), exactly like buildAxisFrame's
// ruler lines above — never disposed/rebuilt on selection change. Uses nodeWorldY, the SAME
// corner-height formula buildHull uses for the mesh itself, so this can never sit a hair off the
// surface it's meant to be outlining.
function buildCellHighlight(THREE, grid, extents) {
    const { layerTop, dzByLayer } = extents;
    const { ni, topDepthOffsetNodes } = grid;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24 * 3), 3));
    // depthTest off + a high renderOrder: this box's edges sit at EXACTLY the same coordinates as
    // the cell's own mesh faces (both come from nodeWorldY), which is a guaranteed depth-buffer
    // tie — normal depth testing left the highlighted mesh face winning that tie every time and
    // painting over the white line, so the highlight never actually appeared despite being drawn.
    // Always-on-top is the deliberate trade-off (the same one most 3D selection-highlight
    // implementations make): the far side of the box can now show faintly through other geometry,
    // but that beats a "highlight" that's invisible 100% of the time.
    const material = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
    const line = new THREE.LineSegments(geometry, material);
    line.renderOrder = 999;
    line.visible = false;

    const setCell = (i, j, k) => {
        const { dx, dy } = grid;
        const x0 = i * dx, x1 = (i + 1) * dx, z0 = j * dy, z1 = (j + 1) * dy;
        const y = (nodeI, nodeJ, bottom) => nodeWorldY(topDepthOffsetNodes, ni, layerTop, dzByLayer, nodeI, nodeJ, k, bottom);
        // 8 corners: top face (bottom=false) then bottom face (bottom=true), each in (0,0)/(1,0)/(1,1)/(0,1) order.
        const c = [
            [x0, y(i, j, false), z0], [x1, y(i + 1, j, false), z0], [x1, y(i + 1, j + 1, false), z1], [x0, y(i, j + 1, false), z1],
            [x0, y(i, j, true), z0], [x1, y(i + 1, j, true), z0], [x1, y(i + 1, j + 1, true), z1], [x0, y(i, j + 1, true), z1]
        ];
        // 4 top edges, 4 bottom edges, 4 verticals joining them — the 12 edges of a box.
        const edges = [
            [0, 1], [1, 2], [2, 3], [3, 0],
            [4, 5], [5, 6], [6, 7], [7, 4],
            [0, 4], [1, 5], [2, 6], [3, 7]
        ];
        const arr = geometry.attributes.position.array;
        edges.forEach(([a, b], n) => {
            arr[n * 6] = c[a][0]; arr[n * 6 + 1] = c[a][1]; arr[n * 6 + 2] = c[a][2];
            arr[n * 6 + 3] = c[b][0]; arr[n * 6 + 4] = c[b][1]; arr[n * 6 + 5] = c[b][2];
        });
        geometry.attributes.position.needsUpdate = true;
        line.visible = true;
    };

    const hide = () => { line.visible = false; };

    return { line, setCell, hide };
}

// Wellhead markers, matching the real product: a coloured cone (green producer, blue injector,
// apex pointing in the direction of flow — up out of a producer, down into an injector — a real
// distinction worth reproducing exactly, not decoration) floating a fixed height above the grid,
// joined to it by a thin connector line down to one cell above the well's shallowest completion.
// Built ONCE (like axisFrame/highlight): nothing here depends on the selected property, and this
// demo has no timestep control yet (state.stepIndex is fixed at mount), so well status — and
// therefore which glyph each well shows — never needs recomputing after this runs.
function buildWellMarkers(THREE, model, extents, stepIndex) {
    const { grid, wells } = model;
    const { dx, dy, topDepthOffsetNodes, ni } = grid;
    const { layerTop, dzByLayer, yTop0, height } = extents;
    const nodeY = (nodeI, nodeJ, k, bottom) =>
        nodeWorldY(topDepthOffsetNodes, ni, layerTop, dzByLayer, nodeI, nodeJ, k, bottom);

    // A fixed height above the grid's own shallowest point, the same for every well regardless of
    // its own local depth — matches the reference image, where every wellhead floats at a visually
    // consistent height rather than one tied to that well's own structural position.
    const standoffHeight = height * 0.35;
    const coneRadius = Math.min(dx, dy) * 0.28;
    const coneHeight = Math.min(dx, dy) * 0.7;

    const producerMaterial = new THREE.MeshBasicMaterial({ color: 0x2ecc40 });
    const injectorMaterial = new THREE.MeshBasicMaterial({ color: 0x1f6feb });
    const coneGeometry = new THREE.ConeGeometry(coneRadius, coneHeight, 12);
    // Connector lines deliberately light grey, not pure white — the cell-selection highlight
    // (added earlier this session) already uses pure white, and a well marker sitting near a
    // hovered cell would otherwise read as one ambiguous white line.
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xcfcfcf });
    const crossMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });

    const group = new THREE.Group();
    // One anchor per well, for mount() to project through the camera each frame and position a
    // DOM label at — the same technique buildAxisFrame's tick labels already use, since a label
    // that must always face the camera can't just be a THREE.Sprite/mesh in the scene.
    const labelAnchors = [];

    for (const well of wells) {
        const i = well.i - 1, j = well.j - 1;
        const x = (i + 0.5) * dx, z = (j + 0.5) * dy;

        // "One cell above the first (shallowest) perforation" — completions are already
        // shallow-to-deep, since track (and therefore completions) is built k = 0..nk-1.
        const shallowestK = well.completions.length > 0 ? well.completions[0].k : 0;
        const connectorBottomY = shallowestK > 0
            ? nodeY(i, j, shallowestK - 1, false)
            : nodeY(i, j, 0, false);
        const topY = yTop0 + standoffHeight;

        const wellGroup = new THREE.Group();

        const linePositions = new Float32Array([x, connectorBottomY, z, x, topY, z]);
        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
        wellGroup.add(new THREE.Line(lineGeometry, lineMaterial));

        const isInjector = well.type === 'Injector';
        const cone = new THREE.Mesh(coneGeometry, isInjector ? injectorMaterial : producerMaterial);
        cone.position.set(x, topY + coneHeight / 2, z);
        if (isInjector) cone.rotation.x = Math.PI; // apex down: flow INTO the reservoir
        wellGroup.add(cone);

        // A 3-axis asterisk rather than a flat "X": reads clearly as "not a normal cone" from any
        // camera angle without needing to face the camera (the way the axis tick labels do, via a
        // DOM overlay projected every frame) — simpler and robust, at the cost of not matching the
        // reference image's flat glyph exactly.
        const crossSize = coneRadius * 1.3;
        const cy = topY + coneHeight / 2;
        const crossPositions = new Float32Array([
            x - crossSize, cy, z, x + crossSize, cy, z,
            x, cy - crossSize, z, x, cy + crossSize, z,
            x, cy, z - crossSize, x, cy, z + crossSize
        ]);
        const crossGeometry = new THREE.BufferGeometry();
        crossGeometry.setAttribute('position', new THREE.Float32BufferAttribute(crossPositions, 3));
        const cross = new THREE.LineSegments(crossGeometry, crossMaterial);
        wellGroup.add(cross);

        const shut = model.wellStatusAt(well, stepIndex) === 'shut';
        cone.visible = !shut;
        cross.visible = shut;

        group.add(wellGroup);
        // Anchored just above the cone's own apex (topY + coneHeight), not high above it — the
        // CSS transform (not this offset) is what shifts the label to the right of the marker.
        labelAnchors.push({ name: well.name, position: new THREE.Vector3(x, topY + coneHeight * 1.1, z) });
    }

    return { group, standoffHeight, labelAnchors };
}

function buildLegend(model, state) {
    // No vector loaded means no data range to show a legend for — matching the product, which
    // has nothing to key a colour scale to once Property is <None>.
    if (state.property === NONE_PROPERTY) return null;

    const property = model.gridProperty(state.property, state.stepIndex);
    const { min, max } = property.range;
    // Fixed integer formatting was fine for PRESSURE (hundreds of bara) but rounded SWAT/SOIL —
    // fractions spanning roughly 0.25-0.85 — down to a useless run of "0"s and "1"s. Precision
    // scales with the property's own range span, not a value chosen for one property and assumed
    // to fit the others.
    const span = max - min;
    const decimals = span < 2 ? 2 : span < 20 ? 1 : 0;
    const stops = 6;
    const ticks = element('div', 'demo-grid-legend-ticks');
    for (let n = stops; n >= 0; n--) {
        const t = n / stops;
        const value = min + t * (max - min);
        const row = element('div', 'demo-grid-legend-tick');
        row.style.top = `${(1 - t) * 100}%`;
        row.appendChild(element('span', 'demo-grid-legend-tick-mark'));
        row.appendChild(element('span', null, value.toFixed(decimals)));
        ticks.appendChild(row);
    }

    // The bar's own gradient must trace exactly the schemeHue() function the mesh colours are
    // drawn from, or the legend would lie about what the surface shows. CSS requires color-stop
    // positions in non-decreasing order — a stop given "out of order" gets its position silently
    // clamped up to match the previous stop's, which is what collapsed this into a single solid
    // colour (the very first stop's hue) the first time round. Position must climb 0% -> 100% as
    // the loop proceeds; t (the value-fraction the colour comes from) runs the other way, 1 -> 0,
    // since 100% (top of legend) is the maximum value and 0% (bottom) is the minimum.
    const stopCount = 10;
    const gradientStops = [];
    for (let n = 0; n <= stopCount; n++) {
        const position = (n / stopCount) * 100;
        const t = 1 - n / stopCount;
        const hue = schemeHue(t) * 360;
        gradientStops.push(`hsl(${hue}, 100%, 50%) ${position}%`);
    }

    const bar = element('div', 'demo-grid-legend-bar');
    bar.style.background = `linear-gradient(to bottom, ${gradientStops.join(', ')})`;

    const legend = element('div', 'demo-grid-legend');
    const title = element('div', 'demo-grid-legend-title',
        property.units ? `${state.property} (${property.units})` : state.property);
    legend.appendChild(title);
    const barWrap = element('div', 'demo-grid-legend-bar-wrap');
    barWrap.appendChild(bar);
    barWrap.appendChild(ticks);
    legend.appendChild(barWrap);
    return legend;
}

/* -------------------------------------------------------------- Cell Lines settings dialog ----- */

// A single-page emulator, not a tree: the real "Grid Editors" window has fourteen pages (Axis
// Settings, Cell Lines, Centre Of Rotation, Cut Planes, ...), and only one is built here. Faking a
// fourteen-item tree where thirteen entries go nowhere would misrepresent the product more, not
// less, than simply not drawing a tree at all — the same reasoning that dropped the treeview
// facade from the line-plot dialog in favour of plain substitute navigation.
function buildCellLinesPanel(state, onChange) {
    const panel = element('fieldset', 's3-group');
    panel.appendChild(element('legend', null, 'Cell Lines'));

    const rows = [
        { kind: 'check', label: 'Show Cell Faces', path: 'showFaces' },
        { kind: 'colour-check', label: 'Show Cell Wireframe:', checkPath: 'showWireframe', colourPath: 'wireframeColour' },
        { kind: 'colour-check', label: 'Show Inactive Cells:', checkPath: 'showInactive', colourPath: 'inactiveColour' },
        { kind: 'colour-check', label: 'Show Active Cells:', checkPath: 'showActive', colourPath: 'activeColour' },
        { kind: 'check', label: 'Show Cell Information Tooltip', path: 'tooltip' }
    ];

    let openPalette = null;
    const closePalette = () => { if (openPalette) { openPalette.remove(); openPalette = null; } };

    for (const row of rows) {
        const line = element('label', 's3-row');
        line.dataset.kind = row.kind === 'check' ? 'check' : 'colour';

        if (row.kind === 'check') {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = Boolean(state[row.path]);
            if (row.disabled) {
                input.disabled = true;
                line.title = row.title;
                line.classList.add('is-disabled');
            } else {
                input.addEventListener('change', () => { state[row.path] = input.checked; onChange(); });
            }
            line.appendChild(input);
            line.appendChild(element('span', null, row.label));
        } else {
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = Boolean(state[row.checkPath]);
            check.addEventListener('change', () => { state[row.checkPath] = check.checked; onChange(); });
            line.appendChild(check);
            line.appendChild(element('span', null, row.label));

            const button = element('button', 's3-colour');
            button.type = 'button';
            const swatch = element('span', 's3-colour-swatch');
            swatch.style.background = state[row.colourPath];
            button.appendChild(swatch);
            button.appendChild(element('span', 's3-colour-arrow', '▼'));
            button.setAttribute('aria-label', `${row.label} choose colour`);

            button.addEventListener('click', () => {
                if (openPalette) { closePalette(); return; }

                const picker = element('div', 's3-palette');
                picker.appendChild(element('div', 's3-palette-label', 'Current Color:'));
                const preview = element('div', 's3-palette-preview');
                preview.style.background = state[row.colourPath];
                picker.appendChild(preview);

                picker.appendChild(element('div', 's3-palette-label', 'Current Color Palette:'));
                const paletteRow = element('div', 's3-palette-row');
                PALETTE_HEX.forEach(hex => {
                    const s = document.createElement('button');
                    s.type = 'button';
                    s.style.background = hex;
                    s.setAttribute('aria-current', String(hex === state[row.colourPath]));
                    s.addEventListener('click', () => {
                        state[row.colourPath] = hex;
                        swatch.style.background = hex;
                        closePalette();
                        onChange();
                    });
                    paletteRow.appendChild(s);
                });
                picker.appendChild(paletteRow);

                const advanced = element('button', 's3-button s3-palette-advanced', 'Advanced…');
                advanced.type = 'button';
                const native = document.createElement('input');
                native.type = 'color';
                native.className = 's3-palette-native';
                native.tabIndex = -1;
                native.value = state[row.colourPath];
                native.addEventListener('input', () => {
                    state[row.colourPath] = native.value;
                    swatch.style.background = native.value;
                    closePalette();
                    onChange();
                });
                advanced.addEventListener('click', () => native.click());
                picker.appendChild(advanced);
                picker.appendChild(native);

                line.style.position = 'relative';
                line.appendChild(picker);
                picker.style.left = '190px';
                picker.style.top = '26px';
                openPalette = picker;
            });

            line.appendChild(button);
        }

        panel.appendChild(line);
    }

    return panel;
}

/* --------------------------------------------------------------------------------- mount ------- */

export async function mount(figure, config) {
    const model = await loadModel();

    const stepIndex = Number.isInteger(config.stepIndex)
        ? config.stepIndex
        : Math.min(6, model.gridDynamic.steps.length - 1);

    const state = {
        property: PROPERTIES.includes(config.property) ? config.property : 'PRESSURE',
        stepIndex,
        showFaces: true,
        showWireframe: true,
        wireframeColour: '#000000',
        showInactive: false,
        inactiveColour: '#ffffff',
        showActive: true,
        activeColour: '#a8d8ff',
        // Ticked by default: hovering and immediately seeing a tooltip is a strong signal to a
        // first-time visitor that this is a live, interactive 3D view rather than a static image.
        tooltip: true,
        showWells: true
    };

    const wrap = element('div', 'demo-wrap');

    // A badge, not a groupbox around the whole demo: the viewport below is styled to be
    // indistinguishable from the real product (see the "Try it" hint's own comment on why nothing
    // can hint at interactivity from inside it), so the "this is live" signal has to live outside
    // it — but as the very first thing on the page, before a visitor has scrolled past the
    // viewport without noticing the smaller hint text beneath it.
    const badge = element('div', 'demo-badge');
    badge.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
        + '<path d="M5 1.5v7.6L7 7l1.6 3.8 1.8-.8L8.8 6.3l2.7-.3z" fill="currentColor"/></svg> '
        + 'Live Demo Section Below';
    wrap.appendChild(badge);

    const controlsBar = element('div', 'demo-restore');
    controlsBar.appendChild(element('span', null, 'Property:'));
    const propertySelect = document.createElement('select');
    propertySelect.className = 'demo-restore-select';
    for (const name of PROPERTIES) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        propertySelect.appendChild(opt);
    }
    propertySelect.value = state.property;
    controlsBar.appendChild(propertySelect);

    const wellsToggleLabel = element('label', 'demo-restore-checkbox');
    const wellsToggle = document.createElement('input');
    wellsToggle.type = 'checkbox';
    wellsToggle.checked = state.showWells;
    wellsToggleLabel.appendChild(wellsToggle);
    wellsToggleLabel.appendChild(document.createTextNode('Show Wells'));
    controlsBar.appendChild(wellsToggleLabel);

    wrap.appendChild(controlsBar);

    const viewport = element('div', 'demo-grid-viewport');
    viewport.style.height = `${Number(figure.dataset.demoHeight) || 460}px`;
    wrap.appendChild(viewport);

    const liveHint = element('p', 'demo-live-hint');
    liveHint.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
        + '<path d="M5 1.5v7.6L7 7l1.6 3.8 1.8-.8L8.8 6.3l2.7-.3z" fill="currentColor"/></svg> '
        + 'Try it — drag to rotate, scroll to zoom, and use the settings below.';
    wrap.appendChild(liveHint);

    const dialog = element('div', 's3-dialog');
    dialog.setAttribute('role', 'group');
    dialog.setAttribute('aria-label', 'Grid Editors');
    const titleBar = element('div', 's3-dialog-title');
    titleBar.appendChild(element('h3', null, 'Grid Editors'));
    dialog.appendChild(titleBar);
    const dialogBody = element('div', 's3-dialog-body-solo');
    dialog.appendChild(dialogBody);
    wrap.appendChild(dialog);

    const fallback = figure.querySelector('[data-demo-fallback]');
    figure.insertBefore(wrap, figure.firstElementChild);
    if (fallback) fallback.hidden = true;

    /* ---- Three.js scene ---- */

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    viewport.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
    // No lights: every surface in this scene is an unlit MeshBasicMaterial (see buildMeshes for
    // why), and the axis frame's LineBasicMaterial doesn't respond to lights either.

    let meshGroup = null;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false; // deliberately no fly-through — orbit and zoom only
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.8;

    const legendHost = element('div', 'demo-grid-legend-host');
    const captionHost = element('div', 'demo-grid-caption');
    const axisLabelHost = element('div', 'demo-grid-axis-labels');
    const tooltipHost = element('div', 'demo-grid-cell-tooltip');
    const wellLabelHost = element('div', 'demo-grid-well-labels');
    viewport.appendChild(legendHost);
    viewport.appendChild(captionHost);
    viewport.appendChild(axisLabelHost);
    viewport.appendChild(tooltipHost);
    viewport.appendChild(wellLabelHost);

    // Built once: geometry depends only on the grid's shape, never on the property/step/Cell-Lines
    // settings, so it lives outside rebuildScene rather than being torn down and rebuilt on every
    // toggle. Each tick gets its own DOM element, positioned every frame by projecting its 3D world
    // point through the (constantly orbiting/zooming) camera — the same technique CSS2DRenderer
    // uses, hand-rolled here rather than pulling in another Three.js addon for nine labels.
    const extents = computeExtents(model.grid);
    const axisFrame = buildAxisFrame(THREE, extents);
    scene.add(axisFrame.group);

    // Built once, like axisFrame — repositioned via setCell() rather than rebuilt per hover.
    const highlight = buildCellHighlight(THREE, model.grid, extents);
    scene.add(highlight.line);

    // Built once, like axisFrame/highlight — nothing about a well's marker depends on the
    // selected property, and this demo has no timestep control yet (state.stepIndex is fixed at
    // mount), so which glyph each well shows never needs recomputing after this runs.
    const wellMarkers = buildWellMarkers(THREE, model, extents, state.stepIndex);
    wellMarkers.group.visible = state.showWells;
    scene.add(wellMarkers.group);
    // One DOM span per well, matching the axis ticks' own overlay pattern — a label that must
    // always face the camera can't be geometry in the scene, only a projected screen-space element.
    const wellLabels = wellMarkers.labelAnchors.map(anchor => {
        const el = element('span', 'demo-grid-well-label', anchor.name);
        wellLabelHost.appendChild(el);
        return { position: anchor.position, el };
    });

    wellsToggle.addEventListener('change', () => {
        state.showWells = wellsToggle.checked;
        wellMarkers.group.visible = state.showWells;
        for (const label of wellLabels) label.el.style.display = state.showWells ? 'block' : 'none';
    });

    // Wellheads float above yTop0 by standoffHeight, which the axis frame's own radius (built with
    // no knowledge of well markers) doesn't account for — without this, the default camera position
    // could crop them, the same class of problem the axis rulers' own reach caused earlier.
    const cameraRadius = Math.hypot(axisFrame.bounds.radius, wellMarkers.standoffHeight);

    controls.target.copy(axisFrame.bounds.center);
    controls.minDistance = cameraRadius * 0.4;
    controls.maxDistance = cameraRadius * 4;
    camera.position.set(
        axisFrame.bounds.center.x + cameraRadius * 1.1,
        axisFrame.bounds.center.y + cameraRadius * 0.9,
        axisFrame.bounds.center.z + cameraRadius * 1.6
    );
    camera.lookAt(axisFrame.bounds.center);

    // layout() must run once before the DOM tick elements are created, so their initial text is
    // populated rather than the empty placeholder buildAxisFrame() seeds them with.
    axisFrame.layout(camera);
    for (const tick of axisFrame.ticks) {
        tick.el = element('span', 'demo-grid-axis-tick', tick.text);
        axisLabelHost.appendChild(tick.el);
    }

    const rebuildScene = () => {
        if (meshGroup) { scene.remove(meshGroup); disposeGroup(meshGroup); }
        meshGroup = buildMeshes(THREE, model, state, extents);
        scene.add(meshGroup);

        legendHost.textContent = '';
        const legend = buildLegend(model, state);
        if (legend) legendHost.appendChild(legend);

        // No vector, no meaningful "as of this date" reading either — the caption drops both
        // rather than showing a property/date pairing that doesn't actually apply to anything.
        captionHost.textContent = state.property === NONE_PROPERTY
            ? `${model.caseName} ROOT - Grid`
            : `${model.caseName} ROOT ${state.property} `
                + `${formatCaptionDate(model.gridDynamic.dates[state.stepIndex])} - Grid`;
    };

    function disposeGroup(group) {
        group.traverse(obj => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) obj.material.dispose();
        });
    }

    let panelHost = null;
    const rebuildPanel = () => {
        dialogBody.textContent = '';
        // cellLinesOnChange is defined further down (after the tooltip/highlight wiring) but this
        // callback only ever runs later, on a checkbox "change" event — by then it's assigned.
        panelHost = buildCellLinesPanel(state, () => cellLinesOnChange());
        dialogBody.appendChild(panelHost);
    };

    propertySelect.addEventListener('change', () => {
        state.property = propertySelect.value;
        rebuildScene();
    });

    const resize = () => {
        const w = viewport.clientWidth, h = viewport.clientHeight;
        if (!w || !h) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);
    resize();

    rebuildScene();
    rebuildPanel();

    /* ---- Cell tooltip + selection highlight, gated on state.tooltip ----------------------- */
    //
    // Gated on the "Show Cell Information Tooltip" checkbox (state.tooltip) — every handler below
    // checks it first and bails immediately when unticked. Uses Pointer Events (not separate mouse
    // and touch listeners) so a tap on a touch device works the same way a click does here, without
    // a second code path — though a tap still can't show a live hover-preview the way a mouse can,
    // since touch has no hover state at all; that's an inherent gap, not something this fixes.
    //
    // Nothing here calls preventDefault()/stopPropagation(), so OrbitControls' own pointer handling
    // on the same canvas element is completely unaffected — these are purely additional listeners.
    const raycaster = new THREE.Raycaster();
    const pointerNdc = new THREE.Vector2();
    let hoveredCell = null; // { i, j, k, category } | null
    let pinnedCell = null;  // same shape | null — set by a genuine click, see pointerup below
    let pointerDownAt = null; // { x, y } client coords, to distinguish a click from an orbit-drag

    const decodeCell = (flatIdx, category) => {
        const { ni, nj } = model.grid;
        const i = flatIdx % ni;
        const j = Math.floor(flatIdx / ni) % nj;
        const k = Math.floor(flatIdx / (ni * nj));
        return { i, j, k, category };
    };

    const pickCell = (clientX, clientY) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        if (!meshGroup) return null;
        const hits = raycaster.intersectObjects(meshGroup.children.filter(o => o.isMesh));
        if (!hits.length) return null;
        // Nearest hit wins by construction (three.js sorts by distance) — the right answer for
        // silhouette overlap between the active and inactive meshes too, not just within one.
        const hit = hits[0];
        const flatIdx = hit.object.userData.cellIndexPerFace[hit.faceIndex];
        return decodeCell(flatIdx, hit.object.userData.category);
    };

    const sameCell = (a, b) => a && b && a.i === b.i && a.j === b.j && a.k === b.k;

    const cellTooltipText = (cell) => {
        // Displayed 1-based (i+1, j+1, k+1) to match S3analyse's own cell-info tooltip — the
        // underlying i/j/k stay 0-based everywhere else (grid.index, decodeCell, the highlight box),
        // this is purely a display-format difference at the last moment.
        const lines = [`(${cell.i + 1}, ${cell.j + 1}, ${cell.k + 1})`];
        if (cell.category === 'inactive') {
            lines.push('Inactive');
        } else if (state.property !== NONE_PROPERTY) {
            const property = model.gridProperty(state.property, state.stepIndex);
            const idx = model.grid.index(cell.i, cell.j, cell.k);
            lines.push(`${state.property}: ${property.values[idx].toFixed(4)}`);
        }
        return lines;
    };

    const updateTooltipDisplay = () => {
        const active = pinnedCell ?? hoveredCell;
        if (!state.tooltip || !active) {
            tooltipHost.style.display = 'none';
            highlight.hide();
            return;
        }
        highlight.setCell(active.i, active.j, active.k);
        tooltipHost.textContent = '';
        for (const line of cellTooltipText(active)) {
            tooltipHost.appendChild(element('div', null, line));
        }
        tooltipHost.style.display = 'block';
    };

    const positionTooltip = (clientX, clientY) => {
        const rect = viewport.getBoundingClientRect();
        let left = clientX - rect.left + 12;
        let top = clientY - rect.top + 12;
        // Flip to the other side of the pointer rather than letting the box run off-screen.
        const tw = tooltipHost.offsetWidth, th = tooltipHost.offsetHeight;
        if (left + tw > rect.width) left = clientX - rect.left - tw - 12;
        if (top + th > rect.height) top = clientY - rect.top - th - 12;
        tooltipHost.style.left = `${Math.max(0, left)}px`;
        tooltipHost.style.top = `${Math.max(0, top)}px`;
    };

    renderer.domElement.addEventListener('pointermove', (e) => {
        if (!state.tooltip) return;
        hoveredCell = pickCell(e.clientX, e.clientY);
        updateTooltipDisplay();
        // Only follow the live cursor while nothing is pinned — once pinned, the box stays put
        // (set once, in the pointerup handler below) rather than chasing the mouse during an
        // unrelated orbit-drag, which would otherwise fire on every pointermove while dragging.
        if (!pinnedCell && hoveredCell) positionTooltip(e.clientX, e.clientY);
    });

    renderer.domElement.addEventListener('pointerleave', () => {
        hoveredCell = null;
        updateTooltipDisplay();
    });

    renderer.domElement.addEventListener('pointerdown', (e) => {
        pointerDownAt = { x: e.clientX, y: e.clientY };
    });

    renderer.domElement.addEventListener('pointerup', (e) => {
        if (!state.tooltip || !pointerDownAt) return;
        const moved = Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y);
        pointerDownAt = null;
        if (moved >= 4) return; // an orbit-drag, not a click

        const clicked = pickCell(e.clientX, e.clientY);
        pinnedCell = (!clicked || sameCell(clicked, pinnedCell)) ? null : clicked;
        updateTooltipDisplay();
        if (pinnedCell) positionTooltip(e.clientX, e.clientY);
    });

    // The checkbox toggled off mid-hover must clear immediately, not just stop updating.
    const clearTooltipIfDisabled = () => {
        if (!state.tooltip) { hoveredCell = null; pinnedCell = null; updateTooltipDisplay(); }
    };
    const cellLinesOnChange = () => { rebuildScene(); clearTooltipIfDisabled(); };

    // A fixed offset margin on the rulers (see buildAxisFrame) turned out not to be enough to
    // guarantee screen-space clearance at every camera angle — measured empirically by rendering
    // and reading back actual pixels at the tick positions across a wide sweep of elevations and
    // azimuths: even a generous margin still left labels landing on rendered mesh pixels at a
    // meaningful fraction of realistic viewing angles, because a perspective camera's projection
    // doesn't scale a fixed world-space margin into a reliable screen-space one. Rather than keep
    // chasing a margin that can't fully solve this, a label simply hides itself for the one frame
    // it would land on the grid — read back the ACTUAL rendered pixel at its anchor point (already
    // drawn, since this runs right after renderer.render() in the same frame) rather than trying to
    // predict occlusion geometrically.
    const projected = new THREE.Vector3();
    const pixelBuf = new Uint8Array(4);
    const updateAxisLabels = () => {
        const w = viewport.clientWidth, h = viewport.clientHeight;
        const bufW = renderer.domElement.width, bufH = renderer.domElement.height;
        const dpr = bufW / w;
        const gl = renderer.getContext();

        for (const tick of axisFrame.ticks) {
            if (tick.el.textContent !== tick.text) tick.el.textContent = tick.text;
            projected.copy(tick.pos).project(camera);
            let visible = projected.z < 1;

            if (visible) {
                const sx = (projected.x * 0.5 + 0.5) * w;
                const sy = (-projected.y * 0.5 + 0.5) * h;
                const bufX = Math.round(sx * dpr), bufY = Math.round(bufH - sy * dpr);
                if (bufX >= 0 && bufX < bufW && bufY >= 0 && bufY < bufH) {
                    gl.readPixels(bufX, bufY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf);
                    if (pixelBuf[0] || pixelBuf[1] || pixelBuf[2]) visible = false;
                }
                if (visible) {
                    tick.el.style.left = `${sx}px`;
                    tick.el.style.top = `${sy}px`;
                }
            }

            tick.el.style.display = visible ? 'block' : 'none';
        }
    };

    // Well labels float well clear of the grid mesh (see buildWellMarkers' standoffHeight), so
    // unlike the axis ticks above they don't need the pixel-readback occlusion check — just the
    // ordinary "is this even in front of the camera" projection every other overlay label needs.
    const updateWellLabels = () => {
        if (!state.showWells) return;
        const w = viewport.clientWidth, h = viewport.clientHeight;

        for (const label of wellLabels) {
            projected.copy(label.position).project(camera);
            const visible = projected.z < 1;
            if (visible) {
                label.el.style.left = `${(projected.x * 0.5 + 0.5) * w}px`;
                label.el.style.top = `${(-projected.y * 0.5 + 0.5) * h}px`;
            }
            label.el.style.display = visible ? 'block' : 'none';
        }
    };

    let frame = requestAnimationFrame(function loop() {
        controls.update();
        // Re-picks which side of the grid each ruler sits on from the camera's current position —
        // cheap early-exit inside layout() when the camera hasn't crossed into a different octant
        // since the last frame, so this is a no-op most frames, not a rebuild every frame.
        axisFrame.layout(camera);
        renderer.render(scene, camera);
        updateAxisLabels();
        updateWellLabels();
        frame = requestAnimationFrame(loop);
    });

    return () => {
        cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        controls.dispose();
        if (meshGroup) disposeGroup(meshGroup);
        disposeGroup(axisFrame.group);
        highlight.line.geometry.dispose();
        highlight.line.material.dispose();
        disposeGroup(wellMarkers.group);
        renderer.dispose();
        wrap.remove();
        if (fallback) fallback.hidden = false;
    };
}
