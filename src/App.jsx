// App.jsx - the whole React frontend: API client, auth, routing, pages and small UI components
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/* ================================================================== */
/* 1. API client - every request goes to our own Express REST API      */
/* ================================================================== */
const TOKEN_KEY = 'aic_token';

class ApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors || {};
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Make sure the backend is running.', 0);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok || !json?.success) {
    // An expired/invalid token on a protected call logs the user out everywhere.
    if (res.status === 401 && token) window.dispatchEvent(new Event('aic:unauthorized'));
    throw new ApiError(json?.message || `Request failed (${res.status}).`, res.status, json?.errors);
  }
  return json.data;
}

const api = {
  health: () => request('/health'),
  register: (b) => request('/auth/register', { method: 'POST', body: b }),
  login: (b) => request('/auth/login', { method: 'POST', body: b }),
  me: () => request('/auth/me'),
  profile: () => request('/users/profile'),
  dashboard: () => request('/users/dashboard'),
  meta: () => request('/interviews/questions'),
  questions: (c, d) => request(`/interviews/questions?category=${c}&difficulty=${d}`),
  submit: (b) => request('/interviews', { method: 'POST', body: b }),
  history: () => request('/interviews/history'),
  interview: (id) => request(`/interviews/${id}`),
  adminStats: () => request('/admin/stats'),
  adminUsers: (params) => request(`/admin/users?${new URLSearchParams(params)}`),
  adminRemove: (id, permanent) => request(`/admin/users/${id}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),
  adminStatus: (id, isActive) => request(`/admin/users/${id}/status`, { method: 'PATCH', body: { isActive } }),
};

/* ================================================================== */
/* 2. Small helpers + hooks                                            */
/* ================================================================== */
const CAT_LABEL = { technical: 'Technical', hr: 'HR', behavioral: 'Behavioral' };
const CAT_ICON = { technical: 'code', hr: 'users', behavioral: 'chat' };
const DIFF_LABEL = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
const DIFF_HELP = { beginner: 'Core fundamentals', intermediate: 'Real-world scenarios', advanced: 'Deep dives and design' };

const fmtDate = (d) => new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtDateTime = (d) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const tone = (s) => (s >= 70 ? 'good' : s >= 45 ? 'warn' : 'bad');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Tiny hash router: "#/interview/technical/beginner" -> ['interview','technical','beginner']
const getParts = () => window.location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
const go = (path) => {
  window.location.hash = `/${path}`;
};
function useRoute() {
  const [parts, setParts] = useState(getParts);
  useEffect(() => {
    const onChange = () => setParts(getParts());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return parts;
}
const Link = ({ to, ...props }) => <a href={`#/${to}`} {...props} />;

// Runs an async function and tracks { data, error, loading }. Re-runs when deps change.
function useAsync(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const run = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error, loading: false }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => run(), [run]);
  return { ...state, reload: () => void run() };
}

