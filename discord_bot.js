import { Client, GatewayIntentBits, Partials, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes } from 'discord.js';
import { SELECTORS } from './selectors.js';
import chokidar from 'chokidar';
import 'dotenv/config';
import WebSocket from 'ws';
import http from 'http';
import https from 'https';
import readline from 'readline';
import { stdin as input, stdout as output } from 'process';
import fs from 'fs';
import path from 'path';

// --- CONFIGURATION ---
const PORTS = [9222, 9000, 9001, 9002, 9003];
const CDP_CALL_TIMEOUT = 30000;
const POLLING_INTERVAL = 2000;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// State
let cdpConnection = null;
let isGenerating = false;
let lastActiveChannel = null;
let lastApprovalMessage = null;
const processedMessages = new Set();
let requestQueue = [];
let isMonitoring = false;
// 監視対象ディレクトリ（初期化時に設定）
let WORKSPACE_ROOT = null;
const LOG_FILE = 'discord_interaction.log';

// --- LOGGING ---
// --- LOGGING ---
const COLORS = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m"
};

function setTitle(status) {
    process.stdout.write(String.fromCharCode(27) + "]0;Antigravity Bot: " + status + String.fromCharCode(7));
}

function logInteraction(type, content) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${content}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);

    let color = COLORS.reset;
    let icon = "";

    switch (type) {
        case 'INJECT':
        case 'SUCCESS':
            color = COLORS.green;
            icon = "✅ ";
            break;
        case 'ERROR':
            color = COLORS.red;
            icon = "❌ ";
            break;
        case 'generating':
            color = COLORS.yellow;
            icon = "🤔 ";
            break;
        case 'CDP':
            color = COLORS.cyan;
            icon = "🔌 ";
            break;
        default:
            color = COLORS.reset;
    }

    console.log(`${color}[${type}] ${icon}${content}${COLORS.reset}`);

    // Update Title based on high-level statuses
    if (type === 'CDP' && content.includes('Connected')) setTitle("🟢 Connected");
    if (type === 'CDP' && content.includes('disconnected')) setTitle("🔴 Disconnected");
    if (type === 'generating') setTitle("🟡 Generating...");
    if (type === 'SUCCESS' || (type === 'INJECT' && !content.includes('failed'))) setTitle("🟢 Connected");
}

// --- ファイルダウンロード ---
function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => {
            // リダイレクト対応
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// --- CDP HELPERS ---
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

async function discoverCDP() {
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            console.log(`[CDP] Checking port ${port}, found ${list.length} targets.`);
            for (const t of list) {
                console.log(` - ${t.type}: ${t.title || t.url} (${t.webSocketDebuggerUrl})`);
            }

            // Priority 0: "Manager" ターゲット = Open Agent Manager (Cascade チャット UI)
            let target = list.find(t =>
                t.type === 'page' &&
                t.webSocketDebuggerUrl &&
                t.title === 'Manager'
            );

            // Priority 1: Target that is NOT Launchpad and looks like a project window
            if (!target) {
                target = list.find(t =>
                    t.type === 'page' &&
                    t.webSocketDebuggerUrl &&
                    !t.title.includes('Launchpad') &&
                    !t.url.includes('workbench-jetski-agent') &&
                    (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade'))
                );
            }

            // Priority 2: Any workbench/project target even if title is weird
            if (!target) {
                target = list.find(t =>
                    t.webSocketDebuggerUrl &&
                    (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade')) &&
                    !t.title.includes('Launchpad')
                );
            }

            // Priority 3: Fallback (Launchpad or anything matching original criteria)
            if (!target) {
                target = list.find(t =>
                    t.webSocketDebuggerUrl &&
                    (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade') || t.title.includes('Launchpad'))
                );
            }

            if (target && target.webSocketDebuggerUrl) {
                console.log(`[CDP] Connected to target: ${target.title} (${target.url})`);
                return { port, url: target.webSocketDebuggerUrl };
            }
        } catch (e) {
            console.log(`[CDP] Port ${port} check failed: ${e.message}`);
        }
    }
    throw new Error("CDP not found.");
}


async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });
    const contexts = [];
    let idCounter = 1;
    const pending = new Map();

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.id !== undefined && pending.has(data.id)) {
                const { resolve, reject, timeoutId } = pending.get(data.id);
                clearTimeout(timeoutId);
                pending.delete(data.id);
                if (data.error) reject(data.error); else resolve(data.result);
            }
            if (data.method === 'Runtime.executionContextCreated') {
                const ctx = data.params.context;
                if (!contexts.find(c => c.id === ctx.id)) contexts.push(ctx);
            }
            if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const timeoutId = setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); reject(new Error("Timeout")); }
        }, CDP_CALL_TIMEOUT);
        pending.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });

    ws.on('close', () => {
        logInteraction('CDP', 'WebSocket disconnected.');
        if (cdpConnection && cdpConnection.ws === ws) {
            cdpConnection = null;
        }
    });

    // コンテキストを動的に取得するヘルパー
    // イベントで収集したものが空の場合、executionContextDescriptions でフォールバック
    const getContexts = async () => {
        if (contexts.length > 0) return contexts;
        try {
            const res = await call("Runtime.executionContextDescriptions", {});
            const descs = res?.executionContextDescriptions || [];
            console.log(`[CDP] Dynamic context fetch: ${descs.length} contexts found.`);
            for (const ctx of descs) {
                if (!contexts.find(c => c.id === ctx.id)) contexts.push(ctx);
            }
        } catch (e) {
            console.log(`[CDP] executionContextDescriptions failed: ${e.message}`);
        }
        return contexts;
    };

    await call("Runtime.enable", {});
    await call("Runtime.disable", {}); // Toggle to force re-emission of events
    await call("Runtime.enable", {});
    // Target.setDiscoverTargets を有効化 → Target.getTargets で全ターゲット（Manager含む）が見えるようになる
    try { await call("Target.setDiscoverTargets", { discover: true }); } catch (e) { }
    await new Promise(r => setTimeout(r, 1500)); // Wait for context events

    // イベントで取れていない場合は動的取得を試みる
    if (contexts.length === 0) {
        await getContexts();
    }

    console.log(`[CDP] Initialized with ${contexts.length} contexts.`);
    logInteraction('CDP', `Connected to target: ${url}`);
    return { ws, call, contexts, getContexts };
}

async function ensureCDP() {
    if (cdpConnection && cdpConnection.ws.readyState === WebSocket.OPEN) return cdpConnection;
    try {
        const { url } = await discoverCDP();
        cdpConnection = await connectCDP(url);
        return cdpConnection;
    } catch (e) { return null; }
}

// --- CDP ユーティリティ: 全コンテキストで式を評価する共通ヘルパー ---
// コンテキストが0の場合は動的取得を試み、それでも0ならデフォルトコンテキストで実行
async function evalInAllContexts(cdp, expression, opts = {}) {
    const { returnByValue = true, awaitPromise = false, stopOnSuccess = true, successCheck = (v) => v !== null && v !== undefined && v !== false } = opts;

    // まずコンテキストを最新状態にする
    let contexts = await cdp.getContexts();

    // まだ空なら諦めてデフォルトコンテキスト（contextId指定なし）で試す
    if (contexts.length === 0) {
        console.log('[evalInAllContexts] No contexts found, trying default context...');
        try {
            const res = await cdp.call("Runtime.evaluate", { expression, returnByValue, awaitPromise });
            return [{ value: res.result?.value, contextId: 'default' }];
        } catch (e) {
            console.log(`[evalInAllContexts] Default context error: ${e.message}`);
            return [];
        }
    }

    const results = [];
    for (const ctx of contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression, returnByValue, awaitPromise, contextId: ctx.id });
            const value = res.result?.value;
            results.push({ value, contextId: ctx.id, contextUrl: ctx.url || ctx.name || '' });
            if (stopOnSuccess && successCheck(value)) break;
        } catch (e) { /* continue */ }
    }
    return results;
}

async function ensureWatchDir() {
    if (process.env.WATCH_DIR !== undefined) {
        if (process.env.WATCH_DIR.trim() === '') {
            WORKSPACE_ROOT = null; // 明示的に無効化
            return;
        }
        WORKSPACE_ROOT = process.env.WATCH_DIR;
        if (!fs.existsSync(WORKSPACE_ROOT)) {
            console.error(`Error: WATCH_DIR '${WORKSPACE_ROOT}' does not exist.`);
            process.exit(1);
        }
        return;
    }

    const rl = readline.createInterface({ input, output });
    console.log('\n--- 監視設定 ---');

    while (true) {
        // 空欄で監視機能無効化
        const answer = await rl.question(`監視するフォルダのパスを入力してください（空欄で監視機能を無効化）: `);
        const folderPath = answer.trim();

        if (folderPath === '') {
            console.log('🚫 監視機能を無効化しました。');
            WORKSPACE_ROOT = null;
            try {
                fs.appendFileSync('.env', `\nWATCH_DIR=`);
            } catch (e) {
                console.warn('⚠️ .envへの保存に失敗しました:', e.message);
            }
            break;
        }

        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
            WORKSPACE_ROOT = folderPath;
            // .env に保存
            try {
                fs.appendFileSync('.env', `\nWATCH_DIR=${folderPath}`);
                console.log(`✅ 設定を.envに保存しました: WATCH_DIR=${folderPath}`);
            } catch (e) {
                console.warn('⚠️ .envへの保存に失敗しました:', e.message);
            }
            break;
        } else {
            console.log('❌ 無効なパスです。存在するディレクトリを指定してください。');
        }
    }
    rl.close();
}

