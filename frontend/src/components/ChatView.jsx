import { getBackendUrl } from '../utils/backendUrl';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Send, Smile, Trash2, Pin, PinOff, Reply, X, AlertCircle, VolumeX, WifiOff, Users, Circle, Eraser, ShieldAlert } from 'lucide-react';
import webrtcManager from '../utils/webrtcManager2';
import ConfirmModal from './ConfirmModal';
import { toastError, toastSuccess } from '../utils/toast';

const CHAT_BC_NAME = 'unishare-chat-v1';

const BACKEND_URL = getBackendUrl();
const API = `${BACKEND_URL}/api`;
const REACTION_PALETTE = ['👍', '❤️', '😂', '😮', '😢', '🎉'];

function formatTime(s) {
  if (!s) return '';
  try {
    return new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

const ChatView = ({ token, currentUser }) => {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [pickerFor, setPickerFor] = useState(null);
  const [mutedUntil, setMutedUntil] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [muteTarget, setMuteTarget] = useState(null);
  const [muteMinutes, setMuteMinutes] = useState('15');
  const [muteBusy, setMuteBusy] = useState(false);
  const [clearScope, setClearScope] = useState(null); // 'self' | 'all'
  const [clearBusy, setClearBusy] = useState(false);
  const [directory, setDirectory] = useState([]);
  const [onlineIds, setOnlineIds] = useState(new Set());
  const [showSidebar, setShowSidebar] = useState(true);
  const [isOffline, setIsOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const listRef = useRef(null);
  const bcRef = useRef(null);
  const seenIdsRef = useRef(new Set());

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const isAdmin = !!(currentUser && currentUser.is_admin);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
    });
  }, []);

  const upsertMessage = useCallback((m) => {
    if (!m || !m.id) return;
    if (seenIdsRef.current.has(m.id)) {
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)));
      return;
    }
    seenIdsRef.current.add(m.id);
    setMessages((prev) => [...prev, m]);
    scrollToBottom();
  }, [scrollToBottom]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get(`${API}/chat/messages?limit=100`, { headers: authHeaders });
        if (!cancelled) {
          const list = r.data || [];
          list.forEach((m) => seenIdsRef.current.add(m.id));
          setMessages(list);
          setLoading(false);
          scrollToBottom();
        }
      } catch (e) {
        if (!cancelled) {
          // Don't bail entirely — chat may still work offline via BroadcastChannel
          setError(null);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [authHeaders, scrollToBottom]);

  useEffect(() => {
    const fetchMuteStatus = async () => {
      try {
        const r = await axios.get(`${API}/auth/me`, { headers: authHeaders });
        if (r.data && r.data.muted_until) {
          setMutedUntil(r.data.muted_until);
        } else {
          setMutedUntil(null);
        }
      } catch (e) {
        console.error('Failed to fetch mute status:', e);
      }
    };
    fetchMuteStatus();
}, [authHeaders]);

  useEffect(() => {
    const fetchMuteStatus = async () => {
      try {
        const r = await axios.get(`${API}/auth/me`, { headers: authHeaders });
        if (r.data && r.data.muted_until) {
          setMutedUntil(r.data.muted_until);
        } else {
          setMutedUntil(null);
        }
      } catch (e) {
        console.error('Failed to fetch mute status:', e);
      }
    };
    fetchMuteStatus();
    const interval = setInterval(fetchMuteStatus, 30000);
    return () => clearInterval(interval);
  }, [authHeaders]);

  useEffect(() => {
    if (mutedUntil) {
      const checkMuteExpiry = () => {
        const now = new Date();
        const until = new Date(mutedUntil);
        if (now >= until) {
          setMutedUntil(null);
        }
      };
      checkMuteExpiry();
      const interval = setInterval(checkMuteExpiry, 5000);
      return () => clearInterval(interval);
    }
  }, [mutedUntil]);

  // Track online/offline status of the browser itself
  useEffect(() => {
    const goOnline = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Cross-tab / LAN-friendly offline chat over BroadcastChannel.
  // Same-origin browser tabs see each other instantly even with no internet.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const bc = new BroadcastChannel(CHAT_BC_NAME);
    bcRef.current = bc;
    bc.onmessage = (ev) => {
      const data = ev.data;
      if (!data || data.type !== 'chat_local') return;
      // Ignore echoes of our own outbound messages
      if (currentUser && data.message && data.message.user_id === currentUser.id) return;
      upsertMessage(data.message);
    };
    return () => {
      try { bc.close(); } catch { /* */ }
      bcRef.current = null;
    };
  }, [currentUser, upsertMessage]);

  // Online users feed from the existing WebRTC signaling WS
  useEffect(() => {
    const onlineHandler = (users) => {
      const ids = new Set((users || []).filter(u => !u.is_admin).map((u) => u.id));
      if (currentUser && !currentUser.is_admin) ids.add(currentUser.id);
      setOnlineIds(ids);
    };
    const priorOnline = webrtcManager.onOnlineUsersChange;
    webrtcManager.onOnlineUsersChange = onlineHandler;
    if (webrtcManager.onlineUsers) onlineHandler(webrtcManager.onlineUsers);
    return () => {
      webrtcManager.onOnlineUsersChange = priorOnline;
    };
  }, [currentUser]);

  // Directory of registered users (so we can show "offline" entries too)
  useEffect(() => {
    let cancelled = false;
    const fetchDir = async () => {
      try {
        const r = await axios.get(`${API}/users/directory`, { headers: authHeaders });
        if (!cancelled) setDirectory(r.data || []);
      } catch {
        // offline / no auth — keep prior
      }
    };
    fetchDir();
    const id = setInterval(fetchDir, 20000);
    const onFocus = () => fetchDir();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [authHeaders]);

  useEffect(() => {
    const handler = (event) => {
      if (event.type === 'chat_new') {
        upsertMessage(event.message);
      } else if (event.type === 'chat_edit') {
        setMessages((prev) => prev.map((m) => (m.id === event.message.id ? event.message : m)));
      } else if (event.type === 'chat_delete') {
        setMessages((prev) => prev.map((m) => (
          m.id === event.message_id
            ? { ...m, deleted: true, deleted_by: event.deleted_by || 'self', content: '', reactions: {}, pinned: false }
            : m
        )));
      } else if (event.type === 'chat_clear') {
        const scope = event.scope;
        const by = event.deleted_by || 'self';
        // Admin clear-all or TTL sweep: physically remove messages
        if (scope === 'all' || scope === 'ttl-sweep') {
          setMessages((prev) => prev.filter((m) => {
            if (scope === 'all') return false;
            if (scope === 'ttl-sweep') return false;
            return true;
          }));
        } else {
          // User scope (guest disconnect or self-clear): mark as deleted
          setMessages((prev) => prev.map((m) => {
            if (m.deleted) return m;
            if (scope === 'user' && m.user_id === event.user_id) {
              return { ...m, deleted: true, deleted_by: by, content: '', reactions: {}, pinned: false };
            }
            return m;
          }));
        }
      } else if (event.type === 'chat_react') {
        setMessages((prev) => prev.map((m) => (m.id === event.message_id ? { ...m, reactions: event.reactions } : m)));
      } else if (event.type === 'chat_pin') {
        setMessages((prev) => prev.map((m) => (m.id === event.message_id ? { ...m, pinned: event.pinned } : m)));
      } else if (event.type === 'chat_mute') {
        if (currentUser && event.user_id === currentUser.id) {
          setMutedUntil(event.muted_until);
        }
      } else if (event.type === 'auto_unmuted') {
        console.log('auto_unmuted event received, clearing mute');
        setMutedUntil(null);
      }
    };
    const prior = webrtcManager.onChatEvent;
    webrtcManager.onChatEvent = handler;
    return () => {
      webrtcManager.onChatEvent = prior;
    };
  }, [currentUser, scrollToBottom, upsertMessage]);

  const broadcastLocal = (msg) => {
    if (!bcRef.current) return;
    try {
      bcRef.current.postMessage({ type: 'chat_local', message: msg });
    } catch (e) {
      console.warn('BroadcastChannel post failed', e);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    setError(null);

    const localMsg = {
      id: 'local-' + Math.random().toString(36).slice(2) + Date.now().toString(36),
      user_id: currentUser ? currentUser.id : 'local',
      username: currentUser ? currentUser.username : 'Guest',
      emoji: currentUser ? currentUser.emoji : '👤',
      is_admin: !!(currentUser && currentUser.is_admin),
      content: text,
      created_at: new Date().toISOString(),
      reply_to: replyTo ? replyTo.id : null,
      reactions: {},
      offline: true,
    };

    try {
      const r = await axios.post(
        `${API}/chat/messages`,
        { content: text, reply_to: replyTo ? replyTo.id : null },
        { headers: authHeaders, timeout: 5000 }
      );
      // Server broadcasts via WS; in the rare case our own WS missed it, dedup will handle.
      if (r.data) upsertMessage(r.data);
      setDraft('');
      setReplyTo(null);
    } catch (e) {
      const detail = e.response?.data?.detail || '';
      if (/muted until/i.test(detail)) {
        setError(detail);
        const m = detail.match(/until (.+)$/);
        if (m) setMutedUntil(m[1]);
      } else {
        // Treat as offline: show locally and broadcast to other tabs
        upsertMessage(localMsg);
        broadcastLocal(localMsg);
        setDraft('');
        setReplyTo(null);
        setError('No connection — message visible to local tabs only');
        setTimeout(() => setError(null), 3500);
      }
    } finally {
      setSending(false);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const react = async (msg, emoji) => {
    try {
      await axios.post(`${API}/chat/messages/${msg.id}/react?emoji=${encodeURIComponent(emoji)}`, null, {
        headers: authHeaders,
      });
      setPickerFor(null);
    } catch (e) {
      console.error('react failed', e);
    }
  };

  const deleteMsg = (msg) => setPendingDelete(msg);

  const confirmDeleteMsg = async () => {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await axios.delete(`${API}/chat/messages/${pendingDelete.id}`, { headers: authHeaders });
      setPendingDelete(null);
    } catch (e) {
      toastError(e.response?.data?.detail || 'Delete failed');
    } finally {
      setDeleteBusy(false);
    }
  };

  const togglePin = async (msg) => {
    try {
      await axios.post(`${API}/chat/messages/${msg.id}/pin`, null, { headers: authHeaders });
    } catch (e) {
      toastError(e.response?.data?.detail || 'Pin failed');
    }
  };

  const muteUser = (msg) => {
    setMuteTarget(msg);
    setMuteMinutes('15');
  };

  const confirmClear = async () => {
    if (!clearScope) return;
    setClearBusy(true);
    try {
      if (clearScope === 'all') {
        await axios.delete(`${API}/admin/chat/messages`, { headers: authHeaders });
        toastSuccess('All chat messages cleared');
      } else {
        await axios.delete(`${API}/chat/messages`, { headers: authHeaders });
        toastSuccess('Your messages cleared');
      }
      setClearScope(null);
    } catch (e) {
      toastError(e.response?.data?.detail || 'Clear failed');
    } finally {
      setClearBusy(false);
    }
  };

  const confirmMute = async () => {
    if (!muteTarget) return;
    const n = parseInt(muteMinutes, 10);
    if (!n || n < 1) {
      toastError('Enter a number ≥ 1');
      return;
    }
    setMuteBusy(true);
    try {
      await axios.post(`${API}/admin/users/${muteTarget.user_id}/mute?minutes=${n}`, null, { headers: authHeaders });
      toastSuccess(`${muteTarget.username} muted for ${n} min`);
      setMuteTarget(null);
    } catch (e) {
      toastError(e.response?.data?.detail || 'Mute failed');
    } finally {
      setMuteBusy(false);
    }
  };

  const renderReplyQuote = (msg) => {
    if (!msg.reply_to) return null;
    const original = messages.find((m) => m.id === msg.reply_to);
    if (!original) return null;
    return (
      <div className="mb-1 pl-2 border-l-2 border-blue-300 dark:border-blue-700 text-xs text-gray-500 dark:text-gray-400 truncate">
        <span className="font-medium">{original.username}:</span> {original.content}
      </div>
    );
  };

  const pinned = messages.filter((m) => m.pinned).slice(-3);

  const dirById = useMemo(() => {
    const m = new Map();
    directory.forEach((u) => m.set(u.id, u));
    if (currentUser && !m.has(currentUser.id)) {
      m.set(currentUser.id, {
        id: currentUser.id,
        username: currentUser.username,
        emoji: currentUser.emoji,
        is_admin: currentUser.is_admin,
        last_seen: null,
      });
    }
    return m;
  }, [directory, currentUser]);

  const onlineList = useMemo(() => {
    const out = new Map();
    onlineIds.forEach((id) => {
      const entry = dirById.get(id);
      if (entry) out.set(id, { ...entry, online: true });
    });
    // Make sure the current user always shows in their own online list
    if (currentUser && !out.has(currentUser.id)) {
      out.set(currentUser.id, {
        id: currentUser.id,
        username: currentUser.username,
        emoji: currentUser.emoji,
        is_admin: currentUser.is_admin,
        online: true,
      });
    }
    // Hide admins from regular users; admins can see everyone.
    // Guests (is_guest: true) are always visible to everyone.
    return Array.from(out.values()).filter((u) => {
      // Admins can see everyone
      if (currentUser && currentUser.is_admin) return true;
      // Regular users: hide admins, show everyone else (including guests)
      if (u.is_admin === true) return false;
      return true;
    });
  }, [onlineIds, dirById, currentUser]);

  const Sidebar = (
    <aside className="hidden lg:flex flex-col w-64 shrink-0 bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-slate-700 flex items-center space-x-2">
        <Users className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">People</h2>
        <span className="ml-auto text-xs text-gray-500">{onlineList.length} online</span>
      </div>
      <div className="flex-1 overflow-y-auto text-sm">
        <div className="px-4 pt-3 pb-1 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center">
          <Circle className="w-2 h-2 mr-1 fill-green-500 text-green-500" />
          Online ({onlineList.length})
        </div>
        {onlineList.length === 0 && (
          <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">Nobody online right now</div>
        )}
        {onlineList.map((u) => (
          <div key={u.id} className="px-4 py-1.5 flex items-center space-x-2 hover:bg-gray-50 dark:hover:bg-slate-700/50">
            {u.avatar_url ? (
              <img src={u.avatar_url} alt="" className="w-5 h-5 rounded-full bg-white" />
            ) : (
              <span className="text-base">{u.emoji}</span>
            )}
            <span className="flex-1 truncate text-gray-800 dark:text-gray-100">{u.username}</span>
            {u.is_admin && <span className="text-[10px] px-1 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">admin</span>}
            {currentUser && u.id === currentUser.id && <span className="text-[10px] text-blue-500">you</span>}
            <span className="w-2 h-2 rounded-full bg-green-500" />
          </div>
        ))}
      </div>
    </aside>
  );

  return (
    <div className="max-w-6xl mx-auto px-2 sm:px-4 py-2 sm:py-4 h-[calc(100vh-8rem)] flex space-x-2 sm:space-x-4 overflow-hidden max-w-full">
      <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Community Chat</h1>
          {isOffline ? (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex items-center">
              <WifiOff className="w-3 h-3 mr-1" /> Offline — local tabs only
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
              Online
            </span>
          )}
        </div>
        <div className="flex items-center space-x-2">
          {isAdmin && (
            <span className="text-xs px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
              Admin moderation enabled
            </span>
          )}
          <button
            onClick={() => setClearScope('self')}
            className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-slate-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center space-x-1"
            title="Delete every message you sent"
          >
            <Eraser className="w-3 h-3" />
            <span>Clear my messages</span>
          </button>
          {isAdmin && (
            <button
              onClick={() => setClearScope('all')}
              className="text-xs px-2 py-1 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 flex items-center space-x-1"
              title="Delete the entire chat history"
            >
              <ShieldAlert className="w-3 h-3" />
              <span>Clear all</span>
            </button>
          )}
        </div>
      </div>

      {pinned.length > 0 && (
        <div className="mb-3 space-y-1">
          {pinned.map((m) => (
            <div key={m.id} className="px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm flex items-start">
              <Pin className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 mr-2 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-medium mr-1">{m.emoji} {m.username}:</span>
                <span className="text-gray-700 dark:text-gray-200">{m.content}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {mutedUntil && (
        <div className="mb-3 p-3 rounded-lg bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 flex items-center text-sm text-red-700 dark:text-red-300">
          <VolumeX className="w-4 h-4 mr-2" />
          You are muted until {new Date(mutedUntil).toLocaleString()}
        </div>
      )}

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto bg-white dark:bg-slate-800 rounded-xl border border-gray-200 dark:border-slate-700 p-3 space-y-2"
      >
        {loading ? (
          <div className="text-center text-gray-500 py-10">Loading…</div>
        ) : messages.length === 0 ? (
          <div className="text-center text-gray-500 py-10">No messages yet — say hi!</div>
        ) : (
          messages.map((m) => {
            const mine = currentUser && m.user_id === currentUser.id;
            const canDelete = mine || isAdmin;
            return (
              <div key={m.id} className={`group flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-3 py-2 shadow-sm ${
                  mine
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 dark:bg-slate-700 text-gray-900 dark:text-white'
                } ${m.pinned ? 'ring-2 ring-amber-400' : ''}`}>
                  <div className="flex items-center text-xs opacity-80 mb-0.5 space-x-1">
                    {m.avatar_url ? (
                      <img src={m.avatar_url} alt="" className="w-4 h-4 rounded-full bg-white" />
                    ) : (
                      <span>{m.emoji}</span>
                    )}
                    <span className="font-medium">{m.username}</span>
                    {m.is_admin && (
                      <span className="text-[10px] px-1 rounded bg-red-500/20 text-red-100">admin</span>
                    )}
                    <span className="opacity-70">· {formatTime(m.created_at)}</span>
                    {m.edited_at && <span className="opacity-70 italic">(edited)</span>}
                  </div>
                  {!m.deleted && renderReplyQuote(m)}
                  {m.deleted ? (
                    <div className="text-sm italic opacity-70 whitespace-pre-wrap break-words">
                      {m.deleted_by === 'admin' ? 'Message removed by an admin' : 'Message deleted'}
                    </div>
                  ) : (
                    <div className="text-sm whitespace-pre-wrap break-words">{m.content}</div>
                  )}

                  {!m.deleted && m.reactions && Object.keys(m.reactions).length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {Object.entries(m.reactions).map(([emoji, users]) => {
                        const reacted = currentUser && users.includes(currentUser.id);
                        return (
                          <button
                            key={emoji}
                            onClick={() => react(m, emoji)}
                            className={`text-xs px-1.5 py-0.5 rounded-full border ${
                              reacted
                                ? 'bg-white/30 border-white/40 text-white'
                                : 'bg-white/60 dark:bg-slate-900/40 border-gray-200 dark:border-slate-600 text-gray-700 dark:text-gray-200'
                            }`}
                          >
                            {emoji} {users.length}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {!m.deleted && (
                    <div className="mt-1 flex items-center justify-end space-x-2 text-xs opacity-0 group-hover:opacity-100 transition">
                      <button
                        onClick={() => setPickerFor(pickerFor === m.id ? null : m.id)}
                        className={mine ? 'text-white/80 hover:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-300'}
                        title="React"
                      >
                        <Smile className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setReplyTo(m)}
                        className={mine ? 'text-white/80 hover:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-300'}
                        title="Reply"
                      >
                        <Reply className="w-3.5 h-3.5" />
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => togglePin(m)}
                          className={mine ? 'text-white/80 hover:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-300'}
                          title={m.pinned ? 'Unpin' : 'Pin'}
                        >
                          {m.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      {isAdmin && !mine && (
                        <button
                          onClick={() => muteUser(m)}
                          className={mine ? 'text-white/80 hover:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-300'}
                          title="Mute author"
                        >
                          <VolumeX className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => deleteMsg(m)}
                          className={mine ? 'text-white/80 hover:text-white' : 'text-red-500 hover:text-red-700'}
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}

                  {!m.deleted && pickerFor === m.id && (
                    <div className="mt-2 flex gap-1">
                      {REACTION_PALETTE.map((e) => (
                        <button
                          key={e}
                          onClick={() => react(m, e)}
                          className="text-base hover:scale-110 transition"
                        >
                          {e}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {error && (
        <div className="mt-2 p-2 rounded-lg bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-xs flex items-center">
          <AlertCircle className="w-3.5 h-3.5 mr-2" />
          {error}
        </div>
      )}

      {replyTo && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 text-xs flex items-center">
          <div className="flex-1 truncate text-blue-700 dark:text-blue-200">
            Replying to <span className="font-medium">{replyTo.username}</span>: {replyTo.content}
          </div>
          <button onClick={() => setReplyTo(null)} className="ml-2 text-blue-600 dark:text-blue-300">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="mt-2 flex items-end space-x-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder={mutedUntil ? 'You are muted' : 'Type a message…'}
          disabled={!!mutedUntil}
          className="flex-1 resize-none px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={sending || !!mutedUntil || !draft.trim()}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-50 flex items-center space-x-1"
        >
          <Send className="w-4 h-4" />
          <span>Send</span>
        </button>
      </div>
      </div>

      {Sidebar}

      <ConfirmModal
        open={!!pendingDelete}
        title="Delete message?"
        message={pendingDelete ? `Remove "${pendingDelete.content.slice(0, 80)}${pendingDelete.content.length > 80 ? '…' : ''}"?` : ''}
        confirmLabel="Delete"
        destructive
        busy={deleteBusy}
        onConfirm={confirmDeleteMsg}
        onCancel={() => !deleteBusy && setPendingDelete(null)}
      />

      <ConfirmModal
        open={!!clearScope}
        title={clearScope === 'all' ? 'Clear ALL chat messages?' : 'Clear your messages?'}
        message={clearScope === 'all'
          ? 'Every message from every user will be permanently deleted. This cannot be undone.'
          : 'Every message you have sent will be marked as deleted. This cannot be undone.'}
        confirmLabel={clearScope === 'all' ? 'Clear all' : 'Clear mine'}
        destructive
        busy={clearBusy}
        onConfirm={confirmClear}
        onCancel={() => !clearBusy && setClearScope(null)}
      />

      {muteTarget && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-2xl shadow-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-slate-700 flex items-center space-x-2">
              <VolumeX className="w-5 h-5 text-purple-600 dark:text-purple-400" />
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Mute user</h2>
            </div>
            <div className="px-6 py-5 space-y-3">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                Mute <span className="font-semibold">{muteTarget.username}</span> from chat for how many minutes?
              </p>
              <input
                type="number"
                min="1"
                value={muteMinutes}
                onChange={(e) => setMuteMinutes(e.target.value)}
                disabled={muteBusy}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
              />
            </div>
            <div className="px-6 py-4 bg-gray-50 dark:bg-slate-900/50 flex justify-end space-x-2">
              <button
                onClick={() => !muteBusy && setMuteTarget(null)}
                disabled={muteBusy}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-600 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmMute}
                disabled={muteBusy}
                className="px-4 py-2 rounded-lg text-sm font-medium bg-purple-600 hover:bg-purple-700 text-white disabled:opacity-50"
              >
                {muteBusy ? 'Muting…' : 'Mute'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatView;
