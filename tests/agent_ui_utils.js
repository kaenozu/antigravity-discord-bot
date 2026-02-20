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

async function evaluateInOrderedContexts(cdp, expression, awaitPromise = false) {
    for (const ctx of getOrderedContexts(cdp)) {
        try {
            const res = await cdp.call('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise,
                contextId: ctx.id
            });
            if (res?.result?.value) {
                return { value: res.result.value, contextId: ctx.id };
            }
        } catch (e) {}
    }
    return { value: null, contextId: null };
}

function domHelpersExpr() {
    return `
        function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            if (el.offsetParent === null && style.position !== 'fixed') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }

        function norm(v) {
            return String(v || '').trim().toLowerCase();
        }

        function getTargetDocs() {
            const docs = [{ source: 'document', doc: document }];
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                const src = iframes[i].src || '';
                if (!src.includes('cascade-panel')) continue;
                try {
                    if (iframes[i].contentDocument) docs.push({ source: 'cascade_iframe', doc: iframes[i].contentDocument });
                } catch (e) {}
            }
            return docs;
        }

        function isSendLikeButton(btn, SELECTORS) {
            if (!btn || !isVisible(btn)) return false;
            const svg = btn.querySelector('svg');
            const cls = (
                (btn.getAttribute('class') || '') + ' ' +
                (svg ? (svg.getAttribute('class') || '') : '')
            ).toLowerCase();
            if (SELECTORS.SUBMIT_BUTTON_SVG_CLASSES.some(c => cls.includes(String(c).toLowerCase()))) return true;

            const txt = norm(btn.innerText || btn.getAttribute('aria-label') || btn.getAttribute('title'));
            if (txt === 'send' || txt === 'run' || txt === 'submit') return true;

            const tip = norm(btn.getAttribute('data-tooltip-id'));
            if (tip.includes('send')) return true;
            return false;
        }

        function findComposerInDoc(doc, SELECTORS) {
            const editors = Array.from(doc.querySelectorAll(SELECTORS.CHAT_INPUT)).filter(isVisible);
            if (editors.length === 0) return null;

            const candidates = [];
            for (const editor of editors) {
                let node = editor;
                let container = null;
                let sendButton = null;

                for (let depth = 0; depth < 10 && node; depth++) {
                    const buttons = Array.from(node.querySelectorAll('button, [role="button"]')).filter(b => isVisible(b));
                    const sendLike = buttons.find(btn => isSendLikeButton(btn, SELECTORS));
                    if (sendLike) {
                        container = node;
                        sendButton = sendLike;
                        break;
                    }
                    node = node.parentElement;
                }

                if (!container) continue;
                const rect = editor.getBoundingClientRect();
                candidates.push({ editor, container, sendButton, editorTop: rect.top });
            }

            if (candidates.length === 0) return null;
            candidates.sort((a, b) => b.editorTop - a.editorTop);
            return candidates[0];
        }

        function getBestLayout(SELECTORS) {
            const docs = getTargetDocs();
            for (const item of docs) {
                const found = findComposerInDoc(item.doc, SELECTORS);
                if (found) {
                    return { ...found, doc: item.doc, docSource: item.source };
                }
            }
            return null;
        }

        function hasGenerationIndicator(doc, container) {
            const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (cancel && isVisible(cancel)) return true;

            const scope = container || doc;
            const buttons = Array.from(scope.querySelectorAll('button, [role="button"]'));
            for (const btn of buttons) {
                if (!isVisible(btn)) continue;
                const txt = norm(btn.innerText || btn.getAttribute('aria-label'));
                if (txt === 'stop' || txt.includes('stop generation')) return true;
            }
            return false;
        }

        function getChatSnapshot(SELECTORS) {
            const layout = getBestLayout(SELECTORS);
            if (!layout) {
                return {
                    layoutRecognized: false,
                    reason: 'chat_layout_not_found',
                    title: null,
                    generatingIndicator: false
                };
            }

            const titleEl = layout.doc.querySelector('p.text-ide-sidebar-title-color');
            return {
                layoutRecognized: true,
                reason: 'ok',
                docSource: layout.docSource,
                title: titleEl ? (titleEl.innerText || '').trim() : null,
                generatingIndicator: hasGenerationIndicator(layout.doc, layout.container)
            };
        }
    `;
}

