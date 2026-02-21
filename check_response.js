/**
 * check_response.js
 * Antigravityに接続して getLastResponse と同等のロジックで
 * AIの応答テキストが取得できているかを確認するデバッグスクリプト
 * 
 * 使い方: node check_response.js
 */

import WebSocket from 'ws';
import http from 'http';

const PORTS = [9222, 9000, 9001, 9002, 9003];

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

const EXP = `(() => {
    const allDocs = [document];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
        try { if (iframes[i].contentDocument) allDocs.push(iframes[i].contentDocument); } catch(e) {}
    }
    
    const selectors = [
        '[data-message-role="assistant"]',
        '[data-testid*="assistant"]',
        '[data-testid*="message"]',
        '.prose',
        '.markdown-body',
        '.assistant-message',
        '[class*="assistant"][class*="message"]',
        '[class*="response"]',
        '.message-content',
        'article[class*="group"]',
        '.group.relative.flex'
    ];
    
    let bestCandidate = null;
    let bestLength = 0;
    const report = { docsChecked: allDocs.length, iframeCount: iframes.length, selectorHits: {} };
    
    for (let di = 0; di < allDocs.length; di++) {
        const doc = allDocs[di];
        let candidates = [];
        for (const sel of selectors) {
            try {
                const found = Array.from(doc.querySelectorAll(sel));
                if (found.length > 0) {
                    report.selectorHits[sel + '_doc' + di] = found.length;
                    candidates = candidates.concat(found);
                }
            } catch(e) {}
        }
        candidates = [...new Set(candidates)];
        for (let i = candidates.length - 1; i >= 0; i--) {
            try {
                const text = (candidates[i].innerText || '').trim();
                if (text.length > bestLength) {
                    bestLength = text.length;
                    bestCandidate = { text: text.substring(0, 500), fullLength: text.length, docIdx: di };
                }
            } catch(e) {}
        }
    }
    
    // Generating check
    let isGenerating = false;
    for (const doc of allDocs) {
        const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) { isGenerating = true; break; }
    }
    
    return { report, bestCandidate, isGenerating };
})()`;

async function run() {
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            const targets = list.filter(t => t.webSocketDebuggerUrl && t.type === 'page');

            for (const target of targets) {
                if (target.url.includes('workbench-jetski-agent')) continue;

                console.log(`\n=== Target: "${target.title}" ===`);
                const ws = new WebSocket(target.webSocketDebuggerUrl);
                try {
                    await new Promise((r, rej) => {
                        ws.on('open', r);
                        setTimeout(() => rej("WS Timeout"), 3000);
                    });

                    let id = 1;
                    const call = (method, params) => new Promise((resolve, reject) => {
                        const curId = id++;
                        const listener = (msg) => {
                            const data = JSON.parse(msg);
                            if (data.id === curId) { ws.off('message', listener); resolve(data.result); }
                        };
                        ws.on('message', listener);
                        ws.send(JSON.stringify({ id: curId, method, params }));
                        setTimeout(() => { ws.off('message', listener); reject("Timeout"); }, 8000);
                    });

                    await call("Runtime.enable", {});
                    await new Promise(r => setTimeout(r, 500));

                    // 全コンテキストで試みる
                    const ctxResult = await call("Runtime.executionContextDescriptions", {});
                    const contexts = (ctxResult?.executionContextDescriptions || []);
                    console.log(`  Contexts: ${contexts.length}`);

                    for (const ctx of contexts) {
                        try {
                            const res = await call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
                            const val = res?.result?.value;
                            if (!val) continue;

                            console.log(`\n  Context ${ctx.id} (${ctx.name || 'unnamed'}):`);
                            console.log(`    isGenerating: ${val.isGenerating}`);
                            console.log(`    docsChecked: ${val.report.docsChecked}, iframes: ${val.report.iframeCount}`);

                            const hits = Object.keys(val.report.selectorHits);
                            if (hits.length > 0) {
                                console.log(`    Selector hits:`);
                                for (const h of hits) console.log(`      ${h}: ${val.report.selectorHits[h]}`);
                            } else {
                                console.log(`    ⚠️ No selector hits`);
                            }

                            if (val.bestCandidate) {
                                console.log(`    ✅ Best candidate (doc${val.bestCandidate.docIdx}, ${val.bestCandidate.fullLength} chars):`);
                                console.log(`      "${val.bestCandidate.text}"`);
                            } else {
                                console.log(`    ❌ No candidate found`);
                            }
                        } catch (e) {
                            console.log(`  Context ${ctx.id}: Error - ${e}`);
                        }
                    }
                    ws.close();
                } catch (e) {
                    console.log(`  Error: ${e}`);
                    ws.close();
                }
            }
        } catch (e) { /* port not open */ }
    }
    console.log('\n=== Done ===');
}

run();
