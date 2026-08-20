// The shared synthetic Eclipse model behind every interactive demo on this site.
//
// This is the ONLY module a demo may import for data. Everything else here is internal, so that
// two demos can never end up describing different models — see docs/ADR-002-interactive-demos.md.
//
// Nothing is shipped as data except the deck at /data/demo-model.json, which holds only what a
// human chose. The bulky arrays are generated here. That keeps ~6.4 MB of JSON off the wire and,
// more importantly, means a line plot and a histogram are provably looking at the same field.
//
// DETERMINISM IS A HARD REQUIREMENT. Showcase prose quotes figures from these curves and
// screenshots have to reproduce, so this file must never use Math.random, Date.now, an argless
// `new Date()`, locale-sensitive formatting, or iteration over an object whose key order is not
// fixed. selfcheck.js hashes the output and will fail loudly if any of that creeps in.

// Relative, not root-absolute: fetch() resolves this against <base href>, same as any HTML
// link/asset. A leading "/" would override <base> entirely and always hit the domain root,
// breaking under a subpath deployment (a GitHub Pages project repo) even though it works fine
// when served from a domain root. See docs/ADR-003.
const DECK_URL = 'data/demo-model.json';

/* ---------------------------------------------------------------- seeded randomness ---------- */

// mulberry32. Small, fast, and good enough for property distributions — we need repeatability,
// not cryptographic quality.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Box-Muller, returning one value per call. The second value is discarded rather than cached
// because a cache would make the stream depend on call parity, which is a subtle way to lose
// determinism when a caller changes.
function gaussian(rand) {
    const u = Math.max(rand(), Number.EPSILON);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Lognormal draw whose arithmetic mean is `mean` (hence the -sigma^2/2 correction).
function lognormal(rand, mean, sigma) {
    return Math.exp(Math.log(mean) + sigma * gaussian(rand) - (sigma * sigma) / 2);
}

/* ------------------------------------------------------------------------- time ---------------- */

function parseIsoDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}

function addMonthsUtc(startMs, months) {
    const d = new Date(startMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate());
}

function buildTime(deck) {
    const startMs = parseIsoDate(deck.time.start);
    const monthly = [];
    const days = [];

    for (let m = 0; m < deck.time.summaryMonths; m++) {
        const t = addMonthsUtc(startMs, m);
        monthly.push(t);
        days.push((addMonthsUtc(startMs, m + 1) - t) / 86400000);
    }

    // Restart output is annual while summary output is monthly, exactly as a real deck separates
    // them. These are indices into the monthly series, so a grid demo and a line demo read the
    // same state rather than two independently generated ones.
    const solutionIndices = [];
    for (let s = 0; s < deck.time.solutionSteps; s++) solutionIndices.push(s * 12);

    return {
        start: startMs,
        monthly,
        monthlyDays: days,
        solutionIndices,
        solution: solutionIndices.map(i => monthly[i])
    };
}

/* ------------------------------------------------------------------------- grid ---------------- */

