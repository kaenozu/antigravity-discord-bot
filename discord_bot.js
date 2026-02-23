import { Client, GatewayIntentBits, Partials, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, MessageFlags } from 'discord.js';


globalThis.isWaitingForApproval = false;
globalThis.generationStarted = false;
console.log('--- GLOBAL STATE INITIALIZED ---');
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
const POLLING_INTERVAL = 1000;
const RAW_CLI_ARGS = process.argv.slice(2).map(arg => String(arg || ''));
const CLI_ARGS = new Set(RAW_CLI_ARGS.map(arg => arg.toLowerCase()));


function getCliArgValue(flagName) {
    const lower = String(flagName || '').toLowerCase();
    if (!lower) return '';
    for (let i = 0; i < RAW_CLI_ARGS.length; i++) {
        const arg = RAW_CLI_ARGS[i];
        const a = arg.toLowerCase();
        if (a === lower && i + 1 < RAW_CLI_ARGS.length) {
            return String(RAW_CLI_ARGS[i + 1] || '').trim();
        }
        if (a.startsWith(`${lower}=`)) {
            return String(arg.slice(flagName.length + 1) || '').trim();
        }
    }
    return '';
}

const TEST_CHANNEL_ID = (getCliArgValue('--test-channel') || process.env.DISCORD_TEST_CHANNEL_ID || '').trim();
const RAW_DUMP_MODE = false
    || CLI_ARGS.has('--raw-dump')
    || ['1', 'true', 'on'].includes((process.env.RAW_RESPONSE_DUMP || '').toLowerCase());
const RAW_DUMP_FILE = (getCliArgValue('--raw-dump-file') || process.env.RAW_RESPONSE_DUMP_FILE || '').trim();

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
let explicitTargetUrl = null; // Explicitly selected window
let isGenerating = false;
let lastActiveChannel = null;
let lastApprovalMessage = null;
const processedMessages = new Set();
let requestQueue = [];
let isMonitoring = false;
// 監視対象ディレクトリ（初期化時に設定）
let WORKSPACE_ROOT = null;
const LOG_FILE = 'discord_interaction.log';
const ALLOWED_DISCORD_USER = (process.env.DISCORD_ALLOWED_USER_ID || '').trim();
const ALLOWED_DISCORD_USER_IS_ID = /^\d+$/.test(ALLOWED_DISCORD_USER);
const DISCORD_ACTIVITY_LOG_ENABLED = !['0', 'false', 'off'].includes((process.env.DISCORD_ACTIVITY_LOG || 'false').toLowerCase());
const DISCORD_ACTIVITY_LOG_TYPES = new Set([
    'APPROVAL',
    'ACTION',
    'ERROR'
]);

function isAuthorizedDiscordUser(user) {
    if (!ALLOWED_DISCORD_USER) return true;

    if (ALLOWED_DISCORD_USER_IS_ID) {
        return user.id === ALLOWED_DISCORD_USER;
    }

    // Backward-compat fallback for existing setups that stored username.
    return (user.username || '').toLowerCase() === ALLOWED_DISCORD_USER.toLowerCase();
}

