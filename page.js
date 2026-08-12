'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import jsQR from 'jsqr';

const MAX_SECONDS = 30;
// שמירה על קובץ קטן כדי לא לחרוג ממגבלת 4.5MB של Vercel
const VIDEO_BPS = 800_000;
const AUDIO_BPS = 32_000;

const T = {
  he: {
    title: 'קריאת שירות בווידאו',
    machine: 'מכונה',
    entryIntro: 'הזינו את שם/מספר המכונה, או סרקו את הברקוד שעל המכונה.',
    machinePlaceholder: 'שם או מספר מכונה, למשל CNC-07',
    scanBtn: 'סרוק ברקוד',
    continueBtn: 'המשך',
    scanHint: 'כוונו את המצלמה אל הברקוד / QR שעל המכונה',
    cancelScan: 'ביטול',
    changeMachine: 'החלף מכונה',
    intro: 'צלמו סרטון קצר (עד 30 שניות): הראו את התקלה ותארו אותה בקול.',
    start: 'התחל צילום',
    stop: 'סיים הקלטה',
    recording: 'מקליט...',
    analyzing: 'הסרטון נשלח לניתוח... זה לוקח בערך 20-40 שניות',
    retry: 'צלם שוב',
    send: 'שלח לניתוח',
    resultTitle: 'מה המערכת הבינה',
    geminiTitle: 'ניתוח הווידאו (Gemini)',
    callTitle: 'טיוטת קריאת שירות (GPT-4o)',
    error: 'שגיאה',
    cameraError: 'לא ניתן לפתוח מצלמה. ודאו שאישרתם גישה למצלמה ולמיקרופון ושאתם גולשים ב-HTTPS.',
    langLabel: 'שפת דיבור בסרטון:',
    newCall: 'קריאה חדשה',
  },
  ru: {
    title: 'Сервисная заявка по видео',
    machine: 'Станок',
    entryIntro: 'Введите имя/номер станка или отсканируйте штрих-код на станке.',
    machinePlaceholder: 'Имя или номер станка, напр. CNC-07',
    scanBtn: 'Сканировать код',
    continueBtn: 'Далее',
    scanHint: 'Наведите камеру на штрих-код / QR на станке',
    cancelScan: 'Отмена',
    changeMachine: 'Сменить станок',
    intro: 'Снимите короткое видео (до 30 секунд): покажите неисправность и опишите её голосом.',
    start: 'Начать съёмку',
    stop: 'Остановить',
    recording: 'Запись...',
    analyzing: 'Видео отправлено на анализ... это займёт 20-40 секунд',
    retry: 'Переснять',
    send: 'Отправить на анализ',
    resultTitle: 'Что поняла система',
    geminiTitle: 'Анализ видео (Gemini)',
    callTitle: 'Черновик заявки (GPT-4o)',
    error: 'Ошибка',
    cameraError: 'Не удалось открыть камеру. Разрешите доступ к камере и микрофону (нужен HTTPS).',
    langLabel: 'Язык речи в видео:',
    newCall: 'Новая заявка',
  },
};

