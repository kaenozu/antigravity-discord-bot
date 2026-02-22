const http = require('http');

const PORTS = [9222, 9000, 9001, 9002, 9003];

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function run() {
    console.log("--- Scanning CDP Targets ---");
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            console.log(`Port ${port}: Found ${list.length} targets`);
            list.forEach((t, i) => {
                console.log(`  [${i}] Title: ${t.title}`);
                console.log(`      URL: ${t.url}`);
                console.log(`      Type: ${t.type}`);
            });
        } catch (e) {
            console.log(`Port ${port}: Failed (${e.message})`);
        }
    }
}

run();