function sanitizeAssistantResponse(rawText, promptText = '') {
    let text = String(rawText || '').replace(/\r/g, '');
    const prompt = String(promptText || '').trim();

    if (prompt && text.includes(prompt)) {
        const idx = text.lastIndexOf(prompt);
        if (idx >= 0) {
            text = text.slice(idx + prompt.length);
        }
    }

    const lines = text
        .split('\n')
        .map(line => line.replace(/\s+$/g, ''))
        .filter(line => {
            const t = line.trim().toLowerCase();
            if (!t) return false;
            if (/^[+-]\d+$/.test(t)) return false;
            if (t === 'edited') return false;
            if (isUiChromeLine(t)) return false;
            return true;
        });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeAssistantMarkdown(rawText, promptText = '') {
    let text = String(rawText || '').replace(/\r/g, '');
    const prompt = String(promptText || '').trim();

    if (prompt && text.includes(prompt)) {
        const idx = text.lastIndexOf(prompt);
        if (idx >= 0) {
            text = text.slice(idx + prompt.length);
        }
    }

    const lines = text
        .split('\n')
        .map(line => line.replace(/\s+$/g, ''))
        .filter(line => {
            const t = line.trim().toLowerCase();
            if (!t) return true;
            if (/^[+-]\d+$/.test(t)) return false;
            if (t === 'edited') return false;
            if (isUiChromeLine(t)) return false;
            return true;
        });

    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function isUiChromeLine(line) {
    const t = String(line || '').trim().toLowerCase();
    if (!t) return true;
    if (/^[+-]\d+$/.test(t)) return true;
    if (/^\d+\s+chars[驕ｯ・ｶ繝ｻ・｢繝ｻ繧托ｽｽ・ｷ].*$/i.test(t)) return true;
    if (t === 'analyzed' || t.startsWith('analyzed ')) return true;
    if (t === 'thinking' || t === 'generating' || t === 'generating..' || t === 'generating...') return true;
    if (t.startsWith('thought for ')) return true;
    if (t === 'planning' || t === 'fast') return true;
    if (t === 'review changes') return true;
    if (t === 'add context' || t === 'media' || t === 'mentions' || t === 'workflows') return true;
    if (t === 'conversation mode' || t === 'model' || t === 'new' || t === 'send') return true;
    if (/^\d+\s+files?\s+with\s+changes$/i.test(t)) return true;
    if (t === 'git graph') return true;
    if (t === 'antigravity - settings') return true;
    if (t === 'agq') return true;
    if (/^pro\s+\d+%\s+flash\s+\d+%/i.test(t)) return true;
    if (/^(css|html|javascript|typescript|json)$/i.test(t)) return true;
    if (/^(crlf|lf|utf-8|utf8)$/i.test(t)) return true;
    if (/^ln\s+\d+,\s*col\s+\d+$/i.test(t)) return true;
    if (t === 'reject all' || t === 'accept all') return true;
    if (t.includes('ask anything, @ to mention')) return true;
    if (t.startsWith('agent can plan before executing tasks')) return true;
    if (t.startsWith('agent will execute tasks directly')) return true;
    if (t.startsWith('prioritizing specific tools')) return true;
    if (t.startsWith('gemini ') || t.startsWith('claude ') || t.startsWith('gpt-')) return true;
    if (t === 'files edited' || t === 'progress updates' || t === 'continue') return true;
    if (t === 'good' || t === 'bad') return true;
    if (t.startsWith('info: server is started')) return true;
    if (t.startsWith('allow directory access to')) return true;
    if (t.startsWith('allow file access to')) return true;
    if (t.startsWith('allow access to')) return true;
    return false;
}

function containsCjk(text) {
    return /[\u3040-\u30ff\u3400-\u9fff]/.test(String(text || ''));
}

function isProgressNarrationLine(line) {
    const t = String(line || '').trim().toLowerCase();
    if (!t) return false;
    if (/^(planning|developing|constructing|implementing|refining|finalizing|initiating|commencing|crafting|verifying|calculating|styling|building)\b/.test(t)) return true;
    if (/^(i('| a)m|i have|i've|i am|my aim is|i plan to|i'm currently|i'm focusing|i have begun|i just started|now,?\s*i('| a)m)\b/.test(t)) return true;
    if (t.startsWith('creating task and implementation plan')) return true;
    if (t.startsWith('creating index.html')) return true;
    if (t.startsWith('testing the app')) return true;
    return false;
}

function isTerminalNoiseLine(line) {
    const t = String(line || '').trim().toLowerCase();
    if (!t) return true;
    if (isUiChromeLine(t)) return true;
    if (t === 'edited') return true;
    if (/^[+-]\d+$/.test(t)) return true;
    if (/^\d+\s+files?\s+with\s+changes$/i.test(t)) return true;
    if (/^\d+\s+chars[驕ｯ・ｶ繝ｻ・｢繝ｻ繧托ｽｽ・ｷ].*$/i.test(t)) return true;
    if (/^[a-z]:\\.+$/i.test(t)) return true;
    return false;
}

function isFinalSummaryLine(line) {
    const s = String(line || '').trim();
    if (!s) return false;
    if (isStrongFinalSummaryLine(s)) return true;
    if (/(created|completed|directory|files?)/i.test(s)) return true;
    return false;
}

function isStrongFinalSummaryLine(line) {
    const s = String(line || '').trim();
    if (!s) return false;
    // Removed old corrupted markers. Basic English/Japanese summary patterns.
    if (/^(the app has been created|i created the following files|created the following files|i have finished|task completed|完了しました|作成しました)/i.test(s)) return true;
    return false;
}

function scoreParagraphForFinalSummary(paragraph) {
    const p = String(paragraph || '').trim();
    if (!p) return -1000;
    let score = meaningfulBodyScore(p);
    if (isProgressNarrationLine(p)) score -= 1200;
    if (!containsCjk(p) && /^(planning|developing|constructing|implementing|refining|finalizing|initiating|commencing|crafting|verifying|calculating|styling|building)\b/i.test(p)) score -= 900;
    if (/^(i('| a)m|i have|i've|i am|my aim is|i plan to|i'm currently|i'm focusing)/i.test(p)) score -= 800;
    if (/(index\.html|style\.css|script\.js|\.html|\.css|\.js)/i.test(p)) score += 120;
    if (/(created|completed|finished|summary|作成|完了)/i.test(p)) score += 900;
    if (containsCjk(p)) score += 220;
    if (/^(good|bad)$/im.test(p)) score -= 800;
    if (/info:\s*server is started/i.test(p)) score -= 1000;
    return score;
}

function cleanupNoiseLines(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (const raw of lines) {
        const line = String(raw || '').replace(/\s+$/g, '');
        const t = line.trim();
        if (!t) {
            out.push('');
            continue;
        }
        if (isTerminalNoiseLine(t)) continue;
        out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractFinalAssistantSummary(text) {
    const cleaned = cleanupNoiseLines(text);
    if (!cleaned) return '';

    const lines = cleaned.split('\n').map(l => l.trimRight());
    const finalLineIndexes = [];
    const strongFinalLineIndexes = [];
    for (let i = 0; i < lines.length; i++) {
        const t = String(lines[i] || '').trim();
        if (!t) continue;
        if (isFinalSummaryLine(t)) finalLineIndexes.push(i);
        if (isStrongFinalSummaryLine(t)) strongFinalLineIndexes.push(i);
    }
    let pickedFinalIdx = -1;
    if (strongFinalLineIndexes.length > 0) {
        const lastStrong = strongFinalLineIndexes[strongFinalLineIndexes.length - 1];
        const windowStart = Math.max(0, lastStrong - 40);
        const firstStrongNearTail = strongFinalLineIndexes.find(i => i >= windowStart);
        pickedFinalIdx = Number.isInteger(firstStrongNearTail) ? firstStrongNearTail : lastStrong;
    } else if (finalLineIndexes.length > 0) {
        pickedFinalIdx = finalLineIndexes[finalLineIndexes.length - 1];
    }
    if (pickedFinalIdx >= 0) {
        let startIdx = Math.max(0, pickedFinalIdx - 6);
        for (let i = startIdx; i < pickedFinalIdx; i++) {
            const t = String(lines[i] || '').trim();
            if (!t) continue;
            if (isProgressNarrationLine(t)) {
                startIdx = i + 1;
            }
        }
        const tail = lines.slice(startIdx)
            .filter(line => !isProgressNarrationLine(line))
            .filter(line => !isTerminalNoiseLine(line))
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        if (tail) return tail;
    }

    const paragraphs = [];
    let current = [];
    for (const line of lines) {
        if (!line.trim()) {
            if (current.length > 0) {
                paragraphs.push(current.join('\n').trim());
                current = [];
            }
            continue;
        }
        current.push(line);
    }
    if (current.length > 0) paragraphs.push(current.join('\n').trim());
    if (paragraphs.length === 0) return '';

    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < paragraphs.length; i++) {
        const s = scoreParagraphForFinalSummary(paragraphs[i]) + Math.floor(i * 8);
        if (s >= bestScore) {
            bestScore = s;
            bestIdx = i;
        }
    }

    if (bestIdx < 0) return '';
    let start = bestIdx;
    for (let i = bestIdx; i >= Math.max(0, bestIdx - 2); i--) {
        if (isFinalSummaryLine(paragraphs[i])) {
            start = i;
        }
    }

    const selected = [];
    for (let i = start; i < paragraphs.length; i++) {
        const p = paragraphs[i];
        const sc = scoreParagraphForFinalSummary(p);
        if (selected.length > 0 && sc < -150) break;
        if (selected.length > 0 && isProgressNarrationLine(p)) break;
        if (sc < -400) continue;
        selected.push(p);
        if (selected.join('\n\n').length > 3500) break;
    }

    const joined = selected.join('\n\n').trim() || paragraphs[bestIdx];
    return cleanupNoiseLines(joined);
}

function detectPromptFromRawText(rawText) {
    const lines = String(rawText || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
    if (lines.length === 0) return '';

    for (const line of lines.slice(0, 25)) {
        if (isTerminalNoiseLine(line)) continue;
        if (isProgressNarrationLine(line)) continue;
        if (isFinalSummaryLine(line)) continue;
        if (/^[a-z]:\\/.test(line)) continue;
        if (line.length < 8 || line.length > 300) continue;
        if (/\[run:\d+\]/i.test(line)) return line;
        if (/(please|create|build)/i.test(line)) return line;
    }
    return '';
}

function extractStructuredAssistantContent(rawText, promptText = '') {
    let text = String(rawText || '').replace(/\r/g, '');
    const prompt = String(promptText || '').trim();
    if (prompt && text.includes(prompt)) {
        const idx = text.lastIndexOf(prompt);
        if (idx >= 0) text = text.slice(idx + prompt.length);
    }

    const lines = text.split('\n').map(line => line.replace(/\s+$/g, ''));
    const bodyLines = [];
    const changes = [];
    const seenFiles = new Set();
    let filesWithChanges = null;
    let insertions = null;
    let deletions = null;
    let pendingPlus = null;
    let pendingMinus = null;

    const pushChange = (file, add, del) => {
        const normalizedFile = String(file || '').trim();
        if (!normalizedFile) return;
        const key = normalizedFile.toLowerCase();
        if (seenFiles.has(key)) return;
        seenFiles.add(key);
        changes.push({
            file: normalizedFile,
            insertions: Number(add) || 0,
            deletions: Number(del) || 0
        });
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = String(raw || '').trim();
        const lower = line.toLowerCase();
        if (!line) continue;

        const fileCountMatch = line.match(/^(\d+)\s+files?\s+with\s+changes$/i);
        if (fileCountMatch) {
            const count = Number(fileCountMatch[1]);
            filesWithChanges = count > 0 ? count : null;
            continue;
        }

        const bothMatch = line.match(/^(\d+)\s+insertions?\s*\(\+\)\s+(\d+)\s+deletions?\s*\(-\)$/i);
        if (bothMatch) {
            const ins = Number(bothMatch[1]);
            const del = Number(bothMatch[2]);
            insertions = ins > 0 ? ins : null;
            deletions = del > 0 ? del : null;
            continue;
        }
        const insMatch = line.match(/^(\d+)\s+insertions?\s*\(\+\)$/i);
        if (insMatch) {
            const ins = Number(insMatch[1]);
            insertions = ins > 0 ? ins : null;
            continue;
        }
        const delMatch = line.match(/^(\d+)\s+deletions?\s*\(-\)$/i);
        if (delMatch) {
            const del = Number(delMatch[1]);
            deletions = del > 0 ? del : null;
            continue;
        }

        let editedMatch = line.match(/^edited\b.*?([a-z0-9._-]+\.[a-z0-9]+)\s+\+(\d+)\s*-\s*(\d+)$/i);
        if (!editedMatch) {
            editedMatch = line.match(/^([a-z0-9._-]+\.[a-z0-9]+)\s+\+(\d+)\s*-\s*(\d+)$/i);
        }
        if (editedMatch) {
            pushChange(editedMatch[1], editedMatch[2], editedMatch[3]);
            continue;
        }

        if (/^\+\d+$/.test(line)) {
            pendingPlus = Number(line.slice(1));
            continue;
        }
        if (/^-\d+$/.test(line) && pendingPlus !== null) {
            pendingMinus = Number(line.slice(1));
            continue;
        }

        if (pendingPlus !== null && pendingMinus !== null) {
            const nameMatch = line.match(/^([a-z0-9._-]+\.[a-z0-9]+)$/i);
            const pathMatch = line.match(/[\\\/]([a-z0-9._-]+\.[a-z0-9]+)$/i);
            if (nameMatch || pathMatch) {
                const file = nameMatch ? nameMatch[1] : pathMatch[1];
                pushChange(file, pendingPlus, pendingMinus);
                pendingPlus = null;
                pendingMinus = null;
                continue;
            }
        }

        if (lower === 'edited') continue;
        if (isUiChromeLine(line)) continue;
        if (/^[a-z]:\\/.test(line)) continue;

        bodyLines.push(line);
    }

    const bodyText = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return {
        bodyText,
        changes,
        filesWithChanges,
        insertions,
        deletions
    };
}

function buildChangeSection(structured) {
    const lines = [];
    const hasFileCount = Number.isInteger(structured?.filesWithChanges) && structured.filesWithChanges > 0;
    const hasInsertions = Number.isInteger(structured?.insertions) && structured.insertions > 0;
    const hasDeletions = Number.isInteger(structured?.deletions) && structured.deletions > 0;

    if (hasFileCount || hasInsertions || hasDeletions) {
        const summary = [];
        if (hasFileCount) summary.push(`${structured.filesWithChanges} file(s)`);
        if (hasInsertions) summary.push(`${structured.insertions} insertions (+)`);
        if (hasDeletions) summary.push(`${structured.deletions} deletions (-)`);
        if (summary.length > 0) lines.push(`### Diff Summary\n${summary.join(' / ')}`);
    }

    const nonZeroChanges = Array.isArray(structured?.changes)
        ? structured.changes.filter(ch => (Number(ch?.insertions) > 0 || Number(ch?.deletions) > 0))
        : [];
    if (nonZeroChanges.length > 0) {
        lines.push('### Files Changed');
        for (const ch of nonZeroChanges.slice(0, 30)) {
            lines.push(`- \`${ch.file}\` \`+${ch.insertions} -${ch.deletions}\``);
        }
    }

    return lines.join('\n').trim();
}

function structuredContentScore(structured) {
    if (!structured || typeof structured !== 'object') return 0;
    let score = 0;
    const changes = Array.isArray(structured.changes) ? structured.changes.length : 0;
    score += changes * 100;
    if (Number.isInteger(structured.filesWithChanges)) score += 30;
    if (Number.isInteger(structured.insertions)) score += 10;
    if (Number.isInteger(structured.deletions)) score += 10;
    if (String(structured.bodyText || '').trim()) score += 1;
    return score;
}

function meaningfulBodyScore(text) {
    const src = String(text || '').replace(/\r/g, '');
    if (!src.trim()) return 0;
    const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
    let score = 0;
    for (const line of lines) {
        if (isUiChromeLine(line)) continue;
        if (/^[+-]\d+$/.test(line)) continue;
        if (/^(edited|review changes)$/i.test(line)) continue;
        const len = line.length;
        if (len < 4) continue;
        score += Math.min(len, 120);
        if (/[\p{L}\p{N}]/u.test(line)) score += 10;
    }
    return score;
}

function isLikelyCodeLine(line) {
    const s = String(line || '').trim();
    if (!s) return false;
    if (/^[+-]\d+$/.test(s)) return true;
    if (/[;{}]/.test(s)) return true;
    if (/^\s*<\/?[a-z][^>]*>\s*$/i.test(s)) return true;
    if (/^\s*(const|let|var|function|if|for|while|return|import|export|class)\b/.test(s)) return true;
    if (/^\s*[.#]?[\w-]+\s*:\s*[^:]+;?\s*$/.test(s)) return true;
    if (/^\s*--[\w-]+\s*:\s*.+;\s*$/.test(s)) return true;
    const symbolCount = (s.match(/[{};=<>\[\]()+*]/g) || []).length;
    if (symbolCount >= 5 && symbolCount > Math.floor(s.length * 0.2)) return true;
    return false;
}

function extractNarrativeBody(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (const raw of lines) {
        const line = String(raw || '').trim();
        if (!line) {
            out.push('');
            continue;
        }
        if (isUiChromeLine(line)) continue;
        if (/^[+-]\d+$/.test(line)) continue;
        if (/^edited$/i.test(line)) continue;
        if (isLikelyCodeLine(line)) continue;
        out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function selectFinalNarrativeSegment(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/g, ''));
    if (lines.length === 0) return '';
    const nonEmpty = lines.map((l, idx) => ({ line: l.trim(), idx })).filter(x => x.line.length > 0);
    if (nonEmpty.length === 0) return '';

    const answerLike = nonEmpty.filter(x =>
        /[.!?\u3002\uff01\uff1f]$/.test(x.line) ||
        /(created|completed|done|summary|result|files?|directory|implemented|updated)/i.test(x.line)
    );

    const targetIdx = answerLike.length > 0
        ? answerLike[answerLike.length - 1].idx
        : nonEmpty[nonEmpty.length - 1].idx;

    const start = Math.max(0, targetIdx - 30);
    const segment = lines.slice(start).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return segment;
}

function containsWorkbenchChrome(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return false;
    const patterns = [
        'file\nedit\nselection\nview\ngo\nrun\nterminal\nhelp',
        'agent manager\nactive',
        'open agent manager',
        'ask anything, @ to mention, / for workflows',
        'git graph',
        'ln ',
        ' col ',
        '\ncrlf\n',
        '\nutf-8\n'
    ];
    return patterns.some(p => t.includes(p));
}

function isLowConfidenceResponse(response) {
    const raw = String(response?.markdown || response?.text || '');
    const sanitized = sanitizeAssistantMarkdown(raw, '');
    const narrative = extractNarrativeBody(sanitized);
    const narrativeScore = meaningfulBodyScore(narrative);
    const messageRoleCount = Number(response?.messageRoleCount || 0);
    const selector = String(response?.selector || '').toLowerCase();
    const lines = narrative
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
    const naturalLines = lines.filter(l =>
        /[.!?\u3002\uff01\uff1f]/.test(l) ||
        /[\u3040-\u30ff\u3400-\u9fff]/.test(l) ||
        /\b[a-z]{3,}\s+[a-z]{3,}\b/i.test(l)
    ).length;
    const pathLikeLines = lines.filter(l =>
        /^[a-z]:\\/i.test(l) ||
        l.includes('\\') ||
        /^\/[a-z0-9_./-]+/i.test(l) ||
        /\[[^\]]+\]/.test(l)
    ).length;
    const codeLikeLines = lines.filter(l => isLikelyCodeLine(l)).length;
    const progressLikeLines = lines.filter(l =>
        /^(i('| a)m|planning|developing|constructing|finalizing|analyzing)\b/i.test(l)
    ).length;
    const hasFinalSignal = lines.some(l =>
        /(created|completed|directory|files?|summary|result|implemented|updated)/i.test(l)
    );
    const hasChangeSignal =
        /(^|\n)\s*edited(?:\s+[+-]\d+\s+[+-]\d+)?\s*($|\n)/im.test(raw) ||
        /(^|\n)\s*[+-]\d+\s*($|\n)/m.test(raw) ||
        /\b\d+\s+insertions?\s*\(\+\)/i.test(raw) ||
        /\b\d+\s+deletions?\s*\(-\)/i.test(raw);
    const hasRunMarker = /\[run:\d+\]/i.test(raw);
    const signalBacked = hasChangeSignal || (hasRunMarker && hasFinalSignal);
    const startsWithChrome = lines.length > 0 && (
        /^agent manager$/i.test(lines[0]) ||
        /^file$/i.test(lines[0]) ||
        /^edit$/i.test(lines[0])
    );

    if (!raw.trim()) return true;
    if (startsWithChrome) return true;
    if (lines.length >= 8 && naturalLines < 2) return true;
    if (pathLikeLines >= 3 && naturalLines < 4) return true;
    if (codeLikeLines >= 2 && naturalLines < 5) return true;
    if (progressLikeLines >= 3 && !hasFinalSignal) return true;
    if (containsWorkbenchChrome(raw) && narrativeScore < 300 && !signalBacked) return true;
    if (messageRoleCount === 0 && (selector.includes('body') || selector === 'none') && narrativeScore < 500 && !signalBacked) return true;
    return false;
}

function splitForEmbed(text, limit = 3800) {
    const input = String(text || '').trim();
    if (!input) return [];

    const chunks = [];
    let rest = input;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf('\n\n', limit);
        if (cut < Math.floor(limit * 0.6)) cut = rest.lastIndexOf('\n', limit);
        if (cut < Math.floor(limit * 0.6)) cut = rest.lastIndexOf(' ', limit);
        if (cut < 1) cut = limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

function clipText(text, max = 12000) {
    const s = String(text || '');
    if (s.length <= max) return s;
    return `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function buildRawResponseEnvelope(response, promptText = '', renderedContent = '') {
    const now = new Date().toISOString();
    return {
        capturedAt: now,
        prompt: String(promptText || ''),
        selector: String(response?.selector || ''),
        contextId: Number(response?.contextId || 0),
        messageRoleCount: Number(response?.messageRoleCount || 0),
        text: clipText(response?.text || ''),
        markdown: clipText(response?.markdown || ''),
        renderedContent: clipText(renderedContent || ''),
        images: Array.isArray(response?.images) ? response.images : [],
        domDebug: response?.domDebug || null
    };
}

function writeDomDebugHtmlFiles(payload, outPath) {
    const htmlFiles = [];
    const domDebug = payload?.domDebug && typeof payload.domDebug === 'object'
        ? payload.domDebug
        : null;
    if (!domDebug) return htmlFiles;

    const outDir = path.dirname(outPath);
    const baseName = path.basename(outPath, path.extname(outPath));
    const targets = [
        { key: 'nodeInnerHTML', suffix: 'node_inner.html' },
        { key: 'nodeOuterHTML', suffix: 'node_outer.html' }
    ];

    for (const target of targets) {
        const value = String(domDebug[target.key] || '');
        if (!value.trim()) continue;

        try {
            const htmlPath = path.join(outDir, `${baseName}_${target.suffix}`);
            fs.writeFileSync(htmlPath, value, 'utf8');
            const relPath = path.relative(process.cwd(), htmlPath).replace(/\\/g, '/');
            domDebug[`${target.key}HtmlFile`] = relPath || path.basename(htmlPath);
            domDebug[target.key] = `[saved to ${domDebug[`${target.key}HtmlFile`]}]`;
            htmlFiles.push(htmlPath);
        } catch (e) {
            logInteraction('ERROR', `[RAW_DUMP] ${target.key} html write failed: ${e?.message || String(e)}`);
        }
    }

    return htmlFiles;
}

function writeRawDumpFile(payload) {
    try {
        const outDir = path.join(process.cwd(), 'debug');
        fs.mkdirSync(outDir, { recursive: true });
        const fileName = RAW_DUMP_FILE
            ? path.basename(RAW_DUMP_FILE)
            : `raw_response_${Date.now()}.json`;
        const outPath = RAW_DUMP_FILE
            ? (path.isAbsolute(RAW_DUMP_FILE) ? RAW_DUMP_FILE : path.join(process.cwd(), RAW_DUMP_FILE))
            : path.join(outDir, fileName);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        const htmlFiles = writeDomDebugHtmlFiles(payload, outPath);
        fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
        return { outPath, htmlFiles };
    } catch (e) {
        logInteraction('ERROR', `[RAW_DUMP] write failed: ${e?.message || String(e)}`);
        return { outPath: '', htmlFiles: [] };
    }
}

async function emitRawDump(target, response, promptText = '', renderedContent = '') {
    if (!RAW_DUMP_MODE) return;

    const payload = buildRawResponseEnvelope(response, promptText, renderedContent);
    const { outPath, htmlFiles } = writeRawDumpFile(payload);
    if (!outPath) return;

    const preview = clipText(JSON.stringify({
        prompt: payload.prompt,
        selector: payload.selector,
        messageRoleCount: payload.messageRoleCount,
        domDebug: payload.domDebug
    }, null, 2), 1300);

    logInteraction('ACTION', `[RAW_DUMP] Saved: ${outPath}${htmlFiles.length > 0 ? ` (+${htmlFiles.length} html)` : ''}\n${preview}`);
    logInteraction('ACTION', '[RAW_DUMP] Discord upload removed; kept local files only.');
}


async function sendResponseEmbeds(originalMessage, response, promptText = '') {
    if (!response?.text) return false;

    const structuredFromText = extractStructuredAssistantContent(response.text, promptText);
    const structuredFromMarkdown = response.markdown
        ? extractStructuredAssistantContent(response.markdown, promptText)
        : null;
    const structured = structuredContentScore(structuredFromMarkdown) > structuredContentScore(structuredFromText)
        ? structuredFromMarkdown
        : structuredFromText;

    const autoPrompt = String(promptText || '').trim()
        || String(response?.prompt || '').trim()
        || detectPromptFromRawText(response.text || '')
        || detectPromptFromRawText(response.markdown || '');

    const cleanedMarkdown = sanitizeAssistantMarkdown(response.markdown || '', autoPrompt);
    const cleanedText = structured.bodyText || sanitizeAssistantResponse(response.text, autoPrompt);
    const narrativeMarkdown = extractFinalAssistantSummary(selectFinalNarrativeSegment(extractNarrativeBody(cleanedMarkdown)));
    const narrativeText = extractFinalAssistantSummary(selectFinalNarrativeSegment(extractNarrativeBody(cleanedText)));
    const markdownScore = meaningfulBodyScore(cleanedMarkdown);
    const textScore = meaningfulBodyScore(cleanedText);
    const narrativeMarkdownScore = meaningfulBodyScore(narrativeMarkdown);
    const narrativeTextScore = meaningfulBodyScore(narrativeText);

    let cleaned = '';
    if (narrativeMarkdownScore > 0 || narrativeTextScore > 0) {
        cleaned = narrativeMarkdownScore >= narrativeTextScore ? narrativeMarkdown : narrativeText;
    } else {
        cleaned = extractFinalAssistantSummary((markdownScore >= textScore ? cleanedMarkdown : cleanedText) || cleanedMarkdown || cleanedText);
    }
    if (!cleaned) {
        cleaned = extractFinalAssistantSummary(response.markdown || response.text || '');
    }
    cleaned = cleanupNoiseLines(cleaned);
    const changeSection = buildChangeSection(structured);
    const content = changeSection
        ? (cleaned ? `${changeSection}\n\n### Assistant Message\n${cleaned}` : changeSection)
        : (cleaned || String(response.markdown || response.text || '').trim());
    if (!content) return false;

    const preview = content
        .replace(/\r/g, '')
        .split('\n')
        .slice(0, 18)
        .join('\n')
        .slice(0, 1200);
    logInteraction(
        'ACTION',
        `[SEND_PREVIEW] markdownScore=${markdownScore}, textScore=${textScore}, narrativeMarkdownScore=${narrativeMarkdownScore}, narrativeTextScore=${narrativeTextScore}, prompt="${autoPrompt.slice(0, 140)}"\n${preview}`
    );

    await emitRawDump(originalMessage, response, autoPrompt, content);
    logInteraction('ACTION', '[DISCORD_RESPONSE] Discord response posting removed. Kept extraction + local raw dump only.');
    return true;
}

function createInteractionReplyBridge(interaction, promptText = '') {
    return {
        content: promptText,
        author: { id: interaction.user?.id || '' },
        followUp: async (payload) => interaction.followUp(payload),
        channel: {
            send: async (payload) => interaction.followUp(payload)
        },
        reply: async (payload) => {
            if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
            return interaction.reply(payload);
        },
        editReply: async (payload) => interaction.editReply(payload)
    };
}



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

function shouldRelayLogToDiscord(type) {
    return DISCORD_ACTIVITY_LOG_ENABLED && DISCORD_ACTIVITY_LOG_TYPES.has(type);
}

function formatLogForDiscord(type, content) {
    const icons = {
        INJECT: '[IN]',
        NEWCHAT: '[NC]',
        APPROVAL: '[AP]',
        ACTION: '[AC]',
        ERROR: '[ER]',
        STOP: '[ST]',
        SUCCESS: '[OK]',
        UPLOAD: '[UP]',
        UPLOAD_ERROR: '[UE]',
        generating: '[GN]'
    };

    const icon = icons[type] || '[--]';
    const normalized = String(content || '').replace(/\s+/g, ' ').trim();
    const max = 1700;
    const body = normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
    return `${icon} [${type}] ${body}`;
}

async function relayLogToDiscord(type, content) {
    if (!lastActiveChannel) return;
    if (!shouldRelayLogToDiscord(type)) return;

    const message = formatLogForDiscord(type, content);
    const now = Date.now();
    const key = `${type}:${message}`;
    if (lastDiscordActivity.key === key && (now - lastDiscordActivity.at) < 3000) return;
    lastDiscordActivity = { key, at: now };

    try {
        await lastActiveChannel.send({ content: message });
    } catch (e) {
        console.error('[DISCORD_ACTIVITY_LOG_ERROR]', e.message);
    }
}

function logInteraction(type, content) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${type}] ${content}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);

    let color = COLORS.reset;
    let icon = '';

    switch (type) {
        case 'INJECT':
        case 'SUCCESS':
            color = COLORS.green;
            icon = '[OK] ';
            break;
        case 'ERROR':
            color = COLORS.red;
            icon = '[ERR] ';
            break;
        case 'generating':
            color = COLORS.yellow;
            icon = '[GEN] ';
            break;
        case 'CDP':
            color = COLORS.cyan;
            icon = '[CDP] ';
            break;
        default:
            color = COLORS.reset;
    }

    console.log(`${color}[${type}] ${icon}${content}${COLORS.reset}`);

    if (type === 'CDP' && content.includes('Connected')) setTitle('Connected');
    if (type === 'CDP' && content.includes('disconnected')) setTitle('Disconnected');
    if (type === 'generating') setTitle('Generating...');
    if (type === 'SUCCESS' || (type === 'INJECT' && !content.includes('failed'))) setTitle('Connected');
    void relayLogToDiscord(type, content);
}

function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => {
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
    const allTargets = [];
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

    if (allTargets.length === 0) throw new Error("CDP not found.");

    // If a target was explicitly selected, try to find it
    if (explicitTargetUrl) {
        const selected = allTargets.find(t => t.webSocketDebuggerUrl === explicitTargetUrl);
        if (selected) {
            console.log(`[CDP] Using explicitly selected target: ${selected.title}`);
            return { port: selected.port, url: selected.webSocketDebuggerUrl };
        }
    }

    // Priorities
    // 1. HIGHEST: Title starts with a real folder name (e.g. "workspace - Antigravity - ...") 
    //    Accept even if "Walkthrough" is in the title - it means a tab in that window, not a pure walkthrough window.
    let target = allTargets.find(t =>
        t.type === 'page' &&
        !t.title.toLowerCase().startsWith('walkthrough') &&   // pure walkthrough window
        !t.title.toLowerCase().startsWith('launchpad') &&     // launchpad window
        !t.url.includes('workbench-jetski-agent') &&
        (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade')) &&
        (t.title.toLowerCase().includes('workspace') || t.title.toLowerCase().includes('project'))
    );

    // 2. Any project window that doesn't look like Launchpad or a pure walkthrough
    if (!target) {
        target = allTargets.find(t =>
            t.type === 'page' &&
            !t.title.toLowerCase().startsWith('walkthrough') &&
            !t.title.toLowerCase().startsWith('launchpad') &&
            !t.url.includes('workbench-jetski-agent') &&
            (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade'))
        );
    }

    // 3. Fallback to any project-like target (still avoid launchpad)
    if (!target) {
        target = allTargets.find(t =>
            t.type === 'page' &&
            (t.url.includes('workbench') || t.title.includes('Antigravity') || t.title.includes('Cascade')) &&
            !t.url.includes('workbench-jetski-agent')
        );
    }

    if (target) {
        console.log(`[CDP] Connected to target: ${target.title} (${target.url})`);
        return { port: target.port, url: target.webSocketDebuggerUrl };
    }
    throw new Error("Suitable CDP target not found.");
}

async function listAllCDPTargets() {
    const allTargets = [];
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            for (const t of list) {
                if (t.type === 'page' && t.webSocketDebuggerUrl) {
                    allTargets.push({ ...t, port });
                }
            }
        } catch (e) { }
    }
    return allTargets;
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
            WORKSPACE_ROOT = null;
            return;
        }
        WORKSPACE_ROOT = process.env.WATCH_DIR;
        if (!fs.existsSync(WORKSPACE_ROOT) || !fs.statSync(WORKSPACE_ROOT).isDirectory()) {
            console.error(`Error: WATCH_DIR '${WORKSPACE_ROOT}' does not exist or is not a directory.`);
            process.exit(1);
        }
        return;
    }

    const rl = readline.createInterface({ input, output });
    console.log('\n--- Watch Directory Setup ---');

    while (true) {
        const answer = await new Promise(resolve => rl.question('Enter watch directory (blank to disable): ', resolve));
        const folderPath = (answer || '').trim();

        if (folderPath === '') {
            console.log('Watching is disabled.');
            WORKSPACE_ROOT = null;
            try {
                fs.appendFileSync('.env', '\nWATCH_DIR=');
            } catch (e) {
                console.warn('Warning: failed to save WATCH_DIR to .env:', e.message);
            }
            break;
        }

        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
            WORKSPACE_ROOT = folderPath;
            try {
                fs.appendFileSync('.env', `\nWATCH_DIR=${folderPath}`);
                console.log(`Saved WATCH_DIR=${folderPath} to .env`);
            } catch (e) {
                console.warn('Warning: failed to save WATCH_DIR to .env:', e.message);
            }
            break;
        }

        console.log('Invalid path. Please enter an existing directory.');
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
        const docs = [document];
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch(e){}
        }

        for (const doc of docs) {
            // 1. Specific Antigravity/Cascade Cancel Button
            const cancel = doc.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"], [aria-label="Stop generation"]');
            if (cancel && cancel.offsetParent !== null) return { ok: true, reason: 'cancel_btn', tag: cancel.tagName, html: cancel.outerHTML.substring(0, 100) };
            
            // 2. Focused Spinner (loading icons usually denote active work)
            const spinner = doc.querySelector('.codicon-loading, .codicon-sync.animating, .loading-indicator');
            if (spinner && spinner.offsetParent !== null) return { ok: true, reason: 'spinner', tag: spinner.tagName, html: spinner.outerHTML.substring(0, 100) };
            
            // 3. Status indicators in chat blocks
            const indicators = doc.querySelectorAll('.running, .executing, .pending_execution');
            for (const el of indicators) {
                if (el.offsetParent !== null) return { ok: true, reason: 'indicator:' + el.className };
            }
        }
        return { ok: false };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true, contextId: ctx.id });
            const val = res.result?.value;
            if (val?.ok) {
                console.log(`[GenCheck] Detected generating in ctx ${ctx.id}: ${val.reason} (${val.tag}): ${val.html}`);
                return true;
            }
        } catch (e) { }
    }
    if (cdp.contexts.length === 0) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: EXP, returnByValue: true });
            if (res.result?.value?.ok) return true;
        } catch (e) { }
    }
    return false;
}