// --- DOM SCRIPTS ---

// Manager ターゲット（Cascade チャット UI）に直接メッセージを送信するヘルパー
async function injectMessageToManagerTarget(cdp, msg) {
    let managerWsUrl = null;
    try {
        const targets = await cdp.call("Target.getTargets");
        const manager = (targets.targetInfos || []).find(t =>
            t.type === 'page' && t.title.includes('Antigravity') && !t.title.includes('Launchpad')
        );
        if (manager?.targetId) managerWsUrl = `ws://127.0.0.1:9222/devtools/page/${manager.targetId}`;
    } catch (e) { }

    if (!managerWsUrl) {
        try {
            const list = await new Promise((resolve) => {
                const http = require('http');
                http.get('http://127.0.0.1:9222/json/list', res => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(JSON.parse(data)));
                }).on('error', () => resolve([]));
            });
            const manager = list.find(t => t.type === 'page' && t.title.includes('Antigravity') && !t.title.includes('Launchpad'));
            if (manager) managerWsUrl = manager.webSocketDebuggerUrl;
        } catch (e) { }
    }

    if (!managerWsUrl) return null;

    const safeText = JSON.stringify(msg);

    return new Promise((resolve) => {
        const ws = new WebSocket(managerWsUrl);
        const timeout = setTimeout(() => { ws.close(); resolve(null); }, 8000);

        ws.on('open', async () => {
            let id = 1;
            const pending = new Map();
            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    if (data.id !== undefined && pending.has(data.id)) {
                        const { resolve } = pending.get(data.id);
                        pending.delete(data.id);
                        resolve(data.result);
                    }
                } catch (e) { }
            });
            const call = (method, params = {}) => new Promise((res) => {
                const curId = id++;
                pending.set(curId, { resolve: res });
                ws.send(JSON.stringify({ id: curId, method, params }));
                setTimeout(() => { pending.delete(curId); res(null); }, 5000);
            });

            const EXP = `(async () => {
                const shadowQuery = (sel, root) => {
                    const res = [];
                    try { for (const el of root.querySelectorAll(sel)) res.push(el); } catch(e){}
                    try {
                        for (const el of root.querySelectorAll('*')) {
                            if (el.shadowRoot) res.push(...shadowQuery(sel, el.shadowRoot));
                            if (el.contentDocument) res.push(...shadowQuery(sel, el.contentDocument));
                        }
                    } catch(e){}
                    return res;
                };

                const ext = [
                    'div[contenteditable="true"][data-lexical-editor="true"]',
                    'textarea[placeholder*="Ask"]', 'textarea[placeholder*="Message"]', 'textarea[placeholder*="Chat"]',
                    'div[contenteditable="true"][aria-label*="Chat"]', '#chat-input', '.chat-input', 'textarea'
                ];

                let editor = null;
                for (const sel of ext) {
                    const els = shadowQuery(sel, document);
                    if (els.length > 0) {
                        editor = els[0];
                        break;
                    }
                }

                if (!editor) return { ok: false, error: "Manager target found, but no editor found in it" };

                if (editor.isContentEditable) {
                    editor.focus();
                    document.execCommand('insertText', false, ${safeText});
                    
                    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
                    editor.dispatchEvent(new Event("change", { bubbles: true }));
                } else {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                    if (setter) setter.call(editor, ${safeText});
                    else editor.value = ${safeText};
                }

                editor.dispatchEvent(new Event("input", { bubbles: true }));
                editor.dispatchEvent(new Event("change", { bubbles: true }));
                editor.focus();

                await new Promise(r => setTimeout(r, 100));

                const btns = shadowQuery('button', document);
                const submit = btns.find(btn => {
                    if (btn.offsetWidth === 0) return false;
                    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                    const txt = (btn.innerText || '').toLowerCase();
                    return aria.includes('send') || aria.includes('submit') || txt.includes('send') || txt.includes('submit') || (btn.querySelector('svg') && btn.innerHTML.includes('lucide-send'));
                });

                if (submit) {
                    submit.click();
                    return { ok: true, method: "click" };
                }

                editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
                return { ok: true, method: "enter" };
            })()`;

            try {
                await call('Runtime.enable');
                const res = await call('Runtime.evaluate', { expression: EXP, returnByValue: true, awaitPromise: true });
                const val = res?.result?.value;
                clearTimeout(timeout);
                ws.close();
                resolve((val && val.ok) ? { ok: true, method: val.method } : { ok: false, error: val?.error || "Unknown evaluate error" });
            } catch (e) {
                clearTimeout(timeout);
                ws.close();
                resolve({ ok: false, error: `evaluate try block catch: ${e.message}` });
            }
        });

        ws.on('error', (e) => {
            clearTimeout(timeout);
            resolve({ ok: false, error: `WS error: ${e.message}` });
        });
    });
}

async function injectMessage(cdp, msg) {
    // まず Manager ターゲット（チャットUI専用）への直結を試みる
    const managerRes = await injectMessageToManagerTarget(cdp, msg);
    if (managerRes?.ok) {
        logInteraction('INJECT', `Sent: ${msg.substring(0, 50).replace(/\\n/g, ' ')}... (Manager Target)`);
        return { success: true };
    } else {
        console.log(`[injectMessage] Manager target failed:`, managerRes?.error || "Could not find managerWsUrl (Panel closed?)");
    }

    const safeText = JSON.stringify(msg);
    const EXP = `(async () => {
        const shadowQuery = (sel, root) => {
            const res = [];
            try { for (const el of root.querySelectorAll(sel)) res.push(el); } catch(e){}
            try {
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) res.push(...shadowQuery(sel, el.shadowRoot));
                    if (el.contentDocument) res.push(...shadowQuery(sel, el.contentDocument));
                }
            } catch(e){}
            return res;
        };

        const ext = [
            'div[contenteditable="true"][data-lexical-editor="true"]',
            'textarea[placeholder*="Ask"]', 'textarea[placeholder*="Message"]', 'textarea[placeholder*="Chat"]',
            'div[contenteditable="true"][aria-label*="Chat"]', '#chat-input', '.chat-input', 'textarea'
        ];

        let editor = null;
        for (const sel of ext) {
            const els = shadowQuery(sel, document);
            if (els.length > 0) {
                editor = els[0];
                break;
            }
        }

        if (!editor) return { ok: false, error: "No editor found in this context" };

        if (editor.isContentEditable) {
            editor.focus();
            document.execCommand('insertText', false, ${safeText});
            editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
            editor.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
            if (setter) setter.call(editor, ${safeText});
            else editor.value = ${safeText};
        }

        editor.dispatchEvent(new Event("input", { bubbles: true }));
        editor.dispatchEvent(new Event("change", { bubbles: true }));
        editor.focus();

        await new Promise(r => setTimeout(r, 100));

        const btns = shadowQuery('button', document);
        const submit = btns.find(btn => {
            if (btn.offsetWidth === 0) return false;
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const txt = (btn.innerText || '').toLowerCase();
            return aria.includes('send') || aria.includes('submit') || txt.includes('send') || txt.includes('submit') || (btn.querySelector('svg') && btn.innerHTML.includes('lucide-send'));
        });

        if (submit) {
            submit.click();
            return { ok: true, method: "click" };
        }

        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        return { ok: true, method: "enter" };
    })()`;

    // Strategy: Prioritize context that looks like cascade-panel
    const allContexts = cdp.contexts || [];
    const targetContexts = allContexts.filter(c =>
        (c.url && c.url.includes('cascade')) ||
        (c.name && c.name.includes('Extension'))
    );

    // If no specific context found, try all
    const contextsToTry = targetContexts.length > 0 ? targetContexts : allContexts;

    for (const ctx of contextsToTry) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value?.ok) {
                logInteraction('INJECT', `Sent: ${msg.substring(0, 50)}... (Priority Context: ${ctx.id})`);
                return res.result.value;
            }
        } catch (e) { }
    }

    const otherContexts = allContexts.filter(c => !contextsToTry.includes(c));
    for (const ctx of otherContexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value?.ok) {
                logInteraction('INJECT', `Sent: ${msg.substring(0, 50)}... (Fallback Context: ${ctx.id})`);
                return res.result.value;
            }
        } catch (e) { }
    }

    // 最終フォールバック: コンテキストなし（デフォルト）で試す
    if (allContexts.length === 0) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true });
            if (res.result?.value?.ok) {
                logInteraction('INJECT', `Sent: ${msg.substring(0, 50)}... (Default Context)`);
                return res.result.value;
            }
        } catch (e) {
            console.log(`[Injection] Default context error: ${e.message}`);
        }
    }

    return { ok: false, error: "Injection failed. Chat panel might be closed." };
}

