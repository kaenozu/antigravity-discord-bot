import fs from 'fs';

function cleanFile() {
    const content = fs.readFileSync('discord_bot.js', 'utf8');
    const lines = content.split('\n');
    const cleanedLines = [];

    let inGarbage = false;
    for (const line of lines) {
        // Simple heuristic: if a line has many sequential CJK/garbage chars and is very long, it might be the start of a garbage block
        const nonAsciiCount = (line.match(/[^\x00-\x7F]/g) || []).length;
        const ratio = nonAsciiCount / line.length;

        if (line.length > 500 && ratio > 0.5) {
            if (!inGarbage) console.log("Entering garbage block at line " + (cleanedLines.length + 1));
            inGarbage = true;
            continue;
        }

        if (inGarbage && line.trim() === '') {
            // Empty line might signal end of garbage if followed by normal code
            continue;
        }

        if (inGarbage && (line.includes('function') || line.includes('const') || line.includes('await'))) {
            console.log("Exiting garbage block at line " + (cleanedLines.length + 1));
            inGarbage = false;
        }

        if (!inGarbage) {
            cleanedLines.push(line);
        }
    }

    fs.writeFileSync('discord_bot_cleaned.js', cleanedLines.join('\n'));
    console.log("Original lines: " + lines.length + ", Cleaned lines: " + cleanedLines.length);
}

cleanFile();
