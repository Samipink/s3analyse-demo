// Development-only assertions over the shared synthetic model.
//
// Not a test framework and not shipped behaviour: this exists because the model's invariants are
// the kind of thing that breaks silently. A wrong conservation sum or a shut-in that quietly stops
// happening still draws a plausible-looking chart, and nobody notices until a showcase paragraph
// quotes a figure that no longer holds.
//
// Run by appending ?demoSelfCheck=1 to any page, or from the console:
//     const { runSelfCheck } = await import('/js/demos/selfcheck.js'); await runSelfCheck();

import { loadModel, hashSummary } from './model.js';

// The determinism guard. Any accidental Math.random, Date.now or locale dependency in the
// generation path changes this value immediately. If a deliberate model change alters it, update
// the constant in the same commit and say so in the message.
const EXPECTED_SUMMARY_HASH = 2293139621;

const MS_PER_DAY = 86400000;

function isoDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

export async function runSelfCheck() {
    const model = await loadModel();

    const failures = [];
    const check = (condition, description) => {
        if (!condition) failures.push(description);
    };

    const { deck, grid, wells, time } = model;
    const producers = wells.filter(w => w.type === 'Producer');
    const injectors = wells.filter(w => w.type === 'Injector');

    /* ---------------------------------------------------------------------- time ------------- */

    check(time.monthly.length === 192, `expected 192 monthly points, got ${time.monthly.length}`);
    check(isoDay(time.monthly[0]) === '2019-01-01',
        `summary starts ${isoDay(time.monthly[0])}, expected 2019-01-01`);
    check(isoDay(time.monthly[time.monthly.length - 1]) === '2034-12-01',
        `summary ends ${isoDay(time.monthly[time.monthly.length - 1])}, expected 2034-12-01`);

    let increasing = true;
    for (let m = 1; m < time.monthly.length; m++) {
        if (time.monthly[m] <= time.monthly[m - 1]) increasing = false;
    }
    check(increasing, 'summary dates are not strictly increasing');

    check(time.solution.length === 16, `expected 16 solution steps, got ${time.solution.length}`);
    check(time.solutionIndices.every((v, n) => v === n * 12),
        'solution steps are not annual samples of the monthly series');

    /* ---------------------------------------------------------------------- grid ------------- */

    check(grid.cellCount === 31 * 21 * 10, `grid should be 6510 cells, got ${grid.cellCount}`);
    check(grid.activeCellCount < grid.cellCount, 'no cells were deactivated');
    check(grid.activeCellCount > grid.cellCount * 0.98,
        `too many inactive cells (${grid.cellCount - grid.activeCellCount})`);

    // Inactive cells must be confined to the top layer, which is what the deck says.
    let inactiveBelowTop = 0;
    for (let k = 1; k < grid.nk; k++) {
        for (let j = 0; j < grid.nj; j++) {
            for (let i = 0; i < grid.ni; i++) {
                if (!grid.active[grid.index(i, j, k)]) inactiveBelowTop++;
            }
        }
    }
    check(inactiveBelowTop === 0, `${inactiveBelowTop} inactive cells below the top layer`);
    check(grid.poreVolume > 0, 'pore volume is not positive');

    /* --------------------------------------------------------------------- wells ------------- */

    const expectedNames = [
        'Prod_1', 'Prod_2', 'Prod_3', 'Prod_4', 'Prod_5', 'Prod_6',
        'Inj_1', 'Inj_2', 'Inj_3', 'Inj_4', 'Inj_5', 'Inj_6'
    ].sort();
    const actualNames = wells.map(w => w.name).sort();
    check(JSON.stringify(actualNames) === JSON.stringify(expectedNames),
        `well names are ${actualNames.join(', ')}`);

    check(producers.length === 6, `expected 6 producers, got ${producers.length}`);
    check(injectors.length === 6, `expected 6 injectors, got ${injectors.length}`);

    const deviated = wells.filter(w => w.deviated);
    check(deviated.length === 4, `expected 4 deviated wells, got ${deviated.length}`);

    for (const w of wells) {
        check(w.track.length === grid.nk, `${w.name}: track does not span all layers`);
        check(w.completions.length > 0, `${w.name}: no completions`);
        check(w.completions.length <= grid.nk, `${w.name}: more completions than layers`);
        check(w.completions.every(c => grid.active[grid.index(c.i, c.j, c.k)] === 1),
            `${w.name}: completion in an inactive cell`);
        check(w.kh > 0, `${w.name}: kh is not positive`);
    }

    // A deviated well must actually move; a vertical one must not.
    for (const w of wells) {
        const moved = w.track.some(c => c.i !== w.track[0].i || c.j !== w.track[0].j);
        check(moved === w.deviated,
            `${w.name}: deviated=${w.deviated} but track ${moved ? 'moves' : 'is vertical'}`);
    }

    /* ------------------------------------------------------------------ shut-ins ------------- */

    const shut = producers.filter(p => p.shutInMonth !== null);
    check(shut.length === 2, `expected 2 shut-in producers, got ${shut.length}`);
    check(shut.every(p => deck.events.economicLimit.wells.includes(p.name)),
        'a well shut in that carries no economic limit');

    const limit = deck.events.economicLimit.waterCutLimit;

    for (const p of shut) {
        const oil = model.vector('Wells', p.name, 'WOPR').values;
        const waterCut = model.vector('Wells', p.name, 'WWCT').values;

        check(oil[p.shutInMonth] === 0, `${p.name}: rate is not exactly zero at shut-in`);
        check(oil.slice(p.shutInMonth).every(v => v === 0),
            `${p.name}: produces again after being shut in`);
        check(oil.slice(0, p.shutInMonth).every(v => v > 0),
            `${p.name}: has a zero rate before being shut in`);

        // The triggering water cut, not the reported one: WWCT is zero once the well is shut,
        // and the month before is by definition still under the limit.
        check(p.shutInWaterCut >= limit,
            `${p.name}: shut in at ${p.shutInWaterCut} water cut, below the ${limit} limit`);
        check(waterCut[p.shutInMonth - 1] < limit,
            `${p.name}: was already over the limit before the month it shut in`);
    }

    // Producers with no economic limit must keep producing however wet they get — otherwise the
    // limit is not doing the work and the shut-ins are an accident of something else.
    for (const p of producers.filter(w => !deck.events.economicLimit.wells.includes(w.name))) {
        check(p.shutInMonth === null, `${p.name}: shut in without an economic limit`);
        const cut = model.vector('Wells', p.name, 'WWCT').values;
        check(cut[cut.length - 1] > limit,
            `${p.name}: never exceeds the limit, so the shut-in wells are not a fair comparison`);
    }

    /* -------------------------------------------------------------- conservation ------------- */

    const fieldOil = model.vector('Field', 'FIELD', 'FOPR').values;
    const fieldWater = model.vector('Field', 'FIELD', 'FWPR').values;
    const fieldCut = model.vector('Field', 'FIELD', 'FWCT').values;
    const fieldTotal = model.vector('Field', 'FIELD', 'FOPT').values;
    const pressure = model.vector('Field', 'FIELD', 'FPR').values;

    let worstOilError = 0;
    let worstCutError = 0;
    for (let m = 0; m < fieldOil.length; m++) {
        const summed = producers.reduce((s, p) =>
            s + model.vector('Wells', p.name, 'WOPR').values[m], 0);
        worstOilError = Math.max(worstOilError, Math.abs(summed - fieldOil[m]));

        const liquid = fieldOil[m] + fieldWater[m];
        const expectedCut = liquid === 0 ? 0 : fieldWater[m] / liquid;
        worstCutError = Math.max(worstCutError, Math.abs(expectedCut - fieldCut[m]));
    }
    check(worstOilError < 1e-6, `FOPR does not equal the sum of WOPR (worst ${worstOilError})`);
    check(worstCutError < 1e-9, `FWCT is inconsistent with FOPR/FWPR (worst ${worstCutError})`);

    let monotonic = true;
    for (let m = 1; m < fieldTotal.length; m++) {
        if (fieldTotal[m] < fieldTotal[m - 1]) monotonic = false;
    }
    check(monotonic, 'FOPT is not monotonically non-decreasing');
    check(fieldCut.every(v => v >= 0 && v <= 1), 'FWCT falls outside [0, 1]');

    /* --------------------------------------------------------- finite-value guard ------------ */

    // A single non-finite value silently blanks an entire SVG path, so this is the cheapest guard
    // against the most confusing possible symptom. Observed vectors are exempt: their gaps are
    // deliberate and the renderer is required to break the line at them.
    for (const v of model.vectors) {
        if (v.observed) continue;
        const bad = Array.prototype.findIndex.call(v.values, x => !Number.isFinite(x));
        check(bad === -1,
            `${v.member} ${v.name}: non-finite value at index ${bad}`);
    }

    /* ---------------------------------------------------------- observed vectors ------------- */

    const observedOil = model.vector('Field', 'FIELD', 'FOPRH');
    check(observedOil !== null, 'FOPRH was not built');
    if (observedOil) {
        const gaps = Array.prototype.filter.call(observedOil.values, v => !Number.isFinite(v)).length;
        check(gaps > 0, 'observed data has no gaps, so "Show Observed Data" would look simulated');

        let repeats = 0;
        for (let m = 1; m < observedOil.values.length; m++) {
            if (Number.isFinite(observedOil.values[m])
                && observedOil.values[m] === observedOil.values[m - 1]) repeats++;
        }
        check(repeats > 0,
            'observed data repeats nothing, so "Hide Repeated Observed Data" would do nothing');

        check(observedOil.complementary?.name === 'FOPR',
            'FOPRH is not paired with FOPR as its complementary vector');
    }

    /* -------------------------------------------------------------- determinism -------------- */

    const hash = hashSummary(model);
    if (EXPECTED_SUMMARY_HASH !== null) {
        check(hash === EXPECTED_SUMMARY_HASH,
            `summary hash is ${hash}, expected ${EXPECTED_SUMMARY_HASH} — the model changed`);
    }

    /* ------------------------------------------------------------------- report -------------- */

    const facts = {
        summaryHash: hash,
        cells: `${grid.ni} x ${grid.nj} x ${grid.nk} = ${grid.cellCount}`,
        activeCells: grid.activeCellCount,
        poreVolumeMm3: +(grid.poreVolume / 1e6).toFixed(2),
        stoiipMm3: +(grid.stoiip / 1e6).toFixed(2),
        openingOilRate: +fieldOil[0].toFixed(1),
        peakOilRate: +Math.max(...fieldOil).toFixed(1),
        finalOilRate: +fieldOil[fieldOil.length - 1].toFixed(1),
        initialPressure: +pressure[0].toFixed(1),
        finalPressure: +pressure[pressure.length - 1].toFixed(1),
        crossesBubblePoint: pressure.some(p => p < deck.fluids.bubblePointPressure),
        recoveryFactor: +(fieldTotal[fieldTotal.length - 1] / grid.stoiip).toFixed(3),
        breakthroughMonths: producers.map(p => ({
            well: p.name,
            month: Math.round(p.breakthroughMonth),
            completions: p.completions.length
        })),
        shutIns: shut.map(p => ({ well: p.name, month: p.shutInMonth, date: isoDay(p.shutInDate) })),
        vectorCount: model.vectors.length
    };

    if (failures.length === 0) {
        console.log('%cdemo model self-check: passed', 'color: green; font-weight: bold');
    } else {
        console.error(`demo model self-check: ${failures.length} failure(s)`);
        for (const f of failures) console.error('  ' + f);
    }
    console.table(facts.breakthroughMonths);
    console.log(facts);

    return { passed: failures.length === 0, failures, facts };
}

// Auto-run when asked for via the query string, so the check is reachable on any page without a
// console. Costs nothing otherwise.
if (typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('demoSelfCheck') === '1') {
    runSelfCheck();
}