async function checkIsGenerating(cdp) {
    const EXP = `(() => {
        // 全iframeとメインドキュメントを検索
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e){}
        }

        for (const doc of docs) {
            // 1. キャンセルボタン（AIがテキスト生成中）
            const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
            if (cancel && cancel.offsetParent !== null) return true;
            
            // 2. ツール実行中のスピナー・ローディング表示
            const spinner = doc.querySelector('[aria-label*="loading"], [aria-label*="Loading"], [class*="spinner"], [class*="loading"]');
            if (spinner && spinner.offsetParent !== null) return true;
            
            // 3. 「Running command」「Executing」などのツール実行中表示
            const runningIndicators = doc.querySelectorAll('[class*="running"], [class*="executing"], [class*="pending"]');
            for (const el of runningIndicators) {
                if (el.offsetParent !== null) return true;
            }
        }
        return false;
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value === true) return true;
        } catch (e) { }
    }
    // コンテキストが0の場合はデフォルトコンテキストで試す
    if (cdp.contexts.length === 0) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true });
            if (res.result?.value === true) return true;
        } catch (e) { }
    }
    return false;
}

async function checkApprovalRequired(cdp) {
    const EXP = `(() => {
        // Helper to get document
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for(let i=0; i<iframes.length; i++) {
                if(iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch(e){}
                }
            }
            return document; 
        }
        const doc = getTargetDoc();
        if (!doc) return null;

        // Keywords for approval buttons
        const approvalKeywords = [
            'run', 'approve', 'allow', 'yes', 'accept', 'confirm', 
            'save', 'apply', 'create', 'update', 'delete', 'remove', 'submit', 'send', 'retry', 'continue',
            'always allow', 'allow once', 'allow this conversation',
            '実行', '許可', '承認', 'はい', '同意', '保存', '適用', '作成', '更新', '削除', '送信', '再試行', '続行'
        ];
        // Anchor keywords (The "No" or "Secondary" button)
        const anchorKeywords = ['cancel', 'reject', 'deny', 'ignore', 'キャンセル', '拒否', '無視', 'いいえ', '不許可'];
        const ignoreKeywords = ['all', 'すべて', '一括', 'auto'];

        let found = null;

        function scan(root) {
            if (found) return;
            if (!root) return;
            
            // Restrict anchor search to interactive elements
            // エディタの差分 UI (.cascade-bar, .part.titlebar) は除外
            function isEditorUI(el) {
                return !!(el.closest && (
                    el.closest('.cascade-bar') ||
                    el.closest('.part.titlebar') ||
                    el.closest('.editor-instance') ||
                    el.closest('.monaco-editor') ||
                    el.closest('.diff-editor')
                ));
            }
            const potentialAnchors = Array.from(root.querySelectorAll ? root.querySelectorAll('button, [role="button"], .cursor-pointer') : []).filter(el => {
                if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
                if (isEditorUI(el)) return false; // エディタ UI を除外
                const txt = (el.innerText || '').trim().toLowerCase();
                // Match anchor keywords
                return anchorKeywords.some(kw => txt === kw || txt.startsWith(kw + ' '));
            }).reverse();

            for (const anchor of potentialAnchors) {
                if (found) return;

                // Look for siblings or cousins in the same container
                const container = anchor.closest('.flex') || anchor.parentElement;
                if (!container) continue;

                const parent = container.parentElement;
                if (!parent) continue;

                // Find potential Approval Buttons in the vicinity
                const searchScope = parent.parentElement || parent;
                const buttons = Array.from(searchScope.querySelectorAll('button, [role="button"], .cursor-pointer'));
                
                const approvalButton = buttons.find(btn => {
                    if (btn === anchor) return false;
                    if (btn.offsetWidth === 0) return false;
                    
                    const txt = (btn.innerText || '').toLowerCase().trim();
                    const aria = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
                    const title = (btn.getAttribute('title') || '').toLowerCase().trim();
                    const combined = txt + ' ' + aria + ' ' + title;
                    
                    return approvalKeywords.some(kw => combined.includes(kw)) && 
                           !ignoreKeywords.some(kw => combined.includes(kw));
                });

                if (approvalButton) {
                    let textContext = "Command or Action requiring approval";
                    const itemContainer = searchScope.closest('.flex.flex-col.gap-2.border-gray-500\\\\/25') || 
                                          searchScope.closest('.group') || 
                                          searchScope.closest('.prose')?.parentElement;
                    
                    if (itemContainer) {
                         const prose = itemContainer.querySelector('.prose');
                         const pre = itemContainer.querySelector('pre');
                         const header = itemContainer.querySelector('.text-sm.border-b') || itemContainer.querySelector('.font-semibold');
                         
                         let msg = [];
                         if (header) msg.push(\`[Header] \${header.innerText.trim()}\`);
                         if (prose) msg.push(prose.innerText.trim());
                         if (pre) msg.push(\`[Command] \${pre.innerText.trim()}\`);
                         
                         if (msg.length > 0) textContext = msg.join('\\n\\n');
                         else textContext = itemContainer.innerText.trim();
                    }

                    found = { required: true, message: textContext.substring(0, 1500) };
                    return;
                }
            }

            // Traverse Shadow Roots
            try {
                const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
                let n;
                while (n = walker.nextNode()) {
                    if (found) return;
                    if (n.shadowRoot) scan(n.shadowRoot);
                }
            } catch(e){}
        }

        scan(doc.body);
        return found;
    })()`;

    // Evaluate in all contexts because we might access iframe via main window with cross-origin access (if same origin)
    // OR we might be lucky and the iframe has its own context.
    // Since we saw "Found Context ID: 6" in dump_agent_panel, it HAS its own context.
    // AND detection via `document.querySelectorAll('iframe').contentDocument` works if same origin.
    // Let's try traversing from main document first (easiest if works).
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value?.required) return res.result.value;
        } catch (e) { }
    }
    // コンテキストが0の場合はデフォルトコンテキストで試す
    if (cdp.contexts.length === 0) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true });
            if (res.result?.value?.required) return res.result.value;
        } catch (e) { }
    }
    return null;
}

