
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

import Cartesia from '@cartesia/cartesia-js';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import fs from 'node:fs/promises';
import path from 'node:path';

// ==========================================
// ENVIRONMENT
// ==========================================

const {
    DISCORD_TOKEN,
    CARTESIA_API_KEY
} = process.env;

const MODEL_ID = 'sonic-3.6';

const DEFAULT_VOICE_ID =
    'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';

const DEFAULT_LANGUAGE = 'hi';

const SUPPORTED_LANGUAGES = {
    hindi: { code: 'hi', label: 'Hindi' },
    marathi: { code: 'mr', label: 'Marathi' },
    english: { code: 'en', label: 'English' }
};

const SETTINGS_FILE = path.resolve('./voice-settings.json');

if (!DISCORD_TOKEN || !CARTESIA_API_KEY) {
    console.error('Missing DISCORD_TOKEN or CARTESIA_API_KEY!');
    process.exit(1);
}

if (!ffmpegPath) {
    console.error('FFmpeg not found!');
    process.exit(1);
}

// Cartesia client
const cartesia = new Cartesia({
    token: CARTESIA_API_KEY
});

// ==========================================
// DISCORD CLIENT
// ==========================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==========================================
// DATA
// ==========================================

const sessions = new Map();

const guildVoices = new Map();
const guildNicknames = new Map();
const guildLanguages = new Map();

let availableVoices = [];

// ==========================================
// NAME HELPERS
// ==========================================

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

// ==========================================
// LANGUAGE HELPERS
// ==========================================

function getGuildLanguage(guildId) {
    return guildLanguages.get(guildId) || DEFAULT_LANGUAGE;
}

function getLanguageLabel(code) {
    return Object.values(SUPPORTED_LANGUAGES)
        .find(language => language.code === code)?.label || 'Hindi';
}

// ==========================================
// SETTINGS
// ==========================================