function buildGrid(deck, rand) {
    const { ni, nj, nk, dx, dy, dzByLayer, topDepth } = deck.grid;
    const trends = deck.layerTrends;
    const count = ni * nj * nk;

    const active = new Uint8Array(count).fill(1);
    const poro = new Float32Array(count);
    const permx = new Float32Array(count);
    const permz = new Float32Array(count);
    const ntg = new Float32Array(count);
    const depth = new Float32Array(count);
    const porv = new Float32Array(count);

    // Inactive clusters, top layer only. Authored as rectangles in the deck rather than a
    // run-length ACTNUM: they are a handful of small blocks, so the readable form is also the
    // smaller one.
    for (const c of deck.grid.inactiveTopLayerClusters) {
        for (let j = c.j0 - 1; j <= c.j1 - 1; j++) {
            for (let i = c.i0 - 1; i <= c.i1 - 1; i++) {
                active[(0 * nj + j) * ni + i] = 0;
            }
        }
    }

    // Layer top depths accumulate down the column.
    const layerTop = [];
    let z = topDepth;
    for (let k = 0; k < nk; k++) {
        layerTop.push(z);
        z += dzByLayer[k];
    }

    // A gentle structural dome plus a regional dip, purely a function of (i, j) — no new random
    // draws, so it stays perfectly deterministic without touching the PRNG stream. Without this
    // the top surface is a flat slab, which reads as a brick rather than a reservoir horizon; real
    // grids (even simple synthetic ones) are never perfectly flat.
    //
    // Defined at grid NODES — (ni+1) x (nj+1) corner points, one more than the cell count in each
    // direction — not per-cell. A per-cell value would let each cell disagree with its neighbour
    // about the height of the corner they're supposed to share, which is exactly what happened the
    // first time round: adjacent cells rendered as visibly disjointed once vertical exaggeration
    // (in grid-viewer.js) amplified those small per-cell disagreements into real gaps you could see
    // through. Sharing one offset per node is what a real corner-point grid does, and it's what
    // guarantees neighbouring cells slope smoothly into each other with no crack.
    const domeAmplitude = 0.32 * (dzByLayer.reduce((a, b) => a + b, 0));
    const domeSpreadI = ni * 0.32, domeSpreadJ = nj * 0.38;
    const domeCentreI = ni * 0.42, domeCentreJ = nj * 0.55;
    const tiltPerCellI = domeAmplitude / (ni * 1.4);

    const nodeOffsetAt = (nodeI, nodeJ) => {
        const di = (nodeI - domeCentreI) / domeSpreadI;
        const dj = (nodeJ - domeCentreJ) / domeSpreadJ;
        const dome = -domeAmplitude * Math.exp(-(di * di + dj * dj));
        const tilt = tiltPerCellI * (nodeI - domeCentreI);
        return dome + tilt;
    };

    const topDepthOffsetNodes = new Float32Array((ni + 1) * (nj + 1));
    for (let j = 0; j <= nj; j++) {
        for (let i = 0; i <= ni; i++) {
            topDepthOffsetNodes[j * (ni + 1) + i] = nodeOffsetAt(i, j);
        }
    }

    // A representative single value per cell — its four corner nodes averaged — for depth[idx]
    // and any other per-cell consumer. The rendered geometry (grid-viewer.js) uses the node array
    // directly, not this average, which is what keeps adjacent cells' shared edges exact rather
    // than merely close.
    const topDepthOffset = new Float32Array(ni * nj);
    for (let j = 0; j < nj; j++) {
        for (let i = 0; i < ni; i++) {
            const n00 = topDepthOffsetNodes[j * (ni + 1) + i];
            const n10 = topDepthOffsetNodes[j * (ni + 1) + i + 1];
            const n01 = topDepthOffsetNodes[(j + 1) * (ni + 1) + i];
            const n11 = topDepthOffsetNodes[(j + 1) * (ni + 1) + i + 1];
            topDepthOffset[j * ni + i] = (n00 + n10 + n01 + n11) / 4;
        }
    }

    let poreVolume = 0;

    // Iteration order is k, then j, then i — fixed, so the PRNG stream is fixed.
    for (let k = 0; k < nk; k++) {
        for (let j = 0; j < nj; j++) {
            for (let i = 0; i < ni; i++) {
                const idx = (k * nj + j) * ni + i;

                // Draw for every cell whether active or not, so that deactivating a cluster does
                // not shift the random stream for the cells after it.
                const cellPoro = Math.min(0.35, Math.max(0.02,
                    trends.poro[k] + 0.02 * gaussian(rand)));
                const cellPerm = lognormal(rand, trends.permMean[k], trends.permSigma);
                const cellNtg = Math.min(1, Math.max(0.2, trends.ntg[k] + 0.04 * gaussian(rand)));

                poro[idx] = cellPoro;
                permx[idx] = cellPerm;
                permz[idx] = cellPerm * 0.1;
                ntg[idx] = cellNtg;
                depth[idx] = layerTop[k] + dzByLayer[k] / 2 + topDepthOffset[j * ni + i];

                if (active[idx]) {
                    porv[idx] = dx * dy * dzByLayer[k] * cellPoro * cellNtg;
                    poreVolume += porv[idx];
                } else {
                    porv[idx] = 0;
                }
            }
        }
    }

    const hydrocarbonPoreVolume = poreVolume * (1 - deck.fluids.connateWaterSaturation);

    return {
        ni, nj, nk, dx, dy, dzByLayer, topDepth, topDepthOffset, topDepthOffsetNodes,
        cellCount: count,
        activeCellCount: active.reduce((n, a) => n + a, 0),
        active, poro, permx, permz, ntg, depth, porv,
        poreVolume,
        hydrocarbonPoreVolume,
        stoiip: hydrocarbonPoreVolume / deck.fluids.bo,
        index: (i, j, k) => (k * nj + j) * ni + i
    };
}

/* ------------------------------------------------------------------ grid dynamics -------------- */

