export const QIANQIANJIE_BRIDGE_KEY = 'qqj_v3_public_bridge_v1';
export const QIANQIANJIE_READ_TIMEOUT_MS = 15000;

const PEOPLE_PROFILE_FIELDS = Object.freeze([
    ['name', '姓名'],
    ['aliases', '档案别名'],
    ['gender', '性别'],
    ['age', '年龄'],
    ['birthday', '生日'],
    ['species', '种族'],
    ['notes', '补充资料'],
    ['height', '身高'],
    ['build', '体型'],
    ['face', '面容'],
    ['hair', '发型发色'],
    ['eyes', '眼睛'],
    ['distinctiveFeatures', '辨识特征'],
    ['clothingStyle', '衣着风格'],
    ['appearance', '外貌补充'],
    ['occupation', '职业'],
    ['organization', '所属组织'],
    ['socialIdentity', '社会身份'],
    ['background', '背景经历'],
    ['identityRelations', '重要身份关系'],
    ['personality', '核心性格'],
    ['conduct', '处事方式'],
    ['expression', '表达习惯'],
    ['likes', '喜好'],
    ['dislikes', '厌恶'],
    ['principles', '原则与底线'],
    ['nsfw', '成人向资料'],
]);

const STATE_CATEGORY_LABELS = Object.freeze({ core: '核心状态', adaptive: '适应状态', situational: '情境状态' });
const STATE_ACTION_LABELS = Object.freeze({ add: '增加', update: '更新', refine: '调整', remove: '移除' });
const STATE_ORIGIN_LABELS = Object.freeze({ baseline: '初始设定', floor: '当楼内容', reasonableProgression: '合理进展', manual: '用户纠正' });

const clean = (value, maximum = 500) => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);

const promptText = value => String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim();

const promptLine = value => promptText(value).replace(/[ \t]*\n+[ \t]*/g, ' / ').replace(/[ \t]+/g, ' ');

const aliasText = value => promptLine(typeof value === 'string' ? value : value?.name);

function snapshotIdentityConflicts(memoryIdentity, snapshotIdentity) {
    if (!memoryIdentity || !snapshotIdentity) return false;
    return ['hostChatId', 'qqjChatId', 'characterLocator', 'personaLocator'].some(field =>
        memoryIdentity[field] != null
        && snapshotIdentity[field] != null
        && memoryIdentity[field] !== snapshotIdentity[field]);
}

function stateBoundary(value, subjectName) {
    const visibility = promptLine(value?.visibility);
    if (visibility === 'private') return `仅 ${subjectName} 本人知情`;
    if (visibility === 'authorial') return '作者参考，不代表任何人物知情';
    if (visibility === 'shared') return '已共享';
    if (visibility === 'expressed') return '已表达';
    if (visibility === 'observable') return '可观察';
    return visibility ? `未识别边界（${visibility}）` : '未标明知情边界';
}

function formatStateSide(value, subjectName) {
    if (!value || typeof value !== 'object') return '无';
    const parts = [];
    const text = promptLine(value.text);
    const reason = promptLine(value.reason);
    const origin = promptLine(value.origin);
    const toward = promptLine(value.towardDisplayName);
    if (text) parts.push(`正文：${text}`);
    parts.push(`知情边界：${stateBoundary(value, subjectName)}`);
    if (reason) parts.push(`依据：${reason}`);
    if (origin) parts.push(`来源类型：${STATE_ORIGIN_LABELS[origin] || origin}`);
    if (toward) parts.push(`指向人物：${toward}`);
    if (Number.isSafeInteger(value.sourceAssistantSeq) && value.sourceAssistantSeq > 0) parts.push(`来源 AI #${value.sourceAssistantSeq}`);
    return parts.join('；');
}

