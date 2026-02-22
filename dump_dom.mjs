import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';

async function dumpDom() {
    const port = 9000;
    console.log(`Checking port ${port}...`);

    let target = null;
    try {
        const list = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(JSON.parse(data)));
            }).on('error', reject);
        });

        // Find the most likely target (Antigravity/Cascade)
        target = list.find(t => t.url.includes('cascade') || t.title.includes('Antigravity')) || list[0];
    } catch (e) {
        console.error(`Error connecting to port ${port}:`, e.message);
        return;
    }

    if (!target) {
        console.log("No targets found.");
        return;
    }

    console.log(`Connecting to ${target.title} (${target.webSocketDebuggerUrl})...`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    const send = (method, params = {}) => {
        const id = Math.floor(Math.random() * 1000000);
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve) => {
            const listener = (msg) => {
                const data = JSON.parse(msg);
                if (data.id === id) {
                    ws.removeListener('message', listener);
                    resolve(data.result);
                }
            };
            ws.on('message', listener);
        });
    };

    await send('Runtime.enable');

    const EXP = `(() => {
        function getSelectors(el) {
            const res = [];
            while (el) {
                let s = el.tagName.toLowerCase();
                if (el.id) s += '#' + el.id;
                if (el.className) s += '.' + Array.from(el.classList).join('.');
                res.unshift(s);
                el = el.parentElement;
            }
            return res.join(' > ');
        }

        const assistants = document.querySelectorAll('[data-message-author-role="assistant"], .assistant-message, [data-message-role="assistant"]');
        const results = [];
        assistants.forEach(a => {
            results.push({
                selector: getSelectors(a),
                text: a.innerText.substring(0, 100),
                html: a.outerHTML.substring(0, 500)
            });
        });
        
        return {
            title: document.title,
            url: window.location.href,
            assistants: results,
            bodyHtml: document.body.innerHTML.substring(0, 5000)
        };
    })()`;

    const result = await send('Runtime.evaluate', { expression: EXP, returnByValue: true });

    fs.writeFileSync('dom_dump_result.json', JSON.stringify(result, null, 2));
    console.log("Dump saved to dom_dump_result.json");
    ws.close();
}

dumpDom();
