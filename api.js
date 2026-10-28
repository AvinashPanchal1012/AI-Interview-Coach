// api.js - All REST routes, auth middleware and the rule-based feedback engine
import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { User, Interview, CATEGORIES, DIFFICULTIES } from './models.js';

export const api = express.Router();

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
// Consistent JSON responses: { success, data } or { success:false, message, errors? }
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, status, message, errors) =>
  res.status(status).json({ success: false, message, ...(errors ? { errors } : {}) });

// Lets async route handlers throw errors that reach the central error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Accept only strings, trim and cap the length. Anything else becomes ''.
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const isId = (id) => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Remove keys such as "$gt" or "a.b" from request data (NoSQL operator injection).
const clean = (obj) => {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      if (key.startsWith('$') || key.includes('.')) delete obj[key];
      else clean(obj[key]);
    }
  }
  return obj;
};
api.use((req, _res, next) => {
  clean(req.body);
  clean(req.query);
  next();
});

// Public health check (also tells the frontend whether MongoDB is connected).
const DB_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];
api.get('/health', (_req, res) =>
  ok(res, { status: 'ok', database: DB_STATES[mongoose.connection.readyState] || 'unknown' })
);

// Every other route needs MongoDB. Give a clear message instead of hanging.
api.use((_req, res, next) => {
  if (mongoose.connection.readyState === 1) return next();
  return fail(res, 503, 'The database is not connected. Check MONGODB_URI and that MongoDB is running.');
});

// Stricter limit for login/register to slow down password guessing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a few minutes.' },
});

/* ------------------------------------------------------------------ */
/* Authentication middleware                                           */
/* ------------------------------------------------------------------ */
const signToken = (user) =>
  jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

// Verifies the Bearer token, then loads the user FROM THE DATABASE so that the
// role and isActive flag are always current (a token can never grant admin rights).
const auth = wrap(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 401, 'Authentication required.');

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return fail(res, 401, 'Your session has expired or is invalid. Please log in again.');
  }

  const user = await User.findById(payload.id);
  if (!user) return fail(res, 401, 'This account no longer exists.');
  if (!user.isActive) return fail(res, 403, 'This account has been deactivated.');
  req.user = user;
  return next();
});

const adminOnly = (req, res, next) =>
  req.user?.role === 'admin' ? next() : fail(res, 403, 'Administrator access is required.');

/* ------------------------------------------------------------------ */
/* Auth routes                                                         */
/* ------------------------------------------------------------------ */
// A fake hash used so login takes the same time whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

api.post(
  '/auth/register',
  authLimiter,
  wrap(async (req, res) => {
    // NOTE: "role" is deliberately ignored. Public sign-ups are always regular users.
    const name = str(req.body.name, 60);
    const email = str(req.body.email, 120).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

    const errors = {};
    if (name.length < 2) errors.name = 'Name must be at least 2 characters.';
    if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.';
    if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
      errors.password = 'Password must be 8-72 characters and include a letter and a number.';
    if (confirmPassword !== password) errors.confirmPassword = 'Passwords do not match.';
    if (Object.keys(errors).length) return fail(res, 400, 'Please fix the highlighted fields.', errors);

    if (await User.exists({ email }))
      return fail(res, 409, 'An account with this email already exists.', { email: 'This email is already registered.' });

    const passwordHash = await bcrypt.hash(password, 12);
    let user;
    try {
      user = await User.create({ name, email, passwordHash, role: 'user' });
    } catch (err) {
      // Two simultaneous sign-ups: the unique index catches the second one.
      if (err.code === 11000)
        return fail(res, 409, 'An account with this email already exists.', { email: 'This email is already registered.' });
      throw err;
    }
    return ok(res, { token: signToken(user), user }, 201);
  })
);

api.post(
  '/auth/login',
  authLimiter,
  wrap(async (req, res) => {
    const email = str(req.body.email, 120).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!EMAIL_RE.test(email) || !password) return fail(res, 400, 'Email and password are required.');

    const user = await User.findOne({ email }).select('+passwordHash');
    const match = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !match) return fail(res, 401, 'Invalid email or password.');
    if (!user.isActive) return fail(res, 403, 'This account has been deactivated. Contact an administrator.');

    return ok(res, { token: signToken(user), user });
  })
);

