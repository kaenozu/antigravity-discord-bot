import WebSocket from 'ws';

async function main() {
    const res = await fetch('http://127.0.0.1:9222/json/list');
    const list = await res.json();
    const target = list.find(t => t.title.includes('Antigravity') && t.type === 'page' && !t.title.includes('Launchpad'));
    if (!target) return console.log('not found');

    const ws = new WebSocket(target.webSocketDebuggerUrl);

    ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
        const exp = `(() => { 
            const shadowQuery = (sel, root) => { 
                const els = []; 
                try { els.push(...root.querySelectorAll(sel)); } catch(e){} 
                try { 
                    for (const el of root.querySelectorAll('*')) { 
                        if (el.shadowRoot) els.push(...shadowQuery(sel, el.shadowRoot)); 
                        if (el.contentDocument) els.push(...shadowQuery(sel, el.contentDocument)); 
                    } 
                } catch(e){} 
                return els; 
            }; 
            const textareas = shadowQuery('textarea', document);
            const contenteditables = shadowQuery('[contenteditable="true"]', document);
            return {
                textareas: textareas.map(t => ({ id: t.id, cl: t.className, ph: t.placeholder, val: t.value || t.innerText })),
                contenteditables: contenteditables.map(t => ({ id: t.id, cl: t.className, ph: t.placeholder, phAttr: t.getAttribute('placeholder'), aria: t.getAttribute('aria-label'), val: t.innerText }))
            };
        })()`;
        ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: exp, returnByValue: true, awaitPromise: true } }));
    });

    ws.on('message', m => {
        const d = JSON.parse(m);
        if (d.id === 2) {
            console.log(JSON.stringify(d.result?.result?.value || d, null, 2));
            process.exit(0);
        }
    });

    setTimeout(() => {
        console.log("Timeout");
        process.exit(1);
    }, 5000);
}

main().catch(console.error);
