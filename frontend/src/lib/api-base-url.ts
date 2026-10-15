/** Browser same-origin by default; Capacitor uses its configured application server. */
export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  return configured && configured !== 'undefined' ? configured : '';
}
