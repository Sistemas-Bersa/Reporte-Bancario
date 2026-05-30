import { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import FileUploader from './components/FileUploader';
import ResultsTable from './components/ResultsTable';
import { extractFilePages } from './lib/pdfText';
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

  // ── Progreso de OCR en navegador ─────────────────────────────────────────
  function makeProgress(fileName) {
    return ({ page, total, phase }) => {
      const tag = phase === 'ocr' ? '🔍 OCR' : '📄 Texto';
      setStatusMsg(`${tag} ${fileName} — página ${page}/${total}`);
    };
  }

  // ── Vista previa (OCR en navegador → API solo parsea) ────────────────────
  async function handlePreview(entry) {
    setEstimated(EST_SECONDS[entry.bank] ?? EST_SECONDS.DEFAULT);
    setStatus('loading');
    setStatusMsg(`Leyendo: ${entry.file.name}…`);
    setPreview(null);

    try {
      const { pages, usedOcr } = await extractFilePages(entry.file, makeProgress(entry.file.name));
      setStatusMsg('Generando vista previa…');

      const res  = await fetch('/api/bank-extractor/preview-from-text', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ filename: entry.file.name, pages, usedOcr })
      });
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
      const xlsxResults = [];   // { name, blob }
      const errors      = [];   // { name, error }

      // Procesar archivo por archivo: OCR en navegador → API solo parsea
      for (const entry of validFiles) {
        try {
          const { pages, usedOcr } = await extractFilePages(entry.file, makeProgress(entry.file.name));
          setStatusMsg(`Generando Excel: ${entry.file.name}…`);

          const res = await fetch('/api/bank-extractor/extract-from-text', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ filename: entry.file.name, pages, usedOcr })
          });

          if (!res.ok) {
            let msg = `Error del servidor (${res.status})`;
            try { const d = await res.json(); msg = d.error || msg; } catch {}
            throw new Error(msg);
          }

          const blob     = await res.blob();
          const cd       = res.headers.get('Content-Disposition') || '';
          const match    = cd.match(/filename="?([^"]+)"?/);
          const xlsxName = match ? match[1] : entry.file.name.replace(/\.pdf$/i, '.xlsx');
          xlsxResults.push({ name: xlsxName, blob });
        } catch (e) {
          errors.push({ name: entry.file.name, error: e.message });
        }
      }

      if (!xlsxResults.length) {
        throw new Error(
          'Ningún archivo generó transacciones.' +
          (errors.length ? ' ' + errors.map(e => `${e.name}: ${e.error}`).join(' · ') : '')
        );
      }

      // Un solo Excel → descarga directa; varios → ZIP en el navegador
      if (xlsxResults.length === 1 && !errors.length) {
        triggerDownload(xlsxResults[0].blob, xlsxResults[0].name);
        setStatus('done');
        setStatusMsg('✅ Excel descargado');
      } else {
        setStatusMsg('Empaquetando ZIP…');
        const zip = new JSZip();
        for (const r of xlsxResults) zip.file(r.name, r.blob);
        if (errors.length) {
          zip.file('_errores.txt', errors.map(e => `${e.name}: ${e.error}`).join('\n'));
        }
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        triggerDownload(zipBlob, 'estados_de_cuenta.zip');
        setStatus('done');
        setStatusMsg(
          `✅ ZIP con ${xlsxResults.length} archivo(s)` +
          (errors.length ? ` (${errors.length} con error)` : '')
        );
      }
    } catch (err) {
      setStatus('error');
      setStatusMsg(err.message);
    }
  }

  // ── Disparar descarga de un blob ──────────────────────────────────────────
  function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
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