async function clickApproval(cdp, allow) {
    const isAllowStr = allow ? 'true' : 'false';
    const EXP = `(() => {
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for(let i=0; i<iframes.length; i++) {
                if(iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch(e){}
                }
            }
            return document; 
        }
        const doc = getTargetDoc();
        if (!doc) return { success: false, log: ["No document found"] };

        const approvalKeywords = [
            'run', 'approve', 'allow', 'yes', 'accept', 'confirm', 
            'save', 'apply', 'create', 'update', 'delete', 'remove', 'submit', 'send', 'retry', 'continue',
            'always allow', 'allow once', 'allow this conversation',
            '実行', '許可', '承認', 'はい', '同意', '保存', '適用', '作成', '更新', '削除', '送信', '再試行', '続行'
        ];
        const anchorKeywords = ['cancel', 'reject', 'deny', 'ignore', 'キャンセル', '拒否', '無視', 'いいえ', '不許可'];
        const ignoreKeywords = ['all', 'すべて', '一括', 'auto'];
        
        const isAllow = ${isAllowStr};
        let found = false;
        let log = [];

        function scan(root) {
            if (found) return;
            if (!root) return;
            
            function isEditorUI(el) {
                return !!(el.closest && (
                    el.closest('.cascade-bar') ||
                    el.closest('.part.titlebar') ||
                    el.closest('.editor-instance') ||
                    el.closest('.monaco-editor') ||
                    el.closest('.diff-editor')
                ));
            }

            const potentialAnchors = Array.from(root.querySelectorAll ? root.querySelectorAll('button, [role="button"], .cursor-pointer') : []).filter(el => {
                if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
                if (isEditorUI(el)) return false; 
                const txt = (el.innerText || '').trim().toLowerCase();
                return anchorKeywords.some(kw => txt === kw || txt.startsWith(kw + ' '));
            }).reverse();

            for (const anchor of potentialAnchors) {
                if (found) return;

                if (!isAllow) {
                    log.push("CLICKING Reject: " + (anchor.innerText || '').trim());
                    let r = anchor.getBoundingClientRect();
                    
                    let offsetX = 0; let offsetY = 0;
                    if (doc !== document) {
                        for(let i=0; i<document.querySelectorAll('iframe').length; i++) {
                            const iframe = document.querySelectorAll('iframe')[i];
                            if (iframe.contentDocument === doc) {
                                let ir = iframe.getBoundingClientRect();
                                offsetX = ir.left; offsetY = ir.top;
                                break;
                            }
                        }
                    }

                    found = true;
                    return { success: true, log: log, rect: { x: r.left + offsetX, y: r.top + offsetY, w: r.width, h: r.height } };
                }

                // 承認(Approve)の場合は同じコンテナ内の承認ボタンを探す
                const container = anchor.closest('.flex') || anchor.parentElement;
                if (!container) continue;

                const parent = container.parentElement;
                if (!parent) continue;

                const searchScope = parent.parentElement || parent;
                const buttons = Array.from(searchScope.querySelectorAll('button, [role="button"], .cursor-pointer'));
                
                let approvalBtns = buttons.filter(btn => {
                    if (btn === anchor) return false;
                    if (btn.offsetWidth === 0) return false;
                    
                    const txt = (btn.innerText || '').toLowerCase().trim();
                    const aria = (btn.getAttribute('aria-label') || '').toLowerCase().trim();
                    const title = (btn.getAttribute('title') || '').toLowerCase().trim();
                    const combined = txt + ' ' + aria + ' ' + title;
                    
                    return approvalKeywords.some(kw => combined.includes(kw) || combined === kw) && 
                           !ignoreKeywords.some(kw => combined.includes(kw));
                });

                if (approvalBtns.length > 0) {
                    // スプリットボタンのドロップダウンを避けるため、テキストやaria-labelが完全にメインアクション（Runなど）と一致する要素を最優先する
                    approvalBtns.sort((a, b) => {
                         const txtA = (a.innerText || '').trim();
                         const ariaA = (a.getAttribute('aria-label') || '').trim();
                         const matchA = txtA || ariaA;

                         const txtB = (b.innerText || '').trim();
                         const ariaB = (b.getAttribute('aria-label') || '').trim();
                         const matchB = txtB || ariaB;

                         let scoreA = 10; 
                         if (matchA === 'Run' || matchA === 'Approve' || matchA === '実行' || matchA === '許可' || matchA === 'Run command' || matchA === 'Accept all') scoreA = 100;
                         else if (matchA.toLowerCase() === 'run' || matchA.toLowerCase() === 'approve') scoreA = 90;
                         else if (matchA === '') scoreA = -10;
                         else if (matchA.toLowerCase().includes('always')) scoreA = -100;

                         let scoreB = 10; 
                         if (matchB === 'Run' || matchB === 'Approve' || matchB === '実行' || matchB === '許可' || matchB === 'Run command' || matchB === 'Accept all') scoreB = 100;
                         else if (matchB.toLowerCase() === 'run' || matchB.toLowerCase() === 'approve') scoreB = 90;
                         else if (matchB === '') scoreB = -10;
                         else if (matchB.toLowerCase().includes('always')) scoreB = -100;

                         return scoreB - scoreA;
                    });

                    log.push("CLICKING Approve: '" + (approvalBtns[0].innerText || '').trim() + "' / aria: '" + (approvalBtns[0].getAttribute('aria-label') || '') + "' (class: " + approvalBtns[0].className + ")");
                    const btnToClick = approvalBtns[0];
                    let r = btnToClick.getBoundingClientRect();
                    
                    let offsetX = 0; let offsetY = 0;
                    if (doc !== document) {
                        for(let i=0; i<document.querySelectorAll('iframe').length; i++) {
                            const iframe = document.querySelectorAll('iframe')[i];
                            if (iframe.contentDocument === doc) {
                                let ir = iframe.getBoundingClientRect();
                                offsetX = ir.left; offsetY = ir.top;
                                break;
                            }
                        }
                    }

                    // Synthetic click dispatch removed - rely solely on CDP native click to precisely hit the main area instead of dropdown chevron.
                    
                    found = true;
                    return { success: true, log: log, rect: { x: r.left + offsetX, y: r.top + offsetY, w: r.width, h: r.height } };
                }
            }

            try {
                const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
                let n;
                while (n = walker.nextNode()) {
                    if (found) return;
                    if (n.shadowRoot) scan(n.shadowRoot);
                }
            } catch(e){}
        }

        const scanRes = scan(doc.body);
        if (scanRes) return scanRes;
        return { success: found, log: log };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const evalPromise = cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
            const res = await Promise.race([evalPromise, timeoutPromise]);
            // DEBUG: if (res.result?.value?.log) console.log(`[CLICK LOG]`, res.result.value.log);
            if (res.result?.value?.success) {
                logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (success) - ${res.result.value.log.join(', ')}`);
                if (res.result.value.rect) {
                    const r = res.result.value.rect;
                    const cx = r.x + 8;
                    const cy = r.y + r.h / 2;
                    try {
                        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
                        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
                        await new Promise(resolve => setTimeout(resolve, 50));
                        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });

                        logInteraction('CLICK', `CDP Native Click & Key dispatched at x:${cx}, y:${cy}`);
                    } catch (err) {
                        logInteraction('ERROR', `CDP Native Click failed: ${err.message}`);
                    }
                }
                return res.result.value;
            }
        } catch (e) { }
    }

    // Fallback to default context if context specific fails
    if (cdp.contexts.length === 0) {
        try {
            const evalPromise = cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
            const res = await Promise.race([evalPromise, timeoutPromise]);
            if (res.result?.value?.success) {
                logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (success) - ${res.result.value.log ? res.result.value.log.join(', ') : ''}`);
                if (res.result.value.rect) {
                    const r = res.result.value.rect;
                    const cx = r.x + 8;
                    const cy = r.y + r.h / 2;
                    try {
                        await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
                        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
                        await new Promise(resolve => setTimeout(resolve, 50));
                        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });

                        logInteraction('CLICK', `CDP Native Click & Key dispatched at x:${cx}, y:${cy}`);
                    } catch (err) { }
                }
                return res.result.value;
            }
        } catch (e) { }
    }

    logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (failed)`);
    return { success: false };
}


// Manager ターゲット（Cascade チャット UI）から AI 応答を取得するヘルパー
async function getResponseFromManagerTarget(cdp) {
    // Target.getTargets で Manager を探す
    let managerWsUrl = null;
    try {
        const targets = await cdp.call("Target.getTargets");
        const allTargets = targets.targetInfos || [];
        // 全ターゲットをログ（デバッグ用）
        console.log(`[Manager] Target.getTargets: ${allTargets.length} targets`);
        for (const t of allTargets) {
            console.log(`  - type=${t.type} title="${t.title}" id=${t.targetId}`);
        }
        const manager = allTargets.find(t =>
            t.type === 'page' &&
            (t.title === 'Manager' || t.title.includes('jetski') || t.url.includes('jetski')) && !t.title.includes('Launchpad')
        );
        if (manager?.targetId) {
            managerWsUrl = `ws://127.0.0.1:9222/devtools/page/${manager.targetId}`;
            console.log(`[getLastResponse] Found Manager target: ${manager.targetId}`);
        }
    } catch (e) {
        console.log(`[getLastResponse] Target.getTargets failed: ${e.message}`);
    }

    // /json/list でも探す（フォールバック）
    if (!managerWsUrl) {
        try {
            const list = await getJson('http://127.0.0.1:9222/json/list');
            console.log(`[Manager] /json/list: ${list.length} entries`);
            for (const t of list) console.log(`  - type=${t.type} title="${t.title}"`);
            const manager = list.find(t =>
                t.type === 'page' &&
                (t.title === 'Manager' || t.title.includes('jetski') || t.url.includes('jetski')) && !t.title.includes('Launchpad')
            );
            if (manager) {
                managerWsUrl = manager.webSocketDebuggerUrl;
                console.log(`[getLastResponse] Found Manager in /json/list`);
            }
        } catch (e) { }
    }

    if (!managerWsUrl) return null;

    // Manager に一時接続して DOM スキャン
    return new Promise((resolve) => {
        const ws = new WebSocket(managerWsUrl);
        const timeout = setTimeout(() => { ws.close(); resolve(null); }, 8000);

        ws.on('open', async () => {
            let id = 1;
            const pending = new Map();
            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (data.id !== undefined && pending.has(data.id)) {
                        const { resolve } = pending.get(data.id);
                        pending.delete(data.id);
                        resolve(data.result);
                    }
                } catch (e) { }
            });
            const call = (method, params = {}) => new Promise((res) => {
                const curId = id++;
                pending.set(curId, { resolve: res });
                ws.send(JSON.stringify({ id: curId, method, params }));
                setTimeout(() => { pending.delete(curId); res(null); }, 5000);
            });

            const SCAN_EXP = `(() => {
                const shadowQuery = (selector, root) => {
                    const results = [];
                    try { const direct = root.querySelectorAll(selector); for (const el of direct) results.push(el); } catch(e){}
                    try {
                        const all = root.querySelectorAll('*');
                        for (const el of all) {
                            if (el.shadowRoot) results.push(...shadowQuery(selector, el.shadowRoot));
                            if (el.contentDocument) results.push(...shadowQuery(selector, el.contentDocument));
                        }
                    } catch(e){}
                    return results;
                };

                const selectors = [
                    '[data-message-role="assistant"]', '[data-testid*="assistant"]', '[data-role="assistant"]',
                    '.prose', '.markdown-body', '.markdown', '.assistant-message', '.message-content',
                    '[class*="assistant"][class*="message"]', '[class*="ai-message"]', '[class*="response"]',
                    '.chat-message-assistant', '.chat-response'
                ];
                const excludePatterns = [
                    /^open agent manager$/i, /^antigravity/i, /^new chat$/i,
                    /^planning$/i, /^fast$/i, /^run$/i, /^cancel$/i
                ];
                function isExcluded(t) { return excludePatterns.some(p => p.test(t.trim())); }
                
                let bestText = null, bestLen = 0, bestImages = [];
                
                // Cascade Panel custom extraction logic First
                try {
                    const convList = shadowQuery('#conversation .flex.w-full.grow.flex-col > .mx-auto.w-full', document);
                    if (convList.length > 0 && convList[0].children.length > 0) {
                        // Get the last message block
                        const lastMsg = convList[0].children[convList[0].children.length - 1];
                        // Inside this block, avoid the "Thought for X" container which is often inside a max-h-0 before opening 
                        // Actually, the main content is often in .leading-relaxed or .animate-markdown
                        const contentNodes = lastMsg.querySelectorAll('.leading-relaxed, .animate-markdown, p:not(.cursor-pointer)');
                        let combinedText = '';
                        for(let c of contentNodes) {
                           // exclude thought block if possible. Usually thought blocks are inside a div with max-h-0 or a span with cursor-pointer
                           if(c.closest('.max-h-0') || c.closest('details') || c.classList.contains('cursor-pointer') || c.closest('.cursor-pointer')) continue;
                           let t = c.innerText.trim();
                           if(t && !isExcluded(t) && !combinedText.includes(t)) combinedText += t + '\\n\\n';
                        }
                        
                        // If we didn't get good content, fallback to the entire text but try to strip 'Thought for X'
                        if(combinedText.trim().length === 0) {
                            let raw = lastMsg.innerText;
                            // Regex to remove "Thought for X... " block if it's there
                            raw = raw.replace(/Thought for .*?(s|m)\\n[\\s\\S]*?(?=\\n\\n|\\n[A-Z]|$)/i, '');
                            combinedText = raw.trim();
                        }
                        
                        if(combinedText.length > 30 && !isExcluded(combinedText)) {
                            bestText = combinedText.trim();
                            bestLen = bestText.length;
                            bestImages = Array.from(lastMsg.querySelectorAll('img')).map(img => img.src);
                        }
                    }
                } catch(e) {}

                // Fallback to original selector search
                if (!bestText) {
                    for (const sel of selectors) {
                        try {
                            const els = shadowQuery(sel, document);
                            for (let i = els.length - 1; i >= 0; i--) {
                                const text = (els[i].innerText || '').trim();
                                if (text.length >= 30 && !isExcluded(text) && text.length > bestLen) {
                                    bestLen = text.length;
                                    bestText = text;
                                    bestImages = Array.from(els[i].querySelectorAll('img')).map(img => img.src);
                                }
                            }
                        } catch(e) {}
                    }
                }
                return bestText ? { text: bestText, images: bestImages } : null;
            })()`;

            try {
                await call('Runtime.enable');
                const res = await call('Runtime.evaluate', { expression: SCAN_EXP, returnByValue: true });
                const val = res?.result?.value;
                clearTimeout(timeout);
                ws.close();
                resolve(val?.text ? val : null);
            } catch (e) {
                clearTimeout(timeout);
                ws.close();
                resolve(null);
            }
        });

        ws.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
}

