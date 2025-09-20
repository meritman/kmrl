// server.js
import express from 'express';
import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import dotenv from 'dotenv';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import fetch from 'node-fetch';
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import jwt from 'jsonwebtoken';
import { MailerSend, EmailParams, Sender, Recipient } from "mailersend";

dotenv.config();

const app = express();
const port = 3000;

// --- Middleware ---
const corsOptions = {
  origin: 'https://metromithra-static.onrender.com'
};
app.use(cors(corsOptions));
app.use(express.json());

// --- GTFS Data Loading ---
let gtfsData = {};

function loadGTFSData() {
    console.log('[LOG] Loading GTFS schedule data...');
    try {
        const stops = parse(fs.readFileSync('./data/stops.txt', 'utf8'), { columns: true, skip_empty_lines: true });
        const stopTimes = parse(fs.readFileSync('./data/stop_times.txt', 'utf8'), { columns: true, skip_empty_lines: true });
        const trips = parse(fs.readFileSync('./data/trips.txt', 'utf8'), { columns: true, skip_empty_lines: true });
        const calendar = parse(fs.readFileSync('./data/calendar.txt', 'utf8'), { columns: true, skip_empty_lines: true });
        const routes = parse(fs.readFileSync('./data/routes.txt', 'utf8'), { columns: true, skip_empty_lines: true });

        gtfsData = {
            stops: new Map(stops.map(s => [s.stop_id, s])),
            stopTimes: stopTimes,
            trips: new Map(trips.map(t => [t.trip_id, t])),
            calendar: calendar,
            routes: new Map(routes.map(r => [r.route_id, r]))
        };
        console.log('[LOG] GTFS data loaded successfully.');
    } catch (error) {
        console.error('[ERROR] Failed to load GTFS data:', error);
        process.exit(1);
    }
}


// --- MongoDB Connection ---
let db;
const client = new MongoClient(process.env.MONGO_URI);

async function connectToMongo() {
    try {
        await client.connect();
        console.log('[LOG] Successfully connected to MongoDB.');
        db = client.db('metromithra');
    } catch (err) {
        console.error('[ERROR] Failed to connect to MongoDB:', err);
        process.exit(1);
    }
}

// --- Run startup functions ---
loadGTFSData();
connectToMongo();

// --- MODIFIED Gemini AI Function for Multi-Label Classification ---
const validClassifications = [
    'Budgets', 'Invoices', 'Purchase Orders', 'Vendor Contracts',
    'Maintenance Reports', 'Safety Circulars', 'Schedules', 'Incident Reports',
    'Passenger Complaints', 'Shift Rosters', 'Safety Updates', 'Incident Alerts', 'Revenue Data',
    'Rolling Stock Maintenance', 'Job Cards', 'Spare Parts Availability', 'Contractor Reports', 'Depot Safety Memos',
    'Projects', 'IAR', 'Regulatory', 'General Correspondence'
];

async function processEmailWithAI(email) {
    const GEMINI_API_KEY = "AIzaSyBaSJz-8Ma99Whgh7OcqBAuWx9AlysEsoU";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
    
    const classificationList = validClassifications.join(', ');

    const prompt = `
    Analyze the following email. Your primary task is to classify it by choosing ALL RELEVANT categories from the following allowed list: [${classificationList}].

    You must follow these rules strictly:
    1.  Choose one or more categories from the list that apply.
    2.  If an email about a "Contractor Report" contains a "Safety Alert", you must include both classifications.
    3.  If it doesn't fit any category, use ["General Correspondence"].

    Respond ONLY with a valid JSON object using this exact schema:
    {"classification": "Array of strings (each string must be one from the provided list)", "urgency": "String ('Low', 'Medium', 'High')", "location": "String", "details": "String", "extracted_action": "String", "suggested_action_roles": "Array of strings"}

    Email Subject: "${email.subject}"
    Email Body: """${email.body}"""`;
    
    try {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
        if (!response.ok) { const errorBody = await response.json(); throw new Error(`Gemini API Error: ${errorBody.error.message}`); }
        const result = await response.json();
        const rawJsonText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawJsonText) throw new Error("No content from Gemini.");
        
        const cleanedJsonText = rawJsonText.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiResponse = JSON.parse(cleanedJsonText);

        // --- NEW VALIDATION LOGIC FOR MULTI-LABEL ---
        let finalClassifications = ['General Correspondence']; // Default fallback

        if (aiResponse.classification && Array.isArray(aiResponse.classification)) {
            // Filter the AI's response to only include tags that are in our valid list
            const validated = aiResponse.classification.filter(tag => validClassifications.includes(tag));
            
            if (validated.length > 0) {
                finalClassifications = validated;
            }
        }
        
        aiResponse.classification = finalClassifications;
        
        return aiResponse;

    } catch (error) { console.error('[ERROR] Failed to process email with AI:', error); return null; }
}


// --- API Endpoints ---

