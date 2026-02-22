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

async function evaluateInOrderedContexts(cdp, expression, awaitPromise = false, accept = (v) => v !== null && v !== undefined) {
    let lastValue = null;
    let lastContextId = null;
    for (const ctx of getOrderedContexts(cdp)) {
        try {
            const res = await cdp.call('Runtime.evaluate', {
                expression,
                returnByValue: true,
                awaitPromise,
                contextId: ctx.id
            });
            const value = res?.result?.value;
            if (value !== undefined) {
                lastValue = value;
                lastContextId = ctx.id;
            }
            if (accept(value, ctx)) {
                return { value, contextId: ctx.id };
            }
        } catch (e) {
            // Ignore failures from stale/inaccessible contexts and keep probing the rest.
        }
    }
    return { value: lastValue, contextId: lastContextId };
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
                } catch (e) {
                    // Cross-origin iframes can throw on contentDocument access; skip and continue.
                }
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

        function isUiChromeLine(line) {
            const t = norm(line);
            if (!t) return true;
            if (t.startsWith('ask anything,')) return true;
            if (t.startsWith('warning: your antigravity installation')) return true;
            if (t.startsWith('thought for ')) return true;
            if (t === 'analyzed' || t.startsWith('analyzed ')) return true;
            if (t === 'generating' || t === 'generating..' || t === 'generating...' || t.startsWith('generating ')) return true;
            if (t.startsWith('allow directory access')) return true;
            if (t.startsWith('allow file access')) return true;
            if (t.startsWith('allow access to')) return true;
            if (t.startsWith('directory access to')) return true;
            if (t === 'good' || t === 'bad' || t === 'send' || t === 'model' || t === 'new') return true;
            if (t === 'planning' || t === 'fast' || t === 'conversation mode') return true;
            if (t.startsWith('agent can ')) return true;
            if (t.startsWith('gemini ') || t.startsWith('claude ') || t.startsWith('gpt-')) return true;
            return false;
        }

        function splitMeaningfulLines(text) {
            return String(text || '')
                .split('\\n')
                .map(s => s.trim())
                .filter(Boolean)
                .filter(s => s.length >= 12 && !isUiChromeLine(s));
        }

        function isWorkbenchWideText(text) {
            const t = norm(text).replace(/\\s+/g, ' ');
            if (!t) return false;
            return (
                t.includes('file edit selection view go run terminal help') ||
                t.includes('explorer search source control run and debug extensions') ||
                t.includes('open editors')
            );
        }

        function findConversationRoot(SELECTORS, layout) {
            const activeLayout = layout || getBestLayout(SELECTORS);
            if (!activeLayout || !activeLayout.editor) return null;

            let node = activeLayout.container || activeLayout.editor;
            let best = node;
            for (let depth = 0; depth < 12 && node; depth++) {
                node = node.parentElement;
                if (!node) break;
                if (node === activeLayout.doc.body || node === activeLayout.doc.documentElement) break;
                if (!isVisible(node)) continue;
                if (!node.contains(activeLayout.editor)) continue;

                const text = (node.innerText || '').trim();
                if (text.length < 20) continue;
                if (isWorkbenchWideText(text)) break;
                best = node;
            }
            return best;
        }

        function getConversationLines(SELECTORS) {
            const layout = getBestLayout(SELECTORS);
            if (!layout) {
                let best = null;
                let bestCount = -1;
                for (const item of getTargetDocs()) {
                    const doc = item.doc;
                    const body = doc && doc.body ? (doc.body.innerText || '') : '';
                    const lines = splitMeaningfulLines(body);
                    if (lines.length > bestCount) {
                        best = { source: item.source, lines };
                        bestCount = lines.length;
                    }
                }

                if (best && best.lines.length > 0) {
                    return {
                        layoutRecognized: false,
                        fallback: true,
                        reason: 'chat_layout_not_found_using_doc_fallback',
                        lines: best.lines.slice(-200),
                        docSource: best.source,
                        rootTag: null,
                        rootClass: null
                    };
                }
                return { layoutRecognized: false, fallback: false, reason: 'chat_layout_not_found', lines: [] };
            }

            const root = findConversationRoot(SELECTORS, layout) || layout.doc.body;
            if (!root) return { layoutRecognized: true, reason: 'conversation_root_not_found', lines: [] };

            const lines = splitMeaningfulLines(root.innerText || '');
            return {
                layoutRecognized: true,
                reason: lines.length > 0 ? 'ok' : 'conversation_empty',
                lines,
                docSource: layout.docSource,
                rootTag: root.tagName || null,
                rootClass: (root.getAttribute && root.getAttribute('class')) ? String(root.getAttribute('class')).slice(0, 200) : null
            };
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
    await resolveApprovalPromptIfPresent(cdp);
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
            } catch (e) {
                // execCommand may be blocked/deprecated in some Chromium surfaces; use fallback below.
            }
            if (!inserted) {
                editor.textContent = value;
                try {
                    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: value }));
                    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
                } catch (e) {
                    // Some runtimes reject InputEvent construction (e.g., restricted constructors/polyfilled envs).
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

        function tryRestoreChatLayout() {
            const selectors = [
                '[data-tooltip-id="new-conversation-tooltip"]',
                '[data-tooltip-id*="new-chat"]',
                '[data-tooltip-id*="new_chat"]',
                '[aria-label*="New Chat"]',
                '[aria-label*="New Conversation"]'
            ];
            for (const item of getTargetDocs()) {
                for (const sel of selectors) {
                    const btn = item.doc.querySelector(sel);
                    if (btn && isVisible(btn) && !btn.disabled) {
                        try { btn.click(); } catch (e) {
                            // Ignore transient click errors and continue with normal layout recovery flow.
                        }
                        return true;
                    }
                }
            }
            return false;
        }

        let layout = getBestLayout(SELECTORS);
        if (!layout) {
            const recovered = tryRestoreChatLayout();
            if (recovered) {
                await new Promise(r => setTimeout(r, 1200));
                layout = getBestLayout(SELECTORS);
            }
        }
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

    const { value } = await evaluateInOrderedContexts(cdp, EXP, true, (v) => Boolean(v?.ok));
    if (value?.ok) return value;
    return { ok: false, error: value?.error || 'injection_failed' };
}

