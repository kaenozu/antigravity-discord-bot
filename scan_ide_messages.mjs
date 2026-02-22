import WebSocket from 'ws';
import fs from 'fs';

async function scanTarget(url, name) {
    console.log(`Scanning ${name}: ${url}`);
    const ws = new WebSocket(url);
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
        function deepScan(root) {
            const res = [];
            const all = root.querySelectorAll('*');
            all.forEach(el => {
                if (el.className && typeof el.className === 'string' && el.className.includes('ide-message')) {
                    res.push({
                        tag: el.tagName,
                        class: el.className,
                        text: el.innerText.substring(0, 50),
                        html: el.outerHTML.substring(0, 200)
                    });
                }
                if (el.shadowRoot) {
                    res.push(...deepScan(el.shadowRoot));
                }
            });
            return res;
        }
        return deepScan(document);
    })()`;

    const result = await send('Runtime.evaluate', { expression: EXP, returnByValue: true });
    ws.close();
    return result.result.value;
}

async function main() {
    const r = await scanTarget("ws://127.0.0.1:9000/devtools/page/F9449195BC9A1162CC3905FF89985D25", "Workbench");
    fs.writeFileSync('ide_message_elements.json', JSON.stringify(r, null, 2));
    console.log("Scan completed.");
}

main();