function formatPeopleProfiles(people) {
    const rows = [];
    for (const person of Array.isArray(people?.items) ? people.items : []) {
        if (!person?.profile || typeof person.profile !== 'object') continue;
        const displayName = promptLine(person.displayName);
        if (!displayName) continue;
        const details = [];
        const aliases = [...new Set((Array.isArray(person.aliases) ? person.aliases : []).map(aliasText).filter(Boolean))];
        if (aliases.length) details.push(`当前别名：${aliases.join('、')}`);
        for (const [field, label] of PEOPLE_PROFILE_FIELDS) {
            const value = promptLine(person.profile[field]);
            if (value) details.push(`${label}：${value}`);
        }
        if (!details.length) continue;
        rows.push(`- ${displayName}`, ...details.map(detail => `  - ${detail}`));
    }
    if (!rows.length) return '';
    return [
        '[千千结人物详细资料]',
        '以下是已经保存的人物长期档案；未在“千人”中关注但已经建档的人物也会保留。',
        ...rows,
    ].join('\n');
}

function formatCseHistory(snapshot, memoryResult) {
    const snapshotCheckpoint = snapshot?.memory?.headCheckpointId;
    const memoryCheckpoint = memoryResult?.anchor?.headCheckpointId;
    if (snapshot?.memory?.status !== 'ready'
        || typeof snapshotCheckpoint !== 'string' || !snapshotCheckpoint
        || typeof memoryCheckpoint !== 'string' || !memoryCheckpoint
        || snapshotCheckpoint !== memoryCheckpoint) return '';
    const rows = [];
    const floors = (Array.isArray(snapshot?.cse?.floors) ? snapshot.cse.floors : [])
        .map((floor, index) => ({ floor, index }))
        .sort((left, right) => {
            const leftSeq = Number.isSafeInteger(left.floor?.assistantSeq) ? left.floor.assistantSeq : Number.MAX_SAFE_INTEGER;
            const rightSeq = Number.isSafeInteger(right.floor?.assistantSeq) ? right.floor.assistantSeq : Number.MAX_SAFE_INTEGER;
            if (leftSeq !== rightSeq) return leftSeq - rightSeq;
            const leftIndex = Number.isSafeInteger(left.floor?.messageIndex) ? left.floor.messageIndex : Number.MAX_SAFE_INTEGER;
            const rightIndex = Number.isSafeInteger(right.floor?.messageIndex) ? right.floor.messageIndex : Number.MAX_SAFE_INTEGER;
            return leftIndex === rightIndex ? left.index - right.index : leftIndex - rightIndex;
        });
    for (const { floor } of floors) {
        if (floor?.changesKnown !== true || !Array.isArray(floor.changes)) continue;
        const subjects = [];
        for (const subject of floor.changes) {
            if (!Array.isArray(subject?.changes) || !subject.changes.length) continue;
            const subjectName = promptLine(subject.displayName) || '未知人物';
            const changes = [];
            for (const change of subject.changes) {
                if (!change || typeof change !== 'object') continue;
                const category = promptLine(change.category);
                const action = promptLine(change.action);
                const before = formatStateSide(change.before, subjectName);
                const after = formatStateSide(change.after, subjectName);
                if (!category && !action && before === '无' && after === '无') continue;
                changes.push(`  - ${subjectName} / ${STATE_CATEGORY_LABELS[category] || category || '层次未标明'} / ${STATE_ACTION_LABELS[action] || action || '动作未标明'}`);
                changes.push(`    - 变化前：${before}`);
                changes.push(`    - 变化后：${after}`);
            }
            subjects.push(...changes);
        }
        if (!subjects.length) continue;
        const labels = [];
        if (Number.isSafeInteger(floor.assistantSeq) && floor.assistantSeq > 0) labels.push(`AI #${floor.assistantSeq}`);
        else labels.push('AI 序号未知');
        if (Number.isSafeInteger(floor.messageIndex) && floor.messageIndex >= 0) labels.push(`聊天楼号 ${floor.messageIndex}`);
        rows.push(`- ${labels.join('；')}`, ...subjects);
    }
    if (!rows.length) return '';
    return [
        '[千千结当楼历史变化]',
        '以下是各 AI 楼当时保存的状态变化。后文可能已经覆盖这些旧变化，不代表当前状态；请保留每条记录标明的知情边界。',
        ...rows,
    ].join('\n');
}

export function formatQianQianJieSnapshotEnhancement(snapshot, memoryResult) {
    if (!snapshot || snapshot.status !== 'ready') return '';
    return [formatPeopleProfiles(snapshot.people), formatCseHistory(snapshot, memoryResult)].filter(Boolean).join('\n\n');
}

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

