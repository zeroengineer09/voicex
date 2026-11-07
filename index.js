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

// Environment
const {
    DISCORD_TOKEN,
    CARTESIA_API_KEY
} = process.env;

// Settings
const MODEL_ID = 'sonic-3.6';
const LANGUAGE = 'hi';

const DEFAULT_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';

const SETTINGS_FILE = path.resolve('./voice-settings.json');

if (!DISCORD_TOKEN || !CARTESIA_API_KEY) {
    console.error('Missing Discord or Cartesia API key!');
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

// Cartesia
const cartesia = new Cartesia({
    apiKey: CARTESIA_API_KEY
});

// Data
const sessions = new Map();
const guildVoices = new Map();

let availableVoices = [];

// Load saved server voices
async function loadSettings() {
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf8');
        const saved = JSON.parse(data);

        for (const [guildId, voiceId] of Object.entries(saved)) {
            guildVoices.set(guildId, voiceId);
        }

        console.log('Saved voice settings loaded.');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('Settings load error:', error.message);
        }
    }
}

// Save server voices
async function saveSettings() {
    const data = Object.fromEntries(guildVoices);

    await fs.writeFile(
        SETTINGS_FILE,
        JSON.stringify(data, null, 2),
        'utf8'
    );
}

// Load Cartesia voices
async function loadVoices() {
    console.log('Loading Cartesia voices...');

    const voices = [];

    try {
        for await (const voice of cartesia.voices.list()) {
            if (voice.id && voice.name) {
                voices.push(voice);
            }
        }

        availableVoices = voices;

        console.log(`Loaded ${availableVoices.length} voices.`);
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

// Generate speech
async function generateSpeech(text, voiceId) {
    const response = await cartesia.tts.generate({
        model_id: MODEL_ID,
        transcript: text,
        voice: voiceId,
        language: LANGUAGE,
        output_format: {
            container: 'wav',
            encoding: 'pcm_s16le',
            sample_rate: 44100
        }
    });

    const audioBlob = await response.blob();

    return Buffer.from(await audioBlob.arrayBuffer());
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
                    console.error('No available Cartesia voice.');
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

// Add text to queue
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

// Create session
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
    console.log('Language: Hindi');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// Voice autocomplete
client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isAutocomplete()) {
        if (interaction.commandName !== 'setvoice') return;

        const focused = interaction.options.getFocused().toLowerCase();

        const results = availableVoices
            .filter(voice => {
                const gender = voice.gender || 'unknown';

                return (
                    voice.name.toLowerCase().includes(focused) ||
                    gender.toLowerCase().includes(focused)
                );
            })
            .slice(0, 25)
            .map(voice => ({
                name: `${voice.name} (${voice.gender || 'unknown'})`,
                value: voice.id
            }));

        return interaction.respond(results).catch(() => {});
    }

    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    const guildId = interaction.guild.id;

    try {
        await interaction.deferReply();

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
                    '❌ Voices load nahi hui. Bot restart karke try karo.'
                );
            }

            const male = availableVoices
                .filter(v => v.gender === 'masculine')
                .map(v => `👨 ${v.name}`)
                .slice(0, 20);

            const female = availableVoices
                .filter(v => v.gender === 'feminine')
                .map(v => `👩 ${v.name}`)
                .slice(0, 20);

            const neutral = availableVoices
                .filter(v => v.gender === 'gender_neutral')
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
                '**Gender-neutral voices**',
                neutral.join('\n') || 'No neutral voices found.',
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
                `✅ Voice changed to **${selectedVoice.name}** (${selectedVoice.gender || 'unknown'})!`
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
client.on(Events.MessageCreate, message => {
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

    const text = `${message.author.username} says: ${message.content}`;

    enqueueSpeech(session, text.slice(0, 500));
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