import 'dotenv/config';

import {
    Client,
    GatewayIntentBits,
    Events,
    ChannelType,
    PermissionFlagsBits
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

import Cartesia from '@cartesia/cartesia-js';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import fs from 'node:fs/promises';
import path from 'node:path';

// ─── CONFIG ─────────────────────────────────────

const { DISCORD_TOKEN, CARTESIA_API_KEY } = process.env;

const MODEL_ID = 'sonic-3.6';
const DEFAULT_LANGUAGE = 'hi';
const DEFAULT_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
const SETTINGS_FILE = path.resolve('./voice-settings.json');

const SUPPORTED_LANGUAGES = {
    hindi: { code: 'hi', label: 'Hindi' },
    marathi: { code: 'mr', label: 'Marathi' },
    english: { code: 'en', label: 'English' }
};

if (!DISCORD_TOKEN || !CARTESIA_API_KEY) {
    console.error('Missing DISCORD_TOKEN or CARTESIA_API_KEY.');
    process.exit(1);
}

if (!ffmpegPath) {
    console.error('FFmpeg binary not found.');
    process.exit(1);
}

// ─── CLIENTS ────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const cartesia = new Cartesia({
    token: CARTESIA_API_KEY
});

// ─── DATA ───────────────────────────────────────

const sessions = new Map();
const guildVoices = new Map();
const guildNicknames = new Map();
const guildLanguages = new Map();

let availableVoices = [];

// ─── HELPERS ────────────────────────────────────

function nicknameKey(guildId, userId) {
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

    return guildNicknames.get(nicknameKey(guildId, member.id))
        || member.displayName
        || member.user.globalName
        || member.user.username;
}

// ─── SETTINGS ───────────────────────────────────

