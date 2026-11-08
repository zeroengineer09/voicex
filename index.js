
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

// ==================== CONFIG ====================

const { DISCORD_TOKEN, ELEVENLABS_API_KEY } = process.env;

const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_LANGUAGE = 'hi';

const DEFAULT_VOICE_ID =
    process.env.ELEVENLABS_DEFAULT_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';

const SETTINGS_FILE = path.resolve('./voice-settings.json');

const SUPPORTED_LANGUAGES = {
    hindi: { code: 'hi', label: 'Hindi' },
    marathi: { code: 'mr', label: 'Marathi' },
    english: { code: 'en', label: 'English' }
};

if (!DISCORD_TOKEN || !ELEVENLABS_API_KEY) {
    console.error('Missing DISCORD_TOKEN or ELEVENLABS_API_KEY!');
    process.exit(1);
}

if (!ffmpegPath) {
    console.error('FFmpeg not found!');
    process.exit(1);
}

// ==================== DISCORD CLIENT ====================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==================== DATA ====================

const sessions = new Map();
const guildVoices = new Map();
const guildNicknames = new Map();
const guildLanguages = new Map();

// Prevent the same interaction from being processed twice
const processedInteractions = new Set();

let availableVoices = [];

// ==================== HELPERS ====================

function getNicknameKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function getGuildLanguage(guildId) {
    return guildLanguages.get(guildId) || DEFAULT_LANGUAGE;
}

function getLanguageLabel(code) {
    return Object.values(SUPPORTED_LANGUAGES)
        .find(item => item.code === code)?.label || 'Hindi';
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

// Safely acknowledge an interaction exactly once
async function safeDeferReply(interaction) {
    if (!interaction.isRepliable()) {
        return false;
    }

    if (interaction.deferred || interaction.replied) {
        return false;
    }

    await interaction.deferReply();
    return true;
}

async function safeEditReply(interaction, content) {
    if (!interaction.isRepliable()) return;

    if (interaction.deferred || interaction.replied) {
        return interaction.editReply(content).catch(error => {
            console.error('Edit reply error:', error.message);
        });
    }

    return interaction.reply({
        content: typeof content === 'string'
            ? content
            : content.content,
        ephemeral: true
    }).catch(error => {
        console.error('Reply error:', error.message);
    });
}

// ==================== SETTINGS ====================

async function loadSettings() {
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf8');
        const saved = JSON.parse(data);

        if (
            saved.guildVoices ||
            saved.guildNicknames ||
            saved.guildLanguages
        ) {
            for (const [id, voice] of Object.entries(saved.guildVoices || {})) {
                guildVoices.set(id, voice);
            }

            for (const [id, name] of Object.entries(saved.guildNicknames || {})) {
                guildNicknames.set(id, name);
            }

            for (const [id, language] of Object.entries(saved.guildLanguages || {})) {
                if (
                    Object.values(SUPPORTED_LANGUAGES)
                        .some(item => item.code === language)
                ) {
                    guildLanguages.set(id, language);
                }
            }
        } else {
            // Old settings compatibility
            for (const [id, voice] of Object.entries(saved || {})) {
                if (typeof voice === 'string') {
                    guildVoices.set(id, voice);
                }
            }
        }

        console.log('Voice, nickname and language settings loaded.');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Settings loading error:', error.message);
        }
    }
}

async function saveSettings() {
    const data = {
        guildVoices: Object.fromEntries(guildVoices),
        guildNicknames: Object.fromEntries(guildNicknames),
        guildLanguages: Object.fromEntries(guildLanguages)
    };

    await fs.writeFile(
        SETTINGS_FILE,
        JSON.stringify(data, null, 2),
        'utf8'
    );
}

// ==================== ELEVENLABS VOICES ====================

async function loadVoices() {
    console.log('Loading ElevenLabs voices...');

    try {
        const voices = [];
        let nextPageToken = null;

        do {
            const url = new URL('https://api.elevenlabs.io/v2/voices');

            url.searchParams.set('page_size', '100');
            url.searchParams.set('include_total_count', 'false');

            if (nextPageToken) {
                url.searchParams.set('next_page_token', nextPageToken);
            }

            const response = await fetch(url, {
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY
                }
            });

            if (!response.ok) {
                const detail = await response.text();
                throw new Error(
                    `ElevenLabs voices API ${response.status}: ${detail.slice(0, 500)}`
                );
            }

            const data = await response.json();

            for (const voice of data.voices || []) {
                if (voice.voice_id && voice.name) {
                    voices.push({
                        id: voice.voice_id,
                        name: voice.name,
                        gender: voice.labels?.gender || 'unknown'
                    });
                }
            }

            nextPageToken = data.has_more
                ? data.next_page_token
                : null;

        } while (nextPageToken);

        availableVoices = voices;

        console.log(`Loaded ${availableVoices.length} ElevenLabs voices.`);
    } catch (error) {
        console.error('Voice loading error:', error.message);
        availableVoices = [];
    }
}

