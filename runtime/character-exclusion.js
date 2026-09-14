// Per-character runtime exclusion. The persisted identity is the exact avatar
// filename, which is stable across character-list reordering and separates
// cards that share the same display name.

export const CHARACTER_EXCLUSION_KEY = 'characterExcludeAvatars';

export function excludedCharacterSet(settings = {}) {
    return new Set((Array.isArray(settings[CHARACTER_EXCLUSION_KEY]) ? settings[CHARACTER_EXCLUSION_KEY] : [])
        .filter(value => typeof value === 'string' && value.length > 0));
}

export function currentCharacterAvatar(context = {}) {
    const character = context?.characters?.[context?.characterId];
    return typeof character?.avatar === 'string' && character.avatar.length > 0 ? character.avatar : null;
}

export function isGroupChat(context = {}) {
    return context?.groupId !== null && context?.groupId !== undefined;
}

export function isCharacterExcluded(context = {}, settings = {}) {
    if (isGroupChat(context)) return false;
    const avatar = currentCharacterAvatar(context);
    return !!avatar && excludedCharacterSet(settings).has(avatar);
}

export function effectivePluginEnabled(context = {}, settings = {}) {
    return settings.pluginEnabled !== false && !isCharacterExcluded(context, settings);
}

export function setCharacterExcluded(settings = {}, avatar, excluded) {
    if (typeof avatar !== 'string' || avatar.length === 0) return false;
    const before = excludedCharacterSet(settings);
    const had = before.has(avatar);
    if (excluded) before.add(avatar);
    else before.delete(avatar);
    settings[CHARACTER_EXCLUSION_KEY] = [...before];
    return had !== before.has(avatar);
}

export function characterCardMatches(card = {}, query = '') {
    const needle = String(query || '').trim().toLocaleLowerCase();
    if (!needle) return true;
    return `${String(card.name || '')}\n${String(card.avatar || '')}`.toLocaleLowerCase().includes(needle);
}

export function renderCharacterExclusionRows(cards = [], excluded = new Set(), { escapeHtml = String } = {}) {
    return cards.map(card => {
        const avatar = String(card?.avatar || '');
        if (!avatar) return '';
        const name = String(card?.name || avatar);
        const on = excluded.has(avatar);
        return `<label class="sp-wi-exclude-row${on ? ' sp-wi-exclude-on' : ''}" data-avatar="${escapeHtml(avatar)}" data-search="${escapeHtml(`${name}\n${avatar}`)}" title="角色卡文件：${escapeHtml(avatar)}">\n`
            + `    <input type="checkbox" class="sp-character-exclude-cb" data-avatar="${escapeHtml(avatar)}"${on ? ' checked' : ''}>\n`
            + `    <span class="sp-wi-exclude-name">${escapeHtml(name)}</span>\n`
            + '</label>';
    }).join('');
}