export async function startNewChat(cdp) {
    await resolveApprovalPromptIfPresent(cdp);
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
                    } catch (e) {
                        // Pointer/mouse constructors can fail across frame contexts; best-effort dispatch.
                    }
                };

                dispatch('pointerdown', PointerEvent);
                dispatch('mousedown', MouseEvent);
                dispatch('pointerup', PointerEvent);
                dispatch('mouseup', MouseEvent);
                dispatch('click', MouseEvent);
                try { btn.click(); } catch (e) {
                    // Ignore and continue; synthetic events above may already trigger the handler.
                }

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
                        } catch (e) {
                            // Some modal buttons detach between query and click; keep searching alternatives.
                        }
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

    const { value } = await evaluateInOrderedContexts(cdp, EXP, true, (v) => Boolean(v?.success));
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

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false, (v) => v === true);
    return value === true;
}

export async function waitForGenerationStart(cdp, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await resolveApprovalPromptIfPresent(cdp);
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

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false, (v) => Boolean(v?.layoutRecognized));
    return value || {
        layoutRecognized: false,
        reason: 'snapshot_failed',
        title: null,
        generatingIndicator: false
    };
}

async function probeAssistantOutput(cdp, promptText) {
    const safePrompt = JSON.stringify(String(promptText || '').trim());
    const EXP = `(() => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        ${domHelpersExpr()}
        const convo = getConversationLines(SELECTORS);
        if (!convo.layoutRecognized && !convo.fallback) {
            return {
                layoutRecognized: false,
                seenPrompt: false,
                outputFound: false,
                outputLine: null,
                reason: convo.reason || 'chat_layout_not_found'
            };
        }

        const prompt = ${safePrompt};
        const lines = convo.lines || [];
        let idx = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].includes(prompt)) {
                idx = i;
                break;
            }
        }

        const pool = idx >= 0 ? lines.slice(idx + 1) : lines;
        const candidates = pool.filter(line => {
            if (!line || line.length < 12) return false;
            if (line.includes(prompt)) return false;
            if (isUiChromeLine(line)) return false;
            return true;
        });

        return {
            layoutRecognized: Boolean(convo.layoutRecognized),
            usedFallback: Boolean(convo.fallback),
            seenPrompt: idx >= 0,
            outputFound: candidates.length > 0,
            outputLine: candidates.length > 0 ? candidates[candidates.length - 1].slice(0, 300) : null,
            candidateLines: candidates.slice(-40),
            rootTag: convo.rootTag || null,
            reason: candidates.length > 0 ? 'ok' : (idx >= 0 ? 'assistant_output_not_found' : 'prompt_not_visible')
        };
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false, (v) => Boolean(v?.outputFound));
    return value || {
        layoutRecognized: false,
        seenPrompt: false,
        outputFound: false,
        outputLine: null,
        reason: 'probe_failed'
    };
}

export async function captureConversationSignature(cdp) {
    const EXP = `(() => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        ${domHelpersExpr()}
        const convo = getConversationLines(SELECTORS);
        if (!convo.layoutRecognized && !convo.fallback) {
            return { ok: false, lines: [], reason: convo.reason || 'chat_layout_not_found' };
        }
        return { ok: true, lines: (convo.lines || []).slice(-80), reason: convo.reason || 'ok' };
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false, (v) => Boolean(v?.ok));
    return value || { ok: false, lines: [], reason: 'signature_failed' };
}

