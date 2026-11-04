export const resolveBackendUrl = (location, configured = '') => {
  const explicit = configured.trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (process.env.NODE_ENV === 'development' && ['3000', '3001'].includes(location.port)) {
    return `${location.protocol}//${location.hostname}:8001`;
  }
  return location.origin;
};

export const getBackendUrl = () => resolveBackendUrl(window.location, process.env.REACT_APP_BACKEND_URL || '');

export const getApiUrl = () => `${getBackendUrl()}/api`;
