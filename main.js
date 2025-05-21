import whatsappWeb from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { knowledgeBase } from './datasets/silverstream.js';

// Load environment variables
dotenv.config();

// Constants
const { Client, LocalAuth } = whatsappWeb;
const WWEB_VERSION = "2.2412.54";
const AI_MODEL = 'gemini-2.0-flash';

// WhatsApp Client Configuration
const clientConfig = {
    puppeteer: {
        clientId: "whatsapp-bot",
        args: ["--no-sandbox"]
    },
    authStrategy: new LocalAuth({
        dataPath: "./sessions"
    }),
    webVersionCache: {
        type: "remote",
        remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WWEB_VERSION}.html`
    }
};

// Initialize clients
const client = new Client(clientConfig);
const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

/**
 * Generates AI response using Gemini AI
 * @param {string} input - User input text
 * @returns {Promise<string>} AI generated response
 */
async function generateAIResponse(input) {
    try {
        const response = await ai.models.generateContentStream({
            model: AI_MODEL,
            config: { responseMimeType: 'text/plain' },
            contents: [{
                role: 'user',
                parts: [{ text: input }]
            }]
        });
        
        let fullResponse = '';
        for await (const chunk of response) {
            fullResponse += chunk.text;
        }
        return fullResponse;
    } catch (error) {
        console.error('Error generating AI response:', error);
        return 'Sorry, I encountered an error while processing your request.';
    }
}

/**
 * Handles incoming messages
 * @param {Object} message - WhatsApp message object
 */
async function handleMessage(message) {
    console.log(message.body);

    if (message.body.includes('!silvia')) {
        // concat knowledge base with user input
        const input = knowledgeBase + '\n\n' + message.body.replace('!silvia', '').trim();
        const aiResponse = await generateAIResponse(input);
        await client.sendMessage(message.from, aiResponse);
    }
}

// Event Listeners
client.once('ready', () => console.log('Client is ready!'));

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.generate(qr, { small: true });
});

client.on('message_create', handleMessage);

// Initialize WhatsApp client
client.initialize();
