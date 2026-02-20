import { ensureCDP } from './cdp_utils.js';
import { requireUiTestsEnabled } from './ui_test_guard.js';

requireUiTestsEnabled('tests/test_mode_switch.js');

async function getCurrentMode(cdp) {
    const EXP = `(() => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch (e) { }
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        const spans = doc.querySelectorAll('span.text-xs.select-none');
        for (const s of spans) {
            const txt = (s.innerText || '').trim();
            if (txt === 'Planning' || txt === 'Fast') return txt;
        }
        return null;
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return null;
}

async function switchMode(cdp, targetMode) {
    const SWITCH_EXP = `(async () => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch (e) { }
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        const toggles = doc.querySelectorAll('div[role="button"][aria-haspopup="dialog"]');
        let clicked = false;
        for (const t of toggles) {
            const txt = (t.innerText || '').trim();
            if (txt === 'Planning' || txt === 'Fast') {
                t.querySelector('button').click();
                clicked = true;
                break;
            }
        }
        if (!clicked) return JSON.stringify({ success: false, reason: 'toggle not found' });
        await new Promise(r => setTimeout(r, 1000));
        
        const target = ${JSON.stringify(targetMode)};
        const dialogs = doc.querySelectorAll('div[role="dialog"]');
        for (const dialog of dialogs) {
            const txt = (dialog.innerText || '');
            if (txt.includes('Conversation mode') || txt.includes('Planning') && txt.includes('Fast')) {
                const divs = dialog.querySelectorAll('div.font-medium');
                for (const d of divs) {
                    if (d.innerText.trim().toLowerCase() === target.toLowerCase()) {
                        d.click();
                        return JSON.stringify({ success: true, mode: d.innerText.trim() });
                    }
                }
            }
        }
        return JSON.stringify({ success: false, reason: 'mode not found in dialog' });
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SWITCH_EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value) {
                const result = JSON.parse(res.result.value);
                if (result.success) {
                    return result;
                }
            }
        } catch (e) { }
    }
    return { success: false, reason: 'CDP error' };
}

async function runTest() {
    console.log("=== Testing Mode Switching ===");
    const cdp = await ensureCDP();
    if (!cdp) {
        console.error("[ERROR] CDP connection failed.");
        process.exit(1);
    }

    const currentMode = await getCurrentMode(cdp);
    console.log(`[INFO] Current mode: ${currentMode || 'Unknown'}`);

    const targetMode = currentMode === 'Planning' ? 'Fast' : 'Planning';
    console.log(`[INFO] Attempting to switch to: ${targetMode}`);

    const result = await switchMode(cdp, targetMode);
    if (result.success) {
        console.log(`[SUCCESS] Switched mode to: ${result.mode}`);

        // Switch back to leave it in original state
        console.log(`[INFO] Restoring previous mode: ${currentMode}`);
        await switchMode(cdp, currentMode);
        console.log(`[SUCCESS] Mode restored.`);
    } else {
        console.error(`[FAILED] Mode switch failed. Reason: ${result.reason}`);
    }

    console.log("Test finished.");
    process.exit(0);
}

runTest();
