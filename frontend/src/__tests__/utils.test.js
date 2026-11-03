import { cn } from '../lib/utils';
import { getAuthToken, setAuthToken, clearAuthToken } from '../utils/authStorage';
import { getWebRtcIceServers, isOfflineMode } from '../utils/offline';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete window.__UNISHARE_OFFLINE__;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('cn', () => {
  test('merges class names and resolves tailwind conflicts', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('a', false && 'b', 'c')).toBe('a c');
  });
});

describe('offline mode', () => {
  test('is off by default', () => {
    expect(isOfflineMode()).toBe(false);
  });

  test('env flag forces it on or off', () => {
    process.env.REACT_APP_OFFLINE_MODE = 'true';
    expect(isOfflineMode()).toBe(true);
    process.env.REACT_APP_OFFLINE_MODE = 'false';
    window.__UNISHARE_OFFLINE__ = true;
    expect(isOfflineMode()).toBe(false);
  });

  test('window flag turns it on', () => {
    window.__UNISHARE_OFFLINE__ = true;
    expect(isOfflineMode()).toBe(true);
  });
});

describe('ICE servers', () => {
  test('defaults to public STUN servers', () => {
    const servers = getWebRtcIceServers();
    expect(servers.length).toBeGreaterThan(0);
    expect(servers.every((s) => s.urls.startsWith('stun:'))).toBe(true);
  });

  test('can be overridden from the environment', () => {
    process.env.REACT_APP_WEBRTC_ICE_SERVERS = ' stun:a.example:3478 , turn:b.example:3478 ,, ';
    expect(getWebRtcIceServers()).toEqual([{ urls: 'stun:a.example:3478' }, { urls: 'turn:b.example:3478' }]);
  });
});

describe('auth token storage', () => {
  test('stores the token in localStorage when online', () => {
    setAuthToken('abc');
    expect(window.localStorage.getItem('token')).toBe('abc');
    expect(getAuthToken()).toBe('abc');
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });

  test('uses sessionStorage in offline mode', () => {
    window.__UNISHARE_OFFLINE__ = true;
    setAuthToken('xyz');
    expect(window.sessionStorage.getItem('token')).toBe('xyz');
    expect(window.localStorage.getItem('token')).toBeNull();
  });
});
