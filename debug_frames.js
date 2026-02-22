/**
 * debug_frames.js
 * エディタウィンドウ([1])の Frame Tree と Webview を調べる
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

const list = await getJson('http://127.0.0.1:9222/json/list');

// [1] エディタウィンドウ
const editor = list.find(t => t.title && t.title.includes('Antigravity') && !t.title.includes('Launchpad') && t.type === 'page');
if (!editor) {
    console.log('Editor target not found!');
    process.exit(1);
}

console.log(`Connecting to: ${editor.title}`);
console.log(`URL: ${editor.url}`);
console.log(`WS: ${editor.webSocketDebuggerUrl}`);

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
    setTimeout(() => { ws.off('message', listener); reject(`Timeout: ${method}`); }, 10000);
});

await call('Runtime.enable');
await call('Page.enable');
await new Promise(r => setTimeout(r, 1000));

// Frame Tree
console.log('\n=== Page.getFrameTree ===');
try {
    const frameTree = await call('Page.getFrameTree');
    const printFrame = (frame, depth = 0) => {
        const indent = '  '.repeat(depth);
        const f = frame.frame;
        console.log(`${indent}Frame: id=${f.id} url=${f.url?.substring(0, 100)}`);
        if (f.name) console.log(`${indent}  name: ${f.name}`);
        if (frame.childFrames) frame.childFrames.forEach(c => printFrame(c, depth + 1));
    };
    printFrame(frameTree.frameTree);
} catch (e) { console.log(`Error: ${e}`); }

// Target list
console.log('\n=== Target.getTargets ===');
try {
    const targets = await call('Target.getTargets');
    for (const t of (targets.targetInfos || [])) {
        console.log(`  type=${t.type} title="${t.title?.substring(0, 60)}" url=${t.url?.substring(0, 80)}`);
    }
} catch (e) { console.log(`Error: ${e}`); }

// Execution contexts
console.log('\n=== ExecutionContexts ===');
try {
    const ctxResult = await call('Runtime.executionContextDescriptions');
    const contexts = ctxResult?.executionContextDescriptions || [];
    console.log(`Count: ${contexts.length}`);
    for (const c of contexts) {
        console.log(`  [${c.id}] name="${c.name || ''}" origin="${c.origin || ''}" aux=${JSON.stringify(c.auxData || {})}`);
    }
} catch (e) { console.log(`Error: ${e}`); }

// DOM scan in default context
console.log('\n=== DOM Scan (default context) ===');
const SCAN_EXP = `(() => {
    const result = {
        title: document.title,
        iframes: [],
        bodyLen: document.body ? document.body.innerHTML.length : 0,
        bodyPreview: document.body ? document.body.innerHTML.substring(0, 1500) : 'NO BODY'
    };
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
        const f = iframes[i];
        const info = { index: i, src: f.src, id: f.id, cls: f.className, name: f.name };
        try {
            if (f.contentDocument) {
                info.docTitle = f.contentDocument.title;
                info.docBodyLen = f.contentDocument.body ? f.contentDocument.body.innerHTML.length : 0;
                // チャット関連のセレクターをiframe内でも検索
                const sels = ['.prose', '[data-message-role]', '[class*="message"]', '[class*="chat"]'];
                info.hits = {};
                for (const s of sels) {
                    const els = f.contentDocument.querySelectorAll(s);
                    if (els.length > 0) info.hits[s] = els.length;
                }
            }
        } catch(e) { info.error = e.message; }
        result.iframes.push(info);
    }
    return result;
})()`;

try {
    const res = await call('Runtime.evaluate', { expression: SCAN_EXP, returnByValue: true });
    const val = res?.result?.value;
    if (val) {
        console.log(`title: ${val.title}`);
        console.log(`bodyLen: ${val.bodyLen}`);
        console.log(`iframes: ${val.iframes.length}`);
        for (const f of val.iframes) {
            console.log(`  iframe[${f.index}]: src="${f.src}" id="${f.id}"`);
            if (f.docTitle) console.log(`    docTitle: ${f.docTitle}, bodyLen: ${f.docBodyLen}`);
            if (f.hits && Object.keys(f.hits).length > 0) console.log(`    hits: ${JSON.stringify(f.hits)}`);
            if (f.error) console.log(`    error: ${f.error}`);
        }
        // bodyPreview
        fs.writeFileSync('body_preview.txt', val.bodyPreview, 'utf8');
        console.log('\nbodyPreview saved to body_preview.txt');
    }
} catch (e) { console.log(`Error: ${e}`); }

ws.close();
console.log('\n=== Done ===');