api.get('/auth/me', auth, (req, res) => ok(res, { user: req.user }));

/* ------------------------------------------------------------------ */
/* Question bank + rule-based feedback engine                          */
/* ------------------------------------------------------------------ */
// Each entry: [question text, keywords a good answer usually mentions]
const BANK = {
  technical: {
    beginner: [
      ['What is the difference between var, let and const in JavaScript?', ['scope', 'hoist', 'reassign', 'block', 'function', 'constant']],
      ['Explain what an API is and give a simple example.', ['request', 'response', 'http', 'endpoint', 'data', 'client', 'server', 'json']],
      ['What is the difference between an array and an object?', ['index', 'key', 'value', 'order', 'list', 'property', 'collection']],
      ['What does a database index do, and why is it useful?', ['fast', 'search', 'query', 'lookup', 'performance', 'column', 'slow', 'write']],
    ],
    intermediate: [
      ['How does the event loop work in JavaScript?', ['call stack', 'callback', 'queue', 'async', 'single', 'thread', 'promise', 'microtask']],
      ['Explain the difference between SQL and NoSQL databases.', ['schema', 'relational', 'document', 'scale', 'join', 'flexible', 'transaction', 'query']],
      ['What is REST and what makes an API RESTful?', ['stateless', 'http', 'resource', 'get', 'post', 'url', 'status', 'json']],
      ['How would you debug a slow web page?', ['network', 'profil', 'cache', 'bundle', 'image', 'lighthouse', 'render', 'measure']],
    ],
    advanced: [
      ['How would you design a URL shortener that handles millions of requests?', ['hash', 'database', 'cache', 'scale', 'collision', 'load balancer', 'redirect', 'availability']],
      ['Explain how you would secure a JWT-based authentication system.', ['expire', 'secret', 'https', 'refresh', 'hash', 'storage', 'revoke', 'xss']],
      ['Describe strategies to scale a Node.js application horizontally.', ['load balancer', 'cluster', 'stateless', 'cache', 'queue', 'database', 'container', 'monitor']],
      ['What are race conditions, and how can you prevent them?', ['concurrent', 'lock', 'atomic', 'transaction', 'shared', 'mutex', 'queue', 'idempoten']],
    ],
  },
  hr: {
    beginner: [
      ['Tell me about yourself.', ['experience', 'skills', 'background', 'education', 'goal', 'interest', 'strength', 'project']],
      ['Why do you want to work for our company?', ['company', 'mission', 'values', 'role', 'growth', 'contribute', 'product', 'culture']],
      ['What are your greatest strengths?', ['strength', 'example', 'team', 'skill', 'learn', 'result', 'reliable', 'communicat']],
      ['Where do you see yourself in five years?', ['grow', 'goal', 'skills', 'lead', 'learn', 'contribute', 'career', 'role']],
    ],
    intermediate: [
      ['What is your biggest weakness, and how are you working on it?', ['weakness', 'improve', 'learn', 'feedback', 'example', 'progress', 'course', 'practice']],
      ['Why are you leaving your current role (or why did you leave your last one)?', ['growth', 'opportunity', 'learn', 'challenge', 'positive', 'team', 'career', 'skills']],
      ['What salary range are you expecting, and how did you arrive at it?', ['research', 'market', 'experience', 'range', 'flexible', 'benefits', 'value', 'skills']],
      ['How do you handle work-life balance and stress?', ['priorit', 'schedule', 'boundar', 'exercise', 'communicat', 'break', 'plan', 'deadline']],
    ],
    advanced: [
      ['Why should we hire you over other candidates?', ['value', 'experience', 'result', 'skills', 'contribute', 'unique', 'team', 'impact']],
      ['Describe the work culture where you do your best work.', ['collaborat', 'feedback', 'autonomy', 'communicat', 'learn', 'transparen', 'team', 'respect']],
      ['How do you evaluate a job offer beyond salary?', ['growth', 'culture', 'mentor', 'impact', 'team', 'learning', 'balance', 'values']],
      ['What would you do in your first 90 days in this role?', ['learn', 'listen', 'goals', 'stakeholder', 'plan', 'relationship', 'quick win', 'feedback']],
    ],
  },
  behavioral: {
    beginner: [
      ['Tell me about a time you worked well in a team.', ['team', 'goal', 'role', 'communicat', 'result', 'collaborat', 'together', 'achieved']],
      ['Describe a time you had to learn something quickly.', ['learn', 'deadline', 'resource', 'practice', 'ask', 'result', 'apply', 'time']],
      ['Tell me about a mistake you made and what you learned.', ['mistake', 'responsib', 'fix', 'learn', 'prevent', 'communicat', 'result', 'improve']],
      ['Give an example of a goal you set and achieved.', ['goal', 'plan', 'steps', 'progress', 'deadline', 'result', 'achieved', 'measure']],
    ],
    intermediate: [
      ['Describe a time you disagreed with a teammate. How did you resolve it?', ['listen', 'perspective', 'compromise', 'communicat', 'respect', 'resolve', 'goal', 'result']],
      ['Tell me about a time you managed several tasks with competing deadlines.', ['priorit', 'deadline', 'plan', 'schedule', 'communicat', 'delegat', 'result', 'stakeholder']],
      ['Describe a situation where you received critical feedback.', ['feedback', 'listen', 'improve', 'action', 'learn', 'thank', 'change', 'result']],
      ['Tell me about a time you took initiative without being asked.', ['initiative', 'noticed', 'proposed', 'owner', 'plan', 'result', 'impact', 'team']],
    ],
    advanced: [
      ['Describe a time you led a team through a difficult challenge.', ['lead', 'motivat', 'plan', 'delegat', 'communicat', 'risk', 'result', 'support']],
      ['Tell me about a decision you made with incomplete information.', ['data', 'risk', 'assum', 'decision', 'stakeholder', 'outcome', 'trade', 'learn']],
      ['Describe a time you influenced others without formal authority.', ['influence', 'stakeholder', 'listen', 'evidence', 'trust', 'persuad', 'align', 'result']],
      ['Tell me about a project that failed. What would you do differently?', ['fail', 'root cause', 'learn', 'responsib', 'lesson', 'change', 'process', 'improve']],
    ],
  },
};