// Per-cell PRESSURE/SWAT/SOIL at each solution step, for the grid-viewer demo. Nothing here
// contradicts the well/field physics above — it reuses the already-computed field pressure trend
// and each producer's own WWCT series, and only adds the spatial distribution across the grid that
// a single-tank material balance has no notion of. SGAS is not modelled (no free-gas front is
// tracked spatially), so SOIL is simply 1 - SWAT; that is a deliberate simplification for a demo,
// not an oversight.
function buildGridDynamics(deck, grid, wells, series, time, rand) {
    const { ni, nj, nk, dx, dy, depth, topDepth } = grid;
    const cellCount = grid.cellCount;
    const f = deck.fluids;
    const producers = wells.filter(w => w.type === 'Producer');
    const injectors = wells.filter(w => w.type === 'Injector');

    // Fixed per-cell texture, drawn once so it stays put as the visitor steps through time —
    // otherwise every timestep would look like independent static.
    const pressureJitter = new Float32Array(cellCount);
    const swatJitter = new Float32Array(cellCount);
    for (let idx = 0; idx < cellCount; idx++) {
        pressureJitter[idx] = 3 * gaussian(rand);
        swatJitter[idx] = 0.015 * gaussian(rand);
    }

    // Nearest-producer and nearest-injector distance per (i, j) column, shared by every layer and
    // every timestep. Wells are vertical or gently deviated, so an i/j-only distance is a fair
    // approximation for a demo grid, and far cheaper than tracking depth-varying completions here.
    const nearestProdDist = new Float32Array(ni * nj);
    const nearestProdIndex = new Int16Array(ni * nj);
    const nearestInjDist = new Float32Array(ni * nj);
    for (let j = 0; j < nj; j++) {
        for (let i = 0; i < ni; i++) {
            const col = j * ni + i;
            let bestP = Infinity, bestPIdx = 0;
            producers.forEach((p, n) => {
                const d = Math.hypot((i - (p.i - 1)) * dx, (j - (p.j - 1)) * dy);
                if (d < bestP) { bestP = d; bestPIdx = n; }
            });
            let bestI = Infinity;
            for (const inj of injectors) {
                const d = Math.hypot((i - (inj.i - 1)) * dx, (j - (inj.j - 1)) * dy);
                if (d < bestI) bestI = d;
            }
            nearestProdDist[col] = bestP;
            nearestProdIndex[col] = bestPIdx;
            nearestInjDist[col] = bestI;
        }
    }

    const decayLength = 3.5 * dx;
    const sweptMax = 0.7;
    const swatCap = 0.85;

    // A real reservoir's pressure field is dominated by its hydrostatic gradient — deeper cells
    // read higher regardless of well pattern — with local drawdown/support around wells as a
    // secondary perturbation on top. Without this term PRESSURE only varied areally (nearest
    // producer/injector), so every cell in a column read identically regardless of depth: visually
    // wrong (colour appeared to "flow" purely across the areal footprint) and physically backwards
    // for a demo meant to look like genuine simulation output. topDepth (not the dome-shifted
    // per-column top) is the reference, so the gradient is a property of true depth, not of the
    // structural dome already visible in the grid's shape.
    //
    // A textbook ~0.1 bar/m was tried first and confirmed (numerically, by averaging PRESSURE per
    // layer) to work exactly as intended — but at this grid's scale (~86m top-to-bottom) that is
    // only a ~9 bar swing, invisible next to the areal term's ~60-90 bar swing, and the DEFAULT
    // camera angle mostly looks down at a single top layer anyway, where only the ~27m structural
    // dome's worth of depth variation is even visible (~3 bar). Exaggerated here for the same
    // reason VERTICAL_EXAGGERATION/CELL_HEIGHT_SCALE are exaggerated in grid-viewer.js: this is a
    // demo meant to look convincingly like the real thing to a viewer who has never used S3analyse,
    // and physically-correct-but-invisible fails that bar as surely as visibly-wrong does.
    const depthGradientPerMetre = 0.5;

    const steps = time.solutionIndices.map(month => {
        const PRESSURE = new Float32Array(cellCount);
        const SWAT = new Float32Array(cellCount);
        const SOIL = new Float32Array(cellCount);

        const fieldPressure = series['FIELD:FPR'][month];
        const depletion = f.initialPressure - fieldPressure;

        for (let k = 0; k < nk; k++) {
            for (let j = 0; j < nj; j++) {
                for (let i = 0; i < ni; i++) {
                    const idx = grid.index(i, j, k);
                    const col = j * ni + i;

                    if (!grid.active[idx]) {
                        PRESSURE[idx] = fieldPressure;
                        SWAT[idx] = f.connateWaterSaturation;
                        SOIL[idx] = 1 - f.connateWaterSaturation;
                        continue;
                    }

                    const dProd = nearestProdDist[col];
                    const dInj = nearestInjDist[col];
                    // 0 at a producer, 1 at an injector — drawdown near production, support near
                    // injection, blending through the field average in between.
                    const bias = dProd / (dProd + dInj + 1);
                    const hydrostatic = depthGradientPerMetre * (depth[idx] - topDepth);
                    PRESSURE[idx] = fieldPressure + hydrostatic
                        + depletion * (bias - 0.5) * 1.6 + pressureJitter[idx];

                    const prod = producers[nearestProdIndex[col]];
                    const wcut = series[`${prod.name}:WWCT`][month];
                    const proximity = Math.exp(-dProd / decayLength);
                    const injBoost = Math.exp(-dInj / decayLength);
                    const swept = Math.max(wcut * proximity, 0.5 * injBoost);
                    const sw = f.connateWaterSaturation + (sweptMax - f.connateWaterSaturation) * swept
                        + swatJitter[idx];
                    SWAT[idx] = Math.min(swatCap, Math.max(f.connateWaterSaturation, sw));
                    SOIL[idx] = 1 - SWAT[idx];
                }
            }
        }

        return { month, PRESSURE, SWAT, SOIL };
    });

    const rangeOf = (key) => {
        let min = Infinity, max = -Infinity;
        for (const step of steps) {
            const arr = step[key];
            for (let idx = 0; idx < cellCount; idx++) {
                if (!grid.active[idx]) continue;
                const v = arr[idx];
                if (v < min) min = v;
                if (v > max) max = v;
            }
        }
        return { min, max };
    };

    return {
        dates: time.solution,
        steps,
        ranges: { PRESSURE: rangeOf('PRESSURE'), SWAT: rangeOf('SWAT'), SOIL: rangeOf('SOIL') }
    };
}

