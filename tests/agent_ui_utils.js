import { SELECTORS } from '../selectors.js';

function getOrderedContexts(cdp) {
    const primary = cdp.contexts.filter(ctx =>
        (ctx.url && ctx.url.includes(SELECTORS.CONTEXT_URL_KEYWORD)) ||
        (ctx.name && ctx.name.includes('Extension'))
    );
    const ordered = primary.length > 0
        ? [...primary, ...cdp.contexts.filter(ctx => !primary.includes(ctx))]
        : [...cdp.contexts];

    const seen = new Set();
    return ordered.filter(ctx => {
        if (seen.has(ctx.id)) return false;
        seen.add(ctx.id);
        return true;
    });
}

export async function injectMessage(cdp, text) {
    const safeText = JSON.stringify(text);
    const EXP = `(async () => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};

        function getTargetDocs() {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (!(iframes[i].src || '').includes('cascade-panel')) continue;
                try {
                    if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument);
                } catch (e) {}
            }
            return docs;
        }

        function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            if (el.offsetParent === null && style.position !== 'fixed') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function isSubmitButton(btn) {
            if (!btn || btn.disabled || !isVisible(btn)) return false;
            const svg = btn.querySelector('svg');
            if (svg) {
                const cls = (svg.getAttribute('class') || '') + ' ' + (btn.getAttribute('class') || '');
                if (SELECTORS.SUBMIT_BUTTON_SVG_CLASSES.some(c => cls.includes(c))) return true;
            }
            const txt = (btn.innerText || btn.getAttribute('aria-label') || '').trim().toLowerCase();
            if (['send', 'run', 'submit'].includes(txt)) return true;
            return false;
        }

        function getSnapshot(doc, editor) {
            const stopVisible = Array.from(doc.querySelectorAll('button, [role="button"]')).some(b => {
                if (!isVisible(b)) return false;
                const txt = ((b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase());
                return txt === 'stop' || txt.includes('stop generation');
            });
            return {
                editorChars: ((editor && editor.innerText) || '').trim().length,
                cancelVisible: Boolean(doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]')),
                stopVisible
            };
        }

        function fillEditor(doc, editor, value) {
            editor.focus();
            const selection = window.getSelection();
            const range = doc.createRange();
            range.selectNodeContents(editor);
            selection.removeAllRanges();
            selection.addRange(range);

            let inserted = false;
            try {
                inserted = doc.execCommand('insertText', false, value);
            } catch (e) {}
            if (!inserted) {
                editor.textContent = value;
                try {
                    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: value }));
                    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
                } catch (e) {
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
        }

        function pressEnter(editor) {
            const eventInit = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
            editor.dispatchEvent(new KeyboardEvent('keydown', eventInit));
            editor.dispatchEvent(new KeyboardEvent('keypress', eventInit));
            editor.dispatchEvent(new KeyboardEvent('keyup', eventInit));
        }

        async function trySubmit(doc, editor) {
            const before = getSnapshot(doc, editor);
            const submit = Array.from(doc.querySelectorAll('button, [role="button"]')).find(isSubmitButton);
            let method = 'enter';

            if (submit) {
                submit.click();
                method = 'click';
            } else {
                pressEnter(editor);
            }

            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 300));
                const after = getSnapshot(doc, editor);
                const submitted =
                    after.cancelVisible ||
                    after.stopVisible ||
                    (before.editorChars > 0 && after.editorChars === 0);
                if (submitted) return { ok: true, method };
            }

            if (method !== 'enter') {
                pressEnter(editor);
                for (let i = 0; i < 8; i++) {
                    await new Promise(r => setTimeout(r, 300));
                    const after = getSnapshot(doc, editor);
                    const submitted =
                        after.cancelVisible ||
                        after.stopVisible ||
                        (before.editorChars > 0 && after.editorChars === 0);
                    if (submitted) return { ok: true, method: 'enter' };
                }
            }

            return { ok: false, error: 'submit_not_confirmed' };
        }

        for (const doc of getTargetDocs()) {
            const editors = Array.from(doc.querySelectorAll(SELECTORS.CHAT_INPUT)).filter(isVisible);
            const editor = editors.at(-1);
            if (!editor) continue;

            fillEditor(doc, editor, ${safeText});
            await new Promise(r => setTimeout(r, 400));
            const result = await trySubmit(doc, editor);
            if (result.ok) return result;
        }

        return { ok: false, error: 'No editor or submission not confirmed' };
    })()`;

    for (const ctx of getOrderedContexts(cdp)) {
        try {
            const res = await cdp.call('Runtime.evaluate', { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value?.ok) return res.result.value;
        } catch (e) {}
    }
    return { ok: false, error: 'Injection failed in all contexts' };
}

export async function startNewChat(cdp) {
    const EXP = `(async () => {
        function getTargetDocs() {
            const docs = [{ source: 'document', doc: document }];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (!(iframes[i].src || '').includes('cascade-panel')) continue;
                try {
                    if (iframes[i].contentDocument) docs.push({ source: 'cascade_iframe', doc: iframes[i].contentDocument });
                } catch (e) {}
            }
            return docs;
        }

        function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            if (el.offsetParent === null && style.position !== 'fixed') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function snapshot(doc) {
            const editors = Array.from(doc.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)')).filter(isVisible);
            const editor = editors.at(-1);
            return {
                editorChars: ((editor && editor.innerText) || '').trim().length
            };
        }

        const selectors = [
            '[data-tooltip-id="new-conversation-tooltip"]',
            '[data-tooltip-id*="new-chat"]',
            '[data-tooltip-id*="new_chat"]',
            '[aria-label*="New Chat"]',
            '[aria-label*="New Conversation"]'
        ];

        for (const item of getTargetDocs()) {
            const doc = item.doc;
            for (const sel of selectors) {
                const btn = doc.querySelector(sel);
                if (!btn) continue;
                if (!isVisible(btn) || btn.disabled) continue;

                const before = snapshot(doc);
                const dispatch = (type, Cls) => {
                    try {
                        if (typeof Cls === 'function') {
                            btn.dispatchEvent(new Cls(type, { bubbles: true, cancelable: true, view: window, buttons: 1 }));
                        }
                    } catch (e) {}
                };

                dispatch('pointerdown', PointerEvent);
                dispatch('mousedown', MouseEvent);
                dispatch('pointerup', PointerEvent);
                dispatch('mouseup', MouseEvent);
                dispatch('click', MouseEvent);
                try { btn.click(); } catch (e) {}

                await new Promise(r => setTimeout(r, 700));

                let confirmClicked = null;
                const confirmKeywords = ['start new', 'new chat', 'new conversation', 'discard', 'continue', 'ok', 'yes'];
                const modalButtons = Array.from(doc.querySelectorAll('button, [role="button"]')).filter(isVisible);
                for (const b of modalButtons) {
                    const txt = ((b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase());
                    if (!txt) continue;
                    if (confirmKeywords.some(k => txt.includes(k))) {
                        try {
                            b.click();
                            confirmClicked = txt.slice(0, 80);
                            break;
                        } catch (e) {}
                    }
                }

                await new Promise(r => setTimeout(r, 900));
                const after = snapshot(doc);
                const changed = before.editorChars > 0 && after.editorChars === 0;
                const success = changed || Boolean(confirmClicked) || before.editorChars === 0;
                return {
                    success,
                    method: sel,
                    docSource: item.source,
                    changed,
                    confirmClicked
                };
            }
        }

        return { success: false, reason: 'button_not_found' };
    })()`;

    for (const ctx of getOrderedContexts(cdp)) {
        try {
            const res = await cdp.call('Runtime.evaluate', { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) {}
    }
    return { success: false, reason: 'not_found_or_not_interactable' };
}

async function checkIsGenerating(cdp) {
    const EXP = `(() => {
        function getTargetDocs() {
            const docs = [document];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (!(iframes[i].src || '').includes('cascade-panel')) continue;
                try {
                    if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument);
                } catch (e) {}
            }
            return docs;
        }

        function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            if (el.offsetParent === null && style.position !== 'fixed') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        for (const doc of getTargetDocs()) {
            const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (cancel && isVisible(cancel)) return true;

            const buttons = Array.from(doc.querySelectorAll('button, [role="button"]'));
            for (const b of buttons) {
                if (!isVisible(b)) continue;
                const txt = ((b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase());
                if (txt === 'stop' || txt.includes('stop generation')) return true;
            }
        }
        return false;
    })()`;

    for (const ctx of getOrderedContexts(cdp)) {
        try {
            const res = await cdp.call('Runtime.evaluate', { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value === true) return true;
        } catch (e) {}
    }
    return false;
}

export async function waitForGenerationStart(cdp, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await checkIsGenerating(cdp)) return true;
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}

export async function getChatSnapshot(cdp) {
    const EXP = `(() => {
        const titleEl = document.querySelector('p.text-ide-sidebar-title-color');
        const sendCancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        return {
            title: titleEl ? (titleEl.innerText || '').trim() : null,
            generatingIndicator: Boolean(sendCancel)
        };
    })()`;

    for (const ctx of getOrderedContexts(cdp)) {
        try {
            const res = await cdp.call('Runtime.evaluate', { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value) return res.result.value;
        } catch (e) {}
    }
    return { title: null, generatingIndicator: false };
}