const CATEGORY_INFO = {
  technical: { label: 'Technical', description: 'Programming concepts, web development, databases and system design.' },
  hr: { label: 'HR', description: 'Motivation, career goals, expectations and culture fit.' },
  behavioral: { label: 'Behavioral', description: 'Real examples of teamwork, conflict, leadership and learning.' },
};

// Scores one answer out of 100 using four simple, transparent checks:
//   depth (30) + relevant keywords (40) + structure (20) + clarity (10)
// This is NOT an AI language model - it only looks at length, keywords and structure.
function evaluate(keys, answer, category) {
  const text = answer.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const strengths = [];
  const improvements = [];

  if (words.length === 0) {
    return { score: 0, strengths, improvements: ['This question was skipped. Even a short answer gives you something to improve.'] };
  }
  const lower = text.toLowerCase();

  // 1) Depth: 60+ words earns full marks
  const depth = Math.round(Math.min(words.length / 60, 1) * 30);
  if (words.length >= 40) strengths.push('Your answers had good depth.');
  else improvements.push(`Some answers were short (${words.length} words). Aim for 50+ words with detail.`);

  // 2) Keywords: concepts a strong answer normally mentions
  const matched = keys.filter((k) => lower.includes(k));
  const needed = Math.max(2, Math.ceil(keys.length * 0.6));
  const keyword = Math.round(Math.min(matched.length / needed, 1) * 40);
  if (matched.length >= needed) strengths.push('You covered the key concepts for the question.');
  else {
    const missing = keys.filter((k) => !matched.includes(k)).slice(0, 3).join(', ');
    improvements.push(`Mention more relevant concepts, for example: ${missing}.`);
  }

  // 3) Structure: STAR method for behavioral, linked sentences for everything else
  let structure = 0;
  if (category === 'behavioral') {
    const star = [
      /situation|when i|at my|during|once|last (year|month)|project/, // Situation
      /task|responsible|goal|needed to|had to|objective/, // Task
      /\bi (decided|built|led|created|implemented|organi[sz]ed|talked|spoke|proposed|started|took|worked|wrote|asked|prioriti[sz]ed|suggested)/, // Action
      /result|outcome|achieved|improved|reduced|increased|learned|successful|delivered/, // Result
    ];
    const hits = star.filter((r) => r.test(lower)).length;
    structure = hits * 5;
    if (hits >= 3) strengths.push('Good use of the STAR structure (Situation, Task, Action, Result).');
    else improvements.push('Use the STAR method: describe the Situation, Task, your Action and the Result.');
  } else {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 3).length;
    const linked = /because|for example|for instance|therefore|however|such as|in practice|which means/.test(lower);
    structure = Math.min(sentences, 3) * 4 + (linked ? 8 : 0);
    if (structure >= 16) strengths.push('Clear, well-organised explanations with examples or reasoning.');
    else improvements.push('Explain your reasoning and add an example ("for example", "because").');
  }

  // 4) Clarity: filler words reduce the score
  const fillers = (lower.match(/\b(um+|uh+|basically|you know|kind of|sort of|i guess)\b/g) || []).length;
  const clarity = Math.max(0, 10 - fillers * 2);
  if (fillers >= 3) improvements.push('Reduce filler words such as "basically", "you know" and "kind of".');

  return { score: Math.min(100, depth + keyword + structure + clarity), strengths, improvements };
}

