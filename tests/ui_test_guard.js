export function requireUiTestsEnabled(testName) {
    if (process.env.RUN_UI_TESTS === '1') return;

    console.log(`[SKIP] ${testName} is disabled by default to avoid touching the live UI.`);
    console.log('[SKIP] Set RUN_UI_TESTS=1 only when you intentionally want UI automation.');
    process.exit(0);
}
