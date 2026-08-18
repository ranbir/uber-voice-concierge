require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_LIVE_BASE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'uber-voice-concierge-secret-key-2026';
const COOKIE_NAME = 'uber_concierge_auth';

// Allowed email whitelist (comma-separated list, e.g. "user1@example.com,user2@example.com")
const RAW_ALLOWED_EMAILS = process.env.ALLOWED_EMAILS || '';
const ALLOWED_EMAILS = RAW_ALLOWED_EMAILS.split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

const app = express();
app.use(cookieParser());
app.use(express.json());

// Helper: Determine public base URL
function getBaseUrl(req) {
    if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

// Helper: Create OAuth client
function getOAuthClient(req) {
    const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
    return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

// Helper: Verify session token from cookie
function verifySessionToken(token) {
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, SESSION_SECRET);
        const email = (decoded.email || '').toLowerCase();
        if (ALLOWED_EMAILS.length === 0 || ALLOWED_EMAILS.includes(email)) {
            return decoded;
        }
        return { ...decoded, unauthorized: true };
    } catch (err) {
        return null;
    }
}

// 1. Health Check (Always public for Cloud Run probes)
app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok', time: new Date().toISOString() });
});

// 2. Auth Status & Current User Info
app.get('/api/me', (req, res) => {
    const token = req.cookies[COOKIE_NAME];
    const user = verifySessionToken(token);
    if (!user || user.unauthorized) {
        return res.status(401).json({ authenticated: false });
    }
    res.json({
        authenticated: true,
        email: user.email,
        name: user.name,
        picture: user.picture
    });
});

// 3. Initiate Google OAuth Login
app.get('/auth/login', (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return res.status(500).send(`
            <div style="font-family: sans-serif; max-width: 600px; margin: 50px auto; padding: 24px; border: 1px solid #e0e0e0; border-radius: 12px;">
                <h2>⚙️ OAuth Configuration Required</h2>
                <p>Google OAuth is not yet configured. Please set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> environment variables on Cloud Run.</p>
                <p><strong>Whitelisted Emails:</strong> ${ALLOWED_EMAILS.join(', ')}</p>
            </div>
        `);
    }

    const oauth2Client = getOAuthClient(req);
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        prompt: 'select_account'
    });

    res.redirect(authUrl);
});

