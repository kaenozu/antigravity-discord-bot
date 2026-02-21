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

            // Priority 1: Target that is NOT Launchpad and looks like a project window
            let target = list.find(t =>
                t.type === 'page' &&
                t.webSocketDebuggerUrl &&
                !t.title.includes('Launchpad') &&
                !t.url.includes('workbench-jetski-agent') &&
                (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade'))
            );

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
            if (data.method === 'Runtime.executionContextCreated') contexts.push(data.params.context);
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

    await call("Runtime.enable", {});
    await call("Runtime.disable", {}); // Toggle to force re-emission of events
    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000)); // Wait for context events
    console.log(`[CDP] Initialized with ${contexts.length} contexts.`);
    logInteraction('CDP', `Connected to target: ${url}`);
    return { ws, call, contexts };
}

async function ensureCDP() {
    if (cdpConnection && cdpConnection.ws.readyState === WebSocket.OPEN) return cdpConnection;
    try {
        const { url } = await discoverCDP();
        cdpConnection = await connectCDP(url);
        return cdpConnection;
    } catch (e) { return null; }
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
async function injectMessage(cdp, text) {
    const safeText = JSON.stringify(text);
    const EXP = `(async () => {
        const SELECTORS = ${JSON.stringify(SELECTORS)};
        
        // Helper to check if button has sending icon
        function isSubmitButton(btn) {
            if (btn.disabled || btn.offsetWidth === 0) return false;
            // Check SVG classes
            const svg = btn.querySelector('svg');
            if (svg) {
                const cls = (svg.getAttribute('class') || '') + ' ' + (btn.getAttribute('class') || '');
                if (SELECTORS.SUBMIT_BUTTON_SVG_CLASSES.some(c => cls.includes(c))) return true;
                // Also check for specific path d or other attributes if needed
            }
            // Check text
            const txt = (btn.innerText || '').trim().toLowerCase();
            if (['send', 'run'].includes(txt)) return true;
            
            return false;
        }

        const doc = document;
        
        // 1. Find Editor
        // Prioritize the role=textbox that is NOT xterm
        const editors = Array.from(doc.querySelectorAll(SELECTORS.CHAT_INPUT));
        // Filter out hidden ones or those in xterm if selector leaked
        const validEditors = editors.filter(el => el.offsetParent !== null);
        
        const editor = validEditors.at(-1); // Use the last one (usually bottom of chat)
        if (!editor) return { ok: false, error: "No editor found in this context" };

        // 2. Focus and Insert Text
        editor.focus();
        
        // Try execCommand first
        let inserted = doc.execCommand("insertText", false, ${safeText});
        
        // Fallback
        if (!inserted) {
            editor.textContent = ${safeText};
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: ${safeText} }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: ${safeText} }));
        }
        editor.dispatchEvent(new Event('input', { bubbles: true })); // Force update
        
        await new Promise(r => setTimeout(r, 200));

        // 3. Click Submit
        // Find button near the editor or global submit button
        // The submit button is usually a sibling or cousin of the editor
        const allButtons = Array.from(doc.querySelectorAll(SELECTORS.SUBMIT_BUTTON_CONTAINER));
        const submit = allButtons.find(isSubmitButton);
        
        if (submit) {
             submit.click();
             return { ok: true, method: "click" };
        }
        
        // Fallback: Enter key
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        return { ok: true, method: "enter" };
    })()`;

    // Strategy: Prioritize context that looks like cascade-panel
    const targetContexts = cdp.contexts.filter(c =>
        (c.url && c.url.includes(SELECTORS.CONTEXT_URL_KEYWORD)) ||
        (c.name && c.name.includes('Extension')) // Fallback
    );

    // If no specific context found, try all
    const contextsToTry = targetContexts.length > 0 ? targetContexts : cdp.contexts;

    console.log(`Injecting message. Priority contexts: ${targetContexts.length}, Total: ${cdp.contexts.length}`);

    for (const ctx of contextsToTry) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value?.ok) {
                logInteraction('INJECT', `Sent: ${text} (Context: ${ctx.id})`);
                return res.result.value;
            }
            // console.log(`[Injection Fail] Context ${ctx.id}: ${res.result?.value?.error}`);
        } catch (e) {
            // console.log(`[Injection Error] Context ${ctx.id}: ${e.message}`);
        }
    }

    // Fallback: Try ALL contexts if priority ones failed
    if (targetContexts.length > 0) {
        const otherContexts = cdp.contexts.filter(c => !targetContexts.includes(c));
        for (const ctx of otherContexts) {
            try {
                const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
                if (res.result?.value?.ok) {
                    logInteraction('INJECT', `Sent: ${text} (Fallback Context: ${ctx.id})`);
                    return res.result.value;
                }
            } catch (e) { }
        }
    }

    return { ok: false, error: `Injection failed. Tried ${cdp.contexts.length} contexts.` };
}