// --- ONE-TIME-USE CACHE CLEARING ENDPOINT ---
app.get('/api/clear-cache', async (req, res) => {
    try {
        if (!db) {
            return res.status(503).send('Database not connected yet.');
        }
        const documentsCollection = db.collection('processed_documents');
        const deleteResult = await documentsCollection.deleteMany({});
        const tasksCollection = db.collection('tasks');
        await tasksCollection.deleteMany({});
        res.status(200).send(`Successfully cleared ${deleteResult.deletedCount} documents and all related tasks. Please REMOVE this endpoint from server.js now.`);
    } catch (error) {
        console.error('[ERROR] Failed to clear cache:', error);
        res.status(500).send('Error clearing cache.');
    }
});


// --- Token-Based Authentication ---
app.post('/api/token-login', (req, res) => {
    const { token } = req.body;
    if (!token) {
        return res.status(400).json({ message: 'Token is required.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
        
        const user = {
            name: decoded.name,
            role: decoded.role,
            roleType: decoded.category,
            location: null
        };

        res.status(200).json({ message: 'Login successful!', user });

    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            return res.status(401).json({ message: 'Token has expired. Please request a new one.' });
        }
        if (error instanceof jwt.JsonWebTokenError) {
            return res.status(401).json({ message: 'Invalid token.' });
        }
        console.error('[ERROR] Token verification failed:', error);
        res.status(500).json({ message: 'Server error during token verification.' });
    }
});

// --- Endpoint to Request a New Token ---
app.post('/api/request-new-token', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ message: 'Email is required.' });
    }

    const mailerSend = new MailerSend({
        apiKey: process.env.MAILERSEND_API_KEY,
    });

    const sentFrom = new Sender("your-verified-from-email@yourdomain.com", "Metro Mithra System");
    const recipients = [
        new Recipient("admin-email-to-receive-requests@example.com", "System Admin")
    ];

    const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setSubject("New Token Request for Metro Mithra")
        .setHtml(`
            <p>Hello Admin,</p>
            <p>A user with the email address <strong>${email}</strong> has requested a new login token because their old one has expired.</p>
            <p>Please use the Python Token Generator to create a new token and send it to them.</p>
            <p>Thank you,<br/>Metro Mithra Automated System</p>
        `);

    try {
        await mailerSend.email.send(emailParams);
        res.status(200).json({ message: 'Request received. An admin has been notified and will send you a new token shortly.' });
    } catch (error) {
        console.error('MailerSend Error:', error.body);
        res.status(500).json({ message: 'Could not send the request. Please contact support.' });
    }
});


// Tasks endpoint
app.get('/api/tasks', async (req, res) => { const { role } = req.query; if (!role) { return res.status(400).json({ message: 'Role query parameter is required.' }); } try { const tasksCollection = db.collection('tasks'); const userTasks = await tasksCollection.find({ assigned_to_role: role }).sort({ createdAt: -1 }).toArray(); res.status(200).json(userTasks); } catch (error) { console.error('[ERROR] Failed to fetch tasks:', error); res.status(500).json({ message: 'Server error while fetching tasks.' }); } });

// --- Endpoint for AI Summarization ---
app.post('/api/summarize', async (req, res) => {
    const { text } = req.body;
    if (!text) {
        return res.status(400).json({ error: 'Text to summarize is required.' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        console.error('[ERROR] Gemini API key is not set in environment variables.');
        return res.status(500).json({ error: 'Server configuration error.' });
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
        contents: [{
            parts: [{
                text: `Summarize the following email text in three brief, clear bullet points:\n\n---\n\n${text}`
            }]
        }]
    };

    try {
        const fetchResponse = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!fetchResponse.ok) {
            const errorBody = await fetchResponse.json();
            throw new Error(`Gemini API Error: ${errorBody.error.message}`);
        }

        const result = await fetchResponse.json();
        const summary = result.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!summary) {
            throw new Error("Could not extract summary from AI response.");
        }

        res.json({ summary });

    } catch (error) {
        console.error('[ERROR] Failed to get summary from Gemini:', error);
        res.status(500).json({ error: error.message });
    }
});

