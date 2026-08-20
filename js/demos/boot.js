// Entry point for the interactive demos.
//
// The site uses static server rendering, so there is no Blazor circuit and no @onclick — but
// blazor.web.js IS loaded, which means enhanced navigation is on: following an internal link
// replaces the DOM without a page load. DOMContentLoaded therefore fires only on a hard load, so a
// widget mounted there silently disappears the first time someone clicks a sidebar link.
// theme.js sidesteps this with document-level delegation; a demo cannot, so it needs a real
// mount/unmount lifecycle. Hooking 'enhancedload' is the whole reason this file exists.
//
// A demo module is fetched only when a page actually contains one, so pages without a demo pay
// nothing beyond this file.

const LOADERS = {
    'line-plot': () => import('./line-plot.js'),
    'grid-viewer': () => import('./grid-viewer.js')
};

const mounted = new WeakMap();

function readConfig(figure) {
    const script = figure.querySelector('script[type="application/json"][data-demo-config]');
    if (!script) return {};
    try {
        return JSON.parse(script.textContent);
    } catch (error) {
        console.error('demo: malformed configuration', error);
        return {};
    }
}

async function mountOne(figure) {
    const kind = figure.dataset.demo;
    const loader = LOADERS[kind];
    if (!loader) return;

    figure.dataset.demoMounted = 'pending';

    try {
        const module = await loader();
        // Progressive enhancement by addition: the screenshot is in the DOM and visible until a
        // mount actually succeeds. If the module fails to load, the deck fetch fails, or the
        // browser is too old, the page stays exactly as it was.
        const unmount = await module.mount(figure, readConfig(figure));
        mounted.set(figure, unmount);
        figure.dataset.demoMounted = 'yes';
    } catch (error) {
        console.error(`demo "${kind}" failed to mount; leaving the static figure in place`, error);
        delete figure.dataset.demoMounted;
    }
}

function mountAll() {
    document.querySelectorAll('[data-demo]:not([data-demo-mounted])').forEach(mountOne);
}

function unmountDetached() {
    // Enhanced navigation discards the old DOM wholesale. Anything the demo attached to window or
    // document has to be released here, or it leaks once per navigation.
    for (const figure of document.querySelectorAll('[data-demo-mounted]')) {
        if (!figure.isConnected) {
            const unmount = mounted.get(figure);
            if (unmount) unmount();
            mounted.delete(figure);
        }
    }
}

mountAll();

if (window.Blazor && typeof Blazor.addEventListener === 'function') {
    Blazor.addEventListener('enhancedload', () => {
        unmountDetached();
        mountAll();
    });
}
