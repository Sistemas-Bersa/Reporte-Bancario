import { useRef, useState } from 'react';
import styles from './FileUploader.module.css';

export default function FileUploader({ onFilesSelect, disabled }) {
  const inputRef    = useRef(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(fileList) {
    const pdfs = Array.from(fileList).filter(f =>
      f.name.toLowerCase().endsWith('.pdf')
    );
    if (pdfs.length) onFilesSelect(pdfs);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    if (!disabled) handleFiles(e.dataTransfer.files);
  }

  function onInputChange(e) {
    handleFiles(e.target.files);
    e.target.value = '';
  }

  return (
    <div
      className={`${styles.dropzone} ${dragging ? styles.dragging : ''} ${disabled ? styles.disabled : ''}`}
      onClick={() => !disabled && inputRef.current.click()}
      onDragOver={e => { e.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        multiple
        style={{ display: 'none' }}
        onChange={onInputChange}
        disabled={disabled}
      />
      <div className={styles.placeholder}>
        <span className={styles.uploadIcon}>📂</span>
        <p className={styles.mainText}>Arrastra uno o varios PDFs aquí</p>
        <p className={styles.subText}>o haz clic para seleccionar — puedes elegir múltiples archivos</p>
      </div>
    </div>
  );
}
