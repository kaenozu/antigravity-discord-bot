import { ensureCDP } from './cdp_utils.js';
import { injectMessage } from './agent_ui_utils.js';
import { requireUiTestsEnabled } from './ui_test_guard.js';

requireUiTestsEnabled('tests/test_text_generation.js');

async function runTest() {
    console.log('=== Testing Text Generation ===');
    const cdp = await ensureCDP();
    if (!cdp) {
        console.error('[ERROR] CDP connection failed.');
        process.exit(1);
    }

    const testText = 'Hello from test script! Just checking if message injection works.';
    console.log(`Injecting message: "${testText}"...`);
    const result = await injectMessage(cdp, testText);

    if (result.ok) {
        console.log(`[SUCCESS] Message injected successfully! Method used: ${result.method}`);
    } else {
        console.error(`[FAILED] Message injection failed. Error: ${result.error}`);
        process.exit(1);
    }

    console.log('Test finished.');
    process.exit(0);
}

runTest();
