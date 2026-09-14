export function createLinesRuntime({ render = value => value } = {}) {
    let busy = false;
    let controller = null;
    let label = '';
    let cachedRaw = '';
    let cachedHtml = '';
    return {
        get busy() { return busy; },
        get controller() { return controller; },
        get raw() { return cachedRaw; },
        get html() { return cachedHtml; },
        get label() { return label; },
        start(nextController, nextLabel = '') { controller = nextController || null; label = String(nextLabel || ''); busy = true; return controller; },
        cache(raw) { cachedRaw = String(raw || ''); cachedHtml = render(cachedRaw); return cachedHtml; },
        setHtml(html) { cachedHtml = String(html || ''); return cachedHtml; },
        finish(ownerController = controller) { if (ownerController && controller !== ownerController) return false; controller = null; label = ''; busy = false; return true; },
        abort(reason = 'manual-abort') { controller?.abort?.(reason); controller = null; label = ''; busy = false; },
        reset() { controller = null; label = ''; busy = false; cachedRaw = ''; cachedHtml = ''; },
    };
}
