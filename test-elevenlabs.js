import 'dotenv/config';

const apiKey = process.env.ELEVENLABS_API_KEY;

if (!apiKey) {
    console.error('Missing ELEVENLABS_API_KEY in .env');
    process.exit(1);
}

try {
    const response = await fetch(
        'https://api.elevenlabs.io/v2/voices?page_size=5&include_total_count=false',
        { headers: { 'xi-api-key': apiKey } }
    );

    if (!response.ok) {
        console.error(`ElevenLabs API error ${response.status}:`, await response.text());
        process.exit(1);
    }

    const data = await response.json();
    console.log('ElevenLabs API connected!');
    console.log('Voices returned:', data.voices?.length ?? 0);
    for (const voice of data.voices || []) {
        console.log(`- ${voice.name} (${voice.voice_id})`);
    }
} catch (error) {
    console.error('ElevenLabs test failed:', error.message);
    process.exit(1);
}