async function waitForGenerationStart(cdp, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            if (await checkIsGenerating(cdp)) return true;
        } catch (e) { }
        await new Promise(r => setTimeout(r, 400));
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
        const approvalKeywords = ${JSON.stringify(SELECTORS.APPROVAL_KEYWORDS)};
        // Anchor keywords (The "No" or "Secondary" button)
        const anchorKeywords = ${JSON.stringify(SELECTORS.CANCEL_KEYWORDS)};
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
                        if (header) msg.push("[Header] " + header.innerText.trim());
                        if (prose) msg.push(prose.innerText.trim());
                        if (pre) msg.push("[Command] " + pre.innerText.trim());
                        
                        if (msg.length > 0) textContext = msg.join('\n\n');
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
            (t.title === 'Manager' || t.title.includes('jetski') || t.url.includes('jetski') || t.title.includes('Launchpad'))
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
                (t.title === 'Manager' || t.title.includes('jetski') || t.url.includes('jetski') || t.title.includes('Launchpad'))
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
                    '.chat-message-assistant', '.chat-response', '.ide-message-block', '[class*="ide-message"]',
                    '[class*="bot-color"]'
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
            '.chat-message-assistant', '.chat-response', '.ide-message-block', '[class*="ide-message"]',
            '[class*="bot-color"]'
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

