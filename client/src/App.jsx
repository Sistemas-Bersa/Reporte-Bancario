import { useState } from 'react';
import FileUploader from './components/FileUploader';
import ResultsTable from './components/ResultsTable';
import styles from './App.module.css';

const BANKS     = ['BBVA', 'SANTANDER', 'BANAMEX', 'BAJIO', 'BANORTE'];
const BANK_COLOR = {
  BBVA:      '#004481',
  SANTANDER: '#ec0000',
  BANAMEX:   '#002b6d',
  BAJIO:     '#e8312a',
  BANORTE:   '#e31837'
};

const BANK_ALIASES = { 'SANTADER': 'SANTANDER', 'SANTANER': 'SANTANDER', 'BNORTE': 'BANORTE' };

function detectBank(filename) {
  const upper = filename.toUpperCase();
  const direct = BANKS.find(b => upper.includes(b));
  if (direct) return direct;
  for (const [alias, canonical] of Object.entries(BANK_ALIASES)) {
    if (upper.includes(alias)) return canonical;
  }
  return null;
}

export default function App() {
  const [files, setFiles]           = useState([]);       // [{ file, bank }]
  const [status, setStatus]         = useState('idle');   // idle|loading|done|error
  const [statusMsg, setStatusMsg]   = useState('');
  const [preview, setPreview]       = useState(null);     // { bank, count, transactions }

  // ── Selección de archivos ─────────────────────────────────────────────────
  function handleFilesSelect(newFiles) {
    const entries = newFiles.map(f => ({ file: f, bank: detectBank(f.name) }));
    setFiles(prev => {
      // Evitar duplicados por nombre
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

  // ── Vista previa (solo para un archivo) ──────────────────────────────────
  async function handlePreview(entry) {
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
      setStatusMsg(`Vista previa: ${data.count} transacciones encontradas en ${entry.file.name}`);
    } catch (err) {
      setStatus('error');
      setStatusMsg(err.message);
    }
  }

  // ── Procesar todos → ZIP (o xlsx si es uno solo) ─────────────────────────
  async function handleDownloadAll() {
    if (!files.length) return;
    const validFiles = files.filter(e => e.bank);
    if (!validFiles.length) {
      setStatus('error');
      setStatusMsg('Ningún archivo tiene banco identificado.');
      return;
    }

    setStatus('loading');
    setStatusMsg(`Procesando ${validFiles.length} archivo(s)…`);
    setPreview(null);

    try {
      const form = new FormData();
      validFiles.forEach(e => form.append('pdfs', e.file));

      const res = await fetch('/api/bank-extractor/extract-multiple', {
        method: 'POST',
        body: form
      });

      if (!res.ok) {
        let errorMsg = `Error del servidor (${res.status})`;
        try {
          const data = await res.json();
          errorMsg = data.error || errorMsg;
        } catch { /* respuesta no era JSON */ }
        throw new Error(errorMsg);
      }

      const blob        = await res.blob();
      const isZip       = blob.type === 'application/zip';
      const ext         = isZip ? '.zip' : '.xlsx';
      const defaultName = isZip ? 'estados_de_cuenta.zip'
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

      const label = isZip ? `ZIP con ${validFiles.length} archivos descargado` : 'Excel descargado';
      setStatus('done');
      setStatusMsg(`✅ ${label}`);
    } catch (err) {
      setStatus('error');
      setStatusMsg(err.message);
    }
  }

  const validCount   = files.filter(e => e.bank).length;
  const invalidCount = files.filter(e => !e.bank).length;
  const isLoading    = status === 'loading';

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

        {/* ── Card carga ── */}
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Cargar estados de cuenta</h2>
          <p className={styles.cardDesc}>
            Soporta: <strong>BBVA · Santander · Banamex · Bajío · Banorte</strong>
          </p>

          <FileUploader onFilesSelect={handleFilesSelect} disabled={isLoading} />

          {/* Lista de archivos seleccionados */}
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
                      <button
                        className={styles.btnPreview}
                        onClick={() => handlePreview(entry)}
                        disabled={isLoading}
                        title="Vista previa de transacciones"
                      >
                        👁
                      </button>
                    )}
                    <button
                      className={styles.btnRemove}
                      onClick={() => removeFile(i)}
                      disabled={isLoading}
                      title="Quitar archivo"
                    >
                      ✕
                    </button>
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
              <button
                className={styles.btnPrimary}
                onClick={handleDownloadAll}
                disabled={isLoading}
              >
                {isLoading
                  ? '⏳ Procesando…'
                  : validCount === 1
                    ? '⬇ Descargar Excel'
                    : `⬇ Procesar ${validCount} archivos → ZIP`
                }
              </button>
            </div>
          )}

          {/* Estado */}
          {status === 'loading' && (
            <div className={styles.statusLoading}>
              <span className={styles.spinner} /> {statusMsg}
            </div>
          )}
          {status === 'done' && (
            <div className={styles.statusOk}>{statusMsg}</div>
          )}
          {status === 'error' && (
            <div className={styles.statusError}>❌ {statusMsg}</div>
          )}
        </div>

        {/* ── Vista previa ── */}
        {preview && (
          <div className={styles.card}>
            <ResultsTable
              transactions={preview.transactions}
              bank={preview.bank}
            />
          </div>
        )}

      </main>
    </div>
  );
}