export async function getConversationHistory(cdp, limit = 200) {
    const safeLimit = Math.max(20, Math.min(1000, Number(limit) || 200));
    const EXP = `(() => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        ${domHelpersExpr()}
        const convo = getConversationLines(SELECTORS);
        if (!convo.layoutRecognized && !convo.fallback) {
            return { ok: false, lines: [], reason: convo.reason || 'chat_layout_not_found' };
        }
        const lines = (convo.lines || []).slice(-${safeLimit});
        return {
            ok: true,
            reason: convo.reason || 'ok',
            layoutRecognized: Boolean(convo.layoutRecognized),
            usedFallback: Boolean(convo.fallback),
            lines
        };
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false, (v) => Boolean(v?.ok));
    return value || { ok: false, lines: [], reason: 'history_probe_failed' };
}

export async function getStructuredMessageHistory(cdp, limit = 120) {
    const safeLimit = Math.max(20, Math.min(1000, Number(limit) || 120));
    const EXP = `(() => {
        ${domHelpersExpr()}

        function normalizeText(text) {
            return String(text || '').replace(/\\r/g, '').replace(/[ \\t]+$/gm, '').trim();
        }

        const selectors = [
            '[data-message-role]',
            '[data-testid*="assistant"]',
            '[data-testid*="message"]',
            '[class*="message"]',
            'article',
            '[role="article"]'
        ];

        const items = [];
        for (const item of getTargetDocs()) {
            const doc = item.doc;
            const seen = new Set();
            const nodes = [];
            for (const selector of selectors) {
                for (const node of Array.from(doc.querySelectorAll(selector))) {
                    if (!node || seen.has(node)) continue;
                    seen.add(node);
                    if (!isVisible(node)) continue;
                    const text = normalizeText(node.innerText || node.textContent);
                    if (!text || text.length < 8) continue;
                    if (node.querySelectorAll && node.querySelectorAll('[data-message-role]').length > 8) continue;
                    nodes.push(node);
                }
            }

            nodes.sort((a, b) => {
                if (a === b) return 0;
                const pos = a.compareDocumentPosition(b);
                if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                return 0;
            });

            for (const node of nodes) {
                const text = normalizeText(node.innerText || node.textContent);
                if (!text) continue;
                items.push({
                    text,
                    role: String(node.getAttribute('data-message-role') || '').toLowerCase(),
                    docSource: item.source
                });
            }
        }

        const dedup = [];
        const seenText = new Set();
        for (const it of items) {
            const key = it.text.toLowerCase();
            if (seenText.has(key)) continue;
            seenText.add(key);
            dedup.push(it);
        }

        const sliced = dedup.slice(-${safeLimit});
        return {
            ok: sliced.length > 0,
            reason: sliced.length > 0 ? 'ok' : 'structured_history_empty',
            items: sliced
        };
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false, (v) => Boolean(v?.ok));
    return value || { ok: false, reason: 'structured_history_probe_failed', items: [] };
}

export async function waitForAssistantOutput(cdp, promptText, timeoutMs = 60000, baselineLines = []) {
    const start = Date.now();
    let last = null;
    const baselineSet = new Set((baselineLines || []).map(s => String(s).trim()).filter(Boolean));
    while (Date.now() - start < timeoutMs) {
        await resolveApprovalPromptIfPresent(cdp);
        last = await probeAssistantOutput(cdp, promptText);
        if (last?.seenPrompt && last?.candidateLines?.length) {
            const fresh = last.candidateLines
                .map(s => String(s).trim())
                .filter(s => s && !baselineSet.has(s));
            if (fresh.length > 0) {
                return { ok: true, ...last, outputLine: fresh[fresh.length - 1] };
            }
        }
        await new Promise(r => setTimeout(r, 700));
    }
    return {
        ok: false,
        ...(last || {
            layoutRecognized: false,
            seenPrompt: false,
            outputFound: false,
            outputLine: null,
            reason: 'assistant_output_timeout'
        })
    };
}

export async function resolveApprovalPromptIfPresent(cdp) {
    const EXP = `(() => {
        ${domHelpersExpr()}

        function includesAny(hay, needles) {
            const t = norm(hay);
            return needles.some(n => t.includes(n));
        }

        const approvalSignals = [
            'allow directory access',
            'allow file access',
            'allow access to',
            'directory access to',
            'allow this conversation',
            'allow workspace access',
            'permission request',
            'grant access'
        ];
        const denySignals = ['deny', 'reject', 'cancel', \"don't allow\", 'do not allow', 'no'];
        const allowSignals = ['allow once', 'always allow', 'allow', 'approve', 'yes', 'continue'];

        for (const item of getTargetDocs()) {
            const doc = item.doc;
            if (!doc || !doc.body) continue;
            const body = doc.body.innerText || '';
            if (!includesAny(body, approvalSignals)) continue;

            const buttons = Array.from(doc.querySelectorAll('button, [role=\"button\"], .cursor-pointer')).filter(isVisible);
            let allowBtn = null;
            for (const btn of buttons) {
                const txt = norm(btn.innerText || btn.getAttribute('aria-label') || btn.getAttribute('title'));
                if (!txt) continue;
                if (denySignals.some(d => txt.includes(d))) continue;
                if (allowSignals.some(a => txt === a || txt.includes(a))) {
                    allowBtn = btn;
                    break;
                }
            }

            if (!allowBtn) {
                const fallback = buttons.find(btn => {
                    const cls = norm(btn.getAttribute('class') || '');
                    if (!cls) return false;
                    return cls.includes('primary') || cls.includes('solid') || cls.includes('filled');
                });
                if (fallback) allowBtn = fallback;
            }

            if (allowBtn) {
                const label = (allowBtn.innerText || allowBtn.getAttribute('aria-label') || '').trim().slice(0, 80);
                try {
                    allowBtn.click();
                    return { handled: true, label, docSource: item.source };
                } catch (e) {
                    // UI can re-render before click; report as unresolved instead of throwing.
                }
            }
            return { handled: false, reason: 'approval_prompt_visible_but_no_allow_button' };
        }

        return { handled: false, reason: 'no_approval_prompt' };
    })()`;

    const { value } = await evaluateInOrderedContexts(cdp, EXP, false, (v) => Boolean(v?.handled));
    return value || { handled: false, reason: 'probe_failed' };
}