async function stopGeneration(cdp) {
    const EXP = `(() => {
        function shadowQuery(selector, root = document) {
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
        }

        const selectors = [
            '[data-tooltip-id="input-send-button-cancel-tooltip"]',
            '[aria-label="Stop generation"]',
            '[aria-label="Cancel"]',
            '.codicon-stop',
            '.codicon-debug-stop',
            '.stop-button',
            '.cancel-button'
        ];

        for (const sel of selectors) {
            const els = shadowQuery(sel);
            for (const el of els) {
                const btn = el.tagName === 'BUTTON' ? el : el.closest('button');
                if (btn && btn.offsetParent !== null) {
                    btn.click();
                    return { success: true, method: sel };
                }
                // Try clicking the element itself if no button parent
                if (el.offsetParent !== null) {
                    el.click();
                    return { success: true, method: sel + '_direct' };
                }
            }
        }

        const buttons = shadowQuery('button');
        for (const btn of buttons) {
            const txt = (btn.innerText || '').trim().toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const combined = txt + ' ' + aria;
            if (combined.includes('stop') || combined.includes('cancel') || combined.includes('停止') || combined.includes('中止')) {
                if (btn.offsetParent !== null) {
                    btn.click();
                    return { success: true, method: 'text:' + combined };
                }
            }
        }
        return { success: false };
    })()`;

    const results = await evalInAllContexts(cdp, EXP, { stopOnSuccess: true, successCheck: (v) => v?.success });
    if (results.some(r => r.value?.success)) {
        logInteraction('STOP', `Generation stopped successfully (Method: ${results.find(r => r.value?.success).value.method})`);
        return true;
    }
    logInteraction('DEBUG', 'Stop button not found in any context.');
    return false;
}

