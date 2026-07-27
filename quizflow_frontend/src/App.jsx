import { useState, useEffect, useRef, useCallback } from "react";

// ─── Font loading ──────────────────────────────────────────────────
// Typeform's own site doesn't pull its Google Font via a CSS @import —
// it preconnects to the font origins ahead of time, then loads the
// font CSS through an actual <link rel="stylesheet"> (they use the
// WebFont.js loader; a plain <link> gets the same non-blocking result
// with less JS). @import is discovered late — only after the browser
// has already fetched and parsed the stylesheet that contains it —
// so it costs an extra round trip before the font request even starts.
// This runs once on mount and injects the same two-step loading Typeform
// uses, guarded so it never double-inserts on re-render/HMR.
function loadGoogleFonts() {
  if (document.getElementById("gf-preconnect-googleapis")) return;

  const preconnectApis = document.createElement("link");
  preconnectApis.id = "gf-preconnect-googleapis";
  preconnectApis.rel = "preconnect";
  preconnectApis.href = "https://fonts.googleapis.com";

  const preconnectStatic = document.createElement("link");
  preconnectStatic.rel = "preconnect";
  preconnectStatic.href = "https://fonts.gstatic.com";
  preconnectStatic.crossOrigin = "anonymous";

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href =
    "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap";

  document.head.append(preconnectApis, preconnectStatic, stylesheet);
}

// ─── API client ──────────────────────────────────────────────────
// Поменяйте на адрес вашего бэкенда (см. README бэкенда — по умолчанию
// он поднимается на localhost:8000).
// В обычной разработке (npm run dev) это просто фиксированные адреса.
// В Docker-развёртывании index.html подгружает /env.js ДО этого бандла —
// он может задать window.__QUIZVK_CONFIG__ с реальными адресами для
// конкретного окружения, не требуя пересборки образа под каждый домен.
// См. quizflow_frontend/Dockerfile и корневой docker-compose.yml.
const RUNTIME_CONFIG = (typeof window !== "undefined" && window.__QUIZVK_CONFIG__) || {};
const API_BASE = RUNTIME_CONFIG.API_BASE !== undefined ? RUNTIME_CONFIG.API_BASE : "http://localhost:8000";
const WS_BASE = RUNTIME_CONFIG.WS_BASE || "ws://localhost:8000";
// FastAPI-микросервис генерации квизов через Claude API — отдельный процесс,
// см. quizflow_ai_service/. Ничего не знает о JWT основного бэкенда, поэтому
// вызывается напрямую через fetch, а не через apiRequest().
const AI_SERVICE_BASE = RUNTIME_CONFIG.AI_SERVICE_BASE !== undefined ? RUNTIME_CONFIG.AI_SERVICE_BASE : "http://localhost:8100";

// Токены — в localStorage, чтобы логин переживал перезагрузку страницы.
const TOKEN_STORAGE_KEY = "quizflow_tokens";

function loadStoredTokens() {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* localStorage недоступен (приватный режим и т.п.) — просто без персиста */
  }
  return { access: null, refresh: null };
}

const authTokens = loadStoredTokens();

function persistAuthTokens() {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(authTokens));
  } catch {
    /* тихо игнорируем — например, приватный режим Safari */
  }
}

function setAuthTokens(tokens) {
  authTokens.access = tokens?.access ?? authTokens.access;
  authTokens.refresh = tokens?.refresh ?? authTokens.refresh;
  persistAuthTokens();
}

function clearAuthTokens() {
  authTokens.access = null;
  authTokens.refresh = null;
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* см. выше */
  }
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function extractErrorMessage(data) {
  if (!data) return "Ошибка сервера";
  if (typeof data === "string") return data;
  if (data.detail) return data.detail;
  const firstKey = Object.keys(data)[0];
  if (firstKey) {
    const val = data[firstKey];
    return Array.isArray(val) ? String(val[0]) : String(val);
  }
  return "Ошибка сервера";
}

async function refreshAccessToken() {
  if (!authTokens.refresh) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: authTokens.refresh }),
    });
    if (!res.ok) throw new Error("refresh failed");
    const data = await res.json();
    authTokens.access = data.access;
    persistAuthTokens();
    return true;
  } catch {
    clearAuthTokens();
    return false;
  }
}

// Универсальная обёртка над fetch: подставляет JWT, при 401 один раз
// пробует обновить access-токен и повторяет запрос, приводит ошибки
// DRF к читаемому сообщению.
async function apiRequest(path, { method = "GET", body, isFormData = false, skipAuth = false, _retry = false } = {}) {
  const headers = {};
  if (!isFormData) headers["Content-Type"] = "application/json";
  if (!skipAuth && authTokens.access) headers.Authorization = `Bearer ${authTokens.access}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isFormData ? body : JSON.stringify(body),
  });

  if (res.status === 401 && !skipAuth && !_retry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return apiRequest(path, { method, body, isFormData, skipAuth, _retry: true });
  }

  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустое тело ответа */
  }

  if (!res.ok) {
    throw new ApiError(extractErrorMessage(data), res.status, data);
  }
  return data;
}

// ─── AI-сервис генерации квизов (FastAPI + Claude API, отдельный процесс) ──
// Не через apiRequest(): другой origin, без JWT основного бэкенда, и другая
// форма ошибок (FastAPI отдаёт {"detail": "..."} или, при 422 от Pydantic,
// {"detail": [{"msg": "...", ...}, ...]}).
async function aiGenerateQuiz({ description, numQuestions, mode }) {
  let res;
  try {
    res = await fetch(`${AI_SERVICE_BASE}/api/generate-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description, num_questions: numQuestions, mode }),
    });
  } catch {
    // fetch бросает голый TypeError ("Failed to fetch"), когда сервис
    // недоступен вообще (не запущен/не тот порт/сеть) — показываем
    // осмысленное сообщение вместо технической строки браузера.
    throw new Error("Не удалось подключиться к сервису генерации. Проверьте, что он запущен.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустое тело ответа */
  }
  if (!res.ok) {
    const detail = data?.detail;
    const message = Array.isArray(detail)
      ? detail.map((d) => d.msg || d).join("; ")
      : detail || "Не удалось сгенерировать квиз. Попробуйте ещё раз.";
    throw new Error(message);
  }
  return data;
}

// Конвертирует ответ AI-сервиса (topics -> questions -> answers с полем
// is_correct) в форму локального состояния CreatorPage (answers с полем
// correct, плюс поля под медиа, которые модель не генерирует).
function adaptGeneratedQuiz(data) {
  return {
    title: data.title,
    category: data.category,
    mode: data.mode,
    topics: data.topics.map((t) => ({
      id: Date.now() + Math.random(),
      title: t.title || "",
      questions: t.questions.map((q) => ({
        text: q.text,
        type: q.type,
        mediaUrl: "", mediaName: "", mediaType: "",
        timeLimit: 20,
        answers: q.answers.map((a) => ({ text: a.text, correct: a.is_correct })),
      })),
    })),
  };
}

// ─── Game WebSocket ────────────────────────────────────────────────
// Одно соединение на комнату, живёт на уровне App и переживает переходы
// между лобби/игрой/результатами — так сервер не пересылает состояние
// заново и не теряются события в момент смены страницы.
function createGameSocket(roomCode, authQuery, { onEvent, onOpen, onClose } = {}) {
  const ws = new WebSocket(`${WS_BASE}/ws/session/${roomCode}/?${authQuery}`);
  ws.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch {
      return;
    }
    onEvent?.(data.event, data.payload);
  };
  ws.onopen = () => onOpen?.();
  ws.onclose = () => onClose?.();
  return ws;
}

// ─── Icons (inline SVG components) ───────────────────────────────
const Icons = {
  Logo: () => (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill="#a78bfa" />
      <text x="16" y="22" textAnchor="middle" fill="#2a222b" fontSize="18" fontWeight="bold" fontFamily="sans-serif">Q</text>
    </svg>
  ),
  Play: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  PlayFilled: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>,
  Pause: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>,
  Plus: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Users: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  Clock: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Search: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  Trophy: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>,
  Check: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  X: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  ArrowRight: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  Home: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  Settings: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>,
  Image: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
  Logout: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  Trash: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  Edit: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Sparkles: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z"/><path d="M19 14l.9 2.6L22.5 17.5l-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14z"/><path d="M5 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/></svg>,
  User: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Star: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  Zap: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  Hash: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>,
  ChevronDown: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>,
  Eye: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  EyeOff: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  Facebook: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>,
  XLogo: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.9 2h3.3l-7.2 8.2L23.5 22h-6.6l-5.2-6.8L5.8 22H2.5l7.7-8.8L1.5 2h6.8l4.7 6.2zm-1.2 18h1.8L7.4 4h-1.9z"/></svg>,
  Instagram: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>,
  YouTube: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.94-2C18.88 4 12 4 12 4s-6.88 0-8.6.46a2.78 2.78 0 0 0-1.94 2A29 29 0 0 0 1 11.75a29 29 0 0 0 .46 5.33A2.78 2.78 0 0 0 3.4 19c1.72.46 8.6.46 8.6.46s6.88 0 8.6-.46a2.78 2.78 0 0 0 1.94-2 29 29 0 0 0 .46-5.25 29 29 0 0 0-.46-5.33z"/><polygon points="9.75 15.02 15.5 11.75 9.75 8.48 9.75 15.02"/></svg>,
  LinkedIn: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/></svg>,
};