async function getLastResponse(cdp) {
    // 1. Manager ターゲット（Cascade チャット UI）を最優先で試す
    const managerResult = await getResponseFromManagerTarget(cdp);
    if (managerResult) {
        logInteraction('DEBUG', `[Manager] Response found, length: ${managerResult.text.length}`);
        return { text: managerResult.text, images: managerResult.images || [] };
    }

    // 2. 現在の CDP 接続でフォールバックスキャン
    const EXP = `(() => {
        const shadowQuery = (selector, root) => {
            const results = [];
            try { const direct = root.querySelectorAll(selector); for (const el of direct) results.push(el); } catch(e){}
            try {
                const all = root.querySelectorAll('*');
                for (const el of all) {
                    if (el.shadowRoot) results.push(...shadowQuery(selector, el.shadowRoot));
                }
            } catch(e){}
            return results;
        };

        // メインドキュメントと、Shadow DOM 内を含むすべての iframe の中のドキュメントを収集
        const allDocs = [document];
        const allIframes = shadowQuery('iframe', document);
        for (const frame of allIframes) {
            try {
                if (frame.contentDocument) {
                    allDocs.push(frame.contentDocument);
                }
            } catch(e) {}
        }

        const selectors = [
            '[data-message-role="assistant"]', '[data-testid*="assistant"]', '[data-role="assistant"]',
            '.prose', '.markdown-body', '.markdown', '.assistant-message', '.message-content',
            '[class*="assistant"][class*="message"]', '[class*="ai-message"]',
            '.chat-message-assistant', '.chat-response'
        ];
        const excludePatterns = [
            /^open agent manager$/i, /^antigravity/i, /^new chat$/i, /^planning$/i, /^fast$/i
        ];
        function isExcluded(t) { return excludePatterns.some(p => p.test(t.trim())); }
        let bestText = null, bestLen = 0, bestImages = [];
        
        for (const doc of allDocs) {
            try {
                const convList = shadowQuery('#conversation .flex.w-full.grow.flex-col > .mx-auto.w-full', doc);
                if (convList.length > 0 && convList[0].children.length > 0) {
                    const lastMsg = convList[0].children[convList[0].children.length - 1];
                    const contentNodes = lastMsg.querySelectorAll('.leading-relaxed, .animate-markdown, p:not(.cursor-pointer)');
                    let combinedText = '';
                    for(let c of contentNodes) {
                       if(c.closest('.max-h-0') || c.closest('details') || c.classList.contains('cursor-pointer') || c.closest('.cursor-pointer')) continue;
                       let t = c.innerText.trim();
                       if(t && !isExcluded(t) && !combinedText.includes(t)) combinedText += t + '\\n\\n';
                    }
                    if(combinedText.trim().length === 0) {
                        let raw = lastMsg.innerText;
                        raw = raw.replace(/Thought for .*?(s|m)\\n[\\s\\S]*?(?=\\n\\n|\\n[A-Z]|$)/i, '');
                        combinedText = raw.trim();
                    }
                    if(combinedText.length > 30 && !isExcluded(combinedText)) {
                        bestText = combinedText.trim();
                        bestLen = bestText.length;
                        bestImages = Array.from(lastMsg.querySelectorAll('img')).map(img => img.src);
                    }
                }
            } catch(e) {}

            if (!bestText) {
                for (const sel of selectors) {
                    try {
                        const els = shadowQuery(sel, doc);
                        for (let i = els.length - 1; i >= 0; i--) {
                            const text = (els[i].innerText || '').trim();
                            if (text.length >= 50 && !isExcluded(text) && text.length > bestLen) {
                                bestLen = text.length;
                                bestText = text;
                                bestImages = Array.from(els[i].querySelectorAll('img')).map(img => img.src);
                            }
                        }
                    } catch(e) {}
                }
            }
        }
        return bestText ? { text: bestText, images: bestImages, _debug: { iframeCount: allIframes.length, docsChecked: allDocs.length } } : { text: null, _debug: { iframeCount: allIframes.length, docsChecked: allDocs.length } };
    })()`;

    const results = await evalInAllContexts(cdp, EXP, { stopOnSuccess: true, successCheck: (v) => v?.text });
    for (const { value: val, contextId } of results) {
        if (val?._debug) console.log(`[getLastResponse] Fallback ctx ${contextId}: iframes=${val._debug.iframeCount}`);
        if (val?.text) {
            logInteraction('DEBUG', `Response found in ctx ${contextId}, length: ${val.text.length}`);
            return { text: val.text, images: val.images };
        }
    }
    return null;
}

async function getScreenshot(cdp) {
    try {
        const result = await cdp.call("Page.captureScreenshot", { format: "png" });
        return Buffer.from(result.data, 'base64');
    } catch (e) { return null; }
}

// --- 生成停止 ---
async function stopGeneration(cdp) {
    const EXP = `(() => {
        // iframe内のドキュメントを取得
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch(e) {}
                }
            }
            return document;
        }
        const doc = getTargetDoc();
        // キャンセルボタンを検索
        const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        // フォールバック: 「Stop」テキストのボタンも検索
        const buttons = doc.querySelectorAll('button');
        for (const btn of buttons) {
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (txt === 'stop' || txt === '停止') {
                btn.click();
                return { success: true };
            }
        }
        return { success: false, reason: 'Cancel button not found' };
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value?.success) {
                logInteraction('STOP', 'Generation stopped by user.');
                return true;
            }
        } catch (e) { }
    }
    return false;
}

// --- 新規チャット ---
async function startNewChat(cdp) {
    const EXP = `(() => {
        // メインドキュメントとiframe両方で検索
        function getTargetDoc() {
            const iframes = document.querySelectorAll('iframe');
            for (let i = 0; i < iframes.length; i++) {
                if (iframes[i].src.includes('cascade-panel')) {
                    try { return iframes[i].contentDocument; } catch(e) {}
                }
            }
            return null;
        }
        // メインドキュメントのNew Chatボタンを優先検索
        const selectors = [
            '[data-tooltip-id="new-conversation-tooltip"]',
            '[data-tooltip-id*="new-chat"]',
            '[data-tooltip-id*="new_chat"]',
            '[aria-label*="New Chat"]',
            '[aria-label*="New Conversation"]'
        ];
        const docs = [document];
        const iframeDoc = getTargetDoc();
        if (iframeDoc) docs.push(iframeDoc);
        for (const doc of docs) {
            for (const sel of selectors) {
                const btn = doc.querySelector(sel);
                if (btn) { btn.click(); return { success: true, method: sel }; }
            }
        }
        return { success: false };
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value?.success) {
                logInteraction('NEWCHAT', 'New chat started. Method: ' + res.result.value.method);
                return true;
            }
        } catch (e) { }
    }
    return false;
}