/* ------------------------------------------------------------------------ wells ---------------- */

function buildWells(deck, grid) {
    const { nk, dzByLayer } = grid;

    return deck.wells.map(w => {
        const track = [];
        for (let k = 0; k < nk; k++) {
            const [di, dj] = w.deviation ? w.deviation[k] : [0, 0];
            const i = Math.min(grid.ni - 1, Math.max(0, w.i - 1 + di));
            const j = Math.min(grid.nj - 1, Math.max(0, w.j - 1 + dj));
            track.push({ i, j, k });
        }

        // A completion at every active cell the track passes through. A track crossing one of the
        // inactive top-layer clusters simply has no perforation in layer 1 — which is the correct
        // behaviour and worth having in the model rather than smoothing away.
        const completions = track.filter(c => grid.active[grid.index(c.i, c.j, c.k)] === 1);

        let kh = 0;
        for (const c of completions) {
            const idx = grid.index(c.i, c.j, c.k);
            kh += grid.permx[idx] * dzByLayer[c.k] * grid.ntg[idx];
        }

        return {
            name: w.name,
            type: w.type,
            i: w.i,
            j: w.j,
            deviated: Boolean(w.deviation),
            track,
            completions,
            kh,
            bhpTarget: w.bhpTarget,
            rateTarget: w.rateTarget,
            // Placed by the physics pass.
            productivityIndex: 0,
            breakthroughMonth: null,
            shutInMonth: null,
            shutInDate: null,
            shutInWaterCut: null
        };
    });
}

/* ---------------------------------------------------------------------- physics ---------------- */

// Total mobility relative to its value in clean oil. Water is the less viscous phase, so a well
// held on a fixed bottom-hole pressure produces progressively more liquid as water cut climbs —
// which is why the liquid curves rise while the oil curves fall.
function relativeMobility(waterCut, muo, muw) {
    const lambda = (1 - waterCut) / muo + waterCut / muw;
    const lambdaClean = 1 / muo;
    return lambda / lambdaClean;
}

