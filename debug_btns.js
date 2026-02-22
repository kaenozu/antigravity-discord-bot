import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';

const PORTS = [9222, 9000];

function getJson(url) {
    return new Promise((resolve) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', () => resolve(null));
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function start() {
    let target = null;
    for (const port of PORTS) {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        if (!list) continue;
        target = list.find(t => t.url && t.url.includes('workbench') && !t.title.includes('Launchpad'));
        if (target) break;
    }

    if (!target) return console.log('No CDP target found');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
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

    const exp = `(() => {
        let docs = [document];
        document.querySelectorAll('iframe').forEach(i => {
            try {
                if (i.contentDocument) docs.push(i.contentDocument);
            } catch(e) {}
        });
        
        for (let doc of docs) {
            let walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null, false);
            let n;
            while(n = walker.nextNode()) {
                if (n.nodeValue.includes('Run command')) {
                    let parent = n.parentElement;
                    for (let i=0; i<8; i++) {
                        if (!parent) break;
                        parent = parent.parentElement;
                    }
                    if (parent) return parent.outerHTML;
                }
            }
        }
        return 'Not found';
    })()`;

    const res = await call("Runtime.evaluate", { expression: exp, returnByValue: true, awaitPromise: true });

    fs.writeFileSync('dom_run_command.html', res.result.value || 'undefined');
    console.log("Saved dom_run_command.html");
    process.exit(0);
}

start();
