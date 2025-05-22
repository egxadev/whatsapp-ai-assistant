import whatsappWeb from 'whatsapp-web.js';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

// Load environment variables
dotenv.config();

// Setup MySQL connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// Setup Express and Socket.IO
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// WhatsApp configuration constants
const { Client, LocalAuth } = whatsappWeb;
const WHATSAPP_VERSION = '2.2412.54';
const GEMINI_MODEL = 'gemini-2.0-flash';
const COMMAND_PREFIX = process.env.COMMAND_PREFIX;

// WhatsApp client configuration
const whatsappConfig = {
    puppeteer: {
        clientId: 'whatsapp-bot',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
        ],
        headless: true,
        timeout: 60000,
    },
    authStrategy: new LocalAuth({
        dataPath: './sessions',
    }),
    webVersionCache: {
        type: 'remote',
        remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WHATSAPP_VERSION}.html`,
    },
};

// Initialize WhatsApp and Gemini clients
const whatsappClient = new Client(whatsappConfig);
const geminiClient = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.emit('status', {
        status: whatsappClient.info ? 'connected' : 'disconnected',
    });
});

/**
 * Generates response using Gemini AI model
 * @param {string} userInput - User's message text
 * @returns {Promise<string>} AI generated response
 */
async function generateGeminiResponse(userInput) {
    try {
        const stream = await geminiClient.models.generateContentStream({
            model: GEMINI_MODEL,
            config: { responseMimeType: 'text/plain' },
            contents: [
                {
                    role: 'user',
                    parts: [{ text: userInput }],
                },
            ],
        });

        let responseText = '';
        for await (const chunk of stream) {
            responseText += chunk.text;
        }
        return responseText;
    } catch (error) {
        console.error('Failed to generate Gemini response:', error);
        return 'I apologize, but I encountered an error while processing your request.';
    }
}

/**
 * Fetches knowledge base content from database
 * @returns {Promise<string>} Combined knowledge base content
 */
async function fetchKnowledgeBase() {
    const [dataset] = await pool.execute('SELECT content FROM knowledge_base where status = 1');
    return dataset.map((row) => `${row.content}`).join('\n\n');
}

/**
 * Saves chat history to database
 * @param {string} phone - User's phone number
 * @param {string} question - User's question
 * @param {string} answer - Bot's response
 */
async function saveChatHistory(phone, question, answer) {
    try {
        await pool.execute(
            'INSERT INTO chat_histories (phone, question, answer) VALUES (?, ?, ?)',
            [phone, question, answer]
        );
    } catch (err) {
        console.error('Failed to save chat history:', err);
    }
}

/**
 * Sends response to user and saves chat history
 * @param {string} to - Recipient's phone number
 * @param {string} question - Original question
 * @param {string} response - Generated response
 */
async function sendResponseAndSaveHistory(to, question, response) {
    await whatsappClient.sendMessage(to, response);
    await saveChatHistory(to, question, response);
}

/**
 * Processes incoming WhatsApp messages
 * @param {Object} message - WhatsApp message object
 */
async function processWhatsAppMessage(message) {
    const knowledgeBase = await fetchKnowledgeBase();
    
    if (COMMAND_PREFIX && message.body.includes(COMMAND_PREFIX)) {
        const userQuery = message.body.replace(COMMAND_PREFIX, '').trim();
        const contextEnrichedQuery = `${knowledgeBase}\n\n${userQuery}`;
        const response = await generateGeminiResponse(contextEnrichedQuery);
        await sendResponseAndSaveHistory(message.from, userQuery, response);
    } else if (!COMMAND_PREFIX) {
        const contextEnrichedQuery = `${knowledgeBase}\n\n${message.body}`;
        const response = await generateGeminiResponse(contextEnrichedQuery);
        await sendResponseAndSaveHistory(message.from, message.body, response);
    }
}

/**
 * Validates if message should be processed
 * @param {Object} message - WhatsApp message object
 * @returns {boolean} true if message should be processed
 */
function shouldProcessMessage(message) {
    if (message.from === 'status@broadcast') return false;
    if (message.hasQuotedMsg) return false;
    if (message.fromMe) return false;
    return true;
}

// WhatsApp client event handlers
whatsappClient.once('ready', () => {
    console.log('WhatsApp client is ready!');
    io.emit('status', { status: 'connected' });
});

whatsappClient.on('authenticated', () => {
    console.log('Authenticated');
    io.emit('status', { status: 'connected' });
});

whatsappClient.on('auth_failure', (error) => {
    console.log('Authentication failed', error);
});

whatsappClient.on('qr', (qr) => {
    console.log('QR code received', qr);
    io.emit('qr', qr);
});

whatsappClient.on('disconnected', () => {
    console.log('WhatsApp client disconnected');
    io.emit('status', { status: 'disconnected' });
});

whatsappClient.on('message', async (message) => {
    if (shouldProcessMessage(message)) {
        await processWhatsAppMessage(message);
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    whatsappClient.initialize();
});