function runPhysics(deck, grid, wells) {
    const f = deck.fluids;
    const perf = deck.performance;
    const ev = deck.events;
    const time = deck.__time;
    const months = time.monthly.length;

    const producers = wells.filter(w => w.type === 'Producer');
    const injectors = wells.filter(w => w.type === 'Injector');

    const meanKh = producers.reduce((s, w) => s + w.kh, 0) / producers.length;
    const meanInjRate = injectors.reduce((s, w) => s + w.rateTarget, 0) / injectors.length;

    // Distance to the nearest injector, and a small constant pressure benefit for being close to
    // one. Both are geometry, not tuning.
    const distances = producers.map(p => Math.min(...injectors.map(inj =>
        Math.hypot((p.i - inj.i) * grid.dx, (p.j - inj.j) * grid.dy))));
    const meanDistance = distances.reduce((a, b) => a + b, 0) / distances.length;

    producers.forEach((p, n) => {
        const nearest = injectors.reduce((best, inj) => {
            const d = Math.hypot((p.i - inj.i) * grid.dx, (p.j - inj.j) * grid.dy);
            return d < best.d ? { d, inj } : best;
        }, { d: Infinity, inj: injectors[0] });

        p.__support = 6 * (nearest.inj.rateTarget / meanInjRate);

        // Breakthrough is later for a distant well, later for a weakly supported one, and earlier
        // for a high-kh (better connected) one. No per-well fudge factor.
        p.breakthroughMonth = perf.breakthroughReferenceMonths
            * (distances[n] / meanDistance)
            * (meanInjRate / nearest.inj.rateTarget)
            * Math.pow(meanKh / p.kh, 0.5);
    });

    // Calibrate the productivity indices together so the field opens at the stated rate. Only the
    // common scale factor is fitted; the relative differences between wells come from kh.
    const rawOpening = producers.reduce((s, p) =>
        s + p.kh * (f.initialPressure + p.__support - p.bhpTarget), 0);
    const scale = perf.targetInitialOilRate / rawOpening;
    for (const p of producers) p.productivityIndex = p.kh * scale;

    const economicWells = new Set(ev.economicLimit.wells);
    const upliftMonth = Math.max(0, Math.round(
        (parseIsoDate(ev.injectionUplift.date) - time.start) / 86400000 / 30.4375));

    const workovers = ev.workovers.map(w => ({
        well: w.well,
        from: Math.max(0, Math.round((parseIsoDate(w.from) - time.start) / 86400000 / 30.4375)),
        months: w.months
    }));

    // Series, all monthly.
    const series = {};
    const track = (key) => (series[key] = new Float64Array(months));
    for (const p of producers) {
        for (const k of ['WOPR', 'WWPR', 'WLPR', 'WGPR', 'WBHP', 'WWCT', 'WOPT']) track(`${p.name}:${k}`);
    }
    for (const inj of injectors) {
        for (const k of ['WWIR', 'WBHP', 'WWIT']) track(`${inj.name}:${k}`);
    }
    for (const k of ['FOPR', 'FWPR', 'FLPR', 'FGPR', 'FWIR', 'FOPT', 'FWPT', 'FGPT', 'FWIT',
        'FWCT', 'FPR', 'FOIP', 'FOE']) track(`FIELD:${k}`);

    const ctPv = f.totalCompressibility * grid.poreVolume;

    let pressure = f.initialPressure;
    let cumOilRm3 = 0, cumWaterRm3 = 0, cumInjRm3 = 0, cumAquiferRm3 = 0;
    let np = 0, wp = 0, gp = 0, wi = 0;

    for (let m = 0; m < months; m++) {
        const days = time.monthlyDays[m];

        // --- injectors: on rate control, so the target is met unless the well is down ---------
        let injTotal = 0;
        for (const inj of injectors) {
            const ramp = Math.min(1, (m + 1) / ev.rampMonths);
            const uplift = m >= upliftMonth ? ev.injectionUplift.factor : 1;
            const down = workovers.some(w =>
                w.well === inj.name && m >= w.from && m < w.from + w.months);

            const rate = down ? 0 : inj.rateTarget * ramp * uplift;
            injTotal += rate;

            series[`${inj.name}:WWIR`][m] = rate;
            // Injection bottom-hole pressure tracks reservoir pressure plus the drawdown needed to
            // push the target away, so it rises as the pattern fills and dips during a workover.
            series[`${inj.name}:WBHP`][m] = down ? pressure : pressure + 35 + 0.02 * rate;

            const previousTotal = m > 0 ? series[`${inj.name}:WWIT`][m - 1] : 0;
            series[`${inj.name}:WWIT`][m] = previousTotal + rate * days;

            wi += rate * days;
        }

        // --- producers: on bottom-hole pressure control ----------------------------------------
        let oilTotal = 0, waterTotal = 0, gasTotal = 0;

        for (const p of producers) {
            const alreadyShut = p.shutInMonth !== null && m >= p.shutInMonth;

            const waterCut = f.maximumWaterCut /
                (1 + Math.exp(-perf.waterCutSteepness * (m - p.breakthroughMonth)));

            if (!alreadyShut && economicWells.has(p.name) && waterCut >= ev.economicLimit.waterCutLimit) {
                // The shut-in date is a result of the model, not a date written into the deck.
                p.shutInMonth = m;
                p.shutInDate = time.monthly[m];
                p.shutInWaterCut = waterCut;
            }

            const shut = p.shutInMonth !== null && m >= p.shutInMonth;

            let liquid = 0;
            if (!shut) {
                const drawdown = pressure + p.__support - p.bhpTarget;
                liquid = drawdown <= 0 ? 0 : p.productivityIndex
                    * relativeMobility(waterCut, f.viscosityOil, f.viscosityWater)
                    * drawdown;
            }

            const oil = liquid * (1 - waterCut);
            const water = liquid * waterCut;

            // Solution gas only. Above the bubble point the producing ratio is Rs; below it, gas
            // breaks out of solution in the reservoir and the ratio climbs.
            const gasOilRatio = pressure >= f.bubblePointPressure
                ? f.rs
                : f.rs * (1 + 2.5 * (f.bubblePointPressure - pressure) / f.bubblePointPressure);

            series[`${p.name}:WOPR`][m] = oil;
            series[`${p.name}:WWPR`][m] = water;
            series[`${p.name}:WLPR`][m] = liquid;
            series[`${p.name}:WGPR`][m] = oil * gasOilRatio;
            series[`${p.name}:WWCT`][m] = liquid === 0 ? 0 : waterCut;
            // On bottom-hole-pressure control the flowing pressure IS the target, which is itself
            // worth showing. Once shut, the well builds back up towards reservoir pressure.
            series[`${p.name}:WBHP`][m] = shut ? pressure : p.bhpTarget;

            const prevOpt = m > 0 ? series[`${p.name}:WOPT`][m - 1] : 0;
            series[`${p.name}:WOPT`][m] = prevOpt + oil * days;

            oilTotal += oil;
            waterTotal += water;
            gasTotal += oil * gasOilRatio;
        }

        // --- material balance -------------------------------------------------------------------
        np += oilTotal * days;
        wp += waterTotal * days;
        gp += gasTotal * days;

        cumOilRm3 += oilTotal * days * f.bo;
        cumWaterRm3 += waterTotal * days * f.bw;
        cumInjRm3 += injTotal * days * f.bw;
        cumAquiferRm3 += f.aquiferStrength * (f.initialPressure - pressure) * days;

        series['FIELD:FOPR'][m] = oilTotal;
        series['FIELD:FWPR'][m] = waterTotal;
        series['FIELD:FLPR'][m] = oilTotal + waterTotal;
        series['FIELD:FGPR'][m] = gasTotal;
        series['FIELD:FWIR'][m] = injTotal;
        series['FIELD:FOPT'][m] = np;
        series['FIELD:FWPT'][m] = wp;
        series['FIELD:FGPT'][m] = gp;
        series['FIELD:FWIT'][m] = wi;
        series['FIELD:FWCT'][m] = (oilTotal + waterTotal) === 0
            ? 0
            : waterTotal / (oilTotal + waterTotal);
        series['FIELD:FPR'][m] = pressure;
        series['FIELD:FOIP'][m] = grid.stoiip - np;
        series['FIELD:FOE'][m] = np / grid.stoiip;

        // Advance the tank last, so FPR above is the pressure these rates were actually computed
        // at — which also makes FPR[0] the deck's initial pressure rather than one month into
        // depletion.
        const voidage = cumOilRm3 + cumWaterRm3 - cumInjRm3 - cumAquiferRm3;
        pressure = Math.max(f.initialPressure * 0.5, f.initialPressure - voidage / ctPv);
    }

    // Month ranges each well is down, for the grid-viewer's well markers (a shut well draws a
    // cross instead of its usual cone) — `to: Infinity` for an economic shut-in since there is no
    // scheduled end to it, unlike a workover's fixed window.
    for (const p of producers) {
        p.downPeriods = p.shutInMonth !== null ? [{ from: p.shutInMonth, to: Infinity }] : [];
    }
    for (const inj of injectors) {
        inj.downPeriods = workovers
            .filter(w => w.well === inj.name)
            .map(w => ({ from: w.from, to: w.from + w.months }));
    }

    return series;
}