// 4. Google OAuth Callback
app.get('/auth/google/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error) {
        return res.status(400).send(`Google Login Error: ${error}`);
    }
    if (!code) {
        return res.redirect('/auth/login');
    }

    try {
        const oauth2Client = getOAuthClient(req);
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        const ticket = await oauth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();
        const email = (payload.email || '').toLowerCase();
        const name = payload.name || email;
        const picture = payload.picture || '';

        // Whitelist validation
        const isAllowed = ALLOWED_EMAILS.length === 0 || ALLOWED_EMAILS.includes(email);

        if (!isAllowed) {
            console.warn(`[AUTH REJECTED] ${email} is not in whitelist: ${ALLOWED_EMAILS.join(', ')}`);
            return res.status(403).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Access Restricted</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                        .card { background: white; padding: 40px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); max-width: 440px; width: 90%; text-align: center; }
                        .avatar { width: 64px; height: 64px; border-radius: 50%; margin-bottom: 16px; border: 2px solid #e0e0e0; }
                        .badge { background: #fee2e2; color: #dc2626; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; display: inline-block; margin-bottom: 16px; }
                        h2 { margin: 0 0 8px; color: #111827; font-size: 22px; }
                        p { color: #6b7280; font-size: 14px; line-height: 1.5; margin: 0 0 24px; }
                        .btn { background: #000; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block; }
                        .btn:hover { background: #333; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        ${picture ? `<img src="${picture}" class="avatar" alt="Avatar">` : ''}
                        <div class="badge">Access Denied</div>
                        <h2>Unauthorized Account</h2>
                        <p>You signed in as <strong>${email}</strong>. This account is not authorized to access the Uber Voice Concierge demo.</p>
                        <a href="/auth/login" class="btn">Sign in with a different account</a>
                    </div>
                </body>
                </html>
            `);
        }

        // Generate signed JWT session token (7-day validity)
        const sessionToken = jwt.sign(
            { email, name, picture },
            SESSION_SECRET,
            { expiresIn: '7d' }
        );

        // Set secure HTTP-only cookie
        res.cookie(COOKIE_NAME, sessionToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        console.log(`[AUTH SUCCESS] User ${email} authorized and logged in.`);
        res.redirect('/');
    } catch (err) {
        console.error('[AUTH ERROR] Token exchange failed:', err);
        res.status(500).send(`Authentication failed: ${err.message}. <a href="/auth/login">Try again</a>`);
    }
});

// 5. Logout
app.get('/auth/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME);
    res.redirect('/auth/login');
});

// 6. Protect Static Web Application Routes
app.use((req, res, next) => {
    // If OAuth is configured, enforce login check
    if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
        const token = req.cookies[COOKIE_NAME];
        const user = verifySessionToken(token);

        if (!user || user.unauthorized) {
            return res.redirect('/auth/login');
        }
        req.user = user;
    }
    next();
});

// Serve static assets (HTML, CSS, JS)
app.use(express.static(path.resolve(__dirname)));

// Fallback to index.html
app.get('*', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'index.html'));
});

const server = http.createServer(app);

// Dedicated WebSocket server for /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs, req) => {
    // 1. Verify WebSocket Authentication
    if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
        const cookieHeader = req.headers.cookie || '';
        const cookies = require('cookie').parse ? require('cookie').parse(cookieHeader) : parseCookies(cookieHeader);
        const token = cookies[COOKIE_NAME];
        const user = verifySessionToken(token);

        if (!user || user.unauthorized) {
            console.warn('[PROXY WS] Unauthorized WebSocket connection attempt blocked.');
            clientWs.send(JSON.stringify({
                error: { message: 'Unauthorized: Google Sign-In with whitelisted email is required.' }
            }));
            clientWs.close(1008, 'Unauthorized');
            return;
        }

        console.log(`[PROXY WS] Authorized WebSocket connection for: ${user.email}`);
    } else {
        console.log('[PROXY WS] Connected (Auth bypass mode - no Client ID set)');
    }

    if (!GEMINI_API_KEY) {
        console.error('[PROXY ERROR] GEMINI_API_KEY environment variable is not set!');
        clientWs.send(JSON.stringify({
            error: { message: 'Server error: GEMINI_API_KEY is not configured.' }
        }));
        clientWs.close(1011, 'Missing API Key');
        return;
    }

    // 2. Connect upstream to Gemini Live
    const upstreamUrl = `${GEMINI_LIVE_BASE_URL}?key=${GEMINI_API_KEY}`;
    const upstreamWs = new WebSocket(upstreamUrl);

    const messageQueue = [];
    let isUpstreamOpen = false;

    upstreamWs.on('open', () => {
        isUpstreamOpen = true;
        console.log('[PROXY] Upstream Gemini Live connection established.');

        while (messageQueue.length > 0) {
            const { data, isBinary } = messageQueue.shift();
            upstreamWs.send(data, { binary: isBinary });
        }
    });

    upstreamWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary });
        }
        try {
            const text = (data instanceof Buffer || data instanceof ArrayBuffer) ? data.toString('utf8') : data;
            if (typeof text === 'string') {
                if (text.includes('generationStarted') || text.includes('generation_started')) console.log('[GEMINI] generationStarted');
                if (text.includes('turnComplete') || text.includes('turn_complete')) console.log('[GEMINI] turnComplete');
                if (text.includes('interrupted')) console.log('[GEMINI] interrupted (barge-in)');
                if (text.includes('error')) console.warn('[GEMINI WARNING]', text.slice(0, 250));
            }
        } catch (e) {}
    });

    upstreamWs.on('error', (err) => {
        console.error('[PROXY] Upstream Gemini Live error:', err.message);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({
                error: { message: `Upstream error: ${err.message}` }
            }));
            clientWs.close(1011, 'Upstream Error');
        }
    });

    // Keep-alive heartbeat to prevent intermediate proxy / Cloud Run idle timeouts
    const pingInterval = setInterval(() => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.ping();
        }
        if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.ping();
        }
    }, 15000);

    const cleanup = () => {
        clearInterval(pingInterval);
        if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
            upstreamWs.close();
        }
    };

    let clientAudioCount = 0;
    clientWs.on('message', (data, isBinary) => {
        if (isUpstreamOpen && upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(data, { binary: isBinary });
        } else {
            messageQueue.push({ data, isBinary });
        }

        try {
            const str = (data instanceof Buffer || data instanceof ArrayBuffer) ? data.toString('utf8') : data;
            if (typeof str === 'string') {
                if (str.includes('setup')) {
                    console.log(`[CLIENT WS] Setup message forwarded to Gemini.`);
                } else if (str.includes('realtimeInput')) {
                    clientAudioCount++;
                    if (clientAudioCount === 1 || clientAudioCount % 200 === 0) {
                        console.log(`[CLIENT WS] Audio streaming (packets: ${clientAudioCount}).`);
                    }
                }
            }
        } catch (e) {}
    });

    clientWs.on('error', (err) => {
        console.error('[PROXY] Client error:', err.message);
        cleanup();
    });

    clientWs.on('close', () => {
        cleanup();
    });

    upstreamWs.on('close', (code, reason) => {
        cleanup();
        const reasonStr = reason ? reason.toString() : '';
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reasonStr);
        }
    });
});

// Helper for cookie parsing if cookie package isn't loaded
function parseCookies(cookieStr) {
    const list = {};
    if (!cookieStr) return list;
    cookieStr.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
    return list;
}

server.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(` Uber Voice Concierge Server (Google SSO)    `);
    console.log(` Listening on port: ${PORT}                  `);
    console.log(` Local URL: http://localhost:${PORT}        `);
    console.log(` Auth Mode: ${GOOGLE_CLIENT_ID ? 'Enforced (Google OAuth 2.0)' : 'Open (No Client ID)'}`);
    console.log(` Allowed Whitelist: ${ALLOWED_EMAILS.join(', ') || 'ALL'}`);
    console.log(` API Key Status: ${GEMINI_API_KEY ? 'Configured (Active)' : 'MISSING'}`);
    console.log(`=============================================`);
});
