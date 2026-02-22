import http from 'http';

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
console.log(`Total: ${list.length} targets\n`);
for (const [i, t] of list.entries()) {
    console.log(`--- [${i}] ---`);
    console.log(`type:  ${t.type}`);
    console.log(`title: ${t.title || ''}`);
    console.log(`url:   ${t.url || ''}`);
    console.log(`wsUrl: ${t.webSocketDebuggerUrl || 'N/A'}`);
    console.log('');
}
