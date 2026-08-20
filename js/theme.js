// Light/dark theme toggle.
//
// Deliberately tiny and framework-free: the site uses static server rendering, so there is
// no Blazor circuit to handle an @onclick. Event delegation on document means the handler
// survives enhanced-navigation DOM replacement without needing to be re-attached.
(function () {
    'use strict';

    var STORAGE_KEY = 'theme';

    function currentTheme() {
        var explicit = document.documentElement.getAttribute('data-theme');
        if (explicit === 'dark' || explicit === 'light') return explicit;

        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch (e) { /* storage unavailable — the choice just won't persist */ }

        document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
            button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
            button.setAttribute('title', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
        });
    }

    document.addEventListener('click', function (event) {
        var toggle = event.target.closest('[data-theme-toggle]');
        if (!toggle) return;

        event.preventDefault();
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });

    // Sync the button state on first load without overriding an unset (system) preference.
    document.addEventListener('DOMContentLoaded', function () {
        var theme = currentTheme();
        document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
            button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        });
    });

    // Enhanced navigation (clicking a sidebar link) patches the page from the server's response
    // rather than reloading it — and the server has no way to know the visitor's saved theme,
    // since that lives only in localStorage. Its rendered <html> carries no data-theme at all,
    // so the patch was silently dropping the attribute the toggle had set, and the page fell
    // back to light on every navigation. Re-asserting the saved theme after each enhanced load
    // is the fix — this does not flip anything, only restores what should already be showing.
    if (window.Blazor && typeof Blazor.addEventListener === 'function') {
        Blazor.addEventListener('enhancedload', function () {
            var saved;
            try {
                saved = localStorage.getItem(STORAGE_KEY);
            } catch (e) { /* storage unavailable */ }

            if (saved === 'dark' || saved === 'light') {
                document.documentElement.setAttribute('data-theme', saved);
            }

            var theme = currentTheme();
            document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
                button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
            });
        });
    }
})();