async function checkIsGenerating(cdp) {
    const EXP = `(() => {
        // Agent Panel Frame を探す
        function findAgentFrame(win) {
             const iframes = document.querySelectorAll('iframe');
             for(let i=0; i<iframes.length; i++) {
                 if(iframes[i].src.includes('cascade-panel')) {
                     try { return iframes[i].contentDocument; } catch(e){}
                 }
             }
             return document;
        }

        const doc = findAgentFrame(window);
        
        // キャンセルボタンの存在で生成中かを判定
        const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return true;

        return false;
    })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
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
            const potentialAnchors = Array.from(root.querySelectorAll ? root.querySelectorAll('button, [role="button"], .cursor-pointer') : []).filter(el => {
                if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
                const txt = (el.innerText || '').trim().toLowerCase();
                // Match anchor keywords
                return anchorKeywords.some(kw => txt === kw || txt.startsWith(kw + ' '));
            });

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
    return null;
}

async function clickApproval(cdp, allow) {
    const isAllowStr = allow ? 'true' : 'false';
    const EXP = '(async () => {' +
        'function getTargetDoc() {' +
        '  var iframes = document.querySelectorAll("iframe");' +
        '  for (var i = 0; i < iframes.length; i++) {' +
        '    if (iframes[i].src.indexOf("cascade-panel") !== -1) {' +
        '      try { return iframes[i].contentDocument; } catch(e) {}' +
        '    }' +
        '  }' +
        '  return document;' +
        '}' +
        'var doc = getTargetDoc();' +
        'var log = []; ' +
        'var approvalKeywords = ["run","approve","allow","yes","accept","confirm","save","apply","create","update","delete","remove","submit","send","retry","continue","always allow","allow once","allow this conversation","実行","許可","承認","はい","同意","保存","適用","作成","更新","削除","送信","再試行","続行"];' +
        'var cancelKeywords = ["cancel","reject","deny","ignore","no","キャンセル","拒否","無視","いいえ","中止","不許可"];' +
        'var ignoreKeywords = ["all","すべて","一括","auto"];' +
        'var isAllow = ' + isAllowStr + ';' +
        'var found = false;' +
        // キーワードマッチ関数（startsWith で誤検知を防ぐ）
        'function matchKeyword(combined, kw) {' +
        '  if (kw.length <= 4) {' +
        '    return combined === kw || combined.indexOf(kw) === 0 || combined.indexOf(" " + kw) !== -1;' +
        '  }' +
        '  return combined.indexOf(kw) !== -1;' +
        '}' +
        // 全ボタンをスキャンしてログに記録
        'var allButtons = Array.from(doc.body ? doc.body.querySelectorAll("button, [role=\\"button\\"], .cursor-pointer") : []);' +
        'log.push("Total buttons found: " + allButtons.length);' +
        // まずキャンセルボタン(アンカー)を探す
        'var anchors = allButtons.filter(function(el) {' +
        '  if (el.offsetWidth === 0) return false;' +
        '  var txt = (el.innerText || "").trim().toLowerCase();' +
        '  return cancelKeywords.some(function(kw) { return txt === kw || txt.indexOf(kw + " ") === 0; });' +
        '});' +
        'log.push("Cancel anchors found: " + anchors.length);' +
        // isAllow=false の場合、キャンセルボタンをクリック
        'if (!isAllow && anchors.length > 0) {' +
        '  anchors[0].click();' +
        '  found = true;' +
        '}' +
        // isAllow=true の場合、承認ボタンを探す
        'if (isAllow && !found) {' +
        // 全ボタンをログに記録
        '  allButtons.forEach(function(btn) {' +
        '    if (btn.offsetWidth === 0) return;' +
        '    var txt = (btn.innerText || "").trim().substring(0, 60);' +
        '    log.push("Btn: " + JSON.stringify(txt));' +
        '  });' +
        // 承認ボタンを全ボタンから探す（キャンセルボタンは除外）
        '  var approvalBtns = allButtons.filter(function(btn) {' +
        '    if (btn.offsetWidth === 0) return false;' +
        '    var txt = (btn.innerText || "").toLowerCase().trim();' +
        // 長すぎるテキストはボタンではなくコードブロック等
        '    if (txt.length > 30) return false;' +
        // キャンセルボタン自体は除外
        '    if (cancelKeywords.some(function(kw) { return txt === kw || txt.indexOf(kw + " ") === 0; })) return false;' +
        '    var aria = (btn.getAttribute("aria-label") || "").toLowerCase().trim();' +
        '    var title = (btn.getAttribute("title") || "").toLowerCase().trim();' +
        '    var combined = txt + " " + aria + " " + title;' +
        '    return approvalKeywords.some(function(kw) { return matchKeyword(combined, kw); }) && ' +
        '           !ignoreKeywords.some(function(kw) { return combined.indexOf(kw) !== -1; });' +
        '  });' +
        // 優先順位でソート ("allow this conversation" > "always allow" > その他)
        '  approvalBtns.sort(function(a, b) {' +
        '     var txtA = (a.innerText || "").toLowerCase();' +
        '     var txtB = (b.innerText || "").toLowerCase();' +
        '     var scoreA = 0; if(txtA.indexOf("allow this conversation") !== -1) scoreA = 2; else if(txtA.indexOf("always allow") !== -1) scoreA = 1;' +
        '     var scoreB = 0; if(txtB.indexOf("allow this conversation") !== -1) scoreB = 2; else if(txtB.indexOf("always allow") !== -1) scoreB = 1;' +
        '     return scoreB - scoreA;' +
        '  });' +
        '  var approvalBtn = approvalBtns[0];' +
        '  if (approvalBtn) {' +
        '    log.push("CLICKING: " + (approvalBtn.innerText || "").trim().substring(0, 30));' +
        '    approvalBtn.click();' +
        '    found = true;' +
        '  } else {' +
        '    log.push("No approval button found!");' +
        '  }' +
        '}' +
        'return { success: found, log: log };' +
        '})()';
    for (const ctx of cdp.contexts) {
        try {
            // 5秒でタイムアウト（ハング防止）
            const evalPromise = cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));
            const res = await Promise.race([evalPromise, timeoutPromise]);
            // デバッグ時のみ有効化: if (res.result?.value?.log) console.log(`[CLICK_DEBUG] Context ${ctx.id}: `, res.result.value.log);
            if (res.result?.value?.success) {
                logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (success)`);
                return res.result.value;
            }
        } catch (e) {
            // タイムアウトは想定内なのでログ不要
        }
    }
    logInteraction('CLICK', `Approval / Rejection clicked: ${allow} (failed)`);
    return { success: false };
}