async function loadSettings() {
    try {
        const saved = JSON.parse(
            await fs.readFile(SETTINGS_FILE, 'utf8')
        );

        if (
            saved.guildVoices ||
            saved.guildNicknames ||
            saved.guildLanguages
        ) {
            for (const [id, value] of Object.entries(saved.guildVoices || {})) {
                guildVoices.set(id, value);
            }

            for (const [id, value] of Object.entries(saved.guildNicknames || {})) {
                guildNicknames.set(id, value);
            }

            for (const [id, value] of Object.entries(saved.guildLanguages || {})) {
                if (Object.values(SUPPORTED_LANGUAGES).some(x => x.code === value)) {
                    guildLanguages.set(id, value);
                }
            }
        } else {
            // Old settings compatibility
            for (const [id, value] of Object.entries(saved || {})) {
                if (typeof value === 'string') guildVoices.set(id, value);
            }
        }

        console.log('Settings loaded.');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Settings load error:', error);
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

// ─── CARTESIA VOICES ────────────────────────────

async function loadVoices() {
    console.log('Loading Cartesia voices...');

    try {
        const voices = [];

        for await (const voice of cartesia.voices.list()) {
            if (!voice.id || !voice.name) continue;

            voices.push({
                id: voice.id,
                name: voice.name,
                gender: voice.gender
                    || voice.metadata?.gender
                    || 'unknown'
            });
        }

        availableVoices = voices;
        console.log(`Loaded ${voices.length} Cartesia voices.`);
    } catch (error) {
        console.error('Cartesia voice loading error:', error);
    }
}

function getGuildVoice(guildId) {
    const savedId = guildVoices.get(guildId);

    return availableVoices.find(v => v.id === savedId)
        || availableVoices.find(v => v.id === DEFAULT_VOICE_ID)
        || availableVoices[0];
}

// ─── GENERATE SPEECH ────────────────────────────

async function generateSpeech(text, voiceId, language) {
    const response = await cartesia.tts.generate({
        model_id: MODEL_ID,
        transcript: text,
        voice: voiceId,
        language,
        output_format: {
            container: 'wav',
            encoding: 'pcm_s16le',
            sample_rate: 44100
        }
    });

    const blob = await response.blob();
    return Buffer.from(await blob.arrayBuffer());
}

// ─── PLAY AUDIO ─────────────────────────────────

async function playAudio(session, audioBuffer) {
    const ffmpeg = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ], {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    session.ffmpeg = ffmpeg;

    let ffmpegError = '';

    ffmpeg.stderr.on('data', data => {
        ffmpegError += data.toString();
    });

    ffmpeg.on('error', error => {
        console.error('FFmpeg process error:', error);
    });

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw
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

        if (ffmpegError.trim()) {
            console.error('FFmpeg:', ffmpegError);
        }
    } finally {
        if (session.ffmpeg === ffmpeg) {
            session.ffmpeg = null;
        }

        if (!ffmpeg.killed) {
            ffmpeg.kill();
        }
    }
}

// ─── SPEECH QUEUE ───────────────────────────────

async function processQueue(session) {
    if (session.processing) return;

    session.processing = true;

    try {
        while (
            session.queue.length &&
            session.connection.state.status !== VoiceConnectionStatus.Destroyed
        ) {
            const text = session.queue.shift();

            try {
                const voice = getGuildVoice(session.guildId);

                if (!voice) {
                    console.error('No Cartesia voice available.');
                    continue;
                }

                const language = getGuildLanguage(session.guildId);

                console.log(`Speaking: ${text}`);
                console.log(`Voice: ${voice.name} | Language: ${language}`);

                const audio = await generateSpeech(
                    text,
                    voice.id,
                    language
                );

                if (
                    session.connection.state.status ===
                    VoiceConnectionStatus.Destroyed
                ) break;

                await playAudio(session, audio);
            } catch (error) {
                console.error('Speech error:', error);
            }
        }
    } finally {
        session.processing = false;

        if (
            session.queue.length &&
            session.connection.state.status !== VoiceConnectionStatus.Destroyed
        ) {
            processQueue(session);
        }
    }
}

function enqueueSpeech(session, text) {
    if (!text?.trim()) return;

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

// ─── VOICE SESSION ──────────────────────────────

function createSession(guild, voiceChannel) {
    const oldSession = sessions.get(guild.id);

    if (oldSession) {
        stopSpeech(oldSession);

        if (oldSession.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            oldSession.connection.destroy();
        }

        sessions.delete(guild.id);
    }

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        debug: true
    });
    connection.on('debug', message => {
    console.log('[VOICE DEBUG]', message);
});

connection.on('stateChange', (oldState, newState) => {
    console.log(`[VOICE STATE] ${oldState.status} -> ${newState.status}`);
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

    connection.on('stateChange', (oldState, newState) => {
        console.log(
            `[VOICE STATE] ${oldState.status} -> ${newState.status}`
        );
    });

    connection.on('debug', message => {
        console.log('[VOICE DEBUG]', message);
    });

    connection.on('error', error => {
        console.error('[VOICE ERROR]', error);
    });

    player.on('error', error => {
        console.error('[PLAYER ERROR]', error);
    });

    return session;
}

// ─── BOT READY ─────────────────────────────────

client.once(Events.ClientReady, async readyClient => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('       VOICEX BOT ONLINE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`Bot: ${readyClient.user.tag}`);

    await loadSettings();
    await loadVoices();

    console.log(`Available voices: ${availableVoices.length}`);
    console.log('TTS Provider: Cartesia');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// ─── INTERACTIONS ───────────────────────────────

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

    const guild = interaction.guild;
    const guildId = guild.id;

    try {
        await interaction.deferReply();

        // SET NICKNAME
        if (interaction.commandName === 'setnick') {
            const name = interaction.options.getString('name', true).trim();
            const key = nicknameKey(guildId, interaction.user.id);

            if (name.toLowerCase() === 'reset') {
                guildNicknames.delete(key);
                await saveSettings();

                const member = await guild.members.fetch(interaction.user.id);

                return interaction.editReply(
                    `✅ Custom TTS name reset. VoiceX will now say **${member.displayName}**.`
                );
            }

            if (!name || name.length > 32) {
                return interaction.editReply(
                    '❌ Name must be between 1 and 32 characters.'
                );
            }

            guildNicknames.set(key, name);
            await saveSettings();

            return interaction.editReply(
                `✅ Your TTS name is now **${name}**!`
            );
        }

        // SET LANGUAGE
        if (interaction.commandName === 'setlang') {
            const selected = interaction.options.getString('language', true);
            const language = SUPPORTED_LANGUAGES[selected];

            if (!language) {
                return interaction.editReply('❌ Unsupported language.');
            }

            guildLanguages.set(guildId, language.code);
            await saveSettings();

            return interaction.editReply(
                `✅ VoiceX language changed to **${language.label}**!`
            );
        }

        // ABOUT
        if (interaction.commandName === 'about') {
            const member = await guild.members.fetch(interaction.user.id);

            return interaction.editReply({
                content: [
                    '**🎧 VoiceX — Discord TTS Bot**',
                    'Converts messages into voice audio in your server.',
                    '',
                    `**Your TTS name:** ${getTTSName(member, guildId)}`,
                    '**Name priority:** Custom name → Server nickname → Discord username',
                    '',
                    `**Language:** ${getLanguageLabel(getGuildLanguage(guildId))}`,
                    '**TTS Provider:** Cartesia',
                    '**Made by Raxxy Developer**'
                ].join('\n')
            });
        }

        // JOIN
        if (interaction.commandName === 'join') {
            const member = await guild.members.fetch(interaction.user.id);
            const voiceChannel = member.voice.channel;

            if (!voiceChannel) {
                return interaction.editReply(
                    '❌ Pehle voice channel join karo!'
                );
            }

            const botMember = await guild.members.fetchMe();
            const permissions = voiceChannel.permissionsFor(botMember);

            const required = [
                [PermissionFlagsBits.ViewChannel, 'View Channel'],
                [PermissionFlagsBits.Connect, 'Connect'],
                [PermissionFlagsBits.Speak, 'Speak']
            ];

            const missing = required
                .filter(([permission]) => !permissions?.has(permission))
                .map(([, name]) => name);

            if (missing.length) {
                return interaction.editReply(
                    `❌ Bot ke paas ye permissions missing hain: **${missing.join(', ')}**`
                );
            }

            const session = createSession(guild, voiceChannel);

            try {
                await entersState(
                    session.connection,
                    VoiceConnectionStatus.Ready,
                    30000
                );
            } catch (error) {
                const failedState = session.connection.state.status;

                console.error(
                    `Voice join failed. State: ${failedState}`,
                    error
                );

                if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    session.connection.destroy();
                }

                if (sessions.get(guildId) === session) {
                    sessions.delete(guildId);
                }

                return interaction.editReply(
                    `❌ Voice connection failed. State: **${failedState}**. Railway logs check karo.`
                );
            }

            return interaction.editReply(
                `✅ VoiceX successfully joined **${voiceChannel.name}**!`
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

            if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                session.connection.destroy();
            }

            sessions.delete(guildId);

            return interaction.editReply('👋 VoiceX left the voice channel.');
        }

        // TTS
        if (interaction.commandName === 'tts') {
            const session = sessions.get(guildId);

            if (!session) {
                return interaction.editReply('❌ Pehle /join use karo!');
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
            if (!availableVoices.length) {
                return interaction.editReply(
                    '❌ Cartesia voices load nahi hui. API key check karo.'
                );
            }

            const male = availableVoices
                .filter(v => ['masculine', 'male'].includes(v.gender.toLowerCase()))
                .slice(0, 20)
                .map(v => `👨 ${v.name}`);

            const female = availableVoices
                .filter(v => ['feminine', 'female'].includes(v.gender.toLowerCase()))
                .slice(0, 20)
                .map(v => `👩 ${v.name}`);

            const other = availableVoices
                .filter(v => !['male', 'female', 'masculine', 'feminine'].includes(v.gender.toLowerCase()))
                .slice(0, 10)
                .map(v => `⚪ ${v.name}`);

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
                `Language: **${getLanguageLabel(getGuildLanguage(guildId))}**`
            ].join('\n');

            return interaction.editReply({
                content: description.slice(0, 1900)
            });
        }

        // SET VOICE
        if (interaction.commandName === 'setvoice') {
            const voiceId = interaction.options.getString('voice', true);
            const selectedVoice = availableVoices.find(v => v.id === voiceId);

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

// ─── AUTO TTS: VOICE CHANNEL TEXT CHAT ──────────

client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.trim()) return;

    const session = sessions.get(message.guild.id);
    if (!session) return;

    if (message.channel.type !== ChannelType.GuildVoice) return;

    if (message.channel.id !== session.connection.joinConfig.channelId) {
        return;
    }

    try {
        const member = message.member
            || await message.guild.members.fetch(message.author.id);

        const displayName = getTTSName(member, message.guild.id);

        enqueueSpeech(
            session,
            `${displayName} says: ${message.content}`.slice(0, 500)
        );
    } catch (error) {
        console.error('Display name error:', error);

        const fallback = message.author.globalName
            || message.author.username;

        enqueueSpeech(
            session,
            `${fallback} says: ${message.content}`.slice(0, 500)
        );
    }
});

// ─── ERROR HANDLING ─────────────────────────────

client.on(Events.Error, error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled rejection:', error);
});

// ─── LOGIN ──────────────────────────────────────
// ─── DISCORD VOICE GATEWAY DEBUG ─────────────────
client.on('raw', packet => {
    if (
        packet.t === 'VOICE_STATE_UPDATE' ||
        packet.t === 'VOICE_SERVER_UPDATE'
    ) {
        console.log(`[DISCORD RAW] ${packet.t}`, {
            guild_id: packet.d.guild_id,
            channel_id: packet.d.channel_id,
            user_id: packet.d.user_id,
            endpoint: packet.d.endpoint
        });
    }
});

client.login(DISCORD_TOKEN).catch(error => {
    console.error('Discord login failed:', error);
    process.exit(1);
});

client.login(DISCORD_TOKEN).catch(error => {
    console.error('Discord login failed:', error);
    process.exit(1);
});