// Email fetching and processing
function getRawEmailsFromImap() { return new Promise((resolve, reject) => { const imap = new Imap({ user: process.env.IMAP_USER, password: process.env.IMAP_PASSWORD, host: 'imap.gmail.com', port: 993, tls: true, tlsOptions: { rejectUnauthorized: false } }); imap.once('ready', () => { imap.openBox('INBOX', true, (err, box) => { if (err) return reject(err); imap.search(['ALL'], (err, results) => { if (err || !results || results.length === 0) { imap.end(); return resolve([]); } const fetch = imap.fetch(results, { bodies: '' }); const messagePromises = []; fetch.on('message', (msg) => { const messagePromise = new Promise((resolveMsg) => { msg.on('body', (stream) => { simpleParser(stream, (err, parsed) => { if (err) return resolveMsg(null); resolveMsg({ from: parsed.from ? parsed.from.text : 'Unknown', subject: parsed.subject || 'No Subject', body: parsed.text || 'No Body', date: parsed.date || new Date(), }); }); }); }); messagePromises.push(messagePromise); }); fetch.once('error', reject); fetch.once('end', () => { Promise.all(messagePromises).then(emails => { imap.end(); resolve(emails.filter(e => e !== null)); }).catch(reject); }); }); }); }); imap.once('error', reject); imap.connect(); }); }
app.get('/api/emails', async (req, res) => { try { const rawEmails = await getRawEmailsFromImap(); const documentsCollection = db.collection('processed_documents'); const tasksCollection = db.collection('tasks'); for (const email of rawEmails) { const existingDoc = await documentsCollection.findOne({ "original_email.subject": email.subject, "original_email.date": email.date }); if (existingDoc) { continue; } const aiData = await processEmailWithAI(email); if (aiData) { const newDocument = { original_email: email, ai_analysis: aiData, createdAt: new Date() }; const insertResult = await documentsCollection.insertOne(newDocument); const newDocId = insertResult.insertedId; if (aiData.suggested_action_roles && aiData.suggested_action_roles.length > 0) { for (const role of aiData.suggested_action_roles) { const newTask = { assigned_to_role: role, title: email.subject || aiData.classification.join(', '), description: aiData.extracted_action || aiData.details, status: "Pending", source_document_id: newDocId, createdAt: new Date() }; await tasksCollection.insertOne(newTask); } } } } const allProcessedDocs = await documentsCollection.find().sort({ createdAt: -1 }).toArray(); res.json(allProcessedDocs); } catch (error) { console.error("[ERROR] API Error in /api/emails:", error.message); res.status(500).json({ error: 'Failed to fetch and process emails.' }); } });


// --- Live Metro Status Endpoint ---
app.get('/api/live-status', (req, res) => {
    try {
        const now = new Date();
        const simulatedNow = new Date(now);
        simulatedNow.setHours(10, 15, 0); 
        
        const dayIndex = simulatedNow.getDay();
        const dayMap = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const currentDay = dayMap[dayIndex];

        const activeService = gtfsData.calendar.find(c => c[currentDay] === '1');
        if (!activeService) {
            return res.json([]);
        }
        const activeServiceId = activeService.service_id;

        const activeTrips = [];
        gtfsData.trips.forEach((trip, tripId) => {
            if (trip.service_id === activeServiceId) {
                const stopTimesForTrip = gtfsData.stopTimes.filter(st => st.trip_id === tripId);
                if (stopTimesForTrip.length > 0) {
                    activeTrips.push({
                        tripId: tripId,
                        directionId: trip.direction_id,
                        stopTimes: stopTimesForTrip.sort((a, b) => parseInt(a.stop_sequence) - parseInt(b.stop_sequence))
                    });
                }
            }
        });
        
        const currentTimeStr = simulatedNow.toTimeString().slice(0, 8);
        const liveStatuses = [];

        for (const trip of activeTrips) {
            const firstStopTime = trip.stopTimes[0];
            const lastStopTime = trip.stopTimes[trip.stopTimes.length - 1];

            if (currentTimeStr < firstStopTime.departure_time || currentTimeStr > lastStopTime.arrival_time) {
                continue;
            }

            let status = 'In Transit';
            let lastStation = null, nextStation = null;
            let progress = 0;

            for (let i = 0; i < trip.stopTimes.length; i++) {
                const currentStop = trip.stopTimes[i];
                if (currentTimeStr >= currentStop.arrival_time && currentTimeStr <= currentStop.departure_time) {
                    status = 'At Station';
                    lastStation = i > 0 ? trip.stopTimes[i - 1] : null;
                    nextStation = currentStop;
                    break;
                }
                if (currentTimeStr < currentStop.arrival_time) {
                    lastStation = i > 0 ? trip.stopTimes[i - 1] : firstStopTime;
                    nextStation = currentStop;
                    break;
                }
            }
            
            if (nextStation) {
                progress = (parseInt(nextStation.stop_sequence) - 1) / (trip.stopTimes.length - 1) * 100;
            }

            const fromStation = gtfsData.stops.get(firstStopTime.stop_id);
            const toStation = gtfsData.stops.get(lastStopTime.stop_id);

            liveStatuses.push({
                tripId: trip.tripId,
                direction: `Towards ${toStation.stop_name}`,
                status: status,
                lastStation: lastStation ? { name: gtfsData.stops.get(lastStation.stop_id).stop_name, time: lastStation.departure_time } : {name: "Start of Line"},
                nextStation: nextStation ? { name: gtfsData.stops.get(nextStation.stop_id).stop_name, time: nextStation.arrival_time } : {name: "End of Line"},
                progress: Math.round(progress),
                totalStops: trip.stopTimes.length
            });
        }
        
        res.json(liveStatuses);

    } catch (error) {
        console.error("[ERROR] API Error in /api/live-status:", error);
        res.status(500).json({ error: 'Failed to calculate live train status.' });
    }
});


// --- Server Start ---
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server with AI and GTFS listening at http://localhost:${PORT}`);
});