// ─── Styles ──────────────────────────────────────────────────────
const baseStyles = `
:root {
  /*
    Реальные токены с сайта Typeform (из предоставленного :root).
    neutral-1000 (#2a222b) — это их "invert"-поверхность, т.е. тёмный фон
    тёмных секций. Это тёплый сливовый почти-чёрный, а НЕ нейтральный #161616.
  */
  --bg-deep: #2a222b;
  --bg-base: #2a222b;       /* = --_colour-primitives---primitives--neutral--1000 */
  --bg-surface: #2a222b;    /* тот же цвет — карточки отличаются только рамкой, как в референсе */
  --bg-elevated: #332a34;   /* едва заметно светлее — только для hover/интерактивных полей */
  --bg-hover: #3a303c;
  /* Purple — приглушённый лавандово-баклажановый, не яркий violet */
  --accent: #9454ab;        /* = --_colour-primitives---primitives--purple--700 */
  --accent-light: #b585c7;  /* оценка purple--600 (светлее 700) */
  --accent-dim: #753a88;    /* = --_colour-primitives---primitives--purple--800 */
  --accent-glow: rgba(148, 84, 171, 0.14);
  --accent-glow-strong: rgba(148, 84, 171, 0.28);
  /* Текст — тёплый off-white, не чистый #fff (мягче на тёмном сливовом фоне) */
  --text-primary: #f5f3f6;   /* ~ neutral--50 */
  --text-secondary: #b6acb9; /* светлый вариант neutral--700 для инверсии */
  --text-muted: #8c8290;
  /* Status */
  --success: #34d399;
  --error: #f87171;
  --warning: #fbbf24;
  --silver: #c0c0c0;
  --bronze: #cd7f32;
  /* Бордеры — светлые с лёгким лавандовым оттенком, тонкие */
  --border: rgba(240, 230, 245, 0.08);
  --border-strong: rgba(240, 230, 245, 0.16);
  /* Radius — --corner-radius-sm: .75rem (12px) в их системе */
  --radius-sm: 12px;
  --radius-md: 16px;
  --radius-lg: 20px;
  --radius-xl: 28px;
  /*
    Шрифты Typeform — Tobias (display) и TWK Lausanne (текст) — платные,
    не лежат на Google Fonts. Указаны первыми в стеке: если у тебя есть
    лицензионные файлы, просто добавь @font-face — переменные подхватятся
    без остальных правок. Fraunces/Inter — ближайшие бесплатные аналоги.
  */
  --font-display: 'Tobias', 'Fraunces', Georgia, serif;
  --font-body: 'TWK Lausanne', 'Inter', -apple-system, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Menlo', monospace;
  /* Shadows */
  --shadow: 0 4px 24px rgba(0,0,0,0.4);
  --shadow-lg: 0 8px 40px rgba(0,0,0,0.5);
  --transition: 0.2s ease;
}

*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

body, html {
  font-family: var(--font-body);
  background: var(--bg-deep);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bg-elevated); border-radius: 3px; }

*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.app {
  min-height: 100vh;
  background: var(--bg-deep);
}

/* ─── NAV (Typeform: dark, minimal, blurred) ─── */
.nav {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 48px;
  background: rgba(42, 34, 43, 0.8);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
}
@media (min-width: 1600px) {
  .nav { padding-left: max(48px, calc((100vw - 1500px) / 2)); padding-right: max(48px, calc((100vw - 1500px) / 2)); }
  .hero, .features-section, .footer-inner { max-width: 1500px; }
  /* Same gutter technique, applied where it's needed elsewhere in the app: */
  .auth-page { max-width: 1500px; margin: 0 auto; }
  /* .main-content sits next to a fixed 240px sidebar, so the available
     track is (100vw - 240px) rather than the full viewport — the gutter
     math below accounts for that offset before centering a 1400px column. */
  .main-content { padding-left: max(40px, calc((100vw - 240px - 1400px) / 2)); padding-right: max(40px, calc((100vw - 240px - 1400px) / 2)); }
}
.nav-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}
.nav-brand-text {
  font-family: var(--font-body);
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}
.nav-links {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nav-link {
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: var(--transition);
  font-family: var(--font-body);
}
.nav-link:hover { color: var(--text-primary); }

/* ─── BUTTONS ─── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 24px;
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 600;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition);
  text-decoration: none;
  white-space: nowrap;
}
/* Primary = WHITE on dark (like Typeform's CTA) */
.btn-primary {
  background: #ffffff;
  color: #2a222b;
}
.btn-primary:hover {
  background: #e8e8e8;
  transform: translateY(-1px);
  box-shadow: 0 4px 20px rgba(255,255,255,0.1);
}
/* Accent = purple variant */
.btn-accent {
  background: var(--accent);
  color: #ffffff;
}
.btn-accent:hover {
  background: var(--accent-light);
  transform: translateY(-1px);
  box-shadow: 0 4px 24px rgba(165,126,250,0.35);
}
.btn-secondary {
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 1px solid var(--border-strong);
}
.btn-secondary:hover { background: var(--bg-elevated); border-color: rgba(255,255,255,0.25); }
.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
}
.btn-ghost:hover { color: var(--text-primary); background: rgba(255,255,255,0.05); }
.btn-danger {
  background: rgba(248,113,113,0.1);
  color: var(--error);
  border: 1px solid rgba(248,113,113,0.2);
}
.btn-danger:hover { background: rgba(248,113,113,0.2); }
.btn-lg { padding: 16px 32px; font-size: 16px; border-radius: var(--radius-md); }
.btn-sm { padding: 8px 16px; font-size: 13px; }
.btn-icon {
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: var(--radius-sm);
}
.btn-full { width: 100%; }

/* ─── INPUTS ─── */
.input-group { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.input-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}
.input {
  padding: 12px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 14px;
  transition: var(--transition);
}
.input:focus { border-color: var(--accent); background: var(--bg-elevated); outline: none; box-shadow: 0 0 0 3px var(--accent-glow); }
.input::placeholder { color: var(--text-muted); }
.input-code {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 600;
  text-align: center;
  letter-spacing: 8px;
  padding: 16px;
  text-transform: uppercase;
}
.input-password-wrap { position: relative; }
.input-password-wrap .input { padding-right: 44px; }
.input-password-toggle {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
}
.input-password-toggle:hover { color: var(--text-secondary); }

.select {
  padding: 12px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 14px;
  appearance: none;
  cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a0a0a0' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}
.select:focus { border-color: var(--accent); outline: none; }

.input-hint {
  font-size: 12px;
  color: var(--text-muted);
}

/* ─── IMAGE UPLOAD (file, not URL) ─── */
.image-upload-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bg-surface);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: 14px;
  cursor: pointer;
  transition: var(--transition);
}
.image-upload-btn:hover { border-color: var(--accent); color: var(--text-primary); background: var(--bg-elevated); }
.image-upload-btn input[type="file"] {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.image-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 6px 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  min-width: 0; /* иначе как grid-item не сжимается ниже ширины контента */
}
.image-preview img,
.image-preview video {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
  background: #000;
}
.media-audio-chip {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-glow);
  color: var(--accent);
}
.image-preview-name {
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0; /* тот же трюк для самого текстового узла — иначе не обрежется */
}
.image-preview-remove {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  display: flex;
  flex-shrink: 0;
}
.image-preview-remove:hover { color: var(--error); }

/* ─── CARDS (Typeform: thin white border, subtle glow) ─── */
.card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
  transition: all 0.3s ease;
}
.card:hover { border-color: var(--border-strong); }
.card-glow:hover {
  border-color: rgba(165,126,250,0.2);
  box-shadow: 0 0 40px rgba(165,126,250,0.08), 0 0 80px rgba(165,126,250,0.04);
}

/* ─── LANDING ─── */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 120px 40px 80px;
  max-width: 900px;
  margin: 0 auto;
  position: relative;
}
.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px;
  background: transparent;
  border: none;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-light);
  margin-bottom: 36px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
}
.hero h1 {
  font-family: var(--font-display);
  font-size: clamp(42px, 6.5vw, 76px);
  line-height: 1.08;
  color: var(--text-primary);
  margin-bottom: 28px;
  font-weight: 400;
  letter-spacing: -0.5px;
}
.hero h1 em {
  font-style: normal;
  color: var(--text-primary);
}
.hero p {
  font-size: 17px;
  line-height: 1.7;
  color: var(--text-secondary);
  max-width: 540px;
  margin-bottom: 44px;
  font-weight: 400;
}
.hero-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}

/* Features section with Typeform purple underglow */
.features-section {
  position: relative;
  padding: 20px 40px 100px;
  margin: 0 auto;
}
.features-section::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 70%;
  height: 200px;
  background: radial-gradient(ellipse at center, rgba(165,126,250,0.15) 0%, transparent 70%);
  pointer-events: none;
}
.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  max-width: 1100px;
  margin: 0 auto;
  position: relative;
  z-index: 1;
}
.feature-card {
  padding: 28px 24px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition: all 0.3s ease;
  position: relative;
}
.feature-card:hover {
  border-color: rgba(165,126,250,0.18);
  box-shadow: 0 8px 40px rgba(165,126,250,0.06);
}
.feature-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  margin-bottom: 12px;
}
.feature-card h3 {
  font-family: var(--font-body);
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 10px;
  letter-spacing: -0.2px;
}
.feature-card.has-badge h3 {
  padding-right: 52px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.feature-card .new-badge {
  position: absolute;
  top: 20px;
  right: 20px;
  display: inline-flex;
  align-items: center;
  padding: 3px 12px;
  background: linear-gradient(135deg, #c266d9, #9a3fc4);
  border-radius: 100px;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  white-space: nowrap;
  box-shadow: 0 0 4px rgba(210, 110, 230, 0.9), 0 0 18px rgba(200, 100, 225, 0.55);
}
.feature-card p {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.feature-icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-glow);
  border-radius: var(--radius-md);
  color: var(--accent);
  margin-bottom: 14px;
}
/* Карточка-слайд подсвечивается, пока идёт её загрузка (управляется из React) */
.feature-card {
  transition: border-color 0.4s ease, box-shadow 0.4s ease;
}
.feature-card.active {
  border-color: rgba(165, 126, 250, 0.35);
  box-shadow: 0 0 40px rgba(165, 126, 250, 0.16), 0 0 90px rgba(165, 126, 250, 0.08);
}
/* Полоска-загрузка — ширина управляется из React (0% → 100% за цикл, потом мгновенный сброс) */
.feature-card .loading-track {
  width: 100%;
  height: 3px;
  background: rgba(240, 230, 245, 0.1);
  border-radius: 2px;
  margin-top: 20px;
  overflow: hidden;
}
.feature-card .loading-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-light));
  border-radius: 2px;
}

/* ─── AUTH ─── */
.auth-page {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-height: calc(100vh - 65px);
}
@media (max-width: 800px) {
  .auth-page { grid-template-columns: 1fr; }
  .auth-side { display: none; }
}
.auth-form-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}
.auth-form {
  width: 100%;
  max-width: 400px;
}
.auth-form h2 {
  font-family: var(--font-body);
  font-size: 34px;
  font-weight: 600;
  margin-bottom: 8px;
}
.auth-form .subtitle {
  color: var(--text-secondary);
  font-size: 15px;
  margin-bottom: 32px;
  line-height: 1.5;
}
.auth-form .form-fields {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 24px;
}
.auth-divider {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 24px 0;
  color: var(--text-muted);
  font-size: 13px;
}
.auth-divider::before, .auth-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-strong);
}
.auth-social {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}
.btn-social {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: var(--transition);
  font-family: var(--font-body);
  width: 100%;
}
.btn-social:hover { border-color: rgba(255,255,255,0.25); background: var(--bg-elevated); }
.auth-error {
  background: rgba(248, 113, 113, 0.1);
  color: var(--error);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 16px;
}
.auth-footer {
  text-align: center;
  font-size: 14px;
  color: var(--text-secondary);
}
.auth-footer button {
  color: var(--accent);
  background: none;
  border: none;
  cursor: pointer;
  font-weight: 600;
  font-size: 14px;
  font-family: var(--font-body);
}
.auth-footer button:hover { text-decoration: underline; }

.auth-forgot-link {
  display: block;
  margin-top: 8px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 13px;
  font-family: var(--font-body);
  text-align: right;
  width: 100%;
}
.auth-forgot-link:hover { color: var(--accent-light); text-decoration: underline; }

.auth-side {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: var(--bg-base);
  border-left: 1px solid var(--border);
  position: relative;
  overflow: hidden;
}
/* Typeform-style purple ambient glow on auth side */
.auth-side::after {
  content: '';
  position: absolute;
  bottom: -80px;
  left: 50%;
  transform: translateX(-50%);
  width: 400px;
  height: 300px;
  background: radial-gradient(ellipse at center, rgba(165,126,250,0.12) 0%, transparent 70%);
  pointer-events: none;
}
.auth-side-content {
  max-width: 360px;
  text-align: center;
  position: relative;
  z-index: 1;
}
.auth-side-content h3 {
  font-family: var(--font-body);
  font-size: 28px;
  font-weight: 600;
  margin-bottom: 16px;
}
.auth-side-content p {
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 32px;
}
.auth-side-visual {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: 100%;
}
.auth-side-visual .mock-q {
  background: var(--bg-surface);
  border-radius: var(--radius-md);
  padding: 20px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
}
.auth-side-visual .mock-q-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 4px;
}
.auth-side-visual .mock-q-text {
  font-size: 15px;
  color: var(--text-primary);
}
.auth-side-visual .mock-answers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.auth-side-visual .mock-ans {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-size: 13px;
  color: var(--text-secondary);
}
.auth-side-visual .mock-ans.correct {
  border-color: var(--success);
  color: var(--success);
  background: rgba(52,211,153,0.06);
}

.role-selector {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 20px;
}
.role-btn {
  padding: 12px;
  background: var(--bg-surface);
  border: 2px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition);
  font-family: var(--font-body);
}
.role-btn.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-glow);
}
.role-btn:hover:not(.active) { border-color: rgba(255,255,255,0.2); }

/* ─── DASHBOARD ─── */
.dashboard {
  display: grid;
  grid-template-columns: 240px 1fr;
  min-height: calc(100vh - 65px);
}
@media (max-width: 800px) {
  .dashboard { grid-template-columns: 1fr; grid-template-rows: auto 1fr; min-height: auto; }
  .sidebar {
    flex-direction: row;
    align-items: center;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding: 10px 12px;
    gap: 4px;
  }
  .sidebar-nav {
    flex-direction: row;
    flex: 1;
    gap: 4px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .sidebar-nav::-webkit-scrollbar { display: none; }
  .sidebar-item { width: auto; white-space: nowrap; padding: 8px 12px; }
  .sidebar-section-label { display: none; }
  .sidebar-user {
    border-top: none;
    margin-top: 0;
    padding: 6px;
    flex-shrink: 0;
  }
  .sidebar-username, .sidebar-role { display: none; }
}
.sidebar {
  background: var(--bg-base);
  border-right: 1px solid var(--border);
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
}
.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}
.sidebar-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  font-family: var(--font-body);
  transition: var(--transition);
}
.sidebar-item:hover { color: var(--text-primary); background: rgba(255,255,255,0.04); }
.sidebar-item.active { color: var(--accent); background: var(--accent-glow); }
.sidebar-section-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 20px 14px 8px;
}
.sidebar-user {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
  margin-top: auto;
}
.sidebar-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  color: #fff;
}
.sidebar-username { font-size: 14px; font-weight: 500; }
.sidebar-role { font-size: 12px; color: var(--text-muted); }

.main-content {
  padding: 32px 40px;
  overflow-y: auto;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 32px;
}
.page-header h2 {
  font-family: var(--font-body);
  font-size: 28px;
  font-weight: 600;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 32px;
}
.stat-card { padding: 20px 24px; }
.stat-label { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
.stat-value { font-size: 28px; font-weight: 700; font-family: var(--font-mono); }
.stat-value.accent { color: var(--accent); }

.quiz-list { display: flex; flex-direction: column; gap: 12px; }
.quiz-item {
  display: grid;
  grid-template-columns: 1fr auto auto auto auto;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  cursor: pointer;
}
.quiz-item-title { font-weight: 600; font-size: 15px; }
.quiz-item-meta { font-size: 13px; color: var(--text-muted); margin-top: 2px; }
.quiz-item-badge {
  padding: 4px 12px;
  border-radius: 100px;
  font-size: 12px;
  font-weight: 600;
}
.badge-live { background: rgba(52,211,153,0.12); color: var(--success); }
.badge-draft { background: rgba(160,160,160,0.1); color: var(--text-secondary); }
.badge-done { background: var(--accent-glow); color: var(--accent); }

/* ─── QUIZ CATALOG: search + category filter ─── */
.catalog-search-wrap { position: relative; max-width: 420px; margin-bottom: 16px; }
.catalog-search-wrap .catalog-search-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
  display: flex;
}
.catalog-search-wrap .input { padding-left: 40px; }
.catalog-categories { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.catalog-category-pill {
  padding: 7px 14px;
  border-radius: 100px;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  font-family: var(--font-body);
  cursor: pointer;
  transition: var(--transition);
}
.catalog-category-pill.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.catalog-category-pill:hover:not(.active) { border-color: var(--accent); color: var(--text-primary); }
.catalog-empty { padding: 48px 20px; text-align: center; color: var(--text-muted); }

/* ─── QUIZ CREATOR ─── */
.creator {
  max-width: 800px;
  margin: 0 auto;
  padding: 32px 40px;
}
.creator h2 {
  font-family: var(--font-body);
  font-size: 28px;
  font-weight: 600;
  margin-bottom: 32px;
}
.creator-section { margin-bottom: 32px; }
.creator-section h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--text-secondary);
}

/* ─── AI-генерация квиза ─── */
.ai-generate-panel {
  background: linear-gradient(160deg, var(--accent-glow), transparent 60%), var(--bg-surface);
  border: 1px solid rgba(165,126,250,0.25);
  border-radius: var(--radius-lg);
  padding: 24px;
  margin-bottom: 32px;
}
.ai-generate-header { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 16px; }
.ai-generate-icon {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
  background: var(--accent); color: #fff;
}
.ai-generate-header h3 { font-size: 16px; font-weight: 600; margin-bottom: 4px; color: var(--text-primary); }
.ai-generate-header p { font-size: 13px; line-height: 1.5; }
.ai-generate-textarea { width: 100%; resize: vertical; min-height: 72px; font-family: var(--font-body); margin-bottom: 14px; }
.ai-generate-row { display: flex; align-items: flex-end; gap: 14px; }
.ai-generate-row .input-group { width: 160px; flex-shrink: 0; }
.ai-generate-row .btn { flex-shrink: 0; }
.ai-generate-error {
  margin-top: 12px; padding: 12px 16px; border-radius: var(--radius-sm);
  background: rgba(248,113,113,0.1); color: var(--error); font-size: 13px;
}
@media (max-width: 600px) {
  .ai-generate-panel { padding: 18px; }
  .ai-generate-row { flex-wrap: wrap; }
  .ai-generate-row .input-group { width: 100%; }
  .ai-generate-row .btn { width: 100%; }
}
.creator-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.question-card { padding: 20px; margin-bottom: 12px; }

.quiz-mode-toggle {
  display: inline-flex;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 3px;
  gap: 3px;
  width: fit-content;
}
.quiz-mode-btn {
  padding: 8px 16px;
  border-radius: calc(var(--radius-sm) - 3px);
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
  background: none;
  border: none;
  cursor: pointer;
  transition: var(--transition);
  font-family: var(--font-body);
}
.quiz-mode-btn.active { background: var(--accent); color: #fff; }

.topic-block {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 20px;
  margin-bottom: 20px;
  background: rgba(255, 255, 255, 0.015);
}
.topic-block-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.topic-title-input { flex: 1; font-weight: 600; font-size: 16px; }

.question-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.question-number {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--accent);
  font-weight: 600;
}
.question-type-badge {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 100px;
  background: var(--accent-glow);
  color: var(--accent-light);
  font-weight: 600;
}
.answers-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 12px;
}
.answer-input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.answer-input-wrap .input { flex: 1; font-size: 13px; padding: 10px 12px; }
.correct-toggle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  background: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  transition: var(--transition);
  flex-shrink: 0;
}
.correct-toggle.active {
  border-color: var(--success);
  background: var(--success);
  color: #2a222b;
}

/* ─── JOIN ROOM ─── */
.join-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 65px);
  padding: 40px;
}
.join-card {
  max-width: 440px;
  width: 100%;
  padding: 48px;
  text-align: center;
}
.join-card h2 {
  font-family: var(--font-body);
  font-size: 32px;
  font-weight: 600;
  margin-bottom: 12px;
}
.join-card p {
  color: var(--text-secondary);
  margin-bottom: 32px;
}

/* ─── LOBBY ─── */
.lobby {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 65px);
  padding: 40px;
  text-align: center;
}
.lobby-code {
  font-family: var(--font-mono);
  font-size: 56px;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 12px;
  margin-bottom: 8px;
  animation: pulse-glow 2s ease-in-out infinite;
}
@keyframes pulse-glow {
  0%, 100% { text-shadow: 0 0 20px rgba(165,126,250,0.3); }
  50% { text-shadow: 0 0 50px rgba(165,126,250,0.6), 0 0 100px rgba(165,126,250,0.2); }
}
.lobby-label {
  font-size: 14px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 2px;
  margin-bottom: 32px;
}
.lobby h2 {
  font-family: var(--font-body);
  font-size: 28px;
  font-weight: 600;
  margin-bottom: 40px;
}
.lobby-players {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  max-width: 500px;
  margin-bottom: 40px;
}
.lobby-player {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 100px;
  font-size: 14px;
  font-weight: 500;
  animation: pop-in 0.3s ease-out;
}
.lobby-player-kick {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
}
.lobby-player-kick svg { width: 12px; height: 12px; }
.lobby-player-kick:hover { background: var(--error); color: #fff; }
.lobby-play-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 20px;
  cursor: pointer;
}
.lobby-play-toggle input { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
@keyframes pop-in {
  0% { transform: scale(0); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}
.lobby-count { font-size: 14px; color: var(--text-muted); margin-bottom: 24px; }
.lobby-waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 14px;
}
.lobby-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success);
  animation: blink 1.4s ease-in-out infinite;
}
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ─── LIVE QUIZ ─── */
.live-quiz {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: calc(100vh - 65px);
  padding: 40px;
}
.live-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  max-width: 700px;
  margin-bottom: 40px;
}
.live-progress-text {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--text-muted);
}
.live-timer {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  font-family: var(--font-mono);
  font-size: 24px;
  font-weight: 700;
  position: relative;
}
.live-timer-ring { position: absolute; inset: 0; }
.live-timer-ring circle { fill: none; stroke-width: 3; stroke-linecap: round; }
.live-timer-ring .bg { stroke: var(--bg-elevated); }
.live-timer-ring .fg { stroke: var(--accent); transition: stroke-dashoffset 1s linear; }
.live-timer.warning .fg { stroke: var(--warning); }
.live-timer.danger .fg { stroke: var(--error); }
.live-score-display {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--text-muted);
}
.live-score-display span {
  color: var(--accent);
  font-weight: 700;
  font-size: 18px;
}

.live-roster-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 100px;
  color: var(--text-secondary);
  font-size: 13px;
  font-family: var(--font-body);
  cursor: pointer;
  transition: var(--transition);
}
.live-roster-toggle:hover { color: var(--text-primary); border-color: var(--accent); }
.live-roster-toggle-inline { display: flex; margin: 0 auto 20px; }
.live-answered-count {
  text-align: center;
  font-size: 13px;
  margin-bottom: 16px;
  font-family: var(--font-mono);
}
.live-roster-panel {
  max-width: 480px;
  margin: 0 auto 20px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  max-height: 220px;
  overflow-y: auto;
}
.live-roster-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  font-size: 14px;
}
.live-roster-row:not(:last-child) { border-bottom: 1px solid var(--border); }
.live-spectator-note {
  text-align: center;
  max-width: 480px;
  margin: 0 auto;
  font-size: 14px;
  padding: 24px;
}

.live-question-card {
  width: 100%;
  max-width: 700px;
  padding: 40px;
  text-align: center;
  margin-bottom: 32px;
}
.live-question-card h3 {
  font-family: var(--font-body);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.4;
}

.live-answers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  width: 100%;
  max-width: 700px;
}
.live-answer-btn {
  padding: 20px 24px;
  background: var(--bg-surface);
  border: 2px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition);
  text-align: left;
  font-family: var(--font-body);
  display: flex;
  align-items: center;
  gap: 12px;
}
.live-answer-btn:hover:not(:disabled):not(.selected) {
  border-color: rgba(255,255,255,0.3);
  background: var(--bg-elevated);
}
.live-answer-btn.selected {
  border-color: var(--accent);
  background: var(--accent-glow);
}
.live-answer-btn.correct {
  border-color: var(--success);
  background: rgba(52,211,153,0.08);
  color: var(--success);
}
.live-answer-btn.wrong {
  border-color: var(--error);
  background: rgba(248,113,113,0.08);
  color: var(--error);
}
.live-answer-btn:disabled { cursor: default; opacity: 0.7; }
.answer-letter {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--bg-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
}
.live-answer-btn.correct .answer-letter { background: var(--success); color: #2a222b; }
.live-answer-btn.wrong .answer-letter { background: var(--error); color: #2a222b; }

/* ─── LEADERBOARD ─── */
.leaderboard {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: calc(100vh - 65px);
  padding: 40px;
}
.leaderboard h2 {
  font-family: var(--font-body);
  font-size: 36px;
  font-weight: 600;
  margin-bottom: 8px;
}
.leaderboard-subtitle {
  color: var(--text-secondary);
  margin-bottom: 40px;
  font-size: 16px;
}
.podium {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 40px;
}
.podium-place {
  display: flex;
  flex-direction: column;
  align-items: center;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  padding: 24px;
  transition: var(--transition);
}
.podium-1 { min-height: 200px; min-width: 160px; border-color: rgba(251,191,36,0.3); }
.podium-2 { min-height: 160px; min-width: 140px; border-color: rgba(192,192,192,0.3); }
.podium-3 { min-height: 130px; min-width: 140px; border-color: rgba(205,127,50,0.3); }
.podium-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 18px;
  margin-bottom: 8px;
}
.podium-1 .podium-avatar { background: var(--warning); color: #2a222b; }
.podium-2 .podium-avatar { background: var(--silver); color: #2a222b; }
.podium-3 .podium-avatar { background: var(--bronze); color: #2a222b; }
.podium-name { font-weight: 600; font-size: 15px; margin-bottom: 4px; }
.podium-score { font-family: var(--font-mono); font-size: 14px; color: var(--text-muted); }
.podium-medal { font-size: 24px; margin-bottom: 8px; }

.leaderboard-table { width: 100%; max-width: 600px; }
.leaderboard-table.mt-24 { margin-left: auto; margin-right: auto; }
.lb-row {
  display: grid;
  grid-template-columns: 40px 1fr auto;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}
.lb-row:last-child { border-bottom: none; }
.lb-row.you-row { background: var(--accent-glow); border-radius: var(--radius-sm); }
.lb-rank { font-family: var(--font-mono); font-weight: 700; font-size: 14px; color: var(--text-muted); }
.lb-name { font-weight: 500; font-size: 15px; }
.lb-name.you { color: var(--accent); }
.lb-score { font-family: var(--font-mono); font-weight: 600; font-size: 14px; color: var(--text-secondary); }

/* ─── LIVE QUIZ: standings between questions ─── */
.live-standings-header { text-align: center; margin-bottom: 8px; }
.live-standings-header h2 { font-family: var(--font-body); font-size: 24px; margin-bottom: 6px; }

/* ─── LIVE QUIZ: question media (photo / video / audio) ─── */
.live-question-media { margin-bottom: 16px; }
.live-question-media img,
.live-question-media video {
  width: 100%;
  max-height: 320px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: #000;
  display: block;
}

/* ─── Custom audio player (replaces the native OS-styled <audio controls>) ─── */
.audio-player {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
}
.audio-player audio { display: none; }
.audio-player-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  border: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: var(--transition);
}
.audio-player-toggle svg { position: relative; left: 1px; }
.audio-player-toggle:hover { background: var(--accent-light); box-shadow: 0 4px 20px rgba(165,126,250,0.35); }
.audio-player-time {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
  min-width: 32px;
  text-align: center;
}
.audio-player-track {
  position: relative;
  flex: 1;
  height: 6px;
  background: var(--border-strong);
  border-radius: 100px;
  cursor: pointer;
}
.audio-player-track-fill {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  background: var(--accent);
  border-radius: 100px;
  pointer-events: none;
}
.audio-player-track-thumb {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 2px var(--accent), 0 2px 6px rgba(0,0,0,0.4);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/* ─── Custom video player ─── */
.video-player-frame {
  position: relative;
  cursor: pointer;
}
.video-player-frame video {
  border-radius: var(--radius-sm) var(--radius-sm) 0 0 !important;
}
.video-player-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 14, 22, 0.3);
  transition: background 0.15s ease;
}
.video-player-frame:hover .video-player-overlay { background: rgba(20, 14, 22, 0.42); }
.video-player-overlay-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  box-shadow: 0 4px 24px rgba(0,0,0,0.45);
}
.video-player-overlay-btn svg { width: 26px; height: 26px; position: relative; left: 2px; }
.video-player-controls {
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  border-top: none;
}

/* ─── LIVE QUIZ: typed-answer question ─── */
.live-text-answer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 480px;
  margin: 0 auto;
}
.input-lg { padding: 16px 20px; font-size: 16px; text-align: center; }
.live-text-result {
  text-align: center;
  padding: 12px;
  border-radius: var(--radius-sm);
  font-weight: 600;
}
.live-text-result.correct { background: rgba(74, 222, 128, 0.12); color: var(--success); }
.live-text-result.wrong { background: rgba(248, 113, 113, 0.12); color: var(--error); }

/* ─── MISC ─── */
.text-center { text-align: center; }
.text-accent { color: var(--accent); }
.text-muted { color: var(--text-muted); }
.text-sm { font-size: 13px; }
.mt-8 { margin-top: 8px; }
.mt-16 { margin-top: 16px; }
.mt-24 { margin-top: 24px; }
.mb-16 { margin-bottom: 16px; }
.gap-8 { gap: 8px; }
.flex { display: flex; }
.flex-col { display: flex; flex-direction: column; }
.items-center { align-items: center; }
.justify-between { justify-content: space-between; }

.progress-bar {
  height: 4px;
  background: var(--bg-elevated);
  border-radius: 2px;
  overflow: hidden;
  width: 100%;
  max-width: 700px;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-light));
  border-radius: 2px;
  transition: width 0.5s ease;
}

.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  padding: 14px 24px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  font-size: 14px;
  box-shadow: var(--shadow-lg);
  animation: slide-up 0.3s ease-out;
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 10px;
}
.toast.success { border-color: var(--success); }
.toast.error { border-color: var(--error); }
@keyframes slide-up {
  0% { transform: translateY(20px); opacity: 0; }
  100% { transform: translateY(0); opacity: 1; }
}

/* ─── FOOTER ─── */
.footer {
  border-top: 1px solid var(--border);
  padding: 64px 48px 40px;
}
.footer-inner {
  max-width: 1200px;
  margin: 0 auto;
}
.footer-columns {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 24px;
  margin-bottom: 56px;
}
.footer-column-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-primary);
  margin-bottom: 20px;
}
.footer-links {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.footer-link {
  font-size: 14px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: color 0.15s ease;
  width: fit-content;
}
.footer-link:hover { color: var(--text-primary); }
.footer-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 32px;
  border-top: 1px solid var(--border);
}
.footer-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-body);
  font-weight: 700;
  font-size: 16px;
  color: var(--text-primary);
}
.footer-socials {
  display: flex;
  align-items: center;
  gap: 16px;
}
.footer-social-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: color 0.15s ease;
}
.footer-social-icon:hover { color: var(--text-primary); }

/* ─── RESPONSIVE ─── */
@media (max-width: 900px) {
  .footer-columns { grid-template-columns: repeat(2, 1fr); gap: 32px; }
}

/* Планшет/большой телефон — верхнее меню и карточки квизов ещё не
   ломаются, но начинают требовать более компактной раскладки. */
@media (max-width: 700px) {
  .nav { padding: 14px 20px; }
  .nav-brand-text { display: none; }
  .nav-links { gap: 4px; }
  .nav-link { padding: 8px 10px; font-size: 13px; }
  .nav-links .btn-sm { padding: 8px 14px; font-size: 13px; }

  /* Строка квиза в «Мои квизы»/каталоге: было 5 колонок в один ряд —
     не помещалось на телефоне и вылезало за экран. Заголовок теперь
     на всю ширину сверху, остальное (бейдж/статы/кнопки) перетекает
     под него и само переносится по мере нехватки места. */
  .quiz-item {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 14px 16px;
  }
  .quiz-item > div:first-child { width: 100%; }

  .live-question-card { padding: 28px 20px; }
  .leaderboard { padding: 24px 16px; }
  .lobby { padding: 24px 16px; }
  .join-page { padding: 16px; }
  .join-card { padding: 32px 24px; }
  .auth-form-wrap { padding: 24px; }
}

/* Телефон */
@media (max-width: 600px) {
  .nav { padding: 12px 16px; }
  .hero { padding: 60px 20px 40px; }
  .features-section { padding: 20px 16px 40px; }
  .main-content { padding: 20px 16px; }
  .creator { padding: 20px 16px; }
  .live-answers { grid-template-columns: 1fr; }
  .creator-grid { grid-template-columns: 1fr; }
  .answers-grid { grid-template-columns: 1fr; }
  .auth-page { grid-template-columns: 1fr; }
  .auth-side { display: none; }
  .podium { gap: 8px; }
  .podium-place { padding: 16px; min-width: 100px; }
  .footer { padding: 40px 20px 24px; }
  .footer-columns { grid-template-columns: 1fr; gap: 28px; }
  .footer-bottom { flex-direction: column; gap: 20px; align-items: flex-start; }

  /* Дашборд */
  .stats-row { grid-template-columns: 1fr 1fr; gap: 12px; }
  .stat-card { padding: 16px; }
  .stat-value { font-size: 22px; }
  .catalog-search-wrap { max-width: none; }

  /* Конструктор квиза */
  .topic-block { padding: 14px; }
  .question-card { padding: 16px; }
  .creator-section h3 { font-size: 16px; }

  /* Лобби */
  .lobby-code { font-size: 40px; letter-spacing: 6px; }
  .lobby-players { max-width: 100%; }

  /* Игра */
  .live-header { max-width: 100%; gap: 12px; }
  .live-timer { width: 52px; height: 52px; font-size: 19px; }
  .live-question-card h3 { font-size: 19px; }
  .live-answer-btn { padding: 14px 16px; font-size: 14px; }
  .live-roster-panel { max-width: 100%; }

  .audio-player,
  .video-player-controls { padding: 10px 14px; gap: 10px; }
  .audio-player-toggle { width: 38px; height: 38px; }
  .audio-player-time { min-width: 28px; font-size: 11px; }
  .video-player-overlay-btn { width: 52px; height: 52px; }
  .video-player-overlay-btn svg { width: 22px; height: 22px; }

  /* Результаты */
  .leaderboard h2 { font-size: 28px; }
  .lb-row { padding: 12px 14px; gap: 10px; }

  /* Модалка/тосты не должны вылезать за экран */
  .toast { left: 16px; right: 16px; max-width: none; }
}

/* Совсем узкие телефоны — 3 места на подиуме теснее всего. */
@media (max-width: 380px) {
  .podium { gap: 6px; }
  .podium-place { padding: 12px 10px; min-width: 0; flex: 1; }
  .podium-avatar { width: 38px; height: 38px; font-size: 15px; }
  .podium-name { font-size: 13px; }
  .stats-row { grid-template-columns: 1fr; }
}
`;

