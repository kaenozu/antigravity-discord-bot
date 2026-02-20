import { ensureCDP } from './cdp_utils.js';

async function stopGeneration(cdp) {
    const EXP = `(() => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch(e) {}
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        const buttons = doc.querySelectorAll('button');
        for (const btn of buttons) {
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (txt === 'stop' || txt === '停止') {
                btn.click();
                return { success: true };
            }
        }
        return { success: false, reason: 'Cancel button not found' };
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value?.success) {
                return { success: true };
            }
        } catch (e) { }
    }
    return { success: false, reason: 'Evaluation failed or button not found in any context' };
}

async function runTest() {
    console.log("=== Testing Stop Generation ===");
    const cdp = await ensureCDP();
    if (!cdp) {
        console.error("[ERROR] CDP connection failed.");
        process.exit(1);
    }

    console.log("[INFO] Attempting to stop generation...");
    const result = await stopGeneration(cdp);

    if (result.success) {
        console.log(`[SUCCESS] Generation stopped by user.`);
    } else {
        console.log(`[FAILED] Could not stop generation. Reason: ${result.reason}`);
        console.log("Note: This is expected if the AI is not currently generating an answer.");
    }

    console.log("Test finished.");
    process.exit(0);
}

runTest();
