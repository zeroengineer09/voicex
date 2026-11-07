import 'dotenv/config';
import Cartesia from '@cartesia/cartesia-js';

console.log('Starting Cartesia test...');

const cartesia = new Cartesia({
    apiKey: process.env.CARTESIA_API_KEY
});

try {
    const voices = await cartesia.voices.list();

    console.log('✅ Cartesia API connected!');
    console.log('Available voices:', voices.data.length);
    console.log('First voice:', voices.data[0]?.name ?? 'No voice found');
} catch (error) {
    console.error('❌ Cartesia connection failed:', error.message);
}