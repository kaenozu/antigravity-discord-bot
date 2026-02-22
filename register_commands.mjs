import { REST, Routes } from 'discord.js';
import 'dotenv/config';

const commands = [
    { name: 'help', description: 'Show command help' },
    { name: 'screenshot', description: 'Capture screenshot' },
    { name: 'auto_approve', description: 'Toggle auto-approval' },
    { name: 'status', description: 'Show status' }
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
    try {
        console.log('Registering global commands...');
        const user = await rest.get(Routes.user());
        console.log(`Bot ID: ${user.id}`);
        await rest.put(Routes.applicationCommands(user.id), { body: commands });
        console.log('Global commands registered.');

        // Also register guild commands for any guild we can find
        // (Wait, we need to know the guild IDs from the bot)
    } catch (e) {
        console.error(e);
    }
})();
