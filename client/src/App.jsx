import { useState, useEffect, useRef } from 'react';
import FileUploader from './components/FileUploader';
import ResultsTable from './components/ResultsTable';
import styles from './App.module.css';

const BANKS      = ['BBVA', 'SANTANDER', 'BANAMEX', 'BAJIO', 'BANORTE'];
const BANK_COLOR = {
  BBVA:      '#004481',
  SANTANDER: '#ec0000',
  BANAMEX:   '#002b6d',
  BAJIO:     '#e8312a',
  BANORTE:   '#e31837'
};
const BANK_ALIASES = { 'SANTADER': 'SANTANDER', 'SANTANER': 'SANTANDER', 'BNORTE': 'BANORTE' };

// Tiempo estimado de procesamiento por banco (segundos)
// PDFs escaneados toman más; digitales son rápidos.
const EST_SECONDS = {
  BBVA:      15,
  BANORTE:   20,
  BANAMEX:   40,
  BAJIO:     5,
  SANTANDER: 90,   // puede ser escaneado (hasta 56 págs OCR)
  DEFAULT:   30
};

function detectBank(filename) {
  const upper = filename.toUpperCase();
  const direct = BANKS.find(b => upper.includes(b));
  if (direct) return direct;
  for (const [alias, canonical] of Object.entries(BANK_ALIASES)) {
    if (upper.includes(alias)) return canonical;
  }
  return null;
}

// ── Hook: cronómetro ──────────────────────────────────────────────────────────
function useTimer(running) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef(null);

  useEffect(() => {
    if (running) {
      setElapsed(0);
      ref.current = setInterval(() => setElapsed(s => s + 1), 1000);
    } else {
      clearInterval(ref.current);
    }
    return () => clearInterval(ref.current);
  }, [running]);

  return elapsed;
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')} min` : `${s} seg`;
}