// --- モデル管理 ---

// 現在のモデル名を取得
async function getCurrentModel(cdp) {
    const EXP = `(() => {
        // メインドキュメントとiframe両方で検索
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                const lower = txt.toLowerCase();
                
                // If the button has aria-expanded, it is highly likely the model selector or mode selector
                if (btn.hasAttribute('aria-expanded')) {
                    if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                        return txt;
                    }
                }
                
                // Sometimes it's just a button with text
                if (txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                    // Make sure it looks like a selected model button (often has an SVG caret next to it)
                    if (btn.querySelector('svg')) {
                        return txt;
                    }
                }
            }
        }
        return null;
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return null;
}

// 現在のチャットタイトルを取得
async function getCurrentTitle(cdp) {
    const EXP = `(() => {
        // メインドキュメントとiframe両方で検索
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        for (const doc of docs) {
            // タイトルクラスを持つP要素を探す
            const els = doc.querySelectorAll('p.text-ide-sidebar-title-color');
            for (const el of els) {
                const txt = (el.innerText || '').trim();
                if (txt.length > 1) return txt;
            }
        }
        return null;
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return null;
}

// モデル一覧を取得（ドロップダウンを開いて閉じる）
async function getModelList(cdp) {
    const EXP = `(async () => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        let targetDoc = null;
        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                const lower = txt.toLowerCase();
                if (btn.hasAttribute('aria-expanded')) {
                    if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                        btn.click();
                        targetDoc = doc;
                        break;
                    }
                }
                if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                    if (btn.querySelector('svg')) {
                        btn.click();
                        targetDoc = doc;
                        break;
                    }
                }
            }
            if (targetDoc) break;
        }
        if (!targetDoc) return JSON.stringify([]);
        await new Promise(r => setTimeout(r, 1000));
        
        let models = [];
        const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
        for (const opt of options) {
            if (opt.className.includes('px-') || opt.className.includes('py-')) {
                 const txt = (opt.textContent || '').replace('New', '').trim();
                 if(txt.length > 3 && txt.length < 50 && (txt.toLowerCase().includes('claude') || txt.toLowerCase().includes('gemini') || txt.toLowerCase().includes('gpt') || txt.toLowerCase().includes('o1') || txt.toLowerCase().includes('o3'))) {
                     if(!models.includes(txt)) models.push(txt);
                 }
            }
        }
        
        const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
        if (openBtn) openBtn.click();
        
        return JSON.stringify(models);
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value) {
                const models = JSON.parse(res.result.value);
                if (models.length > 0) return models;
            }
        } catch (e) { }
    }
    return [];
}

// モデルを切り替え
async function switchModel(cdp, targetName) {
    const SWITCH_EXP = `(async () => {
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e) {}
        }
        let targetDoc = null;
        for (const doc of docs) {
            const buttons = Array.from(doc.querySelectorAll('button, div[role="button"]'));
            for (const btn of buttons) {
                const txt = (btn.textContent || '').trim();
                const lower = txt.toLowerCase();
                if (btn.hasAttribute('aria-expanded')) {
                    if (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('model')) {
                        btn.click();
                        targetDoc = doc;
                        break;
                    }
                }
                if (!targetDoc && txt.length > 3 && txt.length < 50 && (lower.includes('claude') || lower.includes('gemini') || lower.includes('gpt'))) {
                    if (btn.querySelector('svg')) {
                        btn.click();
                        targetDoc = doc;
                        break;
                    }
                }
            }
            if (targetDoc) break;
        }
        if (!targetDoc) return JSON.stringify({ success: false, reason: 'button not found' });
        await new Promise(r => setTimeout(r, 1000));
        
        const target = ${JSON.stringify(targetName)}.toLowerCase();
        const options = Array.from(targetDoc.querySelectorAll('div.cursor-pointer'));
        for (const opt of options) {
            if (opt.className.includes('px-') || opt.className.includes('py-')) {
                 const txt = (opt.textContent || '').replace('New', '').trim();
                 if (txt.toLowerCase().includes(target)) {
                     opt.click();
                     return JSON.stringify({ success: true, model: txt });
                 }
            }
        }
        
        const openBtn = targetDoc.querySelector('button[aria-expanded="true"], div[role="button"][aria-expanded="true"]');
        if (openBtn) openBtn.click();
        return JSON.stringify({ success: false, reason: 'model not found in options list' });
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SWITCH_EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value) {
                const result = JSON.parse(res.result.value);
                if (result.success) {
                    logInteraction('MODEL', `Switched to: ${result.model}`);
                    return result;
                }
            }
        } catch (e) { }
    }
    return { success: false, reason: 'CDP error' };
}

// --- モード管理 ---

// 現在のモード（Planning/Fast）を取得
async function getCurrentMode(cdp) {
    const EXP = `(() => {
                        function getTargetDoc() {
                            const iframes = document.querySelectorAll('iframe');
                            for (let i = 0; i < iframes.length; i++) {
                                if (iframes[i].src.includes('cascade-panel')) {
                                    try { return iframes[i].contentDocument; } catch (e) { }
                                }
                            }
                            return document;
                        }
                        const doc = getTargetDoc();
                        const spans = doc.querySelectorAll('span.text-xs.select-none');
                        for (const s of spans) {
                            const txt = (s.innerText || '').trim();
                            if (txt === 'Planning' || txt === 'Fast') return txt;
                        }
                        return null;
                    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return null;
}

// モード切替
async function switchMode(cdp, targetMode) {
    const SWITCH_EXP = `(async () => {
                        function getTargetDoc() {
                            const iframes = document.querySelectorAll('iframe');
                            for (let i = 0; i < iframes.length; i++) {
                                if (iframes[i].src.includes('cascade-panel')) {
                                    try { return iframes[i].contentDocument; } catch (e) { }
                                }
                            }
                            return document;
                        }
                        const doc = getTargetDoc();
                        // Planningトグルボタンをクリック
                        const toggles = doc.querySelectorAll('div[role="button"][aria-haspopup="dialog"]');
                        let clicked = false;
                        for (const t of toggles) {
                            const txt = (t.innerText || '').trim();
                            if (txt === 'Planning' || txt === 'Fast') {
                                t.querySelector('button').click();
                                clicked = true;
                                break;
                            }
                        }
                        if (!clicked) return JSON.stringify({ success: false, reason: 'toggle not found' });
                        await new Promise(r => setTimeout(r, 1000));
                        // ダイアログ内のモード選択肢をクリック
                        const target = ${JSON.stringify(targetMode)
        };
                    const dialogs = doc.querySelectorAll('div[role="dialog"]');
                    for (const dialog of dialogs) {
                        const txt = (dialog.innerText || '');
                        if (txt.includes('Conversation mode') || txt.includes('Planning') && txt.includes('Fast')) {
                            const divs = dialog.querySelectorAll('div.font-medium');
                            for (const d of divs) {
                                if (d.innerText.trim().toLowerCase() === target.toLowerCase()) {
                                    d.click();
                                    return JSON.stringify({ success: true, mode: d.innerText.trim() });
                                }
                            }
                        }
                    }
                    return JSON.stringify({ success: false, reason: 'mode not found in dialog' });
                }) ()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SWITCH_EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value) {
                const result = JSON.parse(res.result.value);
                if (result.success) {
                    logInteraction('MODE', `Switched to: ${result.mode} `);
                    return result;
                }
            }
        } catch (e) { }
    }
    return { success: false, reason: 'CDP error' };
}

// --- FILE WATCHER ---
function setupFileWatcher() {
    if (!WORKSPACE_ROOT) {
        console.log('🚫 File watching is disabled.');
        return;
    }
    const watcher = chokidar.watch(WORKSPACE_ROOT, { ignored: [/node_modules/, /\.git/, /discord_interaction\.log$/], persistent: true, ignoreInitial: true, awaitWriteFinish: true });
    watcher.on('all', async (event, filePath) => {
        if (!lastActiveChannel) return;
        if (event === 'unlink') {
            await lastActiveChannel.send(`🗑️ ** File Deleted:** \`${path.basename(filePath)}\``);
        } else if (event === 'add' || event === 'change') {
            const stats = fs.statSync(filePath);
            if (stats.size > 8 * 1024 * 1024) return;
            const attachment = new AttachmentBuilder(filePath);
            await lastActiveChannel.send({ content: `📁 **File ${event === 'add' ? 'Created' : 'Updated'}:** \`${path.basename(filePath)}\``, files: [attachment] });
        }
    });
}

// --- QUEUE PROCESSING ---

