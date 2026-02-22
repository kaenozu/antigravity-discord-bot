const CDP = require('chrome-remote-interface');

(async () => {
    try {
        const client = await CDP({ port: 9000, host: '127.0.0.1' });
        const { Runtime } = client;

        await Runtime.enable();

        const exp = `(() => {
            let docs = [document];
            document.querySelectorAll('iframe').forEach(i => {
                try {
                    if (i.contentDocument) docs.push(i.contentDocument);
                } catch(e) {}
            });
            
            let res = [];
            for (let doc of docs) {
                Array.from(doc.querySelectorAll('.monaco-button, [role="button"]')).forEach(e => {
                    let t = (e.innerText || '').trim();
                    let aria = (e.getAttribute('aria-label') || '');
                    if (t || aria) {
                        let r = e.getBoundingClientRect();
                        res.push({
                            text: t,
                            aria: aria,
                            class: e.className,
                            x: r.x, y: r.y, w: r.width, h: r.height,
                            isIframe: doc !== document
                        });
                    }
                });
            }
            return JSON.stringify(res, null, 2);
        })()`;

        const res = await Runtime.evaluate({ expression: exp, returnByValue: true, awaitPromise: true });
        console.log(res.result.value);

        await client.close();
    } catch (e) {
        console.error(e);
    }
})();
