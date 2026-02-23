import { REST, Routes } from 'discord.js';
import 'dotenv/config';

const commands = [
    { name: 'help', description: 'Show command help' },
    { name: 'screenshot', description: 'Capture screenshot from Antigravity' },
    { name: 'stop', description: 'Stop generation' },
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
    { name: 'title', description: 'Show current chat title' },
    { name: 'status', description: 'Show current model and mode' },
    { name: 'last_response', description: 'Extract latest response and save local raw dump' },
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
    { name: 'list_windows', description: 'List available Antigravity windows' },
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
            { name: 'list', description: 'List all scheduled tasks', type: 1 },
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

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
    try {
        console.log('Registering global commands...');
        const user = await rest.get(Routes.user());
        console.log(`Bot ID: ${user.id}`);
        await rest.put(Routes.applicationCommands(user.id), { body: commands });
        console.log('Global commands registered.');
    } catch (e) {
        console.error(e);
    }
})();

