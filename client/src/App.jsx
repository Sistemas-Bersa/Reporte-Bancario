import { useState, useEffect, useRef } from 'react';
import JSZip from 'jszip';
import FileUploader from './components/FileUploader';
import ResultsTable from './components/ResultsTable';
import { extractFilePages, detectBankFromContent } from './lib/pdfText';
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

// Bancos cuyos extractores trabajan con TEXTO → soportan OCR en el navegador.
// Los demás (BBVA/BANAMEX/BANORTE) usan coordenadas X del PDF, así que se
// procesan en el servidor (son digitales y rápidos: no sufren el timeout de 45s).
const TEXT_PATH_BANKS = new Set(['SANTANDER', 'BAJIO']);

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

function fmtMoney(n) {
  return Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Construye un texto de alerta si la reconciliación no cuadra. null si cuadra.
function reconcileWarning(name, r) {
  if (!r || r.status === 'ok') return null;
  const parts = [];
  if (!r.okDep) parts.push(`depósitos extraído ${fmtMoney(r.extractedDep)} vs total impreso ${fmtMoney(r.printedDep)}`);
  if (!r.okRet) parts.push(`retiros extraído ${fmtMoney(r.extractedRet)} vs total impreso ${fmtMoney(r.printedRet)}`);
  return `${name}: ${parts.join(' · ')}`;
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
  const [alerts, setAlerts]       = useState([]);       // avisos de reconciliación

  const isLoading = status === 'loading';
  const elapsed   = useTimer(isLoading);

  // ── Selección de archivos ────────────────────────────────────────────────
  function handleFilesSelect(newFiles) {
    // 1) Detección inmediata por nombre. `source` indica de dónde salió el banco.
    const entries = newFiles.map(f => {
      const byName = detectBank(f.name);
      return {
        file:   f,
        bank:   byName || '',
        source: byName ? 'nombre' : 'pendiente',   // nombre | contenido | manual | pendiente
        manual: false                               // true si el usuario lo eligió
      };
    });

    let addedFiles = [];
    setFiles(prev => {
      const existing = new Set(prev.map(e => e.file.name));
      addedFiles     = entries.filter(e => !existing.has(e.file.name));
      return [...prev, ...addedFiles];
    });
    setStatus('idle');
    setStatusMsg('');
    setPreview(null);

    // 2) Detección por CONTENIDO en segundo plano (no bloquea la UI).
    //    Sólo rellena si el usuario no lo ha puesto manualmente.
    for (const entry of addedFiles) {
      detectBankFromContent(entry.file).then(byContent => {
        if (!byContent) return;
        setFiles(prev => prev.map(e => {
          if (e.file.name !== entry.file.name) return e;
          if (e.manual) return e;                 // respetar elección manual
          // El contenido es más confiable que el nombre → actualiza si difiere
          if (e.bank === byContent && e.source === 'nombre') return e;
          return { ...e, bank: byContent, source: 'contenido' };
        }));
      }).catch(() => {});
    }
  }

  // ── Cambio manual de banco desde el dropdown ──────────────────────────────
  function setBankForFile(index, bank) {
    setFiles(prev => prev.map((e, i) =>
      i === index ? { ...e, bank, source: bank ? 'manual' : 'pendiente', manual: !!bank } : e
    ));
    setStatus('idle');
    setStatusMsg('');
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
      if (phase === 'ocr') {
        setStatusMsg(`🔍 OCR ${fileName} — ${page}/${total} páginas escaneadas`);
      } else {
        setStatusMsg(`📄 Leyendo ${fileName}…`);
      }
    };
  }

  // ── Genera el Excel (blob) de un archivo, enrutando por banco ────────────
  // SANTANDER/BAJIO → OCR en navegador + extract-from-text (evita timeout 45s).
  // BBVA/BANAMEX/BANORTE → endpoint original del servidor (usan coordenadas X).
  async function getXlsxForEntry(entry) {
    let res;
    if (TEXT_PATH_BANKS.has(entry.bank)) {
      const { pages, usedOcr } = await extractFilePages(entry.file, makeProgress(entry.file.name));
      setStatusMsg(`Generando Excel: ${entry.file.name}…`);
      res = await fetch('/api/bank-extractor/extract-from-text', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ filename: entry.file.name, pages, usedOcr, bank: entry.bank })
      });
    } else {
      setStatusMsg(`Procesando en servidor: ${entry.file.name}…`);
      const form = new FormData();
      form.append('pdf', entry.file);
      form.append('bank', entry.bank);
      res = await fetch('/api/bank-extractor/extract', { method: 'POST', body: form });
    }

    if (!res.ok) {
      let msg = `Error del servidor (${res.status})`;
      try { const d = await res.json(); msg = d.error || msg; } catch {}
      throw new Error(msg);
    }
    const blob     = await res.blob();
    const cd       = res.headers.get('Content-Disposition') || '';
    const match    = cd.match(/filename="?([^"]+)"?/);
    const xlsxName = match ? match[1] : entry.file.name.replace(/\.pdf$/i, '.xlsx');

    let reconcile = null;
    try {
      const rh = res.headers.get('X-Reconcile');
      if (rh) reconcile = JSON.parse(rh);
    } catch { /* sin reconciliación */ }

    return { name: xlsxName, blob, reconcile };
  }

  // ── Vista previa (enruta por banco igual que la descarga) ─────────────────
  async function handlePreview(entry) {
    setEstimated(EST_SECONDS[entry.bank] ?? EST_SECONDS.DEFAULT);
    setStatus('loading');
    setStatusMsg(`Leyendo: ${entry.file.name}…`);
    setPreview(null);

    try {
      let data;
      if (TEXT_PATH_BANKS.has(entry.bank)) {
        const { pages, usedOcr } = await extractFilePages(entry.file, makeProgress(entry.file.name));
        setStatusMsg('Generando vista previa…');
        const res = await fetch('/api/bank-extractor/preview-from-text', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ filename: entry.file.name, pages, usedOcr, bank: entry.bank })
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error desconocido');
      } else {
        setStatusMsg(`Procesando en servidor: ${entry.file.name}…`);
        const form = new FormData();
        form.append('pdf', entry.file);
        form.append('bank', entry.bank);
        const res = await fetch('/api/bank-extractor/preview', { method: 'POST', body: form });
        data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Error desconocido');
      }

      setPreview(data);
      const w = reconcileWarning(entry.file.name, data.reconcile);
      setAlerts(w ? [w] : []);
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
    setAlerts([]);

    const t0 = Date.now();
    const fmtDone = () => fmtTime(Math.round((Date.now() - t0) / 1000));

    try {
      const xlsxResults = [];   // { name, blob }
      const errors      = [];   // { name, error }

      // Procesar archivo por archivo, enrutando por banco (ver getXlsxForEntry)
      for (const entry of validFiles) {
        try {
          const result = await getXlsxForEntry(entry);
          xlsxResults.push(result);
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

      // Avisos de reconciliación (totales que no cuadran con el TOTAL del PDF)
      const warnings = xlsxResults
        .map(r => reconcileWarning(r.name, r.reconcile))
        .filter(Boolean);
      setAlerts(warnings);

      // Un solo Excel → descarga directa; varios → ZIP en el navegador
      if (xlsxResults.length === 1 && !errors.length) {
        triggerDownload(xlsxResults[0].blob, xlsxResults[0].name);
        setStatus('done');
        setStatusMsg(`✅ Excel descargado en ${fmtDone()}`);
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
          `✅ ZIP con ${xlsxResults.length} archivo(s) en ${fmtDone()}` +
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

                  {/* Selector de banco — precargado por nombre/contenido, editable */}
                  <span
                    className={styles.bankSelectWrap}
                    style={{ borderColor: entry.bank ? BANK_COLOR[entry.bank] : '#d33' }}
                  >
                    <select
                      className={styles.bankSelect}
                      style={entry.bank ? { color: BANK_COLOR[entry.bank], fontWeight: 700 } : { color: '#d33' }}
                      value={entry.bank}
                      disabled={isLoading}
                      onChange={e => setBankForFile(i, e.target.value)}
                      title={
                        entry.source === 'contenido' ? 'Detectado por el contenido del PDF'
                        : entry.source === 'nombre'   ? 'Detectado por el nombre del archivo'
                        : entry.source === 'manual'   ? 'Elegido manualmente'
                        : 'Selecciona el banco'
                      }
                    >
                      <option value="">⚠ Elegir banco…</option>
                      {BANKS.map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                    {entry.source && entry.source !== 'pendiente' && (
                      <span className={styles.bankSource}>
                        {entry.source === 'contenido' ? '🔎' : entry.source === 'manual' ? '✋' : '🏷️'}
                      </span>
                    )}
                  </span>

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
                  ⚠ {invalidCount} archivo(s) sin banco — elige el banco en el menú para incluirlos.
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
                  ⏱ Los PDFs escaneados pueden tardar hasta 5 minutos — no cierres la pestaña.
                </p>
              )}
            </div>
          )}
          {status === 'done'  && <div className={styles.statusOk}>{statusMsg}</div>}
          {status === 'error' && <div className={styles.statusError}>❌ {statusMsg}</div>}

          {/* Alertas de reconciliación: los totales no cuadran con el PDF */}
          {alerts.length > 0 && (
            <div className={styles.reconcileBox}>
              <strong>⚠ Revisa estos archivos — el total no coincide con el del PDF (posible error de OCR):</strong>
              <ul className={styles.reconcileList}>
                {alerts.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}
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