async function getLastResponse(cdp) {
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
            const candidates = Array.from(doc.querySelectorAll('[data-message-role="assistant"], .prose, .group.relative.flex.gap-3'));
            if (candidates.length === 0) return null;
            const lastMsg = candidates[candidates.length - 1];
            return { text: lastMsg.innerText, images: Array.from(lastMsg.querySelectorAll('img')).map(img => img.src) };
        })()`;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            if (res.result?.value?.text) return res.result.value;
        } catch (e) { }
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

let requestQueue = [];
let isMonitoring = false;
let lastApprovalMessage = null; // Track the last sent approval text to avoid duplicates

async function processQueue(cdp) {
    if (isMonitoring || requestQueue.length === 0) return;
    isMonitoring = true;

    const { originalMessage } = requestQueue.shift();
    let stableCount = 0;
    isGenerating = true; // Use global state for logs/title
    lastApprovalMessage = null;

    // AIが生成を開始するまでの猶予期間
    await new Promise(r => setTimeout(r, 3000));

    const poll = async () => {
        try {
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

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('approve_action').setLabel('✅ Approve / Run').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('reject_action').setLabel('❌ Reject / Cancel').setStyle(ButtonStyle.Danger)
                );
                const reply = await originalMessage.reply({ content: `⚠️ **Approval Required**\n\`\`\`\n${approval.message}\n\`\`\``, components: [row] });
                logInteraction('APPROVAL', `Request sent to Discord: ${approval.message.substring(0, 50)}...`);

                try {
                    const interaction = await reply.awaitMessageComponent({ filter: i => i.user.id === originalMessage.author.id, time: 60000 });
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
                    setTimeout(poll, POLLING_INTERVAL);
                } catch (e) {
                    await reply.edit({ content: '⚠️ Approval timed out.', components: [] });
                    lastApprovalMessage = null;
                    setTimeout(poll, POLLING_INTERVAL);
                }
                return;
            }

            const generating = await checkIsGenerating(cdp);
            if (!generating) {
                stableCount++;
                if (stableCount >= 3) {
                    const response = await getLastResponse(cdp);
                    if (response) {
                        const chunks = response.text.match(/[\s\S]{1,1900}/g) || [response.text];
                        await originalMessage.reply({ content: `🤖 **AI Response:**\n${chunks[0]}` });
                        for (let i = 1; i < chunks.length; i++) await originalMessage.channel.send(chunks[i]);
                    }

                    isGenerating = false;
                    isMonitoring = false;

                    // 次のキューがあれば直ちに処理
                    setTimeout(() => processQueue(cdp), 1000);
                    return;
                }
            } else {
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
    requestQueue.push({ originalMessage });
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

    // Ignore old slash commands that people might manually type
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
        client.login(process.env.DISCORD_BOT_TOKEN);
    } catch (e) {
        console.error('Fatal Error:', e);
        process.exit(1);
    }
})();