function summarizeNewChatAttempt(a) {
    const parts = [
        `ctx = ${a.contextId ?? 'n/a'
        } `,
        `phase = ${a.phase ?? 'n/a'} `,
        `success = ${Boolean(a.success)} `,
        `reason = ${a.reason || 'n/a'} `,
        `doc = ${a.docSource || 'n/a'} `,
        `selector = ${a.method || a.selector || 'n/a'} `
    ];
    if (typeof a.changed === 'boolean') parts.push(`changed = ${a.changed} `);
    if (a.confirmClicked) parts.push(`confirm = "${a.confirmClicked}"`);
    return parts.join(', ');
}

async function startNewChat(cdp) {
    const EXP = `(async () => {
    function getTargetDoc() {
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
            if ((iframes[i].src || '').includes('cascade-panel')) {
                try { return iframes[i].contentDocument; } catch (e) { }
            }
        }
        return null;
    }

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (el.offsetParent === null && style.position !== 'fixed') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getSnapshot(doc) {
        const editorCandidates = Array.from(doc.querySelectorAll('div[role="textbox"]:not(.xterm-helper-textarea)')).filter(isVisible);
        const editor = editorCandidates.at(-1);
        const titles = Array.from(doc.querySelectorAll('p.text-ide-sidebar-title-color')).map(el => (el.innerText || '').trim()).filter(Boolean);
        return {
            messageCount: doc.querySelectorAll('[data-message-role]').length,
            activeTitle: titles[0] || null,
            editorChars: ((editor && editor.innerText) || '').trim().length
        };
    }

    const selectors = [
        '[data-tooltip-id="new-conversation-tooltip"]',
        '[data-tooltip-id*="new-chat"]',
        '[data-tooltip-id*="new_chat"]',
        '[aria-label*="New Chat"]',
        '[aria-label*="New Conversation"]'
    ];

    const docs = [{ source: 'document', doc: document }];
    const iframeDoc = getTargetDoc();
    if (iframeDoc) docs.push({ source: 'cascade_iframe', doc: iframeDoc });

    for (const item of docs) {
        const doc = item.doc;
        for (const sel of selectors) {
            const btn = doc.querySelector(sel);
            if (!btn) continue;
            if (!isVisible(btn) || btn.disabled) {
                return { success: false, reason: 'button_not_interactable', selector: sel, docSource: item.source };
            }

            const before = getSnapshot(doc);
            const dispatch = (type, Cls) => {
                try {
                    if (typeof Cls === 'function') {
                        btn.dispatchEvent(new Cls(type, { bubbles: true, cancelable: true, view: window, buttons: 1 }));
                    }
                } catch (e) { }
            };

            dispatch('pointerdown', PointerEvent);
            dispatch('mousedown', MouseEvent);
            dispatch('pointerup', PointerEvent);
            dispatch('mouseup', MouseEvent);
            dispatch('click', MouseEvent);
            try { btn.click(); } catch (e) { }
            await new Promise(r => setTimeout(r, 700));

            const confirmKeywords = ['start new', 'new chat', 'new conversation', 'discard', 'continue', 'ok', 'yes'];
            let confirmClicked = null;
            const modalButtons = Array.from(doc.querySelectorAll('button, [role="button"]')).filter(isVisible);
            for (const b of modalButtons) {
                const txt = ((b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase());
                if (!txt) continue;
                if (confirmKeywords.some(k => txt.includes(k))) {
                    try {
                        b.click();
                        confirmClicked = txt.slice(0, 80);
                        break;
                    } catch (e) { }
                }
            }

            await new Promise(r => setTimeout(r, 1100));
            const after = getSnapshot(doc);

            const changed =
                before.activeTitle !== after.activeTitle ||
                (before.messageCount > 0 && after.messageCount === 0) ||
                (before.editorChars > 0 && after.editorChars === 0);

            const alreadyFresh = before.messageCount === 0 && before.editorChars === 0;
            const success = changed || Boolean(confirmClicked) || alreadyFresh;

            return {
                success,
                reason: success ? 'ok' : 'click_no_state_change',
                method: sel,
                selector: sel,
                docSource: item.source,
                changed,
                confirmClicked,
                before,
                after
            };
        }
    }

    return { success: false, reason: 'button_not_found' };
})()`;

    const attempts = [];
    const primary = cdp.contexts.filter(c =>
        (c.url && c.url.includes(SELECTORS.CONTEXT_URL_KEYWORD)) ||
        (c.name && c.name.includes('Extension'))
    );
    const firstPass = primary.length > 0 ? primary : cdp.contexts;
    const secondPass = primary.length > 0 ? cdp.contexts.filter(c => !primary.includes(c)) : [];

    const tryContexts = async (contexts, phase) => {
        for (const ctx of contexts) {
            try {
                const res = await cdp.call('Runtime.evaluate', { expression: EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
                const value = res.result?.value || { success: false, reason: 'empty_result' };
                const attempt = {
                    ...value,
                    phase,
                    contextId: ctx.id,
                    contextName: ctx.name || '',
                    contextUrl: ctx.url || ''
                };
                attempts.push(attempt);
                console.log(`[NEWCHAT] ${summarizeNewChatAttempt(attempt)} `);
                if (attempt.success) {
                    logInteraction('NEWCHAT', `Success: ${summarizeNewChatAttempt(attempt)} `);
                    return attempt;
                }
            } catch (e) {
                const attempt = {
                    success: false,
                    reason: `evaluate_error:${e.message} `,
                    phase,
                    contextId: ctx.id,
                    contextName: ctx.name || '',
                    contextUrl: ctx.url || ''
                };
                attempts.push(attempt);
                console.log(`[NEWCHAT] ${summarizeNewChatAttempt(attempt)} `);
            }
        }
        return null;
    };

    const result1 = await tryContexts(firstPass, 'primary');
    if (result1) return result1;
    const result2 = await tryContexts(secondPass, 'fallback');
    if (result2) return result2;

    const tail = attempts.slice(-3).map(summarizeNewChatAttempt).join(' | ');
    logInteraction('NEWCHAT', `Failed after ${attempts.length} attempts.Recent: ${tail} `);
    return {
        success: false,
        reason: attempts[attempts.length - 1]?.reason || 'unknown',
        attempts
    };
}

async function getCurrentModel(cdp) {
    const EXP = `(() => {
    const docs = [document];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
        try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch (e) { }
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

async function getCurrentTitle(cdp) {
    const EXP = `(() => {
    const docs = [document];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
        try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch (e) { }
    }
    for (const doc of docs) {
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

async function getModelList(cdp) {
    const EXP = `(async () => {
    const docs = [document];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
        try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch (e) { }
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
            if (txt.length > 3 && txt.length < 50 && (txt.toLowerCase().includes('claude') || txt.toLowerCase().includes('gemini') || txt.toLowerCase().includes('gpt') || txt.toLowerCase().includes('o1') || txt.toLowerCase().includes('o3'))) {
                if (!models.includes(txt)) models.push(txt);
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

async function switchModel(cdp, targetName) {
    const SWITCH_EXP = `(async () => {
    const docs = [document];
    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
        try { if (iframes[i].contentDocument) docs.push(iframes[i].contentDocument); } catch (e) { }
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

    const target = ${JSON.stringify(targetName)
        }.toLowerCase();
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
    }) ()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", { expression: SWITCH_EXP, returnByValue: true, awaitPromise: true, contextId: ctx.id });
            if (res.result?.value) {
                const result = JSON.parse(res.result.value);
                if (result.success) {
                    logInteraction('MODEL', `Switched to: ${result.model} `);
                    return result;
                }
            }
        } catch (e) { }
    }
    return { success: false, reason: 'CDP error' };
}

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
        console.log('File watching is disabled.');
        return;
    }

    const watcher = chokidar.watch(WORKSPACE_ROOT, {
        ignored: [/node_modules/, /\.git/, /discord_interaction\.log$/],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: true
    });

    watcher.on('all', async (event, filePath) => {
        if (!lastActiveChannel) return;

        try {
            if (event === 'unlink') {
                await lastActiveChannel.send(`** File Deleted:** \`${path.basename(filePath)}\``);
                return;
            }

            if (event === 'add' || event === 'change') {
                if (!fs.existsSync(filePath)) return;
                const stats = fs.statSync(filePath);
                if (stats.size > 8 * 1024 * 1024) return;

                const attachment = new AttachmentBuilder(filePath);
                const label = event === 'add' ? 'Created' : 'Updated';
                await lastActiveChannel.send({
                    content: `**File ${label}:** \`${path.basename(filePath)}\``,
                    files: [attachment]
                });
            }
        } catch (e) {
            console.error('File watcher send error:', e.message);
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

    globalThis.isWaitingForApproval = false;
    globalThis.generationStarted = false;

    const poll = async () => {
        try {
            // 承認待ち中はポーリングをスキップ
            if (globalThis.isWaitingForApproval) {
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



                globalThis.isWaitingForApproval = true; // ブロック開始

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('approve_action').setLabel('Approve / Run').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('reject_action').setLabel('Reject / Cancel').setStyle(ButtonStyle.Danger)
                );
                const reply = await originalMessage.reply({ content: `**Approval Required**\n\`\`\`\n${approval.message}\n\`\`\` `, components: [row] });
                logInteraction('APPROVAL', `Request sent to Discord: ${approval.message.substring(0, 50)}...`);

                try {
                    const discordPromise = reply.awaitMessageComponent({ filter: i => i.user.id === originalMessage.author.id, time: 300000 });

                    let resolvedExternally = false;
                    const checkPromise = (async () => {
                        while (!resolvedExternally && globalThis.isWaitingForApproval) {
                            await new Promise(r => setTimeout(r, 2000));
                            if (!globalThis.isWaitingForApproval) break;
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
                        globalThis.isWaitingForApproval = false; // ブロック解除
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
                    globalThis.isWaitingForApproval = false; // ブロック解除
                    setTimeout(poll, POLLING_INTERVAL);
                } catch (e) {
                    await reply.edit({ content: '⚠️ Approval timed out. Auto-rejecting request in Antigravity.', components: [] });
                    await clickApproval(cdp, false); // Cancel it automatically
                    lastApprovalMessage = null;
                    globalThis.isWaitingForApproval = false; // ブロック解除
                    setTimeout(poll, POLLING_INTERVAL);
                }
                return;
            }

            const generating = await checkIsGenerating(cdp);
            if (generating && !globalThis.generationStarted) {
                globalThis.generationStarted = true;
                logInteraction('generating', 'AI response generation started.');
            }
            if (!generating) {
                stableCount++;
                if (stableCount % 1 === 0) logInteraction('DEBUG', `Polling... (Stable: ${stableCount}, Generating: ${generating})`);
                if (stableCount >= 5) {
                    const response = await getLastResponse(cdp);
                    if (response) {
                        // スナップショットと一致する場合は古い返答なのでスキップ
                        const isStale = prevSnapshot && response.text.substring(0, 500) === prevSnapshot;
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
                        const header = `🤖 **AI Response (PID: ${process.pid} | Msg: ${originalMessage.id}):**\n`;
                        await originalMessage.reply({ content: header + chunks[0] });
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
                logInteraction('DEBUG', `Polling... (Stable: ${stableCount}, Generating: ${generating})`);
            }

            setTimeout(poll, POLLING_INTERVAL);
        } catch (e) {
            console.error("Poll error:", e);
            logInteraction('ERROR', `Poll error: ${e?.stack || e?.message || String(e)}`);
            isGenerating = false;
            isMonitoring = false;
            setTimeout(() => processQueue(cdp), 1000);
        }
    };

    setTimeout(poll, POLLING_INTERVAL);
}
async function monitorAIResponse(originalMessage, cdp, prevSnapshot = null) {
    requestQueue.push({ originalMessage, prevSnapshot });
    processQueue(cdp);
}

// --- SLASH COMMANDS DEFINITION ---
const commands = [
    {
        name: 'help',
        description: 'Show command help',
    },
    {
        name: 'screenshot',
        description: 'Capture screenshot from Antigravity',
    },
    {
        name: 'stop',
        description: 'Stop generation',
    },
    {
        name: 'newchat',
        description: 'Start a new chat',
        options: [
            {
                name: 'prompt',
                description: 'Prompt to send after creating a new chat',
                type: 3,
                required: false,
            }
        ]
    },
    {
        name: 'title',
        description: 'Show current chat title',
    },
    {
        name: 'status',
        description: 'Show current model and mode',
    },
    {
        name: 'last_response',
        description: 'Extract latest response and save local raw dump',
    },
    {
        name: 'model',
        description: 'List models or switch model',
        options: [
            {
                name: 'number',
                description: 'Model number to switch',
                type: 4,
                required: false,
            }
        ]
    },
    {
        name: 'mode',
        description: 'Show or switch mode (planning/fast)',
        options: [
            {
                name: 'target',
                description: 'Target mode (planning or fast)',
                type: 3,
                required: false,
                choices: [
                    { name: 'Planning', value: 'planning' },
                    { name: 'Fast', value: 'fast' }
                ]
            }
        ]
    },
    {
        name: 'list_windows',
        description: 'List available Antigravity windows',
    },
    {
        name: 'select_window',
        description: 'Select active window by number',
        options: [
            {
                name: 'number',
                description: 'Window number',
                type: 4,
                required: true,
            }
        ]
    },

    {
        name: 'schedule',
        description: 'Manage scheduled tasks',
        options: [
            {
                name: 'list',
                description: 'List all scheduled tasks',
                type: 1,
            },
            {
                name: 'add',
                description: 'Add a new scheduled task',
                type: 1,
                options: [
                    { name: 'name', description: 'Name of the task', type: 3, required: true },
                    { name: 'time', description: 'Time (HH:MM)', type: 3, required: true },
                    { name: 'prompt', description: 'Prompt to send', type: 3, required: true }
                ]
            },
            {
                name: 'remove',
                description: 'Remove a scheduled task',
                type: 1,
                options: [
                    { name: 'name', description: 'Name of the task to remove', type: 3, required: true }
                ]
            }
        ]
    }
];

// --- DISCORD EVENTS ---
client.on('error', error => {
    console.error('Discord client error:', error);
});

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    setupFileWatcher();

    const startupCdp = await ensureCDP();
    if (startupCdp) console.log('Auto-connected to Antigravity on startup.');
    else console.log('Could not auto-connect to Antigravity on startup.');

    setupExternalScheduler();

    try {
        console.log('Started refreshing application (/) commands.');
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Failed to reload application commands:', error);
    }


});
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (!isAuthorizedDiscordUser(interaction.user)) {
        logInteraction('SECURITY', `Unauthorized access attempt from UserID: ${interaction.user.id} (${interaction.user.username})`);
        if (!interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({ content: 'Unauthorized.', flags: MessageFlags.Ephemeral });
            } catch (e) {
                if (e?.code !== 10062) {
                    console.error('Failed to send unauthorized reply:', e);
                }
            }
        }
        return;
    }

    try {
        lastActiveChannel = interaction.channel;
        const { commandName } = interaction;

        if (commandName === 'help') {
            await interaction.reply(
                '**Antigravity Bot Commands**\n\n' +
                '`/screenshot` Capture screenshot\n' +
                '`/stop` Stop generation\n' +
                '`/newchat` Start a new chat\n' +
                '`/newchat prompt:<text>` Start a new chat and send prompt\n' +
                '`/title` Show current chat title\n' +
                '`/status` Show model and mode\n' +
                '`/last_response` Extract latest response and save local raw dump\n' +
                '`/model` List models\n' +
                '`/model number:<n>` Switch model\n' +
                '`/mode` Show mode\n' +
                '`/mode target:<planning|fast>` Switch mode\n' +
                '`/list_windows` List available windows\n' +
                '`/select_window number:<n>` Select active window\n' +
                '`/schedule list` List scheduled tasks\n' +
                '`/schedule add name:<n> time:<HH:MM> prompt:<p>` Add task\n' +
                '`/schedule remove name:<n>` Remove task'
            );
            return;
        }

        await interaction.deferReply();

        if (commandName === 'list_windows') {
            const targets = await listAllCDPTargets();
            if (targets.length === 0) {
                await interaction.editReply('No available windows found.');
                return;
            }

            const selected = explicitTargetUrl;
            const list = targets.map((t, i) => {
                const isSelected = selected === t.webSocketDebuggerUrl;
                return `${isSelected ? '>' : ' '} ${i + 1}. ${t.title} (port ${t.port})`;
            }).join('\n');

            await interaction.editReply(`Available windows:\n\n${list}\n\nUse /select_window number:<n> to select one.`);
            return;
        }

        if (commandName === 'select_window') {
            const num = interaction.options.getInteger('number');
            const targets = await listAllCDPTargets();

            if (num < 1 || num > targets.length) {
                await interaction.editReply(`Number must be between 1 and ${targets.length}.`);
                return;
            }

            const target = targets[num - 1];
            explicitTargetUrl = target.webSocketDebuggerUrl;

            if (cdpConnection) {
                cdpConnection.ws.close();
                cdpConnection = null;
            }

            const newCdp = await ensureCDP();
            if (newCdp) {
                await interaction.editReply(`Selected window: ${target.title}`);
                return;
            }
            await interaction.editReply(`Failed to connect to: ${target.title}`);
            return;
        }

        const cdp = await ensureCDP();
        if (!cdp) {
            await interaction.editReply('CDP not found. Is Antigravity running?');
            return;
        }

        if (commandName === 'screenshot') {
            const ss = await getScreenshot(cdp);
            if (ss) {
                await interaction.editReply({ files: [new AttachmentBuilder(ss, { name: 'ss.png' })] });
            } else {
                await interaction.editReply('Failed to capture screenshot.');
            }
            return;
        }

        if (commandName === 'stop') {
            const stopped = await stopGeneration(cdp);
            if (stopped) {
                isGenerating = false;
                await interaction.editReply('Generation stopped.');
            } else {
                await interaction.editReply('No active generation.');
            }
            return;
        }

        if (commandName === 'newchat') {
            const prompt = interaction.options.getString('prompt');
            const result = await startNewChat(cdp);
            if (!result.success) {
                const reason = result.reason || 'unknown';
                await interaction.editReply(`New chat did not complete. reason=${reason} (see discord_interaction.log)`);
                return;
            }

            isGenerating = false;
            await new Promise(r => setTimeout(r, 3000));

            if (prompt && prompt.trim()) {
                const promptText = prompt.trim();
                logInteraction('NEWCHAT', `Prompt provided (${promptText.length} chars). Sending after new chat.`);
                let injected = await injectMessage(cdp, promptText);
                let started = injected.ok ? await waitForGenerationStart(cdp, 9000) : false;

                if (!started) {
                    logInteraction('NEWCHAT', 'No generation detected after first send. Retrying once...');
                    await new Promise(r => setTimeout(r, 1000));
                    injected = await injectMessage(cdp, promptText);
                    started = injected.ok ? await waitForGenerationStart(cdp, 9000) : false;
                }

                if (injected.ok && started) {
                    await interaction.editReply(`New chat started and prompt was sent (${injected.method}).`);
                    logInteraction('ACTION', 'Start monitor for /newchat prompt flow.');
                    void monitorAIResponse(createInteractionReplyBridge(interaction, promptText), cdp);
                } else if (injected.ok && !started) {
                    logInteraction('ERROR', 'Prompt was injected, but generation did not start.');
                    await interaction.editReply('Prompt was injected, but generation did not start. Check the Antigravity input box and press Enter once.');
                } else {
                    logInteraction('ERROR', `Prompt send failed after new chat: ${injected.error || 'unknown'}`);
                    await interaction.editReply(`New chat started, but prompt send failed: ${injected.error || 'unknown'}`);
                }
            } else {
                logInteraction('NEWCHAT', 'No prompt provided. New chat only.');
                await interaction.editReply('New chat request completed.');
            }
            return;
        }

        if (commandName === 'title') {
            const title = await getCurrentTitle(cdp);
            await interaction.editReply(`Current chat title: ${title || 'unknown'}`);
            return;
        }

        if (commandName === 'status') {
            const model = await getCurrentModel(cdp);
            const mode = await getCurrentMode(cdp);
            await interaction.editReply(`Model: ${model || 'unknown'}\nMode: ${mode || 'unknown'}`);
            return;
        }

        if (commandName === 'last_response') {
            await interaction.editReply('Extracting latest response from current Antigravity chat...');
            let response = null;
            try {
                response = await getLastResponse(cdp);
            } catch (e) {
                logInteraction('ERROR', `last_response extraction failed: ${e?.message || String(e)}`);
            }

            if (!response?.text) {
                await interaction.editReply('No response could be extracted from the current chat history.');
                return;
            }
            if (isLowConfidenceResponse(response)) {
                await interaction.editReply('Extraction failed: detected IDE chrome content instead of chat history. Check active Antigravity window.');
                return;
            }

            let sent = false;
            try {
                sent = await sendResponseEmbeds(createInteractionReplyBridge(interaction, ''), response, '');
            } catch (e) {
                logInteraction('ERROR', `last_response sendResponseEmbeds failed: ${e?.message || String(e)}`);
            }

            if (sent) {
                await interaction.editReply('Latest response extracted and saved locally.');
            } else {
                await interaction.editReply('Response extraction succeeded, but local dump handling failed.');
            }
            return;
        }

        if (commandName === 'model') {
            const num = interaction.options.getInteger('number');

            if (num === null) {
                const current = await getCurrentModel(cdp);
                const models = await getModelList(cdp);
                if (models.length === 0) {
                    await interaction.editReply('Could not read model list.');
                    return;
                }
                const list = models.map((m, i) => `${m === current ? '>' : ' '} ${i + 1}. ${m}`).join('\n');
                await interaction.editReply(`Current model: ${current || 'unknown'}\n\n${list}\n\nUse /model number:<n> to switch.`);
                return;
            }

            if (num < 1) {
                await interaction.editReply('Number must be >= 1.');
                return;
            }
            const models = await getModelList(cdp);
            if (num > models.length) {
                await interaction.editReply(`Number must be between 1 and ${models.length}.`);
                return;
            }
            const result = await switchModel(cdp, models[num - 1]);
            if (result.success) {
                await interaction.editReply(`Switched model to ${result.model}.`);
            } else {
                await interaction.editReply(`Failed to switch model: ${result.reason}`);
            }
            return;
        }

        if (commandName === 'mode') {
            const target = interaction.options.getString('target');

            if (!target) {
                const mode = await getCurrentMode(cdp);
                await interaction.editReply(`Current mode: ${mode || 'unknown'}\n\nUse /mode target:<planning|fast> to switch.`);
                return;
            }

            const result = await switchMode(cdp, target);
            if (result.success) {
                await interaction.editReply(`Switched mode to ${result.mode}.`);
            } else {
                await interaction.editReply(`Failed to switch mode: ${result.reason}`);
            }
            return;
        }



        if (commandName === 'schedule') {
            const sub = interaction.options.getSubcommand();
            const schedulesPath = path.join(WORKSPACE_ROOT || path.join(process.cwd(), 'workspace'), 'schedules.json');

            if (sub === 'list') {
                if (!fs.existsSync(schedulesPath)) {
                    await interaction.editReply('No schedules found.');
                    return;
                }
                const schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
                if (schedules.length === 0) {
                    await interaction.editReply('No schedules registered.');
                    return;
                }
                const list = schedules.map(s => `- **${s.name}**: ${s.time} [${s.enabled !== false ? '✅' : '❌'}]\n  Prompt: \`${s.prompt}\``).join('\n');
                await interaction.editReply(`### Scheduled Tasks\n\n${list}`);
                return;
            }

            if (sub === 'add') {
                const name = interaction.options.getString('name');
                const time = interaction.options.getString('time');
                const prompt = interaction.options.getString('prompt');

                if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
                    await interaction.editReply('Invalid time format. Use HH:MM (e.g. 06:00).');
                    return;
                }

                let schedules = [];
                if (fs.existsSync(schedulesPath)) {
                    schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
                }

                if (schedules.find(s => s.name === name)) {
                    await interaction.editReply(`Task with name "${name}" already exists.`);
                    return;
                }

                schedules.push({ name, time, prompt, enabled: true });
                fs.writeFileSync(schedulesPath, JSON.stringify(schedules, null, 2), 'utf8');
                await interaction.editReply(`Added task: **${name}** at ${time}`);
                return;
            }

            if (sub === 'remove') {
                const name = interaction.options.getString('name');
                if (!fs.existsSync(schedulesPath)) {
                    await interaction.editReply('No schedules found.');
                    return;
                }
                let schedules = JSON.parse(fs.readFileSync(schedulesPath, 'utf8'));
                const originalCount = schedules.length;
                schedules = schedules.filter(s => s.name !== name);

                if (schedules.length === originalCount) {
                    await interaction.editReply(`Task "${name}" not found.`);
                    return;
                }

                fs.writeFileSync(schedulesPath, JSON.stringify(schedules, null, 2), 'utf8');
                await interaction.editReply(`Removed task: **${name}**`);
                return;
            }
        }
    } catch (error) {
        console.error('Interaction Error:', error);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: `Error: ${error.message}` });
            } else {
                await interaction.reply({ content: `Error: ${error.message}`, flags: MessageFlags.Ephemeral });
            }
        } catch (innerError) {
            console.error('Failed to send error reply:', innerError);
        }
    }
});
client.on('messageCreate', async message => {
    if (!isAuthorizedDiscordUser(message.author)) return;
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

    // Capture snapshot BEFORE injecting the new message
    let prevSnapshot = null;
    try {
        const snap = await getLastResponse(cdp);
        if (snap?.text) prevSnapshot = snap.text.substring(0, 500); // Use longer snapshot for safety
    } catch (e) {
        console.error('[Snap] Failed to capture pre-inject snapshot:', e.message);
    }

    const res = await injectMessage(cdp, messageText);
    if (res.ok) {
        await message.react('✅').catch(() => { });
        logInteraction('SUCCESS', `Message ${message.id} injected successfully.`);
        monitorAIResponse(message, cdp, prevSnapshot);
    } else {
        await message.react('❌').catch(() => { });
        if (res.error) await message.reply(`Error: ${res.error}`).catch(() => { });
    }
});

