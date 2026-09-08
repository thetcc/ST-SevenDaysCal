export const QIANQIANJIE_BRIDGE_KEY = 'qqj_v3_public_bridge_v1';

const clean = (value, maximum = 500) => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);

export function captureQianQianJieHostIdentity(context) {
    const characterId = context?.characterId;
    const character = Array.isArray(context?.characters) ? context.characters[characterId] : context?.characters?.[characterId];
    return Object.freeze({
        hostChatId: String(context?.chatId ?? context?.getCurrentChatId?.() ?? '').trim(),
        characterLocator: String(character?.avatar ?? context?.characterAvatar ?? '').trim(),
        personaLocator: String(context?.userAvatar ?? context?.personaAvatar ?? '').trim(),
    });
}

export function sameQianQianJieHostIdentity(left, right) {
    return !!left && !!right
        && left.hostChatId === right.hostChatId
        && left.characterLocator === right.characterLocator
        && (!left.personaLocator || !right.personaLocator || left.personaLocator === right.personaLocator);
}

function emptyResult(status, message, extra = {}) {
    return Object.freeze({ status, text: '', message: clean(message), ...extra });
}

export function createQianQianJieMemoryAccess({ globalRef = globalThis, contextProvider, isSelected = () => true } = {}) {
    if (typeof contextProvider !== 'function') throw new TypeError('千千结记忆适配器缺少宿主上下文');
    const selected = () => {
        try { return isSelected() === true; } catch { return false; }
    };
    const currentBridge = () => globalRef?.[QIANQIANJIE_BRIDGE_KEY];
    function status() {
        const api = currentBridge();
        if (!api || api.schemaVersion !== 1 || api.kind !== 'qqj-public-memory-bridge' || typeof api.readMemory !== 'function') {
            return emptyResult('api-unavailable', '检测不到千千结只读记忆接口');
        }
        if (typeof api.getStatus !== 'function') return emptyResult('ready', '千千结只读接口已就绪');
        try {
            const value = api.getStatus();
            return emptyResult(value?.status || 'not-ready', value?.message || '千千结当前状态未知');
        } catch { return emptyResult('not-ready', '千千结只读接口暂未就绪'); }
    }
    async function result() {
        const before = captureQianQianJieHostIdentity(contextProvider());
        const api = currentBridge();
        if (!api || api.schemaVersion !== 1 || api.kind !== 'qqj-public-memory-bridge' || typeof api.readMemory !== 'function') {
            return emptyResult('api-unavailable', '检测不到千千结只读记忆接口');
        }
        if (!selected()) return emptyResult('stale', '记忆源已切换');
        let value;
        try { value = await api.readMemory(); }
        catch (error) { return emptyResult('read-failed', error?.message || '千千结记忆读取失败'); }
        const after = captureQianQianJieHostIdentity(contextProvider());
        if (!selected() || currentBridge() !== api || !sameQianQianJieHostIdentity(before, after)) {
            return emptyResult('stale', '读取期间当前聊天或记忆源已变化');
        }
        const sourceIdentity = value?.identity;
        if (sourceIdentity && (sourceIdentity.hostChatId !== before.hostChatId
            || sourceIdentity.characterLocator !== before.characterLocator
            || (before.personaLocator && sourceIdentity.personaLocator !== before.personaLocator))) {
            return emptyResult('stale', '千千结返回的宿主聊天身份已变化');
        }
        const text = typeof value?.text === 'string' ? value.text.trim() : '';
        if (value?.status === 'ready' && text) {
            return Object.freeze({ status: 'ready', text, message: '', identity: sourceIdentity ?? null, anchor: value.anchor ?? null, coverage: value.coverage ?? null });
        }
        return emptyResult(value?.status || 'empty', value?.message || '当前聊天还没有千千结正式记忆', { identity: sourceIdentity ?? null, coverage: value?.coverage ?? null });
    }
    return Object.freeze({ status, result, async text() { return (await result()).text; } });
}

export function qianQianJieMemoryDiagnostic(result) {
    switch (result?.status) {
        case 'ready': return '千千结记忆已就绪';
        case 'api-unavailable': return '检测不到千千结只读记忆接口：请确认千千结已安装并启用';
        case 'disabled': return '千千结当前已关闭';
        case 'not-ready': return result?.message || '千千结尚未准备好当前聊天';
        case 'empty':
        case 'unavailable': return result?.message || '当前聊天还没有千千结正式记忆';
        case 'stale': return '当前聊天或记忆源已变化，请重新生成';
        case 'read-failed':
        case 'error': return result?.message ? `千千结记忆读取失败：${result.message}` : '千千结记忆读取失败';
        default: return result?.message || '千千结记忆状态未知';
    }
}