// ── Barra de progreso animada ─────────────────────────────────────────────────
function ProgressBar({ elapsed, estimated }) {
  // La barra llega al 90% en el tiempo estimado, luego crece lento
  const pct = Math.min(90, Math.round((elapsed / estimated) * 90));
  const over = elapsed > estimated;

  return (
    <div className={styles.progressWrap}>
      <div
        className={styles.progressBar}
        style={{ width: `${over ? 90 + Math.min(9, elapsed - estimated) : pct}%` }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [files, setFiles]         = useState([]);
  const [status, setStatus]       = useState('idle');   // idle|loading|done|error
  const [statusMsg, setStatusMsg] = useState('');
  const [preview, setPreview]     = useState(null);
  const [estimated, setEstimated] = useState(30);       // segundos estimados

  const isLoading = status === 'loading';
  const elapsed   = useTimer(isLoading);

  // ── Selección de archivos ────────────────────────────────────────────────
  function handleFilesSelect(newFiles) {
    const entries = newFiles.map(f => ({ file: f, bank: detectBank(f.name) }));
    setFiles(prev => {
      const existing = new Set(prev.map(e => e.file.name));
      const added    = entries.filter(e => !existing.has(e.file.name));
      return [...prev, ...added];
    });
    setStatus('idle');
    setStatusMsg('');
    setPreview(null);
  }

  function removeFile(index) {
    setFiles(prev => prev.filter((_, i) => i !== index));
    setPreview(null);
    setStatus('idle');
  }

  function clearAll() {
    setFiles([]);
    setPreview(null);
    setStatus('idle');
    setStatusMsg('');
  }

  // ── Calcular tiempo estimado según los archivos seleccionados ────────────
  function getEstimated(validFiles) {
    return validFiles.reduce((acc, e) => {
      const t = EST_SECONDS[e.bank] ?? EST_SECONDS.DEFAULT;
      return acc + t;
    }, 0);
  }

  // ── Vista previa ─────────────────────────────────────────────────────────
  async function handlePreview(entry) {
    setEstimated(EST_SECONDS[entry.bank] ?? EST_SECONDS.DEFAULT);
    setStatus('loading');
    setStatusMsg(`Extrayendo: ${entry.file.name}…`);
    setPreview(null);

    try {
      const form = new FormData();
      form.append('pdf', entry.file);

      const res  = await fetch('/api/bank-extractor/preview', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');

      setPreview(data);
      setStatus('done');
      setStatusMsg(`Vista previa: ${data.count} transacciones en ${entry.file.name}`);
    } catch (err) {
      setStatus('error');
      setStatusMsg(err.message);
    }
  }

  // ── Descargar Excel / ZIP ────────────────────────────────────────────────
  async function handleDownloadAll() {
    if (!files.length) return;
    const validFiles = files.filter(e => e.bank);
    if (!validFiles.length) {
      setStatus('error');
      setStatusMsg('Ningún archivo tiene banco identificado.');
      return;
    }

    setEstimated(getEstimated(validFiles));
    setStatus('loading');
    setStatusMsg(`Procesando ${validFiles.length} archivo(s)…`);
    setPreview(null);

    try {
      const form = new FormData();
      validFiles.forEach(e => form.append('pdfs', e.file));

      const res = await fetch('/api/bank-extractor/extract-multiple', {
        method: 'POST',
        body:   form
      });

      if (!res.ok) {
        let errorMsg = `Error del servidor (${res.status})`;
        try { const d = await res.json(); errorMsg = d.error || errorMsg; } catch {}
        throw new Error(errorMsg);
      }

      const blob        = await res.blob();
      const isZip       = blob.type === 'application/zip';
      const defaultName = isZip
        ? 'estados_de_cuenta.zip'
        : validFiles[0].file.name.replace('.pdf', '.xlsx');
      const cd       = res.headers.get('Content-Disposition') || '';
      const match    = cd.match(/filename="?([^"]+)"?/);
      const fileName = match ? match[1] : defaultName;

      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);

      setStatus('done');
      setStatusMsg(`✅ ${isZip ? `ZIP con ${validFiles.length} archivos` : 'Excel'} descargado`);
    } catch (err) {
      setStatus('error');
      setStatusMsg(err.message);
    }
  }

  const validCount   = files.filter(e => e.bank).length;
  const invalidCount = files.filter(e => !e.bank).length;

  return (
    <div className={styles.layout}>

      {/* ── Header ── */}
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <span className={styles.logo}>🏦 Extractor Bancario</span>
          <span className={styles.subtitle}>PDF → Excel</span>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Cargar estados de cuenta</h2>
          <p className={styles.cardDesc}>
            Soporta: <strong>BBVA · Santander · Banamex · Bajío · Banorte</strong>
          </p>

          <FileUploader onFilesSelect={handleFilesSelect} disabled={isLoading} />

          {/* Lista de archivos */}
          {files.length > 0 && (
            <div className={styles.fileList}>
              <div className={styles.fileListHeader}>
                <span>{files.length} archivo(s) seleccionado(s)</span>
                <button className={styles.btnClear} onClick={clearAll} disabled={isLoading}>
                  Limpiar todo
                </button>
              </div>

              {files.map((entry, i) => (
                <div key={entry.file.name + i} className={styles.fileRow}>
                  <span className={styles.fileRowIcon}>📄</span>
                  {entry.bank
                    ? <span className={styles.bankTag} style={{ background: BANK_COLOR[entry.bank] }}>
                        {entry.bank}
                      </span>
                    : <span className={styles.bankTagWarn}>⚠ Sin banco</span>
                  }
                  <span className={styles.fileRowName} title={entry.file.name}>
                    {entry.file.name}
                  </span>
                  <div className={styles.fileRowActions}>
                    {entry.bank && (
                      <button className={styles.btnPreview}
                        onClick={() => handlePreview(entry)}
                        disabled={isLoading} title="Vista previa">👁</button>
                    )}
                    <button className={styles.btnRemove}
                      onClick={() => removeFile(i)}
                      disabled={isLoading} title="Quitar">✕</button>
                  </div>
                </div>
              ))}

              {invalidCount > 0 && (
                <p className={styles.warnMsg}>
                  ⚠ {invalidCount} archivo(s) sin banco identificado serán omitidos.
                </p>
              )}
            </div>
          )}

          {/* Botón principal */}
          {validCount > 0 && (
            <div className={styles.actions}>
              <button className={styles.btnPrimary}
                onClick={handleDownloadAll} disabled={isLoading}>
                {isLoading
                  ? '⏳ Procesando…'
                  : validCount === 1
                    ? '⬇ Descargar Excel'
                    : `⬇ Procesar ${validCount} archivos → ZIP`}
              </button>
            </div>
          )}

          {/* ── Estado de carga con progreso ── */}
          {isLoading && (
            <div className={styles.statusLoading}>
              <ProgressBar elapsed={elapsed} estimated={estimated} />
              <div className={styles.loadingRow}>
                <span className={styles.spinner} />
                <span>{statusMsg}</span>
                <span className={styles.elapsed}>{fmtTime(elapsed)}</span>
              </div>
              {elapsed > 15 && (
                <p className={styles.loadingHint}>
                  ⏱ PDFs escaneados pueden tardar hasta {fmtTime(estimated)} — no cierres la pestaña.
                </p>
              )}
            </div>
          )}
          {status === 'done'  && <div className={styles.statusOk}>{statusMsg}</div>}
          {status === 'error' && <div className={styles.statusError}>❌ {statusMsg}</div>}
        </div>

        {/* Vista previa */}
        {preview && (
          <div className={styles.card}>
            <ResultsTable transactions={preview.transactions} bank={preview.bank} />
          </div>
        )}
      </main>
    </div>
  );
}
