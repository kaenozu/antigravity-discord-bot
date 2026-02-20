import { ensureCDP } from './cdp_utils.js';
import fs from 'fs';
import path from 'path';

async function getScreenshot(cdp) {
    try {
        const result = await cdp.call("Page.captureScreenshot", { format: "png" });
        return Buffer.from(result.data, 'base64');
    } catch (e) { return null; }
}

async function runTest() {
    console.log("=== Testing Screenshot Capture ===");
    const cdp = await ensureCDP();
    if (!cdp) {
        console.error("[ERROR] CDP connection failed.");
        process.exit(1);
    }

    console.log("[INFO] Capturing screenshot...");
    const ssBuffer = await getScreenshot(cdp);

    if (ssBuffer) {
        const outPath = path.join(process.cwd(), 'tests', 'screenshot_test_output.png');
        fs.writeFileSync(outPath, ssBuffer);
        console.log(`[SUCCESS] Screenshot captured and saved to: ${outPath}`);
    } else {
        console.error("[FAILED] Could not capture screenshot.");
    }

    console.log("Test finished.");
    process.exit(0);
}

runTest();
