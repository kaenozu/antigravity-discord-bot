import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';

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

    // Try to click the model dropdown and then read everything
    const EXP_CLICK = `(async () => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        
        let clicked = false;
        let targetDocId = null;
        for (let d=0; d<docs.length; d++) {
            const doc = docs[d];
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim().toLowerCase();
                if (btn.hasAttribute('aria-expanded')) {
                    if (txt.includes('claude') || txt.includes('gemini') || txt.includes('gpt') || txt.includes('o1') || txt.includes('o3') || txt.includes('model')) {
                        console.log('Clicking button with text:', btn.textContent);
                        btn.click();
                        clicked = true;
                        targetDocId = d;
                        break;
                    }
                }
            }
            if(clicked) break;
        }
        
        if(!clicked) return { error: 'Dropdown toggle not found' };
        
        // Wait for animation
        await new Promise(r => setTimeout(r, 1000));
        
        // Now find the popup
        const doc = docs[targetDocId];
        
        // Let's dump the outer HTML of any element with role="listbox", role="menu", or role="dialog" or class that hints at popover
        const popups = Array.from(doc.querySelectorAll('[role="listbox"], [role="menu"], [role="dialog"], .popover, [role="presentation"]'));
        const results = [];
        
        for (const p of popups) {
             // To avoid dumping the whole page if it's broad
             if (p.textContent.length < 5000) {
                 results.push({
                     role: p.getAttribute('role'),
                     className: p.className,
                     textContentSubset: p.textContent.substring(0,200),
                     html: p.innerHTML.substring(0, 1000)
                 });
             }
        }
        
        // Also just dump any divs that have cursor-pointer and a model name, as those might be the actual options
        const allDivs = Array.from(doc.querySelectorAll('div'));
        const optionDivs = [];
        for (const d of allDivs) {
            if (d.children.length > 2) continue; // Keep it somewhat leaf-like
            const txt = (d.textContent || '').trim();
            const lower = txt.toLowerCase();
            if (txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3'))) {
                // Ignore the button we already clicked
                if (d.getAttribute('aria-expanded') !== null) continue;
                if (d.tagName === 'BUTTON') continue;
                
                optionDivs.push({
                    text: txt,
                    className: d.className,
                    html: d.outerHTML.substring(0, 200)
                });
            }
        }
        
        return { popups, options: optionDivs.slice(0, 20) };
    })()`;

    // Try finding context id 3 - which we saw before contained the DOM
    let res;
    // For simplicity just evaluate on Top context for now and see if it propagates because usually querySelectorAll('iframe') crosses bounds if same origin
    res = await call("Runtime.evaluate", { expression: EXP_CLICK, returnByValue: true, awaitPromise: true });

    fs.writeFileSync('dom_dump.json', JSON.stringify(res.result.value, null, 2), 'utf8');
    console.log("Finished.");
    process.exit(0);
}

test();