function getGuildVoice(guildId) {
    const savedId = guildVoices.get(guildId);

    if (savedId) {
        const voice = availableVoices.find(v => v.id === savedId);
        if (voice) return voice;
    }

    return availableVoices.find(v => v.id === DEFAULT_VOICE_ID)
        || availableVoices[0];
}

// ==================== ELEVENLABS TTS ====================

async function generateSpeech(text, voiceId, language) {
    const url = new URL(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`
    );

    url.searchParams.set('output_format', OUTPUT_FORMAT);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
        },
        body: JSON.stringify({
            text,
            model_id: MODEL_ID,
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
                style: 0,
                use_speaker_boost: true
            }
        })
    });

    if (!response.ok) {
        const detail = await response.text();

        throw new Error(
            `ElevenLabs TTS API ${response.status}: ${detail.slice(0, 700)}`
        );
    }

    return Buffer.from(await response.arrayBuffer());
}

// ==================== AUDIO PLAYER ====================

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
        console.error('FFmpeg error:', error.message);
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

// ==================== SPEECH QUEUE ====================

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

                const language = getGuildLanguage(session.guildId);

                console.log(
                    `Speaking with ElevenLabs voice ${voice.name}:`,
                    text
                );

                console.log(
                    `TTS language: ${getLanguageLabel(language)}`
                );

                const audio = await generateSpeech(
                    text,
                    voice.id,
                    language
                );

                if (
                    session.connection.state.status ===
                    VoiceConnectionStatus.Destroyed
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

function enqueueSpeech(session, text) {
    if (!text || !text.trim()) return;

    session.queue.push(text.trim());
    processQueue(session);
}

function stopSpeech(session) {
    session.queue = [];

    if (session.ffmpeg && !session.ffmpeg.killed) {
        session.ffmpeg.kill();
        session.ffmpeg = null;
    }

    session.player.stop(true);
}

// ==================== VOICE SESSION ====================

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
        console.error('Voice connection error:', error.message);
    });

    player.on('error', error => {
        console.error('Audio player error:', error.message);
    });

    return session;
}

// ==================== BOT READY ====================

client.once(Events.ClientReady, async readyClient => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('       VOICEX BOT ONLINE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    console.log(`Bot: ${readyClient.user.tag}`);

    await loadSettings();
    await loadVoices();

    console.log(`Available voices: ${availableVoices.length}`);
    console.log(`TTS Provider: ElevenLabs (${MODEL_ID})`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// ==================== INTERACTIONS ====================

client.on(Events.InteractionCreate, async interaction => {

    // Autocomplete
    if (interaction.isAutocomplete()) {
        if (interaction.commandName !== 'setvoice') return;

        const focused = interaction.options
            .getFocused()
            .toLowerCase();

        const results = availableVoices
            .filter(voice =>
                voice.name.toLowerCase().includes(focused) ||
                (voice.gender || 'unknown').toLowerCase().includes(focused)
            )
            .slice(0, 25)
            .map(voice => ({
                name: `${voice.name} (${voice.gender})`.slice(0, 100),
                value: voice.id
            }));

        if (!interaction.responded) {
            await interaction.respond(results).catch(() => {});
        }

        return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    // Ignore duplicate delivery in this process
    if (processedInteractions.has(interaction.id)) return;

    processedInteractions.add(interaction.id);

    // Keep a short-lived record to prevent duplicate handling
    setTimeout(() => {
        processedInteractions.delete(interaction.id);
    }, 15 * 60 * 1000).unref?.();

    const guildId = interaction.guild.id;

    try {
        // Acknowledge only if this interaction is not already acknowledged
        await safeDeferReply(interaction);

        // SET NICKNAME
        if (interaction.commandName === 'setnick') {
            const requestedName = interaction.options
                .getString('name', true)
                .trim();

            const key = getNicknameKey(
                guildId,
                interaction.user.id
            );

            if (requestedName.toLowerCase() === 'reset') {
                guildNicknames.delete(key);
                await saveSettings();

                const member = await interaction.guild.members.fetch(
                    interaction.user.id
                );

                return safeEditReply(
                    interaction,
                    `✅ Custom TTS name reset. VoiceX will now say **${member.displayName}**.`
                );
            }

            if (!requestedName || requestedName.length > 32) {
                return safeEditReply(
                    interaction,
                    '❌ Name must be between 1 and 32 characters.'
                );
            }

            guildNicknames.set(key, requestedName);
            await saveSettings();

            return safeEditReply(
                interaction,
                `✅ Your TTS name is now **${requestedName}**!`
            );
        }

        // SET LANGUAGE
        if (interaction.commandName === 'setlang') {
            const selectedLanguage = interaction.options
                .getString('language', true);

            const language = SUPPORTED_LANGUAGES[selectedLanguage];

            if (!language) {
                return safeEditReply(
                    interaction,
                    '❌ Unsupported language. Choose Hindi, Marathi, or English.'
                );
            }

            guildLanguages.set(guildId, language.code);
            await saveSettings();

            return safeEditReply(
                interaction,
                `✅ VoiceX language changed to **${language.label}** for this server!`
            );
        }

        // ABOUT
        if (interaction.commandName === 'about') {
            const member = await interaction.guild.members.fetch(
                interaction.user.id
            );

            return safeEditReply(interaction, {
                content: [
                    '**🎧 VoiceX — Discord TTS Bot**',
                    'Converts messages into voice audio in your server.',
                    '',
                    `**Your TTS name:** ${getTTSName(member, guildId)}`,
                    '**Name priority:** Custom TTS name → Server nickname → Discord username',
                    '',
                    `**Language:** ${getLanguageLabel(getGuildLanguage(guildId))}`,
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
                return safeEditReply(
                    interaction,
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

            return safeEditReply(
                interaction,
                `✅ VoiceX joined **${voiceChannel.name}**!`
            );
        }

        // LEAVE
        if (interaction.commandName === 'leave') {
            const session = sessions.get(guildId);

            if (!session) {
                return safeEditReply(
                    interaction,
                    '❌ VoiceX is not in a voice channel!'
                );
            }

            stopSpeech(session);
            session.connection.destroy();
            sessions.delete(guildId);

            return safeEditReply(
                interaction,
                '👋 VoiceX left the voice channel.'
            );
        }

        // TTS
        if (interaction.commandName === 'tts') {
            const session = sessions.get(guildId);

            if (!session) {
                return safeEditReply(
                    interaction,
                    '❌ Pehle /join use karo!'
                );
            }

            const text = interaction.options
                .getString('text', true);

            enqueueSpeech(session, text);

            const voice = getGuildVoice(guildId);

            return safeEditReply(
                interaction,
                `🔊 Added to queue! Voice: **${voice?.name || 'Default'}**`
            );
        }

        // STOP
        if (interaction.commandName === 'stop') {
            const session = sessions.get(guildId);

            if (!session) {
                return safeEditReply(
                    interaction,
                    '❌ VoiceX is not in a voice channel!'
                );
            }

            stopSpeech(session);

            return safeEditReply(
                interaction,
                '⏹️ Speech stopped and queue cleared!'
            );
        }

        // VOICES
        if (interaction.commandName === 'voices') {
            if (availableVoices.length === 0) {
                return safeEditReply(
                    interaction,
                    '❌ ElevenLabs voices load nahi hui. API key aur account access check karo.'
                );
            }

            const male = availableVoices
                .filter(v =>
                    ['masculine', 'male'].includes(
                        (v.gender || 'unknown').toLowerCase()
                    )
                )
                .map(v => `👨 ${v.name}`)
                .slice(0, 20);

            const female = availableVoices
                .filter(v =>
                    ['feminine', 'female'].includes(
                        (v.gender || 'unknown').toLowerCase()
                    )
                )
                .map(v => `👩 ${v.name}`)
                .slice(0, 20);

            const other = availableVoices
                .filter(v =>
                    !['male', 'female', 'masculine', 'feminine']
                        .includes((v.gender || 'unknown').toLowerCase())
                )
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
                'Use `/setvoice` to change your voice.',
                `Language: **${getLanguageLabel(getGuildLanguage(guildId))}** (change with /setlang)`
            ].join('\n');

            return safeEditReply(interaction, {
                content: description.slice(0, 1900)
            });
        }

        // SET VOICE
        if (interaction.commandName === 'setvoice') {
            const voiceId = interaction.options
                .getString('voice', true);

            const selectedVoice = availableVoices.find(
                v => v.id === voiceId
            );

            if (!selectedVoice) {
                return safeEditReply(
                    interaction,
                    '❌ Voice nahi mili. `/voices` check karo.'
                );
            }

            guildVoices.set(guildId, selectedVoice.id);
            await saveSettings();

            return safeEditReply(
                interaction,
                `✅ Voice changed to **${selectedVoice.name}** (${selectedVoice.gender})!`
            );
        }

        // UNKNOWN COMMAND
        return safeEditReply(
            interaction,
            '❌ Unknown command.'
        );

    } catch (error) {
        console.error('Command error:', error);

        await safeEditReply(
            interaction,
            `❌ Error: ${error.message}`
        );
    }
});

// ==================== AUTO VOICE CHAT TTS ====================

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

        const displayName = getTTSName(
            member,
            message.guild.id
        );

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

// ==================== DISCORD ERRORS ====================

client.on(Events.Error, error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});

// ==================== LOGIN ====================

client.login(DISCORD_TOKEN).catch(error => {
    console.error('Discord login failed:', error.message);
    process.exit(1);
});