// Combines the per-question results into one overall feedback block.
function summarise(items, score) {
  const band = score >= 80 ? 'Excellent performance' : score >= 60 ? 'Good job' : score >= 40 ? 'Fair attempt' : 'Needs more practice';
  const answered = items.filter((i) => i.answer).length;
  const top = (key) => {
    const counts = new Map();
    items.forEach((i) => i[key].forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  };
  const strengths = top('strengths');
  const improvements = top('improvements');
  return {
    engine: 'rule-based',
    engineLabel: 'Rule-based feedback engine: checks answer length, keywords, structure and filler words. This is not an AI language model.',
    summary: `${band}. You answered ${answered} of ${items.length} questions and scored ${score}/100.`,
    strengths: strengths.length ? strengths : ['Keep practising: consistency builds confident answers.'],
    improvements: improvements.length ? improvements : ['No major issues found by the rule-based checks.'],
  };
}

/* ------------------------------------------------------------------ */
/* Interview routes                                                    */
/* ------------------------------------------------------------------ */
// With no query: returns the available categories/difficulties.
// With ?category=&difficulty=: returns that question set (keywords are never sent to the browser).
api.get('/interviews/questions', auth, (req, res) => {
  const category = str(req.query.category, 20).toLowerCase();
  const difficulty = str(req.query.difficulty, 20).toLowerCase();

  if (!category && !difficulty) {
    return ok(res, {
      categories: CATEGORIES.map((id) => ({ id, ...CATEGORY_INFO[id], questionCount: BANK[id].beginner.length })),
      difficulties: DIFFICULTIES,
    });
  }
  if (!CATEGORIES.includes(category) || !DIFFICULTIES.includes(difficulty))
    return fail(res, 400, 'Provide a valid category and difficulty.');

  const questions = BANK[category][difficulty].map(([question], id) => ({ id, question }));
  return ok(res, { category, difficulty, questions });
});

api.post(
  '/interviews',
  auth,
  wrap(async (req, res) => {
    const category = str(req.body.category, 20).toLowerCase();
    const difficulty = str(req.body.difficulty, 20).toLowerCase();
    if (!CATEGORIES.includes(category) || !DIFFICULTIES.includes(difficulty))
      return fail(res, 400, 'Choose a valid category and difficulty.');

    const { answers } = req.body;
    const set = BANK[category][difficulty];
    if (!Array.isArray(answers) || answers.length === 0 || answers.length > set.length)
      return fail(res, 400, 'Submit your answers as a list.');

    const byId = new Map();
    for (const a of answers) {
      const id = Number(a?.id);
      if (!Number.isInteger(id) || id < 0 || id >= set.length || byId.has(id))
        return fail(res, 400, 'One of the submitted question ids is invalid.');
      byId.set(id, str(a.answer, 3000));
    }
    if (![...byId.values()].some(Boolean)) return fail(res, 400, 'Answer at least one question before submitting.');

    // Questions come from the server's bank (by id), so the client cannot tamper with them.
    const items = set.map(([question, keys], id) => {
      const answer = byId.get(id) || '';
      const r = evaluate(keys, answer, category);
      return { question, answer, score: r.score, strengths: r.strengths, improvements: r.improvements };
    });
    const score = Math.round(items.reduce((sum, i) => sum + i.score, 0) / items.length);
    const interview = await Interview.create({
      userId: req.user._id,
      category,
      difficulty,
      items,
      feedback: summarise(items, score),
      score,
    });
    return ok(res, interview, 201);
  })
);

// Defined BEFORE /interviews/:id so "history" is not treated as an id.
api.get(
  '/interviews/history',
  auth,
  wrap(async (req, res) => {
    const list = await Interview.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .select('category difficulty score createdAt items.question')
      .lean();
    return ok(res, {
      interviews: list.map((i) => ({
        _id: i._id,
        category: i.category,
        difficulty: i.difficulty,
        score: i.score,
        createdAt: i.createdAt,
        questionCount: i.items.length,
      })),
    });
  })
);

api.get(
  '/interviews/:id',
  auth,
  wrap(async (req, res) => {
    if (!isId(req.params.id)) return fail(res, 400, 'Invalid interview id.');
    // Filtering by userId means users can only open their own sessions.
    const interview = await Interview.findOne({ _id: req.params.id, userId: req.user._id });
    if (!interview) return fail(res, 404, 'Interview not found.');
    return ok(res, interview);
  })
);

/* ------------------------------------------------------------------ */
/* User routes                                                         */
/* ------------------------------------------------------------------ */
api.get(
  '/users/profile',
  auth,
  wrap(async (req, res) => {
    const totalInterviews = await Interview.countDocuments({ userId: req.user._id });
    return ok(res, { user: req.user, stats: { totalInterviews, memberSince: req.user.createdAt } });
  })
);

api.get(
  '/users/dashboard',
  auth,
  wrap(async (req, res) => {
    const userId = req.user._id;
    const [totals, byCategory, recent, last10] = await Promise.all([
      Interview.aggregate([
        { $match: { userId } },
        { $group: { _id: null, total: { $sum: 1 }, avg: { $avg: '$score' }, best: { $max: '$score' } } },
      ]),
      Interview.aggregate([
        { $match: { userId } },
        { $group: { _id: '$category', count: { $sum: 1 }, avg: { $avg: '$score' } } },
      ]),
      Interview.find({ userId }).sort({ createdAt: -1 }).limit(5).select('category difficulty score createdAt').lean(),
      Interview.find({ userId }).sort({ createdAt: -1 }).limit(10).select('score').lean(),
    ]);
    const t = totals[0] || { total: 0, avg: 0, best: 0 };
    return ok(res, {
      totalInterviews: t.total,
      averageScore: Math.round(t.avg || 0),
      bestScore: t.best || 0,
      latestScore: recent[0]?.score ?? null,
      byCategory: byCategory.map((c) => ({ category: c._id, count: c.count, avg: Math.round(c.avg) })),
      recent,
      trend: last10.map((i) => i.score).reverse(), // oldest -> newest
    });
  })
);

/* ------------------------------------------------------------------ */
/* Admin routes (server-side role check on EVERY route below)         */
/* ------------------------------------------------------------------ */
api.use('/admin', auth, adminOnly);

api.get(
  '/admin/stats',
  wrap(async (_req, res) => {
    // Last 7 days in UTC, oldest first
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - 6);

    const [totalUsers, activeUsers, totalAdmins, totalSessions, avg, byCategory, daily, recent] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ isActive: true }),
      User.countDocuments({ role: 'admin', isActive: true }),
      Interview.countDocuments(),
      Interview.aggregate([{ $group: { _id: null, avg: { $avg: '$score' } } }]),
      Interview.aggregate([{ $group: { _id: '$category', count: { $sum: 1 }, avg: { $avg: '$score' } } }]),
      Interview.aggregate([
        { $match: { createdAt: { $gte: start } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      ]),
      Interview.find().sort({ createdAt: -1 }).limit(8).select('userId category difficulty score createdAt').populate('userId', 'name email').lean(),
    ]);

    const dailyMap = new Map(daily.map((d) => [d._id, d.count]));
    const activity = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      return { date: key, count: dailyMap.get(key) || 0 };
    });

    return ok(res, {
      totalUsers,
      activeUsers,
      inactiveUsers: totalUsers - activeUsers,
      totalAdmins,
      totalSessions,
      averageScore: Math.round(avg[0]?.avg || 0),
      byCategory: CATEGORIES.map((c) => {
        const row = byCategory.find((x) => x._id === c);
        return { category: c, count: row?.count || 0, avg: Math.round(row?.avg || 0) };
      }),
      activity,
      recentSessions: recent.map((s) => ({
        _id: s._id,
        user: s.userId ? { name: s.userId.name, email: s.userId.email } : null,
        category: s.category,
        difficulty: s.difficulty,
        score: s.score,
        createdAt: s.createdAt,
      })),
    });
  })
);

