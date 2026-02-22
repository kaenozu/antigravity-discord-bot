import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';

async function listTargets() {
    const ports = [9222, 9000, 9001];
    const results = [];

    for (const port of ports) {
        try {
            const list = await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(data)); } catch (e) { resolve([]); }
                    });
                });
                req.on('error', () => resolve([]));
                req.setTimeout(1000, () => { req.destroy(); resolve([]); });
            });
            results.push({ port, targets: list });
        } catch (e) { }
    }

    fs.writeFileSync('target_list.json', JSON.stringify(results, null, 2));
    console.log("Targets saved to target_list.json");
}

listTargets();
