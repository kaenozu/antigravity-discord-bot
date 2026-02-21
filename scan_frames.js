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

async function run() {
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            const targets = list.filter(t => t.webSocketDebuggerUrl && t.type === 'page');

            for (const target of targets) {
                console.log(`\n=== Target: "${target.title}" ===`);
                console.log(`    URL: ${target.url}`);
                const ws = new WebSocket(target.webSocketDebuggerUrl);
                try {
                    await new Promise((r, rej) => {
                        ws.on('open', r);
                        setTimeout(() => rej("WS Timeout"), 3000);
                    });

                    let id = 1;
                    const call = (method, params) => {
                        return new Promise((resolve, reject) => {
                            const curId = id++;
                            const listener = (msg) => {
                                const data = JSON.parse(msg);
                                if (data.id === curId) {
                                    ws.off('message', listener);
                                    resolve(data.result);
                                }
                            };
                            ws.on('message', listener);
                            ws.send(JSON.stringify({ id: curId, method, params }));
                            setTimeout(() => { ws.off('message', listener); reject("Call Timeout"); }, 8000);
                        });
                    };

                    // Enable Runtime & get all contexts
                    await call("Runtime.enable", {});
                    const ctxResult = await call("Runtime.executionContextDescriptions", {});
                    const contexts = (ctxResult?.executionContextDescriptions || []).map(c => c.id);
                    console.log(`    Contexts: [${contexts.join(', ')}]`);

                    // Run deep scan in each context
                    for (const ctxId of contexts) {
                        const EXP = `(() => {
                            const selectors = [
                                '[data-message-role="assistant"]',
                                '[data-testid*="assistant"]',
                                '[data-testid*="message"]',
                                '.prose',
                                '.markdown',
                                '.markdown-body',
                                '.message-content',
                                '.assistant-message',
                                '[class*="assistant"]',
                                '[class*="message"]',
                                '[class*="response"]',
                                '[class*="chat"]',
                                'article',
                                '[role="article"]',
                                '[role="listitem"]',
                                'p'
                            ];
                            const found = {};
                            for (const sel of selectors) {
                                try {
                                    const els = document.querySelectorAll(sel);
                                    if (els.length > 0) {
                                        found[sel] = Array.from(els).slice(-3).map(el => ({
                                            tag: el.tagName,
                                            classes: el.className.substring(0, 100),
                                            text: (el.innerText || '').trim().substring(0, 150)
                                        }));
                                    }
                                } catch(e) {}
                            }
                            // Also grab body structure
                            return {
                                url: window.location.href,
                                title: document.title,
                                bodySnippet: document.body ? document.body.innerHTML.substring(0, 800) : 'NO BODY',
                                selectorResults: found,
                                iframeCount: document.querySelectorAll('iframe').length
                            };
                        })()`;
                        try {
                            const res = await call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctxId });
                            if (res?.result?.value) {
                                const d = res.result.value;
                                console.log(`\n  --- Context ${ctxId}: ${d.title} (${d.url}) ---`);
                                console.log(`  IFrames: ${d.iframeCount}`);
                                const keys = Object.keys(d.selectorResults);
                                if (keys.length === 0) {
                                    console.log(`  ⚠️  No selectors matched.`);
                                    console.log(`  Body snippet: ${d.bodySnippet.substring(0, 300)}`);
                                } else {
                                    console.log(`  ✅ Matched selectors (${keys.length}):`);
                                    for (const k of keys) {
                                        const items = d.selectorResults[k];
                                        console.log(`    [${k}] → ${items.length} element(s)`);
                                        for (const item of items) {
                                            if (item.text) console.log(`      <${item.tag} class="${item.classes}"> "${item.text}"`);
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.log(`  Context ${ctxId}: Error - ${e}`);
                        }
                    }
                    ws.close();
                } catch (e) {
                    console.log(`  Error connecting: ${e}`);
                    ws.close();
                }
            }
        } catch (e) { /* port not open */ }
    }
    console.log('\n=== Scan Complete ===');
}

run();