api.get(
  '/admin/users',
  wrap(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const filter = {};
    const search = str(req.query.search, 60);
    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i'); // escaped, so it cannot be abused as a regex
      filter.$or = [{ name: rx }, { email: rx }];
    }
    const status = str(req.query.status, 10);
    if (status === 'active') filter.isActive = true;
    if (status === 'inactive') filter.isActive = false;
    const role = str(req.query.role, 10);
    if (role === 'user' || role === 'admin') filter.role = role;

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    ]);

    // Add session counts + average score for the users on this page
    const stats = await Interview.aggregate([
      { $match: { userId: { $in: users.map((u) => u._id) } } },
      { $group: { _id: '$userId', sessions: { $sum: 1 }, avgScore: { $avg: '$score' } } },
    ]);
    const statMap = new Map(stats.map((s) => [String(s._id), s]));

    return ok(res, {
      users: users.map((u) => {
        const s = statMap.get(String(u._id));
        return { ...u.toJSON(), sessions: s?.sessions || 0, avgScore: s ? Math.round(s.avgScore) : null };
      }),
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  })
);

// Shared safety checks for deactivate / delete.
async function guardRemoval(req, res, target) {
  if (String(req.user._id) === String(target._id)) {
    fail(res, 400, 'You cannot delete or deactivate your own account.');
    return false;
  }
  if (target.role === 'admin' && target.isActive) {
    const others = await User.countDocuments({ role: 'admin', isActive: true, _id: { $ne: target._id } });
    if (others < 1) {
      fail(res, 400, 'You cannot remove the last active administrator.');
      return false;
    }
  }
  return true;
}

