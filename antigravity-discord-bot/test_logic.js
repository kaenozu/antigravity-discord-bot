import WebSocket from 'ws';
import http from 'http';

const PORTS = [9222, 9000, 9001, 9002, 9003];

function getJson(url) {
    return new Promise((resolve) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', () => resolve(null));
    });
}

async function discoverCDP() {
    for (const port of PORTS) {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        if (!list) continue;
        const target = list.find(t => t.url && t.url.includes('workbench') && !t.title.includes('Launchpad'));
        if (target) return { port, url: target.webSocketDebuggerUrl };
    }
    return null;
}

async function test() {
    const target = await discoverCDP();
    if (!target) return console.log('No CDP target found');

    const ws = new WebSocket(target.url);
    await new Promise(r => ws.on('open', r));

    const pending = new Map();
    let idCounter = 1;

    ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.id && pending.has(data.id)) {
            pending.get(data.id).resolve(data.result);
            pending.delete(data.id);
        }
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await call("Runtime.enable", {});

    const EXP_CURRENT = `(() => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                const lower = txt.toLowerCase();
                if (btn.hasAttribute('aria-expanded')) {
                    if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                        return txt;
                    }
                }
                if (txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                    if (btn.querySelector('svg')) {
                        return txt;
                    }
                }
            }
        }
        return null;
    })()`;

    const res_curr = await call("Runtime.evaluate", { expression: EXP_CURRENT, returnByValue: true, awaitPromise: true });
    console.log("Current Model:", res_curr.result.value);

    // List models
    const EXP_LIST = `(async () => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        let targetDoc = null;
        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                const lower = txt.toLowerCase();
                if (btn.hasAttribute('aria-expanded')) {
                    if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                        btn.click();
                        targetDoc = doc;
                        break;
                    }
                }
                if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                    if (btn.querySelector('svg')) {
                        btn.click();
                        targetDoc = doc;
                        break;
                    }
                }
            }
            if (targetDoc) break;
        }
        if (!targetDoc) return JSON.stringify({error: 'target button not found'});
        await new Promise(r => setTimeout(r, 1000));
        
        let models = [];
        const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
        for (const opt of options) {
            // Usually the model option has some padding
            if (opt.className.includes('px-') || opt.className.includes('py-')) {
                 const txt = (opt.textContent || '').replace('New', '').trim(); // Remove "New" badges
                 if(txt.length > 3 && txt.length < 50 && (txt.toLowerCase().includes('claude') || txt.toLowerCase().includes('gemini') || txt.toLowerCase().includes('gpt') || txt.toLowerCase().includes('o1') || txt.toLowerCase().includes('o3'))) {
                     if(!models.includes(txt)) models.push(txt);
                 }
            }
        }
        
        // Hide popup
        const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
        if (openBtn) openBtn.click();
        
        return JSON.stringify(models);
    })()`;

    const res_list = await call("Runtime.evaluate", { expression: EXP_LIST, returnByValue: true, awaitPromise: true });
    console.log("List Models:", res_list.result.value);

    process.exit(0);
}

test();