/* -------------------------------------------------------- summary vector metadata ------------- */

// Mirrors EclipseReader/Summary/SummaryVectorVerboseNameLookup.cs: a keyword lookup crossed with
// the class letter, so WOPR reads "Well Oil Production Rate" and FOPT "Field Oil Production Total".
const KEYWORD_NAMES = {
    OPR: 'Oil Production Rate', OPT: 'Oil Production Total',
    WPR: 'Water Production Rate', WPT: 'Water Production Total',
    GPR: 'Gas Production Rate', GPT: 'Gas Production Total',
    LPR: 'Liquid Production Rate', LPT: 'Liquid Production Total',
    WIR: 'Water Injection Rate', WIT: 'Water Injection Total',
    BHP: 'Bottom Hole Pressure', THP: 'Tubing Head Pressure',
    WCT: 'Water Cut', GOR: 'Gas Oil Ratio',
    PR: 'Pressure', OIP: 'Oil In Place', OE: 'Oil Recovery Efficiency'
};

const CLASS_PREFIX = { F: 'Field', W: 'Well', G: 'Group', R: 'Region' };

// Units follow EclipseReader/Units/EclipseMetricUnitSystem.cs.
const KEYWORD_UNITS = {
    OPR: 'm3/day', WPR: 'm3/day', GPR: 'm3/day', LPR: 'm3/day', WIR: 'm3/day',
    OPT: 'sm3', WPT: 'sm3', GPT: 'sm3', LPT: 'sm3', WIT: 'sm3', OIP: 'sm3',
    BHP: 'barsa', THP: 'barsa', PR: 'barsa',
    GOR: 'sm3/sm3',
    WCT: '', OE: ''
};

