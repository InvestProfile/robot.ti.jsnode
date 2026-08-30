const DECIMAL_KOPECKS = /^-?\d+$/;

const formatPaperKopecks = (value, { signed = false, empty = '—' } = {}) => {
  if (value === undefined || value === null || value === '') return empty;
  const source = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!DECIMAL_KOPECKS.test(source)) return empty;

  const kopecks = BigInt(source);
  const negative = kopecks < 0n;
  const absolute = negative ? -kopecks : kopecks;
  const rubles = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  const cents = (absolute % 100n).toString().padStart(2, '0');
  const sign = negative ? '−' : signed && kopecks > 0n ? '+' : '';
  return `${sign}${rubles},${cents} ₽`;
};

module.exports = { formatPaperKopecks };
