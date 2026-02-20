import { ensureCDP } from './cdp_utils.js';
import { SELECTORS } from '../selectors.js';

async function injectMessage(cdp, text) {
    const safeText = JSON.stringify(text);
    const EXP = `(async () => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        
        function isSubmitButton(btn) {
            if (btn.disabled || btn.offsetWidth === 0) return false;
            const svg = btn.querySelector('svg');
            if (svg) {
                const cls = (svg.getAttribute('class') || '') + ' ' + (btn.getAttribute('class') || '');
                if (SELECTORS.SUBMIT_BUTTON_SVG_CLASSES.some(c => cls.includes(c))) return true;
            }
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (['send', 'run'].includes(txt)) return true;
            return false;
        }

        const doc = document;
        const editors = Array.from(doc.querySelectorAll(SELECTORS.CHAT_INPUT));
        const validEditors = editors.filter(el => el.offsetParent !== null);
        
        const editor = validEditors.at(-1); 
        if (!editor) return { ok: false, error: "No editor found in this context" };

        editor.focus();
        
        let inserted = doc.execCommand("insertText", false, ${safeText});
        if (!inserted) {
            editor.textContent = ${safeText};
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: ${safeText} }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: ${safeText} }));
        }
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        
        await new Promise(r => setTimeout(r, 200));

        const allButtons = Array.from(doc.querySelectorAll(SELECTORS.SUBMIT_BUTTON_CONTAINER));
        const submit = allButtons.find(isSubmitButton);
        
        if (submit) {
             submit.click();
             return { ok: true, method: "click" };
        }
        
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        return { ok: true, method: "enter" };
    })()`;

    const targetContexts = cdp.contexts.filter(c =>
        (c.url && c.url.includes(SELECTORS.CONTEXT_URL_KEYWORD)) ||
        (c.name && c.name.includes('Extension'))
    );

    const contextsToTry = targetContexts.length > 0 ? targetContexts : cdp.contexts;

    for (const ctx of contextsToTry) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value?.ok) {
                return res.result.value;
            }
        } catch (e) { }
    }

    if (targetContexts.length > 0) {
        const otherContexts = cdp.contexts.filter(c => !targetContexts.includes(c));
        for (const ctx of otherContexts) {
            try {
                const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
                if (res.result?.value?.ok) {
                    return res.result.value;
                }
            } catch (e) { }
        }
    }

    return { ok: false, error: "Injection failed" };
}

async function runTest() {
    console.log("=== Testing Text Generation ===");
    const cdp = await ensureCDP();
    if (!cdp) {
        console.error("[ERROR] CDP connection failed.");
        process.exit(1);
    }

    const testText = "Hello from test script! Just checking if message injection works.";
    console.log(`Injecting message: "${testText}"...`);
    const result = await injectMessage(cdp, testText);

    if (result.ok) {
        console.log(`[SUCCESS] Message injected successfully! Method used: ${result.method}`);
    } else {
        console.error(`[FAILED] Message injection failed. Error: ${result.error}`);
    }

    console.log("Test finished.");
    process.exit(0);
}

runTest();
