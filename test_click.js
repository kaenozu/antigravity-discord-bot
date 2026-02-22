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
            let buttons = Array.from(doc.querySelectorAll('button, [role="button"], .cursor-pointer'));
            for(let btn of buttons) {
                let txt = (btn.innerText || '').trim();
                let aria = btn.getAttribute('aria-label') || '';
                if(txt === 'Run' || txt === '実行' || aria.includes('Run command') || aria.includes('実行')) {
                    if (txt.toLowerCase().includes('always')) continue;
                    let r = btn.getBoundingClientRect();
                    let offsetX = 0; let offsetY = 0;
                    if (doc !== document) {
                        for(let i=0; i<document.querySelectorAll('iframe').length; i++) {
                            const iframe = document.querySelectorAll('iframe')[i];
                            if (iframe.contentDocument === doc) {
                                let ir = iframe.getBoundingClientRect();
                                offsetX = ir.left; offsetY = ir.top;
                                break;
                            }
                        }
                    }
                    return { x: r.left + offsetX, y: r.top + offsetY, w: r.width, h: r.height, text: txt, aria: aria, className: btn.className };
                }
            }
        }
        return null;
    })()`;

    const res = await call("Runtime.evaluate", { expression: exp, returnByValue: true, awaitPromise: true });

    if (res.result.value) {
        console.log("Found Run button:", res.result.value);
        let rect = res.result.value;
        let cx = rect.x + 8;
        let cy = rect.y + rect.h / 2;

        console.log(`Clicking at ${cx}, ${cy}`);
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
        await call("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
        await delay(50);
        await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
        console.log("Clicked.");
    } else {
        console.log("Run button not found");
    }

    process.exit(0);
}

start();