const KEYWORD_QUANTITY = {
    OPR: 'RateLiquidSurfaceVolume', WPR: 'RateLiquidSurfaceVolume',
    LPR: 'RateLiquidSurfaceVolume', WIR: 'RateLiquidSurfaceVolume',
    GPR: 'RateGasSurfaceVolume', GPT: 'VolumeGasSurface',
    OPT: 'VolumeLiquidSurface', WPT: 'VolumeLiquidSurface',
    LPT: 'VolumeLiquidSurface', WIT: 'VolumeLiquidSurface', OIP: 'VolumeLiquidSurface',
    BHP: 'PressureAbs', THP: 'PressureAbs', PR: 'PressureAbs',
    GOR: 'GasLiquidRatio'
};

function describe(mnemonic) {
    const observed = mnemonic.length > 1 && mnemonic.endsWith('H');
    const base = observed ? mnemonic.slice(0, -1) : mnemonic;
    const classLetter = base[0];
    const keyword = base.slice(1);

    const prefix = CLASS_PREFIX[classLetter] || '';
    const keywordName = KEYWORD_NAMES[keyword] || keyword;

    return {
        observed,
        units: KEYWORD_UNITS[keyword] ?? '',
        quantityTag: KEYWORD_QUANTITY[keyword] || null,
        verboseName: `${prefix} ${keywordName}${observed ? ' (Observed)' : ''}`.trim()
    };
}

/* ---------------------------------------------------------------- observed vectors ------------- */

// Observed data is the simulated series with a bias and coarser noise, deliberately sparse and
// partly stale. Real history is: some months were never reported, and some readings are the
// previous one carried forward. Without both, "Show Observed Data" and "Hide Repeated Observed
// Data" would be toggles that visibly do nothing.
function buildObserved(values, cfg, rand) {
    const out = new Float64Array(values.length);
    let previous = NaN;

    for (let m = 0; m < values.length; m++) {
        const missing = rand() < cfg.missingFraction;
        if (missing) {
            out[m] = NaN;
            continue;
        }

        if (rand() < cfg.repeatedFraction && Number.isFinite(previous)) {
            out[m] = previous;
            continue;
        }

        const v = values[m] * cfg.bias * (1 + cfg.noise * gaussian(rand));
        out[m] = v < 0 ? 0 : v;
        previous = out[m];
    }

    return out;
}

/* -------------------------------------------------------------------- assembly ----------------- */

function buildVectors(deck, grid, wells, series, time, rand) {
    const vectors = [];

    const add = (classType, member, mnemonic, values) => {
        const meta = describe(mnemonic);
        const vector = {
            classType,
            member,
            subMember: null,
            name: mnemonic,
            caseName: deck.caseName,
            units: meta.units,
            quantityTag: meta.quantityTag,
            verboseName: meta.verboseName,
            observed: meta.observed,
            complementary: null,
            times: time.monthly,
            values
        };
        vectors.push(vector);
        return vector;
    };

    for (const w of wells) {
        const keys = w.type === 'Producer'
            ? ['WOPR', 'WWPR', 'WLPR', 'WGPR', 'WBHP', 'WWCT', 'WOPT']
            : ['WWIR', 'WBHP', 'WWIT'];
        for (const k of keys) add('Wells', w.name, k, series[`${w.name}:${k}`]);
    }

    for (const k of ['FOPR', 'FWPR', 'FLPR', 'FGPR', 'FWIR', 'FOPT', 'FWPT', 'FGPT', 'FWIT',
        'FWCT', 'FPR', 'FOIP', 'FOE']) {
        add('Field', 'FIELD', k, series[`FIELD:${k}`]);
    }

    // Observed counterparts. Ordered explicitly — producers by deck order, then the field — so the
    // random stream does not depend on how the vector list happens to be arranged.
    const observedTargets = [
        ...deck.wells.filter(w => w.type === 'Producer').map(w => ({
            classType: 'Wells', member: w.name, simulated: 'WOPR', history: 'WOPRH'
        })),
        { classType: 'Field', member: 'FIELD', simulated: 'FOPR', history: 'FOPRH' }
    ];

    for (const t of observedTargets) {
        const simulated = vectors.find(v =>
            v.classType === t.classType && v.member === t.member && v.name === t.simulated);
        const history = add(t.classType, t.member, t.history,
            buildObserved(simulated.values, deck.observed, rand));

        // Mirrors ISummaryVector.ComplementaryVector: the pairing the product uses to show
        // observed data alongside a simulated curve.
        simulated.complementary = history;
        history.complementary = simulated;
    }

    return vectors;
}

