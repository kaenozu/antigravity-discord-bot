/**
 * debug_manager.js
 * "Manager" ターゲット（Open Agent Manager）の DOM をスキャンして
 * チャット応答のセレクターを特定する
 */
import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

// /json/list と /json (全ターゲット) を試す
let managerTarget = null;

for (const endpoint of ['/json/list', '/json']) {
    try {
        const list = await getJson(`http://127.0.0.1:9222${endpoint}`);
        console.log(`\n${endpoint}: ${Array.isArray(list) ? list.length : '?'} entries`);
        if (Array.isArray(list)) {
            for (const t of list) {
                console.log(`  type=${t.type} title="${t.title || ''}" wsUrl=${t.webSocketDebuggerUrl ? 'YES' : 'NO'}`);
                if (t.title === 'Manager' && t.webSocketDebuggerUrl) {
                    managerTarget = t;
                }
            }
        }
    } catch (e) { console.log(`${endpoint}: error ${e.message}`); }
}

if (!managerTarget) {
    console.log('\nManager target not found in /json/list. Trying Target.getTargets via editor connection...');

    // エディタウィンドウ経由で Target.getTargets を呼ぶ
    const list = await getJson('http://127.0.0.1:9222/json/list');
    const editor = list.find(t => t.title && t.title.includes('Antigravity') && !t.title.includes('Launchpad') && t.type === 'page');

    if (editor) {
        const ws = new WebSocket(editor.webSocketDebuggerUrl);
        await new Promise((r, rej) => { ws.on('open', r); setTimeout(() => rej('WS Timeout'), 3000); });

        let id = 1;
        const call = (method, params = {}) => new Promise((resolve, reject) => {
            const curId = id++;
            const listener = (msg) => {
                const data = JSON.parse(msg);
                if (data.id === curId) { ws.off('message', listener); resolve(data.result); }
            };
            ws.on('message', listener);
            ws.send(JSON.stringify({ id: curId, method, params }));
            setTimeout(() => { ws.off('message', listener); reject(`Timeout: ${method}`); }, 5000);
        });

        try {
            const targets = await call('Target.getTargets');
            for (const t of (targets.targetInfos || [])) {
                console.log(`  Target: type=${t.type} title="${t.title}" url=${t.url?.substring(0, 80)}`);
                if (t.title === 'Manager' && t.targetId) {
                    // Manager ターゲットの webSocket デバッガー URL を構築
                    managerTarget = {
                        title: t.title,
                        url: t.url,
                        webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${t.targetId}`
                    };
                    console.log(`  → Found Manager targetId: ${t.targetId}`);
                }
            }
        } catch (e) { console.log(`Target.getTargets error: ${e}`); }

        ws.close();
    }
}

if (!managerTarget) {
    console.log('\n⚠️  Manager target not found at all. Is Open Agent Manager open in Antigravity?');
    process.exit(1);
}

console.log(`\n✅ Manager target found: ${managerTarget.webSocketDebuggerUrl}`);
console.log(`   url: ${managerTarget.url}`);

// Manager ターゲットに接続して DOM スキャン
const ws2 = new WebSocket(managerTarget.webSocketDebuggerUrl);
try {
    await new Promise((r, rej) => { ws2.on('open', r); setTimeout(() => rej('WS Timeout'), 3000); });
} catch (e) {
    console.log(`\n⚠️  Cannot connect to Manager: ${e}`);
    process.exit(1);
}

let id2 = 1;
const call2 = (method, params = {}) => new Promise((resolve, reject) => {
    const curId = id2++;
    const listener = (msg) => {
        const data = JSON.parse(msg);
        if (data.id === curId) { ws2.off('message', listener); resolve(data.result); }
    };
    ws2.on('message', listener);
    ws2.send(JSON.stringify({ id: curId, method, params }));
    setTimeout(() => { ws2.off('message', listener); reject(`Timeout: ${method}`); }, 10000);
});

await call2('Runtime.enable');
await new Promise(r => setTimeout(r, 1000));

const ctxResult = await call2('Runtime.executionContextDescriptions');
const contexts = ctxResult?.executionContextDescriptions || [];
console.log(`\nContexts: ${contexts.length}`);
for (const c of contexts) {
    console.log(`  [${c.id}] name="${c.name || ''}" origin="${c.origin || ''}"`);
}

// DOM スキャン
const SCAN_EXP = `(() => {
    const allDocs = [{ doc: document, label: 'main' }];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
        try {
            if (iframes[i].contentDocument) allDocs.push({ doc: iframes[i].contentDocument, label: 'iframe['+i+']: '+iframes[i].src.substring(0,50) });
        } catch(e) {}
    }
    
    const selectors = [
        '[data-message-role]', '[data-role]', '[data-testid*="message"]',
        '[data-testid*="assistant"]', '[data-testid*="chat"]',
        '.prose', '.markdown-body', '.markdown',
        '.assistant-message', '.message-content',
        '[class*="message"]', '[class*="chat"]', '[class*="response"]',
        'article', '[role="article"]', '[role="listitem"]',
        'p', '.text-sm', '.text-base'
    ];
    
    const report = [];
    for (const {doc, label} of allDocs) {
        const docHits = [];
        for (const sel of selectors) {
            try {
                const els = Array.from(doc.querySelectorAll(sel));
                const withText = els.filter(e => (e.innerText||'').trim().length > 30);
                if (withText.length > 0) {
                    docHits.push({ 
                        selector: sel, 
                        count: withText.length,
                        samples: withText.slice(-2).map(e => ({
                            tag: e.tagName,
                            cls: e.className.substring(0,80),
                            text: (e.innerText||'').trim().substring(0,200),
                            len: (e.innerText||'').trim().length
                        }))
                    });
                }
            } catch(e) {}
        }
        if (docHits.length > 0) report.push({ doc: label, hits: docHits });
    }
    
    return {
        title: document.title,
        url: window.location ? window.location.href : 'N/A',
        iframeCount: iframes.length,
        iframeSrcs: Array.from(iframes).map(f => f.src),
        report
    };
})()`;

console.log('\n--- DOM Scan (default context) ---');
try {
    const res = await call2('Runtime.evaluate', { expression: SCAN_EXP, returnByValue: true });
    const val = res?.result?.value;
    if (!val) { console.log('(null result)'); }
    else {
        console.log(`title: ${val.title}`);
        console.log(`url: ${val.url}`);
        console.log(`iframes: ${val.iframeCount}`);
        for (const s of val.iframeSrcs) console.log(`  iframe: ${s}`);

        if (val.report.length === 0) {
            console.log('⚠️  No hits with text > 30 chars');
        } else {
            for (const docR of val.report) {
                console.log(`\n[${docR.doc}]:`);
                for (const h of docR.hits) {
                    console.log(`  ${h.selector} → ${h.count} el(s)`);
                    for (const s of h.samples) {
                        console.log(`    <${s.tag} class="${s.cls.substring(0, 50)}">`);
                        console.log(`    (${s.len} chars): "${s.text.substring(0, 150)}"`);
                    }
                }
            }
        }
        fs.writeFileSync('manager_body.txt', JSON.stringify(val, null, 2), 'utf8');
        console.log('\nFull result saved to manager_body.txt');
    }
} catch (e) { console.log(`Error: ${e}`); }

ws2.close();
console.log('\n=== Done ===');