// ─── App ─────────────────────────────────────────────────────────
const emptyGameState = {
  roomCode: null,
  quizTitle: "",
  isOrganizer: false,
  myNickname: "",
  participants: [],
  status: "lobby",       // lobby | live | finished
  phase: "lobby",        // lobby | question | reveal | standings | finished
  question: null,
  answeredCount: 0,
  answeredTotal: 0,
  revealData: null,
  standings: [],
  wasKicked: false,
  wsConnected: false,
  error: null,
};

export default function App() {
  // Обычно это просто состояние без адресной строки — но OAuth-редирект и
  // ссылка сброса пароля приходят настоящим переходом браузера на
  // конкретный путь, так что для этих двух случаев стартовую страницу
  // нужно определить по window.location, а не всегда открывать лендинг.
  const [page, setPage] = useState(() => {
    const path = window.location.pathname;
    if (path === "/oauth-callback") return "oauth-callback";
    if (path === "/reset-password") return "reset-password";
    return "landing";
  });
  const [authMode, setAuthMode] = useState("login");
  const [role, setRole] = useState("organizer");
  const [user, setUser] = useState(null);
  const [toast, setToast] = useState(null);
  const [dashTab, setDashTab] = useState("quizzes");
  // Если задан — CreatorPage открывается в режиме редактирования этого
  // квиза вместо создания нового.
  const [editingQuizId, setEditingQuizId] = useState(null);
  // Настройка квиза (задаётся в CreatorPage, читается в LiveQuizPage) —
  // показывать таблицу очков после каждого вопроса или только в конце.
  const [resultsMode, setResultsMode] = useState("afterEach"); // "afterEach" | "atEnd"
  // Организатор может участвовать в собственном квизе как игрок —
  // переключается в лобби.
  const [organizerPlaying, setOrganizerPlaying] = useState(true);

  // Живое состояние текущей комнаты — обновляется событиями WebSocket,
  // общее на лобби/игру/результаты, чтобы при переходе между страницами
  // соединение не пересоздавалось и события не терялись.
  const [gameState, setGameState] = useState(emptyGameState);
  const wsRef = useRef(null);

  useEffect(() => {
    loadGoogleFonts();
    // Токены могли остаться в localStorage с прошлого визита — не
    // заставляем логиниться заново, тихо подтягиваем профиль.
    if (authTokens.access || authTokens.refresh) {
      apiRequest("/api/auth/me/")
        .then((me) => applyLoggedInUser(me))
        .catch(() => clearAuthTokens());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showToast = useCallback((message, type = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const navigate = (p) => setPage(p);

  // Открыть CreatorPage — либо с чистого листа, либо в режиме
  // редактирования конкретного квиза (quizId).
  const openCreator = (quizId = null) => {
    setEditingQuizId(quizId);
    navigate("creator");
  };

  // ─── Игровой WebSocket ───────────────────────────────────────────
  const handleGameEvent = useCallback((event, payload) => {
    setGameState((prev) => {
      switch (event) {
        case "participant_joined":
          if (prev.participants.some((p) => p.nickname === payload.nickname)) return prev;
          return { ...prev, participants: [...prev.participants, payload] };
        case "participant_kicked":
          if (payload.nickname === prev.myNickname && !prev.isOrganizer) {
            return { ...prev, wasKicked: true };
          }
          return { ...prev, participants: prev.participants.filter((p) => p.nickname !== payload.nickname) };
        case "quiz_started":
          return { ...prev, status: "live" };
        case "question":
          return { ...prev, phase: "question", question: payload, answeredCount: 0, answeredTotal: 0, revealData: null };
        case "answered_count":
          return { ...prev, answeredCount: payload.answered, answeredTotal: payload.total };
        case "reveal":
          return { ...prev, phase: "reveal", revealData: payload, standings: payload.standings };
        case "standings":
          return { ...prev, phase: "standings", standings: payload.standings };
        case "quiz_finished":
          return { ...prev, phase: "finished", status: "finished", standings: payload.standings };
        case "error":
          return { ...prev, error: payload.detail };
        default:
          return prev;
      }
    });
  }, []);

  // Подключение к комнате: сперва REST-снимок (кто уже в лобби), потом
  // WebSocket поверх него — так список участников не пустой первую секунду.
  const connectToRoom = useCallback(async (roomCode, authQuery, { isOrganizer, myNickname }) => {
    if (wsRef.current) wsRef.current.close();

    let seed = { participants: [], quizTitle: "", status: "lobby", phase: "lobby" };
    try {
      const detail = await apiRequest(`/api/sessions/${roomCode}/`, { skipAuth: true });
      seed = { participants: detail.participants, quizTitle: detail.quiz_title, status: detail.status, phase: detail.phase };
    } catch {
      /* не критично — участники подтянутся по мере join-событий */
    }

    setGameState({ ...emptyGameState, roomCode, isOrganizer, myNickname, ...seed });

    wsRef.current = createGameSocket(roomCode, authQuery, {
      onEvent: handleGameEvent,
      onOpen: () => setGameState((prev) => ({ ...prev, wsConnected: true })),
      onClose: () => setGameState((prev) => ({ ...prev, wsConnected: false })),
    });
  }, [handleGameEvent]);

  const connectAsOrganizer = useCallback(
    (roomCode) => connectToRoom(roomCode, `token=${authTokens.access}`, { isOrganizer: true, myNickname: user?.name || "" }),
    [connectToRoom, user]
  );

  const connectAsParticipant = useCallback(
    (roomCode, participantToken, nickname) =>
      connectToRoom(roomCode, `participant=${participantToken}`, { isOrganizer: false, myNickname: nickname }),
    [connectToRoom]
  );

  const sendGameMessage = useCallback((type, payload) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type, payload }));
    }
  }, []);

  const leaveRoom = useCallback((destination = "dashboard") => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setGameState(emptyGameState);
    navigate(destination);
  }, []);

  // ─── Аутентификация ──────────────────────────────────────────────
  const applyLoggedInUser = (apiUser) => {
    const displayName = apiUser.name || apiUser.display_name || apiUser.username;
    setUser({ id: apiUser.id, name: displayName, role: apiUser.role });
    navigate("dashboard");
  };

  const handleAuthSubmit = async ({ name, email, password }) => {
    if (authMode === "login") {
      const tokens = await apiRequest("/api/auth/login/", {
        method: "POST",
        body: { username: email, password },
        skipAuth: true,
      });
      setAuthTokens(tokens);
      const me = await apiRequest("/api/auth/me/");
      applyLoggedInUser(me);
      showToast(`Добро пожаловать, ${me.name || me.username}!`);
    } else {
      const data = await apiRequest("/api/auth/register/", {
        method: "POST",
        body: { username: email, email, password, role, display_name: name },
        skipAuth: true,
      });
      setAuthTokens(data);
      applyLoggedInUser(data.user);
      showToast(`Добро пожаловать, ${data.user.name || data.user.username}!`);
    }
  };

  const handleLogout = () => {
    clearAuthTokens();
    setUser(null);
    setPage("landing");
    setRole("organizer");
    leaveRoom("landing");
  };

  return (
    <div className="app">
      <style>{baseStyles}</style>

      {/* Nav */}
      <nav className="nav">
        <div className="nav-brand" onClick={() => navigate(user ? "dashboard" : "landing")}>
          <Icons.Logo />
          <span className="nav-brand-text">QuizVK</span>
        </div>
        <div className="nav-links">
          {!user ? (
            <>
              <button className="nav-link" onClick={() => { navigate("join"); }}>Войти в квиз</button>
              <button className="nav-link" onClick={() => { setAuthMode("login"); navigate("auth"); }}>Войти</button>
              <button className="btn btn-primary btn-sm" onClick={() => { setAuthMode("register"); navigate("auth"); }}>Регистрация</button>
            </>
          ) : (
            <>
              <button className="nav-link" onClick={() => navigate("dashboard")}>
                <span className="flex items-center gap-8"><Icons.Home /> Главная</span>
              </button>
              <button className="nav-link" onClick={() => navigate("profile")}>
                <span className="flex items-center gap-8"><Icons.User /> Профиль</span>
              </button>
              {user.role === "player" && (
                <button className="btn btn-primary btn-sm" onClick={() => navigate("join")}>
                  Войти в квиз
                </button>
              )}
            </>
          )}
        </div>
      </nav>

      {/* Pages */}
      {page === "landing" && <LandingPage navigate={navigate} setAuthMode={setAuthMode} />}
      {page === "auth" && (
        <AuthPage
          mode={authMode}
          setMode={setAuthMode}
          role={role}
          setRole={setRole}
          onSubmit={handleAuthSubmit}
          navigate={navigate}
        />
      )}
      {page === "oauth-callback" && (
        <OAuthCallbackPage navigate={navigate} showToast={showToast} onLoggedIn={applyLoggedInUser} />
      )}
      {page === "forgot-password" && <ForgotPasswordPage navigate={navigate} />}
      {page === "reset-password" && <ResetPasswordPage navigate={navigate} showToast={showToast} />}
      {page === "profile" && user && (
        <ProfilePage user={user} setUser={setUser} navigate={navigate} showToast={showToast} onLogout={handleLogout} />
      )}
      {page === "dashboard" && user && (
        <DashboardPage
          user={user}
          navigate={navigate}
          onLogout={handleLogout}
          tab={dashTab}
          setTab={setDashTab}
          showToast={showToast}
          connectAsOrganizer={connectAsOrganizer}
          openCreator={openCreator}
        />
      )}
      {page === "creator" && (
        <CreatorPage
          navigate={navigate}
          showToast={showToast}
          resultsMode={resultsMode}
          setResultsMode={setResultsMode}
          connectAsOrganizer={connectAsOrganizer}
          editingQuizId={editingQuizId}
          setEditingQuizId={setEditingQuizId}
        />
      )}
      {page === "join" && (
        <JoinPage navigate={navigate} connectAsParticipant={connectAsParticipant} />
      )}
      {page === "lobby" && (
        <LobbyPage
          navigate={navigate}
          gameState={gameState}
          sendGameMessage={sendGameMessage}
          leaveRoom={leaveRoom}
          organizerPlaying={organizerPlaying}
          setOrganizerPlaying={setOrganizerPlaying}
        />
      )}
      {page === "live" && (
        <LiveQuizPage
          navigate={navigate}
          showToast={showToast}
          gameState={gameState}
          sendGameMessage={sendGameMessage}
          leaveRoom={leaveRoom}
          isSpectator={gameState.isOrganizer && !organizerPlaying}
        />
      )}
      {page === "leaderboard" && (
        <LeaderboardPage navigate={navigate} gameState={gameState} leaveRoom={leaveRoom} sendGameMessage={sendGameMessage} />
      )}

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === "success" ? <Icons.Check /> : <Icons.X />}
          {toast.message}
        </div>
      )}
    </div>
  );
}

