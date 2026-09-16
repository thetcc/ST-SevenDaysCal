// Native SillyTavern 1.18 chat-file bridge used only when the host does not
// expose Luker's fixed-target patch contract. It keeps a captured chat target,
// saves the complete file with force:false, and trusts only a fixed-target GET
// readback as confirmation.

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const present = value => value !== undefined && value !== null && String(value) !== '';

function responseError(response, payload = null) {
    const status = Number(response?.status);
    return Object.assign(new Error(payload?.message || payload?.error || `聊天文件 HTTP ${status || '错误'}`), {
        ...(Number.isInteger(status) ? { status } : {}),
        code: Number.isInteger(status) ? `http-${status}` : 'host-http-error',
        payload,
    });
}

export function captureNativeChatTarget(ctx) {
    const chatId = present(ctx?.chatId) ? String(ctx.chatId) : '';
    if (!chatId) return null;
    if (present(ctx?.groupId)) {
        return {
            native: true,
            is_group: true,
            groupId: String(ctx.groupId),
            chatId,
            id: chatId,
        };
    }
    if (!present(ctx?.characterId)) return null;
    const character = ctx?.characters?.[ctx.characterId];
    const fileName = present(character?.chat) ? String(character.chat) : '';
    if (!fileName || fileName !== chatId || typeof character?.name !== 'string' || typeof character?.avatar !== 'string') return null;
    return {
        native: true,
        is_group: false,
        chatId,
        characterId: String(ctx.characterId),
        char_name: character.name,
        file_name: fileName,
        avatar_url: character.avatar,
    };
}

export function nativeTargetMatchesContext(target, ctx) {
    if (!target?.native || !ctx || String(ctx.chatId || '') !== String(target.chatId || '')) return false;
    if (target.is_group) {
        return present(ctx.groupId) && String(ctx.groupId) === String(target.groupId);
    }
    if (present(ctx.groupId) || !present(ctx.characterId) || String(ctx.characterId) !== String(target.characterId)) return false;
    const character = ctx.characters?.[ctx.characterId];
    return !!character
        && String(character.chat || '') === String(target.file_name || '')
        && String(character.name ?? '') === String(target.char_name ?? '')
        && String(character.avatar ?? '') === String(target.avatar_url ?? '');
}

