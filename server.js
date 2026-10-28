// server.js - Express app, security middleware, MongoDB connection and first-admin setup
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { api } from './api.js';
import { User } from './models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PORT = 5000, MONGODB_URI, JWT_SECRET, CLIENT_ORIGIN = 'http://localhost:5173', ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

/* ------------------------------------------------------------------ */
/* 1. Required configuration - stop early with a clear message         */
/* ------------------------------------------------------------------ */
const problems = [];
if (!MONGODB_URI) problems.push('MONGODB_URI is missing.');
if (!JWT_SECRET) problems.push('JWT_SECRET is missing.');
else if (JWT_SECRET.length < 32 || JWT_SECRET.startsWith('replace-with'))
  problems.push('JWT_SECRET must be a random string of at least 32 characters (not the placeholder).');
if (problems.length) {
  console.error('\nConfiguration error:\n  - ' + problems.join('\n  - '));
  console.error('\nCopy .env.example to .env and fill in the values. See the setup guide.\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 2. Express app + security middleware                                */
/* ------------------------------------------------------------------ */
const app = express();
app.disable('x-powered-by');
// Secure HTTP headers. "upgrade-insecure-requests" is switched off so the built app
// also works over plain http://localhost (it is safe to keep on behind HTTPS in production).
app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': null } } }));
app.use(cors({ origin: CLIENT_ORIGIN.split(',').map((o) => o.trim()) }));
app.use(express.json({ limit: '50kb' })); // small body limit blocks oversized payloads
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));

app.use('/api', api);

// If the React app has been built (npm run build), serve it from this same server.
const dist = path.join(__dirname, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// Central error handler: logs details on the server, returns a safe message to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Invalid JSON in request body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Request is too large.' });
  if (err.name === 'ValidationError') return res.status(400).json({ success: false, message: 'Invalid data submitted.' });
  if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid identifier.' });
  console.error(err);
  return res.status(500).json({ success: false, message: 'Something went wrong on the server.' });
});

/* ------------------------------------------------------------------ */
/* 3. First admin (one-time, secure setup)                             */
/* ------------------------------------------------------------------ */
// Runs after the database connects. It ONLY creates an admin when:
//   - ADMIN_EMAIL and ADMIN_PASSWORD are set in .env, and
//   - no admin exists yet.
// Nobody can reach this through the website. Remove ADMIN_PASSWORD from .env afterwards.
async function seedAdmin() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  if (await User.exists({ role: 'admin' })) return;

  const email = ADMIN_EMAIL.trim().toLowerCase();
  if (ADMIN_PASSWORD.length < 10 || ADMIN_PASSWORD.startsWith('replace-with')) {
    console.warn('Admin not created: ADMIN_PASSWORD must be at least 10 characters (and not the placeholder).');
    return;
  }
  if (await User.exists({ email })) {
    console.warn(`Admin not created: ${email} is already registered as a regular user. Use a different ADMIN_EMAIL.`);
    return;
  }
  await User.create({
    name: (ADMIN_NAME || 'Administrator').trim(),
    email,
    passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
    role: 'admin',
  });
  console.log(`First admin created: ${email}`);
  console.log('Now delete ADMIN_PASSWORD from your .env file.');
}

/* ------------------------------------------------------------------ */
/* 4. MongoDB connection (retries instead of crashing)                 */
/* ------------------------------------------------------------------ */
async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log('MongoDB connected.');
    await seedAdmin();
  } catch (err) {
    console.error(`MongoDB connection failed: ${err.message}`);
    console.error('Retrying in 5 seconds. API routes return 503 until the database is available.');
    setTimeout(connectDB, 5000);
  }
}

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
  connectDB();
});
