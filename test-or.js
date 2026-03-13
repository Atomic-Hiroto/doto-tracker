const axios = require('axios');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const env = fs.readFileSync(envPath, 'utf8');
const keyMatch = env.match(/OPENROUTER_API_KEY=(.*)/);
const apiKey = keyMatch ? keyMatch[1].replace(/["'\r]/g, '').trim() : null;

if (!apiKey) {
    console.error('API Key not found in .env');
    process.exit(1);
}

async function test(model) {
    console.log(`Testing model: ${model}`);
    try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: model,
            messages: [{ role: 'user', content: 'hi' }]
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`SUCCESS [${model}]: ${response.status}`);
    } catch (error) {
        console.log(`ERROR [${model}]: ${error.response?.status || error.message}`);
        if (error.response?.data) {
            console.log('Error data:', JSON.stringify(error.response.data));
        }
    }
}

async function run() {
    await test('anthropic/claude-sonnet-4.5');
    await test('anthropic/claude-3.5-sonnet');
}

run();