async function loadSettings() {
    try {
        const data = await fs.readFile(
            SETTINGS_FILE,
            'utf8'
        );

        const saved = JSON.parse(data);

        if (
            saved.guildVoices ||
            saved.guildNicknames ||
            saved.guildLanguages
        ) {
            for (const [id, voice] of Object.entries(
                saved.guildVoices || {}
            )) {
                guildVoices.set(id, voice);
            }

            for (const [id, name] of Object.entries(
                saved.guildNicknames || {}
            )) {
                guildNicknames.set(id, name);
            }

            for (const [id, language] of Object.entries(
                saved.guildLanguages || {}
            )) {
                guildLanguages.set(id, language);
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
            console.error('Settings load error:', error.message);
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

// ==========================================
// CARTESIA VOICES
// ==========================================

async function loadVoices() {
    console.log('Loading Cartesia voices...');

    try {
        const voices = [];

        for await (const voice of cartesia.voices.list()) {
            voices.push({
                id: voice.id,
                name: voice.name || 'Unnamed voice',
                gender: voice.gender ||
                    voice.metadata?.gender ||
                    'unknown'
            });
        }

        availableVoices = voices;

        console.log(
            `Loaded ${availableVoices.length} Cartesia voices.`
        );

    } catch (error) {
        console.error(
            'Cartesia voice loading error:',
            error.message
        );
    }
}

function getGuildVoice(guildId) {
    const savedId = guildVoices.get(guildId);

    if (savedId) {
        const voice = availableVoices.find(
            v => v.id === savedId
        );

        if (voice) return voice;
    }

    return availableVoices.find(
        v => v.id === DEFAULT_VOICE_ID
    ) || availableVoices[0];
}

// ==========================================
// CARTESIA SPEECH GENERATION
// ==========================================

async function generateSpeech(text, voiceId, language) {
    console.log(`Generating speech in ${language}...`);

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

    const audioBlob = await response.blob();

    const audioBuffer = Buffer.from(
        await audioBlob.arrayBuffer()
    );

    if (!audioBuffer.length) {
        throw new Error('Cartesia returned empty audio.');
    }

    console.log(
        `Generated audio: ${audioBuffer.length} bytes`
    );

    return audioBuffer;
}

// ==========================================
// AUDIO PLAYBACK
// ==========================================

async function playAudio(session, audioBuffer) {
    return new Promise((resolve, reject) => {

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

        let started = false;
        let finished = false;
        let stderrOutput = '';

        let timeout;

        const cleanup = () => {
            clearTimeout(timeout);

            if (session.ffmpeg === ffmpeg) {
                session.ffmpeg = null;
            }

            session.player.removeListener(
                'stateChange',
                onStateChange
            );

            session.player.removeListener(
                'error',
                onPlayerError
            );

            if (!ffmpeg.killed) {
                ffmpeg.kill();
            }
        };

        const finish = (error = null) => {
            if (finished) return;

            finished = true;

            cleanup();

            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        const onStateChange = (oldState, newState) => {

            console.log(
                `Player: ${oldState.status} -> ${newState.status}`
            );

            if (
                newState.status === AudioPlayerStatus.Playing
            ) {
                started = true;

                console.log('Audio playback started.');
            }

            if (
                started &&
                newState.status === AudioPlayerStatus.Idle
            ) {
                console.log('Audio playback completed.');

                finish();
            }
        };

        const onPlayerError = error => {
            finish(
                new Error(`Audio player error: ${error.message}`)
            );
        };

        session.player.on(
            'stateChange',
            onStateChange
        );

        session.player.on(
            'error',
            onPlayerError
        );

        ffmpeg.stderr.on('data', data => {
            stderrOutput += data.toString();

            console.error(
                'FFmpeg:',
                data.toString()
            );
        });

        ffmpeg.on('error', error => {
            finish(
                new Error(`FFmpeg spawn error: ${error.message}`)
            );
        });

        ffmpeg.on('close', code => {
            if (code !== 0 && !finished) {
                finish(
                    new Error(
                        `FFmpeg exited with code ${code}: ${stderrOutput}`
                    )
                );
            }
        });

        timeout = setTimeout(() => {

            const message = started
                ? 'Audio playback timed out.'
                : 'Audio player did not start. Check voice connection and FFmpeg output.';

            finish(new Error(message));

        }, 60000);

        try {
            const resource = createAudioResource(
                ffmpeg.stdout,
                {
                    inputType: StreamType.Raw
                }
            );

            session.player.play(resource);

            ffmpeg.stdin.end(audioBuffer);

        } catch (error) {
            finish(error);
        }
    });
}

// ==========================================
// SPEECH QUEUE
// ==========================================

async function processQueue(session) {
    if (session.processing) return;

    session.processing = true;

    try {
        while (
            session.queue.length > 0 &&
            session.connection.state.status !==
                VoiceConnectionStatus.Destroyed
        ) {

            const text = session.queue.shift();

            try {
                const voice = getGuildVoice(session.guildId);

                if (!voice) {
                    console.error('No Cartesia voice available.');
                    continue;
                }

                const language = getGuildLanguage(
                    session.guildId
                );

                console.log(
                    `Speaking with ${voice.name} (${language}):`,
                    text
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
                console.error(
                    'Speech generation/playback error:',
                    error
                );
            }
        }

    } finally {
        session.processing = false;

        if (
            session.queue.length > 0 &&
            session.connection.state.status !==
                VoiceConnectionStatus.Destroyed
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

// ==========================================
// STOP SPEECH
// ==========================================

function stopSpeech(session) {
    session.queue = [];

    if (session.ffmpeg && !session.ffmpeg.killed) {
        session.ffmpeg.kill();
        session.ffmpeg = null;
    }

    session.player.stop(true);
}

// ==========================================
// CREATE VOICE SESSION
// ==========================================

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

        selfDeaf: false,
        selfMute: false
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
            `Voice connection: ${oldState.status} -> ${newState.status}`
        );
    });

    connection.on('error', error => {
        console.error(
            'Voice connection error:',
            error.message
        );
    });

    player.on('stateChange', (oldState, newState) => {
        console.log(
            `Audio player: ${oldState.status} -> ${newState.status}`
        );
    });

    player.on('error', error => {
        console.error(
            'Audio player error:',
            error.message
        );
    });

    return session;
}

// ==========================================
// BOT READY
// ==========================================

client.once(Events.ClientReady, async readyClient => {

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('       VOICEX BOT ONLINE');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    console.log(`Bot: ${readyClient.user.tag}`);

    await loadSettings();
    await loadVoices();

    console.log(
        `Available Cartesia voices: ${availableVoices.length}`
    );

    console.log(
        `TTS Provider: Cartesia (${MODEL_ID})`
    );

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// ==========================================
// INTERACTIONS
// ==========================================

client.on(Events.InteractionCreate, async interaction => {

    // VOICE AUTOCOMPLETE
    if (interaction.isAutocomplete()) {

        if (interaction.commandName !== 'setvoice') return;

        const focused = interaction.options
            .getFocused()
            .toLowerCase();

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

        // ======================================
        // SET NICKNAME
        // ======================================

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

                return interaction.editReply(
                    `✅ Custom TTS name reset. VoiceX will now say **${member.displayName}**.`
                );
            }

            if (
                !requestedName ||
                requestedName.length > 32
            ) {
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

        // ======================================
        // SET LANGUAGE
        // ======================================

        if (interaction.commandName === 'setlang') {

            const selected = interaction.options
                .getString('language', true);

            const language = SUPPORTED_LANGUAGES[selected];

            if (!language) {
                return interaction.editReply(
                    '❌ Unsupported language.'
                );
            }

            guildLanguages.set(
                guildId,
                language.code
            );

            await saveSettings();

            return interaction.editReply(
                `✅ Server TTS language set to **${language.label}**.`
            );
        }

        // ======================================
        // ABOUT
        // ======================================

        if (interaction.commandName === 'about') {

            const member = await interaction.guild.members.fetch(
                interaction.user.id
            );

            const voice = getGuildVoice(guildId);

            return interaction.editReply({
                content: [
                    '**🎧 VoiceX — Discord TTS Bot**',
                    'Converts messages in the connected voice channel into speech.',
                    '',
                    `**Your TTS name:** ${getTTSName(member, guildId)}`,
                    '**Name priority:** Custom TTS name → Server nickname → Global name → Username',
                    `**Server language:** ${getLanguageLabel(getGuildLanguage(guildId))}`,
                    `**Selected voice:** ${voice?.name || 'Default'}`,
                    '**TTS Provider:** Cartesia Sonic 3.6',
                    '**Made by Raxxy Developer**'
                ].join('\n')
            });
        }

        // ======================================
        // JOIN
        // ======================================

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

            try {

                await entersState(
                    session.connection,
                    VoiceConnectionStatus.Ready,
                    30000
                );

                return interaction.editReply(
                    `✅ VoiceX joined **${voiceChannel.name}**!`
                );

            } catch (error) {

                console.error(
                    'Voice connection failed:',
                    error.message,
                    'Current state:',
                    session.connection.state.status
                );

                stopSpeech(session);

                session.connection.destroy();

                sessions.delete(guildId);

                return interaction.editReply(
                    '❌ Voice connection failed. Check bot permissions (Connect and Speak), Discord voice connection and Railway logs.'
                );
            }
        }

        // ======================================
        // LEAVE
        // ======================================

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

        // ======================================
        // TTS
        // ======================================

        if (interaction.commandName === 'tts') {

            const session = sessions.get(guildId);

            if (!session) {
                return interaction.editReply(
                    '❌ Pehle /join use karo!'
                );
            }

            const text = interaction.options.getString(
                'text',
                true
            );

            enqueueSpeech(session, text);

            const voice = getGuildVoice(guildId);

            return interaction.editReply(
                `🔊 Added to queue! Voice: **${voice?.name || 'Default'}** | Language: **${getLanguageLabel(getGuildLanguage(guildId))}**`
            );
        }

        // ======================================
        // STOP
        // ======================================

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

        // ======================================
        // VOICES
        // ======================================

        if (interaction.commandName === 'voices') {

            if (availableVoices.length === 0) {
                return interaction.editReply(
                    '❌ Cartesia voices load nahi hui. Railway logs/API key check karo.'
                );
            }

            const groups = {

                male: availableVoices.filter(v =>
                    ['male', 'masculine'].includes(
                        v.gender.toLowerCase()
                    )
                ),

                female: availableVoices.filter(v =>
                    ['female', 'feminine'].includes(
                        v.gender.toLowerCase()
                    )
                ),

                other: availableVoices.filter(v =>
                    ![
                        'male',
                        'masculine',
                        'female',
                        'feminine'
                    ].includes(v.gender.toLowerCase())
                )
            };

            const currentVoice = getGuildVoice(guildId);

            const description = [
                `**Currently selected:** ${currentVoice?.name || 'Default'}`,
                `**Language:** ${getLanguageLabel(getGuildLanguage(guildId))}`,
                '',
                '**Male voices**',
                groups.male.slice(0, 15)
                    .map(v => `👨 ${v.name}`)
                    .join('\n') || 'No male voices found.',
                '',
                '**Female voices**',
                groups.female.slice(0, 15)
                    .map(v => `👩 ${v.name}`)
                    .join('\n') || 'No female voices found.',
                '',
                '**Other voices**',
                groups.other.slice(0, 10)
                    .map(v => `⚪ ${v.name}`)
                    .join('\n') || 'No other voices found.',
                '',
                'Use `/setvoice` to change your voice.'
            ].join('\n');

            return interaction.editReply({
                content: description.slice(0, 1900)
            });
        }

        // ======================================
        // SET VOICE
        // ======================================

        if (interaction.commandName === 'setvoice') {

            const voiceId = interaction.options.getString(
                'voice',
                true
            );

            const selectedVoice = availableVoices.find(
                v => v.id === voiceId
            );

            if (!selectedVoice) {
                return interaction.editReply(
                    '❌ Voice nahi mili. `/voices` check karo.'
                );
            }

            guildVoices.set(
                guildId,
                selectedVoice.id
            );

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

// ==========================================
// AUTOMATIC VOICE CHANNEL TEXT READING
// ==========================================

client.on(Events.MessageCreate, async message => {

    if (message.author.bot) return;

    if (!message.guild) return;

    if (!message.content.trim()) return;

    const session = sessions.get(message.guild.id);

    if (!session) return;

    if (message.channel.type !== ChannelType.GuildVoice) {
        return;
    }

    if (
        message.channel.id !==
        session.connection.joinConfig.channelId
    ) {
        return;
    }

    try {

        const member = message.member ||
            await message.guild.members.fetch(
                message.author.id
            );

        const displayName = getTTSName(
            member,
            message.guild.id
        );

        const text = `${displayName} says: ${message.content}`;

        enqueueSpeech(
            session,
            text.slice(0, 500)
        );

    } catch (error) {

        console.error(
            'Display name error:',
            error.message
        );

        const fallback =
            message.author.globalName ||
            message.author.username;

        enqueueSpeech(
            session,
            `${fallback} says: ${message.content}`.slice(0, 500)
        );
    }
});

// ==========================================
// DISCORD ERRORS
// ==========================================

client.on(Events.Error, error => {
    console.error('Discord client error:', error);
});

// ==========================================
// LOGIN
// ==========================================

client.login(DISCORD_TOKEN).catch(error => {

    console.error(
        'Discord login failed:',
        error.message
    );

    process.exit(1);
});