// ═══ LANDING PAGE ════════════════════════════════════════════════
function LandingPage({ navigate, setAuthMode }) {
  const FILL_MS = 7200;   // в 2 раза медленнее, чем было (3600 → 7200)
  const FADE_MS = 450;    // полоска гаснет после полной загрузки
  const GAP_MS = 350;     // пауза перед стартом следующей карточки
  const [activeFeature, setActiveFeature] = useState(0);
  const [phase, setPhase] = useState("idle"); // 'filling' | 'fading' | 'idle'
  // Важно: старт с "idle" (а не "filling") — чтобы первый кадр отрисовался с width:0%
  // ДО того, как useEffect запустит анимацию. Иначе браузеру не от чего анимировать
  // переход, и полоска первой карточки сразу отрисовывается заполненной на 100%.

  useEffect(() => {
    const timeouts = [];

    function runCycle(index) {
      setActiveFeature(index);
      setPhase("filling");

      timeouts.push(setTimeout(() => {
        setPhase("fading"); // достигли 100% — полоска начинает гаснуть

        timeouts.push(setTimeout(() => {
          setPhase("idle"); // полностью погасла

          timeouts.push(setTimeout(() => {
            runCycle((index + 1) % 3); // следующая карточка, цикл повторяется
          }, GAP_MS));
        }, FADE_MS));
      }, FILL_MS));
    }

    runCycle(0);
    return () => timeouts.forEach(clearTimeout);
  }, []);

  const featureCards = [
    { label: "Создавай", title: "Живые квизы", badge: false,
      text: "Запускайте квиз и подключайте участников по уникальному коду комнаты. Вопросы появляются одновременно у всех." },
    { label: "Настраивай", title: "Гибкая настройка", badge: true,
      text: "Выбирайте категории, задавайте таймер на каждый вопрос, добавляйте изображения и настраивайте правила подсчёта." },
    { label: "Играй", title: "Мгновенный лидерборд", badge: true,
      text: "Система баллов с учётом скорости ответа. Результаты отображаются сразу по завершении квиза." },
  ];

  // Вторая строка карточек — те же 3 индекса (0/1/2), поэтому их можно
  // подсветить и загрузить синхронно с верхней строкой, используя то же
  // activeFeature/phase вместо отдельного независимого цикла.
  const secondaryFeatureCards = [
    { icon: <Icons.Users />, title: "Личный кабинет",
      text: "Участники и организаторы видят полную историю квизов, статистику и достижения в своём профиле." },
    { icon: <Icons.Image />, title: "Разные типы вопросов",
      text: "Текстовые вопросы и вопросы с изображением. Одиночный или множественный выбор ответа." },
    { icon: <Icons.Clock />, title: "Контроль времени",
      text: "Таймер на каждый вопрос. Ответ доступен только во время демонстрации — как в настоящем квиз-шоу." },
  ];

  // Общая логика заливки/подсветки для карточки с индексом i — раньше
  // жила только внутри одного .map(), теперь общая для обеих строк.
  function getCardAnimState(i) {
    const isActive = i === activeFeature;
    const showGlow = isActive && phase !== "idle";

    let fillWidth = "0%";
    let fillOpacity = 0;
    let fillTransition = "width 0s linear, opacity 0.2s ease";

    if (isActive) {
      if (phase === "filling") {
        fillWidth = "100%";
        fillOpacity = 1;
        fillTransition = `width ${FILL_MS}ms linear, opacity 0.2s ease`;
      } else if (phase === "fading") {
        fillWidth = "100%";
        fillOpacity = 0;
        fillTransition = `opacity ${FADE_MS}ms ease`;
      } else {
        fillWidth = "0%";
        fillOpacity = 0;
        fillTransition = "width 0s linear, opacity 0s linear";
      }
    }

    return { showGlow, fillWidth, fillOpacity, fillTransition };
  }

  return (
    <>
      <section className="hero">
        <div className="hero-badge">
          <Icons.Zap /> Платформа для квизов
        </div>
        <h1>
          Создавайте квизы.<br />
          <em>Играйте в реальном времени.</em>
        </h1>
        <p>
          QuizVK — платформа для проведения интерактивных квизов с подключением участников по коду комнаты, живыми таймерами и мгновенным лидербордом.
        </p>
        <div className="hero-actions">
          <button className="btn btn-primary btn-lg" onClick={() => { setAuthMode("register"); navigate("auth"); }}>
            Начать бесплатно
          </button>
          <button className="btn btn-secondary btn-lg" onClick={() => navigate("join")}>
            Войти по коду
          </button>
        </div>
      </section>

      <section className="features-section">
        <div className="features">
          {featureCards.map((f, i) => {
            const { showGlow, fillWidth, fillOpacity, fillTransition } = getCardAnimState(i);

            return (
              <div key={i} className={`feature-card card-glow ${showGlow ? "active" : ""} ${f.badge ? "has-badge" : ""}`}>
                {f.badge && <span className="new-badge">New</span>}
                <div className="feature-label">{f.label}</div>
                <h3><span>{f.title}</span></h3>
                <p>{f.text}</p>
                <div className="loading-track">
                  <div
                    className="loading-fill"
                    style={{ width: fillWidth, opacity: fillOpacity, transition: fillTransition }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="features-section" style={{ paddingTop: 0 }}>
        <div className="features">
          {secondaryFeatureCards.map((f, i) => {
            const { showGlow, fillWidth, fillOpacity, fillTransition } = getCardAnimState(i);

            return (
              <div key={i} className={`feature-card card-glow ${showGlow ? "active" : ""}`}>
                <div className="feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
                <div className="loading-track">
                  <div
                    className="loading-fill"
                    style={{ width: fillWidth, opacity: fillOpacity, transition: fillTransition }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <Footer navigate={navigate} setAuthMode={setAuthMode} />
    </>
  );
}

// ═══ FOOTER ══════════════════════════════════════════════════════
function Footer({ navigate, setAuthMode }) {
  const columns = [
    {
      title: "Продукт",
      links: ["Тарифы", "Для команд и организаций"],
    },
    {
      title: "Шаблоны квизов",
      links: ["Популярные шаблоны", "Новые шаблоны", "Категории", "Все категории"],
    },
    {
      title: "Интеграции",
      links: ["Популярные интеграции", "Ещё интеграции", "Категории приложений", "Ещё категории"],
    },
    {
      title: "Ресурсы",
      links: ["Блог", "Гайды", "Помощь", "Комьюнити", "Туториалы", "FAQ", "Почему QuizVK?"],
    },
    {
      title: "О нас",
      links: ["О компании", "Бренд", "Карьера", "Связаться с отделом продаж", "Условия использования", "Рассылка"],
    },
  ];

  const socials = [
    { name: "Facebook", icon: <Icons.Facebook /> },
    { name: "X", icon: <Icons.XLogo /> },
    { name: "Instagram", icon: <Icons.Instagram /> },
    { name: "YouTube", icon: <Icons.YouTube /> },
    { name: "LinkedIn", icon: <Icons.LinkedIn /> },
  ];

  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-columns">
          {columns.map((col) => (
            <div key={col.title} className="footer-column">
              <div className="footer-column-title">{col.title}</div>
              <div className="footer-links">
                {col.links.map((link) => (
                  <a key={link} href="#" onClick={(e) => e.preventDefault()} className="footer-link">
                    {link}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="footer-bottom">
          <div className="footer-brand">
            <Icons.Logo />
            <span>QuizVK</span>
          </div>
          <div className="footer-socials">
            {socials.map((s) => (
              <a key={s.name} href="#" onClick={(e) => e.preventDefault()} className="footer-social-icon" title={s.name}>
                {s.icon}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}


function AuthPage({ mode, setMode, role, setRole, onSubmit, navigate }) {
  const [showPass, setShowPass] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const isLogin = mode === "login";

  const handleSubmit = async () => {
    setError("");
    if (!email.trim() || !password) {
      setError("Заполните email и пароль.");
      return;
    }
    setLoading(true);
    try {
      await onSubmit({ name: name.trim(), email: email.trim(), password });
    } catch (err) {
      setError(err.message || "Что-то пошло не так. Проверьте, запущен ли бэкенд.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-form-wrap">
        <div className="auth-form">
          <h2>{isLogin ? "Войти" : "Регистрация"}</h2>
          <p className="subtitle">
            {isLogin
              ? "Войдите, чтобы управлять квизами или участвовать в них."
              : "Создайте аккаунт, чтобы начать."}
          </p>

          <div className="auth-social">
            <a className="btn-social" href={`${API_BASE}/api/auth/oauth/google/start/`}>
              <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              {isLogin ? "Войти через Google" : "Зарегистрироваться через Google"}
            </a>
            <a className="btn-social" href={`${API_BASE}/api/auth/oauth/vk/start/`}>
              <svg width="20" height="20" viewBox="0 0 20 20"><rect width="20" height="20" rx="5" fill="#0077FF"/><text x="10" y="14.5" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="700" fontSize="10.5" fill="#fff">VK</text></svg>
              {isLogin ? "Войти через ВКонтакте" : "Зарегистрироваться через ВКонтакте"}
            </a>
          </div>

          <div className="auth-divider">или</div>

          {!isLogin && (
            <div className="role-selector">
              <button
                className={`role-btn ${role === "organizer" ? "active" : ""}`}
                onClick={() => setRole("organizer")}
              >
                Организатор
              </button>
              <button
                className={`role-btn ${role === "player" ? "active" : ""}`}
                onClick={() => setRole("player")}
              >
                Участник
              </button>
            </div>
          )}

          <div className="form-fields">
            {!isLogin && (
              <div className="input-group">
                <label className="input-label">Имя</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Введите имя" />
              </div>
            )}
            <div className="input-group">
              <label className="input-label">Email</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              />
            </div>
            <div className="input-group">
              <label className="input-label">Пароль</label>
              <div className="input-password-wrap">
                <input
                  className="input"
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  style={{ width: "100%" }}
                  onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                />
                <button
                  className="input-password-toggle"
                  onClick={() => setShowPass(!showPass)}
                  type="button"
                >
                  {showPass ? <Icons.EyeOff /> : <Icons.Eye />}
                </button>
              </div>
              {isLogin && (
                <button type="button" className="auth-forgot-link" onClick={() => navigate("forgot-password")}>
                  Забыли пароль?
                </button>
              )}
            </div>
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button className="btn btn-primary btn-full btn-lg" onClick={handleSubmit} disabled={loading}>
            {loading ? "Секунду…" : isLogin ? "Войти" : "Создать аккаунт"}
          </button>

          <div className="auth-footer mt-24">
            {isLogin ? (
              <>Нет аккаунта? <button onClick={() => setMode("register")}>Зарегистрироваться</button></>
            ) : (
              <>Уже есть аккаунт? <button onClick={() => setMode("login")}>Войти</button></>
            )}
          </div>
        </div>
      </div>

      <div className="auth-side">
        <div className="auth-side-content">
          <h3>Квизы в реальном времени</h3>
          <p>Создавайте вопросы, запускайте комнату и наблюдайте, как участники соревнуются за первое место.</p>
          <div className="auth-side-visual">
            <div className="mock-q">
              <div className="mock-q-title">Вопрос 3 из 10</div>
              <div className="mock-q-text">Какой город является столицей Австралии?</div>
            </div>
            <div className="mock-answers">
              <div className="mock-ans">Сидней</div>
              <div className="mock-ans">Мельбурн</div>
              <div className="mock-ans correct">✓ Канберра</div>
              <div className="mock-ans">Перт</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══ OAUTH CALLBACK ══════════════════════════════════════════════
// Сюда браузер попадает настоящим редиректом от бэкенда после того, как
// пользователь согласился на вход через Google/VK — токены приходят в
// hash-части URL (после #), а не в query, чтобы не осесть в access-логах
// сервера при последующих запросах со страницы.
function OAuthCallbackPage({ navigate, showToast, onLoggedIn }) {
  const [error, setError] = useState("");

  useEffect(() => {
    const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const params = new URLSearchParams(raw);
    window.history.replaceState({}, "", "/");

    const errorCode = params.get("error");
    const access = params.get("access");
    const refresh = params.get("refresh");

    if (errorCode || !access || !refresh) {
      const messages = {
        access_denied: "Вход отменён.",
        expired: "Ссылка авторизации истекла — попробуйте войти ещё раз.",
        provider_error: "Не удалось получить данные от провайдера. Попробуйте ещё раз.",
      };
      setError(messages[errorCode] || "Не удалось войти. Попробуйте ещё раз.");
      return;
    }

    setAuthTokens({ access, refresh });
    apiRequest("/api/auth/me/")
      .then((me) => {
        onLoggedIn(me);
        showToast(`Добро пожаловать, ${me.name || me.username}!`);
      })
      .catch(() => {
        clearAuthTokens();
        setError("Не удалось получить профиль. Попробуйте войти ещё раз.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="join-page">
      <div className="card join-card" style={{ textAlign: "center" }}>
        {error ? (
          <>
            <h2>Не удалось войти</h2>
            <p>{error}</p>
            <button className="btn btn-primary btn-full btn-lg mt-24" onClick={() => navigate("auth")}>
              Вернуться ко входу
            </button>
          </>
        ) : (
          <>
            <h2>Входим…</h2>
            <p>Подождите секунду.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ═══ ЗАБЫЛИ ПАРОЛЬ ═══════════════════════════════════════════════
function ForgotPasswordPage({ navigate }) {
  const [identifier, setIdentifier] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!identifier.trim()) {
      setError("Введите email или логин.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await apiRequest("/api/auth/password-reset/", {
        method: "POST",
        body: { email_or_username: identifier.trim() },
        skipAuth: true,
      });
      setSent(true);
    } catch (err) {
      setError(err.message || "Что-то пошло не так. Попробуйте ещё раз.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="join-page">
      <div className="card join-card">
        <h2>Забыли пароль?</h2>
        {sent ? (
          <>
            <p>Если такой аккаунт существует, на него отправлено письмо со ссылкой для сброса пароля. Проверьте почту (и папку «Спам»).</p>
            <button className="btn btn-secondary btn-full btn-lg mt-24" onClick={() => navigate("auth")}>
              Вернуться ко входу
            </button>
          </>
        ) : (
          <>
            <p>Введите email или логин, указанный при регистрации — вышлем ссылку для сброса пароля.</p>
            <div className="input-group mb-16">
              <label className="input-label">Email или логин</label>
              <input
                className="input"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@example.com"
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                autoFocus
              />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="btn btn-primary btn-full btn-lg" onClick={handleSubmit} disabled={loading}>
              {loading ? "Отправляем…" : "Отправить ссылку"}
            </button>
            <div className="auth-footer mt-24">
              <button onClick={() => navigate("auth")}>Вернуться ко входу</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══ НОВЫЙ ПАРОЛЬ (по ссылке из письма) ═════════════════════════
function ResetPasswordPage({ navigate, showToast }) {
  const [params] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return { uid: p.get("uid") || "", token: p.get("token") || "" };
  });
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const missingLink = !params.uid || !params.token;

  const handleSubmit = async () => {
    if (password.length < 8) {
      setError("Пароль должен быть не короче 8 символов.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Пароли не совпадают.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await apiRequest("/api/auth/password-reset/confirm/", {
        method: "POST",
        body: { uid: params.uid, token: params.token, new_password: password },
        skipAuth: true,
      });
      window.history.replaceState({}, "", "/");
      setDone(true);
      showToast("Пароль изменён — теперь можно войти.");
    } catch (err) {
      setError(err.message || "Ссылка недействительна или уже использована.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="join-page">
      <div className="card join-card">
        <h2>Новый пароль</h2>
        {missingLink ? (
          <>
            <p>Ссылка для сброса пароля повреждена или неполная.</p>
            <button className="btn btn-secondary btn-full btn-lg mt-24" onClick={() => navigate("forgot-password")}>
              Запросить новую ссылку
            </button>
          </>
        ) : done ? (
          <>
            <p>Пароль успешно изменён.</p>
            <button className="btn btn-primary btn-full btn-lg mt-24" onClick={() => navigate("auth")}>
              Войти
            </button>
          </>
        ) : (
          <>
            <p>Задайте новый пароль для входа.</p>
            <div className="input-group mb-16">
              <label className="input-label">Новый пароль</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoFocus
              />
            </div>
            <div className="input-group mb-16">
              <label className="input-label">Повторите пароль</label>
              <input
                className="input"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="btn btn-primary btn-full btn-lg" onClick={handleSubmit} disabled={loading}>
              {loading ? "Сохраняем…" : "Сохранить пароль"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ═══ ПРОФИЛЬ ═════════════════════════════════════════════════════
function ProfilePage({ user, setUser, navigate, showToast, onLogout }) {
  const [displayName, setDisplayName] = useState(user.name || "");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("");
  const [linkedProviders, setLinkedProviders] = useState([]);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  useEffect(() => {
    apiRequest("/api/auth/me/")
      .then((me) => {
        setDisplayName(me.display_name || "");
        setEmail(me.email || "");
        setRole(me.role);
        setLinkedProviders(me.linked_providers || []);
      })
      .catch(() => {});
  }, []);

  const handleSaveProfile = async () => {
    setProfileError("");
    setSavingProfile(true);
    try {
      const updated = await apiRequest("/api/auth/me/", {
        method: "PATCH",
        body: { display_name: displayName.trim() },
      });
      setUser((prev) => ({ ...prev, name: updated.name }));
      showToast("Профиль обновлён");
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async () => {
    setPasswordError("");
    setPasswordSuccess(false);
    if (newPassword.length < 8) {
      setPasswordError("Новый пароль должен быть не короче 8 символов.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError("Пароли не совпадают.");
      return;
    }
    setChangingPassword(true);
    try {
      await apiRequest("/api/auth/change-password/", {
        method: "POST",
        body: { old_password: oldPassword, new_password: newPassword },
      });
      setOldPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setPasswordSuccess(true);
      showToast("Пароль изменён");
    } catch (err) {
      setPasswordError(err.message);
    } finally {
      setChangingPassword(false);
    }
  };

  const providerLabels = { google: "Google", vk: "VK" };

  return (
    <div className="creator">
      <h2>Профиль</h2>

      <div className="creator-section">
        <h3>Основная информация</h3>
        <div className="card" style={{ padding: 24 }}>
          <div className="input-group mb-16">
            <label className="input-label">Отображаемое имя</label>
            <input
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Как вас называть"
            />
          </div>
          <div className="input-group mb-16">
            <label className="input-label">Email</label>
            <input className="input" value={email} disabled style={{ opacity: 0.6 }} />
          </div>
          <div className="input-group mb-16">
            <label className="input-label">Роль</label>
            <input className="input" value={role === "organizer" ? "Организатор" : "Участник"} disabled style={{ opacity: 0.6 }} />
          </div>
          {profileError && <div className="auth-error">{profileError}</div>}
          <button className="btn btn-primary" onClick={handleSaveProfile} disabled={savingProfile}>
            {savingProfile ? "Сохраняем…" : "Сохранить"}
          </button>
        </div>
      </div>

      <div className="creator-section">
        <h3>Подключённые аккаунты</h3>
        <div className="card" style={{ padding: 24 }}>
          {linkedProviders.length === 0 ? (
            <p className="text-muted">Google и VK не подключены — вход только по паролю.</p>
          ) : (
            <p className="text-muted">Подключено: {linkedProviders.map((p) => providerLabels[p] || p).join(", ")}</p>
          )}
        </div>
      </div>

      <div className="creator-section">
        <h3>Изменить пароль</h3>
        <div className="card" style={{ padding: 24 }}>
          <div className="input-group mb-16">
            <label className="input-label">Текущий пароль</label>
            <input
              className="input"
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div className="input-group mb-16">
            <label className="input-label">Новый пароль</label>
            <input
              className="input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <div className="input-group mb-16">
            <label className="input-label">Повторите новый пароль</label>
            <input
              className="input"
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={(e) => e.key === "Enter" && handleChangePassword()}
            />
          </div>
          {passwordError && <div className="auth-error">{passwordError}</div>}
          {passwordSuccess && (
            <div className="live-text-result correct" style={{ marginBottom: 16 }}>
              Пароль изменён.
            </div>
          )}
          <button className="btn btn-secondary" onClick={handleChangePassword} disabled={changingPassword}>
            {changingPassword ? "Сохраняем…" : "Изменить пароль"}
          </button>
        </div>
      </div>

      <button className="btn btn-ghost" onClick={onLogout} style={{ color: "var(--error)" }}>
        <Icons.Logout /> Выйти из аккаунта
      </button>
    </div>
  );
}

// ═══ DASHBOARD ═══════════════════════════════════════════════════
function DashboardPage({ user, navigate, onLogout, tab, setTab, showToast, connectAsOrganizer, openCreator }) {
  const isOrg = user.role === "organizer";

  const [quizzes, setQuizzes] = useState([]);
  const [loadingQuizzes, setLoadingQuizzes] = useState(false);
  const [quizzesError, setQuizzesError] = useState("");

  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogCategory, setCatalogCategory] = useState("Все");
  const [catalogCategories, setCatalogCategories] = useState(["Все"]);
  const [catalogResults, setCatalogResults] = useState([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);

  useEffect(() => {
    if (tab !== "quizzes") return;
    let cancelled = false;
    setLoadingQuizzes(true);
    setQuizzesError("");
    apiRequest("/api/quizzes/")
      .then((data) => { if (!cancelled) setQuizzes(Array.isArray(data) ? data : data.results); })
      .catch((err) => { if (!cancelled) setQuizzesError(err.message); })
      .finally(() => { if (!cancelled) setLoadingQuizzes(false); });
    return () => { cancelled = true; };
  }, [tab]);

  useEffect(() => {
    if (tab !== "catalog") return;
    apiRequest("/api/categories/")
      .then((data) => setCatalogCategories(["Все", ...(Array.isArray(data) ? data : data.results).map((c) => c.name)]))
      .catch(() => {});
  }, [tab]);

  useEffect(() => {
    if (tab !== "catalog") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoadingCatalog(true);
      const params = new URLSearchParams();
      if (catalogQuery.trim()) params.set("search", catalogQuery.trim());
      if (catalogCategory !== "Все") params.set("category", catalogCategory);
      apiRequest(`/api/quizzes/catalog/?${params.toString()}`)
        .then((data) => { if (!cancelled) setCatalogResults(Array.isArray(data) ? data : data.results); })
        .catch(() => { if (!cancelled) setCatalogResults([]); })
        .finally(() => { if (!cancelled) setLoadingCatalog(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tab, catalogQuery, catalogCategory]);

  const handleLaunch = async (quiz) => {
    try {
      const session = await apiRequest(`/api/quizzes/${quiz.id}/sessions/`, { method: "POST" });
      await connectAsOrganizer(session.room_code);
      navigate("lobby");
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const handleClone = async (quiz) => {
    try {
      await apiRequest(`/api/quizzes/${quiz.id}/clone/`, { method: "POST" });
      setCatalogResults((prev) => prev.filter((q) => q.id !== quiz.id));
      showToast(`«${quiz.title}» добавлен в ваши квизы`);
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const totalQuestions = quizzes.reduce((sum, q) => sum + (q.questions_count || 0), 0);
  const totalPlays = quizzes.reduce((sum, q) => sum + (q.plays_count || 0), 0);

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-nav">
          <div className="sidebar-section-label">Меню</div>
          <button className={`sidebar-item ${tab === "quizzes" ? "active" : ""}`} onClick={() => setTab("quizzes")}>
            <Icons.Home /> {isOrg ? "Мои квизы" : "История"}
          </button>
          {isOrg && (
            <button className={`sidebar-item ${tab === "create" ? "active" : ""}`} onClick={() => openCreator()}>
              <Icons.Plus /> Новый квиз
            </button>
          )}
          {isOrg && (
            <button className={`sidebar-item ${tab === "catalog" ? "active" : ""}`} onClick={() => setTab("catalog")}>
              <Icons.Search /> Каталог квизов
            </button>
          )}
          {!isOrg && (
            <button className="sidebar-item" onClick={() => navigate("join")}>
              <Icons.Play /> Войти в квиз
            </button>
          )}
        </div>
        <div className="sidebar-user">
          <div className="sidebar-avatar">{user.name[0]}</div>
          <div>
            <div className="sidebar-username">{user.name}</div>
            <div className="sidebar-role">{isOrg ? "Организатор" : "Участник"}</div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onLogout} style={{ marginLeft: "auto" }} title="Выйти">
            <Icons.Logout />
          </button>
        </div>
      </aside>

      <main className="main-content">
        {tab === "quizzes" && (
          <>
            <div className="page-header">
              <h2>{isOrg ? "Мои квизы" : "История квизов"}</h2>
            </div>

            <div className="stats-row">
              <div className="card stat-card">
                <div className="stat-label">Всего квизов</div>
                <div className="stat-value accent">{loadingQuizzes ? "…" : quizzes.length}</div>
              </div>
              <div className="card stat-card">
                <div className="stat-label">Всего вопросов</div>
                <div className="stat-value">{loadingQuizzes ? "…" : totalQuestions}</div>
              </div>
              <div className="card stat-card">
                <div className="stat-label">Прохождений</div>
                <div className="stat-value">{loadingQuizzes ? "…" : totalPlays}</div>
              </div>
            </div>

            {quizzesError && <div className="auth-error">Не удалось загрузить квизы: {quizzesError}</div>}

            {!loadingQuizzes && quizzes.length === 0 && !quizzesError ? (
              <div className="card catalog-empty">Пока нет ни одного квиза — самое время создать первый.</div>
            ) : (
              <div className="quiz-list">
                {quizzes.map((q) => (
                  <div key={q.id} className="card quiz-item" onClick={() => openCreator(q.id)} title="Открыть для редактирования">
                    <div>
                      <div className="quiz-item-title">{q.title}</div>
                      <div className="quiz-item-meta">
                        {q.category || "Без категории"} · {q.questions_count} вопросов · {new Date(q.created_at).toLocaleDateString("ru-RU")}
                      </div>
                    </div>
                    <span className={`quiz-item-badge ${q.status === "published" ? "badge-live" : "badge-draft"}`}>
                      {q.status === "published" ? "Опубликован" : "Черновик"}
                    </span>
                    <span className="text-sm text-muted">
                      {q.plays_count > 0 ? `${q.plays_count} прохождений` : "—"}
                    </span>
                    <button
                      className="btn btn-ghost btn-icon"
                      title="Редактировать"
                      onClick={(e) => { e.stopPropagation(); openCreator(q.id); }}
                    >
                      <Icons.Edit />
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); handleLaunch(q); }}>
                      <Icons.Play /> Запустить
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === "catalog" && (
          <>
            <div className="page-header">
              <h2>Каталог квизов</h2>
            </div>
            <p className="text-muted mb-16">Готовые квизы других организаторов — добавьте понравившийся себе и запускайте как свой.</p>

            <div className="catalog-search-wrap">
              <span className="catalog-search-icon"><Icons.Search /></span>
              <input
                className="input"
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
                placeholder="Поиск по названию или автору..."
              />
            </div>

            <div className="catalog-categories">
              {catalogCategories.map((c) => (
                <button
                  key={c}
                  className={`catalog-category-pill ${catalogCategory === c ? "active" : ""}`}
                  onClick={() => setCatalogCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>

            {!loadingCatalog && catalogResults.length === 0 ? (
              <div className="card catalog-empty">Ничего не нашлось — попробуйте другой запрос или категорию.</div>
            ) : (
              <div className="quiz-list">
                {catalogResults.map((q) => (
                  <div key={q.id} className="card quiz-item">
                    <div>
                      <div className="quiz-item-title">{q.title}</div>
                      <div className="quiz-item-meta">
                        {q.category || "Без категории"} · {q.questions_count} вопросов · автор {q.owner_name} · {q.plays_count} прохождений
                      </div>
                    </div>
                    <button className="btn btn-secondary btn-sm" onClick={() => handleClone(q)}>
                      <Icons.Plus /> Добавить себе
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ═══ QUIZ CREATOR ════════════════════════════════════════════════
function CreatorPage({ navigate, showToast, resultsMode, setResultsMode, connectAsOrganizer, editingQuizId, setEditingQuizId }) {
  const CATEGORY_OPTIONS = ["География", "Наука", "История", "Программирование", "Развлечения", "Спорт"];
  const makeQuestion = () => ({
    text: "",
    type: "single",
    mediaUrl: "", mediaName: "", mediaType: "",
    timeLimit: 20,
    answers: [
      { text: "", correct: false },
      { text: "", correct: false },
      { text: "", correct: false },
      { text: "", correct: false },
    ],
  });
  const makeTopic = (title = "") => ({ id: Date.now() + Math.random(), title, questions: [makeQuestion()] });

  // Простой квиз — это квиз с ОДНОЙ темой; хранится всё равно как topics,
  // просто в простом режиме заголовок темы скрыт и добавить вторую тему нельзя.
  const [quizMode, setQuizMode] = useState("simple"); // "simple" | "topics"
  const [topics, setTopics] = useState([
    {
      id: 1,
      title: "",
      questions: [
        {
          text: "Какой город является столицей Австралии?",
          type: "single",
          mediaUrl: "", mediaName: "", mediaType: "",
          timeLimit: 20,
          answers: [
            { text: "Сидней", correct: false },
            { text: "Мельбурн", correct: false },
            { text: "Канберра", correct: true },
            { text: "Перт", correct: false },
          ],
        },
      ],
    },
  ]);
  const [category, setCategory] = useState("География");
  const [customCategory, setCustomCategory] = useState("");
  const [title, setTitle] = useState("Столицы мира");
  const [timePerQuestion, setTimePerQuestion] = useState(20);
  const [pointsPerQuestion, setPointsPerQuestion] = useState(100);
  const [speedBonusEnabled, setSpeedBonusEnabled] = useState(true);
  const [isPublic, setIsPublic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [loadingExisting, setLoadingExisting] = useState(false);

  const [aiDescription, setAiDescription] = useState("");
  const [aiNumQuestions, setAiNumQuestions] = useState(5);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiError, setAiError] = useState("");

  const handleGenerateWithAI = async () => {
    if (!aiDescription.trim()) {
      setAiError("Опишите, какой квиз нужен — тему, для кого, сложность.");
      return;
    }
    setAiError("");
    setAiGenerating(true);
    try {
      const data = await aiGenerateQuiz({
        description: aiDescription.trim(),
        numQuestions: Number(aiNumQuestions) || 5,
        mode: quizMode,
      });
      const adapted = adaptGeneratedQuiz(data);
      setTitle(adapted.title);
      if (CATEGORY_OPTIONS.includes(adapted.category)) {
        setCategory(adapted.category);
        setCustomCategory("");
      } else {
        setCategory("custom");
        setCustomCategory(adapted.category);
      }
      setQuizMode(adapted.mode);
      setTopics(adapted.topics);
      showToast("Квиз сгенерирован — проверьте и отредактируйте перед сохранением");
    } catch (err) {
      setAiError(err.message);
    } finally {
      setAiGenerating(false);
    }
  };

  useEffect(() => {
    if (!editingQuizId) return;
    let cancelled = false;
    setLoadingExisting(true);
    setSubmitError("");
    apiRequest(`/api/quizzes/${editingQuizId}/`)
      .then((data) => {
        if (cancelled) return;
        setTitle(data.title);
        if (CATEGORY_OPTIONS.includes(data.category)) {
          setCategory(data.category);
          setCustomCategory("");
        } else {
          setCategory("custom");
          setCustomCategory(data.category || "");
        }
        setQuizMode(data.mode);
        setResultsMode(data.results_mode === "after_each" ? "afterEach" : "atEnd");
        setTimePerQuestion(data.time_per_question);
        setPointsPerQuestion(data.points_per_question);
        setSpeedBonusEnabled(data.speed_bonus_enabled);
        setIsPublic(data.is_public);
        setTopics(
          data.topics.map((t) => ({
            id: t.id,
            title: t.title,
            questions: t.questions.map((q) => ({
              id: q.id,
              text: q.text,
              type: q.type,
              mediaUrl: q.media || "",
              mediaName: q.media ? decodeURIComponent(q.media.split("/").pop()) : "",
              mediaType: q.media_type,
              mediaFile: null,
              timeLimit: q.time_limit,
              answers: q.answers.map((a) => ({ id: a.id, text: a.text, correct: a.is_correct })),
            })),
          }))
        );
      })
      .catch((err) => !cancelled && setSubmitError(err.message))
      .finally(() => !cancelled && setLoadingExisting(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingQuizId]);

  const totalQuestions = topics.reduce((sum, t) => sum + t.questions.length, 0);

  const updateTopicQuestions = (ti, updater) => {
    setTopics((prev) => {
      const next = [...prev];
      next[ti] = { ...next[ti], questions: updater(next[ti].questions) };
      return next;
    });
  };

  const addTopic = () => setTopics((prev) => [...prev, makeTopic(`Тема ${prev.length + 1}`)]);

  const removeTopic = (ti) => {
    if (topics.length <= 1) return;
    topics[ti].questions.forEach((q) => { if (q.mediaUrl) URL.revokeObjectURL(q.mediaUrl); });
    setTopics((prev) => prev.filter((_, i) => i !== ti));
  };

  const updateTopicTitle = (ti, title) => {
    setTopics((prev) => {
      const next = [...prev];
      next[ti] = { ...next[ti], title };
      return next;
    });
  };

  const addQuestion = (ti) => updateTopicQuestions(ti, (qs) => [...qs, makeQuestion()]);

  const removeQuestion = (ti, qi) => {
    if (topics[ti].questions.length <= 1) return;
    if (topics[ti].questions[qi].mediaUrl) URL.revokeObjectURL(topics[ti].questions[qi].mediaUrl);
    updateTopicQuestions(ti, (qs) => qs.filter((_, i) => i !== qi));
  };

  const updateQuestion = (ti, qi, field, value) => {
    updateTopicQuestions(ti, (qs) => {
      const next = [...qs];
      next[qi] = { ...next[qi], [field]: value };
      return next;
    });
  };

  const updateAnswer = (ti, qi, aIdx, field, value) => {
    updateTopicQuestions(ti, (qs) => {
      const next = [...qs];
      const answers = [...next[qi].answers];
      answers[aIdx] = { ...answers[aIdx], [field]: value };
      if (field === "correct" && next[qi].type === "single" && value) {
        answers.forEach((a, i) => { if (i !== aIdx) a.correct = false; });
      }
      next[qi] = { ...next[qi], answers };
      return next;
    });
  };

  // У вариантов выбора хранится 4 ответа, у текстового — один принимаемый
  // вариант. При смене типа переформатируем answers под новую форму,
  // стараясь не потерять то, что уже было введено как правильный ответ.
  const changeQuestionType = (ti, qi, newType) => {
    updateTopicQuestions(ti, (qs) => {
      const next = [...qs];
      const prevQ = next[qi];
      let answers = prevQ.answers;

      if (newType === "text" && prevQ.type !== "text") {
        const current = prevQ.answers.find((a) => a.correct) || prevQ.answers[0];
        answers = [{ text: current?.text || "", correct: true }];
      } else if (newType !== "text" && prevQ.type === "text") {
        answers = [
          { text: prevQ.answers[0]?.text || "", correct: true },
          { text: "", correct: false },
          { text: "", correct: false },
          { text: "", correct: false },
        ];
      }

      next[qi] = { ...prevQ, type: newType, answers };
      return next;
    });
  };

  // Фото для вопросов на эрудицию, видео — для отрывков из фильмов,
  // аудио — для вопросов "угадай мелодию". Тип медиа определяется по
  // MIME-типу самого файла, а не по расширению. Сам File держим в
  // состоянии до сохранения квиза — грузим на бэкенд отдельным запросом
  // уже после того, как у вопроса появится реальный id.
  const handleMediaSelect = (ti, qi, file) => {
    if (!file) return;
    const prevUrl = topics[ti].questions[qi].mediaUrl;
    if (prevUrl?.startsWith("blob:")) URL.revokeObjectURL(prevUrl);
    const url = URL.createObjectURL(file);
    const mediaType = file.type.split("/")[0] || "image"; // "image" | "video" | "audio"
    updateTopicQuestions(ti, (qs) => {
      const next = [...qs];
      next[qi] = { ...next[qi], mediaUrl: url, mediaName: file.name, mediaType, mediaFile: file };
      return next;
    });
  };

  const removeMedia = (ti, qi) => {
    const question = topics[ti].questions[qi];
    if (question.mediaUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(question.mediaUrl);
    } else if (question.mediaUrl && Number.isInteger(question.id)) {
      // Уже сохранённое на бэкенде медиа — убираем его там же и сразу,
      // а не откладываем до общего сохранения квиза.
      apiRequest(`/api/questions/${question.id}/media/`, { method: "DELETE" }).catch(() => {});
    }
    updateTopicQuestions(ti, (qs) => {
      const next = [...qs];
      next[qi] = { ...next[qi], mediaUrl: "", mediaName: "", mediaType: "", mediaFile: null };
      return next;
    });
  };

  const typeLabels = { single: "Один ответ", multiple: "Несколько ответов", text: "Ввод текстом" };
  const mediaTypeLabels = { image: "Фото", video: "Видео", audio: "Аудио" };

  const renderQuestionCard = (ti, q, qi, showRemove) => (
    <div key={qi} className="card question-card">
      <div className="question-header">
        <span className="question-number">#{qi + 1}</span>
        <div className="flex items-center gap-8">
          <span className="question-type-badge">{typeLabels[q.type]}</span>
          {showRemove && (
            <button className="btn btn-ghost btn-sm" onClick={() => removeQuestion(ti, qi)} style={{ color: "var(--error)", padding: "4px 8px" }}>
              <Icons.Trash />
            </button>
          )}
        </div>
      </div>

      <div className="input-group mb-16">
        <label className="input-label">Текст вопроса</label>
        <input
          className="input"
          value={q.text}
          onChange={(e) => updateQuestion(ti, qi, "text", e.target.value)}
          placeholder="Введите вопрос..."
        />
      </div>

      <div className="creator-grid mb-16">
        <div className="input-group">
          <label className="input-label">Тип вопроса</label>
          <select
            className="select"
            value={q.type}
            onChange={(e) => changeQuestionType(ti, qi, e.target.value)}
          >
            <option value="single">Одиночный выбор</option>
            <option value="multiple">Множественный выбор</option>
            <option value="text">Ввод текстом</option>
          </select>
        </div>
        <div className="input-group">
          <label className="input-label">Медиа к вопросу (необязательно)</label>
          {q.mediaUrl ? (
            <div className="image-preview">
              {q.mediaType === "image" && <img src={q.mediaUrl} alt="" />}
              {q.mediaType === "video" && <video src={q.mediaUrl} muted />}
              {q.mediaType === "audio" && <div className="media-audio-chip"><Icons.Zap /></div>}
              <span className="image-preview-name">
                {mediaTypeLabels[q.mediaType] || "файл"} · {q.mediaName || ""}
              </span>
              <button type="button" className="image-preview-remove" title="Убрать медиа" onClick={() => removeMedia(ti, qi)}>
                <Icons.X />
              </button>
            </div>
          ) : (
            <label className="image-upload-btn" htmlFor={`q-media-${ti}-${qi}`}>
              <Icons.Image /> Прикрепить фото, видео или аудио
              <input
                id={`q-media-${ti}-${qi}`}
                type="file"
                accept="image/*,video/*,audio/*"
                onChange={(e) => handleMediaSelect(ti, qi, e.target.files?.[0])}
              />
            </label>
          )}
        </div>
      </div>

      {q.type === "text" ? (
        <div className="input-group">
          <label className="input-label">Правильный ответ</label>
          <input
            className="input"
            value={q.answers[0]?.text || ""}
            onChange={(e) => updateAnswer(ti, qi, 0, "text", e.target.value)}
            placeholder="Например: Канберра"
          />
          <div className="input-hint">Игрок вводит ответ вручную с клавиатуры — регистр не учитывается.</div>
        </div>
      ) : (
        <>
          <div className="input-label" style={{ marginBottom: 8 }}>
            Варианты ответов (нажмите ○ для правильного)
          </div>
          <div className="answers-grid">
            {q.answers.map((a, ai) => (
              <div key={ai} className="answer-input-wrap">
                <input
                  className="input"
                  value={a.text}
                  onChange={(e) => updateAnswer(ti, qi, ai, "text", e.target.value)}
                  placeholder={`Вариант ${String.fromCharCode(65 + ai)}`}
                />
                <button
                  className={`correct-toggle ${a.correct ? "active" : ""}`}
                  onClick={() => updateAnswer(ti, qi, ai, "correct", !a.correct)}
                  title="Отметить как правильный"
                >
                  <Icons.Check />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );

  // Собираем то, что реально ждёт бэкенд: {text, is_correct} вместо
  // {text, correct}, без mediaUrl/mediaFile/mediaName (медиа грузится
  // отдельным запросом уже после того, как вопрос получит настоящий id).
  // id добавляем только когда он настоящий, серверный (целое число) —
  // у локально добавленных тем/вопросов/ответов id либо нет, либо это
  // временный ключ для React (Date.now()+Math.random(), не целое).
  const withId = (obj, id) => (Number.isInteger(id) ? { ...obj, id } : obj);

  const buildPayload = (status) => ({
    title: title.trim() || "Без названия",
    category: category === "custom" ? customCategory.trim() || "Без категории" : category,
    mode: quizMode,
    status,
    results_mode: resultsMode === "afterEach" ? "after_each" : "at_end",
    points_per_question: Number(pointsPerQuestion) || 100,
    speed_bonus_enabled: speedBonusEnabled,
    time_per_question: Number(timePerQuestion) || 20,
    is_public: isPublic,
    topics: topics.map((t) =>
      withId(
        {
          title: t.title,
          questions: t.questions.map((q) =>
            withId(
              {
                text: q.text,
                type: q.type,
                answers: q.answers.map((a) => withId({ text: a.text, is_correct: a.correct }, a.id)),
              },
              q.id
            )
          ),
        },
        t.id
      )
    ),
  });

  // Загружает медиа для вопросов, у которых выбран НОВЫЙ локальный файл —
  // сопоставляя по порядку с вопросами, которые вернул бэкенд (порядок
  // совпадает с отправленным, включая переиспользованные при правке id).
  const uploadPendingMedia = async (savedQuiz) => {
    for (let ti = 0; ti < topics.length; ti++) {
      for (let qi = 0; qi < topics[ti].questions.length; qi++) {
        const file = topics[ti].questions[qi].mediaFile;
        if (!file) continue;
        const savedQuestion = savedQuiz.topics[ti]?.questions[qi];
        if (!savedQuestion) continue;
        const form = new FormData();
        form.append("file", file);
        await apiRequest(`/api/questions/${savedQuestion.id}/media/`, {
          method: "POST",
          body: form,
          isFormData: true,
        });
      }
    }
  };

  const saveQuiz = (status) =>
    editingQuizId
      ? apiRequest(`/api/quizzes/${editingQuizId}/`, { method: "PATCH", body: buildPayload(status) })
      : apiRequest("/api/quizzes/", { method: "POST", body: buildPayload(status) });

  const handleSaveDraft = async () => {
    setSubmitError("");
    setSubmitting(true);
    try {
      const saved = await saveQuiz("draft");
      await uploadPendingMedia(saved);
      showToast(editingQuizId ? "Изменения сохранены" : "Черновик сохранён");
      setEditingQuizId(null);
      navigate("dashboard");
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLaunch = async () => {
    setSubmitError("");
    setSubmitting(true);
    try {
      const saved = await saveQuiz("published");
      await uploadPendingMedia(saved);
      const session = await apiRequest(`/api/quizzes/${saved.id}/sessions/`, { method: "POST" });
      showToast("Квиз сохранён! Запускаем комнату…");
      setEditingQuizId(null);
      await connectAsOrganizer(session.room_code);
      navigate("lobby");
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingExisting) {
    return (
      <div className="creator">
        <h2>Редактировать квиз</h2>
        <p className="text-muted">Загружаем квиз…</p>
      </div>
    );
  }

  return (
    <div className="creator">
      <h2>{editingQuizId ? "Редактировать квиз" : "Создать квиз"}</h2>

      {!editingQuizId && (
        <div className="ai-generate-panel">
          <div className="ai-generate-header">
            <span className="ai-generate-icon"><Icons.Sparkles /></span>
            <div>
              <h3>Сгенерировать с помощью ИИ</h3>
              <p className="text-muted">Опишите, какой квиз нужен — тему, для кого, сложность — и нейросеть соберёт черновик. Всё можно проверить и поправить перед сохранением.</p>
            </div>
          </div>
          <textarea
            className="input ai-generate-textarea"
            value={aiDescription}
            onChange={(e) => setAiDescription(e.target.value)}
            placeholder="Например: квиз про историю Древнего Рима для старшеклассников, средней сложности"
            rows={3}
          />
          <div className="ai-generate-row">
            <div className="input-group">
              <label className="input-label">Количество вопросов</label>
              <input
                className="input"
                type="number"
                min={1}
                max={15}
                value={aiNumQuestions}
                onChange={(e) => setAiNumQuestions(e.target.value)}
              />
            </div>
            <button className="btn btn-accent" onClick={handleGenerateWithAI} disabled={aiGenerating}>
              <Icons.Sparkles /> {aiGenerating ? "Генерируем…" : "Сгенерировать"}
            </button>
          </div>
          {aiError && <div className="ai-generate-error">{aiError}</div>}
        </div>
      )}

      <div className="creator-section">
        <h3>Основные настройки</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="input-group">
            <label className="input-label">Название квиза</label>
            <input className="input" placeholder="Например: Столицы мира" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div className="input-group">
            <label className="input-label">Структура квиза</label>
            <div className="quiz-mode-toggle">
              <button type="button" className={`quiz-mode-btn ${quizMode === "simple" ? "active" : ""}`} onClick={() => setQuizMode("simple")}>
                Простой квиз
              </button>
              <button type="button" className={`quiz-mode-btn ${quizMode === "topics" ? "active" : ""}`} onClick={() => setQuizMode("topics")}>
                Квиз с темами
              </button>
            </div>
            <div className="input-hint">
              {quizMode === "simple"
                ? "Один список вопросов по одной теме."
                : "Несколько тем внутри одного квиза — у каждой свои вопросы, как подтемы."}
            </div>
          </div>

          <div className="creator-grid">
            <div className="input-group">
              <label className="input-label">Категория</label>
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option>География</option>
                <option>Наука</option>
                <option>История</option>
                <option>Программирование</option>
                <option>Развлечения</option>
                <option>Спорт</option>
                <option value="custom">Своя категория…</option>
              </select>
              {category === "custom" && (
                <input
                  className="input mt-8"
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value)}
                  placeholder="Введите название категории"
                  autoFocus
                />
              )}
            </div>
            <div className="input-group">
              <label className="input-label">Время на вопрос (сек)</label>
              <input
                className="input"
                type="number"
                value={timePerQuestion}
                onChange={(e) => setTimePerQuestion(e.target.value)}
                min={5}
                max={120}
              />
            </div>
          </div>
          <div className="creator-grid">
            <div className="input-group">
              <label className="input-label">Баллы за правильный ответ</label>
              <input
                className="input"
                type="number"
                value={pointsPerQuestion}
                onChange={(e) => setPointsPerQuestion(e.target.value)}
                min={10}
              />
            </div>
            <div className="input-group">
              <label className="input-label">Бонус за скорость</label>
              <select
                className="select"
                value={speedBonusEnabled ? "on" : "off"}
                onChange={(e) => setSpeedBonusEnabled(e.target.value === "on")}
              >
                <option value="on">Включён</option>
                <option value="off">Выключен</option>
              </select>
            </div>
          </div>
          <div className="input-group">
            <label className="input-label">Показ результатов</label>
            <select className="select" value={resultsMode} onChange={(e) => setResultsMode(e.target.value)}>
              <option value="afterEach">После каждого вопроса</option>
              <option value="atEnd">Только в конце квиза</option>
            </select>
            <div className="input-hint">
              {resultsMode === "afterEach"
                ? "Между вопросами участники 20 секунд видят промежуточную таблицу очков."
                : "Участники узнают счёт только на финальном экране результатов."}
            </div>
          </div>
          <label className="lobby-play-toggle" style={{ marginBottom: 0 }}>
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            Опубликовать в каталоге (другие организаторы смогут добавить себе)
          </label>
        </div>
      </div>

      {quizMode === "simple" ? (
        <div className="creator-section">
          <h3>Вопросы ({topics[0].questions.length})</h3>
          {topics[0].questions.map((q, qi) => renderQuestionCard(0, q, qi, topics[0].questions.length > 1))}
          <button className="btn btn-secondary btn-full" onClick={() => addQuestion(0)}>
            <Icons.Plus /> Добавить вопрос
          </button>
        </div>
      ) : (
        <div className="creator-section">
          <h3 className="mb-16">Темы ({topics.length}) · {totalQuestions} вопросов всего</h3>
          {topics.map((t, ti) => (
            <div key={t.id} className="topic-block">
              <div className="topic-block-header">
                <input
                  className="input topic-title-input"
                  value={t.title}
                  onChange={(e) => updateTopicTitle(ti, e.target.value)}
                  placeholder={`Название темы ${ti + 1}`}
                />
                {topics.length > 1 && (
                  <button className="btn btn-ghost btn-sm" onClick={() => removeTopic(ti)} style={{ color: "var(--error)" }}>
                    <Icons.Trash /> Удалить тему
                  </button>
                )}
              </div>
              {t.questions.map((q, qi) => renderQuestionCard(ti, q, qi, t.questions.length > 1))}
              <button className="btn btn-secondary btn-full" onClick={() => addQuestion(ti)}>
                <Icons.Plus /> Добавить вопрос в тему
              </button>
            </div>
          ))}
          <button className="btn btn-secondary btn-full mt-24" onClick={addTopic}>
            <Icons.Plus /> Добавить тему
          </button>
        </div>
      )}

      {submitError && <div className="auth-error mt-24">{submitError}</div>}

      <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 24 }}>
        <button className="btn btn-secondary" onClick={() => { setEditingQuizId(null); navigate("dashboard"); }} disabled={submitting}>Отмена</button>
        <button className="btn btn-secondary" onClick={handleSaveDraft} disabled={submitting}>
          {submitting ? "Сохраняем…" : "Сохранить черновик"}
        </button>
        <button className="btn btn-primary" onClick={handleLaunch} disabled={submitting}>
          <Icons.Play /> {submitting ? "Запускаем…" : "Запустить квиз"}
        </button>
      </div>
    </div>
  );
}

// ═══ JOIN PAGE ════════════════════════════════════════════════════
function JoinPage({ navigate, connectAsParticipant }) {
  const [code, setCode] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleJoin = async () => {
    setError("");
    setLoading(true);
    try {
      const data = await apiRequest(`/api/sessions/${code}/join/`, {
        method: "POST",
        body: { nickname: nickname.trim() },
        skipAuth: true,
      });
      await connectAsParticipant(data.session.room_code, data.participant.token, data.participant.nickname);
      navigate("lobby");
    } catch (err) {
      setError(err.status === 404 ? "Комната с таким кодом не найдена." : err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="join-page">
      <div className="card join-card">
        <h2>Войти в квиз</h2>
        <p>Введите код комнаты, который дал организатор, и имя, под которым вас увидят остальные — регистрация не нужна</p>
        <div className="input-group mb-16">
          <label className="input-label">Ваш никнейм</label>
          <input
            className="input"
            value={nickname}
            onChange={(e) => setNickname(e.target.value.slice(0, 20))}
            placeholder="Например: Максим"
            maxLength={20}
          />
        </div>
        <div className="input-group mb-16">
          <label className="input-label">Код комнаты</label>
          <input
            className="input input-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
            placeholder="X K 9 F 2 A"
            maxLength={6}
            onKeyDown={(e) => e.key === "Enter" && handleJoin()}
          />
        </div>
        {error && <div className="auth-error">{error}</div>}
        <button
          className="btn btn-primary btn-full btn-lg"
          disabled={code.length < 4 || nickname.trim().length < 2 || loading}
          onClick={handleJoin}
        >
          {loading ? "Подключаемся…" : "Присоединиться"}
        </button>
      </div>
    </div>
  );
}

// ═══ LOBBY ═══════════════════════════════════════════════════════
function LobbyPage({ navigate, gameState, sendGameMessage, leaveRoom, organizerPlaying, setOrganizerPlaying }) {
  const { roomCode, quizTitle, isOrganizer, myNickname, participants, status, wasKicked, error } = gameState;

  // Как только организатор жмёт «Начать» — статус комнаты меняется у
  // всех подключённых одинаково, независимо от того, кто именно нажал.
  useEffect(() => {
    if (status === "live" || status === "finished") navigate("live");
  }, [status, navigate]);

  if (wasKicked) {
    return (
      <div className="join-page">
        <div className="card join-card">
          <h2>Вас удалили из комнаты</h2>
          <p>Организатор закрыл вам доступ к этому квизу.</p>
          <button className="btn btn-primary btn-full btn-lg mt-24" onClick={() => leaveRoom("landing")}>
            На главную
          </button>
        </div>
      </div>
    );
  }

  const kick = (nickname) => sendGameMessage("kick", { target_nickname: nickname });

  const handleToggleOrganizerPlaying = async (checked) => {
    setOrganizerPlaying(checked); // оптимистично — иначе чекбокс на секунду залипает
    try {
      await apiRequest(`/api/sessions/${roomCode}/toggle-play/`, {
        method: "POST",
        body: { playing: checked },
      });
    } catch {
      setOrganizerPlaying(!checked); // сервер отказал — откатываем обратно
    }
  };

  return (
    <div className="lobby">
      <div className="lobby-code">{roomCode}</div>
      <div className="lobby-label">Код комнаты</div>

      <h2>{quizTitle || "Квиз"}</h2>

      {isOrganizer && (
        <label className="lobby-play-toggle">
          <input
            type="checkbox"
            checked={organizerPlaying}
            onChange={(e) => handleToggleOrganizerPlaying(e.target.checked)}
          />
          Играть вместе с участниками
        </label>
      )}

      {error && <div className="auth-error">{error}</div>}

      <div className="lobby-count">{participants.length} участников подключено</div>

      <div className="lobby-players">
        {participants.map((p) => (
          <div key={p.nickname} className="lobby-player">
            {p.nickname}
            {isOrganizer && p.nickname !== myNickname && !p.is_organizer_player && (
              <button className="lobby-player-kick" title={`Удалить «${p.nickname}» из комнаты`} onClick={() => kick(p.nickname)}>
                <Icons.X />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="lobby-waiting">
        <span className="lobby-dot" />
        {isOrganizer ? "Нажмите «Начать», когда все подключатся" : "Ожидаем начала квиза…"}
      </div>

      {isOrganizer && (
        <button className="btn btn-primary btn-lg mt-24" onClick={() => sendGameMessage("start")}>
          <Icons.Play /> Начать квиз
        </button>
      )}
    </div>
  );
}

// ═══ LIVE QUIZ ═══════════════════════════════════════════════════
// Нативный <audio controls> выглядит как чужеродный виджет ОС поверх
// тёмной темы сайта — рисуем свои play/pause, шкалу и таймер, а сам
// <audio> держим скрытым и только дёргаем его через ref.
function CustomAudioPlayer({ src }) {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };

  const handleSeek = (e) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(ratio * duration);
  };

  const formatTime = (t) => {
    if (!isFinite(t) || t < 0) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const progress = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="audio-player">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => setIsPlaying(false)}
      />
      <button className="audio-player-toggle" onClick={togglePlay} type="button">
        {isPlaying ? <Icons.Pause /> : <Icons.PlayFilled />}
      </button>
      <span className="audio-player-time">{formatTime(currentTime)}</span>
      <div className="audio-player-track" onClick={handleSeek}>
        <div className="audio-player-track-fill" style={{ width: `${progress}%` }} />
        <div className="audio-player-track-thumb" style={{ left: `${progress}%` }} />
      </div>
      <span className="audio-player-time">{formatTime(duration)}</span>
    </div>
  );
}

// Тот же принцип, что у аудио: свой плей/пауза, шкала и таймер вместо
// нативной хромированной панели браузера — плюс крупная кнопка поверх
// кадра, пока видео на паузе.
function CustomVideoPlayer({ src }) {
  const videoRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [src]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  const handleSeek = (e) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
    setCurrentTime(ratio * duration);
  };

  const formatTime = (t) => {
    if (!isFinite(t) || t < 0) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  const progress = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="video-player">
      <div className="video-player-frame" onClick={togglePlay}>
        <video
          ref={videoRef}
          src={src}
          preload="metadata"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onEnded={() => setIsPlaying(false)}
        />
        {!isPlaying && (
          <div className="video-player-overlay">
            <span className="video-player-overlay-btn"><Icons.PlayFilled /></span>
          </div>
        )}
      </div>
      <div className="audio-player video-player-controls">
        <button className="audio-player-toggle" onClick={togglePlay} type="button">
          {isPlaying ? <Icons.Pause /> : <Icons.PlayFilled />}
        </button>
        <span className="audio-player-time">{formatTime(currentTime)}</span>
        <div className="audio-player-track" onClick={handleSeek}>
          <div className="audio-player-track-fill" style={{ width: `${progress}%` }} />
          <div className="audio-player-track-thumb" style={{ left: `${progress}%` }} />
        </div>
        <span className="audio-player-time">{formatTime(duration)}</span>
      </div>
    </div>
  );
}

function LiveQuizPage({ navigate, showToast, gameState, sendGameMessage, leaveRoom, isSpectator }) {
  const { phase, question, answeredCount, answeredTotal, revealData, standings, isOrganizer, myNickname, participants, wasKicked, status } = gameState;

  const [selected, setSelected] = useState(null);
  const [textAnswer, setTextAnswer] = useState("");
  const [textSubmitted, setTextSubmitted] = useState(false);
  const [timeLeft, setTimeLeft] = useState(question?.time_limit || 20);
  const [showRoster, setShowRoster] = useState(false);
  const tickRef = useRef(null);

  // Визуальный отсчёт на клиенте — чисто косметика. Когда вопрос реально
  // заканчивается (истекло общее время или ответили все), решает только
  // сервер и присылает событие reveal — таймер тут ничего не решает сам.
  useEffect(() => {
    clearInterval(tickRef.current);
    if (phase !== "question" || !question) return;
    setSelected(null);
    setTextAnswer("");
    setTextSubmitted(false);
    setTimeLeft(question.time_limit);
    tickRef.current = setInterval(() => {
      setTimeLeft((t) => (t > 0 ? t - 1 : 0));
    }, 1000);
    return () => clearInterval(tickRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question?.id, question?.index, phase]);

  useEffect(() => {
    if (status === "finished") navigate("leaderboard");
  }, [status, navigate]);

  if (wasKicked) {
    return (
      <div className="join-page">
        <div className="card join-card">
          <h2>Вас удалили из комнаты</h2>
          <p>Организатор закрыл вам доступ к этому квизу.</p>
          <button className="btn btn-primary btn-full btn-lg mt-24" onClick={() => leaveRoom("landing")}>
            На главную
          </button>
        </div>
      </div>
    );
  }

  const handleAnswer = (idx) => {
    if (phase !== "question" || selected !== null || isSpectator || !question) return;
    setSelected(idx);
    sendGameMessage("answer", { answer_id: question.answers[idx].id });
  };

  const handleTextSubmit = () => {
    if (phase !== "question" || textSubmitted || !textAnswer.trim() || isSpectator) return;
    setTextSubmitted(true);
    sendGameMessage("answer", { text_answer: textAnswer.trim() });
  };

  const kickFromRoster = (nickname) => sendGameMessage("kick", { target_nickname: nickname });

  const timeLimit = question?.time_limit || 20;
  const circumference = 2 * Math.PI * 28;
  const dashOffset = circumference - (timeLeft / timeLimit) * circumference;
  const timerClass = timeLeft <= 3 ? "danger" : timeLeft <= 7 ? "warning" : "";
  const totalQuestions = question?.total ?? standings.length ?? 0;
  const currentIndex = question?.index ?? 0;
  const myScore = standings.find((p) => p.nickname === myNickname)?.score ?? 0;

  if (phase === "standings") {
    const yourRank = standings.findIndex((p) => p.nickname === myNickname) + 1;
    const medals = ["🥇", "🥈", "🥉"];
    return (
      <div className="live-quiz">
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${((currentIndex + 1) / (totalQuestions || 1)) * 100}%` }} />
        </div>

        <div className="live-standings-header mt-24">
          <h2>После вопроса {currentIndex + 1} из {totalQuestions}</h2>
          <p className="text-muted">
            {isSpectator || yourRank === 0 ? "Ожидаем организатора…" : `Ваше место — #${yourRank}, ${myScore} баллов`}
          </p>
        </div>

        <div className="leaderboard-table mt-24">
          {standings.map((p, i) => (
            <div key={p.nickname} className={`lb-row ${p.nickname === myNickname ? "you-row" : ""}`}>
              <div className="lb-rank">{i < 3 ? medals[i] : `#${i + 1}`}</div>
              <div className={`lb-name ${p.nickname === myNickname ? "you" : ""}`}>
                {p.nickname} {p.nickname === myNickname && <span className="text-sm text-muted">(вы)</span>}
              </div>
              <div className="lb-score">{p.score}</div>
            </div>
          ))}
        </div>

        {isOrganizer && (
          <button className="btn btn-primary btn-lg mt-24" onClick={() => sendGameMessage("skip")}>
            Пропустить ожидание <Icons.ArrowRight />
          </button>
        )}
      </div>
    );
  }

  if (!question) {
    return (
      <div className="live-quiz">
        <div className="live-standings-header mt-24">
          <h2>Ждём начала квиза…</h2>
          <p className="text-muted">Соединение установлено, вопросы вот-вот появятся.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="live-quiz">
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${((currentIndex + 1) / (totalQuestions || 1)) * 100}%` }} />
      </div>

      <div className="live-header mt-24">
        <div className="live-progress-text">
          {currentIndex + 1} / {totalQuestions}
        </div>

        <div className={`live-timer ${timerClass}`}>
          <svg className="live-timer-ring" viewBox="0 0 64 64">
            <circle className="bg" cx="32" cy="32" r="28" />
            <circle
              className="fg"
              cx="32" cy="32" r="28"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 32 32)"
            />
          </svg>
          {timeLeft}
        </div>

        {isSpectator ? (
          <button className="live-roster-toggle" onClick={() => setShowRoster((s) => !s)}>
            <Icons.Users /> {participants.length}
          </button>
        ) : (
          <div className="live-score-display">
            Баллы: <span>{myScore}</span>
          </div>
        )}
      </div>

      {!isSpectator && (
        <div className="live-answered-count text-muted">
          Ответили: {answeredCount}/{answeredTotal}
        </div>
      )}

      {isOrganizer && !isSpectator && (
        <button className="live-roster-toggle live-roster-toggle-inline" onClick={() => setShowRoster((s) => !s)}>
          <Icons.Users /> Участники ({participants.length})
        </button>
      )}

      {showRoster && isOrganizer && (
        <div className="live-roster-panel">
          {participants.map((p) => (
            <div key={p.nickname} className="live-roster-row">
              <span>{p.nickname} {p.nickname === myNickname && <span className="text-sm text-muted">(вы)</span>}</span>
              {p.nickname !== myNickname && !p.is_organizer_player && (
                <button className="lobby-player-kick" title={`Удалить «${p.nickname}»`} onClick={() => kickFromRoster(p.nickname)}>
                  <Icons.X />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card live-question-card">
        {question.media_url && (
          <div className="live-question-media">
            {question.media_type === "image" && <img src={question.media_url} alt="" />}
            {question.media_type === "video" && <CustomVideoPlayer src={question.media_url} />}
            {question.media_type === "audio" && <CustomAudioPlayer src={question.media_url} />}
          </div>
        )}
        <h3>{question.text}</h3>
      </div>

      {isSpectator ? (
        <div className="live-spectator-note text-muted">
          Вы ведёте квиз и не отвечаете на вопросы — ответы участников считаются автоматически.
        </div>
      ) : question.type === "text" ? (
        <div className="live-text-answer">
          <input
            className="input input-lg"
            value={textAnswer}
            onChange={(e) => setTextAnswer(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleTextSubmit()}
            placeholder="Введите ответ..."
            disabled={textSubmitted}
            autoFocus
          />
          <button
            className="btn btn-primary btn-lg"
            onClick={handleTextSubmit}
            disabled={textSubmitted || !textAnswer.trim()}
          >
            {textSubmitted ? "Ответ отправлен" : "Ответить"}
          </button>
          {phase === "reveal" && revealData && (
            <div
              className={`live-text-result ${
                revealData.correct_text && textAnswer.trim().toLowerCase() === revealData.correct_text.trim().toLowerCase()
                  ? "correct"
                  : "wrong"
              }`}
            >
              Правильный ответ: {revealData.correct_text}
            </div>
          )}
        </div>
      ) : (
        <div className="live-answers">
          {question.answers.map((a, i) => {
            let cls = "live-answer-btn";
            if (phase === "reveal" && revealData) {
              if (revealData.correct_answer_ids.includes(a.id)) cls += " correct";
              else if (i === selected) cls += " wrong";
            } else if (i === selected) {
              cls += " selected";
            }
            return (
              <button
                key={a.id}
                className={cls}
                onClick={() => handleAnswer(i)}
                disabled={selected !== null || phase === "reveal"}
              >
                <span className="answer-letter">{String.fromCharCode(65 + i)}</span>
                {a.text}
              </button>
            );
          })}
        </div>
      )}

      {isOrganizer && phase === "reveal" && (
        <button className="btn btn-secondary mt-24" onClick={() => sendGameMessage("skip")}>
          Пропустить ожидание <Icons.ArrowRight />
        </button>
      )}
    </div>
  );
}

// ═══ LEADERBOARD ═════════════════════════════════════════════════
function LeaderboardPage({ navigate, gameState, leaveRoom }) {
  const { standings, myNickname, isOrganizer, quizTitle, roomCode } = gameState;
  const [fallbackStandings, setFallbackStandings] = useState(null);

  // gameState.standings приходит с событием quiz_finished — но если на
  // этот экран попали как-то иначе (например, обновили страницу), на
  // всякий случай подтянем финальную таблицу и через REST.
  useEffect(() => {
    if (standings.length > 0 || !roomCode) return;
    apiRequest(`/api/sessions/${roomCode}/leaderboard/`, { skipAuth: true })
      .then((data) => setFallbackStandings(data.leaderboard))
      .catch(() => {});
  }, [standings.length, roomCode]);

  const board = (standings.length > 0 ? standings : fallbackStandings || []).map((p) => ({
    ...p,
    isYou: p.nickname === myNickname,
  }));
  const top3 = board.slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  const podiumOrder = [top3[1], top3[0], top3[2]];
  const podiumClasses = ["podium-2", "podium-1", "podium-3"];

  return (
    <div className="leaderboard">
      <h2>Результаты</h2>
      <p className="leaderboard-subtitle">{quizTitle || "Квиз"} завершён</p>

      {board.length === 0 ? (
        <p className="text-muted">Загружаем результаты…</p>
      ) : (
        <>
          <div className="podium">
            {podiumOrder.map((p, i) =>
              p ? (
                <div key={i} className={`podium-place ${podiumClasses[i]}`}>
                  <div className="podium-medal">{medals[i === 1 ? 0 : i === 0 ? 1 : 2]}</div>
                  <div className="podium-avatar">{p.nickname[0]}</div>
                  <div className="podium-name">{p.nickname}</div>
                  <div className="podium-score">{p.score} очков</div>
                </div>
              ) : null
            )}
          </div>

          <div className="leaderboard-table">
            {board.map((p) => (
              <div key={p.nickname} className={`lb-row ${p.isYou ? "you-row" : ""}`}>
                <div className="lb-rank">{board.indexOf(p) < 3 ? medals[board.indexOf(p)] : `#${board.indexOf(p) + 1}`}</div>
                <div className={`lb-name ${p.isYou ? "you" : ""}`}>
                  {p.nickname} {p.isYou && <span className="text-sm text-muted">(вы)</span>}
                </div>
                <div className="lb-score">{p.score}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 40 }}>
        <button className="btn btn-secondary" onClick={() => leaveRoom(isOrganizer ? "dashboard" : "landing")}>
          <Icons.Home /> На главную
        </button>
      </div>
    </div>
  );
}