function pickMimeType() {
  const candidates = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

// אם הברקוד מכיל URL של האפליקציה — נחלץ את פרמטר machine; אחרת נשתמש בערך כמו שהוא
function extractMachineFromCode(value) {
  try {
    const url = new URL(value);
    const m = url.searchParams.get('machine');
    if (m) return m;
  } catch { /* לא URL — ערך גולמי */ }
  return value.trim();
}

function Home() {
  const params = useSearchParams();
  const machineFromQr = params.get('machine');

  const [lang, setLang] = useState('he');
  const [machineId, setMachineId] = useState('');
  const [machineInput, setMachineInput] = useState('');
  // entry | scan | idle | recording | preview | analyzing | done | error
  const [phase, setPhase] = useState('entry');
  const [seconds, setSeconds] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [result, setResult] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);

  const videoRef = useRef(null);
  const scanVideoRef = useRef(null);
  const scanCanvasRef = useRef(null);
  const scanLoopRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const blobRef = useRef(null);
  const timerRef = useRef(null);

  const t = T[lang];

  // כניסה ישירה דרך QR עם ?machine= — מדלגים על מסך הכניסה
  useEffect(() => {
    if (machineFromQr) {
      setMachineId(machineFromQr);
      setPhase('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineFromQr]);

  useEffect(() => () => cleanupStream(), []);

  function cleanupStream() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (scanLoopRef.current) cancelAnimationFrame(scanLoopRef.current);
    scanLoopRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    }
  }

  // ---------- סריקת ברקוד ----------
  async function startScan() {
    setErrorMsg('');
    setPhase('scan');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const vid = scanVideoRef.current;
      vid.srcObject = stream;
      await vid.play().catch(() => {});

      // BarcodeDetector תומך גם בברקודים רגילים (Code128 וכו'), jsQR — רק QR
      let detector = null;
      if ('BarcodeDetector' in window) {
        try {
          detector = new window.BarcodeDetector({
            formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'data_matrix'],
          });
        } catch { detector = null; }
      }

      const canvas = scanCanvasRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      let busy = false;

      const tick = async () => {
        if (!streamRef.current) return;
        if (!busy && vid.readyState >= 2 && vid.videoWidth > 0) {
          busy = true;
          try {
            canvas.width = vid.videoWidth;
            canvas.height = vid.videoHeight;
            ctx.drawImage(vid, 0, 0);
            let value = null;
            if (detector) {
              const codes = await detector.detect(canvas);
              if (codes && codes.length > 0) value = codes[0].rawValue;
            } else {
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const qr = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
              if (qr && qr.data) value = qr.data;
            }
            if (value) {
              const machine = extractMachineFromCode(value);
              if (machine) {
                cleanupStream();
                setMachineId(machine);
                setPhase('idle');
                return;
              }
            }
          } catch (e) { console.error('scan tick error', e); }
          busy = false;
        }
        scanLoopRef.current = requestAnimationFrame(tick);
      };
      scanLoopRef.current = requestAnimationFrame(tick);
    } catch (err) {
      console.error(err);
      cleanupStream();
      setErrorMsg(t.cameraError);
      setPhase('entry');
    }
  }

  function cancelScan() {
    cleanupStream();
    setPhase('entry');
  }

  function submitMachine() {
    const m = machineInput.trim();
    if (!m) return;
    setMachineId(m);
    setPhase('idle');
  }

  // ---------- הקלטת וידאו ----------
  async function startRecording() {
    setErrorMsg('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        await videoRef.current.play().catch(() => {});
      }
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: VIDEO_BPS,
        audioBitsPerSecond: AUDIO_BPS,
      });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'video/mp4' });
        blobRef.current = blob;
        setVideoUrl(URL.createObjectURL(blob));
        cleanupStream();
        setPhase('preview');
      };
      recorderRef.current = rec;
      rec.start();
      setSeconds(0);
      setPhase('recording');
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) stopRecording();
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      console.error(err);
      setErrorMsg(t.cameraError);
      setPhase('error');
    }
  }

  function stopRecording() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  }

  async function sendForAnalysis() {
    if (!blobRef.current) return;
    setPhase('analyzing');
    setErrorMsg('');
    try {
      const fd = new FormData();
      const ext = (blobRef.current.type || '').includes('mp4') ? 'mp4' : 'webm';
      fd.append('video', blobRef.current, `report.${ext}`);
      fd.append('machineId', machineId);
      fd.append('lang', lang);
      const res = await fetch('/api/analyze', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      setPhase('done');
    } catch (err) {
      console.error(err);
      setErrorMsg(String(err.message || err));
      setPhase('error');
    }
  }

  function resetToRecord() {
    cleanupStream();
    blobRef.current = null;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setResult(null);
    setErrorMsg('');
    setSeconds(0);
    setPhase('idle');
  }

  function backToEntry() {
    resetToRecord();
    setMachineId('');
    setMachineInput('');
    setPhase('entry');
  }

  const sizeMB = blobRef.current ? (blobRef.current.size / 1024 / 1024).toFixed(1) : null;

  return (
    <main style={styles.main} dir={lang === 'he' ? 'rtl' : 'ltr'}>
      <header style={styles.header}>
        <h1 style={styles.h1}>{t.title}</h1>
        {machineId && phase !== 'entry' && phase !== 'scan' && (
          <div style={styles.machineTag}>
            {t.machine}: <b>{machineId}</b>
            {' '}
            <button style={styles.linkBtn} onClick={backToEntry}>({t.changeMachine})</button>
          </div>
        )}
      </header>

      {phase === 'entry' && (
        <>
          <p style={styles.intro}>{t.entryIntro}</p>
          <div style={styles.langRow}>
            <span>{t.langLabel}</span>
            <button style={lang === 'he' ? styles.langBtnActive : styles.langBtn} onClick={() => setLang('he')}>עברית</button>
            <button style={lang === 'ru' ? styles.langBtnActive : styles.langBtn} onClick={() => setLang('ru')}>Русский</button>
          </div>
          <div style={styles.entryRow}>
            <input
              style={styles.input}
              value={machineInput}
              onChange={(e) => setMachineInput(e.target.value)}
              placeholder={t.machinePlaceholder}
              onKeyDown={(e) => { if (e.key === 'Enter') submitMachine(); }}
            />
            <button style={styles.scanIconBtn} onClick={startScan} title={t.scanBtn}>
              <span style={{ fontSize: 22 }}>▦</span>
              <span style={{ fontSize: 11 }}>{t.scanBtn}</span>
            </button>
          </div>
          <button
            style={{ ...styles.sendBtn, opacity: machineInput.trim() ? 1 : 0.4 }}
            disabled={!machineInput.trim()}
            onClick={submitMachine}
          >
            {t.continueBtn} ←
          </button>
          {errorMsg && <div style={styles.errorBox}>{errorMsg}</div>}
        </>
      )}

      {phase === 'scan' && (
        <>
          <video ref={scanVideoRef} playsInline muted style={styles.video} />
          <canvas ref={scanCanvasRef} style={{ display: 'none' }} />
          <div style={styles.scanHint}>{t.scanHint}</div>
          <button style={styles.secondaryBtn} onClick={cancelScan}>✕ {t.cancelScan}</button>
        </>
      )}

      {phase === 'idle' && (
        <>
          <p style={styles.intro}>{t.intro}</p>
          <button style={styles.recordBtn} onClick={startRecording}>
            <span style={styles.redDot} /> {t.start}
          </button>
        </>
      )}

      {phase === 'recording' && (
        <>
          <video ref={videoRef} playsInline muted style={styles.video} />
          <div style={styles.timer}>{t.recording} {seconds}/{MAX_SECONDS}s</div>
          <button style={{ ...styles.recordBtn, background: '#334155' }} onClick={stopRecording}>
            ⏹ {t.stop}
          </button>
        </>
      )}

      {phase === 'preview' && (
        <>
          {videoUrl && <video src={videoUrl} controls playsInline style={styles.video} />}
          {sizeMB && <div style={styles.sizeNote}>{sizeMB} MB</div>}
          <div style={styles.row}>
            <button style={styles.sendBtn} onClick={sendForAnalysis}>📤 {t.send}</button>
            <button style={styles.secondaryBtn} onClick={resetToRecord}>🔄 {t.retry}</button>
          </div>
        </>
      )}

      {phase === 'analyzing' && (
        <div style={styles.analyzing}>
          <div style={styles.spinner} />
          <p>{t.analyzing}</p>
        </div>
      )}

      {phase === 'done' && result && (
        <div style={styles.results}>
          <h2 style={styles.h2}>{t.resultTitle}</h2>

          <section style={styles.card}>
            <h3 style={styles.h3}>{t.callTitle}</h3>
            {result.serviceCall ? (
              <table style={styles.table}><tbody>
                {Object.entries(result.serviceCall).map(([k, v]) => (
                  <tr key={k}>
                    <td style={styles.tdKey}>{k}</td>
                    <td style={styles.tdVal}>{typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v)}</td>
                  </tr>
                ))}
              </tbody></table>
            ) : <pre style={styles.pre}>{result.serviceCallRaw}</pre>}
          </section>

          <section style={styles.card}>
            <h3 style={styles.h3}>{t.geminiTitle}</h3>
            <pre style={styles.pre}>{result.geminiAnalysis}</pre>
          </section>

          <button style={styles.recordBtn} onClick={resetToRecord}>🎬 {t.newCall}</button>
        </div>
      )}

      {phase === 'error' && (
        <div style={styles.results}>
          <div style={styles.errorBox}><b>{t.error}:</b> {errorMsg}</div>
          <button style={styles.secondaryBtn} onClick={resetToRecord}>🔄 {t.retry}</button>
        </div>
      )}
    </main>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Home />
    </Suspense>
  );
}