export function createNativeExternalChatHostBridge({ getContext = () => null, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    let writeQueue = Promise.resolve();
    const context = () => { try { return getContext?.() || null; } catch { return null; } };
    const headers = () => context()?.getRequestHeaders?.() || {};

    async function readTarget(target) {
        if (!target?.native) throw Object.assign(new Error('原生聊天目标不可用'), { code: 'missing-chat-target' });
        const url = target.is_group ? '/api/chats/group/get' : '/api/chats/get';
        const body = target.is_group
            ? { id: target.chatId }
            : { ch_name: target.char_name, file_name: target.file_name, avatar_url: target.avatar_url };
        let response;
        try {
            response = await fetchImpl(url, { method: 'POST', cache: 'no-cache', headers: headers(), body: JSON.stringify(body) });
        } catch (error) {
            throw Object.assign(new Error('原生聊天文件读取失败'), { code: 'network', cause: error });
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw responseError(response, payload);
        if (!Array.isArray(payload) || !payload.length || !payload[0] || !Object.prototype.hasOwnProperty.call(payload[0], 'chat_metadata')) {
            throw Object.assign(new Error('原生聊天文件缺少有效头部'), { code: 'invalid-chat-file' });
        }
        const header = clone(payload[0]);
        return { header, metadata: clone(header.chat_metadata || {}), messages: clone(payload.slice(1)) };
    }

    function liveBaselineMatches(target, metadataPatch, rootKeys) {
        const live = context();
        if (!nativeTargetMatchesContext(target, live)) return false;
        if (metadataPatch?.expectedMetadata && !same(live.chatMetadata, metadataPatch.expectedMetadata)) return false;
        if (!metadataPatch?.expectedRoots) return true;
        if (String(live.chatId || '') !== String(metadataPatch.expectedChatId || '')) return false;
        if (!same(live.chat, metadataPatch.expectedMessages)) return false;
        return rootKeys.every(key => same(live.chatMetadata?.[key], metadataPatch.expectedRoots[key]));
    }

    function serialized(task) {
        const operation = writeQueue.then(task, task);
        writeQueue = operation.catch(() => {});
        return operation;
    }

    async function publish({ target, beforeMessages, nextMessages, metadataPatch = null, ownerGuard = () => true, rootKeys = [], markerKey, prepareMetadata = null }) {
        return serialized(async () => {
            if (!ownerGuard() || !nativeTargetMatchesContext(target, context())) {
                return { ok: false, reason: 'reply-changed', dispatched: false, commitState: 'not-dispatched' };
            }
            const liveMetadata = prepareMetadata ? clone(context()?.chatMetadata) : null;
            const liveMessages = prepareMetadata ? clone(context()?.chat) : null;
            let baseline;
            try { baseline = await readTarget(target); }
            catch (error) { return { ok: false, reason: error.code || 'host-read-failed', dispatched: false, commitState: 'not-dispatched', error }; }
            if (!baseline.metadata?.integrity) return { ok: false, reason: 'host-snapshot-unavailable', dispatched: false, commitState: 'not-dispatched' };
            if (prepareMetadata) {
                // 普通导入不能用服务器旧头部覆盖尚未落盘的第三方 metadata 或正文。
                if (!same(baseline.metadata, liveMetadata) || !same(baseline.messages, liveMessages)) {
                    return { ok: false, reason: 'live-baseline-conflict', dispatched: false, commitState: 'conflict' };
                }
                const plan = await prepareMetadata(clone(baseline.metadata));
                if (!plan?.ok) return plan;
                beforeMessages = baseline.messages;
                nextMessages = baseline.messages;
                metadataPatch = {
                    replacementRoots: clone(plan.replacementRoots),
                    expectedMetadata: liveMetadata,
                    expectedRoots: Object.fromEntries(rootKeys.map(key => [key, clone(baseline.metadata[key])])),
                    expectedMessages: liveMessages,
                    expectedChatId: target.chatId,
                };
            }
            if (!same(baseline.messages, beforeMessages)) return { ok: false, reason: 'host-message-conflict', dispatched: false, commitState: 'conflict' };
            if (metadataPatch?.expectedRoots && rootKeys.some(key => !same(baseline.metadata[key], metadataPatch.expectedRoots[key]))) {
                return { ok: false, reason: 'host-root-conflict', dispatched: false, commitState: 'conflict' };
            }
            if (!liveBaselineMatches(target, metadataPatch, rootKeys) || !ownerGuard()) {
                return { ok: false, reason: 'live-root-conflict', dispatched: false, commitState: 'conflict' };
            }

            const afterMetadata = clone(baseline.metadata);
            if (metadataPatch) {
                if (metadataPatch.replacementRoots) {
                    for (const [key, value] of Object.entries(metadataPatch.replacementRoots)) afterMetadata[key] = clone(value);
                } else {
                    afterMetadata[markerKey] = clone(metadataPatch.marker);
                    for (const key of rootKeys) delete afterMetadata[key];
                }
            }
            const afterHeader = { ...clone(baseline.header), chat_metadata: afterMetadata };
            const afterState = { header: afterHeader, metadata: afterMetadata, messages: clone(nextMessages) };
            if (same(baseline.header, afterHeader) && same(baseline.messages, nextMessages)) {
                return { ok: true, dispatched: false, commitState: 'confirmed', ...(metadataPatch?.replacementRoots ? { replacementRoots: clone(metadataPatch.replacementRoots) } : {}) };
            }

            // 发出整文件保存前再核对服务器；原生接口没有原子 CAS，integrity
            // 也不随每次修改轮换，GET 到 POST 间的普通并发写仍无法保证拒绝。
            let finalBaseline;
            try { finalBaseline = await readTarget(target); }
            catch (error) { return { ok: false, reason: error.code || 'host-read-failed', dispatched: false, commitState: 'not-dispatched', error }; }
            if (!same(finalBaseline.header, baseline.header) || !same(finalBaseline.messages, baseline.messages)
                || !liveBaselineMatches(target, metadataPatch, rootKeys) || !ownerGuard()) {
                return { ok: false, reason: 'final-baseline-conflict', dispatched: false, commitState: 'conflict' };
            }

            const url = target.is_group ? '/api/chats/group/save' : '/api/chats/save';
            const body = target.is_group
                ? { id: target.chatId, chat: [afterHeader, ...clone(nextMessages)], force: false }
                : { ch_name: target.char_name, file_name: target.file_name, avatar_url: target.avatar_url, chat: [afterHeader, ...clone(nextMessages)], force: false };
            let response = null; let requestError = null; let responsePayload = null;
            try {
                response = await fetchImpl(url, { method: 'POST', cache: 'no-cache', headers: headers(), body: JSON.stringify(body) });
                responsePayload = await response.json().catch(() => null);
            } catch (error) { requestError = error; }

            let readBack = null; let readBackError = null;
            try { readBack = await readTarget(target); }
            catch (error) { readBackError = error; }
            if (readBack && same(readBack.header, afterState.header) && same(readBack.messages, afterState.messages)) {
                return { ok: true, dispatched: true, commitState: 'confirmed', ...(metadataPatch?.replacementRoots ? { replacementRoots: clone(metadataPatch.replacementRoots) } : {}), ...((requestError || !response?.ok) ? { confirmedAfterUnknown: true } : {}) };
            }
            if (readBack && same(readBack.header, baseline.header) && same(readBack.messages, baseline.messages)) {
                const status = Number(response?.status);
                return {
                    ok: false,
                    reason: Number.isInteger(status) && !response.ok ? `http-${status}` : (requestError ? 'network-not-committed' : 'save-not-committed'),
                    ...(Number.isInteger(status) ? { status } : {}),
                    dispatched: true,
                    commitState: status === 409 ? 'conflict' : 'not-dispatched',
                    ...(requestError ? { error: requestError } : {}),
                };
            }
            const status = Number(response?.status);
            const error = requestError || readBackError || (!response?.ok ? responseError(response, responsePayload) : null);
            return {
                ok: false,
                reason: Number.isInteger(status) && !response?.ok ? `http-${status}` : (requestError ? 'network' : 'host-readback-unknown'),
                ...(Number.isInteger(status) ? { status } : {}),
                dispatched: true,
                commitState: 'unknown',
                ...(error ? { error } : {}),
            };
        });
    }

    async function confirmPublished(target, marker, nextMessages, rootKeys, markerKey) {
        try {
            const readBack = await readTarget(target);
            return same(readBack.metadata?.[markerKey], marker)
                && rootKeys.every(key => readBack.metadata?.[key] == null)
                && same(readBack.messages, nextMessages);
        } catch { return false; }
    }

    return Object.freeze({
        captureTarget: () => captureNativeChatTarget(context()),
        isCurrent: target => nativeTargetMatchesContext(target, context()),
        readTarget,
        publish,
        confirmPublished,
    });
}
