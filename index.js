
import 'dotenv/config';

import {
    Client,
    GatewayIntentBits,
    Events,
    ChannelType
} from 'discord.js';

import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    NoSubscriberBehavior,
    StreamType,
    entersState
} from '@discordjs/voice';

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import fs from 'node:fs/promises';
import path from 'node:path';

// Environment
const {
    DISCORD_TOKEN,
    ELEVENLABS_API_KEY
} = process.env;

// ElevenLabs settings
const MODEL_ID = 'eleven_multilingual_v2';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

const SETTINGS_FILE = path.resolve('./voice-settings.json');

if (!DISCORD_TOKEN || !ELEVENLABS_API_KEY) {
    console.error('Missing Discord or ElevenLabs API key!');
    process.exit(1);
}

if (!ffmpegPath) {
    console.error('FFmpeg not found!');
    process.exit(1);
}

// Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Data
const sessions = new Map();
const guildVoices = new Map();
const guildNicknames = new Map();

let availableVoices = [];

// Settings helpers
function getNicknameKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function getTTSName(member, guildId = member?.guild?.id) {
    if (!member || !guildId) return 'Someone';

    const customName = guildNicknames.get(
        getNicknameKey(guildId, member.id)
    );

    return customName ||
        member.displayName ||
        member.user.globalName ||
        member.user.username;
}

// Load settings
async function loadSettings() {
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf8');
        const saved = JSON.parse(data);

        if (saved.guildVoices || saved.guildNicknames) {
            for (const [id, voice] of Object.entries(saved.guildVoices || {})) {
                guildVoices.set(id, voice);
            }

            for (const [id, name] of Object.entries(saved.guildNicknames || {})) {
                guildNicknames.set(id, name);
            }
        } else {
            // Old settings compatibility
            for (const [id, voice] of Object.entries(saved || {})) {
                if (typeof voice === 'string') {
                    guildVoices.set(id, voice);
                }
            }
        }

        console.log('Voice and nickname settings loaded.');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Settings error:', error.message);
        }
    }
}

// Save settings
async function saveSettings() {
    const data = {
        guildVoices: Object.fromEntries(guildVoices),
        guildNicknames: Object.fromEntries(guildNicknames)
    };

    await fs.writeFile(
        SETTINGS_FILE,
        JSON.stringify(data, null, 2),
        'utf8'
    );
}

// ElevenLabs API request helper
async function elevenLabsRequest(endpoint, options = {}) {
    const response = await fetch(
        `https://api.elevenlabs.io/v1${endpoint}`,
        {
            ...options,
            headers: {
                'xi-api-key': ELEVENLABS_API_KEY,
                ...options.headers
            }
        }
    );

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `ElevenLabs API ${response.status}: ${errorText.slice(0, 500)}`
        );
    }

    return response;
}

// Load ElevenLabs voices
async function loadVoices() {
    console.log('Loading ElevenLabs voices...');

    try {
        const response = await elevenLabsRequest('/voices');
        const data = await response.json();

        availableVoices = (data.voices || []).map(voice => ({
            id: voice.voice_id,
            name: voice.name,
            gender: voice.labels?.gender || 'unknown'
        }));

        console.log(`Loaded ${availableVoices.length} ElevenLabs voices.`);
    } catch (error) {
        console.error('Voice loading error:', error.message);
    }
}

// Get selected voice
function getGuildVoice(guildId) {
    const savedId = guildVoices.get(guildId);

    if (savedId) {
        const voice = availableVoices.find(v => v.id === savedId);
        if (voice) return voice;
    }

    return availableVoices.find(v => v.id === DEFAULT_VOICE_ID)
        || availableVoices[0];
}

