import { ensureCDP } from './cdp_utils.js';
import { captureConversationSignature, getChatSnapshot, getConversationHistory, getStructuredMessageHistory, injectMessage, startNewChat, waitForAssistantOutput, waitForGenerationStart } from './agent_ui_utils.js';

async function runTest() {
    console.log('=== Testing Meaningful New Chat Workflow ===');
    const cdp = await ensureCDP();
    if (!cdp) {
        console.error('[ERROR] CDP connection failed.');
        process.exit(1);
    }

    const before = await getChatSnapshot(cdp);
    if (!before.layoutRecognized) {
        console.log(`[WARN] Chat layout not recognized before test: ${before.reason || 'unknown'}`);
    } else {
        console.log(`[INFO] Before new chat: title="${before.title || 'null'}", generating=${before.generatingIndicator}`);
    }

    console.log('[INFO] Starting a New Chat to clear the workspace...');
    const resetResult = await startNewChat(cdp);
    if (!resetResult.success) {
        console.error(`[FAILED] New Chat button not found: ${resetResult.reason || 'unknown'}`);
        process.exit(1);
    }

    console.log(`[SUCCESS] New chat signal sent via: ${resetResult.method}`);
    console.log('[INFO] Waiting for reset to clear UI...');
    await new Promise(r => setTimeout(r, 4000));

    const afterReset = await getChatSnapshot(cdp);
    if (!afterReset.layoutRecognized) {
        console.log(`[WARN] Chat layout not recognized after reset: ${afterReset.reason || 'unknown'}`);
    } else {
        console.log(`[INFO] After new chat: title="${afterReset.title || 'null'}", generating=${afterReset.generatingIndicator}`);
    }

    console.log('[INFO] Injecting instruction to build a Dice App...');
    const runId = Date.now();
    const appPrompt = `Please create a simple dice app (HTML/JS) in this Workspace. [run:${runId}]`;
    const baseline = await captureConversationSignature(cdp);
    const injectResult = await injectMessage(cdp, appPrompt);
    if (!injectResult.ok) {
        console.error(`[FAILED] Failed to submit generation prompt: ${injectResult.error}`);
        process.exit(1);
    }

    console.log(`[SUCCESS] Generation prompt submitted via ${injectResult.method}.`);
    console.log('[INFO] Waiting for generation to start...');
    const started = await waitForGenerationStart(cdp, 25000);
    if (!started) {
        console.log('[WARN] Generation was not detected within timeout. Will check actual output.');
    }

    console.log('[INFO] Waiting for assistant output...');
    const output = await waitForAssistantOutput(cdp, appPrompt, 70000, baseline.lines || []);
    if (!output.ok) {
        console.error(`[FAILED] No assistant output detected. reason=${output.reason}`);
        process.exit(1);
    }
    console.log(`[SUCCESS] Assistant output detected: ${output.outputLine}`);

    console.log('[INFO] Verifying conversation history contains prompt and response...');
    const history = await getConversationHistory(cdp, 300);
    if (!history.ok) {
        console.error(`[FAILED] History probe failed. reason=${history.reason}`);
        process.exit(1);
    }

    const lines = history.lines || [];
    const promptMarker = `[run:${runId}]`;
    const hasPromptInHistory = lines.some(line => line.includes(promptMarker));

    const outputHead = String(output.outputLine || '').trim().slice(0, 40);
    const hasResponseInHistory = outputHead.length > 0 && lines.some(line => line.includes(outputHead));

    if (!hasPromptInHistory || !hasResponseInHistory) {
        console.error(`[FAILED] History verification failed. hasPrompt=${hasPromptInHistory}, hasResponse=${hasResponseInHistory}, lines=${lines.length}`);
        process.exit(1);
    }

    const structured = await getStructuredMessageHistory(cdp, 160);
    if (!structured.ok) {
        console.error(`[FAILED] Structured history probe failed. reason=${structured.reason}`);
        process.exit(1);
    }

    const structuredTexts = (structured.items || []).map(i => String(i.text || ''));
    const hasPromptInStructured = structuredTexts.some(t => t.includes(promptMarker));
    const hasResponseInStructured = outputHead.length > 0 && structuredTexts.some(t => t.includes(outputHead));
    if (structuredTexts.length === 0) {
        console.error('[FAILED] Structured history verification failed. items=0');
        process.exit(1);
    }
    if (!hasPromptInStructured || !hasResponseInStructured) {
        console.log(`[WARN] Structured history did not include both markers. hasPrompt=${hasPromptInStructured}, hasResponse=${hasResponseInStructured}, items=${structuredTexts.length}`);
    } else {
        console.log('[SUCCESS] Structured history includes both prompt marker and response marker.');
    }

    const hasDiffSummaryLine = lines.some(line =>
        /(^|\s)Edited($|\s)/i.test(line) ||
        /\b\d+\s+insertions?\s*\(\+\)/i.test(line) ||
        /\b\d+\s+deletions?\s*\(-\)/i.test(line) ||
        /^[+-]\d+$/.test(String(line || '').trim())
    );
    if (hasDiffSummaryLine) {
        console.log('[SUCCESS] Diff summary style lines are present in history.');
    } else {
        console.log('[WARN] Diff summary style lines were not found in this run history.');
    }

    console.log(`[SUCCESS] History verified. lines=${lines.length}, structuredItems=${structuredTexts.length}, layoutRecognized=${history.layoutRecognized}, fallback=${history.usedFallback}`);
    console.log('[SUCCESS] VERIFIED: New Chat + prompt submission + visible output is working.');
    console.log('Test finished.');
    process.exit(0);
}

runTest();
