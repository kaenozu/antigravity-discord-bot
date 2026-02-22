import fs from 'fs';
import { spawn } from 'child_process';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import path from 'path';

async function runTest() {
    console.log('--- SYSTEM TEST FOR DISCORD BOT QUEUE & AUTO-APPROVE ---');

    console.log('[1] Starting Mock CDP Server on port 9222...');
    let cdpState = {
        generating: false,
        approvalNeeded: false,
        response: null
    };

    // 1. Mock CDP HTTP Server
    const server = http.createServer((req, res) => {
        if (req.url === '/json/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify([{
                type: 'page',
                title: 'Antigravity Mock',
                webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/mock123'
            }]));
        } else if (req.url === '/test/set_approval') {
            cdpState.approvalNeeded = true;
            res.writeHead(200); res.end('OK');
        } else if (req.url === '/test/set_generating') {
            cdpState.generating = true;
            res.writeHead(200); res.end('OK');
        } else if (req.url === '/test/set_done') {
            cdpState.generating = false;
            cdpState.response = "Hello from AI in CDP!";
            res.writeHead(200); res.end('OK');
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    // 2. Mock CDP WebSocket Server
    const wss = new WebSocketServer({ server });
    wss.on('connection', ws => {
        ws.on('message', msg => {
            const data = JSON.parse(msg.toString());
            // mock Evaluate
            if (data.method === 'Runtime.evaluate') {
                const expr = data.params.expression;
                let resultObj = { type: 'undefined' };

                if (expr.includes('checkApprovalRequired')) {
                    if (cdpState.approvalNeeded) {
                        resultObj = { type: 'string', value: '{ "message": "Mock approval requested for a destructive action" }' };
                    } else {
                        resultObj = { type: 'undefined' };
                    }
                } else if (expr.includes('checkIsGenerating')) {
                    resultObj = { type: 'boolean', value: cdpState.generating };
                } else if (expr.includes('getLastResponse')) {
                    if (cdpState.response) {
                        resultObj = { type: 'string', value: JSON.stringify({ text: cdpState.response }) };
                    } else {
                        resultObj = { type: 'undefined' };
                    }
                } else if (expr.includes('clickApproval')) {
                    if (expr.includes('true')) {
                        console.log('>>> [MOCK CDP] Received clickApproval(true) - Mocking approval resolved!!!');
                        cdpState.approvalNeeded = false;
                    }
                    resultObj = { type: 'boolean', value: true };
                }

                ws.send(JSON.stringify({
                    id: data.id,
                    result: {
                        result: resultObj
                    }
                }));
            }

            // mock Contexts
            if (data.method === 'Runtime.enable') {
                ws.send(JSON.stringify({ id: data.id, result: {} }));
                setTimeout(() => {
                    ws.send(JSON.stringify({
                        method: 'Runtime.executionContextCreated',
                        params: { context: { id: 1, name: 'context1' } }
                    }));
                }, 100);
            }
        });
    });

    server.listen(9222);
    console.log('[OK] Mock CDP Server is running on port 9222.');

    console.log('[2] Patching discord_bot.js for system test...');
    let originalCode = fs.readFileSync('discord_bot.js', 'utf8');

    // Make local mock copy
    let testCode = originalCode.replace(/process.env.DISCORD_BOT_TOKEN/g, '"mock-token"');
    testCode = testCode.replace(/import chokidar from 'chokidar';/g, 'const chokidar = { watch: () => ({ on: () => {} }) };');
    testCode = testCode.replace(/client\.login\(.*\);/g, `
        console.log('>> [TEST MOCK] Bot Initialized <<');
        
        // Ensure auto approval is on
        globalThis.isAutoApproval = true;
        
        // Give it a tiny bit to connect
        setTimeout(async () => {
             console.log('[TEST] Connecting CDP...');
             let cdp = await ensureCDP();
             
             console.log('[TEST] Enqueuing a mock request...');
             const dummyOriginalMessage = {
                author: { id: 'mock-user' },
                channel: { send: async(msg) => console.log('>> [BOT CHANNEL SEND] ' + String(msg).substring(0, 100)) },
                reply: async (msg) => { 
                    console.log('>> [BOT REPLY] ' + String(msg.content ? msg.content : msg).substring(0, 100)); 
                    return { edit: async (m) => console.log('>> [BOT EDIT] ' + String(m.content).substring(0, 100)) }; 
                }
             };
             
             // Trigger monitorAIResponse
             globalThis.requestQueue.push({ originalMessage: dummyOriginalMessage, prevSnapshot: null });
             processQueue(cdp);

             // Control the server state over HTTP
             setTimeout(() => {
                 console.log('[TEST] Triggering Approval required in CDP');
                 http.get('http://127.0.0.1:9222/test/set_approval');
             }, 4000);

             setTimeout(() => {
                 console.log('[TEST] Triggering Generating state in CDP');
                 http.get('http://127.0.0.1:9222/test/set_generating');
             }, 8000);

             setTimeout(() => {
                 console.log('[TEST] Triggering Generation Done with response in CDP');
                 http.get('http://127.0.0.1:9222/test/set_done');
             }, 13000);

             setTimeout(() => {
                 console.log('--- TEST FINISHED SUCCESSFULLY ---');
                 process.exit(0);
             }, 20000);

        }, 1000);
    `);

    // EXPOSE queue to global space for the test injection
    testCode = testCode.replace('let requestQueue = [];', 'globalThis.requestQueue = [];');

    fs.writeFileSync('discord_bot_test_auto.mjs', testCode, 'utf8');

    console.log('[3] Running Test Bot Process...');
    const botProcess = spawn('node', ['discord_bot_test_auto.mjs'], { stdio: 'pipe' });

    let botOutput = '';
    botProcess.stdout.on('data', data => {
        botOutput += data.toString();
        process.stdout.write(data);
    });
    botProcess.stderr.on('data', data => {
        botOutput += data.toString();
        process.stderr.write(data);
    });

    botProcess.on('exit', (code) => {
        server.close();
        if (code === 0 && botOutput.includes('Auto-Approved') && botOutput.includes('Hello from AI in CDP!')) {
            console.log('\\n✅ System Test Passed! ReferenceError avoided, Auto-approve sent, and AI response processed.');
        } else {
            console.log('\\n❌ System Test Failed. Check output.');
            process.exit(1);
        }
    });

}

runTest().catch(console.error);