const styles = {
  main: { maxWidth: 480, margin: '0 auto', padding: '16px', minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 12 },
  header: { textAlign: 'center', marginBottom: 4 },
  h1: { fontSize: 22, margin: '8px 0 4px' },
  h2: { fontSize: 18, margin: '4px 0' },
  h3: { fontSize: 15, margin: '0 0 8px', color: '#93c5fd' },
  machineTag: { display: 'inline-block', background: '#1e293b', borderRadius: 999, padding: '4px 14px', fontSize: 14 },
  linkBtn: { background: 'none', border: 'none', color: '#60a5fa', fontSize: 12, padding: 0 },
  intro: { fontSize: 15, lineHeight: 1.5, textAlign: 'center', color: '#cbd5e1' },
  langRow: { display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', fontSize: 14 },
  langBtn: { background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 8, padding: '6px 14px', fontSize: 14 },
  langBtnActive: { background: '#2563eb', color: '#fff', border: '1px solid #2563eb', borderRadius: 8, padding: '6px 14px', fontSize: 14 },
  entryRow: { display: 'flex', gap: 8, alignItems: 'stretch', marginTop: 8 },
  input: { flex: 1, background: '#1e293b', border: '1px solid #334155', borderRadius: 12, color: '#e2e8f0', padding: '14px', fontSize: 16, outline: 'none', minWidth: 0 },
  scanIconBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 12, padding: '8px 14px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 },
  scanHint: { textAlign: 'center', fontSize: 14, color: '#93c5fd' },
  recordBtn: { marginTop: 8, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 16, padding: '18px', fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 },
  redDot: { width: 14, height: 14, borderRadius: '50%', background: '#fff', display: 'inline-block' },
  video: { width: '100%', borderRadius: 12, background: '#000', maxHeight: '55dvh', objectFit: 'contain' },
  timer: { textAlign: 'center', fontSize: 16, color: '#fca5a5', fontWeight: 600 },
  sizeNote: { textAlign: 'center', fontSize: 12, color: '#64748b' },
  row: { display: 'flex', gap: 8 },
  sendBtn: { flex: 2, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 12, padding: '14px', fontSize: 16, fontWeight: 700 },
  secondaryBtn: { flex: 1, background: '#334155', color: '#e2e8f0', border: 'none', borderRadius: 12, padding: '14px', fontSize: 15 },
  analyzing: { textAlign: 'center', padding: '40px 0', color: '#cbd5e1' },
  spinner: { width: 40, height: 40, border: '4px solid #334155', borderTopColor: '#3b82f6', borderRadius: '50%', margin: '0 auto 16px', animation: 'spin 1s linear infinite' },
  results: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: '#1e293b', borderRadius: 12, padding: 14 },
  pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, margin: 0, fontFamily: 'inherit', lineHeight: 1.5 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  tdKey: { padding: '6px 8px', color: '#94a3b8', verticalAlign: 'top', whiteSpace: 'nowrap' },
  tdVal: { padding: '6px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  errorBox: { background: '#7f1d1d', borderRadius: 12, padding: 14, fontSize: 14, lineHeight: 1.5 },
};