async function processQueue(cdp) {
    if (isMonitoring || requestQueue.length === 0) return;
    isMonitoring = true;

    const { originalMessage, prevSnapshot } = requestQueue.shift();
    let stableCount = 0;
    isGenerating = true; // Use global state for logs/title
    lastApprovalMessage = null;

    // AIが生成を開始するまでの猶予期間
    await new Promise(r => setTimeout(r, 3000));

    let isWaitingForApproval = false;

    const poll = async () => {
        try {
            // 承認待ち中はポーリングをスキップ
            if (isWaitingForApproval) {
                setTimeout(poll, POLLING_INTERVAL);
                return;
            }

            const approval = await checkApprovalRequired(cdp);
            if (approval) {
                if (lastApprovalMessage === approval.message) {
                    setTimeout(poll, POLLING_INTERVAL);
                    return;
                }

                await new Promise(r => setTimeout(r, 3000));
                const stillRequiresApproval = await checkApprovalRequired(cdp);
                if (!stillRequiresApproval) {
                    setTimeout(poll, POLLING_INTERVAL);
                    return;
                }

                if (lastApprovalMessage === approval.message) {
                    setTimeout(poll, POLLING_INTERVAL);
                    return;
                }

                lastApprovalMessage = approval.message;
                isWaitingForApproval = true; // ブロック開始

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('approve_action').setLabel('✅ Approve / Run').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('reject_action').setLabel('❌ Reject / Cancel').setStyle(ButtonStyle.Danger)
                );
                const reply = await originalMessage.reply({ content: `⚠️ **Approval Required**\n\`\`\`\n${approval.message}\n\`\`\``, components: [row] });
                logInteraction('APPROVAL', `Request sent to Discord: ${approval.message.substring(0, 50)}...`);

                try {
                    const discordPromise = reply.awaitMessageComponent({ filter: i => i.user.id === originalMessage.author.id, time: 300000 });

                    let resolvedExternally = false;
                    const checkPromise = (async () => {
                        while (!resolvedExternally && isWaitingForApproval) {
                            await new Promise(r => setTimeout(r, 2000));
                            if (!isWaitingForApproval) break;
                            const req = await checkApprovalRequired(cdp);
                            if (!req) {
                                resolvedExternally = true;
                                break;
                            }
                        }
                        if (resolvedExternally) return 'external';
                        return 'abort';
                    })();

                    const result = await Promise.race([discordPromise, checkPromise]);

                    if (result === 'external') {
                        // User manually clicked it in VSCode or Auto-Accept handled it
                        await reply.edit({ content: `${reply.content}\n\n✅ **Resolved Externally**`, components: [] });
                        logInteraction('ACTION', 'Approval resolved externally (by VSCode/Auto-Accept).');
                        lastApprovalMessage = null;
                        isWaitingForApproval = false; // ブロック解除
                        setTimeout(poll, POLLING_INTERVAL);
                        return;
                    }

                    // Otherwise it was clicked in Discord
                    resolvedExternally = true; // stop checker loop
                    const interaction = result;
                    const allow = interaction.customId === 'approve_action';
                    await interaction.deferUpdate();
                    await clickApproval(cdp, allow);
                    await reply.edit({ content: `${reply.content}\n\n${allow ? '✅ **Approved**' : '❌ **Rejected**'}`, components: [] });
                    logInteraction('ACTION', `User ${allow ? 'Approved' : 'Rejected'} the request.`);

                    for (let j = 0; j < 15; j++) {
                        if (!(await checkApprovalRequired(cdp))) break;
                        await new Promise(r => setTimeout(r, 500));
                    }
                    lastApprovalMessage = null;
                    isWaitingForApproval = false; // ブロック解除
                    setTimeout(poll, POLLING_INTERVAL);
                } catch (e) {
                    await reply.edit({ content: '⚠️ Approval timed out. Auto-rejecting request in Antigravity.', components: [] });
                    await clickApproval(cdp, false); // Cancel it automatically
                    lastApprovalMessage = null;
                    isWaitingForApproval = false; // ブロック解除
                    setTimeout(poll, POLLING_INTERVAL);
                }
                return;
            }

            const generating = await checkIsGenerating(cdp);
            if (!generating) {
                stableCount++;
                if (stableCount % 5 === 0) logInteraction('DEBUG', `Waiting for generation to finish... (Stable: ${stableCount})`);
                if (stableCount >= 5) { // 5カウント（約10秒）以上安定してから応答を取得
                    const response = await getLastResponse(cdp);
                    if (response) {
                        // スナップショットと一致する場合は古い返答なのでスキップ
                        const isStale = prevSnapshot && response.text.substring(0, 200) === prevSnapshot;
                        if (isStale) {
                            logInteraction('DEBUG', 'Response matches snapshot (stale), waiting for new response...');
                            if (stableCount > 20) {
                                logInteraction('ERROR', 'Timed out waiting for new response (snapshot did not change).');
                                isGenerating = false;
                                isMonitoring = false;
                                setTimeout(() => processQueue(cdp), 1000);
                                return;
                            }
                            setTimeout(poll, POLLING_INTERVAL);
                            return;
                        }
                        logInteraction('SUCCESS', `Response found: ${response.text.substring(0, 50)}...`);
                        const chunks = response.text.match(/[\s\S]{1,1900}/g) || [response.text];
                        await originalMessage.reply({ content: `🤖 **AI Response:**\n${chunks[0]}` });
                        for (let i = 1; i < chunks.length; i++) await originalMessage.channel.send(chunks[i]);

                        isGenerating = false;
                        isMonitoring = false;
                        setTimeout(() => processQueue(cdp), 1000);
                        return;
                    } else {
                        // If no response found yet, keep polling even if not generating (might be rendering)
                        if (stableCount > 20) { // Timeout after ~40s of nothing
                            logInteraction('ERROR', 'Generation finished but no response text found.');
                            isGenerating = false;
                            isMonitoring = false;
                            setTimeout(() => processQueue(cdp), 1000);
                            return;
                        }
                    }
                }
            } else {
                if (stableCount > 0) logInteraction('DEBUG', 'AI started generating again.');
                stableCount = 0;
            }

            setTimeout(poll, POLLING_INTERVAL);
        } catch (e) {
            console.error("Poll error:", e);
            isGenerating = false;
            isMonitoring = false;
            setTimeout(() => processQueue(cdp), 1000);
        }
    };

    setTimeout(poll, POLLING_INTERVAL);
}

async function monitorAIResponse(originalMessage, cdp) {
    // 送信前の最後の返答をスナップショットとして記録
    let prevSnapshot = null;
    try {
        const snap = await getLastResponse(cdp);
        if (snap?.text) prevSnapshot = snap.text.substring(0, 200);
    } catch (e) { }
    requestQueue.push({ originalMessage, prevSnapshot });
    processQueue(cdp);
}

// --- SLASH COMMANDS DEFINITION ---
const commands = [
    {
        name: 'help',
        description: 'Antigravity Bot コマンド一覧を表示',
    },
    {
        name: 'screenshot',
        description: 'Antigravityのスクリーンショットを取得',
    },
    {
        name: 'stop',
        description: 'AIの生成を停止',
    },
    {
        name: 'newchat',
        description: '新規チャットを作成',
    },
    {
        name: 'title',
        description: '現在のチャットタイトルを表示',
    },
    {
        name: 'status',
        description: '現在のモデルとモードを表示',
    },
    {
        name: 'model',
        description: 'モデル一覧表示または切替',
        options: [
            {
                name: 'number',
                description: '切り替えるモデルの番号 (未指定で一覧表示)',
                type: 4, // Integer type
                required: false,
            }
        ]
    },
    {
        name: 'mode',
        description: 'モード (Planning/Fast) を表示または切替',
        options: [
            {
                name: 'target',
                description: '切り替えるモード (planning または fast)',
                type: 3, // String type
                required: false,
                choices: [
                    { name: 'Planning', value: 'planning' },
                    { name: 'Fast', value: 'fast' }
                ]
            }
        ]
    }
];