// Generate speech with ElevenLabs
async function generateSpeech(text, voiceId) {
    const response = await elevenLabsRequest(
        `/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text,
                model_id: MODEL_ID,
                language_code: 'hi',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.2,
                    use_speaker_boost: true
                }
            })
        }
    );

    return Buffer.from(await response.arrayBuffer());
}

// Play audio
async function playAudio(session, audioBuffer) {
    const ffmpeg = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ]);

    session.ffmpeg = ffmpeg;

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw
    });

    ffmpeg.on('error', error => {
        console.error('FFmpeg error:', error);
    });

    session.player.play(resource);
    ffmpeg.stdin.end(audioBuffer);

    try {
        await entersState(
            session.player,
            AudioPlayerStatus.Playing,
            15000
        );

        await entersState(
            session.player,
            AudioPlayerStatus.Idle,
            120000
        );
    } finally {
        if (session.ffmpeg === ffmpeg) {
            session.ffmpeg = null;
        }

        if (!ffmpeg.killed) {
            ffmpeg.kill();
        }
    }
}

// Speech queue
async function processQueue(session) {
    if (session.processing) return;

    session.processing = true;

    try {
        while (
            session.queue.length > 0 &&
            session.connection.state.status !== VoiceConnectionStatus.Destroyed
        ) {
            const text = session.queue.shift();

            try {
                const voice = getGuildVoice(session.guildId);

                if (!voice) {
                    console.error('No available ElevenLabs voice.');
                    continue;
                }

                console.log(`Speaking with ${voice.name}:`, text);

                const audio = await generateSpeech(text, voice.id);

                if (
                    session.connection.state.status === VoiceConnectionStatus.Destroyed
                ) {
                    break;
                }

                await playAudio(session, audio);

            } catch (error) {
                console.error('Speech error:', error.message);
            }
        }
    } finally {
        session.processing = false;

        if (
            session.queue.length > 0 &&
            session.connection.state.status !== VoiceConnectionStatus.Destroyed
        ) {
            processQueue(session);
        }
    }
}

// Add speech to queue
function enqueueSpeech(session, text) {
    if (!text || !text.trim()) return;

    session.queue.push(text.trim());
    processQueue(session);
}

// Stop speech
function stopSpeech(session) {
    session.queue = [];

    if (session.ffmpeg && !session.ffmpeg.killed) {
        session.ffmpeg.kill();
        session.ffmpeg = null;
    }

    session.player.stop(true);
}

// Create voice session
function createSession(guild, voiceChannel) {
    const oldSession = sessions.get(guild.id);

    if (oldSession) {
        stopSpeech(oldSession);
        oldSession.connection.destroy();
    }

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false
    });

    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause
        }
    });

    connection.subscribe(player);

    const session = {
        guildId: guild.id,
        connection,
        player,
        queue: [],
        processing: false,
        ffmpeg: null
    };

    sessions.set(guild.id, session);

    connection.on('error', error => {
        console.error('Voice connection error:', error);
    });

    player.on('error', error => {
        console.error('Audio player error:', error);
    });

    return session;
}

// Bot ready
client.once(Events.ClientReady, async readyClient => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('       VOICEX BOT ONLINE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    console.log(`Bot: ${readyClient.user.tag}`);

    await loadSettings();
    await loadVoices();

    console.log(`Available voices: ${availableVoices.length}`);
    console.log('TTS Provider: ElevenLabs');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// Interactions
client.on(Events.InteractionCreate, async interaction => {

    // Voice autocomplete
    if (interaction.isAutocomplete()) {
        if (interaction.commandName !== 'setvoice') return;

        const focused = interaction.options.getFocused().toLowerCase();

        const results = availableVoices
            .filter(voice =>
                voice.name.toLowerCase().includes(focused) ||
                voice.gender.toLowerCase().includes(focused)
            )
            .slice(0, 25)
            .map(voice => ({
                name: `${voice.name} (${voice.gender})`.slice(0, 100),
                value: voice.id
            }));

        return interaction.respond(results).catch(() => {});
    }

    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    const guildId = interaction.guild.id;

    try {
        await interaction.deferReply();

        // SET NICKNAME
        if (interaction.commandName === 'setnick') {
            const requestedName = interaction.options
        
                .getString('name', true)
                .trim();

            const key = getNicknameKey(guildId, interaction.user.id);

            if (requestedName.toLowerCase() === 'reset') {
                guildNicknames.delete(key);
                await saveSettings();

                const member = await interaction.guild.members.fetch(
                    interaction.user.id
                );

                return interaction.editReply(
                    `✅ Custom TTS name reset. VoiceX will now say **${member.displayName}**.`
                );
            }

            if (!requestedName || requestedName.length > 32) {
                return interaction.editReply(
                    '❌ Name must be between 1 and 32 characters.'
                );
            }

            guildNicknames.set(key, requestedName);
            await saveSettings();

            return interaction.editReply(
                `✅ Your TTS name is now **${requestedName}**!`
            );
        }

        // ABOUT
        if (interaction.commandName === 'about') {
            const member = await interaction.guild.members.fetch(
                interaction.user.id
            );

            return interaction.editReply({
                content: [
                    '**🎧 VoiceX — Discord TTS Bot**',
                    'Converts messages into voice audio in your server.',
                    '',
                    `**Your TTS name:** ${getTTSName(member, guildId)}`,
                    '**Name priority:** Custom TTS name → Server nickname → Discord username',
                    '',
                    '**TTS Provider:** ElevenLabs',
                    '**Made by Raxxy Developer**'
                ].join('\n')
            });
        }

        // JOIN
        if (interaction.commandName === 'join') {
            const member = await interaction.guild.members.fetch(
                interaction.user.id
            );

            const voiceChannel = member.voice.channel;

            if (!voiceChannel) {
                return interaction.editReply(
                    '❌ Pehle voice channel join karo!'
                );
            }

            const session = createSession(
                interaction.guild,
                voiceChannel
            );

            await entersState(
                session.connection,
                VoiceConnectionStatus.Ready,
                20000
            );

            return interaction.editReply(
                `✅ VoiceX joined **${voiceChannel.name}**!`
            );
        }

        // LEAVE
        if (interaction.commandName === 'leave') {
            const session = sessions.get(guildId);

            if (!session) {
                return interaction.editReply(
                    '❌ VoiceX is not in a voice channel!'
                );
            }

            stopSpeech(session);
            session.connection.destroy();
            sessions.delete(guildId);

            return interaction.editReply(
                '👋 VoiceX left the voice channel.'
            );
        }

        // TTS
        if (interaction.commandName === 'tts') {
            const session = sessions.get(guildId);

            if (!session) {
                return interaction.editReply(
                    '❌ Pehle /join use karo!'
                );
            }

            const text = interaction.options.getString('text', true);

            enqueueSpeech(session, text);

            const voice = getGuildVoice(guildId);

            return interaction.editReply(
                `🔊 Added to queue! Voice: **${voice?.name || 'Default'}**`
            );
        }

        // STOP
        if (interaction.commandName === 'stop') {
            const session = sessions.get(guildId);

            if (!session) {
                return interaction.editReply(
                    '❌ VoiceX is not in a voice channel!'
                );
            }

            stopSpeech(session);

            return interaction.editReply(
                '⏹️ Speech stopped and queue cleared!'
            );
        }

        // VOICES
        if (interaction.commandName === 'voices') {
            if (availableVoices.length === 0) {
                return interaction.editReply(
                    '❌ ElevenLabs voices load nahi hui. API key check karo.'
                );
            }

            const male = availableVoices
                .filter(v => v.gender.toLowerCase() === 'male')
                .map(v => `👨 ${v.name}`)
                .slice(0, 20);

            const female = availableVoices
                .filter(v => v.gender.toLowerCase() === 'female')
                .map(v => `👩 ${v.name}`)
                .slice(0, 20);

            const other = availableVoices
                .filter(v => !['male', 'female'].includes(v.gender.toLowerCase()))
                .map(v => `⚪ ${v.name}`)
                .slice(0, 10);

            const currentVoice = getGuildVoice(guildId);

            const description = [
                `**Currently selected:** ${currentVoice?.name || 'Default'}`,
                '',
                '**Male voices**',
                male.join('\n') || 'No male voices found.',
                '',
                '**Female voices**',
                female.join('\n') || 'No female voices found.',
                '',
                '**Other voices**',
                other.join('\n') || 'No other voices found.',
                '',
                'Use `/setvoice` to change your voice.'
            ].join('\n');

            return interaction.editReply({
                content: description.slice(0, 1900)
            });
        }

        // SET VOICE
        if (interaction.commandName === 'setvoice') {
            const voiceId = interaction.options.getString('voice', true);

            const selectedVoice = availableVoices.find(
                v => v.id === voiceId
            );

            if (!selectedVoice) {
                return interaction.editReply(
                    '❌ Voice nahi mili. `/voices` check karo.'
                );
            }

            guildVoices.set(guildId, selectedVoice.id);
            await saveSettings();

            return interaction.editReply(
                `✅ Voice changed to **${selectedVoice.name}** (${selectedVoice.gender})!`
            );
        }

    } catch (error) {
        console.error('Command error:', error);

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(
                `❌ Error: ${error.message}`
            ).catch(() => {});
        }
    }
});

// Automatic voice-channel text chat reading
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content.trim()) return;

    const session = sessions.get(message.guild.id);

    if (!session) return;

    if (message.channel.type !== ChannelType.GuildVoice) return;

    if (
        message.channel.id !==
        session.connection.joinConfig.channelId
    ) {
        return;
    }

    try {
        const member = message.member ||
            await message.guild.members.fetch(message.author.id);

        const displayName = getTTSName(member, message.guild.id);
        const text = `${displayName} says: ${message.content}`;

        enqueueSpeech(session, text.slice(0, 500));
    } catch (error) {
        console.error('Display name error:', error.message);

        const fallback = message.author.globalName ||
            message.author.username;

        enqueueSpeech(
            session,
            `${fallback} says: ${message.content}`.slice(0, 500)
        );
    }
});

// Discord errors
client.on(Events.Error, error => {
    console.error('Discord client error:', error);
});

// Login
client.login(DISCORD_TOKEN).catch(error => {
    console.error('Discord login failed:', error.message);
    process.exit(1);
});