let lastScheduledTaskExecution = {}; // taskName -> dateKey
function setupExternalScheduler() {
    const schedulesPath = path.join(WORKSPACE_ROOT || path.join(process.cwd(), 'workspace'), 'schedules.json');
    console.log(`--- EXTERNAL SCHEDULER INITIALIZED (Path: ${schedulesPath}) ---`);

    setInterval(async () => {
        try {
            if (!fs.existsSync(schedulesPath)) return;
            const content = fs.readFileSync(schedulesPath, 'utf8');
            const schedules = JSON.parse(content);
            const now = new Date();
            const hour = now.getHours();
            const minute = now.getMinutes();
            const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            const dateKey = now.toDateString();

            for (const task of schedules) {
                if (task.enabled === false) continue;
                if (task.time === timeStr && lastScheduledTaskExecution[task.name] !== dateKey) {
                    lastScheduledTaskExecution[task.name] = dateKey;
                    await triggerScheduledTask(task.prompt, `SCHEDULED:${task.name}`);
                }
            }
        } catch (e) {
            console.error('Scheduler error:', e.message);
        }
    }, 60000); // Check every minute
}

async function triggerScheduledTask(prompt, source = 'UNKNOWN') {
    const targetChannel = lastActiveChannel || (TEST_CHANNEL_ID ? client.channels.cache.get(TEST_CHANNEL_ID) : null);

    if (!targetChannel) {
        logInteraction('WARN', `[${source}] Task triggered but no target channel found.`);
        return;
    }

    const cdp = await ensureCDP();
    if (!cdp) {
        logInteraction('ERROR', `[${source}] Task failed: CDP not connected.`);
        return;
    }

    logInteraction('ACTION', `[${source}] Triggering task: ${prompt.substring(0, 50)}...`);

    // Create a bridge message for monitorAIResponse
    const dummyMessage = {
        author: { id: ALLOWED_DISCORD_USER },
        id: `sched-task-${Date.now()}`,
        content: prompt,
        channel: targetChannel,
        react: async (emoji) => logInteraction('DEBUG', `[Task] Reacted with ${emoji}`),
        reply: async (payload) => {
            if (typeof payload === 'string') return targetChannel.send({ content: payload });
            return targetChannel.send(payload);
        }
    };

    const res = await injectMessage(cdp, prompt);
    if (res.ok) {
        monitorAIResponse(dummyMessage, cdp);
    } else {
        logInteraction('ERROR', `[${source}] Failed to inject task query: ${res.error || 'unknown'}`);
    }
}

// Main Execution
(async () => {
    try {
        if (!ALLOWED_DISCORD_USER) {
            throw new Error('DISCORD_ALLOWED_USER_ID is missing in .env');
        }
        if (!ALLOWED_DISCORD_USER_IS_ID) {
            console.warn('[CONFIG] DISCORD_ALLOWED_USER_ID is not numeric. Username fallback is active; Discord user ID is recommended.');
        }
        await ensureWatchDir();
        console.log(`📂 Watching directory: ${WORKSPACE_ROOT}`);

        // Standard Discord login
        client.login(process.env.DISCORD_BOT_TOKEN).catch(e => {
            console.error('Failed to login:', e);
            process.exit(1);
        });

    } catch (e) {
        console.error('Fatal Error:', e);
        process.exit(1);
    }
})();