export function createQianQianJieMemoryAccess({ globalRef = globalThis, contextProvider, isSelected = () => true, readTimeoutMs = QIANQIANJIE_READ_TIMEOUT_MS } = {}) {
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
    async function result({ signal = null, timeoutMs = readTimeoutMs } = {}) {
        const before = captureQianQianJieHostIdentity(contextProvider());
        const api = currentBridge();
        if (!api || api.schemaVersion !== 1 || api.kind !== 'qqj-public-memory-bridge' || typeof api.readMemory !== 'function') {
            return emptyResult('api-unavailable', '检测不到千千结只读记忆接口');
        }
        if (!selected()) return emptyResult('stale', '记忆源已切换');
        if (signal?.aborted) return emptyResult('cancelled', '本次记忆读取已取消');
        let value;
        const deadline = Math.max(1, Number(timeoutMs) || QIANQIANJIE_READ_TIMEOUT_MS);
        try {
            value = await new Promise((resolve, reject) => {
                let settled = false;
                let timer = null;
                const finish = (callback, payload) => {
                    if (settled) return;
                    settled = true;
                    if (timer !== null) clearTimeout(timer);
                    signal?.removeEventListener?.('abort', onAbort);
                    callback(payload);
                };
                const onAbort = () => finish(reject, Object.assign(new Error('qqj-memory-read-cancelled'), { name: 'AbortError' }));
                timer = setTimeout(() => finish(reject, Object.assign(new Error('qqj-memory-read-timeout'), { name: 'TimeoutError' })), deadline);
                signal?.addEventListener?.('abort', onAbort, { once: true });
                let pending;
                try { pending = api.readMemory(); }
                catch (error) { finish(reject, error); return; }
                Promise.resolve(pending).then(
                    resultValue => finish(resolve, resultValue),
                    error => finish(reject, error),
                );
            });
        } catch (error) {
            if (error?.name === 'AbortError') return emptyResult('cancelled', '本次记忆读取已取消');
            if (error?.name === 'TimeoutError') return emptyResult('timed-out', '等待千千结记忆超时');
            return emptyResult('read-failed', error?.message || '千千结记忆读取失败');
        }
        const sourceIdentity = value?.identity;
        const text = typeof value?.text === 'string' ? value.text.trim() : '';
        let enhancement = '';
        if (value?.status === 'ready' && text) {
            if (typeof api.getSnapshot === 'function') {
                try {
                    const snapshot = api.getSnapshot();
                    if (snapshot?.status === 'ready') {
                        if (snapshotIdentityConflicts(sourceIdentity, snapshot.identity)) {
                            return emptyResult('stale', '千千结记忆与结构化快照的聊天身份不一致');
                        }
                        enhancement = formatQianQianJieSnapshotEnhancement(snapshot, value);
                    }
                } catch {}
            }
        }
        const after = captureQianQianJieHostIdentity(contextProvider());
        if (!selected() || currentBridge() !== api || !sameQianQianJieHostIdentity(before, after)) {
            return emptyResult('stale', '读取期间当前聊天或记忆源已变化');
        }
        if (sourceIdentity && (sourceIdentity.hostChatId !== before.hostChatId
            || sourceIdentity.characterLocator !== before.characterLocator
            || (before.personaLocator && sourceIdentity.personaLocator !== before.personaLocator))) {
            return emptyResult('stale', '千千结返回的宿主聊天身份已变化');
        }
        if (value?.status === 'ready' && text) {
            return Object.freeze({ status: 'ready', text: enhancement ? `${text}\n\n${enhancement}` : text, message: '', identity: sourceIdentity ?? null, anchor: value.anchor ?? null, coverage: value.coverage ?? null, reader: api });
        }
        return emptyResult(value?.status || 'empty', value?.message || '当前聊天还没有千千结正式记忆', { identity: sourceIdentity ?? null, coverage: value?.coverage ?? null, reader: api });
    }
    return Object.freeze({ status, result, reader: currentBridge, async text(options) { return (await result(options)).text; } });
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
        case 'cancelled': return '本次千千结记忆读取已取消';
        case 'timed-out': return '等待千千结记忆超时';
        case 'read-failed':
        case 'error': return result?.message ? `千千结记忆读取失败：${result.message}` : '千千结记忆读取失败';
        default: return result?.message || '千千结记忆状态未知';
    }
}
