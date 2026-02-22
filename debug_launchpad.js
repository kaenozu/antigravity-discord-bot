/**
 * debug_launchpad.js
 * Launchpad ターゲット（チャットUIを含む可能性）の DOM を詳細スキャン
 */
import WebSocket from 'ws';
import http from 'http';

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

const EXP = `(() => {
    const allDocs = [{ doc: document, label: 'main (' + document.title + ')' }];
    
    // iframe をすべて収集（アクセス可/不可問わず）
    const iframes = document.querySelectorAll('iframe');
    console.log && console.log('iframes found:', iframes.length);
    for (let i = 0; i < iframes.length; i++) {
        const src = iframes[i].src || '(no src)';
        try {
            if (iframes[i].contentDocument) {
                allDocs.push({ doc: iframes[i].contentDocument, label: 'iframe[' + i + ']: ' + src.substring(0, 60) });
            }
        } catch(e) {}
    }
    
    // AI応答関連セレクター（幅広く）
    const selectors = [
        '[data-message-role]', '[data-role]', '[data-testid*="message"]',
        '[data-testid*="assistant"]', '[data-testid*="chat"]',
        '.prose', '.markdown-body', '.markdown',
        '.assistant-message', '.message-content', '.message',
        '[class*="assistant"]', '[class*="message"]', '[class*="chat"]',
        '[class*="response"]', '[class*="ai"]',
        'article', '[role="article"]', '[role="listitem"]',
        '.group', '.conversation', '.dialogue'
    ];
    
    const report = [];
    
    for (const { doc, label } of allDocs) {
        const docReport = { doc: label, hits: [], iframeCount: 0, bodyPreview: '' };
        
        // iframe 数
        try { docReport.iframeCount = doc.querySelectorAll('iframe').length; } catch(e) {}
        
        // body preview（DOM 構造把握のため）
        try { docReport.bodyPreview = (doc.body ? doc.body.innerHTML : '').substring(0, 600); } catch(e) {}
        
        for (const sel of selectors) {
            try {
                const els = Array.from(doc.querySelectorAll(sel));
                if (els.length > 0) {
                    const samples = els.slice(-2).map(el => ({
                        tag: el.tagName,
                        className: el.className.substring(0, 80),
                        text: (el.innerText || '').trim().substring(0, 200),
                        textLen: (el.innerText || '').trim().length
                    })).filter(s => s.textLen > 0);
                    if (samples.length > 0) {
                        docReport.hits.push({ selector: sel, count: els.length, samples });
                    }
                }
            } catch(e) {}
        }
        
        report.push(docReport);
    }
    
    return {
        mainTitle: document.title,
        totalIframes: iframes.length,
        iframeSrcs: Array.from(iframes).map(f => ({ src: f.src, id: f.id, cls: f.className })),
        report
    };
})()`;

const list = await getJson('http://127.0.0.1:9222/json/list');

// Launchpad ターゲット に接続
const launchpad = list.find(t => t.title === 'Launchpad' && t.webSocketDebuggerUrl);
if (!launchpad) {
    console.log('Launchpad target not found!');
    process.exit(1);
}

console.log(`Connecting to Launchpad: ${launchpad.webSocketDebuggerUrl}`);
const ws = new WebSocket(launchpad.webSocketDebuggerUrl);

await new Promise((r, rej) => {
    ws.on('open', r);
    setTimeout(() => rej('WS Timeout'), 3000);
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
    setTimeout(() => { ws.off('message', listener); reject('Timeout'); }, 10000);
});

await call('Runtime.enable', {});
await new Promise(r => setTimeout(r, 1000));

// コンテキスト一覧
const ctxResult = await call('Runtime.executionContextDescriptions', {});
const contexts = ctxResult?.executionContextDescriptions || [];
console.log(`\nContexts: ${contexts.length}`);
for (const c of contexts) {
    console.log(`  [${c.id}] ${c.name || '(unnamed)'} | origin: ${c.origin || ''}`);
}

// デフォルトコンテキストでスキャン
console.log('\n--- Scanning default context ---');
try {
    const res = await call('Runtime.evaluate', { expression: EXP, returnByValue: true });
    const val = res?.result?.value;
    if (!val) {
        console.log('(null result)');
    } else {
        console.log(`mainTitle: ${val.mainTitle}`);
        console.log(`totalIframes: ${val.totalIframes}`);
        if (val.iframeSrcs.length > 0) {
            console.log('iframe srcs:');
            for (const f of val.iframeSrcs) {
                console.log(`  src="${f.src}" id="${f.id}" class="${f.cls}"`);
            }
        }
        for (const docR of val.report) {
            if (docR.hits.length > 0) {
                console.log(`\n[${docR.doc}] iframes=${docR.iframeCount}`);
                for (const h of docR.hits) {
                    console.log(`  ${h.selector} → ${h.count}`);
                    for (const s of h.samples) {
                        console.log(`    <${s.tag} class="${s.className.substring(0, 50)}">`);
                        console.log(`    text(${s.textLen}): "${s.text.substring(0, 120)}"`);
                    }
                }
            } else if (docR.bodyPreview) {
                console.log(`\n[${docR.doc}] No hits. Body preview:`);
                console.log(docR.bodyPreview.substring(0, 300));
            }
        }
    }
} catch (e) {
    console.log(`Error: ${e}`);
}

// 各コンテキストでもスキャン
for (const ctx of contexts) {
    console.log(`\n--- Context ${ctx.id}: ${ctx.name || 'unnamed'} ---`);
    try {
        const res = await call('Runtime.evaluate', { expression: EXP, returnByValue: true, contextId: ctx.id });
        const val = res?.result?.value;
        if (!val) { console.log('  (null)'); continue; }
        console.log(`  mainTitle: ${val.mainTitle} | iframes: ${val.totalIframes}`);
        for (const docR of val.report) {
            for (const h of docR.hits) {
                console.log(`  [${docR.doc}] ${h.selector} → ${h.count}`);
                for (const s of h.samples) {
                    console.log(`    text(${s.textLen}): "${s.text.substring(0, 100)}"`);
                }
            }
        }
    } catch (e) {
        console.log(`  Error: ${e}`);
    }
}

ws.close();
console.log('\n=== Done ===');