// DELETE /api/admin/users/:id            -> deactivate (reversible)
// DELETE /api/admin/users/:id?permanent=true -> delete the user and their interview sessions
api.delete(
  '/admin/users/:id',
  wrap(async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return fail(res, 400, 'Invalid user id.');
    const target = await User.findById(id);
    if (!target) return fail(res, 404, 'User not found.');
    if (!(await guardRemoval(req, res, target))) return undefined;

    if (req.query.permanent === 'true') {
      await Interview.deleteMany({ userId: target._id });
      await target.deleteOne();
      return ok(res, { id, action: 'deleted' });
    }
    target.isActive = false;
    await target.save();
    return ok(res, { id, action: 'deactivated', user: target });
  })
);

// PATCH /api/admin/users/:id/status  { isActive: true|false } -> reactivate or deactivate
api.patch(
  '/admin/users/:id/status',
  wrap(async (req, res) => {
    const { id } = req.params;
    if (!isId(id)) return fail(res, 400, 'Invalid user id.');
    if (typeof req.body.isActive !== 'boolean') return fail(res, 400, 'isActive must be true or false.');
    const target = await User.findById(id);
    if (!target) return fail(res, 404, 'User not found.');
    if (!req.body.isActive && !(await guardRemoval(req, res, target))) return undefined;

    target.isActive = req.body.isActive;
    await target.save();
    return ok(res, { user: target });
  })
);

// Unknown /api routes
api.use((_req, res) => fail(res, 404, 'API route not found.'));