function useDebounce(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/* ================================================================== */
/* 3. Contexts: notifications + authentication                         */
/* ================================================================== */
const ToastCtx = createContext(null);
const useToast = () => useContext(ToastCtx);

function ToastProvider({ children }) {
  const [list, setList] = useState([]);
  const push = useCallback((type, message) => {
    const id = Math.random().toString(36).slice(2);
    setList((l) => [...l, { id, type, message }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4500);
  }, []);
  const value = useMemo(() => ({ success: (m) => push('success', m), error: (m) => push('error', m) }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <Icon name={t.type === 'success' ? 'check' : 'x'} size={16} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

const AuthCtx = createContext(null);
const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(() => !!localStorage.getItem(TOKEN_KEY));

  // On first load, restore the session by asking the server who the token belongs to.
  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    api
      .me()
      .then((d) => setUser(d.user))
      .catch((e) => {
        if (e.status === 401 || e.status === 403) localStorage.removeItem(TOKEN_KEY);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
    };
    window.addEventListener('aic:unauthorized', onUnauthorized);
    return () => window.removeEventListener('aic:unauthorized', onUnauthorized);
  }, []);

  const finish = (d) => {
    localStorage.setItem(TOKEN_KEY, d.token);
    setUser(d.user);
    return d.user;
  };
  const value = useMemo(
    () => ({
      user,
      loading,
      login: async (body) => finish(await api.login(body)),
      register: async (body) => finish(await api.register(body)),
      logout: () => {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
        go('');
      },
    }),
    [user, loading]
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/* ================================================================== */
/* 4. Reusable UI pieces                                               */
/* ================================================================== */
const ICONS = {
  code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  chart: 'M18 20V10M12 20V4M6 20v-6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  check: 'M20 6L9 17l-5-5',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  x: 'M18 6L6 18M6 6l12 12',
  menu: 'M3 6h18M3 12h18M3 18h18',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};
function Icon({ name, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

function Logo() {
  return (
    <Link to="" className="logo" aria-label="AI Interview Coach home">
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4f8cff" />
            <stop offset="1" stopColor="#8b5cf6" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="url(#logo-g)" />
        <path d="M9 11h14v9h-8l-4 3v-3H9z" fill="#fff" />
      </svg>
      <span>
        AI Interview <b>Coach</b>
      </span>
    </Link>
  );
}

function Spinner() {
  return <span className="spinner" role="progressbar" aria-label="Loading" />;
}
function PageLoader({ text = 'Loading…' }) {
  return (
    <div className="page-loader">
      <Spinner />
      <p>{text}</p>
    </div>
  );
}
function ErrorBox({ error, onRetry }) {
  return (
    <div className="container page">
      <div className="card center-card">
        <h2>Something went wrong</h2>
        <p className="muted">{error?.message || 'Unexpected error.'}</p>
        {onRetry && (
          <button className="btn btn-primary" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

// Circular score indicator that animates from 0 to the value.
function ScoreRing({ value = 0, size = 128, stroke = 11, label = 'out of 100' }) {
  const [shown, setShown] = useState(0);
  const gid = useRef(`ring-${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    const t = setTimeout(() => setShown(value), 60);
    return () => clearTimeout(t);
  }, [value]);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#4f8cff" />
            <stop offset="1" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.09)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${gid})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(100, shown) / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 1s ease' }}
        />
      </svg>
      <div className="ring-text">
        <strong>{Math.round(value)}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function ProgressRow({ label, value, max = 100, right }) {
  return (
    <div className="prow">
      <div className="prow-top">
        <span>{label}</span>
        <span className="muted">{right ?? `${value}`}</span>
      </div>
      <div className="bar">
        <span style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

function Sparkline({ values }) {
  if (values.length < 2) return <p className="muted small">Complete two or more interviews to see your score trend.</p>;
  const W = 300;
  const H = 90;
  const pts = values.map((v, i) => [10 + (i / (values.length - 1)) * (W - 20), H - 12 - (v / 100) * (H - 24)]);
  const line = pts.map((p) => p.join(',')).join(' ');
  const area = `10,${H - 4} ${line} ${W - 10},${H - 4}`;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Score trend: ${values.join(', ')}`}>
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cf6" stopOpacity=".35" />
          <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#spark-fill)" />
      <polyline points={line} fill="none" stroke="#8fb3ff" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="3.5" fill="#0b1020" stroke="#a78bfa" strokeWidth="2" />
      ))}
    </svg>
  );
}

function Modal({ title, children, actions, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

function Field({ label, error, children }) {
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

/* ================================================================== */
/* 5. Navigation bar                                                   */
/* ================================================================== */
function Navbar({ page }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [page]);

  const links = !user ? [] : user.role === 'admin' ? [['admin', 'Admin console']] : [['dashboard', 'Dashboard'], ['history', 'History']];
  const jump = (id) => {
    setOpen(false);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <header className="nav">
      <div className="container nav-inner">
        <Logo />
        <button className="nav-toggle" onClick={() => setOpen((o) => !o)} aria-label="Toggle menu" aria-expanded={open}>
          <Icon name={open ? 'x' : 'menu'} />
        </button>
        <nav className={`nav-links ${open ? 'open' : ''}`}>
          {!user && !page && (
            <>
              <button className="nav-link" onClick={() => jump('features')}>Features</button>
              <button className="nav-link" onClick={() => jump('how')}>How it works</button>
            </>
          )}
          {links.map(([to, label]) => (
            <Link key={to} to={to} className={`nav-link ${page === to || (to === 'dashboard' && page === 'interview') ? 'active' : ''}`}>
              {label}
            </Link>
          ))}
          <span className="nav-spacer" />
          {user ? (
            <>
              <span className="chip" title={user.email}>
                <Icon name="user" size={15} /> {user.name.split(' ')[0]}
                {user.role === 'admin' && <em>admin</em>}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={logout}>
                <Icon name="logout" size={15} /> Log out
              </button>
            </>
          ) : (
            <>
              <Link to="login" className="btn btn-ghost btn-sm">Log in</Link>
              <Link to="register" className="btn btn-primary btn-sm">Create account</Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

/* ================================================================== */
/* 6. Landing page                                                     */
/* ================================================================== */
function Landing() {
  const { user } = useAuth();
  const cta = user ? (user.role === 'admin' ? 'admin' : 'dashboard') : 'register';
  const features = [
    ['code', 'Technical practice', 'JavaScript, APIs, databases and system design questions that grow with you.'],
    ['users', 'HR practice', 'Rehearse motivation, expectations and culture-fit questions out loud in writing.'],
    ['chat', 'Behavioral practice', 'Build STAR-style stories about teamwork, conflict and leadership.'],
    ['target', 'Three difficulty levels', 'Start with fundamentals, then step up to scenarios and design questions.'],
    ['bolt', 'Instant feedback', 'Every answer is scored for depth, key concepts, structure and clarity.'],
    ['chart', 'Progress tracking', 'Your history, averages and score trend are saved so you can see improvement.'],
  ];
  return (
    <>
      <section className="container hero">
        <div className="hero-copy">
          <span className="pill">Practice questions with transparent, rule-based feedback</span>
          <h1>
            Rehearse the interview before it <span className="grad-text">counts</span>.
          </h1>
          <p className="lead">
            Answer real interview questions, see exactly how each answer scored, and track your progress from one session to the next.
          </p>
          <div className="hero-actions">
            <Link to={cta} className="btn btn-primary btn-lg">{user ? 'Open my dashboard' : 'Start practising free'}</Link>
            <button className="btn btn-ghost btn-lg" onClick={() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })}>
              See how it works
            </button>
          </div>
        </div>
        <div className="hero-visual card" aria-label="Sample feedback preview">
          <div className="hero-visual-head">
            <span>Sample feedback</span>
            <span className="badge badge-warn">Preview only</span>
          </div>
          <div className="hero-visual-body">
            <ScoreRing value={82} label="sample score" />
            <div className="hero-bars">
              <ProgressRow label="Depth" value={26} max={30} right="26/30" />
              <ProgressRow label="Key concepts" value={34} max={40} right="34/40" />
              <ProgressRow label="Structure" value={16} max={20} right="16/20" />
              <ProgressRow label="Clarity" value={6} max={10} right="6/10" />
            </div>
          </div>
          <p className="muted small">Your real scores appear after you finish an interview.</p>
        </div>
      </section>

      <section id="features" className="container section">
        <h2 className="section-title">Everything you need to practise with intent</h2>
        <div className="features">
          {features.map(([icon, title, text]) => (
            <article key={title} className="card feature">
              <span className="icon-bubble"><Icon name={icon} /></span>
              <h3>{title}</h3>
              <p className="muted">{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="how" className="container section">
        <h2 className="section-title">How a session works</h2>
        <ol className="steps">
          <li className="card"><h3>1. Pick a track</h3><p className="muted">Choose technical, HR or behavioral questions and a difficulty level.</p></li>
          <li className="card"><h3>2. Write your answers</h3><p className="muted">Move through four questions at your own pace. Skip and come back any time.</p></li>
          <li className="card"><h3>3. Review the feedback</h3><p className="muted">See a score for every answer, what worked, and what to improve next.</p></li>
        </ol>
      </section>

      <section className="container section">
        <div className="cta-banner card">
          <div>
            <h2>Ready for your first session?</h2>
            <p className="muted">Create a free account and finish a practice interview in about ten minutes.</p>
          </div>
          <Link to={cta} className="btn btn-primary btn-lg">{user ? 'Go to dashboard' : 'Create account'}</Link>
        </div>
      </section>

      <footer className="container footer">
        <span>© {new Date().getFullYear()} AI Interview Coach</span>
        <span className="muted small">Feedback is generated by a rule-based engine (keywords, length and structure), not by a language model.</span>
      </footer>
    </>
  );
}

/* ================================================================== */
/* 7. Login / Register                                                 */
/* ================================================================== */
const strengthOf = (p) => {
  let s = 0;
  if (p.length >= 8) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p) || p.length >= 12) s++;
  return s;
};

function AuthPage({ mode }) {
  const isReg = mode === 'register';
  const { login, register } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  const set = (k) => (e) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setErrors((er) => ({ ...er, [k]: undefined }));
    setFormError('');
  };

  const validate = () => {
    const e = {};
    if (isReg && form.name.trim().length < 2) e.name = 'Enter your full name (at least 2 characters).';
    if (!EMAIL_RE.test(form.email.trim())) e.email = 'Enter a valid email address.';
    if (isReg) {
      if (form.password.length < 8 || !/[A-Za-z]/.test(form.password) || !/\d/.test(form.password))
        e.password = 'Use 8 or more characters with at least one letter and one number.';
      if (form.confirmPassword !== form.password) e.confirmPassword = 'Passwords do not match.';
    } else if (!form.password) e.password = 'Enter your password.';
    return e;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    const v = validate();
    setErrors(v);
    if (Object.keys(v).length) return;
    setBusy(true);
    setFormError('');
    try {
      const user = isReg
        ? await register({ name: form.name, email: form.email, password: form.password, confirmPassword: form.confirmPassword })
        : await login({ email: form.email, password: form.password });
      toast.success(isReg ? `Welcome, ${user.name.split(' ')[0]}! Your account is ready.` : 'Logged in successfully.');
      go(user.role === 'admin' ? 'admin' : 'dashboard');
    } catch (err) {
      setErrors(err.errors || {});
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const strength = strengthOf(form.password);
  const labels = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'];

  return (
    <main className="container auth">
      <section className="auth-promo">
        <h1>{isReg ? 'Create your free account' : 'Welcome back'}</h1>
        <p className="lead">
          {isReg
            ? 'Save every practice session, watch your scores climb and know what to work on next.'
            : 'Pick up where you left off and keep building your interview confidence.'}
        </p>
        <ul className="ticks">
          <li><Icon name="check" size={16} /> Technical, HR and behavioral tracks</li>
          <li><Icon name="check" size={16} /> Score and feedback on every answer</li>
          <li><Icon name="check" size={16} /> Your history is saved to your account</li>
        </ul>
      </section>

      <form className="card auth-card" onSubmit={submit} noValidate>
        <h2>{isReg ? 'Sign up' : 'Log in'}</h2>
        {formError && <div className="banner banner-error" role="alert">{formError}</div>}

        {isReg && (
          <Field label="Full name" error={errors.name}>
            <input className="input" value={form.name} onChange={set('name')} autoComplete="name" maxLength={60} placeholder="Ada Lovelace" />
          </Field>
        )}
        <Field label="Email" error={errors.email}>
          <input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" maxLength={120} placeholder="you@example.com" />
        </Field>
        <Field label="Password" error={errors.password}>
          <div className="input-wrap">
            <input className="input" type={show ? 'text' : 'password'} value={form.password} onChange={set('password')} autoComplete={isReg ? 'new-password' : 'current-password'} maxLength={72} />
            <button type="button" className="link-btn" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </Field>
        {isReg && form.password && (
          <div className="strength" aria-live="polite">
            <div className={`bar s${strength}`}><span style={{ width: `${(strength / 4) * 100}%` }} /></div>
            <span className="small muted">{labels[strength]}</span>
          </div>
        )}
        {isReg && (
          <Field label="Confirm password" error={errors.confirmPassword}>
            <input className="input" type={show ? 'text' : 'password'} value={form.confirmPassword} onChange={set('confirmPassword')} autoComplete="new-password" maxLength={72} />
          </Field>
        )}

        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? <Spinner /> : isReg ? 'Create account' : 'Log in'}
        </button>
        <p className="muted small center">
          {isReg ? 'Already have an account? ' : 'New here? '}
          <Link to={isReg ? 'login' : 'register'} className="text-link">{isReg ? 'Log in' : 'Create an account'}</Link>
        </p>
      </form>
    </main>
  );
}

/* ================================================================== */
/* 8. User dashboard                                                   */
/* ================================================================== */
function UserDashboard() {
  const { user, logout } = useAuth();
  const { data, error, loading, reload } = useAsync(() => Promise.all([api.dashboard(), api.meta(), api.profile()]), []);
  const [category, setCategory] = useState('technical');
  const [difficulty, setDifficulty] = useState('beginner');

  if (loading && !data) return <PageLoader text="Loading your dashboard…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const [d, meta, prof] = data;
  const first = user.name.split(' ')[0];

  return (
    <main className="container page">
      <header className="page-head">
        <div>
          <h1>Welcome back, {first}</h1>
          <p className="muted">{d.totalInterviews ? 'Keep the streak going with another practice session.' : 'Start your first practice interview below.'}</p>
        </div>
      </header>

      <section className="stats">
        <div className="card stat"><span className="icon-bubble"><Icon name="check" /></span><div><strong>{d.totalInterviews}</strong><span>Interviews completed</span></div></div>
        <div className="card stat"><span className="icon-bubble"><Icon name="chart" /></span><div><strong>{d.totalInterviews ? d.averageScore : '–'}</strong><span>Average score</span></div></div>
        <div className="card stat"><span className="icon-bubble"><Icon name="target" /></span><div><strong>{d.totalInterviews ? d.bestScore : '–'}</strong><span>Best score</span></div></div>
        <div className="card stat"><span className="icon-bubble"><Icon name="bolt" /></span><div><strong>{d.latestScore ?? '–'}</strong><span>Latest score</span></div></div>
      </section>

      <div className="dash-grid">
        <div className="stack">
          <section className="card">
            <h2 className="card-title">Start an interview</h2>
            <div className="cat-grid" role="radiogroup" aria-label="Interview category">
              {meta.categories.map((c) => (
                <button key={c.id} role="radio" aria-checked={category === c.id} className={`cat-card ${category === c.id ? 'active' : ''}`} onClick={() => setCategory(c.id)}>
                  <span className="icon-bubble"><Icon name={CAT_ICON[c.id]} /></span>
                  <strong>{c.label}</strong>
                  <span className="muted small">{c.description}</span>
                </button>
              ))}
            </div>
            <h3 className="sub-title">Difficulty</h3>
            <div className="seg" role="radiogroup" aria-label="Difficulty">
              {meta.difficulties.map((df) => (
                <button key={df} role="radio" aria-checked={difficulty === df} className={difficulty === df ? 'active' : ''} onClick={() => setDifficulty(df)}>
                  <strong>{DIFF_LABEL[df]}</strong>
                  <span>{DIFF_HELP[df]}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-primary btn-lg" onClick={() => go(`interview/${category}/${difficulty}`)}>
              Start {CAT_LABEL[category]} interview
            </button>
          </section>

          <section className="card">
            <div className="row-between">
              <h2 className="card-title">Recent results</h2>
              <Link to="history" className="text-link small">View all history</Link>
            </div>
            {d.recent.length === 0 ? (
              <p className="muted">No interviews yet. Your results will show up here after your first session.</p>
            ) : (
              <ul className="list">
                {d.recent.map((r) => (
                  <li key={r._id}>
                    <Link to={`history/${r._id}`} className="list-row">
                      <span className="icon-bubble sm"><Icon name={CAT_ICON[r.category]} size={16} /></span>
                      <span className="grow">
                        <strong>{CAT_LABEL[r.category]}</strong>
                        <span className="muted small"> · {DIFF_LABEL[r.difficulty]} · {fmtDate(r.createdAt)}</span>
                      </span>
                      <span className={`badge badge-${tone(r.score)}`}>{r.score}/100</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="card">
            <h2 className="card-title">Performance</h2>
            <div className="center"><ScoreRing value={d.averageScore} label="average" /></div>
            <h3 className="sub-title">Score trend</h3>
            <Sparkline values={d.trend} />
            <h3 className="sub-title">By category</h3>
            {meta.categories.map((c) => {
              const row = d.byCategory.find((x) => x.category === c.id);
              return <ProgressRow key={c.id} label={c.label} value={row?.avg || 0} right={row ? `${row.avg} avg · ${row.count} session${row.count === 1 ? '' : 's'}` : 'No sessions'} />;
            })}
          </section>

          <section className="card">
            <h2 className="card-title">Your profile</h2>
            <dl className="profile">
              <dt>Name</dt><dd>{prof.user.name}</dd>
              <dt>Email</dt><dd>{prof.user.email}</dd>
              <dt>Member since</dt><dd>{fmtDate(prof.stats.memberSince)}</dd>
              <dt>Sessions</dt><dd>{prof.stats.totalInterviews}</dd>
            </dl>
            <button className="btn btn-ghost btn-block" onClick={logout}><Icon name="logout" size={16} /> Log out</button>
          </section>
        </aside>
      </div>
    </main>
  );
}

/* ================================================================== */
/* 9. Interview practice flow                                          */
/* ================================================================== */
function InterviewPage({ category, difficulty }) {
  const toast = useToast();
  const q = useAsync(() => api.questions(category, difficulty), [category, difficulty]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  if (q.loading) return <PageLoader text="Loading questions…" />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;

  const list = q.data.questions;
  const cur = list[idx];
  const text = answers[cur.id] || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const answered = Object.values(answers).filter((a) => a.trim()).length;

  const submit = async () => {
    setConfirm(false);
    setBusy(true);
    try {
      const payload = list.map((x) => ({ id: x.id, answer: answers[x.id] || '' }));
      const result = await api.submit({ category, difficulty, answers: payload });
      toast.success('Interview submitted. Here is your feedback.');
      go(`history/${result._id}`);
    } catch (e) {
      toast.error(e.message);
      setBusy(false);
    }
  };

  if (busy) return <PageLoader text="Scoring your answers…" />;

  return (
    <main className="container page narrow">
      <header className="page-head">
        <div>
          <h1>{CAT_LABEL[category]} interview</h1>
          <p className="muted">{DIFF_LABEL[difficulty]} level · {answered} of {list.length} answered</p>
        </div>
        <Link to="dashboard" className="btn btn-ghost btn-sm">Exit</Link>
      </header>

      <div className="bar thick"><span style={{ width: `${((idx + 1) / list.length) * 100}%` }} /></div>

      <section className="card q-card">
        <p className="muted small">Question {idx + 1} of {list.length}</p>
        <h2 className="question">{cur.question}</h2>
        <textarea
          className="input textarea"
          rows={9}
          maxLength={3000}
          value={text}
          onChange={(e) => setAnswers((a) => ({ ...a, [cur.id]: e.target.value }))}
          placeholder="Type your answer here. Include a concrete example and explain your reasoning."
          aria-label={`Answer to question ${idx + 1}`}
        />
        <div className="row-between">
          <span className={`small ${words >= 50 ? 'good-text' : 'muted'}`}>{words} words{words < 50 ? ' · aim for 50 or more' : ''}</span>
          <span className="small muted">{text.length}/3000</span>
        </div>
      </section>

      <div className="q-dots" aria-label="Question navigation">
        {list.map((x, i) => (
          <button key={x.id} className={`dot ${i === idx ? 'current' : ''} ${(answers[x.id] || '').trim() ? 'done' : ''}`} onClick={() => setIdx(i)} aria-label={`Go to question ${i + 1}`}>
            {i + 1}
          </button>
        ))}
      </div>

      <div className="row-between">
        <button className="btn btn-ghost" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>Previous</button>
        {idx < list.length - 1 ? (
          <button className="btn btn-primary" onClick={() => setIdx(idx + 1)}>Next question</button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={answered === 0}
            onClick={() => (answered < list.length ? setConfirm(true) : submit())}
          >
            Submit interview
          </button>
        )}
      </div>

      {confirm && (
        <Modal
          title="Submit with unanswered questions?"
          onClose={() => setConfirm(false)}
          actions={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Keep answering</button>
              <button className="btn btn-primary" onClick={submit}>Submit anyway</button>
            </>
          }
        >
          You answered {answered} of {list.length} questions. Skipped questions score 0 and lower your overall score.
        </Modal>
      )}
    </main>
  );
}

/* ================================================================== */
/* 10. Result detail + history                                         */
/* ================================================================== */
function ResultPage({ id }) {
  const { data: r, error, loading, reload } = useAsync(() => api.interview(id), [id]);
  if (loading) return <PageLoader text="Loading results…" />;
  if (error) return <ErrorBox error={error} onRetry={error.status === 404 ? null : reload} />;
  const f = r.feedback;

  return (
    <main className="container page narrow">
      <header className="page-head">
        <div>
          <h1>{CAT_LABEL[r.category]} interview results</h1>
          <p className="muted">{DIFF_LABEL[r.difficulty]} level · {fmtDateTime(r.createdAt)}</p>
        </div>
        <div className="head-actions">
          <Link to="dashboard" className="btn btn-ghost btn-sm">Dashboard</Link>
          <Link to={`interview/${r.category}/${r.difficulty}`} className="btn btn-primary btn-sm">Practise again</Link>
        </div>
      </header>

      <section className="card result-top">
        <ScoreRing value={r.score} size={150} />
        <div>
          <h2>{f.summary}</h2>
          <div className="two-col">
            <div>
              <h3 className="sub-title good-text">What worked</h3>
              <ul className="bullets">{f.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
            <div>
              <h3 className="sub-title warn-text">What to improve</h3>
              <ul className="bullets">{f.improvements.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          </div>
        </div>
      </section>
      <div className="banner banner-info">{f.engineLabel}</div>

      <h2 className="section-sub">Question by question</h2>
      <div className="stack">
        {r.items.map((it, i) => (
          <article key={i} className="card">
            <div className="row-between">
              <h3 className="question sm">{i + 1}. {it.question}</h3>
              <span className={`badge badge-${tone(it.score)}`}>{it.score}/100</span>
            </div>
            <p className="answer-box">{it.answer || <em className="muted">Skipped</em>}</p>
            {it.strengths.map((s) => <p key={s} className="note good-text"><Icon name="check" size={15} /> {s}</p>)}
            {it.improvements.map((s) => <p key={s} className="note warn-text"><Icon name="bolt" size={15} /> {s}</p>)}
          </article>
        ))}
      </div>
    </main>
  );
}

function HistoryPage() {
  const { data, error, loading, reload } = useAsync(() => api.history(), []);
  const [filter, setFilter] = useState('all');
  if (loading) return <PageLoader text="Loading your history…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const rows = data.interviews.filter((i) => filter === 'all' || i.category === filter);

  return (
    <main className="container page narrow">
      <header className="page-head">
        <div>
          <h1>Practice history</h1>
          <p className="muted">{data.interviews.length} completed session{data.interviews.length === 1 ? '' : 's'}</p>
        </div>
        <Link to="dashboard" className="btn btn-primary btn-sm">New interview</Link>
      </header>
      <div className="filters">
        {['all', 'technical', 'hr', 'behavioral'].map((c) => (
          <button key={c} className={`filter ${filter === c ? 'active' : ''}`} onClick={() => setFilter(c)}>{c === 'all' ? 'All' : CAT_LABEL[c]}</button>
        ))}
      </div>
      <section className="card">
        {rows.length === 0 ? (
          <p className="muted">{data.interviews.length ? 'No sessions in this category yet.' : 'You have not completed an interview yet. Start one from your dashboard.'}</p>
        ) : (
          <ul className="list">
            {rows.map((r) => (
              <li key={r._id}>
                <Link to={`history/${r._id}`} className="list-row">
                  <span className="icon-bubble sm"><Icon name={CAT_ICON[r.category]} size={16} /></span>
                  <span className="grow">
                    <strong>{CAT_LABEL[r.category]}</strong>
                    <span className="muted small"> · {DIFF_LABEL[r.difficulty]} · {r.questionCount} questions</span>
                    <span className="muted small block">{fmtDateTime(r.createdAt)}</span>
                  </span>
                  <span className={`badge badge-${tone(r.score)}`}>{r.score}/100</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

/* ================================================================== */
/* 11. Admin console                                                   */
/* ================================================================== */
function AdminDashboard() {
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  return (
    <main className="container page">
      <header className="page-head">
        <div>
          <h1>Admin console</h1>
          <p className="muted">Signed in as {user.name}</p>
        </div>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>Overview</button>
          <button role="tab" aria-selected={tab === 'users'} className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users</button>
        </div>
      </header>
      {tab === 'overview' ? <AdminOverview /> : <AdminUsers />}
    </main>
  );
}

function AdminOverview() {
  const { data: s, error, loading, reload } = useAsync(() => api.adminStats(), []);
  if (loading) return <PageLoader text="Loading statistics…" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const maxDay = Math.max(1, ...s.activity.map((a) => a.count));
  const maxCat = Math.max(1, ...s.byCategory.map((c) => c.count));

  return (
    <>
      <section className="stats">
        <div className="card stat"><span className="icon-bubble"><Icon name="users" /></span><div><strong>{s.totalUsers}</strong><span>Registered users</span></div></div>
        <div className="card stat"><span className="icon-bubble"><Icon name="user" /></span><div><strong>{s.activeUsers}</strong><span>Active accounts ({s.inactiveUsers} deactivated)</span></div></div>
        <div className="card stat"><span className="icon-bubble"><Icon name="chat" /></span><div><strong>{s.totalSessions}</strong><span>Interview sessions</span></div></div>
        <div className="card stat"><span className="icon-bubble"><Icon name="chart" /></span><div><strong>{s.totalSessions ? s.averageScore : '–'}</strong><span>Average score</span></div></div>
      </section>

      <div className="two-col wide">
        <section className="card">
          <h2 className="card-title">Sessions in the last 7 days</h2>
          <div className="columns" role="img" aria-label="Sessions per day for the last 7 days">
            {s.activity.map((a) => (
              <div key={a.date} className="col">
                <span className="col-val">{a.count}</span>
                <div className="col-bar"><span style={{ height: `${(a.count / maxDay) * 100}%` }} /></div>
                <span className="col-label">{new Date(`${a.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <h2 className="card-title">Activity by category</h2>
          {s.byCategory.map((c) => (
            <ProgressRow key={c.category} label={CAT_LABEL[c.category]} value={c.count} max={maxCat} right={`${c.count} session${c.count === 1 ? '' : 's'}${c.count ? ` · ${c.avg} avg` : ''}`} />
          ))}
        </section>
      </div>

      <section className="card">
        <h2 className="card-title">Recent interview sessions</h2>
        {s.recentSessions.length === 0 ? (
          <p className="muted">No interview sessions have been completed yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Category</th><th>Level</th><th>Score</th><th>When</th></tr></thead>
              <tbody>
                {s.recentSessions.map((r) => (
                  <tr key={r._id}>
                    <td><strong>{r.user?.name || 'Deleted user'}</strong><span className="muted small block">{r.user?.email}</span></td>
                    <td>{CAT_LABEL[r.category]}</td>
                    <td>{DIFF_LABEL[r.difficulty]}</td>
                    <td><span className={`badge badge-${tone(r.score)}`}>{r.score}</span></td>
                    <td>{fmtDateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function AdminUsers() {
  const { user: me } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const dSearch = useDebounce(search, 350);
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [confirm, setConfirm] = useState(null); // { type, user }
  const [busy, setBusy] = useState(false);

  const { data, error, loading, reload } = useAsync(
    () => api.adminUsers({ search: dSearch, status, role, page, limit: 8 }),
    [dSearch, status, role, page]
  );

  const act = async () => {
    const { type, user } = confirm;
    setBusy(true);
    try {
      if (type === 'delete') await api.adminRemove(user._id, true);
      else if (type === 'deactivate') await api.adminRemove(user._id, false);
      else await api.adminStatus(user._id, true);
      toast.success(type === 'delete' ? `${user.name} was deleted.` : type === 'deactivate' ? `${user.name} was deactivated.` : `${user.name} was reactivated.`);
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const copy = {
    deactivate: ['Deactivate this user?', 'They will be signed out and unable to log in until you reactivate them. Their data is kept.', 'Deactivate'],
    activate: ['Reactivate this user?', 'They will be able to log in again.', 'Reactivate'],
    delete: ['Delete this user permanently?', 'The account and all of their interview sessions will be removed. This cannot be undone.', 'Delete permanently'],
  };

  return (
    <section className="card">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input className="input" placeholder="Search by name or email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search users" maxLength={60} />
        </div>
        <select className="input select" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
        </select>
        <select className="input select" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }} aria-label="Filter by role">
          <option value="">All roles</option>
          <option value="user">Users</option>
          <option value="admin">Admins</option>
        </select>
      </div>

      {error ? (
        <div className="banner banner-error">{error.message} <button className="link-btn" onClick={reload}>Retry</button></div>
      ) : !data ? (
        <PageLoader text="Loading users…" />
      ) : data.users.length === 0 ? (
        <p className="muted">No users match your filters.</p>
      ) : (
        <>
          <div className={`table-wrap ${loading ? 'dim' : ''}`}>
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Registered</th><th>Sessions</th><th>Status</th><th className="right">Actions</th></tr></thead>
              <tbody>
                {data.users.map((u) => {
                  const self = u._id === me._id;
                  return (
                    <tr key={u._id}>
                      <td><strong>{u.name}</strong>{u.role === 'admin' && <span className="badge badge-info ml">admin</span>}{self && <span className="muted small ml">(you)</span>}</td>
                      <td>{u.email}</td>
                      <td>{fmtDate(u.createdAt)}</td>
                      <td>{u.sessions}{u.avgScore !== null && <span className="muted small"> · {u.avgScore} avg</span>}</td>
                      <td><span className={`badge ${u.isActive ? 'badge-good' : 'badge-bad'}`}>{u.isActive ? 'Active' : 'Deactivated'}</span></td>
                      <td className="right actions">
                        {self ? (
                          <span className="muted small">No actions</span>
                        ) : (
                          <>
                            {u.isActive ? (
                              <button className="btn btn-ghost btn-xs" onClick={() => setConfirm({ type: 'deactivate', user: u })}>Deactivate</button>
                            ) : (
                              <button className="btn btn-ghost btn-xs" onClick={() => setConfirm({ type: 'activate', user: u })}>Reactivate</button>
                            )}
                            <button className="btn btn-danger btn-xs" onClick={() => setConfirm({ type: 'delete', user: u })}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row-between pager">
            <span className="muted small">{data.total} user{data.total === 1 ? '' : 's'} · page {data.page} of {data.pages}</span>
            <div className="head-actions">
              <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="btn btn-ghost btn-sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
        </>
      )}

      {confirm && (
        <Modal
          title={copy[confirm.type][0]}
          onClose={() => !busy && setConfirm(null)}
          actions={
            <>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
              <button className={`btn ${confirm.type === 'delete' ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={act}>
                {busy ? <Spinner /> : copy[confirm.type][2]}
              </button>
            </>
          }
        >
          <p><strong>{confirm.user.name}</strong> ({confirm.user.email})</p>
          <p className="muted">{copy[confirm.type][1]}</p>
        </Modal>
      )}
    </section>
  );
}

/* ================================================================== */
/* 12. App shell: providers, routing, route guards                     */
/* ================================================================== */
const USER_PAGES = ['dashboard', 'interview', 'history'];

function Shell() {
  const { user, loading } = useAuth();
  const [page, a, b] = useRoute();
  const [health, setHealth] = useState(null); // null = ok, otherwise a message

  // Poll /api/health so users get a clear message if the backend or MongoDB is down.
  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .health()
        .then((h) => alive && setHealth(h.database === 'connected' ? null : 'The database is disconnected. Sign-in and saving are unavailable until MongoDB reconnects.'))
        .catch(() => alive && setHealth('Cannot reach the backend server. Start it with "npm run dev" and refresh.'));
    check();
    const t = setInterval(check, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const isAdmin = user?.role === 'admin';
  let redirect = null;
  if (!loading) {
    if (!user && (USER_PAGES.includes(page) || page === 'admin')) redirect = 'login';
    else if (user && (page === 'login' || page === 'register')) redirect = isAdmin ? 'admin' : 'dashboard';
    else if (isAdmin && USER_PAGES.includes(page)) redirect = 'admin'; // admins use the admin console
    else if (user && !isAdmin && page === 'admin') redirect = 'dashboard';
  }
  useEffect(() => {
    if (redirect) go(redirect);
  }, [redirect]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page, a, b]);

  const CATS = ['technical', 'hr', 'behavioral'];
  const LEVELS = ['beginner', 'intermediate', 'advanced'];
  let content;
  if (loading || redirect) content = <PageLoader />;
  else if (!page) content = <Landing />;
  else if (page === 'login' || page === 'register') content = <AuthPage key={page} mode={page} />;
  else if (page === 'dashboard') content = <UserDashboard />;
  else if (page === 'interview' && CATS.includes(a) && LEVELS.includes(b)) content = <InterviewPage key={`${a}-${b}`} category={a} difficulty={b} />;
  else if (page === 'history') content = a ? <ResultPage id={a} /> : <HistoryPage />;
  else if (page === 'admin') content = <AdminDashboard />;
  else
    content = (
      <main className="container page">
        <div className="card center-card">
          <h1>Page not found</h1>
          <p className="muted">The page you are looking for does not exist.</p>
          <Link to="" className="btn btn-primary">Back to home</Link>
        </div>
      </main>
    );

  return (
    <>
      <div className="bg-orbs" aria-hidden="true"><span /><span /></div>
      <Navbar page={page} />
      {health && <div className="banner banner-warn top-banner" role="alert">{health}</div>}
      {content}
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ToastProvider>
  );
}
