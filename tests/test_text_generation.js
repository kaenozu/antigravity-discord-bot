import { ensureCDP } from './cdp_utils.js';
import { captureConversationSignature, injectMessage, waitForAssistantOutput } from './agent_ui_utils.js';

async function runTest() {
    console.log('=== Testing Text Generation ===');
    const cdp = await ensureCDP();
    if (!cdp) {
        console.error('[ERROR] CDP connection failed.');
        process.exit(1);
    }

    const runId = Date.now();
    const testText = `Hello from test script! Just checking if message injection works. [run:${runId}]`;
    const baseline = await captureConversationSignature(cdp);
    console.log(`Injecting message: "${testText}"...`);
    const result = await injectMessage(cdp, testText);

    if (result.ok) {
        console.log(`[SUCCESS] Message injected successfully! Method used: ${result.method}`);
    } else {
        console.error(`[FAILED] Message injection failed. Error: ${result.error}`);
        process.exit(1);
    }

    console.log('[INFO] Waiting for assistant output...');
    const output = await waitForAssistantOutput(cdp, testText, 60000, baseline.lines || []);
    if (!output.ok) {
        console.error(`[FAILED] No assistant output detected. reason=${output.reason}`);
        process.exit(1);
    }
    console.log(`[SUCCESS] Assistant output detected: ${output.outputLine}`);

    console.log('Test finished.');
    process.exit(0);
}

runTest();
