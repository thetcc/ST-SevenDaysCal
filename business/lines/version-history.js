export const LINE_HISTORY_LIMIT = 10;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

export function normalizeLineGeneratedAt(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

export function normalizeLineHistory(history, { excludeRaw, limit = LINE_HISTORY_LIMIT } = {}) {
    const recent = [];
    for (const item of Array.isArray(history) ? history : []) {
        if (!item || typeof item !== 'object' || !own(item, 'raw')) continue;
        const raw = String(item.raw ?? '');
        if (excludeRaw !== undefined && raw === excludeRaw) continue;
        const duplicate = recent.findIndex(entry => entry.raw === raw);
        if (duplicate >= 0) recent.splice(duplicate, 1);
        recent.push({ raw, generatedAt: normalizeLineGeneratedAt(item.generatedAt) });
    }
    return recent.slice(-Math.max(0, Number(limit) || LINE_HISTORY_LIMIT));
}

export function snapshotLineStore(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
    if (own(source, 'raw')) source.raw = String(source.raw ?? '');
    if (own(source, 'generatedAt')) source.generatedAt = normalizeLineGeneratedAt(source.generatedAt);
    if (own(source, 'history')) source.history = normalizeLineHistory(source.history, { excludeRaw: own(source, 'raw') ? source.raw : undefined });
    return source;
}

export function freezeLineStore(value) {
    const freeze = node => {
        if (!node || typeof node !== 'object' || Object.isFrozen(node)) return node;
        for (const child of Object.values(node)) freeze(child);
        return Object.freeze(node);
    };
    return freeze(snapshotLineStore(value));
}

export function lineStoreMatches(left, right) {
    return JSON.stringify(snapshotLineStore(left)) === JSON.stringify(snapshotLineStore(right));
}

function withMetadata(value) {
    const next = snapshotLineStore(value);
    next.generatedAt = own(next, 'generatedAt') ? normalizeLineGeneratedAt(next.generatedAt) : null;
    next.history = normalizeLineHistory(next.history, { excludeRaw: own(next, 'raw') ? next.raw : undefined });
    return next;
}

export function changeCurrentLineStore(value, raw, {
    now = Date.now(),
    generatedAt,
    archiveCurrent = false,
    removeTargetFromHistory = true,
} = {}) {
    const current = withMetadata(value);
    const targetRaw = String(raw ?? '');
    const currentHasRaw = own(current, 'raw');
    if (currentHasRaw && current.raw === targetRaw) return { changed: false, value: current };
    let history = normalizeLineHistory(current.history);
    if (removeTargetFromHistory) history = history.filter(item => item.raw !== targetRaw);
    if (archiveCurrent && currentHasRaw) {
        history = normalizeLineHistory([...history, { raw: current.raw, generatedAt: current.generatedAt }], { excludeRaw: targetRaw });
    } else {
        history = normalizeLineHistory(history, { excludeRaw: targetRaw });
    }
    return {
        changed: true,
        value: {
            ...current,
            raw: targetRaw,
            ts: Number(now),
            generatedAt: generatedAt === undefined ? current.generatedAt : normalizeLineGeneratedAt(generatedAt),
            history,
        },
    };
}

export function generatedLineStore(value, raw, now = Date.now()) {
    return changeCurrentLineStore(value, raw, { now, generatedAt: now, archiveCurrent: true });
}

export function retiredLineStore(value, raw, now = Date.now()) {
    return changeCurrentLineStore(value, raw, { now, archiveCurrent: true });
}

export function manualLineStore(value, raw, now = Date.now()) {
    return changeCurrentLineStore(value, raw, { now, archiveCurrent: false });
}

export function restoreLineHistoryVersion(value, index, now = Date.now()) {
    const current = withMetadata(value);
    const history = normalizeLineHistory(current.history, { excludeRaw: own(current, 'raw') ? current.raw : undefined });
    const selected = history[Number(index)];
    if (!selected) return { ok: false, reason: 'missing-version', value: current };
    const withoutSelected = history.filter((_, itemIndex) => itemIndex !== Number(index));
    const changed = changeCurrentLineStore({ ...current, history: withoutSelected }, selected.raw, {
        now,
        generatedAt: selected.generatedAt,
        archiveCurrent: true,
    });
    return { ok: changed.changed, reason: changed.changed ? '' : 'same-current', value: changed.value };
}
