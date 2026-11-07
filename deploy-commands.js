import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
    console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env');
    process.exit(1);
}

const commands = [
    new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join your current voice channel'),

    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Leave the voice channel'),

    new SlashCommandBuilder()
        .setName('tts')
        .setDescription('Speak text using TTS')
        .addStringOption(option =>
            option.setName('text')
                .setDescription('Text to speak')
                .setRequired(true)
                .setMaxLength(500)
        ),

    new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop speech and clear the queue'),

    new SlashCommandBuilder()
        .setName('voices')
        .setDescription('List available Cartesia voices'),

    new SlashCommandBuilder()
        .setName('setvoice')
        .setDescription('Choose a Cartesia voice')
        .addStringOption(option =>
            option.setName('voice')
                .setDescription('Search and select a voice')
                .setRequired(true)
                .setAutocomplete(true)
        ),

    new SlashCommandBuilder()
        .setName('setnick')
        .setDescription('Set your custom TTS display name; use reset to clear')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Your TTS name (or reset)')
                .setRequired(true)
                .setMaxLength(32)
        ),

    new SlashCommandBuilder()
        .setName('setlang')
        .setDescription('Set this server TTS language')
        .addStringOption(option =>
            option.setName('language')
                .setDescription('Choose language')
                .setRequired(true)
                .addChoices(
                    { name: 'Hindi', value: 'hindi' },
                    { name: 'Marathi', value: 'marathi' },
                    { name: 'English', value: 'english' }
                )
        ),

    new SlashCommandBuilder()
        .setName('about')
        .setDescription('Show VoiceX information and your TTS settings')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
    console.log('Registering VoiceX commands...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`All ${commands.length} VoiceX commands registered globally!`);
} catch (error) {
    console.error('Command registration failed:', error);
    process.exit(1);
}