export async function injectMessage(cdp, text) {
    const safeText = JSON.stringify(text);
    const EXP = `(async () => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        ${domHelpersExpr()}

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

        const layout = getBestLayout(SELECTORS);
        if (!layout) {
            return { ok: false, error: 'chat_layout_not_found' };
        }

        const beforeEditorChars = (layout.editor.innerText || '').trim().length;
        fillEditor(layout.doc, layout.editor, ${safeText});
        await new Promise(r => setTimeout(r, 250));
        const insertedChars = (layout.editor.innerText || '').trim().length;
        if (insertedChars === 0) {
            return { ok: false, error: 'input_not_applied' };
        }

        let method = 'enter';
        let clickedSend = false;
        for (let i = 0; i < 8; i++) {
            if (layout.sendButton && !layout.sendButton.disabled && isVisible(layout.sendButton)) {
                layout.sendButton.click();
                method = 'click';
                clickedSend = true;
                break;
            }
            await new Promise(r => setTimeout(r, 150));
        }

        if (!clickedSend) {
            pressEnter(layout.editor);
            method = 'enter';
        }

        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 250));
                const afterEditorChars = (layout.editor.innerText || '').trim().length;
                if (
                    hasGenerationIndicator(layout.doc, layout.container) ||
                    (insertedChars > 0 && afterEditorChars === 0) ||
                    (beforeEditorChars > 0 && afterEditorChars === 0)
                ) {
                    return { ok: true, method, layout: layout.docSource };
                }
        }

        return { ok: false, error: 'submit_not_confirmed' };
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, true);
    if (value?.ok) return value;
    return { ok: false, error: value?.error || 'injection_failed' };
}

export async function startNewChat(cdp) {
    const EXP = `(async () => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        ${domHelpersExpr()}

        const selectors = [
            '[data-tooltip-id="new-conversation-tooltip"]',
            '[data-tooltip-id*="new-chat"]',
            '[data-tooltip-id*="new_chat"]',
            '[aria-label*="New Chat"]',
            '[aria-label*="New Conversation"]'
        ];

        const before = getChatSnapshot(SELECTORS);
        if (!before.layoutRecognized) {
            return { success: false, reason: 'chat_layout_not_found' };
        }

        for (const item of getTargetDocs()) {
            const doc = item.doc;
            for (const sel of selectors) {
                const btn = doc.querySelector(sel);
                if (!btn || !isVisible(btn) || btn.disabled) continue;

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
                    const txt = norm(b.innerText || b.getAttribute('aria-label'));
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
                const after = getChatSnapshot(SELECTORS);
                if (!after.layoutRecognized) {
                    return { success: false, reason: 'layout_lost_after_new_chat' };
                }

                return {
                    success: true,
                    method: sel,
                    docSource: item.source,
                    confirmClicked
                };
            }
        }

        return { success: false, reason: 'button_not_found' };
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, true);
    if (value?.success) return value;
    return { success: false, reason: value?.reason || 'new_chat_failed' };
}

async function checkIsGenerating(cdp) {
    const EXP = `(() => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        ${domHelpersExpr()}

        const snapshot = getChatSnapshot(SELECTORS);
        return Boolean(snapshot.layoutRecognized && snapshot.generatingIndicator);
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false);
    return value === true;
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
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        ${domHelpersExpr()}
        return getChatSnapshot(SELECTORS);
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false);
    return value || {
        layoutRecognized: false,
        reason: 'snapshot_failed',
        title: null,
        generatingIndicator: false
    };
}
