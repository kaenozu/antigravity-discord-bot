import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';

async function runTest() {
    console.log("=== Testing File Watcher ===");

    // Create a dummy watch directory
    const watchDir = path.join(process.cwd(), 'tests', 'dummy_watch_dir');
    if (!fs.existsSync(watchDir)) {
        fs.mkdirSync(watchDir, { recursive: true });
    }

    console.log(`[INFO] Setting up watcher for: ${watchDir}`);

    const watcher = chokidar.watch(watchDir, {
        ignored: [/node_modules/, /\.git/, /discord_interaction\.log$/],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: true
    });

    let detectedFile = false;
    let detectedDelete = false;

    watcher.on('all', (event, filePath) => {
        console.log(`[EVENT] ${event} on ${path.basename(filePath)}`);
        if (event === 'add') {
            detectedFile = true;
            console.log(`[SUCCESS] Detected file addition: ${path.basename(filePath)}`);
            // Trigger deletion
            fs.unlinkSync(filePath);
        } else if (event === 'unlink') {
            detectedDelete = true;
            console.log(`[SUCCESS] Detected file deletion: ${path.basename(filePath)}`);
        }
    });

    // Wait a brief moment for watcher to initialize
    await new Promise(r => setTimeout(r, 1000));

    const testFile = path.join(watchDir, 'test_file.txt');
    console.log(`[INFO] Writing test file: ${testFile}`);
    fs.writeFileSync(testFile, 'hello watcher!\n');

    // Wait for events to trigger
    await new Promise(r => setTimeout(r, 3000));

    if (detectedFile && detectedDelete) {
        console.log(`[SUCCESS] File Watcher events logged successfully!`);
    } else {
        console.error(`[FAILED] File Watcher failed to detect addition or deletion.`);
    }

    // Clean up
    watcher.close();
    fs.rmdirSync(watchDir);

    console.log("Test finished.");
    process.exit(0);
}

runTest();
