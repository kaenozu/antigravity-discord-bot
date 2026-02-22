import WebSocket from 'ws';

async function main() {
    const res = await fetch('http://127.0.0.1:9000/json/list');
    const list = await res.json();
    const target = list.find(t => t.title.includes('Antigravity') && t.type === 'page' && !t.title.includes('Launchpad'));
    if (!target) return console.log('not found');

    const ws = new WebSocket(target.webSocketDebuggerUrl);

    ws.on('open', () => {
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
        // 会話メッセージの構造を調査
        const exp = `(() => {
            const msgs = [];
            const convList = document.querySelectorAll('#conversation .flex.w-full.grow.flex-col > .mx-auto.w-full');
            const container = convList.length > 0 ? convList[0] : null;
            if (!container) return { error: 'no #conversation container', childCount: 0 };
            const children = Array.from(container.children);
            for (let i = 0; i < children.length; i++) {
                const el = children[i];
                const txt = (el.innerText || '').trim().substring(0, 100);
                // ロールの手がかりを探す
                const dataRole = el.getAttribute('data-role') || '';
                const classes = el.className.substring(0, 150);
                // 内部要素のaria-labelやdata属性
                const innerAttrs = {};
                const roleEl = el.querySelector('[data-role],[data-message-role],[aria-label]');
                if (roleEl) {
                    innerAttrs.dataRole = roleEl.getAttribute('data-role') || '';
                    innerAttrs.msgRole = roleEl.getAttribute('data-message-role') || '';
                    innerAttrs.aria = roleEl.getAttribute('aria-label') || '';
                }
                msgs.push({ index: i, dataRole, classes, txt, innerAttrs });
            }
            return { childCount: children.length, msgs };
        })()`;
        ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: exp, returnByValue: true, awaitPromise: true } }));
    });

    ws.on('message', m => {
        const d = JSON.parse(m);
        if (d.id === 2) {
            import('fs').then(fs => {
                fs.writeFileSync('dom_dump_output.json', JSON.stringify(d.result?.result?.value || d, null, 2));
                console.log('Saved to dom_dump_output.json');
                process.exit(0);
            });
        }
    });

    setTimeout(() => {
        console.log("Timeout");
        process.exit(1);
    }, 5000);
}

main().catch(console.error);
