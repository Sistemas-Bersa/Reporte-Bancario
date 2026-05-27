import styles from './ResultsTable.module.css';

export default function ResultsTable({ transactions, bank }) {
  if (!transactions?.length) return null;

  const headers = Object.keys(transactions[0]);

  return (
    <div>
      <div className={styles.titleRow}>
        <h3 className={styles.title}>Vista previa de transacciones</h3>
        <span className={styles.badge}>{bank} — {transactions.length} registros</span>
      </div>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>{headers.map(h => <th key={h}>{h.toUpperCase()}</th>)}</tr>
          </thead>
          <tbody>
            {transactions.map((tx, i) => (
              <tr key={i}>
                {headers.map(h => <td key={h}>{tx[h] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
