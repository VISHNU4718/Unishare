import { resolveBackendUrl } from '../utils/backendUrl';

test('production URLs use the same origin without guessing a port', () => {
  expect(resolveBackendUrl({ origin: 'https://share.example', port: '' })).toBe('https://share.example');
  expect(resolveBackendUrl({ origin: 'http://localhost', port: '' })).toBe('http://localhost');
  expect(resolveBackendUrl({ origin: 'http://localhost:4174', port: '4174' })).toBe('http://localhost:4174');
});

test('configured backend URLs are normalized', () => {
  expect(resolveBackendUrl({}, ' https://api.example/ ')).toBe('https://api.example');
});

test('development server connects to the documented backend port', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    expect(resolveBackendUrl({ protocol: 'http:', hostname: 'localhost', port: '3000' })).toBe('http://localhost:8001');
  } finally { process.env.NODE_ENV = previous; }
});