/* --------------------------------------------------------------- public interface -------------- */

let pending = null;

async function build() {
    // No cache override: the static file middleware serves an ETag, so the browser revalidates
    // cheaply and an edited deck is picked up on reload. 'force-cache' would serve a stale deck
    // indefinitely, which is maddening while the model is being developed.
    const response = await fetch(DECK_URL);
    if (!response.ok) throw new Error(`demo model: deck fetch failed (${response.status})`);
    const deck = await response.json();

    // One stream for the grid, a second for the observed vectors, so that changing how many
    // observed series exist cannot alter the reservoir.
    const grid = buildGrid(deck, mulberry32(deck.seed));
    const wells = buildWells(deck, grid);
    const time = buildTime(deck);

    deck.__time = time;
    const series = runPhysics(deck, grid, wells);
    const vectors = buildVectors(deck, grid, wells, series, time,
        mulberry32(deck.seed ^ 0x5f3759df));

    // A third, independent stream — so adding or resizing this generator can never shift the
    // summary vectors' random draws, or vice versa.
    const gridDynamic = buildGridDynamics(deck, grid, wells, series, time,
        mulberry32(deck.seed ^ 0x2545f491));

    const byKey = new Map(vectors.map(v => [`${v.classType}|${v.member}|${v.name}`, v]));

    return {
        deck,
        caseName: deck.caseName,
        simulator: deck.simulator,
        unitSystem: deck.unitSystem,
        grid,
        wells,
        time,
        vectors,
        gridDynamic,

        // A named grid property at a solution step: { values, units, range }. classType mirrors
        // the summary vectors' own shape even though there is only ever one class here.
        gridProperty(name, stepIndex) {
            const step = gridDynamic.steps[stepIndex];
            if (!step || !step[name]) return null;
            const units = name === 'PRESSURE' ? 'barsa' : '';
            return { values: step[name], units, range: gridDynamic.ranges[name] };
        },

        // 'shut' or 'open' as of a grid solution step — hides the step→month mapping here rather
        // than leaking time.solutionIndices bookkeeping into the grid-viewer demo.
        wellStatusAt(well, stepIndex) {
            const month = time.solutionIndices[stepIndex];
            return well.downPeriods.some(p => month >= p.from && month < p.to) ? 'shut' : 'open';
        },

        vector(classType, member, name) {
            return byKey.get(`${classType}|${member}|${name}`) || null;
        },

        // Mirrors SearchProperty: the dimensions a picker offers.
        members(classType) {
            return [...new Set(vectors
                .filter(v => v.classType === classType)
                .map(v => v.member))];
        },

        mnemonics(classType) {
            return [...new Set(vectors
                .filter(v => v.classType === classType && !v.observed)
                .map(v => v.name))];
        }
    };
}

/** Loads the shared synthetic model. Single-flight: concurrent callers share one build. */
export function loadModel() {
    if (!pending) pending = build();
    return pending;
}

/**
 * FNV-1a over the first `count` summary values, in a fixed vector order. The determinism guard:
 * any accidental Math.random, Date.now or locale dependency changes this immediately.
 */
export function hashSummary(model, count = 1000) {
    let hash = 0x811c9dc5;
    let seen = 0;

    for (const v of model.vectors) {
        for (let m = 0; m < v.values.length && seen < count; m++, seen++) {
            // Quantise before hashing: the last bits of a float are not a meaningful part of the
            // contract, and would make the hash fragile across engines.
            const text = Number.isFinite(v.values[m]) ? v.values[m].toFixed(4) : 'NaN';
            for (let c = 0; c < text.length; c++) {
                hash ^= text.charCodeAt(c);
                hash = Math.imul(hash, 0x01000193) >>> 0;
            }
        }
        if (seen >= count) break;
    }

    return hash >>> 0;
}