// --- DISCORD EVENTS ---
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    setupFileWatcher();
    ensureCDP().then(res => {
        if (res) console.log("✅ Auto-connected to Antigravity on startup.");
        else console.log("❌ Could not auto-connect to Antigravity on startup.");
    });

    // 登録されたコマンドをDiscord APIに送信
    try {
        console.log('🔄 Started refreshing application (/) commands.');
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('✅ Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('❌ Failed to reload application commands:', error);
    }
});
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    lastActiveChannel = interaction.channel;
    const cdp = await ensureCDP();
    if (!cdp) {
        await interaction.reply({ content: "❌ CDP not found. Is Antigravity running?", ephemeral: true });
        return;
    }

    const { commandName } = interaction;

    if (commandName === 'help') {
        return interaction.reply(
            `📖 **Antigravity Bot コマンド一覧**\n\n` +
            `💬 **テキスト送信** — 通常のメッセージを送信\n` +
            `📎 **ファイル添付** — 画像・ファイルを添付して送信\n\n` +
            `🖼️ \`/screenshot\` — スクリーンショット取得\n` +
            `⏹️ \`/stop\` — 生成を停止\n` +
            `🆕 \`/newchat\` — 新規チャット作成\n` +
            `📊 \`/status\` — 現在のモデル・モード表示\n` +
            `📝 \`/title\` — チャットタイトル表示\n` +
            `🤖 \`/model\` — モデル一覧表示\n` +
            `🤖 \`/model <番号>\` — モデル切替\n` +
            `📋 \`/mode\` — 現在のモード表示\n` +
            `📋 \`/mode <planning|fast>\` — モード切替`
        );
    }

    if (commandName === 'screenshot') {
        await interaction.deferReply();
        const ss = await getScreenshot(cdp);
        return ss ? interaction.editReply({ files: [new AttachmentBuilder(ss, { name: 'ss.png' })] }) : interaction.editReply("Failed to capture screenshot.");
    }

    if (commandName === 'stop') {
        const stopped = await stopGeneration(cdp);
        if (stopped) {
            isGenerating = false;
            return interaction.reply({ content: '⏹️ 生成を停止しました。' });
        } else {
            return interaction.reply({ content: '⚠️ 現在生成中ではありません。', ephemeral: true });
        }
    }

    if (commandName === 'newchat') {
        const started = await startNewChat(cdp);
        if (started) {
            isGenerating = false;
            return interaction.reply({ content: '🆕 新規チャットを開始しました。' });
        } else {
            return interaction.reply({ content: '⚠️ New Chatボタンが見つかりませんでした。', ephemeral: true });
        }
    }

    if (commandName === 'title') {
        await interaction.deferReply();
        const title = await getCurrentTitle(cdp);
        return interaction.editReply(`📝 **チャットタイトル:** ${title || '不明'}`);
    }

    if (commandName === 'status') {
        await interaction.deferReply();
        const model = await getCurrentModel(cdp);
        const mode = await getCurrentMode(cdp);
        return interaction.editReply(`🤖 **モデル:** ${model || '不明'}\n📋 **モード:** ${mode || '不明'}`);
    }

    if (commandName === 'model') {
        await interaction.deferReply();
        const num = interaction.options.getInteger('number');

        if (num === null) {
            // 一覧表示
            const current = await getCurrentModel(cdp);
            const models = await getModelList(cdp);
            if (models.length === 0) return interaction.editReply('⚠️ モデル一覧を取得できませんでした。');
            const list = models.map((m, i) => `${m === current ? '▶' : '　'} **${i + 1}.** ${m}`).join('\n');
            return interaction.editReply(`🤖 **現在のモデル:** ${current || '不明'}\n\n${list}\n\n_切替: \`/model number:\`<番号>_`);
        } else {
            // モデル切り替え
            if (num < 1) return interaction.editReply('⚠️ 番号は1以上を指定してください。');
            const models = await getModelList(cdp);
            if (num > models.length) return interaction.editReply(`⚠️ 番号は1〜${models.length}で指定してください。`);
            const result = await switchModel(cdp, models[num - 1]);
            if (result.success) return interaction.editReply(`✅ **${result.model}** に切り替えました`);
            return interaction.editReply(`⚠️ 切替に失敗しました: ${result.reason}`);
        }
    }

    if (commandName === 'mode') {
        await interaction.deferReply();
        const target = interaction.options.getString('target');

        if (!target) {
            const mode = await getCurrentMode(cdp);
            return interaction.editReply(`📋 **現在のモード:** ${mode || '不明'}\n\n_切替: \`/mode target:\`<planning|fast>_`);
        } else {
            const result = await switchMode(cdp, target);
            if (result.success) return interaction.editReply(`✅ モード: **${result.mode}** に切り替えました`);
            return interaction.editReply(`⚠️ モード切替に失敗しました: ${result.reason}`);
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (processedMessages.has(message.id)) return;
    processedMessages.add(message.id);
    // Keep size manageable
    if (processedMessages.size > 100) {
        const first = processedMessages.values().next().value;
        processedMessages.delete(first);
    }
    if (message.content.startsWith('/')) return;
    // メンション文字列（<@ユーザーID> 形式）を除去して整形
    let messageText = (message.content || '').replace(/<@!?\d+>/g, '').trim();
    if (message.attachments.size > 0) {
        if (!WORKSPACE_ROOT) {
            logInteraction('UPLOAD_ERROR', 'Cannot handle attachments: WORKSPACE_ROOT is not set.');
            await message.reply('⚠️ 添付ファイルの処理には WATCH_DIR の設定が必要です。').catch(() => { });
        } else {
            const uploadDir = path.join(WORKSPACE_ROOT, 'discord_uploads');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

            const downloadedFiles = [];
            for (const [, attachment] of message.attachments) {
                try {
                    const fileName = `${Date.now()}_${path.basename(attachment.name)}`;
                    const filePath = path.join(uploadDir, fileName);
                    const fileData = await downloadFile(attachment.url);
                    fs.writeFileSync(filePath, fileData);
                    downloadedFiles.push({ name: attachment.name, path: filePath });
                    logInteraction('UPLOAD', `Downloaded: ${attachment.name} -> ${filePath}`);
                } catch (e) {
                    logInteraction('UPLOAD_ERROR', `Failed to download ${attachment.name}: ${e.message}`);
                }
            }

            if (downloadedFiles.length > 0) {
                const fileInfo = downloadedFiles.map(f => `[添付ファイル: ${f.name}] パス: ${f.path}`).join('\n');
                messageText = messageText ? `${messageText}\n\n${fileInfo}` : fileInfo;
                await message.react('📎').catch(() => { });
            }
        }
    }

    if (!messageText) return;

    const cdp = await ensureCDP();
    if (!cdp) {
        await message.react('❌').catch(() => { });
        await message.reply('❌ CDP not found. Is Antigravity running?').catch(() => { });
        return;
    }

    const res = await injectMessage(cdp, messageText);
    if (res.ok) {
        await message.react('✅').catch(() => { });
        logInteraction('SUCCESS', `Message ${message.id} injected successfully.`);
        monitorAIResponse(message, cdp);
    } else {
        await message.react('❌').catch(() => { });
        if (res.error) await message.reply(`Error: ${res.error}`).catch(() => { });
    }
});

// Main Execution
(async () => {
    try {
        if (!process.env.DISCORD_ALLOWED_USER_ID) {
            throw new Error("❌ DISCORD_ALLOWED_USER_ID is missing in .env");
        }
        await ensureWatchDir();
        console.log(`📂 Watching directory: ${WORKSPACE_ROOT}`);

        // ==========================================
        // Local Test Mode (Bot <-> Antigravity test)
        // ==========================================
        if (process.argv.includes('--test')) {
            console.log("=== RUNNING IN LOCAL TEST MODE ===");
            try {
                const discovered = await discoverCDP();
                if (!discovered || !discovered.url) {
                    console.error("Test Failed: Antigravity not found on debug port.");
                    process.exit(1);
                }
                console.log(`Discovered Antigravity! URL: ${discovered.url}`);

                const cdp = await connectCDP(discovered.url);
                if (!cdp) throw new Error("Could not connect to CDP");
                cdpConnection = cdp;

                const testMsg = {
                    author: { id: "test-user-id" },
                    content: "PowerShellで現在のディレクトリに `approval_test.txt` という空ファイルを作ってみて。絶対にコマンドを実行すること。",
                    reply: async function (replyObj) {
                        console.log("===============================");
                        console.log("[SIMULATED DISCORD REPLY]:");
                        console.log(replyObj);
                        console.log("===============================");

                        const mockReplyMsg = {
                            content: replyObj.content,
                            edit: async function (editObj) {
                                console.log("[SIMULATED DISCORD EDIT]:", editObj);
                                return this;
                            },
                            awaitMessageComponent: async () => {
                                console.log("[SIMULATED DISCORD AWAITING BUTTON] -> Auto Approving in 2s...");
                                await new Promise(r => setTimeout(r, 2000));
                                return {
                                    customId: 'approve_action',
                                    user: { id: "test-user-id" },
                                    deferUpdate: async () => console.log("[SIMULATED DISCORD BUTTON] Update deferred")
                                };
                            }
                        };
                        return mockReplyMsg;
                    },
                    channel: {
                        sendTyping: () => console.log("[SIMULATED] -> Sending typing indicator..."),
                        send: async (msg) => console.log("[SIMULATED DISCORD SEND]:", msg)
                    }
                };

                // Add to queue
                requestQueue.push({ originalMessage: testMsg });

                // Inject message manually first (since messageCreate handler isn't running)
                const res = await injectMessage(cdp, testMsg.content);
                if (!res.success && !res.ok) {
                    throw new Error("Local Test failed: injectMessage returned false/error. " + (res.error || ""));
                }

                console.log("Injection succeeded. Starting response monitor.");
                // Process response
                monitorAIResponse(testMsg, cdp);

                // For testing wait a bit to ensure async polling finishes
                await new Promise(r => setTimeout(r, 60000)); // wait up to 60 seconds

                console.log("=== LOCAL TEST FINISHED ===");
                process.exit(0);
            } catch (e) {
                console.error("Test Error:", e);
                process.exit(1);
            }
        } else {
            // Standard Discord login
            client.login(process.env.DISCORD_BOT_TOKEN).catch(e => {
                console.error('Failed to login:', e);
                process.exit(1);
            });
        }
    } catch (e) {
        console.error('Fatal Error:', e);
        process.exit(1);
    }
})();
